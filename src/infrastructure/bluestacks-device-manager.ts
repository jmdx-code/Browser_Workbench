import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import path from 'node:path';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  isBluestacksPortraitResolution,
  type BluestacksInstance,
  type BluestacksRuntimeConfig,
} from '../shared/bluestacks.js';
import type { BluestacksSavedSettings, DiscoveredInstanceRecord } from './bluestacks-store.js';
import {
  cropToDataUrl,
  flattenLiteNodes,
  isBottomSheetOpen,
  parseDumpsysTop,
  parseLiteXml,
  scalePointFrom900,
  type LiteXmlNode,
  type OcrRecognizer,
  type RectBounds,
} from './bluestacks-vision.js';

export interface BluestacksDeviceRepo {
  savedSettings(): BluestacksSavedSettings;
  listInstances(onlineKeys?: ReadonlyArray<string>): BluestacksInstance[];
  getInstance(id: string): BluestacksInstance | null;
  upsertDiscoveredInstances(items: ReadonlyArray<DiscoveredInstanceRecord>): BluestacksInstance[];
  saveInspectionResult(input: {
    id: string;
    fbLiteInstalled: boolean;
    accountState: 'unknown' | 'logged-in' | 'logged-out' | 'missing-app';
    accountId?: string;
    accountName?: string;
    avatarUrl?: string | null;
    fbWidth?: number;
    fbHeight?: number;
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

    const onAbort = () => {
      reason ??= 'TASK_STOPPED';
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      reason ??= 'TIMEOUT';
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, options.timeoutMs ?? 15000);

    const collect = (chunks: Buffer[], buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes > (options.maxBytes ?? 32 * 1024 * 1024)) {
        reason ??= 'OUTPUT_LIMIT';
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      } else {
        chunks.push(buffer);
      }
    };
    child.stdout?.on('data', (b: Buffer) => collect(out, b));
    child.stderr?.on('data', (b: Buffer) => collect(err, b));
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (reason) {
        reject(new Error(reason));
      } else if (code !== 0) {
        reject(new Error(`EXIT_${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
      } else {
        resolveResult(Buffer.concat(out));
      }
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

  async resolveRuntimeConfig(): Promise<{
    config: BluestacksRuntimeConfig;
    adbPath: string | null;
    playerPath: string | null;
    effectiveConfPath: string | null;
  }> {
    const saved = await this.repo.savedSettings();
    const reg = await this.detectRegistryPaths();

    const detectedInstallDir =
      reg.installDir ??
      COMMON_INSTALL_DIRS.find((dir) => existsSync(path.join(dir, 'HD-Adb.exe'))) ??
      null;
    const detectedConfPath =
      reg.confPath ?? COMMON_CONF_PATHS.find((file) => existsSync(file)) ?? null;

    const effectiveInstall = saved.installDir || detectedInstallDir;
    const effectiveConf = saved.confPath || detectedConfPath;

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
      },
      adbPath: adbReady ? adbCandidate : null,
      playerPath: playerReady ? playerCandidate : null,
      effectiveConfPath: effectiveConf && existsSync(effectiveConf) ? effectiveConf : null,
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

  async adb(
    serial: string,
    args: string[],
    timeoutMs = 15000,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const adbExe = await this.requireAdbPath();
    try {
      return await runProcess(adbExe, ['-s', serial, ...args], { timeoutMs, signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'TASK_STOPPED' || signal?.aborted) throw new Error('TASK_STOPPED');
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

  async hasFbLiteInstalled(serial: string, force = false, signal?: AbortSignal): Promise<boolean> {
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
      const installed = out.includes('package:com.facebook.lite');
      this.litePackageCache.set(serial, { installed, checkedAt: Date.now() });
      return installed;
    } catch {
      return false;
    }
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

    // Resolve effective ADB port per instance without relying on elevated HD-Player CommandLine
    // (BlueStacks HD-Player.exe often runs elevated, where WMI CommandLine returns empty string to standard processes).
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

    const installChecks = new Map<string, boolean>();
    const sizeChecks = new Map<string, { width: number; height: number }>();
    const sdkChecks = new Map<string, number | null>();
    await Promise.all(
      [...onlineSerials].map(async (serial) => {
        const portMatch = /:(\d+)$/.exec(serial);
        const port = portMatch?.[1] ? Number(portMatch[1]) : 0;
        const needsDisambiguation = (portEntryCounts.get(port) ?? 0) > 1;
        const [installed, size, sdk] = await Promise.all([
          this.hasFbLiteInstalled(serial),
          this.readLiveScreenSize(serial, 900, 1600),
          needsDisambiguation ? this.readGuestSdkVersion(serial) : Promise.resolve(null),
        ]);
        installChecks.set(serial, installed);
        sizeChecks.set(serial, size);
        sdkChecks.set(serial, sdk);
      }),
    );

    // Pick winning instanceKey for any shared open port using SDK version + configured screen size + readable CommandLine
    const sharedPortWinner = new Map<number, string>();
    const sharedOpenPorts = [...openPorts].filter((p) => (portEntryCounts.get(p) ?? 0) > 1);
    if (sharedOpenPorts.length > 0) {
      const runningProc = await this.readRunningHdPlayerInstances();
      for (const port of sharedOpenPorts) {
        const serial = `127.0.0.1:${port}`;
        if (!onlineSerials.has(serial)) continue;
        const contenders = resolvedEntries.filter((e) => e.adbPort === port);
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
        fbLiteInstalled: online ? (installChecks.get(serial) ?? false) : null,
      });
    }

    // Include any standalone connected 127.0.0.1:<port> device not listed in bluestacks.conf
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
    const alreadyOpen = await isTcpPortOpen(existing.adbPort);
    if (!alreadyOpen) {
      await new Promise<void>((resolveSpawn) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolveSpawn();
          }
        };
        try {
          const child = spawn(playerPath, ['--instance', safeKey], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
          child.once('error', () => {
            // Fallback to Start-Process ShellExecute when HD-Player.exe requires UAC elevation (740)
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
          });
          child.once('spawn', () => {
            child.unref();
            finish();
          });
        } catch {
          finish();
        }
      });
    }

    const deadline = Date.now() + 45000;
    let activePort = existing.adbPort;
    while (Date.now() < deadline) {
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
            await abortableWait(500, signal);
            const { instances } = await this.discoverInstances();
            const refreshed = instances.find((i) => i.id === instanceId);
            if (refreshed) return refreshed;
          }
        } catch {
          /* still booting */
        }
      }
      await abortableWait(1400, signal);
    }
    throw new ProductError(
      'BLUESTACKS_LAUNCH_TIMEOUT',
      `蓝蝶窗口 ${existing.displayName} 启动等待超时（45s），请检查多开器状态`,
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

    // 1. Graceful guest shutdown via ADB (works even when HD-Player.exe runs elevated)
    if (adbPath && (await isTcpPortOpen(existing.adbPort))) {
      await runProcess(adbPath, ['-s', existing.serial, 'shell', 'reboot', '-p'], {
        timeoutMs: 4000,
      }).catch(() => null);
    }

    // 2. Also signal window close / cleanup by owning TCP port PID + CommandLine match
    if (process.platform === 'win32') {
      const psCloseScript = `
$key = '${safeKey}'
$port = ${Number(existing.adbPort) || 0}
$pattern = '(?:^|\\s)--instance\\s+"?' + [regex]::Escape($key) + '"?(?:\\s|$)'
$cmdPids = @(Get-CimInstance Win32_Process -Filter "Name = 'HD-Player.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object { [int]$_.ProcessId })
$portPids = @()
if ($port -gt 0 -and $port -ne 5555) {
  $portPids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 })
}
$pids = @($cmdPids + $portPids | Select-Object -Unique)
foreach ($id in $pids) {
  try {
    $p = [System.Diagnostics.Process]::GetProcessById($id)
    if ($p.ProcessName -eq 'HD-Player') { $null = $p.CloseMainWindow() }
  } catch {}
}
if ($pids.Count -gt 0) {
  $deadline = (Get-Date).AddMilliseconds(3500)
  while ((Get-Date) -lt $deadline) {
    $alive = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  foreach ($id in $pids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}
`;
      await runProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCloseScript],
        { timeoutMs: 8000 },
      ).catch(() => null);
    }

    if (adbPath) {
      await runProcess(adbPath, ['disconnect', existing.serial], { timeoutMs: 4000 }).catch(
        () => null,
      );
    }
    this.onlineInstanceKeys.delete(existing.instanceKey);
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
        url,
      ],
      8000,
      signal,
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      await abortableWait(1100, signal);
      const xml = await this.dumpXml(serial, screenW, screenH, signal);
      if (xml && xml.packageName === 'com.facebook.lite' && flattenLiteNodes(xml).length >= 10) {
        return;
      }
    }
  }

  async pasteIntoFocused(
    serial: string,
    x900: number,
    y900: number,
    text: string,
    screenW = 900,
    screenH = 1600,
    signal?: AbortSignal,
  ): Promise<void> {
    await withClipboardLock(async () => {
      const previousClipboard = await getHostClipboard().catch(() => null);
      try {
        await setHostClipboard(text);
        await abortableWait(100, signal);
        await this.tap900(serial, x900, y900, screenW, screenH, signal);
        await abortableWait(250, signal);
        await this.keyevent(serial, 279, signal);
        await abortableWait(300, signal);
      } finally {
        if (previousClipboard !== null) {
          await setHostClipboard(previousClipboard).catch(() => null);
        }
      }
    });
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
      (n) =>
        (n.className.includes('EditText') || n.className.includes('MultiAutoCompleteTextView')) &&
        n.bounds.y1 >= 140 &&
        n.bounds.y2 <= 1180,
    );
    const hasHomeTabBar = all.some(
      (n) =>
        n.clickable &&
        n.bounds.y1 >= 90 &&
        n.bounds.y2 <= 180 &&
        n.bounds.w >= 135 &&
        n.bounds.w <= 165 &&
        n.bounds.x1 >= 735,
    );
    const hasTopMenuOrBack = all.some(
      (n) =>
        n.clickable &&
        n.bounds.y1 >= 30 &&
        n.bounds.y2 <= 112 &&
        ((n.bounds.x1 <= 15 && n.bounds.x2 <= 95) || (n.bounds.x1 >= 815 && n.bounds.x2 <= 900)),
    );
    const hasExplicitLoginText = all.some((n) => {
      const label = `${n.text} ${n.contentDesc}`.trim();
      return /登录|登入|log\s*in|sign\s*in|创建新账号|建立新帳號|create\s*new\s*account|手机号或邮箱/i.test(
        label,
      );
    });
    if (hasMidScreenInput && !hasHomeTabBar && !hasTopMenuOrBack) return true;
    if (hasExplicitLoginText && !hasHomeTabBar && !hasTopMenuOrBack) return true;
    return false;
  }

  async inspectAccount(instanceId: string, signal?: AbortSignal): Promise<BluestacksInstance> {
    const { instances } = await this.discoverInstances();
    const inst = instances.find((p) => p.id === instanceId);
    if (!inst || !inst.online) {
      throw new Error('蓝蝶实例未在线，请先启动模拟器窗口');
    }

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

    if (!(await this.hasFbLiteInstalled(inst.serial, true, signal))) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: false,
        accountState: 'missing-app',
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
      });
      throw new Error('未安装 FB Lite');
    }

    await this.openDeepLink(
      inst.serial,
      'https://www.facebook.com/me',
      liveSize.width,
      liveSize.height,
      signal,
    );
    await abortableWait(1800, signal);

    let homeXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
    if (!homeXml || homeXml.packageName !== 'com.facebook.lite') {
      await abortableWait(1500, signal);
      homeXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
    }
    if (this.isLoginOrLoggedOutXml(homeXml)) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: true,
        accountState: 'logged-out',
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
      });
      throw new Error('FB Lite 未登录账号');
    }
    if (!homeXml || homeXml.packageName !== 'com.facebook.lite') {
      throw new Error('FB Lite 页面加载未就绪，请稍后重试');
    }

    await this.tap900(inst.serial, 859, 66, liveSize.width, liveSize.height, signal);
    await abortableWait(1600, signal);

    const findProfileCard = (root: LiteXmlNode | null) =>
      flattenLiteNodes(root).find(
        (n) =>
          n.clickable &&
          n.bounds.x1 <= 30 &&
          n.bounds.x2 >= 860 &&
          n.bounds.y1 >= 120 &&
          n.bounds.y1 <= 155 &&
          n.bounds.h >= 75 &&
          n.bounds.h <= 115,
      );
    const hasMenuGridTiles = (root: LiteXmlNode | null) =>
      flattenLiteNodes(root).filter(
        (n) =>
          n.clickable &&
          ((n.bounds.x1 <= 30 && n.bounds.x2 >= 430 && n.bounds.x2 <= 455) ||
            (n.bounds.x1 >= 445 && n.bounds.x1 <= 470 && n.bounds.x2 >= 870)) &&
          n.bounds.y1 >= 240 &&
          n.bounds.y2 <= 960,
      ).length >= 2;

    let menuXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
    let cardNode = findProfileCard(menuXml);
    if (!cardNode || !hasMenuGridTiles(menuXml)) {
      await this.tap900(inst.serial, 859, 66, liveSize.width, liveSize.height, signal);
      await abortableWait(1600, signal);
      menuXml = await this.dumpXml(inst.serial, liveSize.width, liveSize.height, signal);
      cardNode = findProfileCard(menuXml);
    }

    if (!cardNode || !hasMenuGridTiles(menuXml)) {
      if (this.isLoginOrLoggedOutXml(menuXml)) {
        await this.repo.saveInspectionResult({
          id: inst.id,
          fbLiteInstalled: true,
          accountState: 'logged-out',
          fbWidth: liveSize.width,
          fbHeight: liveSize.height,
        });
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
    const nameY1 = cardNode.bounds.y1 + 6;
    const nameBounds: RectBounds = {
      x1: 96,
      y1: nameY1,
      x2: 520,
      y2: nameY1 + 43,
      w: 424,
      h: 43,
      cx: 308,
      cy: nameY1 + 21,
    };
    const [avatarUrl, rawName] = await Promise.all([
      cropToDataUrl(png, avatarBounds, 96),
      this.ocr.recognizeBounds(png, nameBounds),
    ]);

    await this.keyevent(inst.serial, 4, signal).catch(() => null);

    const cleanName = rawName
      .replace(/[|_~`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
      });
      throw new Error('FB Lite 未登录账号');
    }

    const effectiveName = cleanName || inst.accountName || inst.displayName;
    const effectiveAccountId = cleanName
      ? `${inst.displayName} (${cleanName})`
      : inst.accountId || `${inst.displayName} (FB Lite)`;

    return await this.repo.saveInspectionResult({
      id: inst.id,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: effectiveAccountId,
      accountName: effectiveName,
      avatarUrl: avatarUrl ?? inst.avatarUrl,
      fbWidth: liveSize.width,
      fbHeight: liveSize.height,
    });
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
    if (!(await this.hasFbLiteInstalled(inst.serial, true, signal))) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: false,
        accountState: 'missing-app',
        fbWidth: liveSize.width,
        fbHeight: liveSize.height,
      });
      throw new Error('跳过：未安装 FB Lite');
    }
    if (
      inst.accountState !== 'logged-in' ||
      !inst.accountName ||
      inst.accountName === inst.displayName
    ) {
      return await this.inspectAccount(inst.id, signal);
    }
    return {
      ...inst,
      fbWidth: liveSize.width,
      fbHeight: liveSize.height,
    };
  }
}
