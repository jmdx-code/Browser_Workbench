import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FacebookPlanMaterialCatalogs } from '../src/infrastructure/facebook-plan-material-catalogs.js';
import { PublicDriveDownloader } from '../src/infrastructure/public-drive-download.js';
import { mediaReference } from '../src/domain/resource-table.js';
import type { ResourceRowValue } from '../src/shared/resource-table.js';
import type { StepExecution } from '../src/domain/browse-execution.js';

async function fixture(
  row: ResourceRowValue,
  run: (f: {
    store: WorkspaceStore;
    dir: string;
    combinationId: string;
    executions: StepExecution[];
  }) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-fb-catalogs-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  const db = new DatabaseSync(file);
  try {
    const combination = store.createCombination({
      name: '生成资料素材装配',
      note: '模拟 actor/Drive，非FB验收',
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
    store.resourceTables.save(combination.id, 0, [row]);
    const profiles = [0, 1].map(() => ({
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: randomUUID(), name: null, avatar: null },
    }));
    const plans = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combination.id,
        version: 1,
        expectedResourceRevision: 1,
        profileIds: profiles.map((p) => p.id),
      },
      profiles,
    );
    assert.equal(store.tasks.claimNext(profiles, new Set(['post'])), null);
    // Explicit generated-actor setup; production resource-table claiming stays disabled.
    const executions = plans.map((plan) => {
      const profile = profiles.find((profile) => profile.id === plan.profileId),
        step = store.tasks.steps(plan.id)[0];
      assert.ok(profile && step);
      db.prepare("UPDATE task_plans SET state='RUNNING',account_id=? WHERE id=?").run(
        profile.account.id,
        plan.id,
      );
      db.prepare("UPDATE task_steps SET status='ACTIVE' WHERE id=?").run(step.id);
      db.prepare('INSERT INTO task_account_locks VALUES(?,?)').run(profile.account.id, plan.id);
      return {
        plan: store.tasks.get(plan.id),
        step: store.tasks.steps(plan.id)[0] ?? step,
        session: {
          profileId: profile.id,
          accountId: profile.account.id,
          connectionEpoch: randomUUID(),
          leaseId: randomUUID(),
          generation: 0,
        },
      };
    });
    await run({ store, dir, combinationId: combination.id, executions });
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_outbox').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM material_reservations').get()?.n, 0);
  } finally {
    db.close();
    store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.ok(path.basename(dir).startsWith('wb-fb-catalogs-'));
    await rm(dir, { recursive: true, force: true });
  }
}
const row = (): ResourceRowValue => ({
  id: randomUUID(),
  text: '固定原文',
  background: 'plain',
  media: [mediaReference('https://drive.google.com/file/d/public_catalog_test/view')],
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
  'base64',
);
const response = () =>
  new Response(new Uint8Array(png).buffer, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(png.length) },
  });

test('original fixed resource revision shares one Drive cache/catalog across actors; head edits and returned clones cannot change saved task content', async () => {
  const saved = row();
  await fixture(saved, async (f) => {
    let requests = 0;
    const catalogs = new FacebookPlanMaterialCatalogs(
      f.store,
      f.dir,
      (cache) =>
        new PublicDriveDownloader(cache, undefined, async () => {
          requests++;
          await f.store.resourceTables.save(f.combinationId, 1, [{ ...saved, text: '新表正文' }]);
          return response();
        }),
    );
    try {
      await Promise.all(f.executions.map((e) => catalogs.prepare(e, () => {})));
      const [first, second] = f.executions;
      assert.ok(first && second);
      const a = await catalogs.current(first),
        b = await catalogs.current(second);
      assert.ok(a && b);
      assert.equal(a.id, b.id);
      assert.equal(requests, 1);
      assert.equal(a.sources[0]?.snapshot.text, '固定原文');
      a.sources[0]!.snapshot.text = '外部克隆变动';
      await catalogs.prepare(second, () => {});
      assert.equal((await catalogs.current(second))?.sources[0]?.snapshot.text, '固定原文');
      assert.equal((await f.store.resourceTables.read(f.combinationId)).revision, 2);
    } finally {
      await catalogs.close();
    }
  });
});

test('stopping the first resource consumer does not cancel another actor or duplicate its shared download', async () => {
  await fixture(row(), async (f) => {
    const first = f.executions[0];
    assert.ok(first);
    const catalogs = new FacebookPlanMaterialCatalogs(
      f.store,
      f.dir,
      (cache) =>
        new PublicDriveDownloader(cache, undefined, async () => {
          await f.store.tasks.requestControl(first.plan.id, 'stop');
          return response();
        }),
    );
    try {
      const results = await Promise.allSettled(
        f.executions.map((e) => catalogs.prepare(e, () => {})),
      );
      assert.equal(results[0]?.status, 'rejected');
      assert.equal(results[1]?.status, 'fulfilled');
      const second = f.executions[1];
      assert.ok(second);
      assert.ok((await catalogs.current(second))?.sources.length);
      assert.equal((await f.store.tasks.get(second.plan.id)).state, 'RUNNING');
      assert.equal((await f.store.tasks.operations(second.plan.id)).length, 0);
      assert.equal((await f.store.tasks.get(first.plan.id)).controlConfirmed, false);
    } finally {
      await catalogs.close();
    }
  });
});

test('revoking all shared consumers aborts the read without publishing a partial catalog or granting input', async () => {
  await fixture(row(), async (f) => {
    const catalogs = new FacebookPlanMaterialCatalogs(
      f.store,
      f.dir,
      (cache) =>
        new PublicDriveDownloader(cache, undefined, async () => {
          for (const execution of f.executions)
            await f.store.tasks.requestControl(execution.plan.id, 'stop');
          return response();
        }),
    );
    try {
      const results = await Promise.allSettled(
        f.executions.map((e) => catalogs.prepare(e, () => {})),
      );
      assert.ok(results.every((r) => r.status === 'rejected'));
      const first = f.executions[0];
      assert.ok(first);
      assert.equal(await catalogs.current(first), null);
      const db = new DatabaseSync(path.join(f.dir, 'workspace.sqlite'));
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM material_catalogs').get()?.n, 0);
      } finally {
        db.close();
      }
    } finally {
      await catalogs.close();
    }
  });
});

test('colored rows preserve their native background requirement across catalog reuse without reserving or publishing plain text', async () => {
  await fixture({ ...row(), media: [], background: 'color' }, async (f) => {
    const catalogs = new FacebookPlanMaterialCatalogs(f.store, f.dir);
    const execution = f.executions[0];
    assert.ok(execution);
    try {
      await catalogs.prepare(execution, () => {});
      const original = await catalogs.current(execution);
      assert.ok(original && 'resourceRevision' in original);
      assert.equal(original.sources.length, 1);
      assert.equal(original.sources[0]?.origin.row.background, 'color');
      await catalogs.prepare(execution, () => {});
      assert.deepEqual(await catalogs.current(execution), original);
      assert.deepEqual(await catalogs.blocked(execution), []);
      const db = new DatabaseSync(path.join(f.dir, 'workspace.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM material_post_intents').get()?.n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM material_publications').get()?.n, 0);
      } finally {
        db.close();
      }
    } finally {
      await catalogs.close();
    }
  });
});
