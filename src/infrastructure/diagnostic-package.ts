import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { TaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import { mapAsync } from '../shared/async-collections.js';
import { profileDisplayName } from '../shared/contracts.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { Core } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { WorkspaceService } from '../application/workspace-service.js';
import type { TaskService } from '../application/task-service.js';
import type { GroupInviterService } from '../application/group-inviter-service.js';
import type { GroupBumperService } from '../application/group-bumper-service.js';
import type { GroupPosterService } from '../application/group-poster-service.js';
import type { BluestacksService } from '../application/bluestacks-service.js';
import type { WindowLayoutService } from '../application/window-layout.js';
import type { AutoSchedulerService } from '../application/auto-scheduler-service.js';
import type { GoogleSheetsService } from '../application/google-sheets-service.js';
import type { PostBumpRecordsPort } from '../shared/post-bump-records.js';
type ZipEntryInput = { name: string; data: Buffer | string };
const pickFields = <T extends object>(src: T, keys: string): Record<string, unknown> => {
  const rec = src as Record<string, unknown>,
    out: Record<string, unknown> = {};
  for (const k of keys.split(' ')) if (k) out[k] = rec[k];
  return out;
};
const invalidPkg = (msg: string, code = 'DIAGNOSTIC_PACKAGE_INVALID', status = 400): never => {
  throw new ProductError(code, msg, status);
};
export function createZipArchive(entries: readonly ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [],
    centralParts: Buffer[] = [],
    now = new Date(),
    year = Math.max(1980, Math.min(2107, now.getFullYear())),
    dosTime =
      ((now.getHours() & 0x1f) << 11) |
      ((now.getMinutes() & 0x3f) << 5) |
      (Math.floor(now.getSeconds() / 2) & 0x1f),
    dosDate =
      (((year - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f),
    w16 = (b: Buffer, o: number, v: number) => b.writeUInt16LE(v, o),
    w32 = (b: Buffer, o: number, v: number) => b.writeUInt32LE(v, o);
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8'),
      rawBytes = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data,
      uncomp = rawBytes.length,
      method = uncomp > 0 ? 8 : 0,
      comp = uncomp > 0 ? deflateRawSync(rawBytes) : Buffer.alloc(0),
      compSize = comp.length,
      checksum = crc32(rawBytes) >>> 0,
      lh = Buffer.alloc(30 + nameBytes.length),
      ch = Buffer.alloc(46 + nameBytes.length),
      writeMeta = (b: Buffer, off: number) => {
        w16(b, off, 0x0800);
        w16(b, off + 2, method);
        w16(b, off + 4, dosTime);
        w16(b, off + 6, dosDate);
        w32(b, off + 8, checksum);
        w32(b, off + 12, compSize);
        w32(b, off + 16, uncomp);
        w16(b, off + 20, nameBytes.length);
      };
    w32(lh, 0, 0x04034b50);
    w16(lh, 4, 20);
    writeMeta(lh, 6);
    nameBytes.copy(lh, 30);
    localParts.push(lh, comp);
    w32(ch, 0, 0x02014b50);
    w16(ch, 4, 20);
    w16(ch, 6, 20);
    writeMeta(ch, 8);
    w32(ch, 42, offset);
    nameBytes.copy(ch, 46);
    centralParts.push(ch);
    offset += lh.length + compSize;
  }
  const cd = Buffer.concat(centralParts),
    eocd = Buffer.alloc(22);
  w32(eocd, 0, 0x06054b50);
  w16(eocd, 8, entries.length);
  w16(eocd, 10, entries.length);
  w32(eocd, 12, cd.length);
  w32(eocd, 16, offset);
  return Buffer.concat([...localParts, cd, eocd]);
}
function formatLocalTimestamp(date: Date): { fileStamp: string; readable: string } {
  const p = (n: number, len = 2) => String(n).padStart(len, '0'),
    ymd = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`,
    y = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    hms = `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`,
    t = `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
  return { fileStamp: `${ymd}-${hms}`, readable: `${y} ${t}` };
}
async function readTailBuffer(
  filePath: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; fullFileSize: number } | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    if (info.size <= maxBytes) return { buffer: await readFile(filePath), fullFileSize: info.size };
    const handle = await open(filePath, 'r');
    try {
      const start = Math.max(0, info.size - maxBytes),
        length = info.size - start,
        chunk = Buffer.alloc(length),
        { bytesRead } = await handle.read(chunk, 0, length, start),
        slice = chunk.subarray(0, bytesRead),
        nl = slice.indexOf(0x0a),
        aligned = nl >= 0 && nl + 1 < slice.length ? slice.subarray(nl + 1) : slice;
      return { buffer: Buffer.from(aligned), fullFileSize: info.size };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
async function collectRecentRuntimeLogs(logsDir: string, maxDays = 3): Promise<Buffer> {
  try {
    const runtimeFiles = (await readdir(logsDir))
      .filter((n) => /^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(n))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, maxDays)
      .reverse();
    if (!runtimeFiles.length) return Buffer.alloc(0);
    const buffers: Buffer[] = [];
    for (const file of runtimeFiles) {
      try {
        const content = await readFile(path.join(logsDir, file));
        if (content.length > 0) {
          buffers.push(content);
          if (content[content.length - 1] !== 0x0a) buffers.push(Buffer.from('\n', 'utf8'));
        }
      } catch {}
    }
    return Buffer.concat(buffers);
  } catch {
    return Buffer.alloc(0);
  }
}
async function listZipPackagesDesc(dir: string) {
  const items: { name: string; fullPath: string; mtimeMs: number }[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.zip'))) {
    const fullPath = path.join(dir, name),
      info = await stat(fullPath).catch(() => null);
    if (info?.isFile()) items.push({ name, fullPath, mtimeMs: info.mtimeMs });
  }
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}
const generatedCustomDiagnosticDirs = new Set<string>();
const generatedCustomDiagnosticFiles = new Set<string>();
const normalizeCmpPath = (p: string) =>
  process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
function isWithinResolvedDir(candidate: string, allowedDir: string): boolean {
  const base = normalizeCmpPath(allowedDir),
    target = normalizeCmpPath(candidate);
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
function assertSafeDir(dir: string | undefined): string {
  const clean = dir?.trim() || '';
  if (clean && (!path.isAbsolute(clean) || clean.includes('..')))
    invalidPkg('无效的反馈包保存目录');
  return clean;
}
export async function revealDiagnosticPackage(
  dataDir: string,
  fileName?: string,
  targetDir?: string,
): Promise<{ filePath: string; fileName: string }> {
  const defaultFeedbackDir = path.resolve(dataDir, 'logs', 'feedback'),
    requestedDir = assertSafeDir(targetDir),
    resolvedRequestedDir = requestedDir ? path.resolve(requestedDir) : '';
  if (
    resolvedRequestedDir &&
    !isWithinResolvedDir(resolvedRequestedDir, defaultFeedbackDir) &&
    normalizeCmpPath(resolvedRequestedDir) !== normalizeCmpPath(defaultFeedbackDir) &&
    !generatedCustomDiagnosticDirs.has(normalizeCmpPath(resolvedRequestedDir))
  )
    invalidPkg('反馈包目录超出允许范围');
  const feedbackDir = resolvedRequestedDir || defaultFeedbackDir;
  let targetName = fileName?.trim() || '',
    zipPath = '';
  if (targetName && path.isAbsolute(targetName)) {
    const resolvedTarget = path.resolve(targetName),
      inAllowedDir =
        isWithinResolvedDir(resolvedTarget, defaultFeedbackDir) ||
        (resolvedRequestedDir
          ? isWithinResolvedDir(resolvedTarget, resolvedRequestedDir) &&
            generatedCustomDiagnosticFiles.has(normalizeCmpPath(resolvedTarget))
          : generatedCustomDiagnosticFiles.has(normalizeCmpPath(resolvedTarget)));
    if (
      targetName.includes('..') ||
      !resolvedTarget.toLowerCase().endsWith('.zip') ||
      !inAllowedDir
    )
      invalidPkg('无效的反馈包文件路径');
    zipPath = resolvedTarget;
    targetName = path.basename(resolvedTarget);
  } else {
    if (targetName) {
      if (
        path.basename(targetName) !== targetName ||
        targetName.includes('..') ||
        !targetName.toLowerCase().endsWith('.zip')
      )
        invalidPkg('无效的反馈包文件名');
    } else
      targetName = await listZipPackagesDesc(feedbackDir).then(
        (items) => items[0]?.name ?? '',
        () => '',
      );
    if (!targetName) invalidPkg('未找到已生成的诊断反馈包', 'DIAGNOSTIC_PACKAGE_NOT_FOUND', 404);
    zipPath = path.resolve(feedbackDir, targetName);
    if (
      !isWithinResolvedDir(zipPath, feedbackDir) ||
      (!isWithinResolvedDir(zipPath, defaultFeedbackDir) &&
        !generatedCustomDiagnosticFiles.has(normalizeCmpPath(zipPath)))
    )
      invalidPkg('反馈包路径超出允许范围');
  }
  if (!(await stat(zipPath).catch(() => null))?.isFile())
    invalidPkg('反馈包文件不存在或已被清理', 'DIAGNOSTIC_PACKAGE_NOT_FOUND', 404);
  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'REVEAL_DIAGNOSTIC_PACKAGE', filePath: zipPath });
    return { filePath: zipPath, fileName: targetName };
  }
  if (
    process.platform === 'win32' &&
    !process.env.NODE_TEST_CONTEXT &&
    process.env.WORKBENCH_DISABLE_EXPLORER_REVEAL !== '1'
  ) {
    try {
      const c = spawn('explorer.exe', [`/select,${zipPath}`], { detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      c.unref();
    } catch {}
  }
  return { filePath: zipPath, fileName: targetName };
}
export interface DiagnosticPackageResult {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  entryId: number;
  at: string;
}
export function createDiagnosticSnapshotBuilder(deps: {
  dataDir: string;
  softwareVersion: string;
  extensionVersion: string;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  groupInviterService: GroupInviterService;
  getGroupBumperService: () => GroupBumperService | undefined;
  groupPosterService: GroupPosterService;
  getBluestacksService?: (() => BluestacksService | undefined) | undefined;
  getWindowLayout?: (() => WindowLayoutService | undefined) | undefined;
  getAutoSchedulerService?: (() => AutoSchedulerService | undefined) | undefined;
  getGoogleSheetsService?: (() => GoogleSheetsService | undefined) | undefined;
  postBumpRecords?: PostBumpRecordsPort | undefined;
  tasksRepository: TaskRepository;
  core: Core;
  getMainKernel: () => KernelBridge | undefined;
  controllerLoopDelay: { count: number; max: number; percentile(p: number): number };
  devDiagFlush: () => Promise<void>;
  devDiagFilePath: string;
}) {
  return async (diagInput?: {
    note?: string;
    uiContext?: string;
    targetDir?: string;
    reveal?: boolean;
  }): Promise<DiagnosticPackageResult> => {
    const { note, uiContext, targetDir, reveal } = diagInput ?? {},
      groupBumperService = deps.getGroupBumperService(),
      bluestacksService = deps.getBluestacksService?.(),
      windowLayoutService = deps.getWindowLayout?.(),
      autoSchedulerService = deps.getAutoSchedulerService?.(),
      googleSheetsService = deps.getGoogleSheetsService?.(),
      mainKernel = deps.getMainKernel(),
      safe = <T>(p: Promise<T> | undefined, fb: T): Promise<T> =>
        p ? p.catch(() => fb) : Promise.resolve(fb);
    const [
      wsSnapshot,
      runtime,
      inviterState,
      inviterLogs,
      posterState,
      posterLogs,
      bumperState,
      bumperLogs,
      bsState,
      recentRecords,
      windowLayoutSnapshot,
      autoSchedulerState,
      googleSheetsOverview,
    ] = await Promise.all([
      deps.workspaceService.snapshot(),
      deps.taskService.runtimeOverview(),
      deps.groupInviterService.state(),
      deps.groupInviterService.logs('', undefined, 300),
      deps.groupPosterService.state(),
      deps.groupPosterService.logs('', undefined, undefined),
      groupBumperService ? groupBumperService.state() : Promise.resolve(null),
      groupBumperService
        ? groupBumperService.logs('', undefined, undefined, 300)
        : Promise.resolve([]),
      safe(bluestacksService?.state(false), null),
      deps.postBumpRecords
        ? safe(Promise.resolve(deps.postBumpRecords.list({ limit: 100 })), null)
        : Promise.resolve(null),
      safe(windowLayoutService?.snapshot(), null),
      safe(autoSchedulerService?.state(), null),
      safe(googleSheetsService?.overview(), null),
    ]);
    const pickRun = (r: NonNullable<typeof autoSchedulerState>['activeRuns'][number]) =>
      pickFields(
        r,
        'id scheduleId scheduleName carrier status statusReason totalTargets completedCount softIssueCount hardBlockedCount startedAt finishedAt',
      );
    const sanitizedAutoScheduler = autoSchedulerState
      ? {
          ...pickFields(
            autoSchedulerState,
            'settings running powerLockMode activeBrowserWorkers queuedBrowserTargets activeBluestacksWorkers queuedBluestacksTargets',
          ),
          scheduleCount: autoSchedulerState.schedules.length,
          enabledScheduleCount: autoSchedulerState.schedules.filter((s) => s.enabled).length,
          activeRuns: autoSchedulerState.activeRuns.map(pickRun),
          recentRuns: autoSchedulerState.recentRuns.slice(0, 10).map(pickRun),
        }
      : null;
    const sanitizedGoogleSheets = googleSheetsOverview
      ? {
          auth: {
            ...pickFields(
              googleSheetsOverview.auth,
              'hasCredentials clientIdHint authorized scopes pendingAuthStartedAt lastError',
            ),
            hasPendingAuth: Boolean(googleSheetsOverview.auth.pendingAuthUrl),
          },
          imageHost: pickFields(
            googleSheetsOverview.imageHost,
            'preferredHost hasGyazoToken gyazoTokenCount gyazoTokenPreviews driveFolderId defaultMachineName cachedImageCount',
          ),
          ...pickFields(
            googleSheetsOverview,
            'runningScheduleCount runningRecordsCount activeProfiles',
          ),
          links: googleSheetsOverview.links.map((l) => ({
            ...pickFields(
              l,
              'id kind title spreadsheetId sheetId sheetName enabled scheduleConfig runtime',
            ),
            recordsConfig: l.recordsConfig
              ? { ...l.recordsConfig, commentPool: `[${l.recordsConfig.commentPool.length}]` }
              : undefined,
          })),
          logs: googleSheetsOverview.logs.slice(0, 30),
        }
      : null;
    const sanitizedBluestacks = bsState
      ? {
          ...pickFields(
            bsState,
            'running pageBumperRunning activeRunning posterRunning inviterRunning statusText pageBumperStatusText activeStatusText posterStatusText inviterStatusText bumperSettings pageBumperSettings riskLimitSettings dailyUsage total pageTotal profileCounts pageBumperProfileCounts activeProfileCounts posterProfileCounts inviterProfileCounts',
          ),
          instances: bsState.instances.map((i) =>
            pickFields(
              i,
              'id instanceKey displayName alias online fbWidth fbHeight fbLiteInstalled accountState accountId accountName identityType lastStatus',
            ),
          ),
        }
      : null;
    const activePlans = await mapAsync(runtime.plans.slice(-16), async (plan) => {
      const activeStep = await deps.tasksRepository.currentStepForPlan?.(
          plan.id,
          plan.round,
          plan.position,
        ),
        matched = wsSnapshot.profiles.find((p) => p.id === plan.profileId);
      return {
        ...pickFields(plan, 'id profileId state reason round position'),
        profileName: profileDisplayName(matched, plan.profileId.slice(0, 8)),
        combinationName: plan.snapshot.name,
        activeStep: activeStep
          ? {
              id: activeStep.id,
              type: activeStep.spec.type,
              status: activeStep.status,
              progress: activeStep.progress,
            }
          : null,
        recentOps: [],
      };
    });
    const profileSummaries = wsSnapshot.profiles.map((p) => {
      const peer = deps.core.peers.get(p.id);
      return {
        id: p.id,
        name: profileDisplayName(p),
        alias: p.alias ?? '',
        browserName: p.browserName ?? '',
        online: p.online,
        phase: p.phase,
        synced: p.synced,
        unresolved: p.unresolved,
        extensionVersion: peer?.extensionVersion ?? null,
        accountState: p.account.state,
        accountId: p.account.id ?? null,
        accountName: p.account.name ?? null,
        profileWindowFocused: peer?.profileWindowFocused ?? null,
        focusedWindowAt: peer?.focusedWindowAt ?? null,
        presentationRecoverySupported:
          peer?.capabilities?.includes('task-presentation-recovery-v1') ?? false,
        kernelTraceTail: mainKernel ? mainKernel.diagnostics(p.id).slice(-50) : [],
      };
    });
    const loopDelaySummary = {
      resolutionMs: 20,
      samples: deps.controllerLoopDelay.count,
      maxSampleIntervalMs: deps.controllerLoopDelay.count
        ? deps.controllerLoopDelay.max / 1e6
        : null,
      p99SampleIntervalMs: deps.controllerLoopDelay.count
        ? deps.controllerLoopDelay.percentile(99) / 1e6
        : null,
    };
    const entry = devDiag.emit('SNAPSHOT', 'SNAPSHOT', 'USER_MANUAL_SNAPSHOT', {
      reason: note?.trim() || uiContext?.trim() || 'USER_CLICKED_SNAPSHOT_BUTTON',
      data: {
        softwareVersion: deps.softwareVersion,
        uiContext: uiContext?.trim() || '',
        controllerLoopDelay: loopDelaySummary,
        controllerMemory: process.memoryUsage(),
        settings: runtime.settings,
        profiles: profileSummaries,
        plans: activePlans,
        plansTruncated: runtime.plans.length > activePlans.length,
        groupInviter: pickFields(inviterState, 'running runId statusText profileCounts'),
        groupBumper: bumperState
          ? pickFields(
              bumperState,
              'running pageBumperRunning statusText pageBumperStatusText profileCounts pageBumperProfileCounts',
            )
          : null,
        groupPoster: pickFields(posterState, 'running statusText profileCounts'),
        ...(sanitizedBluestacks ? { bluestacks: sanitizedBluestacks } : {}),
        ...(windowLayoutSnapshot ? { windowLayout: windowLayoutSnapshot } : {}),
        ...(sanitizedAutoScheduler ? { autoScheduler: sanitizedAutoScheduler } : {}),
        ...(sanitizedGoogleSheets ? { googleSheets: sanitizedGoogleSheets } : {}),
      },
    });
    const now = new Date(),
      { fileStamp, readable } = formatLocalTimestamp(now),
      feedbackDir = path.join(deps.dataDir, 'logs', 'feedback');
    await mkdir(feedbackDir, { recursive: true });
    const allPlans = [...(await deps.tasksRepository.list())].sort(
        (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
      ),
      ledgerPlans = await Promise.all(
        allPlans.slice(0, 30).map(async (plan) => {
          const [steps, events] = await Promise.all([
            deps.tasksRepository.steps(plan.id),
            deps.tasksRepository.events(plan.id),
          ]);
          return {
            plan: {
              ...pickFields(
                plan,
                'id batchId profileId combinationId version round position state reason controlMode controlRequestId createdAt updatedAt',
              ),
              combinationName: plan.snapshot.name,
            },
            steps,
            operations: [],
            events: events
              .slice(-120)
              .map((ev) => pickFields(ev, 'sequence type detail createdAt')),
            tabs: [],
          };
        }),
      );
    await deps.devDiagFlush();
    const mainDiag = await readTailBuffer(deps.devDiagFilePath, 8 * 1024 * 1024),
      zipEntries: ZipEntryInput[] = [
        {
          name: '1-snapshot.json',
          data: JSON.stringify(
            {
              userNote: note?.trim() || '',
              uiContext: uiContext?.trim() || '',
              generatedAt: now.toISOString(),
              localTime: readable,
              softwareVersion: deps.softwareVersion,
              extensionVersion: deps.extensionVersion,
              entryId: entry.id,
              system: {
                memoryUsage: process.memoryUsage(),
                uptimeSeconds: Math.round(process.uptime()),
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                totalmem: os.totalmem(),
                freemem: os.freemem(),
                controllerLoopDelay: loopDelaySummary,
              },
              profiles: profileSummaries,
              combinations: wsSnapshot.combinations.map((row) => ({
                ...pickFields(row, 'id version revision updatedAt'),
                saved: row.saved ? pickFields(row.saved, 'name note randomOrder loop steps') : null,
              })),
              groupInviter: { state: inviterState, logs: inviterLogs },
              groupBumper: bumperState ? { state: bumperState, logs: bumperLogs } : null,
              groupPoster: { state: posterState, logs: posterLogs.slice(0, 50) },
              bluestacks: sanitizedBluestacks,
              windowLayout: windowLayoutSnapshot,
              autoScheduler: sanitizedAutoScheduler,
              googleSheets: sanitizedGoogleSheets,
              recentPostBumpRecords: recentRecords
                ? { total: recentRecords.total, records: recentRecords.records }
                : null,
            },
            null,
            2,
          ),
        },
        {
          name: '2-task-ledger.json',
          data: JSON.stringify(
            {
              generatedAt: now.toISOString(),
              totalPlansInDatabase: allPlans.length,
              includedPlanCount: ledgerPlans.length,
              plans: ledgerPlans,
            },
            null,
            2,
          ),
        },
        { name: '3-dev-diagnostics.jsonl', data: mainDiag?.buffer ?? Buffer.alloc(0) },
      ];
    if ((mainDiag?.fullFileSize ?? 0) < 2 * 1024 * 1024) {
      const prevDiag = await readTailBuffer(
        path.join(path.dirname(deps.devDiagFilePath), 'dev-diagnostics.prev.jsonl'),
        4 * 1024 * 1024,
      );
      if (prevDiag && prevDiag.buffer.length > 0)
        zipEntries.push({ name: '3b-dev-diagnostics.prev.jsonl', data: prevDiag.buffer });
    }
    zipEntries.push({
      name: '4-runtime-logs.ndjson',
      data: await collectRecentRuntimeLogs(path.join(deps.dataDir, 'logs'), 3),
    });
    const zipBuffer = createZipArchive(zipEntries),
      basePrefix = `问题反馈-v${deps.softwareVersion}-${fileStamp}`,
      customTargetDir = assertSafeDir(targetDir),
      outputDir = customTargetDir || feedbackDir;
    if (customTargetDir) await mkdir(outputDir, { recursive: true });
    let fileName = `${basePrefix}.zip`,
      zipPath = path.join(outputDir, fileName),
      suffix = 2;
    while (await stat(zipPath).catch(() => null)) {
      fileName = `${basePrefix}-${suffix++}.zip`;
      zipPath = path.join(outputDir, fileName);
    }
    await writeFile(zipPath, zipBuffer);
    if (customTargetDir) {
      generatedCustomDiagnosticDirs.add(normalizeCmpPath(outputDir));
      generatedCustomDiagnosticFiles.add(normalizeCmpPath(zipPath));
    }
    for (const stale of (await listZipPackagesDesc(feedbackDir).catch(() => [])).slice(10))
      await unlink(stale.fullPath).catch(() => {});
    if (reveal !== false)
      await revealDiagnosticPackage(deps.dataDir, zipPath, customTargetDir || undefined);
    return {
      filePath: zipPath,
      fileName,
      sizeBytes: zipBuffer.length,
      entryId: entry.id,
      at: entry.at,
    };
  };
}
