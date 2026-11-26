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
import type { PostBumpRecordsPort } from '../shared/post-bump-records.js';
type ZipEntryInput = { name: string; data: Buffer | string };
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
      .filter((name) => /^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
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
function assertSafeDir(dir: string | undefined): string {
  const clean = dir?.trim() || '';
  if (clean && (!path.isAbsolute(clean) || clean.includes('..')))
    throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包保存目录', 400);
  return clean;
}
export async function revealDiagnosticPackage(
  dataDir: string,
  fileName?: string,
  targetDir?: string,
): Promise<{ filePath: string; fileName: string }> {
  const feedbackDir = assertSafeDir(targetDir) || path.join(dataDir, 'logs', 'feedback');
  let targetName = fileName?.trim() || '',
    zipPath = '';
  if (targetName && path.isAbsolute(targetName)) {
    if (targetName.includes('..') || !targetName.toLowerCase().endsWith('.zip'))
      throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包文件路径', 400);
    zipPath = targetName;
    targetName = path.basename(targetName);
  } else {
    if (targetName) {
      if (
        path.basename(targetName) !== targetName ||
        targetName.includes('..') ||
        !targetName.toLowerCase().endsWith('.zip')
      )
        throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包文件名', 400);
    } else
      targetName = await listZipPackagesDesc(feedbackDir).then(
        (items) => items[0]?.name ?? '',
        () => '',
      );
    if (!targetName)
      throw new ProductError('DIAGNOSTIC_PACKAGE_NOT_FOUND', '未找到已生成的诊断反馈包', 404);
    zipPath = path.join(feedbackDir, targetName);
  }
  if (!(await stat(zipPath).catch(() => null))?.isFile())
    throw new ProductError('DIAGNOSTIC_PACKAGE_NOT_FOUND', '反馈包文件不存在或已被清理', 404);
  if (process.parentPort)
    return (
      process.parentPort.postMessage({ type: 'REVEAL_DIAGNOSTIC_PACKAGE', filePath: zipPath }),
      { filePath: zipPath, fileName: targetName }
    );
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
      mainKernel = deps.getMainKernel(),
      [
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
        bluestacksService
          ? bluestacksService.state(false).catch(() => null)
          : Promise.resolve(null),
        deps.postBumpRecords
          ? Promise.resolve(deps.postBumpRecords.list({ limit: 100 })).catch(() => null)
          : Promise.resolve(null),
      ]),
      sanitizedBluestacks = bsState
        ? {
            running: bsState.running,
            pageBumperRunning: bsState.pageBumperRunning,
            activeRunning: bsState.activeRunning,
            posterRunning: bsState.posterRunning,
            inviterRunning: bsState.inviterRunning,
            statusText: bsState.statusText,
            pageBumperStatusText: bsState.pageBumperStatusText,
            activeStatusText: bsState.activeStatusText,
            posterStatusText: bsState.posterStatusText,
            inviterStatusText: bsState.inviterStatusText,
            bumperSettings: bsState.bumperSettings,
            pageBumperSettings: bsState.pageBumperSettings,
            riskLimitSettings: bsState.riskLimitSettings,
            dailyUsage: bsState.dailyUsage,
            total: bsState.total,
            pageTotal: bsState.pageTotal,
            profileCounts: bsState.profileCounts,
            pageBumperProfileCounts: bsState.pageBumperProfileCounts,
            activeProfileCounts: bsState.activeProfileCounts,
            posterProfileCounts: bsState.posterProfileCounts,
            inviterProfileCounts: bsState.inviterProfileCounts,
            instances: bsState.instances.map((i) => ({
              id: i.id,
              instanceKey: i.instanceKey,
              displayName: i.displayName,
              alias: i.alias,
              online: i.online,
              fbWidth: i.fbWidth,
              fbHeight: i.fbHeight,
              fbLiteInstalled: i.fbLiteInstalled,
              accountState: i.accountState,
              accountId: i.accountId,
              accountName: i.accountName,
              identityType: i.identityType,
              lastStatus: i.lastStatus,
            })),
          }
        : null,
      activePlans = await mapAsync(runtime.plans.slice(-16), async (plan) => {
        const [activeStep, rawOps] = await Promise.all([
            deps.tasksRepository.currentStepForPlan?.(plan.id, plan.round, plan.position),
            deps.tasksRepository.recentOperations
              ? deps.tasksRepository.recentOperations(plan.id, 6)
              : Promise.resolve([]),
          ]),
          matched = wsSnapshot.profiles.find((p) => p.id === plan.profileId);
        return {
          id: plan.id,
          profileId: plan.profileId,
          profileName: profileDisplayName(matched, plan.profileId.slice(0, 8)),
          combinationName: plan.snapshot.name,
          state: plan.state,
          reason: plan.reason,
          round: plan.round,
          position: plan.position,
          activeStep: activeStep
            ? {
                id: activeStep.id,
                type: activeStep.spec.type,
                status: activeStep.status,
                progress: activeStep.progress,
              }
            : null,
          recentOps: rawOps.map((op) => ({
            id: op.id,
            kind: op.action.kind,
            status: op.status,
            disposition: op.disposition ?? null,
            updatedAt: op.updatedAt,
          })),
        };
      }),
      profileSummaries = wsSnapshot.profiles.map((p) => {
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
      }),
      loopDelaySummary = {
        resolutionMs: 20,
        samples: deps.controllerLoopDelay.count,
        maxSampleIntervalMs: deps.controllerLoopDelay.count
          ? deps.controllerLoopDelay.max / 1e6
          : null,
        p99SampleIntervalMs: deps.controllerLoopDelay.count
          ? deps.controllerLoopDelay.percentile(99) / 1e6
          : null,
      },
      entry = devDiag.record({
        level: 'SNAPSHOT',
        category: 'SNAPSHOT',
        event: 'USER_MANUAL_SNAPSHOT',
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
          groupInviter: {
            running: inviterState.running,
            runId: inviterState.runId,
            statusText: inviterState.statusText,
            profileCounts: inviterState.profileCounts,
          },
          groupBumper: bumperState
            ? {
                running: bumperState.running,
                pageBumperRunning: bumperState.pageBumperRunning,
                statusText: bumperState.statusText,
                pageBumperStatusText: bumperState.pageBumperStatusText,
                profileCounts: bumperState.profileCounts,
                pageBumperProfileCounts: bumperState.pageBumperProfileCounts,
              }
            : null,
          groupPoster: {
            running: posterState.running,
            statusText: posterState.statusText,
            profileCounts: posterState.profileCounts,
          },
          ...(sanitizedBluestacks ? { bluestacks: sanitizedBluestacks } : {}),
        },
      }),
      now = new Date(),
      { fileStamp, readable } = formatLocalTimestamp(now),
      feedbackDir = path.join(deps.dataDir, 'logs', 'feedback');
    await mkdir(feedbackDir, { recursive: true });
    const allPlans = [...(await deps.tasksRepository.list())].sort(
        (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
      ),
      ledgerPlans = await Promise.all(
        allPlans.slice(0, 30).map(async (plan) => {
          const [steps, operations, events] = await Promise.all([
            deps.tasksRepository.steps(plan.id),
            deps.tasksRepository.operations(plan.id),
            deps.tasksRepository.events(plan.id),
          ]);
          return {
            plan: {
              id: plan.id,
              batchId: plan.batchId,
              profileId: plan.profileId,
              combinationId: plan.combinationId,
              combinationName: plan.snapshot.name,
              version: plan.version,
              round: plan.round,
              position: plan.position,
              state: plan.state,
              reason: plan.reason,
              controlMode: plan.controlMode,
              controlRequestId: plan.controlRequestId,
              timing: plan.timing,
              createdAt: plan.createdAt,
              updatedAt: plan.updatedAt,
            },
            steps,
            operations: operations.slice(-100).map((op) => ({
              id: op.id,
              stepId: op.stepId,
              action: op.action,
              status: op.status,
              disposition: op.disposition ?? null,
              receipt: op.receipt ?? null,
              createdAt: op.createdAt,
              updatedAt: op.updatedAt,
            })),
            events: events.slice(-120).map((ev) => ({
              sequence: ev.sequence,
              type: ev.type,
              detail: ev.detail,
              createdAt: ev.createdAt,
            })),
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
                id: row.id,
                version: row.version,
                revision: row.revision,
                updatedAt: row.updatedAt,
                saved: row.saved
                  ? {
                      name: row.saved.name,
                      note: row.saved.note,
                      randomOrder: row.saved.randomOrder,
                      loop: row.saved.loop,
                      steps: row.saved.steps,
                    }
                  : null,
              })),
              groupInviter: { state: inviterState, logs: inviterLogs },
              groupBumper: bumperState ? { state: bumperState, logs: bumperLogs } : null,
              groupPoster: { state: posterState, logs: posterLogs.slice(0, 50) },
              bluestacks: sanitizedBluestacks,
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
    for (const stale of (await listZipPackagesDesc(feedbackDir).catch(() => [])).slice(10))
      await unlink(stale.fullPath).catch(() => {});
    if (reveal !== false) await revealDiagnosticPackage(deps.dataDir, zipPath);
    return {
      filePath: zipPath,
      fileName,
      sizeBytes: zipBuffer.length,
      entryId: entry.id,
      at: entry.at,
    };
  };
}
