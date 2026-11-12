import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildNormalBrowserLaunchArgs,
  formatBrowserWindowName,
} from '../src/shared/profile-lifecycle.js';
import { LocalBrowserLabels } from '../src/infrastructure/local-browser-labels.js';
import { BrowserLifecycleManager } from '../src/infrastructure/browser-lifecycle-manager.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { persistenceRoutes } from '../src/infrastructure/persistence-routes.js';
import { Store } from '../src/bridge/store.js';
import { Core } from '../src/bridge/core.js';
import { GroupBumperService, type BumperRunner } from '../src/application/group-bumper-service.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { GroupPosterBrowserAdapter } from '../src/infrastructure/group-poster-runner.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';

test('buildNormalBrowserLaunchArgs matches 浏览器管理.exe exact normal parameters with zero automation flags', () => {
  const userDataDir = 'C:\\Users\\demo\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data';
  const windowName = formatBrowserWindowName('brave', 'Profile 142', userDataDir);
  assert.equal(
    windowName,
    'Brave_Profile 142_C:|Users|demo|AppData|Local|BraveSoftware|Brave-Browser|User Data',
  );

  const args = buildNormalBrowserLaunchArgs({
    browserKind: 'brave',
    profileDirectory: 'Profile 142',
    userDataDir,
    windowName,
  });

  assert.deepEqual(args, [
    '--profile-directory=Profile 142',
    `--user-data-dir=${userDataDir}`,
    `--window-name=${windowName}`,
  ]);
  for (const flag of args) {
    assert.ok(!flag.includes('remote-debugging'));
    assert.ok(!flag.includes('automation'));
  }
});

const TEST_EXT_ID = 'eehghiicklfpnhliknglhagcipkjkjjf';

function safeCleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  } catch {
    // Windows SQLite WAL file handle may release slightly after close
  }
}

test('LocalBrowserLabels strictly binds 1-to-1 extension profiles, rejects collisions, and never exposes uninstalled profiles', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wb-labels-lifecycle-'));
  try {
    const userDataDir = join(tempRoot, 'BraveSoftware', 'Brave-Browser', 'User Data');
    mkdirSync(userDataDir, { recursive: true });
    const fakeExe = join(tempRoot, 'brave.exe');
    writeFileSync(fakeExe, 'fake-binary');

    const extId = TEST_EXT_ID;
    const profileOk = randomUUID();
    const profileDupFolder = randomUUID();
    const profileSharedA = randomUUID();
    const profileSharedB = randomUUID();

    writeFileSync(
      join(userDataDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 1': { name: '用户8' },
            'Profile 2': { name: '私人未装插件浏览器' },
            'Profile 3': { name: '克隆目录A' },
            'Profile 4': { name: '克隆目录B' },
            'Profile 5': { name: '多ID冲突目录' },
          },
        },
      }),
    );

    const writeExtStorage = (folder: string, content: string) => {
      const extDir = join(userDataDir, folder, 'Local Extension Settings', extId);
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, '000003.log'), content, 'utf8');
    };

    writeExtStorage('Profile 1', `prefix:${profileOk}:suffix`);
    mkdirSync(join(userDataDir, 'Profile 2'), { recursive: true });
    writeExtStorage('Profile 3', `dup:${profileDupFolder}`);
    writeExtStorage('Profile 4', `dup:${profileDupFolder}`);
    writeExtStorage('Profile 5', `both:${profileSharedA}:${profileSharedB}`);

    const labels = new LocalBrowserLabels([extId], [userDataDir], Date.now, {
      brave: [fakeExe],
    });

    await labels.refreshNow([profileOk, profileDupFolder, profileSharedA, profileSharedB]);

    assert.equal(labels.name(profileOk), '用户8');
    const bindingOk = labels.binding(profileOk);
    assert.ok(bindingOk);
    assert.equal(bindingOk.browserKind, 'brave');
    assert.equal(bindingOk.profileDirectory, 'Profile 1');
    assert.equal(bindingOk.executablePath, fakeExe);

    // Collisions must never bind
    assert.equal(labels.binding(profileDupFolder), undefined);
    assert.equal(labels.binding(profileSharedA), undefined);
    assert.equal(labels.binding(profileSharedB), undefined);

    // Uninstalled Profile 2 is never stored or exposed anywhere
    assert.equal(labels.allBindings().length, 1);
    assert.equal(labels.allBindings()[0]?.profileId, profileOk);

    // Verify pre-launch disk check blocks if extension storage is removed
    const verifiedBefore = await labels.verifyBindingOnDisk(bindingOk);
    assert.equal(verifiedBefore.ok, true);

    rmSync(join(userDataDir, 'Profile 1', 'Local Extension Settings'), {
      recursive: true,
      force: true,
    });
    const verifiedAfterUninstall = await labels.verifyBindingOnDisk(bindingOk);
    assert.equal(verifiedAfterUninstall.ok, false);
    if (!verifiedAfterUninstall.ok) {
      assert.equal(verifiedAfterUninstall.errorCode, 'EXTENSION_NOT_INSTALLED_IN_PROFILE');
    }
  } finally {
    safeCleanupDir(tempRoot);
  }
});

test('BrowserLifecycleManager enforces registered-only guard, launches/closes/restarts single profile without touching others', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wb-lifecycle-mgr-'));
  try {
    const workspaceStore = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
    const bridgeStore = new Store(join(tempRoot, 'bridge.sqlite'));
    const core = new Core(bridgeStore);

    const extId = TEST_EXT_ID;
    const userDataDir = join(tempRoot, 'BraveSoftware', 'Brave-Browser', 'User Data');
    mkdirSync(userDataDir, { recursive: true });
    const fakeExe = join(tempRoot, 'brave.exe');
    writeFileSync(fakeExe, 'fake');

    const registeredOfflineId = randomUUID();
    const registeredOnlineKeepId = randomUUID();
    const unregisteredId = randomUUID();

    bridgeStore.pair(registeredOfflineId, 'sec-1', extId);
    bridgeStore.pair(registeredOnlineKeepId, 'sec-2', extId);

    const connectMockPeer = async (id: string) => {
      const peer = core.connect(
        id,
        (msg) => {
          const typed = msg as { type?: string; requestId?: string };
          if (typed.type === 'CLOSE_BROWSER_WINDOWS' && typed.requestId) {
            const current = core.peers.get(id);
            if (current) {
              core.browserWindowsClosed(current, typed.requestId, {
                closedCount: 1,
                remainingCount: 0,
              });
              current.browserWindowCount = 0;
              void core.disconnect(current);
            }
          }
        },
        () => {},
      );
      peer.browserWindowCount = 1;
      peer.capabilities = ['browser-window-close-v1'];
      const syncCtrl = await core.sync(peer);
      await core.synced(peer, syncCtrl.requestId, []);
      return peer;
    };

    // Connect registeredOnlineKeepId and keep it online throughout
    await connectMockPeer(registeredOnlineKeepId);

    writeFileSync(
      join(userDataDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 8': { name: '用户8' },
            'Profile 9': { name: '用户9' },
          },
        },
      }),
    );
    for (const [folder, pid] of [
      ['Profile 8', registeredOfflineId],
      ['Profile 9', registeredOnlineKeepId],
    ] as const) {
      const extDir = join(userDataDir, folder, 'Local Extension Settings', extId);
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, '000003.log'), pid, 'utf8');
    }

    const labels = new LocalBrowserLabels([extId], [userDataDir], Date.now, {
      brave: [fakeExe],
    });
    const spawnedCalls: Array<{ exe: string; args: readonly string[] }> = [];
    const stoppedProfiles: string[] = [];

    const manager = new BrowserLifecycleManager({
      core,
      store: bridgeStore,
      browserLabels: labels,
      persistBindings: (b) => {
        workspaceStore.upsertProfileLaunchBindings(b);
      },
      stopActiveTasksForProfile: async (pid) => {
        stoppedProfiles.push(pid);
      },
      sleep: async () => {},
      spawnProcess: async (exe, args) => {
        spawnedCalls.push({ exe, args });
        await connectMockPeer(registeredOfflineId);
      },
    });

    // 1. Unregistered profile is strictly rejected
    const unregRes = await manager.launchProfile(unregisteredId);
    assert.equal(unregRes.ok, false);
    assert.equal(unregRes.errorCode, 'PROFILE_NOT_REGISTERED');
    assert.equal(spawnedCalls.length, 0);

    // 2. Launching registered offline profile uses exact normal args and persists binding
    const openRes = await manager.launchProfile(registeredOfflineId);
    assert.equal(openRes.ok, true);
    assert.equal(openRes.online, true);
    assert.equal(openRes.synced, true);
    assert.equal(spawnedCalls.length, 1);
    assert.deepEqual(spawnedCalls[0]?.args, [
      '--profile-directory=Profile 8',
      `--user-data-dir=${userDataDir}`,
      `--window-name=Brave_Profile 8_${userDataDir.replace(/\\/g, '|')}`,
    ]);
    // Both registered extension profiles ('Profile 8' and 'Profile 9') were persisted
    assert.equal(workspaceStore.profileLaunchBindings().length, 2);

    // 3. Restarting single profile stops its tasks, closes ONLY its windows, and reopens it while p2 stays online
    const restartRes = await manager.restartProfile(registeredOfflineId);
    assert.equal(restartRes.ok, true);
    assert.equal(restartRes.action, 'restart');
    assert.equal(restartRes.online, true);
    assert.deepEqual(stoppedProfiles, [registeredOfflineId]);
    assert.equal(spawnedCalls.length, 2);
    // Verify registeredOnlineKeepId was NEVER touched or disconnected!
    assert.equal(core.peers.get(registeredOnlineKeepId)?.online, true);

    bridgeStore.db.close();
    workspaceStore.close();
  } finally {
    safeCleanupDir(tempRoot);
  }
});

test('GroupBumperService scheduled tasks persist, recover stale running on startup, and auto-launch offline browsers when due', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wb-bumper-sched-'));
  try {
    const workspaceStore = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
    const profileId = randomUUID();
    workspaceStore.groupBumper.upsertTargets('groups', {
      items: [{ id: '123456789012', name: '测试小组' }],
    });
    workspaceStore.groupBumper.upsertTargets('pages', {
      items: [{ id: '987654321098', name: '测试专页' }],
    });

    // Seed a stale running task and reopen store to verify startup recovery
    const staleTask = workspaceStore.groupBumper.createScheduledTask({
      mode: 'group-bumper',
      profileIds: [profileId],
      groupIds: ['123456789012'],
      pageIds: ['987654321098'],
      scheduledAt: Date.now() + 60_000,
    });
    workspaceStore.groupBumper.updateScheduledTask(staleTask.id, {
      status: 'running',
      statusReason: '执行中',
      runId: 'stale-run',
      startedAt: Date.now() - 10_000,
    });
    workspaceStore.close();

    const reopened = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
    const recovered = reopened.groupBumper.scheduledTasks().find((t) => t.id === staleTask.id);
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.statusReason, '软件重启中断');

    let browserOnline = false;
    const autoLaunchedIds: string[] = [];
    const executedRuns: Array<{ profileId: string; groupsFirstId: string }> = [];

    const mockRunner: BumperRunner = {
      ready: () => browserOnline,
      busy: async () => false,
      run: async (id, groups, _pages, _settings, callbacks) => {
        executedRuns.push({ profileId: id, groupsFirstId: groups[0]?.id ?? '' });
        callbacks.status('已完成顶贴', 1);
      },
      stop: async () => {},
    };

    const service = new GroupBumperService(reopened.groupBumper, mockRunner, async () => ({
      comments: [],
      total: 0,
    }));
    service.setProfileLifecycle({
      isLaunching: () => false,
      getStatus: async () => [],
      launchProfile: async (id) => ({
        profileId: id,
        browserName: '用户8',
        action: 'open',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 10,
      }),
      closeProfile: async (id) => ({
        profileId: id,
        browserName: '用户8',
        action: 'close',
        ok: true,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        launchable: true,
        elapsedMs: 10,
      }),
      restartProfile: async (id) => ({
        profileId: id,
        browserName: '用户8',
        action: 'restart',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 10,
      }),
      ensureProfilesOnline: async (ids) => {
        autoLaunchedIds.push(...ids);
        browserOnline = true;
        return {
          requestedIds: [...ids],
          readyIds: [...ids],
          launchedIds: [...ids],
          failed: [],
          items: [],
        };
      },
    });

    // Create a due page-bumper scheduled task (scheduled ~2.3s in the future)
    const afterCreate = await service.manage('tasks/create', {
      mode: 'page-bumper',
      profileIds: [profileId],
      groupIds: [],
      pageIds: ['987654321098'],
      scheduledAt: Date.now() + 2300,
    });
    const createdTask = afterCreate.scheduledTasks?.find((t) => t.mode === 'page-bumper');
    assert.ok(createdTask);
    assert.equal(createdTask.status, 'scheduled');

    await new Promise((r) => setTimeout(r, 2450));
    await service.tickScheduledTasks();
    await new Promise((r) => setTimeout(r, 80));

    assert.deepEqual(autoLaunchedIds, [profileId]);
    assert.equal(executedRuns.length, 1);
    // Page bumper uses synthetic group id '-'
    assert.equal(executedRuns[0]?.groupsFirstId, '-');

    const finalState = await service.state();
    const completedTask = finalState.scheduledTasks?.find((t) => t.id === createdTask.id);
    assert.equal(completedTask?.status, 'completed');

    service.shutdown();
    reopened.close();
  } finally {
    safeCleanupDir(tempRoot);
  }
});

test('GroupPosterService + real GroupPosterBrowserAdapter auto-launches offline selected browser when scheduled task triggers after user closed browser', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wb-poster-sched-offline-'));
  try {
    const workspaceStore = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
    const bridgeStore = new Store(join(tempRoot, 'bridge.sqlite'));
    const core = new Core(bridgeStore);

    const extId = TEST_EXT_ID;
    const userDataDir = join(tempRoot, 'BraveSoftware', 'Brave-Browser', 'User Data');
    mkdirSync(userDataDir, { recursive: true });
    const fakeExe = join(tempRoot, 'brave.exe');
    writeFileSync(fakeExe, 'fake');
    const fakeMediaFile = join(tempRoot, 'post-image.jpg');
    writeFileSync(fakeMediaFile, 'fake-jpg');

    const profileId = randomUUID();
    bridgeStore.pair(profileId, 'sec-poster-8', extId);

    writeFileSync(
      join(userDataDir, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { 'Profile 142': { name: '用户8' } } },
      }),
    );
    const extDir = join(userDataDir, 'Profile 142', 'Local Extension Settings', extId);
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, '000003.log'), profileId, 'utf8');

    const connectMockPeer = async (id: string) => {
      const peer = core.connect(
        id,
        () => {},
        () => {},
      );
      peer.browserWindowCount = 1;
      peer.capabilities = ['browser-window-close-v1'];
      const syncCtrl = await core.sync(peer);
      await core.synced(peer, syncCtrl.requestId, []);
      return peer;
    };

    // 1. User creates scheduled task while 用户8 is online
    const initialPeer = await connectMockPeer(profileId);

    const fakeKernel = {
      withSummary: async () => ({ operations: [] }),
    } as unknown as KernelBridge;

    const realAdapter = new GroupPosterBrowserAdapter(
      workspaceStore.groupBumper,
      () => fakeKernel,
      () => core,
      async () => false,
      1,
      workspaceStore.groupPoster,
    );

    const postedGroups: string[] = [];
    // Wrap realAdapter's ready() & busy() untouched while stubbing only runProfileWorker's FB DOM submission
    const posterRunner = {
      ready: (id: string) => realAdapter.ready(id),
      busy: (id: string) => realAdapter.busy(id),
      onlineProfileIds: () => realAdapter.onlineProfileIds(),
      stop: (id: string) => realAdapter.stop(id),
      runProfileWorker: async (
        id: string,
        _files: readonly string[],
        _settings: unknown,
        callbacks: Parameters<GroupPosterBrowserAdapter['runProfileWorker']>[3],
      ) => {
        while (!callbacks.cancelled()) {
          const next = await callbacks.claimNextTask();
          if (!next) break;
          postedGroups.push(next.group.id);
          await callbacks.onTaskPosted({
            id: randomUUID(),
            profileId: id,
            accountId: '61593615564708',
            accountName: '用户8',
            accountAvatar: null,
            identityType: 'personal',
            groupId: next.group.id,
            groupName: next.group.name,
            groupAvatar: null,
            materialId: next.material.id,
            captionPreview: next.material.caption,
            postId: '999888777',
            postUrl: `https://www.facebook.com/groups/${next.group.id}/posts/999888777/`,
            postedAt: Date.now(),
          });
        }
      },
    };

    const labels = new LocalBrowserLabels([extId], [userDataDir], Date.now, {
      brave: [fakeExe],
    });
    const spawnedArgs: Array<readonly string[]> = [];
    const lifecycle = new BrowserLifecycleManager({
      core,
      store: bridgeStore,
      browserLabels: labels,
      persistBindings: (b) => {
        workspaceStore.upsertProfileLaunchBindings(b);
      },
      sleep: async () => {},
      spawnProcess: async (_exe, args) => {
        spawnedArgs.push(args);
        await connectMockPeer(profileId);
      },
    });

    workspaceStore.groupPoster.upsertTargets({
      items: [{ id: '3017439278594998', name: '测试发帖小组' }],
    });
    workspaceStore.groupPoster.saveMaterials({
      items: [
        {
          id: 'mat-sched-8',
          caption: '',
          mediaSource: fakeMediaFile,
          background: 'plain',
          selected: true,
        },
      ],
    });

    const posterService = new GroupPosterService(workspaceStore.groupPoster, posterRunner, {
      prepare: async () => ({
        localFilePath: fakeMediaFile,
        mediaKind: 'image',
      }),
      verifyExists: async () => true,
    });
    posterService.setProfileLifecycle(lifecycle);

    const createdState = await posterService.createTask({
      materialId: 'mat-sched-8',
      groupIds: ['3017439278594998'],
      accountMode: 'selected',
      profileIds: [profileId],
      scheduledAt: Date.now() + 800,
    });
    const scheduledTask = createdState.tasks?.find((t) => t.materialId === 'mat-sched-8');
    assert.ok(scheduledTask);
    assert.equal(scheduledTask.status, 'scheduled');

    // 2. User closes 用户8 before scheduled time arrives!
    await core.disconnect(initialPeer);
    assert.equal(core.peers.get(profileId)?.online ?? false, false);
    // Crucial regression assertion: offline browser MUST NOT be treated as busy!
    assert.equal(await realAdapter.busy(profileId), false);
    assert.equal(realAdapter.ready(profileId), false);

    // 3. Scheduled time arrives -> tickScheduledTasks wakes up 用户8 and completes posting!
    await new Promise((r) => setTimeout(r, 950));
    await posterService.tickScheduledTasks();
    for (let i = 0; i < 40; i += 1) {
      if (!posterService.hasActiveExecution()) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.equal(spawnedArgs.length, 1);
    assert.deepEqual(postedGroups, ['3017439278594998']);
    const afterState = await posterService.state();
    const finishedTask = afterState.tasks?.find((t) => t.id === scheduledTask.id);
    assert.equal(finishedTask?.status, 'completed');
    assert.notEqual(finishedTask?.statusReason, '跳过：正在执行其他任务');

    bridgeStore.db.close();
    workspaceStore.close();
  } finally {
    safeCleanupDir(tempRoot);
  }
});

test('persistenceRoutes allowlists all browser lifecycle binding and bumper schedule worker routes', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bw-routes-test-'));
  try {
    const store = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
    try {
      const requiredRoutes = [
        'workspace.profileLaunchBindings',
        'workspace.upsertProfileLaunchBindings',
        'workspace.groupBumper.scheduledTasks',
        'workspace.groupBumper.createScheduledTask',
        'workspace.groupBumper.updateScheduledTask',
        'workspace.groupBumper.deleteScheduledTask',
      ];
      for (const route of requiredRoutes) {
        assert.equal(persistenceRoutes.has(route), true, `Missing persistence route: ${route}`);
        const parts = route.split('.').slice(1);
        let current: unknown = store;
        for (const part of parts) {
          current = Reflect.get(current as object, part);
        }
        assert.equal(
          typeof current,
          'function',
          `Route method not found on WorkspaceStore: ${route}`,
        );
      }
    } finally {
      store.close();
    }
  } finally {
    safeCleanupDir(tempRoot);
  }
});
