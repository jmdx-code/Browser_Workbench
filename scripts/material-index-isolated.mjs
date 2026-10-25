import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';

const reportFile = path.resolve('audit/material-index-isolated.json');
// New foundation proof, not a replay of any native browser or historical automation audit.
const original = JSON.parse(await readFile('audit/material-preflight-http-live.json', 'utf8'));
const directory = path.resolve(original.directory),
  audit = path.resolve('audit');
if (
  !original.generatedFixture ||
  original.userResourceDirectoriesRead ||
  path.dirname(directory) !== audit ||
  !path.basename(directory).startsWith('material-preflight-fixture-')
)
  throw Error('GENERATED_FIXTURE_REQUIRED');
async function hashes(root) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw Error('FIXTURE_LINK_REJECTED');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        result.push({
          file: path.relative(root, file),
          hash: createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        });
    }
  }
  await visit(root);
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
const before = await hashes(directory),
  isolated = await mkdtemp(path.join(audit, 'material-index-isolated-')),
  file = path.join(isolated, 'workspace.sqlite');
let store = await WorkspaceStore.open(file);
try {
  const scan = await new FilesystemMaterialScanner().scan(directory),
    catalog = store.materials.index(scan, randomUUID());
  assert.equal(catalog.sources.length, 5);
  assert.equal(new Set(catalog.sources.map((source) => source.snapshot.format)).size, 4);
  assert.equal(new Set(catalog.sources.map((source) => source.snapshot.fingerprint)).size, 4);
  const source = catalog.sources.find((item) => item.snapshot.source === 'text.txt');
  assert.ok(source);
  function simulatedRequest() {
    const profileId = randomUUID(),
      accountId = 'isolated-material-fixture-' + randomUUID(),
      profile = {
        id: profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: accountId, name: null, avatar: null },
      };
    const saved = store.createCombination({
      name: '生成素材事务验收',
      note: '仅模拟任务身份，无原生浏览器',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          resourceDirectory: directory,
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: true,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    store.tasks.assign(
      { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [profileId] },
      [profile],
    );
    const plan = store.tasks.claimNext([profile], new Set(['post']));
    assert.ok(plan);
    const step = store.tasks.steps(plan.id)[0];
    assert.ok(step);
    const context = {
        profileId,
        accountId,
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 0,
      },
      proof = {
        profileId,
        ownershipId: randomUUID(),
        browserSessionEpoch: randomUUID(),
        tabId: 42,
        targetId: randomUUID(),
      };
    store.taskTabs.register(plan.id, proof, context);
    return {
      attemptId: randomUUID(),
      jobId: plan.id,
      stepId: step.id,
      expectedProgressRevision: 0,
      catalogId: catalog.id,
      sourceId: source.id,
      context,
      proof,
    };
  }
  const first = simulatedRequest(),
    second = simulatedRequest(),
    held = store.materials.reserve(first);
  assert.throws(() => store.materials.reserve(second), /MATERIAL_CONTENT_RESERVED/);
  assert.deepEqual(store.materials.reserve(first), held);
  assert.equal(store.tasks.operations(first.jobId).length, 0);
  store.close();
  store = await WorkspaceStore.open(file);
  assert.deepEqual(store.materials.reservation(first.attemptId), held);
  assert.equal(store.tasks.get(first.jobId).state, 'RUNNING');
  store.tasks.recoverOnStartup();
  assert.equal(store.materials.reservation(first.attemptId).state, 'REVIEW');
  assert.equal(store.tasks.get(first.jobId).state, 'REVIEW');
  assert.deepEqual(store.materials.reservation(first.attemptId).intent, held.intent);
  const db = new DatabaseSync(file, { readOnly: true });
  let facts;
  try {
    facts = {
      schema: db.prepare('PRAGMA user_version').get().user_version,
      catalogs: db.prepare('SELECT count(*) AS n FROM material_catalogs').get().n,
      contents: db.prepare('SELECT count(*) AS n FROM material_contents').get().n,
      sources: db.prepare('SELECT count(*) AS n FROM material_sources').get().n,
      intents: db.prepare('SELECT count(*) AS n FROM material_post_intents').get().n,
      reservations: db.prepare('SELECT count(*) AS n FROM material_reservations').get().n,
      outbox: db.prepare('SELECT count(*) AS n FROM task_outbox').get().n,
      originalAccountLockHeld:
        db
          .prepare('SELECT job_id FROM task_account_locks WHERE account_id=?')
          .get(first.context.accountId)?.job_id === first.jobId,
    };
  } finally {
    db.close();
  }
  assert.equal(facts.originalAccountLockHeld, true);
  const after = await hashes(directory);
  assert.deepEqual(after, before);
  const report = {
    state: 'PASSED',
    recordedAt: new Date().toISOString(),
    softwareVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
    generatedFixture: true,
    simulatedTasksAndIdentities: true,
    userResourceDirectoriesRead: false,
    nativeBrowserOperations: 0,
    published: false,
    archived: false,
    productionEnabled: false,
    database: file,
    directory,
    checks: {
      fourFormatsIndexed: true,
      globalContentDedupe: true,
      reservationAndIntentAtomic: true,
      duplicateClaimRejected: true,
      reopenPassive: true,
      explicitRecoveryHolds: true,
      originalIntentPreserved: true,
      originalAccountLockHeld: true,
      sourceFilesUnchanged: true,
    },
    facts,
    sourceAnchors: catalog.sources.map((item) => item.snapshot.source),
    hashes: after,
  };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({ state: report.state, facts, database: file, sourceFilesUnchanged: true }),
  );
} finally {
  store.close();
}
