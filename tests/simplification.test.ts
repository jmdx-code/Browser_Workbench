import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Combination } from '../src/shared/contracts.js';
import { WorkspaceBackupService } from '../src/application/workspace-backup-service.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { assignSamplePlan, workspaceFixture } from './fixtures/workspace-fixture.js';

const baseCombination: Combination = {
  name: 'base',
  note: '',
  steps: [],
  randomOrder: false,
  loop: { mode: 'finite', rounds: 1 },
};
test('historical offline plan does not block backup; current runtime execution still does', async () =>
  workspaceFixture(async (store) => {
    let active = false;
    const tasks = Object.create(store.tasks) as typeof store.tasks;
    tasks.livePlans = () => {
      throw Error('must not scan historical plans');
    };
    const service = new WorkspaceBackupService(
      tasks,
      {
        write: async () => {
          throw Error('not invoked');
        },
      },
      undefined,
      () => active,
    );
    assert.equal((await service.status()).canCreate, true);
    active = true;
    assert.equal((await service.status()).canCreate, false);
  }));
test('clearing ended ordinary history deletes original rows and keeps foreign keys valid', async () =>
  workspaceFixture(async (store, file) => {
    const { plan, profile } = assignSamplePlan(store);
    const step = store.tasks.steps(plan.id)[0]!;
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    store.tasks.completeStepDirect(plan.id, step.id);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON');
    const scope = { stepIds: [step.id] };
    assert.equal(store.dataCleanup.removeBatch(scope), 1);
    for (const table of ['task_plans', 'task_steps', 'task_events', 'task_record_deletions'])
      assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n), 0, table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  }));
test('source check can exceed thirty seconds while making progress, but rejects a stalled read', async () =>
  workspaceFixture(async (store) => {
    const combo = store.createCombination({
      ...baseCombination,
      name: 'resource',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const row = {
      id: randomUUID(),
      text: 'text',
      background: 'plain' as const,
      purpose: 'both' as const,
      media: [],
    };
    store.resourceTables.save(combo.id, 0, [row]);
    let now = 0;
    const service = new ResourceTableService(
      store.resourceTables,
      {
        verify: async (_row, current) => {
          for (let i = 0; i < 5; i++) {
            now += 20_000;
            await current(1);
          }
          return { verified: false as const, issue: 'EMPTY' as const };
        },
      },
      () => now,
    );
    assert.equal(
      (await service.checkSources({ combinationId: combo.id, expectedRevision: 1 })).rows.length,
      1,
    );
    const stalled = new ResourceTableService(
      store.resourceTables,
      {
        verify: async (_row, current) => {
          now += 30_001;
          await current();
          return { verified: false as const, issue: 'EMPTY' as const };
        },
      },
      () => now,
    );
    await assert.rejects(stalled.checkSources({ combinationId: combo.id, expectedRevision: 1 }));
  }));
