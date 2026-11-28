import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Locator, Page } from 'playwright-core';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { isWorkAbortError, Workboard } from '../src/application/workboard.js';
import type {
  BumperGroupFeedContext,
  BumperSurface,
} from '../src/infrastructure/group-bumper/bumper-core.js';
import { createGroupSurfaceHelpers } from '../src/infrastructure/group-bumper/bumper-group-setup.js';
import { navigateViaSearchEntry } from '../src/infrastructure/group-bumper/bumper-post-flow.js';
import type { BumperSessionRuntime } from '../src/infrastructure/group-bumper/bumper-session.js';
import { clickInvitationControl } from '../src/infrastructure/group-inviter-runner/inviter-ops.js';
import {
  openAndFillPosterComposer,
  preparePosterTargetSurface,
} from '../src/infrastructure/group-poster-runner/poster-flow.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';

function createDeferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('Workboard.acquireCarrierPermit is reentrant for the same carrier and blocks excess distinct carriers', async () => {
  const wb = new Workboard({ browserConcurrency: 2 });
  const r1a = await wb.acquireCarrierPermit('browser', 'p1');
  const r2 = await wb.acquireCarrierPermit('browser', 'p2');
  assert.equal(wb.browserPermits.used, 2);

  // Reentrant same-carrier permit resolves immediately without consuming an extra permit.
  const r1b = await wb.acquireCarrierPermit('browser', 'p1');
  assert.equal(wb.browserPermits.used, 2);
  assert.equal(wb.hasCarrierPermit('browser', 'p1'), true);

  let p3Acquired = false;
  const p3Promise = wb.acquireCarrierPermit('browser', 'p3').then((rel) => {
    p3Acquired = true;
    return rel;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p3Acquired, false);

  // Releasing only inner reentrant handle keeps permit held; releasing outer frees slot for p3.
  r1b();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p3Acquired, false);
  assert.equal(wb.hasCarrierPermit('browser', 'p1'), true);

  r1a();
  const r3 = await p3Promise;
  assert.equal(p3Acquired, true);
  assert.equal(wb.hasCarrierPermit('browser', 'p1'), false);
  assert.equal(wb.browserPermits.used, 2);

  r2();
  r3();
  assert.equal(wb.browserPermits.used, 0);

  const ac = new AbortController();
  ac.abort('STOP');
  await assert.rejects(() => wb.acquireCarrierPermit('browser', 'p4', ac.signal), isWorkAbortError);
});

test('Poster, Bumper, and Inviter acquire concurrency slots before launching offline browsers', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wb-slot-before-launch-'));
  const store = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    const createControlledLifecycle = (
      online: Set<string>,
      launchedOrder: string[],
    ): ProfileLifecyclePort => ({
      isLaunching: () => false,
      getStatus: async (reqIds) =>
        reqIds.map((profileId) => ({
          profileId,
          browserName: profileId.slice(0, 6),
          action: 'status' as const,
          ok: true,
          online: online.has(profileId),
          phase: online.has(profileId) ? 'PAUSED' : 'OFFLINE',
          synced: online.has(profileId),
          launchable: true,
          elapsedMs: 0,
        })),
      launchProfile: async () => {
        throw Error('unused');
      },
      closeProfile: async () => {
        throw Error('unused');
      },
      restartProfile: async () => {
        throw Error('unused');
      },
      ensureProfilesOnline: async (reqIds) => {
        for (const id of reqIds) {
          launchedOrder.push(id);
          online.add(id);
        }
        return {
          requestedIds: [...reqIds],
          readyIds: [...reqIds],
          launchedIds: [...reqIds],
          failed: [],
          items: [],
        };
      },
    });

    // 1. Poster with maxConcurrentProfiles=1 only launches 1 offline browser while first is active
    {
      const wb = new Workboard({ browserConcurrency: 1, launchConcurrency: 4 });
      await store.groupPoster.saveSettings({
        maxConcurrentProfiles: 1,
        maxPostsPerAccount: 1,
        materialsPerGroup: 1,
      });
      const mat = store.groupPoster.saveMaterials({
        items: [{ caption: 'slot order', mediaSource: '', background: 'plain', selected: true }],
      })[0];
      assert.ok(mat);
      store.groupPoster.upsertTargets({
        items: [
          { id: 'g-1', name: 'G1' },
          { id: 'g-2', name: 'G2' },
          { id: 'g-3', name: 'G3' },
        ],
      });
      const online = new Set<string>();
      const launched: string[] = [];
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      let firstRunning = false;
      const poster = new GroupPosterService(
        store.groupPoster,
        {
          ready: (id) => online.has(id),
          busy: async () => false,
          runProfileWorker: async (_pid, _f, _s, cb) => {
            if (!firstRunning) {
              firstRunning = true;
              firstEntered.resolve();
              await releaseFirst.promise;
            }
            const next = await cb.claimNextTask();
            if (next) {
              await cb.onTaskPosted({
                id: randomUUID(),
                profileId: _pid,
                accountId: 'acc',
                accountName: 'Acc',
                accountAvatar: null,
                identityType: 'personal',
                groupId: next.group.id,
                groupName: next.group.name,
                groupAvatar: null,
                materialId: next.material.id,
                captionPreview: 'slot',
                postId: `post-${next.group.id}`,
                postUrl: 'https://www.facebook.com/groups/g-1/posts/1',
                postedAt: Date.now(),
              });
            }
          },
          stop: async () => {},
        },
        { prepare: async (src) => ({ localFilePath: src, mediaKind: 'none' }) },
      );
      poster.setWorkboard(wb);
      poster.setProfileLifecycle(createControlledLifecycle(online, launched));
      await poster.createTask({
        materialId: mat.id,
        groupIds: ['g-1', 'g-2', 'g-3'],
        accountMode: 'selected',
        profileIds: ids,
      });
      await firstEntered.promise;
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(
        launched.length,
        1,
        'poster must only launch 1 offline browser for concurrency=1',
      );
      releaseFirst.resolve();
      await poster.stop();
    }

    // 2. Bumper with maxConcurrentProfiles=1 only launches 1 offline browser while first is active
    {
      const wb = new Workboard({ browserConcurrency: 1, launchConcurrency: 4 });
      await store.groupBumper.saveSettings({
        searchMode: 'time_sort',
        maxPostAgeHours: 8,
        maxPostsPerGroupPage: 5,
        maxPostsPerPage: 3,
        maxConcurrentProfiles: 1,
        dailyMaxLikesPerAccount: 10,
        maxLikesPerPost: 10,
        likeProbability: 100,
        commentProbability: 0,
        shareToStoryProbability: 0,
        consumeCommentOnUse: false,
        enableSound: false,
        useLongPressReaction: false,
        reactionTypes: ['like'],
      });
      store.groupBumper.upsertTargets('groups', { items: [{ id: 'gb-1', name: 'GB1' }] });
      store.groupBumper.upsertTargets('pages', { items: [{ id: 'pb-1', name: 'PB1' }] });
      const online = new Set<string>();
      const launched: string[] = [];
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      let firstRunning = false;
      const bumper = new GroupBumperService(
        store.groupBumper,
        {
          ready: (id) => online.has(id),
          busy: async () => false,
          run: async () => {
            if (!firstRunning) {
              firstRunning = true;
              firstEntered.resolve();
              await releaseFirst.promise;
            }
          },
          stop: async () => {},
          hasControl: () => false,
        },
        async () => ({ comments: [], total: 0 }),
        () => {},
        undefined,
        0,
      );
      bumper.setWorkboard(wb);
      bumper.setProfileLifecycle(createControlledLifecycle(online, launched));
      await bumper.start({ profileIds: ids, groupIds: ['gb-1'], pageIds: ['pb-1'] });
      await firstEntered.promise;
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(
        launched.length,
        1,
        'bumper must only launch 1 offline browser for concurrency=1',
      );
      releaseFirst.resolve();
      await bumper.stop();
    }

    // 3. Inviter with maxConcurrentProfiles=1 only launches 1 offline browser while first is active
    {
      const wb = new Workboard({ browserConcurrency: 1, launchConcurrency: 4 });
      store.groupInviter.saveSettings({ invitesPerGroup: 5, maxConcurrentProfiles: 1 });
      store.groupInviter.upsertGroups({ items: [{ groupId: 'gi-1', groupName: 'GI1' }] });
      const online = new Set<string>();
      const launched: string[] = [];
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      let firstRunning = false;
      const inviter = new GroupInviterService(store.groupInviter, {
        isAvailable: () => true,
        isProfileReady: (id) => online.has(id),
        isProfileBusy: async () => false,
        inviteForGroup: async () => {
          if (!firstRunning) {
            firstRunning = true;
            firstEntered.resolve();
            await releaseFirst.promise;
          }
        },
      });
      inviter.setWorkboard(wb);
      inviter.setProfileLifecycle(createControlledLifecycle(online, launched));
      await inviter.start({ profileIds: ids, groupIds: ['gi-1'] });
      await firstEntered.promise;
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(
        launched.length,
        1,
        'inviter must only launch 1 offline browser for concurrency=1',
      );
      releaseFirst.resolve();
      await inviter.stop();
    }
  } finally {
    store.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('clickInvitationControl reveals and retries Playwright click before falling back to DOM click', async () => {
  let evaluateCalls = 0;
  let clickCalls = 0;
  const mockLocator = {
    evaluate: async () => {
      evaluateCalls++;
      return undefined;
    },
    click: async () => {
      clickCalls++;
      if (clickCalls === 1) throw Error('Element is outside of the viewport');
    },
  } as unknown as Locator;

  await clickInvitationControl(mockLocator, async () => {
    throw Error('DOM fallback should not be needed when retry succeeds');
  });
  assert.equal(clickCalls, 2);
  assert.equal(evaluateCalls, 2);
});

test('preparePosterTargetSurface reads fresh getPage after reconnect and openAndFillPosterComposer skips clicking editor when caption is empty', async () => {
  const newPageGotos: string[] = [];
  const oldPage = {
    url: () => 'https://www.facebook.com/groups/search/groups/?q=Bible',
    goto: async () => {
      throw Error('page.goto: Target page, context or browser has been closed');
    },
  } as unknown as Page;

  const newPage = {
    url: () => 'https://www.facebook.com/groups/123456/',
    goto: async (url: string) => {
      newPageGotos.push(url);
      return null;
    },
    evaluate: async () => ({
      url: 'https://www.facebook.com/groups/123456/',
      groupIds: ['123456'],
      groupTitle: 'Bible Group',
      avatarUrl: null,
      restricted: false,
      restrictionReason: null,
      welcomeDismissCSS: null,
      joinGroupCSS: null,
      blockingDialog: false,
      posts: [],
      loading: false,
    }),
  } as unknown as Page;

  let activePage: Page = oldPage;
  const prepared = await preparePosterTargetSurface({
    getPage: () => activePage,
    accountId: 'acc-1',
    rawGroupId: '123456',
    initialEffectiveGroupId: '123456',
    initialEffectiveGroupName: 'Bible Group',
    groupAvatarUrl: null,
    isPageTimeline: true,
    identityMeta: { identityType: 'personal', accountAvatar: null },
    paceScale: 0.01,
    bumperRepo: {} as unknown as Parameters<typeof preparePosterTargetSurface>[0]['bumperRepo'],
    callbacks: {
      runId: 'run-1',
      cancelled: () => false,
      status: () => {},
      claimNextTask: async () => null,
      returnTaskOnRestriction: () => {},
      onTaskPosted: async () => {},
      canContinueAccount: async () => true,
    },
    guard: () => {},
    paceWait: async () => {},
    execOp: async (label, work) => {
      if (label === '打开小组页面') {
        activePage = newPage;
      }
      return work();
    },
    updateContext: () => {},
  });
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(newPageGotos, ['https://www.facebook.com/']);

  let editorClicked = false;
  let uploadedPath = '';
  const composerPage = {
    evaluate: async (fn: unknown) => {
      const src = String(fn);
      if (src.includes('data-wb-poster-trigger')) {
        return { ok: true, restricted: false, diag: '' };
      }
      if (src.includes('restrictionRx')) {
        return { hasEditor: true, restrictionText: null };
      }
      if (src.includes('data-wb-poster-editor')) {
        return { hasDialog: true, hasEditor: false };
      }
      return true;
    },
    locator: (sel: string) => ({
      first: () => ({
        evaluate: async () => {},
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {
          if (sel.includes('data-wb-poster-editor')) {
            editorClicked = true;
            throw Error('Should not click stale editor when caption is empty');
          }
        },
      }),
      count: async () => (sel.includes('input[type="file"]') ? 1 : 0),
      nth: () => ({
        getAttribute: async () => 'image/*',
        setInputFiles: async (filePath: string) => {
          uploadedPath = filePath;
        },
      }),
    }),
    keyboard: { insertText: async () => {} },
  } as unknown as Page;

  await openAndFillPosterComposer({
    getPage: () => composerPage,
    accountId: 'acc-1',
    groupDisplayName: 'Bible Group',
    effectiveGroupName: 'Bible Group',
    isPageTimeline: false,
    material: {
      id: 'mat-1',
      caption: '',
      mediaSource: 'https://example.com/a.jpg',
      localFilePath: '/tmp/a.jpg',
      mediaKind: 'image',
      cacheStatus: 'ready',
      cacheError: '',
      selected: true,
      usedCount: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      background: 'plain',
      lastUsedAt: null,
      aiLabel: 'default',
    },
    identityMeta: { identityType: 'personal', accountAvatar: null },
    paceScale: 0.01,
    callbacks: {
      runId: 'run-1',
      cancelled: () => false,
      status: () => {},
      claimNextTask: async () => null,
      returnTaskOnRestriction: () => {},
      onTaskPosted: async () => {},
      canContinueAccount: async () => true,
    },
    guard: () => {},
    execOp: async (_label, work) => work(),
  });
  assert.equal(editorClicked, false);
  assert.equal(uploadedPath, '/tmp/a.jpg');
});

test('bumper dismissWelcomeDialogIfNeeded handles joinRestrictionDismissCSS and navigateViaSearchEntry falls back cleanly on destroyed context', async () => {
  let dialogOpen = true;
  const pressedKeys: string[] = [];
  const fakePage = {
    url: () => 'https://www.facebook.com/groups/search/groups/?q=Test',
    locator: () => ({
      first: () => ({
        evaluate: async () => {},
        click: async () => {
          dialogOpen = false;
        },
      }),
    }),
    evaluate: async () => ({
      url: 'https://www.facebook.com/groups/111/',
      groupIds: ['111'],
      groupTitle: 'Test Group',
      avatarUrl: null,
      restricted: false,
      restrictionReason: null,
      welcomeDismissCSS: null,
      joinRestrictionDismissCSS: dialogOpen ? '[data-wb-bumper-join-dismiss="1"]' : null,
      joinGroupCSS: null,
      blockingDialog: dialogOpen,
      groupJoinState: 'non_member',
      posts: [],
      loading: false,
      checkpointRestricted: false,
    }),
    keyboard: {
      press: async (k: string) => {
        pressedKeys.push(k);
        dialogOpen = false;
      },
    },
  } as unknown as Page;

  let opCalls = 0;
  const mockSession: BumperSessionRuntime = {
    runId: 'r1',
    accountId: 'acc1',
    getPeer: () => ({}) as ReturnType<BumperSessionRuntime['getPeer']>,
    getEpoch: () => 'e1',
    getConn: () => ({}) as ReturnType<BumperSessionRuntime['getConn']>,
    getPage: () => fakePage,
    getPageOrUndefined: () => fakePage,
    guard: () => {},
    isBackgroundAllowed: () => false,
    isCanceledByUserDetach: () => false,
    assertIdentity: async () => {},
    recoverBumperSession: async () => {
      throw Error('recoverBumperSession must not be called on transient search context loss');
    },
    resolveActionProgressOnOpExit: async () => 'NOT_SENT',
    op: (async (_label, work) => {
      opCalls++;
      return work();
    }) as BumperSessionRuntime['op'],
    paceWait: async () => {},
    navigate: async (url) => url,
    searchViaInputOrUrl: async () => {},
    updateAvatar: async () => {},
    updateMetadata: async () => {},
    getOperationContext: () => ({ groupId: '111', groupName: 'Test Group' }),
    setOperationContext: () => {},
    getIssueCount: () => 0,
    reportIssue: () => {},
    getNavigationChain: () => [],
    clearNavigationChain: () => {},
    resetNoProgressRecoveries: () => {},
  };

  const groupCtx: BumperGroupFeedContext = {
    isPageBumperMode: false,
    sourceMode: 'group',
    effectiveGroupId: '111',
    effectiveSearchMode: 'time_sort',
    joinRestrictedFallback: false,
    unjoinableFallbackReason: '',
    group: {
      id: '111',
      name: 'Test Group',
      avatarUrl: null,
      folderId: null,
      sortOrder: 0,
      totalBumpedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    pages: [],
  };

  const helpers = createGroupSurfaceHelpers({
    profileId: 'p1',
    paceScale: 0.01,
    settings: {
      searchMode: 'time_sort',
      maxPostAgeHours: 8,
      maxPostsPerGroupPage: 5,
      maxPostsPerPage: 3,
      maxConcurrentProfiles: 1,
      dailyMaxLikesPerAccount: 10,
      maxLikesPerPost: 10,
      likeProbability: 100,
      commentProbability: 0,
      shareToStoryProbability: 0,
      consumeCommentOnUse: false,
      enableSound: false,
      useLongPressReaction: false,
      reactionTypes: ['like'],
    },
    callbacks: { cancelled: () => false, status: () => {}, added: () => {} },
    session: mockSession,
    groupCtx,
  });

  const dismissed = await helpers.dismissWelcomeDialogIfNeeded({
    url: 'https://www.facebook.com/groups/111/',
    restricted: false,
    restrictionReason: null,
    blockingDialog: true,
    welcomeDismissCSS: null,
    joinRestrictionDismissCSS: '[data-wb-bumper-join-dismiss="1"]',
    groupJoinState: 'non_member',
    posts: [],
  } as unknown as BumperSurface);
  assert.equal(dismissed, true);
  assert.equal(dialogOpen, false);
  assert.equal(opCalls, 1);

  // Now verify navigateViaSearchEntry falls back cleanly when entry.click throws Cannot find context with specified id
  let fallbackUsedUrl = '';
  const searchPage = {
    url: () => 'https://www.facebook.com/groups/search/groups/?q=Bible',
    locator: () => ({
      first: () => ({
        evaluate: async () => {},
        click: async () => {
          throw Error(
            'rpc-error:{"code":-32000,"message":"Cannot find context with specified id"}',
          );
        },
      }),
    }),
    waitForURL: async () => {
      throw Error('timeout');
    },
  } as unknown as Page;

  const searchSession: BumperSessionRuntime = {
    ...mockSession,
    getPage: () => searchPage,
    getPageOrUndefined: () => searchPage,
    navigate: async (url) => {
      fallbackUsedUrl = url;
      return url;
    },
  };

  const navRes = await navigateViaSearchEntry({
    session: searchSession,
    paceScale: 0.01,
    query: 'Bible',
    searchUrl: 'https://www.facebook.com/groups/search/groups/?q=Bible',
    fallbackUrl: 'https://www.facebook.com/groups/111/',
    readSurface: async () =>
      ({
        groupEntryCSS: '[data-wb-entry="1"]',
        posts: [],
      }) as unknown as BumperSurface,
    missingMsg: 'missing',
    urlOk: (u) => /^\/groups\/\d+/i.test(u.pathname),
  });
  assert.equal(navRes.usedFallback, true);
  assert.equal(fallbackUsedUrl, 'https://www.facebook.com/groups/111/');
  assert.equal(pressedKeys.length, 0);
});
