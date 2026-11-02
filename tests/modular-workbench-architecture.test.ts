import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import type { GroupBumperService } from '../src/application/group-bumper-service.js';
import type { GroupInviterService } from '../src/application/group-inviter-service.js';
import type { WorkspaceService } from '../src/application/workspace-service.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import {
  projectProfileActivity,
  projectProfileActivitiesMap,
  projectSelectionControls,
} from '../src/renderer/modules/profile-activity-projector.js';
import { buildUnifiedActivityFeed } from '../src/renderer/modules/unified-activity-records.js';
import type { Profile } from '../src/shared/contracts.js';
import type { TaskRecord, TaskRuntimeOverview } from '../src/shared/task-contracts.js';
import type { z } from 'zod';

function makeProfile(id: string, name: string): Profile {
  return {
    id,
    alias: name,
    browserName: name,
    groupId: null,
    order: 0,
    online: true,
    synced: true,
    phase: 'CONNECTED',
    unresolved: 0,
    extensionVersion: '0.3.58',
    capabilities: [],
    account: {
      state: 'logged-in',
      id: '10000' + id.slice(-4),
      name,
      avatar: null,
    },
  };
}

test('FeatureExecutionRegistry enforces cross-module mutual exclusion and stops running modules only', async () => {
  const registry = new FeatureExecutionRegistry();
  const stoppedByModule: Record<string, string[]> = {};
  const runningByModule: Record<string, Set<string>> = {
    'active-accounts': new Set(['p1']),
    'group-inviter': new Set(['p2']),
    'group-bumper': new Set(['p2', 'p3']),
  };

  for (const [id, label] of [
    ['active-accounts', '活跃账号'],
    ['group-inviter', '小组邀请人'],
    ['group-bumper', '小组顶贴'],
  ] as const) {
    registry.register({
      id,
      label,
      isProfileRunning: (pid) => runningByModule[id]?.has(pid) ?? false,
      hasActiveExecution: () => (runningByModule[id]?.size ?? 0) > 0,
      stopProfiles: async (pids) => {
        stoppedByModule[id] = [...pids];
        for (const pid of pids) runningByModule[id]?.delete(pid);
      },
    });
  }

  assert.equal(await registry.hasAnyActiveExecution(), true);
  assert.equal(await registry.isProfileBusy('p1'), true);
  assert.equal(await registry.isProfileBusy('p1', 'active-accounts'), false);
  assert.equal(await registry.isProfileBusy('p2', 'group-inviter'), true);
  assert.equal(await registry.isProfileBusy('p4'), false);

  const labelsForP2 = await registry.busyModuleLabels(['p2']);
  assert.deepEqual(labelsForP2, ['小组邀请人', '小组顶贴']);

  const labelsExcludingInviter = await registry.busyModuleLabels(['p2'], 'group-inviter');
  assert.deepEqual(labelsExcludingInviter, ['小组顶贴']);

  const stopped = await registry.stopProfilesAcrossModules(['p2', 'p2', 'p4']);
  assert.equal(stopped, true);
  assert.deepEqual(stoppedByModule['group-inviter'], ['p2']);
  assert.deepEqual(stoppedByModule['group-bumper'], ['p2']);
  assert.equal(stoppedByModule['active-accounts'], undefined);
  assert.equal(await registry.isProfileBusy('p2'), false);
});

test('profile-activity-projector prioritizes active module stats, background running tasks, and selection controls', () => {
  const p1 = makeProfile('10000000-0000-4000-8000-000000000001', '浏览器1');
  const p2 = makeProfile('10000000-0000-4000-8000-000000000002', '浏览器2');
  const p3 = makeProfile('10000000-0000-4000-8000-000000000003', '浏览器3');

  const bumperViewInput = {
    activeModule: 'group-bumper' as const,
    tasks: null,
    bumperCounts: {
      [p1.id]: { today: 5, session: 2, status: '正在浏览小组 A', running: true },
    },
    bumperRunningIds: [p1.id],
    groupInviterCounts: null,
    groupInviterRunningIds: [p2.id],
  };

  const act1 = projectProfileActivity(p1, bumperViewInput);
  assert.ok(act1);
  assert.equal(act1.moduleId, 'group-bumper');
  assert.equal(act1.running, true);
  assert.equal(act1.tone, 'run');
  assert.match(act1.text, /今日 5 · 本轮 2 · 正在浏览小组 A/);

  const act2 = projectProfileActivity(p2, bumperViewInput);
  assert.ok(act2);
  assert.equal(act2.moduleId, 'group-inviter');
  assert.equal(act2.running, true);
  assert.equal(act2.text, '小组邀请人 · 运行中');

  const act3 = projectProfileActivity(p3, bumperViewInput);
  assert.ok(act3);
  assert.equal(act3.running, false);
  assert.equal(act3.tone, 'ok');
  assert.match(act3.text, /今日 0 · 本轮 0 · 未运行/);

  const map = projectProfileActivitiesMap([p1, p2, p3], bumperViewInput);
  assert.equal(map.size, 3);

  const controls = projectSelectionControls(new Set([p1.id, p2.id, p3.id]), bumperViewInput);
  assert.deepEqual(controls.stoppableModuleProfileIds, [p1.id, p2.id]);
  assert.equal(controls.totalStoppableCount, 2);
  assert.equal(controls.isProfileBusy(p1.id), true);
  assert.equal(controls.isProfileBusy(p2.id), true);
  assert.equal(controls.isProfileBusy(p3.id), false);
});

test('unified-activity-records aggregates 3 modules and filters by profileId, moduleFilter, statusFilter, and query', () => {
  const p1 = makeProfile('10000000-0000-4000-8000-000000000001', 'Alpha 浏览器');
  const p2 = makeProfile('10000000-0000-4000-8000-000000000002', 'Beta 浏览器');

  const taskRecord: TaskRecord = {
    stepId: '30000000-0000-4000-8000-000000000001',
    planId: '20000000-0000-4000-8000-000000000001',
    profileId: p1.id,
    combinationId: '40000000-0000-4000-8000-000000000001',
    combinationName: '早间日常养号',
    combinationVersion: 1,
    round: 1,
    position: 0,
    type: 'video',
    status: 'COMPLETED',
    planState: 'COMPLETED',
    planReason: '',
    progress: {
      revision: 1,
      effectiveMilliseconds: 180000,
      likes: 2,
      published: 0,
      cursor: null,
    },
    budget: { kind: 'time', milliseconds: 180000 },
    outcome: undefined,
    startedAt: 1700000100000,
    finishedAt: 1700000280000,
    planCreatedAt: 1700000090000,
    planUpdatedAt: 1700000280000,
  };

  const feedAll = buildUnifiedActivityFeed({
    profiles: [p1, p2],
    taskRecords: [taskRecord],
    inviterState: {
      groups: [
        {
          groupId: 'g100',
          groupName: '跨境卖家交流群',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalInvitedCount: 5,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      invitesPerGroup: 20,
      running: true,
      runId: 'run-1',
      startedAt: 1700000500000,
      finishedAt: null,
      statusText: '运行中',
      profileCounts: {
        [p2.id]: { sessionInvited: 3, totalInvited: 10, status: '正在邀请好友…' },
      },
    },
    inviterLogs: [
      {
        id: '50000000-0000-4000-8000-000000000001',
        profileId: p1.id,
        accountId: 'fb_p1',
        friendId: 'friend_99',
        friendName: 'Alice Wang',
        groupId: 'g100',
        invitedAt: 1700000300000,
      },
    ],
    bumperState: {
      groups: [],
      pages: [],
      settings: {
        searchMode: 'time_sort',
        maxPostAgeHours: 24,
        maxPostsPerGroupPage: 5,
        maxPostsPerPage: 3,
        maxConcurrentProfiles: 4,
        dailyMaxLikesPerAccount: 20,
        maxLikesPerPost: 10,
        likeProbability: 100,
        commentProbability: 30,
        consumeCommentOnUse: false,
      },
      comments: [],
      total: 1,
      running: false,
      statusText: '空闲',
      profileCounts: {
        [p2.id]: { today: 0, session: 0, status: '风控受限：触发 368 拦截', running: false },
      },
    },
    bumperLogs: [
      {
        id: 'bump-1',
        profileId: p1.id,
        accountId: 'fb_p1',
        groupId: 'g200',
        groupName: '好物推荐组',
        pageId: 'page_1',
        pageName: '官方专页',
        postId: 'post_888',
        postUrl: 'https://www.facebook.com/groups/g200/posts/post_888/',
        liked: true,
        commentText: '写得太好了！',
        bumpedAt: 1700000400000,
      },
    ],
    now: 1700000600000,
  });

  assert.equal(feedAll.items.length, 5);
  assert.equal(feedAll.moduleCounts.all, 5);
  assert.equal(feedAll.moduleCounts['active-accounts'], 1);
  assert.equal(feedAll.moduleCounts['group-inviter'], 2);
  assert.equal(feedAll.moduleCounts['group-bumper'], 2);
  assert.equal(feedAll.items[0]?.status, 'running');
  assert.equal(feedAll.items[0]?.moduleId, 'group-inviter');

  const feedP1 = buildUnifiedActivityFeed({
    profiles: [p1, p2],
    taskRecords: [taskRecord],
    inviterLogs: [
      {
        id: '50000000-0000-4000-8000-000000000001',
        profileId: p1.id,
        accountId: 'fb_p1',
        friendId: 'friend_99',
        friendName: 'Alice Wang',
        groupId: 'g100',
        invitedAt: 1700000300000,
      },
    ],
    bumperLogs: [
      {
        id: 'bump-1',
        profileId: p1.id,
        accountId: 'fb_p1',
        groupId: 'g200',
        groupName: '好物推荐组',
        pageId: 'page_1',
        pageName: '官方专页',
        postId: 'post_888',
        postUrl: 'https://www.facebook.com/groups/g200/posts/post_888/',
        liked: true,
        commentText: '写得太好了！',
        bumpedAt: 1700000400000,
      },
    ],
    profileId: p1.id,
  });
  assert.equal(feedP1.items.length, 3);
  assert.ok(feedP1.items.every((item) => item.profileId === p1.id));

  const feedSearch = buildUnifiedActivityFeed({
    profiles: [p1, p2],
    taskRecords: [taskRecord],
    bumperLogs: [
      {
        id: 'bump-1',
        profileId: p1.id,
        accountId: 'fb_p1',
        groupId: 'g200',
        groupName: '好物推荐组',
        pageId: 'page_1',
        pageName: '官方专页',
        postId: 'post_888',
        postUrl: 'https://www.facebook.com/groups/g200/posts/post_888/',
        liked: true,
        commentText: '写得太好了！',
        bumpedAt: 1700000400000,
      },
    ],
    query: '写得太好了',
  });
  assert.equal(feedSearch.items.length, 1);
  assert.equal(feedSearch.items[0]?.moduleId, 'group-bumper');
});

test('projectSelectionControls isProfileBusy recognizes active-accounts, group-inviter, and group-bumper simultaneously', () => {
  const pActive = makeProfile('10000000-0000-4000-8000-000000000011', '活跃账号运行中');
  const pInviter = makeProfile('10000000-0000-4000-8000-000000000012', '邀请人运行中');
  const pBumper = makeProfile('10000000-0000-4000-8000-000000000013', '顶贴运行中');
  const pIdle = makeProfile('10000000-0000-4000-8000-000000000014', '空闲浏览器');

  const runtime: z.infer<typeof TaskRuntimeOverview> = {
    dispatchEnabled: true,
    settings: { maxConcurrentProfiles: 2 },
    plans: [
      {
        id: '20000000-0000-4000-8000-000000000011',
        batchId: '50000000-0000-4000-8000-000000000011',
        profileId: pActive.id,
        combinationId: '40000000-0000-4000-8000-000000000011',
        version: 1,
        accountId: '100000011',
        snapshot: {
          name: '日常养号',
          note: '',
          randomOrder: false,
          loop: { mode: 'finite', rounds: 1 },
          steps: [
            {
              id: '30000000-0000-4000-8000-000000000011',
              type: 'video',
              durationMinutes: 5,
              likeProbability: 0,
              maxLikes: 1,
              minLikeCount: 0,
            },
          ],
        },
        state: 'RUNNING',
        reason: '',
        controlMode: null,
        controlRequestId: null,
        controlConfirmed: true,
        round: 1,
        position: 0,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
    currentSteps: [],
  };

  const selected = new Set([pActive.id, pInviter.id, pBumper.id, pIdle.id]);
  const controls = projectSelectionControls(selected, {
    activeModule: 'active-accounts',
    tasks: runtime,
    bumperRunningIds: [pBumper.id],
    groupInviterRunningIds: [pInviter.id],
  });

  assert.equal(controls.isProfileBusy(pActive.id), true);
  assert.equal(controls.isProfileBusy(pInviter.id), true);
  assert.equal(controls.isProfileBusy(pBumper.id), true);
  assert.equal(controls.isProfileBusy(pIdle.id), false);

  const busyIds = new Set([...selected].filter((id) => controls.isProfileBusy(id)));
  const eligibleIds = [...selected].filter((id) => !busyIds.has(id));
  assert.deepEqual(eligibleIds, [pIdle.id]);
});

test('split workspaceApi routes respond for group-inviter, group-bumper, diagnostics/snapshot, diagnostics/reveal, and profiles/stop', async () => {
  const p1 = makeProfile('10000000-0000-4000-8000-000000000021', 'Route Test Browser');
  const stoppedIds: string[] = [];
  let revealedFile = '';

  const registry = new FeatureExecutionRegistry();
  registry.register({
    id: 'group-bumper',
    label: '小组顶贴',
    isProfileRunning: (id) => id === p1.id,
    hasActiveExecution: () => true,
    stopProfiles: async (ids) => {
      stoppedIds.push(...ids);
    },
  });

  const fakeService = {
    snapshot: async () => ({
      profiles: [p1],
      groups: [],
      combinations: [],
    }),
    requireProfiles: async () => undefined,
    stopProfiles: async (ids: string[]) => ids.map((profileId) => ({ profileId, requested: true })),
    repository: {},
  } as unknown as WorkspaceService;

  const fakeBumper = {
    state: async () => ({
      groups: [],
      pages: [],
      settings: {
        searchMode: 'time_sort',
        maxPostAgeHours: 24,
        maxPostsPerGroupPage: 5,
        maxPostsPerPage: 3,
        maxConcurrentProfiles: 4,
        dailyMaxLikesPerAccount: 20,
        maxLikesPerPost: 10,
        likeProbability: 100,
        commentProbability: 30,
        consumeCommentOnUse: false,
      },
      comments: [],
      total: 0,
      running: true,
      statusText: '运行中',
      profileCounts: {
        [p1.id]: { today: 1, session: 1, status: '正在顶贴', running: true },
      },
    }),
    logs: async () => [],
    isProfileRunning: (id: string) => id === p1.id,
  } as unknown as GroupBumperService;

  const fakeInviter = {
    state: async () => ({
      groups: [],
      invitesPerGroup: 20,
      running: false,
      runId: null,
      startedAt: null,
      finishedAt: null,
      statusText: '空闲',
      profileCounts: {},
    }),
    logs: async () => [],
    isProfileRunning: () => false,
  } as unknown as GroupInviterService;

  const handler = workspaceApi(
    fakeService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fakeInviter,
    async (opts) => ({
      filePath: 'C:/tmp/workbench-feedback.zip',
      fileName: 'workbench-feedback.zip',
      sizeBytes: 2048,
      entryId: 42,
      at: opts?.note ?? '2026-10-27T00:00:00.000Z',
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    fakeBumper,
    async (fileName) => {
      revealedFile = fileName ?? '';
      return { filePath: 'C:/tmp/' + (fileName ?? ''), fileName: fileName ?? '' };
    },
    registry,
  );

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const input = raw ? JSON.parse(raw) : undefined;
      const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const handled = await handler(req, res, route, input);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const inviterRes = await fetch(`${baseUrl}/api/workspace/group-inviter/state`);
    assert.equal(inviterRes.status, 200);
    const inviterBody = (await inviterRes.json()) as { statusText: string };
    assert.equal(inviterBody.statusText, '空闲');

    const bumperRes = await fetch(`${baseUrl}/api/workspace/group-bumper/state`);
    assert.equal(bumperRes.status, 200);
    const bumperBody = (await bumperRes.json()) as { running: boolean };
    assert.equal(bumperBody.running, true);

    const snapRes = await fetch(`${baseUrl}/api/workspace/diagnostics/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'split-route-check', uiContext: 'test' }),
    });
    assert.equal(snapRes.status, 200);
    const snapBody = (await snapRes.json()) as { fileName: string; entryId: number };
    assert.equal(snapBody.fileName, 'workbench-feedback.zip');
    assert.equal(snapBody.entryId, 42);

    const revealRes = await fetch(`${baseUrl}/api/workspace/diagnostics/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'workbench-feedback.zip' }),
    });
    assert.equal(revealRes.status, 200);
    const revealBody = (await revealRes.json()) as { revealed: boolean; fileName: string };
    assert.equal(revealBody.revealed, true);
    assert.equal(revealedFile, 'workbench-feedback.zip');

    const stopRes = await fetch(`${baseUrl}/api/workspace/profiles/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileIds: [p1.id] }),
    });
    assert.equal(stopRes.status, 200);
    const stopBody = (await stopRes.json()) as {
      results: { profileId: string; requested: boolean }[];
    };
    assert.deepEqual(stopBody.results, [{ profileId: p1.id, requested: true }]);
    assert.deepEqual(stoppedIds, [p1.id]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
