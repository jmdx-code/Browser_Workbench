import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rename, rm, stat } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import type { WorkspaceRestorePort } from '../domain/workspace-backup.js';
import {
  WorkspaceBackupManifest,
  WorkspaceRestoreInspection,
  type RestoreStatus,
} from '../shared/workspace-backup.js';
import { workspaceSchemaVersion } from './workspace-store.js';
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
  const temp = pendingFile(dataDir) + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(PendingRestore.parse(value), null, 2), {
    flag: 'wx',
    flush: true,
  });
  await rename(temp, pendingFile(dataDir));
}
async function readPending(dataDir: string) {
  try {
    return PendingRestore.parse(JSON.parse(await readFile(pendingFile(dataDir), 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
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
  for (const record of manifest.files) {
    const file = path.join(directory, record.name),
      actual = await fingerprint(file);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256)
      throw Error('备份文件已改变或损坏：' + record.name);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      const maximum = record.name === 'workspace.sqlite' ? workspaceSchemaVersion : 2;
      if (typeof version !== 'number' || version < 1 || version > maximum)
        throw Error('备份版本不兼容，请使用同版或更新的软件');
      if (
        db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length
      )
        throw Error('备份数据库检查未通过');
      // Check that these are the application's databases, without running a migration or recovery.
      if (record.name === 'workspace.sqlite') {
        for (const table of ['groups', 'combinations', 'profile_metadata', 'task_plans'])
          db.prepare('SELECT count(*) FROM ' + table).get();
      } else
        for (const table of ['profiles', 'operations', 'tasks'])
          db.prepare('SELECT count(*) FROM ' + table).get();
    } finally {
      db.close();
    }
  }
  const workspace = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
  const journal = new DatabaseSync(path.join(directory, 'journal.sqlite'), { readOnly: true });
  try {
    const count = (db: DatabaseSync, table: string) =>
      Number(db.prepare('SELECT count(*) AS total FROM ' + table).get()?.total);
    return {
      manifest,
      inspection: WorkspaceRestoreInspection.parse({
        directory,
        id: manifest.id,
        createdAt: manifest.createdAt,
        softwareVersion: manifest.softwareVersion,
        groups: count(workspace, 'groups'),
        combinations: count(workspace, 'combinations'),
        profiles: count(journal, 'profiles'),
        tasks: count(workspace, 'task_plans'),
      }),
    };
  } finally {
    workspace.close();
    journal.close();
  }
}

// This is a software-data transaction, not a browser task or another execution journal.
// It is staged while running and applied only before opening either DB, after owning the port.
export class FilesystemWorkspaceRestore implements WorkspaceRestorePort {
  constructor(private readonly dataDir: string) {}
  async inspect(directory: string) {
    return (await inspect(directory)).inspection;
  }
  async status(): Promise<RestoreStatus> {
    const pending = await readPending(this.dataDir);
    return {
      available: true,
      state: pending?.state === 'APPLYING' ? 'READY' : (pending?.state ?? 'NONE'),
      reason: pending?.reason ?? '',
      safetyDirectory: pending?.safetyDirectory ?? '',
    };
  }
  async prepare(directory: string, guard: () => Awaitable<void>) {
    await guard();
    const previous = await readPending(this.dataDir);
    if (previous && ['READY', 'APPLYING'].includes(previous.state))
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

async function replacePair(
  dataDir: string,
  source: string,
  id: string,
  checkpoint: (name: string) => Promise<void>,
) {
  await inspect(source);
  for (const name of names) {
    const target = path.join(dataDir, name),
      temp = target + '.restore-' + id;
    await rm(temp, { force: true });
    await copyFile(path.join(source, name), temp, constants.COPYFILE_EXCL);
    // Only original application DB names in its explicitly supplied data directory.
    // Both DB connections are closed. Old WAL/SHM must not be applied to the restored snapshot.
    for (const file of [target + '-wal', target + '-shm', target]) await rm(file, { force: true });
    await rename(temp, target);
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
          await backup(db, target);
        } finally {
          db.close();
        }
      };
      const safety = await new FilesystemWorkspaceBackupWriter(
        (file) => snapshot('workspace.sqlite', file),
        (file) => snapshot('journal.sqlite', file),
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
