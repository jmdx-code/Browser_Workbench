import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskService } from '../src/application/task-service.js';
import {
  FeatureEvidenceMap,
  TaskFeatureOverview,
  TaskFeatureOverviewV2,
} from '../src/shared/task-features.js';
import { settlementFixture } from './fixtures/settlement.js';

test('feature evidence is independent from execution gates and old clients retain the strict original contract', async () => {
  const evidence = FeatureEvidenceMap.parse({
    feed: { implementation: 'partial', verification: 'failed', reason: 'isolated failure fixture' },
    video: {
      implementation: 'partial',
      verification: 'limited',
      reason: 'isolated limited fixture',
    },
    marketplace: {
      implementation: 'partial',
      verification: 'limited',
      reason: 'isolated limited fixture',
    },
    post: {
      implementation: 'partial',
      verification: 'pending',
      reason: 'isolated pending fixture',
    },
    story: {
      implementation: 'partial',
      verification: 'pending',
      reason: 'isolated pending fixture',
    },
  });
  await settlementFixture(async (store) => {
    const service = new TaskService(
      store.tasks,
      () => ({
        available: () => true,
        capabilities: () => ({ types: ['feed', 'video', 'marketplace'], combinations: [] }),
        start: () => [],
        stopProfile: async () => {},
        commandPlan: async () => {
          throw Error('NOT_USED');
        },
      }),
      () => {},
      () => evidence,
    );
    const legacy = TaskFeatureOverview.parse(await service.features());
    assert.equal(Object.hasOwn(legacy.features[0] ?? {}, 'verification'), false);
    const current = TaskFeatureOverviewV2.parse(await service.features('2'));
    assert.equal(current.features.find((f) => f.id === 'feed')?.enabled, true);
    assert.equal(current.features.find((f) => f.id === 'feed')?.verification, 'failed');
    assert.equal(current.features.find((f) => f.id === 'post')?.enabled, false);
    assert.equal(current.features.find((f) => f.id === 'story')?.verification, 'pending');
  });
});
