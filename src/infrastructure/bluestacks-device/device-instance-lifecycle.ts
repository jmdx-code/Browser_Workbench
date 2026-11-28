import { existsSync, readFileSync } from 'node:fs';
import { ProductError } from '../../domain/workspace.js';
import type { BluestacksInstance, BluestacksRuntimeConfig } from '../../shared/bluestacks.js';
import type { DiscoveredInstanceRecord } from '../bluestacks-store.js';
import {
  arrangeBlueStacksWindows,
  closeBlueStacksPids,
  focusBlueStacksWindow,
  matchBlueStacksWindow,
  queryRunningBlueStacksWindows,
  type BlueStacksRunningWindow,
} from '../bluestacks-win32.js';
import {
  abortableWait,
  isTcpPortOpen,
  parseBluestacksConfContent,
  runProcess,
} from './runner-helpers.js';
import {
  type DeviceRuntimeContext,
  adb,
  hasFbLiteInstalled,
  lockPortraitOrientation,
  matchesInstanceSdk,
  probeFbLiteInstalled,
  readFbLiteVersion,
  readGuestSdkVersion,
  readLiveScreenSize,
  readRunningHdPlayerInstances,
  resolveRuntimeConfig,
  runSerializedPlayerSpawn,
} from './device-runtime-and-adb.js';
function matchWinForInstance(
  wins: readonly BlueStacksRunningWindow[],
  inst: Pick<BluestacksInstance, 'displayName' | 'instanceKey' | 'adbPort'>,
  sharedPort: boolean,
) {
  return matchBlueStacksWindow(wins, {
    displayName: inst.displayName,
    instanceKey: inst.instanceKey,
    adbPort: inst.adbPort,
    sharedPort,
  });
}
const hasSharedPort = async (ctx: DeviceRuntimeContext, adbPort: number) =>
  adbPort > 0 && (await ctx.repo.listInstances()).filter((i) => i.adbPort === adbPort).length > 1;
const errBs = (code: string, msg: string, status = 400) => new ProductError(code, msg, status);
async function requireSavedInstance(
  ctx: DeviceRuntimeContext,
  instanceId: string,
): Promise<BluestacksInstance> {
  const existing = await ctx.repo.getInstance(instanceId);
  if (!existing) throw errBs('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
  return existing;
}
export async function discoverInstances(
  ctx: DeviceRuntimeContext,
): Promise<{ instances: BluestacksInstance[]; config: BluestacksRuntimeConfig }> {
  const { config, adbPath, effectiveConfPath } = await resolveRuntimeConfig(ctx);
  let confEntries: ReturnType<typeof parseBluestacksConfContent> = [];
  if (effectiveConfPath) {
    try {
      confEntries = parseBluestacksConfContent(readFileSync(effectiveConfPath, 'utf8'));
    } catch {
      confEntries = [];
    }
  }
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
    ctx.onlineInstanceKeys = new Set();
    const instances =
      offlineItems.length > 0
        ? await ctx.repo.upsertDiscoveredInstances(offlineItems)
        : await ctx.repo.listInstances([]);
    return { instances, config };
  }
  const resolvedEntries = confEntries.map((entry) => ({
    ...entry,
    adbPort:
      entry.statusPort &&
      entry.statusPort > 0 &&
      (entry.statusPort !== 5555 || entry.configuredPort === 5555)
        ? entry.statusPort
        : entry.configuredPort,
  }));
  const candidatePorts = [...new Set(resolvedEntries.map((e) => e.adbPort).filter((p) => p > 0))];
  const portChecks = await Promise.all(
    candidatePorts.map(async (port) => ({ port, open: await isTcpPortOpen(port) })),
  );
  const openPorts = new Set(portChecks.filter((c) => c.open).map((c) => c.port));
  await Promise.all(
    [...openPorts].map((port) =>
      runProcess(adbPath, ['connect', `127.0.0.1:${port}`], { timeoutMs: 6000 }).catch(() => null),
    ),
  );
  const onlineSerials = new Set<string>();
  try {
    for (const line of (await runProcess(adbPath, ['devices'], { timeoutMs: 6000 }))
      .toString('utf8')
      .split(/\r?\n/)) {
      const m = /^(\S+)\s+device$/.exec(line.trim());
      if (m?.[1] && !m[1].startsWith('emulator-')) onlineSerials.add(m[1]);
    }
  } catch {}
  const portEntryCounts = new Map<number, number>();
  for (const e of resolvedEntries)
    portEntryCounts.set(e.adbPort, (portEntryCounts.get(e.adbPort) ?? 0) + 1);
  const installChecks = new Map<string, boolean | null>();
  const sizeChecks = new Map<string, { width: number; height: number }>();
  const sdkChecks = new Map<string, number | null>();
  const versionChecks = new Map<string, string | null>();
  await Promise.all(
    [...onlineSerials].map(async (serial) => {
      const confEntry = resolvedEntries.find((e) => `127.0.0.1:${e.adbPort}` === serial);
      const [installed, size, sdk] = await Promise.all([
        probeFbLiteInstalled(ctx, serial),
        readLiveScreenSize(ctx, serial, confEntry?.fbWidth ?? 900, confEntry?.fbHeight ?? 1600),
        readGuestSdkVersion(ctx, serial),
      ]);
      installChecks.set(serial, installed);
      sizeChecks.set(serial, size);
      sdkChecks.set(serial, sdk);
      versionChecks.set(serial, installed === true ? await readFbLiteVersion(ctx, serial) : null);
    }),
  );
  const sharedPortWinner = new Map<number, string>();
  const sharedOpenPorts = [...openPorts].filter((p) => (portEntryCounts.get(p) ?? 0) > 1);
  if (sharedOpenPorts.length > 0) {
    const [runningWins, runningProc] = await Promise.all([
      queryRunningBlueStacksWindows(),
      readRunningHdPlayerInstances(),
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
      const sdkFiltered = contenders.filter((e) => matchesInstanceSdk(e.instanceKey, liveSdk));
      const pool = sdkFiltered.length > 0 ? sdkFiltered : contenders;
      const winner =
        (liveSize
          ? pool.find((e) => e.fbWidth === liveSize.width && e.fbHeight === liveSize.height)
          : undefined) ?? pool[0];
      if (winner) sharedPortWinner.set(port, winner.instanceKey);
    }
  }
  const items: DiscoveredInstanceRecord[] = [];
  const onlineKeys = new Set<string>();
  for (const entry of resolvedEntries) {
    const serial = `127.0.0.1:${entry.adbPort}`;
    const isSharedPort = (portEntryCounts.get(entry.adbPort) ?? 0) > 1;
    const online =
      (!isSharedPort || sharedPortWinner.get(entry.adbPort) === entry.instanceKey) &&
      openPorts.has(entry.adbPort) &&
      onlineSerials.has(serial);
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
    const port = Number(/:(\d+)$/.exec(serial)?.[1] ?? 5555);
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
  ctx.onlineInstanceKeys = onlineKeys;
  const instances =
    items.length > 0
      ? await ctx.repo.upsertDiscoveredInstances(items)
      : await ctx.repo.listInstances([...onlineKeys]);
  return { instances, config };
}
export async function launchInstance(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  signal?: AbortSignal,
): Promise<BluestacksInstance> {
  const existing = await requireSavedInstance(ctx, instanceId);
  const { playerPath, adbPath, effectiveConfPath } = await resolveRuntimeConfig(ctx);
  if (!playerPath)
    throw errBs(
      'BLUESTACKS_PLAYER_NOT_FOUND',
      '未找到 HD-Player.exe，请在设置中指定 BlueStacks 安装目录',
    );
  if (!adbPath)
    throw errBs(
      'BLUESTACKS_ADB_NOT_FOUND',
      '未找到 HD-Adb.exe，请在设置中指定 BlueStacks 安装目录',
    );
  const safeKey = existing.instanceKey.replace(/[^A-Za-z0-9_.-]/g, ''),
    sharedPort = await hasSharedPort(ctx, existing.adbPort);
  const alreadyOpen = sharedPort
    ? Boolean(matchWinForInstance(await queryRunningBlueStacksWindows(), existing, true))
    : await isTcpPortOpen(existing.adbPort);
  let spawnMonitor = alreadyOpen
    ? null
    : await runSerializedPlayerSpawn(ctx, playerPath, safeKey, signal);
  const deadline = Date.now() + 90_000;
  let activePort = existing.adbPort;
  let respawnRetries = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('TASK_STOPPED');
    if (
      spawnMonitor &&
      spawnMonitor.exitedEarly() !== null &&
      respawnRetries < 2 &&
      !(await isTcpPortOpen(activePort))
    ) {
      respawnRetries++;
      await abortableWait(2200, signal);
      spawnMonitor = await runSerializedPlayerSpawn(ctx, playerPath, safeKey, signal);
    }
    if (effectiveConfPath && existsSync(effectiveConfPath)) {
      try {
        const match = parseBluestacksConfContent(readFileSync(effectiveConfPath, 'utf8')).find(
          (p) => p.instanceKey === existing.instanceKey,
        );
        if (match?.statusPort && (match.statusPort !== 5555 || match.configuredPort === 5555))
          activePort = match.statusPort;
      } catch {}
    }
    if (await isTcpPortOpen(activePort)) {
      const serial = `127.0.0.1:${activePort}`;
      try {
        if (sharedPort && activePort === existing.adbPort) {
          if (
            !matchWinForInstance(
              await queryRunningBlueStacksWindows(),
              { ...existing, adbPort: activePort },
              true,
            )
          ) {
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
          await lockPortraitOrientation(ctx, serial, signal);
          const refreshed = (await discoverInstances(ctx)).instances.find(
            (i) => i.id === instanceId,
          );
          if (refreshed?.online) return refreshed;
        }
      } catch {}
    }
    await abortableWait(1400, signal);
  }
  throw errBs(
    'BLUESTACKS_LAUNCH_TIMEOUT',
    `蓝蝶窗口 ${existing.displayName} 启动等待超时（90s），请检查多开器状态`,
    504,
  );
}
export async function closeInstance(ctx: DeviceRuntimeContext, instanceId: string): Promise<void> {
  const existing = await requireSavedInstance(ctx, instanceId),
    safeKey = existing.instanceKey.replace(/[^A-Za-z0-9_.-]/g, '');
  if (!safeKey) return;
  const [{ adbPath }, sharedPort, runningWins] = await Promise.all([
    resolveRuntimeConfig(ctx),
    hasSharedPort(ctx, existing.adbPort),
    queryRunningBlueStacksWindows(),
  ]);
  const matchedWin = matchWinForInstance(runningWins, existing, sharedPort);
  const ownsLivePort =
    (await isTcpPortOpen(existing.adbPort)) &&
    (!sharedPort || matchedWin !== null || ctx.onlineInstanceKeys.has(existing.instanceKey));
  if (process.platform === 'win32') {
    const closeTargets: Array<{ pid: number; hwnd?: string | undefined }> = [];
    if (matchedWin) closeTargets.push({ pid: matchedWin.pid, hwnd: matchedWin.hwnd });
    else {
      const runningProc = await readRunningHdPlayerInstances();
      for (const pid of runningProc.pidByKey.get(safeKey) ?? []) closeTargets.push({ pid });
      if (closeTargets.length === 0 && !sharedPort && existing.adbPort > 0) {
        const portWin = runningWins.find((w) => w.listeningPorts.includes(existing.adbPort));
        if (portWin) closeTargets.push({ pid: portWin.pid, hwnd: portWin.hwnd });
      }
    }
    if (closeTargets.length > 0) await closeBlueStacksPids(undefined, closeTargets);
  }
  if (adbPath && ownsLivePort)
    await runProcess(adbPath, ['disconnect', existing.serial], { timeoutMs: 1500 }).catch(
      () => null,
    );
  ctx.onlineInstanceKeys.delete(existing.instanceKey);
}
export async function showInstance(
  ctx: DeviceRuntimeContext,
  instanceId: string,
): Promise<boolean> {
  const existing = await requireSavedInstance(ctx, instanceId),
    matched = matchWinForInstance(
      await queryRunningBlueStacksWindows(),
      existing,
      await hasSharedPort(ctx, existing.adbPort),
    );
  if (!matched)
    throw errBs(
      'BLUESTACKS_WINDOW_NOT_FOUND',
      `未找到运行中的蓝蝶窗口 ${existing.displayName}，请先启动模拟器`,
      404,
    );
  return focusBlueStacksWindow(undefined, matched.hwnd, matched.pid);
}
export async function arrangeWindows(
  ctx: DeviceRuntimeContext,
  instanceIds?: readonly string[],
  options: {
    columns?: number;
    gap?: number;
    monitorBounds?: { left: number; top: number; width: number; height: number };
  } = {},
): Promise<number> {
  const allInstances = await ctx.repo.listInstances([...ctx.onlineInstanceKeys]);
  const targetInstances =
    instanceIds && instanceIds.length > 0
      ? allInstances.filter((i) => instanceIds.includes(i.id))
      : allInstances.filter((i) => i.online);
  const wins = await queryRunningBlueStacksWindows();
  const matchedItems: Array<{ hwnd: string; pid: number }> = [];
  const usedPids = new Set<number>();
  for (const inst of targetInstances) {
    const sharedPort = allInstances.filter((x) => x.adbPort === inst.adbPort).length > 1;
    const m = matchWinForInstance(wins, inst, sharedPort);
    if (m && !usedPids.has(m.pid)) {
      usedPids.add(m.pid);
      matchedItems.push({ hwnd: m.hwnd, pid: m.pid });
    }
  }
  if (matchedItems.length === 0) {
    return !instanceIds || instanceIds.length === 0
      ? arrangeBlueStacksWindows(
          undefined,
          wins.map((w) => ({ hwnd: w.hwnd, pid: w.pid })),
          options,
        )
      : 0;
  }
  return arrangeBlueStacksWindows(undefined, matchedItems, options);
}
export async function installFbLiteApk(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  explicitApkPath?: string,
  signal?: AbortSignal,
): Promise<BluestacksInstance> {
  const apkPath = explicitApkPath?.trim() || (await resolveRuntimeConfig(ctx)).effectiveApkPath;
  if (!apkPath || !existsSync(apkPath))
    throw errBs(
      'BLUESTACKS_APK_NOT_FOUND',
      '未找到 FB Lite APK 安装包，请在蓝蝶路径设置中指定 .apk 文件路径',
    );
  const inst = (await discoverInstances(ctx)).instances.find((i) => i.id === instanceId);
  if (!inst || !inst.online) throw errBs('BLUESTACKS_OFFLINE', '模拟器未在线，请先启动蓝蝶窗口');
  await adb(ctx, inst.serial, ['install', '-r', '-g', apkPath], 90_000, signal);
  ctx.litePackageCache.delete(inst.serial);
  if (!(await hasFbLiteInstalled(ctx, inst.serial, true, signal)))
    throw errBs('BLUESTACKS_APK_INSTALL_FAILED', 'FB Lite APK 安装后未检测到应用包', 500);
  return await ctx.repo.saveInspectionResult({
    id: inst.id,
    fbLiteInstalled: true,
    accountState: inst.accountState === 'missing-app' ? 'unknown' : inst.accountState,
    fbLiteVersion: await readFbLiteVersion(ctx, inst.serial, signal),
  });
}
