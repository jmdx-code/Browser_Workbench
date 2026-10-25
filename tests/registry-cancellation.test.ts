import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProfileActorRegistry } from '../src/application/profile-actor-registry.js';
import type { ManagedProfileSession } from '../src/domain/profile-actor.js';
import type { ExecutionSession } from '../src/shared/task-execution.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';

test('SDK cancellation error during user stop and after owner release cannot demote stop to pause or touch a replacement', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store);
    const context: ExecutionSession = {
      profileId: f.binding.profileId,
      accountId: f.binding.accountId,
      connectionEpoch: f.binding.connectionEpoch,
      leaseId: f.binding.leaseId,
      generation: 0,
    };
    const registry = new ProfileActorRegistry(
      () => [f.profile],
      store.tasks,
      store.tasks.settlements,
      store.taskControls,
      store.taskTabs,
      randomUUID,
    );
    let cancellation: ((reason: string) => Promise<void>) | undefined;
    const port: ManagedProfileSession = {
      profileId: f.profile.id,
      profile: () => f.profile,
      current: () => context,
      inventory: async () => {
        throw Error('NOT_OBSERVED');
      },
      notify: async (binding, resolution) => ({ binding, resolution }),
      sendGuarded: async () => {
        throw Error('NOT_SENT');
      },
      setFailureHandler: (handler) => {
        cancellation = handler;
      },
      stop: async (binding) => {
        assert.ok(cancellation);
        await cancellation('SDK_CANCELED_BY_USER_STOP');
        return { ...binding, state: 'stopped' };
      },
    };
    await registry.attach(port);
    const plan = await registry.control(f.plan.id, 'stop');
    assert.equal(plan.controlMode, 'stop');
    assert.equal(plan.state, 'REVIEW');
    assert.equal(plan.controlConfirmed, true);
    assert.ok(cancellation);
    const oldCallback = cancellation;
    await oldCallback('LATE_CANCELLATION_AFTER_RELEASE');
    assert.equal((await store.tasks.get(plan.id)).controlMode, 'stop');
    await registry.attach({ ...port, current: () => ({ ...context, leaseId: randomUUID() }) });
    await oldCallback('LATE_CANCELLATION_AFTER_REPLACEMENT');
    assert.equal((await registry.status()).length, 1);
    assert.equal((await registry.status())[0]?.lifecycle, 'ATTACHED');
    assert.equal((await store.taskControls.list()).length, 1);
  });
});
