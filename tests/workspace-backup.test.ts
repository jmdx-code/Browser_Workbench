import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { Store } from '../src/bridge/store.js';
import { WorkspaceBackupService } from '../src/application/workspace-backup-service.js';
import { FilesystemWorkspaceBackupWriter } from '../src/infrastructure/workspace-backup-writer.js';
import { WorkspaceBackupManifest } from '../src/shared/workspace-backup.js';
import { mediaReference } from '../src/domain/resource-table.js';
import { TaskService } from '../src/application/task-service.js';

test('backup copies both live SQLite databases and saved resources with completion checksums, retaining sources and old backups', async () =>
  settlementFixture(async (store, file) => {
    const directory = path.dirname(file),
      journal = new Store(':memory:');
    try {
      const profileId = randomUUID();
      journal.pair(profileId, 'generated-private-test-only', 'a'.repeat(32));
      const group = await store.createGroup('生成备份分组', 'blue');
      const combination = await store.createCombination({
        name: '生成备份组合',
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 4, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      const source = path.join(directory, 'original-source.png');
      await writeFile(source, 'generated media, never copied');
      await store.resourceTables.save(combination.id, 0, [
        {
          id: randomUUID(),
          text: '生成文案',
          background: 'plain',
          purpose: 'both',
          media: [mediaReference(source)],
        },
      ]);
      const service = new WorkspaceBackupService(
        store.tasks,
        new FilesystemWorkspaceBackupWriter(
          async (file) => store.backup(file),
          (file) => journal.backup(file),
          '0.1.40',
        ),
      );
      const first = await service.create({ directory }),
        second = await service.create({ directory });
      assert.notEqual(first.directory, second.directory);
      const manifest = WorkspaceBackupManifest.parse(
        JSON.parse(await readFile(path.join(first.directory, 'backup.json'), 'utf8')),
      );
      assert.deepEqual(
        manifest.files.map((item) => item.name),
        ['workspace.sqlite', 'journal.sqlite'],
      );
      assert.equal(manifest.includesSourceMedia, false);
      for (const record of manifest.files) {
        const bytes = await readFile(path.join(first.directory, record.name));
        assert.equal(bytes.length, record.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
        const database = new DatabaseSync(path.join(first.directory, record.name), {
          readOnly: true,
        });
        try {
          assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
          if (record.name === 'workspace.sqlite') {
            assert.equal(
              database.prepare('SELECT name FROM groups WHERE id=?').get(group.id)?.name,
              group.name,
            );
            assert.deepEqual(
              JSON.parse(
                String(
                  database
                    .prepare(
                      'SELECT body FROM combination_versions WHERE combination_id=? AND version=1',
                    )
                    .get(combination.id)?.body,
                ),
              ),
              combination.saved,
            );
            assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
          } else
            assert.ok(database.prepare('SELECT * FROM profiles WHERE profileId=?').get(profileId));
        } finally {
          database.close();
        }
      }
      assert.deepEqual((await readdir(first.directory)).sort(), [
        'backup.json',
        'journal.sqlite',
        'workspace.sqlite',
      ]);
      assert.equal(await readFile(source, 'utf8'), 'generated media, never copied');
      assert.equal((await store.combinations()).length, 1);
      assert.equal((await store.tasks.list()).length, 0);
    } finally {
      journal.db.close();
    }
  }));
test('backup blocks active tasks and competing launch before writing; failure releases busy state without a completion manifest', async () =>
  settlementFixture(async (store, file) => {
    let release = () => {},
      entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new WorkspaceBackupService(store.tasks, {
      write: async () => {
        entered();
        await waiting;
        throw Error('GENERATED_BACKUP_IO_FAILURE');
      },
    });
    const pending = service.create({ directory: path.dirname(file) });
    await started;
    assert.equal((await service.status()).busy, true);
    await assert.rejects(
      async () =>
        await new TaskService(store.tasks, undefined, () => service.assertIdle()).start({
          requestId: randomUUID(),
          combinationId: randomUUID(),
          version: 1,
          profileIds: [randomUUID()],
        }),
      /正在保存数据备份/,
    );
    await assert.rejects(service.create({ directory: path.dirname(file) }), /正在保存数据备份/);
    release();
    await assert.rejects(pending, /GENERATED_BACKUP_IO_FAILURE/);
    assert.equal((await service.status()).canCreate, true);
    await prepareBound(store);
    await assert.rejects(service.create({ directory: path.dirname(file) }), /请先暂停或停止/);
    assert.deepEqual(
      (await readdir(path.dirname(file))).filter((name) =>
        name.startsWith('BrowserWorkbench-backup-'),
      ),
      [],
    );
  }));
test('a failed second database save leaves an explicitly incomplete folder, preserving original task data', async () =>
  settlementFixture(async (store, file) => {
    const directory = path.dirname(file);
    const writer = new FilesystemWorkspaceBackupWriter(
      async (file) => store.backup(file),
      async () => {
        throw Error('GENERATED_SECOND_SAVE_FAILED');
      },
      '0.1.40',
    );
    await assert.rejects(
      writer.write(directory, () => {}),
      /GENERATED_SECOND_SAVE_FAILED/,
    );
    const child = (await readdir(directory)).find((name) =>
      name.startsWith('BrowserWorkbench-backup-'),
    );
    assert.ok(child);
    assert.deepEqual(await readdir(path.join(directory, child)), ['workspace.sqlite']);
    assert.equal((await store.tasks.list()).length, 0);
  }));
