import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { AutoSchedulerService } from '../dist/src/application/auto-scheduler-service.js';
import { BluestacksService } from '../dist/src/application/bluestacks-service.js';
import {
  FeatureExecutionRegistry,
  ensureFeatureExecutionRegistry,
} from '../dist/src/application/feature-execution-registry.js';
import { GoogleSheetsService } from '../dist/src/application/google-sheets-service.js';
import { GroupBumperService } from '../dist/src/application/group-bumper-service.js';
import { GroupInviterService } from '../dist/src/application/group-inviter-service.js';
import { GroupPosterService } from '../dist/src/application/group-poster-service.js';
import { TaskService } from '../dist/src/application/task-service.js';
import { Semaphore, Workboard } from '../dist/src/application/workboard.js';
import { WorkspaceEventHub } from '../dist/src/application/workspace-event-hub.js';
import { WorkspaceService } from '../dist/src/application/workspace-service.js';
import { Core } from '../dist/src/bridge/core.js';
import { ActiveAccountRuntime } from '../dist/src/infrastructure/active-account-runtime.js';
import { BluestacksActiveRunner } from '../dist/src/infrastructure/bluestacks-active-runner.js';
import { BridgeBrowserWindow } from '../dist/src/infrastructure/bridge-browser-window.js';
import { BridgeProfileSource } from '../dist/src/infrastructure/browser-source.js';
import { PersistenceClient } from '../dist/src/infrastructure/persistence-client.js';
import { bridgeCapabilities } from '../dist/src/shared/bridge-capabilities.js';
import {
  computeTotalDailyActions,
  evaluateDailyRiskQuota,
} from '../dist/src/shared/daily-risk-limits.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred, timeoutMs = 15_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`WAIT_UNTIL_TIMEOUT:${label}`);
}

/**
 * Pre-flight Semaphore thundering-herd & FIFO fairness verification:
 * 60 concurrent waiters on Semaphore(3) must wake strictly 1-for-1 in FIFO order.
 */
async function verifySemaphoreFifoAndNoThunderingHerd() {
  const sem = new Semaphore(3);
  const initialReleases = [await sem.acquire(), await sem.acquire(), await sem.acquire()];
  const acquiredOrder = [];
  const holdReleases = [];
  let maxObservedActive = sem.used;

  const waiters = Array.from({ length: 60 }, (_, idx) =>
    sem.acquire().then((release) => {
      acquiredOrder.push(idx);
      maxObservedActive = Math.max(maxObservedActive, sem.used);
      holdReleases.push(release);
    }),
  );

  await sleep(15);
  assert.equal(acquiredOrder.length, 0, 'no waiters should wake while Semaphore(3) is full');

  // Release one at a time and assert 1 release = 1 wakeup
  for (let i = 0; i < 3; i++) {
    initialReleases[i]();
    await sleep(5);
    assert.equal(
      acquiredOrder.length,
      i + 1,
      `expected exactly ${i + 1} wakeups after ${i + 1} releases`,
    );
    assert.equal(sem.used, 3, 'Semaphore.used must stay at 3 during 1-for-1 handoff');
  }

  // Drain remaining 57 waiters
  while (holdReleases.length > 0 || acquiredOrder.length < 60) {
    const rel = holdReleases.shift();
    if (rel) rel();
    else await sleep(5);
  }
  await Promise.all(waiters);
  assert.equal(sem.used, 0, 'Semaphore.used must drain to 0');
  assert.equal(maxObservedActive, 3, 'Semaphore must never exceed limit 3');
  assert.deepEqual(
    acquiredOrder,
    Array.from({ length: 60 }, (_, i) => i),
    'Semaphore must preserve strict FIFO acquisition order',
  );
}

/**
 * Creates a fake KernelBridge + Playwright Page harness that exercises real
 * Workboard permits, Core peers, withBrowserSession, and ActiveAccountRuntime state transitions.
 */
function createChaosKernelHarness(core, options) {
  const {
    profileAccountMap,
    onWorkStart,
    onWorkEnd,
    wsDisconnectProfiles,
    contextLostProfiles,
    browserCrashProfiles,
    restrictedProfiles,
    verificationProfiles,
    unconfirmedPostProfiles,
  } = options;

  const makePage = (profileId) => {
    const listeners = new Map();
    return {
      url: () => 'https://www.facebook.com/',
      on: (ev, fn) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
      },
      off: (ev, fn) => listeners.get(ev)?.delete(fn),
      goto: async () => {
        if (unconfirmedPostProfiles.has(profileId)) {
          await sleep(15);
          throw new Error('PUBLISH_RESULT_UNCONFIRMED');
        }
        await sleep(10);
      },
      evaluate: async () => ({
        url: 'https://www.facebook.com/',
        ready: 'complete',
        rows: [],
      }),
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
          evaluate: async () => {},
          click: async () => {},
        }),
        count: async () => 0,
      }),
      keyboard: { insertText: async () => {} },
    };
  };

  return {
    withSummary: async (peer, fn) => {
      const proof = { tabId: 1, url: 'https://www.facebook.com/', windowId: 1 };
      return await fn({
        inventory: async () => ({
          tabs: [{ state: 'READY', proof }],
          workspaceMain: proof,
          operations: [],
        }),
        notify: async () => {},
      });
    },
    inspectIdleFacebookPage: async (peer) => {
      if (restrictedProfiles.has(peer.profileId)) {
        throw new Error('FACEBOOK_ACCOUNT_RESTRICTED');
      }
      if (verificationProfiles.has(peer.profileId)) {
        throw new Error('FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED');
      }
      return {
        actor: {
          accountId: profileAccountMap.get(peer.profileId) ?? '1000999',
          name: `User-${peer.profileId.slice(0, 6)}`,
        },
        proof: { tabId: 1, url: 'https://www.facebook.com/', windowId: 1 },
      };
    },
    inspectFacebookIdentity: async (peer) => {
      if (restrictedProfiles.has(peer.profileId)) {
        throw new Error('FACEBOOK_ACCOUNT_RESTRICTED');
      }
      if (verificationProfiles.has(peer.profileId)) {
        throw new Error('FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED');
      }
      return {
        actor: {
          accountId: profileAccountMap.get(peer.profileId) ?? '1000999',
          name: `User-${peer.profileId.slice(0, 6)}`,
        },
        proof: { tabId: 1, url: 'https://www.facebook.com/', windowId: 1 },
      };
    },
    connectFacebook: async (peer, accountId, guard, proof) => {
      onWorkStart(peer.profileId);
      const page = makePage(peer.profileId);
      let closed = false;
      const conn = {
        proof,
        stopRequestId: randomUUID(),
        failureReason: null,
        browser: { contexts: () => [{ pages: () => [page] }] },
        context: async () => {
          if (contextLostProfiles.has(peer.profileId)) {
            throw new Error('FACEBOOK_EXECUTION_CONTEXT_LOST');
          }
          return {
            profileId: peer.profileId,
            accountId,
            connectionEpoch: peer.epoch,
            leaseId: randomUUID(),
            generation: 1,
          };
        },
        execute: async (binding, fn) => {
          if (wsDisconnectProfiles.has(peer.profileId)) {
            await sleep(20);
            const live = core.peers.get(peer.profileId);
            if (live) {
              live.online = false;
              await core.disconnect(live);
            }
            guard();
          }
          if (browserCrashProfiles.has(peer.profileId)) {
            await sleep(20);
            const live = core.peers.get(peer.profileId);
            if (live) {
              live.browserWindowCount = 0;
              live.online = false;
              await core.disconnect(live);
            }
            throw new Error('TARGET_CLOSED');
          }
          await sleep(40);
          return { value: await fn(), binding, targetUnavailableBeforeInput: false };
        },
        reconcile: async () => {},
        close: async () => {
          if (!closed) {
            closed = true;
            onWorkEnd(peer.profileId);
          }
        },
        stopOnCloseFailure: async () => {},
        retryClose: async () => {},
        closeLocalAfterDisconnect: async () => {
          if (!closed) {
            closed = true;
            onWorkEnd(peer.profileId);
          }
        },
        revokeInput: () => {},
      };
      return conn;
    },
  };
}

async function main() {
  await verifySemaphoreFifoAndNoThunderingHerd();

  const dir = await mkdtemp(path.join(tmpdir(), 'wb-stress-chaos-'));
  const dataDir = path.join(dir, 'data');
  const uploadCacheRoot = path.join(dir, 'upload-cache');
  const mediaFile = path.join(dir, 'sample.jpg');
  await mkdir(dataDir, { recursive: true });
  await mkdir(uploadCacheRoot, { recursive: true });
  await writeFile(mediaFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  let persistence = await PersistenceClient.open(dataDir);
  let core = new Core(persistence.bridge);
  let eventHub = new WorkspaceEventHub({ coalesceMs: 25, keepaliveMs: 15_000, maxClients: 16 });
  let autoScheduler;
  let groupBumper;
  let groupPoster;
  let groupInviter;
  let googleSheets;
  let activeRuntime;
  let sampler = null;
  let stopStorm = () => {};

  try {
    const workboard = new Workboard({
      browserConcurrency: 5,
      bluestacksConcurrency: 5,
      launchConcurrency: 8,
      launchStaggerMs: 20,
    });
    const featureExecution = new FeatureExecutionRegistry();

    // Create 50 browser profiles (p00..p09 pre-opened online, p10..p49 offline)
    const browserIds = Array.from({ length: 50 }, () => randomUUID());
    const preOnlineBrowserSet = new Set(browserIds.slice(0, 10));
    const currentOnlineBrowsers = new Set(browserIds.slice(0, 10));
    const profileAccountMap = new Map();

    // Create 20 BlueStacks instances (bs00..bs03 pre-opened online, bs04..bs19 offline)
    const bsKeys = Array.from({ length: 20 }, (_, i) => `Pie64_chaos_${i}`);
    const currentOnlineBsKeys = new Set(bsKeys.slice(0, 4));

    await persistence.workspace.ensureProfileOrders(browserIds);

    const launchBindings = [];
    for (let i = 0; i < browserIds.length; i++) {
      const pid = browserIds[i];
      const accId = String(1000000 + i);
      profileAccountMap.set(pid, accId);
      await persistence.bridge.pair(pid, randomUUID(), 'a'.repeat(32));
      await persistence.workspace.renameProfile(pid, `ChaosBrowser-${String(i).padStart(2, '0')}`);
      await persistence.workspace.updateProfileAccountCache(pid, {
        state: 'logged-in',
        id: accId,
        name: `Account-${String(i).padStart(2, '0')}`,
        avatar: null,
        liveConfirmedLoggedIn: true,
      });
      launchBindings.push({
        profileId: pid,
        browserKind: 'chrome',
        executablePath: 'C:\\Chrome\\chrome.exe',
        userDataDir: path.join(dir, 'profiles', `u-${i}`),
        profileDirectory: 'Default',
        browserName: `ChaosBrowser-${String(i).padStart(2, '0')}`,
        windowName: `ChaosBrowser-${String(i).padStart(2, '0')}`,
        verifiedAt: Date.now(),
      });
    }
    await persistence.workspace.upsertProfileLaunchBindings(launchBindings);

    const bsFolder = await persistence.workspace.bluestacks.createFolder({
      name: 'Chaos-BS-Group',
    });
    const discoveredBs = await persistence.workspace.bluestacks.upsertDiscoveredInstances(
      bsKeys.map((key, idx) => ({
        instanceKey: key,
        displayName: `ChaosBS-${String(idx).padStart(2, '0')}`,
        adbPort: 5555 + idx * 10,
        fbWidth: 900,
        fbHeight: 1600,
        online: currentOnlineBsKeys.has(key),
        fbLiteInstalled: true,
      })),
    );
    const bsIds = discoveredBs.map((inst) => inst.id);
    const bsKeyById = new Map(discoveredBs.map((inst) => [inst.id, inst.instanceKey]));
    for (let i = 0; i < bsIds.length; i++) {
      await persistence.workspace.bluestacks.saveInspectionResult({
        id: bsIds[i],
        fbLiteInstalled: true,
        accountState: 'logged-in',
        accountId: `bsacc-${i}`,
        numericAccountId: String(2000000 + i),
        accountName: `BSAccount-${i}`,
        identityType: 'personal',
      });
    }
    const bsDbPath = path.join(dataDir, 'workspace.sqlite');
    // Assign first 12 BS instances to folder via Bluestacks store? No direct move method needed — use explicit targetIds in scheduler!
    void bsFolder;
    void bsDbPath;

    let cleanupTabsKilledActive = 0;
    let cleanupTabsBlockedCount = 0;
    const closedOnFinishTargets = new Set();
    const expectedCloseOnFinishTargets = new Set();
    const launchStartTimes = [];

    const connectSimulatedPeer = (profileId, markOnline = true) => {
      const existing = core.peers.get(profileId);
      if (existing?.online) return existing;
      const peer = core.connect(
        profileId,
        (msg) => {
          if (msg && msg.type === 'CLEANUP_EXTRA_TABS') {
            queueMicrotask(async () => {
              const busy =
                workboard.isCarrierBusy(profileId) ||
                (await featureExecution.isProfileBusy(profileId, [])) ||
                (await persistence.workspace.tasks.hasProfilePlanInStates(profileId, [
                  'QUEUED',
                  'RUNNING',
                ]));
              if (busy) cleanupTabsKilledActive += 1;
              core.extraTabsCleaned(peer, msg.requestId, {
                keptTabId: 1,
                closedTabIds: [],
                remainingTabCount: 1,
              });
            });
          } else if (msg && msg.type === 'CLOSE_BROWSER_WINDOWS') {
            queueMicrotask(() => {
              peer.online = false;
              peer.browserWindowCount = 0;
              core.browserWindowsClosed(peer, msg.requestId, {
                ok: true,
                closedCount: 1,
                remainingCount: 0,
                disconnected: true,
              });
            });
          }
        },
        () => {},
      );
      peer.online = markOnline;
      peer.phase = 'PAUSED';
      peer.synced = true;
      peer.browserWindowCount = markOnline ? 1 : 0;
      peer.extensionVersion = '0.3.99';
      peer.capabilities = [
        ...bridgeCapabilities,
        'browser-window-reveal-v1',
        'kernel-workspace-cleanup-v1',
        'browser-window-close-v1',
      ];
      return peer;
    };

    for (const pid of preOnlineBrowserSet) {
      connectSimulatedPeer(pid, true);
    }

    const profileSource = new BridgeProfileSource(core, persistence.bridge);
    const workspaceService = new WorkspaceService(persistence.workspace, profileSource);

    const profileLifecycle = {
      isLaunching: () => false,
      getStatus: async (ids) =>
        ids.map((profileId) => ({
          profileId,
          browserName: profileId.slice(0, 8),
          action: 'status',
          ok: true,
          online: currentOnlineBrowsers.has(profileId),
          phase: currentOnlineBrowsers.has(profileId) ? 'PAUSED' : 'OFFLINE',
          synced: currentOnlineBrowsers.has(profileId),
          launchable: true,
          elapsedMs: 0,
        })),
      launchProfile: async (profileId) => {
        if (!currentOnlineBrowsers.has(profileId)) {
          launchStartTimes.push(Date.now());
          await sleep(12);
          currentOnlineBrowsers.add(profileId);
          connectSimulatedPeer(profileId, true);
        }
        return {
          profileId,
          browserName: profileId.slice(0, 8),
          action: 'open',
          ok: true,
          online: true,
          phase: 'PAUSED',
          synced: true,
          launchable: true,
          elapsedMs: 12,
        };
      },
      closeProfile: async (profileId) => {
        closedOnFinishTargets.add(profileId);
        currentOnlineBrowsers.delete(profileId);
        const peer = core.peers.get(profileId);
        if (peer) {
          peer.online = false;
          peer.browserWindowCount = 0;
          await core.disconnect(peer).catch(() => {});
        }
        return {
          profileId,
          browserName: profileId.slice(0, 8),
          action: 'close',
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: true,
          elapsedMs: 2,
        };
      },
      restartProfile: async (profileId) => {
        await profileLifecycle.closeProfile(profileId);
        return profileLifecycle.launchProfile(profileId);
      },
      ensureProfilesOnline: async (ids) => {
        const readyIds = [];
        const launchedIds = [];
        for (const id of ids) {
          if (!currentOnlineBrowsers.has(id)) {
            launchStartTimes.push(Date.now());
            await sleep(12);
            currentOnlineBrowsers.add(id);
            connectSimulatedPeer(id, true);
            launchedIds.push(id);
          }
          readyIds.push(id);
        }
        return {
          requestedIds: [...ids],
          readyIds,
          launchedIds,
          failed: [],
          items: [],
        };
      },
    };

    // Track concurrent workers & chaos fault sets
    let activeRunnerCount = 0;
    let peakActiveRunners = 0;
    const onRunnerEnter = () => {
      activeRunnerCount += 1;
      peakActiveRunners = Math.max(peakActiveRunners, activeRunnerCount);
    };
    const onRunnerExit = () => {
      activeRunnerCount = Math.max(0, activeRunnerCount - 1);
    };

    const wsDisconnectProfiles = new Set([browserIds[10]]);
    const contextLostProfiles = new Set([browserIds[11]]);
    const browserCrashProfiles = new Set([browserIds[12], browserIds[13]]);
    const restrictedProfiles = new Set();
    const verificationProfiles = new Set();
    const unconfirmedPostProfiles = new Set();
    const abnormalReports = [];

    const kernelHarness = createChaosKernelHarness(core, {
      profileAccountMap,
      onWorkStart: onRunnerEnter,
      onWorkEnd: onRunnerExit,
      wsDisconnectProfiles,
      contextLostProfiles,
      browserCrashProfiles,
      restrictedProfiles,
      verificationProfiles,
      unconfirmedPostProfiles,
    });

    activeRuntime = new ActiveAccountRuntime({
      workboard,
      store: persistence.workspace,
      core,
      kernel: kernelHarness,
      profileSource,
      profileLifecycle,
      accountAbnormalReporter: async (report) => {
        abnormalReports.push(report);
      },
      otherModuleBusy: (profileId) => featureExecution.isProfileBusy(profileId, 'active-accounts'),
      dataDirectory: dataDir,
      uploadCacheRoot,
    });
    const taskService = new TaskService(persistence.workspace.tasks, () => activeRuntime);

    const bridgeBrowserWindow = new BridgeBrowserWindow(
      core,
      taskService,
      undefined,
      async (profileId) => {
        const busy =
          workboard.isCarrierBusy(profileId) ||
          (await featureExecution.isProfileBusy(profileId, [])) ||
          (await taskService.hasProfilePlanInStates(profileId, ['QUEUED', 'RUNNING']));
        if (busy) cleanupTabsKilledActive += 1;
        return {
          profileId,
          proof: { tabId: 1, url: 'https://www.facebook.com/', windowId: 1 },
          url: 'https://www.facebook.com/',
          closedTabIds: [],
          remainingTabCount: 1,
        };
      },
      async (profileId) =>
        workboard.isCarrierBusy(profileId) || (await featureExecution.isProfileBusy(profileId, [])),
    );

    // Seed shared bumper/poster/inviter targets & materials
    const bumperGroups = await persistence.workspace.groupBumper.upsertTargets('groups', {
      items: [
        { id: '1111111111', name: 'Chaos Group 1' },
        { id: '2222222222', name: 'Chaos Group 2' },
      ],
    });
    const bumperPages = await persistence.workspace.groupBumper.upsertTargets('pages', {
      items: [{ id: '3333333333', name: 'Chaos Page 1' }],
    });
    await persistence.workspace.groupBumper.saveComments(
      { texts: ['Nice post!'], scope: 'group' },
      'group',
    );

    const posterGroups = await persistence.workspace.groupPoster.upsertTargets({
      items: [
        { id: '4444444444', name: 'Poster Group A' },
        { id: '5555555555', name: 'Poster Group B' },
        { id: '6666666666', name: 'Poster Group C' },
        { id: '7777777777', name: 'Poster Group D' },
        { id: '8888888888', name: 'Poster Group E' },
        { id: '9999999999', name: 'Poster Group F' },
      ],
    });
    const savedMaterials = await persistence.workspace.groupPoster.saveMaterials({
      items: [
        {
          caption: 'Chaos stress post material',
          mediaSource: mediaFile,
          background: 'plain',
          aiLabel: 'default',
          selected: true,
        },
      ],
    });

    const inviterGroups = await persistence.workspace.groupInviter.upsertGroups({
      items: [{ groupId: '1212121212', groupName: 'Inviter Group 1' }],
    });

    // Track online-first launch ordering per module
    const bumperStartOrder = [];
    const posterStartOrder = [];
    const inviterStartOrder = [];
    const sheetsStartOrder = [];
    const bsBumperStartOrder = [];

    groupBumper = new GroupBumperService(
      persistence.workspace.groupBumper,
      {
        ready: (id) => currentOnlineBrowsers.has(id),
        busy: async (id) => featureExecution.isProfileBusy(id, ['group-bumper', 'page-bumper']),
        run: async (id, _groups, _pages, _settings, cb) => {
          bumperStartOrder.push(id);
          onRunnerEnter();
          try {
            if (id === browserIds[31]) {
              await sleep(25);
              throw new Error('RPC_TIMEOUT_FAULT');
            }
            await sleep(75);
            cb.added(1);
          } finally {
            onRunnerExit();
          }
        },
        stop: async () => {},
      },
      async () => ({
        comments: await persistence.workspace.groupBumper.comments('group'),
        total: await persistence.workspace.groupBumper.total('group'),
      }),
      () => {},
      undefined,
      0.01,
    );
    groupBumper.setWorkboard(workboard);
    groupBumper.setFeatureExecutionRegistry(featureExecution);
    groupBumper.setProfileLifecycle(profileLifecycle);
    groupBumper.setPostBumpRecords(persistence.workspace.postBumpRecords);
    groupBumper.setCheckDailyRiskLimit((pid, kind) =>
      persistence.workspace.activityStats.checkBrowserRiskLimit(pid, kind),
    );

    groupPoster = new GroupPosterService(
      persistence.workspace.groupPoster,
      {
        ready: (id) => currentOnlineBrowsers.has(id),
        busy: async (id) => featureExecution.isProfileBusy(id, 'group-poster'),
        runProfileWorker: async (id, _files, _settings, cb) => {
          posterStartOrder.push(id);
          onRunnerEnter();
          try {
            if (id === browserIds[39]) {
              await sleep(20);
              currentOnlineBrowsers.delete(id);
              throw new Error('BROWSER_CRASHED_MID_POST');
            }
            while (!cb.cancelled() && (await cb.canContinueAccount(id))) {
              const item = await cb.claimNextTask();
              if (!item) break;
              await sleep(70);
              await cb.onTaskPosted({
                id: randomUUID(),
                profileId: id,
                accountId: profileAccountMap.get(id) ?? '',
                groupId: item.group.id,
                groupName: item.group.name,
                materialId: item.material.id,
                postId: String(Date.now()),
                postUrl: `https://www.facebook.com/groups/${item.group.id}/posts/1`,
                postedAt: Date.now(),
              });
            }
          } finally {
            onRunnerExit();
          }
        },
        stop: async () => {},
      },
      {
        prepare: async () => ({
          localFilePath: mediaFile,
          mediaKind: 'image',
          thumbnailDataUrl: null,
        }),
      },
      featureExecution,
    );
    groupPoster.setWorkboard(workboard);
    groupPoster.setProfileLifecycle(profileLifecycle);
    groupPoster.setPostBumpRecords(persistence.workspace.postBumpRecords);
    groupPoster.setCheckDailyRiskLimit((pid, kind) =>
      persistence.workspace.activityStats.checkBrowserRiskLimit(pid, kind),
    );

    groupInviter = new GroupInviterService(persistence.workspace.groupInviter, {
      isAvailable: () => true,
      isProfileReady: (id) => currentOnlineBrowsers.has(id),
      isProfileBusy: async (id) => featureExecution.isProfileBusy(id, 'group-inviter'),
      inviteForGroup: async (id, _group, _invitesPerGroup, cb) => {
        inviterStartOrder.push(id);
        onRunnerEnter();
        try {
          await sleep(60);
          cb.addSessionInvited(id, 1);
        } finally {
          onRunnerExit();
        }
      },
    });
    groupInviter.setWorkboard(workboard);
    groupInviter.setFeatureExecutionRegistry(featureExecution);
    groupInviter.setProfileLifecycle(profileLifecycle);
    groupInviter.setCheckDailyRiskLimit((pid, kind) =>
      persistence.workspace.activityStats.checkBrowserRiskLimit(pid, kind),
    );

    const bsDevices = {
      getOnlineKeys: () => currentOnlineBsKeys,
      discoverInstances: async () => ({
        instances: await persistence.workspace.bluestacks.listInstances([...currentOnlineBsKeys]),
        config: {
          installDir: 'C:\\Program Files\\BlueStacks_nxt',
          confPath: 'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf',
          adbPath: 'adb.exe',
          apkPath: null,
        },
      }),
      launchInstance: async (instanceId) => {
        const key = bsKeyById.get(instanceId);
        if (key && !currentOnlineBsKeys.has(key)) {
          launchStartTimes.push(Date.now());
          await sleep(15);
          currentOnlineBsKeys.add(key);
        }
        return (
          await persistence.workspace.bluestacks.listInstances([...currentOnlineBsKeys])
        ).find((i) => i.id === instanceId);
      },
      closeInstance: async (instanceId) => {
        closedOnFinishTargets.add(instanceId);
        const key = bsKeyById.get(instanceId);
        if (key) currentOnlineBsKeys.delete(key);
      },
      inspectAccount: async (instanceId) =>
        (await persistence.workspace.bluestacks.listInstances([...currentOnlineBsKeys])).find(
          (i) => i.id === instanceId,
        ),
    };

    const bluestacks = new BluestacksService(
      persistence.workspace.bluestacks,
      bsDevices,
      {
        run: async (instanceId, _groups, _pages, _settings, _signal, cb) => {
          bsBumperStartOrder.push(instanceId);
          onRunnerEnter();
          try {
            await sleep(75);
            cb.added(1);
          } finally {
            onRunnerExit();
          }
        },
        runDirectPosts: async (instanceId, posts, _settings, _pool, _signal, cb) => {
          onRunnerEnter();
          try {
            for (const p of posts) {
              await sleep(45);
              await cb.onPostDone?.({ postId: p.postId, liked: true, commented: false });
            }
            return { bumped: posts.length, attempted: posts.length };
          } finally {
            onRunnerExit();
          }
        },
      },
      featureExecution,
      {
        activeRunner: {
          run: async (instanceId, _steps, _signal, cb) => {
            onRunnerEnter();
            try {
              await sleep(65);
              cb.action('like');
              return {
                completedSteps: 1,
                skippedSteps: 0,
                likes: 1,
                acceptedFriends: 0,
                published: 0,
                notes: [],
              };
            } finally {
              onRunnerExit();
            }
          },
        },
        posterRunner: {
          run: async (instanceId, materials, groups, opts, _signal, cb) => {
            onRunnerEnter();
            try {
              const job = opts.claimNextGroupJob
                ? await opts.claimNextGroupJob()
                : groups[0] && materials[0]
                  ? { group: groups[0], material: materials[0] }
                  : null;
              if (job) {
                await sleep(55);
                await cb.onPostLog?.(
                  {
                    id: randomUUID(),
                    profileId: instanceId,
                    accountId: 'bsacc',
                    groupId: job.group.id,
                    groupName: job.group.name,
                    materialId: job.material.id,
                    postId: String(Date.now()),
                    postUrl: 'https://www.facebook.com/groups/1/posts/1',
                    postedAt: Date.now(),
                  },
                  false,
                );
                opts.releaseGroupJob?.(job.group.id, job.material.id, true);
                cb.posted();
              }
              return { posted: job ? 1 : 0, skipped: 0, notes: [] };
            } finally {
              onRunnerExit();
            }
          },
        },
        listCombinations: () => persistence.workspace.combinations(),
        listPosterMaterials: () => persistence.workspace.groupPoster.materials(),
      },
    );
    bluestacks.setWorkboard(workboard);
    bluestacks.setPostBumpRecords(persistence.workspace.postBumpRecords);

    // Google Sheets Service for browser + BS direct post bumping
    const sheetsRecordsLink = await persistence.workspace.googleSheets.createLink({
      kind: 'post_records',
      title: 'Chaos Records Sheet',
      spreadsheetId: 'sheet-chaos-1',
      spreadsheetTitle: 'Chaos Sheet',
      sheetId: 1,
      sheetName: 'Records',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-chaos-1/edit',
      recordsConfig: {
        enabled: true,
        machineName: 'ChaosPC',
        bumperProfileIds: [browserIds[9], browserIds[49]],
        bumperBluestacksIds: [bsIds[2], bsIds[12]],
        bumperSettings: {
          maxLikesPerPost: 2,
          maxPostAgeHours: 72,
          likeProbability: 100,
          commentProbability: 0,
        },
        collectMetricsOnThisPc: false,
      },
    });
    const sheetCells = [];
    googleSheets = new GoogleSheetsService(persistence.workspace.googleSheets, {
      workspace: workspaceService,
      groupBumper,
      bluestacks,
      oauth: {
        status: async () => ({
          configured: true,
          authorized: true,
          authorizedEmail: 'chaos@example.com',
          lastError: null,
        }),
        importCredentialsJson: async () => {
          throw new Error('unused');
        },
        startAuthSession: async () => {
          throw new Error('unused');
        },
        completeManualAuth: async () => {
          throw new Error('unused');
        },
        revokeAuth: async () => {
          throw new Error('unused');
        },
        getValidAccessToken: async () => 'tok',
        shutdown: async () => {},
      },
      sheetsApi: {
        getSpreadsheetMeta: async () => ({
          spreadsheetId: 'sheet-chaos-1',
          title: 'Chaos Sheet',
          sheets: [{ sheetId: 1, title: 'Records', index: 0 }],
        }),
        readSheetValues: async () => ({
          formulaRows: [
            ['时间', '小组', '专页', '贴文链接', 'ChaosPC'],
            [
              '2026-11-27 12:00',
              'G1',
              'P1',
              'https://www.facebook.com/groups/111/posts/999001',
              '0',
            ],
          ],
          formattedRows: [
            ['时间', '小组', '专页', '贴文链接', 'ChaosPC'],
            [
              '2026-11-27 12:00',
              'G1',
              'P1',
              'https://www.facebook.com/groups/111/posts/999001',
              '0',
            ],
          ],
        }),
        batchUpdateCells: async (_id, _name, updates) => {
          sheetCells.push(...updates);
        },
        appendRows: async () => {},
        deleteRowsDescending: async () => {},
        ensureHeaderColumn: async () => 4,
      },
      imageHost: {
        uploadDataUrlOrUrl: async () => null,
        testUpload: async () => ({ remoteUrl: 'https://img.example/1.png', host: 'gyazo' }),
      },
      automation: {
        publishScheduledMaterial: async () => ({ postedCount: 0, timelinePosted: false }),
        prepareMaterialMedia: async () => ({
          localFilePath: mediaFile,
          mediaKind: 'image',
          thumbnailDataUrl: null,
        }),
        bumpDirectPosts: async (input) => {
          sheetsStartOrder.push(input.profileId);
          onRunnerEnter();
          try {
            const results = [];
            for (const p of input.posts) {
              await sleep(50);
              const res = {
                postCode: p.postCode,
                postUrl: p.postUrl,
                bumped: true,
                liked: true,
                commented: false,
              };
              await input.onPostBumped(res);
              results.push(res);
            }
            return results;
          } finally {
            onRunnerExit();
          }
        },
        scrapePostMetrics: async () => [],
      },
      featureExecution,
      profileLifecycle,
      postBumpRecords: persistence.workspace.postBumpRecords,
    });
    googleSheets.setWorkboard(workboard);

    // Register all participants
    ensureFeatureExecutionRegistry(featureExecution, {
      tasks: taskService,
      groupInviter,
      groupBumper,
      groupPoster,
      bluestacks,
    });

    autoScheduler = new AutoSchedulerService(persistence.workspace.autoScheduler, {
      workspace: workspaceService,
      workboard,
      tasks: taskService,
      groupBumper,
      groupPoster,
      groupInviter,
      bluestacks,
      profileLifecycle,
      featureExecution,
      pollIntervalMs: 25,
    });
    await autoScheduler.saveSettings({
      browserConcurrency: 5,
      bluestacksConcurrency: 5,
      launchStaggerSeconds: 0,
      idleWatchdogMinutes: 5,
      preventSystemSleep: false,
    });
    await autoScheduler.start();

    // Create reusable combinations
    const emptyPostCombo = await persistence.workspace.createCombination({
      name: 'Chaos Active Post (Table)',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          count: 1,
          destination: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          allowRepeat: true,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const emptyRev = (
      await persistence.workspace.resourceTables.save(emptyPostCombo.id, 0, [
        {
          id: randomUUID(),
          purpose: 'story',
          aiLabel: 'preserve-current',
          text: 'Story-only row so post step exercises lease and skips exhausted',
          media: [],
          background: 'plain',
        },
      ])
    ).revision;

    const bsActiveCombo = await persistence.workspace.createCombination({
      name: 'Chaos BS Active',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });

    // Scheduler schedules for Phase 1
    const browserScheduleState = await autoScheduler.saveSchedule({
      name: 'Chaos Browser Schedule',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [
          ...browserIds.slice(2, 4),
          ...browserIds.slice(20, 30),
          browserIds[0], // busy overlap with Active Accounts
          browserIds[10], // busy overlap with Active Accounts
        ],
        skipAbnormalAccounts: true,
      },
      trigger: {
        mode: 'weekly',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 120,
      },
      steps: [
        {
          id: randomUUID(),
          type: 'group-bumper',
          groupIds: [bumperGroups[0].id],
          pageIds: [bumperPages[0].id],
        },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: 10,
    });
    const browserScheduleId = browserScheduleState.schedules[0].id;
    for (const tid of [...browserIds.slice(2, 4), ...browserIds.slice(20, 30)]) {
      expectedCloseOnFinishTargets.add(tid);
    }

    const bsScheduleState = await autoScheduler.saveSchedule({
      name: 'Chaos BS Schedule',
      enabled: true,
      carrier: 'bluestacks',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [...bsIds.slice(0, 2), ...bsIds.slice(4, 12)],
        skipAbnormalAccounts: true,
      },
      trigger: {
        mode: 'weekly',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 120,
      },
      steps: [
        {
          id: randomUUID(),
          type: 'bluestacks-active-combination',
          combinationId: bsActiveCombo.id,
        },
        {
          id: randomUUID(),
          type: 'bluestacks-group-bumper',
          groupIds: [bumperGroups[0].id],
          pageIds: [bumperPages[0].id],
        },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: 10,
    });
    const bsScheduleId = bsScheduleState.schedules.find((s) => s.carrier === 'bluestacks').id;
    for (const bsid of [...bsIds.slice(0, 2), ...bsIds.slice(4, 12)]) {
      expectedCloseOnFinishTargets.add(bsid);
    }

    // =========================================================================
    // PHASE 1: Multi-Module Concurrent Slot Contention (50 browser + 20 BS)
    //          + Dynamic Hot Concurrency Resize (5 -> 12 -> 3 -> 5)
    //          + Fault 1 (cleanup-tabs storm), Fault 2 (WS/context/RPC), Fault 3 (crash)
    // =========================================================================
    let currentLimitBound = 5;
    let drainingFromPreviousCap = 5;
    let peakBrowserUsed = 0;
    let peakBluestacksUsed = 0;
    const phasePeaks = { initial5: 0, up12: 0, down3: 0, final5: 0 };
    let currentPhaseKey = 'initial5';
    let downscaleSettledTo3 = false;
    let limitViolations = 0;

    sampler = setInterval(() => {
      const bUsed = workboard.browserPermits.used;
      const bsUsed = workboard.bluestacksPermits.used;
      peakBrowserUsed = Math.max(peakBrowserUsed, bUsed);
      peakBluestacksUsed = Math.max(peakBluestacksUsed, bsUsed);
      phasePeaks[currentPhaseKey] = Math.max(phasePeaks[currentPhaseKey], bUsed);

      if (currentPhaseKey === 'down3') {
        if (bUsed <= 3) downscaleSettledTo3 = true;
        if (downscaleSettledTo3 && bUsed > 3) limitViolations += 1;
        if (bUsed > drainingFromPreviousCap) limitViolations += 1;
      } else if (bUsed > currentLimitBound) {
        limitViolations += 1;
      }
      if (bsUsed > 5) limitViolations += 1;
    }, 5);
    sampler.unref?.();

    // Start Fault 1: High-frequency cleanup-tabs storm against busy & idle profiles every 35ms
    let stormActive = true;
    let cleanupStormPromise = Promise.resolve();
    stopStorm = async () => {
      stormActive = false;
      await cleanupStormPromise.catch(() => {});
    };
    cleanupStormPromise = (async () => {
      try {
        while (stormActive) {
          const busyTargets = workboard.busyCarrierIds().filter((id) => !id.startsWith('bs:'));
          if (busyTargets.length > 0) {
            const preCleanable = [];
            for (const id of busyTargets) {
              if (!stormActive) break;
              const labels = await featureExecution.busyModuleLabels([id]);
              const carrierBusy = workboard.isCarrierBusy(id);
              if (labels.length > 0 || carrierBusy) {
                cleanupTabsBlockedCount += 1;
              } else {
                preCleanable.push(id);
              }
            }
            if (!stormActive) break;
            // Also hammer BridgeBrowserWindow.cleanupTabs directly against busy peers!
            const res = await bridgeBrowserWindow.cleanupTabs(busyTargets, false).catch(() => ({
              cleanedProfiles: 0,
              closedTabs: 0,
              skippedBusy: 0,
              skippedOffline: 0,
            }));
            cleanupTabsBlockedCount += res.skippedBusy;
            if (preCleanable.length > 0) {
              const res2 = await bridgeBrowserWindow.cleanupTabs(preCleanable, false);
              cleanupTabsBlockedCount += res2.skippedBusy;
            }
          }
          await sleep(35);
        }
      } catch {
        // Ignore transient cleanup storm errors if runtime shuts down on failure
      }
    })();

    // Launch all 6 browser modules + BlueStacks concurrently
    const activeStartProfiles = [...browserIds.slice(0, 2), ...browserIds.slice(10, 20)];
    await taskService.start({
      requestId: randomUUID(),
      combinationId: emptyPostCombo.id,
      version: emptyPostCombo.version,
      expectedResourceRevision: emptyRev,
      profileIds: activeStartProfiles,
      closeBrowserOnFinish: true,
    });
    for (const pid of activeStartProfiles) expectedCloseOnFinishTargets.add(pid);

    await autoScheduler.runNow({ id: browserScheduleId });
    await autoScheduler.runNow({ id: bsScheduleId });
    // Enforce 20ms stress stagger after autoScheduler.runNow synced settings
    workboard.setConcurrencyLimits({
      browserConcurrency: 5,
      bluestacksConcurrency: 5,
      launchStaggerMs: 20,
    });

    const bumperPromise = groupBumper.start({
      profileIds: [...browserIds.slice(4, 6), ...browserIds.slice(30, 38)],
      groupIds: [bumperGroups[0].id],
      pageIds: [bumperPages[0].id],
    });

    const posterState = await groupPoster.createTask({
      materialId: savedMaterials[0].id,
      groupIds: posterGroups.map((g) => g.id),
      accountMode: 'selected',
      profileIds: [...browserIds.slice(6, 8), ...browserIds.slice(38, 44)],
      scheduledAt: null,
    });

    const inviterPromise = groupInviter.start({
      profileIds: [browserIds[8], ...browserIds.slice(44, 49)],
      groupIds: [inviterGroups[0].groupId],
      invitesPerGroup: 2,
    });

    const sheetsPollPromise = googleSheets.triggerRecordsPoll(sheetsRecordsLink.id);

    await bluestacks.startBumper({
      profileIds: [bsIds[3], ...bsIds.slice(13, 17)],
      groupIds: [bumperGroups[0].id],
      pageIds: [bumperPages[0].id],
    });
    await bluestacks.startActive({
      instanceIds: bsIds.slice(17, 20),
      quickStep: { type: 'feed', durationMinutes: 1, maxLikes: 1 },
    });

    // Dynamic hot-resize: 5 -> 12 -> 3 -> 5
    await sleep(320);
    currentPhaseKey = 'up12';
    currentLimitBound = 12;
    workboard.setConcurrencyLimits({ browserConcurrency: 12 });

    await sleep(380);
    currentPhaseKey = 'down3';
    drainingFromPreviousCap = Math.max(3, workboard.browserPermits.used);
    currentLimitBound = 3;
    workboard.setConcurrencyLimits({ browserConcurrency: 3 });

    await sleep(450);
    currentPhaseKey = 'final5';
    currentLimitBound = 5;
    workboard.setConcurrencyLimits({ browserConcurrency: 5 });

    // Wait for all Phase 1 work across all modules to settle
    await Promise.allSettled([bumperPromise, inviterPromise, sheetsPollPromise]);
    await waitUntil(
      async () =>
        !(await taskService.hasActiveExecution()) &&
        !autoScheduler.hasActiveExecution() &&
        !groupBumper.hasActiveExecution() &&
        !groupPoster.hasActiveExecution() &&
        !groupInviter.hasActiveExecution() &&
        !googleSheets.hasActiveExecution() &&
        !bluestacks.hasActiveExecution() &&
        !workboard.hasAnyActive(),
      25_000,
      'phase1_all_modules_idle',
    ).catch(async (err) => {
      const diag = {
        tasks: await taskService.hasActiveExecution(),
        autoScheduler: autoScheduler.hasActiveExecution(),
        autoSnap: autoScheduler.getActiveCarrierSnapshot(),
        bumper: groupBumper.hasActiveExecution(),
        poster: groupPoster.hasActiveExecution(),
        inviter: groupInviter.hasActiveExecution(),
        sheets: googleSheets.hasActiveExecution(),
        bluestacks: bluestacks.hasActiveExecution(),
        workboardBusy: workboard.busyCarrierIds(),
        browserUsed: workboard.browserPermits.used,
        bsUsed: workboard.bluestacksPermits.used,
      };
      throw new Error(`${err.message} :: ${JSON.stringify(diag)}`);
    });

    stormActive = false;
    await cleanupStormPromise;
    clearInterval(sampler);

    assert.equal(limitViolations, 0, `Concurrency limit violated ${limitViolations} times`);
    assert.ok(phasePeaks.initial5 <= 5, `initial5 peak ${phasePeaks.initial5} > 5`);
    assert.ok(phasePeaks.up12 <= 12, `up12 peak ${phasePeaks.up12} > 12`);
    assert.ok(downscaleSettledTo3, 'downscale 12 -> 3 must drain down to <= 3');
    assert.ok(phasePeaks.final5 <= 5, `final5 peak ${phasePeaks.final5} > 5`);
    assert.equal(workboard.browserPermits.used, 0, 'browserPermits leaked after Phase 1');
    assert.equal(workboard.bluestacksPermits.used, 0, 'bluestacksPermits leaked after Phase 1');
    assert.equal(cleanupTabsKilledActive, 0, 'cleanupTabs cleaned an active profile!');
    assert.ok(cleanupTabsBlockedCount > 0, 'cleanupTabs storm should have blocked busy profiles');
    assert.ok((posterState.tasks ?? []).length > 0, 'GroupPoster task should be created');

    // Verify online-first priority in module start order
    const firstBumperOnline = preOnlineBrowserSet.has(bumperStartOrder[0]);
    const firstInviterOnline = preOnlineBrowserSet.has(inviterStartOrder[0]);
    const firstSheetsOnline = preOnlineBrowserSet.has(sheetsStartOrder[0]);
    const firstBsOnline =
      currentOnlineBsKeys.has(bsKeyById.get(bsBumperStartOrder[0])) ||
      bsIds.slice(0, 4).includes(bsBumperStartOrder[0]);
    assert.ok(
      firstBumperOnline && firstInviterOnline && firstSheetsOnline && firstBsOnline,
      `Online-first priority failed: bumper=${firstBumperOnline}, inviter=${firstInviterOnline}, sheets=${firstSheetsOnline}, bs=${firstBsOnline}`,
    );

    // Verify launchStaggerMs > 0 ordering across staggered launches
    if (launchStartTimes.length >= 2) {
      let nonZeroGaps = 0;
      for (let i = 1; i < launchStartTimes.length; i++) {
        if (launchStartTimes[i] - launchStartTimes[i - 1] >= 10) nonZeroGaps += 1;
      }
      assert.ok(
        nonZeroGaps > 0,
        'Expected non-zero launch stagger spacing across offline launches',
      );
    }

    // Verify Fault 2 & Fault 3 isolated settlement on ActiveAccountRuntime plans
    const allPhase1Plans = await persistence.workspace.tasks.list();
    for (const faultPid of [browserIds[10], browserIds[11], browserIds[12], browserIds[13]]) {
      const p = allPhase1Plans.find((plan) => plan.profileId === faultPid);
      assert.ok(
        p && ['FAILED', 'STOPPED'].includes(p.state),
        `Fault profile ${faultPid} should settle cleanly, got ${p?.state}`,
      );
    }

    // =========================================================================
    // PHASE 2: Fault 4 (5-cap daily risk limits) + Fault 5 (Restricted/Verif/Unconfirmed + closeOnFinish)
    // =========================================================================
    await persistence.workspace.activityStats.saveBrowserRiskLimits({
      enabled: true,
      dailyMaxTotalActions: 8,
      dailyMaxBumps: 5,
      dailyMaxPosts: 2,
      dailyMaxInvites: 5,
      dailyMaxActiveLikes: 2,
      perTargetOverrides: {},
    });
    await persistence.workspace.bluestacks.saveRiskLimitSettings({
      enabled: true,
      dailyMaxTotalActions: 6,
      dailyMaxBumps: 3,
      dailyMaxPosts: 1,
      dailyMaxInvites: 3,
      dailyMaxActiveLikes: 2,
      perInstanceOverrides: {},
    });

    // Fault 4a: dailyMaxActiveLikes hit on Chrome & BS
    const riskLikeChrome = browserIds[40];
    await persistence.workspace.activityStats.recordDailyActivity({
      carrier: 'browser',
      profileId: riskLikeChrome,
      accountId: profileAccountMap.get(riskLikeChrome),
      likesDelta: 2,
      actionsDelta: 2,
    });
    const chromeLikeCap = await persistence.workspace.activityStats.checkBrowserRiskLimit(
      riskLikeChrome,
      'active-like',
    );
    assert.equal(
      chromeLikeCap.allowed,
      false,
      'Chrome dailyMaxActiveLikes cap should block at 2/2',
    );

    const riskLikeBs = bsIds[15];
    await persistence.workspace.bluestacks.recordDailyActiveAction(riskLikeBs, 'like', 2);
    const bsActiveCapStep = await bluestacks.runScheduledActiveStep({
      instanceId: riskLikeBs,
      combinationId: bsActiveCombo.id,
      onProgress: () => {},
    });
    assert.equal(
      bsActiveCapStep.softIssue,
      false,
      'BS dailyMaxActiveLikes skip must have softIssue: false',
    );
    assert.equal(bsActiveCapStep.hardBlocked, false);

    // Verify BS in-step BluestacksActiveRunner graceful degrade on checkRiskLimit('like')
    const bsRunner = new BluestacksActiveRunner(
      {
        ensureReadyAndLoggedIn: async (id) =>
          (await persistence.workspace.bluestacks.listInstances([bsKeyById.get(id)])).find(
            (i) => i.id === id,
          ),
        screencap: async () => Buffer.alloc(64),
        dumpXml: async () => ({
          tag: 'hierarchy',
          bounds: { x1: 0, y1: 0, x2: 900, y2: 1600, cx: 450, cy: 800, w: 900, h: 1600 },
          clickable: false,
          text: '',
          contentDesc: '',
          resourceId: '',
          className: '',
          children: [],
        }),
        detectAbnormalScreen: async () => null,
        isLoginOrLoggedOutXml: () => false,
        tap900: async () => {},
        swipe900: async () => {},
        openDeepLink: async () => {},
        keyevent: async () => {},
      },
      { recognize: async () => '', recognizeBounds: async () => '' },
    );
    const bsDegradeAbort = new AbortController();
    const bsDegradeStatuses = [];
    const bsDegradeSafetyTimer = setTimeout(() => bsDegradeAbort.abort('SAFETY_TIMEOUT'), 6000);
    bsDegradeSafetyTimer.unref?.();
    await bsRunner
      .run(
        bsIds[16],
        [{ type: 'feed', durationMinutes: 1, maxLikes: 3, likeProbability: 100 }],
        bsDegradeAbort.signal,
        {
          status: (t) => {
            bsDegradeStatuses.push(t);
            if (t.includes('继续浏览首页')) bsDegradeAbort.abort('DONE_DEGRADE_CHECK');
          },
          action: () => {},
          checkRiskLimit: async (kind) =>
            kind === 'like'
              ? { allowed: false, reason: '今日已达蓝蝶风控活跃点赞日限额' }
              : { allowed: true, reason: null },
        },
      )
      .catch(() => {})
      .finally(() => clearTimeout(bsDegradeSafetyTimer));
    assert.ok(
      bsDegradeStatuses.some((s) => s.includes('继续浏览首页')),
      `Expected BS active runner graceful degrade on like limit, got: ${JSON.stringify(bsDegradeStatuses)}`,
    );

    // Fault 4b: dailyMaxPosts hit -> Chrome ActiveAccountRuntime DAILY_LIMIT_SKIP + AutoScheduler skipped (softIssue: false)
    const riskPostChrome = browserIds[41];
    for (let k = 0; k < 2; k++) {
      await persistence.workspace.postBumpRecords.insert({
        recordType: 'post',
        carrier: 'browser',
        status: 'success',
        profileId: riskPostChrome,
        accountId: profileAccountMap.get(riskPostChrome) ?? '',
        groupId: posterGroups[0].id,
        groupName: posterGroups[0].name,
        postId: `seed-post-${k}`,
      });
    }
    const postWithRowCombo = await persistence.workspace.createCombination({
      name: 'Chaos Post With Row',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          count: 1,
          destination: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          allowRepeat: true,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const postTable = await persistence.workspace.resourceTables.save(postWithRowCombo.id, 0, [
      {
        id: randomUUID(),
        purpose: 'both',
        aiLabel: 'preserve-current',
        text: 'Risk limit test post',
        media: [],
        background: 'plain',
      },
    ]);

    const prePostRecordsCount = (
      await persistence.workspace.postBumpRecords.list({ limit: 500 })
    ).records.filter((r) => r.profileId === riskPostChrome && r.status === 'success').length;
    await taskService.start({
      requestId: randomUUID(),
      combinationId: postWithRowCombo.id,
      version: postWithRowCombo.version,
      expectedResourceRevision: postTable.revision,
      profileIds: [riskPostChrome],
      closeBrowserOnFinish: true,
    });
    expectedCloseOnFinishTargets.add(riskPostChrome);
    await waitUntil(
      async () => !(await taskService.hasActiveExecution()),
      8_000,
      'riskPostChrome_idle',
    );
    const postPostRecordsCount = (
      await persistence.workspace.postBumpRecords.list({ limit: 500 })
    ).records.filter((r) => r.profileId === riskPostChrome && r.status === 'success').length;
    assert.equal(
      postPostRecordsCount,
      prePostRecordsCount,
      'DAILY_LIMIT_SKIP must produce 0 new success posts',
    );

    // Fault 4c: dailyMaxTotalActions including activeFriends (2 likes + 3 friends + 2 bumps + 1 post = 8/8)
    const riskTotalChrome = browserIds[42];
    await persistence.workspace.activityStats.recordDailyActivity({
      carrier: 'browser',
      profileId: riskTotalChrome,
      accountId: profileAccountMap.get(riskTotalChrome),
      likesDelta: 2,
      friendsDelta: 3,
      actionsDelta: 5,
    });
    await persistence.workspace.postBumpRecords.insert({
      recordType: 'group_bump',
      carrier: 'browser',
      status: 'success',
      profileId: riskTotalChrome,
      accountId: profileAccountMap.get(riskTotalChrome) ?? '',
      groupId: bumperGroups[0].id,
      postId: 'seed-bump-1',
    });
    await persistence.workspace.postBumpRecords.insert({
      recordType: 'group_bump',
      carrier: 'browser',
      status: 'success',
      profileId: riskTotalChrome,
      accountId: profileAccountMap.get(riskTotalChrome) ?? '',
      groupId: bumperGroups[1].id,
      postId: 'seed-bump-2',
    });
    await persistence.workspace.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'browser',
      status: 'success',
      profileId: riskTotalChrome,
      accountId: profileAccountMap.get(riskTotalChrome) ?? '',
      groupId: posterGroups[0].id,
      postId: 'seed-post-total',
    });
    assert.equal(
      computeTotalDailyActions({
        groupBumpsToday: 2,
        pageBumpsToday: 0,
        postsToday: 1,
        invitesToday: 0,
        activeLikesToday: 2,
        activeFriendsToday: 3,
      }),
      8,
    );
    const totalCapCheck = await persistence.workspace.activityStats.checkBrowserRiskLimit(
      riskTotalChrome,
      'bump',
    );
    assert.equal(
      totalCapCheck.allowed,
      false,
      'dailyMaxTotalActions including activeFriends must block',
    );
    const riskLimitsCfg = await persistence.workspace.activityStats.getBrowserRiskLimits();
    assert.equal(
      evaluateDailyRiskQuota(riskLimitsCfg, riskLimitsCfg.perTargetOverrides, riskTotalChrome, {
        groupBumpsToday: 2,
        pageBumpsToday: 0,
        postsToday: 1,
        invitesToday: 0,
        activeLikesToday: 2,
        activeActionsToday: 5,
        activeFriendsToday: 3,
      }).allowed,
      false,
    );

    const riskSchedState = await autoScheduler.saveSchedule({
      name: 'Chaos Risk Limit Schedule',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [riskPostChrome, riskTotalChrome],
        skipAbnormalAccounts: false,
      },
      trigger: {
        mode: 'weekly',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 120,
      },
      steps: [
        {
          id: randomUUID(),
          type: 'group-poster',
          materialIds: [savedMaterials[0].id],
          groupIds: [posterGroups[0].id],
          maxGroupsPerProfile: 1,
        },
        {
          id: randomUUID(),
          type: 'group-bumper',
          groupIds: [bumperGroups[0].id],
          pageIds: [bumperPages[0].id],
        },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: 10,
    });
    const riskSchedId = riskSchedState.schedules.find(
      (s) => s.name === 'Chaos Risk Limit Schedule',
    ).id;
    await autoScheduler.runNow({ id: riskSchedId });
    await waitUntil(() => !autoScheduler.hasActiveExecution(), 8_000, 'risk_sched_idle');
    const recentAfterRisk = (await autoScheduler.state()).recentRuns.find(
      (r) => r.scheduleId === riskSchedId,
    );
    assert.ok(recentAfterRisk, 'Risk schedule run should be persisted');
    assert.equal(
      recentAfterRisk.softIssueCount,
      0,
      'Daily risk limit hits must settle with softIssue: false',
    );
    assert.equal(
      recentAfterRisk.completedCount,
      2,
      'Scheduler risk-limit skip items settle cleanly without soft warnings',
    );

    // Fault 5: ACCOUNT_RESTRICTED, VERIFICATION_REQUIRED, PUBLISH_RESULT_UNCONFIRMED + closeOnFinish = true
    const restrictedPid = browserIds[43];
    const verifPid = browserIds[44];
    const unconfirmedPid = browserIds[45];
    restrictedProfiles.add(restrictedPid);
    verificationProfiles.add(verifPid);
    unconfirmedPostProfiles.add(unconfirmedPid);
    for (const pid of [restrictedPid, verifPid, unconfirmedPid]) {
      expectedCloseOnFinishTargets.add(pid);
    }

    const fault5Batch = await taskService.start({
      requestId: randomUUID(),
      combinationId: postWithRowCombo.id,
      version: postWithRowCombo.version,
      expectedResourceRevision: postTable.revision,
      profileIds: [restrictedPid, verifPid, unconfirmedPid],
      closeBrowserOnFinish: true,
    });
    await waitUntil(async () => !(await taskService.hasActiveExecution()), 8_000, 'fault5_idle');

    let unconfirmedPreservedUnknown = 0;
    let falseVerifiedCount = 0;

    const unconfirmedPlan = fault5Batch.plans.find((p) => p.profileId === unconfirmedPid);
    assert.ok(unconfirmedPlan);
    const unconfirmedSteps = await persistence.workspace.tasks.steps(unconfirmedPlan.id);
    assert.equal(unconfirmedSteps[0].status, 'FAILED');
    assert.equal(unconfirmedSteps[0].outcome?.kind, 'FAILED');
    assert.equal(
      unconfirmedSteps[0].outcome?.businessResult,
      'UNKNOWN',
      'PUBLISH_RESULT_UNCONFIRMED must preserve UNKNOWN businessResult',
    );
    assert.equal(
      unconfirmedSteps[0].outcome?.submissionPhase,
      'UNKNOWN',
      'PUBLISH_RESULT_UNCONFIRMED must preserve UNKNOWN submissionPhase (never STEP_TYPE_SUBMISSION_MISMATCH)',
    );
    unconfirmedPreservedUnknown += 1;

    const fault5PostRecords = (
      await persistence.workspace.postBumpRecords.list({ limit: 500 })
    ).records.filter((r) => [restrictedPid, verifPid, unconfirmedPid].includes(r.profileId));
    for (const rec of fault5PostRecords) {
      if (rec.status === 'success') falseVerifiedCount += 1;
    }
    assert.ok(
      fault5PostRecords.some((r) => r.profileId === unconfirmedPid && r.status === 'failed'),
      'Unconfirmed post must be recorded as failed in post_bump_records, never success',
    );
    assert.ok(
      abnormalReports.some((r) => r.profileId === restrictedPid && r.state === 'restricted') &&
        abnormalReports.some((r) => r.profileId === verifPid && r.state === 'verification'),
      'ACCOUNT_RESTRICTED and VERIFICATION_REQUIRED must trigger accountAbnormalReporter',
    );

    const unclosedOnFinishCount = [...expectedCloseOnFinishTargets].filter(
      (id) => !closedOnFinishTargets.has(id),
    ).length;
    assert.equal(
      unclosedOnFinishCount,
      0,
      'All closeOnFinish targets must close cleanly in finally',
    );

    // =========================================================================
    // PHASE 3: Fault 6 (Simulated Cold Crash + Restart Recovery + Active/Expired `once` + FK check)
    // =========================================================================
    const nowMs = Date.now();
    const activeOnceRes = await autoScheduler.saveSchedule({
      name: 'Chaos Active Once Schedule',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [browserIds[0]],
        skipAbnormalAccounts: false,
      },
      trigger: {
        mode: 'once',
        onceAt: nowMs + 600_000,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 30,
      },
      steps: [
        {
          id: randomUUID(),
          type: 'group-bumper',
          groupIds: [bumperGroups[0].id],
          pageIds: [bumperPages[0].id],
        },
      ],
      closeWindowOnFinish: true,
    });
    const activeOnceId = activeOnceRes.schedules.find(
      (s) => s.name === 'Chaos Active Once Schedule',
    ).id;

    const expiredOnceRes = await autoScheduler.saveSchedule({
      name: 'Chaos Expired Once Schedule',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [browserIds[0]],
        skipAbnormalAccounts: false,
      },
      trigger: {
        mode: 'once',
        onceAt: nowMs - 10 * 3600_000,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['00:00'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 5,
      },
      steps: [
        {
          id: randomUUID(),
          type: 'group-bumper',
          groupIds: [bumperGroups[0].id],
          pageIds: [bumperPages[0].id],
        },
      ],
      closeWindowOnFinish: true,
    });
    const expiredOnceId = expiredOnceRes.schedules.find(
      (s) => s.name === 'Chaos Expired Once Schedule',
    ).id;

    // Seed an active running/queued AutoScheduleRun AND running/queued TaskPlans directly before cold crash
    const crashRunId = randomUUID();
    await persistence.workspace.autoScheduler.saveRunWithItems(
      {
        id: crashRunId,
        scheduleId: activeOnceId,
        scheduleName: 'Chaos Active Once Schedule',
        carrier: 'browser',
        phase: 'main',
        slotKey: 'manual-crash:main',
        triggerMode: 'manual',
        status: 'running',
        statusReason: '模拟崩溃前运行中',
        totalTargets: 2,
        completedCount: 0,
        softIssueCount: 0,
        hardBlockedCount: 0,
        watchdogTimeoutCount: 0,
        skippedCount: 0,
        scheduledFor: nowMs,
        startedAt: nowMs,
        finishedAt: null,
      },
      [
        {
          runId: crashRunId,
          targetId: browserIds[0],
          targetName: 'Browser-00',
          status: 'running',
          currentStep: '执行中',
          summary: '运行中',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          startedAt: nowMs,
          finishedAt: null,
          updatedAt: nowMs,
        },
        {
          runId: crashRunId,
          targetId: browserIds[1],
          targetName: 'Browser-01',
          status: 'queued',
          currentStep: '排队中',
          summary: '排队中',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: nowMs,
        },
      ],
    );

    const crashPlans = await persistence.workspace.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: emptyPostCombo.id,
        version: emptyPostCombo.version,
        expectedResourceRevision: emptyRev,
        profileIds: [browserIds[46], browserIds[47]],
      },
      [
        {
          id: browserIds[46],
          online: true,
          synced: true,
          unresolved: 0,
          account: { state: 'logged-in', id: '1000046', name: 'A46', avatar: null },
          dispatchAllowed: true,
        },
        {
          id: browserIds[47],
          online: true,
          synced: true,
          unresolved: 0,
          account: { state: 'logged-in', id: '1000047', name: 'A47', avatar: null },
          dispatchAllowed: true,
        },
      ],
    );
    await persistence.workspace.tasks.claimPlanForProfile(browserIds[46], '1000046');
    // Leave crashPlans[0] RUNNING/ACTIVE and crashPlans[1] QUEUED/PENDING, then simulate cold crash!
    assert.equal(crashPlans.length, 2);

    await autoScheduler.shutdown().catch(() => {});
    await groupBumper.shutdown().catch(() => {});
    await groupPoster.shutdown().catch(() => {});
    await googleSheets.shutdown().catch(() => {});
    await activeRuntime.close().catch(() => {});
    await core.shutdown();
    await persistence.close();

    // Restart recovery
    persistence = await PersistenceClient.open(dataDir);
    core = new Core(persistence.bridge);
    await persistence.workspace.tasks.recoverOnStartup(true);

    const recoveredProfileSource = new BridgeProfileSource(core, persistence.bridge);
    const recoveredWorkspace = new WorkspaceService(persistence.workspace, recoveredProfileSource);
    const recoveredScheduler = new AutoSchedulerService(persistence.workspace.autoScheduler, {
      workspace: recoveredWorkspace,
      workboard,
      featureExecution: new FeatureExecutionRegistry(),
      pollIntervalMs: 50,
    });
    await recoveredScheduler.start();
    await recoveredScheduler.tick();

    const recoveredState = await recoveredScheduler.state();
    const recoveredActiveOnce = recoveredState.schedules.find((s) => s.id === activeOnceId);
    const recoveredExpiredOnce = recoveredState.schedules.find((s) => s.id === expiredOnceId);
    assert.equal(
      recoveredActiveOnce?.enabled,
      true,
      'Active future once schedule must survive restart recovery',
    );
    assert.equal(recoveredExpiredOnce?.enabled, false, 'Expired once schedule must auto-disable');
    assert.ok(
      recoveredState.recentRuns.some(
        (r) => r.scheduleId === expiredOnceId && r.status === 'skipped_expired',
      ),
      'Expired once schedule must persist skipped_expired run',
    );

    await recoveredScheduler.shutdown();
    await core.shutdown().catch(() => {});
    await persistence.close();
    eventHub.close();

    // Verify zero zombie rows and zero foreign key errors directly on SQLite
    const rawDb = new DatabaseSync(path.join(dataDir, 'workspace.sqlite'), { readOnly: true });
    let zombiePlansOrSteps = 0;
    let foreignKeyErrors = 0;
    try {
      const zombiePlans = Number(
        rawDb
          .prepare("SELECT COUNT(*) AS c FROM task_plans WHERE state IN ('RUNNING', 'QUEUED')")
          .get()?.c ?? 0,
      );
      const zombieSteps = Number(
        rawDb
          .prepare("SELECT COUNT(*) AS c FROM task_steps WHERE status IN ('ACTIVE', 'PENDING')")
          .get()?.c ?? 0,
      );
      const zombieRuns = Number(
        rawDb
          .prepare("SELECT COUNT(*) AS c FROM auto_scheduler_runs WHERE status = 'running'")
          .get()?.c ?? 0,
      );
      const zombieRunItems = Number(
        rawDb
          .prepare(
            "SELECT COUNT(*) AS c FROM auto_scheduler_run_items WHERE status IN ('running', 'queued')",
          )
          .get()?.c ?? 0,
      );
      zombiePlansOrSteps = zombiePlans + zombieSteps + zombieRuns + zombieRunItems;
      const fkRows = rawDb.prepare('PRAGMA foreign_key_check').all();
      foreignKeyErrors = fkRows.length;
    } finally {
      rawDb.close();
    }

    const leakedPermits = workboard.browserPermits.used + workboard.bluestacksPermits.used;
    const eventLoopLagP99Ms = Number((loopDelay.percentile(99) / 1e6).toFixed(2));

    const slo = {
      ok: true,
      totalSimulatedAccounts: browserIds.length + bsIds.length,
      peakBrowserUsed,
      peakBluestacksUsed,
      peakActiveRunners,
      phasePeaks,
      cleanupTabsBlockedCount,
      cleanupTabsKilledActive,
      unconfirmedPreservedUnknown,
      falseVerifiedCount,
      closedOnFinishCount: closedOnFinishTargets.size,
      unclosedOnFinishCount,
      leakedPermits,
      zombiePlansOrSteps,
      eventLoopLagP99Ms,
      foreignKeyErrors,
    };

    assert.equal(slo.leakedPermits, 0, `leakedPermits=${slo.leakedPermits}`);
    assert.equal(slo.zombiePlansOrSteps, 0, `zombiePlansOrSteps=${slo.zombiePlansOrSteps}`);
    assert.equal(
      slo.cleanupTabsKilledActive,
      0,
      `cleanupTabsKilledActive=${slo.cleanupTabsKilledActive}`,
    );
    assert.equal(slo.falseVerifiedCount, 0, `falseVerifiedCount=${slo.falseVerifiedCount}`);
    assert.equal(
      slo.unclosedOnFinishCount,
      0,
      `unclosedOnFinishCount=${slo.unclosedOnFinishCount}`,
    );
    assert.ok(slo.eventLoopLagP99Ms < 80, `eventLoopLagP99Ms=${slo.eventLoopLagP99Ms} >= 80`);
    assert.equal(slo.foreignKeyErrors, 0, `foreignKeyErrors=${slo.foreignKeyErrors}`);

    console.log(JSON.stringify(slo, null, 2));
  } finally {
    loopDelay.disable();
    if (sampler) clearInterval(sampler);
    await stopStorm();
    await autoScheduler?.shutdown().catch(() => {});
    await groupBumper?.shutdown().catch(() => {});
    await groupPoster?.shutdown().catch(() => {});
    await googleSheets?.shutdown().catch(() => {});
    await activeRuntime?.close().catch(() => {});
    await core.shutdown().catch(() => {});
    await persistence.close().catch(() => {});
    eventHub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
