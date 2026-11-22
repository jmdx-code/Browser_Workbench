import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, stat, writeFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceBackupWriter } from '../domain/workspace-backup.js';
import { WorkspaceBackupResult, WorkspaceBackupManifest } from '../shared/workspace-backup.js';
import { defaultBackupDirectory } from './paths.js';

// Reuses each original SQLite backup operation. Does not copy live WAL files or source media.
export class FilesystemWorkspaceBackupWriter implements WorkspaceBackupWriter {
  constructor(
    private readonly workspace: (file: string) => Promise<void>,
    private readonly journal: (file: string) => Promise<void>,
    private readonly softwareVersion: string,
    private readonly protectedDataDirectory?: string,
  ) {}
  defaultDirectory() {
    return defaultBackupDirectory();
  }
  async write(
    directory: string,
    guard: () => Awaitable<void>,
    options?: { redactSecrets?: boolean | undefined },
  ) {
    if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory())
      throw Error('请选择已存在的本机备份文件夹');
    if (this.protectedDataDirectory) {
      const source = await realpath(this.protectedDataDirectory),
        destination = await realpath(directory);
      const relative = path.relative(source, destination);
      if (
        relative === '' ||
        (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
      )
        throw Error('备份位置不能在工作台数据目录内，请选择其他文件夹');
    }
    await guard();
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    const target = path.join(
      directory,
      'BrowserWorkbench-backup-' + createdAt.replace(/[:.]/g, '-') + '-' + id,
    );
    await mkdir(target);
    const files = [];
    const started = performance.now();
    for (const [name, save] of [
      ['workspace.sqlite', this.workspace],
      ['journal.sqlite', this.journal],
    ] as const) {
      await guard();
      const file = path.join(target, name);
      await save(file);
      await guard();
      // Make the new backup self-contained; opening it must not require external WAL files.
      const saved = new DatabaseSync(file);
      try {
        saved.exec('PRAGMA busy_timeout = 5000');
        saved.exec('PRAGMA journal_mode=DELETE');
        if (options?.redactSecrets && name === 'workspace.sqlite') {
          // Redact Google OAuth tokens/clientSecret and Gyazo tokens ONLY inside the exported backup copy
          try {
            const row = saved
              .prepare('SELECT auth_json, image_host_json FROM google_sheets_config WHERE id = 1')
              .get() as { auth_json?: string; image_host_json?: string } | undefined;
            if (row) {
              const auth = JSON.parse(row.auth_json ?? '{}') as Record<string, unknown>;
              const img = JSON.parse(row.image_host_json ?? '{}') as Record<string, unknown>;
              const scrubbedAuth = {
                ...auth,
                clientSecret: '',
                accessToken: null,
                refreshToken: null,
                expiryDate: null,
              };
              const scrubbedImg = {
                ...img,
                gyazoAccessToken: '',
                gyazoAccessTokens: [],
              };
              saved
                .prepare(
                  'UPDATE google_sheets_config SET auth_json = ?, image_host_json = ? WHERE id = 1',
                )
                .run(JSON.stringify(scrubbedAuth), JSON.stringify(scrubbedImg));
            }
          } catch {}
        }
      } finally {
        saved.close();
      }
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(file)) {
        await guard();
        if (performance.now() - started > 300_000) throw Error('备份校验超时，未生成完成清单');
        bytes += chunk.length;
        hash.update(chunk);
      }
      files.push({ name, bytes, sha256: hash.digest('hex') });
    }
    await guard();
    const manifest = WorkspaceBackupManifest.parse({
      version: 1,
      id,
      createdAt,
      softwareVersion: this.softwareVersion,
      files,
      includesSourceMedia: false,
      includesMediaCache: false,
    });
    await writeFile(path.join(target, 'backup.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
    });
    return WorkspaceBackupResult.parse({ ...manifest, directory: target });
  }
}
