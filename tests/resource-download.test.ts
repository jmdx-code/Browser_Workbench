import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { emptyResourceRow, mediaReference } from '../src/domain/resource-table.js';
import { ResourceDownloadService } from '../src/application/resource-download-service.js';
import { PublicResourceDriveDownloader } from '../src/infrastructure/resource-drive-downloader.js';
import { FilesystemResourceSourceReader } from '../src/infrastructure/resource-source-reader.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { ResourceDownloadFrame } from '../src/shared/resource-download.js';
import { readResourceDownloadStream } from '../src/renderer/resource-download-stream.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import type { ResourceDriveDownloader } from '../src/domain/resource-download.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
  'base64',
);
const makeRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...emptyResourceRow(randomUUID()),
    text: '批量下载' + index,
    media: [mediaReference('https://drive.google.com/file/d/generated-' + index + '/view')],
  }));
const draft = async (store: WorkspaceStore) =>
  await store.createDraft({
    name: '网盘资源',
    note: '',
    steps: [],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
const framesBody = (frames: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(
        frames.map((value) => JSON.stringify(value) + '\n').join(''),
      );
      for (let offset = 0; offset < bytes.length; offset += 11)
        controller.enqueue(bytes.slice(offset, offset + 11));
      controller.close();
    },
  });

test('public batch download caps real downloader concurrency, persists successful local members, retains failed URLs and original revisions, and retries only remaining members', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-download-'));
  const store = await WorkspaceStore.open(':memory:');
  let active = 0,
    maximum = 0,
    deny = true;
  const seen: string[] = [];
  const request: typeof fetch = async (input) => {
    const id = new URL(String(input)).searchParams.get('id') ?? '';
    seen.push(id);
    active++;
    maximum = Math.max(active, maximum);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    if (id === 'generated-3' && deny) return new Response('需要登录', { status: 403 });
    return new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    });
  };
  try {
    const combo = await draft(store),
      original = store.resourceTables.save(combo.id, 0, makeRows(7));
    const service = new ResourceDownloadService(
      store.resourceTables,
      new PublicResourceDriveDownloader(directory, request),
    );
    const frames: unknown[] = [];
    const report = await service.download(
      { combinationId: combo.id, expectedRevision: 1 },
      () => {},
      async (value) => {
        frames.push({ kind: 'progress', ...value });
      },
    );
    assert.equal(maximum, 3);
    assert.equal(report.progress.downloaded, 6);
    assert.equal(report.progress.failed, 1);
    assert.equal(report.progress.total, 7);
    assert.equal(report.table.revision, 7);
    assert.equal(report.issues[0]?.rowId, original.rows[3]?.id);
    assert.deepEqual(store.resourceTables.readVersion(combo.id, 1), original);
    for (const row of report.table.rows) {
      const media = row.media[0];
      assert.ok(media);
      if (row.id === original.rows[3]?.id) {
        assert.equal(media.kind, 'drive');
        continue;
      }
      assert.equal(media.kind, 'local');
      assert.deepEqual(await readFile(media.source), png);
      const checked = await new FilesystemResourceSourceReader().verify(row, () => {});
      assert.equal(checked.verified, true);
    }
    frames.push({ kind: 'completed', report });
    assert.deepEqual(await readResourceDownloadStream(framesBody(frames), () => {}), report);
    const before = seen.length;
    deny = false;
    const second = await service.download(
      {
        combinationId: combo.id,
        expectedRevision: report.table.revision,
        rowIds: report.issues.map((issue) => issue.rowId),
      },
      () => {},
      async () => {},
    );
    assert.deepEqual(seen.slice(before), ['generated-3']);
    assert.equal(second.progress.downloaded, 1);
    assert.equal(second.table.rows.filter((row) => row.media[0]?.kind === 'drive').length, 0);
    assert.equal(store.tasks.list().length, 0);
    await assert.rejects(
      service.download(
        { combinationId: combo.id, expectedRevision: 1 },
        () => {},
        async () => {},
      ),
      /资源表已修改/,
    );
  } finally {
    store.close();
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation preserves completed members, revokes all in-flight reads and rejects another batch until all work stops; concurrent edits are never overwritten', async () => {
  const store = await WorkspaceStore.open(':memory:');
  const combo = await draft(store),
    original = store.resourceTables.save(combo.id, 0, makeRows(7));
  let alive = true,
    cancelled = 0,
    release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const downloader: ResourceDriveDownloader = {
    download: async (source, _index, current) => {
      if (source.includes('generated-0/')) return mediaReference(path.resolve('generated.png'));
      await blocked;
      try {
        await current();
      } catch (error) {
        cancelled++;
        throw error;
      }
      return mediaReference(path.resolve('generated.png'));
    },
  };
  const service = new ResourceDownloadService(store.resourceTables, downloader);
  let observed: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const work = service.download(
    { combinationId: combo.id, expectedRevision: 1 },
    () => {
      if (!alive) throw Error('CLIENT_CLOSED');
    },
    async (progress) => {
      if (progress.downloaded === 1) {
        alive = false;
        observed();
      }
    },
  );
  try {
    await started;
    assert.equal(store.resourceTables.read(combo.id).rows[0]?.media[0]?.kind, 'local');
    await assert.rejects(
      service.download(
        { combinationId: combo.id, expectedRevision: 2 },
        () => {},
        async () => {},
      ),
      /另一批/,
    );
    release();
    await assert.rejects(work, /下载已停止/);
    assert.equal(cancelled, 2);
    assert.equal(
      store.resourceTables.read(combo.id).rows.filter((row) => row.media[0]?.kind === 'drive')
        .length,
      6,
    );
    assert.deepEqual(store.resourceTables.readVersion(combo.id, 1), original);
    let unblock: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const conflicting = new ResourceDownloadService(store.resourceTables, {
      download: async (_source, _index, current) => {
        await waiting;
        await current();
        return mediaReference(path.resolve('later.png'));
      },
    });
    const old = store.resourceTables.read(combo.id);
    const attempt = conflicting.download(
      { combinationId: combo.id, expectedRevision: old.revision },
      () => {},
      async () => {},
    );
    const edited = store.resourceTables.save(
      combo.id,
      old.revision,
      old.rows.map((row) => ({ ...row, text: '用户的新内容' })),
    );
    unblock();
    await assert.rejects(attempt, /其他窗口修改/);
    assert.deepEqual(store.resourceTables.read(combo.id), edited);
    assert.equal(store.tasks.list().length, 0);
  } finally {
    release();
    store.close();
  }
});

test('byte progress is delivered before a slow media finishes while the original source revision changes only on completion', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const combo = await draft(store),
      original = store.resourceTables.save(combo.id, 0, makeRows(1));
    let now = 1000;
    const frames: unknown[] = [];
    const service = new ResourceDownloadService(
      store.resourceTables,
      {
        download: async (_source, _index, current) => {
          now += 600;
          await current(128);
          await Promise.resolve();
          now += 600;
          await current(256);
          assert.deepEqual(store.resourceTables.read(combo.id), original);
          return mediaReference(path.resolve('byte-progress.png'));
        },
      },
      () => now,
    );
    const report = await service.download(
      { combinationId: combo.id, expectedRevision: 1 },
      () => {},
      async (progress) => {
        frames.push({ kind: 'progress', ...progress });
      },
    );
    assert.equal(frames.length, 4);
    assert.equal(report.progress.bytes, 384);
    frames.push({ kind: 'completed', report });
    assert.deepEqual(await readResourceDownloadStream(framesBody(frames), () => {}), report);
    assert.deepEqual(store.resourceTables.readVersion(combo.id, 1), original);
  } finally {
    store.close();
  }
});

test('download stream rejects regressed counts, changed totals, truncated completion and unrelated frames', async () => {
  const zero = { kind: 'progress', completed: 0, total: 3, downloaded: 0, failed: 0, bytes: 0 };
  const one = { ...zero, completed: 1, downloaded: 1, bytes: 100 };
  for (const frames of [
    [],
    [zero],
    [one],
    [zero, { ...one, total: 4 }],
    [zero, one, { ...one, bytes: 50 }],
  ])
    await assert.rejects(readResourceDownloadStream(framesBody(frames), () => {}));
  assert.equal(ResourceDownloadFrame.safeParse({ ...one, source: 'arbitrary' }).success, false);
});

test('authenticated real HTTP streams the download report and saved local media is previewable through the original endpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-download-http-'));
  const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const combo = await draft(store),
    table = store.resourceTables.save(combo.id, 0, makeRows(2));
  const source = path.join(directory, 'valid.png');
  await writeFile(source, png);
  const resources = new ResourceTableService(
    store.resourceTables,
    new FilesystemResourceSourceReader(),
    Date.now,
    new ResourceDownloadService(store.resourceTables, {
      download: async (_source, _index, current) => {
        await current(png.length);
        return mediaReference(source);
      },
    }),
  );
  const server = await startBridgeServer({
    root: process.cwd(),
    dataDir: path.join(directory, 'bridge'),
    port: address.port,
    extensionIds: ['a'.repeat(32)],
    appRoutes: ({ core, store: bridge, tasks }) =>
      workspaceApi(
        new WorkspaceService(store, new BridgeProfileSource(core, bridge, tasks)),
        undefined,
        undefined,
        undefined,
        resources,
      ),
  });
  try {
    const cookie = (await fetch(server.origin + '/workbench/')).headers
      .get('set-cookie')
      ?.split(';')[0];
    assert.ok(cookie);
    const post = (route: string, input: unknown) =>
      fetch(server.origin + '/api/workspace/resource-tables/' + route, {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
        },
        body: JSON.stringify(input),
      });
    const response = await post('download', { combinationId: combo.id, expectedRevision: 1 });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const report = await readResourceDownloadStream(response.body, () => {});
    assert.equal(report.progress.downloaded, 2);
    const row = report.table.rows[0];
    assert.ok(row);
    const media = await post('media', {
      combinationId: combo.id,
      expectedRevision: report.table.revision,
      rowId: row.id,
      fileIndex: 0,
    });
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
    assert.deepEqual(store.resourceTables.readVersion(combo.id, 1), table);
    assert.equal(store.tasks.list().length, 0);
  } finally {
    await server.close();
    store.close();
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});
