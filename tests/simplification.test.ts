import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DraftSession } from '../src/renderer/draft-session.js';
import type { Combination, SavedCombination } from '../src/shared/contracts.js';
import { WorkspaceBackupService } from '../src/application/workspace-backup-service.js';
import { DirectMaterialUpload } from '../src/infrastructure/direct-material-upload.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { KernelOperationFileGrant } from '../src/shared/kernel-file-grant.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { settlementFixture, prepareBound, verifyBound } from './fixtures/settlement.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  deliverPostNotices,
} from './fixtures/material-post.js';
import { browseHarness } from './fixtures/browse.js';

const draft: Combination = {
  name: 'draft',
  note: '',
  steps: [],
  randomOrder: false,
  loop: { mode: 'finite', rounds: 1 },
};
const saved = (id: string, revision: number, value: Combination): SavedCombination => ({
  id,
  revision,
  draft: value,
  saved: null,
  version: 0,
  updatedAt: 0,
});
for (const applied of [false, true])
  test(`draft recovers a temporary save failure automatically; first committed=${applied}`, async () => {
    const id = randomUUID();
    let remote = saved(id, 3, draft),
      calls = 0;
    const session = new DraftSession(
      id,
      3,
      async (_id, revision, value) => {
        calls++;
        if (calls === 1) {
          if (applied) remote = saved(id, revision + 1, value);
          throw Error('NETWORK');
        }
        return (remote = saved(id, revision + 1, value));
      },
      draft,
      async () => remote,
    );
    const result = await session.write({ ...draft, name: 'changed' });
    assert.equal(result.revision, 4);
    assert.equal(result.draft?.name, 'changed');
    assert.equal(calls, applied ? 1 : 2);
    assert.equal(session.frozen, false);
  });
test('automatic save recovery does not overwrite a real conflicting version', async () => {
  const id = randomUUID();
  let calls = 0;
  const session = new DraftSession(
    id,
    3,
    async () => {
      calls++;
      throw Error('CONFLICT');
    },
    draft,
    async () => saved(id, 7, { ...draft, name: 'foreign edit' }),
  );
  await assert.rejects(session.write(draft));
  await assert.rejects(session.write(draft));
  assert.equal(calls, 1);
  assert.equal(session.frozen, true);
});
test('historical offline PAUSING does not block backup; current runtime execution still does', async () =>
  settlementFixture(async (store) => {
    let active = false;
    const tasks = Object.create(store.tasks) as typeof store.tasks;
    tasks.livePlans = () => {
      throw Error('must not scan historical plans');
    };
    const service = new WorkspaceBackupService(
      tasks,
      {
        write: async () => {
          throw Error('not invoked');
        },
      },
      undefined,
      () => active,
    );
    assert.equal((await service.status()).canCreate, true);
    active = true;
    assert.equal((await service.status()).canCreate, false);
  }));
test('clearing ended ordinary history deletes original rows and keeps foreign keys valid', async () =>
  settlementFixture(async (store, file) => {
    const f = prepareBound(store);
    verifyBound(store, f);
    deliverPostNotices(store, f.profile.id);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON');
    db.prepare("UPDATE task_plans SET state='COMPLETED' WHERE id=?").run(f.plan.id);
    const scope = { stepIds: [f.step.id] };
    assert.equal(store.dataCleanup.removeBatch(scope), 1);
    for (const table of [
      'task_plans',
      'task_steps',
      'task_outbox',
      'task_events',
      'task_dispatch_bindings',
      'task_settlement_notices',
      'task_record_deletions',
    ])
      assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n), 0, table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  }));
test('direct upload uses original paths, creates no cache, and rejects changed files and revoked input', async () =>
  postFixture(async (store, _file, catalog) => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
      'base64',
    );
    const original = path.join(catalog.directory, 'image.png');
    await writeFile(original, png);
    const indexed = store.materials.index(
      await new FilesystemMaterialScanner().scan(catalog.directory),
      randomUUID(),
    );
    const intent = store.materials.reserve(
      await postRequest(store, indexed, { source: 'image.png' }),
    ).intent;
    const op = await dispatchedPost(store, intent, 'OPEN_COMPOSER');
    assert.ok(op.binding);
    const before = await readdir(path.dirname(catalog.directory));
    const direct = new DirectMaterialUpload();
    let live = true;
    const current = () => {
      if (!live) throw Error('STOPPED');
    };
    const manifest = await direct.stage(intent, op.binding, current);
    const files = await direct.verify(intent, op.binding, manifest, current);
    assert.deepEqual(files, [original]);
    assert.equal(manifest.files[0]?.name, 'image.png');
    assert.deepEqual(await readdir(path.dirname(catalog.directory)), before);
    const grant = {
      binding: op.binding,
      action: {
        kind: 'uploadMedia',
        tabId: intent.proof.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: 'input[type=file]' },
        attemptId: intent.attemptId,
        fingerprint: intent.fingerprint,
      },
      proof: intent.proof,
      manifest,
      files,
    };
    assert.equal(KernelOperationFileGrant.safeParse(grant).success, true);
    assert.equal(
      KernelOperationFileGrant.safeParse({
        ...grant,
        files: [path.join(catalog.directory, 'foreign.png')],
      }).success,
      false,
    );
    const guard = direct.guard(intent, op.binding, manifest, current);
    const command = {
      target: { tabId: intent.proof.tabId },
      method: 'DOM.setFileInputFiles',
      params: { files },
    };
    await guard(command);
    await guard(command);
    live = false;
    await assert.rejects(guard(command), /STOPPED/);
    live = true;
    await writeFile(original, 'changed');
    await assert.rejects(guard(command), /SOURCE_CHANGED/);
  }));
test('source check can exceed thirty seconds while making progress, but rejects a stalled read', async () =>
  settlementFixture(async (store) => {
    const combo = store.createCombination({
      ...draft,
      name: 'resource',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const row = {
      id: randomUUID(),
      text: 'text',
      background: 'plain' as const,
      purpose: 'both' as const,
      media: [],
    };
    store.resourceTables.save(combo.id, 0, [row]);
    let now = 0;
    const service = new ResourceTableService(
      store.resourceTables,
      {
        verify: async (_row, current) => {
          for (let i = 0; i < 5; i++) {
            now += 20_000;
            await current(1);
          }
          return { verified: false as const, issue: 'EMPTY' as const };
        },
      },
      () => now,
    );
    assert.equal(
      (await service.checkSources({ combinationId: combo.id, expectedRevision: 1 })).rows.length,
      1,
    );
    const stalled = new ResourceTableService(
      store.resourceTables,
      {
        verify: async (_row, current) => {
          now += 30_001;
          await current();
          return { verified: false as const, issue: 'EMPTY' as const };
        },
      },
      () => now,
    );
    await assert.rejects(stalled.checkSources({ combinationId: combo.id, expectedRevision: 1 }));
  }));
test('an acknowledged pure scroll timeout is cancelled without unknown, progress or repeat business input', async () =>
  settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      ...draft,
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    Object.assign(h.host, { supportsControlRelease: () => true });
    const plan = await h.claim();
    const executor = h.executors.find((e) => e.type === 'feed')!;
    executor.decide = async (e) => ({
      kind: 'action',
      action: {
        kind: 'browseScroll',
        tabId: h.sample(e).proof.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        url: 'https://www.facebook.com/',
        timeOrigin: 1,
        fromY: 0,
        deltaY: 500,
      },
      intent: {
        kind: 'auxiliary',
        purpose: 'advance',
        proof: h.sample(e).proof,
        documentEpoch: 0,
        routeEpoch: 0,
      },
    });
    assert.equal((await h.runner.advance(plan.id)).status, 'DISPATCHED');
    executor.verify = async (_e, op) => ({
      outcome: 'WAIT',
      reason: 'FACEBOOK_BROWSE_EFFECT_PENDING',
      receipt: { binding: op.binding, evidence: {} },
    });
    await h.runner.advance(plan.id);
    h.clock.at = 31_000;
    await h.runner.advance(plan.id);
    const op = store.tasks.operations(plan.id)[0]!;
    assert.equal(op.status, 'CANCELLED');
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 0);
    assert.equal(store.tasks.settlements.list()[0]?.resolution.outcome, 'CONTROL_RELEASED');
    // The original notification is delivered before the next control input can start.
    await h.host.observe(plan.profileId);
    assert.equal(store.tasks.settlements.list()[0]?.state, 'DELIVERED');
    assert.ok(await h.host.session(plan.profileId));
    await h.runner.advance(plan.id);
    assert.equal(h.inputs.get(plan.profileId), 2);
  }));
