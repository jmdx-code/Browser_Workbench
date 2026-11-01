import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { postFixture, postRequest } from './fixtures/material-post.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { FacebookPublishingRuntime } from '../src/infrastructure/facebook-publishing-runtime.js';
import { TaskEndingCoordinator } from '../src/infrastructure/task-ending-coordinator.js';
import { DatabaseSync } from 'node:sqlite';
import type { Timing } from '../src/shared/task-timing.js';
import type { WorkspaceStorePort } from '../src/infrastructure/persistence-port.js';

function makePlan(store: WorkspaceStore, timing?: Timing) {
  const profile = {
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in' as const, id: randomUUID(), name: null, avatar: null },
  };
  const combo = store.createCombination({
    name: 'WO52',
    note: 'isolated, no browser',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
  });
  const [plan] = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: 1,
      profileIds: [profile.id],
      ...(timing ? { timing } : {}),
    },
    [profile],
  );
  assert.ok(plan);
  return { plan, profile };
}
function harness(
  t: TestContext,
  store: WorkspaceStore,
  file: string,
  poll: () => Promise<unknown[]> = async () => [],
) {
  const bridge = new Store(':memory:'),
    core = new Core(bridge),
    kernel = new KernelBridge(core, new WatchTasks(core));
  const runtime = new FacebookPublishingRuntime(kernel, core, store, path.dirname(file), () => [], {
    feed: () => true,
    video: () => true,
  });
  const internals = runtime as unknown as {
    runner: { poll(): Promise<unknown[]> };
    available(): Promise<boolean>;
  };
  t.mock.method(internals, 'available', async () => true);
  t.mock.method(internals.runner, 'poll', poll);
  return {
    runtime,
    core,
    kernel,
    async close() {
      await runtime.close();
      await kernel.close();
      await core.shutdown();
      bridge.close();
    },
  };
}

test('WO52-1: restart stops ordinary running/queued/user-paused plans, preserves progress and future schedules', async (t) => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await settlementFixture(async (store) => {
    const running = makePlan(store),
      queued = makePlan(store),
      paused = makePlan(store);
    store.tasks.claimNext([running.profile], new Set(['feed']));
    const step = store.tasks.steps(running.plan.id)[0]!;
    store.tasks.checkpoint(running.plan.id, step.id, 0, {
      ...step.progress,
      revision: 1,
      effectiveMilliseconds: 1234,
    });
    store.tasks.requestControl(paused.plan.id, 'pause', 'USER_PAUSE');
    const scheduled = makePlan(store, { mode: 'at', startAt: now + 60_000, timeZone: 'UTC' });
    now += 10;
    store.tasks.recoverOnStartup();
    for (const f of [running, queued, paused]) {
      assert.equal(store.tasks.get(f.plan.id).state, 'STOPPED');
      assert.equal(store.tasks.get(f.plan.id).reason, 'SOFTWARE_RESTART_STOPPED');
      // A fresh plan for the same account is possible: the original lock has been released.
      assert.equal(store.tasks.unresolved(f.plan.id), false);
    }
    assert.equal(store.tasks.steps(running.plan.id)[0]?.progress.effectiveMilliseconds, 1234);
    assert.equal(store.tasks.get(scheduled.plan.id).state, 'QUEUED');
  });
});

test('WO52-2: no-peer future schedule starts its offline grace only when released; reconnect resets grace', async (t) => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await settlementFixture(async (store, file) => {
    const f = makePlan(store, { mode: 'at', startAt: now + 60_000, timeZone: 'UTC' });
    store.tasks.recoverOnStartup();
    const h = harness(t, store, file);
    try {
      await h.runtime.tick();
      assert.equal(store.tasks.get(f.plan.id).state, 'QUEUED');
      now += 60_000;
      await h.runtime.tick();
      now += 14_999;
      await h.runtime.tick();
      assert.equal(store.tasks.get(f.plan.id).state, 'QUEUED');
      const peer = h.core.connect(
        f.profile.id,
        () => {},
        () => {},
      );
      peer.synced = true;
      peer.phase = 'PAUSED';
      await h.runtime.tick();
      peer.online = false;
      now += 1;
      await h.runtime.tick();
      now += 14_999;
      await h.runtime.tick();
      assert.equal(store.tasks.get(f.plan.id).state, 'QUEUED');
      now += 1;
      await h.runtime.tick();
      assert.equal(store.tasks.get(f.plan.id).state, 'STOPPED');
    } finally {
      await h.close();
    }
  });
});

test('WO52-3: windowCount zero ends immediately; a pause caused by this WS loss keeps all 15 seconds', async (t) => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await settlementFixture(async (store, file) => {
    const a = makePlan(store),
      b = makePlan(store),
      oldPause = makePlan(store);
    store.tasks.claimNext([b.profile], new Set(['feed']));
    store.tasks.requestControl(oldPause.plan.id, 'pause', 'RUNTIME_NOT_READY');
    let paused = false;
    const h = harness(t, store, file, async () => {
      if (!paused) {
        paused = true;
        now += 1;
        const control = store.tasks.requestControl(b.plan.id, 'pause', 'RUNTIME_NOT_READY');
        assert.ok(control.controlRequestId);
        store.tasks.confirmControl(b.plan.id, control.controlRequestId);
      }
      return [];
    });
    const pa = h.core.connect(
      a.profile.id,
      () => {},
      () => {},
    );
    pa.browserWindowCount = 0;
    const pb = h.core.connect(
      b.profile.id,
      () => {},
      () => {},
    );
    pb.online = false;
    pb.browserWindowCount = 1;
    now += 1;
    try {
      await h.runtime.tick();
      assert.equal(store.tasks.get(a.plan.id).state, 'STOPPED');
      assert.equal(store.tasks.get(oldPause.plan.id).state, 'STOPPED');
      assert.equal(store.tasks.get(b.plan.id).state, 'PAUSED');
      now += 14_998;
      await h.runtime.tick();
      assert.equal(store.tasks.get(b.plan.id).state, 'PAUSED');
      now += 1;
      await h.runtime.tick();
      assert.equal(store.tasks.get(b.plan.id).state, 'STOPPED');
    } finally {
      await h.close();
    }
  });
});

test('WO52-4a: unresolved clicks become REVIEW without success or unlocking; repeated checks perform no writes', async (t) => {
  await settlementFixture(async (store, file) => {
    const f = prepareBound(store, 2);
    const h = harness(t, store, file);
    const peer = h.core.connect(
      f.profile.id,
      () => {},
      () => {},
    );
    peer.browserWindowCount = 0;
    try {
      await h.runtime.tick();
      const reviewed = store.tasks.get(f.plan.id);
      assert.equal(reviewed.state, 'REVIEW');
      assert.equal(reviewed.controlConfirmed, false);
      assert.equal(store.tasks.operations(f.plan.id)[0]?.status, 'UNKNOWN');
      const token = store.tasks.cacheStateToken();
      for (let i = 0; i < 4; i++) {
        await h.runtime.tick();
        store.tasks.stopOfflineBrowse(f.plan.id, 'BROWSER_OFFLINE_STOPPED', {
          reviewIfBlocked: true,
        });
      }
      assert.equal(store.tasks.cacheStateToken(), token);
      assert.equal(store.tasks.get(f.plan.id).updatedAt, reviewed.updatedAt);
      assert.equal(store.tasks.stopOfflineBrowse(f.plan.id), null);
      assert.equal(store.tasks.get(f.plan.id).controlConfirmed, false);
      const read = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(
          read.prepare('SELECT count(*) n FROM task_account_locks WHERE job_id=?').get(f.plan.id)
            ?.n,
          1,
        );
      } finally {
        read.close();
      }
    } finally {
      await h.close();
    }
  });
});

test('WO52-4b: reserved material remains REVIEW on runtime loss and restart, idempotently', async (t) => {
  await postFixture(async (store, file, catalog) => {
    const request = postRequest(store, catalog);
    store.materials.reserve(request);
    const h = harness(t, store, file);
    const peer = h.core.connect(
      request.context.profileId,
      () => {},
      () => {},
    );
    peer.browserWindowCount = 0;
    try {
      await h.runtime.tick();
      assert.equal(store.materials.reservation(request.attemptId).state, 'REVIEW');
      assert.equal(store.tasks.get(request.jobId).state, 'REVIEW');
      const token = store.tasks.cacheStateToken();
      for (let i = 0; i < 3; i++) await h.runtime.tick();
      assert.equal(store.tasks.cacheStateToken(), token);
      store.tasks.recoverOnStartup();
      assert.equal(store.tasks.get(request.jobId).state, 'REVIEW');
    } finally {
      await h.close();
    }
  }, false);
});

test('WO52-5: poll failure does not bypass offline cleanup or hide the poll error', async (t) => {
  await settlementFixture(async (store, file) => {
    const f = makePlan(store);
    const error = Error('EXPECTED_POLL_FAILURE');
    const h = harness(t, store, file, async () => {
      throw error;
    });
    const peer = h.core.connect(
      f.profile.id,
      () => {},
      () => {},
    );
    peer.browserWindowCount = 0;
    try {
      await assert.rejects(h.runtime.tick(), (e) => e === error);
      assert.equal(store.tasks.get(f.plan.id).state, 'STOPPED');
    } finally {
      await h.close();
    }
  });
});

test('WO52-6: coordinator rechecks connection and ownership after asynchronous reads; store rejects stale versions', async () => {
  await settlementFixture(async (store) => {
    const f = makePlan(store);
    const bridge = new Store(':memory:'),
      core = new Core(bridge),
      kernel = new KernelBridge(core, new WatchTasks(core));
    const peer = core.connect(
      f.profile.id,
      () => {},
      () => {},
    );
    peer.online = false;
    let inFlight = false,
      writes = 0,
      onRead = () => {};
    const delayed = {
      tasks: {
        get: async () => {
          await Promise.resolve();
          onRead();
          return store.tasks.get(f.plan.id);
        },
        stopOfflineBrowse: () => {
          writes++;
          return null;
        },
      },
    } as unknown as WorkspaceStorePort;
    const ending = new TaskEndingCoordinator(kernel, core, delayed);
    try {
      onRead = () => {
        peer.online = true;
      };
      assert.equal(
        await ending.stopOffline(f.plan.id, false, 'BROWSER_OFFLINE_STOPPED', {
          canStopOffline: () => !inFlight,
        }),
        null,
      );
      peer.online = false;
      onRead = () => {
        inFlight = true;
      };
      assert.equal(
        await ending.stopOffline(f.plan.id, false, 'BROWSER_OFFLINE_STOPPED', {
          canStopOffline: () => !inFlight,
        }),
        null,
      );
      assert.equal(writes, 0);
      assert.equal(
        store.tasks.stopOfflineBrowse(f.plan.id, 'STALE', {
          expectedUpdatedAt: f.plan.updatedAt - 1,
          reviewIfBlocked: true,
        }),
        null,
      );
      assert.equal(store.tasks.get(f.plan.id).state, 'QUEUED');
    } finally {
      await kernel.close();
      await core.shutdown();
      bridge.close();
    }
  });
});

test('WO52-7: clearing startup backoff retains reopening until the original in-flight admission is absent', async (t) => {
  await settlementFixture(async (store, file) => {
    const h = harness(t, store, file);
    const id = randomUUID();
    const internals = h.runtime.runtime as unknown as {
      reopeningProfiles: Set<string>;
      opening: Map<string, Promise<void>>;
    };
    try {
      internals.reopeningProfiles.add(id);
      h.runtime.runtime.clearStartupBackoff(id);
      assert.equal(h.runtime.hasExecutionOrOpening(id), true);
      internals.opening.set(id, Promise.resolve());
      h.runtime.runtime.clearReopeningIfIdle(id);
      assert.equal(h.runtime.hasExecutionOrOpening(id), true);
      internals.opening.delete(id);
      h.runtime.runtime.clearReopeningIfIdle(id);
      assert.equal(h.runtime.hasExecutionOrOpening(id), false);
    } finally {
      await h.close();
    }
  });
});

test('WO52: historical queued/missed schedule with reserved material reaches REVIEW, not the old PAUSED shortcut', async (t) => {
  await postFixture(async (store, file, catalog) => {
    const r = postRequest(store, catalog);
    store.materials.reserve(r);
    const plan = store.tasks.get(r.jobId);
    // Only this isolated historical fixture is altered: represent an interrupted old snapshot.
    // New tasks cannot normally reserve material before a timed admission.
    const fixture = new DatabaseSync(file);
    try {
      fixture
        .prepare('INSERT INTO task_batch_timing(batch_id,body) VALUES(?,?)')
        .run(
          plan.batchId,
          JSON.stringify({ mode: 'at', startAt: Date.now() - 120_000, timeZone: 'UTC' }),
        );
      fixture.prepare("UPDATE task_plans SET state='QUEUED' WHERE id=?").run(plan.id);
    } finally {
      fixture.close();
    }
    assert.notEqual(store.tasks.get(plan.id).timingReleased, true);
    assert.equal(store.tasks.operations(plan.id).length, 0);
    const reasons: (string | undefined)[] = [];
    const original = store.tasks.stopOfflineBrowse.bind(store.tasks);
    t.mock.method(store.tasks, 'stopOfflineBrowse', (...args: Parameters<typeof original>) => {
      reasons.push(args[1]);
      return original(...args);
    });
    store.tasks.recoverOnStartup();
    assert.equal(reasons[0], 'SCHEDULE_MISSED_ON_RESTART');
    assert.equal(store.tasks.get(plan.id).state, 'REVIEW');
    assert.equal(store.materials.reservation(r.attemptId).state, 'REVIEW');
    assert.equal(store.tasks.get(plan.id).controlConfirmed, false);
  }, false);
});

for (const status of ['ACKNOWLEDGED', 'UNKNOWN'] as const) {
  test(`WO52: ${status} click on restart remains unknown and held for review`, async () =>
    settlementFixture(async (store, file) => {
      const f = prepareBound(store, 2);
      if (status === 'ACKNOWLEDGED') store.tasks.acknowledgeBound(f.receipt);
      else store.tasks.markBoundUnknown(f.binding, 'EXPECTED_TEST_UNKNOWN');
      store.tasks.recoverOnStartup();
      assert.equal(store.tasks.get(f.plan.id).state, 'REVIEW');
      assert.equal(store.tasks.operations(f.plan.id)[0]?.status, 'UNKNOWN');
      assert.equal(store.tasks.get(f.plan.id).controlConfirmed, false);
      const read = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(
          read.prepare('SELECT count(*) n FROM task_account_locks WHERE job_id=?').get(f.plan.id)
            ?.n,
          1,
        );
      } finally {
        read.close();
      }
    }));
}
