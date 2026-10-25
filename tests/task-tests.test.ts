import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { settlementFixture } from './fixtures/settlement.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { TaskService, type TaskExecutionPort } from '../src/application/task-service.js';
import { TaskTestService } from '../src/application/task-test-service.js';
import { ProfileSchema, type Profile } from '../src/shared/contracts.js';
import { TaskTestRequest } from '../src/shared/task-tests.js';

test('single-task testing keeps exact browser selection and original batch identity across reply loss, rejects offline profiles and does not start newly online ones on retry', async () =>
  settlementFixture(async (store) => {
    const profiles: Profile[] = [true, false].map((online) =>
      ProfileSchema.parse({
        id: randomUUID(),
        alias: '生成资料',
        groupId: null,
        online,
        synced: online,
        phase: online ? 'PAUSED' : 'OFFLINE',
        unresolved: 0,
        extensionVersion: '0.3.21',
        capabilities: [],
        account: { state: 'unknown', id: null, name: null, avatar: null },
      }),
    );
    const workspace = new WorkspaceService(store, {
      profiles: () => profiles,
      records: () => [],
      stop: () => {},
    });
    const port: TaskExecutionPort = {
      available: () => true,
      capabilities: () => ({ types: ['feed', 'video', 'marketplace'], combinations: [] }),
      start: async (input) =>
        await store.tasks.assign(
          input,
          profiles.map((p) => ({ ...p, dispatchAllowed: false })),
        ),
      stopProfile: async () => {},
      commandPlan: async () => {
        throw Error('NOT_USED');
      },
    };
    const tests = new TaskTestService(workspace, new TaskService(store.tasks, () => port));
    const firstProfile = profiles[0],
      secondProfile = profiles[1];
    assert.ok(firstProfile && secondProfile);
    const request = {
      requestId: randomUUID(),
      profileIds: profiles.map((p) => p.id),
      module: 'feed',
      durationMinutes: 1,
    };
    const result = await tests.start(request);
    assert.equal(result.plans.length, 1);
    assert.equal(result.plans[0]?.profileId, firstProfile.id);
    assert.equal(result.rejected[0]?.profileId, secondProfile.id);
    assert.equal(result.plans[0]?.snapshot.steps[0]?.type, 'feed');
    assert.equal((await store.tasks.operations(result.plans[0]!.id)).length, 0);
    secondProfile.online = true;
    secondProfile.synced = true;
    const retried = await tests.start(request);
    assert.deepEqual(
      retried.plans.map((p) => p.id),
      result.plans.map((p) => p.id),
    );
    assert.equal((await store.tasks.list()).length, 1);
    secondProfile.extensionVersion = '0.3.20';
    const oldBridge = await tests.start({ ...request, requestId: randomUUID() });
    assert.equal(oldBridge.plans.length, 0);
    assert.ok(
      oldBridge.rejected.some(
        (row) => row.profileId === secondProfile.id && row.reason.includes('0.3.21'),
      ),
    );
    secondProfile.extensionVersion = '0.3.21';
    await assert.rejects(tests.start({ ...request, durationMinutes: 2 }), /不能改动参数/);
    const partial = await tests.start({ ...request, requestId: randomUUID() });
    assert.equal(partial.plans.length, 1);
    assert.equal(partial.plans[0]?.profileId, secondProfile.id);
    assert.equal(partial.rejected[0]?.profileId, firstProfile.id);
    assert.equal((await store.combinations()).length, 2);
  }));
test('unloaded or unsupported modules and invalid settings cannot create a combination or a browser operation', async () =>
  settlementFixture(async (store) => {
    const profile = ProfileSchema.parse({
      id: randomUUID(),
      alias: '生成',
      groupId: null,
      online: true,
      synced: true,
      phase: 'PAUSED',
      unresolved: 0,
      extensionVersion: '0.3.21',
      capabilities: [],
      account: { state: 'unknown', id: null, name: null, avatar: null },
    });
    const workspace = new WorkspaceService(store, {
      profiles: () => [profile],
      records: () => [],
      stop: () => {},
    });
    const tests = new TaskTestService(workspace, new TaskService(store.tasks));
    const request = {
      requestId: randomUUID(),
      profileIds: [profile.id],
      module: 'feed',
      durationMinutes: 1,
    };
    await assert.rejects(tests.start(request), /尚未加载/);
    assert.equal((await store.combinations()).length, 0);
    assert.equal((await store.tasks.list()).length, 0);
    assert.equal(TaskTestRequest.safeParse({ ...request, module: 'post' }).success, false);
    assert.equal(
      TaskTestRequest.safeParse({
        ...request,
        module: 'marketplace',
        minPrice: 20,
        maxPrice: 10,
        keyword: 'bike',
      }).success,
      false,
    );
    assert.equal(TaskTestRequest.safeParse({ ...request, keyword: 'bike' }).success, false);
  }));
