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

  it('pastes 1-3 columns and 5-column Active Accounts TSV into PosterMaterialMatrix', () => {
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
    assert.equal(pasted[1]?.caption, '多行带视频文案\n第二行');
    assert.equal(
      pasted[1]?.mediaSource,
      'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link',
    );
    // Media present -> background forced to 'plain'
    assert.equal(pasted[1]?.background, 'plain');

    const formatted = formatPosterCellsForClipboard(pasted, 0, 1, 0, 2);
    assert.equal(formatted.includes('彩贴短文案\t\t彩贴'), true);
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
      groupId: '3017439278594998',
      groupName: 'Myanmar Group',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'Amen',
      postId: '555666776',
      postUrl: 'https://www.facebook.com/groups/3017439278594998/posts/555666776/',
      postedAt: Date.now() - 1000,
    });

    store.groupPoster.recordPost({
      id: 'log-page-avatar',
      profileId: P021,
      accountId: '61594502274210',
      accountName: 'Hub of Spiritual Strength',
      accountAvatar: 'data:image/webp;base64,REAL_LOCALIZED_PAGE_AVATAR',
      identityType: 'page',
      groupId: '3017439278594998',
      groupName: 'Myanmar Group',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'Amen',
      postId: '555666777',
      postUrl: 'https://www.facebook.com/groups/3017439278594998/posts/555666777/',
      postedAt: Date.now(),
    });

    const logs = store.groupPoster.logs();
    const personalLog = logs.find((l) => l.id === 'log-personal-avatar');
    const pageLog = logs.find((l) => l.id === 'log-page-avatar');
    assert.equal(
      personalLog?.accountAvatar,
      'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoQABAAgA0JaQAA3AA/vuUAAA==',
    );
    assert.equal(pageLog?.accountAvatar, 'data:image/webp;base64,REAL_LOCALIZED_PAGE_AVATAR');
  });
});
