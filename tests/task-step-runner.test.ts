import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStepRunner } from '../src/application/task-step-runner.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { Intent } from '../src/shared/browse-execution.js';
import { BrowseReadTimeout, BrowsePendingDiagnostic } from '../src/shared/browse-execution.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Action } from '../src/shared/browser-actions.js';
import { settlementFixture } from './fixtures/settlement.js';
import { browseHarness } from './fixtures/browse.js';
import { dropMaterialSchema } from './fixtures/material-schema.js';

function action(
  proof: Intent['proof'],
  count = 500,
  contentId = 'mock-like-content',
): { kind: 'action'; action: Action; intent: Extract<Intent, { kind: 'like' }> } {
  return {
    kind: 'action',
    action: {
      kind: 'click',
      tabId: proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '#mock-like' },
    },
    intent: {
      kind: 'like',
      proof,
      documentEpoch: 0,
      routeEpoch: 0,
      contentId,
      observedLikeCount: count,
      observedLiked: false,
    },
  };
}
function latch() {
  let done: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolve) => {
      done = resolve;
    }),
    release: () => {
      assert.ok(done);
      done();
    },
  };
}

test('feed credits the observed interval before input, excludes dispatch time, and resumes from independent verification without stale checkpoint guards', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: 'pre-action timing',
      note: 'isolated',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const plan = await h.claim();
    const executor = h.executors.find((e) => e.type === 'feed')!;
    const originalDecide = executor.decide;
    await h.runner.advance(plan.id);
    executor.decide = async (e, guard) => {
      await guard();
      const observation = h.sample(e);
      return {
        kind: 'action',
        observation,
        action: {
          kind: 'browseScroll',
          tabId: observation.proof.tabId,
          documentEpoch: 0,
          routeEpoch: 0,
          url: 'https://www.facebook.com/',
          timeOrigin: 1,
          fromY: 0,
          deltaY: 500,
        },
        intent: {
          kind: 'auxiliary',
          purpose: 'advance',
          proof: observation.proof,
          documentEpoch: 0,
          routeEpoch: 0,
        },
      };
    };
    h.clock.at = 1000;
    assert.equal((await h.runner.advance(plan.id)).status, 'DISPATCHED');
    assert.equal(store.tasks.steps(plan.id)[0]!.progress.effectiveMilliseconds, 1000);
    const originalVerify = executor.verify;
    executor.verify = async (e, op, intent, guard) => {
      const result = await originalVerify(e, op, intent, guard);
      return result.outcome === 'VERIFIED' ? { ...result, observation: h.sample(e) } : result;
    };
    h.clock.at = 4000;
    const verified = await h.runner.advance(plan.id);
    assert.equal(verified.status, 'VERIFIED', JSON.stringify(verified));
    assert.equal(store.tasks.steps(plan.id)[0]!.progress.effectiveMilliseconds, 1000);
    executor.decide = originalDecide;
    h.clock.at = 5000;
    await h.runner.advance(plan.id);
    assert.equal(store.tasks.steps(plan.id)[0]!.progress.effectiveMilliseconds, 2000);
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');
    await h.host.control(plan.id, 'stop', 'USER_STOP');
    h.clock.at = 6000;
    await h.runner.advance(plan.id);
    assert.equal(store.tasks.steps(plan.id)[0]!.progress.effectiveMilliseconds, 2000);
  });
});

test('window closure settles an original dispatched action but prevents a late decision from dispatching or crediting new work', async (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, undefined, undefined, {
      mode: 'window',
      startTime: '11:00',
      endTime: '13:00',
      timeZone: 'UTC',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    });
    const plan = await h.claim(),
      proof = h.proofs.get(plan.profileId),
      executor = h.executors[0];
    assert.ok(proof && executor);
    executor.decide = async () => action(proof);
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'ACKNOWLEDGED');
    now = Date.parse('2026-10-15T14:00:00Z');
    assert.equal((await h.runner.advance(plan.id)).status, 'VERIFIED');
    const progress = (await store.tasks.steps(plan.id))[0]?.progress;
    assert.equal((await h.runner.advance(plan.id)).reason, 'SCHEDULE_WINDOW_CLOSED');
    assert.equal(h.inputs.get(plan.profileId), 1);
    assert.deepEqual((await store.tasks.steps(plan.id))[0]?.progress, progress);
    now = Date.parse('2026-10-16T12:00:00Z');
    const entered = latch(),
      release = latch();
    executor.decide = async () => {
      entered.release();
      await release.promise;
      return action(proof, 500, 'another-generated-action');
    };
    const pending = h.runner.advance(plan.id);
    await entered.promise;
    assert.equal(await h.runner.isAdvancing(plan.id), true);
    now = Date.parse('2026-10-16T14:00:00Z');
    release.release();
    assert.equal((await pending).reason, 'SCHEDULE_WINDOW_CLOSED');
    assert.equal(h.inputs.get(plan.profileId), 1);
    assert.equal((await store.tasks.operations(plan.id)).length, 1);
    assert.deepEqual((await store.tasks.steps(plan.id))[0]?.progress, progress);
    await h.runner.close();
    await h.registry.close();
  });
});

test('admission document timeout pauses only that plan and does not repeat reads until explicit resume', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 2);
    const [failed, other] = h.assigned;
    assert.ok(failed && other);
    const observe = h.host.observe.bind(h.host);
    let reads = 0;
    h.host.observe = async (profileId) => {
      if (profileId === failed.profileId) {
        reads++;
        throw Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT');
      }
      await observe(profileId);
    };
    const result = await h.runner.tick();
    assert.equal(result.find((row) => row.jobId === failed.id)?.status, 'ADMISSION_PAUSED');
    assert.equal((await store.tasks.get(failed.id)).state, 'PAUSED');
    assert.equal((await store.tasks.get(failed.id)).reason, 'FACEBOOK_TASK_DOCUMENT_TIMEOUT');
    assert.equal((await store.tasks.get(failed.id)).controlConfirmed, false);
    assert.equal((await store.tasks.operations(failed.id)).length, 0);
    assert.equal((await store.tasks.steps(failed.id))[0]?.progress.effectiveMilliseconds, 0);
    assert.equal((await store.tasks.get(other.id)).state, 'RUNNING');
    await h.runner.tick();
    await h.runner.tick();
    assert.equal(reads, 1);
    await store.tasks.resume(failed.id);
    await h.runner.tick();
    assert.equal(reads, 2);
  });
});

test('identity, plugin and window admission failures pause until explicit resume, without blocking other profiles', async () => {
  for (const reason of [
    'FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED',
    'FACEBOOK_CURRENT_CREATOR_UNCONFIRMED',
    'FACEBOOK_CURRENT_NATIVE_BOOTSTRAP_REQUIRED',
    'FACEBOOK_TASK_EXTENSION_UPDATE_REQUIRED',
    'WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED',
    'WINDOW_LAYOUT_DISPLAY_MISSING',
    'WINDOW_LAYOUT_MOVE_UNCONFIRMED:{"observed":{}}',
  ]) {
    await settlementFixture(async (store) => {
      const h = await browseHarness(store, 2);
      const failed = h.assigned[0],
        other = h.assigned[1];
      assert.ok(failed && other);
      let reads = 0;
      const observe = h.host.observe.bind(h.host);
      h.host.observe = async (profileId) => {
        if (profileId === failed.profileId) {
          reads++;
          throw Error(reason);
        }
        await observe(profileId);
      };
      await h.runner.tick();
      await h.runner.tick();
      assert.equal((await store.tasks.get(failed.id)).state, 'PAUSED');
      assert.equal((await store.tasks.get(failed.id)).reason, reason);
      assert.equal((await store.tasks.get(other.id)).state, 'RUNNING');
      assert.equal(reads, 1);
      assert.equal((await store.tasks.operations(failed.id)).length, 0);
      await store.tasks.resume(failed.id);
      await h.runner.tick();
      assert.equal(reads, 2);
    });
  }
});

test('capacity wait stays queued and a late admission error does not overwrite user stop', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 2);
    const [waiting, stopped] = h.assigned;
    assert.ok(waiting && stopped);
    h.host.observe = async (profileId) => {
      if (profileId === waiting.profileId) throw Error('CONCURRENCY_LIMIT');
      await store.tasks.requestControl(stopped.id, 'stop', 'USER_STOP');
      throw Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT');
    };
    await h.runner.tick();
    assert.equal((await store.tasks.get(waiting.id)).state, 'QUEUED');
    assert.equal((await store.tasks.get(waiting.id)).reason, 'CONCURRENCY_LIMIT');
    assert.equal((await store.tasks.get(stopped.id)).state, 'STOPPED');
    assert.equal((await store.tasks.get(stopped.id)).reason, 'USER_STOP');
    assert.equal((await store.tasks.operations(waiting.id)).length, 0);
    assert.equal((await store.tasks.operations(stopped.id)).length, 0);
  });
});

test('15 minute video is accumulated by valid intervals, caps at the target and completes only on the next guarded cycle', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: '15分钟模拟计时',
      note: '不是FB',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 15, maxLikes: 2, minLikeCount: 500 },
      ],
    });
    const plan = await h.claim();
    await h.runner.advance(plan.id);
    for (let seconds = 1; seconds <= 900; seconds++) {
      h.clock.at = seconds * 1000;
      await h.runner.advance(plan.id);
    }
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 900000);
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 0);
    assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'COMPLETED');
    assert.equal((await h.registry.status()).length, 0);
  });
});

test('repeated feed steps and finite rounds keep independent time and terminate after exactly the saved rounds', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: '独立步骤两轮',
      note: '模拟',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 2 },
      steps: [
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 200 },
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const plan = await h.claim();
    for (
      let cycles = 0;
      cycles < 250 && (await store.tasks.get(plan.id)).state === 'RUNNING';
      cycles++
    ) {
      h.clock.at += 1000;
      await h.runner.advance(plan.id);
    }
    assert.equal((await store.tasks.get(plan.id)).state, 'COMPLETED');
    assert.equal((await store.tasks.get(plan.id)).round, 2);
    const steps = [
      ...(await store.tasks.steps(plan.id, 1)),
      ...(await store.tasks.steps(plan.id, 2)),
    ];
    assert.equal(new Set(steps.map((s) => s.id)).size, 4);
    assert.ok(
      steps.every(
        (s) =>
          s.status === 'COMPLETED' &&
          s.progress.effectiveMilliseconds === 60000 &&
          s.progress.likes === 0,
      ),
    );
  });
});

test('until-stopped creates only the next round, while user stop terminates the loop without a third round', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: '直到停止',
      note: '模拟',
      randomOrder: true,
      loop: { mode: 'until-stopped' },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const plan = await h.claim();
    for (let i = 0; i < 62; i++) {
      h.clock.at += 1000;
      await h.runner.advance(plan.id);
    }
    assert.equal((await store.tasks.get(plan.id)).round, 2);
    assert.equal((await store.tasks.steps(plan.id, 3)).length, 0);
    await h.registry.control(plan.id, 'stop');
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'STOPPED');
    assert.equal((await store.tasks.steps(plan.id, 3)).length, 0);
  });
});

test('a missing post executor blocks the whole four-step combination, including an already running plan', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: '完整组合不可跳过',
      note: '模拟',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 15, maxLikes: 2, minLikeCount: 500 },
        { id: randomUUID(), type: 'feed', durationMinutes: 4, maxLikes: 1, minLikeCount: 200 },
        {
          id: randomUUID(),
          type: 'post',
          resourceDirectory: 'X:/fixture-unavailable',
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: true,
          count: 1,
        },
        { id: randomUUID(), type: 'feed', durationMinutes: 8, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const results = await h.runner.tick();
    assert.equal(results[0]?.reason, 'EXECUTOR_REQUIRED');
    assert.equal((await store.tasks.list())[0]?.state, 'QUEUED');
    const plan = await store.tasks.claimNext(
      await h.host.schedulingProfiles(),
      new Set(['video', 'feed', 'post']),
    );
    assert.ok(plan);
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
    assert.equal((await store.tasks.operations(plan.id)).length, 0);
  });
});

test('ACK holds time/counts until separate matching like verification and notification permits the next step action', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      proof = h.proofs.get(plan.profileId);
    assert.ok(proof);
    const executor = h.executors[0];
    assert.ok(executor);
    executor.decide = async () => action(proof);
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'ACKNOWLEDGED');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 0);
    assert.equal(
      (await store.browseIntents.get(String((await store.tasks.operations(plan.id))[0]?.id))).intent
        .kind,
      'like',
    );
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 1);
    assert.equal((await store.tasks.settlements.list())[0]?.state, 'PENDING');
    executor.decide = async () => ({ kind: 'wait', reason: 'NO_OTHER_ELIGIBLE_CONTENT' });
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.settlements.list())[0]?.state, 'DELIVERED');
    assert.equal(h.inputs.get(plan.profileId), 1);
  });
});

test('low popularity, zero-like budget and changed intent cannot reach browser input', async () => {
  for (const count of [499, 500]) {
    await settlementFixture(async (store) => {
      const h = await browseHarness(store, 1, {
        name: '点赞条件',
        note: '模拟',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: randomUUID(),
            type: 'video',
            durationMinutes: 1,
            maxLikes: count === 500 ? 0 : 2,
            minLikeCount: 500,
          },
        ],
      });
      const plan = await h.claim(),
        proof = h.proofs.get(plan.profileId);
      assert.ok(proof);
      const executor = h.executors[0];
      assert.ok(executor);
      executor.decide = async () => action(proof, count);
      await h.runner.advance(plan.id);
      assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
      assert.equal((await store.tasks.operations(plan.id)).length, 0);
      assert.equal(h.inputs.get(plan.profileId) ?? 0, 0);
    });
  }
});

test('unknown or mismatched business result preserves account lock and never increases likes or retries input', async () => {
  for (const unknown of [true, false]) {
    await settlementFixture(async (store, file) => {
      const h = await browseHarness(store),
        plan = await h.claim(),
        proof = h.proofs.get(plan.profileId);
      assert.ok(proof);
      const executor = h.executors[0];
      assert.ok(executor);
      executor.decide = async () => action(proof);
      executor.verify = async (_e, op) =>
        unknown
          ? {
              outcome: 'UNKNOWN',
              receipt: { binding: op.binding, evidence: {} },
              reason: 'TARGET_UNREADABLE',
            }
          : {
              outcome: 'VERIFIED',
              receipt: { binding: op.binding, evidence: {} },
              effect: { kind: 'liked', contentId: 'different-content', observedLiked: true },
            };
      await h.runner.advance(plan.id);
      await h.runner.advance(plan.id);
      await h.runner.tick();
      assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
      assert.equal((await store.tasks.get(plan.id)).state, 'REVIEW');
      assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 0);
      assert.equal(h.inputs.get(plan.profileId), 1);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(
          db.prepare('SELECT count(*) AS count FROM task_account_locks').get()?.count,
          1,
        );
      } finally {
        db.close();
      }
    });
  }
});

test('acknowledged activation waits at most thirty seconds without resending; recovery verifies original action and expiry preserves UNKNOWN', async () => {
  for (const resume of ['verified', 'pending', 'malformed', 'timeout']) {
    await settlementFixture(async (store, file) => {
      const h = await browseHarness(store, 1, {
        name: 'Foreground wait fixture',
        note: 'Generated',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      const plan = await h.claim(),
        proof = h.proofs.get(plan.profileId);
      const executor = h.executors.find((value) => value.type === 'feed');
      assert.ok(proof && executor);
      executor.decide = async () => ({
        kind: 'action',
        action: { kind: 'activateTab', tabId: proof.tabId },
        intent: { kind: 'auxiliary', purpose: 'activate', proof, documentEpoch: 0, routeEpoch: 0 },
      });
      const diagnostic = BrowsePendingDiagnostic.parse({
        version: 1,
        independent: true,
        url: 'https://www.facebook.com/',
        timeOrigin: 100,
        ready: true,
        visible: false,
        blocked: false,
        scrollY: 0,
        scrollMaxY: 1000,
        viewportHeight: 900,
        contentId: null,
        mainCount: 1,
        scrollRoots: [],
        centerHit: null,
      });
      let reason = 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED';
      executor.verify = async (_e, op) => ({
        outcome: 'WAIT',
        reason,
        receipt: {
          binding: op.binding,
          evidence: { pending: resume === 'malformed' ? { visible: false } : diagnostic },
        },
      });
      await h.runner.advance(plan.id);
      const db = new DatabaseSync(file);
      try {
        db.prepare('UPDATE task_outbox SET updated_at=? WHERE job_id=?').run(
          Date.now() - 31000,
          plan.id,
        );
      } finally {
        db.close();
      }
      h.clock.at = 40000;
      await h.runner.advance(plan.id);
      if (resume === 'malformed') {
        assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
        return;
      }
      assert.equal((await store.tasks.get(plan.id)).reason, reason);
      h.clock.at = resume === 'timeout' ? 70000 : 69000;
      const resumed = await h.runner.advance(plan.id);
      if (resume === 'timeout') {
        assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
        assert.equal(resumed.reason, 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT');
        assert.equal((await store.tasks.get(plan.id)).state, 'REVIEW');
        assert.equal(h.inputs.get(plan.profileId), 1);
        assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
        return;
      }
      assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'ACKNOWLEDGED');
      assert.equal(h.inputs.get(plan.profileId), 1);
      assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
      diagnostic.visible = true;
      reason = 'FACEBOOK_BROWSE_EFFECT_PENDING';
      h.clock.at++;
      if (resume === 'verified') {
        executor.verify = async (_e, op) => ({
          outcome: 'VERIFIED',
          receipt: { binding: op.binding, evidence: {} },
          effect: { kind: 'auxiliary', purpose: 'activate', observed: true },
        });
        await h.runner.advance(plan.id);
        assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'VERIFIED');
      } else {
        await h.runner.advance(plan.id);
        h.clock.at += 29000;
        await h.runner.advance(plan.id);
        assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'ACKNOWLEDGED');
        h.clock.at += 2000;
        await h.runner.advance(plan.id);
        assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
      }
      assert.equal(h.inputs.get(plan.profileId), 1);
      assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
    });
  }
});

test('browse timeout preserves only its final independent read before control stops, without resending or crediting it', async () => {
  await settlementFixture(async (store, file) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      proof = h.proofs.get(plan.profileId);
    const executor = h.executors[0];
    assert.ok(proof && executor);
    executor.decide = async () => action(proof);
    const pending = { version: 1, visible: false, scrollY: 8085 };
    executor.verify = async (_e, op) => ({
      outcome: 'WAIT',
      reason: 'PENDING',
      receipt: { binding: op.binding, evidence: { pending } },
    });
    await h.runner.advance(plan.id);
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE task_outbox SET updated_at=? WHERE job_id=?').run(
        Date.now() - 31000,
        plan.id,
      );
    } finally {
      db.close();
    }
    await h.runner.advance(plan.id);
    const saved = (await store.tasks.operations(plan.id))[0];
    assert.equal(saved?.status, 'UNKNOWN');
    assert.deepEqual(saved?.receipt, {
      binding: saved?.binding,
      reason: 'BROWSE_EFFECT_TIMEOUT',
      observation: { pending },
    });
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
    assert.equal(h.inputs.get(plan.profileId), 1);
  });
});

test('empty-content timeout records its current read without inventing an operation; diagnostic failure cannot block pause', async () => {
  for (const fail of [false, true])
    await settlementFixture(async (store) => {
      const h = await browseHarness(store),
        plan = await h.claim(),
        executor = h.executors[0];
      assert.ok(executor);
      const diagnostic = BrowsePendingDiagnostic.parse({
        version: 1,
        independent: true,
        url: 'https://www.facebook.com/',
        timeOrigin: 1,
        ready: true,
        visible: true,
        blocked: false,
        scrollY: 6504,
        scrollMaxY: 12631,
        viewportHeight: 674,
        contentId: null,
        mainCount: 1,
        scrollRoots: [],
        centerHit: null,
      });
      executor.decide = async () => {
        throw new BrowseReadTimeout('FACEBOOK_FEED_CONTENT_REQUIRED_TIMEOUT', diagnostic);
      };
      if (fail)
        store.tasks.noteBrowseReadFailure = () => {
          throw Error('FIXTURE_DIAGNOSTIC_WRITE_FAILED');
        };
      await h.runner.advance(plan.id);
      assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
      assert.equal((await store.tasks.operations(plan.id)).length, 0);
      assert.equal(h.inputs.get(plan.profileId) ?? 0, 0);
      assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
      const row = (await store.tasks.events(plan.id)).find((x) => x.type === 'BROWSE_READ_TIMEOUT');
      if (fail) assert.equal(row, undefined);
      else
        assert.deepEqual(row?.detail, {
          version: 1,
          stepId: (await store.tasks.steps(plan.id))[0]?.id,
          reason: 'FACEBOOK_FEED_CONTENT_REQUIRED_TIMEOUT',
          pending: diagnostic,
        });
    });
});

test('a confirmed NOT_APPLIED action does not get resent by the loop', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      proof = h.proofs.get(plan.profileId);
    assert.ok(proof);
    const executor = h.executors[0];
    assert.ok(executor);
    executor.decide = async () => action(proof);
    executor.verify = async (_e, op) => ({
      outcome: 'NOT_APPLIED',
      receipt: { binding: op.binding, evidence: { independentlyNotApplied: true } },
    });
    await h.runner.advance(plan.id);
    await h.runner.advance(plan.id);
    executor.decide = async () => ({ kind: 'wait', reason: 'NO_NEW_ACTION' });
    await h.runner.advance(plan.id);
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'FAILED');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 0);
    assert.equal(h.inputs.get(plan.profileId), 1);
  });
});

test('duplicate calls coalesce per profile while another profile advances independently', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 2),
      first = await h.claim(),
      second = await h.claim(),
      block = latch();
    const executor = h.executors[0];
    assert.ok(executor);
    executor.decide = async (e, guard) => {
      if (e.plan.id === first.id) await block.promise;
      await guard();
      return { kind: 'observe', observation: h.sample(e) };
    };
    const a = h.runner.advance(first.id),
      b = h.runner.advance(first.id);
    assert.equal(a, b);
    const secondResult = await h.runner.advance(second.id);
    assert.equal(secondResult.status, 'OBSERVED');
    h.clock.at = 1000;
    await h.runner.advance(second.id);
    assert.equal((await store.tasks.steps(second.id))[0]?.progress.effectiveMilliseconds, 1000);
    block.release();
    await a;
    assert.equal((await store.tasks.get(first.id)).state, 'RUNNING');
    assert.equal((await store.tasks.get(second.id)).state, 'RUNNING');
  });
});

test('stop during asynchronous observation fences its stale result and excludes elapsed time', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      block = latch();
    await h.runner.advance(plan.id);
    h.clock.at = 1000;
    const executor = h.executors[0];
    assert.ok(executor);
    executor.decide = async (e) => {
      await block.promise;
      return { kind: 'observe', observation: h.sample(e) };
    };
    const reading = h.runner.advance(plan.id);
    await h.registry.control(plan.id, 'stop');
    block.release();
    await reading;
    assert.equal((await store.tasks.get(plan.id)).state, 'STOPPED');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
  });
});

test('product polling advances a ready profile while another cycle waits, without duplicate reads or stale progress after stop', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 2),
      first = await h.claim(),
      second = await h.claim(),
      block = latch();
    await h.runner.tick();
    const executor = h.executors[0];
    assert.ok(executor);
    let firstReads = 0;
    executor.decide = async (e, guard) => {
      if (e.plan.id === first.id) {
        firstReads++;
        await block.promise;
      }
      await guard();
      return { kind: 'observe', observation: h.sample(e) };
    };
    const settleReady = async (value: number) => {
      for (
        let i = 0;
        i < 20 && (await store.tasks.steps(second.id))[0]?.progress.effectiveMilliseconds !== value;
        i++
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await store.tasks.steps(second.id))[0]?.progress.effectiveMilliseconds, value);
    };
    try {
      h.clock.at = 1000;
      assert.deepEqual(await h.runner.poll(), []);
      await settleReady(1000);
      h.clock.at = 2000;
      const completed = await h.runner.poll();
      assert.deepEqual(
        completed.map((r) => r.profileId),
        [second.profileId],
      );
      await settleReady(2000);
      assert.equal(firstReads, 1);
      assert.equal((await store.tasks.steps(first.id))[0]?.progress.effectiveMilliseconds, 0);
      await h.registry.control(first.id, 'stop');
      block.release();
      await h.runner.tick();
      assert.equal((await store.tasks.get(first.id)).state, 'STOPPED');
      assert.equal((await store.tasks.steps(first.id))[0]?.progress.effectiveMilliseconds, 0);
      assert.equal((await store.tasks.operations(first.id)).length, 0);
    } finally {
      block.release();
      await h.runner.close();
    }
  });
});

test('runner shutdown drains in-flight reads and rejects new cycles before any stale input or progress', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      block = latch();
    await h.runner.tick();
    const executor = h.executors[0];
    assert.ok(executor);
    const entered = latch();
    executor.decide = async (e, guard) => {
      entered.release();
      await block.promise;
      await guard();
      return { kind: 'observe', observation: h.sample(e) };
    };
    h.clock.at = 1000;
    await h.runner.poll();
    await entered.promise;
    let drained = false;
    const closing = h.runner.close().then(() => {
      drained = true;
    });
    assert.deepEqual(await h.runner.poll(), []);
    assert.equal((await h.runner.advance(plan.id)).reason, 'STEP_RUNNER_CLOSED');
    assert.equal(drained, false);
    block.release();
    await closing;
    assert.equal(drained, true);
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
    assert.equal((await store.tasks.operations(plan.id)).length, 0);
  });
});

test('per-profile claim retains original global budget and leaves other queued reasons unchanged', async () => {
  await settlementFixture(async (store) => {
    store.tasks.setSettings({ maxConcurrentProfiles: 2 });
    const h = await browseHarness(store, 3);
    const [first, second, third] = h.assigned;
    assert.ok(first && second && third);
    const profiles = await h.host.schedulingProfiles();
    assert.equal(
      (
        await store.tasks.claimNext(profiles, new Set(['video']), {
          resourceTables: false,
          profileId: second.profileId,
        })
      )?.id,
      second.id,
    );
    assert.equal((await store.tasks.get(first.id)).reason, '');
    assert.equal(
      (
        await store.tasks.claimNext(profiles, new Set(['video']), {
          resourceTables: false,
          profileId: first.profileId,
        })
      )?.id,
      first.id,
    );
    assert.equal(
      await store.tasks.claimNext(profiles, new Set(['video']), {
        resourceTables: false,
        profileId: third.profileId,
      }),
      null,
    );
    assert.equal((await store.tasks.get(third.id)).reason, 'CONCURRENCY_LIMIT');
    assert.equal((await store.tasks.get(first.id)).state, 'RUNNING');
    assert.equal((await store.tasks.get(second.id)).state, 'RUNNING');
  });
});

test('runner replacement and repository reopen preserve progress but never carry a cached time interval across restart', async () => {
  await settlementFixture(async (store, file) => {
    const h = await browseHarness(store),
      plan = await h.claim();
    await h.runner.advance(plan.id);
    h.clock.at = 1000;
    await h.runner.advance(plan.id);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 1000);
      const next = new TaskStepRunner(
        reopened.tasks,
        reopened.browseIntents,
        reopened.taskTabs,
        h.host,
        h.executors,
        h.clock,
        randomUUID,
      );
      h.clock.at = 100000;
      await next.advance(plan.id);
      assert.equal(reopened.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 1000);
      h.clock.at = 101000;
      await next.advance(plan.id);
      assert.equal(reopened.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 2000);
    } finally {
      reopened.close();
    }
  });
});

test('29 persisted plans respect two active slots; task-loop simulation is distinct from 29 real browsers', async () => {
  await settlementFixture(async (store) => {
    store.tasks.setSettings({ maxConcurrentProfiles: 2 });
    const h = await browseHarness(store, 29);
    await h.runner.tick();
    const plans = await store.tasks.list();
    assert.equal(plans.filter((p) => p.state === 'RUNNING').length, 2);
    assert.equal(plans.filter((p) => p.state === 'QUEUED').length, 27);
    assert.equal(plans.filter((p) => p.state === 'PAUSED').length, 0);
  });
});

test('business intent and outbox commit atomically, are immutable, and refuse repeated known-like content for the same account', async () => {
  await settlementFixture(async (store, file) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      proof = h.proofs.get(plan.profileId);
    assert.ok(proof);
    await h.runner.advance(plan.id);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const decision = action(proof),
      id = randomUUID(),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_intent BEFORE INSERT ON task_browse_intents BEGIN SELECT RAISE(ABORT,'INTENT_FAILURE'); END",
      );
      await assert.rejects(
        async () =>
          await store.browseIntents.prepare(plan.id, step.id, id, decision.action, decision.intent),
        /INTENT_FAILURE/,
      );
      assert.equal((await store.tasks.operations(plan.id)).length, 0);
      db.exec('DROP TRIGGER fail_intent');
      await store.browseIntents.prepare(plan.id, step.id, id, decision.action, decision.intent);
      const other: Intent = { ...decision.intent, contentId: 'changed' };
      await assert.rejects(
        async () => await store.browseIntents.prepare(plan.id, step.id, id, decision.action, other),
        /ID_CONFLICT/,
      );
      assert.throws(
        () => db.prepare('UPDATE task_browse_intents SET body=?').run('{}'),
        /IMMUTABLE_BROWSE_INTENT/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM task_browse_intents').run(),
        /RETAIN_BROWSE_INTENT/,
      );
      await h.runner.advance(plan.id);
      await h.runner.advance(plan.id);
      const additional: Action = decision.action;
      await assert.rejects(
        async () =>
          await store.browseIntents.prepare(
            plan.id,
            step.id,
            randomUUID(),
            additional,
            decision.intent,
          ),
        /ALREADY_USED/,
      );
      assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 1);
    } finally {
      db.close();
    }
  });
});

test('explicit waiting breaks timing and the next observation establishes a new baseline', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      executor = h.executors[0];
    assert.ok(executor);
    const original = executor.decide;
    await h.runner.advance(plan.id);
    h.clock.at = 1000;
    await h.runner.advance(plan.id);
    executor.decide = async () => ({ kind: 'wait', reason: 'PAGE_UNREADABLE' });
    h.clock.at = 2000;
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.get(plan.id)).reason, 'PAGE_UNREADABLE');
    assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
    executor.decide = original;
    h.clock.at = 3000;
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.get(plan.id)).reason, '');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 1000);
    h.clock.at = 4000;
    await h.runner.advance(plan.id);
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 2000);
  });
});

test('settlement notification reply loss holds the running loop without replay, progress regression or false offline', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      proof = h.proofs.get(plan.profileId),
      executor = h.executors[0];
    assert.ok(proof);
    assert.ok(executor);
    executor.decide = async () => action(proof);
    await h.runner.advance(plan.id);
    await h.runner.advance(plan.id);
    const port = h.ports.get(plan.profileId);
    assert.ok(port);
    const notify = port.notify;
    port.notify = async (binding, resolution) => {
      await notify(binding, resolution);
      throw Error('NOTICE_REPLY_LOST');
    };
    const result = await h.runner.advance(plan.id);
    assert.equal(result.reason, 'ACTOR_BACKPRESSURE');
    assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.likes, 1);
    assert.equal((await store.tasks.settlements.list())[0]?.state, 'PENDING');
    assert.equal(h.inputs.get(plan.profileId), 1);
    assert.equal((await h.host.profiles())[0]?.online, true);
  });
});

test('runtime account change requests and confirms actual stop without carrying old timing into the new account', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      profile = h.profiles[0];
    assert.ok(profile);
    await h.runner.advance(plan.id);
    h.clock.at = 1000;
    profile.account = { state: 'logged-in', id: 'changed-account', name: null, avatar: null };
    await h.runner.tick();
    assert.equal((await store.tasks.get(plan.id)).state, 'STOPPED');
    assert.equal((await store.tasks.get(plan.id)).controlMode, 'stop');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
    assert.equal((await store.taskControls.list()).length, 1);
  });
});

test('an old prepared operation without semantic intent cannot be dispatched by the business loop', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      proof = h.proofs.get(plan.profileId);
    assert.ok(proof);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    await store.tasks.prepareOperation(plan.id, step.id, randomUUID(), action(proof).action);
    const result = await h.runner.advance(plan.id);
    assert.equal(result.reason, 'BROWSE_INTENT_REQUIRED');
    assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'CANCELLED');
    assert.equal(h.inputs.get(plan.profileId) ?? 0, 0);
  });
});

test('schema6 forward migration backs up the original control intent without confirming, recovering or manufacturing business intent', async () => {
  await settlementFixture(async (store, file) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      context = h.sessions.get(plan.profileId);
    assert.ok(context);
    const stopping = await store.tasks.requestControl(plan.id, 'stop');
    assert.ok(stopping.controlRequestId);
    await store.taskControls.bind({
      ...context,
      jobId: plan.id,
      requestId: stopping.controlRequestId,
      mode: 'stop',
    });
    const before = await store.tasks.get(plan.id),
      controls = await store.taskControls.list();
    const db = new DatabaseSync(file);
    try {
      db.exec(
        dropMaterialSchema +
          'DROP TRIGGER immutable_browse_intent;DROP TRIGGER retain_browse_intent;DROP TABLE task_browse_intents;PRAGMA user_version=6',
      );
    } finally {
      db.close();
    }
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.tasks.get(plan.id), before);
      assert.deepEqual(reopened.taskControls.list(), controls);
      assert.throws(() => reopened.browseIntents.get(randomUUID()), /BROWSE_INTENT_REQUIRED/);
      const backups = (await readdir(path.dirname(file))).filter((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.equal(backups.length, 1);
      const backup = new DatabaseSync(path.join(path.dirname(file), String(backups[0])), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 6);
      } finally {
        backup.close();
      }
    } finally {
      reopened.close();
    }
  });
});

test('unavailable marketplace records its step failure and confirms control before the existing ending coordinator can continue', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: 'Marketplace denial continuation',
      note: 'Generated only',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
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
    });
    const plan = await h.claim();
    const executor = h.executors.find((e) => e.type === 'marketplace');
    assert.ok(executor);
    executor.decide = async () => {
      throw Error('FACEBOOK_MARKETPLACE_UNAVAILABLE');
    };
    await h.runner.advance(plan.id);
    const steps = await store.tasks.steps(plan.id);
    assert.equal(steps[0]?.status, 'ACTIVE');
    const failure = (await store.tasks.events(plan.id)).find(
      (e) => e.type === 'STEP_FAILURE_INTENT',
    );
    assert.equal(
      (failure?.detail as { reason?: string })?.reason,
      'FACEBOOK_MARKETPLACE_UNAVAILABLE',
    );
    assert.equal(steps[1]?.status, 'PENDING');
    assert.equal((await store.tasks.get(plan.id)).controlConfirmed, true);
    assert.equal(h.inputs.get(plan.profileId) ?? 0, 0);
  });
});
