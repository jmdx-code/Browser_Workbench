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
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import { orderedSteps, type RuntimeProfile } from '../src/domain/tasks.js';
import { type Action } from '../src/shared/browser-actions.js';
import { type Combination, type Step } from '../src/shared/contracts.js';
import type { Plan, Progress } from '../src/shared/task-contracts.js';
import type { ExecutionReceipt } from '../src/shared/task-execution.js';

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
const supported = new Set<Step['type']>(['video', 'feed', 'post']);
const click: Action = {
  kind: 'click',
  tabId: 1,
  documentEpoch: 0,
  routeEpoch: 0,
  target: { css: '[data-test=like]' },
};
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
      const draft = await store.writeDraft(saved.id, saved.revision, {
        ...value,
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      await store.publish(saved.id, draft.revision);
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
test('live task query excludes terminal history while retaining queued, running and paused original plans', async () => {
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
    const stopped = plans[0],
      paused = plans[1];
    assert.ok(stopped && paused);
    await store.tasks.requestControl(stopped.id, 'stop', 'USER_STOP');
    await store.tasks.requestControl(paused.id, 'pause', 'USER_PAUSE');
    const claimed = await store.tasks.claimNext(runtime, new Set(['feed']));
    assert.ok(claimed);
    assert.deepEqual(
      await store.tasks.livePlans(),
      (await store.tasks.list()).filter(
        (plan) => !['COMPLETED', 'STOPPED', 'FAILED'].includes(plan.state),
      ),
    );
    assert.deepEqual(
      new Set((await store.tasks.livePlans()).map((plan) => plan.state)),
      new Set(['QUEUED', 'RUNNING', 'PAUSED']),
    );
    const step = (await store.tasks.steps(claimed.id))[0];
    assert.ok(step);
    await store.tasks.checkpoint(claimed.id, step.id, 0, {
      ...step.progress,
      revision: 1,
      effectiveMilliseconds: 60000,
    });
    await store.tasks.completeStep(claimed.id, step.id);
    assert.equal((await store.tasks.livePlans()).length, 2);
    assert.equal((await store.tasks.list()).length, 4);
    assert.equal((await store.tasks.get(stopped.id)).state, 'STOPPED');
    assert.equal((await store.tasks.get(claimed.id)).state, 'COMPLETED');
  });
});

test('task history reads the persisted profile ledger without exposing input or changing unknown effects', async () => {
  await fixture(async (store, file) => {
    const runtime = profiles(2);
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan);
    const operationId = randomUUID();
    await store.tasks.prepareOperation(plan.id, step.id, operationId, {
      kind: 'typeText',
      tabId: 1,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '[data-private="do-not-return"]' },
      text: 'private exact draft body',
    });
    await store.tasks.takeOperation();
    await store.tasks.markAcknowledged(operationId, {
      inputDispatched: true,
      secret: 'private receipt',
    });
    await store.tasks.settleOperation(operationId, 'UNKNOWN', { reason: 'private raw failure' });
    const service = new TaskService(store.tasks);
    const before = await store.tasks.get(plan.id);
    const result = await service.history({ profileId: plan.profileId });
    assert.equal(result.selectedPlanId, plan.id);
    assert.equal(result.operations[0]?.status, 'UNKNOWN');
    assert.equal(result.steps[0]?.progress.published, 0);
    assert.ok(result.events.length > 0);
    for (const value of [
      'private exact draft body',
      'private receipt',
      'private raw failure',
      'do-not-return',
    ])
      assert.equal(JSON.stringify(result).includes(value), false);
    assert.deepEqual(await store.tasks.get(plan.id), before);
    const other = runtime.find((row) => row.id !== plan.profileId);
    assert.ok(other);
    await assert.rejects(
      async () => await service.history({ profileId: other.id, planId: plan.id }),
      /这份浏览器/,
    );
    assert.equal((await service.history({ profileId: randomUUID() })).selectedPlanId, null);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(
        await new TaskService(reopened.tasks).history({ profileId: plan.profileId }),
        result,
      );
    } finally {
      reopened.close();
    }
  });
});
async function confirmControl(store: WorkspaceStore, id: string) {
  const plan = await store.tasks.get(id);
  assert.ok(plan.controlRequestId);
  return await store.tasks.confirmControl(id, plan.controlRequestId);
}
async function current(store: WorkspaceStore, plan: Plan) {
  const step = (await store.tasks.steps(plan.id, plan.round)).find(
    (row) => row.position === plan.position,
  );
  assert.ok(step);
  return step;
}
function progress(before: Progress, delta: Partial<Progress> = {}): Progress {
  return { ...before, ...delta, revision: before.revision + 1 };
}
async function completeCurrent(store: WorkspaceStore, plan: Plan) {
  const step = await current(store, plan);
  assert.notEqual(step.spec.type, 'post');
  const milliseconds = step.spec.type === 'post' ? 0 : step.spec.durationMinutes * 60_000;
  await store.tasks.checkpoint(
    plan.id,
    step.id,
    step.progress.revision,
    progress(step.progress, { effectiveMilliseconds: milliseconds }),
  );
  return await store.tasks.completeStep(plan.id, step.id);
}
test('29 plans persist atomically, only budgeted profiles are claimed and completion frees a slot', async () => {
  await fixture(async (store, file) => {
    store.tasks.setSettings({ maxConcurrentProfiles: 2 });
    const runtime = profiles(29),
      { plans } = await assign(store, runtime);
    assert.equal(plans.length, 29);
    const one = await store.tasks.claimNext(runtime, supported),
      two = await store.tasks.claimNext(runtime, supported);
    assert.ok(one && two);
    assert.notEqual(one.profileId, two.profileId);
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
    const peer = await WorkspaceStore.open(file);
    try {
      assert.equal(peer.tasks.list().length, 29);
      assert.equal(peer.tasks.claimNext(runtime, supported), null);
    } finally {
      peer.close();
    }
    let done = one;
    for (let i = 0; i < 3; i++) done = await completeCurrent(store, done);
    assert.equal(done.state, 'COMPLETED');
    assert.ok(await store.tasks.claimNext(runtime, supported));
    assert.equal((await store.tasks.list()).filter((row) => row.state === 'RUNNING').length, 2);
  });
});
test('actual concurrent processes cannot oversubscribe budget or execute the same account twice', async () => {
  for (const shared of [false, true])
    await fixture(async (store, file) => {
      const runtime = profiles(4);
      if (shared) for (const profile of runtime) profile.account.id = 'same-account';
      await store.tasks.setSettings({ maxConcurrentProfiles: shared ? 2 : 1 });
      await assign(store, runtime);
      const workers = Array.from({ length: 2 }, () =>
        spawn(
          process.execPath,
          ['dist/tests/fixtures/task-claim-worker.js', file, JSON.stringify(runtime)],
          {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true,
          },
        ),
      );
      const timer = setTimeout(() => workers.forEach((child) => child.kill()), 8000);
      try {
        const read = (child: (typeof workers)[number], type: string) =>
          new Promise<unknown>((resolve, reject) => {
            const onMessage = (value: unknown) => {
              if (value && typeof value === 'object' && 'type' in value && value.type === type) {
                child.off('message', onMessage);
                resolve(value);
              }
            };
            child.on('message', onMessage);
            child.once('error', reject);
            child.once('exit', (code) => {
              if (code !== 0) reject(Error('CLAIM_WORKER_EXIT_' + code));
            });
          });
        await Promise.all(workers.map((child) => read(child, 'READY')));
        const done = workers.map((child) => read(child, 'DONE'));
        workers.forEach((child) => child.send('GO'));
        await Promise.all(done);
        const running = (await store.tasks.list()).filter((plan) => plan.state === 'RUNNING');
        assert.equal(running.length, 1);
        assert.equal(new Set(running.map((plan) => plan.accountId)).size, 1);
      } finally {
        clearTimeout(timer);
        await Promise.all(
          workers.map(
            (child) =>
              new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) resolve();
                else {
                  child.once('exit', () => resolve());
                  child.kill();
                }
              }),
          ),
        );
      }
    });
});
test('batch retries are idempotent; conflict and occupied profile roll back the entire assignment', async () => {
  await fixture(async (store) => {
    const runtime = profiles(3),
      { plans, request } = await assign(store, runtime.slice(0, 1));
    const repeated = await store.tasks.assign(
      { ...request, profileIds: [request.profileIds[0] ?? '', request.profileIds[0] ?? ''] },
      runtime,
    );
    assert.equal(repeated[0]?.id, plans[0]?.id);
    await assert.rejects(
      async () => await store.tasks.assign({ ...request, version: 2 }, runtime),
      /提交标识/,
    );
    await assert.rejects(
      async () =>
        await store.tasks.assign(
          { ...request, requestId: randomUUID(), profileIds: runtime.map((row) => row.id) },
          runtime,
        ),
      /原计划/,
    );
    assert.equal((await store.tasks.list()).length, 1);
  });
});
test('unknown identity, offline, unsynced, unsupported executors and unready channels never claim', async () => {
  await fixture(async (store) => {
    const runtime = profiles(5);
    const a = runtime[0],
      b = runtime[1],
      c = runtime[2],
      d = runtime[3];
    assert.ok(a && b && c && d);
    a.account = { state: 'unknown', id: null, name: null, avatar: null };
    b.online = false;
    c.synced = false;
    d.dispatchAllowed = false;
    await assign(store, runtime);
    assert.equal(await store.tasks.claimNext(runtime, new Set()), null);
    assert.equal(
      (await store.tasks.list()).find((row) => row.profileId === a.id)?.reason,
      'IDENTITY_REQUIRED',
    );
    const one = await store.tasks.claimNext(runtime, supported);
    assert.equal(one?.profileId, runtime[4]?.id);
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
  });
});
test('two profiles sharing an account are mutually exclusive across database handles', async () => {
  await fixture(async (store, file) => {
    const runtime = profiles(2);
    const a = runtime[0],
      b = runtime[1];
    assert.ok(a && b);
    b.account.id = a.account.id;
    await assign(store, runtime);
    const one = await store.tasks.claimNext(runtime, supported);
    assert.ok(one);
    const peer = await WorkspaceStore.open(file);
    try {
      assert.equal(peer.tasks.claimNext(runtime, supported), null);
      assert.equal(peer.tasks.list().filter((row) => row.reason === 'ACCOUNT_BUSY').length, 1);
    } finally {
      peer.close();
    }
    await store.tasks.requestControl(one.id, 'pause');
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
    await confirmControl(store, one.id);
    assert.ok(await store.tasks.claimNext(runtime, supported));
  });
});
test('running snapshot uses requested saved version and cannot be changed by subsequent edits', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1),
      { plans, saved } = await assign(store, runtime);
    const plan = plans[0];
    assert.ok(plan);
    const draft = await store.writeDraft(saved.id, saved.revision, {
      ...combination(),
      name: '新版',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    await store.publish(saved.id, draft.revision);
    assert.equal((await store.tasks.get(plan.id)).version, 1);
    assert.equal((await store.tasks.get(plan.id)).snapshot.steps.length, 3);
    assert.equal((await store.tasks.get(plan.id)).snapshot.name, '调度验收');
  });
});
test('each round is stored once; repeated step types remain independent and infinite loops are lazy', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1),
      value = combination(2, true),
      { plans } = await assign(store, runtime, value);
    const initial = plans[0];
    assert.ok(initial);
    let plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const first = await store.tasks.steps(plan.id, 1);
    assert.equal(new Set(first.map((row) => row.id)).size, 3);
    assert.equal(first.filter((row) => row.spec.type === 'feed').length, 2);
    for (let i = 0; i < 3; i++) plan = await completeCurrent(store, plan);
    assert.equal(plan.round, 2);
    assert.equal((await store.tasks.steps(plan.id)).length, 6);
    for (let i = 0; i < 3; i++) plan = await completeCurrent(store, plan);
    assert.equal(plan.state, 'COMPLETED');
    assert.equal((await store.tasks.steps(plan.id)).length, 6);
    const infinite = { ...combination(), loop: { mode: 'until-stopped' as const } };
    await assign(store, runtime, infinite);
    let endless = await store.tasks.claimNext(runtime, supported);
    assert.ok(endless);
    for (let i = 0; i < 3; i++) endless = await completeCurrent(store, endless);
    assert.equal(endless.round, 2);
    assert.equal((await store.tasks.steps(endless.id)).length, 6);
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
test('pause retains checkpoint and order; resume is explicit; stop keeps history and frees profile', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1),
      { plans } = await assign(store, runtime, combination(2, true));
    assert.ok(plans[0]);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan);
    await store.tasks.checkpoint(
      plan.id,
      step.id,
      0,
      progress(step.progress, { effectiveMilliseconds: 12345 }),
    );
    assert.equal((await store.tasks.requestControl(plan.id, 'pause')).state, 'PAUSING');
    await assert.rejects(async () => await store.tasks.resume(plan.id), /不能继续/);
    await confirmControl(store, plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
    await store.tasks.resume(plan.id);
    assert.equal((await store.tasks.claimNext(runtime, supported))?.id, plan.id);
    assert.equal(
      (await current(store, await store.tasks.get(plan.id))).progress.effectiveMilliseconds,
      12345,
    );
    await store.tasks.requestControl(plan.id, 'stop');
    await confirmControl(store, plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'STOPPED');
    assert.equal((await store.tasks.steps(plan.id)).length, 3);
    await assert.rejects(async () => await store.tasks.resume(plan.id), /不能继续/);
    assert.equal((await assign(store, runtime)).plans.length, 1);
  });
});
test('outbox is durable before dispatch; duplicate ID never dispatches again; ACK does not advance', async () => {
  await fixture(async (store, file) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan),
      id = randomUUID();
    await store.tasks.prepareOperation(plan.id, step.id, id, click);
    assert.equal(
      (await store.tasks.prepareOperation(plan.id, step.id, id, click)).status,
      'PREPARED',
    );
    await assert.rejects(
      async () =>
        await store.tasks.prepareOperation(plan.id, step.id, id, {
          ...click,
          target: { css: 'other' },
        }),
      /内容不同/,
    );
    const peer = await WorkspaceStore.open(file);
    try {
      assert.equal(peer.tasks.operations(plan.id)[0]?.status, 'PREPARED');
      assert.equal(peer.tasks.takeOperation()?.id, id);
      assert.equal(await store.tasks.takeOperation(), null);
    } finally {
      peer.close();
    }
    await store.tasks.markAcknowledged(id, { inputDispatched: true });
    assert.equal((await current(store, plan)).progress.likes, 0);
    assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
    await assert.rejects(async () => await store.tasks.completeStep(plan.id, step.id), /未结算/);
    await assert.rejects(
      async () => await store.tasks.prepareOperation(plan.id, step.id, randomUUID(), click),
      /尚未结算/,
    );
    await store.tasks.settleOperation(
      id,
      'VERIFIED',
      { liked: true },
      progress(step.progress, { likes: 1 }),
    );
    assert.equal((await current(store, plan)).progress.likes, 1);
    await store.tasks.settleOperation(
      id,
      'VERIFIED',
      { liked: true },
      progress(step.progress, { likes: 1 }),
    );
    assert.equal((await current(store, plan)).progress.revision, 1);
  });
});
test('checkpoint validation prevents stale replies, progress regression, fake counters and incomplete completion', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan);
    await assert.rejects(
      async () =>
        await store.tasks.checkpoint(plan.id, step.id, 0, progress(step.progress, { likes: 1 })),
      /副作用/,
    );
    await store.tasks.checkpoint(
      plan.id,
      step.id,
      0,
      progress(step.progress, { effectiveMilliseconds: 500 }),
    );
    await assert.rejects(
      async () =>
        await store.tasks.checkpoint(
          plan.id,
          step.id,
          0,
          progress(step.progress, { effectiveMilliseconds: 1000 }),
        ),
      /进度已变化/,
    );
    const latest = await current(store, plan);
    await assert.rejects(
      async () =>
        await store.tasks.checkpoint(
          plan.id,
          step.id,
          1,
          progress(latest.progress, { effectiveMilliseconds: 1 }),
        ),
      /回退/,
    );
    await assert.rejects(async () => await store.tasks.completeStep(plan.id, step.id), /没有达到/);
  });
});
test('unknown side effects retain account lock even after stop; reconciliation applies checkpoint once', async () => {
  await fixture(async (store) => {
    const runtime = profiles(2);
    const a = runtime[0],
      b = runtime[1];
    assert.ok(a && b);
    b.account.id = a.account.id;
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan),
      id = randomUUID();
    await store.tasks.prepareOperation(plan.id, step.id, id, click);
    await store.tasks.takeOperation();
    await store.tasks.markAcknowledged(id, { inputDispatched: true });
    await store.tasks.settleOperation(id, 'UNKNOWN', { timeout: true });
    assert.equal((await store.tasks.get(plan.id)).state, 'REVIEW');
    await store.tasks.markAcknowledged(id, { late: true });
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
    await store.tasks.requestControl(plan.id, 'stop');
    await confirmControl(store, plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'REVIEW');
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
    await store.tasks.settleOperation(
      id,
      'VERIFIED',
      { liked: true },
      progress(step.progress, { likes: 1 }),
    );
    assert.equal((await store.tasks.get(plan.id)).state, 'STOPPED');
    assert.ok(await store.tasks.claimNext(runtime, supported));
    assert.equal((await current(store, plan)).progress.likes, 1);
  });
});
test('restart preserves order and checkpoints, pauses queues, cancels unsent commands and holds uncertain locks', async () => {
  await fixture(async (store, file) => {
    const runtime = profiles(3),
      { plans } = await assign(store, runtime, combination(2, true));
    assert.equal(plans.length, 3);
    const a = await store.tasks.claimNext(runtime, supported),
      b = await store.tasks.claimNext(runtime, supported);
    assert.ok(a && b);
    const stepA = await current(store, a),
      stepB = await current(store, b);
    await store.tasks.checkpoint(
      a.id,
      stepA.id,
      0,
      progress(stepA.progress, { effectiveMilliseconds: 555 }),
    );
    await store.tasks.prepareOperation(a.id, stepA.id, randomUUID(), click);
    const operation = await store.tasks.takeOperation();
    assert.ok(operation);
    await store.tasks.prepareOperation(b.id, stepB.id, randomUUID(), click);
    const order = (await store.tasks.steps(a.id)).map((row) => row.id);
    const restarted = await WorkspaceStore.open(file);
    try {
      assert.equal(restarted.tasks.get(a.id).state, 'RUNNING'); // Merely opening storage has no recovery side effects.
      restarted.tasks.recoverOnStartup();
      assert.equal(restarted.tasks.get(a.id).state, 'REVIEW');
      assert.equal(restarted.tasks.operations(a.id)[0]?.status, 'UNKNOWN');
      assert.equal(restarted.tasks.get(b.id).state, 'PAUSED');
      assert.equal(restarted.tasks.operations(b.id)[0]?.status, 'CANCELLED');
      assert.equal(restarted.tasks.list().filter((row) => row.state === 'PAUSED').length, 2);
      assert.deepEqual(
        restarted.tasks.steps(a.id).map((row) => row.id),
        order,
      );
      assert.equal(
        (await current(restarted, restarted.tasks.get(a.id))).progress.effectiveMilliseconds,
        555,
      );
      assert.equal(restarted.tasks.claimNext(runtime, supported), null);
      assert.throws(() => restarted.tasks.resume(a.id), /不能继续/);
    } finally {
      restarted.close();
    }
  });
});
test('account change stops old plan; temporary unreadable identity only requests a pause', async () => {
  await fixture(async (store) => {
    const runtime = profiles(2);
    await assign(store, runtime);
    const a = await store.tasks.claimNext(runtime, supported),
      b = await store.tasks.claimNext(runtime, supported);
    assert.ok(a && b);
    const profileA = runtime.find((row) => row.id === a.profileId),
      profileB = runtime.find((row) => row.id === b.profileId);
    assert.ok(profileA && profileB);
    profileA.account.id = 'changed-account';
    profileB.account = { state: 'unknown', id: null, name: null, avatar: null };
    await store.tasks.reconcileRuntime(runtime);
    assert.equal((await store.tasks.get(a.id)).state, 'STOPPING');
    assert.equal((await store.tasks.get(a.id)).reason, 'ACCOUNT_CHANGED');
    assert.equal((await store.tasks.get(b.id)).state, 'PAUSING');
    assert.equal(await store.tasks.takeOperation(), null);
  });
});
test('dispatcher cannot blindly resend after uncertain send or overlapping flush', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan),
      id = randomUUID();
    await store.tasks.prepareOperation(plan.id, step.id, id, click);
    let release: (() => void) | undefined,
      sends = 0;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestEpoch = randomUUID(),
      requestLease = randomUUID();
    const dispatcher = new TaskDispatcher(store.tasks, {
      profiles: () => runtime,
      session: (profileId) => ({
        profileId,
        accountId: runtime[0]?.account.id ?? '',
        connectionEpoch: requestEpoch,
        leaseId: requestLease,
        generation: 0,
      }),
      send: async (): Promise<ExecutionReceipt> => {
        sends++;
        assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'DISPATCHING');
        await blocker;
        throw Error('CONNECTION_LOST');
      },
    });
    const pending = dispatcher.flushOne();
    assert.equal(await dispatcher.flushOne(), false);
    assert.ok(release);
    release();
    assert.equal(await pending, true);
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
    assert.equal(await dispatcher.flushOne(), false);
    assert.equal(sends, 1);
    assert.equal((await new TaskService(store.tasks).overview()).dispatchEnabled, false);
  });
});
test('old control confirmations and repeated uncertainty cannot release a newer stop or undo its evidence', async () => {
  await fixture(async (store) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const paused = await store.tasks.requestControl(plan.id, 'pause');
    assert.ok(paused.controlRequestId);
    const stopped = await store.tasks.requestControl(plan.id, 'stop');
    assert.ok(stopped.controlRequestId);
    assert.notEqual(paused.controlRequestId, stopped.controlRequestId);
    await assert.rejects(
      async () => await store.tasks.confirmControl(plan.id, paused.controlRequestId ?? ''),
      /过期/,
    );
    await store.tasks.confirmControl(plan.id, stopped.controlRequestId);
    assert.equal((await store.tasks.get(plan.id)).state, 'STOPPED');
    await assign(store, runtime);
    const second = await store.tasks.claimNext(runtime, supported);
    assert.ok(second);
    const step = await current(store, second),
      id = randomUUID();
    await store.tasks.prepareOperation(second.id, step.id, id, click);
    await store.tasks.takeOperation();
    await store.tasks.settleOperation(id, 'UNKNOWN', { timeout: true });
    await store.tasks.requestControl(second.id, 'stop');
    await confirmControl(store, second.id);
    await store.tasks.settleOperation(id, 'UNKNOWN', { duplicate: true });
    assert.equal((await store.tasks.get(second.id)).controlConfirmed, true);
    await store.tasks.settleOperation(id, 'NOT_APPLIED', { verifiedAbsent: true });
    assert.equal((await store.tasks.get(second.id)).state, 'STOPPED');
  });
});
test('restart while waiting for stop retains its lock and rejects the previous control request', async () => {
  await fixture(async (store) => {
    const runtime = profiles(2),
      a = runtime[0],
      b = runtime[1];
    assert.ok(a && b);
    b.account.id = a.account.id;
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const stopping = await store.tasks.requestControl(plan.id, 'pause');
    assert.ok(stopping.controlRequestId);
    await store.tasks.recoverOnStartup();
    assert.equal((await store.tasks.get(plan.id)).state, 'REVIEW');
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
    const latest = await store.tasks.requestControl(plan.id, 'pause');
    assert.ok(latest.controlRequestId);
    await assert.rejects(
      async () => await store.tasks.confirmControl(plan.id, stopping.controlRequestId ?? ''),
      /过期/,
    );
    await confirmControl(store, plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
  });
});
test('a second controller fails on occupied port before recovering or creating either database', async () => {
  await fixture(async (store, file) => {
    const runtime = profiles(1);
    await assign(store, runtime);
    const plan = await store.tasks.claimNext(runtime, supported);
    assert.ok(plan);
    const step = await current(store, plan),
      id = randomUUID();
    await store.tasks.prepareOperation(plan.id, step.id, id, click);
    await store.tasks.takeOperation();
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
      assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
      assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'DISPATCHING');
      assert.equal((await readdir(path.dirname(file))).includes('journal.sqlite'), false);
    } finally {
      await releaseControllerPort(occupied.server);
    }
  });
});
test('migration from v1 backs up and preserves existing data; SQLite prevents snapshot/order edits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-migration-')),
    file = path.join(dir, 'workspace.sqlite');
  const before = new DatabaseSync(file);
  before.exec(
    "CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT,color TEXT,sort_order INTEGER); CREATE TABLE profile_metadata(profile_id TEXT PRIMARY KEY,group_id TEXT,alias TEXT); CREATE TABLE combinations(id TEXT PRIMARY KEY,current_version INTEGER,revision INTEGER,draft TEXT,updated_at INTEGER); CREATE TABLE combination_versions(combination_id TEXT,version INTEGER,body TEXT,created_at INTEGER,PRIMARY KEY(combination_id,version)); INSERT INTO groups VALUES('keep','保留组','blue',0); PRAGMA user_version=1",
  );
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
    const planA = await store.tasks.claimNext(runtime, supported);
    const planB = await store.tasks.claimNext(runtime, supported);
    assert.ok(planA && planB);
    const stepA0 = await current(store, planA);
    await store.tasks.checkpoint(
      planA.id,
      stepA0.id,
      0,
      progress(stepA0.progress, { effectiveMilliseconds: 900_000 }),
    );
    await store.tasks.completeStep(planA.id, stepA0.id);
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
    const browserAName = planA.profileId === runtime[0]?.id ? '浏览器1' : '浏览器2';
    const byBrowser = await service.records(
      { profileId: planA.profileId, query: browserAName, limit: 2 },
      runtime.map((p, i) => ({ id: p.id, browserName: `浏览器${i + 1}`, alias: `别名${i + 1}` })),
    );
    assert.equal(byBrowser.total, 3);
    assert.equal(byBrowser.records.length, 2);
    assert.ok(byBrowser.nextCursor && byBrowser.nextCursor !== '2');
    const secondPage = await service.records(
      { profileId: planA.profileId, query: browserAName, cursor: byBrowser.nextCursor!, limit: 2 },
      runtime.map((p, i) => ({ id: p.id, browserName: `浏览器${i + 1}`, alias: `别名${i + 1}` })),
    );
    assert.equal(secondPage.records.length, 1);
    assert.equal(secondPage.nextCursor, null);
  });
});
