import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { deliverPostNotices } from './fixtures/material-post.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { TaskService } from '../src/application/task-service.js';
import { DataCleanupService } from '../src/application/data-cleanup.js';
import { Store } from '../src/bridge/store.js';
import type { BumperLog } from '../src/shared/group-bumper.js';
import type { PosterLog } from '../src/shared/group-poster.js';
import type { Binding } from '../src/shared/task-execution.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import { JournalEntry } from '../src/bridge/protocol.js';

const avatar =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
const profile = randomUUID();
function bumper(i: number): BumperLog {
  return {
    id: randomUUID(),
    profileId: profile,
    accountId: '61500000000001',
    groupId: '123456789',
    groupName: 'Group',
    pageId: '61500000000002',
    pageName: 'Page',
    postId: String(900000000000 + i),
    postUrl: `https://www.facebook.com/groups/123456789/posts/${900000000000 + i}/`,
    liked: true,
    commentText: null,
    bumpedAt: Date.now() - 10000 + i,
    sourceMode: 'group',
  };
}
function poster(i: number): PosterLog {
  return {
    id: randomUUID(),
    profileId: profile,
    accountId: '61500000000001',
    accountName: 'Account',
    accountAvatar: avatar,
    identityType: 'personal',
    groupId: '123456789',
    groupName: 'Group',
    groupAvatar: avatar,
    materialId: 'material-' + i,
    captionPreview: 'result',
    postId: String(800000000000 + i),
    postUrl: `https://www.facebook.com/groups/123456789/posts/${800000000000 + i}/`,
    postedAt: Date.now() - 10000 + i,
  };
}
function archiveRecord(bridge: Store, binding: Binding) {
  const sequence = bridge.kernelOperationSequence(binding, 0);
  const row = {
    binding,
    operationSequence: sequence,
    state: 'RECONCILED' as const,
    reason: '',
    resolution: { id: randomUUID(), outcome: 'VERIFIED' as const, evidenceDigest: 'a'.repeat(64) },
  };
  bridge.archiveKernelReceipts(binding.profileId, [row]);
  return row;
}
function binding(): Binding {
  return {
    profileId: profile,
    accountId: '61500000000001',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'b'.repeat(64),
  };
}
test('retention defaults and independent caps persist without resetting unrelated configuration', async () => {
  const s = await WorkspaceStore.open(':memory:');
  try {
    const before = s.dataCleanup.settings();
    assert.equal(before.historyMaxCount, 10000);
    assert.equal(before.bumperMaxCount, 300000);
    assert.equal(before.posterMaxCount, 100000);
    assert.equal(before.detailMaxCount, 1000);
    s.dataCleanup.saveSettings({
      expectedRevision: before.revision,
      historyRetentionDays: null,
      detailMaxCount: 50,
    });
    const after = s.dataCleanup.settings();
    assert.equal(after.detailMaxCount, 50);
    assert.equal(after.bumperMaxCount, 300000);
    assert.equal(after.posterMaxCount, 100000);
    assert.equal(after.historyMaxCount, 10000);
  } finally {
    s.close();
  }
});
test('automatic result eviction preserves duplicate prevention, quotas, comment history and explicit clearing', async () => {
  const s = await WorkspaceStore.open(':memory:');
  try {
    s.groupBumper.upsertTargets('groups', { items: [{ id: '123456789', name: 'Group' }] });
    s.groupBumper.upsertTargets('pages', { items: [{ id: '61500000000002', name: 'Page' }] });
    const old = { ...bumper(0), commentText: 'same confirmed comment' };
    s.groupBumper.record(old);
    for (let i = 1; i < 6; i++) s.groupBumper.record(bumper(i));
    const firstPost = poster(0);
    s.groupPoster.recordPost(firstPost);
    for (let i = 1; i < 6; i++) s.groupPoster.recordPost(poster(i));
    const quota = s.groupBumper.eligibility(old.accountId, old.profileId, old.postId),
      counts = s.groupPoster.todayCounts();
    while (s.dataCleanup.pruneResults(2, 2, 2)) {}
    assert.equal(s.groupBumper.total(), 2);
    assert.equal(s.groupPoster.total(), 2);
    assert.deepEqual(s.groupBumper.eligibility(old.accountId, old.profileId, old.postId), quota);
    assert(s.groupPoster.hasGroupPostedMaterial(firstPost.groupId, firstPost.materialId));
    assert.deepEqual(s.groupPoster.todayCounts(), counts);
    assert.equal(s.groupBumper.record(old), false);
    assert.equal(s.groupPoster.recordPost(firstPost), false);
    s.groupBumper.deleteLogs({ all: true });
    s.groupPoster.deleteLogs({ all: true });
    assert.equal(
      s.groupBumper.eligibility(old.accountId, old.profileId, old.postId).duplicate,
      false,
    );
    assert.equal(
      s.groupPoster.hasGroupPostedMaterial(firstPost.groupId, firstPost.materialId),
      false,
    );
    assert.equal(s.groupBumper.targets('groups')[0]?.totalBumpedCount, 0);
  } finally {
    s.close();
  }
});
test('record avatars reference the exact actor ID, are stored once and survive result eviction', async () => {
  await settlementFixture((s, file) => {
    const a = poster(1);
    s.groupPoster.recordPost(a);
    s.groupPoster.recordPost(poster(2));
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const stored = raw.prepare('SELECT account_avatar,group_avatar FROM group_poster_logs').all();
      assert(stored.every((r) => r.account_avatar === null && r.group_avatar === null));
      assert.equal(raw.prepare('SELECT count(*) n FROM record_avatar_cache').get()?.n, 2);
      assert.equal(s.dataCleanup.recordAvatar('account', a.accountId), avatar);
      assert.equal(s.dataCleanup.recordAvatar('account', '61500000000099'), null);
      assert.match(s.groupPoster.logs()[0]?.accountAvatar ?? '', /record-avatar\?kind=account/);
      s.dataCleanup.pruneResults(1, 1);
      assert.equal(s.dataCleanup.recordAvatar('account', a.accountId), avatar);
    } finally {
      raw.close();
    }
  });
});

test('ID normalization also moves compact usage after visible history was trimmed', async () => {
  const s = await WorkspaceStore.open(':memory:');
  try {
    s.groupBumper.upsertTargets('groups', { items: [{ id: 'old_group', name: 'Group' }] });
    s.groupBumper.upsertTargets('pages', { items: [{ id: 'old_page', name: 'Page' }] });
    const b = { ...bumper(0), groupId: 'old_group', pageId: 'old_page' };
    const p = { ...poster(0), groupId: 'old_group' };
    s.groupBumper.record(b);
    s.groupPoster.recordPost(p);
    s.groupBumper.record(bumper(1));
    s.groupPoster.recordPost(poster(1));
    s.dataCleanup.pruneResults(1, 1);
    s.groupBumper.applyResolvedTargetMetadata('groups', 'old_group', {
      canonicalId: '123456789',
      name: 'Group',
    });
    s.groupBumper.applyResolvedTargetMetadata('pages', 'old_page', {
      canonicalId: '61500000000002',
      name: 'Page',
    });
    assert(s.groupPoster.hasGroupPostedMaterial('123456789', p.materialId));
    assert.equal(s.groupBumper.targets('groups')[0]?.totalBumpedCount, 2);
    assert.equal(s.groupBumper.targets('pages')[0]?.totalBumpedCount, 2);
    assert(s.groupBumper.eligibility(b.accountId, b.profileId, b.postId).duplicate);
  } finally {
    s.close();
  }
});
test('a final activity result, timestamps and step outcome remain identical after raw events and outbox are reclaimed', async () => {
  await settlementFixture(async (s, file) => {
    const f = prepareBound(s);
    s.tasks.acknowledgeBound(f.receipt);
    s.tasks.settleBound(f.receipt, 'VERIFIED', {
      ...f.step.progress,
      revision: 1,
      likes: 1,
      effectiveMilliseconds: 60000,
    });
    deliverPostNotices(s, f.profile.id);
    s.tasks.completeStep(f.plan.id, f.step.id);
    const service = new TaskService(s.tasks),
      request = { profileId: f.profile.id, planId: f.plan.id };
    const before = await service.history(request),
      records = await service.records({ groupBy: 'run', limit: 100 });
    assert.equal(s.tasks.get(f.plan.id).state, 'COMPLETED');
    const boundary = { at: Date.now() + 1000, key: 'z' };
    while (s.dataCleanup.pruneDetails(boundary, 100)) {}
    const after = await service.history(request);
    assert.deepEqual(after.steps, before.steps);
    assert(after.detailsReclaimed);
    assert.deepEqual(
      (await service.records({ groupBy: 'run', limit: 100 })).records,
      records.records,
    );
    assert.equal(s.tasks.operations(f.plan.id).length, 0);
    assert.equal(s.tasks.events(f.plan.id).length, 0);
    const db = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  });
});
test('running and unknown operations are excluded, and pending business result records are not evicted', async () => {
  await settlementFixture((s) => {
    const f = prepareBound(s);
    s.tasks.markBoundUnknown(f.binding, 'unknown');
    const original = s.tasks.operations(f.plan.id);
    const head = s.dataCleanup.detailHead(1000);
    assert(!head.some((r) => r.key === 'operation:' + f.binding.operationId));
    assert.equal(s.dataCleanup.pruneDetails({ at: Date.now() + 1000, key: 'z' }), 0);
    assert.deepEqual(s.tasks.operations(f.plan.id), original);
    const old = bumper(0);
    s.groupBumper.record(old);
    const b = binding();
    s.groupBumper.prepareOperation({
      binding: b,
      runId: b.jobId,
      actionKind: 'submit_comment',
      groupId: old.groupId,
      groupName: old.groupName,
      pageId: old.pageId,
      pageName: old.pageName,
      postId: old.postId,
      postUrl: old.postUrl,
      logId: old.id,
    });
    s.groupBumper.record(bumper(1));
    s.groupBumper.record(bumper(2));
    while (s.dataCleanup.pruneResults(1, 1)) {}
    assert(s.groupBumper.logs().some((r) => r.id === old.id));
    assert.equal(s.groupBumper.total(), 2);
  });
});
test('bridge detail retirement preserves watermarks, exact bindings and blocks replay without returning false success', () => {
  const b = new Store(':memory:');
  try {
    const a = archiveRecord(b, binding()),
      protectedRecord = archiveRecord(b, binding());
    const profileId = a.binding.profileId,
      previous = Number(
        b.db
          .prepare('SELECT high_water FROM kernel_operation_watermarks WHERE profile_id=?')
          .get(profileId)?.high_water,
      );
    assert.equal(
      b.pruneDetails({ at: Date.now() + 1000, key: 'z' }, [protectedRecord.binding.operationId]),
      1,
    );
    assert.equal(b.kernelReceipts(profileId, [protectedRecord.binding.operationId]).length, 1);
    assert.equal(b.kernelReceipts(profileId, [a.binding.operationId]).length, 0);
    assert.throws(() => b.kernelOperationSequence(a.binding, 0), /RETIRED/);
    b.archiveKernelReceipts(profileId, [a]);
    assert.equal(b.kernelReceipts(profileId, [a.binding.operationId]).length, 0);
    assert(b.kernelOperationSequence(binding(), 0) > previous);
    const prepared = b.prepare({
      profileId,
      operationId: randomUUID(),
      action: { kind: 'observe', tabId: 1 },
    });
    b.set(prepared.row.commandId, 'VERIFIED', { large: 'x'.repeat(10000) });
    b.pruneDetails({ at: Date.now() + 1000, key: 'z' }, [protectedRecord.binding.operationId]);
    assert.throws(
      () =>
        b.prepare({
          profileId,
          operationId: prepared.row.operationId,
          action: { kind: 'observe', tabId: 1 },
        }),
      /DETAILS_RECLAIMED/,
    );
  } finally {
    b.close();
  }
});
test('the 1000-entry detail budget is global across workspace and bridge, not per module', async () => {
  await settlementFixture(async (s) => {
    const f = prepareBound(s);
    s.tasks.acknowledgeBound(f.receipt);
    s.tasks.settleBound(f.receipt, 'VERIFIED', {
      ...f.step.progress,
      revision: 1,
      likes: 1,
      effectiveMilliseconds: 60000,
    });
    deliverPostNotices(s, f.profile.id);
    s.tasks.completeStep(f.plan.id, f.step.id);
    const bridge = new Store(':memory:');
    try {
      for (let i = 0; i < 12; i++) archiveRecord(bridge, binding());
      const config = s.dataCleanup.settings();
      s.dataCleanup.saveSettings({
        expectedRevision: config.revision,
        historyRetentionDays: null,
        detailMaxCount: 5,
      });
      const service = new DataCleanupService(
        s.dataCleanup,
        { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
        undefined,
        async () => {},
        () => {},
        bridge,
      );
      await service.automatic();
      const protectedIds = s.dataCleanup.protectedOperationIds();
      assert.equal(
        s.dataCleanup.detailHead(1000).length + bridge.detailHead(1000, protectedIds).length,
        5,
      );
    } finally {
      bridge.close();
    }
  });
});
test('older completed loop rounds can be evicted and reclaimed without stopping the current round', async () => {
  await settlementFixture((s) => {
    const p: RuntimeProfile = {
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '61500000000999', name: null, avatar: null },
    };
    const c = s.createCombination({
      name: 'loop result retention',
      note: 'isolated',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 3 },
    });
    s.tasks.assign(
      { requestId: randomUUID(), combinationId: c.id, version: 1, profileIds: [p.id] },
      [p],
    );
    const plan = s.tasks.claimNext([p], new Set(['feed']));
    assert.ok(plan);
    for (let round = 1; round <= 2; round++) {
      const step = s.tasks.steps(plan.id, round)[0];
      assert.ok(step);
      s.tasks.checkpoint(plan.id, step.id, step.progress.revision, {
        ...step.progress,
        revision: step.progress.revision + 1,
        effectiveMilliseconds: 60000,
      });
      s.tasks.completeStep(plan.id, step.id);
    }
    assert.equal(s.tasks.get(plan.id).round, 3);
    const current = s.tasks.steps(plan.id, 3),
      second = s.tasks.steps(plan.id, 2);
    assert.equal(s.dataCleanup.removeBatch({ keepLatestRuns: 1 }), 1);
    while (s.dataCleanup.pruneDetails({ at: Date.now() + 1000, key: 'z' }, 100)) {}
    assert.equal(s.dataCleanup.reclaimHiddenRounds(), 1);
    assert.equal(s.tasks.steps(plan.id, 1).length, 0);
    assert.deepEqual(s.tasks.steps(plan.id, 2), second);
    assert.deepEqual(s.tasks.steps(plan.id, 3), current);
    assert.equal(s.tasks.get(plan.id).state, 'RUNNING');
  });
});
test('a late real journal for a retired cancellation restores UNKNOWN evidence without resending', () => {
  const b = new Store(':memory:');
  try {
    const intent = {
      profileId: profile,
      operationId: randomUUID(),
      action: {
        kind: 'click' as const,
        tabId: 1,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: '#real' },
      },
    };
    const { row } = b.prepare(intent);
    b.set(row.commandId, 'CANCELLED');
    b.pruneDetails({ at: Date.now() + 1000, key: 'z' });
    assert.equal(b.get(row.commandId), undefined);
    b.reconcile(profile, [
      JournalEntry.parse({
        operationId: row.operationId,
        commandId: row.commandId,
        action: intent.action,
        digest: row.digest,
        status: 'ACKNOWLEDGED',
        legacyFixture: false,
      }),
    ]);
    assert.equal(b.get(row.commandId)?.status, 'UNKNOWN');
    assert.deepEqual(JSON.parse(b.get(row.commandId)?.action ?? 'null'), intent.action);
    assert.equal(b.unresolved(profile).length, 1);
  } finally {
    b.close();
  }
});
test('closed unknown submissions retain their original evidence while pure logs are reclaimed and later outcome updates remain visible', async () => {
  await settlementFixture(async (s, file) => {
    const f = prepareBound(s);
    s.tasks.markBoundUnknown(f.binding, 'UNKNOWN_FIXTURE');
    const requestId = s.tasks.requestEnd(f.plan.id),
      stop = {
        profileId: f.profile.id,
        connectionEpoch: f.binding.connectionEpoch,
        requestId,
        state: 'stopped' as const,
      };
    s.tasks.prepareEnd(f.plan.id, stop);
    deliverPostNotices(s, f.profile.id);
    s.tasks.finishEnd(f.plan.id, stop);
    const original = s.tasks.operations(f.plan.id),
      service = new TaskService(s.tasks),
      request = { profileId: f.profile.id, planId: f.plan.id };
    const before = await service.history(request);
    assert.equal(s.tasks.get(f.plan.id).state, 'FAILED');
    while (s.dataCleanup.pruneDetails({ at: Date.now() + 1000, key: 'z' }, 100)) {}
    assert.deepEqual(s.tasks.operations(f.plan.id), original);
    assert.equal(s.tasks.events(f.plan.id).length, 0);
    const after = await service.history(request);
    assert.deepEqual(after.steps, before.steps);
    assert(after.detailsReclaimed);
    const old = s.tasks.steps(f.plan.id)[0];
    assert.ok(old);
    const progress = { ...old.progress, revision: old.progress.revision + 1 };
    const db = new DatabaseSync(file);
    db.prepare('UPDATE task_steps SET progress=? WHERE id=?').run(JSON.stringify(progress), old.id);
    db.close();
    await service.records({ limit: 100 });
    const refreshed = await service.history(request);
    assert.deepEqual(refreshed.steps[0]?.progress, progress);
    assert.equal(refreshed.steps[0]?.finishedAt, after.steps[0]?.finishedAt);
  });
});
