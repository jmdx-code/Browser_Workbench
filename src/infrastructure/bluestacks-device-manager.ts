import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import path from 'node:path';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  isBluestacksPortraitResolution,
  type BluestacksAccountState,
  type BluestacksIdentityType,
  type BluestacksInstance,
  type BluestacksManagedIdentity,
  type BluestacksRuntimeConfig,
} from '../shared/bluestacks.js';
import type { BluestacksSavedSettings, DiscoveredInstanceRecord } from './bluestacks-store.js';
import {
  classifyAbnormalScreenText,
  cropToDataUrl,
  detectBottomSheetIdentityRows,
  detectHomeTabBar,
  findAllTextInputNodes,
  flattenLiteNodes,
  isBottomSheetOpen,
  isLiteTextInputClass,
  isSolidBlueButton,
  makeCanonicalRect,
  parseDumpsysTop,
  parseLiteXml,
  readPngDimensions,
  resolveProfileShareUrl,
  scalePointFrom900,
  type LiteXmlNode,
  type OcrRecognizer,
  type RectBounds,
} from './bluestacks-vision.js';
import {
  arrangeBlueStacksWindows,
  closeBlueStacksPids,
  focusBlueStacksWindow,
  generateTotpCode,
  isPrintableAscii,
  matchBlueStacksWindow,
  queryRunningBlueStacksWindows,
  quoteForAndroidInputText,
} from './bluestacks-win32.js';

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

export function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('TASK_STOPPED'));
  }
  return new Promise<void>((resolveWait, rejectWait) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(new Error('TASK_STOPPED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function runProcess(
  executable: string,
  args: string[],
  options: {
    input?: Buffer | string;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  if (options.signal?.aborted) {
    return Promise.reject(new Error('TASK_STOPPED'));
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let reason: string | undefined;
    let settled = false;
    let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupStreams = () => {
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
    };

    const settle = (errObj: Error | null, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
      if (errObj) {
        cleanupStreams();
        reject(errObj);
        return;
      }
      if (reason) {
        cleanupStreams();
        reject(new Error(reason));
      } else if (code !== 0) {
        reject(new Error(`EXIT_${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
      } else {
        resolveResult(Buffer.concat(out));
      }
    };

    const onAbort = () => {
      reason ??= 'TASK_STOPPED';
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      settle(new Error(reason));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      reason ??= 'TIMEOUT';
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      settle(new Error(reason));
    }, options.timeoutMs ?? 15000);

    const collect = (chunks: Buffer[], buffer: Buffer) => {
      if (settled) return;
      bytes += buffer.length;
      if (bytes > (options.maxBytes ?? 32 * 1024 * 1024)) {
        reason ??= 'OUTPUT_LIMIT';
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        settle(new Error(reason));
      } else {
        chunks.push(buffer);
      }
    };
    child.stdout?.on('data', (b: Buffer) => collect(out, b));
    child.stderr?.on('data', (b: Buffer) => collect(err, b));
    child.stdin?.on('error', () => {
      /* ignore EPIPE if child exited before consuming stdin */
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.once('error', (error) => {
      settle(error);
    });
    // On Windows, `adb start-server` / `connect` can spawn a background daemon that inherits
    // open pipe handles so `close` never fires even after the direct child exits.
    child.once('exit', (code) => {
      if (settled) return;
      exitGraceTimer = setTimeout(() => {
        cleanupStreams();
        settle(null, code);
      }, 250);
    });
    child.once('close', (code) => {
      settle(null, code);
    });
  });
}

function isTcpPortOpen(port: number, timeoutMs = 160): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

export interface ParsedBluestacksConfEntry {
  instanceKey: string;
  displayName: string;
  configuredPort: number;
  statusPort: number | null;
  fbWidth: number;
  fbHeight: number;
}

export function parseBluestacksConfContent(content: string): ParsedBluestacksConfEntry[] {
  const map = new Map<
    string,
    {
      displayName?: string;
      adbPort?: number;
      statusPort?: number;
      fbWidth?: number;
      fbHeight?: number;
    }
  >();
  for (const line of content.split(/\r?\n/)) {
    const m =
      /^bst\.instance\.([^.]+)\.(display_name|adb_port|status\.adb_port|fb_width|fb_height)="([^"]*)"/.exec(
        line.trim(),
      );
    if (!m) continue;
    const key = m[1];
    const field = m[2];
    const val = m[3] ?? '';
    if (!key || !field) continue;
    const entry = map.get(key) ?? {};
    if (field === 'display_name') entry.displayName = val;
    else if (field === 'adb_port') entry.adbPort = Number(val);
    else if (field === 'status.adb_port') entry.statusPort = Number(val);
    else if (field === 'fb_width') entry.fbWidth = Number(val);
    else if (field === 'fb_height') entry.fbHeight = Number(val);
    map.set(key, entry);
  }
  const out: ParsedBluestacksConfEntry[] = [];
  for (const [instanceKey, v] of map) {
    const configuredPort = v.adbPort && v.adbPort > 0 ? v.adbPort : 5555;
    const statusPort = v.statusPort && v.statusPort > 0 ? v.statusPort : null;
    out.push({
      instanceKey,
      displayName: v.displayName?.trim() || instanceKey,
      configuredPort,
      statusPort,
      fbWidth: v.fbWidth && v.fbWidth >= 100 ? v.fbWidth : 900,
      fbHeight: v.fbHeight && v.fbHeight >= 100 ? v.fbHeight : 1600,
    });
  }
  return out;
}

// Global host clipboard mutex so concurrent BlueStacks instances never collide
let clipboardQueue: Promise<unknown> = Promise.resolve();
export function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = clipboardQueue.then(fn, fn);
  clipboardQueue = next.catch(() => {});
  return next;
}

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data?: unknown }) => void): void;
  start?(): void;
}

const pendingIpcClipboard = new Map<
  string,
  { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }
>();
let ipcClipboardBoundPort: ParentPortLike | null = null;

function ensureIpcClipboardPort(): ParentPortLike | null {
  const procRecord = process as unknown as { parentPort?: ParentPortLike };
  const port = procRecord.parentPort ?? null;
  if (!port) return null;
  if (ipcClipboardBoundPort !== port) {
    ipcClipboardBoundPort = port;
    port.on('message', (event: { data?: unknown }) => {
      const msg = event && typeof event === 'object' && 'data' in event ? event.data : event;
      if (
        msg &&
        typeof msg === 'object' &&
        'type' in msg &&
        msg.type === 'CLIPBOARD_RESULT' &&
        'reqId' in msg &&
        typeof msg.reqId === 'string'
      ) {
        const pending = pendingIpcClipboard.get(msg.reqId);
        if (!pending) return;
        pendingIpcClipboard.delete(msg.reqId);
        clearTimeout(pending.timer);
        const ok = !('ok' in msg) || msg.ok !== false;
        const text = 'text' in msg && typeof msg.text === 'string' ? msg.text : '';
        pending.resolve(ok ? text : null);
      }
    });
    if (typeof port.start === 'function') {
      port.start();
    }
  }
  return port;
}

async function ipcClipboardRequest(
  payload:
    | { type: 'CLIPBOARD_GET'; reqId: string }
    | { type: 'CLIPBOARD_SET'; reqId: string; text: string },
): Promise<string | null> {
  const port = ensureIpcClipboardPort();
  if (!port) return null;
  return new Promise<string | null>((resolveReq) => {
    const timer = setTimeout(() => {
      pendingIpcClipboard.delete(payload.reqId);
      resolveReq(null);
    }, 1500);
    pendingIpcClipboard.set(payload.reqId, { resolve: resolveReq, timer });
    try {
      port.postMessage(payload);
    } catch {
      clearTimeout(timer);
      pendingIpcClipboard.delete(payload.reqId);
      resolveReq(null);
    }
  });
}

async function getHostClipboard(): Promise<string> {
  const ipcRes = await ipcClipboardRequest({ type: 'CLIPBOARD_GET', reqId: randomUUID() });
  if (ipcRes !== null) return ipcRes.trim();
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'for ($i = 0; $i -lt 10; $i++) { ' +
    'try { Get-Clipboard -Raw -ErrorAction Stop; exit 0 } ' +
    'catch { if ($i -eq 9) { throw }; Start-Sleep -Milliseconds 60 } ' +
    '}';
  const out = await runProcess('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], {
    timeoutMs: 8000,
  });
  return out.toString('utf8').trim();
}

async function setHostClipboard(text: string): Promise<void> {
  const ipcRes = await ipcClipboardRequest({
    type: 'CLIPBOARD_SET',
    reqId: randomUUID(),
    text,
  });
  if (ipcRes !== null) return;
  if (!text) {
    // PowerShell Set-Clipboard throws ArgumentNullException on empty string; pass $null to clear cleanly.
    await runProcess(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-Command', 'Set-Clipboard -Value $null'],
      { timeoutMs: 8000 },
    ).catch(() => null);
    return;
  }
  const script =
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
    '$val = [Console]::In.ReadToEnd(); ' +
    'for ($i = 0; $i -lt 10; $i++) { ' +
    'try { Set-Clipboard -Value $val -ErrorAction Stop; exit 0 } ' +
    'catch { if ($i -eq 9) { throw }; Start-Sleep -Milliseconds 60 } ' +
    '}';
  await runProcess('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], {
    input: Buffer.from(text, 'utf8'),
    timeoutMs: 8000,
  });
}

const COMMON_INSTALL_DIRS = [
  'C:\\Program Files\\BlueStacks_nxt',
  'D:\\Program Files\\BlueStacks_nxt',
  'E:\\Program Files\\BlueStacks_nxt',
  'C:\\Program Files\\BlueStacks_bgp64',
];

const COMMON_CONF_PATHS = [
  'D:\\BlueStacks_nxt\\bluestacks.conf',
  'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf',
  'E:\\BlueStacks_nxt\\bluestacks.conf',
  'F:\\BlueStacks_nxt\\bluestacks.conf',
];

export class BluestacksDeviceManager {
  private registryDetectPromise: Promise<{
    installDir: string | null;
    confPath: string | null;
  }> | null = null;
  private readonly litePackageCache = new Map<string, { installed: boolean; checkedAt: number }>();
  private readonly wmSizeCache = new Map<
    string,
    { width: number; height: number; checkedAt: number }
  >();
  private onlineInstanceKeys = new Set<string>();
  private launchSpawnTail: Promise<void> = Promise.resolve();
  private lastPlayerSpawnAt = 0;
  private adbDaemonRecoveryPromise: Promise<void> | null = null;
  private lastAdbDaemonRecoveryAt = 0;
  private consecutiveAdbTimeouts = 0;

  private async runSerializedPlayerSpawn(
    playerPath: string,
    safeKey: string,
    signal?: AbortSignal,
  ): Promise<{ exitedEarly: () => number | null }> {
    const prev = this.launchSpawnTail;
    let release: () => void = () => {};
    this.launchSpawnTail = new Promise<void>((r) => {
      release = r;
    });
    let earlyExitCode: number | null = null;
    try {
      await prev.catch(() => {});
      const minGapMs = 3200;
      const waitMs = Math.max(0, this.lastPlayerSpawnAt + minGapMs - Date.now());
      if (waitMs > 0) {
        await abortableWait(waitMs, signal);
      }
      if (signal?.aborted) throw new Error('TASK_STOPPED');
      this.lastPlayerSpawnAt = Date.now();

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
            if (typeof code === 'number' && code !== 0) {
              earlyExitCode = code;
            }
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

  constructor(
    private readonly repo: CompatibleRepository<BluestacksDeviceRepo>,
    private readonly ocr: OcrRecognizer,
  ) {}

  getOnlineKeys(): ReadonlySet<string> {
    return this.onlineInstanceKeys;
  }

  private detectRegistryPaths(): Promise<{ installDir: string | null; confPath: string | null }> {
    if (this.registryDetectPromise) return this.registryDetectPromise;
    this.registryDetectPromise = (async () => {
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
    return this.registryDetectPromise;
  }

  private detectLocalFbLiteApk(): string | null {
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

  async resolveRuntimeConfig(): Promise<{
    config: BluestacksRuntimeConfig;
    adbPath: string | null;
    playerPath: string | null;
    effectiveConfPath: string | null;
    effectiveApkPath: string | null;
  }> {
    const saved = await this.repo.savedSettings();
    const reg = await this.detectRegistryPaths();

    const detectedInstallDir =
      reg.installDir ??
      COMMON_INSTALL_DIRS.find((dir) => existsSync(path.join(dir, 'HD-Adb.exe'))) ??
      null;
    const detectedConfPath =
      reg.confPath ?? COMMON_CONF_PATHS.find((file) => existsSync(file)) ?? null;
    const detectedApkPath = this.detectLocalFbLiteApk();

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

  private async requireAdbPath(): Promise<string> {
    const { adbPath } = await this.resolveRuntimeConfig();
    if (!adbPath) {
      throw new ProductError(
        'BLUESTACKS_ADB_NOT_FOUND',
        '未找到蓝蝶 HD-Adb.exe，请在左侧点击设置按钮指定 BlueStacks 安装目录',
        400,
      );
    }
    return adbPath;
  }

  private async recoverAdbDaemon(adbExe: string, signal?: AbortSignal): Promise<void> {
    if (this.adbDaemonRecoveryPromise) {
      return this.adbDaemonRecoveryPromise;
    }
    if (Date.now() - this.lastAdbDaemonRecoveryAt < 20_000) {
      return;
    }
    this.lastAdbDaemonRecoveryAt = Date.now();
    this.adbDaemonRecoveryPromise = (async () => {
      await runProcess(adbExe, ['kill-server'], { timeoutMs: 6000, signal }).catch(() => null);
      await abortableWait(500, signal).catch(() => null);
      await runProcess(adbExe, ['start-server'], { timeoutMs: 10_000, signal }).catch(() => null);
    })().finally(() => {
      this.adbDaemonRecoveryPromise = null;
    });
    return this.adbDaemonRecoveryPromise;
  }

  async adb(
    serial: string,
    args: string[],
    timeoutMs = 15000,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const adbExe = await this.requireAdbPath();
    try {
      const out = await runProcess(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
      this.consecutiveAdbTimeouts = 0;
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
        this.consecutiveAdbTimeouts++;
      }
      if (isDaemonError || (isTimeout && this.consecutiveAdbTimeouts >= 2)) {
        this.consecutiveAdbTimeouts = 0;
        await this.recoverAdbDaemon(adbExe, signal);
        await runProcess(adbExe, ['connect', serial], { timeoutMs: 6000, signal }).catch(
          () => null,
        );
        return await runProcess(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
      }
      if (/not found|offline|closed/i.test(msg)) {
        await runProcess(adbExe, ['connect', serial], { timeoutMs: 6000, signal }).catch(
          () => null,
        );
        return await runProcess(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
      }
      throw err;
    }
  }

  private async readRunningHdPlayerInstances(): Promise<{
    queried: boolean;
    keys: Set<string>;
    bareMasterRunning: boolean;
  }> {
    if (process.platform !== 'win32') {
      return { queried: false, keys: new Set(), bareMasterRunning: false };
    }
    try {
      const out = await runProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "Name = \'HD-Player.exe\'" | ForEach-Object { $_.CommandLine }',
        ],
        { timeoutMs: 4000 },
      );
      const keys = new Set<string>();
      let bareMasterRunning = false;
      for (const line of out.toString('utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = /(?:^|\s)--instance\s+"?([A-Za-z0-9_.-]+)"?(?:\s|$)/i.exec(trimmed);
        if (m?.[1]) {
          keys.add(m[1]);
        } else {
          bareMasterRunning = true;
        }
      }
      return { queried: true, keys, bareMasterRunning };
    } catch {
      return { queried: false, keys: new Set(), bareMasterRunning: false };
    }
  }

  /**
   * Probes whether `com.facebook.lite` is installed.
   * Returns:
   * - `true`  when confirmed installed
   * - `false` ONLY when Android PackageManager itself is healthy (`package:android` present) and FB Lite is absent
   * - `null`  when ADB / PackageManager is busy, booting, or shutting down (prevents false `missing-app` wipes!)
   */
  async probeFbLiteInstalled(
    serial: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    const cached = this.litePackageCache.get(serial);
    if (!force && cached && Date.now() - cached.checkedAt < 15000) {
      return cached.installed;
    }
    try {
      const out = (
        await this.adb(
          serial,
          ['shell', 'pm', 'list', 'packages', 'com.facebook.lite'],
          5000,
          signal,
        )
      ).toString('utf8');
      if (out.includes('package:com.facebook.lite')) {
        this.litePackageCache.set(serial, { installed: true, checkedAt: Date.now() });
        return true;
      }
      // Verify PackageManager itself is responsive before declaring the app uninstalled
      const sysOut = (
        await this.adb(serial, ['shell', 'pm', 'list', 'packages', 'android'], 4000, signal)
      ).toString('utf8');
      if (sysOut.includes('package:android')) {
        this.litePackageCache.set(serial, { installed: false, checkedAt: Date.now() });
        return false;
      }
      return null;
    } catch {
      return null;
    }
  }

  async hasFbLiteInstalled(serial: string, force = false, signal?: AbortSignal): Promise<boolean> {
    return (await this.probeFbLiteInstalled(serial, force, signal)) === true;
  }

  async readLiveScreenSize(
    serial: string,
    fallbackW: number,
    fallbackH: number,
    force = false,
    signal?: AbortSignal,
  ): Promise<{ width: number; height: number }> {
    const cached = this.wmSizeCache.get(serial);
    if (!force && cached && Date.now() - cached.checkedAt < 30000) {
      return { width: cached.width, height: cached.height };
    }
    try {
      const out = (await this.adb(serial, ['shell', 'wm', 'size'], 4000, signal)).toString('utf8');
      const overrideMatch = /Override size:\s*(\d+)x(\d+)/i.exec(out);
      const physicalMatch = /Physical size:\s*(\d+)x(\d+)/i.exec(out);
      const m = overrideMatch ?? physicalMatch;
      if (m?.[1] && m[2]) {
        const width = Number(m[1]);
        const height = Number(m[2]);
        if (width >= 100 && height >= 100) {
          this.wmSizeCache.set(serial, { width, height, checkedAt: Date.now() });
          return { width, height };
        }
      }
    } catch {
      /* fallback to conf dimensions */
    }
    return { width: fallbackW, height: fallbackH };
  }

  private async readFbLiteVersion(serial: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const out = (
        await this.adb(
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

  async lockPortraitOrientation(serial: string, signal?: AbortSignal): Promise<void> {
    await this.adb(
      serial,
      [
        'shell',
        'settings put system accelerometer_rotation 0; settings put system user_rotation 0',
      ],
      4000,
      signal,
    ).catch(() => null);
  }

  private async readGuestSdkVersion(serial: string, signal?: AbortSignal): Promise<number | null> {
    try {
      const out = (
        await this.adb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], 3500, signal)
      )
        .toString('utf8')
        .trim();
      const sdk = Number(out);
      return Number.isFinite(sdk) && sdk > 0 ? sdk : null;
    } catch {
      return null;
    }
  }

  private matchesInstanceSdk(instanceKey: string, sdk: number | null): boolean {
    if (!sdk) return true;
    const lower = instanceKey.toLowerCase();
    if (lower.startsWith('tiramisu')) return sdk >= 31;
    if (lower.startsWith('rvc')) return sdk >= 29 && sdk <= 30;
    if (lower.startsWith('pie')) return sdk === 28;
    if (lower.startsWith('nougat')) return sdk <= 25;
    return true;
  }

  async discoverInstances(): Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }> {
    const { config, adbPath, effectiveConfPath } = await this.resolveRuntimeConfig();
    const confEntries = effectiveConfPath
      ? (() => {
          try {
            return parseBluestacksConfContent(readFileSync(effectiveConfPath, 'utf8'));
          } catch {
            return [];
          }
        })()
      : [];

    if (!adbPath) {
      const offlineItems: DiscoveredInstanceRecord[] = confEntries.map((e) => ({
        instanceKey: e.instanceKey,
        displayName: e.displayName,
        adbPort: e.configuredPort,
        fbWidth: e.fbWidth,
        fbHeight: e.fbHeight,
        online: false,
        fbLiteInstalled: null,
      }));
      this.onlineInstanceKeys = new Set();
      const instances =
        offlineItems.length > 0
          ? await this.repo.upsertDiscoveredInstances(offlineItems)
          : await this.repo.listInstances([]);
      return { instances, config };
    }

    const resolvedEntries = confEntries.map((entry) => {
      const adbPort =
        entry.statusPort &&
        entry.statusPort > 0 &&
        (entry.statusPort !== 5555 || entry.configuredPort === 5555)
          ? entry.statusPort
          : entry.configuredPort;
      return { ...entry, adbPort };
    });

    const candidatePorts = [...new Set(resolvedEntries.map((e) => e.adbPort).filter((p) => p > 0))];
    const portChecks = await Promise.all(
      candidatePorts.map(async (port) => ({ port, open: await isTcpPortOpen(port) })),
    );
    const openPorts = new Set(portChecks.filter((c) => c.open).map((c) => c.port));

    await Promise.all(
      [...openPorts].map((port) =>
        runProcess(adbPath, ['connect', `127.0.0.1:${port}`], { timeoutMs: 6000 }).catch(
          () => null,
        ),
      ),
    );

    const onlineSerials = new Set<string>();
    try {
      const devOut = (await runProcess(adbPath, ['devices'], { timeoutMs: 6000 })).toString('utf8');
      for (const line of devOut.split(/\r?\n/)) {
        const m = /^(\S+)\s+device$/.exec(line.trim());
        if (m?.[1] && !m[1].startsWith('emulator-')) {
          onlineSerials.add(m[1]);
        }
      }
    } catch {
      /* ignore */
    }

    // Count how many conf entries share each port (e.g. master Pie64 & master Tiramisu64 sharing 5555)
    const portEntryCounts = new Map<number, number>();
    for (const e of resolvedEntries) {
      portEntryCounts.set(e.adbPort, (portEntryCounts.get(e.adbPort) ?? 0) + 1);
    }

    const installChecks = new Map<string, boolean | null>();
    const sizeChecks = new Map<string, { width: number; height: number }>();
    const sdkChecks = new Map<string, number | null>();
    const versionChecks = new Map<string, string | null>();
    await Promise.all(
      [...onlineSerials].map(async (serial) => {
        const [installed, size, sdk] = await Promise.all([
          this.probeFbLiteInstalled(serial),
          this.readLiveScreenSize(serial, 900, 1600),
          this.readGuestSdkVersion(serial),
        ]);
        const ver = installed === true ? await this.readFbLiteVersion(serial) : null;
        installChecks.set(serial, installed);
        sizeChecks.set(serial, size);
        sdkChecks.set(serial, sdk);
        versionChecks.set(serial, ver);
      }),
    );

    // Pick winning instanceKey for any shared open port using:
    // 1) Win32 visible window title match (100% accurate even for elevated HD-Player on port 5555!)
    // 2) CommandLine --instance match (when readable)
    // 3) Android guest SDK + live resolution fallback
    const sharedPortWinner = new Map<number, string>();
    const sharedOpenPorts = [...openPorts].filter((p) => (portEntryCounts.get(p) ?? 0) > 1);
    if (sharedOpenPorts.length > 0) {
      const [runningWins, runningProc] = await Promise.all([
        queryRunningBlueStacksWindows(runProcess),
        this.readRunningHdPlayerInstances(),
      ]);
      for (const port of sharedOpenPorts) {
        const serial = `127.0.0.1:${port}`;
        if (!onlineSerials.has(serial)) continue;
        const contenders = resolvedEntries.filter((e) => e.adbPort === port);
        const titleMatched = contenders.find((e) => {
          const normName = e.displayName.trim().toLowerCase();
          return (
            normName.length > 0 &&
            runningWins.some(
              (w) =>
                w.title.trim().toLowerCase() === normName &&
                (w.listeningPorts.length === 0 || w.listeningPorts.includes(port)),
            )
          );
        });
        if (titleMatched) {
          sharedPortWinner.set(port, titleMatched.instanceKey);
          continue;
        }
        const cmdMatch = contenders.find((e) => runningProc.keys.has(e.instanceKey));
        if (cmdMatch) {
          sharedPortWinner.set(port, cmdMatch.instanceKey);
          continue;
        }
        const liveSdk = sdkChecks.get(serial) ?? null;
        const liveSize = sizeChecks.get(serial);
        const sdkFiltered = contenders.filter((e) =>
          this.matchesInstanceSdk(e.instanceKey, liveSdk),
        );
        const pool = sdkFiltered.length > 0 ? sdkFiltered : contenders;
        const sizeMatched = liveSize
          ? pool.find((e) => e.fbWidth === liveSize.width && e.fbHeight === liveSize.height)
          : undefined;
        const winner = sizeMatched ?? pool[0];
        if (winner) sharedPortWinner.set(port, winner.instanceKey);
      }
    }

    const items: DiscoveredInstanceRecord[] = [];
    const onlineKeys = new Set<string>();

    for (const entry of resolvedEntries) {
      const serial = `127.0.0.1:${entry.adbPort}`;
      const isSharedPort = (portEntryCounts.get(entry.adbPort) ?? 0) > 1;
      const wonPort = !isSharedPort || sharedPortWinner.get(entry.adbPort) === entry.instanceKey;
      const online = wonPort && openPorts.has(entry.adbPort) && onlineSerials.has(serial);
      if (online) onlineKeys.add(entry.instanceKey);
      const liveSize = online ? sizeChecks.get(serial) : undefined;
      items.push({
        instanceKey: entry.instanceKey,
        displayName: entry.displayName,
        adbPort: entry.adbPort,
        fbWidth: liveSize?.width ?? entry.fbWidth,
        fbHeight: liveSize?.height ?? entry.fbHeight,
        online,
        fbLiteInstalled: online ? (installChecks.get(serial) ?? null) : null,
        androidSdk: online ? (sdkChecks.get(serial) ?? null) : null,
        fbLiteVersion: online ? (versionChecks.get(serial) ?? null) : null,
      });
    }

    for (const serial of onlineSerials) {
      if (items.some((i) => `127.0.0.1:${i.adbPort}` === serial && i.online)) continue;
      const portMatch = /:(\d+)$/.exec(serial);
      const port = portMatch?.[1] ? Number(portMatch[1]) : 5555;
      const liveSize = sizeChecks.get(serial) ?? { width: 900, height: 1600 };
      onlineKeys.add(serial);
      items.push({
        instanceKey: serial,
        displayName: serial,
        adbPort: port,
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
        online: true,
        fbLiteInstalled: installChecks.get(serial) ?? false,
        androidSdk: sdkChecks.get(serial) ?? null,
        fbLiteVersion: versionChecks.get(serial) ?? null,
      });
    }

    this.onlineInstanceKeys = onlineKeys;
    const instances =
      items.length > 0
        ? await this.repo.upsertDiscoveredInstances(items)
        : await this.repo.listInstances([...onlineKeys]);
    return { instances, config };
  }

  async launchInstance(instanceId: string, signal?: AbortSignal): Promise<BluestacksInstance> {
    const existing = await this.repo.getInstance(instanceId);
    if (!existing) {
      throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
    }
    const { playerPath, adbPath, effectiveConfPath } = await this.resolveRuntimeConfig();
    if (!playerPath) {
      throw new ProductError(
        'BLUESTACKS_PLAYER_NOT_FOUND',
        '未找到 HD-Player.exe，请在设置中指定 BlueStacks 安装目录',
        400,
      );
    }
    if (!adbPath) {
      throw new ProductError(
        'BLUESTACKS_ADB_NOT_FOUND',
        '未找到 HD-Adb.exe，请在设置中指定 BlueStacks 安装目录',
        400,
      );
    }

    const safeKey = existing.instanceKey.replace(/[^A-Za-z0-9_.-]/g, '');
    const allSavedInstances = await this.repo.listInstances();
    const sharedPort =
      existing.adbPort > 0 &&
      allSavedInstances.filter((item) => item.adbPort === existing.adbPort).length > 1;
    let alreadyOpen = false;
    if (sharedPort) {
      const runningWins = await queryRunningBlueStacksWindows(runProcess);
      alreadyOpen = Boolean(
        matchBlueStacksWindow(runningWins, {
          displayName: existing.displayName,
          instanceKey: existing.instanceKey,
          adbPort: existing.adbPort,
          sharedPort: true,
        }),
      );
    } else {
      alreadyOpen = await isTcpPortOpen(existing.adbPort);
    }
    let spawnMonitor: { exitedEarly: () => number | null } | null = null;
    if (!alreadyOpen) {
      spawnMonitor = await this.runSerializedPlayerSpawn(playerPath, safeKey, signal);
    }

    // Android 13 (Tiramisu) & concurrent multi-instance cold launches need up to 90s
    const deadline = Date.now() + 90_000;
    let activePort = existing.adbPort;
    let respawnRetries = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error('TASK_STOPPED');
      }
      if (
        spawnMonitor &&
        spawnMonitor.exitedEarly() !== null &&
        respawnRetries < 2 &&
        !(await isTcpPortOpen(activePort))
      ) {
        respawnRetries++;
        await abortableWait(2200, signal);
        spawnMonitor = await this.runSerializedPlayerSpawn(playerPath, safeKey, signal);
      }
      if (effectiveConfPath && existsSync(effectiveConfPath)) {
        try {
          const parsed = parseBluestacksConfContent(readFileSync(effectiveConfPath, 'utf8'));
          const match = parsed.find((p) => p.instanceKey === existing.instanceKey);
          if (match?.statusPort && (match.statusPort !== 5555 || match.configuredPort === 5555)) {
            activePort = match.statusPort;
          }
        } catch {
          /* ignore */
        }
      }
      if (await isTcpPortOpen(activePort)) {
        const serial = `127.0.0.1:${activePort}`;
        try {
          // On shared default port (e.g. 5555), verify this specific instance actually owns a window before probing
          if (sharedPort && activePort === existing.adbPort) {
            const runningWins = await queryRunningBlueStacksWindows(runProcess);
            const matchedWin = matchBlueStacksWindow(runningWins, {
              displayName: existing.displayName,
              instanceKey: existing.instanceKey,
              adbPort: activePort,
              sharedPort: true,
            });
            if (!matchedWin) {
              await abortableWait(1400, signal);
              continue;
            }
          }
          await runProcess(adbPath, ['connect', serial], { timeoutMs: 5000, signal });
          const bootOut = (
            await runProcess(adbPath, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
              timeoutMs: 4000,
              signal,
            })
          )
            .toString('utf8')
            .trim();
          if (bootOut === '1') {
            await abortableWait(800, signal);
            // Lock portrait orientation so Android 13 / FB Lite v524 never flips to landscape
            await this.lockPortraitOrientation(serial, signal);
            const { instances } = await this.discoverInstances();
            const refreshed = instances.find((i) => i.id === instanceId);
            if (refreshed?.online) return refreshed;
          }
        } catch {
          /* still booting */
        }
      }
      await abortableWait(1400, signal);
    }
    throw new ProductError(
      'BLUESTACKS_LAUNCH_TIMEOUT',
      `蓝蝶窗口 ${existing.displayName} 启动等待超时（90s），请检查多开器状态`,
      504,
    );
  }

  async closeInstance(instanceId: string): Promise<void> {
    const existing = await this.repo.getInstance(instanceId);
    if (!existing) {
      throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
    }
    const safeKey = existing.instanceKey.replace(/[^A-Za-z0-9_.-]/g, '');
    if (!safeKey) return;

    const { adbPath } = await this.resolveRuntimeConfig();
    const allInstances = await this.repo.listInstances();
    const sharedPort = allInstances.filter((i) => i.adbPort === existing.adbPort).length > 1;

    // 1. Identify exact owning HD-Player PID + HWND via Win32 window title + TCP port (works for port 5555 & elevated processes!)
    const runningWins = await queryRunningBlueStacksWindows(runProcess);
    const matchedWin = matchBlueStacksWindow(runningWins, {
      displayName: existing.displayName,
      instanceKey: existing.instanceKey,
      adbPort: existing.adbPort,
      sharedPort,
    });

    const portOpen = await isTcpPortOpen(existing.adbPort);
    const ownsLivePort =
      portOpen &&
      (!sharedPort || matchedWin !== null || this.onlineInstanceKeys.has(existing.instanceKey));

    // 2. Gracefully close the exact HD-Player window via WM_CLOSE + UIA confirmation.
    //    NEVER run `adb shell reboot -p` while HD-Player is in [Ready] state — that triggers
    //    BlueStacks's `FATAL: Unexpected shutdown. PlrState: 3` crash dialog! HD-Player itself
    //    flushes bluestacks.conf, powers down Android cleanly, and exits with err: 0.
    if (process.platform === 'win32') {
      const closeTargets: Array<{ pid: number; hwnd?: string | undefined }> = [];
      if (matchedWin) {
        closeTargets.push({ pid: matchedWin.pid, hwnd: matchedWin.hwnd });
      } else {
        // Fallback: query CommandLine match for non-elevated processes
        const cmdOut = await runProcess(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-Command',
            `$pattern = '(?:^|\\s)--instance\\s+"?' + [regex]::Escape('${safeKey}') + '"?(?:\\s|$)'; @(Get-CimInstance Win32_Process -Filter "Name = 'HD-Player.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object { [int]$_.ProcessId }) -join ','`,
          ],
          { timeoutMs: 4000 },
        ).catch(() => Buffer.alloc(0));
        for (const token of cmdOut.toString('utf8').split(',')) {
          const p = Number(token.trim());
          if (Number.isFinite(p) && p > 0) closeTargets.push({ pid: p });
        }
        if (closeTargets.length === 0 && !sharedPort && existing.adbPort > 0) {
          const portWin = runningWins.find((w) => w.listeningPorts.includes(existing.adbPort));
          if (portWin) closeTargets.push({ pid: portWin.pid, hwnd: portWin.hwnd });
        }
      }
      if (closeTargets.length > 0) {
        await closeBlueStacksPids(runProcess, closeTargets);
      }
    }

    // 3. Clean up stale ADB transport after HD-Player has powered down cleanly
    if (adbPath && ownsLivePort) {
      await runProcess(adbPath, ['disconnect', existing.serial], { timeoutMs: 4000 }).catch(
        () => null,
      );
    }
    this.onlineInstanceKeys.delete(existing.instanceKey);
  }

  async showInstance(instanceId: string): Promise<boolean> {
    const existing = await this.repo.getInstance(instanceId);
    if (!existing) {
      throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
    }
    const allInstances = await this.repo.listInstances();
    const sharedPort = allInstances.filter((i) => i.adbPort === existing.adbPort).length > 1;
    const wins = await queryRunningBlueStacksWindows(runProcess);
    const matched = matchBlueStacksWindow(wins, {
      displayName: existing.displayName,
      instanceKey: existing.instanceKey,
      adbPort: existing.adbPort,
      sharedPort,
    });
    if (!matched) {
      throw new ProductError(
        'BLUESTACKS_WINDOW_NOT_FOUND',
        `未找到运行中的蓝蝶窗口 ${existing.displayName}，请先启动模拟器`,
        404,
      );
    }
    return focusBlueStacksWindow(runProcess, matched.hwnd, matched.pid);
  }

  async arrangeWindows(
    instanceIds?: readonly string[],
    options: { columns?: number; gap?: number } = {},
  ): Promise<number> {
    const allInstances = await this.repo.listInstances([...this.onlineInstanceKeys]);
    const targetInstances =
      instanceIds && instanceIds.length > 0
        ? allInstances.filter((i) => instanceIds.includes(i.id))
        : allInstances.filter((i) => i.online);
    const wins = await queryRunningBlueStacksWindows(runProcess);
    const matchedItems: Array<{ hwnd: string; pid: number }> = [];
    const usedPids = new Set<number>();
    for (const inst of targetInstances) {
      const sharedPort = allInstances.filter((x) => x.adbPort === inst.adbPort).length > 1;
      const m = matchBlueStacksWindow(wins, {
        displayName: inst.displayName,
        instanceKey: inst.instanceKey,
        adbPort: inst.adbPort,
        sharedPort,
      });
      if (m && !usedPids.has(m.pid)) {
        usedPids.add(m.pid);
        matchedItems.push({ hwnd: m.hwnd, pid: m.pid });
      }
    }
    if (matchedItems.length === 0) {
      // Fallback: tile all visible HD-Player windows when caller didn't filter
      if (!instanceIds || instanceIds.length === 0) {
        return arrangeBlueStacksWindows(
          runProcess,
          wins.map((w) => ({ hwnd: w.hwnd, pid: w.pid })),
          options,
        );
      }
      return 0;
    }
    return arrangeBlueStacksWindows(runProcess, matchedItems, options);
  }

  async installFbLiteApk(
    instanceId: string,
    explicitApkPath?: string,
    signal?: AbortSignal,
  ): Promise<BluestacksInstance> {
    const { effectiveApkPath } = await this.resolveRuntimeConfig();
    const apkPath = explicitApkPath?.trim() || effectiveApkPath;
    if (!apkPath || !existsSync(apkPath)) {
      throw new ProductError(
        'BLUESTACKS_APK_NOT_FOUND',
        '未找到 FB Lite APK 安装包，请在蓝蝶路径设置中指定 .apk 文件路径',
        400,
      );
    }
    const { instances } = await this.discoverInstances();
    const inst = instances.find((i) => i.id === instanceId);
    if (!inst || !inst.online) {
      throw new ProductError('BLUESTACKS_OFFLINE', '模拟器未在线，请先启动蓝蝶窗口', 400);
    }
    await this.adb(inst.serial, ['install', '-r', '-g', apkPath], 90_000, signal);
    this.litePackageCache.delete(inst.serial);
    const installed = await this.hasFbLiteInstalled(inst.serial, true, signal);
    if (!installed) {
      throw new ProductError(
        'BLUESTACKS_APK_INSTALL_FAILED',
        'FB Lite APK 安装后未检测到应用包',
        500,
      );
    }
    const ver = await this.readFbLiteVersion(inst.serial, signal);
    return await this.repo.saveInspectionResult({
      id: inst.id,
      fbLiteInstalled: true,
      accountState: inst.accountState === 'missing-app' ? 'unknown' : inst.accountState,
      fbLiteVersion: ver,
    });
  }

  async screencap(serial: string, signal?: AbortSignal): Promise<Buffer> {
    try {
      const buf = await this.adb(serial, ['exec-out', 'screencap', '-p'], 8000, signal);
      if (buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50) return buf;
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'TASK_STOPPED')) {
        throw new Error('TASK_STOPPED');
      }
    }
    const remote = `/sdcard/agy_cap_${serial.replace(/[^0-9]/g, '')}.png`;
    await this.adb(serial, ['shell', 'screencap', '-p', remote], 8000, signal);
    const buf = await this.adb(serial, ['exec-out', 'cat', remote], 8000, signal);
    await this.adb(serial, ['shell', 'rm', '-f', remote], 4000).catch(() => null);
    return buf;
  }

  async dumpXml(
    serial: string,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<LiteXmlNode | null> {
    try {
      const topBuf = await this.adb(serial, ['shell', 'dumpsys', 'activity', 'top'], 4500, signal);
      const parsed = parseDumpsysTop(topBuf.toString('utf8'), screenW, screenH);
      if (parsed && flattenLiteNodes(parsed).length >= 8) {
        return parsed;
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'TASK_STOPPED')) {
        throw new Error('TASK_STOPPED');
      }
    }

    const remote = `/sdcard/agy_dump_${serial.replace(/[^0-9]/g, '')}.xml`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.adb(serial, ['shell', 'rm', '-f', remote], 3000, signal).catch(() => null);
        await this.adb(serial, ['shell', 'uiautomator', 'dump', remote], 7000, signal);
        const xmlBuf = await this.adb(serial, ['exec-out', 'cat', remote], 5000, signal);
        await this.adb(serial, ['shell', 'rm', '-f', remote], 3000).catch(() => null);
        const root = parseLiteXml(xmlBuf.toString('utf8'), screenW, screenH);
        if (root) return root;
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.message === 'TASK_STOPPED')) {
          throw new Error('TASK_STOPPED');
        }
        if (attempt === 0) {
          await this.swipe900(serial, 5, 500, 5, 492, 100, screenW, screenH, signal).catch(
            () => null,
          );
          await abortableWait(350, signal);
        }
      }
    }
    return null;
  }

  async tap900(
    serial: string,
    x900: number,
    y900: number,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<void> {
    const pt = scalePointFrom900(x900, y900, screenW, screenH);
    await this.adb(serial, ['shell', 'input', 'tap', String(pt.x), String(pt.y)], 5000, signal);
  }

  async swipe900(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 500,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<void> {
    const p1 = scalePointFrom900(x1, y1, screenW, screenH);
    const p2 = scalePointFrom900(x2, y2, screenW, screenH);
    await this.adb(
      serial,
      [
        'shell',
        'input',
        'swipe',
        String(p1.x),
        String(p1.y),
        String(p2.x),
        String(p2.y),
        String(Math.round(durationMs)),
      ],
      6000,
      signal,
    );
  }

  async keyevent(serial: string, code: number, signal?: AbortSignal): Promise<void> {
    await this.adb(serial, ['shell', 'input', 'keyevent', String(code)], 5000, signal);
  }

  private parseStreamMusicState(
    dumpsysAudio: string,
  ): { muted: boolean; speakerVol: number } | null {
    const idx = dumpsysAudio.indexOf('- STREAM_MUSIC:');
    if (idx < 0) return null;
    const block = dumpsysAudio.slice(idx, idx + 420);
    const mutedMatch = /\bMuted:\s*(true|false)\b/i.exec(block);
    const speakerMatch = /\bspeaker\):\s*(\d+)\b/i.exec(block);
    const defaultMatch = /\bdefault\):\s*(\d+)\b/i.exec(block);
    if (!mutedMatch) return null;
    const muted = mutedMatch[1]?.toLowerCase() === 'true';
    const speakerVol = Number(speakerMatch?.[1] ?? defaultMatch?.[1] ?? (muted ? 0 : 10));
    return { muted, speakerVol: Number.isFinite(speakerVol) ? speakerVol : 0 };
  }

  async setMediaSoundEnabled(
    serial: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (enabled) {
        const audioBuf = await this.adb(serial, ['shell', 'dumpsys', 'audio'], 4000, signal).catch(
          () => null,
        );
        const state = audioBuf ? this.parseStreamMusicState(audioBuf.toString('utf8')) : null;
        if (state && !state.muted && state.speakerVol >= 3) {
          return;
        }
        await this.adb(
          serial,
          [
            'shell',
            'media volume --stream 3 --set 11 >/dev/null 2>&1 || cmd media_session volume --stream 3 --set 11 >/dev/null 2>&1 || true',
          ],
          4000,
          signal,
        );
        const verifyBuf = await this.adb(serial, ['shell', 'dumpsys', 'audio'], 4000, signal).catch(
          () => null,
        );
        const afterState = verifyBuf
          ? this.parseStreamMusicState(verifyBuf.toString('utf8'))
          : null;
        if (afterState?.muted) {
          await this.keyevent(serial, 24, signal);
        }
      } else {
        await this.adb(
          serial,
          [
            'shell',
            'media volume --stream 3 --set 0 >/dev/null 2>&1 || cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1 || true',
          ],
          4000,
          signal,
        );
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'TASK_STOPPED')) {
        throw new Error('TASK_STOPPED');
      }
    }
  }

  async setInstanceSoundEnabled(
    instanceId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const existing = await this.repo.getInstance(instanceId);
    if (!existing) return;
    if (
      !this.onlineInstanceKeys.has(existing.instanceKey) &&
      !(await isTcpPortOpen(existing.adbPort))
    ) {
      return;
    }
    await this.setMediaSoundEnabled(existing.serial, enabled, signal);
  }

  private async focusBySerial(serial: string): Promise<void> {
    if (process.platform !== 'win32') return;
    const portMatch = /:(\d+)$/.exec(serial);
    const port = portMatch?.[1] ? Number(portMatch[1]) : 0;
    if (!port) return;
    const wins = await queryRunningBlueStacksWindows(runProcess);
    const matched = wins.find((w) => w.listeningPorts.includes(port));
    if (matched) {
      await focusBlueStacksWindow(runProcess, matched.hwnd, matched.pid).catch(() => false);
    }
  }

  async openDeepLink(
    serial: string,
    url: string,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!(await this.hasFbLiteInstalled(serial, false, signal))) {
      throw new Error('跳过：未安装 FB Lite');
    }
    await this.lockPortraitOrientation(serial, signal);

    // Android 13 / FB Lite v524 silently drops cold-boot PermalinkPossiblePatternsActivityAlias intents
    // if FB Lite MainActivity is not yet warm/resumed. Warm-start MainActivity first when needed.
    const preXml = await this.dumpXml(serial, screenW, screenH, signal).catch(() => null);
    if (!preXml || preXml.packageName !== 'com.facebook.lite') {
      await this.adb(
        serial,
        [
          'shell',
          'monkey',
          '-p',
          'com.facebook.lite',
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ],
        8000,
        signal,
      ).catch(() => null);
      for (let warm = 0; warm < 5; warm++) {
        await abortableWait(1200, signal);
        const wXml = await this.dumpXml(serial, screenW, screenH, signal).catch(() => null);
        if (
          wXml &&
          wXml.packageName === 'com.facebook.lite' &&
          flattenLiteNodes(wXml).length >= 8
        ) {
          break;
        }
      }
    }

    // POSIX single-quote URL for Android /system/bin/sh so '&' in permalink.php?story_fbid=X&id=Y is never truncated!
    const quotedUrl = `'${url.replace(/'/g, `'\\''`)}'`;
    await this.adb(
      serial,
      [
        'shell',
        'am',
        'start',
        '-n',
        'com.facebook.lite/.deeplinking.activities.PermalinkPossiblePatternsActivityAlias',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        quotedUrl,
      ],
      8000,
      signal,
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await abortableWait(1100, signal);
      const xml = await this.dumpXml(serial, screenW, screenH, signal);
      if (xml && xml.packageName === 'com.facebook.lite' && flattenLiteNodes(xml).length >= 10) {
        return;
      }
    }
  }

  async typeAsciiAt900(
    serial: string,
    x900: number,
    y900: number,
    text: string,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.tap900(serial, x900, y900, screenW, screenH, signal);
    await abortableWait(300, signal);
    // Chunk into 16-char segments so Android InputManager never drops fast bursts
    for (let i = 0; i < text.length; i += 16) {
      const chunk = text.slice(i, i + 16);
      await this.adb(
        serial,
        ['shell', `input text ${quoteForAndroidInputText(chunk)}`],
        8000,
        signal,
      );
      await abortableWait(100, signal);
    }
    await abortableWait(220, signal);
  }

  async pasteIntoFocused(
    serial: string,
    x900: number,
    y900: number,
    text: string,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
    options: { preferClipboard?: boolean } = {},
  ): Promise<void> {
    // Pure printable ASCII without newlines: type natively inside Android (zero host clipboard race!)
    if (
      !options.preferClipboard &&
      text.length > 0 &&
      text.length <= 160 &&
      isPrintableAscii(text)
    ) {
      await this.typeAsciiAt900(serial, x900, y900, text, screenW, screenH, signal);
      return;
    }
    await withClipboardLock(async () => {
      const previousClipboard = await getHostClipboard().catch(() => null);
      try {
        await this.focusBySerial(serial);
        await setHostClipboard(text);
        await abortableWait(260, signal);
        await this.tap900(serial, x900, y900, screenW, screenH, signal);
        await abortableWait(280, signal);
        await this.keyevent(serial, 279, signal);
        await abortableWait(350, signal);
      } finally {
        if (previousClipboard !== null) {
          await setHostClipboard(previousClipboard).catch(() => null);
        }
      }
    });
  }

  async pruneOldPushedMedia(
    serial: string,
    maxAgeMs = 30 * 60_000,
    signal?: AbortSignal,
  ): Promise<number> {
    const cutoffMs = Date.now() - Math.max(60_000, maxAgeMs);
    const dirs = ['/sdcard/Movies/Workbench', '/sdcard/Pictures/Workbench'];
    const stalePaths: string[] = [];
    for (const dir of dirs) {
      const outBuf = await this.adb(serial, ['shell', 'ls', '-1', dir], 4000, signal).catch(
        () => null,
      );
      if (!outBuf) continue;
      for (const rawLine of outBuf.toString('utf8').split(/\r?\n/)) {
        const name = rawLine.trim();
        const match = /^wb_(\d{13})_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.exec(name);
        if (!match?.[1]) continue;
        const createdAt = Number(match[1]);
        if (Number.isFinite(createdAt) && createdAt < cutoffMs) {
          stalePaths.push(`${dir}/${name}`);
        }
      }
    }
    if (stalePaths.length > 0) {
      await this.cleanupPushedMedia(serial, stalePaths);
    }
    return stalePaths.length;
  }

  async pushMediaToGallery(
    serial: string,
    localFilePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!existsSync(localFilePath)) {
      throw new Error(`媒体文件不存在: ${localFilePath}`);
    }
    await this.pruneOldPushedMedia(serial, 30 * 60_000, signal).catch(() => 0);
    const ext = path.extname(localFilePath).toLowerCase() || '.jpg';
    const isVideo = /\.(mp4|mov|m4v|webm|3gp|mkv)$/i.test(ext);
    const remoteDir = isVideo ? '/sdcard/Movies/Workbench' : '/sdcard/Pictures/Workbench';
    const safeName = `wb_${Date.now()}_${randomUUID().slice(0, 6)}${ext}`;
    const remotePath = `${remoteDir}/${safeName}`;
    // Ensure FB Lite already has storage/media read permissions so gallery picker never blocks on runtime dialog
    for (const perm of [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
    ]) {
      await this.adb(
        serial,
        ['shell', 'pm', 'grant', 'com.facebook.lite', perm],
        3000,
        signal,
      ).catch(() => null);
    }
    await this.adb(serial, ['shell', 'mkdir', '-p', remoteDir], 6000, signal);
    await this.adb(serial, ['push', localFilePath, remotePath], 60_000, signal);
    // Touch mtime to now + fire MediaStore scan so FB Lite's gallery picker shows it as the #1 newest item
    await this.adb(serial, ['shell', 'touch', remotePath], 4000, signal).catch(() => null);
    await this.adb(
      serial,
      [
        'shell',
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${remotePath}`,
      ],
      6000,
      signal,
    ).catch(() => null);
    await abortableWait(1200, signal);
    return remotePath;
  }

  async cleanupPushedMedia(serial: string, remotePaths: readonly string[]): Promise<void> {
    for (const remotePath of remotePaths) {
      if (!remotePath.startsWith('/sdcard/')) continue;
      await this.adb(serial, ['shell', 'rm', '-f', remotePath], 4000).catch(() => null);
      await this.adb(
        serial,
        [
          'shell',
          'am',
          'broadcast',
          '-a',
          'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
          '-d',
          `file://${remotePath}`,
        ],
        4000,
      ).catch(() => null);
    }
  }

  async copyLinkFromMoreMenu(
    serial: string,
    moreBounds: RectBounds,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return withClipboardLock(async () => {
      const previousClipboard = await getHostClipboard().catch(() => null);
      let sheetMayBeOpen = false;
      try {
        await this.focusBySerial(serial);
        const marker = `__AGY_EMPTY_${Date.now()}__`;
        const markerApplied = await setHostClipboard(marker)
          .then(() => true)
          .catch(() => false);
        sheetMayBeOpen = true;
        await this.tap900(serial, moreBounds.cx, moreBounds.cy, screenW, screenH, signal);
        await abortableWait(1350, signal);

        const [sheetPng, sheetXml] = await Promise.all([
          this.screencap(serial, signal),
          this.dumpXml(serial, screenW, screenH, signal),
        ]);
        if (!(await isBottomSheetOpen(sheetPng))) {
          sheetMayBeOpen = false;
          return null;
        }

        let copyTapY = 1370;
        const sheetRows = flattenLiteNodes(sheetXml)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.x1 >= 0 &&
              n.bounds.x1 <= 80 &&
              n.bounds.x2 >= 820 &&
              n.bounds.y1 >= 740 &&
              n.bounds.h >= 50 &&
              n.bounds.h <= 115,
          )
          .sort((a, b) => b.bounds.y1 - a.bounds.y1);
        for (const row of sheetRows) {
          const rowText = await this.ocr.recognizeBounds(sheetPng, row.bounds);
          const compact = rowText.replace(/\s+/g, '');
          if (/复制链接|複製連結|copylink/i.test(compact)) {
            copyTapY = row.bounds.cy;
            break;
          }
        }

        await this.tap900(serial, 450, copyTapY, screenW, screenH, signal);
        await abortableWait(900, signal);

        const afterPng = await this.screencap(serial, signal).catch(() => null);
        if (afterPng && (await isBottomSheetOpen(afterPng))) {
          await this.keyevent(serial, 4, signal).catch(() => null);
          await abortableWait(600, signal);
        }
        sheetMayBeOpen = false;

        const clip = await getHostClipboard().catch(() => '');
        if (!clip || !/^https?:\/\//i.test(clip)) {
          return null;
        }
        if (markerApplied && clip === marker) {
          return null;
        }
        if (!markerApplied && previousClipboard !== null && clip === previousClipboard) {
          return null;
        }
        return clip;
      } finally {
        if (sheetMayBeOpen && !signal?.aborted) {
          const remainPng = await this.screencap(serial).catch(() => null);
          if (remainPng && (await isBottomSheetOpen(remainPng))) {
            await this.keyevent(serial, 4).catch(() => null);
            await abortableWait(500).catch(() => null);
          }
        }
        if (previousClipboard !== null) {
          await setHostClipboard(previousClipboard).catch(() => null);
        }
      }
    });
  }

  isLoginOrLoggedOutXml(root: LiteXmlNode | null): boolean {
    if (!root || root.packageName !== 'com.facebook.lite') return false;
    const all = flattenLiteNodes(root);
    if (all.length < 6) return false;
    const hasMidScreenInput = all.some(
      (n) => isLiteTextInputClass(n.className) && n.bounds.y1 >= 140 && n.bounds.y2 <= 1180,
    );
    const hasHomeTabBar = detectHomeTabBar(root) !== null;
    const hasTopMenuOrBack = all.some(
      (n) =>
        n.clickable &&
        n.bounds.y1 >= 30 &&
        n.bounds.y2 <= 112 &&
        ((n.bounds.x1 <= 15 && n.bounds.x2 <= 95) || (n.bounds.x1 >= 815 && n.bounds.x2 <= 900)),
    );
    const hasExplicitLoginText = all.some((n) => {
      const label = `${n.text} ${n.contentDesc}`.trim();
      return /登录|登入|log\s*in|sign\s*in|创建新账号|创建新账户|建立新帳號|create\s*new\s*account|手机号或邮箱/i.test(
        label,
      );
    });
    if (hasMidScreenInput && !hasHomeTabBar && !hasTopMenuOrBack) return true;
    if (hasExplicitLoginText && !hasHomeTabBar && !hasTopMenuOrBack) return true;
    return false;
  }

  /**
   * Checks a full-screen screenshot for abnormal account screens (`logged-out` / `verification` / `restricted`).
   */
  async detectAbnormalScreen(
    serial: string,
    xml: LiteXmlNode | null,
    png?: Buffer,
    signal?: AbortSignal,
  ): Promise<'logged-out' | 'verification' | 'restricted' | null> {
    if (this.isLoginOrLoggedOutXml(xml)) return 'logged-out';
    const shot = png ?? (await this.screencap(serial, signal).catch(() => null));
    if (!shot) return null;
    const text = await this.ocr.recognizeBounds(shot, makeCanonicalRect(0, 0, 900, 1600));
    return classifyAbnormalScreenText(text);
  }

  /**
   * Reads switchable identities from FB Lite Menu's top profile card dropdown chevron,
   * and optionally taps a target identity (`targetName` or `targetType`).
   */
  private async inspectOrSelectManagedIdentities(
    serial: string,
    cardBounds: RectBounds,
    activeName: string,
    activeType: BluestacksIdentityType,
    sw: number,
    sh: number,
    selectTarget?: { targetName?: string; targetType?: 'personal' | 'page' },
    signal?: AbortSignal,
  ): Promise<{ identities: BluestacksManagedIdentity[]; switchedTo: string | null }> {
    const identities: BluestacksManagedIdentity[] = [];
    let switchedTo: string | null = null;
    const fallbackType: 'personal' | 'page' = activeType === 'page' ? 'page' : 'personal';
    if (activeName) {
      identities.push({ name: activeName, identityType: fallbackType, active: true });
    }

    // Chevron sits at the far right of the Menu profile card (~x=838, y=card.cy)
    const chevronX = Math.min(865, Math.max(810, cardBounds.x2 - 36));
    const chevronY = cardBounds.cy;
    await this.tap900(serial, chevronX, chevronY, sw, sh, signal);
    await abortableWait(1400, signal);

    const [dropPng] = await Promise.all([this.screencap(serial, signal)]);
    if (!(await isBottomSheetOpen(dropPng))) {
      return { identities, switchedTo: null };
    }

    const sheetRows = await detectBottomSheetIdentityRows(dropPng);
    const parsedRows: Array<{
      name: string;
      identityType: 'personal' | 'page';
      active: boolean;
      bounds: RectBounds;
    }> = [];
    for (const row of sheetRows) {
      const rawFull = (await this.ocr.recognizeBounds(dropPng, row.fullTextBounds))
        .replace(/[|_~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawFull) continue;
      if (
        /前往\s*meta|账户设置|创建新|create\s*new|新建公共主页|退出|log\s*out|查看全部/i.test(
          rawFull,
        )
      ) {
        continue;
      }
      const cleanedName = rawFull
        .replace(/[·•.,]?\s*\d+\s*(?:\+?\s*)?条\s*通\s*知.*$/i, '')
        .replace(/[·•.,]?\s*\d+\s*(?:\+?\s*)?notifications?.*$/i, '')
        .replace(/[·•.,]?\s*unread.*$/i, '')
        .trim();
      if (!cleanedName || cleanedName.length < 2) continue;

      const normRaw = cleanedName.toLowerCase();
      const normActive = activeName.toLowerCase();
      const matchesActive =
        Boolean(normActive) && (normRaw.includes(normActive) || normActive.includes(normRaw));
      const isActive = row.isActiveBlueCheck || matchesActive;
      // Prefer the bottom-sheet's own clean row OCR (handles short Page names like "Thu" accurately),
      // only falling back to activeName when the active row name contains activeName cleanly.
      const displayName =
        isActive && activeName && normRaw.includes(normActive) ? activeName : cleanedName;
      const rowType: 'personal' | 'page' = isActive
        ? fallbackType
        : parsedRows.length === 0 && fallbackType === 'page'
          ? 'personal'
          : 'page';
      if (!parsedRows.some((p) => p.name.toLowerCase() === displayName.toLowerCase())) {
        parsedRows.push({
          name: displayName,
          identityType: rowType,
          active: isActive,
          bounds: row.rowBounds,
        });
      }
    }

    if (parsedRows.length > 0) {
      identities.length = 0;
      for (const r of parsedRows) {
        identities.push({ name: r.name, identityType: r.identityType, active: r.active });
      }
    }

    if (selectTarget) {
      const wantName = selectTarget.targetName?.trim().toLowerCase() ?? '';
      let chosen: (typeof parsedRows)[number] | undefined;
      if (wantName) {
        chosen = parsedRows.find(
          (r) =>
            r.name.toLowerCase() === wantName ||
            r.name.toLowerCase().includes(wantName) ||
            wantName.includes(r.name.toLowerCase()),
        );
      } else if (selectTarget.targetType) {
        chosen =
          parsedRows.find((r) => !r.active && r.identityType === selectTarget.targetType) ??
          parsedRows.find((r) => r.identityType === selectTarget.targetType);
      } else {
        chosen = parsedRows.find((r) => !r.active);
      }

      if (chosen) {
        if (chosen.active) {
          switchedTo = chosen.name;
          await this.keyevent(serial, 4, signal).catch(() => null);
          await abortableWait(700, signal);
        } else {
          await this.tap900(serial, chosen.bounds.cx, chosen.bounds.cy, sw, sh, signal);
          await abortableWait(4000, signal);
          switchedTo = chosen.name;
        }
        return { identities, switchedTo };
      }
    }

    // Close bottom sheet cleanly
    await this.keyevent(serial, 4, signal).catch(() => null);
    await abortableWait(700, signal);
    return { identities, switchedTo: null };
  }

  /**
   * Opens the currently active Profile / Page from Menu card, taps the `...` overflow button,
   * copies "复制个人主页链接" / "复制公共主页链接", and resolves the real numeric Facebook ID.
   */
  private async extractActiveProfileNumericId(
    serial: string,
    cardBounds: RectBounds,
    sw: number,
    sh: number,
    signal?: AbortSignal,
  ): Promise<{ numericId: string | null; identityHint: BluestacksIdentityType }> {
    let identityHint: BluestacksIdentityType = 'unknown';
    try {
      // Tap left-center of the Menu profile card to open active Profile / Page
      await this.tap900(serial, 300, cardBounds.cy, sw, sh, signal);
      await abortableWait(2400, signal);

      const [profPng, profXml] = await Promise.all([
        this.screencap(serial, signal),
        this.dumpXml(serial, sw, sh, signal),
      ]);
      // Locate the `...` overflow button:
      // 1) Top-right Profile header bar (`[821, 36, 894, 120]` in FB Lite v488 & v524)
      // 2) Fallback: Profile CTA row (`y ≈ 440..1060`) on alternate layouts
      const allProfNodes = flattenLiteNodes(profXml);
      const topRightMore = allProfNodes
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.x1 >= 795 &&
            n.bounds.x2 <= 900 &&
            n.bounds.y1 >= 25 &&
            n.bounds.y2 <= 155 &&
            n.bounds.w >= 45 &&
            n.bounds.w <= 115 &&
            n.bounds.h >= 45 &&
            n.bounds.h <= 120,
        )
        .sort((a, b) => b.bounds.x1 - a.bounds.x1)[0];
      const ctaMore = allProfNodes
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.x1 >= 720 &&
            n.bounds.x2 <= 895 &&
            n.bounds.y1 >= 440 &&
            n.bounds.y2 <= 1060 &&
            n.bounds.w >= 48 &&
            n.bounds.w <= 150 &&
            n.bounds.h >= 40 &&
            n.bounds.h <= 105,
        )
        .sort((a, b) => a.bounds.y1 - b.bounds.y1)[0];
      const moreBtn = topRightMore ?? ctaMore;
      if (!moreBtn) {
        const profText = (
          await this.ocr.recognizeBounds(profPng, makeCanonicalRect(0, 420, 900, 960))
        ).replace(/\s+/g, '');
        if (
          /专业面板|专业模式面板|推广公共主页|公共主页状态|professionaldashboard|adcenter/i.test(
            profText,
          )
        ) {
          identityHint = 'page';
        }
        await this.keyevent(serial, 4, signal).catch(() => null);
        await abortableWait(700, signal);
        return { numericId: null, identityHint };
      }

      await this.tap900(serial, moreBtn.bounds.cx, moreBtn.bounds.cy, sw, sh, signal);
      await abortableWait(1800, signal);

      let [morePng, moreXml] = await Promise.all([
        this.screencap(serial, signal),
        this.dumpXml(serial, sw, sh, signal),
      ]);
      const fullMoreText = (
        await this.ocr.recognizeBounds(morePng, makeCanonicalRect(0, 100, 900, 1580))
      ).replace(/\s+/g, '');
      if (/复制公共主页链接|公共主页链接|copypagelink|yourpagelink/i.test(fullMoreText)) {
        identityHint = 'page';
      } else if (
        /复制个人主页链接|个人主页链接|copyprofilelink|yourprofilelink/i.test(fullMoreText)
      ) {
        identityHint = 'personal';
      }

      const findCopyRow = async (pngBuf: Buffer, rootNode: LiteXmlNode | null) => {
        const rows = flattenLiteNodes(rootNode)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.w >= 260 &&
              n.bounds.y1 >= 160 &&
              n.bounds.y2 <= 1600 &&
              n.bounds.h >= 40 &&
              n.bounds.h <= 140,
          )
          .sort((a, b) => b.bounds.y1 - a.bounds.y1);
        for (const row of rows) {
          const t = (await this.ocr.recognizeBounds(pngBuf, row.bounds)).replace(/\s+/g, '');
          if (/复制链接|复制个人主页链接|复制公共主页链接|copylink|copyprofile|copypage/i.test(t)) {
            return row;
          }
        }
        return null;
      };

      let copyBtn = await findCopyRow(morePng, moreXml);
      if (!copyBtn) {
        // Scroll down Profile Settings once in case "复制链接" is below fold
        await this.swipe900(serial, 450, 1280, 450, 420, 450, sw, sh, signal);
        await abortableWait(1200, signal);
        [morePng, moreXml] = await Promise.all([
          this.screencap(serial, signal),
          this.dumpXml(serial, sw, sh, signal),
        ]);
        const scrolledText = (
          await this.ocr.recognizeBounds(morePng, makeCanonicalRect(0, 100, 900, 1580))
        ).replace(/\s+/g, '');
        if (identityHint === 'unknown') {
          if (/复制公共主页链接|公共主页链接|copypagelink/i.test(scrolledText)) {
            identityHint = 'page';
          } else if (/复制个人主页链接|个人主页链接|copyprofilelink/i.test(scrolledText)) {
            identityHint = 'personal';
          }
        }
        copyBtn = await findCopyRow(morePng, moreXml);
      }

      let resolvedNumericId: string | null = null;
      if (copyBtn) {
        const rawUrl = await withClipboardLock(async () => {
          const prev = await getHostClipboard().catch(() => null);
          const marker = `__WB_PROF_${Date.now()}__`;
          try {
            await this.focusBySerial(serial);
            await setHostClipboard(marker).catch(() => null);
            await this.tap900(serial, copyBtn.bounds.cx, copyBtn.bounds.cy, sw, sh, signal);
            for (let poll = 0; poll < 3; poll++) {
              await abortableWait(480, signal);
              const clip = await getHostClipboard().catch(() => '');
              if (clip && clip !== marker && /^https?:\/\//i.test(clip)) {
                return clip;
              }
            }
            return null;
          } finally {
            if (prev !== null) await setHostClipboard(prev).catch(() => null);
          }
        });
        if (rawUrl) {
          const resolved = await resolveProfileShareUrl(rawUrl);
          resolvedNumericId = resolved.numericId;
        }
      }

      // Return cleanly to Menu / Home
      await this.keyevent(serial, 4, signal).catch(() => null);
      await abortableWait(650, signal);
      await this.keyevent(serial, 4, signal).catch(() => null);
      await abortableWait(650, signal);
      return { numericId: resolvedNumericId, identityHint };
    } catch {
      return { numericId: null, identityHint };
    }
  }

  async inspectAccount(
    instanceId: string,
    signal?: AbortSignal,
    options?: { expectedNameHint?: string },
  ): Promise<BluestacksInstance> {
    const { instances } = await this.discoverInstances();
    const inst = instances.find((p) => p.id === instanceId);
    if (!inst || !inst.online) {
      throw new Error('蓝蝶实例未在线，请先启动模拟器窗口');
    }

    await this.lockPortraitOrientation(inst.serial, signal);
    const liveSize = await this.readLiveScreenSize(
      inst.serial,
      inst.fbWidth,
      inst.fbHeight,
      true,
      signal,
    );
    if (!isBluestacksPortraitResolution(liveSize.width, liveSize.height)) {
      throw new Error(
        `模拟器为横屏 (${liveSize.width}×${liveSize.height})，请在蓝蝶设置改为竖屏分辨率（如 900×1600 或 720×1280）`,
      );
    }

    const [fbProbe, androidSdk] = await Promise.all([
      this.probeFbLiteInstalled(inst.serial, true, signal),
      this.readGuestSdkVersion(inst.serial, signal),
    ]);
    if (fbProbe === false) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: false,
        accountState: 'missing-app',
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
        androidSdk,
      });
      throw new Error('未安装 FB Lite');
    }
    if (fbProbe === null) {
      throw new Error('模拟器 ADB 暂未就绪，请稍后重试');
    }
    const fbLiteVersion = await this.readFbLiteVersion(inst.serial, signal);

    await this.openDeepLink(
      inst.serial,
      'https://www.facebook.com/',
      liveSize.width,
      liveSize.height,
      signal,
    );
    await abortableWait(2000, signal);

    let [homeXml, homePng] = await Promise.all([
      this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal),
      this.screencap(inst.serial, signal),
    ]);
    const dims = readPngDimensions(homePng);
    if (dims && dims.width > dims.height) {
      await this.lockPortraitOrientation(inst.serial, signal);
      await abortableWait(900, signal);
      [homeXml, homePng] = await Promise.all([
        this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal),
        this.screencap(inst.serial, signal),
      ]);
    }
    if (!homeXml || homeXml.packageName !== 'com.facebook.lite') {
      await abortableWait(1500, signal);
      [homeXml, homePng] = await Promise.all([
        this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal),
        this.screencap(inst.serial, signal),
      ]);
    }

    const abnormal = await this.detectAbnormalScreen(inst.serial, homeXml, homePng, signal);
    if (abnormal) {
      const savedAbnormal = await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: true,
        accountState: abnormal,
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
        androidSdk,
        fbLiteVersion,
      });
      if (abnormal === 'verification' || abnormal === 'restricted') {
        return savedAbnormal;
      }
      throw new Error('FB Lite 未登录账号');
    }
    if (!homeXml || homeXml.packageName !== 'com.facebook.lite') {
      throw new Error('FB Lite 页面加载未就绪，请稍后重试');
    }

    const homeTabs = detectHomeTabBar(homeXml);
    let identityType: BluestacksIdentityType = homeTabs?.identityHint ?? 'unknown';

    const findProfileCard = (root: LiteXmlNode | null) =>
      flattenLiteNodes(root).find(
        (n) =>
          n.clickable &&
          n.bounds.x1 <= 40 &&
          n.bounds.x2 >= 840 &&
          n.bounds.y1 >= 105 &&
          n.bounds.y1 <= 300 &&
          n.bounds.h >= 70 &&
          n.bounds.h <= 145,
      );
    const hasMenuGridTiles = (root: LiteXmlNode | null) =>
      flattenLiteNodes(root).filter(
        (n) =>
          n.clickable &&
          ((n.bounds.x1 <= 40 && n.bounds.x2 >= 420 && n.bounds.x2 <= 460) ||
            (n.bounds.x1 >= 440 && n.bounds.x1 <= 475 && n.bounds.x2 >= 855)) &&
          n.bounds.y1 >= 220 &&
          n.bounds.y2 <= 1320,
      ).length >= 2;

    let menuXml: LiteXmlNode | null = homeXml;
    let cardNode = hasMenuGridTiles(menuXml) ? findProfileCard(menuXml) : undefined;
    let lastTab = homeTabs?.tabs[homeTabs.tabs.length - 1] ?? null;

    for (let attempt = 0; attempt < 3 && (!cardNode || !hasMenuGridTiles(menuXml)); attempt++) {
      if (attempt === 0) {
        // v488 & standard layout: top-right Menu button (x=859, y=72)
        await this.tap900(inst.serial, 859, 72, liveSize.width, liveSize.height, signal);
      } else {
        // v524 A/B header layout places Profile at (859, 72) and Menu (☰) as the rightmost Home tab
        if (!detectHomeTabBar(menuXml)) {
          await this.keyevent(inst.serial, 4, signal).catch(() => null);
          await abortableWait(900, signal);
          const backXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
          const refreshedTabs = detectHomeTabBar(backXml);
          if (refreshedTabs?.tabs.length) {
            lastTab = refreshedTabs.tabs[refreshedTabs.tabs.length - 1] ?? lastTab;
          }
        }
        const tapX = lastTab?.cx ?? 825;
        const tapY = lastTab?.cy ?? 162;
        await this.tap900(inst.serial, tapX, tapY, liveSize.width, liveSize.height, signal);
      }
      await abortableWait(2200, signal);
      menuXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
      cardNode = findProfileCard(menuXml);
      if (!cardNode || !hasMenuGridTiles(menuXml)) {
        // Catch delayed server-pushed Checkpoint / Restricted screens right after skeleton Home Feed!
        const lateAbnormal = await this.detectAbnormalScreen(
          inst.serial,
          menuXml,
          undefined,
          signal,
        );
        if (lateAbnormal) {
          const savedLate = await this.repo.saveInspectionResult({
            id: inst.id,
            fbLiteInstalled: true,
            accountState: lateAbnormal,
            fbWidth: liveSize.width,
            fbHeight: liveSize.height,
            androidSdk,
            fbLiteVersion,
          });
          if (lateAbnormal === 'verification' || lateAbnormal === 'restricted') {
            return savedLate;
          }
          throw new Error('FB Lite 未登录账号');
        }
      }
    }

    if (!cardNode || !hasMenuGridTiles(menuXml)) {
      await abortableWait(1200, signal);
      const menuAbnormal = await this.detectAbnormalScreen(inst.serial, menuXml, undefined, signal);
      if (menuAbnormal) {
        const savedMenuAbnormal = await this.repo.saveInspectionResult({
          id: inst.id,
          fbLiteInstalled: true,
          accountState: menuAbnormal,
          fbWidth: liveSize.width,
          fbHeight: liveSize.height,
          androidSdk,
          fbLiteVersion,
        });
        if (menuAbnormal === 'verification' || menuAbnormal === 'restricted') {
          return savedMenuAbnormal;
        }
        throw new Error('FB Lite 未登录账号');
      }
      throw new Error('未能打开 FB Lite 账号菜单，请重试');
    }

    const png = await this.screencap(inst.serial, signal);
    const avatarBounds: RectBounds = {
      x1: 34,
      y1: cardNode.bounds.y1 + 12,
      x2: 94,
      y2: cardNode.bounds.y1 + 72,
      w: 60,
      h: 60,
      cx: 64,
      cy: cardNode.bounds.y1 + 42,
    };
    const nameX1 = liveSize.width < 800 ? 118 : 102;
    const nameY1 = cardNode.bounds.y1 + 6;
    const nameBounds: RectBounds = {
      x1: nameX1,
      y1: nameY1,
      x2: 680,
      y2: nameY1 + 48,
      w: 680 - nameX1,
      h: 48,
      cx: Math.round((nameX1 + 680) / 2),
      cy: nameY1 + 24,
    };
    const [avatarUrl, rawName, menuTilesText] = await Promise.all([
      cropToDataUrl(png, avatarBounds, 96),
      this.ocr.recognizeBounds(png, nameBounds),
      this.ocr.recognizeBounds(png, makeCanonicalRect(0, 240, 900, 760)),
    ]);

    const compactMenu = menuTilesText.replace(/\s+/g, '');
    if (identityType === 'unknown') {
      if (/专业面板|广告中心|metabusiness|professionaldashboard|adcenter/i.test(compactMenu)) {
        identityType = 'page';
      } else if (/好友|marketplace|friends/i.test(compactMenu)) {
        identityType = 'personal';
      }
    }

    const sanitizeCardName = (text: string): string =>
      text
        .replace(/[|_~`]/g, '')
        .replace(
          /(?:查\s*)?看\s*你\s*的\s*主\s*页|查\s*看\s*公\s*共\s*主\s*页|查\s*看\s*主\s*页|管\s*理\s*主\s*页|view\s*your\s*profile|view\s*page|manage\s*page/gi,
          '',
        )
        .replace(/^[:：·•.,\-_\s]+|[:：·•.,\-_\s]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    let cleanName = sanitizeCardName(rawName);
    if (!cleanName) {
      // Short 2-4 char Page names (e.g. "Thu") can fail tight crop OCR; retry full card text band
      const wideRaw = await this.ocr.recognizeBounds(
        png,
        makeCanonicalRect(nameX1, cardNode.bounds.y1, 740, cardNode.bounds.y2),
      );
      cleanName = sanitizeCardName(wideRaw);
    }
    if (
      cleanName &&
      /登录|登入|log\s*in|sign\s*in|密码|password|手机号|邮箱|创建新账号|create\s*new/i.test(
        cleanName,
      )
    ) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: true,
        accountState: 'logged-out',
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
        androidSdk,
        fbLiteVersion,
      });
      throw new Error('FB Lite 未登录账号');
    }

    const expectedHint = options?.expectedNameHint?.trim() || '';
    const preliminaryName = cleanName || expectedHint;

    // Discover managed switchable identities from chevron dropdown
    const { identities: managedIdentities } = await this.inspectOrSelectManagedIdentities(
      inst.serial,
      cardNode.bounds,
      preliminaryName,
      identityType,
      liveSize.width,
      liveSize.height,
      undefined,
      signal,
    ).catch(() => ({ identities: [], switchedTo: null }));

    const activeFromSheet = managedIdentities.find((m) => m.active)?.name?.trim() || '';
    const effectiveName =
      cleanName || expectedHint || activeFromSheet || inst.accountName || inst.displayName;

    // Extract real numeric Facebook User / Page ID via Profile -> "..." -> Copy Link
    const { numericId, identityHint: profIdentityHint } = await this.extractActiveProfileNumericId(
      inst.serial,
      cardNode.bounds,
      liveSize.width,
      liveSize.height,
      signal,
    ).catch(() => ({ numericId: null, identityHint: 'unknown' as BluestacksIdentityType }));
    if (profIdentityHint !== 'unknown') {
      identityType = profIdentityHint;
    }

    await this.keyevent(inst.serial, 4, signal).catch(() => null);

    const effectiveAccountId =
      numericId ||
      (effectiveName
        ? `${inst.displayName} (${effectiveName})`
        : inst.accountId || `${inst.displayName} (FB Lite)`);

    return await this.repo.saveInspectionResult({
      id: inst.id,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: effectiveAccountId,
      accountName: effectiveName,
      avatarUrl: avatarUrl ?? inst.avatarUrl,
      fbWidth: liveSize.width,
      fbHeight: liveSize.height,
      identityType,
      numericAccountId: numericId ?? undefined,
      managedIdentities,
      androidSdk,
      fbLiteVersion,
    });
  }

  /**
   * Switches active FB Lite identity between Personal Profile and managed Pages, then re-inspects
   * to confirm and persist the newly active identity, avatar, and real numeric ID.
   */
  async switchIdentity(
    instanceId: string,
    target: { targetName?: string; targetType?: 'personal' | 'page' },
    signal?: AbortSignal,
  ): Promise<BluestacksInstance> {
    const { instances } = await this.discoverInstances();
    const inst = instances.find((i) => i.id === instanceId);
    if (!inst || !inst.online) {
      throw new ProductError('BLUESTACKS_OFFLINE', '模拟器未在线，请先启动蓝蝶窗口', 400);
    }
    const liveSize = await this.readLiveScreenSize(
      inst.serial,
      inst.fbWidth,
      inst.fbHeight,
      false,
      signal,
    );
    await this.openDeepLink(
      inst.serial,
      'https://www.facebook.com/',
      liveSize.width,
      liveSize.height,
      signal,
    );
    await abortableWait(1800, signal);
    let cardNode: LiteXmlNode | undefined;
    let curXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
    let lastTab = detectHomeTabBar(curXml)?.tabs.at(-1) ?? null;
    for (let attempt = 0; attempt < 3 && !cardNode; attempt++) {
      if (attempt === 0) {
        await this.tap900(inst.serial, 859, 72, liveSize.width, liveSize.height, signal);
      } else {
        if (!detectHomeTabBar(curXml)) {
          await this.keyevent(inst.serial, 4, signal).catch(() => null);
          await abortableWait(900, signal);
          const backXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
          lastTab = detectHomeTabBar(backXml)?.tabs.at(-1) ?? lastTab;
        }
        await this.tap900(
          inst.serial,
          lastTab?.cx ?? 825,
          lastTab?.cy ?? 162,
          liveSize.width,
          liveSize.height,
          signal,
        );
      }
      await abortableWait(2000, signal);
      curXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
      cardNode = flattenLiteNodes(curXml).find(
        (n) =>
          n.clickable &&
          n.bounds.x1 <= 40 &&
          n.bounds.x2 >= 840 &&
          n.bounds.y1 >= 105 &&
          n.bounds.y1 <= 300 &&
          n.bounds.h >= 70 &&
          n.bounds.h <= 145,
      );
    }
    if (!cardNode) {
      throw new ProductError('BLUESTACKS_MENU_NOT_FOUND', '未能打开 FB Lite 身份切换菜单', 500);
    }

    const { switchedTo } = await this.inspectOrSelectManagedIdentities(
      inst.serial,
      cardNode.bounds,
      inst.accountName,
      inst.identityType ?? 'unknown',
      liveSize.width,
      liveSize.height,
      target,
      signal,
    );
    if (!switchedTo) {
      throw new ProductError(
        'BLUESTACKS_IDENTITY_NOT_FOUND',
        '未找到可切换的目标身份（可能该账号未管理公共主页或已处于目标身份）',
        404,
      );
    }
    await abortableWait(2500, signal);
    return await this.inspectAccount(instanceId, signal, { expectedNameHint: switchedTo });
  }

  /**
   * Automated FB Lite account login supporting special-character passwords (pure Android input),
   * existing-session policy (`skip` vs `clear-and-relogin`), saved-account switcher & pre-login prompts,
   * 2FA push-approval fallback ("试试其他方式" -> "身份验证应用"), RFC 6238 TOTP code entry,
   * checkpoint detection (never auto-resets password!), and post-login onboarding dismissal.
   * Credentials and TOTP secrets are strictly ephemeral and NEVER logged or stored.
   */
  async loginAccountDetailed(
    instanceId: string,
    credentials: {
      account: string;
      password: string;
      totpSecret?: string;
      saveLoginInfo?: boolean;
      ifAlreadyLoggedIn?: 'skip' | 'clear-and-relogin';
    },
    signal?: AbortSignal,
    onProgress?: (status: string) => void,
  ): Promise<{ instance: BluestacksInstance; skippedAlreadyLoggedIn: boolean }> {
    const { instances } = await this.discoverInstances();
    const inst = instances.find((i) => i.id === instanceId);
    if (!inst || !inst.online) {
      throw new ProductError('BLUESTACKS_OFFLINE', '模拟器未在线，请先启动蓝蝶窗口', 400);
    }
    await this.lockPortraitOrientation(inst.serial, signal);
    const liveSize = await this.readLiveScreenSize(
      inst.serial,
      inst.fbWidth,
      inst.fbHeight,
      true,
      signal,
    );
    if (!isBluestacksPortraitResolution(liveSize.width, liveSize.height)) {
      throw new ProductError(
        'BLUESTACKS_LANDSCAPE_UNSUPPORTED',
        `模拟器为横屏 (${liveSize.width}×${liveSize.height})，需先改为竖屏`,
        400,
      );
    }
    if ((await this.probeFbLiteInstalled(inst.serial, true, signal)) !== true) {
      throw new ProductError('BLUESTACKS_MISSING_APP', '未安装 FB Lite，请先一键安装 APK', 400);
    }

    const { serial } = inst;
    const { width: sw, height: sh } = liveSize;
    const existingPolicy = credentials.ifAlreadyLoggedIn ?? 'skip';

    const launchFbLiteFresh = async (clearData: boolean) => {
      await this.adb(
        serial,
        ['shell', 'am', 'force-stop', 'com.facebook.lite'],
        6000,
        signal,
      ).catch(() => null);
      if (clearData) {
        onProgress?.('正在清除旧 FB Lite 会话准备换号登录…');
        await this.adb(serial, ['shell', 'pm', 'clear', 'com.facebook.lite'], 8000, signal).catch(
          () => null,
        );
        for (const perm of [
          'android.permission.READ_EXTERNAL_STORAGE',
          'android.permission.WRITE_EXTERNAL_STORAGE',
          'android.permission.READ_MEDIA_IMAGES',
          'android.permission.READ_MEDIA_VIDEO',
        ]) {
          await this.adb(
            serial,
            ['shell', 'pm', 'grant', 'com.facebook.lite', perm],
            3000,
            signal,
          ).catch(() => null);
        }
      }
      await abortableWait(500, signal);
      await this.adb(
        serial,
        [
          'shell',
          'monkey',
          '-p',
          'com.facebook.lite',
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ],
        8000,
        signal,
      );
      await abortableWait(4500, signal);
    };

    onProgress?.('正在启动 FB Lite 进入登录界面…');
    await launchFbLiteFresh(false);

    let credSubmitted = false;
    let clearedExisting = false;
    let totpAttempts = 0;
    let saveInfoAttempts = 0;
    let postLoginIdleSteps = 0;

    for (let step = 0; step < 26; step++) {
      if (signal?.aborted) throw new Error('TASK_STOPPED');
      const [png, tree] = await Promise.all([
        this.screencap(serial, signal),
        this.dumpXml(serial, sw, sh, signal),
      ]);

      // Home tab bar visible! Distinguish "newly logged in" vs "already logged in before submit"
      if (detectHomeTabBar(tree)) {
        if (!credSubmitted) {
          if (existingPolicy === 'clear-and-relogin' && !clearedExisting) {
            clearedExisting = true;
            await launchFbLiteFresh(true);
            continue;
          }
          // Double-check screen is genuinely logged-in (not a verification/checkpoint bar that mimics tabs)
          const preCheckText = await this.ocr.recognizeBounds(
            png,
            makeCanonicalRect(0, 0, 900, 1600),
          );
          const preAbnormal = classifyAbnormalScreenText(preCheckText);
          if (preAbnormal === 'verification' || preAbnormal === 'restricted') {
            await this.repo.saveInspectionResult({
              id: inst.id,
              fbLiteInstalled: true,
              accountState: preAbnormal,
              fbWidth: sw,
              fbHeight: sh,
            });
            throw new ProductError(
              preAbnormal === 'restricted'
                ? 'BLUESTACKS_ACCOUNT_RESTRICTED'
                : 'BLUESTACKS_ACCOUNT_CHECKPOINT',
              preAbnormal === 'restricted'
                ? '原账号已被 Facebook 停用或封禁（如需换号请选择“覆盖重登”）'
                : '原账号触发 Facebook 安全验证 (Checkpoint)（如需换号请选择“覆盖重登”）',
              409,
            );
          }
          onProgress?.('检测到该实例已登录账号，按策略跳过并同步身份…');
          const existingInst = await this.inspectAccount(instanceId, signal);
          if (existingInst.accountState === 'logged-in') {
            return { instance: existingInst, skippedAlreadyLoggedIn: true };
          }
          if (existingInst.accountState === 'verification') {
            throw new ProductError(
              'BLUESTACKS_ACCOUNT_CHECKPOINT',
              '原账号触发 Facebook 安全验证 (Checkpoint)（如需换号请选择“覆盖重登”）',
              409,
            );
          }
          if (existingInst.accountState === 'restricted') {
            throw new ProductError(
              'BLUESTACKS_ACCOUNT_RESTRICTED',
              '原账号已被 Facebook 停用或封禁（如需换号请选择“覆盖重登”）',
              409,
            );
          }
          // Otherwise logged-out: proceed cleanly with login!
        } else {
          onProgress?.('登录成功，正在读取账号身份与头像…');
          await abortableWait(1200, signal);
          const loggedInInst = await this.inspectAccount(instanceId, signal);
          return { instance: loggedInInst, skippedAlreadyLoggedIn: false };
        }
      }

      const inputs = findAllTextInputNodes(tree);

      // Step A: Login form (2 inputs: email/phone + password)
      if (inputs.length >= 2 && !credSubmitted) {
        onProgress?.('正在输入账号与密码…');
        const emailInput = inputs[0];
        const passInput = inputs[1];
        if (emailInput && passInput) {
          await this.pasteIntoFocused(
            serial,
            emailInput.bounds.cx,
            emailInput.bounds.cy,
            credentials.account,
            sw,
            sh,
            signal,
          );
          await this.pasteIntoFocused(
            serial,
            passInput.bounds.cx,
            passInput.bounds.cy,
            credentials.password,
            sw,
            sh,
            signal,
          );
          credSubmitted = true;
          const [filledPng, filledTree] = await Promise.all([
            this.screencap(serial, signal),
            this.dumpXml(serial, sw, sh, signal),
          ]);
          const btnCands = flattenLiteNodes(filledTree)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 420 &&
                n.bounds.y1 > passInput.bounds.y2 &&
                n.bounds.h >= 38 &&
                n.bounds.h <= 125,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1);
          let loginBtn: LiteXmlNode | null = null;
          for (const c of btnCands) {
            if (await isSolidBlueButton(filledPng, c.bounds)) {
              loginBtn = c;
              break;
            }
          }
          onProgress?.('正在提交登录请求…');
          await this.tap900(
            serial,
            loginBtn?.bounds.cx ?? 450,
            loginBtn?.bounds.cy ?? passInput.bounds.y2 + 68,
            sw,
            sh,
            signal,
          );
          await abortableWait(7000, signal);
          continue;
        }
      }

      const rawFullText = await this.ocr.recognizeBounds(png, makeCanonicalRect(0, 0, 900, 1600));
      const compact = rawFullText.replace(/\s+/g, '');

      // Post-submit Home Feed OCR confirmation (handles transition frames where dumpsys still lags behind!)
      if (
        credSubmitted &&
        inputs.length === 0 &&
        /what'?sonyourmind|分享新鲜事|createstory|创建快拍/i.test(compact)
      ) {
        onProgress?.('登录成功，正在读取账号身份与头像…');
        await abortableWait(1200, signal);
        const loggedInInst = await this.inspectAccount(instanceId, signal);
        return { instance: loggedInInst, skippedAlreadyLoggedIn: false };
      }

      // Pre-login screens before 2-input form appears:
      // 1) Saved account one-tap chooser ("登录其他账户" / "Log into another account")
      // 2) Brand-new install language / permission / cookie consent dialogs
      if (!credSubmitted && inputs.length < 2) {
        const preBtns = flattenLiteNodes(tree)
          .filter((n) => n.clickable && n.bounds.w >= 90 && n.bounds.h >= 28 && n.bounds.h <= 150)
          .sort((a, b) => b.bounds.y1 - a.bounds.y1);
        let handledPre = false;
        if (/登录其他账|使用其他账|logintoanotheraccount|useanotheraccount/i.test(compact)) {
          for (const b of preBtns) {
            const t = (await this.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
            if (/登录其他账|使用其他账|logintoanotheraccount|useanotheraccount/i.test(t)) {
              onProgress?.('正在切换至账密登录表单…');
              await this.tap900(serial, b.bounds.cx, b.bounds.cy, sw, sh, signal);
              await abortableWait(2600, signal);
              handledPre = true;
              break;
            }
          }
        } else if (
          /允许facebooklite|allowfacebooklite|拨打和管理电话|访问您的通讯录/i.test(compact)
        ) {
          for (const b of preBtns) {
            const t = (await this.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
            if (/^拒绝$|^不允许$|^deny$|^don'tallow$|^允许$|^allow$/i.test(t)) {
              onProgress?.('正在处理系统权限弹窗…');
              await this.tap900(serial, b.bounds.cx, b.bounds.cy, sw, sh, signal);
              await abortableWait(2200, signal);
              handledPre = true;
              break;
            }
          }
        } else if (
          /选择语言|chooseyourlanguage|试用中文|接受所有cookie|acceptallcookies/i.test(compact)
        ) {
          for (const b of preBtns) {
            const t = (await this.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
            if (/中文\(简体\)|中文（简体）|继续|continue|接受|accept/i.test(t)) {
              onProgress?.('正在确认启动引导页…');
              await this.tap900(serial, b.bounds.cx, b.bounds.cy, sw, sh, signal);
              await abortableWait(2600, signal);
              handledPre = true;
              break;
            }
          }
        }
        if (handledPre) continue;
      }

      // Explicit failure: wrong password / account not found
      if (
        /密码有误|密码不正确|incorrectpassword|wrongpassword|找不到你的账户|couldn'tfindyouraccount|invalidusernameorpassword/i.test(
          compact,
        )
      ) {
        await this.repo.saveInspectionResult({
          id: inst.id,
          fbLiteInstalled: true,
          accountState: 'logged-out',
          fbWidth: sw,
          fbHeight: sh,
        });
        throw new ProductError(
          'BLUESTACKS_LOGIN_WRONG_CREDENTIALS',
          '账号或密码有误，登录失败',
          400,
        );
      }

      // Explicit security checkpoint / disabled account — STOP immediately, never touch password reset!
      const abnormal = classifyAbnormalScreenText(rawFullText);
      if (abnormal === 'verification' || abnormal === 'restricted') {
        if (!credSubmitted && existingPolicy === 'clear-and-relogin' && !clearedExisting) {
          clearedExisting = true;
          await launchFbLiteFresh(true);
          continue;
        }
        await this.repo.saveInspectionResult({
          id: inst.id,
          fbLiteInstalled: true,
          accountState: abnormal,
          fbWidth: sw,
          fbHeight: sh,
        });
        throw new ProductError(
          abnormal === 'restricted'
            ? 'BLUESTACKS_ACCOUNT_RESTRICTED'
            : 'BLUESTACKS_ACCOUNT_CHECKPOINT',
          abnormal === 'restricted'
            ? '账号已被 Facebook 停用或封禁'
            : '账号触发 Facebook 安全验证 (Checkpoint)，需人工核验',
          409,
        );
      }

      // Step B: 2FA push approval ("在另一台设备上查看通知" -> "试试其他方式") or method chooser ("身份验证应用")
      if (
        inputs.length === 0 &&
        /试试其他方式|尝试其他方式|tryanotherway|使用其他方式|选择身份验证方式|选择验证方式|查看通知|检查通知|待批准|身份验证应用|身份验证器|authenticationapp/i.test(
          compact,
        )
      ) {
        const btns = flattenLiteNodes(tree)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.w >= 220 &&
              n.bounds.y1 >= 200 &&
              n.bounds.h >= 40 &&
              n.bounds.h <= 260,
          )
          .sort((a, b) => a.bounds.y1 - b.bounds.y1);

        let pickedAuthApp = false;
        for (const b of btns) {
          const t = (await this.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
          if (/身份验证器|身份验证应用|authenticationapp|验证码生成器|验证码应用/i.test(t)) {
            onProgress?.('正在选择身份验证器 (2FA)…');
            await this.tap900(serial, b.bounds.cx, b.bounds.cy, sw, sh, signal);
            await abortableWait(1600, signal);
            pickedAuthApp = true;
            break;
          }
        }
        if (pickedAuthApp) {
          const [selPng, selTree] = await Promise.all([
            this.screencap(serial, signal),
            this.dumpXml(serial, sw, sh, signal),
          ]);
          const blueCands = flattenLiteNodes(selTree).filter(
            (n) => n.clickable && n.bounds.w >= 360 && n.bounds.h >= 42 && n.bounds.h <= 125,
          );
          for (const bb of blueCands) {
            if (await isSolidBlueButton(selPng, bb.bounds)) {
              await this.tap900(serial, bb.bounds.cx, bb.bounds.cy, sw, sh, signal);
              await abortableWait(5000, signal);
              break;
            }
          }
          continue;
        }

        let tappedOtherWay = false;
        for (const b of btns) {
          const t = (await this.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
          if (/试试其他方式|尝试其他方式|tryanotherway|使用其他方式/i.test(t)) {
            onProgress?.('正在切换为验证器验证码方式…');
            await this.tap900(serial, b.bounds.cx, b.bounds.cy, sw, sh, signal);
            await abortableWait(4200, signal);
            tappedOtherWay = true;
            break;
          }
        }
        if (tappedOtherWay) continue;
      }

      // Step C: 2FA 6-digit TOTP entry!
      if (
        inputs.length === 1 &&
        /验证|code|authenticator|双重|two-factor|安全码|6位数|验证码|身份验证/i.test(compact)
      ) {
        if (!credentials.totpSecret?.trim()) {
          throw new ProductError(
            'BLUESTACKS_2FA_SECRET_REQUIRED',
            '该账号已开启双重验证 (2FA)，请提供 2FA Base32 密钥',
            400,
          );
        }
        if (totpAttempts >= 2) {
          throw new ProductError(
            'BLUESTACKS_2FA_FAILED',
            '2FA 动态验证码校验未通过，请确认 2FA 密钥正确且系统时间准确',
            400,
          );
        }
        const codeInput = inputs[0];
        if (codeInput) {
          // Avoid submitting right across a 30s TOTP step boundary
          const secRem = 30 - (Math.floor(Date.now() / 1000) % 30);
          if (secRem <= 5) {
            await abortableWait((secRem + 1) * 1000, signal);
          }
          const totpCode = generateTotpCode(credentials.totpSecret);
          totpAttempts++;
          onProgress?.(`正在填入 2FA 动态验证码 (第 ${totpAttempts} 次)…`);
          await this.typeAsciiAt900(
            serial,
            codeInput.bounds.cx,
            codeInput.bounds.cy,
            totpCode,
            sw,
            sh,
            signal,
          );
          const [afterPng, afterTree] = await Promise.all([
            this.screencap(serial, signal),
            this.dumpXml(serial, sw, sh, signal),
          ]);
          const blueCands = flattenLiteNodes(afterTree)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 360 &&
                n.bounds.h >= 42 &&
                n.bounds.h <= 125 &&
                n.bounds.y1 > codeInput.bounds.y2,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1);
          let submitted = false;
          for (const bb of blueCands) {
            if (await isSolidBlueButton(afterPng, bb.bounds)) {
              await this.tap900(serial, bb.bounds.cx, bb.bounds.cy, sw, sh, signal);
              await abortableWait(6500, signal);
              submitted = true;
              break;
            }
          }
          if (!submitted) {
            await this.keyevent(serial, 66, signal);
            await abortableWait(6500, signal);
          }
          continue;
        }
      }

      // Step D: Post-login onboarding & interstitial dismissal!
      if (credSubmitted) {
        // Language prompt ("试用中文（简体）版") — prefer Simplified Chinese blue button so OCR & UI stay consistent
        if (/设置语言|试用中文|try中文/i.test(compact)) {
          const blueBtns = flattenLiteNodes(tree).filter(
            (n) => n.clickable && n.bounds.w >= 360 && n.bounds.y1 >= 1100 && n.bounds.h >= 42,
          );
          let tappedLang = false;
          for (const bb of blueBtns) {
            if (await isSolidBlueButton(png, bb.bounds)) {
              onProgress?.('正在确认语言设置…');
              await this.tap900(serial, bb.bounds.cx, bb.bounds.cy, sw, sh, signal);
              await abortableWait(4000, signal);
              tappedLang = true;
              break;
            }
          }
          if (tappedLang) continue;
        }

        // Save login info? ("保存登录信息？" / "Save your login info?") — locate real OCR button first,
        // then pixel-scan the solid blue Save pill (handles separate Android dialog windows on v524!),
        // and fallback to Back/Home deep-link if the interstitial still lingers.
        if (/保存登录信息|savelogininfo|saveyourlogininfo/i.test(compact)) {
          saveInfoAttempts++;
          onProgress?.('正在处理「保存登录信息」提示…');
          if (saveInfoAttempts >= 3) {
            await this.keyevent(serial, 4, signal).catch(() => null);
            await abortableWait(1200, signal);
            await this.openDeepLink(serial, 'https://www.facebook.com/', sw, sh, signal).catch(
              () => null,
            );
            await abortableWait(2500, signal);
            continue;
          }
          const saveCands = flattenLiteNodes(tree)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 120 &&
                n.bounds.y1 >= 800 &&
                n.bounds.h >= 34 &&
                n.bounds.h <= 140,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1);
          const wantSave = credentials.saveLoginInfo !== false;
          let tappedSaveChoice = false;
          for (const sc of saveCands) {
            const st = (await this.ocr.recognizeBounds(png, sc.bounds)).replace(/\s+/g, '');
            if (
              (wantSave && /^保存$|^save$|^确定$|^ok$/i.test(st)) ||
              (!wantSave && /^以后再说$|^notnow$|^跳过$|^skip$|^暂不$/i.test(st))
            ) {
              await this.tap900(serial, sc.bounds.cx, sc.bounds.cy, sw, sh, signal);
              await abortableWait(3500, signal);
              tappedSaveChoice = true;
              break;
            }
          }
          if (!tappedSaveChoice) {
            // Pixel-scan for v524 stacked solid-blue Save button (x=60..840, y=960..1500)
            let blueBandY: number | null = null;
            for (let y = 960; y <= 1480; y += 28) {
              if (await isSolidBlueButton(png, makeCanonicalRect(80, y, 820, y + 48))) {
                blueBandY = y + 24;
                break;
              }
            }
            if (blueBandY !== null) {
              const targetY = wantSave ? blueBandY : Math.min(1560, blueBandY + 100);
              await this.tap900(serial, 450, targetY, sw, sh, signal);
              await abortableWait(3500, signal);
            } else {
              const tapX = wantSave ? 670 : 230;
              await this.tap900(serial, tapX, 1565, sw, sh, signal);
              await abortableWait(3500, signal);
            }
          }
          continue;
        }

        // Add friends onboarding ("添加好友" / "可能认识") — scroll slightly if Skip is clipped at bottom
        if (/添加好友.*可能认识|addfriends.*peopleyoumayknow/i.test(compact)) {
          onProgress?.('正在跳过「添加好友」引导…');
          await this.tap900(serial, 450, 1585, sw, sh, signal);
          await abortableWait(2500, signal);
          const [fPng, fTree] = await Promise.all([
            this.screencap(serial, signal),
            this.dumpXml(serial, sw, sh, signal),
          ]);
          if (detectHomeTabBar(fTree)) continue;
          const skipBtns = flattenLiteNodes(fTree).filter(
            (n) => n.clickable && n.bounds.y1 >= 1350 && n.bounds.h >= 20 && n.bounds.h <= 120,
          );
          for (const sb of skipBtns) {
            const st = (await this.ocr.recognizeBounds(fPng, sb.bounds)).replace(/\s+/g, '');
            if (/跳过|skip|下一步|next/i.test(st)) {
              await this.tap900(serial, sb.bounds.cx, sb.bounds.cy, sw, sh, signal);
              await abortableWait(3000, signal);
              break;
            }
          }
          continue;
        }

        // Generic onboarding prompts: Contacts / Add Email / Add Phone / Add Photo / Notifications
        const allBtns = flattenLiteNodes(tree).filter(
          (n) => n.clickable && n.bounds.w >= 55 && n.bounds.h >= 22 && n.bounds.h <= 150,
        );
        const scored: Array<{ prio: number; y: number; node: LiteXmlNode; label: string }> = [];
        for (const b of allBtns) {
          const t = (await this.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
          if (/^跳过$|^skip$|^以后再说$|^notnow$|^不用了$|^拒绝$|^不允许$|^don'tallow$/i.test(t)) {
            scored.push({ prio: 1, y: b.bounds.y1, node: b, label: t });
          } else if (/^保存$|^save$|^确定$|^ok$|^允许$|^allow$|^完成$|^done$/i.test(t)) {
            scored.push({ prio: 2, y: b.bounds.y1, node: b, label: t });
          }
        }
        // Prefer priority 1 (Skip/Not now) and HIGHER y1 (foreground modal dialog beats background top-bar Skip!)
        scored.sort((a, b) => a.prio - b.prio || b.y - a.y);
        if (scored[0]) {
          postLoginIdleSteps = 0;
          onProgress?.(`正在跳过引导提示 (${scored[0].label})…`);
          await this.tap900(
            serial,
            scored[0].node.bounds.cx,
            scored[0].node.bounds.cy,
            sw,
            sh,
            signal,
          );
          await abortableWait(3500, signal);
          continue;
        }
        postLoginIdleSteps++;
        if (postLoginIdleSteps === 3 || postLoginIdleSteps === 6) {
          // If post-login onboarding lingers after auth succeeded, navigate directly to FB Home
          onProgress?.('正在跳转进入 FB Lite 首页…');
          await this.openDeepLink(serial, 'https://www.facebook.com/', sw, sh, signal).catch(
            () => null,
          );
          await abortableWait(2500, signal);
          continue;
        }
      }

      await abortableWait(3000, signal);
    }

    throw new ProductError(
      'BLUESTACKS_LOGIN_TIMEOUT',
      '自动登录流程超时，未能进入 FB Lite 首页（请点击“显示窗口”查看模拟器当前界面）',
      504,
    );
  }

  async loginAccount(
    instanceId: string,
    credentials: {
      account: string;
      password: string;
      totpSecret?: string;
      saveLoginInfo?: boolean;
      ifAlreadyLoggedIn?: 'skip' | 'clear-and-relogin';
    },
    signal?: AbortSignal,
    onProgress?: (status: string) => void,
  ): Promise<BluestacksInstance> {
    const res = await this.loginAccountDetailed(instanceId, credentials, signal, onProgress);
    return res.instance;
  }

  async ensureReadyAndLoggedIn(
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<BluestacksInstance> {
    const { instances } = await this.discoverInstances();
    const inst = instances.find((p) => p.id === instanceId);
    if (!inst || !inst.online) {
      throw new Error('跳过：蓝蝶实例未在线');
    }
    await this.lockPortraitOrientation(inst.serial, signal);
    const liveSize = await this.readLiveScreenSize(
      inst.serial,
      inst.fbWidth,
      inst.fbHeight,
      false,
      signal,
    );
    if (!isBluestacksPortraitResolution(liveSize.width, liveSize.height)) {
      throw new Error(
        `跳过：横屏分辨率 ${liveSize.width}×${liveSize.height}，请改为竖屏（如 900×1600 或 720×1280）`,
      );
    }
    const fbProbe = await this.probeFbLiteInstalled(inst.serial, true, signal);
    if (fbProbe === false) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: false,
        accountState: 'missing-app',
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
      });
      throw new Error('跳过：未安装 FB Lite');
    }
    if (fbProbe === null) {
      throw new Error('跳过：模拟器 ADB 暂未就绪');
    }
    if (inst.accountState === 'restricted') {
      throw new Error('跳过：账号已受限/停用');
    }
    if (inst.accountState === 'verification') {
      throw new Error('跳过：账号需安全验证 (Checkpoint)');
    }
    if (
      inst.accountState !== 'logged-in' ||
      !inst.accountName ||
      inst.accountName === inst.displayName
    ) {
      const inspected = await this.inspectAccount(inst.id, signal);
      if (inspected.accountState === 'restricted') {
        throw new Error('跳过：账号已受限/停用');
      }
      if (inspected.accountState === 'verification') {
        throw new Error('跳过：账号需安全验证 (Checkpoint)');
      }
      if (inspected.accountState !== 'logged-in') {
        throw new Error('跳过：FB Lite 未登录账号');
      }
      return inspected;
    }
    return {
      ...inst,
      fbWidth: liveSize.width,
      fbHeight: liveSize.height,
    };
  }
}
