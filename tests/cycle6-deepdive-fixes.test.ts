import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  BluestacksService,
  type BluestacksDeviceController,
  type BluestacksServiceRepository,
} from '../src/application/bluestacks-service.js';
import {
  GroupPosterService,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
} from '../src/application/group-poster-service.js';
import { mediaReference } from '../src/domain/resource-table.js';
import type { BluestacksDeviceManager } from '../src/infrastructure/bluestacks-device-manager.js';
import { BluestacksGroupPosterRunner } from '../src/infrastructure/bluestacks-poster-runner.js';
import { relativePostAge } from '../src/infrastructure/group-bumper-effects.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  AutoSchedule,
  computeDueScheduleTriggers,
  SaveAutoScheduleInput,
} from '../src/shared/auto-scheduler.js';
import type { BluestacksInstance } from '../src/shared/bluestacks.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';
import {
  formatPosterCaptionPreview,
  isPendingApprovalPostId,
  type PosterMaterial,
} from '../src/shared/group-poster.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';

const tempDirs: Array<{ dir: string; store?: WorkspaceStore }> = [];
const P001 = '00000000-0000-4000-8000-000000000201';
const SCHED_1 = '00000000-0000-4000-8000-000000000301';
const SCHED_2 = '00000000-0000-4000-8000-000000000302';
const STEP_1 = '00000000-0000-4000-8000-000000000401';
const STEP_2 = '00000000-0000-4000-8000-000000000402';
const MAT_UUID = '00000000-0000-4000-8000-000000000501';
const BS_1 = '00000000-0000-4000-8000-000000000601';
const BS_2 = '00000000-0000-4000-8000-000000000602';
const BS_3 = '00000000-0000-4000-8000-000000000603';

async function openTempStore(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  tempDirs.push({ dir, store });
  return { dir, store };
}

afterEach(() => {
  for (const entry of tempDirs.splice(0, tempDirs.length)) {
    try {
      entry.store?.close();
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});

describe('Cycle 6 Deep-Dive Fixes Regression Suite', () => {
  it('AutoScheduler computeDueScheduleTriggers never back-fires slots earlier than createdAt/updatedAt and clamps prewarm jitter', () => {
    // 2026-11-22 13:30:19 Asia/Shanghai (created 90 min AFTER the 12:00 slot!)
    const createdAt = new Date('2026-11-22T13:30:19+08:00').getTime();
    const tickNow = createdAt + 5_000;
    const rule = AutoSchedule.parse({
      id: SCHED_1,
      name: '午间定时',
      enabled: true,
      carrier: 'browser',
      targetSelector: { mode: 'explicit', groupIds: [], targetIds: [P001] },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['12:00', '19:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
      },
      prewarm: { enabled: false, leadMinutes: 60, steps: [] },
      steps: [{ id: STEP_1, type: 'quick-browse', target: 'feed', durationMinutes: 5 }],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: 60,
      sortOrder: 0,
      createdAt,
      updatedAt: createdAt,
    });

    const due = computeDueScheduleTriggers(rule, tickNow, new Set());
    assert.equal(due.length, 0, 'Must NOT back-fire the 12:00 slot created at 13:30');

    // Verify prewarm jitter clamp: main slot at 19:00, leadMinutes=20, jitterMinutes=20
    const ruleWithJitter = AutoSchedule.parse({
      ...rule,
      id: SCHED_2,
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['19:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 20,
      },
      prewarm: {
        enabled: true,
        leadMinutes: 20,
        steps: [{ id: STEP_2, type: 'quick-browse', target: 'feed', durationMinutes: 3 }],
      },
      createdAt: new Date('2026-11-22T10:00:00+08:00').getTime(),
      updatedAt: new Date('2026-11-22T10:00:00+08:00').getTime(),
    });
    const atPrewarmCheck = new Date('2026-11-22T18:52:00+08:00').getTime();
    const duePrewarm = computeDueScheduleTriggers(ruleWithJitter, atPrewarmCheck, new Set()).filter(
      (d) => d.phase === 'prewarm',
    );
    for (const trigger of duePrewarm) {
      assert.ok(
        trigger.scheduledFor < trigger.mainScheduledFor,
        'Clamped prewarm scheduledFor must remain strictly before mainScheduledFor',
      );
    }
  });

  it('BluestacksGroupPosterStep schema rejects empty groupIds unless postToTimeline is true', () => {
    const base = {
      name: '蓝蝶排班发帖',
      enabled: true,
      carrier: 'bluestacks' as const,
      targetSelector: { mode: 'explicit' as const, groupIds: [], targetIds: [BS_1] },
      trigger: {
        weekdays: [1, 2, 3, 4, 5],
        times: ['10:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
      },
      prewarm: { enabled: false as const, leadMinutes: 90, steps: [] },
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: 60,
    };

    const emptyGroupsNoTimeline = SaveAutoScheduleInput.safeParse({
      ...base,
      steps: [
        {
          id: STEP_1,
          type: 'bluestacks-group-poster',
          materialIds: [MAT_UUID],
          groupIds: [],
          maxGroupsPerProfile: 3,
          postToTimeline: false,
        },
      ],
    });
    assert.equal(emptyGroupsNoTimeline.success, false);

    const emptyGroupsWithTimeline = SaveAutoScheduleInput.safeParse({
      ...base,
      steps: [
        {
          id: STEP_2,
          type: 'bluestacks-group-poster',
          materialIds: [MAT_UUID],
          groupIds: [],
          maxGroupsPerProfile: 3,
          postToTimeline: true,
        },
      ],
    });
    assert.equal(emptyGroupsWithTimeline.success, true);
  });

  it('Shared poster helpers handle Burmese/legacy pending postIds, sanitize Windows paths, parse Burmese age, and accept .gif', () => {
    assert.equal(isPendingApprovalPostId('pending_approval'), true);
    assert.equal(isPendingApprovalPostId('pending-1793675146196'), true);
    assert.equal(isPendingApprovalPostId('122145678901234'), false);

    const previewImg = formatPosterCaptionPreview('', 'D:\\专页组\\秘密路径\\promo.jpg', 'image');
    assert.ok(!previewImg.includes('D:\\'), 'Caption preview must never leak local drive paths');
    assert.equal(previewImg, '[图片贴文]');

    const previewPathOnly = formatPosterCaptionPreview('', 'D:\\专页组\\clip.mp4', undefined);
    assert.equal(previewPathOnly, '[视频] clip.mp4');

    assert.equal(relativePostAge('ယခုလေးတင်'), 0);
    assert.equal(relativePostAge('5 မိနစ်'), 5 / 60);
    assert.equal(relativePostAge('2 နာရီ'), 2);
    assert.equal(relativePostAge('vừa xong'), 0);

    const gifRef = mediaReference('D:\\media\\banner.gif');
    assert.equal(gifRef.mediaType, 'image');
  });

  it('GroupPosterService.createTask rejects all-already-posted groups (409), breaks offline pending-stop deadlock, and defers busy scheduled tasks', async () => {
    const { store } = await openTempStore('wb-c6-poster-');
    store.groupPoster.upsertTargets({ items: [{ id: '1001', name: 'Test Group' }] });
    const savedMats = store.groupPoster.saveMaterials({
      items: [{ id: 'mat-c6-1', caption: 'Hello world', mediaSource: '', background: 'plain' }],
      replaceAll: true,
    });
    const mat = savedMats[0];
    assert.ok(mat);

    store.groupPoster.recordPost({
      id: randomUUID(),
      profileId: P001,
      accountId: 'acc-1',
      accountName: 'Tester',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '1001',
      groupName: 'Test Group',
      groupAvatar: null,
      materialId: mat.id,
      captionPreview: 'Hello world',
      postId: '987654321',
      postUrl: 'https://www.facebook.com/groups/1001/posts/987654321/',
      postedAt: Date.now() - 1000,
    });

    let launchedOfflineIds: string[] = [];
    let profileBusyFlag = false;
    let profileOnlineFlag = false;
    let pendingReconnectStopFlag = true;

    const fakeRunner: GroupPosterBrowserPort = {
      ready: () => profileOnlineFlag,
      busy: async () => profileBusyFlag || pendingReconnectStopFlag,
      hasPendingReconnectStop: () => pendingReconnectStopFlag && !profileOnlineFlag,
      runProfileWorker: async () => {},
      stop: async () => {},
    };
    const fakeMedia: PosterMediaPreparerPort = {
      prepare: async (src) => ({ localFilePath: src, mediaKind: 'none' }),
    };

    const service = new GroupPosterService(store.groupPoster, fakeRunner, fakeMedia);
    const fakeLifecycle: ProfileLifecyclePort = {
      isLaunching: () => false,
      getStatus: async () => [],
      launchProfile: async () => {
        throw Error('unused');
      },
      closeProfile: async () => {
        throw Error('unused');
      },
      restartProfile: async () => {
        throw Error('unused');
      },
      ensureProfilesOnline: async (ids) => {
        launchedOfflineIds = [...ids];
        profileOnlineFlag = true;
        pendingReconnectStopFlag = false;
        return {
          requestedIds: [...ids],
          readyIds: [...ids],
          launchedIds: [...ids],
          failed: [],
          items: [],
        };
      },
    };
    service.setProfileLifecycle(fakeLifecycle);

    await assert.rejects(
      service.createTask({
        materialId: mat.id,
        groupIds: ['1001'],
        accountMode: 'selected',
        profileIds: [P001],
      }),
      /已全部发过该贴文/,
    );

    store.groupPoster.upsertTargets({ items: [{ id: '1002', name: 'Group Two' }] });
    await service.createTask({
      materialId: mat.id,
      groupIds: ['1002'],
      accountMode: 'selected',
      profileIds: [P001],
    });
    assert.deepEqual(
      launchedOfflineIds,
      [P001],
      'dispatchTask must wake offline Chrome when only holding a pending reconnect-stop',
    );
    await service.stop();

    store.groupPoster.upsertTargets({ items: [{ id: '1003', name: 'Group Three' }] });
    profileOnlineFlag = true;
    profileBusyFlag = true;
    const now = Date.now();
    await service.createTask({
      materialId: mat.id,
      groupIds: ['1003'],
      accountMode: 'selected',
      profileIds: [P001],
      scheduledAt: now + 60_000,
    });
    const tasksBefore = store.groupPoster.listTasks(10);
    const schedTask = tasksBefore.find((t) => t.groupIds.includes('1003'));
    assert.ok(schedTask);
    await service.tickScheduledTasks((schedTask.scheduledAt ?? now) + 1000);
    const afterTask = store.groupPoster.listTasks(10).find((t) => t.id === schedTask.id);
    assert.equal(afterTask?.status, 'scheduled', 'Transient busy scheduled task must be deferred');
    assert.ok(
      (afterTask?.scheduledAt ?? 0) > now,
      'Deferred scheduled task must move scheduledAt forward',
    );
    await service.shutdown();
  });

  it('BluestacksService.startPoster splits groups atomically across 3 emulators with zero duplicate spam and honors DB dedup', async () => {
    const postedHistory = new Set<string>([`g1::${MAT_UUID}`]);
    const claimedCalls: Array<{ instId: string; groupId: string; materialId: string }> = [];

    const makeInst = (id: string, suffix: string): BluestacksInstance => ({
      id,
      instanceKey: `bs-${suffix}`,
      displayName: `BS-${suffix}`,
      alias: null,
      serial: `127.0.0.1:555${suffix}`,
      adbPort: 5555,
      online: true,
      fbWidth: 900,
      fbHeight: 1600,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: `acc-${suffix}`,
      numericAccountId: `10000${suffix}`,
      accountName: `User ${suffix}`,
      avatarUrl: null,
      identityType: 'personal',
      managedIdentities: [],
      folderId: null,
      sortOrder: 0,
      lastStatus: null,
      updatedAt: Date.now(),
    });

    const instances = [makeInst(BS_1, '1'), makeInst(BS_2, '2'), makeInst(BS_3, '3')];
    const groups: BumperTarget[] = ['g1', 'g2', 'g3', 'g4'].map((id) => ({
      id,
      name: `Group ${id}`,
      avatarUrl: null,
      folderId: null,
      sortOrder: 0,
      totalBumpedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }));
    const materials: PosterMaterial[] = [
      {
        id: MAT_UUID,
        caption: 'Shared post',
        mediaSource: '',
        background: 'plain',
        localFilePath: null,
        mediaKind: 'none',
        cacheStatus: 'ready',
        cacheError: null,
        selected: true,
        usedCount: 0,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const repo: BluestacksServiceRepository = {
      savedSettings: () => ({
        installDir: 'C:\\BS',
        confPath: 'C:\\BS\\bs.conf',
        bumperSettings: BumperSettings.parse({}),
      }),
      savePaths: () => ({
        installDir: 'C:\\BS',
        confPath: 'C:\\BS\\bs.conf',
        bumperSettings: BumperSettings.parse({}),
      }),
      saveBumperSettings: () => BumperSettings.parse({}),
      folders: () => [],
      createFolder: () => {
        throw Error('unused');
      },
      renameFolder: () => {
        throw Error('unused');
      },
      deleteFolder: () => {},
      reorderFolders: () => {},
      listInstances: () => instances,
      getInstance: (id) => instances.find((i) => i.id === id) ?? null,
      saveLastStatus: () => {},
      renameInstance: () => {
        throw Error('unused');
      },
      reorderInstances: () => {},
      deleteInstances: () => 0,
      targets: () => groups,
      todayCounts: () => ({}),
      total: () => 0,
      weeklyDailyCounts: () => [],
    };
    const devices: BluestacksDeviceController = {
      getOnlineKeys: () => new Set(instances.map((i) => i.instanceKey)),
      discoverInstances: async () => ({
        instances,
        config: {
          installDir: 'C:\\BS',
          confPath: 'C:\\BS\\bs.conf',
          detectedInstallDir: 'C:\\BS',
          detectedConfPath: 'C:\\BS\\bs.conf',
          adbReady: true,
          playerReady: true,
        },
      }),
      launchInstance: async (id) => {
        const found = instances.find((i) => i.id === id);
        if (!found) throw Error('missing');
        return found;
      },
      closeInstance: async () => {},
      inspectAccount: async (id) => {
        const found = instances.find((i) => i.id === id);
        if (!found) throw Error('missing');
        return found;
      },
    };

    const service = new BluestacksService(repo, devices, { run: async () => {} }, undefined, {
      listPosterMaterials: () => materials,
      hasGroupPostedMaterial: (gid, mid) => postedHistory.has(`${gid}::${mid}`),
      posterRunner: {
        run: async (instId, _mats, _grps, options, _signal, callbacks) => {
          let posted = 0;
          for (let i = 0; i < options.maxGroupsPerInstance; i++) {
            const job = await options.claimNextGroupJob?.();
            if (!job) break;
            claimedCalls.push({ instId, groupId: job.group.id, materialId: job.material.id });
            await new Promise((r) => setTimeout(r, 15));
            posted++;
            callbacks.posted();
            options.releaseGroupJob?.(job.group.id, job.material.id, true);
          }
          return { posted, skipped: 0, notes: [] };
        },
      },
    });

    await service.startPoster({
      instanceIds: [BS_1, BS_2, BS_3],
      materialIds: [MAT_UUID],
      groupIds: ['g1', 'g2', 'g3', 'g4'],
      maxGroupsPerInstance: 3,
      postToTimeline: false,
    });

    const deadline = Date.now() + 3000;
    while (service.hasExtraExecution('poster') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const claimedGroupIds = claimedCalls.map((c) => c.groupId).sort();
    assert.deepEqual(
      claimedGroupIds,
      ['g2', 'g3', 'g4'],
      'g1 must be skipped by DB dedup, and g2/g3/g4 must each be posted EXACTLY ONCE across all 3 emulators',
    );
  });

  it('BluestacksGroupPosterRunner aborts cleanly when mediaSource is non-empty and local file is missing', async () => {
    const inst: BluestacksInstance = {
      id: 'bs-missing-media',
      instanceKey: 'bs-missing-media',
      displayName: 'BS1',
      alias: null,
      serial: '127.0.0.1:5555',
      adbPort: 5555,
      online: true,
      fbWidth: 900,
      fbHeight: 1600,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: 'acc-1',
      numericAccountId: '10001',
      accountName: 'Test',
      avatarUrl: null,
      identityType: 'personal',
      managedIdentities: [],
      folderId: null,
      sortOrder: 0,
      lastStatus: null,
      updatedAt: Date.now(),
    };
    let pasteCalled = false;
    const fakeDevices = {
      ensureReadyAndLoggedIn: async () => inst,
      openDeepLink: async () => {},
      dumpXml: async () => ({
        index: 0,
        text: '',
        resourceId: '',
        className: 'android.widget.FrameLayout',
        packageName: 'com.facebook.lite',
        contentDesc: '',
        clickable: false,
        longClickable: false,
        focused: false,
        scrollable: false,
        bounds: { x1: 0, y1: 0, x2: 900, y2: 1600, w: 900, h: 1600, cx: 450, cy: 800 },
        children: [
          {
            index: 1,
            text: '',
            resourceId: '',
            className: 'android.widget.EditText',
            packageName: 'com.facebook.lite',
            contentDesc: '',
            clickable: true,
            longClickable: false,
            focused: false,
            scrollable: false,
            bounds: { x1: 40, y1: 200, x2: 860, y2: 400, w: 820, h: 200, cx: 450, cy: 300 },
            children: [],
          },
        ],
      }),
      screencap: async () => Buffer.alloc(16),
      detectAbnormalScreen: async () => null,
      tap900: async () => {},
      keyevent: async () => {},
      pasteIntoFocused: async () => {
        pasteCalled = true;
      },
      cleanupPushedMedia: async () => {},
    } as unknown as BluestacksDeviceManager;

    const runner = new BluestacksGroupPosterRunner(fakeDevices, {
      recognizeBounds: async () => '',
      close: () => {},
    });

    const missingMaterial: PosterMaterial = {
      id: 'mat-missing',
      caption: 'Should never publish without media!',
      mediaSource: 'https://drive.google.com/file/d/abc123/view',
      background: 'plain',
      localFilePath: path.join(os.tmpdir(), 'definitely-missing-file-' + randomUUID() + '.mp4'),
      mediaKind: 'video',
      cacheStatus: 'ready',
      cacheError: null,
      selected: true,
      usedCount: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    const outcome = await runner.run(
      inst.id,
      [missingMaterial],
      [],
      { maxGroupsPerInstance: 0, postToTimeline: true },
      new AbortController().signal,
      { status: () => {}, posted: () => {} },
    );

    assert.equal(outcome.posted, 0);
    assert.equal(outcome.skipped, 1);
    assert.equal(pasteCalled, false, 'Must abort BEFORE pasting caption or publishing');
    assert.ok(outcome.notes[0]?.includes('媒体文件缺失'), `Unexpected note: ${outcome.notes[0]}`);
  });
});
