import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskTiming } from '../src/shared/task-timing.js';
import { taskTimingEligibility } from '../src/domain/task-timing.js';
import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import { settlementFixture } from './fixtures/settlement.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';

test('daily windows use configured timezone and start-day weekdays for overnight work; missed one-time jobs never catch up', () => {
  const window = TaskTiming.parse({
    mode: 'window',
    startTime: '22:00',
    endTime: '02:00',
    timeZone: 'Asia/Taipei',
    weekdays: [7],
  });
  assert.equal(taskTimingEligibility(window, Date.parse('2026-10-11T15:00:00Z')), 'OPEN');
  assert.equal(taskTimingEligibility(window, Date.parse('2026-10-11T17:00:00Z')), 'OPEN');
  assert.equal(taskTimingEligibility(window, Date.parse('2026-10-11T18:00:00Z')), 'WAIT');
  assert.equal(taskTimingEligibility(window, Date.parse('2026-10-12T15:00:00Z')), 'WAIT');
  const once = TaskTiming.parse({ mode: 'at', startAt: 100000, timeZone: 'UTC' });
  assert.equal(taskTimingEligibility(once, 99000), 'WAIT');
  assert.equal(taskTimingEligibility(once, 160001), 'MISSED');
  assert.equal(taskTimingEligibility(once, 160001, true), 'OPEN');
  assert.throws(() => TaskTiming.parse({ ...window, weekdays: [] }));
  assert.throws(() => TaskTiming.parse({ ...window, startTime: '24:99' }));
});
test('50 scheduled plans pin original combination, release once as a batch and continue concurrency queueing after the startup grace', async () =>
  settlementFixture(async (store, file) => {
    const db = new DatabaseSync(file);
    let now = 10000;
    const tasks = new SqliteTaskRepository(db, {
      id: randomUUID,
      now: () => now,
      random: () => 0.5,
    });
    try {
      const row = await store.createCombination({
        name: '生成定时批量',
        note: '无浏览器输入',
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const profiles: RuntimeProfile[] = Array.from({ length: 50 }, (_, i) => ({
        id: randomUUID(),
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: 'generated-' + i, name: null, avatar: null },
      }));
      const request = {
        requestId: randomUUID(),
        combinationId: row.id,
        version: 1,
        profileIds: profiles.map((p) => p.id),
        timing: { mode: 'at' as const, startAt: 20000, timeZone: 'UTC' },
      };
      const plans = tasks.assign(request, profiles);
      assert.equal(plans.length, 50);
      tasks.setSettings({ maxConcurrentProfiles: 1 });
      assert.equal(tasks.claimNext(profiles, new Set(['feed'])), null);
      assert.ok(tasks.list().every((plan) => plan.state === 'QUEUED' && !plan.timingReleased));
      const edited = await store.writeDraft(row.id, row.revision, {
        ...row.saved!,
        name: '后来编辑的组合',
      });
      await store.publish(row.id, edited.revision);
      now = 20000;
      tasks.releaseScheduled();
      tasks.releaseScheduled();
      assert.equal(
        Number(
          db.prepare("SELECT count(*) AS n FROM task_events WHERE type='SCHEDULE_RELEASED'").get()
            ?.n,
        ),
        1,
      );
      const first = tasks.claimNext(profiles, new Set(['feed']));
      assert.ok(first);
      assert.equal(first.snapshot.name, '生成定时批量');
      now = 100000;
      assert.equal(tasks.claimNext(profiles, new Set(['feed'])), null);
      tasks.setSettings({ maxConcurrentProfiles: 2 });
      const second = tasks.claimNext(profiles, new Set(['feed']));
      assert.ok(second);
      assert.equal(second.snapshot.name, '生成定时批量');
      assert.ok(tasks.list().every((plan) => plan.state !== 'FAILED'));
      assert.deepEqual(
        tasks.assign(request, profiles).map((p) => p.id),
        plans.map((p) => p.id),
      );
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      db.close();
    }
  }));
test('restart retains future unstarted schedules but pauses released work and missed time; no original operation is replayed', async () =>
  settlementFixture(async (store, file) => {
    const db = new DatabaseSync(file);
    let now = 10000;
    const tasks = new SqliteTaskRepository(db, {
      id: randomUUID,
      now: () => now,
      random: () => 0.5,
    });
    try {
      const row = await store.createCombination({
        name: '生成定时恢复',
        note: '',
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const profile: RuntimeProfile = {
        id: randomUUID(),
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: 'generated-schedule', name: null, avatar: null },
      };
      const [plan] = tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: row.id,
          version: 1,
          profileIds: [profile.id],
          timing: { mode: 'at', startAt: 20000, timeZone: 'UTC' },
        },
        [profile],
      );
      assert.ok(plan);
      tasks.recoverOnStartup();
      assert.equal(tasks.get(plan.id).state, 'QUEUED');
      now = 20000;
      tasks.releaseScheduled();
      tasks.recoverOnStartup();
      assert.equal(tasks.get(plan.id).state, 'PAUSED');
      assert.equal(tasks.operations(plan.id).length, 0);
      assert.equal(tasks.claimNext([profile], new Set(['feed'])), null);
      const restoredProfile = {
        ...profile,
        id: randomUUID(),
        account: { ...profile.account, id: 'generated-restored' },
      };
      const [restored] = tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: row.id,
          version: 1,
          profileIds: [restoredProfile.id],
          timing: { mode: 'at', startAt: 300000, timeZone: 'UTC' },
        },
        [restoredProfile],
      );
      assert.ok(restored);
      tasks.recoverOnStartup(false);
      assert.equal(tasks.get(restored.id).state, 'PAUSED');
      assert.equal(tasks.operations(restored.id).length, 0);
      const missedProfile = {
        ...profile,
        id: randomUUID(),
        account: { ...profile.account, id: 'generated-missed' },
      };
      const [missed] = tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: row.id,
          version: 1,
          profileIds: [missedProfile.id],
          timing: { mode: 'at', startAt: 40000, timeZone: 'UTC' },
        },
        [missedProfile],
      );
      assert.ok(missed);
      now = 100001;
      tasks.releaseScheduled();
      assert.equal(tasks.get(missed.id).state, 'FAILED');
      assert.equal(tasks.get(missed.id).reason, 'SCHEDULE_MISSED');
      assert.equal(tasks.operations(missed.id).length, 0);
    } finally {
      db.close();
    }
  }));
