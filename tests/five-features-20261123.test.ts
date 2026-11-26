import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Page, Request, Response } from 'playwright-core';
import { EventEmitter } from 'node:events';
import { StepSchema, CombinationSchema } from '../src/shared/contracts.js';
import { AssignTasks, TaskPlan } from '../src/shared/task-contracts.js';
import { TaskTestRequest, taskTestStep } from '../src/shared/task-tests.js';
import { StartBluestacksActiveInput } from '../src/shared/bluestacks.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import {
  formatFeedTargetPagesText,
  parseFeedTargetPagesText,
} from '../src/shared/feed-target-pages.js';
import {
  FACEBOOK_FRIENDS_REQUESTS_URL,
  FACEBOOK_FRIENDS_SUGGESTIONS_URL,
  facebookBrowseSurface,
  facebookBrowseSurfaceForStep,
  facebookDetourMatchesTarget,
  facebookFeedDetourURL,
  facebookFriendsRouteMatches,
  facebookSearchPagesURL,
} from '../src/shared/facebook-browse-route.js';
import { recordMatches } from '../src/domain/task-record-projection.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { observeBumperStoryShareGraphql } from '../src/infrastructure/group-bumper-runner.js';
import { stepName } from '../src/renderer/task-record-summary.js';

const uid = () => randomUUID();

test('Feature #1: closeBrowserOnFinish persists in SqliteTaskRepository & validates BlueStacks input', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const profileId = uid();
    const profileId2 = uid();
    store.ensureProfileOrders([profileId, profileId2]);
    const runtimeProfiles = [profileId, profileId2].map((id) => ({
      id,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '1000001', name: 'Test User', avatar: null },
    }));
    const combo = store.createCombination(
      CombinationSchema.parse({
        name: '有限养号组合',
        note: '',
        steps: [
          {
            id: uid(),
            type: 'feed',
            durationMinutes: 5,
            maxLikes: 1,
            minLikeCount: 0,
          },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      }),
    );

    const req = AssignTasks.parse({
      requestId: uid(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
      closeBrowserOnFinish: true,
    });
    assert.equal(req.closeBrowserOnFinish, true);

    const [plan] = store.tasks.assign(req, runtimeProfiles);
    assert.ok(plan);
    assert.equal(plan.closeBrowserOnFinish, true);

    const reloaded = store.tasks.get(plan.id);
    assert.equal(reloaded.closeBrowserOnFinish, true);
    assert.equal(TaskPlan.parse(reloaded).closeBrowserOnFinish, true);

    const reqNoClose = AssignTasks.parse({
      requestId: uid(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId2],
    });
    const [plan2] = store.tasks.assign(reqNoClose, runtimeProfiles);
    assert.equal(plan2?.closeBrowserOnFinish, undefined);

    const bsInput = StartBluestacksActiveInput.parse({
      instanceIds: [uid()],
      combinationId: combo.id,
      closeWindowOnFinish: true,
    });
    assert.equal(bsInput.closeWindowOnFinish, true);
  } finally {
    store.close();
  }
});

test('Feature #3: Bumper Story Share schema migration, triggers, eligibility, TSV & GraphQL observer', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    // Settings defaults and validation
    const def = BumperSettings.parse({});
    assert.equal(def.shareToStoryProbability, 0);
    assert.equal(BumperSettings.parse({ shareToStoryProbability: 65 }).shareToStoryProbability, 65);
    assert.equal(BumperSettings.safeParse({ shareToStoryProbability: 101 }).success, false);
    assert.equal(BumperSettings.safeParse({ shareToStoryProbability: -1 }).success, false);

    const db = (store as unknown as { db: DatabaseSync }).db;
    assert.ok(db);

    const repo = store.groupBumper as SqliteGroupBumperRepository;
    const profileId = uid();
    const accountId = '61588000112233';
    const postId = '122111222333444';
    const logId = uid();
    const opId = uid();
    const runId = uid();

    const connEpoch = uid();
    const leaseId = uid();
    // Prepare a submit_story_share operation (verifies expanded CHECK constraint)
    repo.prepareOperation({
      binding: {
        profileId,
        accountId,
        connectionEpoch: connEpoch,
        leaseId,
        generation: 1,
        operationId: opId,
        jobId: runId,
        stepId: uid(),
        actionDigest: 'a'.repeat(64),
      },
      runId,
      actionKind: 'submit_story_share',
      groupId: '-',
      groupName: '专页直顶',
      pageId: '61588452821652',
      pageName: 'The spiritual journey',
      postId,
      postUrl: `https://www.facebook.com/61588452821652/posts/${postId}/`,
      logId,
    });

    // Confirm story-share-only submission (liked=false, commentText=null, storyShared=true)
    const now = Date.now();
    repo.confirmSubmission(
      opId,
      {
        id: logId,
        profileId,
        accountId,
        groupId: '-',
        groupName: '专页直顶',
        pageId: '61588452821652',
        pageName: 'The spiritual journey',
        postId,
        postUrl: `https://www.facebook.com/61588452821652/posts/${postId}/`,
        liked: false,
        commentText: null,
        storyShared: true,
        bumpedAt: now,
        sourceMode: 'page',
      },
      undefined,
      { id: uid(), outcome: 'VERIFIED', evidenceDigest: 'b'.repeat(64) },
    );

    const elig = repo.eligibility(accountId, profileId, postId, now + 1000, 'page');
    assert.equal(elig.duplicate, true);
    assert.equal(elig.today, 1);

    const logs = repo.logs('', 20, undefined, undefined, 'page');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.storyShared, true);
    assert.equal(logs[0]?.liked, false);

    // Pending review operation maps submit_story_share -> story_share
    const opId2 = uid();
    repo.prepareOperation({
      binding: {
        profileId,
        accountId,
        connectionEpoch: connEpoch,
        leaseId,
        generation: 1,
        operationId: opId2,
        jobId: runId,
        stepId: uid(),
        actionDigest: 'c'.repeat(64),
      },
      runId,
      actionKind: 'submit_story_share',
      groupId: '-',
      groupName: '专页直顶',
      pageId: '61588452821652',
      pageName: 'The spiritual journey',
      postId: '122111222333999',
    });
    repo.markOperationReview(opId2, '未收到服务器确认');
    const pending = repo.pendingReviewOperations(10);
    assert.equal(pending[0]?.actionKind, 'story_share');
  } finally {
    store.close();
  }

  // Test GraphQL observer with mock page EventEmitter
  const emitter = new EventEmitter();
  const mockPage = emitter as unknown as Page;
  const observer = observeBumperStoryShareGraphql(mockPage, {
    actorId: '10001',
    postId: '999999',
  });
  const fakeReq = {
    method: () => 'POST',
    url: () => 'https://www.facebook.com/api/graphql/',
    postData: () =>
      'fb_api_req_friendly_name=CometShareToStoryMutation&variables=' +
      encodeURIComponent(JSON.stringify({ input: { story_id: '999999' } })),
  } as unknown as Request;
  const fakeRes = {
    request: () => fakeReq,
    status: () => 200,
    text: async () => JSON.stringify({ data: { story_create: { story: { id: 's1' } } } }),
  } as unknown as Response;
  emitter.emit('request', fakeReq);
  emitter.emit('response', fakeRes);
  await observer.waitForEvidence(500);
  assert.equal(observer.confirmed(), true);
  assert.equal(observer.failed(), false);
  assert.equal(observer.restricted(), false);
  await observer.close();
});

test('Feature #4: add_suggested friends validation, policy isolation & executor behavior', async () => {
  // Schema validation
  assert.equal(
    StepSchema.safeParse({
      id: uid(),
      type: 'friends',
      friendAction: 'add_suggested',
      durationMinutes: 10,
      acceptMode: 'count',
      maxAccepts: 5,
      maxLikes: 0,
      minLikeCount: 0,
    }).success,
    true,
  );
  // Reject 'all' and > 100 for add_suggested
  assert.equal(
    StepSchema.safeParse({
      id: uid(),
      type: 'friends',
      friendAction: 'add_suggested',
      durationMinutes: 10,
      acceptMode: 'all',
      maxAccepts: 5,
      maxLikes: 0,
      minLikeCount: 0,
    }).success,
    false,
  );
  assert.equal(
    StepSchema.safeParse({
      id: uid(),
      type: 'friends',
      friendAction: 'add_suggested',
      durationMinutes: 10,
      acceptMode: 'count',
      maxAccepts: 101,
      maxLikes: 0,
      minLikeCount: 0,
    }).success,
    false,
  );

  // TaskTestRequest & taskTestStep
  const req = TaskTestRequest.parse({
    requestId: uid(),
    profileIds: [uid()],
    module: 'add_friends',
    durationMinutes: 10,
    maxAccepts: 4,
  });
  const built = taskTestStep(req, uid());
  assert.equal(built.type, 'friends');
  assert.equal('friendAction' in built ? built.friendAction : undefined, 'add_suggested');
  assert.equal(stepName({ type: 'friends', friendAction: 'add_suggested' }), '加推荐好友');

  // Route matching
  assert.equal(facebookBrowseSurface(FACEBOOK_FRIENDS_SUGGESTIONS_URL), 'friends');
  assert.equal(
    facebookFriendsRouteMatches(FACEBOOK_FRIENDS_SUGGESTIONS_URL, 'add_suggested'),
    true,
  );
  assert.equal(facebookFriendsRouteMatches(FACEBOOK_FRIENDS_REQUESTS_URL, 'add_suggested'), false);
  assert.equal(facebookFriendsRouteMatches(FACEBOOK_FRIENDS_REQUESTS_URL, 'accept'), true);
});

test('Feature #5: detour URLs, target page parser & search_pages/random detour state machines', async () => {
  // Parser round-trip
  const parsedPages = parseFeedTargetPagesText(
    [
      'The spiritual journey, 61588452821652',
      'https://www.facebook.com/houseofburmesechristians/',
      '100085926219692, House of Burmese Christians',
      'Pure Name Page',
      'The spiritual journey, 61588452821652', // duplicate
    ].join('\n'),
  );
  assert.equal(parsedPages.length, 4);
  assert.deepEqual(parsedPages[0], { id: '61588452821652', name: 'The spiritual journey' });
  assert.deepEqual(parsedPages[1], {
    id: 'houseofburmesechristians',
    name: 'houseofburmesechristians',
  });
  assert.deepEqual(parsedPages[2], { id: '100085926219692', name: 'House of Burmese Christians' });
  assert.deepEqual(parsedPages[3], { name: 'Pure Name Page' });
  assert.ok(
    formatFeedTargetPagesText(parsedPages).includes('The spiritual journey, 61588452821652'),
  );

  // Detour URL allowlist & strict deny list
  assert.equal(facebookFeedDetourURL(facebookSearchPagesURL('The spiritual journey')), true);
  assert.equal(
    facebookFeedDetourURL('https://www.facebook.com/profile.php?id=61588452821652'),
    true,
  );
  assert.equal(facebookFeedDetourURL('https://www.facebook.com/houseofburmesechristians/'), true);
  assert.equal(
    facebookFeedDetourURL('https://www.facebook.com/people/John-Doe/1000123456789/'),
    true,
  );
  for (const denied of [
    'https://www.facebook.com/login.php',
    'https://www.facebook.com/checkpoint/',
    'https://www.facebook.com/messages/',
    'https://www.facebook.com/groups/1065694329782225/',
    'https://www.facebook.com/settings',
    'https://www.facebook.com/marketplace/create/',
    'https://www.facebook.com/search/pages/',
    'https://evil.example.com/houseofburmesechristians/',
  ]) {
    assert.equal(facebookFeedDetourURL(denied), false, `should reject ${denied}`);
  }

  // Plain home feed step rejects detour URLs; explore/detour step accepts them
  const plainFeed = StepSchema.parse({
    id: uid(),
    type: 'feed',
    durationMinutes: 5,
    maxLikes: 0,
    minLikeCount: 0,
  });
  assert.equal(
    facebookBrowseSurfaceForStep('https://www.facebook.com/houseofburmesechristians/', plainFeed),
    null,
  );
  const searchFeed = StepSchema.parse({
    id: uid(),
    type: 'feed',
    feedMode: 'search_pages',
    detourDwellSeconds: 20,
    targetPages: [{ id: '61588452821652', name: 'The spiritual journey' }, { name: 'Second Page' }],
    durationMinutes: 5,
    maxLikes: 0,
    minLikeCount: 0,
  });
  assert.equal(
    facebookBrowseSurfaceForStep('https://www.facebook.com/houseofburmesechristians/', searchFeed),
    'feed',
  );
  assert.equal(stepName({ type: 'feed', feedMode: 'search_pages' }), '搜专页逛时间线');
  assert.equal(stepName({ type: 'feed', feedMode: 'random_profile' }), '逛他人时间线');
  assert.equal(stepName({ type: 'feed', feedMode: 'random_page' }), '逛公共专页');

  // search_pages requires >= 1 targetPage
  assert.equal(
    StepSchema.safeParse({
      id: uid(),
      type: 'feed',
      feedMode: 'search_pages',
      targetPages: [],
      durationMinutes: 5,
      maxLikes: 0,
      minLikeCount: 0,
    }).success,
    false,
  );

  // Round 1/2 refinement regressions: modern /p/ & /pages/ URLs, parser query stripping,
  // detour target matching (anti-premature-ACK), strict busy check, and record search text.
  assert.equal(
    facebookFeedDetourURL('https://www.facebook.com/p/The-Spiritual-Journey-61588452821652/'),
    true,
  );
  assert.equal(
    facebookFeedDetourURL('https://www.facebook.com/pages/Example-Page/61588452821652/'),
    true,
  );
  assert.equal(
    facebookFeedDetourURL('https://www.facebook.com/%E7%A6%8F%E9%9F%B3%E4%B8%93%E9%A1%B5/'),
    true,
  );
  assert.equal(facebookFeedDetourURL('https://www.facebook.com/p/'), false);

  assert.equal(
    facebookDetourMatchesTarget(
      'https://www.facebook.com/houseofburmesechristians/',
      facebookSearchPagesURL('Second Page'),
      'https://www.facebook.com/houseofburmesechristians/',
    ),
    false,
  );
  assert.equal(
    facebookDetourMatchesTarget(
      facebookSearchPagesURL('First Page'),
      facebookSearchPagesURL('Second Page'),
      facebookSearchPagesURL('First Page'),
    ),
    false,
  );
  assert.equal(
    facebookDetourMatchesTarget(
      facebookSearchPagesURL('Second Page'),
      facebookSearchPagesURL('Second Page'),
      facebookSearchPagesURL('First Page'),
    ),
    true,
  );
  assert.equal(
    facebookDetourMatchesTarget(
      'https://www.facebook.com/p/My-Page-61588452821652/',
      'https://www.facebook.com/profile.php?id=61588452821652',
      facebookSearchPagesURL('My Page'),
    ),
    true,
  );

  const parsedUrls = parseFeedTargetPagesText(
    [
      '自定义名称, https://www.facebook.com/profile.php?id=61588452821652&sk=about',
      'https://www.facebook.com/p/Spiritual-Journey-61588452821699/',
      'https://www.facebook.com/people/John-Doe/1000123456789/',
    ].join('\n'),
  );
  assert.deepEqual(parsedUrls[0], { id: '61588452821652', name: '自定义名称' });
  assert.deepEqual(parsedUrls[1], { id: '61588452821699', name: 'Spiritual Journey' });
  assert.deepEqual(parsedUrls[2], { id: '1000123456789', name: 'John Doe' });

  // Feature #1 strict auto-scheduler busy check prevents TOCTOU window close
  const reg = new FeatureExecutionRegistry();
  reg.register({
    id: 'auto-scheduler',
    label: '定时排班',
    isProfileRunning: (pid) => pid === 'p-sched',
    hasActiveExecution: () => true,
  });
  reg.setDelegatedSubmodule('p-sched', 'active-accounts');
  assert.equal(await reg.isProfileBusy('p-sched', 'active-accounts'), false);
  assert.equal(await reg.isProfileBusyStrict('p-sched', 'active-accounts'), true);

  // Record search matches new modes
  assert.equal(
    recordMatches(
      {
        combinationName: '养号',
        profileId: 'p1',
        type: 'friends',
        friendAction: 'add_suggested',
      },
      undefined,
      '加推荐好友',
    ),
    true,
  );
  assert.equal(
    recordMatches(
      {
        combinationName: '养号',
        profileId: 'p1',
        type: 'feed',
        feedMode: 'search_pages',
      },
      undefined,
      '搜专页',
    ),
    true,
  );
});
