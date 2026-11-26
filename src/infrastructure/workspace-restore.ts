import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rename, rm, stat } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import type { WorkspaceRestorePort } from '../domain/system-ports.js';
import {
  WorkspaceBackupManifest,
  WorkspaceRestoreInspection,
  type RestoreStatus,
} from '../shared/workspace-backup.js';
import { workspaceSchemaVersion } from './workspace-store.js';
import { bridgeSchemaVersion } from '../bridge/store.js';
import { FilesystemWorkspaceBackupWriter } from './workspace-backup-writer.js';

const names = ['workspace.sqlite', 'journal.sqlite'] as const;
const PendingRestore = z
  .object({
    id: z.uuid(),
    state: z.enum(['READY', 'APPLYING', 'APPLIED', 'ROLLED_BACK', 'FAILED']),
    safetyDirectory: z.string().max(4096),
    reason: z.string().max(500),
  })
  .strict();
type Pending = z.infer<typeof PendingRestore>;
const pendingFile = (dataDir: string) => path.join(dataDir, 'pending-restore.json');
const stageDirectory = (dataDir: string, id: string) => path.join(dataDir, 'data-restores', id);

async function savePending(dataDir: string, value: Pending) {
  const tmp = pendingFile(dataDir) + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(PendingRestore.parse(value), null, 2), {
    flag: 'wx',
    flush: true,
  });
  await rename(tmp, pendingFile(dataDir));
}
async function readPending(dataDir: string) {
  try {
    return PendingRestore.parse(JSON.parse(await readFile(pendingFile(dataDir), 'utf8')));
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}
async function fingerprint(file: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}
async function inspect(directory: string) {
  if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory())
    throw Error('请选择完整的数据备份文件夹');
  const manifest = WorkspaceBackupManifest.parse(
    JSON.parse(await readFile(path.join(directory, 'backup.json'), 'utf8')),
  );
  for (const rec of manifest.files) {
    const file = path.join(directory, rec.name),
      actual = await fingerprint(file);
    if (actual.bytes !== rec.bytes || actual.sha256 !== rec.sha256)
      throw Error('备份文件已改变或损坏：' + rec.name);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const v = db.prepare('PRAGMA user_version').get()?.user_version,
        max = rec.name === 'workspace.sqlite' ? workspaceSchemaVersion : bridgeSchemaVersion;
      if (typeof v !== 'number' || v < 1 || v > max)
        throw Error('备份版本不兼容，请使用同版或更新的软件');
      if (
        db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length
      )
        throw Error('备份数据库检查未通过');
      const reqTables =
        rec.name === 'workspace.sqlite'
          ? ['groups', 'combinations', 'profile_metadata', 'task_plans']
          : ['profiles', 'operations', 'tasks'];
      for (const t of reqTables) db.prepare('SELECT count(*) FROM ' + t).get();
    } finally {
      db.close();
    }
  }
  const ws = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true }),
    jn = new DatabaseSync(path.join(directory, 'journal.sqlite'), { readOnly: true });
  try {
    ws.exec('PRAGMA busy_timeout = 5000');
    jn.exec('PRAGMA busy_timeout = 5000');
    const cnt = (db: DatabaseSync, t: string) =>
      Number(db.prepare('SELECT count(*) AS total FROM ' + t).get()?.total);
    return {
      manifest,
      inspection: WorkspaceRestoreInspection.parse({
        directory,
        id: manifest.id,
        createdAt: manifest.createdAt,
        softwareVersion: manifest.softwareVersion,
        groups: cnt(ws, 'groups'),
        combinations: cnt(ws, 'combinations'),
        profiles: cnt(jn, 'profiles'),
        tasks: cnt(ws, 'task_plans'),
      }),
    };
  } finally {
    ws.close();
    jn.close();
  }
}

export class FilesystemWorkspaceRestore implements WorkspaceRestorePort {
  constructor(private readonly dataDir: string) {}
  async inspect(directory: string) {
    return (await inspect(directory)).inspection;
  }
  async status(): Promise<RestoreStatus> {
    const p = await readPending(this.dataDir);
    return {
      available: true,
      state: p?.state === 'APPLYING' ? 'READY' : (p?.state ?? 'NONE'),
      reason: p?.reason ?? '',
      safetyDirectory: p?.safetyDirectory ?? '',
    };
  }
  async prepare(directory: string, guard: () => Awaitable<void>) {
    await guard();
    const prev = await readPending(this.dataDir);
    if (prev && ['READY', 'APPLYING'].includes(prev.state))
      throw Error('已有待恢复的数据，请先重启完成恢复');
    const original = await inspect(directory);
    await guard();
    const id = randomUUID(),
      stage = stageDirectory(this.dataDir, id);
    await mkdir(stage, { recursive: true });
    for (const name of names) {
      await guard();
      await copyFile(path.join(directory, name), path.join(stage, name), constants.COPYFILE_EXCL);
    }
    await writeFile(path.join(stage, 'backup.json'), JSON.stringify(original.manifest, null, 2), {
      flag: 'wx',
      flush: true,
    });
    await inspect(stage);
    await guard();
    await savePending(this.dataDir, {
      id,
      state: 'READY',
      safetyDirectory: '',
      reason: '数据已准备，重启软件后恢复；原素材保持原位',
    });
    return this.status();
  }
}

async function renameWithWindowsRetry(fromPath: string, toPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (error) {
      lastErr = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function replacePair(
  dataDir: string,
  source: string,
  id: string,
  checkpoint: (name: string) => Promise<void>,
) {
  await inspect(source);
  for (const name of names) {
    const target = path.join(dataDir, name),
      temp = target + '.restore-' + id,
      oldBackup = target + '.prev-' + id;
    await rm(temp, { force: true, maxRetries: 4, retryDelay: 100 });
    await rm(oldBackup, { force: true, maxRetries: 4, retryDelay: 100 });
    await copyFile(path.join(source, name), temp, constants.COPYFILE_EXCL);
    let movedOld = false;
    try {
      await renameWithWindowsRetry(target, oldBackup);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    }
    try {
      await renameWithWindowsRetry(temp, target);
    } catch (error) {
      if (movedOld) await renameWithWindowsRetry(oldBackup, target).catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    for (const file of [target + '-wal', target + '-shm', oldBackup])
      await rm(file, { force: true, maxRetries: 6, retryDelay: 150 });
    await checkpoint(name);
  }
}

export async function applyPendingWorkspaceRestore(
  dataDir: string,
  softwareVersion: string,
  checkpoint: (name: string) => Promise<void> = async () => {},
) {
  let pending = await readPending(dataDir);
  if (!pending || !['READY', 'APPLYING'].includes(pending.state))
    return new FilesystemWorkspaceRestore(dataDir).status();
  const rollback = async (reason: string) => {
    if (!pending?.safetyDirectory) throw Error('恢复中断且安全备份缺失；已停止打开数据库');
    await replacePair(dataDir, pending.safetyDirectory, pending.id, async () => {});
    await savePending(dataDir, { ...pending, state: 'ROLLED_BACK', reason: reason.slice(0, 500) });
  };
  if (pending.state === 'APPLYING')
    await rollback('上次恢复中断，已恢复重启前的数据；没有继续执行旧任务');
  else {
    try {
      const stage = stageDirectory(dataDir, pending.id);
      await inspect(stage);
      const safetyRoot = path.join(dataDir, 'data-backups');
      await mkdir(safetyRoot, { recursive: true });
      const snapshot = async (name: string, target: string) => {
        const db = new DatabaseSync(path.join(dataDir, name));
        try {
          db.exec('PRAGMA busy_timeout = 5000');
          await backup(db, target);
        } finally {
          db.close();
        }
      };
      const safety = await new FilesystemWorkspaceBackupWriter(
        (f) => snapshot('workspace.sqlite', f),
        (f) => snapshot('journal.sqlite', f),
        softwareVersion,
      ).write(safetyRoot, () => {});
      pending = { ...pending, state: 'APPLYING', safetyDirectory: safety.directory, reason: '' };
      await savePending(dataDir, pending);
      await replacePair(dataDir, stage, pending.id, checkpoint);
      await savePending(dataDir, {
        ...pending,
        state: 'APPLIED',
        reason: '数据恢复完成；旧任务保持停止，原素材与缓存未更改',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '恢复未完成';
      if (pending.state === 'APPLYING') await rollback('恢复失败，已保留原数据：' + reason);
      else
        await savePending(dataDir, { ...pending, state: 'FAILED', reason: reason.slice(0, 500) });
    }
  }
  return new FilesystemWorkspaceRestore(dataDir).status();
}
