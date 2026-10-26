import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { postFixture, postRequest } from './fixtures/material-post.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { FacebookPublishingRuntime } from '../src/infrastructure/facebook-publishing-runtime.js';
import { TaskService } from '../src/application/task-service.js';
import type { Peer } from '../src/bridge/core.js';
import type { Step } from '../src/shared/contracts.js';
import {
  marketplaceBridgeSupported,
  marketplaceMinimumBridge,
} from '../src/shared/task-features.js';

test('next daily window resumes only a confirmed automatic window pause, never a user pause or restarted controller', async (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await postFixture(async (workspace, file) => {
    const bridgeStore = new Store(':memory:'),
      core = new Core(bridgeStore),
      kernel = new KernelBridge(core, new WatchTasks(core));
    const combination = await workspace.createCombination({
      name: 'Generated daily window',
      note: 'Clock fixture, not a real next-day browser test.',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 4, maxLikes: 0, minLikeCount: 0 }],
    });
    const paused = async (reason: string) => {
      const profile = {
        id: randomUUID(),
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in' as const, id: randomUUID(), name: null, avatar: null },
      };
      const [plan] = await workspace.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: combination.id,
          version: combination.version,
          profileIds: [profile.id],
          timing: {
            mode: 'window',
            startTime: '11:00',
            endTime: '13:00',
            timeZone: 'UTC',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
          },
        },
        [profile],
      );
      assert.ok(plan);
      assert.equal((await workspace.tasks.claimNext([profile], new Set(['feed'])))?.id, plan.id);
      const control = await workspace.tasks.requestControl(plan.id, 'pause', reason);
      assert.ok(control.controlRequestId);
      await workspace.tasks.confirmControl(plan.id, control.controlRequestId);
      return plan.id;
    };
    const automatic = await paused('SCHEDULE_WINDOW_CLOSED');
    const manual = await paused('USER_PAUSE');
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      workspace,
      path.dirname(file),
      () => [],
      { feed: () => true },
    );
    try {
      now = Date.parse('2026-10-15T14:00:00Z');
      await runtime.tick();
      assert.equal((await workspace.tasks.get(automatic)).state, 'PAUSED');
      now = Date.parse('2026-10-16T12:00:00Z');
      await runtime.tick();
      assert.equal((await workspace.tasks.get(automatic)).state, 'QUEUED');
      assert.equal((await workspace.tasks.get(manual)).state, 'PAUSED');
      assert.equal((await workspace.tasks.operations(automatic)).length, 0);
      // Startup recovery replaces the old controller's automatic-resume authority.
      await workspace.tasks.recoverOnStartup();
      await runtime.tick();
      assert.equal((await workspace.tasks.get(automatic)).state, 'PAUSED');
      assert.equal((await workspace.tasks.get(manual)).state, 'PAUSED');
    } finally {
      await runtime.close();
      await kernel.close();
      bridgeStore.close();
    }
  }, false);
});

test('accepted stories are independent from ordinary posts, require friends and current bridge, and resume checks the original whole plan', async () => {
  await postFixture(async (workspace, file, catalog) => {
    const bridgeStore = new Store(':memory:'),
      core = new Core(bridgeStore),
      kernel = new KernelBridge(core, new WatchTasks(core));
    const profileId = randomUUID();
    const profile = {
      id: profileId,
      online: false,
      synced: false,
      unresolved: 0,
      dispatchAllowed: false,
      account: { state: 'unknown' as const, id: null, name: null, avatar: null },
    };
    const peer = { profileId, extensionVersion: '0.3.32' } as Peer;
    core.peers.set(profileId, peer);
    let storyEnabled = true;
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      workspace,
      path.dirname(file),
      () => [profile],
      { story: () => storyEnabled, feed: () => true },
    );
    const step: Step = {
      id: randomUUID(),
      type: 'post',
      destination: 'story',
      audience: 'friends',
      resourceDirectory: catalog.directory,
      count: 1,
      allowRepeat: false,
      forbidSameAccountRepeat: true,
      archivePublished: false,
    };
    const create = async (name: string, steps: Step[]) =>
      await workspace.createCombination({
        name,
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps,
      });
    const story = await create('Generated story', [step]);
    const ordinary = await create('Generated ordinary', [
      { ...step, id: randomUUID(), destination: 'post', audience: 'self' },
    ]);
    const mixed = await create('Generated mixed', [step, ordinary.saved!.steps[0]!]);
    const browsing = await create('Generated mixed browse', [
      { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      step,
    ]);
    const request = {
      requestId: randomUUID(),
      combinationId: story.id,
      version: story.version,
      profileIds: [profileId],
    };
    try {
      assert.deepEqual(await runtime.supportedTypes(), ['feed', 'post']);
      assert.equal(await runtime.supportsFeature('story'), true);
      assert.equal(await runtime.supportsFeature('post'), false);
      const service = new TaskService(workspace.tasks, () => runtime);
      assert.equal(
        (await service.features('2')).features.find((f) => f.id === 'story')?.status,
        'available',
      );
      assert.equal(
        (await service.features('2')).features.find((f) => f.id === 'post')?.status,
        'verification-pending',
      );
      assert.equal(
        (await runtime.capabilities()).combinations.find((c) => c.id === browsing.id)?.enabled,
        true,
      );
      assert.equal(
        (await runtime.capabilities()).combinations.find((c) => c.id === mixed.id)?.enabled,
        false,
      );
      assert.match(await runtime.unavailableReason(ordinary.saved!), /发布内容/);
      for (const audience of [undefined, 'self', 'preserve-current'] as const)
        assert.match(
          await runtime.unavailableReason({ ...story.saved!, steps: [{ ...step, audience }] }),
          /好友范围/,
        );
      const before = await workspace.tasks.list();
      await assert.rejects(async () => await runtime.start(request), /插件0.3.33/);
      assert.deepEqual(await workspace.tasks.list(), before);
      peer.extensionVersion = '0.3.33';
      const [queued] = await runtime.start(request);
      assert.ok(queued);
      const paused = await runtime.commandPlan(queued.id, 'pause');
      assert.equal(paused.state, 'PAUSED');
      storyEnabled = false;
      await assert.rejects(runtime.commandPlan(queued.id, 'resume'), /快拍/);
      assert.deepEqual(await workspace.tasks.get(queued.id), paused);
      assert.deepEqual(await runtime.start(request), [paused]);
      storyEnabled = true;
      assert.equal((await runtime.commandPlan(queued.id, 'resume')).state, 'QUEUED');
      assert.deepEqual((await workspace.tasks.get(queued.id)).snapshot, queued.snapshot);
      await runtime.stopProfile(profileId);
      assert.equal((await workspace.tasks.operations(queued.id)).length, 0);
    } finally {
      await runtime.close();
      assert.equal(await runtime.supportsFeature('story'), false);
      await kernel.close();
      bridgeStore.close();
    }
  }, false);
});

test('explicit stop interrupts an unready parent transport without forging task closure or business results', async () => {
  await postFixture(async (workspace, file) => {
    const bridgeStore = new Store(':memory:'),
      core = new Core(bridgeStore);
    const kernel = new KernelBridge(core, new WatchTasks(core));
    const profileId = randomUUID(),
      sent: unknown[] = [];
    const raw = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '123', name: 'Generated', avatar: null },
    };
    const peer = core.connect(
      profileId,
      (message) => {
        sent.push(message);
        const stop = message as { type: string; requestId: string };
        if (stop.type === 'STOP')
          queueMicrotask(async () => await core.stopped(peer, stop.requestId));
      },
      () => {},
    );
    peer.phase = 'PAUSED';
    peer.synced = false;
    const saved = await workspace.createCombination({
      name: 'Generated stop',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const [plan] = await workspace.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: [profileId],
      },
      [raw],
    );
    assert.ok(plan);
    const running = await workspace.tasks.claimNext([raw], new Set(['feed']));
    assert.ok(running);
    await workspace.tasks.requestControl(plan.id, 'pause', 'GENERATED_UNREADY');
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      workspace,
      path.dirname(file),
      () => [raw],
      { feed: () => true },
    );
    try {
      assert.equal(await runtime.canRecoverConnectionForEnding(profileId), false);
      const result = await runtime.commandPlan(plan.id, 'stop');
      assert.equal(result.state, 'STOPPING');
      assert.equal(result.controlConfirmed, false);
      assert.equal(await runtime.canRecoverConnectionForEnding(profileId), true);
      assert.equal(await runtime.canRecoverConnectionForEnding(randomUUID()), false);
      await workspace.tasks.recoverOnStartup();
      assert.equal((await workspace.tasks.get(plan.id)).state, 'STOPPED');
      assert.equal(await runtime.canRecoverConnectionForEnding(profileId), false);
      assert.deepEqual(
        sent.map((message) => (message as { type: string }).type),
        ['STOP'],
      );
      assert.equal((await workspace.tasks.operations(plan.id)).length, 0);
    } finally {
      await runtime.close();
      assert.equal(await runtime.canRecoverConnectionForEnding(profileId), false);
      await kernel.close();
      await core.shutdown();
      bridgeStore.close();
    }
  });
});

test('Marketplace capability rejects an older selected bridge before assigning any plan and preserves retry idempotency', async () => {
  await postFixture(async (workspace, file) => {
    const profileId = randomUUID();
    const raw = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: false,
      account: { state: 'unknown' as const, id: null, name: null, avatar: null },
    };
    const saved = await workspace.createCombination({
      name: '商城版本准入',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'marketplace',
          keyword: '',
          durationMinutes: 1,
          maxLikes: 0,
          minLikeCount: 0,
        },
      ],
    });
    const bridgeStore = new Store(':memory:'),
      core = new Core(bridgeStore);
    const kernel = new KernelBridge(core, new WatchTasks(core));
    const peer = { profileId, extensionVersion: '0.3.18' } as Peer;
    core.peers.set(profileId, peer);
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      workspace,
      path.dirname(file),
      () => [raw],
      { marketplace: () => true },
    );
    const request = {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: [profileId],
    };
    try {
      const before = await workspace.tasks.list();
      await assert.rejects(async () => await runtime.start(request), /商城任务需要插件0.3.19/);
      assert.deepEqual(await workspace.tasks.list(), before);
      peer.extensionVersion = '0.3.19';
      const plans = await runtime.start(request);
      assert.equal(plans.length, 1);
      assert.equal(plans[0]?.state, 'QUEUED');
      peer.extensionVersion = '0.3.18';
      assert.deepEqual(await runtime.start(request), plans);
      for (const version of ['0.3.19', '0.3.20', '0.4.0', '1.0.0'])
        assert.equal(marketplaceBridgeSupported(version), true);
      for (const version of ['0.3.9', '0.3.18', '0.2.99', 'bad', '0.3.19-extra', undefined])
        assert.equal(marketplaceBridgeSupported(version), false);
      const filtered = await workspace.createCombination({
        ...saved.saved!,
        name: '商城筛选准入',
        steps: saved.saved!.steps.map((step) => ({
          ...step,
          categoryId: '479353692612078',
          minPrice: 10,
        })),
      });
      const filteredRequest = {
        ...request,
        requestId: randomUUID(),
        combinationId: filtered.id,
        version: filtered.version,
      };
      peer.extensionVersion = '0.3.19';
      const beforeFiltered = await workspace.tasks.list();
      await assert.rejects(
        async () => await runtime.start(filteredRequest),
        /商城任务需要插件0.3.20/,
      );
      assert.deepEqual(await workspace.tasks.list(), beforeFiltered);
      assert.equal(marketplaceBridgeSupported('0.3.19', '0.3.20'), false);
      assert.equal(marketplaceBridgeSupported('0.3.20', '0.3.20'), true);
      assert.equal(marketplaceMinimumBridge(saved.saved!.steps), '0.3.19');
      assert.equal(
        marketplaceMinimumBridge(
          saved.saved!.steps.map((step) =>
            step.type === 'marketplace' ? { ...step, keyword: 'phone' } : step,
          ),
        ),
        '0.3.20',
      );
      const story = await workspace.createCombination({
        name: '快拍不能冒充普通帖子',
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: randomUUID(),
            type: 'post',
            destination: 'story',
            resourceMode: 'table',
            resourceDirectory: '',
            count: 1,
            allowRepeat: true,
            forbidSameAccountRepeat: true,
            archivePublished: false,
          },
        ],
      });
      const beforeStory = await workspace.tasks.list();
      await assert.rejects(
        async () =>
          await runtime.start({
            ...request,
            requestId: randomUUID(),
            combinationId: story.id,
            version: story.version,
            expectedResourceRevision: 1,
          }),
        /快拍/,
      );
      assert.deepEqual(await workspace.tasks.list(), beforeStory);
    } finally {
      await runtime.close();
      await kernel.close();
      bridgeStore.db.close();
    }
  });
});

test('composed publishing lifecycle stays idle before complete acceptance and preserves original reservations', async () => {
  await postFixture(async (workspace, file, catalog) => {
    const request = await postRequest(workspace, catalog);
    await workspace.materials.reserve(request);
    const snapshot = async () => ({
      plans: await workspace.tasks.list(),
      operations: await workspace.tasks.operations(request.jobId),
      reservation: await workspace.materials.reservation(request.attemptId),
    });
    const before = await snapshot();
    const bridgeStore = new Store(':memory:');
    const core = new Core(bridgeStore);
    const kernel = new KernelBridge(core, new WatchTasks(core));
    let inventoryReads = 0;
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      workspace,
      path.dirname(file),
      () => {
        inventoryReads++;
        throw Error('unexpected native admission before acceptance');
      },
    );
    try {
      assert.equal(await runtime.available(), false);
      assert.deepEqual(await runtime.tick(), []);
      assert.deepEqual(await runtime.tick(), []);
      assert.equal(inventoryReads, 0);
      assert.deepEqual(await snapshot(), before);
      const closing = runtime.close();
      assert.equal(runtime.close(), closing);
      await closing;
      assert.equal(await runtime.available(), false);
      assert.deepEqual(await runtime.tick(), []);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await runtime.close();
      await kernel.close();
      bridgeStore.db.close();
    }
  });
});

test('accepted feed stays independent of unfinished publication, launch validates whole combo and retry returns original batch', async () => {
  await postFixture(async (workspace, file, catalog) => {
    const original = await postRequest(workspace, catalog);
    await workspace.materials.reserve(original);
    const held = await structuredClone(await workspace.materials.reservation(original.attemptId));
    const originalPlan = await workspace.tasks.get(original.jobId);
    const profileId = randomUUID();
    const raw = {
      id: profileId,
      online: false,
      synced: false,
      unresolved: 0,
      dispatchAllowed: false,
      account: { state: 'unknown' as const, id: null, name: null, avatar: null },
    };
    const saved = await workspace.createCombination({
      name: '可独立浏览',
      note: '未实测',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const mixed = await workspace.createCombination({
      ...saved.saved!,
      name: '混合组合',
      steps: [
        ...saved.saved!.steps,
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const bridgeStore = new Store(':memory:'),
      core = new Core(bridgeStore),
      kernel = new KernelBridge(core, new WatchTasks(core));
    let feed = true;
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      workspace,
      path.dirname(file),
      () => [raw],
      { feed: () => feed },
    );
    try {
      assert.deepEqual(await runtime.supportedTypes(), ['feed']);
      assert.equal(await runtime.available(), true);
      assert.equal(
        (await runtime.capabilities()).combinations.find((row) => row.id === saved.id)?.enabled,
        true,
      );
      const before = await workspace.tasks.list();
      await assert.rejects(
        async () =>
          await runtime.start({
            requestId: randomUUID(),
            combinationId: mixed.id,
            version: mixed.version,
            profileIds: [profileId],
          }),
        /视频浏览/,
      );
      assert.deepEqual(await workspace.tasks.list(), before);
      const request = {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: [profileId],
      };
      const [queued] = await runtime.start(request);
      assert.equal(queued?.state, 'QUEUED');
      feed = false;
      assert.deepEqual(await runtime.start(request), [queued]);
      assert.equal(
        (await workspace.tasks.list()).filter((plan) => plan.batchId === request.requestId).length,
        1,
      );
      assert.ok(queued);
      const service = new TaskService(workspace.tasks, () => runtime);
      const target = (plan: typeof queued) => ({
        profileId: plan.profileId,
        planId: plan.id,
        expectedState: plan.state,
        expectedUpdatedAt: plan.updatedAt,
      });
      const paused = await service.command({ command: 'pause', plans: [target(queued)] });
      assert.equal(paused.results[0]?.accepted, true);
      const originalPaused = await workspace.tasks.get(queued.id);
      assert.equal(originalPaused.state, 'PAUSED');
      assert.equal(originalPaused.controlConfirmed, false); // Queued work has no native owner.
      const closedGate = await service.command({
        command: 'resume',
        plans: [target(originalPaused)],
      });
      assert.equal(closedGate.results[0]?.accepted, false);
      assert.deepEqual(await workspace.tasks.get(queued.id), originalPaused);
      feed = true;
      // Editing the saved head cannot replace this original paused version or its progress.
      const changed = await workspace.writeDraft(saved.id, saved.revision, {
        ...saved.saved!,
        name: '后续保存版本',
      });
      await workspace.publish(saved.id, changed.revision);
      const resumed = await service.command({ command: 'resume', plans: [target(originalPaused)] });
      assert.equal(resumed.results[0]?.state, 'QUEUED');
      assert.equal(resumed.results[0]?.accepted, true);
      assert.deepEqual((await workspace.tasks.get(queued.id)).snapshot, queued.snapshot);
      assert.deepEqual((await workspace.tasks.steps(queued.id))[0]?.progress, {
        revision: 0,
        effectiveMilliseconds: 0,
        likes: 0,
        published: 0,
        cursor: null,
      });
      const repeated = await service.command({
        command: 'resume',
        plans: [target(originalPaused)],
      });
      assert.equal(repeated.results[0]?.accepted, false);
      assert.equal(
        (await workspace.tasks.list()).filter((plan) => plan.batchId === request.requestId).length,
        1,
      );
      const current = await workspace.tasks.get(queued.id);
      const partial = await service.command({
        command: 'pause',
        plans: [{ ...target(originalPlan), profileId: randomUUID() }, target(current)],
      });
      assert.equal(partial.results[0]?.accepted, false);
      assert.equal(partial.results[0]?.state, null); // No cross-profile plan projection.
      assert.equal(partial.results[1]?.state, 'PAUSED');
      await assert.rejects(
        service.command({ command: 'resume', plans: [target(current), target(current)] }),
      );
      assert.deepEqual(await workspace.materials.reservation(original.attemptId), held);
      assert.deepEqual(await workspace.tasks.get(original.jobId), originalPlan);
      await runtime.stopProfile(profileId);
      assert.equal((await workspace.tasks.get(queued!.id)).state, 'STOPPED');
      assert.deepEqual(await workspace.materials.reservation(original.attemptId), held);
    } finally {
      await runtime.close();
      await kernel.close();
      bridgeStore.db.close();
    }
  });
});
