import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, symlink, rm, open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemResourceSourceReader } from '../src/infrastructure/resource-source-reader.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { ResourceSourceReport } from '../src/shared/resource-source.js';
import { mediaReference } from '../src/domain/resource-table.js';
import type { ResourceRowValue } from '../src/shared/resource-table.js';
import type { ResourceSourceReader } from '../src/domain/resource-source.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
  'base64',
);
const row = (text: string, sources: string[] = []): ResourceRowValue => ({
  id: randomUUID(),
  text,
  media: sources.map(mediaReference),
  background: 'color',
});
async function fixture(run: (directory: string, store: WorkspaceStore) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-resource-source-'));
  const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
  try {
    await run(directory, store);
  } finally {
    store.close();
    assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith('wb-resource-source-'));
    await rm(directory, { recursive: true, force: true });
  }
}
async function save(store: WorkspaceStore, rows: ResourceRowValue[]) {
  const combination = await store.createDraft({
    name: '来源检查生成样本',
    note: '',
    steps: [
      {
        id: randomUUID(),
        type: 'post',
        resourceMode: 'table',
        resourceDirectory: '',
        count: 1,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: true,
      },
    ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  return await store.resourceTables.save(combination.id, 0, rows);
}

test('saved-row preview delivers only the selected real media without changing table or task ledger', async () =>
  fixture(async (dir, store) => {
    const source = path.join(dir, 'selected.png');
    await writeFile(source, png);
    const video = path.join(dir, 'clip.mp4');
    await copyFile(path.resolve('public/sample.mp4'), video);
    const rows = [row('第一行', [source]), row('第二行', [video])];
    const table = await save(store, rows);
    const service = new ResourceTableService(
      store.resourceTables,
      new FilesystemResourceSourceReader(),
    );
    const request = {
      combinationId: table.combinationId,
      expectedRevision: table.revision,
      rowId: rows[0]!.id,
      fileIndex: 0,
    };
    let delivered = 0;
    await service.previewMedia(
      request,
      () => {},
      async (media) => {
        delivered++;
        assert.equal(media.contentType, 'image/png');
        assert.deepEqual(Buffer.from(media.bytes), png);
      },
    );
    await service.previewMedia(
      { ...request, rowId: rows[1]!.id },
      () => {},
      async (media) => {
        delivered++;
        assert.equal(media.contentType, 'video/mp4');
        assert.deepEqual(Buffer.from(media.bytes), await readFile(video));
      },
    );
    assert.equal(delivered, 2);
    assert.deepEqual(await store.resourceTables.read(table.combinationId), table);
    assert.equal((await store.tasks.list()).length, 0);
    await assert.rejects(
      service.previewMedia(
        { ...request, rowId: randomUUID() },
        () => {},
        async () => {
          throw Error('UNEXPECTED_DELIVERY');
        },
      ),
      /这行资源已删除/,
    );
    await assert.rejects(
      service.previewMedia(
        { ...request, expectedRevision: 0 },
        () => {},
        async () => {
          throw Error('UNEXPECTED_DELIVERY');
        },
      ),
      /资源表已修改/,
    );
    await assert.rejects(
      service.previewMedia(
        { ...request, source },
        () => {},
        async () => {},
      ),
    );
  }));

test('media preview bounds allocation, rejects pending Drive, revokes changed revision and releases its busy slot', async () =>
  fixture(async (dir, store) => {
    const source = path.join(dir, 'too-large.png');
    const handle = await open(source, 'wx');
    try {
      await handle.write(png);
      await handle.truncate(20 * 1024 ** 2 + 1);
    } finally {
      await handle.close();
    }
    const rows = [
      row('大图', [source]),
      row('网盘', ['https://drive.google.com/file/d/preview-generated/view']),
    ];
    const table = await save(store, rows);
    const service = new ResourceTableService(
      store.resourceTables,
      new FilesystemResourceSourceReader(),
    );
    const request = {
      combinationId: table.combinationId,
      expectedRevision: table.revision,
      rowId: rows[0]!.id,
      fileIndex: 0,
    };
    const noDelivery = async () => {
      throw Error('UNEXPECTED_DELIVERY');
    };
    await assert.rejects(
      service.previewMedia(request, () => {}, noDelivery),
      /预览上限/,
    );
    await assert.rejects(
      service.previewMedia({ ...request, rowId: rows[1]!.id }, () => {}, noDelivery),
      /需先下载/,
    );
    await writeFile(source, png);
    let changed = false;
    await assert.rejects(
      service.previewMedia(
        request,
        async () => {
          if (!changed) {
            changed = true;
            await store.resourceTables.save(table.combinationId, table.revision, rows);
          }
        },
        noDelivery,
      ),
      /资源表已修改/,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    const current = { ...request, expectedRevision: table.revision + 1 };
    const pending = service.previewMedia(
      current,
      () => {},
      async () => {
        deliveryStarted();
        await held;
      },
    );
    await started;
    await assert.rejects(
      service.previewMedia(current, () => {}, noDelivery),
      /另一份媒体正在读取/,
    );
    release();
    await pending;
    await service.previewMedia(
      current,
      () => {},
      async (media) => assert.deepEqual(Buffer.from(media.bytes), png),
    );
  }));

test('saved resource rows inspect real bytes, preserve ordered media and match existing v1 scanner fingerprints', async () =>
  fixture(async (dir, store) => {
    const source = path.join(dir, 'first.png'),
      renamed = path.join(dir, 'renamed.png');
    await writeFile(source, png);
    await copyFile(source, renamed);
    const video = path.join(dir, 'clip.mp4');
    await copyFile(path.resolve('public/sample.mp4'), video);
    const rows = [
      row('\uFEFF正文\r\n', [source]),
      row('正文', [renamed]),
      row('', [video]),
      row('相册', [source, renamed]),
      row('相册', [renamed, source]),
      row('普通正文'),
      row('x'.repeat(4001)),
      row(''),
    ];
    const table = await save(store, rows);
    const service = new ResourceTableService(
      store.resourceTables,
      new FilesystemResourceSourceReader(),
    );
    const report = await service.checkSources({
      combinationId: table.combinationId,
      expectedRevision: 1,
    });
    assert.equal(report.verifiedSources, 7);
    assert.equal(report.uniqueContents, 5);
    assert.equal(report.rows[1]?.duplicateOf, rows[0]?.id);
    assert.equal(report.rows[4]?.duplicateOf, rows[3]?.id);
    assert.deepEqual(
      report.rows[3]?.files.map((file) => file.name),
      ['first.png', 'renamed.png'],
    );
    assert.deepEqual(
      report.rows[4]?.files.map((file) => file.name),
      ['renamed.png', 'first.png'],
    );
    assert.equal(report.rows[0]?.files[0]?.digest, createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(report.rows[6]?.blockers, ['TEXT_INPUT_LIMIT', 'BACKGROUND_UNVERIFIED']);
    assert.equal(report.rows[7]?.issue, 'EMPTY');
    assert.equal(report.publishingReady, false);
    const scanRoot = path.join(dir, 'original-scanner');
    await mkdir(scanRoot);
    const pack = path.join(scanRoot, '素材');
    await mkdir(pack);
    await writeFile(path.join(pack, '正文.txt'), '\uFEFF正文\r\n');
    await writeFile(path.join(pack, 'image.png'), png);
    const scan = await new FilesystemMaterialScanner().scan(scanRoot);
    assert.equal(scan.complete, true);
    assert.equal(scan.packages[0]?.fingerprint, report.rows[0]?.fingerprint);
    assert.deepEqual(await store.resourceTables.read(table.combinationId), table);
    assert.deepEqual(await readFile(source), png);
    const db = new DatabaseSync(path.join(dir, 'workspace.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM task_plans').get()?.n, 0);
    } finally {
      db.close();
    }
  }));

test('missing, wrong header and directory junctions cannot be verified; Drive references never read local IO', async () =>
  fixture(async (dir, store) => {
    const bad = path.join(dir, 'bad.mp4');
    await writeFile(bad, '<html>download page</html>');
    const real = path.join(dir, 'media');
    await mkdir(real);
    await writeFile(path.join(real, 'good.png'), png);
    const linked = path.join(dir, 'junction');
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const rows = [
      row('缺失', [path.join(dir, 'missing.png')]),
      row('', [bad]),
      row('', [path.join(linked, 'good.png')]),
      row('', ['https://drive.google.com/file/d/Generated_NotDownloaded/view']),
    ];
    const table = await save(store, rows);
    const report = await new ResourceTableService(
      store.resourceTables,
      new FilesystemResourceSourceReader(),
    ).checkSources({ combinationId: table.combinationId, expectedRevision: 1 });
    assert.deepEqual(
      report.rows.map((result) => result.issue),
      ['FILE_UNAVAILABLE', 'TYPE_MISMATCH', 'PATH_UNSUPPORTED', 'DRIVE_DOWNLOAD_PENDING'],
    );
    assert.equal(report.verifiedSources, 0);
    assert.equal(report.uniqueContents, 0);
    assert.ok(
      report.rows.every((result) => result.files.length === 0 && result.fingerprint === null),
    );
  }));

test('file mutation during streamed reading invalidates its entire row and does not return a partial media list', async () =>
  fixture(async (dir) => {
    const source = path.join(dir, 'changing.png');
    await writeFile(source, png);
    let changed = false;
    const result = await new FilesystemResourceSourceReader().verify(
      row('', [source, source]),
      (bytes = 0) => {
        if (bytes && !changed) {
          changed = true;
          writeFileSync(source, Buffer.concat([png, Buffer.from('changed')]));
        }
      },
    );
    assert.equal(changed, true);
    assert.deepEqual(result, { verified: false, issue: 'FILE_CHANGED' });
  }));

test('stale revisions reject before IO; edits from a second database handle cancel in-flight source inspection', async () =>
  fixture(async (dir, store) => {
    const table = await save(store, [row('原正文')]);
    let reads = 0;
    const reader: ResourceSourceReader = {
      verify: async () => {
        reads++;
        return { verified: false, issue: 'EMPTY' };
      },
    };
    const service = new ResourceTableService(store.resourceTables, reader);
    await assert.rejects(
      service.checkSources({ combinationId: table.combinationId, expectedRevision: 2 }),
      /资源表已修改/,
    );
    assert.equal(reads, 0);
    const second = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
    try {
      const racing: ResourceSourceReader = {
        verify: async (_row, current) => {
          second.resourceTables.save(table.combinationId, 1, [row('其他窗口')]);
          await current();
          return { verified: false, issue: 'EMPTY' };
        },
      };
      await assert.rejects(
        new ResourceTableService(store.resourceTables, racing).checkSources({
          combinationId: table.combinationId,
          expectedRevision: 1,
        }),
        /资源表已修改/,
      );
      assert.equal(await store.resourceTables.revision(table.combinationId), 2);
      assert.equal(
        (await store.resourceTables.read(table.combinationId)).rows[0]?.text,
        '其他窗口',
      );
    } finally {
      second.close();
    }
  }));

test('single-flight backpressure, cancellation, deadline, rollback clock and read budget invalidate whole checks and release the slot', async () =>
  fixture(async (_dir, store) => {
    const table = await save(store, [row('一'), row('二')]);
    const input = { combinationId: table.combinationId, expectedRevision: 1 };
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let connected = true;
    const service = new ResourceTableService(store.resourceTables, {
      verify: async (_row, current) => {
        entered?.();
        await waiting;
        await current();
        return { verified: false, issue: 'EMPTY' };
      },
    });
    const first = service.checkSources(input, () => {
      if (!connected) throw Error('client closed');
    });
    await ready;
    await assert.rejects(service.checkSources(input), /正在检查/);
    connected = false;
    release?.();
    await assert.rejects(first, /来源检查未完成/);
    connected = true;
    assert.equal((await service.checkSources(input)).rows.length, 2);
    let clock = 1_000;
    for (const next of [31_001, -1, Number.NaN]) {
      clock = 1_000;
      const timed = new ResourceTableService(
        store.resourceTables,
        {
          verify: async (_row, current) => {
            clock = next;
            await current();
            return { verified: false, issue: 'EMPTY' };
          },
        },
        () => clock,
      );
      await assert.rejects(timed.checkSources(input), /长时间没有进展/);
    }
    const over = new ResourceTableService(store.resourceTables, {
      verify: async (_row, current) => {
        await current(10 * 1024 ** 3 + 1);
        return { verified: false, issue: 'EMPTY' };
      },
    });
    await assert.rejects(over.checkSources(input), /10GiB/);
  }));

test('source contracts reject arbitrary paths, spoofed verification counts, duplicated IDs and bad duplicate references', () => {
  assert.equal(
    ResourceSourceReport.safeParse({
      combinationId: randomUUID(),
      expectedRevision: 1,
      path: 'C:\\private.png',
    }).success,
    false,
  );
  const item = {
    rowId: randomUUID(),
    sourceVerified: true,
    issue: null,
    fingerprint: 'a'.repeat(64),
    files: [],
    duplicateOf: null,
    blockers: [],
  };
  const report = {
    combinationId: randomUUID(),
    expectedRevision: 1,
    checkedAt: 0,
    readonly: true,
    publishingReady: false,
    fingerprintVersion: 1,
    rows: [item],
    verifiedSources: 1,
    uniqueContents: 1,
  };
  assert.equal(ResourceSourceReport.safeParse(report).success, true);
  assert.equal(
    ResourceSourceReport.safeParse({
      ...report,
      rows: [{ ...item, sourceVerified: false, fingerprint: null }],
      verifiedSources: 0,
      uniqueContents: 0,
    }).success,
    false,
  );
  assert.equal(ResourceSourceReport.safeParse({ ...report, verifiedSources: 2 }).success, false);
  assert.equal(
    ResourceSourceReport.safeParse({ ...report, rows: [item, item], verifiedSources: 2 }).success,
    false,
  );
  assert.equal(
    ResourceSourceReport.safeParse({ ...report, rows: [{ ...item, duplicateOf: randomUUID() }] })
      .success,
    false,
  );
});

test('explicit row subsets retain saved order, reject duplicate/foreign rows before IO and check only selected sources', async () =>
  fixture(async (_dir, store) => {
    const rows = [row('一'), row('二'), row('三')],
      table = await save(store, rows);
    const read: string[] = [];
    const service = new ResourceTableService(store.resourceTables, {
      verify: async (selected) => {
        read.push(selected.id);
        return { verified: false, issue: 'EMPTY' };
      },
    });
    const input = { combinationId: table.combinationId, expectedRevision: 1 };
    await assert.rejects(service.checkSources({ ...input, rowIds: [rows[0]?.id, rows[0]?.id] }));
    await assert.rejects(service.checkSources({ ...input, rowIds: [randomUUID()] }), /当前版本/);
    assert.equal(read.length, 0);
    const report = await service.checkSources({ ...input, rowIds: [rows[2]?.id, rows[0]?.id] });
    assert.deepEqual(read, [rows[0]?.id, rows[2]?.id]);
    assert.deepEqual(
      report.rows.map((result) => result.rowId),
      read,
    );
  }));
