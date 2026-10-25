import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { Catalog, ReservationRequest } from '../src/shared/material-index.js';
import { dropMaterialSchema } from './fixtures/material-schema.js';
import { dispatchedPost } from './fixtures/material-post.js';

async function fixture(
  work: (
    store: WorkspaceStore,
    file: string,
    directory: string,
    catalog: Catalog,
  ) => Promise<void> | void,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-material-index-')),
    file = path.join(directory, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file),
    resources = path.join(directory, 'resources');
  try {
    const historical = new DatabaseSync(file);
    historical.exec("UPDATE material_usage_policy SET file_policy='archive-test' WHERE id=1");
    historical.close();
    await mkdir(resources);
    await writeFile(path.join(resources, 'first.txt'), '素材事务生成测试');
    await writeFile(path.join(resources, 'copy.txt'), '素材事务生成测试');
    const scan = await new FilesystemMaterialScanner().scan(resources),
      catalog = store.materials.index(scan, randomUUID());
    await work(store, file, directory, catalog);
  } finally {
    store.close();
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith('wb-material-index-')
    )
      throw Error('CLEANUP_SCOPE');
    await rm(directory, { recursive: true, force: true });
  }
}
async function request(
  store: WorkspaceStore,
  catalog: Catalog,
  accountId = 'fixture-account-' + randomUUID(),
): Promise<ReservationRequest> {
  const id = randomUUID(),
    profile: RuntimeProfile = {
      id,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: accountId, name: null, avatar: null },
    };
  const saved = await store.createCombination({
    name: '素材事务隔离测试',
    note: '模拟身份，无浏览器输入',
    steps: [
      {
        id: randomUUID(),
        type: 'post',
        resourceDirectory: catalog.directory,
        count: 1,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: true,
      },
    ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  await store.tasks.assign(
    { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [id] },
    [profile],
  );
  const plan = await store.tasks.claimNext([profile], new Set(['post']));
  assert.ok(plan);
  const step = (await store.tasks.steps(plan.id))[0],
    source = catalog.sources[0];
  assert.ok(step && source);
  const context = {
      profileId: id,
      accountId,
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
    },
    proof = {
      profileId: id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
  await store.taskTabs.register(plan.id, proof, context);
  return {
    attemptId: randomUUID(),
    jobId: plan.id,
    stepId: step.id,
    expectedProgressRevision: 0,
    catalogId: catalog.id,
    sourceId: source.id,
    context,
    proof,
  };
}
function counts(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return [
      'material_catalogs',
      'material_contents',
      'material_sources',
      'material_post_intents',
      'material_reservations',
    ].map((table) => Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n));
  } finally {
    db.close();
  }
}

test('catalog preserves immutable sources and global content identity across copies, renames and reopen', async () => {
  await fixture(async (store, file, directory, first) => {
    assert.deepEqual(counts(file), [1, 1, 2, 0, 0]);
    const other = path.join(directory, 'other');
    await mkdir(other);
    await writeFile(path.join(other, 'renamed.txt'), '\uFEFF素材事务生成测试\r\n');
    const second = await store.materials.index(
      await new FilesystemMaterialScanner().scan(other),
      randomUUID(),
    );
    assert.equal(second.sources[0]?.snapshot.fingerprint, first.sources[0]?.snapshot.fingerprint);
    assert.deepEqual(counts(file), [2, 1, 3, 0, 0]);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.materials.catalog(first.id), first);
      assert.deepEqual(reopened.materials.current(other), second);
    } finally {
      reopened.close();
    }
  });
});
test('new scans replace only the current pointer; old idempotent imports cannot roll it back', async () => {
  await fixture(async (store, _file, _directory, first) => {
    await writeFile(path.join(first.directory, 'first.txt'), '更改后内容');
    const second = await store.materials.index(
      await new FilesystemMaterialScanner().scan(first.directory),
      randomUUID(),
    );
    assert.equal(second.revision, 2);
    assert.equal((await store.materials.current(first.directory))?.id, second.id);
    assert.deepEqual(await store.materials.index(first.scan, first.id), first);
    assert.equal((await store.materials.current(first.directory))?.id, second.id);
    await assert.rejects(
      async () => await store.materials.index(second.scan, first.id),
      /MATERIAL_CATALOG_ID_CONFLICT/,
    );
    const r = await request(store, first);
    await assert.rejects(async () => await store.materials.reserve(r), /MATERIAL_CATALOG_STALE/);
  });
});
test('partial scans, forged fingerprints and path escapes never create catalogs or replace the root', async () => {
  await fixture(async (store, file, _directory, first) => {
    const before = counts(file);
    await assert.rejects(
      async () => await store.materials.index({ ...first.scan, complete: false }, randomUUID()),
    );
    const bad = structuredClone(first.scan);
    const one = bad.packages[0];
    assert.ok(one);
    one.fingerprint = 'a'.repeat(64);
    await assert.rejects(
      async () => await store.materials.index(bad, randomUUID()),
      /MATERIAL_FINGERPRINT_INVALID/,
    );
    one.fingerprint = first.scan.packages[0]?.fingerprint ?? '';
    one.source = '../outside';
    await assert.rejects(
      async () => await store.materials.index(bad, randomUUID()),
      /MATERIAL_SOURCE_INVALID/,
    );
    assert.deepEqual(counts(file), before);
    assert.equal((await store.materials.current(first.directory))?.id, first.id);
  });
});
test('a catalog write fault rolls back all new content, sources and current-root changes', async () => {
  await fixture(async (store, file, _directory, first) => {
    await writeFile(path.join(first.directory, 'first.txt'), '故障时的新内容');
    const scan = await new FilesystemMaterialScanner().scan(first.directory),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_material_source BEFORE INSERT ON material_sources BEGIN SELECT RAISE(ABORT,'INJECT_INDEX_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.materials.index(scan, randomUUID()),
        /INJECT_INDEX_FAILURE/,
      );
      assert.deepEqual(counts(file), [1, 1, 2, 0, 0]);
      assert.equal((await store.materials.current(first.directory))?.id, first.id);
    } finally {
      db.exec('DROP TRIGGER fail_material_source');
      db.close();
    }
  });
});
test('reservation and original post intent commit once, preserve the source snapshot and never grant an input', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const r = await request(store, catalog),
      held = await store.materials.reserve(r);
    assert.equal(held.state, 'RESERVED');
    assert.equal(held.intent.context.accountId, r.context.accountId);
    assert.deepEqual(held.intent.snapshot, catalog.sources[0]?.snapshot);
    assert.deepEqual(await store.materials.reserve(r), held);
    assert.deepEqual(counts(file), [1, 1, 2, 1, 1]);
    await assert.rejects(
      async () =>
        await store.materials.reserve({ ...r, context: { ...r.context, leaseId: randomUUID() } }),
      /MATERIAL_ATTEMPT_ID_CONFLICT/,
    );
    await assert.rejects(
      async () =>
        await store.tasks.prepareOperation(r.jobId, r.stepId, randomUUID(), {
          kind: 'observe',
          tabId: 42,
        }),
      /POST_OPERATION_INTENT_REQUIRED/,
    );
    assert.equal((await store.tasks.operations(r.jobId)).length, 0);
    await assert.rejects(
      async () => await store.tasks.completeStep(r.jobId, r.stepId),
      /指令未结算/,
    );
  });
});
test('changed progress, account, target, lease and inactive plan are rejected before reserving', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const r = await request(store, catalog);
    for (const bad of [
      { ...r, expectedProgressRevision: 1 },
      { ...r, context: { ...r.context, accountId: 'other-account' } },
      { ...r, context: { ...r.context, leaseId: randomUUID() } },
      { ...r, proof: { ...r.proof, targetId: 'wrong-target' } },
    ])
      await assert.rejects(async () => await store.materials.reserve(bad));
    await store.tasks.requestControl(r.jobId, 'pause');
    await assert.rejects(async () => await store.materials.reserve(r), /MATERIAL_TASK_NOT_READY/);
    assert.deepEqual(counts(file), [1, 1, 2, 0, 0]);
  });
});
test('same content across independent roots and different accounts remains mutually exclusive', async () => {
  await fixture(async (store, file, directory, catalog) => {
    const other = path.join(directory, 'other');
    await mkdir(other);
    await writeFile(path.join(other, 'same.txt'), '素材事务生成测试');
    const second = await store.materials.index(
        await new FilesystemMaterialScanner().scan(other),
        randomUUID(),
      ),
      one = await request(store, catalog),
      two = await request(store, second);
    await store.materials.reserve(one);
    await assert.rejects(
      async () => await store.materials.reserve(two),
      /MATERIAL_CONTENT_RESERVED/,
    );
    assert.deepEqual(counts(file), [2, 1, 3, 1, 1]);
  });
});
test('an insert fault cannot leave a post intent without its reservation', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const r = await request(store, catalog),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_material_hold BEFORE INSERT ON material_reservations BEGIN SELECT RAISE(ABORT,'INJECT_HOLD_FAILURE'); END",
      );
      await assert.rejects(async () => await store.materials.reserve(r), /INJECT_HOLD_FAILURE/);
      assert.deepEqual(counts(file), [1, 1, 2, 0, 0]);
    } finally {
      db.exec('DROP TRIGGER fail_material_hold');
      db.close();
    }
    assert.equal((await store.materials.reserve(r)).state, 'RESERVED');
  });
});
test('acknowledged native stop cannot release dispatched material or the original account lock', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const r = await request(store, catalog);
    await store.materials.reserve(r);
    await dispatchedPost(store, r, 'OPEN_COMPOSER');
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    const stopped = await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    assert.equal(stopped.state, 'REVIEW');
    assert.equal(stopped.controlConfirmed, true);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'REVIEW');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare('SELECT job_id FROM task_account_locks WHERE account_id=?')
          .get(r.context.accountId)?.job_id,
        r.jobId,
      );
    } finally {
      db.close();
    }
    await assert.rejects(async () => await store.tasks.resume(r.jobId), /需先核对/);
    assert.equal((await store.materials.reserve(r)).state, 'REVIEW');
  });
});
test('opening repositories is passive; explicit startup recovery retains reservation and original context', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const r = await request(store, catalog),
      held = await store.materials.reserve(r),
      reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.materials.reservation(r.attemptId), held);
      assert.equal(reopened.tasks.get(r.jobId).state, 'RUNNING');
      reopened.tasks.recoverOnStartup();
      assert.equal(reopened.materials.reservation(r.attemptId).state, 'REVIEW');
      assert.deepEqual(reopened.materials.reservation(r.attemptId).intent, held.intent);
      assert.equal(reopened.tasks.get(r.jobId).state, 'REVIEW');
      assert.equal(
        reopened.tasks.takeBoundOperation({ ...r.context, leaseId: randomUUID() }),
        null,
      );
      assert.equal(reopened.materials.reserve(r).state, 'REVIEW');
      assert.deepEqual(counts(file), [1, 1, 2, 1, 1]);
    } finally {
      reopened.close();
    }
  });
});
test('SQLite retains original catalog/content/source/intent/reservation and prevents REVIEW revival', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const r = await request(store, catalog);
    await store.materials.reserve(r);
    await dispatchedPost(store, r, 'OPEN_COMPOSER');
    await store.tasks.requestControl(r.jobId, 'stop');
    const db = new DatabaseSync(file);
    try {
      for (const table of [
        'material_catalogs',
        'material_contents',
        'material_sources',
        'material_post_intents',
      ]) {
        assert.throws(() => db.exec('UPDATE ' + table + ' SET rowid=rowid'), /IMMUTABLE_MATERIAL/);
        assert.throws(() => db.exec('DELETE FROM ' + table), /RETAIN_MATERIAL/);
      }
      assert.throws(
        () => db.exec('DELETE FROM material_reservations'),
        /RETAIN_MATERIAL_RESERVATION/,
      );
      assert.throws(
        () => db.exec("UPDATE material_reservations SET state='RESERVED'"),
        /MATERIAL_REVIEW_REQUIRED/,
      );
      assert.throws(
        () => db.exec("UPDATE material_reservations SET fingerprint='wrong'"),
        /IMMUTABLE_MATERIAL_RESERVATION/,
      );
      for (const state of ['PUBLISHED', 'NOT_PUBLISHED'])
        assert.throws(
          () => db.prepare('UPDATE material_reservations SET state=?').run(state),
          /MATERIAL_TERMINAL_EVIDENCE_REQUIRED/,
        );
    } finally {
      db.close();
    }
  });
});
test('two real processes racing for one content commit exactly one complete intent/reservation', async () => {
  await fixture(async (store, file, _directory, catalog) => {
    const requests = [await request(store, catalog), await request(store, catalog)],
      children = requests.map((r) =>
        fork(
          fileURLToPath(new URL('./fixtures/material-reserve-worker.js', import.meta.url)),
          [file, JSON.stringify(r)],
          { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
        ),
      );
    const pending = children.map(
      (child) =>
        new Promise<{ reserved: boolean; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill();
            reject(Error('RESERVATION_WORKER_TIMEOUT'));
          }, 15000);
          let settled = false;
          child.on('error', reject);
          child.on('exit', (code) => {
            clearTimeout(timer);
            if (!settled) reject(Error('RESERVATION_WORKER_EXIT ' + code));
          });
          child.on('message', (input: unknown) => {
            if (typeof input !== 'object' || input === null) return;
            if ('ready' in input) {
              ready++;
              if (ready === children.length) for (const member of children) member.send('go');
            } else if ('reserved' in input && typeof input.reserved === 'boolean') {
              settled = true;
              resolve({
                reserved: input.reserved,
                ...('error' in input && typeof input.error === 'string'
                  ? { error: input.error }
                  : {}),
              });
            }
          });
        }),
    );
    let ready = 0;
    try {
      const results = await Promise.all(pending);
      assert.equal(results.filter((item) => item.reserved).length, 1);
      assert.match(
        results.find((item) => !item.reserved)?.error ?? '',
        /MATERIAL_CONTENT_RESERVED/,
      );
      assert.deepEqual(counts(file), [1, 1, 2, 1, 1]);
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null) resolve();
              else child.once('exit', () => resolve());
            }),
        ),
      );
    }
  });
});
test('schema7 upgrade backs up user preferences and running plans without reserving or recovering them', async () => {
  await fixture(async (store, file, directory, catalog) => {
    const r = await request(store, catalog),
      plan = await store.tasks.get(r.jobId),
      db = new DatabaseSync(file);
    db.exec(dropMaterialSchema + 'PRAGMA user_version=7');
    db.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(migrated.tasks.get(r.jobId), plan);
      assert.equal(migrated.materials.current(catalog.directory), null);
      assert.deepEqual(counts(file), [0, 0, 0, 0, 0]);
      const backupFile = (await readdir(directory)).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(backupFile);
      const before = new DatabaseSync(path.join(directory, backupFile), { readOnly: true });
      try {
        assert.equal(before.prepare('PRAGMA user_version').get()?.user_version, 7);
        assert.equal(
          before.prepare('SELECT state FROM task_plans WHERE id=?').get(r.jobId)?.state,
          'RUNNING',
        );
        assert.equal(
          before
            .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='material_reservations'")
            .get()?.n,
          0,
        );
      } finally {
        before.close();
      }
    } finally {
      migrated.close();
    }
  });
});
