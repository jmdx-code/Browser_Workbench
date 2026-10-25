import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeReviewService } from '../src/application/native-review.js';
import { KernelNativeReview } from '../src/infrastructure/kernel-native-review.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Core } from '../src/bridge/core.js';
import type { TaskRepository } from '../src/domain/tasks.js';
import type { KernelState } from '../src/shared/kernel-state.js';

for (const associated of [false, true])
  test(`retained main permits orphan control ending but never an original task (associated=${associated})`, async () => {
    const profileId = randomUUID(),
      epoch = randomUUID();
    const proof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: epoch,
      tabId: 7,
      targetId: 'main',
    };
    const binding = {
      profileId,
      accountId: '123456789',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: 'a'.repeat(64),
    };
    const inventory: KernelState = {
      version: 1,
      profileId,
      browserSessionEpoch: epoch,
      workspaceMain: proof,
      tabs: [
        {
          ownershipId: proof.ownershipId,
          url: 'https://www.facebook.com/',
          state: 'READY',
          proof,
          reason: '',
        },
      ],
      operations: [{ binding, state: 'UNKNOWN', reason: 'OLD_UNCONFIRMED', resolution: null }],
    };
    let endings = 0,
      withdrawals = 0;
    const peer = {
      profileId,
      online: true,
      synced: true,
      phase: 'PAUSED',
      capabilities: ['kernel-journal-v1', 'kernel-idle-tab-end-v1'],
    };
    const kernel = {
      withSummary: async (_: unknown, fn: Function) => {
        let ended = false;
        return fn({
          inventory: async () => {
            if (ended) throw Error('KERNEL_FENCED');
            return structuredClone(inventory);
          },
          notify: async (_: unknown, value: KernelState['operations'][number]['disposition']) => {
            endings++;
            ended = true;
            const original = inventory.operations[0];
            if (!original) throw Error('FIXTURE_OPERATION_REQUIRED');
            original.disposition = value;
          },
          stopCurrent: async () => {
            withdrawals++;
          },
        });
      },
    } as unknown as KernelBridge;
    const core = { peers: new Map([[profileId, peer]]) } as unknown as Core;
    const tasks = {
      hasProfilePlanInStates: () => false,
      retainedTaskPage: () => proof,
      hasPlanOrOperation: () => associated,
    } as unknown as TaskRepository;
    const adapter = new KernelNativeReview(kernel, core),
      service = new NativeReviewService(adapter, tasks);
    if (associated) {
      await assert.rejects(service.releaseIdle({ profileId }), /请从原任务记录结束/);
      assert.equal(endings, 0);
    } else {
      assert.deepEqual(await service.releaseIdle({ profileId }), {
        released: 0,
        endedOperations: 1,
      });
      assert.equal(endings, 1);
      assert.equal(inventory.operations[0]?.state, 'UNKNOWN');
      assert.equal(inventory.tabs[0]?.state, 'READY');
    }
    assert.equal(withdrawals, 0);
  });
