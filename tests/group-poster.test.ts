import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  GroupPosterService,
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
} from '../src/application/group-poster-service.js';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { confirmedBumperGraphQL } from '../src/infrastructure/group-bumper-runner.js';
import { extractCreatedGroupPostIdFromGraphQL } from '../src/infrastructure/group-poster-runner.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  createEmptyMaterialDraft,
  formatPosterCellsForClipboard,
  pastePosterMaterialCells,
} from '../src/domain/poster-material-table.js';
import {
  canPosterMaterialUseColorBackground,
  hasPosterMaterialContent,
} from '../src/shared/group-poster.js';

const tempStores: Array<{ dir: string; store: WorkspaceStore }> = [];
const P001 = '00000000-0000-4000-8000-000000000001';
const P002 = '00000000-0000-4000-8000-000000000002';
const P010 = '00000000-0000-4000-8000-000000000010';
const P011 = '00000000-0000-4000-8000-000000000011';
const P021 = '00000000-0000-4000-8000-000000000021';

async function createTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-wo65-poster-'));
  const dbPath = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(dbPath);
  tempStores.push({ dir, store });
  return { dir, store };
}

afterEach(() => {
  for (const item of tempStores.splice(0, tempStores.length)) {
    try {
      item.store.close();
    } catch {
      // Ignore close race
    }
    try {
      fs.rmSync(item.dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race
    }
  }
});

describe('Work Order #65: Group Poster, Reactions & Page Identity Sync', () => {
  it('deduplicates (group × material), re-dispatches task when one browser is restricted, and stops when all browsers are restricted', async () => {
    const { store } = await createTempStore();
    store.groupPoster.upsertTargets({
      items: [
        { id: '111111111111111', name: 'Group One' },
        { id: '222222222222222', name: 'Group Two' },
      ],
    });
    const savedMaterials = store.groupPoster.saveMaterials({
      items: [
        {
          id: 'mat-1',
          caption: 'Test Burmese Caption 1',
          mediaSource:
            'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link',
          selected: true,
        },
      ],
    });
    assert.equal(savedMaterials.length, 1);

    // Pre-record Group One + mat-1 as already posted so queue deduplication skips it
    store.groupPoster.recordPost({
      id: 'log-existing',
      profileId: P001,
      accountId: '61500000000001',
      accountName: 'Page One',
      accountAvatar: null,
      identityType: 'page',
      groupId: '111111111111111',
      groupName: 'Group One',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'Test Burmese Caption 1',
      postId: '999000111',
      postUrl: 'https://www.facebook.com/groups/111111111111111/posts/999000111/',
      postedAt: Date.now() - 10_000,
    });
    assert.equal(store.groupPoster.hasGroupPostedMaterial('111111111111111', 'mat-1'), true);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('222222222222222', 'mat-1'), false);

    const mediaPreparer: PosterMediaPreparerPort = {
      async prepare() {
        return {
          localFilePath: 'C:\\temp\\cached-video.mp4',
          mediaKind: 'video',
        };
      },
    };

    const claimedByProfile: Array<{ profileId: string; groupId: string }> = [];
    // P001 fails with restriction on first claim; P002 claims the returned task and succeeds
    const runner: GroupPosterBrowserPort = {
      ready: () => true,
      busy: async () => false,
      stop: async () => {},
      async runProfileWorker(
        profileId: string,
        _files: readonly string[],
        _settings,
        callbacks: GroupPosterBrowserCallbacks,
      ) {
        if (profileId === P001) {
          const task = await callbacks.claimNextTask();
          if (task) {
            claimedByProfile.push({ profileId, groupId: task.group.id });
            callbacks.returnTaskOnRestriction(task);
            throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
          }
          return;
        }
        // Delay slightly so P001 claims first and returns the task on restriction
        await new Promise<void>((r) => setTimeout(r, 30));
        while (await callbacks.canContinueAccount(profileId)) {
          const task = await callbacks.claimNextTask();
          if (!task) break;
          claimedByProfile.push({ profileId, groupId: task.group.id });
          await callbacks.onTaskPosted({
            id: 'log-new-2',
            profileId,
            accountId: '61500000000002',
            accountName: 'Page Two',
            accountAvatar: 'data:image/webp;base64,AAAA',
            identityType: 'page',
            groupId: task.group.id,
            groupName: task.group.name,
            groupAvatar: null,
            materialId: task.material.id,
            captionPreview: task.material.caption,
            postId: '888777666',
            postUrl: `https://www.facebook.com/groups/${task.group.id}/posts/888777666/`,
            postedAt: Date.now(),
          });
        }
      },
    };

    const service = new GroupPosterService(store.groupPoster, runner, mediaPreparer);
    await service.start({
      profileIds: [P001, P002],
      groupIds: ['111111111111111', '222222222222222'],
      materialIds: ['mat-1'],
    });

    // Wait for workers to finish
    for (let i = 0; i < 40; i += 1) {
      if (!service.hasActiveExecution()) break;
      await new Promise<void>((r) => setTimeout(r, 25));
    }

    const finalState = await service.state();
    assert.equal(finalState.running, false);
    assert.deepEqual(claimedByProfile, [
      { profileId: P001, groupId: '222222222222222' },
      { profileId: P002, groupId: '222222222222222' },
    ]);
    assert.equal(finalState.profileCounts[P001]?.restricted, true);
    assert.equal(finalState.profileCounts[P001]?.status.includes('受限'), true);
    assert.equal(finalState.profileCounts[P002]?.session, 1);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('222222222222222', 'mat-1'), true);

    // Check profile_task_results recorded FAILED with source 'group-poster' and name '小组发帖'
    const results = store.tasks.runtimeSnapshot().profileResults ?? [];
    const p001Result = results.find((r) => r.profileId === P001);
    assert.equal(p001Result?.source, 'group-poster');
    assert.equal(p001Result?.name, '小组发帖');
    assert.equal(p001Result?.state, 'FAILED');
  });

  it('stops the entire run immediately when all browsers hit restriction', async () => {
    const { store } = await createTempStore();
    store.groupPoster.upsertTargets({
      items: [{ id: '333333333333333', name: 'Group Three' }],
    });
    store.groupPoster.saveMaterials({
      items: [{ id: 'mat-only', caption: 'Hello world', mediaSource: '', selected: true }],
    });
    const mediaPreparer: PosterMediaPreparerPort = {
      async prepare() {
        return { localFilePath: '', mediaKind: 'none' };
      },
    };
    const runner: GroupPosterBrowserPort = {
      ready: () => true,
      busy: async () => false,
      stop: async () => {},
      async runProfileWorker(_profileId, _files, _settings, callbacks) {
        const task = await callbacks.claimNextTask();
        if (task) callbacks.returnTaskOnRestriction(task);
        throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
      },
    };
    const service = new GroupPosterService(store.groupPoster, runner, mediaPreparer);
    await service.start({
      profileIds: [P010, P011],
      groupIds: ['333333333333333'],
      materialIds: ['mat-only'],
    });
    for (let i = 0; i < 40; i += 1) {
      if (!service.hasActiveExecution()) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    const finalState = await service.state();
    assert.equal(finalState.running, false);
    assert.equal(finalState.profileCounts[P010]?.restricted, true);
    assert.equal(finalState.profileCounts[P011]?.restricted, true);
    assert.equal(finalState.statusText.includes('受限'), true);
  });

  it('clears stale personal avatar when switching to a Page (i_user) and preserves cached Page identity in WorkspaceService.snapshot', async () => {
    const { store } = await createTempStore();
    store.updateProfileAccountCache(P021, {
      state: 'logged-in',
      id: '100001111111111',
      name: 'Personal User',
      avatar: 'data:image/webp;base64,OLD_PERSONAL_AVATAR',
    });

    // Switch identity to Page 61580000000021 without avatar yet -> must clear old personal avatar
    store.updateProfileAccountCache(P021, {
      state: 'logged-in',
      id: '61580000000021',
      name: 'My Business Page',
    });
    const afterSwitch = store.profileAccountCache().get(P021);
    assert.equal(afterSwitch?.id, '61580000000021');
    assert.equal(afterSwitch?.name, 'My Business Page');
    assert.equal(afterSwitch?.avatar, null);

    // Subsequent avatar localization updates the Page avatar
    store.updateProfileAccountCache(P021, {
      state: 'logged-in',
      id: '61580000000021',
      name: 'My Business Page',
      avatar: 'data:image/webp;base64,NEW_PAGE_AVATAR',
    });

    const inspection = new ProfileInspectionService(
      {
        connection: () => ({ profileId: P021, connectionEpoch: 'ep-1' }),
        assertIdle: async () => {},
        read: async () => {
          throw Error('NOT_USED');
        },
      },
      () => Date.now(),
    );
    inspection.syncExternalObservation(P021, {
      state: 'logged-in',
      id: '61580000000021',
      name: 'My Business Page',
      avatar: 'data:image/webp;base64,NEW_PAGE_AVATAR',
    });
    assert.equal(inspection.get(P021)?.account.id, '61580000000021');
    assert.equal(inspection.get(P021)?.account.avatar, 'data:image/webp;base64,NEW_PAGE_AVATAR');

    // Even if extension live peer reports state: 'unknown' (e.g. non-Facebook tab), snapshot must keep the cached Page identity
    const ws = new WorkspaceService(store, {
      profiles: async () => [
        {
          id: P021,
          alias: 'Profile 21',
          groupId: null,
          order: 0,
          browserName: 'Profile 21',
          extensionVersion: '0.1.188',
          online: true,
          phase: 'READY',
          synced: true,
          unresolved: 0,
          capabilities: [],
          account: {
            state: 'unknown',
            id: null,
            name: null,
            avatar: null,
          },
        },
      ],
      records: async () => [],
      stop: async () => {},
    });
    const snap = await ws.snapshot();
    const snapProfile = snap.profiles.find((p) => p.id === P021);
    assert.equal(snapProfile?.account.state, 'logged-in');
    assert.equal(snapProfile?.account.id, '61580000000021');
    assert.equal(snapProfile?.account.name, 'My Business Page');
    assert.equal(snapProfile?.account.avatar, 'data:image/webp;base64,NEW_PAGE_AVATAR');
  });

  it('confirms all 7 Facebook reaction types in confirmedBumperGraphQL and extracts post_id from ComposerStoryCreateMutation', () => {
    const reactionTypes = [1, 2, 16, 4, 3, 7, 8];
    for (const rt of reactionTypes) {
      const ok = confirmedBumperGraphQL({
        actorId: '61580000000021',
        feedbackId: 'feedback:123456789012345',
        kind: 'like',
        variables: {
          input: {
            actor_id: '61580000000021',
            feedback_id: 'feedback:123456789012345',
            feedback_reaction: rt,
          },
        },
        status: 200,
        body: JSON.stringify({
          data: {
            feedback_react: {
              feedback: {
                id: 'feedback:123456789012345',
                viewer_feedback_reaction_info: {
                  reaction_type: rt,
                  reaction: { id: String(rt) },
                },
              },
            },
          },
        }),
      });
      assert.equal(ok, true);
    }

    const parsedPost = extractCreatedGroupPostIdFromGraphQL(
      JSON.stringify({
        data: {
          story_create: {
            post_id: '122109876543210',
            story: {
              id: 'UzpfSTEwMDAwOjEyMjEwOTg3NjU0MzIxMA==',
            },
          },
        },
      }),
    );
    assert.equal(parsedPost.postId, '122109876543210');
    assert.equal(parsedPost.restricted, false);
  });

  it('persists background (color/plain), forces plain when mediaSource is non-empty, and handles replaceAll preserving localFilePath & usedCount', async () => {
    const { store } = await createTempStore();
    const initial = store.groupPoster.saveMaterials({
      items: [
        {
          id: 'm-color',
          caption: 'Short colorful post',
          mediaSource: '',
          background: 'color',
          selected: true,
        },
        {
          id: 'm-media',
          caption: 'Video post',
          mediaSource:
            'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link',
          background: 'color',
          selected: true,
        },
        {
          id: 'm-to-remove',
          caption: 'Will be removed',
          mediaSource: '',
          background: 'plain',
          selected: false,
        },
      ],
      replaceAll: true,
    });
    assert.equal(initial.length, 3);
    assert.equal(initial[0]?.background, 'color');
    assert.equal(initial[1]?.background, 'plain');
    assert.equal(
      canPosterMaterialUseColorBackground({
        caption: 'Short colorful post',
        mediaSource: '',
        background: 'color',
      }),
      true,
    );
    assert.equal(
      canPosterMaterialUseColorBackground({
        caption: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
        mediaSource: '',
        background: 'color',
      }),
      false,
    );
    assert.equal(hasPosterMaterialContent({ caption: '', mediaSource: 'C:\\a.mp4' }), true);
    assert.equal(hasPosterMaterialContent({ caption: '   ', mediaSource: '  ' }), false);

    // Simulate cached media and usedCount on m-media
    store.groupPoster.updateMaterialCache('m-media', {
      localFilePath: 'C:\\cache\\video-1.mp4',
      mediaKind: 'video',
      cacheStatus: 'ready',
      cacheError: null,
    });
    store.groupPoster.recordPost({
      id: 'log-used-1',
      profileId: P001,
      accountId: '61500000000001',
      accountName: 'Page One',
      accountAvatar: null,
      identityType: 'page',
      groupId: '111111111111111',
      groupName: 'Group One',
      groupAvatar: null,
      materialId: 'm-media',
      captionPreview: 'Video post',
      postId: '100200300',
      postUrl: 'https://www.facebook.com/groups/111111111111111/posts/100200300/',
      postedAt: Date.now(),
    });

    // Save with replaceAll: true, re-ordering [m-media, m-color] and removing m-to-remove
    const updated = store.groupPoster.saveMaterials({
      items: [
        {
          id: 'm-media',
          caption: 'Video post updated caption',
          mediaSource:
            'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link',
          background: 'plain',
          selected: true,
        },
        {
          id: 'm-color',
          caption: 'Short colorful post',
          mediaSource: '',
          background: 'color',
          selected: true,
        },
      ],
      replaceAll: true,
    });
    assert.equal(updated.length, 2);
    assert.equal(updated[0]?.id, 'm-media');
    assert.equal(updated[0]?.sortOrder, 0);
    assert.equal(updated[0]?.localFilePath, 'C:\\cache\\video-1.mp4');
    assert.equal(updated[0]?.cacheStatus, 'ready');
    assert.equal(updated[0]?.usedCount, 1);
    assert.equal(updated[1]?.id, 'm-color');
    assert.equal(updated[1]?.sortOrder, 1);
    assert.equal(updated[1]?.background, 'color');
  });

  it('pastes 1-4 columns, 5-column Active Accounts TSV, unquoted leading quotes, and horizontal 1xN Excel rows into PosterMaterialMatrix', () => {
    let idCounter = 0;
    const nextId = () => `draft-${++idCounter}`;
    const startRows = [createEmptyMaterialDraft('draft-0')];

    // Paste 5-column TSV copied from Active Accounts (Caption, Media, Background, Purpose, AI Label)
    const fiveColTsv = [
      '彩贴短文案\t\t彩贴\t帖子\t默认',
      '"多行带视频文案\n第二行"\thttps://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link\t彩贴\t通用\t开启',
    ].join('\n');

    const pasted = pastePosterMaterialCells(startRows, 0, 0, fiveColTsv, nextId);
    assert.equal(pasted.length, 2);
    assert.equal(pasted[0]?.caption, '彩贴短文案');
    assert.equal(pasted[0]?.mediaSource, '');
    assert.equal(pasted[0]?.background, 'color');
    assert.equal(pasted[0]?.aiLabel, 'default');
    assert.equal(pasted[1]?.caption, '多行带视频文案\n第二行');
    assert.equal(
      pasted[1]?.mediaSource,
      'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link',
    );
    // Media present -> background forced to 'plain', aiLabel mapped from col 5 ('开启' -> 'on')
    assert.equal(pasted[1]?.background, 'plain');
    assert.equal(pasted[1]?.aiLabel, 'on');

    const formatted = formatPosterCellsForClipboard(pasted, 0, 1, 0, 3);
    assert.equal(formatted.includes('彩贴短文案\t\t彩贴\t默认'), true);

    // Unquoted cell starting with a quote character (e.g. Burmese blessing text) must not throw quote error
    const unquotedLeadingQuote = `"အာမင်" လို့ ရေးခဲ့သူတိုင်း ဘုရားသခင် ကောင်းချီးပေးပါစေ`;
    const pastedQuote = pastePosterMaterialCells(
      [createEmptyMaterialDraft('q-0')],
      0,
      0,
      unquotedLeadingQuote,
      nextId,
    );
    assert.equal(pastedQuote.length, 1);
    assert.equal(pastedQuote[0]?.caption, unquotedLeadingQuote);

    // Horizontal 1x3 Excel row of captions pasted into Column A (col 0) auto-transposes into 3 rows
    const horizontalCaptions = '第一条横向文案\t第二条横向文案\t第三条横向文案';
    const pastedHoriz = pastePosterMaterialCells(
      [createEmptyMaterialDraft('h-0')],
      0,
      0,
      horizontalCaptions,
      nextId,
    );
    assert.equal(pastedHoriz.length, 3);
    assert.equal(pastedHoriz[0]?.caption, '第一条横向文案');
    assert.equal(pastedHoriz[1]?.caption, '第二条横向文案');
    assert.equal(pastedHoriz[2]?.caption, '第三条横向文案');
  });

  it('snapshots personal avatar from profile_account_cache at write time and never overwrites page identity avatar', async () => {
    const { store } = await createTempStore();
    store.updateProfileAccountCache(P021, {
      state: 'logged-in',
      id: '100000123456',
      name: 'Personal User',
      avatar: 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoQABAAgA0JaQAA3AA/vuUAAA==',
    });

    store.groupPoster.recordPost({
      id: 'log-personal-avatar',
      profileId: P021,
      accountId: '100000123456',
      accountName: 'Personal User',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '300000000000001',
      groupName: 'Sample Group',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'Amen',
      postId: '555666776',
      postUrl: 'https://www.facebook.com/groups/300000000000001/posts/555666776/',
      postedAt: Date.now() - 1000,
    });

    store.groupPoster.recordPost({
      id: 'log-page-avatar',
      profileId: P021,
      accountId: '61500000000002',
      accountName: 'Sample Page',
      accountAvatar: 'data:image/webp;base64,REAL_LOCALIZED_PAGE_AVATAR',
      identityType: 'page',
      groupId: '300000000000001',
      groupName: 'Sample Group',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'Amen',
      postId: '555666777',
      postUrl: 'https://www.facebook.com/groups/300000000000001/posts/555666777/',
      postedAt: Date.now(),
    });

    const logs = store.groupPoster.logs();
    const personalLog = logs.find((l) => l.id === 'log-personal-avatar');
    const pageLog = logs.find((l) => l.id === 'log-page-avatar');
    assert.equal(
      store.dataCleanup.recordAvatar('account', '100000123456'),
      'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoQABAAgA0JaQAA3AA/vuUAAA==',
    );
    assert.equal(
      store.dataCleanup.recordAvatar('page', '61500000000002'),
      'data:image/webp;base64,REAL_LOCALIZED_PAGE_AVATAR',
    );
    assert.match(personalLog?.accountAvatar ?? '', /record-avatar\?kind=account/);
    assert.match(pageLog?.accountAvatar ?? '', /record-avatar\?kind=page/);
  });

  it('creates per-post tasks, skips already-posted groups, supports scheduled start with all_online dynamic accounts, and settles partial/failed when restricted or offline', async () => {
    const { store } = await createTempStore();
    store.groupPoster.upsertTargets({
      items: [
        { id: '10001', name: 'Group Alpha' },
        { id: '10002', name: 'Group Beta' },
        { id: '10003', name: 'Group Gamma' },
      ],
    });
    store.groupPoster.saveMaterials({
      items: [
        {
          id: 'mat-card-1',
          caption: 'Per-post task material 1',
          mediaSource: '',
          background: 'color',
          selected: true,
        },
      ],
    });

    // Mark 10001 as already posted for mat-card-1
    store.groupPoster.recordPost({
      id: 'log-alpha-done',
      profileId: P001,
      accountId: '61500001',
      accountName: 'Page A',
      accountAvatar: null,
      identityType: 'page',
      groupId: '10001',
      groupName: 'Group Alpha',
      groupAvatar: null,
      materialId: 'mat-card-1',
      captionPreview: 'Per-post task material 1',
      postId: '111',
      postUrl: 'https://www.facebook.com/groups/10001/posts/111/',
      postedAt: Date.now() - 5000,
    });

    let currentOnline: string[] = [];
    let shouldRestrictAll = false;
    const mediaPreparer: PosterMediaPreparerPort = {
      async prepare() {
        return { localFilePath: '', mediaKind: 'none' };
      },
    };
    const runner: GroupPosterBrowserPort = {
      ready: (id) => currentOnline.includes(id),
      onlineProfileIds: () => [...currentOnline],
      busy: async () => false,
      stop: async () => {},
      async runProfileWorker(profileId, _files, _settings, callbacks) {
        while (await callbacks.canContinueAccount(profileId)) {
          const task = await callbacks.claimNextTask();
          if (!task) break;
          if (shouldRestrictAll) {
            callbacks.returnTaskOnRestriction(task);
            throw new PosterAccountRestrictedError('受限 · 账号暂时无法发帖');
          }
          await callbacks.onTaskPosted({
            id: `log-${profileId}-${task.group.id}`,
            profileId,
            accountId: '61500002',
            accountName: 'Page Dynamic',
            accountAvatar: null,
            identityType: 'page',
            groupId: task.group.id,
            groupName: task.group.name,
            groupAvatar: null,
            materialId: task.material.id,
            captionPreview: task.material.caption,
            postId: `post-${task.group.id}`,
            postUrl: `https://www.facebook.com/groups/${task.group.id}/posts/post-${task.group.id}/`,
            postedAt: Date.now(),
          });
        }
      },
    };

    const service = new GroupPosterService(store.groupPoster, runner, mediaPreparer);

    // 1) Scheduled task when NO browsers are online at trigger time -> marked 'failed'
    const scheduledOffline = await service.createTask({
      materialId: 'mat-card-1',
      groupIds: ['10001', '10002'],
      accountMode: 'all_online',
      profileIds: [],
      scheduledAt: Date.now() + 500,
    });
    const offlineTask = (scheduledOffline.tasks ?? []).find((t) => t.materialId === 'mat-card-1');
    assert.equal(offlineTask?.status, 'scheduled');
    assert.equal(offlineTask?.totalGroups, 1); // 10001 was skipped!
    assert.equal(offlineTask?.skippedCount, 1);

    await service.tickScheduledTasks(Date.now() + 1000);
    const afterOfflineTrigger = await service.state();
    const failedTask = (afterOfflineTrigger.tasks ?? []).find((t) => t.id === offlineTask?.id);
    assert.equal(failedTask?.status, 'failed');
    assert.equal(failedTask?.statusReason.includes('没有在线'), true);

    // 2) Scheduled task with all_online: created while P002 is offline, then P002 comes online at trigger time
    const scheduledOnline = await service.createTask({
      materialId: 'mat-card-1',
      groupIds: ['10001', '10002'],
      accountMode: 'all_online',
      profileIds: [],
      scheduledAt: Date.now() + 2000,
    });
    const onlineTask = (scheduledOnline.tasks ?? []).find((t) => t.status === 'scheduled');
    assert.ok(onlineTask);

    currentOnline = [P002];
    await service.tickScheduledTasks(Date.now() + 2500);
    for (let i = 0; i < 40; i += 1) {
      if (!service.hasActiveExecution()) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    const afterOnlineRun = await service.state();
    const completedTask = (afterOnlineRun.tasks ?? []).find((t) => t.id === onlineTask.id);
    assert.equal(completedTask?.status, 'completed');
    assert.equal(completedTask?.postedCount, 1);
    assert.deepEqual(afterOnlineRun.postedGroupIdsByMaterial?.['mat-card-1']?.sort(), [
      '10001',
      '10002',
    ]);

    // 3) Immediate task on 10003 when all accounts hit restriction -> settled as 'failed'
    shouldRestrictAll = true;
    await service.createTask({
      materialId: 'mat-card-1',
      groupIds: ['10003'],
      accountMode: 'all_online',
      profileIds: [],
      scheduledAt: null,
    });
    for (let i = 0; i < 40; i += 1) {
      if (!service.hasActiveExecution()) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    const afterRestrictState = await service.state();
    const latestTask = (afterRestrictState.tasks ?? [])[0];
    assert.equal(latestTask?.status, 'failed');
  });

  it('merges overlapping tasks for the same post without duplicate posting', async () => {
    const { store } = await createTempStore();
    store.groupPoster.upsertTargets({
      items: [
        { id: '20001', name: 'Overlap Group 1' },
        { id: '20002', name: 'Overlap Group 2' },
      ],
    });
    store.groupPoster.saveMaterials({
      items: [
        {
          id: 'mat-overlap',
          caption: 'Overlap test post',
          mediaSource: '',
          background: 'plain',
          selected: true,
        },
      ],
    });

    const postedGroups: string[] = [];
    let releaseFirstPost!: () => void;
    const firstPostGate = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });

    const mediaPreparer: PosterMediaPreparerPort = {
      async prepare() {
        return { localFilePath: '', mediaKind: 'none' };
      },
    };
    const runner: GroupPosterBrowserPort = {
      ready: () => true,
      onlineProfileIds: () => [P001, P002],
      busy: async () => false,
      stop: async () => {},
      async runProfileWorker(profileId, _files, _settings, callbacks) {
        while (await callbacks.canContinueAccount(profileId)) {
          const task = await callbacks.claimNextTask();
          if (!task) break;
          await firstPostGate;
          postedGroups.push(task.group.id);
          await callbacks.onTaskPosted({
            id: `log-ov-${task.group.id}-${Date.now()}`,
            profileId,
            accountId: '61500099',
            accountName: 'Overlap Page',
            accountAvatar: null,
            identityType: 'page',
            groupId: task.group.id,
            groupName: task.group.name,
            groupAvatar: null,
            materialId: task.material.id,
            captionPreview: task.material.caption,
            postId: `p-${task.group.id}`,
            postUrl: `https://www.facebook.com/groups/${task.group.id}/posts/p-${task.group.id}/`,
            postedAt: Date.now(),
          });
        }
      },
    };

    const service = new GroupPosterService(store.groupPoster, runner, mediaPreparer);

    // Task A starts on [20001, 20002] with P001
    await service.createTask({
      materialId: 'mat-overlap',
      groupIds: ['20001', '20002'],
      accountMode: 'selected',
      profileIds: [P001],
      scheduledAt: null,
    });

    // While Task A is still in-flight/queued, Task B starts on [20001, 20002] with P002
    await service.createTask({
      materialId: 'mat-overlap',
      groupIds: ['20001', '20002'],
      accountMode: 'selected',
      profileIds: [P002],
      scheduledAt: null,
    });

    // Check activeGroupsByMaterial while in-flight
    const midState = await service.state();
    assert.equal((midState.activeGroupsByMaterial?.['mat-overlap'] ?? []).length, 2);

    releaseFirstPost();
    for (let i = 0; i < 40; i += 1) {
      if (!service.hasActiveExecution()) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // Each group must only be posted ONCE!
    assert.deepEqual([...postedGroups].sort(), ['20001', '20002']);
    const endState = await service.state();
    for (const t of endState.tasks ?? []) {
      assert.equal(t.status, 'completed');
      assert.equal(t.postedCount, 2);
    }
  });
});
