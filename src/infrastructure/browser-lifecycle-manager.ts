import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { BridgeStorePort } from './persistence-port.js';
import { inferBrowserBrandFromRoot, type LocalBrowserLabels } from './local-browser-labels.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import {
  cleanupProfileSavedTabGroups,
  defaultLocalBrowserUserDataRoots,
} from './saved-tab-groups-hygiene.js';
import {
  buildNormalBrowserLaunchArgs,
  type BrowserBrand,
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
  releaseIdleKernelSession?: (profileId: string) => Promise<void>;
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
const isPeerWindowOnline = (peer: Peer | undefined) =>
  Boolean(peer?.online && (peer.browserWindowCount ?? 1) > 0);
const isPeerIdleReady = (peer: Peer | undefined) =>
  Boolean(isPeerWindowOnline(peer) && peer?.synced && peer.phase === 'PAUSED');
const diagBridge = (
  event: string,
  profileId: string,
  data?: Record<string, unknown>,
  level: 'INFO' | 'WARN' = 'INFO',
  reason?: string,
) =>
  devDiag.record({
    level,
    category: 'BRIDGE_WS',
    event,
    profileId,
    ...(reason ? { reason } : {}),
    ...(data ? { data } : {}),
  });
export class BrowserLifecycleManager implements ProfileLifecyclePort {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly launchingIds = new Set<string>();
  private readonly disconnectCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly spawnFn: (executablePath: string, args: readonly string[]) => Promise<void>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  constructor(private readonly opts: BrowserLifecycleManagerOptions) {
    this.spawnFn = opts.spawnProcess ?? defaultSpawnDetached;
    this.sleepFn = opts.sleep ?? defaultSleep;
  }
  private runOfflineTabGroupCleanup(
    profileId: string,
    binding: { userDataDir: string; profileDirectory: string },
    mode: 'keep-one' | 'prepare-launch',
    diagMode: string,
    includePreserved: boolean,
  ): void {
    try {
      const res = cleanupProfileSavedTabGroups(
        path.join(binding.userDataDir, binding.profileDirectory),
        mode,
      );
      if (res.ok && (res.deletedGroups > 0 || res.deletedTabs > 0)) {
        diagBridge('SAVED_TAB_GROUPS_CLEANED', profileId, {
          mode: diagMode,
          profileDirectory: binding.profileDirectory,
          deletedGroups: res.deletedGroups,
          deletedTabs: res.deletedTabs,
          remainingWorkbenchGroups: res.remainingWorkbenchGroups,
          ...(includePreserved ? { preservedUserGroups: res.preservedUserGroups } : {}),
        });
      }
    } catch {}
  }
  private notRegisteredResult(
    profileId: string,
    action: ProfileLifecycleItemResult['action'],
    reason: string,
    includeDir = false,
  ): ProfileLifecycleItemResult {
    return {
      profileId,
      browserName: null,
      action,
      ok: false,
      online: false,
      phase: 'OFFLINE',
      synced: false,
      launchable: false,
      ...(includeDir ? { browserKind: null, profileDirectory: null } : {}),
      elapsedMs: 0,
      errorCode: 'PROFILE_NOT_REGISTERED',
      reason,
    };
  }
  scheduleOfflineTabGroupHygiene(profileId: string, delayMs = 4000): void {
    const existing = this.disconnectCleanupTimers.get(profileId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.disconnectCleanupTimers.delete(profileId);
      if (this.launchingIds.has(profileId)) return;
      if (isPeerWindowOnline(this.opts.core.peers.get(profileId))) return;
      const binding = this.opts.browserLabels.binding(profileId);
      if (binding)
        this.runOfflineTabGroupCleanup(
          profileId,
          binding,
          'keep-one',
          'keep-one-disconnect',
          false,
        );
    }, delayMs);
    timer.unref();
    this.disconnectCleanupTimers.set(profileId, timer);
  }
  isLaunching(profileId: string): boolean {
    return this.launchingIds.has(profileId);
  }
  private async withProfileLock<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(profileId) ?? Promise.resolve();
    let release = () => {};
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
      if (this.locks.get(profileId) === chained) this.locks.delete(profileId);
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
  private async refreshBindings(): Promise<void> {
    const allRows = await this.opts.store.profileList();
    await this.opts.browserLabels.refreshNow(
      allRows.map((p) => String(p.profileId)),
      this.opts.persistBindings,
    );
  }
  private async pollUntil(
    timeoutMs: number,
    intervalMs: number,
    pred: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await this.sleepFn(intervalMs);
    }
    return pred();
  }
  async getStatus(profileIds: readonly string[]): Promise<ProfileLifecycleItemResult[]> {
    const uniqueIds = [...new Set(profileIds)],
      registeredSet = new Set<string>();
    let needsRefresh = false;
    for (const id of uniqueIds) {
      if (await this.opts.store.profileSummary(id)) {
        registeredSet.add(id);
        if (!this.opts.browserLabels.binding(id)) needsRefresh = true;
      }
    }
    if (needsRefresh) await this.refreshBindings();
    const out: ProfileLifecycleItemResult[] = [];
    for (const profileId of uniqueIds) {
      const startedAt = Date.now();
      if (!registeredSet.has(profileId)) {
        out.push(
          this.notRegisteredResult(
            profileId,
            'status',
            '该浏览器未安装工作台插件或尚未在工作台配对注册',
            true,
          ),
        );
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
        return { ...closed, action: 'restart', elapsedMs: Math.max(0, Date.now() - startedAt) };
      }
      if (!closed.alreadyInTargetState) await this.sleepFn(RESTART_SETTLE_DELAY_MS);
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
    const ready = await this.pollUntil(Math.max(2000, timeoutMs), 200, () => {
      const p = this.opts.core.peers.get(profileId);
      return Boolean(
        isPeerWindowOnline(p) && p?.synced && (p.phase === 'PAUSED' || p.phase === 'RUNNING'),
      );
    });
    return { ready, peer: this.opts.core.peers.get(profileId) };
  }
  private async launchUnlocked(
    profileId: string,
    action: 'open' | 'restart',
    timeoutMs: number,
  ): Promise<ProfileLifecycleItemResult> {
    const startedAt = Date.now(),
      done = (alreadyInTargetState: boolean, extra?: Partial<ProfileLifecycleItemResult>) =>
        this.buildCurrentStatus(profileId, action, startedAt, { alreadyInTargetState, ...extra }),
      fail = (errorCode: string, reason: string, extra?: Partial<ProfileLifecycleItemResult>) =>
        this.buildCurrentStatus(profileId, action, startedAt, {
          ok: false,
          errorCode,
          reason,
          ...extra,
        });
    if (!(await this.opts.store.profileSummary(profileId)))
      return this.notRegisteredResult(
        profileId,
        action,
        '该浏览器未安装工作台插件或尚未配对注册，禁止启动',
      );
    const existingPeer = this.opts.core.peers.get(profileId);
    if (isPeerWindowOnline(existingPeer)) {
      if (existingPeer?.synced && existingPeer.phase === 'PAUSED') return done(true);
      if ((await this.waitForPeerReady(profileId, Math.min(timeoutMs, 12_000))).ready)
        return done(true);
      const afterWaitPeer = this.opts.core.peers.get(profileId);
      if (isPeerWindowOnline(afterWaitPeer))
        return fail(
          'BROWSER_LAUNCH_SYNC_TIMEOUT',
          `浏览器窗口已在线但插件状态尚未就绪（当前阶段：${afterWaitPeer?.phase ?? 'UNKNOWN'}）`,
        );
    }
    let binding = this.opts.browserLabels.binding(profileId);
    if (!binding) {
      await this.refreshBindings();
      binding = this.opts.browserLabels.binding(profileId);
    }
    if (!binding) {
      const conflict = await this.detectDuplicateBindingConflict(profileId);
      if (conflict) {
        return fail('PROFILE_LAUNCH_BINDING_CONFLICT', conflict.reason, {
          launchable: false,
          browserKind: conflict.browserKind,
          profileDirectory: conflict.profileDirectory,
        });
      }
      return fail(
        'PROFILE_LAUNCH_BINDING_NOT_FOUND',
        '尚未在本机唯一识别到该已装插件浏览器的本地资料目录（或存在多副本冲突），请先手动正常打开该浏览器一次完成关联',
        { launchable: false },
      );
    }
    const verified = await this.opts.browserLabels.verifyBindingOnDisk(binding);
    if (!verified.ok) return fail(verified.errorCode, verified.reason, { launchable: false });
    const validBinding = verified.updatedBinding;
    if (this.opts.persistBindings) await this.opts.persistBindings([validBinding]);
    this.runOfflineTabGroupCleanup(
      profileId,
      validBinding,
      'prepare-launch',
      'prepare-launch',
      true,
    );
    const args = buildNormalBrowserLaunchArgs(validBinding);
    this.launchingIds.add(profileId);
    try {
      diagBridge('BROWSER_PROFILE_LAUNCHING', profileId, {
        browserKind: validBinding.browserKind,
        profileDirectory: validBinding.profileDirectory,
        browserName: validBinding.browserName,
      });
      await this.spawnFn(validBinding.executablePath, args);
      const { ready, peer } = await this.waitForPeerReady(
        profileId,
        Math.max(3000, timeoutMs - (Date.now() - startedAt)),
      );
      if (!ready)
        return fail(
          'BROWSER_LAUNCH_SYNC_TIMEOUT',
          isPeerWindowOnline(peer)
            ? `浏览器已打开但插件状态尚未完成同步（当前阶段：${peer?.phase ?? 'UNKNOWN'}）`
            : '已发出正常启动指令，但在超时时间内未收到该浏览器工作台插件的回连信号',
        );
      diagBridge('BROWSER_PROFILE_LAUNCHED', profileId, {
        phase: peer?.phase ?? 'PAUSED',
        elapsedMs: Date.now() - startedAt,
      });
      return done(false);
    } catch (err) {
      return fail(
        'BROWSER_SPAWN_FAILED',
        `启动浏览器进程失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.launchingIds.delete(profileId);
    }
  }
  private async closeUnlocked(
    profileId: string,
    action: 'close' | 'restart',
    options: { timeoutMs: number; stopTasksFirst: boolean },
  ): Promise<ProfileLifecycleItemResult> {
    const startedAt = Date.now(),
      done = (alreadyInTargetState: boolean, extra?: Partial<ProfileLifecycleItemResult>) =>
        this.buildCurrentStatus(profileId, action, startedAt, { alreadyInTargetState, ...extra }),
      fail = (errorCode: string, reason: string) =>
        this.buildCurrentStatus(profileId, action, startedAt, { ok: false, errorCode, reason });
    if (!(await this.opts.store.profileSummary(profileId)))
      return this.notRegisteredResult(
        profileId,
        action,
        '该浏览器未安装工作台插件或尚未配对注册，禁止关闭操作',
      );
    const initialPeer = this.opts.core.peers.get(profileId);
    if (!initialPeer?.online) return done(true);
    if (options.stopTasksFirst && this.opts.stopActiveTasksForProfile) {
      const stopOutcome = await Promise.race([
        this.opts
          .stopActiveTasksForProfile(profileId)
          .then(() => 'STOPPED' as const)
          .catch((err: unknown) => ({
            kind: 'ERROR' as const,
            reason: err instanceof Error ? err.message : String(err),
          })),
        this.sleepFn(3_500).then(() => 'TIMEOUT' as const),
      ]);
      if (stopOutcome !== 'STOPPED') {
        diagBridge(
          'BROWSER_CLOSE_PRESTEP_STOP_INCOMPLETE',
          profileId,
          undefined,
          'WARN',
          stopOutcome === 'TIMEOUT' ? 'STOP_TASKS_TIMEOUT' : stopOutcome.reason,
        );
      }
    }
    let peer = this.opts.core.peers.get(profileId);
    if (!peer?.online) return done(false);
    const missingCap = () =>
      fail(
        'BROWSER_CLOSE_CAPABILITY_MISSING',
        '该浏览器内工作台插件尚未升级到支持安全单资料关窗的版本，请先重载插件',
      );
    if (!peer.capabilities?.includes('browser-window-close-v1')) {
      const reloadResult = await Promise.resolve(this.opts.core.reloadExtension(profileId)).catch(
        () => ({ requested: false, reason: 'RELOAD_FAILED' }),
      );
      if (!reloadResult.requested) return missingCap();
      await this.pollUntil(5000, 150, () => {
        const c = this.opts.core.peers.get(profileId);
        return Boolean(c?.online && c.capabilities?.includes('browser-window-close-v1'));
      });
      peer = this.opts.core.peers.get(profileId);
      if (!peer?.online) return done(false);
      if (!peer.capabilities?.includes('browser-window-close-v1')) return missingCap();
    }
    if (this.opts.releaseIdleKernelSession) {
      await Promise.race([
        this.opts.releaseIdleKernelSession(profileId).catch(() => {}),
        this.sleepFn(3_000),
      ]);
    }
    try {
      await this.opts.core.closeBrowserWindows(profileId, Math.min(options.timeoutMs, 10_000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Win32 window teardown can take ~50-300ms after chrome.windows.remove resolves
      if (msg === 'BROWSER_CLOSE_BLOCKED')
        await this.pollUntil(
          1200,
          100,
          () => !isPeerWindowOnline(this.opts.core.peers.get(profileId)),
        );
      if (isPeerWindowOnline(this.opts.core.peers.get(profileId)))
        return fail(
          msg === 'BROWSER_CLOSE_BLOCKED' ? 'BROWSER_CLOSE_BLOCKED' : 'BROWSER_CLOSE_FAILED',
          msg === 'BROWSER_CLOSE_BLOCKED'
            ? '该浏览器窗口存在未确认离开提示或拦截弹窗，未能关闭全部窗口'
            : `安全关闭该浏览器窗口失败：${msg}`,
        );
    }
    if (
      await this.pollUntil(
        Math.max(1500, options.timeoutMs - (Date.now() - startedAt)),
        150,
        () => !isPeerWindowOnline(this.opts.core.peers.get(profileId)),
      )
    ) {
      const closedBinding = this.opts.browserLabels.binding(profileId);
      if (closedBinding)
        this.runOfflineTabGroupCleanup(profileId, closedBinding, 'keep-one', 'keep-one', false);
      diagBridge('BROWSER_PROFILE_CLOSED', profileId, { elapsedMs: Date.now() - startedAt });
      return done(false, { online: false, phase: 'OFFLINE', synced: false });
    }
    return fail(
      'BROWSER_CLOSE_UNCONFIRMED',
      '已发送关闭指令，但该浏览器窗口在超时时间内尚未完全退出连接',
    );
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
      if (isPeerIdleReady(peer)) {
        readyIds.push(id);
        itemsByProfile.set(
          id,
          this.buildCurrentStatus(id, 'open', Date.now(), { alreadyInTargetState: true }),
        );
      } else toLaunch.push(id);
    }
    if (toLaunch.length > 0) {
      let cursor = 0;
      const workerCount = Math.min(maxParallel, toLaunch.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (cursor < toLaunch.length) {
            const id = toLaunch[cursor++];
            if (!id) continue;
            const res = await this.launchProfile(id, { timeoutMs });
            itemsByProfile.set(id, res);
            if (res.ok && res.online && res.synced && res.phase === 'PAUSED') {
              readyIds.push(id);
              if (!res.alreadyInTargetState) launchedIds.push(id);
            } else {
              failed.push({
                profileId: id,
                errorCode:
                  res.errorCode ??
                  (res.phase !== 'PAUSED' ? 'BROWSER_NOT_IDLE' : 'BROWSER_LAUNCH_FAILED'),
                reason:
                  res.reason ??
                  (res.phase !== 'PAUSED'
                    ? `浏览器当前阶段为 ${res.phase}，尚未进入空闲就绪态`
                    : '启动未就绪'),
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
  private async detectDuplicateBindingConflict(profileId: string): Promise<{
    reason: string;
    browserKind: BrowserBrand | null;
    profileDirectory: string | null;
  } | null> {
    try {
      const rows = await this.opts.store.profileList();
      const rowById = new Map(rows.map((r) => [String(r.profileId), r]));
      const labelOf = (id: string) => {
        const row = rowById.get(id);
        const alias = typeof row?.alias === 'string' ? row.alias.trim() : '';
        const bName = this.opts.browserLabels.name(id)?.trim() ?? '';
        if (alias && bName && alias !== bName) return `${alias}（${bName}）`;
        return alias || bName || id.slice(0, 8);
      };
      const allIds = rows.map((r) => String(r.profileId));
      const selfNeedle = Buffer.from(profileId);
      for (const root of defaultLocalBrowserUserDataRoots()) {
        let infoCache: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8')) as {
            profile?: { info_cache?: Record<string, unknown> };
          };
          infoCache = parsed.profile?.info_cache ?? {};
        } catch {
          continue;
        }
        const browserKind = inferBrowserBrandFromRoot(root);
        for (const [folder, meta] of Object.entries(infoCache)) {
          if (!/^(Default|Profile \d+)$/.test(folder)) continue;
          const folderLabel =
            typeof (meta as { name?: unknown } | null)?.name === 'string'
              ? String((meta as { name: string }).name).trim()
              : '';
          const selfName = this.opts.browserLabels.name(profileId)?.trim();
          if (selfName && folderLabel && selfName !== folderLabel) continue;
          const extDirs = await readdir(path.join(root, folder, 'Local Extension Settings')).catch(
            () => [] as string[],
          );
          if (!extDirs.length) continue;
          const matchedIds = new Set<string>();
          for (const extDir of extDirs) {
            if (!/^[a-p]{32}$/.test(extDir)) continue;
            const fullExt = path.join(root, folder, 'Local Extension Settings', extDir);
            const files = (await readdir(fullExt).catch(() => [] as string[])).filter((f) =>
              /\.(log|ldb)$/.test(f),
            );
            for (const file of files) {
              const filePath = path.join(fullExt, file);
              try {
                if ((await stat(filePath)).size > 4 * 1024 * 1024) continue;
                const buf = await readFile(filePath);
                if (!buf.includes(selfNeedle)) continue;
                matchedIds.add(profileId);
                for (const otherId of allIds) {
                  if (otherId !== profileId && buf.includes(Buffer.from(otherId))) {
                    matchedIds.add(otherId);
                  }
                }
              } catch {}
            }
          }
          if (matchedIds.has(profileId) && matchedIds.size > 1) {
            const others = [...matchedIds].filter((id) => id !== profileId).map(labelOf);
            const fullDir = path.join(root, folder);
            return {
              browserKind,
              profileDirectory: folder,
              reason: `本地资料目录冲突（${fullDir}）：「${labelOf(profileId)}」与「${others.join('、')}」共用同一浏览器资料目录，已禁止启动；请移除重复资料或为其中之一使用独立资料目录`,
            };
          }
        }
      }
      const selfName = this.opts.browserLabels.name(profileId)?.trim();
      if (selfName) {
        const sameNameOthers = allIds.filter(
          (id) =>
            id !== profileId &&
            !this.opts.browserLabels.binding(id) &&
            this.opts.browserLabels.name(id)?.trim() === selfName,
        );
        if (sameNameOthers.length > 0) {
          return {
            browserKind: null,
            profileDirectory: null,
            reason: `本地资料目录存在多副本冲突：「${labelOf(profileId)}」与「${sameNameOthers.map(labelOf).join('、')}」疑似共用同一浏览器资料目录（${selfName}），已禁止启动`,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
