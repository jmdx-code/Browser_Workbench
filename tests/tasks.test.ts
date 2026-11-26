import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  reserveControllerPort,
  releaseControllerPort,
} from '../src/infrastructure/controller-port.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import { orderedSteps, validateProgress, type RuntimeProfile } from '../src/domain/tasks.js';
import { type Combination } from '../src/shared/contracts.js';
import type { Plan, Progress } from '../src/shared/task-contracts.js';

function combination(rounds = 1, randomOrder = false): Combination {
  return {
    name: '调度验收',
    note: '隔离模拟，不是FB执行',
    steps: [
      { id: randomUUID(), type: 'video', durationMinutes: 15, maxLikes: 2, minLikeCount: 500 },
      { id: randomUUID(), type: 'feed', durationMinutes: 4, maxLikes: 1, minLikeCount: 200 },
      { id: randomUUID(), type: 'feed', durationMinutes: 8, maxLikes: 0, minLikeCount: 200 },
    ],
    randomOrder,
    loop: { mode: 'finite', rounds },
  };
}
function profiles(count: number): RuntimeProfile[] {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: 'test-account-' + i, name: null, avatar: null },
  }));
}
async function fixture(run: (store: WorkspaceStore, file: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-tasks-'));
  const file = path.join(dir, 'workspace.sqlite'),
    store = await WorkspaceStore.open(file);
  try {
    await run(store, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function assign(store: WorkspaceStore, runtime: RuntimeProfile[], value = combination()) {
  const saved = await store.createCombination(value);
  const request = {
    requestId: randomUUID(),
    combinationId: saved.id,
    version: saved.version,
    profileIds: runtime.map((p) => p.id),
  };
  return { plans: await store.tasks.assign(request, runtime), request, saved };
}
function current(store: WorkspaceStore, plan: Plan) {
  const step = store.tasks.currentStepForPlan(plan.id, plan.round, plan.position);
  assert.ok(step);
  return step;
}
function progress(before: Progress, delta: Partial<Progress> = {}): Progress {
  return { ...before, revision: before.revision + 1, ...delta };
}
function completeCurrent(store: WorkspaceStore, plan: Plan) {
  const step = current(store, plan);
  const full =
    step.spec.type === 'post'
      ? progress(step.progress, { published: step.spec.count })
      : progress(step.progress, { effectiveMilliseconds: step.spec.durationMinutes * 60_000 });
  return store.tasks.completeStepDirect(plan.id, step.id, full);
}

test('display budgets follow stored shuffled steps and immutable versions, without changing progress', async () => {
  await fixture(async (store, file) => {
    const db = new DatabaseSync(file);
    try {
      const repository = new SqliteTaskRepository(db, {
        id: randomUUID,
        now: Date.now,
        random: () => 0,
      });
      const runtime = profiles(1),
        value = combination(2, true);
      const saved = await store.createCombination(value);
      const [plan] = repository.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: runtime.map((p) => p.id),
        },
        runtime,
      );
      assert.ok(plan);
      const steps = repository.steps(plan.id, 1);
      assert.equal(steps[0]?.spec.id, value.steps[1]?.id);
      await store.saveCombination(saved.id, saved.revision, {
        ...value,
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      const service = new TaskService(repository),
        before = repository.steps(plan.id);
      const overview = await service.runtimeOverview();
      assert.deepEqual(overview.currentSteps[0]?.budget, {
        kind: 'time',
        milliseconds: 4 * 60_000,
      });
      assert.deepEqual(
        (await service.history({ profileId: plan.profileId })).steps.map((s) => s.budget),
        [
          { kind: 'time', milliseconds: 4 * 60_000 },
          { kind: 'time', milliseconds: 8 * 60_000 },
          { kind: 'time', milliseconds: 15 * 60_000 },
        ],
      );
      assert.deepEqual(repository.steps(plan.id), before);
    } finally {
      db.close();
    }
  });
});

test('live task query excludes terminal history while retaining queued and running original plans', async () => {
  await fixture(async (store) => {
    const runtime = profiles(4);
    const value = {
      ...combination(),
      steps: [
        {
          id: randomUUID(),
          type: 'feed' as const,
          durationMinutes: 1,
          maxLikes: 0,
          minLikeCount: 0,
        },
      ],
    };
    const { plans } = await assign(store, runtime, value);
    const stopped = plans.find((p) => p.profileId === runtime[0]!.id);
    const claimedProfile = runtime[1]!;
    const completedProfile = runtime[2]!;
    assert.ok(stopped);
    store.tasks.stopPlanDirect(stopped.id, 'USER_STOP');
    const runningPlan = store.tasks.claimPlanForProfile(
      claimedProfile.id,
      claimedProfile.account.id,
    );
    const toComplete = store.tasks.claimPlanForProfile(
      completedProfile.id,
      completedProfile.account.id,
    );
    assert.ok(runningPlan && toComplete);
    completeCurrent(store, toComplete);
    assert.deepEqual(
      store.tasks.livePlans(),
      store.tasks.list().filter((plan) => !['COMPLETED', 'STOPPED', 'FAILED'].includes(plan.state)),
    );
    assert.deepEqual(
      new Set(store.tasks.livePlans().map((plan) => plan.state)),
      new Set(['QUEUED', 'RUNNING']),
    );
    assert.equal(store.tasks.livePlans().length, 2);
    assert.equal(store.tasks.list().length, 4);
    assert.equal(store.tasks.get(stopped.id).state, 'STOPPED');
    assert.equal(store.tasks.get(toComplete.id).state, 'COMPLETED');
  });
});

test('task history reads the persisted profile ledger cleanly', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1);
    const { plans } = await assign(store, runtime);
    const plan = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.ok(plan && plans[0]);
    const step = current(store, plan);
    store.tasks.updateStepProgress(
      plan.id,
      step.id,
      progress(step.progress, { effectiveMilliseconds: 1000 }),
    );
    const history = await new TaskService(store.tasks).history({ profileId: runtime[0]!.id });
    assert.equal(history.plans.length, 1);
    assert.equal(history.steps.length, 3);
    assert.equal(history.steps[0]?.progress.effectiveMilliseconds, 1000);
  });
});

test('batch retries are idempotent; conflict and occupied profile roll back the entire assignment', async () => {
  await fixture(async (store) => {
    const runtime = profiles(2);
    const saved = await store.createCombination(combination());
    const req = {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: [runtime[0]!.id],
    };
    const first = store.tasks.assign(req, runtime);
    const retried = store.tasks.assign(req, runtime);
    assert.deepEqual(
      retried.map((p) => p.id),
      first.map((p) => p.id),
    );
    assert.throws(
      () =>
        store.tasks.assign(
          {
            requestId: randomUUID(),
            combinationId: saved.id,
            version: saved.version,
            profileIds: runtime.map((p) => p.id),
          },
          runtime,
        ),
      (err: unknown) =>
        err instanceof Error &&
        'code' in err &&
        (err.code === 'PROFILE_PLAN_BUSY' || err.code === 'TASK_PROFILE_BUSY'),
    );
    assert.equal(store.tasks.list().length, 1);
  });
});

test('two profiles sharing an account are mutually exclusive via account locks', async () => {
  await fixture(async (store) => {
    const runtime = profiles(2);
    const a = runtime[0]!;
    const b = runtime[1]!;
    b.account.id = a.account.id;
    const { plans } = await assign(store, runtime);
    const planA = store.tasks.claimPlanForProfile(a.id, a.account.id);
    assert.equal(planA?.state, 'RUNNING');
    assert.equal(store.tasks.claimPlanForProfile(b.id, b.account.id), null);
    const planForB = plans.find((p) => p.profileId === b.id)!;
    assert.equal(store.tasks.get(planForB.id).reason, 'ACCOUNT_BUSY');
    store.tasks.stopPlanDirect(planA!.id, 'USER_STOP');
    const planB = store.tasks.claimPlanForProfile(b.id, b.account.id);
    assert.equal(planB?.state, 'RUNNING');
  });
});

test('running snapshot uses requested saved version and cannot be changed by subsequent edits', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1),
      { plans, saved } = await assign(store, runtime);
    const plan = plans[0];
    assert.ok(plan);
    await store.saveCombination(saved.id, saved.revision, {
      ...combination(),
      name: '新版',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    assert.equal(store.tasks.get(plan.id).version, 1);
    assert.equal(store.tasks.get(plan.id).snapshot.steps.length, 3);
    assert.equal(store.tasks.get(plan.id).snapshot.name, '调度验收');
  });
});

test('each round is stored once; repeated step types remain independent and infinite loops are lazy', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1),
      value = combination(2, true);
    await assign(store, runtime, value);
    let plan = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.ok(plan);
    const first = store.tasks.steps(plan.id, 1);
    assert.equal(new Set(first.map((row) => row.id)).size, 3);
    assert.equal(first.filter((row) => row.spec.type === 'feed').length, 2);
    for (let i = 0; i < 3; i++) plan = completeCurrent(store, plan);
    assert.equal(plan.round, 2);
    assert.equal(store.tasks.steps(plan.id).length, 6);
    for (let i = 0; i < 3; i++) plan = completeCurrent(store, plan);
    assert.equal(plan.state, 'COMPLETED');
    assert.equal(store.tasks.steps(plan.id).length, 6);
    const infinite = { ...combination(), loop: { mode: 'until-stopped' as const } };
    await assign(store, runtime, infinite);
    let endless = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.ok(endless);
    for (let i = 0; i < 3; i++) endless = completeCurrent(store, endless);
    assert.equal(endless.round, 2);
    assert.equal(store.tasks.steps(endless.id).length, 6);
  });
});

test('random shuffle validates its source and preserves source step identities', () => {
  const input = combination().steps;
  assert.deepEqual(
    orderedSteps(input, false, () => {
      throw Error('unused');
    }),
    input,
  );
  assert.deepEqual(
    orderedSteps(input, true, () => 0).map((row) => row.id),
    [input[1]?.id, input[2]?.id, input[0]?.id],
  );
  assert.throws(() => orderedSteps(input, true, () => 1), /随机源/);
  assert.throws(() => orderedSteps(input, true, () => NaN), /随机源/);
});

test('stop retains checkpoints and frees account lock', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1);
    await assign(store, runtime, combination(2, true));
    const plan = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.ok(plan);
    const step = current(store, plan);
    store.tasks.updateStepProgress(
      plan.id,
      step.id,
      progress(step.progress, { effectiveMilliseconds: 5000 }),
    );
    const stopped = store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 5000);
    await assign(store, runtime);
    const nextPlan = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.equal(nextPlan?.state, 'RUNNING');
  });
});

test('checkpoint validation prevents progress regression and out-of-bounds counters', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.ok(plan);
    const step = current(store, plan);
    assert.throws(
      () =>
        validateProgress(step.spec, step.progress, {
          ...step.progress,
          revision: 0,
        }),
      /已变化/,
    );
    assert.throws(
      () => validateProgress(step.spec, step.progress, progress(step.progress, { published: 1 })),
      /超出子任务约束/,
    );
    store.tasks.updateStepProgress(
      plan.id,
      step.id,
      progress(step.progress, { effectiveMilliseconds: 500 }),
    );
    const latest = current(store, plan);
    assert.throws(
      () =>
        validateProgress(
          latest.spec,
          latest.progress,
          progress(latest.progress, { effectiveMilliseconds: 1 }),
        ),
      /不能回退/,
    );
  });
});

test('a second controller fails on occupied port before recovering or creating either database', async () => {
  await fixture(async (store, file) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    assert.ok(plan);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const occupied = await reserveControllerPort(port);
    try {
      const child = spawn(process.execPath, ['dist/src/server.js'], {
        env: {
          ...process.env,
          WORKBENCH_DATA_DIR: path.dirname(file),
          WORKBENCH_PORT: String(port),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let diagnostic = '';
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostic += chunk.toString();
      });
      const timer = setTimeout(() => child.kill(), 5000);
      let code: number | null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      assert.notEqual(code, 0);
      assert.match(diagnostic, /EADDRINUSE/);
      assert.equal(store.tasks.get(plan.id).state, 'RUNNING');
      assert.equal((await readdir(path.dirname(file))).includes('journal.sqlite'), false);
    } finally {
      await releaseControllerPort(occupied.server);
    }
  });
});

test('v61->v62 migration backs up and preserves existing data while rejecting pre-v59 DBs; SQLite prevents snapshot/order edits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-migration-')),
    file = path.join(dir, 'workspace.sqlite'),
    oldFile = path.join(dir, 'too-old.sqlite');
  const legacyTooOld = new DatabaseSync(oldFile);
  legacyTooOld.exec('CREATE TABLE sentinel(v TEXT); PRAGMA user_version=1');
  legacyTooOld.close();
  await assert.rejects(() => WorkspaceStore.open(oldFile), { code: 'DATABASE_VERSION_TOO_OLD' });

  const initial = await WorkspaceStore.open(file);
  initial.createGroup('保留组', 'blue');
  initial.close();
  const before = new DatabaseSync(file);
  before.exec('PRAGMA user_version=61');
  before.close();
  const store = await WorkspaceStore.open(file);
  try {
    assert.equal(store.groups()[0]?.name, '保留组');
    assert.ok((await readdir(dir)).some((name) => name.includes(latestMigrationBackupMarker)));
    const runtime = profiles(1),
      { plans } = await assign(store, runtime),
      plan = plans[0];
    assert.ok(plan);
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () => db.prepare('UPDATE task_plans SET snapshot=? WHERE id=?').run('{}', plan.id),
        /IMMUTABLE/,
      );
      assert.throws(
        () => db.prepare('UPDATE task_steps SET position=4 WHERE job_id=?').run(plan.id),
        /IMMUTABLE/,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('task records aggregate step-level rows across profiles with start/end timestamps, status filters and pagination', async () => {
  await fixture(async (store) => {
    const runtime = profiles(2);
    await assign(store, runtime, combination(1, false));
    const service = new TaskService(store.tasks);
    const planA = store.tasks.claimPlanForProfile(runtime[0]!.id, runtime[0]!.account.id);
    const planB = store.tasks.claimPlanForProfile(runtime[1]!.id, runtime[1]!.account.id);
    assert.ok(planA && planB);
    const stepA0 = current(store, planA);
    store.tasks.completeStepDirect(
      planA.id,
      stepA0.id,
      progress(stepA0.progress, { effectiveMilliseconds: 900_000 }),
    );
    const all = await service.records(
      { status: 'all', limit: 10 },
      runtime.map((p, i) => ({ id: p.id, browserName: `浏览器${i + 1}`, alias: `别名${i + 1}` })),
    );
    assert.equal(all.counts.all, 6);
    assert.equal(all.counts.completed, 1);
    assert.equal(all.counts.running, 2);
    const completed = await service.records({ status: 'completed' });
    assert.equal(completed.records.length, 1);
    assert.equal(completed.records[0]?.stepId, stepA0.id);
    assert.equal(typeof completed.records[0]?.startedAt, 'number');
    assert.equal(typeof completed.records[0]?.finishedAt, 'number');
    assert.ok((completed.records[0]?.startedAt ?? 0) <= (completed.records[0]?.finishedAt ?? 0));
    const byBrowser = await service.records(
      { profileId: planA.profileId, query: '浏览器1', limit: 2 },
      runtime.map((p, i) => ({ id: p.id, browserName: `浏览器${i + 1}`, alias: `别名${i + 1}` })),
    );
    assert.equal(byBrowser.total, 3);
    assert.equal(byBrowser.records.length, 2);
    assert.ok(byBrowser.nextCursor && byBrowser.nextCursor !== '2');
    const secondPage = await service.records(
      { profileId: planA.profileId, query: '浏览器1', cursor: byBrowser.nextCursor!, limit: 2 },
      runtime.map((p, i) => ({ id: p.id, browserName: `浏览器${i + 1}`, alias: `别名${i + 1}` })),
    );
    assert.equal(secondPage.records.length, 1);
    assert.equal(secondPage.nextCursor, null);
  });
});

test('runtimeOverview projects full shuffled roundSteps and preserves maxLikes when randomOrder is true', async () => {
  await fixture(async (store, file) => {
    const db = new DatabaseSync(file);
    try {
      const repository = new SqliteTaskRepository(db, {
        id: randomUUID,
        now: Date.now,
        random: () => 0,
      });
      const runtime = profiles(1),
        value = combination(1, true);
      const saved = await store.createCombination(value);
      const [plan] = repository.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: runtime.map((p) => p.id),
        },
        runtime,
      );
      assert.ok(plan);
      const storedSteps = repository.steps(plan.id, plan.round);
      const overview = await new TaskService(repository).runtimeOverview();
      assert.equal(overview.roundSteps?.length, storedSteps.length);
      assert.deepEqual(
        overview.roundSteps?.map((s) => s.id),
        storedSteps.map((s) => s.id),
      );
      assert.deepEqual(
        overview.roundSteps?.map((s) => s.position),
        [0, 1, 2],
      );
      assert.equal(overview.roundSteps?.[0]?.maxLikes, 1);
      assert.equal(overview.currentSteps[0]?.maxLikes, 1);
    } finally {
      db.close();
    }
  });
});
