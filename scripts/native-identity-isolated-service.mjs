import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { productDataDirectory } from '../dist/src/infrastructure/paths.js';

const root = process.cwd();
const source = path.resolve(process.env.WORKBENCH_SNAPSHOT_SOURCE ?? productDataDirectory());
const target = path.resolve('audit/native-identity-service-' + randomUUID());
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(18767, '127.0.0.1', resolve);
});
await new Promise((resolve) => probe.close(resolve));
await mkdir(target);
const digest = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const copies = [];
for (const name of ['journal.sqlite', 'workspace.sqlite']) {
  const file = path.join(source, name),
    before = await digest(file);
  // A coherent SQLite read-only snapshot, including any existing WAL. All migration and
  // startup recovery is confined to the new copy; the original product database is not opened
  // by WorkspaceStore and is never upgraded or recovered here.
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.prepare('VACUUM INTO ?').run(path.join(target, name));
  } finally {
    database.close();
  }
  const after = await digest(file);
  if (before !== after) throw Error('FORMAL_DATABASE_CHANGED_DURING_SNAPSHOT');
  copies.push({
    name,
    sourceReadOnly: true,
    sourceMainSha256: before,
    copy: path.join(target, name),
  });
}
const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: target,
  WORKBENCH_PORT: '18767',
  WORKBENCH_DIAGNOSTICS: '1',
  WORKBENCH_NATIVE_IDENTITY_AUDIT: '1',
};
for (const key of [
  'WORKBENCH_UPLOAD_AUDIT',
  'WORKBENCH_FACEBOOK_READ_AUDIT',
  'WORKBENCH_FACEBOOK_FOLLOWUP_AUDIT',
  'WORKBENCH_STOP_RETRY_AUDIT',
  'WORKBENCH_LIFECYCLE_AUDIT',
  'WORKBENCH_ACTOR_FENCE_AUDIT',
  'WORKBENCH_STARTUP_AUDIT',
  'WORKBENCH_KERNEL_AUDIT',
  'WORKBENCH_KERNEL_PERSISTENCE_AUDIT',
  'WORKBENCH_TASK_TAB_AUDIT',
])
  env[key] = '0';
const child = spawn(process.execPath, ['dist/src/server.js'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
await writeFile(
  path.join(target, 'service.json'),
  JSON.stringify(
    {
      version: 1,
      kind: 'isolated-native-identity-read',
      parentPid: process.pid,
      serverPid: child.pid,
      dataDir: target,
      copies,
      formalWorkspaceUnmodified: true,
      oldAuditFlagsDisabled: true,
      newPosts: 0,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ isolatedDataDir: target, serverPid: child.pid, newPosts: 0 }));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
