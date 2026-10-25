import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readResourceCheckStream } from '../src/renderer/resource-source-stream.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { emptyResourceRow } from '../src/domain/resource-table.js';
import { mediaReference } from '../src/domain/resource-table.js';
import { FilesystemResourceSourceReader } from '../src/infrastructure/resource-source-reader.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const body = (frames: unknown[], cut = 7) => {
  const bytes = new TextEncoder().encode(
    frames.map((frame) => JSON.stringify(frame) + '\n').join(''),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += cut)
        controller.enqueue(bytes.slice(index, index + cut));
      controller.close();
    },
  });
};
test('original readonly source check streams monotonic progress, complete multibyte report and cancellation without saving another ledger', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const combo = store.createDraft({
      name: '进度检查',
      note: '',
      steps: [],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const rows = [
      emptyResourceRow(randomUUID()),
      { ...emptyResourceRow(randomUUID()), text: '多字节中文内容' },
    ];
    const table = store.resourceTables.save(combo.id, 0, rows);
    const service = new ResourceTableService(
      store.resourceTables,
      {
        verify: async (_row, current) => {
          await current();
          return { verified: false, issue: 'EMPTY' };
        },
      },
      () => 1000,
    );
    const request = { combinationId: combo.id, expectedRevision: table.revision };
    const frames: unknown[] = [];
    const report = await service.checkSources(
      request,
      () => {},
      (progress) => {
        frames.push({ kind: 'progress', ...progress });
      },
    );
    frames.push({ kind: 'completed', report });
    const seen: unknown[] = [];
    assert.deepEqual(
      await readResourceCheckStream(body(frames), (value) => seen.push(value)),
      report,
    );
    assert.deepEqual(seen, [
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
    await assert.rejects(
      service.checkSources(
        request,
        () => {},
        (value) => {
          if (value.completed === 1) throw Error('cancel current observation');
        },
      ),
      /检查未完成/,
    );
    assert.deepEqual(await service.checkSources(request), report);
    assert.deepEqual(store.resourceTables.read(combo.id), table);
    assert.equal(store.tasks.list().length, 0);
  } finally {
    store.close();
  }
});

test('stream rejects truncated results, changed totals, missing progress and trailing frames, and propagates bounded errors', async () => {
  const progress = { kind: 'progress', completed: 0, total: 2 };
  for (const frames of [
    [],
    [progress],
    [progress, { ...progress, total: 3, completed: 1 }],
    [{ ...progress, completed: 1 }],
    [progress, { ...progress, completed: 2 }],
  ])
    await assert.rejects(readResourceCheckStream(body(frames), () => {}));
  await assert.rejects(
    readResourceCheckStream(
      body([
        progress,
        { kind: 'failed', code: 'RESOURCE_REVISION_CONFLICT', error: '资源版本已修改' },
      ]),
      () => {},
    ),
    /资源版本已修改/,
  );
  const empty = {
    combinationId: randomUUID(),
    expectedRevision: 1,
    checkedAt: 1000,
    readonly: true,
    publishingReady: false,
    fingerprintVersion: 1,
    rows: [],
    verifiedSources: 0,
    uniqueContents: 0,
  };
  await assert.rejects(
    readResourceCheckStream(
      body([
        { kind: 'progress', completed: 0, total: 0 },
        { kind: 'completed', report: empty },
        { kind: 'completed', report: empty },
      ]),
      () => {},
    ),
    /额外数据/,
  );
});

test('real HTTP delivers progress and selected media, and client cancellation revokes original checking without modifying saved resources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-resource-stream-'));
  const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const reader = new FilesystemResourceSourceReader();
  let delay = false,
    cancelled = false,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const finished = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const service = new ResourceTableService(store.resourceTables, {
    previewMedia: reader.previewMedia.bind(reader),
    verify: async (row, current) => {
      if (delay) {
        await waiting;
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            await current();
          } catch (error) {
            cancelled = true;
            observed();
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        observed();
        throw Error('HTTP_CANCEL_NOT_OBSERVED');
      }
      return reader.verify(row, current);
    },
  });
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
        service,
      ),
  });
  try {
    const source = path.join(directory, 'image.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(source, png);
    const combo = store.createDraft({
      name: 'HTTP进度',
      note: '',
      steps: [],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const table = store.resourceTables.save(combo.id, 0, [
      { ...emptyResourceRow(randomUUID()), text: '图片', media: [mediaReference(source)] },
    ]);
    const cookie = (await fetch(server.origin + '/workbench/')).headers
      .get('set-cookie')
      ?.split(';')[0];
    assert.ok(cookie);
    const request = { combinationId: combo.id, expectedRevision: table.revision };
    const post = (route: string, input: unknown, signal?: AbortSignal) =>
      fetch(server.origin + '/api/workspace/resource-tables/' + route, {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
        },
        body: JSON.stringify(input),
        signal,
      });
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/resource-tables/media', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
      ).status,
      401,
    );
    const response = await post('check', request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    assert.ok(response.body);
    const progress: unknown[] = [];
    const report = await readResourceCheckStream(response.body, (value) => progress.push(value));
    assert.equal(report.verifiedSources, 1);
    assert.deepEqual(progress, [
      { completed: 0, total: 1 },
      { completed: 1, total: 1 },
    ]);
    const media = await post('media', { ...request, rowId: table.rows[0]!.id, fileIndex: 0 });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
    assert.equal(
      (await post('media', { ...request, rowId: table.rows[0]!.id, fileIndex: 0, source })).status,
      400,
    );
    const controller = new AbortController();
    delay = true;
    const cancelledResponse = await post('check', request, controller.signal);
    assert.ok(cancelledResponse.body);
    const stream = cancelledResponse.body.getReader();
    const initial = await stream.read();
    assert.ok(new TextDecoder().decode(initial.value).includes('"completed":0'));
    controller.abort();
    await stream.cancel().catch(() => {});
    stream.releaseLock();
    // Allow the actual HTTP close notification before releasing the blocked source read.
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await finished;
    assert.equal(cancelled, true);
    assert.deepEqual(store.resourceTables.read(combo.id), table);
    assert.equal(store.tasks.list().length, 0);
  } finally {
    release();
    await server.close();
    store.close();
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});
