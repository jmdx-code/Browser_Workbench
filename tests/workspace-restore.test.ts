import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { Store } from '../src/bridge/store.js';
import { FilesystemWorkspaceBackupWriter } from '../src/infrastructure/workspace-backup-writer.js';
import {
  FilesystemWorkspaceRestore,
  applyPendingWorkspaceRestore,
} from '../src/infrastructure/workspace-restore.js';
import { WorkspaceBackupManifest } from '../src/shared/workspace-backup.js';
import { WorkspaceBackupService } from '../src/application/workspace-backup-service.js';

async function fixture(run: (directory: string, backupDirectory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-restore-'));
  try {
    const workspace = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
    const journal = new Store(path.join(directory, 'journal.sqlite'));
    workspace.createGroup('备份时的分组', 'blue');
    journal.pair(randomUUID(), 'generated-restore-only', 'a'.repeat(32));
    const root = path.join(directory, 'exports');
    await mkdir(root);
    const saved = await new FilesystemWorkspaceBackupWriter(
      (file) => workspace.backup(file),
      (file) => journal.backup(file),
      '0.1.41',
    ).write(root, () => {});
    workspace.createGroup('备份后新增', 'orange');
    workspace.close();
    journal.db.close();
    await writeFile(path.join(directory, 'source.mp4'), 'original remains unchanged');
    await run(directory, saved.directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function groups(directory: string) {
  const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
  try {
    return db
      .prepare('SELECT name FROM groups ORDER BY sort_order')
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}
test('restoration stages validated copies, backs up latest current data before replacing both DBs, and never moves original media', async () =>
  fixture(async (directory, saved) => {
    const restore = new FilesystemWorkspaceRestore(directory);
    const inspection = await restore.inspect(saved);
    assert.equal(inspection.groups, 1);
    assert.equal(inspection.profiles, 1);
    assert.equal((await restore.prepare(saved, () => {})).state, 'READY');
    assert.deepEqual(groups(directory), ['备份时的分组', '备份后新增']);
    const current = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
    current.createGroup('点击重启前的修改', 'green');
    current.close();
    const result = await applyPendingWorkspaceRestore(directory, '0.1.41');
    assert.equal(result.state, 'APPLIED');
    assert.deepEqual(groups(directory), ['备份时的分组']);
    assert.deepEqual(groups(result.safetyDirectory), [
      '备份时的分组',
      '备份后新增',
      '点击重启前的修改',
    ]);
    assert.equal(
      await readFile(path.join(directory, 'source.mp4'), 'utf8'),
      'original remains unchanged',
    );
    assert.equal((await applyPendingWorkspaceRestore(directory, '0.1.41')).state, 'APPLIED');
    assert.deepEqual(groups(saved), ['备份时的分组']);
  }));
test('a failure between database replacements rolls back the complete current pair and leaves no automatic restore retry', async () =>
  fixture(async (directory, saved) => {
    await new FilesystemWorkspaceRestore(directory).prepare(saved, () => {});
    let replaced = 0;
    const result = await applyPendingWorkspaceRestore(directory, '0.1.41', async () => {
      if (++replaced === 1) throw Error('GENERATED_SECOND_REPLACE_FAILURE');
    });
    assert.equal(result.state, 'ROLLED_BACK');
    assert.deepEqual(groups(directory), ['备份时的分组', '备份后新增']);
    const db = new DatabaseSync(path.join(directory, 'journal.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM profiles').get()?.n, 1);
    } finally {
      db.close();
    }
    assert.equal((await applyPendingWorkspaceRestore(directory, '0.1.41')).state, 'ROLLED_BACK');
  }));
test('restart after interrupted replacement recovers both databases from the persisted safety backup', async () =>
  fixture(async (directory, saved) => {
    await new FilesystemWorkspaceRestore(directory).prepare(saved, () => {});
    const applied = await applyPendingWorkspaceRestore(directory, '0.1.41');
    const record = JSON.parse(await readFile(path.join(directory, 'pending-restore.json'), 'utf8'));
    record.state = 'APPLYING';
    await writeFile(path.join(directory, 'pending-restore.json'), JSON.stringify(record));
    await copyFile(path.join(saved, 'journal.sqlite'), path.join(directory, 'journal.sqlite'));
    const result = await applyPendingWorkspaceRestore(directory, '0.1.41');
    assert.equal(result.state, 'ROLLED_BACK');
    assert.equal(result.safetyDirectory, applied.safetyDirectory);
    assert.deepEqual(groups(directory), ['备份时的分组', '备份后新增']);
  }));
test('bad manifest, altered bytes and revoked preparation refuse restoration without changing current data', async () =>
  fixture(async (directory, saved) => {
    const restore = new FilesystemWorkspaceRestore(directory);
    const manifest = JSON.parse(await readFile(path.join(saved, 'backup.json'), 'utf8'));
    assert.throws(() =>
      WorkspaceBackupManifest.parse({ ...manifest, files: [manifest.files[0], manifest.files[0]] }),
    );
    await assert.rejects(
      restore.prepare(saved, () => {
        throw Error('GENERATED_REVOKED');
      }),
      /REVOKED/,
    );
    await writeFile(path.join(saved, 'journal.sqlite'), 'changed');
    await assert.rejects(
      restore.prepare(saved, () => {}),
      /改变或损坏/,
    );
    assert.equal((await restore.status()).state, 'NONE');
    assert.deepEqual(groups(directory), ['备份时的分组', '备份后新增']);
  }));

test('a newer database schema refuses restore even when the file checksum is valid', async () =>
  fixture(async (directory, saved) => {
    const file = path.join(saved, 'workspace.sqlite'),
      db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=999');
    db.close();
    const bytes = await readFile(file),
      manifest = JSON.parse(await readFile(path.join(saved, 'backup.json'), 'utf8'));
    manifest.files[0] = {
      name: 'workspace.sqlite',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await writeFile(path.join(saved, 'backup.json'), JSON.stringify(manifest));
    await assert.rejects(
      new FilesystemWorkspaceRestore(directory).prepare(saved, () => {}),
      /版本不兼容/,
    );
    assert.deepEqual(groups(directory), ['备份时的分组', '备份后新增']);
  }));

test('prepared restoration blocks further task launches until the normal controller restarts', async () =>
  fixture(async (directory, saved) => {
    const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
    try {
      const service = new WorkspaceBackupService(
        store.tasks,
        {
          write: async () => {
            throw Error('unused writer');
          },
        },
        new FilesystemWorkspaceRestore(directory),
      );
      await service.prepareRestore({ directory: saved });
      assert.throws(() => service.assertIdle(), /先重启软件/);
      assert.equal((await service.restoreStatus()).state, 'READY');
      assert.equal((await service.status()).canCreate, false);
    } finally {
      store.close();
    }
  }));
