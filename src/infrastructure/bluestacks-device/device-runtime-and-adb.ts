import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { CompatibleRepository } from '../../domain/persistence.js';
import { failError } from '../../domain/workspace.js';
import type {
  BluestacksAccountState,
  BluestacksIdentityType,
  BluestacksInstance,
  BluestacksManagedIdentity,
  BluestacksRuntimeConfig,
} from '../../shared/bluestacks.js';
import type { BluestacksSavedSettings, DiscoveredInstanceRecord } from '../bluestacks-store.js';
import type { OcrRecognizer } from '../bluestacks-vision.js';
import { queryHdPlayerProcessesViaWin32Helper, type RunProcessFn } from '../bluestacks-win32.js';
import {
  COMMON_CONF_PATHS,
  COMMON_INSTALL_DIRS,
  abortableWait,
  runProcess,
} from './runner-helpers.js';
export interface BluestacksDeviceRepo {
  savedSettings(): BluestacksSavedSettings;
  listInstances(onlineKeys?: ReadonlyArray<string>): BluestacksInstance[];
  getInstance(id: string): BluestacksInstance | null;
  upsertDiscoveredInstances(items: ReadonlyArray<DiscoveredInstanceRecord>): BluestacksInstance[];
  saveInspectionResult(input: {
    id: string;
    fbLiteInstalled: boolean;
    accountState: BluestacksAccountState;
    accountId?: string;
    accountName?: string;
    avatarUrl?: string | null;
    fbWidth?: number;
    fbHeight?: number;
    identityType?: BluestacksIdentityType;
    numericAccountId?: string;
    managedIdentities?: ReadonlyArray<BluestacksManagedIdentity>;
    androidSdk?: number | null;
    fbLiteVersion?: string | null;
  }): BluestacksInstance;
  saveLastStatus(id: string, status: string | null): void;
}
export interface DeviceRuntimeContext {
  readonly repo: CompatibleRepository<BluestacksDeviceRepo>;
  readonly ocr: OcrRecognizer;
  registryDetectPromise: Promise<{ installDir: string | null; confPath: string | null }> | null;
  readonly litePackageCache: Map<string, { installed: boolean; checkedAt: number }>;
  readonly wmSizeCache: Map<string, { width: number; height: number; checkedAt: number }>;
  onlineInstanceKeys: Set<string>;
  launchSpawnTail: Promise<void>;
  lastPlayerSpawnAt: number;
  adbStartServerPromise: Promise<void> | null;
  lastAdbStartServerAt: number;
  readonly serialRecoveryPromises: Map<string, Promise<void>>;
  readonly consecutiveAdbTimeoutsBySerial: Map<string, number>;
  readonly runProcOverride?: RunProcessFn;
  readonly adbPathOverride?: string;
}
export function createDeviceRuntimeContext(
  repo: CompatibleRepository<BluestacksDeviceRepo>,
  ocr: OcrRecognizer,
  overrides: { runProc?: RunProcessFn; adbPath?: string } = {},
): DeviceRuntimeContext {
  return {
    repo,
    ocr,
    registryDetectPromise: null,
    litePackageCache: new Map(),
    wmSizeCache: new Map(),
    onlineInstanceKeys: new Set(),
    launchSpawnTail: Promise.resolve(),
    lastPlayerSpawnAt: 0,
    adbStartServerPromise: null,
    lastAdbStartServerAt: 0,
    serialRecoveryPromises: new Map(),
    consecutiveAdbTimeoutsBySerial: new Map(),
    ...(overrides.runProc ? { runProcOverride: overrides.runProc } : {}),
    ...(overrides.adbPath ? { adbPathOverride: overrides.adbPath } : {}),
  };
}
export async function runSerializedPlayerSpawn(
  ctx: DeviceRuntimeContext,
  playerPath: string,
  safeKey: string,
  signal?: AbortSignal,
): Promise<{ exitedEarly: () => number | null }> {
  const prev = ctx.launchSpawnTail;
  let release: () => void = () => {};
  ctx.launchSpawnTail = new Promise<void>((r) => {
    release = r;
  });
  let earlyExitCode: number | null = null;
  try {
    await prev.catch(() => {});
    const minGapMs = 3200;
    const waitMs = Math.max(0, ctx.lastPlayerSpawnAt + minGapMs - Date.now());
    if (waitMs > 0) await abortableWait(waitMs, signal);
    if (signal?.aborted) throw new Error('TASK_STOPPED');
    ctx.lastPlayerSpawnAt = Date.now();
    await new Promise<void>((resolveSpawn) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolveSpawn();
        }
      };
      const launchViaShellExecute = () => {
        const escapedExe = playerPath.replace(/'/g, "''");
        void runProcess(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-Command',
            `Start-Process -FilePath '${escapedExe}' -ArgumentList '--instance','${safeKey}'`,
          ],
          { timeoutMs: 8000 },
        )
          .catch(() => null)
          .finally(finish);
      };
      try {
        const child = spawn(playerPath, ['--instance', safeKey], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.once('exit', (code) => {
          if (typeof code === 'number' && code !== 0) earlyExitCode = code;
        });
        child.once('error', launchViaShellExecute);
        child.once('spawn', () => {
          child.unref();
          finish();
        });
      } catch {
        launchViaShellExecute();
      }
    });
    return { exitedEarly: () => earlyExitCode };
  } finally {
    release();
  }
}
function detectRegistryPaths(
  ctx: DeviceRuntimeContext,
): Promise<{ installDir: string | null; confPath: string | null }> {
  if (ctx.registryDetectPromise) return ctx.registryDetectPromise;
  ctx.registryDetectPromise = (async () => {
    if (process.platform !== 'win32') return { installDir: null, confPath: null };
    try {
      const out = await runProcess('reg.exe', ['query', 'HKLM\\SOFTWARE\\BlueStacks_nxt'], {
        timeoutMs: 3000,
      });
      const text = out.toString('utf8');
      const installMatch = /InstallDir\s+REG_SZ\s+(.+)/i.exec(text);
      const userDirMatch = /UserDefinedDir\s+REG_SZ\s+(.+)/i.exec(text);
      const rawInstall = installMatch?.[1]?.trim().replace(/[\\/]+$/, '') ?? null;
      const rawUserDir = userDirMatch?.[1]?.trim().replace(/[\\/]+$/, '') ?? null;
      const confCandidate = rawUserDir ? path.join(rawUserDir, 'bluestacks.conf') : null;
      return {
        installDir: rawInstall && existsSync(rawInstall) ? rawInstall : null,
        confPath: confCandidate && existsSync(confCandidate) ? confCandidate : null,
      };
    } catch {
      return { installDir: null, confPath: null };
    }
  })();
  return ctx.registryDetectPromise;
}
function detectLocalFbLiteApk(): string | null {
  const searchDirs = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.join(process.cwd(), 'apk'),
    path.join(process.cwd(), 'assets'),
  ];
  for (const dir of searchDirs) {
    try {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir)
        .filter((name) => /facebook\.lite.*\.apk$/i.test(name))
        .sort()
        .reverse();
      if (files[0]) {
        const full = path.join(dir, files[0]);
        if (existsSync(full)) return full;
      }
    } catch {
      /* ignore unreadable dir */
    }
  }
  return null;
}
export async function resolveRuntimeConfig(ctx: DeviceRuntimeContext): Promise<{
  config: BluestacksRuntimeConfig;
  adbPath: string | null;
  playerPath: string | null;
  effectiveConfPath: string | null;
  effectiveApkPath: string | null;
}> {
  const saved = await ctx.repo.savedSettings();
  const reg = await detectRegistryPaths(ctx);
  const detectedInstallDir =
    reg.installDir ??
    COMMON_INSTALL_DIRS.find((dir) => existsSync(path.join(dir, 'HD-Adb.exe'))) ??
    null;
  const detectedConfPath =
    reg.confPath ?? COMMON_CONF_PATHS.find((file) => existsSync(file)) ?? null;
  const detectedApkPath = detectLocalFbLiteApk();
  const effectiveInstall = saved.installDir || detectedInstallDir;
  const effectiveConf = saved.confPath || detectedConfPath;
  const effectiveApk =
    saved.apkPath && existsSync(saved.apkPath)
      ? saved.apkPath
      : detectedApkPath && existsSync(detectedApkPath)
        ? detectedApkPath
        : null;
  const adbCandidate = effectiveInstall ? path.join(effectiveInstall, 'HD-Adb.exe') : null;
  const playerCandidate = effectiveInstall ? path.join(effectiveInstall, 'HD-Player.exe') : null;
  const adbReady = Boolean(adbCandidate && existsSync(adbCandidate));
  const playerReady = Boolean(playerCandidate && existsSync(playerCandidate));
  return {
    config: {
      installDir: saved.installDir,
      confPath: saved.confPath,
      detectedInstallDir,
      detectedConfPath,
      adbReady,
      playerReady,
      apkPath: saved.apkPath ?? null,
      detectedApkPath,
    },
    adbPath: adbReady ? adbCandidate : null,
    playerPath: playerReady ? playerCandidate : null,
    effectiveConfPath: effectiveConf && existsSync(effectiveConf) ? effectiveConf : null,
    effectiveApkPath: effectiveApk,
  };
}
async function requireAdbPath(ctx: DeviceRuntimeContext): Promise<string> {
  if (ctx.adbPathOverride) return ctx.adbPathOverride;
  const { adbPath } = await resolveRuntimeConfig(ctx);
  if (!adbPath) {
    failError(
      'BLUESTACKS_ADB_NOT_FOUND',
      '未找到蓝蝶 HD-Adb.exe，请在左侧点击设置按钮指定 BlueStacks 安装目录',
      400,
    );
  }
  return adbPath;
}
async function awaitWithAbortSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await promise;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('TASK_STOPPED'));
      return;
    }
    const onAbort = () => reject(new Error('TASK_STOPPED'));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
async function ensureAdbServerStarted(
  ctx: DeviceRuntimeContext,
  adbExe: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('TASK_STOPPED');
  let starter = ctx.adbStartServerPromise;
  if (!starter) {
    if (Date.now() - ctx.lastAdbStartServerAt < 10_000) return;
    ctx.lastAdbStartServerAt = Date.now();
    const execProc = ctx.runProcOverride ?? runProcess;
    starter = (async () => {
      await execProc(adbExe, ['start-server'], { timeoutMs: 10_000 }).catch(() => null);
    })().finally(() => {
      if (ctx.adbStartServerPromise === starter) ctx.adbStartServerPromise = null;
    });
    ctx.adbStartServerPromise = starter;
  }
  await awaitWithAbortSignal(starter, signal);
}
export async function recoverAdbSerial(
  ctx: DeviceRuntimeContext,
  adbExe: string,
  serial: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('TASK_STOPPED');
  let recovery = ctx.serialRecoveryPromises.get(serial);
  if (!recovery) {
    const execProc = ctx.runProcOverride ?? runProcess;
    recovery = (async () => {
      await execProc(adbExe, ['disconnect', serial], { timeoutMs: 4000 }).catch(() => null);
      await abortableWait(200).catch(() => null);
      await execProc(adbExe, ['connect', serial], { timeoutMs: 6000 }).catch(() => null);
      for (const delayMs of [250, 500, 1000]) {
        const stateOut = await execProc(adbExe, ['-s', serial, 'get-state'], { timeoutMs: 2500 })
          .then((b) => b.toString('utf8').trim())
          .catch(() => '');
        if (stateOut === 'device') return;
        await abortableWait(delayMs).catch(() => null);
        await execProc(adbExe, ['connect', serial], { timeoutMs: 5000 }).catch(() => null);
      }
      await execProc(adbExe, ['-s', serial, 'get-state'], { timeoutMs: 2500 }).catch(() => null);
    })().finally(() => {
      if (ctx.serialRecoveryPromises.get(serial) === recovery) {
        ctx.serialRecoveryPromises.delete(serial);
      }
    });
    ctx.serialRecoveryPromises.set(serial, recovery);
  }
  await awaitWithAbortSignal(recovery, signal);
}
export async function adb(
  ctx: DeviceRuntimeContext,
  serial: string,
  args: string[],
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<Buffer> {
  const adbExe = await requireAdbPath(ctx);
  const execProc = ctx.runProcOverride ?? runProcess;
  try {
    const out = await execProc(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
    ctx.consecutiveAdbTimeoutsBySerial.delete(serial);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'TASK_STOPPED' || signal?.aborted) throw new Error('TASK_STOPPED');
    const isDaemonError =
      /daemon not running|cannot connect to daemon|protocol fault|adb server|failed to start daemon|could not read ok from adb/i.test(
        msg,
      );
    const isTimeout = msg === 'TIMEOUT';
    if (isTimeout) {
      ctx.consecutiveAdbTimeoutsBySerial.set(
        serial,
        (ctx.consecutiveAdbTimeoutsBySerial.get(serial) ?? 0) + 1,
      );
    }
    if (isDaemonError) {
      ctx.consecutiveAdbTimeoutsBySerial.delete(serial);
      await ensureAdbServerStarted(ctx, adbExe, signal);
      await recoverAdbSerial(ctx, adbExe, serial, signal);
      return await execProc(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
    }
    if (isTimeout || /not found|offline|closed/i.test(msg)) {
      ctx.consecutiveAdbTimeoutsBySerial.delete(serial);
      await recoverAdbSerial(ctx, adbExe, serial, signal);
      return await execProc(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
    }
    throw err;
  }
}
export async function readRunningHdPlayerInstances(): Promise<{
  queried: boolean;
  keys: Set<string>;
  pidByKey: Map<string, number[]>;
  bareMasterRunning: boolean;
}> {
  const keys = new Set<string>();
  const pidByKey = new Map<string, number[]>();
  if (process.platform !== 'win32')
    return { queried: false, keys, pidByKey, bareMasterRunning: false };
  try {
    const helperRows = await queryHdPlayerProcessesViaWin32Helper();
    const entries: Array<{ pid: number; cmd: string }> = helperRows
      ? helperRows.map((r) => ({ pid: r.pid, cmd: r.commandLine }))
      : (
          await runProcess(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "Name = \'HD-Player.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
            ],
            { timeoutMs: 4000 },
          )
        )
          .toString('utf8')
          .split(/\r?\n/)
          .flatMap((raw) => {
            const sep = raw.indexOf('|');
            if (sep < 0) return [];
            return [{ pid: Number(raw.slice(0, sep).trim()), cmd: raw.slice(sep + 1).trim() }];
          });
    let bareMasterRunning = false;
    for (const { pid, cmd } of entries) {
      if (!cmd) continue;
      const m = /(?:^|\s)--instance\s+"?([A-Za-z0-9_.-]+)"?(?:\s|$)/i.exec(cmd);
      if (m?.[1]) {
        keys.add(m[1]);
        if (Number.isFinite(pid) && pid > 0) {
          const list = pidByKey.get(m[1]) ?? [];
          list.push(pid);
          pidByKey.set(m[1], list);
        }
      } else bareMasterRunning = true;
    }
    return { queried: true, keys, pidByKey, bareMasterRunning };
  } catch {
    return { queried: false, keys, pidByKey, bareMasterRunning: false };
  }
}
/**
 * Probes whether `com.facebook.lite` is installed.
 * Returns:
 * - `true`  when confirmed installed
 * - `false` ONLY when Android PackageManager itself is healthy (`package:android` present) and FB Lite is absent
 * - `null`  when ADB / PackageManager is busy, booting, or shutting down (prevents false `missing-app` wipes!)
 */
export async function probeFbLiteInstalled(
  ctx: DeviceRuntimeContext,
  serial: string,
  force = false,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const cached = ctx.litePackageCache.get(serial);
  if (!force && cached && Date.now() - cached.checkedAt < 15000) return cached.installed;
  try {
    const out = (
      await adb(ctx, serial, ['shell', 'pm', 'list', 'packages', 'com.facebook.lite'], 5000, signal)
    ).toString('utf8');
    if (out.includes('package:com.facebook.lite')) {
      ctx.litePackageCache.set(serial, { installed: true, checkedAt: Date.now() });
      return true;
    }
    // Verify PackageManager itself is responsive before declaring the app uninstalled
    const sysOut = (
      await adb(ctx, serial, ['shell', 'pm', 'list', 'packages', 'android'], 4000, signal)
    ).toString('utf8');
    if (sysOut.includes('package:android')) {
      ctx.litePackageCache.set(serial, { installed: false, checkedAt: Date.now() });
      return false;
    }
    return null;
  } catch {
    return null;
  }
}
export async function hasFbLiteInstalled(
  ctx: DeviceRuntimeContext,
  serial: string,
  force = false,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await probeFbLiteInstalled(ctx, serial, force, signal)) === true;
}
export async function readLiveScreenSize(
  ctx: DeviceRuntimeContext,
  serial: string,
  fallbackW: number,
  fallbackH: number,
  force = false,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const cached = ctx.wmSizeCache.get(serial);
  if (!force && cached && Date.now() - cached.checkedAt < 30000) {
    return { width: cached.width, height: cached.height };
  }
  try {
    const out = (await adb(ctx, serial, ['shell', 'wm', 'size'], 4000, signal)).toString('utf8');
    const overrideMatch = /Override size:\s*(\d+)x(\d+)/i.exec(out);
    const physicalMatch = /Physical size:\s*(\d+)x(\d+)/i.exec(out);
    const ovW = overrideMatch?.[1] ? Number(overrideMatch[1]) : 0;
    const ovH = overrideMatch?.[2] ? Number(overrideMatch[2]) : 0;
    const phW = physicalMatch?.[1] ? Number(physicalMatch[1]) : 0;
    const phH = physicalMatch?.[2] ? Number(physicalMatch[2]) : 0;
    const preferPhysical =
      ovW >= 100 &&
      ovH >= 100 &&
      phW >= 100 &&
      phH >= 100 &&
      phW === fallbackW &&
      phH === fallbackH &&
      Math.abs(ovW / ovH - phW / phH) > 0.08;
    const width = preferPhysical ? phW : ovW >= 100 && ovH >= 100 ? ovW : phW;
    const height = preferPhysical ? phH : ovW >= 100 && ovH >= 100 ? ovH : phH;
    if (width >= 100 && height >= 100) {
      ctx.wmSizeCache.set(serial, { width, height, checkedAt: Date.now() });
      return { width, height };
    }
  } catch {
    /* fallback to conf dimensions */
  }
  return { width: fallbackW, height: fallbackH };
}
export async function readFbLiteVersion(
  ctx: DeviceRuntimeContext,
  serial: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const out = (
      await adb(
        ctx,
        serial,
        ['shell', 'dumpsys package com.facebook.lite | grep versionName | head -n 1'],
        4000,
        signal,
      )
    )
      .toString('utf8')
      .trim();
    const m = /versionName=([^\s]+)/.exec(out);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
export async function lockPortraitOrientation(
  ctx: DeviceRuntimeContext,
  serial: string,
  signal?: AbortSignal,
): Promise<void> {
  await adb(
    ctx,
    serial,
    ['shell', 'settings put system accelerometer_rotation 0; settings put system user_rotation 0'],
    4000,
    signal,
  ).catch(() => null);
}
export async function readGuestSdkVersion(
  ctx: DeviceRuntimeContext,
  serial: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const out = (await adb(ctx, serial, ['shell', 'getprop', 'ro.build.version.sdk'], 3500, signal))
      .toString('utf8')
      .trim();
    const sdk = Number(out);
    return Number.isFinite(sdk) && sdk > 0 ? sdk : null;
  } catch {
    return null;
  }
}
export function matchesInstanceSdk(instanceKey: string, sdk: number | null): boolean {
  if (!sdk) return true;
  const lower = instanceKey.toLowerCase();
  if (lower.startsWith('tiramisu')) return sdk >= 31;
  if (lower.startsWith('rvc')) return sdk >= 29 && sdk <= 30;
  if (lower.startsWith('pie')) return sdk === 28;
  if (lower.startsWith('nougat')) return sdk <= 25;
  return true;
}
