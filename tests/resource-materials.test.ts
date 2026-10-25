import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  readFile,
  rm,
  readdir,
  rmdir,
  chmod,
  lstat,
} from 'node:fs/promises';
import { PublicDriveDownloader } from '../src/infrastructure/public-drive-download.js';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemResourceMaterialVerifier } from '../src/infrastructure/resource-material-verifier.js';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { FilesystemMaterialArchivePlanner } from '../src/infrastructure/material-archive-planner.js';
import { FilesystemMaterialArchiveExecutor } from '../src/infrastructure/material-archive-executor.js';
import { ResourceMaterialPreparation } from '../src/application/resource-material-preparation.js';
import { FacebookPostStepExecutor } from '../src/infrastructure/facebook-post-step-executor.js';
import type {
  FacebookPostPageReading,
  FacebookPostPageSource,
} from '../src/domain/facebook-post-execution.js';
import {
  FACEBOOK_BACKGROUND_OPTIONS,
  facebookBackgroundScope,
  nativeSolidBackgrounds,
  nativeBackgroundCSS,
} from '../src/shared/facebook-background.js';
import { FACEBOOK_COMPOSER_TEXT, FACEBOOK_COMPOSER_FILES } from '../src/shared/facebook-ui.js';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../src/application/material-upload-preparation.js';
import { PersistentMaterialUploadStage } from '../src/application/persistent-material-upload-stage.js';
import { MaterialArchivePreparation } from '../src/application/material-archive-preparation.js';
import { mediaReference } from '../src/domain/resource-table.js';
import {
  ResourceMaterialPostIntent,
  DirectoryMaterialPostIntent,
  type ReservationRequest,
} from '../src/shared/material-index.js';
import type { ResourceRowValue } from '../src/shared/resource-table.js';
import { dispatchedPost, postReceipt, deliverPostNotices } from './fixtures/material-post.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';

const noop = () => {};
test('colored table resource uses original background operations and independent effects before text; ACK never becomes a plain post or consumes the resource', async () =>
  fixture(async (store, _file, _dir, db) => {
    const saved = { ...row('生成彩贴正文'), background: 'color' as const };
    const { assigned, profiles } = await plans(store, [saved]);
    const planId = assigned[0]?.id,
      profile = profiles[0];
    assert.ok(planId && profile);
    const preparation = new ResourceMaterialPreparation(
      store.tasks.resources,
      new FilesystemResourceMaterialVerifier(),
      store.materials,
      undefined,
      undefined,
      true,
    );
    const prepared = await preparation.prepare(planId, randomUUID(), noop);
    assert.equal(prepared.blocked.length, 0);
    assert.equal(prepared.catalog.sources.length, 1);
    const input = await simulatedActor(store, db, planId, profile.account.id, prepared.catalog.id);
    const held = await store.materials.reserveNextResource(input),
      request = { ...input, sourceId: held.intent.sourceId };
    const opened = await dispatchedPost(store, request, 'OPEN_COMPOSER');
    await store.materialPosts.verify(await postReceipt(store, request, opened));
    await deliverPostNotices(store, input.context.profileId);
    const step = (await store.tasks.steps(planId))[0];
    assert.ok(step);
    const reading: FacebookPostPageReading = {
      context: input.context,
      proof: input.proof,
      observedAccountId: input.context.accountId,
      documentEpoch: 0,
      routeEpoch: 0,
      timeOrigin: 1000,
      url: 'https://www.facebook.com/',
      locale: 'en_US',
      opener: null,
      text: '',
      surface: {
        scope: facebookBackgroundScope,
        textCSS: FACEBOOK_COMPOSER_TEXT,
        mediaCSS: FACEBOOK_COMPOSER_FILES,
        phase: 'direct-submit',
        advance: null,
        submit: null,
        purposeVerified: false,
        actingIdentityVerified: false,
        contentVerified: false,
      },
      background: {
        url: 'https://www.facebook.com/',
        timeOrigin: 1000,
        ready: true,
        visible: true,
        draftEmpty: true,
        phase: 'plain',
        openCSS: FACEBOOK_BACKGROUND_OPTIONS,
        clearCSS: null,
        selectedCSS: null,
        options: [],
      },
    };
    const source: FacebookPostPageSource = {
      ready: () => true,
      catalogId: () => prepared.catalog.id,
      read: async (_e, guard) => {
        await guard();
        return structuredClone(reading);
      },
      verifyBusiness: async () => {
        throw Error('NO_PUBLICATION_IN_THIS_TEST');
      },
    };
    const executor = new FacebookPostStepExecutor(
      store.tasks,
      store.materialPosts,
      source,
      randomUUID,
    );
    const execution = { plan: await store.tasks.get(planId), step, session: input.context };
    const opening = await executor.decide(execution, [held], noop);
    assert.equal(opening.kind, 'action');
    if (opening.kind !== 'action') throw Error('EXPECTED_ACTION');
    assert.equal(opening.operation.purpose, 'OPEN_BACKGROUND');
    await store.materialPosts.prepare(opening.operation);
    let op = await store.tasks.takeBoundOperation(input.context);
    assert.ok(op?.binding);
    await store.tasks.acknowledgeBound({ binding: op.binding, evidence: { generated: true } });
    assert.equal(
      (
        await executor.verify(
          execution,
          { ...op, binding: op.binding, status: 'ACKNOWLEDGED' },
          { intent: held.intent, link: await store.materialPosts.link(op.id) },
          noop,
        )
      ).kind,
      'wait',
    );
    const bg = reading.background;
    assert.ok(bg);
    const css = nativeBackgroundCSS(nativeSolidBackgrounds[0].label);
    bg.options = [{ id: 'red', css }];
    let verdict = await executor.verify(
      execution,
      { ...op, binding: op.binding, status: 'ACKNOWLEDGED' },
      { intent: held.intent, link: await store.materialPosts.link(op.id) },
      noop,
    );
    assert.equal(verdict.kind, 'verified');
    if (verdict.kind !== 'verified') throw Error('EXPECTED_VERDICT');
    await store.materialPosts.verify(verdict.receipt);
    await deliverPostNotices(store, input.context.profileId);
    const selecting = await executor.decide(execution, [held], noop);
    assert.equal(selecting.kind, 'action');
    if (selecting.kind !== 'action') throw Error('EXPECTED_ACTION');
    assert.equal(selecting.operation.purpose, 'SET_BACKGROUND');
    await store.materialPosts.prepare(selecting.operation);
    op = await store.tasks.takeBoundOperation(input.context);
    assert.ok(op?.binding);
    await store.tasks.acknowledgeBound({ binding: op.binding, evidence: { generated: true } });
    assert.equal(
      (
        await executor.verify(
          execution,
          { ...op, binding: op.binding, status: 'ACKNOWLEDGED' },
          { intent: held.intent, link: await store.materialPosts.link(op.id) },
          noop,
        )
      ).kind,
      'wait',
    );
    bg.phase = 'solid';
    bg.selectedCSS = css;
    verdict = await executor.verify(
      execution,
      { ...op, binding: op.binding, status: 'ACKNOWLEDGED' },
      { intent: held.intent, link: await store.materialPosts.link(op.id) },
      noop,
    );
    assert.equal(verdict.kind, 'verified');
    if (verdict.kind !== 'verified') throw Error('EXPECTED_VERDICT');
    await store.materialPosts.verify(verdict.receipt);
    await deliverPostNotices(store, input.context.profileId);
    const text = await executor.decide(execution, [held], noop);
    assert.equal(text.kind, 'action');
    if (text.kind === 'action') assert.equal(text.operation.purpose, 'SET_TEXT');
    assert.equal(count(db, 'material_publications'), 0);
    assert.equal((await store.tasks.steps(planId))[0]?.progress.published, 0);
    bg.phase = 'plain';
    bg.selectedCSS = null;
    await assert.rejects(executor.decide(execution, [held], noop), /POST_BACKGROUND_CHANGED/);
  }));
test('public Drive cached image/video use original pinned catalog, upload journal, independent consumption and reopen; input source checks never re-download', async () =>
  fixture(async (store, file, dir, db) => {
    const video = await readFile('public/sample.mp4');
    for (const [ordinal, bytes] of [png, video].entries()) {
      const saved = row(ordinal ? '' : '公开网盘图文', [
        'https://drive.google.com/file/d/public_' + ordinal + '/view',
      ]);
      const { assigned, profiles } = await plans(store, [saved]);
      let requests = 0;
      const reader = new FilesystemResourceMaterialVerifier(
        undefined,
        undefined,
        new PublicDriveDownloader(path.join(dir, 'drive-cache'), undefined, async () => {
          requests++;
          return new Response(new Uint8Array(bytes).buffer, {
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes.length),
            },
          });
        }),
      );
      const prepared = await new ResourceMaterialPreparation(
        store.tasks.resources,
        reader,
        store.materials,
      ).prepare(assigned[0]!.id, randomUUID(), noop);
      const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        prepared.catalog.id,
      );
      const held = await store.materials.reserveNextResource(input);
      const intent = ResourceMaterialPostIntent.parse(held.intent);
      const request = { ...input, sourceId: intent.sourceId };
      assert.deepEqual(intent.resource.row, saved);
      assert.equal(held.intent.snapshot.format, ordinal ? 'video' : 'single-image');
      const upload = await dispatchedPost(
        store,
        { ...input, sourceId: held.intent.sourceId },
        'UPLOAD_MEDIA',
      );
      const sourceCheck = new MaterialPostSourceCheck(
        store.materials,
        store.materialPosts,
        store.taskTabs,
        new FilesystemMaterialSourceVerifier(),
      );
      await sourceCheck.check(upload.binding, noop);
      const cache = new FilesystemMaterialUploadStage(path.join(dir, 'upload-' + ordinal));
      const manifest = await cache.stage(held.intent, upload.binding, noop);
      const paths = await cache.verify(held.intent, upload.binding, manifest, noop);
      assert.deepEqual(await readFile(paths[0]!), bytes);
      assert.equal(requests, 1);
      await store.materialPosts.verify(await postReceipt(store, request, upload));
      await deliverPostNotices(store, input.context.profileId);
      const submit = await dispatchedPost(store, { ...input, sourceId: held.intent.sourceId });
      assert.equal(
        (await store.resourceTables.usageSummaries()).find(
          (s) => s.combinationId === intent.resource.combinationId,
        )?.published,
        0,
      );
      await store.materialPosts.verify(await postReceipt(store, request, submit));
      await deliverPostNotices(store, input.context.profileId);
      const archived = await new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ).prepare(input.attemptId);
      await new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(input.attemptId);
      assert.equal(await store.archiveExecution.completed(input.attemptId), true);
      assert.ok(archived.plan?.version === 2);
      for (const item of archived.plan.files)
        assert.deepEqual(await readFile(item.sourcePath), await readFile(item.targetPath));
      const reopened = await WorkspaceStore.open(file);
      try {
        assert.deepEqual(
          reopened.materials.reservation(input.attemptId),
          await store.materials.reservation(input.attemptId),
        );
      } finally {
        reopened.close();
      }
      const downloaded = intent.snapshot.downloads?.[0];
      assert.ok(downloaded);
      await chmod(downloaded.path, 0o600);
      await writeFile(downloaded.path, Buffer.concat([bytes, Buffer.from([1])]));
      await assert.rejects(
        new FilesystemMaterialSourceVerifier().verify(held.intent, noop),
        /SOURCE_CHANGED/,
      );
      assert.equal(requests, 1);
      assert.equal((await store.materialPosts.result(input.attemptId))?.outcome, 'PUBLISHED');
    }
  }));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
  'base64',
);
const row = (text: string, media: string[] = []): ResourceRowValue => ({
  id: randomUUID(),
  text,
  media: media.map(mediaReference),
  background: 'plain',
});
async function fixture(
  run: (store: WorkspaceStore, file: string, dir: string, db: DatabaseSync) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-resource-materials-')),
    file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file),
    db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec("UPDATE material_usage_policy SET file_policy='archive-test' WHERE id=1");
  try {
    await run(store, file, dir, db);
  } finally {
    db.close();
    store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.ok(path.basename(dir).startsWith('wb-resource-materials-'));
    await rm(dir, { recursive: true, force: true });
  }
}
async function plans(
  store: WorkspaceStore,
  rows: ResourceRowValue[],
  count = 1,
  allowRepeat = false,
  directory?: string,
  destination?: 'post' | 'story',
) {
  const combination = await store.createCombination({
    name: '生成资源表发布事务',
    note: '所有账号/原生目标/发布结果均模拟，非FB验收',
    steps: [
      {
        id: randomUUID(),
        type: 'post',
        destination,
        resourceMode: 'table',
        resourceDirectory: '',
        count: 2,
        allowRepeat,
        forbidSameAccountRepeat: true,
        archivePublished: true,
      },
      ...(directory
        ? [
            {
              id: randomUUID(),
              type: 'post' as const,
              resourceMode: 'directory' as const,
              resourceDirectory: directory,
              count: 1,
              allowRepeat: false,
              forbidSameAccountRepeat: true as const,
              archivePublished: true as const,
            },
          ]
        : []),
    ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  await store.resourceTables.save(combination.id, 0, rows);
  const profiles = Array.from({ length: count }, () => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: {
      state: 'logged-in' as const,
      id: 'generated-account-' + randomUUID(),
      name: null,
      avatar: null,
    },
  }));
  const assigned = await store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combination.id,
      version: 1,
      expectedResourceRevision: 1,
      profileIds: profiles.map((profile) => profile.id),
    },
    profiles,
  );
  assert.equal(await store.tasks.claimNext(profiles, new Set(['post'])), null);
  return { combination, assigned, profiles };
}
// Explicit test-only actor/identity setup. Production table claim remains disabled.
async function simulatedActor(
  store: WorkspaceStore,
  db: DatabaseSync,
  jobId: string,
  accountId: string,
  catalogId: string,
  stepIndex = 0,
): Promise<Omit<ReservationRequest, 'sourceId'>> {
  const plan = await store.tasks.get(jobId),
    step = (await store.tasks.steps(jobId))[stepIndex];
  assert.ok(step);
  db.prepare(
    "UPDATE task_plans SET state='RUNNING',reason='',account_id=?,position=? WHERE id=?",
  ).run(accountId, step.position, jobId);
  db.prepare("UPDATE task_steps SET status='ACTIVE' WHERE id=?").run(step.id);
  db.prepare('INSERT INTO task_account_locks VALUES(?,?)').run(accountId, jobId);
  const context = {
      profileId: plan.profileId,
      accountId,
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
    },
    proof = {
      profileId: plan.profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
  await store.taskTabs.register(jobId, proof, context);
  return {
    attemptId: randomUUID(),
    jobId,
    stepId: step.id,
    expectedProgressRevision: 0,
    catalogId,
    context,
    proof,
  };
}
const prepare = (store: WorkspaceStore) =>
  new ResourceMaterialPreparation(
    store.tasks.resources,
    new FilesystemResourceMaterialVerifier(),
    store.materials,
  );
const count = (db: DatabaseSync, table: string) =>
  Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n);

test('reference archive IO preserves other current or pinned captions, moves exclusive sources and archives inline text without inventing files', async () => {
  for (const kind of ['current', 'pinned', 'exclusive', 'inline', 'repeat-edited'])
    await fixture(async (store, _file, dir, db) => {
      const image = path.join(dir, 'archive.png');
      await writeFile(image, png);
      const own = row('原文案', kind === 'inline' ? [] : [image]);
      const shared = row('另一个待发文案', [image]);
      const saved = kind === 'current' || kind === 'pinned' ? [own, shared] : [own];
      const { combination, assigned, profiles } = await plans(store, saved);
      const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
      if (kind === 'pinned') await store.resourceTables.save(combination.id, 1, [own]);
      const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        catalog.id,
      );
      const held = await store.materials.reserveNextResource(input),
        request = { ...input, sourceId: held.intent.sourceId };
      if (kind !== 'inline') {
        const upload = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
        await store.materialPosts.verify(await postReceipt(store, request, upload));
        await deliverPostNotices(store, input.context.profileId);
      }
      const submit = await dispatchedPost(store, request);
      await store.materialPosts.verify(await postReceipt(store, request, submit));
      await deliverPostNotices(store, input.context.profileId);
      if (kind === 'repeat-edited') {
        assert.ok(combination.saved);
        const draft = await store.writeDraft(combination.id, combination.revision, {
          ...combination.saved,
          steps: combination.saved.steps.map((s) =>
            s.type === 'post' ? { ...s, allowRepeat: true } : s,
          ),
        });
        await store.publish(combination.id, draft.revision);
      }
      const ready = await new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ).prepare(input.attemptId);
      await new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(input.attemptId);
      assert.equal(await store.archiveExecution.completed(input.attemptId), true);
      assert.ok(ready.plan?.version === 2);
      if (kind === 'exclusive') await assert.rejects(lstat(image), { code: 'ENOENT' });
      else assert.deepEqual(await readFile(image), png);
      for (const f of ready.plan.files) assert.deepEqual(await readFile(f.targetPath), png);
      assert.equal(ready.plan.files.length, kind === 'inline' ? 0 : 1);
      assert.equal(
        (await store.resourceTables.usageSummaries()).find(
          (s) => s.combinationId === combination.id,
        )?.published,
        1,
      );
      if (kind === 'inline')
        await assert.rejects(lstat(path.join(dir, '已发')), { code: 'ENOENT' });
    });
});
test('original source lock blocks concurrent table edits and catalogs until confirmed archive completion', async () =>
  fixture(async (store, file, dir, db) => {
    const image = path.join(dir, 'locked.png');
    await writeFile(image, png);
    const own = row('独占资源', [image]);
    const { combination, assigned, profiles } = await plans(store, [own]);
    const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
    const input = await simulatedActor(
      store,
      db,
      assigned[0]!.id,
      profiles[0]!.account.id,
      catalog.id,
    );
    const held = await store.materials.reserveNextResource(input),
      request = { ...input, sourceId: held.intent.sourceId };
    const upload = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    await store.materialPosts.verify(await postReceipt(store, request, upload));
    await deliverPostNotices(store, input.context.profileId);
    const submit = await dispatchedPost(store, request);
    await store.materialPosts.verify(await postReceipt(store, request, submit));
    await deliverPostNotices(store, input.context.profileId);
    await new MaterialArchivePreparation(
      store.archivePreparation,
      new FilesystemMaterialArchivePlanner(),
    ).prepare(input.attemptId);
    const claim = await store.archiveExecution.claim(input.attemptId);
    assert.equal(await store.archiveExecution.protectSource(claim, image), 'DELETE');
    const other = await WorkspaceStore.open(file);
    try {
      assert.throws(
        () => other.resourceTables.save(combination.id, 1, [own, row('新共享文案', [image])]),
        /SOURCE_ARCHIVING/,
      );
      const scan = await new FilesystemMaterialScanner().scan(dir);
      assert.throws(() => other.materials.index(scan, randomUUID()), /SOURCE_ARCHIVING/);
      assert.equal(other.resourceTables.revision(combination.id), 1);
      assert.equal(other.archiveExecution.recoverOnStartup(), 1);
      await new FilesystemMaterialArchiveExecutor(other.archiveExecution).execute(input.attemptId);
      assert.equal(other.archiveExecution.completed(input.attemptId), true);
    } finally {
      other.close();
    }
  }));

test('reference archives retain real parents, ordered members and repeat sources; changed bytes and occupied destinations reject planning', async () =>
  fixture(async (store, _file, dir, db) => {
    const first = path.join(dir, 'first'),
      second = path.join(dir, 'second');
    await mkdir(first);
    await mkdir(second);
    const image = path.join(first, 'a.png'),
      other = path.join(second, 'b.png');
    await writeFile(image, png);
    await writeFile(other, Buffer.concat([png, Buffer.from([1])]));
    for (const allowRepeat of [false, true]) {
      const resource = row('引用归档 ' + allowRepeat, [other, image]);
      const { assigned, profiles } = await plans(store, [resource], 1, allowRepeat);
      const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
      const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        catalog.id,
      );
      const held = await store.materials.reserveNextResource(input),
        request = { ...input, sourceId: held.intent.sourceId };
      const upload = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
      await store.materialPosts.verify(await postReceipt(store, request, upload));
      await deliverPostNotices(store, input.context.profileId);
      const submit = await dispatchedPost(store, request);
      await store.materialPosts.verify(await postReceipt(store, request, submit));
      await deliverPostNotices(store, input.context.profileId);
      const pending = (await store.materialPosts.archives()).find(
        (a) => a.attemptId === input.attemptId,
      );
      assert.ok(pending);
      const planner = new FilesystemMaterialArchivePlanner();
      const prepared = await new MaterialArchivePreparation(
        store.archivePreparation,
        planner,
      ).prepare(input.attemptId);
      assert.equal(prepared.state, 'READY');
      assert.equal(prepared.plan?.version, 2);
      const plan = prepared.plan;
      assert.ok(plan?.version === 2);
      assert.deepEqual(
        plan.files.map((f) => f.sourcePath),
        [other, image],
      );
      assert.deepEqual(
        plan.files.map((f) => f.preserveSource),
        [allowRepeat, allowRepeat],
      );
      for (const [i, file] of plan.files.entries()) {
        assert.equal(
          path.dirname(path.dirname(path.dirname(file.targetPath))),
          path.dirname(file.sourcePath),
        );
        assert.equal(path.basename(path.dirname(path.dirname(file.targetPath))), '已发');
        assert.ok(path.basename(file.targetPath).startsWith(String(i + 1).padStart(3, '0') + '-'));
        assert.deepEqual(
          await readFile(file.sourcePath),
          i === 0 ? Buffer.concat([png, Buffer.from([1])]) : png,
        );
      }
      await mkdir(path.dirname(plan.files[0]!.targetPath), { recursive: true });
      await assert.rejects(planner.inspect(pending, noop), /DESTINATION_OCCUPIED/);
      // Only remove the empty test destination; source and original plan remain unchanged.
      await rmdir(path.dirname(plan.files[0]!.targetPath));
      if (allowRepeat) {
        await writeFile(image, Buffer.concat([png, Buffer.from([2])]));
        await assert.rejects(planner.inspect(pending, noop), /SOURCE_CHANGED/);
      }
      assert.throws(
        () =>
          db
            .prepare("UPDATE material_archive_state SET state='COMPLETED' WHERE attempt_id=?")
            .run(input.attemptId),
        /ARCHIVE_COMPLETION_PROOF_REQUIRED/,
      );
      assert.equal((await store.materials.reservation(input.attemptId)).state, 'PUBLISHED');
    }
  }));

test('a mixed table/directory combination counts only table-origin attempts without changing legacy reservations', async () =>
  fixture(async (store, _file, dir, db) => {
    const root = path.join(dir, 'legacy-source');
    await mkdir(root);
    await writeFile(path.join(root, 'source.txt'), '目录正文');
    const { assigned, profiles } = await plans(store, [row('表格正文')], 1, false, root);
    const catalog = await store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    const source = catalog.sources[0];
    assert.ok(source);
    const input = await simulatedActor(
      store,
      db,
      assigned[0]!.id,
      profiles[0]!.account.id,
      catalog.id,
      1,
    );
    const held = await store.materials.reserve({ ...input, sourceId: source.id });
    assert.equal(held.intent.directory, root);
    const usage = (await store.resourceTables.usageSummaries())[0]!;
    assert.equal(usage.remaining, 1);
    assert.equal(usage.pendingAttempts, 0);
    assert.equal(usage.published, 0);
    assert.equal((await store.materials.reservation(input.attemptId)).state, 'RESERVED');
  }));

test('editing the current resource table never hides an old UNKNOWN attempt or consumes the replacement; restoring unchanged rows retains publication history', async () =>
  fixture(async (store, file, _dir, db) => {
    const original = row('原固定正文'),
      other = row('另一正文'),
      empty = row('');
    const { combination, assigned, profiles } = await plans(store, [original, other, empty]);
    const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
    const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        catalog.id,
      ),
      held = await store.materials.reserveNextResource(input),
      request = { ...input, sourceId: held.intent.sourceId };
    await store.resourceTables.save(combination.id, 1, [other, original, empty]);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.total, 2);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.previousVersionPending, 0);
    const operation = await dispatchedPost(store, request),
      receipt = await postReceipt(store, request, operation);
    await store.tasks.markBoundUnknown(operation.binding, 'generated-unknown-old-revision');
    const changed = { ...original, text: '修改后正文' };
    await store.resourceTables.save(combination.id, 2, [other, changed, empty]);
    let usage = (await store.resourceTables.usageSummaries())[0]!;
    assert.equal(usage.remaining, 2);
    assert.equal(usage.reviewAttempts, 1);
    assert.equal(usage.previousVersionPending, 1);
    await store.materialPosts.reconcile(receipt);
    usage = (await store.resourceTables.usageSummaries())[0]!;
    assert.equal(usage.remaining, 2);
    assert.equal(usage.published, 0);
    assert.equal(usage.reviewAttempts, 0);
    await store.resourceTables.save(combination.id, 3, [original, other, row(original.text)]);
    usage = (await store.resourceTables.usageSummaries())[0]!;
    assert.equal(usage.total, 3);
    assert.equal(usage.remaining, 2);
    assert.equal(usage.published, 1);
    assert.equal(usage.verifiedReady, 0); // Duplicate rows are not three eligible contents.
    assert.equal((await store.resourceTables.summaries())[0]?.remaining, 3); // Frozen v1 wire meaning.
    const before = ['material_publications', 'material_attempt_verdicts', 'task_outbox'].map(
      (table) => count(db, table),
    );
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.resourceTables.usageSummaries(), [usage]);
      for (let index = 0; index < 3; index++) reopened.resourceTables.usageSummaries();
      const returned = reopened.resourceTables.usageSummaries();
      returned[0]!.remaining = 999;
      assert.deepEqual(reopened.resourceTables.usageSummaries(), [usage]);
      reopened.resourceTables.save(combination.id, 4, [other]);
      const latest = (await store.resourceTables.usageSummaries())[0]!;
      assert.equal(latest.revision, 5);
      assert.equal(latest.remaining, 1);
      assert.equal(latest.published, 0);
    } finally {
      reopened.close();
    }
    assert.deepEqual(
      ['material_publications', 'material_attempt_verdicts', 'task_outbox'].map((table) =>
        count(db, table),
      ),
      before,
    );
  }));

test('inline table text shares the original v1 fingerprint with legacy TXT content, so changing source mode does not reset dedupe history', async () =>
  fixture(async (store, _file, dir) => {
    const resource = row('同一正文');
    await writeFile(path.join(dir, 'generated-comparison.txt'), resource.text);
    const legacy = await store.materials.index(
      await new FilesystemMaterialScanner().scan(dir),
      randomUUID(),
    );
    const snapshot = await new FilesystemResourceMaterialVerifier().snapshot(resource, noop);
    assert.equal(legacy.sources[0]?.snapshot.fingerprint, snapshot.fingerprint);
    const { assigned } = await plans(store, [resource]);
    const catalog = await store.materials.indexResources(assigned[0]!.id, randomUUID(), [snapshot]);
    assert.equal(catalog.sources[0]?.snapshot.fingerprint, legacy.sources[0]?.snapshot.fingerprint);
  }));

test('UNKNOWN table submit keeps original occupancy across reopen, blocks normal late success and settles only original explicit reconciliation', async () =>
  fixture(async (store, file, _dir, db) => {
    const { assigned, profiles } = await plans(store, [row('回执丢失测试')], 2);
    const first = assigned[0]!,
      second = assigned[1]!;
    const catalog = (await prepare(store).prepare(first.id, randomUUID(), noop)).catalog;
    const profile = profiles.find((profile) => profile.id === first.profileId);
    assert.ok(profile);
    const input = await simulatedActor(store, db, first.id, profile.account.id, catalog.id),
      held = await store.materials.reserveNextResource(input),
      request = { ...input, sourceId: held.intent.sourceId };
    const operation = await dispatchedPost(store, request),
      receipt = await postReceipt(store, request, operation);
    await store.tasks.markBoundUnknown(operation.binding, 'generated-lost-response');
    assert.equal((await store.materials.reservation(input.attemptId)).state, 'REVIEW');
    assert.equal((await store.resourceTables.usageSummaries())[0]?.remaining, 1);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.reviewAttempts, 1);
    await assert.rejects(
      async () => await store.materialPosts.verify(receipt),
      /POST_EXPLICIT_RECONCILIATION_REQUIRED/,
    );
    await assert.rejects(
      async () => await store.materialPosts.cancelUnsent(input.attemptId),
      /POST_ATTEMPT_DISPATCHED/,
    );
    const secondCatalog = (await prepare(store).prepare(second.id, randomUUID(), noop)).catalog;
    const secondProfile = profiles.find((profile) => profile.id === second.profileId);
    assert.ok(secondProfile);
    const secondInput = await simulatedActor(
      store,
      db,
      second.id,
      secondProfile.account.id,
      secondCatalog.id,
    );
    await assert.rejects(
      async () => await store.materials.reserveNextResource(secondInput),
      /MATERIAL_NO_ELIGIBLE_RESOURCE/,
    );
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.materials.reservation(input.attemptId).state, 'REVIEW');
    } finally {
      reopened.close();
    }
    assert.equal(count(db, 'material_publications'), 0);
    await store.materialPosts.reconcile(receipt);
    assert.equal(count(db, 'material_publications'), 1);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.remaining, 0);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.reviewAttempts, 0);
    await assert.rejects(
      async () => await store.materials.reserveNextResource(secondInput),
      /MATERIAL_NO_ELIGIBLE_RESOURCE/,
    );
  }));

test('table SUBMIT notification failure rolls back consumption, progress and archive in the original transaction; verified nonpublication permits a new attempt', async () =>
  fixture(async (store, _file, _dir, db) => {
    const { assigned, profiles } = await plans(store, [row('事务回滚')]);
    const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
    const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        catalog.id,
      ),
      held = await store.materials.reserveNextResource(input),
      request = { ...input, sourceId: held.intent.sourceId };
    const operation = await dispatchedPost(store, request);
    db.exec(
      "CREATE TRIGGER generated_fail_table_notice BEFORE INSERT ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'GENERATED_NOTICE_FAILURE'); END",
    );
    await assert.rejects(
      async () => await store.materialPosts.verify(await postReceipt(store, request, operation)),
      /GENERATED_NOTICE_FAILURE/,
    );
    assert.equal((await store.materials.reservation(input.attemptId)).state, 'RESERVED');
    assert.equal((await store.resourceTables.usageSummaries())[0]?.remaining, 1);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.pendingAttempts, 1);
    for (const table of [
      'material_publications',
      'material_attempt_verdicts',
      'material_archive_requests',
    ])
      assert.equal(count(db, table), 0);
    assert.equal((await store.tasks.steps(input.jobId))[0]?.progress.published, 0);
    db.exec('DROP TRIGGER generated_fail_table_notice');
    await store.materialPosts.verify(await postReceipt(store, request, operation, 'NOT_PUBLISHED'));
    assert.equal((await store.resourceTables.usageSummaries())[0]?.remaining, 1);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.pendingAttempts, 0);
    await deliverPostNotices(store, input.context.profileId);
    const next = await store.materials.reserveNextResource({ ...input, attemptId: randomUUID() });
    assert.equal(next.intent.fingerprint, held.intent.fingerprint);
    assert.equal(count(db, 'material_publications'), 0);
  }));

test('table-native sources preserve four formats and inline captions without creating TXT or source folders; changed references cannot alter pinned plans', async () =>
  fixture(async (store, file, dir) => {
    const image = path.join(dir, 'a.png'),
      other = path.join(dir, 'b.png'),
      video = path.join(dir, 'v.mp4');
    await writeFile(image, png);
    await copyFile(image, other);
    await copyFile(path.resolve('public/sample.mp4'), video);
    const rows = [
      row('纯正文'),
      row('单图配文', [image]),
      row('相册', [other, image]),
      row('', [video]),
    ];
    const before = await readdir(dir),
      { combination, assigned } = await plans(store, rows);
    await store.resourceTables.save(combination.id, 1, [row('新表不改旧任务')]);
    const result = await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop);
    assert.deepEqual(result.blocked, []);
    assert.equal(result.inputPermission, false);
    assert.equal(result.catalog.resourceRevision, 1);
    assert.deepEqual(
      result.catalog.sources.map((source) => source.snapshot.format),
      ['text', 'single-image', 'multi-image', 'video'],
    );
    assert.equal(result.catalog.sources[0]?.snapshot.files.length, 0);
    assert.equal(result.catalog.sources[2]?.origin.row.media[0]?.source, other);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => !/workspace\.sqlite/.test(name)),
      before.filter((name) => !/workspace\.sqlite/.test(name)),
    );
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.materials.resourceCatalog(result.catalog.id), result.catalog);
    } finally {
      reopened.close();
    }
  }));

test('fifty generated actors use one content ledger and reserve distinct table rows atomically, including duplicate captions', async () =>
  fixture(async (store, _file, _dir, db) => {
    const rows = [
      row('内容1'),
      ...Array.from({ length: 60 }, (_, index) => row('内容' + (index + 1))),
    ];
    const { assigned, profiles } = await plans(store, rows, 50);
    const fingerprints = new Set<string>();
    const reader = new FilesystemResourceMaterialVerifier();
    let reads = 0;
    const worker = new ResourceMaterialPreparation(
      store.tasks.resources,
      {
        snapshot: async (row, current) => {
          reads++;
          return reader.snapshot(row, current);
        },
      },
      store.materials,
    );
    const result = await worker.prepareForPlans(
      assigned.map((plan) => plan.id),
      randomUUID(),
      noop,
    );
    for (const plan of assigned) {
      const profile = profiles.find((profile) => profile.id === plan.profileId);
      assert.ok(profile);
      const request = await simulatedActor(
        store,
        db,
        plan.id,
        profile.account.id,
        result.catalog.id,
      );
      const held = await store.materials.reserveNextResource(request);
      assert.equal(held.state, 'RESERVED');
      assert.ok(!fingerprints.has(held.intent.fingerprint));
      fingerprints.add(held.intent.fingerprint);
      assert.deepEqual(await store.materials.reserveNextResource(request), held);
    }
    assert.equal(fingerprints.size, 50);
    assert.equal(reads, rows.length);
    assert.equal(count(db, 'material_catalogs'), 1);
    assert.equal(count(db, 'material_reservations'), 50);
    assert.equal(count(db, 'material_publications'), 0);
    assert.equal(count(db, 'task_outbox'), 0);
    const usage = (await store.resourceTables.usageSummaries())[0];
    assert.equal(usage?.remaining, rows.length);
    assert.equal(usage?.pendingAttempts, 50);
    assert.equal(usage?.published, 0);
  }));

test('shared preparation rejects mixed pinned versions before source IO and original custom source budgets still apply to table media', async () =>
  fixture(async (store, _file, dir, db) => {
    const image = path.join(dir, 'budget.png');
    await writeFile(image, png);
    const resource = row('配文', [image]);
    const first = await plans(store, [resource]),
      second = await plans(store, [row('另一组合')]);
    let reads = 0;
    const worker = new ResourceMaterialPreparation(
      store.tasks.resources,
      {
        snapshot: async () => {
          reads++;
          throw Error('UNEXPECTED_IO');
        },
      },
      store.materials,
    );
    await assert.rejects(
      worker.prepareForPlans([first.assigned[0]!.id, second.assigned[0]!.id], randomUUID(), noop),
      /RESOURCE_MATERIAL_PLAN_SCOPE/,
    );
    assert.equal(reads, 0);
    assert.equal(count(db, 'material_catalogs'), 0);
    const catalog = (await prepare(store).prepare(first.assigned[0]!.id, randomUUID(), noop))
      .catalog;
    const input = await simulatedActor(
        store,
        db,
        first.assigned[0]!.id,
        first.profiles[0]!.account.id,
        catalog.id,
      ),
      held = await store.materials.reserveNextResource(input);
    await assert.rejects(
      new FilesystemMaterialSourceVerifier({
        entries: 3000,
        totalBytes: 1,
        textBytes: 262144,
        milliseconds: 30000,
      }).verify(held.intent, noop),
      /RESOURCE_MATERIAL_BUDGET/,
    );
    assert.equal(count(db, 'material_publications'), 0);
  }));

test('table text uses original outbox, independent SUBMIT settlement, shared consumption and pending archive; transport dispatch never consumes', async () =>
  fixture(async (store, file, _dir, db) => {
    const { assigned, profiles } = await plans(store, [row('明确发布正文'), row('另一个正文')]);
    const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
    const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        catalog.id,
      ),
      held = await store.materials.reserveNextResource(input);
    const intent = ResourceMaterialPostIntent.parse(held.intent),
      request = { ...input, sourceId: intent.sourceId };
    assert.equal(intent.directory, null);
    assert.equal(intent.resource.version, 1);
    assert.throws(() =>
      ResourceMaterialPostIntent.parse({ ...intent, resource: { ...intent.resource, version: 2 } }),
    );
    assert.equal(intent.snapshot.files.length, 0);
    assert.throws(() => DirectoryMaterialPostIntent.parse(intent));
    const text = await dispatchedPost(store, request, 'SET_TEXT');
    await new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      new FilesystemMaterialSourceVerifier(),
    ).check(text.binding, noop);
    await store.materialPosts.verify(await postReceipt(store, request, text, 'APPLIED'));
    await deliverPostNotices(store, input.context.profileId);
    assert.equal(count(db, 'material_publications'), 0);
    const submit = await dispatchedPost(store, request);
    assert.equal(count(db, 'material_publications'), 0);
    await store.tasks.acknowledgeBound({
      binding: submit.binding,
      evidence: { inputReturned: true },
    });
    assert.equal((await store.resourceTables.usageSummaries())[0]?.remaining, 2);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.pendingAttempts, 1);
    const receipt = await postReceipt(store, request, submit);
    await store.materialPosts.verify(receipt);
    await store.materialPosts.verify(receipt);
    assert.equal((await store.materials.reservation(input.attemptId)).state, 'PUBLISHED');
    assert.equal(count(db, 'material_publications'), 1);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.remaining, 1);
    assert.equal((await store.resourceTables.usageSummaries())[0]?.published, 1);
    assert.equal((await store.tasks.steps(input.jobId))[0]?.progress.published, 1);
    const archive = (await store.materialPosts.archives())[0];
    assert.ok(archive);
    assert.equal(archive.archiveDirectory, null);
    const referencePlan = await new FilesystemMaterialArchivePlanner().inspect(archive, noop);
    assert.equal(referencePlan.version, 2);
    assert.equal(referencePlan.files.length, 0);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(
        reopened.materials.reservation(input.attemptId),
        await store.materials.reservation(input.attemptId),
      );
      assert.deepEqual(
        reopened.resourceTables.usageSummaries(),
        await store.resourceTables.usageSummaries(),
      );
    } finally {
      reopened.close();
    }
    await deliverPostNotices(store, input.context.profileId);
    const next = await store.materials.reserveNextResource({
      ...input,
      attemptId: randomUUID(),
      expectedProgressRevision: 2,
    });
    assert.notEqual(next.intent.fingerprint, held.intent.fingerprint);
  }));

test('table image, ordered multi-image and pure video stage exact real bytes through original persistent uploader; source mutation rejects reuse', async () =>
  fixture(async (store, _file, dir, db) => {
    const image = path.join(dir, 'a.png'),
      second = path.join(dir, 'b.png'),
      video = path.join(dir, 'v.mp4');
    await writeFile(image, png);
    await writeFile(second, Buffer.concat([png, Buffer.from([0])]));
    await copyFile(path.resolve('public/sample.mp4'), video);
    for (const resource of [
      row('单图', [image]),
      row('有序相册', [second, image]),
      row('', [video]),
    ]) {
      const { assigned, profiles } = await plans(store, [resource]);
      const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
      const input = await simulatedActor(
          store,
          db,
          assigned[0]!.id,
          profiles[0]!.account.id,
          catalog.id,
        ),
        held = await store.materials.reserveNextResource(input),
        request = { ...input, sourceId: held.intent.sourceId };
      const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
      const source = new MaterialPostSourceCheck(
        store.materials,
        store.materialPosts,
        store.taskTabs,
        new FilesystemMaterialSourceVerifier(),
      );
      const disk = new FilesystemMaterialUploadStage(path.join(dir, 'owned-upload-cache'));
      const cache = new PersistentMaterialUploadStage(store.uploadStages, disk);
      const manifest = await new MaterialUploadPreparation(source, cache).prepare(
        operation.binding,
        noop,
      );
      const targets = await disk.verify(held.intent, operation.binding, manifest, noop);
      for (const [index, target] of targets.entries())
        assert.deepEqual(await readFile(target), await readFile(resource.media[index]!.source));
      assert.equal((await store.uploadStages.get(manifest.stageId)).state, 'READY');
      assert.equal(await store.materialPosts.result(input.attemptId), null);
      assert.equal(count(db, 'material_publications'), 0);
    }
    const snapshot = await new FilesystemResourceMaterialVerifier().snapshot(
      row('正文', [image]),
      noop,
    );
    const { assigned, profiles } = await plans(store, [
      { ...row('正文', [image]), id: snapshot.source },
    ]);
    const catalog = await store.materials.indexResources(assigned[0]!.id, randomUUID(), [snapshot]);
    const input = await simulatedActor(
        store,
        db,
        assigned[0]!.id,
        profiles[0]!.account.id,
        catalog.id,
      ),
      held = await store.materials.reserveNextResource(input);
    await writeFile(image, Buffer.concat([png, Buffer.from([1])]));
    await assert.rejects(
      new FilesystemMaterialSourceVerifier().verify(held.intent, noop),
      /RESOURCE_MATERIAL_SOURCE_CHANGED/,
    );
    assert.equal((await store.materials.reservation(input.attemptId)).state, 'RESERVED');
  }));

test('background, oversized text, missing file and Drive block specific rows; cancellation makes no partial catalog and preparation remains reusable', async () =>
  fixture(async (store, _file, dir, db) => {
    const rows = [
      row('可准备'),
      { ...row('彩贴'), background: 'color' as const },
      row('x'.repeat(4001)),
      row('', [path.join(dir, 'missing.mp4')]),
      row('', ['https://drive.google.com/file/d/abcdefghijk/view']),
    ];
    const { assigned } = await plans(store, rows),
      jobId = assigned[0]!.id,
      worker = prepare(store);
    let calls = 0;
    await assert.rejects(
      worker.prepare(jobId, randomUUID(), () => {
        if (++calls > 5) throw Error('ACTOR_CANCELLED');
      }),
      /ACTOR_CANCELLED/,
    );
    assert.equal(count(db, 'material_catalogs'), 0);
    assert.equal(count(db, 'material_sources'), 0);
    const result = await worker.prepare(jobId, randomUUID(), noop);
    assert.equal(result.catalog.sources.length, 1);
    assert.deepEqual(
      result.blocked.map((row) => row.reason),
      [
        'BACKGROUND_UNVERIFIED',
        'TEXT_INPUT_LIMIT',
        'RESOURCE_SOURCE_FILE_UNAVAILABLE',
        'RESOURCE_SOURCE_DRIVE_DOWNLOAD_PENDING',
      ],
    );
    assert.equal(count(db, 'material_post_intents'), 0);
  }));

test('resource catalog refuses foreign saved rows, forged member keys or caption changes without inserting content; no fake directory can satisfy table reservation', async () =>
  fixture(async (store, _file, _dir, db) => {
    const original = row('原文'),
      { assigned, profiles } = await plans(store, [original]),
      jobId = assigned[0]!.id,
      reader = new FilesystemResourceMaterialVerifier();
    const snapshot = await reader.snapshot(original, noop);
    await assert.rejects(
      async () =>
        await store.materials.indexResources(jobId, randomUUID(), [{ ...snapshot, text: '篡改' }]),
      /RESOURCE_MATERIAL_SNAPSHOT_MISMATCH/,
    );
    await assert.rejects(
      async () =>
        await store.materials.indexResources(jobId, randomUUID(), [
          { ...snapshot, source: randomUUID() },
        ]),
      /RESOURCE_MATERIAL_ROW_NOT_IN_PLAN/,
    );
    assert.equal(count(db, 'material_catalogs'), 0);
    assert.equal(count(db, 'material_contents'), 0);
    const catalog = await store.materials.indexResources(jobId, randomUUID(), [snapshot]);
    assert.deepEqual(await store.materials.indexResources(jobId, catalog.id, [snapshot]), catalog);
    const input = await simulatedActor(store, db, jobId, profiles[0]!.account.id, catalog.id);
    await assert.rejects(
      async () =>
        await store.materials.reserveNextResource({
          ...input,
          context: { ...input.context, accountId: 'foreign-account' },
        }),
      /MATERIAL_TASK_NOT_READY/,
    );
    assert.equal(count(db, 'material_post_intents'), 0);
  }));

test('shared resource table selects the step destination in the original reservation transaction, never changes the saved row', async () =>
  fixture(async (store, _file, _dir, db) => {
    const story = { ...row('生成文字快拍'), purpose: 'story' as const };
    const post = row('生成普通帖子');
    const both = { ...row('生成两用文字'), purpose: 'both' as const };
    const { assigned, profiles } = await plans(store, [story, post, both]);
    const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
    const input = await simulatedActor(
      store,
      db,
      assigned[0]!.id,
      profiles[0]!.account.id,
      catalog.id,
    );
    const storySource = catalog.sources.find((source) => source.origin.row.id === story.id)!;
    await assert.rejects(
      async () => await store.materials.reserve({ ...input, sourceId: storySource.id }),
      /RESOURCE_PURPOSE_MISMATCH/,
    );
    assert.equal(count(db, 'material_reservations'), 0);
    const held = await store.materials.reserveNextResource(input);
    assert.equal(ResourceMaterialPostIntent.parse(held.intent).resource.row.id, post.id);
    assert.equal(count(db, 'material_reservations'), 1);
    assert.equal(count(db, 'material_publications'), 0);
    assert.deepEqual((await store.tasks.resources.snapshot(input.jobId)).table.rows, [
      story,
      post,
      both,
    ]);
  }));

test('story reservation skips post-only resources and prevents a multi-image post from becoming one story', async () =>
  fixture(async (store, _file, dir, db) => {
    const image = path.join(dir, 'generated-story.png');
    await writeFile(image, png);
    const multi = { ...row('多图', [image, image]), purpose: 'story' as const };
    const text = { ...row('单条文字快拍'), purpose: 'both' as const };
    const { assigned, profiles } = await plans(
      store,
      [row('帖子'), multi, text],
      1,
      false,
      undefined,
      'story',
    );
    const catalog = (await prepare(store).prepare(assigned[0]!.id, randomUUID(), noop)).catalog;
    const input = await simulatedActor(
      store,
      db,
      assigned[0]!.id,
      profiles[0]!.account.id,
      catalog.id,
    );
    const multiSource = catalog.sources.find((source) => source.origin.row.id === multi.id)!;
    await assert.rejects(
      async () => await store.materials.reserve({ ...input, sourceId: multiSource.id }),
      /STORY_MULTI_MEDIA/,
    );
    const held = await store.materials.reserveNextResource(input);
    assert.equal(ResourceMaterialPostIntent.parse(held.intent).resource.row.id, text.id);
    assert.equal(count(db, 'material_publications'), 0);
    assert.deepEqual(await readFile(image), png);
  }));
