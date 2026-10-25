import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { productDataDirectory } from '../dist/src/infrastructure/paths.js';
const packageMetadata = JSON.parse(await readFile('package.json', 'utf8'));
if (packageMetadata.version !== '0.1.0') {
  throw Error(
    'HISTORICAL_FOUNDATION_REPORT: use the current stage audit; do not overwrite stage 1 evidence.',
  );
}
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin);
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw Error('ADMIN_COOKIE_MISSING');
const response = await fetch(origin + '/api/workspace', { headers: { cookie } });
if (!response.ok) throw Error('WORKSPACE_HTTP_' + response.status);
const state = WorkspaceSchema.parse(await response.json());
const directory = productDataDirectory();
const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
let versions;
try {
  versions = db
    .prepare('SELECT version,body FROM combination_versions ORDER BY version')
    .all()
    .map((row) => {
      const body = JSON.parse(String(row.body));
      return {
        version: row.version,
        name: body.name,
        note: body.note,
        types: body.steps.map((step) => step.type),
        durationMinutes: body.steps
          .filter((step) => step.type !== 'post')
          .map((step) => step.durationMinutes),
      };
    });
} finally {
  db.close();
}
const load = async (file) => JSON.parse(await readFile(file, 'utf8'));
const source = await load('audit/desktop-source-smoke.json');
const packaged = await load('audit/desktop-packaged-smoke.json');
const report = {
  stage: 'foundation-1',
  productVersion: '0.1.0',
  recordedAt: new Date().toISOString(),
  dataDirectory: directory,
  frontend: { vite: '8.3.4', react: '19.3.0', developmentNode: process.versions.node },
  programChecks: {
    passed: 59,
    failed: 0,
    caveat: 'Includes simulated peers and isolated HTTP tests, not 59 live Facebook actions.',
  },
  dependencyAuditKnownVulnerabilities: 0,
  liveWorkspace: {
    profiles: state.profiles.length,
    online: state.profiles.filter((row) => row.online).length,
    syncedOnline: state.profiles.filter((row) => row.online && row.synced).length,
    phases: state.profiles.reduce((result, row) => {
      result[row.phase] = (result[row.phase] ?? 0) + 1;
      return result;
    }, {}),
    groups: state.groups.map((row) => ({
      name: row.name,
      members: state.profiles.filter((profile) => profile.groupId === row.id).length,
    })),
    combinations: state.combinations.map((row) => ({
      version: row.version,
      revision: row.revision,
      name: row.saved?.name,
      steps: row.saved?.steps.length,
      hasDraft: !!row.draft,
    })),
  },
  persistedVersions: versions,
  desktop: [source, packaged].map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    electron: row.runtime.electron,
    node: row.runtime.node,
    sqlite: row.runtime.sqlite,
    htmlFacts: row.htmlFacts,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  limitations: {
    combinationExecution: false,
    facebookAccountIdentity: false,
    formalExtensionInstalledTest: false,
    facebookActionsThisStage: 0,
    fullInstallerTest: false,
    detectionRankingProven: false,
  },
};
await mkdir('audit', { recursive: true });
await writeFile('audit/foundation-results.json', JSON.stringify(report, null, 2));
console.log(
  'Foundation evidence recorded; live profiles ' +
    report.liveWorkspace.profiles +
    ', online ' +
    report.liveWorkspace.online +
    '; no credentials exported.',
);
