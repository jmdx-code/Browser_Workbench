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
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import {
  GroupPosterService,
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
} from '../src/application/group-poster-service.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { BluestacksGroupBumperRunner } from '../src/infrastructure/bluestacks-bumper-runner.js';
import type { BluestacksDeviceManager } from '../src/infrastructure/bluestacks-device-manager.js';
import { deterministicBluestacksId } from '../src/infrastructure/bluestacks-store.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { inspectionPresentation } from '../src/renderer/inspection-presentation.js';
import { isValidTotpSecret, type BluestacksInstance } from '../src/shared/bluestacks.js';
import { profileDisplayName } from '../src/shared/contracts.js';
import { BumperSettings } from '../src/shared/group-bumper.js';

const tempDirs: Array<{ dir: string; store?: WorkspaceStore }> = [];
const P001 = '00000000-0000-4000-8000-000000000101';
const P002 = '00000000-0000-4000-8000-000000000102';
const P003 = '00000000-0000-4000-8000-000000000103';

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
      // Ignore close race
    }
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race
    }
  }
});

describe('Cycle 5 Top-Down Fixes Regression Suite', () => {
  it('WorkspaceService.snapshot propagates custom alias to browserName while keeping original name when unrenamed', async () => {
    const { store } = await openTempStore('wb-c5-alias-');
    const svc = new WorkspaceService(store, {
      profiles: async () => [
        {
          id: P001,
          browserName: 'Original Chrome 1',
          alias: 'Original Chrome 1',
          groupId: null,
          order: 0,
          online: false,
          phase: 'OFFLINE',
          synced: true,
          unresolved: 0,
          extensionVersion: null,
          capabilities: [],
          account: { state: 'unknown', id: null, name: null, avatar: null },
        },
        {
          id: P002,
          browserName: 'Original Chrome 2',
          alias: 'Original Chrome 2',
          groupId: null,
          order: 1,
          online: false,
          phase: 'OFFLINE',
          synced: true,
          unresolved: 0,
          extensionVersion: null,
          capabilities: [],
          account: { state: 'unknown', id: null, name: null, avatar: null },
        },
      ],
      records: async () => [],
      stop: async () => {},
    });

    await svc.renameProfile(P001, 'Custom Alias One');
    const snap = await svc.snapshot();
    const p1 = snap.profiles.find((p) => p.id === P001);
    const p2 = snap.profiles.find((p) => p.id === P002);
    assert.equal(p1?.alias, 'Custom Alias One');
    assert.equal(p1?.browserName, 'Custom Alias One');
    assert.equal(p2?.alias, 'Original Chrome 2');
    assert.equal(p2?.browserName, 'Original Chrome 2');
  });

  it('GroupPosterStore.deleteLogs clears settled VERIFIED poster operations to unlock re-posting while preserving PENDING_REVIEW', async () => {
    const { store } = await openTempStore('wb-c5-poster-del-');
    const mat = store.groupPoster.saveMaterials({
      items: [{ caption: 'Hello world post' }],
    })[0];
    assert.ok(mat);
    store.groupPoster.upsertTargets({
      items: [
        { id: '111111111111', name: 'Group A' },
        { id: '222222222222', name: 'Group B' },
      ],
    });

    const verifiedOpId = randomUUID();
    const pendingOpId = randomUUID();
    const logId = randomUUID();
    const now = Date.now();

    store.groupPoster.recordPost({
      id: logId,
      profileId: P001,
      accountId: '100001',
      accountName: 'Acc 1',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '111111111111',
      groupName: 'Group A',
      groupAvatar: null,
      materialId: mat.id,
      captionPreview: 'Hello world post',
      postId: '9876543210',
      postUrl: 'https://www.facebook.com/groups/111111111111/posts/9876543210/',
      postedAt: now,
    });
    store.groupPoster.prepareOperation({
      binding: {
        profileId: P001,
        accountId: '100001',
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 1,
        operationId: verifiedOpId,
        jobId: randomUUID(),
        stepId: 's1',
        actionDigest: 'dig-v',
      },
      runId: randomUUID(),
      actionKind: 'submit_post',
      groupId: '111111111111',
      groupName: 'Group A',
      materialId: mat.id,
      postId: '9876543210',
      postUrl: 'https://www.facebook.com/groups/111111111111/posts/9876543210/',
      logId,
    });
    store.groupPoster.setOperationResolution(verifiedOpId, {
      id: randomUUID(),
      outcome: 'VERIFIED',
      evidenceDigest: 'ev-1',
    });
    store.groupPoster.markOperationKernelSettled(verifiedOpId);

    store.groupPoster.prepareOperation({
      binding: {
        profileId: P001,
        accountId: '100001',
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 1,
        operationId: pendingOpId,
        jobId: randomUUID(),
        stepId: 's2',
        actionDigest: 'dig-p',
      },
      runId: randomUUID(),
      actionKind: 'submit_post',
      groupId: '222222222222',
      groupName: 'Group B',
      materialId: mat.id,
    });
    store.groupPoster.setOperationResolution(pendingOpId, {
      id: randomUUID(),
      outcome: 'ENDED_UNKNOWN',
      evidenceDigest: 'ev-2',
    });

    assert.equal(store.groupPoster.hasGroupPostedMaterial('111111111111', mat.id), true);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('222222222222', mat.id), true);

    store.groupPoster.deleteLogs({ all: true });

    // Group A (settled VERIFIED) is now unlocked; Group B (PENDING_REVIEW) stays protected!
    assert.equal(store.groupPoster.hasGroupPostedMaterial('111111111111', mat.id), false);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('222222222222', mat.id), true);
  });

  it('GroupPosterService all_online mode does not re-spawn restricted, quota-exhausted, or manually stopped profiles', async () => {
    const { store } = await openTempStore('wb-c5-poster-allonline-');
    const mat = store.groupPoster.saveMaterials({
      items: [{ caption: 'All online guard test' }],
    })[0];
    assert.ok(mat);
    store.groupPoster.upsertTargets({
      items: [
        { id: '300000000001', name: 'G1' },
        { id: '300000000002', name: 'G2' },
        { id: '300000000003', name: 'G3' },
        { id: '300000000004', name: 'G4' },
      ],
    });
    store.groupPoster.saveSettings({
      ...store.groupPoster.settings(),
      maxPostsPerAccount: 1,
      maxConcurrentProfiles: 3,
    });

    const spawnCounts = new Map<string, number>();
    const hooks = {
      releaseP3: () => {},
      markP3Entered: () => {},
    };
    const p3Entered = new Promise<void>((resolve) => {
      hooks.markP3Entered = resolve;
    });

    const runner: GroupPosterBrowserPort = {
      ready: () => true,
      busy: async () => false,
      onlineProfileIds: async () => [P001, P002, P003],
      stop: async () => {
        hooks.releaseP3();
      },
      runProfileWorker: async (pid: string, _files, _settings, cb: GroupPosterBrowserCallbacks) => {
        spawnCounts.set(pid, (spawnCounts.get(pid) ?? 0) + 1);
        if (pid === P001) {
          const t = await cb.claimNextTask();
          if (t) cb.returnTaskOnRestriction(t);
          throw new PosterAccountRestrictedError('账号操作受限');
        }
        if (pid === P002) {
          const t = await cb.claimNextTask();
          if (t) {
            await cb.onTaskPosted({
              id: randomUUID(),
              profileId: pid,
              accountId: 'acc-2',
              accountName: 'Acc 2',
              accountAvatar: null,
              identityType: 'personal',
              groupId: t.group.id,
              groupName: t.group.name,
              groupAvatar: null,
              materialId: t.material.id,
              captionPreview: t.material.caption,
              postId: '5555555',
              postUrl: 'https://www.facebook.com/groups/300000000001/posts/5555555/',
              postedAt: Date.now(),
            });
          }
          return;
        }
        if (pid === P003) {
          hooks.markP3Entered();
          await new Promise<void>((resolve) => {
            hooks.releaseP3 = resolve;
          });
        }
      },
    };
    const preparer: PosterMediaPreparerPort = {
      prepare: async (mediaSource) => ({
        localFilePath: mediaSource,
        mediaKind: 'none',
      }),
    };
    const svc = new GroupPosterService(store.groupPoster, runner, preparer);

    await svc.createTask({
      materialId: mat.id,
      groupIds: ['300000000001', '300000000002', '300000000003', '300000000004'],
      accountMode: 'all_online',
      profileIds: [],
      scheduledAt: null,
    });
    await p3Entered;
    await new Promise((r) => setTimeout(r, 80));
    await svc.stopProfiles([P003]);
    await new Promise((r) => setTimeout(r, 50));

    // Tick scheduled tasks: none of P001 (restricted), P002 (quota), or P003 (manual stop) may re-spawn!
    await svc.tickScheduledTasks(Date.now());
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(spawnCounts.get(P001), 1);
    assert.equal(spawnCounts.get(P002), 1);
    assert.equal(spawnCounts.get(P003), 1);

    await svc.stop();
  });

  it('GroupBumperStore isolates Chrome vs BlueStacks logs & deleteLogs, and preserves Chrome consumeCommentOnUse when omitted', async () => {
    const { store } = await openTempStore('wb-c5-bumper-carrier-');
    const bsId = deterministicBluestacksId('Pie64_carrier_iso');
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_carrier_iso',
        displayName: 'BS Iso',
        adbPort: 5571,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);

    const now = Date.now();
    store.groupBumper.record({
      id: randomUUID(),
      profileId: P001,
      accountId: 'chrome-acc-1',
      groupId: '400000000001',
      groupName: 'Chrome Group',
      pageId: '500000000001',
      pageName: 'Chrome Page',
      postId: '700000000001',
      postUrl: 'https://www.facebook.com/groups/400000000001/posts/700000000001/',
      liked: true,
      commentText: null,
      bumpedAt: now - 10,
      sourceMode: 'group',
    });
    store.groupBumper.record({
      id: randomUUID(),
      profileId: bsId,
      accountId: 'bs-acc-1',
      groupId: '400000000002',
      groupName: 'BS Group',
      pageId: '500000000002',
      pageName: 'BS Page',
      postId: '700000000002',
      postUrl: 'https://www.facebook.com/groups/400000000002/posts/700000000002/',
      liked: true,
      commentText: null,
      bumpedAt: now - 5,
      sourceMode: 'group',
    });

    assert.equal(store.groupBumper.logs('', 50, undefined, '\uffff', 'group', 'chrome').length, 1);
    assert.equal(
      store.groupBumper.logs('', 50, undefined, '\uffff', 'group', 'bluestacks').length,
      1,
    );

    // Deleting BlueStacks logs MUST NOT touch Chrome logs!
    store.groupBumper.deleteLogs({ all: true, sourceMode: 'group', carrier: 'bluestacks' });
    assert.equal(
      store.groupBumper.logs('', 50, undefined, '\uffff', 'group', 'bluestacks').length,
      0,
    );
    assert.equal(store.groupBumper.logs('', 50, undefined, '\uffff', 'group', 'chrome').length, 1);

    // Saving comment texts without consumeCommentOnUse (BlueStacks modal) MUST NOT overwrite Chrome's toggle!
    store.groupBumper.saveSettings({ ...store.groupBumper.settings(), consumeCommentOnUse: true });
    store.groupBumper.saveComments({ texts: ['Nice post!'] }, 'group');
    assert.equal(store.groupBumper.settings().consumeCommentOnUse, true);
  });

  it('GroupInviterStore searches by accountId, paginates stably with beforeId, and GroupInviterService syncs live concurrency', async () => {
    const { store } = await openTempStore('wb-c5-inviter-');
    const sameTs = 1_750_000_000_000;
    store.groupInviter.recordInvites([
      {
        profileId: P001,
        accountId: '615999000111',
        friendId: 'f1',
        friendName: 'Alice',
        groupId: '888001',
        invitedAt: sameTs,
      },
      {
        profileId: P001,
        accountId: '615999000111',
        friendId: 'f2',
        friendName: 'Bob',
        groupId: '888001',
        invitedAt: sameTs,
      },
      {
        profileId: P002,
        accountId: '615999000222',
        friendId: 'f3',
        friendName: 'Charlie',
        groupId: '888001',
        invitedAt: sameTs,
      },
    ]);

    const byAccount = store.groupInviter.listLogs({ search: '615999000222', limit: 20 });
    assert.equal(byAccount.length, 1);
    assert.equal(byAccount[0]?.friendName, 'Charlie');

    const page1 = store.groupInviter.listLogs({ limit: 2 });
    assert.equal(page1.length, 2);
    const last1 = page1[1];
    assert.ok(last1);
    const page2 = store.groupInviter.listLogs({
      before: last1.invitedAt,
      beforeId: last1.id,
      limit: 2,
    });
    assert.equal(page2.length, 1);
    assert.ok(!page1.some((r) => r.id === page2[0]?.id));

    const svc = new GroupInviterService(store.groupInviter);
    const nextState = await svc.updateSettings({ maxConcurrentProfiles: 9 });
    assert.equal(nextState.maxConcurrentProfiles, 9);
  });

  it('isValidTotpSecret enforces >= 8 Base32 characters matching generateTotpCode', () => {
    assert.equal(isValidTotpSecret('ABCDEF'), false);
    assert.equal(isValidTotpSecret('ABCDEFG'), false);
    assert.equal(isValidTotpSecret('JBSWY3DP'), true);
    assert.equal(isValidTotpSecret('JBSW Y3DP EHPK 3PXP'), true);
  });

  it('BluestacksService reports skippedAlreadyLoggedIn accurately and never auto-closes pre-opened windows', async () => {
    const idPreOpen = deterministicBluestacksId('Pie64_preopen_1');
    const idAutoLaunch = deterministicBluestacksId('Pie64_autolaunch_2');
    const liveInstances: BluestacksInstance[] = [
      {
        id: idPreOpen,
        instanceKey: 'Pie64_preopen_1',
        displayName: 'PreOpen',
        alias: null,
        folderId: null,
        sortOrder: 0,
        adbPort: 5621,
        serial: '127.0.0.1:5621',
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
        accountState: 'logged-in',
        accountId: '1001',
        accountName: 'Existing User',
        avatarUrl: null,
        lastStatus: null,
        updatedAt: Date.now(),
      },
      {
        id: idAutoLaunch,
        instanceKey: 'Pie64_autolaunch_2',
        displayName: 'AutoLaunch',
        alias: null,
        folderId: null,
        sortOrder: 1,
        adbPort: 5623,
        serial: '127.0.0.1:5623',
        fbWidth: 900,
        fbHeight: 1600,
        online: false,
        fbLiteInstalled: true,
        accountState: 'unknown',
        accountId: '',
        accountName: '',
        avatarUrl: null,
        lastStatus: null,
        updatedAt: Date.now(),
      },
    ];
    const closed: string[] = [];
    const savedSettings = BumperSettings.parse({ maxConcurrentProfiles: 2 });
    const repo: BluestacksServiceRepository = {
      savedSettings: () => ({
        installDir: null,
        confPath: null,
        bumperSettings: savedSettings,
        pageBumperSettings: savedSettings,
      }),
      savePaths: () => ({
        installDir: null,
        confPath: null,
        bumperSettings: savedSettings,
        pageBumperSettings: savedSettings,
      }),
      saveBumperSettings: (v) => BumperSettings.parse(v),
      folders: () => [],
      createFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
      renameFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
      deleteFolder: () => {},
      reorderFolders: () => {},
      listInstances: () => liveInstances.map((x) => ({ ...x })),
      getInstance: (id) => {
        const hit = liveInstances.find((x) => x.id === id);
        return hit ? { ...hit } : null;
      },
      saveLastStatus: (id, status) => {
        const hit = liveInstances.find((x) => x.id === id);
        if (hit) hit.lastStatus = status;
      },
      renameInstance: () => liveInstances[0] as BluestacksInstance,
      reorderInstances: () => {},
      deleteInstances: () => 0,
      targets: () => [],
      todayCounts: () => ({}),
      total: () => 0,
    };
    const devices: BluestacksDeviceController = {
      getOnlineKeys: () => new Set(liveInstances.filter((x) => x.online).map((x) => x.instanceKey)),
      discoverInstances: async () => ({
        instances: liveInstances.map((x) => ({ ...x })),
        config: {
          installDir: null,
          confPath: null,
          detectedInstallDir: null,
          detectedConfPath: null,
          adbReady: true,
          playerReady: true,
        },
      }),
      launchInstance: async (id) => {
        const hit = liveInstances.find((x) => x.id === id);
        if (!hit) throw new Error('missing');
        hit.online = true;
        return { ...hit };
      },
      closeInstance: async (id) => {
        closed.push(id);
      },
      inspectAccount: async (id) => {
        const hit = liveInstances.find((x) => x.id === id);
        if (!hit) throw new Error('missing');
        hit.accountState = 'logged-in';
        return { ...hit };
      },
      loginAccountDetailed: async (id) => {
        const hit = liveInstances.find((x) => x.id === id);
        if (!hit) throw new Error('missing');
        return { instance: { ...hit }, skippedAlreadyLoggedIn: true };
      },
    };

    const service = new BluestacksService(repo, devices, { run: async () => {} });

    // 1. Single loginInstance reports skipped status instead of false "登录成功"
    await service.loginInstance({
      instanceId: idPreOpen,
      account: 'new@example.com',
      password: 'Password123!',
      ifAlreadyLoggedIn: 'skip',
    });
    await new Promise((r) => setTimeout(r, 60));
    const preOpenAfterLogin = liveInstances.find((x) => x.id === idPreOpen);
    assert.match(preOpenAfterLogin?.lastStatus ?? '', /原已登录.*已跳过/);

    // 2. startHealthCheck with closeOnFinish: true closes auto-launched window ONLY, never pre-opened window!
    await service.startHealthCheck({
      instanceIds: [idPreOpen, idAutoLaunch],
      maxConcurrency: 2,
      autoLaunch: true,
      autoInstallApk: false,
      closeOnFinish: true,
    });
    for (let i = 0; i < 40; i++) {
      const st = await service.state(false);
      if (st.healthCheck && !st.healthCheck.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(closed.includes(idAutoLaunch), true);
    assert.equal(closed.includes(idPreOpen), false);
  });

  it('inspectionPresentation renders ACCOUNT_RESTRICTED cleanly instead of mislabeling as logged-out', () => {
    const now = Date.now();
    const profile = {
      id: P001,
      alias: 'Restricted Browser',
      groupId: null,
      order: 0,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      extensionVersion: '0.3.88',
      capabilities: ['facebook-readonly-v2'],
      account: { state: 'restricted' as const, id: null, name: null, avatar: null },
    };
    const summary = inspectionPresentation(
      profile,
      {
        profileId: P001,
        state: 'OBSERVED',
        account: { state: 'restricted', id: null, name: null, avatar: null },
        reason: 'ACCOUNT_RESTRICTED',
        checkedAt: now,
        avatarObservation: null,
        nameObservation: null,
      },
      true,
      now,
    );
    assert.match(summary.title, /受限|停用/);
    assert.doesNotMatch(summary.title, /未登录/);

    // Even if reason is '' (legacy external sync), OBSERVED + restricted must still show restricted, never "尚未检查"
    const fallback = inspectionPresentation(
      profile,
      {
        profileId: P001,
        state: 'OBSERVED',
        account: { state: 'restricted', id: null, name: null, avatar: null },
        reason: '',
        checkedAt: now,
        avatarObservation: null,
        nameObservation: null,
      },
      true,
      now,
    );
    assert.match(fallback.title, /受限|停用/);
    assert.doesNotMatch(fallback.title, /尚未检查|未登录/);
  });

  it('BluestacksService.state reports queued active instances as running: true while waiting for concurrency slot', async () => {
    const id1 = deterministicBluestacksId('Pie64_q_1');
    const id2 = deterministicBluestacksId('Pie64_q_2');
    const liveInstances: BluestacksInstance[] = [id1, id2].map((id, i) => ({
      id,
      instanceKey: `Pie64_q_${i + 1}`,
      displayName: `Q-${i + 1}`,
      alias: null,
      folderId: null,
      sortOrder: i,
      adbPort: 5631 + i * 2,
      serial: `127.0.0.1:${5631 + i * 2}`,
      fbWidth: 900,
      fbHeight: 1600,
      online: true,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: `100${i}`,
      accountName: `User ${i}`,
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    }));
    const savedSettings = BumperSettings.parse({ maxConcurrentProfiles: 1 });
    const hooks = {
      releaseFirst: () => {},
      markFirstStarted: () => {},
    };
    const firstStarted = new Promise<void>((resolve) => {
      hooks.markFirstStarted = resolve;
    });

    const repo: BluestacksServiceRepository = {
      savedSettings: () => ({
        installDir: null,
        confPath: null,
        bumperSettings: savedSettings,
        pageBumperSettings: savedSettings,
      }),
      savePaths: () => ({
        installDir: null,
        confPath: null,
        bumperSettings: savedSettings,
        pageBumperSettings: savedSettings,
      }),
      saveBumperSettings: (v) => BumperSettings.parse(v),
      folders: () => [],
      createFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
      renameFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
      deleteFolder: () => {},
      reorderFolders: () => {},
      listInstances: () => liveInstances.map((x) => ({ ...x })),
      getInstance: (id) => liveInstances.find((x) => x.id === id) ?? null,
      saveLastStatus: () => {},
      renameInstance: () => liveInstances[0] as BluestacksInstance,
      reorderInstances: () => {},
      deleteInstances: () => 0,
      targets: () => [],
      todayCounts: () => ({}),
      total: () => 0,
    };
    const devices: BluestacksDeviceController = {
      getOnlineKeys: () => new Set(liveInstances.map((x) => x.instanceKey)),
      discoverInstances: async () => ({
        instances: liveInstances.map((x) => ({ ...x })),
        config: {
          installDir: null,
          confPath: null,
          detectedInstallDir: null,
          detectedConfPath: null,
          adbReady: true,
          playerReady: true,
        },
      }),
      launchInstance: async (id) => {
        const hit = liveInstances.find((x) => x.id === id);
        if (!hit) throw new Error('missing');
        return { ...hit };
      },
      closeInstance: async () => {},
      inspectAccount: async (id) => {
        const hit = liveInstances.find((x) => x.id === id);
        if (!hit) throw new Error('missing');
        return { ...hit };
      },
    };
    const service = new BluestacksService(repo, devices, { run: async () => {} }, undefined, {
      activeRunner: {
        run: async (instanceId) => {
          if (instanceId === id1) {
            hooks.markFirstStarted();
            await new Promise<void>((resolve) => {
              hooks.releaseFirst = resolve;
            });
          }
          return {
            completedSteps: 1,
            skippedSteps: 0,
            likes: 0,
            acceptedFriends: 0,
            published: 0,
            notes: [],
          };
        },
      },
    });

    await service.startActive({
      instanceIds: [id1, id2],
      quickStep: { type: 'marketplace', durationMinutes: 1 },
    });
    await firstStarted;
    const midState = await service.state(false);
    assert.equal(midState.activeProfileCounts?.[id1]?.running, true);
    assert.equal(midState.activeProfileCounts?.[id2]?.running, true);

    hooks.releaseFirst();
    await service.stopExtra('active');
  });

  it('BluestacksGroupBumperRunner.runDirectPosts normalizes pfbid postId to numeric ID and stops immediately on riskLimitReason', async () => {
    const bsId = deterministicBluestacksId('Pie64_direct_pfbid');
    const seenPostIds: string[] = [];
    const statuses: string[] = [];
    let deepLinkCalls = 0;

    const runner = new BluestacksGroupBumperRunner(
      {
        eligibility: (_acc, _inst, postId) => {
          seenPostIds.push(postId);
          return {
            today: 0,
            postCount: 0,
            duplicate: false,
            riskLimitReason: '今日已达蓝蝶风控安全上限 (30/30)',
            allowed: false,
          };
        },
        pickComment: () => null,
        recordBump: () => true,
        saveInspectionResult: () => ({
          id: bsId,
          instanceKey: 'Pie64_direct_pfbid',
          displayName: 'Direct',
          alias: null,
          folderId: null,
          sortOrder: 0,
          adbPort: 5641,
          serial: '127.0.0.1:5641',
          fbWidth: 900,
          fbHeight: 1600,
          online: true,
          fbLiteInstalled: true,
          accountState: 'logged-in',
          accountId: '1009',
          accountName: 'Direct User',
          avatarUrl: null,
          lastStatus: null,
          updatedAt: Date.now(),
        }),
      },
      { applyResolvedTargetMetadata: () => {} },
      {
        ensureReadyAndLoggedIn: async () => ({
          id: bsId,
          instanceKey: 'Pie64_direct_pfbid',
          displayName: 'Direct',
          alias: null,
          folderId: null,
          sortOrder: 0,
          adbPort: 5641,
          serial: '127.0.0.1:5641',
          fbWidth: 900,
          fbHeight: 1600,
          online: true,
          fbLiteInstalled: true,
          accountState: 'logged-in',
          accountId: '1009',
          accountName: 'Direct User',
          avatarUrl: null,
          lastStatus: null,
          updatedAt: Date.now(),
        }),
        openDeepLink: async () => {
          deepLinkCalls++;
        },
      } as unknown as BluestacksDeviceManager,
      { recognizeBounds: async () => '', close: async () => {} },
    );

    const res = await runner.runDirectPosts(
      bsId,
      [
        {
          postId: 'pfbid02XyZabc1234567890',
          postUrl: 'https://www.facebook.com/groups/123456/posts/pfbid02XyZabc1234567890/',
          groupId: '123456',
          groupName: 'Test Group',
          pageId: '-',
          pageName: '',
        },
        {
          postId: 'POST-2026-002',
          postUrl: 'https://www.facebook.com/share/p/1AbCdEfGhI/',
          groupId: '123456',
          groupName: 'Test Group',
          pageId: '-',
          pageName: '',
        },
      ],
      BumperSettings.parse({}),
      ['Nice!'],
      new AbortController().signal,
      { status: (t) => statuses.push(t) },
    );

    // First pfbid post was normalized to pure digits, hit riskLimitReason, and broke out BEFORE checking post #2!
    assert.equal(seenPostIds.length, 1);
    assert.match(seenPostIds[0] ?? '', /^\d+$/);
    assert.equal(deepLinkCalls, 0);
    assert.equal(res.attempted, 0);
    assert.ok(statuses.some((s) => s.includes('蓝蝶风控安全上限')));
  });

  it('profileDisplayName prefers browserName over default Chrome hex alias while preserving custom alias and fallbacks', () => {
    const id = '1a761215-0000-4000-8000-000000000001';
    assert.equal(
      profileDisplayName({ id, alias: 'Chrome 1a761215', browserName: '用户9' }),
      '用户9',
    );
    assert.equal(profileDisplayName({ id, alias: '用户8--', browserName: '用户8--' }), '用户8--');
    assert.equal(
      profileDisplayName({ id, alias: 'Chrome 1a761215', browserName: '   ' }),
      'Chrome 1a761215',
    );
    assert.equal(
      profileDisplayName({ id, alias: '', browserName: null, name: '备选名' }),
      '备选名',
    );
    assert.equal(profileDisplayName({ id, alias: '', browserName: null }), '1a761215');
    assert.equal(profileDisplayName(null, '自定义兜底'), '自定义兜底');
    assert.equal(profileDisplayName(undefined), '浏览器');
  });
});
