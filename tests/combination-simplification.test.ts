import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { CombinationSchema, type Combination } from '../src/shared/contracts.js';

function makeCombination(name = '日常养号'): Combination {
  return CombinationSchema.parse({
    name,
    note: '',
    randomOrder: true,
    loop: { mode: 'finite', rounds: 1 },
    steps: [
      {
        id: randomUUID(),
        type: 'video',
        durationMinutes: 10,
        maxLikes: 2,
        minLikeCount: 100,
      },
    ],
  });
}

test('WorkspaceStore.saveCombination updates combination atomically without draft and preserves prior version row', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-combo-save-'));
  const file = path.join(dir, 'workspace.sqlite');
  try {
    const store = await WorkspaceStore.open(file);
    try {
      const created = store.createCombination(makeCombination('日常'));
      assert.equal(created.version, 1);
      assert.equal(created.draft, null);

      // Simulate a legacy stale draft lingering in SQLite before direct save.
      const legacyDb = new DatabaseSync(file);
      try {
        legacyDb
          .prepare('UPDATE combinations SET draft=?,revision=revision+1 WHERE id=?')
          .run(JSON.stringify(makeCombination('残留草稿')), created.id);
      } finally {
        legacyDb.close();
      }
      const withStaleDraft = store.combinations().find((row) => row.id === created.id);
      assert.ok(withStaleDraft);
      assert.equal(withStaleDraft.draft, null);

      const saved = store.saveCombination(
        created.id,
        withStaleDraft.revision,
        makeCombination('日常精简版'),
      );
      assert.equal(saved.version, 2);
      assert.equal(saved.revision, withStaleDraft.revision + 1);
      assert.equal(saved.saved?.name, '日常精简版');
      assert.equal(saved.draft, null);

      assert.throws(
        () => store.saveCombination(created.id, withStaleDraft.revision, makeCombination('冲突')),
        /其他窗口/,
      );

      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const v1 = db
          .prepare('SELECT body FROM combination_versions WHERE combination_id=? AND version=1')
          .get(created.id);
        const v2 = db
          .prepare('SELECT body FROM combination_versions WHERE combination_id=? AND version=2')
          .get(created.id);
        assert.equal(JSON.parse(String(v1?.body)).name, '日常');
        assert.equal(JSON.parse(String(v2?.body)).name, '日常精简版');
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/workspace/combinations/save persists directly and enforces expectedRevision', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-combo-api-'));
  const file = path.join(dir, 'workspace.sqlite');
  const repo = await WorkspaceStore.open(file);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await startBridgeServer({
    root: process.cwd(),
    dataDir: dir,
    port,
    extensionIds: ['a'.repeat(32)],
    appRoutes: ({ core, store }) =>
      workspaceApi(new WorkspaceService(repo, new BridgeProfileSource(core, store))),
  });
  try {
    const landing = await fetch(server.origin);
    const cookie = landing.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const post = (route: string, body: unknown) =>
      fetch(server.origin + '/api/workspace' + route, {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'content-type': 'application/json',
          'x-workbench-workspace-contract': '6',
        },
        body: JSON.stringify(body),
      });

    const created = repo.createCombination(makeCombination('初始组合'));
    const okRes = await post('/combinations/save', {
      id: created.id,
      expectedRevision: created.revision,
      value: makeCombination('直接保存后的组合'),
    });
    assert.equal(okRes.status, 200);
    const saved = (await okRes.json()) as {
      version: number;
      revision: number;
      draft: unknown;
      saved: { name: string } | null;
    };
    assert.equal(saved.version, 2);
    assert.equal(saved.revision, created.revision + 1);
    assert.equal(saved.draft, null);
    assert.equal(saved.saved?.name, '直接保存后的组合');

    const staleRes = await post('/combinations/save', {
      id: created.id,
      expectedRevision: created.revision,
      value: makeCombination('过期的保存'),
    });
    assert.equal(staleRes.status, 409);
  } finally {
    await server.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
