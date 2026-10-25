import { readFile, writeFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
import { productDataDirectory } from '../dist/src/infrastructure/paths.js';

const load = async (file) => JSON.parse(await readFile(file, 'utf8'));
const metadata = await load('package.json');
if (metadata.version !== '0.1.1') throw Error('STAGE_VERSION_MISMATCH');
const log = await readFile('audit/check-stage2a.log', 'utf8');
const metric = (name) => {
  const match = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!match) throw Error('MISSING_CHECK_METRIC_' + name);
  return Number(match[1]);
};
const checks = { tests: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (!checks.tests || checks.tests !== checks.passed || checks.failed) {
  throw Error('CHECKS_NOT_ALL_PASSED');
}
const dependencyAudit = await load('audit/dependencies-stage2a.json');
const source = await load('audit/task-source-smoke.json');
const packaged = await load('audit/task-packaged-migration-smoke.json');
for (const result of [source, packaged]) {
  if (!result.ok || result.workspaceDatabaseVersion !== 2 || !result.closePersisted) {
    throw Error('DESKTOP_CHECK_FAILED');
  }
}
if (packaged.seedSchemaVersion !== 1) throw Error('MIGRATION_SEED_MISSING');
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin);
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw Error('ADMIN_COOKIE_MISSING');
const get = async (route, schema) => {
  const response = await fetch(origin + route, { headers: { cookie } });
  if (!response.ok) throw Error('HTTP_' + response.status);
  return schema.parse(await response.json());
};
const workspace = await get('/api/workspace', WorkspaceSchema);
const tasks = await get('/api/workspace/tasks', TaskOverview);
if (tasks.dispatchEnabled || tasks.plans.length) throw Error('UNEXPECTED_LIVE_EXECUTION');
const directory = productDataDirectory();
const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
let database;
try {
  database = {
    schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
    persistedVersions: db
      .prepare('SELECT version,body FROM combination_versions ORDER BY version')
      .all()
      .map((row) => {
        const body = JSON.parse(String(row.body));
        return {
          version: row.version,
          name: body.name,
          types: body.steps.map((step) => step.type),
          durationMinutes: body.steps
            .filter((step) => step.type !== 'post')
            .map((step) => step.durationMinutes),
        };
      }),
  };
} finally {
  db.close();
}
const report = {
  stage: 'task-core-2a',
  productVersion: metadata.version,
  recordedAt: new Date().toISOString(),
  developmentNode: process.versions.node,
  checkLogSha256: createHash('sha256').update(log).digest('hex'),
  programChecks: {
    ...checks,
    scope: 'Isolated semantic tests and bridge regressions; not live Facebook operations.',
  },
  dependencyVulnerabilities: dependencyAudit.metadata.vulnerabilities,
  database: {
    ...database,
    migrationBackups: (await readdir(directory)).filter(
      (name) => name.startsWith('workspace.sqlite') && name.includes('before-v2'),
    ),
  },
  liveWorkspace: {
    profiles: workspace.profiles.length,
    online: workspace.profiles.filter((row) => row.online).length,
    phases: workspace.profiles.reduce((counts, row) => {
      counts[row.phase] = (counts[row.phase] ?? 0) + 1;
      return counts;
    }, {}),
    groups: workspace.groups.map((group) => ({
      name: group.name,
      members: workspace.profiles.filter((row) => row.groupId === group.id).length,
    })),
    combinations: workspace.combinations.map((row) => ({
      name: row.saved?.name,
      version: row.version,
      steps: row.saved?.steps.length,
      hasDraft: !!row.draft,
    })),
    tasks: {
      dispatchEnabled: tasks.dispatchEnabled,
      plans: tasks.plans.length,
      maxConcurrentProfiles: tasks.settings.maxConcurrentProfiles,
    },
  },
  desktop: [source, packaged].map((row, index) => ({
    target: index ? 'packaged-exe-migration' : 'source-fresh-database',
    ok: row.ok,
    electron: row.runtime.electron,
    node: row.runtime.node,
    sqlite: row.runtime.sqlite,
    databaseVersion: row.workspaceDatabaseVersion,
    seedVersion: row.seedSchemaVersion,
    preservedGroups: row.workspace.groups.length,
    preservedCombinations: row.workspace.combinations.length,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  limitations: {
    productionDispatcherStarted: false,
    stepActorsImplemented: false,
    accountIdentityImplemented: false,
    formalExtensionInstalledTest: false,
    materialConsumptionImplemented: false,
    facebookActionsThisStage: 0,
    fullInstallerTest: false,
    detectionRankingProven: false,
  },
};
await writeFile('audit/task-results.json', JSON.stringify(report, null, 2));
console.log(
  `Task core evidence recorded: ${checks.passed} checks, ${report.liveWorkspace.profiles} real profiles, ${tasks.plans.length} actual task plans; no credentials exported.`,
);
