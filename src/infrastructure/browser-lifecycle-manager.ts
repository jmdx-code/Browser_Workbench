import { spawn } from 'node:child_process';
import type { Core, Peer } from '../bridge/core.js';
import type { BridgeStorePort } from './persistence-port.js';
import type { LocalBrowserLabels } from './local-browser-labels.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import {
  buildNormalBrowserLaunchArgs,
  type EnsureProfilesOnlineResult,
  type ProfileLaunchBinding,
  type ProfileLifecycleItemResult,
  type ProfileLifecyclePort,
} from '../shared/profile-lifecycle.js';

export interface BrowserLifecycleManagerOptions {
  core: Core;
  store: BridgeStorePort;
  browserLabels: LocalBrowserLabels;
  persistBindings?: (bindings: readonly ProfileLaunchBinding[]) => Promise<void> | void;
  stopActiveTasksForProfile?: (profileId: string) => Promise<void>;
  spawnProcess?: (executablePath: string, args: readonly string[]) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 35_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;
const RESTART_SETTLE_DELAY_MS = 800;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnDetached(executablePath: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function isPeerWindowOnline(peer: Peer | undefined): boolean {
  return Boolean(peer?.online && (peer.browserWindowCount ?? 1) > 0);
}

export class BrowserLifecycleManager implements ProfileLifecyclePort {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly launchingIds = new Set<string>();
  private readonly spawnFn: (executablePath: string, args: readonly string[]) => Promise<void>;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(private readonly opts: BrowserLifecycleManagerOptions) {
    this.spawnFn = opts.spawnProcess ?? defaultSpawnDetached;
    this.sleepFn = opts.sleep ?? defaultSleep;
  }

  isLaunching(profileId: string): boolean {
    return this.launchingIds.has(profileId);
  }

  private async withProfileLock<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.locks.set(profileId, chained);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(profileId) === chained) {
        this.locks.delete(profileId);
      }
    }
  }

  private buildCurrentStatus(
    profileId: string,
    action: ProfileLifecycleItemResult['action'],
    startedAt: number,
    extra: Partial<ProfileLifecycleItemResult> = {},
  ): ProfileLifecycleItemResult {
    const peer = this.opts.core.peers.get(profileId);
    const binding = this.opts.browserLabels.binding(profileId);
    const online = isPeerWindowOnline(peer);
    return {
      profileId,
      browserName: this.opts.browserLabels.name(profileId) ?? binding?.browserName ?? null,
      action,
      ok: true,
      online,
      phase: online ? (peer?.phase ?? 'OFFLINE') : 'OFFLINE',
      synced: online ? Boolean(peer?.synced) : false,
      launchable: Boolean(binding),
      browserKind: binding?.browserKind ?? null,
      profileDirectory: binding?.profileDirectory ?? null,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...extra,
    };
  }

  async getStatus(profileIds: readonly string[]): Promise<ProfileLifecycleItemResult[]> {
    const uniqueIds = [...new Set(profileIds)];
    const registeredSet = new Set<string>();
    let needsRefresh = false;
    for (const id of uniqueIds) {
      if (await this.opts.store.profileSummary(id)) {
        registeredSet.add(id);
        if (!this.opts.browserLabels.binding(id)) {
          needsRefresh = true;
        }
      }
    }
    if (needsRefresh) {
      const allRows = await this.opts.store.profileList();
      await this.opts.browserLabels.refreshNow(
        allRows.map((p) => String(p.profileId)),
        this.opts.persistBindings,
      );
    }
    const out: ProfileLifecycleItemResult[] = [];
    for (const profileId of uniqueIds) {
      const startedAt = Date.now();
      if (!registeredSet.has(profileId)) {
        out.push({
          profileId,
          browserName: null,
          action: 'status',
          ok: false,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: false,
          browserKind: null,
          profileDirectory: null,
          elapsedMs: 0,
          errorCode: 'PROFILE_NOT_REGISTERED',
          reason: '该浏览器未安装工作台插件或尚未在工作台配对注册',
        });
        continue;
      }
      out.push(this.buildCurrentStatus(profileId, 'status', startedAt));
    }
    return out;
  }

  async launchProfile(
    profileId: string,
    options?: { timeoutMs?: number | undefined },
  ): Promise<ProfileLifecycleItemResult> {
    return this.withProfileLock(profileId, () =>
      this.launchUnlocked(profileId, 'open', options?.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS),
    );
  }

  async closeProfile(
    profileId: string,
    options?: { timeoutMs?: number | undefined; stopTasksFirst?: boolean | undefined },
  ): Promise<ProfileLifecycleItemResult> {
    return this.withProfileLock(profileId, () =>
      this.closeUnlocked(profileId, 'close', {
        timeoutMs: options?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
        stopTasksFirst: options?.stopTasksFirst !== false,
      }),
    );
  }

  async restartProfile(
    profileId: string,
    options?: { closeTimeoutMs?: number | undefined; openTimeoutMs?: number | undefined },
  ): Promise<ProfileLifecycleItemResult> {
    return this.withProfileLock(profileId, async () => {
      const startedAt = Date.now();
      const closed = await this.closeUnlocked(profileId, 'restart', {
        timeoutMs: options?.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
        stopTasksFirst: true,
      });
      if (!closed.ok) {
        return {
          ...closed,
          action: 'restart',
          elapsedMs: Math.max(0, Date.now() - startedAt),
        };
      }
      if (!closed.alreadyInTargetState) {
        await this.sleepFn(RESTART_SETTLE_DELAY_MS);
      }
      const opened = await this.launchUnlocked(
        profileId,
        'restart',
        options?.openTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      );
      return {
        ...opened,
        action: 'restart',
        alreadyInTargetState: false,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
    });
  }

  private async waitForPeerReady(
    profileId: string,
    timeoutMs: number,
  ): Promise<{ ready: boolean; peer: Peer | undefined }> {
    const deadline = Date.now() + Math.max(2000, timeoutMs);
    while (Date.now() < deadline) {
      const peer = this.opts.core.peers.get(profileId);
      if (
        isPeerWindowOnline(peer) &&
        peer?.synced &&
        (peer.phase === 'PAUSED' || peer.phase === 'RUNNING' || peer.phase === 'RECOVERING')
      ) {
        return { ready: true, peer };
      }
      await this.sleepFn(200);
    }
    return { ready: false, peer: this.opts.core.peers.get(profileId) };
  }

  private async launchUnlocked(
    profileId: string,
    action: 'open' | 'restart',
    timeoutMs: number,
  ): Promise<ProfileLifecycleItemResult> {
    const startedAt = Date.now();
    if (!(await this.opts.store.profileSummary(profileId))) {
      return {
        profileId,
        browserName: null,
        action,
        ok: false,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        launchable: false,
        elapsedMs: 0,
        errorCode: 'PROFILE_NOT_REGISTERED',
        reason: '该浏览器未安装工作台插件或尚未配对注册，禁止启动',
      };
    }

    const existingPeer = this.opts.core.peers.get(profileId);
    if (isPeerWindowOnline(existingPeer)) {
      if (existingPeer?.synced) {
        return this.buildCurrentStatus(profileId, action, startedAt, {
          alreadyInTargetState: true,
        });
      }
      const syncedWait = await this.waitForPeerReady(profileId, Math.min(timeoutMs, 12_000));
      if (syncedWait.ready) {
        return this.buildCurrentStatus(profileId, action, startedAt, {
          alreadyInTargetState: true,
        });
      }
    }

    let binding = this.opts.browserLabels.binding(profileId);
    if (!binding) {
      const allRows = await this.opts.store.profileList();
      await this.opts.browserLabels.refreshNow(
        allRows.map((p) => String(p.profileId)),
        this.opts.persistBindings,
      );
      binding = this.opts.browserLabels.binding(profileId);
    }
    if (!binding) {
      return this.buildCurrentStatus(profileId, action, startedAt, {
        ok: false,
        launchable: false,
        errorCode: 'PROFILE_LAUNCH_BINDING_NOT_FOUND',
        reason:
          '尚未在本机唯一识别到该已装插件浏览器的本地资料目录（或存在多副本冲突），请先手动正常打开该浏览器一次完成关联',
      });
    }

    const verified = await this.opts.browserLabels.verifyBindingOnDisk(binding);
    if (!verified.ok) {
      return this.buildCurrentStatus(profileId, action, startedAt, {
        ok: false,
        launchable: false,
        errorCode: verified.errorCode,
        reason: verified.reason,
      });
    }

    const validBinding = verified.updatedBinding;
    if (this.opts.persistBindings) {
      await this.opts.persistBindings([validBinding]);
    }
    const args = buildNormalBrowserLaunchArgs(validBinding);

    this.launchingIds.add(profileId);
    try {
      devDiag.record({
        level: 'INFO',
        category: 'BRIDGE_WS',
        event: 'BROWSER_PROFILE_LAUNCHING',
        profileId,
        data: {
          browserKind: validBinding.browserKind,
          profileDirectory: validBinding.profileDirectory,
          browserName: validBinding.browserName,
        },
      });
      await this.spawnFn(validBinding.executablePath, args);
      const remainingMs = Math.max(3000, timeoutMs - (Date.now() - startedAt));
      const { ready, peer } = await this.waitForPeerReady(profileId, remainingMs);
      if (!ready) {
        return this.buildCurrentStatus(profileId, action, startedAt, {
          ok: false,
          errorCode: 'BROWSER_LAUNCH_SYNC_TIMEOUT',
          reason: isPeerWindowOnline(peer)
            ? `浏览器已打开但插件状态尚未完成同步（当前阶段：${peer?.phase ?? 'UNKNOWN'}）`
            : '已发出正常启动指令，但在超时时间内未收到该浏览器工作台插件的回连信号',
        });
      }
      devDiag.record({
        level: 'INFO',
        category: 'BRIDGE_WS',
        event: 'BROWSER_PROFILE_LAUNCHED',
        profileId,
        data: {
          phase: peer?.phase ?? 'PAUSED',
          elapsedMs: Date.now() - startedAt,
        },
      });
      return this.buildCurrentStatus(profileId, action, startedAt, {
        alreadyInTargetState: false,
        ...(peer?.phase === 'RECOVERING'
          ? { reason: '浏览器已启动连接，存在待核对记录需先确认' }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.buildCurrentStatus(profileId, action, startedAt, {
        ok: false,
        errorCode: 'BROWSER_SPAWN_FAILED',
        reason: `启动浏览器进程失败：${msg}`,
      });
    } finally {
      this.launchingIds.delete(profileId);
    }
  }

  private async closeUnlocked(
    profileId: string,
    action: 'close' | 'restart',
    options: { timeoutMs: number; stopTasksFirst: boolean },
  ): Promise<ProfileLifecycleItemResult> {
    const startedAt = Date.now();
    if (!(await this.opts.store.profileSummary(profileId))) {
      return {
        profileId,
        browserName: null,
        action,
        ok: false,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        launchable: false,
        elapsedMs: 0,
        errorCode: 'PROFILE_NOT_REGISTERED',
        reason: '该浏览器未安装工作台插件或尚未配对注册，禁止关闭操作',
      };
    }

    const initialPeer = this.opts.core.peers.get(profileId);
    if (!initialPeer?.online) {
      return this.buildCurrentStatus(profileId, action, startedAt, {
        alreadyInTargetState: true,
      });
    }

    if (options.stopTasksFirst && this.opts.stopActiveTasksForProfile) {
      const stopOutcome = await Promise.race([
        this.opts
          .stopActiveTasksForProfile(profileId)
          .then(() => 'STOPPED' as const)
          .catch((err: unknown) => ({
            kind: 'ERROR' as const,
            reason: err instanceof Error ? err.message : String(err),
          })),
        this.sleepFn(6_000).then(() => 'TIMEOUT' as const),
      ]);
      if (stopOutcome !== 'STOPPED') {
        devDiag.record({
          level: 'WARN',
          category: 'BRIDGE_WS',
          event: 'BROWSER_CLOSE_PRESTEP_STOP_INCOMPLETE',
          profileId,
          reason: stopOutcome === 'TIMEOUT' ? 'STOP_TASKS_TIMEOUT' : stopOutcome.reason,
        });
      }
    }

    let peer = this.opts.core.peers.get(profileId);
    if (!peer?.online) {
      return this.buildCurrentStatus(profileId, action, startedAt, {
        alreadyInTargetState: false,
      });
    }

    if (!peer.capabilities?.includes('browser-window-close-v1')) {
      try {
        this.opts.core.reloadExtension(profileId);
      } catch {
        // Ignore if socket closed concurrently
      }
      const reloadDeadline = Date.now() + 5000;
      while (Date.now() < reloadDeadline) {
        const current = this.opts.core.peers.get(profileId);
        if (current?.online && current.capabilities?.includes('browser-window-close-v1')) {
          peer = current;
          break;
        }
        await this.sleepFn(150);
      }
      peer = this.opts.core.peers.get(profileId);
      if (!peer?.online) {
        return this.buildCurrentStatus(profileId, action, startedAt, {
          alreadyInTargetState: false,
        });
      }
      if (!peer.capabilities?.includes('browser-window-close-v1')) {
        return this.buildCurrentStatus(profileId, action, startedAt, {
          ok: false,
          errorCode: 'BROWSER_CLOSE_CAPABILITY_MISSING',
          reason: '该浏览器内工作台插件尚未升级到支持安全单资料关窗的版本，请先重载插件',
        });
      }
    }

    try {
      await this.opts.core.closeBrowserWindows(profileId, Math.min(options.timeoutMs, 10_000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'BROWSER_CLOSE_BLOCKED') {
        // Win32 window teardown can take ~50-300ms after chrome.windows.remove resolves
        const teardownDeadline = Date.now() + 1200;
        while (Date.now() < teardownDeadline) {
          if (!isPeerWindowOnline(this.opts.core.peers.get(profileId))) break;
          await this.sleepFn(100);
        }
      }
      const afterErrPeer = this.opts.core.peers.get(profileId);
      if (isPeerWindowOnline(afterErrPeer)) {
        return this.buildCurrentStatus(profileId, action, startedAt, {
          ok: false,
          errorCode:
            msg === 'BROWSER_CLOSE_BLOCKED' ? 'BROWSER_CLOSE_BLOCKED' : 'BROWSER_CLOSE_FAILED',
          reason:
            msg === 'BROWSER_CLOSE_BLOCKED'
              ? '该浏览器窗口存在未确认离开提示或拦截弹窗，未能关闭全部窗口'
              : `安全关闭该浏览器窗口失败：${msg}`,
        });
      }
    }

    const waitDeadline = Date.now() + Math.max(1500, options.timeoutMs - (Date.now() - startedAt));
    while (Date.now() < waitDeadline) {
      const current = this.opts.core.peers.get(profileId);
      if (!isPeerWindowOnline(current)) {
        devDiag.record({
          level: 'INFO',
          category: 'BRIDGE_WS',
          event: 'BROWSER_PROFILE_CLOSED',
          profileId,
          data: { elapsedMs: Date.now() - startedAt },
        });
        return this.buildCurrentStatus(profileId, action, startedAt, {
          alreadyInTargetState: false,
          online: false,
          phase: 'OFFLINE',
          synced: false,
        });
      }
      await this.sleepFn(150);
    }

    return this.buildCurrentStatus(profileId, action, startedAt, {
      ok: false,
      errorCode: 'BROWSER_CLOSE_UNCONFIRMED',
      reason: '已发送关闭指令，但该浏览器窗口在超时时间内尚未完全退出连接',
    });
  }

  async ensureProfilesOnline(
    profileIds: readonly string[],
    options?: { timeoutMs?: number | undefined; maxParallelLaunches?: number | undefined },
  ): Promise<EnsureProfilesOnlineResult> {
    const requestedIds = [...new Set(profileIds)];
    const timeoutMs = options?.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const maxParallel = Math.max(1, Math.min(6, options?.maxParallelLaunches ?? 3));

    const readyIds: string[] = [];
    const launchedIds: string[] = [];
    const failed: EnsureProfilesOnlineResult['failed'] = [];
    const itemsByProfile = new Map<string, ProfileLifecycleItemResult>();
    const toLaunch: string[] = [];

    for (const id of requestedIds) {
      const peer = this.opts.core.peers.get(id);
      if (isPeerWindowOnline(peer) && peer?.synced && peer.phase === 'PAUSED') {
        readyIds.push(id);
        itemsByProfile.set(
          id,
          this.buildCurrentStatus(id, 'open', Date.now(), { alreadyInTargetState: true }),
        );
      } else {
        toLaunch.push(id);
      }
    }

    if (toLaunch.length > 0) {
      let cursor = 0;
      const workerCount = Math.min(maxParallel, toLaunch.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (cursor < toLaunch.length) {
            const idx = cursor++;
            const id = toLaunch[idx];
            if (!id) continue;
            const res = await this.launchProfile(id, { timeoutMs });
            itemsByProfile.set(id, res);
            if (res.ok && res.online && res.synced) {
              readyIds.push(id);
              if (!res.alreadyInTargetState) launchedIds.push(id);
            } else {
              failed.push({
                profileId: id,
                errorCode: res.errorCode ?? 'BROWSER_LAUNCH_FAILED',
                reason: res.reason ?? '启动未就绪',
              });
            }
          }
        }),
      );
    }

    return {
      requestedIds,
      readyIds,
      launchedIds,
      failed,
      items: requestedIds
        .map((id) => itemsByProfile.get(id))
        .filter((item): item is ProfileLifecycleItemResult => Boolean(item)),
    };
  }
}
