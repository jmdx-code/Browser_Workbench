import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Workboard } from '../src/application/workboard.js';
import { ActiveAccountRuntime } from '../src/infrastructure/active-account-runtime.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';
import { emptyResourceRow } from '../src/domain/resource-table.js';
import { makeRuntimeProfiles, workspaceFixture } from './fixtures/workspace-fixture.js';

function fakeLifecycle(
  launchImpl: ProfileLifecyclePort['ensureProfilesOnline'],
): ProfileLifecyclePort {
  return {
    isLaunching: () => false,
    getStatus: async (ids) =>
      ids.map((profileId) => ({
        profileId,
        browserName: null,
        action: 'status',
        ok: true,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        launchable: true,
        elapsedMs: 0,
      })),
    launchProfile: async (profileId) => ({
      profileId,
      browserName: null,
      action: 'open',
      ok: false,
      online: false,
      phase: 'OFFLINE',
      synced: false,
      launchable: true,
      elapsedMs: 0,
    }),
    closeProfile: async (profileId) => ({
      profileId,
      browserName: null,
      action: 'close',
      ok: true,
      online: false,
      phase: 'OFFLINE',
      synced: false,
      launchable: true,
      elapsedMs: 0,
    }),
    restartProfile: async (profileId) => ({
      profileId,
      browserName: null,
      action: 'restart',
      ok: true,
      online: false,
      phase: 'OFFLINE',
      synced: false,
      launchable: true,
      elapsedMs: 0,
    }),
    ensureProfilesOnline: launchImpl,
  };
}

test('ActiveAccountRuntime starts batch in <1s without blocking on slow or offline launch failures', async () =>
  workspaceFixture(async (store, _file, dir) => {
    const bridgeStore = new Store(':memory:');
    const core = new Core(bridgeStore);
    const workboard = new Workboard({ browserConcurrency: 2, launchConcurrency: 2 });
    const [p1, p2] = makeRuntimeProfiles(2);
    assert.ok(p1 && p2);
    const combo = store.createCombination({
      name: 'Nonblocking Batch',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    let releaseP1: (() => void) | undefined;
    const runtime = new ActiveAccountRuntime({
      workboard,
      store,
      core,
      kernel: {} as unknown as KernelBridge,
      profileSource: {
        profiles: () =>
          [p1, p2].map((p) => ({
            id: p.id,
            alias: p.id.slice(0, 6),
            groupId: null,
            order: 0,
            online: false,
            synced: false,
            phase: 'OFFLINE' as const,
            unresolved: 0,
            extensionVersion: '0.3.92',
            capabilities: [],
            account: p.account,
          })),
        records: () => [],
        stop: () => {},
      },
      profileLifecycle: fakeLifecycle(async (ids) => {
        if (ids.includes(p1.id)) {
          await new Promise<void>((resolve) => {
            releaseP1 = resolve;
            setTimeout(resolve, 2500);
          });
        }
        return {
          requestedIds: [...ids],
          readyIds: [],
          launchedIds: [],
          failed: ids.map((profileId) => ({
            profileId,
            errorCode: 'LAUNCH_TIMEOUT',
            reason: 'offline in test',
          })),
          items: [],
        };
      }),
      dataDirectory: dir,
      uploadCacheRoot: dir,
    });
    try {
      const startedAt = Date.now();
      const plans = await runtime.start({
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [p1.id, p2.id],
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(plans.length, 2);
      assert.ok(elapsed < 1000, `expected non-blocking start <1s, took ${elapsed}ms`);

      // p1 and p2 are sorted lexicographically by assign(), so resolve each by profileId
      const planP1 = plans.find((p) => p.profileId === p1.id)!;
      const planP2 = plans.find((p) => p.profileId === p2.id)!;
      assert.ok(planP1 && planP2);

      // commandPlan('resume') rejects cleanly; commandPlan('stop') aborts immediately
      await assert.rejects(
        () => runtime.commandPlan(planP1.id, 'resume'),
        (err: unknown) =>
          err instanceof Error && 'code' in err && err.code === 'TASK_RESUME_REMOVED',
      );
      const stopped = await runtime.commandPlan(planP1.id, 'stop');
      assert.equal(stopped.state, 'STOPPED');
      await workboard.waitUntilCarrierIdle(p2.id, 1000);
      assert.equal(store.tasks.get(planP2.id).state, 'FAILED');
      releaseP1?.();
    } finally {
      await runtime.close();
      await core.shutdown();
      bridgeStore.close();
    }
  }));

test('direct publication ledger tracks fingerprint dedup, materialUsage, resourceTables usageSummaries and removePublishedRow', async () =>
  workspaceFixture(async (store) => {
    const [profile] = makeRuntimeProfiles(1);
    assert.ok(profile);
    const combo = store.createCombination({
      name: 'Direct Post Table',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          count: 1,
          destination: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const row1 = { ...emptyResourceRow(randomUUID()), text: 'First direct post' };
    const row2 = { ...emptyResourceRow(randomUUID()), text: 'Second direct post' };
    const savedTable = store.resourceTables.save(combo.id, 0, [row1, row2]);
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        expectedResourceRevision: savedTable.revision,
        profileIds: [profile.id],
      },
      [profile],
    );
    assert.ok(plan);
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    const [step] = store.tasks.steps(plan.id);
    assert.ok(step);

    const fp1 = 'fp-direct-1';
    const srcKey1 = `table:${combo.id}:${row1.id}`;
    assert.equal(store.tasks.hasAccountPublishedFingerprint(profile.account.id!, fp1), false);
    assert.equal(store.tasks.isMaterialSourceUsed(srcKey1), false);

    store.tasks.recordDirectPublication({
      jobId: plan.id,
      stepId: step.id,
      accountId: profile.account.id!,
      combinationId: combo.id,
      fingerprint: fp1,
      postId: 'post-999',
      usageSourceKey: srcKey1,
      allowRepeat: false,
      resourceOrigin: {
        version: 1,
        combinationId: combo.id,
        revision: savedTable.revision,
        row: row1,
      },
    });
    assert.equal(store.tasks.hasAccountPublishedFingerprint(profile.account.id!, fp1), true);
    assert.equal(store.tasks.isMaterialSourceUsed(srcKey1), true);
    assert.equal(store.materialUsage.snapshot().published, 1);

    const summaries = store.resourceTables.usageSummaries();
    assert.equal(summaries[0]?.published, 1);

    store.resourceTables.removePublishedRow(combo.id, row1, Date.now());
    assert.deepEqual(
      store.resourceTables.read(combo.id).rows.map((r) => r.id),
      [row2.id],
    );

    const done = store.tasks.completeStepDirect(plan.id, step.id, {
      ...step.progress,
      published: 1,
    });
    assert.equal(done.state, 'COMPLETED');
  }));

test('skipStepDirect skips unavailable Marketplace and continues remaining step without error', async () =>
  workspaceFixture(async (store) => {
    const [profile] = makeRuntimeProfiles(1);
    assert.ok(profile);
    const combo = store.createCombination({
      name: 'Marketplace + Feed',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'marketplace',
          durationMinutes: 1,
          keyword: '',
          maxLikes: 0,
          minLikeCount: 0,
        },
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profile.id],
      },
      [profile],
    );
    assert.ok(plan);
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    const s0 = store.tasks.currentStepForPlan(plan.id, 1, 0)!;
    const afterSkip = store.tasks.skipStepDirect(plan.id, s0.id, 'MARKETPLACE_UNAVAILABLE');
    assert.equal(afterSkip.state, 'RUNNING');
    assert.equal(afterSkip.position, 1);
    const s1 = store.tasks.currentStepForPlan(plan.id, 1, 1)!;
    const finished = store.tasks.completeStepDirect(plan.id, s1.id, {
      ...s1.progress,
      effectiveMilliseconds: 60_000,
    });
    assert.equal(finished.state, 'COMPLETED');
    assert.equal(store.tasks.steps(plan.id)[0]?.outcome?.reason, 'MARKETPLACE_UNAVAILABLE');
  }));
