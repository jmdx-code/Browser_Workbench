import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import {
  dropResourceTableSchema,
  latestMigrationBackupMarker,
} from './fixtures/workspace-schema.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { FilesystemResourceSourceReader } from '../src/infrastructure/resource-source-reader.js';
import { ResourceSourceReport } from '../src/shared/resource-source.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { CombinationSchema, type Combination } from '../src/shared/contracts.js';
import { ResourceTable, ResourceRows } from '../src/shared/resource-table.js';
import {
  parseResourceClipboard,
  pasteResourceCells,
  fillResourceMedia,
  emptyResourceRow,
  mediaReference,
  hasResource,
  validateResourceRows,
  resourceType,
  resourceCellValue,
  formatResourceCellsForClipboard,
  parseResourceBackground,
  parseResourcePurpose,
  parseResourceAILabel,
} from '../src/domain/resource-table.js';

function combination(): Combination {
  return {
    name: '资源表验收',
    note: '本机生成引用，不发布',
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
  };
}
async function fixture(run: (store: WorkspaceStore, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-resource-table-'));
  const file = path.join(directory, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, file);
  } finally {
    store.close();
    assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith('wb-resource-table-'));
    await rm(directory, { recursive: true, force: true });
  }
}
test('Sheets TSV preserves multiline, escaped quotes, tabs, formulas and literal HTML; malformed and oversized clipboard rejected', () => {
  assert.deepEqual(
    parseResourceClipboard('"两行\n正文\t中有制表"\t"双""引号"\t彩贴\r\n=SUM(A1:A2)\t\t文字\r\n'),
    [
      ['两行\n正文\t中有制表', '双"引号', '彩贴'],
      ['=SUM(A1:A2)', '', '文字'],
    ],
  );
  assert.deepEqual(parseResourceClipboard('<img onerror=alert(1)>\n'), [
    ['<img onerror=alert(1)>'],
  ]);
  assert.throws(() => parseResourceClipboard('"未闭合'), /引号/);
  assert.throws(() => parseResourceClipboard('"正文"后缀'), /引号/);
  assert.throws(() => parseResourceClipboard('a\tb\tc\td\te\tf'), /五列/);
  assert.throws(() => parseResourceClipboard('x\n'.repeat(1001)), /1000/);
  assert.throws(() => parseResourceClipboard('字'.repeat(1500000)), /4MiB/);
});
test('200 captions + 100 Drive references + 70 local videos + 30 color text + 5 videos and 5 images fill exact rows without overwrite', () => {
  let rows = pasteResourceCells(
    [],
    0,
    0,
    Array.from({ length: 200 }, (_, i) => '文案' + (i + 1)).join('\n'),
    randomUUID,
  );
  rows = pasteResourceCells(
    rows,
    0,
    1,
    Array.from(
      { length: 100 },
      (_, i) => 'https://drive.google.com/file/d/Generated_' + i + '/view?usp=sharing',
    ).join('\n'),
    randomUUID,
  );
  const original = structuredClone(rows);
  rows = fillResourceMedia(
    rows,
    0,
    Array.from({ length: 70 }, (_, i) => mediaReference('D:\\生成\\视频' + i + '.mp4')),
    randomUUID,
  );
  assert.equal(rows.length, 200);
  assert.equal(rows[99]?.media[0]?.kind, 'drive');
  assert.equal(rows[100]?.text, '文案101');
  assert.equal(rows[100]?.media[0]?.name, '视频0.mp4');
  assert.equal(rows[169]?.media[0]?.name, '视频69.mp4');
  assert.equal(
    rows.slice(170).every((row) => !row.media.length && row.background === 'color'),
    true,
  );
  assert.equal(original[100]?.media.length, 0);
  rows.push(emptyResourceRow(randomUUID()));
  rows = fillResourceMedia(
    rows,
    200,
    [
      ...Array.from({ length: 5 }, (_, i) => mediaReference('D:\\生成\\末尾' + i + '.mp4')),
      ...Array.from({ length: 5 }, (_, i) => mediaReference('D:\\生成\\末尾' + i + '.jpg')),
    ],
    randomUUID,
  );
  assert.equal(rows.length, 210);
  assert.equal(rows.filter(hasResource).length, 210);
  assert.equal(
    rows.slice(200).every((row) => !row.text),
    true,
  );
  assert.equal(
    rows.slice(200, 205).every((row) => resourceType(row) === '视频'),
    true,
  );
  assert.equal(
    rows.slice(205).every((row) => resourceType(row) === '单图'),
    true,
  );
  assert.equal(pasteResourceCells(rows, 0, 0, '覆盖', randomUUID)[0]?.text, '覆盖');
  assert.equal(rows[0]?.text, '文案1');
  assert.throws(
    () => pasteResourceCells(rows, 0, 1, 'https://evil.example/video.mp4', randomUUID),
    /Google Drive/,
  );
  assert.equal(rows[0]?.media[0]?.kind, 'drive');
});
test('resource references cannot spoof verified format or become arbitrary URL reads; bounds and mixed album rules atomic', () => {
  for (const source of [
    'javascript:alert(1)',
    'file:///C:/x.mp4',
    'http://127.0.0.1/a.mp4',
    'https://drive.google.com.evil.test/file/d/id/view',
    'https://user@drive.google.com/file/d/id/view',
    'https://drive.google.com/folders/ID',
    'C:\\fakepath\\a.mp4',
    'D:\\x.exe',
  ])
    assert.throws(() => mediaReference(source));
  const media = mediaReference('https://drive.google.com/open?id=Generated_1&resourcekey=key');
  assert.equal(media.mediaType, 'unknown');
  assert.throws(
    () =>
      validateResourceRows([
        { ...emptyResourceRow(randomUUID()), media: [{ ...media, mediaType: 'video' }] },
      ]),
    /不一致/,
  );
  const row = {
    ...emptyResourceRow(randomUUID()),
    media: [mediaReference('D:\\x.jpg'), mediaReference('D:\\y.mp4')],
  };
  assert.throws(() => validateResourceRows([row]), /独占/);
  const rows = Array.from({ length: 1000 }, () => emptyResourceRow(randomUUID()));
  assert.throws(
    () =>
      fillResourceMedia(
        rows,
        999,
        [mediaReference('D:\\a.jpg'), mediaReference('D:\\b.jpg')],
        randomUUID,
      ),
    /1000/,
  );
  assert.equal(rows[999]?.media.length, 0);
  assert.equal(ResourceRows.safeParse([rows[0], rows[0]]).success, false);
  assert.throws(() => pasteResourceCells(rows, 1000, 0, 'x', randomUUID), /容量/);
  const legacy = {
    ...combination(),
    steps: [{ ...combination().steps[0], resourceMode: undefined, resourceDirectory: 'D:\\old' }],
  };
  assert.equal(CombinationSchema.safeParse(legacy).success, true);
  assert.equal(
    CombinationSchema.safeParse({
      ...legacy,
      steps: [{ ...legacy.steps[0], resourceDirectory: '' }],
    }).success,
    false,
  );
  assert.equal(CombinationSchema.safeParse(combination()).success, true);
});
test('resource table versions persist, conflict is atomic across handles, copies isolated, old configurations untouched and history immutable', async () =>
  fixture(async (store, file) => {
    const row = await store.createCombination(combination());
    const other = await store.createDraft({ ...combination(), name: '另一组合' });
    const rows = pasteResourceCells([], 0, 0, '文案一\n文案二', randomUUID);
    rows.push(emptyResourceRow(randomUUID()));
    assert.equal((await store.resourceTables.read(row.id)).revision, 0);
    const saved = await store.resourceTables.save(row.id, 0, rows);
    assert.equal(saved.revision, 1);
    assert.equal((await store.resourceTables.summaries())[0]?.remaining, 2);
    saved.rows[0]?.media.push(mediaReference('D:\\changed.jpg'));
    assert.equal((await store.resourceTables.read(row.id)).rows[0]?.media.length, 0);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.resourceTables.read(row.id).rows, rows);
      reopened.resourceTables.save(row.id, 1, [
        {
          ...rows[0],
          id: rows[0]?.id ?? randomUUID(),
          text: '窗口二',
          media: [],
          background: 'plain',
        },
      ]);
      await assert.rejects(
        async () => await store.resourceTables.save(row.id, 1, rows),
        /其他窗口/,
      );
      assert.equal((await store.resourceTables.read(row.id)).rows[0]?.text, '窗口二');
      assert.equal((await store.resourceTables.read(other.id)).revision, 0);
      const copy = await store.copyCombination(row.id);
      const copied = await store.resourceTables.read(copy.id);
      assert.equal(copied.rows[0]?.text, '窗口二');
      assert.notEqual(copied.rows[0]?.id, rows[0]?.id);
      await store.resourceTables.save(copy.id, 1, []);
      assert.equal((await store.resourceTables.read(row.id)).rows.length, 1);
      assert.equal((await store.combinations()).find((value) => value.id === row.id)?.revision, 0);
      assert.equal((await store.combinations()).find((value) => value.id === row.id)?.version, 1);
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () => db.prepare('UPDATE resource_table_versions SET body=?').run('[]'),
        /IMMUTABLE/,
      );
      assert.throws(() => db.prepare('DELETE FROM resource_table_versions').run(), /IMMUTABLE/);
      assert.equal(db.prepare('SELECT count(*) n FROM task_plans').get()?.n, 0);
      assert.equal(
        JSON.parse(
          String(
            db
              .prepare(
                'SELECT body FROM resource_table_versions WHERE combination_id=? AND revision=1',
              )
              .get(row.id)?.body,
          ),
        ).length,
        3,
      );
      const before = (await store.combinations()).length;
      db.exec(
        "CREATE TRIGGER fail_resource_copy BEFORE INSERT ON resource_table_versions BEGIN SELECT RAISE(ABORT,'INJECTED_WRITE_FAILURE'); END",
      );
      await assert.rejects(async () => await store.copyCombination(row.id), /INJECTED/);
      assert.equal((await store.combinations()).length, before);
    } finally {
      db.close();
    }
  }));
test('authenticated HTTP saves 200 long captions beyond old JSON budget without executing media, rejects conflicts and strict extra fields', async () =>
  fixture(async (repo, dirFile) => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = await startBridgeServer({
      root: process.cwd(),
      dataDir: path.dirname(dirFile),
      port,
      extensionIds: ['a'.repeat(32)],
      appRoutes: ({ core, store, tasks }) =>
        workspaceApi(
          new WorkspaceService(repo, new BridgeProfileSource(core, store, tasks)),
          undefined,
          undefined,
          undefined,
          new ResourceTableService(repo.resourceTables, new FilesystemResourceSourceReader()),
        ),
    });
    try {
      const combo = await repo.createDraft(combination());
      const rows = pasteResourceCells(
        [],
        0,
        0,
        Array.from({ length: 200 }, (_, i) => '长文案' + i + '字'.repeat(800)).join('\n'),
        randomUUID,
      );
      const landing = await fetch(server.origin);
      const cookie = landing.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      assert.equal(
        (await fetch(server.origin + '/api/workspace', { headers: { cookie } })).status,
        409,
      );
      assert.equal(
        (
          await fetch(server.origin + '/api/workspace', {
            headers: { cookie, 'x-workbench-workspace-contract': '2' },
          })
        ).status,
        200,
      );
      const post = (route: string, body: unknown, authenticated = true, origin = server.origin) =>
        fetch(server.origin + '/api/workspace' + route, {
          method: 'POST',
          headers: {
            ...(authenticated ? { cookie } : {}),
            origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      assert.equal(
        (await post('/resource-tables/read', { combinationId: combo.id }, false)).status,
        401,
      );
      assert.equal(
        (
          await post(
            '/resource-tables/save',
            { combinationId: combo.id, expectedRevision: 0, rows },
            true,
            'https://other.example',
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post('/resource-tables/save', {
            combinationId: combo.id,
            expectedRevision: 0,
            rows,
            verified: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (await post('/resource-tables/read', { combinationId: randomUUID() })).status,
        404,
      );
      const result = await post('/resource-tables/save', {
        combinationId: combo.id,
        expectedRevision: 0,
        rows,
      });
      assert.equal(result.status, 200);
      assert.equal(ResourceTable.parse(await result.json()).rows.length, 200);
      const checkInput = { combinationId: combo.id, expectedRevision: 1 };
      assert.equal((await post('/resource-tables/check', checkInput, false)).status, 401);
      assert.equal(
        (await post('/resource-tables/check', checkInput, true, 'https://other.example')).status,
        403,
      );
      assert.equal(
        (await post('/resource-tables/check', { ...checkInput, path: 'C:\\private.png' })).status,
        400,
      );
      assert.equal(
        (await post('/resource-tables/check', { ...checkInput, expectedRevision: 2 })).status,
        409,
      );
      assert.equal(
        (await post('/resource-tables/check', { ...checkInput, rowIds: [randomUUID()] })).status,
        404,
      );
      const checkResponse = await post('/resource-tables/check', checkInput);
      assert.equal(checkResponse.status, 200);
      const checked = ResourceSourceReport.parse(await checkResponse.json());
      assert.equal(checked.verifiedSources, 200);
      assert.equal(checked.publishingReady, false);
      assert.equal(await repo.resourceTables.revision(combo.id), 1);
      assert.equal(
        (
          await post('/resource-tables/save', {
            combinationId: combo.id,
            expectedRevision: 0,
            rows,
          })
        ).status,
        409,
      );
      const fragmented = Buffer.from(
        JSON.stringify({
          combinationId: combo.id,
          expectedRevision: 1,
          rows: [{ ...emptyResourceRow(randomUUID()), text: '中文😀正文' }],
        }),
      );
      const split = fragmented.indexOf(Buffer.from('中')) + 1;
      const status = await new Promise<number>((resolve) => {
        const req = request(
          server.origin + '/api/workspace/resource-tables/save',
          {
            method: 'POST',
            headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.write(fragmented.subarray(0, split));
        setTimeout(() => req.end(fragmented.subarray(split)), 5);
      });
      assert.equal(status, 200);
      assert.equal((await repo.resourceTables.read(combo.id)).rows[0]?.text, '中文😀正文');
      assert.equal(
        (await post('/resource-tables/read', { combinationId: combo.id, pad: 'x'.repeat(140000) }))
          .status,
        400,
      );
      assert.equal(
        (
          await post('/resource-tables/save', {
            combinationId: combo.id,
            expectedRevision: 2,
            rows: [],
            pad: 'x'.repeat(4 * 1024 * 1024),
          })
        ).status,
        400,
      );
      assert.equal((await repo.resourceTables.read(combo.id)).revision, 2);
      const copied = await post('/combinations/copy', { id: combo.id });
      assert.equal(copied.status, 201);
      assert.equal(
        (
          await fetch(server.origin + '/api/workspace/resource-tables/summaries', {
            headers: { cookie },
          })
        ).status,
        200,
      );
    } finally {
      await server.close();
    }
  }));
test('schema12 migration backs up before adding resource tables and preserves every original SQL definition and configuration', async () =>
  fixture(async (store, file) => {
    const combo = await store.createCombination({
      ...combination(),
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          resourceDirectory: 'D:\\legacy',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: true,
        },
      ],
    });
    await store.createGroup('旧分组', 'green');
    await store.renameProfile(randomUUID(), '旧资料');
    const db = new DatabaseSync(file);
    db.exec(dropResourceTableSchema + 'PRAGMA user_version=12');
    const before = db
      .prepare('SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name')
      .all();
    const configs = await store.combinations();
    const metadata = await store.profileMetadata();
    const groups = await store.groups();
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(upgraded.combinations(), configs);
      assert.deepEqual(upgraded.profileMetadata(), metadata);
      assert.deepEqual(upgraded.groups(), groups);
      assert.equal(upgraded.resourceTables.read(combo.id).revision, 0);
      assert.equal(upgraded.resourceTables.summaries().length, 0);
      const after = new DatabaseSync(file, { readOnly: true });
      try {
        for (const definition of before) assertSchemaDefinitionPreserved(after, definition);
        assert.equal(
          after.prepare('PRAGMA user_version').get()?.user_version,
          workspaceSchemaVersion,
        );
      } finally {
        after.close();
      }
      const backupFile = (await readdir(path.dirname(file))).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(backupFile);
      const backup = new DatabaseSync(path.join(path.dirname(file), backupFile), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 12);
        assert.equal(
          backup
            .prepare("SELECT count(*) n FROM sqlite_master WHERE name='resource_table_heads'")
            .get()?.n,
          0,
        );
      } finally {
        backup.close();
      }
    } finally {
      upgraded.close();
    }
  }));
import { assertSchemaDefinitionPreserved } from './fixtures/workspace-schema.js';

test('five-column Sheets overwrite, single-cell rectangle fill and quoted TSV roundtrip', () => {
  let rows = pasteResourceCells(
    [],
    0,
    0,
    '"line1\nline2\t\"\"quoted\"\""\tD:\\image.jpg\tPLAIN\tboth\tON',
    randomUUID,
  );
  assert.equal(rows[0]?.background, 'plain');
  assert.equal(rows[0]?.purpose, 'both');
  assert.equal(rows[0]?.aiLabel, 'on');
  const tsv = formatResourceCellsForClipboard(rows, 0, 0, 0, 4);
  const roundtrip = pasteResourceCells([], 0, 0, tsv, randomUUID);
  assert.deepEqual({ ...roundtrip[0], id: rows[0]!.id }, rows[0]);
  rows = pasteResourceCells(rows, 0, 0, 'new caption', randomUUID, 2, 0);
  assert.deepEqual(
    rows.map((r) => r.text),
    ['new caption', 'new caption', 'new caption'],
  );
  assert.equal(rows[0]?.media[0]?.source, 'D:\\image.jpg');
  const original = structuredClone(rows);
  assert.throws(() => pasteResourceCells(rows, 0, 3, '默认', randomUUID, 2, 4), /用途/);
  assert.deepEqual(rows, original);
  rows = pasteResourceCells(rows, 0, 4, 'off', randomUUID, 2, 4);
  assert.ok(rows.every((r) => r.aiLabel === 'off'));
  rows = pasteResourceCells(rows, 0, 1, 'D:\\replace.mp4', randomUUID);
  assert.equal(rows[0]?.media[0]?.mediaType, 'video');
  const blank = pasteResourceCells(rows, 0, 4, '', randomUUID, 2, 4);
  assert.ok(blank.every((r) => r.aiLabel === 'preserve-current'));
  const rect = pasteResourceCells(rows, 0, 0, '', randomUUID, 1, 4);
  assert.equal(rect[0]?.text, '');
  assert.deepEqual(rect[0]?.media, []);
  assert.equal(rect[0]?.background, 'color');
  assert.equal(rect[0]?.purpose, 'post');
  assert.throws(() => pasteResourceCells(rows, 0, 0, 'x', randomUUID, 1000000000, 0), /范围/);
  assert.throws(() => pasteResourceCells(rows, 999, 0, 'a\nb', randomUUID), /范围/);
  assert.throws(() => pasteResourceCells(rows, 0, 4, 'off\ton', randomUUID), /五列/);
  const old = ResourceRows.parse([{ ...emptyResourceRow(randomUUID()), text: 'old' }]);
  assert.equal(old[0]?.aiLabel, undefined);
});

test('resource option aliases accept natural Sheets values and reject unknown settings', () => {
  for (const value of ['普通文字', '文字', '普通', '白底', ' PLAIN '])
    assert.equal(parseResourceBackground(value), 'plain');
  for (const value of ['彩贴', '彩色', '彩底', 'color', ''])
    assert.equal(parseResourceBackground(value), 'color');
  for (const value of ['快拍', 'STORY']) assert.equal(parseResourcePurpose(value), 'story');
  for (const value of ['通用', '两者通用', '帖子及快拍', '全部', 'BOTH'])
    assert.equal(parseResourcePurpose(value), 'both');
  for (const value of ['帖子', '发帖', 'post', ''])
    assert.equal(parseResourcePurpose(value), 'post');
  for (const value of ['开启', '开启声明', '是', '声明', 'ai', 'ON', 'true', '1'])
    assert.equal(parseResourceAILabel(value), 'on');
  for (const value of ['关闭', '关闭声明', '否', '不声明', 'OFF', 'false', '0'])
    assert.equal(parseResourceAILabel(value), 'off');
  for (const value of [
    '默认',
    '保持默认',
    '保持',
    '保持 Facebook 当前设置',
    'preserve-current',
    '',
  ])
    assert.equal(parseResourceAILabel(value), 'preserve-current');
  for (const parse of [parseResourceBackground, parseResourcePurpose, parseResourceAILabel])
    assert.throws(() => parse('invalid'));
});

test('optional row AI survives saved versions without rewriting an older row lacking the field', async () => {
  await fixture(async (store) => {
    const combo = await store.createDraft(combination()),
      old = { ...emptyResourceRow(randomUUID()), text: 'old row' };
    await store.resourceTables.save(combo.id, 0, [old]);
    await store.resourceTables.save(combo.id, 1, [{ ...old, aiLabel: 'on' }]);
    assert.equal((await store.resourceTables.read(combo.id)).rows[0]?.aiLabel, 'on');
    const original = await store.resourceTables.readVersion(combo.id, 1);
    assert.equal(original.rows[0]?.aiLabel, undefined);
    assert.deepEqual(original.rows, [old]);
  });
});

test('one row of multiple cells repeats down a multi-row selection, even with a single target column', () => {
  const original = Array.from({ length: 5 }, () => emptyResourceRow(randomUUID()));
  for (const endColumn of [2, 4]) {
    const rows = pasteResourceCells(
      original,
      1,
      2,
      '普通文字\t通用\t开启',
      randomUUID,
      3,
      endColumn,
    );
    assert.ok(
      rows
        .slice(1, 4)
        .every(
          (row) => row.background === 'plain' && row.purpose === 'both' && row.aiLabel === 'on',
        ),
    );
    assert.deepEqual(rows[0], original[0]);
    assert.deepEqual(rows[4], original[4]);
  }
  const full = pasteResourceCells(original, 1, 0, 'caption\t\tplain\tboth\toff', randomUUID, 3, 0);
  assert.ok(full.slice(1, 4).every((row) => row.text === 'caption' && row.aiLabel === 'off'));
  const horizontal = pasteResourceCells(original, 0, 3, '\n', randomUUID, 1, 4);
  assert.equal(horizontal[0]?.purpose, 'post');
  assert.equal(horizontal[0]?.aiLabel, 'preserve-current');
  const media = pasteResourceCells(original, 0, 0, 'C:\\one.jpg\nC:\\two.mp4', randomUUID, 1, 1);
  assert.equal(media[0]?.text, 'C:\\one.jpg');
  assert.equal(media[0]?.media[0]?.mediaType, 'image');
  assert.equal(media[1]?.text, 'C:\\two.mp4');
  assert.equal(media[1]?.media[0]?.mediaType, 'video');
  const exact = pasteResourceCells(
    original,
    1,
    2,
    'plain\tpost\ton\ncolor\tboth\toff',
    randomUUID,
    4,
    4,
  );
  assert.equal(exact[3]?.background, 'color'); // An actual multi-row matrix does not repeat vertically.
  assert.throws(
    () => pasteResourceCells(original, 0, 3, 'post\toff\textra', randomUUID, 2, 3),
    /五列/,
  );
  assert.ok(original.every((row) => row.background === 'color' && row.media.length === 0));
});

test('media insertion and paste force plain background; legacy media displays plain without changing history', () => {
  const original = Array.from({ length: 3 }, () => emptyResourceRow(randomUUID()));
  const filled = fillResourceMedia(
    original,
    0,
    [mediaReference('C:\\one.jpg'), mediaReference('C:\\two.mp4')],
    randomUUID,
  );
  assert.ok(filled.slice(0, 2).every((row) => row.background === 'plain'));
  assert.equal(filled[2]?.background, 'color');
  const pasted = pasteResourceCells(
    original,
    0,
    0,
    'caption\tC:\\one.jpg\t彩贴\nvideo\tC:\\two.mp4\tcolor',
    randomUUID,
  );
  assert.ok(pasted.slice(0, 2).every((row) => row.background === 'plain'));
  const recolor = pasteResourceCells(pasted, 0, 2, '彩贴', randomUUID, 2, 2);
  assert.equal(recolor[0]?.background, 'plain');
  assert.equal(recolor[1]?.background, 'plain');
  assert.equal(recolor[2]?.background, 'color');
  const old = { ...emptyResourceRow(randomUUID()), media: [mediaReference('C:\\old.jpg')] };
  assert.equal(resourceCellValue(old, 2), '普通文字');
  assert.equal(old.background, 'color');
  assert.equal(pasteResourceCells([old], 0, 1, '', randomUUID)[0]?.background, 'color');
  assert.equal(pasteResourceCells([old], 0, 1, '\t彩贴', randomUUID)[0]?.background, 'color');
});
