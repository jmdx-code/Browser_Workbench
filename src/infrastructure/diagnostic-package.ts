import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { TaskRepository } from '../domain/tasks.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import { ProductError } from '../domain/workspace.js';

export interface ZipEntryInput {
  name: string;
  data: Buffer | string;
}

function dosDateTime(date = new Date()): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

export function createZipArchive(entries: readonly ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const rawBytes =
      typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const uncompressedSize = rawBytes.length;
    const method = uncompressedSize > 0 ? 8 : 0;
    const compressedBytes = uncompressedSize > 0 ? deflateRawSync(rawBytes) : Buffer.alloc(0);
    const compressedSize = compressedBytes.length;
    const checksum = crc32(rawBytes) >>> 0;
    const flags = 0x0800; // UTF-8 filename

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    localParts.push(localHeader, compressedBytes);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + compressedBytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function formatLocalTimestamp(date: Date): { fileStamp: string; readable: string } {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const ms = pad(date.getMilliseconds(), 3);
  return {
    fileStamp: `${y}${m}${d}-${hh}${mm}${ss}`,
    readable: `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}`,
  };
}

async function readTailBuffer(
  filePath: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; fullFileSize: number } | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    if (info.size <= maxBytes) {
      const full = await readFile(filePath);
      return { buffer: full, fullFileSize: info.size };
    }
    const handle = await open(filePath, 'r');
    try {
      const start = Math.max(0, info.size - maxBytes);
      const length = info.size - start;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      const slice = chunk.subarray(0, bytesRead);
      const firstNewline = slice.indexOf(0x0a);
      const aligned =
        firstNewline >= 0 && firstNewline + 1 < slice.length
          ? slice.subarray(firstNewline + 1)
          : slice;
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
    const names = await readdir(logsDir);
    const runtimeFiles = names
      .filter((name) => /^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, maxDays)
      .reverse();
    if (runtimeFiles.length === 0) return Buffer.alloc(0);
    const buffers: Buffer[] = [];
    for (const file of runtimeFiles) {
      try {
        const content = await readFile(path.join(logsDir, file));
        if (content.length > 0) {
          buffers.push(content);
          if (content[content.length - 1] !== 0x0a) {
            buffers.push(Buffer.from('\n', 'utf8'));
          }
        }
      } catch {
        // Ignore unreadable runtime log file.
      }
    }
    return Buffer.concat(buffers);
  } catch {
    return Buffer.alloc(0);
  }
}

async function pruneOldFeedbackPackages(feedbackDir: string, keepCount = 10): Promise<void> {
  try {
    const names = await readdir(feedbackDir);
    const zipNames = names.filter((n) => n.toLowerCase().endsWith('.zip'));
    if (zipNames.length <= keepCount) return;
    const items: { name: string; fullPath: string; mtimeMs: number }[] = [];
    for (const name of zipNames) {
      const fullPath = path.join(feedbackDir, name);
      try {
        const info = await stat(fullPath);
        if (info.isFile()) {
          items.push({ name, fullPath, mtimeMs: info.mtimeMs });
        }
      } catch {
        // Ignore race.
      }
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    for (const stale of items.slice(keepCount)) {
      try {
        await unlink(stale.fullPath);
      } catch {
        // Ignore unlink errors.
      }
    }
  } catch {
    // Ignore directory read errors.
  }
}

export async function revealDiagnosticPackage(
  dataDir: string,
  fileName?: string,
  targetDir?: string,
): Promise<{ filePath: string; fileName: string }> {
  const customDir = targetDir?.trim() || '';
  if (customDir && (!path.isAbsolute(customDir) || customDir.includes('..'))) {
    throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包保存目录', 400);
  }
  const feedbackDir = customDir || path.join(dataDir, 'logs', 'feedback');
  let targetName = fileName?.trim() || '';
  let zipPath = '';
  if (targetName && path.isAbsolute(targetName)) {
    if (targetName.includes('..') || !targetName.toLowerCase().endsWith('.zip')) {
      throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包文件路径', 400);
    }
    zipPath = targetName;
    targetName = path.basename(targetName);
  } else {
    if (targetName) {
      if (
        path.basename(targetName) !== targetName ||
        targetName.includes('..') ||
        !targetName.toLowerCase().endsWith('.zip')
      ) {
        throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包文件名', 400);
      }
    } else {
      try {
        const names = (await readdir(feedbackDir)).filter((n) => n.toLowerCase().endsWith('.zip'));
        const stats: { name: string; mtimeMs: number }[] = [];
        for (const name of names) {
          try {
            const info = await stat(path.join(feedbackDir, name));
            if (info.isFile()) stats.push({ name, mtimeMs: info.mtimeMs });
          } catch {}
        }
        stats.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
        targetName = stats[0]?.name ?? '';
      } catch {
        targetName = '';
      }
    }
    if (!targetName) {
      throw new ProductError('DIAGNOSTIC_PACKAGE_NOT_FOUND', '未找到已生成的诊断反馈包', 404);
    }
    zipPath = path.join(feedbackDir, targetName);
  }
  try {
    const info = await stat(zipPath);
    if (!info.isFile()) throw Error('NOT_FILE');
  } catch {
    throw new ProductError('DIAGNOSTIC_PACKAGE_NOT_FOUND', '反馈包文件不存在或已被清理', 404);
  }

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
      const child = spawn('explorer.exe', [`/select,${zipPath}`], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      // Never fail diagnostic creation if Explorer launch fails.
    }
  }
  return { filePath: zipPath, fileName: targetName };
}

export interface DiagnosticPackageProfileSummary {
  id: string;
  name: string;
  alias: string;
  browserName: string;
  online: boolean;
  phase: string;
  synced: boolean;
  unresolved: number | boolean;
  extensionVersion: string | null;
  accountState: string;
  accountId: string | null;
  accountName: string | null;
  profileWindowFocused: boolean | null;
  focusedWindowAt: number | null;
  presentationRecoverySupported: boolean;
  kernelTraceTail: unknown[];
}

export interface BuildDiagnosticPackageOptions {
  dataDir: string;
  softwareVersion: string;
  extensionVersion: string;
  note?: string;
  uiContext?: string;
  targetDir?: string;
  reveal?: boolean;
  entryId: number;
  at: string;
  controllerLoopDelay: {
    resolutionMs: number;
    samples: number;
    maxSampleIntervalMs: number | null;
    p99SampleIntervalMs: number | null;
  };
  profiles: DiagnosticPackageProfileSummary[];
  combinations: unknown[];
  groupInviter: {
    state: unknown;
    logs: unknown[];
  };
  groupBumper: {
    state: unknown;
    logs: unknown[];
  } | null;
  tasksRepository: TaskRepository;
  taskTabsRepository?: TaskTabRepository;
  devDiagFlush: () => Promise<void>;
  devDiagFilePath: string;
}

export interface DiagnosticPackageResult {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  entryId: number;
  at: string;
}

export async function buildDiagnosticFeedbackPackage(
  options: BuildDiagnosticPackageOptions,
): Promise<DiagnosticPackageResult> {
  const now = new Date();
  const { fileStamp, readable } = formatLocalTimestamp(now);
  const feedbackDir = path.join(options.dataDir, 'logs', 'feedback');
  await mkdir(feedbackDir, { recursive: true });

  // 1. Build 1-snapshot.json
  const snapshotPayload = {
    userNote: options.note?.trim() || '',
    uiContext: options.uiContext?.trim() || '',
    generatedAt: now.toISOString(),
    localTime: readable,
    softwareVersion: options.softwareVersion,
    extensionVersion: options.extensionVersion,
    entryId: options.entryId,
    system: {
      memoryUsage: process.memoryUsage(),
      uptimeSeconds: Math.round(process.uptime()),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
      controllerLoopDelay: options.controllerLoopDelay,
    },
    profiles: options.profiles,
    combinations: options.combinations,
    groupInviter: options.groupInviter,
    groupBumper: options.groupBumper,
  };

  // 2. Build 2-task-ledger.json (latest 30 plans sorted by updatedAt DESC)
  const allPlans = [...(await options.tasksRepository.list())].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
  );
  const recentPlans = allPlans.slice(0, 30);
  const ledgerPlans: unknown[] = [];
  for (const plan of recentPlans) {
    const [steps, operations, events, tabs] = await Promise.all([
      options.tasksRepository.steps(plan.id),
      options.tasksRepository.operations(plan.id),
      options.tasksRepository.events(plan.id),
      options.taskTabsRepository
        ? options.taskTabsRepository.forPlan(plan.id)
        : Promise.resolve([]),
    ]);
    ledgerPlans.push({
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
      tabs,
    });
  }
  const taskLedgerPayload = {
    generatedAt: now.toISOString(),
    totalPlansInDatabase: allPlans.length,
    includedPlanCount: ledgerPlans.length,
    plans: ledgerPlans,
  };

  // 3. Flush and read 3-dev-diagnostics.jsonl (up to 8 MB) + optional 3b-dev-diagnostics.prev.jsonl
  await options.devDiagFlush();
  const maxMainDiagBytes = 8 * 1024 * 1024;
  const mainDiag = await readTailBuffer(options.devDiagFilePath, maxMainDiagBytes);
  const mainDiagBuffer = mainDiag?.buffer ?? Buffer.alloc(0);

  const zipEntries: ZipEntryInput[] = [
    { name: '1-snapshot.json', data: JSON.stringify(snapshotPayload, null, 2) },
    { name: '2-task-ledger.json', data: JSON.stringify(taskLedgerPayload, null, 2) },
    { name: '3-dev-diagnostics.jsonl', data: mainDiagBuffer },
  ];

  if ((mainDiag?.fullFileSize ?? 0) < 2 * 1024 * 1024) {
    const prevPath = path.join(path.dirname(options.devDiagFilePath), 'dev-diagnostics.prev.jsonl');
    const prevDiag = await readTailBuffer(prevPath, 4 * 1024 * 1024);
    if (prevDiag && prevDiag.buffer.length > 0) {
      zipEntries.push({ name: '3b-dev-diagnostics.prev.jsonl', data: prevDiag.buffer });
    }
  }

  // 4. Collect 4-runtime-logs.ndjson (latest 3 days)
  const runtimeLogsBuffer = await collectRecentRuntimeLogs(path.join(options.dataDir, 'logs'), 3);
  zipEntries.push({ name: '4-runtime-logs.ndjson', data: runtimeLogsBuffer });

  const zipBuffer = createZipArchive(zipEntries);

  const basePrefix = `问题反馈-v${options.softwareVersion}-${fileStamp}`;
  const customTargetDir = options.targetDir?.trim() || '';
  if (customTargetDir && (!path.isAbsolute(customTargetDir) || customTargetDir.includes('..'))) {
    throw new ProductError('DIAGNOSTIC_PACKAGE_INVALID', '无效的反馈包保存目录', 400);
  }
  const outputDir = customTargetDir || feedbackDir;
  if (customTargetDir) {
    await mkdir(outputDir, { recursive: true });
  }
  let fileName = `${basePrefix}.zip`;
  let zipPath = path.join(outputDir, fileName);
  let suffix = 2;
  while (true) {
    try {
      await stat(zipPath);
      fileName = `${basePrefix}-${suffix}.zip`;
      zipPath = path.join(outputDir, fileName);
      suffix++;
    } catch {
      break;
    }
  }

  await writeFile(zipPath, zipBuffer);
  await pruneOldFeedbackPackages(feedbackDir, 10);

  if (options.reveal !== false) {
    await revealDiagnosticPackage(options.dataDir, zipPath);
  }

  return {
    filePath: zipPath,
    fileName,
    sizeBytes: zipBuffer.length,
    entryId: options.entryId,
    at: options.at,
  };
}
