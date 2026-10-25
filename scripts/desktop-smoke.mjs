import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync, backup } from 'node:sqlite';
import { workspaceSchemaVersion } from '../dist/src/infrastructure/workspace-store.js';
const temp = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-'));
const report = path.resolve(process.env.WORKBENCH_SMOKE_REPORT ?? 'audit/desktop-smoke.json');
await mkdir(path.dirname(report), { recursive: true });
await mkdir(path.join(temp, 'user'), { recursive: true });
let seedSchemaVersion = null;
if (process.env.WORKBENCH_SMOKE_SEED_WORKSPACE) {
  await mkdir(path.join(temp, 'data'), { recursive: true });
  const source = new DatabaseSync(path.resolve(process.env.WORKBENCH_SMOKE_SEED_WORKSPACE), {
    readOnly: true,
  });
  try {
    seedSchemaVersion = source.prepare('PRAGMA user_version').get()?.user_version;
    await backup(source, path.join(temp, 'data/workspace.sqlite'));
  } finally {
    source.close();
  }
}
if (process.env.WORKBENCH_SMOKE_SEED_JOURNAL) {
  await mkdir(path.join(temp, 'data'), { recursive: true });
  const source = new DatabaseSync(path.resolve(process.env.WORKBENCH_SMOKE_SEED_JOURNAL), {
    readOnly: true,
  });
  try {
    await backup(source, path.join(temp, 'data/journal.sqlite'));
  } finally {
    source.close();
  }
}
const probe = createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const executable =
  process.env.WORKBENCH_SMOKE_EXE ?? path.resolve('node_modules/electron/dist/electron.exe');
const child = spawn(executable, process.env.WORKBENCH_SMOKE_EXE ? [] : ['.'], {
  env: {
    ...process.env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_DATA_DIR: path.join(temp, 'data'),
    WORKBENCH_SMOKE_USER_DATA: path.join(temp, 'user'),
    WORKBENCH_SMOKE_OUT: report,
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output = (output + chunk).slice(-16000);
});
child.stderr.on('data', (chunk) => {
  output = (output + chunk).slice(-16000);
});
const requestedTimeout = Number(process.env.WORKBENCH_SMOKE_TIMEOUT_MS ?? 40000);
const timer = setTimeout(
  () => child.kill(),
  Number.isFinite(requestedTimeout) ? Math.min(660000, Math.max(40000, requestedTimeout)) : 40000,
);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (process.env.WORKBENCH_SMOKE_RESET === '1') {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        await readFile(report);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  const value = JSON.parse(await readFile(report, 'utf8'));
  value.seedSchemaVersion = seedSchemaVersion;
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(report, JSON.stringify(value, null, 2)),
  );
  if (
    code !== 0 ||
    !value.ok ||
    (process.env.WORKBENCH_SMOKE_RESET === '1' && !value.resetVerified) ||
    (process.env.WORKBENCH_SMOKE_CLEANUP_UI === '1' && !value.cleanupUi) ||
    value.htmlFacts.overflow ||
    value.htmlFacts.nodeExposed ||
    !value.htmlFacts.desktopBridge ||
    !value.htmlFacts.constructedFileRejected ||
    !value.closePersisted ||
    value.workspaceDatabaseVersion !== workspaceSchemaVersion
  )
    throw Error('DESKTOP_SMOKE_FAILED: ' + JSON.stringify(value) + '\n' + output);
  console.log(
    'Desktop smoke passed: Electron ' +
      value.runtime.electron +
      ', Node ' +
      value.runtime.node +
      ', SQLite ' +
      value.runtime.sqlite +
      '; isolated port ' +
      port,
  );
} finally {
  clearTimeout(timer);
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
  assert.ok(path.basename(temp).startsWith('workbench-desktop-'));
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
