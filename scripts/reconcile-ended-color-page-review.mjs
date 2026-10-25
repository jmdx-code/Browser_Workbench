import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import {
  WorkspaceStore,
  workspaceSchemaVersion,
} from '../dist/src/infrastructure/workspace-store.js';
import { PostReceipt } from '../dist/src/shared/material-post.js';

// Explicit independent page review, not automatic native-response correlation or task replay.
const root = path.resolve(process.argv[2] ?? '');
assert.ok(root.startsWith(path.resolve('audit') + path.sep));
const prepared = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8'));
const review = JSON.parse(await readFile(path.join(root, 'independent-page-review.json'), 'utf8'));
const scope = prepared.scope;
assert.ok([5, 7].includes(scope.version));
assert.equal(scope.audience, 'SELF');
if (scope.version === 5) assert.equal(scope.maximumPublications, 1);
assert.equal(
  review.reviewMethod,
  scope.version === 5
    ? 'stopped-original-main-page-native-time-link-to-exact-permalink'
    : 'stopped-original-native-result-history-to-exact-permalink',
);
assert.equal(review.businessObservation, 'PUBLISHED');
assert.equal(review.background, scope.version === 5 ? 'visible-solid-red' : 'plain');
assert.equal(review.audience, 'SELF');
assert.equal(review.accountId, scope.accountId);
const resource =
  scope.resources.find((item) => item.format === (review.format ?? scope.resources[0].format)) ??
  scope.resources[0];
assert.equal(review.textSha256, resource.textSha256);
const url = new URL(review.url);
assert.equal(url.origin, 'https://www.facebook.com');
if (review.format === 'video') {
  assert.match(review.videoId ?? '', /^\d{1,30}$/);
  assert.equal(url.pathname, `/reel/${review.videoId}`);
  assert.equal(url.searchParams.size, 0);
} else {
  assert.equal(url.pathname, '/permalink.php');
  assert.equal(url.searchParams.get('id'), scope.accountId);
  assert.match(
    url.searchParams.get('story_fbid') ?? '',
    scope.version === 5 ? /^pfbid[a-zA-Z0-9]{20,180}$/ : /^\d{1,30}$/,
  );
  assert.equal(url.searchParams.size, 2);
}
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const response = await fetch(origin + '/api/workspace/tasks', {
  headers: { cookie, 'x-workbench-task-contract': '4' },
});
assert.ok(response.ok);
const overview = await response.json();
assert.ok(
  !overview.plans.some((plan) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state)),
);
const file = path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite');
const db = new DatabaseSync(file, { readOnly: true });
assert.equal(db.prepare('PRAGMA user_version').get().user_version, workspaceSchemaVersion);
if (process.argv.includes('--apply'))
  await backup(db, path.join(root, 'before-page-business-review.sqlite'));
db.close();
const store = await WorkspaceStore.open(file);
try {
  const plan = store.tasks.get(review.planId);
  assert.equal(plan.batchId, scope.id);
  assert.equal(plan.profileId, scope.profileId);
  assert.equal(plan.accountId, scope.accountId);
  assert.equal(plan.state, 'FAILED');
  const operation = store.tasks.findOperation(plan.id, review.operationId);
  assert.equal(operation?.status, 'UNKNOWN');
  assert.ok(operation.binding);
  const step = store.tasks.steps(plan.id).find((value) => value.id === operation.stepId);
  assert.equal(step?.outcome?.currentStop?.state, 'stopped');
  const link = store.materialPosts.link(operation.id);
  assert.equal(link.purpose, 'SUBMIT');
  const held = store.materials.reservation(link.attemptId);
  assert.equal(held.state, 'REVIEW');
  assert.equal(held.intent.context.accountId, review.accountId);
  if (scope.version === 7) {
    assert.equal(held.intent.snapshot.format, review.format ?? 'text');
    assert.equal(review.text, held.intent.snapshot.text);
    if (review.format === 'video') {
      assert.deepEqual(review.nativeObservation.posts, [
        {
          accountId: scope.accountId,
          postId: review.videoId,
          permalink: review.url,
          text: review.text,
          expanded: true,
          nestedShare: false,
          photos: [],
          videoId: review.videoId,
          videoReady: true,
        },
      ]);
    } else {
      assert.deepEqual(review.nativeObservation.roots, [
        {
          authors: [scope.accountId],
          expanded: true,
          previewSlots: 0,
          privacy: ['Only me'],
          text: [review.text],
        },
      ]);
    }
    assert.equal(review.nativeObservation.url, review.url);
    assert.equal(review.nativeObservation.observedAt, review.observedAt);
    assert.equal(review.lookupHistory.url, review.url);
    const events = store.tasks
      .events(plan.id)
      .filter(
        (e) =>
          e.type.startsWith('CHILD_PAGE_') &&
          e.detail &&
          typeof e.detail === 'object' &&
          'binding' in e.detail &&
          e.detail.binding.operationId === operation.id,
      );
    assert.equal(events.length, 3);
    assert.deepEqual(
      new Set(events.map((e) => e.type)),
      new Set(['CHILD_PAGE_REQUESTED', 'CHILD_PAGE_READY', 'CHILD_PAGE_CLOSED']),
    );
    assert.ok(
      events.every((e) => e.detail.lifecycle.ownershipId === review.nativeChildOwnershipId),
    );
    const requested = events.find((e) => e.type === 'CHILD_PAGE_REQUESTED'),
      closed = events.find((e) => e.type === 'CHILD_PAGE_CLOSED');
    assert.ok(
      Date.parse(review.lookupHistory.visitedAt) >= requested.createdAt &&
        Date.parse(review.lookupHistory.visitedAt) <= closed.createdAt,
    );
  }
  assert.equal(
    createHash('sha256').update(held.intent.snapshot.text).digest('hex'),
    review.textSha256,
  );
  assert.ok(
    Date.parse(review.observedAt) >= operation.createdAt &&
      Date.parse(review.observedAt) <= Date.now(),
  );
  const before = {
    plan,
    operations: store.tasks.operations(plan.id),
    steps: store.tasks.steps(plan.id),
  };
  const receipt = PostReceipt.parse({
    binding: operation.binding,
    evidence: {
      kind: 'material-post-verification',
      independent: true,
      attemptId: held.intent.attemptId,
      fingerprint: held.intent.fingerprint,
      purpose: 'SUBMIT',
      proof: held.intent.proof,
      observedAccountId: review.accountId,
      observationId: randomUUID(),
      checkedAt: review.observedAt,
      outcome: 'PUBLISHED',
      basis: 'own-post-observed',
      postId: review.url,
    },
  });
  if (process.argv.includes('--apply')) {
    store.materialPosts.reconcile(receipt);
    assert.deepEqual(
      {
        plan: store.tasks.get(plan.id),
        operations: store.tasks.operations(plan.id),
        steps: store.tasks.steps(plan.id),
      },
      before,
    );
    assert.equal(store.materials.reservation(link.attemptId).state, 'PUBLISHED');
    await writeFile(
      path.join(root, 'original-business-page-reviewed.json'),
      JSON.stringify(
        {
          reviewMethod: review.reviewMethod,
          receipt,
          originalHistoryUnchanged: true,
          automaticSettlement: false,
          taskAssignments: 0,
          nativeInputs: 0,
          replays: 0,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  }
  console.log(
    JSON.stringify({
      planId: plan.id,
      postId: review.url,
      applied: process.argv.includes('--apply'),
      originalTaskState: plan.state,
      originalSubmitState: operation.status,
    }),
  );
} finally {
  store.close();
}
