import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { build } from 'esbuild';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, '../..');
const id = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const reportDir = path.join(root, 'audit', 'concurrency-lab-' + id);
const scratch = await mkdtemp(path.join(tmpdir(), 'workbench-concurrency-lab-'));
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(scratch, '.isolated-lab'), id);
const bundle = path.join(reportDir, 'e1-bundle.mjs');
const scoped = process.argv.includes('--scoped-reads');
const commits = process.argv.includes('--commits');
const verifyOnly = process.argv.includes('--verify-records');
const records = process.argv.includes('--records') || verifyOnly;
await build({
  entryPoints: [
    path.join(scripts, commits ? 'e2.ts' : records ? 'records.ts' : scoped ? 'scoped.ts' : 'e1.ts'),
  ],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
const sourceFiles = [
  'src/infrastructure/workspace-store.ts',
  'src/infrastructure/task-store.ts',
  'src/application/workspace-service.ts',
  'src/application/task-service.ts',
  'src/shared/task-contracts.ts',
  'src/infrastructure/sqlite-transaction.ts',
  'scripts/concurrency-lab/run.mjs',
  'scripts/concurrency-lab/main.cjs',
  'scripts/concurrency-lab/utility.mjs',
  'scripts/concurrency-lab/db.mjs',
  'scripts/concurrency-lab/action-worker.mjs',
  'scripts/concurrency-lab/e1.ts',
  'scripts/concurrency-lab/e2.ts',
  'src/infrastructure/task-capacity-migration.ts',
  'src/shared/task-capacity.ts',
  'scripts/concurrency-lab/scoped.ts',
  'scripts/concurrency-lab/records.ts',
  'scripts/concurrency-lab/verify.ts',
  'src/domain/task-record-projection.ts',
  'src/infrastructure/task-record-reader.ts',
  'src/infrastructure/task-record-migration.ts',
];
const sourceHashes = {};
for (const file of sourceFiles)
  sourceHashes[file] = createHash('sha256')
    .update(await readFile(path.join(root, file)))
    .digest('hex');
const config = {
  experiments: commits
    ? ['E2']
    : records
      ? ['E1-RECORDS']
      : scoped
        ? ['E1-SCOPED']
        : process.argv.includes('--e1-only') || process.argv.includes('--e1-matrix')
          ? ['E1']
          : ['E5', 'E1'],
  verifyOnly,
  e1Matrix: process.argv.includes('--e1-matrix'),
  scopeSource:
    scoped || records
      ? path.resolve(
          process.argv[
            process.argv.indexOf(
              records ? (verifyOnly ? '--verify-records' : '--records') : '--scoped-reads',
            ) + 1
          ] ?? '',
        )
      : null,
  id,
  root,
  scratch,
  reportDir,
  bundle,
  sourceHashes,
  host: {
    versions: process.versions,
    os: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  scope: 'generated databases only; no production data, browser, network or business input',
};
const configFile = path.join(reportDir, 'config.json');
await writeFile(configFile, JSON.stringify(config, null, 2));
const env = { ...process.env, WORKBENCH_LAB_CONFIG: configFile };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  path.join(root, 'node_modules/electron/dist/electron.exe'),
  [path.join(scripts, 'main.cjs')],
  { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    output = (output + chunk).slice(-40000);
  });
const timer = setTimeout(() => child.kill(), config.e1Matrix || records ? 360000 : 240000);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(timer);
await writeFile(path.join(reportDir, 'process-output.log'), output);
console.log(JSON.stringify({ reportDir, scratch, exitCode: code }));
if (code !== 0) {
  console.error(output.slice(-6000));
  process.exitCode = 1;
}
