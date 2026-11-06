import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page, Request, Response } from 'playwright-core';
import {
  confirmedBumperGraphQL,
  observeBumperGraphql,
  executeBumperOperation,
  canonicalBumperPageIdFromURL,
  readBumperPageRedirect,
} from '../src/infrastructure/group-bumper-runner.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';
import type { Binding } from '../src/shared/task-execution.js';

const feedbackId = btoa('feedback:123456789012345');
const input = {
  actorId: '61599999999999',
  feedbackId,
  kind: 'comment' as const,
  comment: 'hello',
  variables: { input: { feedback_id: feedbackId, message: { text: 'hello' } } },
  status: 200,
  body: JSON.stringify({
    data: {
      comment_create: {
        feedback: { id: feedbackId },
        feedback_comment_edge: {
          node: {
            id: btoa('comment:123456789012345_222222222222222'),
            author: { id: '61599999999999' },
            body: { text: 'hello' },
            feedback: { id: 'comment-own-feedback' },
          },
        },
      },
    },
  }),
};
function changedBody(change: (v: any) => void) {
  const data = JSON.parse(input.body);
  change(data);
  return JSON.stringify(data);
}
function binding(): Binding {
  return {
    profileId: randomUUID(),
    accountId: '61599999999999',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'a'.repeat(64),
  };
}

test('native comment response without request actor confirms only matching response author, text and parent feedback', () => {
  assert.equal(confirmedBumperGraphQL(input), true);
  assert.equal(
    confirmedBumperGraphQL({
      ...input,
      body: 'for (;;);' + input.body + '\n' + JSON.stringify({ extensions: { is_final: true } }),
    }),
    true,
  );
  const rejected = [
    { variables: { input: { ...input.variables.input, actor_id: 'wrong' } } },
    { variables: { input: { ...input.variables.input, message: { text: 'other' } } } },
    {
      body: changedBody(
        (x) => (x.data.comment_create.feedback_comment_edge.node.author.id = 'wrong'),
      ),
    },
    {
      body: changedBody(
        (x) => (x.data.comment_create.feedback_comment_edge.node.body.text = 'other'),
      ),
    },
    { body: changedBody((x) => (x.data.comment_create.feedback.id = 'wrong-parent')) },
    { body: changedBody((x) => delete x.data.comment_create.feedback) },
    { body: changedBody((x) => (x.data.comment_create.feedback_comment_edge.node = null)) },
    { body: changedBody((x) => (x.errors = [{ message: 'failed' }])) },
    { status: 500 },
    { feedbackId: '' },
  ];
  for (const change of rejected)
    assert.equal(confirmedBumperGraphQL({ ...input, ...change }), false, JSON.stringify(change));
  assert.equal(confirmedBumperGraphQL({ ...input, kind: 'like' }), false);
});

test('observer captures native missing-actor comment request and its paired delayed response', async () => {
  const page = new EventEmitter();
  const observer = observeBumperGraphql(page as unknown as Page, input);
  const request = {
    method: () => 'POST',
    url: () => 'https://www.facebook.com/api/graphql/',
    postData: () =>
      new URLSearchParams({
        fb_api_req_friendly_name: 'useCometUFICreateCommentMutation',
        variables: JSON.stringify(input.variables),
      }).toString(),
  } as Request;
  page.emit('request', request);
  page.emit('response', {
    request: () => request,
    status: () => 200,
    text: async () => input.body,
  } as Response);
  await observer.close();
  assert.equal(observer.confirmed(), true);
  assert.equal(page.listenerCount('request'), 0);
});

test('lightweight browser GET uses the final Facebook profile route and rejects login, foreign origins and post URLs', async () => {
  let requested = '';
  const page = {
    evaluate: async (_fn: (id: string) => Promise<unknown>, id: string) => {
      requested = id;
      return { status: 200, url: 'https://www.facebook.com/profile.php?id=61599999999999' };
    },
  } as unknown as Page;
  assert.equal(await readBumperPageRedirect(page, '111111111111111'), '61599999999999');
  assert.equal(requested, '111111111111111');
  for (const url of [
    'https://evil.test/profile.php?id=61599999999999',
    'https://www.facebook.com/login/?id=61599999999999',
    'https://www.facebook.com/61599999999999/posts/123456789012345/',
    'http://www.facebook.com/profile.php?id=61599999999999',
  ])
    assert.equal(canonicalBumperPageIdFromURL(url), null);
  assert.equal(
    canonicalBumperPageIdFromURL('https://www.facebook.com/61599999999999/'),
    '61599999999999',
  );
});

test('scrolling alone is NOT_APPLIED; a dispatched Enter with unknown result remains pending review', async () => {
  for (const dispatch of [false, true]) {
    let scroll = 0,
      enter = 0,
      outcome = '',
      reviews = 0;
    const b = binding();
    await assert.rejects(
      executeBumperOperation({
        binding: b,
        label: '发送评论',
        connection: {
          get nativeMutationCalls() {
            return { 'DOM.scrollIntoViewIfNeeded': scroll };
          },
          get submissionCalls() {
            return { enter, mousePress: 0 };
          },
          execute: async (_b: Binding, work: () => Promise<unknown>) => ({ value: await work() }),
          reconcile: async (_b: Binding, resolution: { outcome: string }) => {
            outcome = resolution.outcome;
          },
        } as never,
        work: async () => {
          scroll++;
          if (dispatch) enter++;
          return true;
        },
        verify: async () => false,
        assertCurrent: async () => {},
        stop: async () => {},
        settlement: {
          auxiliary: false,
          save: async (r) => r,
          settled: async () => {},
          review: async () => {
            reviews++;
          },
        },
      }),
      /结果待核对/,
    );
    assert.equal(outcome, dispatch ? '' : 'NOT_APPLIED');
    assert.equal(reviews, dispatch ? 1 : 0);
  }
});

test('ended unknown submissions stay visible and block only the same account/post; setup and NOT_APPLIED do not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumper-evidence-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const repo = store.groupBumper,
      b = binding();
    repo.prepareOperation({
      binding: b,
      runId: randomUUID(),
      actionKind: 'submit_comment',
      groupId: '12345',
      groupName: 'g',
      pageId: '54321',
      pageName: 'p',
      postId: '123456789012345',
    });
    repo.markOperationReview(b.operationId, 'unconfirmed');
    repo.setOperationResolution(b.operationId, {
      id: randomUUID(),
      outcome: 'ENDED_UNKNOWN',
      evidenceDigest: 'b'.repeat(64),
    });
    repo.markOperationSettled(b.operationId);
    assert.equal(
      repo.pendingReviewOperations().some((x) => x.id === b.operationId),
      true,
    );
    assert.equal(repo.eligibility(b.accountId, b.profileId, '123456789012345').allowed, false);
    assert.equal(repo.eligibility(b.accountId, b.profileId, '333333333333333').allowed, true);
    assert.equal(
      repo.eligibility('another-account', randomUUID(), '123456789012345').allowed,
      true,
    );
    const setup = { ...binding(), profileId: b.profileId };
    repo.prepareOperation({
      binding: setup,
      runId: randomUUID(),
      actionKind: 'setup_scroll',
      groupId: '12345',
      groupName: 'g',
      postId: '333333333333333',
    });
    repo.setOperationResolution(setup.operationId, {
      id: randomUUID(),
      outcome: 'ENDED_UNKNOWN',
      evidenceDigest: 'c'.repeat(64),
    });
    repo.markOperationSettled(setup.operationId);
    assert.equal(repo.pendingReviewOperations().length, 1);
    assert.equal(repo.eligibility(b.accountId, b.profileId, '333333333333333').allowed, true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial success retains its count and structured pending outcome in final profile result', async () => {
  const id = randomUUID();
  let saved: any;
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const target: BumperTarget = {
    id: '12345',
    name: 'target',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const service = new GroupBumperService(
    {
      targets: () => [target],
      settings: () => BumperSettings.parse({}),
      todayCounts: () => ({}),
      saveProfileResult: (r: unknown) => {
        saved = r;
        done();
      },
    } as never,
    {
      ready: () => true,
      busy: async () => false,
      hasControl: () => false,
      stop: async () => {},
      run: async (_id, _groups, _pages, _settings, cb) => {
        cb.added(1);
        cb.issue?.({ kind: 'pending', reason: 'comment unconfirmed' });
      },
    },
    async () => ({ comments: [], total: 0 }),
    () => {},
    undefined,
    0,
  );
  await service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['12345'] });
  await finished;
  assert.equal(saved.failedSteps, 1);
  assert.equal(saved.state, 'FAILED');
  assert.match(saved.reason, /1.*已确认.*1.*待核对/);
});
