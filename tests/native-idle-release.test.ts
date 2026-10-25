import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeReviewService } from '../src/application/native-review.js';
import { KernelNativeReview } from '../src/infrastructure/kernel-native-review.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';
import { settlementFixture } from './fixtures/settlement.js';

test('idle release withdraws exact native ownership after current STOP and preserves old records; a waiting plan blocks release', async () =>
  settlementFixture(async (store) => {
    const legacy = new Store(':memory:');
    const core = new Core(legacy);
    const profileId = randomUUID();
    const peer = core.connect(
      profileId,
      () => {},
      () => {},
    );
    peer.online = true;
    peer.synced = true;
    peer.phase = 'PAUSED';
    peer.capabilities = ['kernel-journal-v1'];
    const proof: TabProof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: randomUUID(),
      tabId: 11,
      targetId: 'OWNED',
    };
    const inventory: KernelState = {
      version: 1,
      profileId,
      browserSessionEpoch: proof.browserSessionEpoch,
      operations: [],
      tabs: [
        {
          ownershipId: proof.ownershipId,
          proof,
          state: 'READY',
          url: 'https://www.facebook.com/',
          reason: 'old read',
        },
      ],
    };
    const stops: TabProof[][] = [];
    const kernel = {
      withSummary: async <T>(_peer: unknown, work: Parameters<KernelBridge['withSummary']>[1]) => {
        let stopped = false;
        return work({
          profileId,
          inventory: async () => {
            if (stopped) throw Error('KERNEL_FENCED');
            return structuredClone(inventory);
          },
          stopCurrent: async (requestId: string, proofs: readonly TabProof[] = []) => {
            stopped = true;
            stops.push([...proofs]);
            for (const row of inventory.tabs)
              if (proofs.some((p) => p.ownershipId === row.ownershipId)) row.state = 'LOST';
            return { profileId, connectionEpoch: peer.epoch, requestId, state: 'stopped' as const };
          },
          notify: async () => {
            throw Error('NO_NOTIFICATION');
          },
        }) as Promise<T>;
      },
    } as unknown as KernelBridge;
    try {
      const service = new NativeReviewService(new KernelNativeReview(kernel, core), store.tasks);
      assert.deepEqual(await service.releaseIdle({ profileId }), {
        released: 1,
        endedOperations: 0,
      });
      assert.deepEqual(stops, [[proof]]);
      assert.equal(inventory.tabs[0]?.state, 'LOST');
      assert.equal(inventory.tabs[0]?.reason, 'old read');
      assert.equal(inventory.operations.length, 0);
      assert.equal((await store.tasks.list()).length, 0);
      assert.deepEqual(await service.releaseIdle({ profileId }), {
        released: 0,
        endedOperations: 0,
      });
      assert.equal(stops.length, 1);
      inventory.operations.push({
        binding: {
          profileId,
          accountId: 'generated-account',
          connectionEpoch: peer.epoch,
          leaseId: randomUUID(),
          generation: 1,
          jobId: randomUUID(),
          stepId: randomUUID(),
          operationId: randomUUID(),
          actionDigest: 'a'.repeat(64),
        },
        state: 'UNKNOWN',
        resolution: null,
        reason: 'generated unresolved input',
      });
      const pending = structuredClone(inventory.operations);
      await assert.rejects(
        new KernelNativeReview(kernel, core).releaseIdle(profileId, () => {}),
        /仍有原操作待处理/,
      );
      assert.deepEqual(inventory.operations, pending);
      assert.equal(stops.length, 1);
      inventory.operations = [];
      const combo = await store.createCombination({
        name: '生成占用保护',
        note: '',
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      await store.tasks.assign(
        { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
        [
          {
            id: profileId,
            online: true,
            synced: true,
            unresolved: 0,
            dispatchAllowed: false,
            account: { state: 'unknown', id: null, name: null, avatar: null },
          },
        ],
      );
      await assert.rejects(service.releaseIdle({ profileId }), /请先停止/);
      assert.equal(stops.length, 1);
    } finally {
      await core.shutdown();
      legacy.close();
    }
  }));
