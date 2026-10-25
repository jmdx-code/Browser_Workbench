import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, lstat, readdir, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialArchivePlanner } from '../src/infrastructure/material-archive-planner.js';
import { FilesystemMaterialArchiveExecutor } from '../src/infrastructure/material-archive-executor.js';
import { MaterialArchivePreparation } from '../src/application/material-archive-preparation.js';
import { MaterialArchiveWorker } from '../src/application/material-archive-worker.js';
import { ArchiveManagementService } from '../src/application/archive-management.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import type { Catalog } from '../src/shared/material-index.js';
import type { MaterialArchiveExecutionRepository } from '../src/domain/material-archive-execution.js';
import type {
  ArchiveExecution,
  ArchiveStep,
  ArchiveProof,
} from '../src/shared/material-archive-execution.js';
import {
  dropArchiveExecutionSchema,
  latestMigrationBackupMarker,
} from './fixtures/workspace-schema.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);

test('a later post in the same plan cannot block the confirmed earlier post archive', async () => {
  for (const laterState of ['UNKNOWN', 'NOTICE_PENDING'] as const)
    await postFixture(async (store, _file, catalog) => {
      const first = await postRequest(store, catalog, { count: 2 });
      await store.materials.reserve(first);
      const submitted = await dispatchedPost(store, first);
      await store.materialPosts.verify(await postReceipt(store, first, submitted));
      assert.deepEqual(await store.archivePreparation.pending(), []);
      await deliverPostNotices(store, first.context.profileId);
      const nextSource = catalog.sources.find((row) => row.snapshot.source === 'other.txt');
      assert.ok(nextSource);
      const second = {
        ...first,
        attemptId: randomUUID(),
        sourceId: nextSource.id,
        expectedProgressRevision: (await store.tasks.steps(first.jobId))[0]!.progress.revision,
      };
      await store.materials.reserve(second);
      const later = await dispatchedPost(store, second);
      if (laterState === 'UNKNOWN')
        await store.tasks.markBoundUnknown(later.binding, 'later post uncertain');
      else await store.materialPosts.verify(await postReceipt(store, second, later));
      assert.deepEqual(await store.archivePreparation.pending(), [first.attemptId]);
      if (laterState === 'NOTICE_PENDING')
        await assert.rejects(
          async () => await store.archivePreparation.request(second.attemptId),
          /NOTICE_PENDING/,
        );
      else
        await assert.rejects(
          async () => await store.archivePreparation.request(second.attemptId),
          /PUBLISHED_REQUEST_REQUIRED/,
        );
      const before = await store.tasks.operations(first.jobId);
      const worker = new MaterialArchiveWorker(
        store.archivePreparation,
        new MaterialArchivePreparation(
          store.archivePreparation,
          new FilesystemMaterialArchivePlanner(),
        ),
        new FilesystemMaterialArchiveExecutor(store.archiveExecution),
      );
      try {
        await worker.tick();
        assert.equal(await store.archiveExecution.completed(first.attemptId), true);
        assert.equal(await store.archiveExecution.completed(second.attemptId), false);
        assert.deepEqual(await store.tasks.operations(first.jobId), before);
        assert.equal(await readFile(path.join(catalog.directory, 'other.txt'), 'utf8'), '不同内容');
      } finally {
        await worker.close();
      }
    });
});
test('archive queue waits for original delivered settlement; concurrent ticks archive once without new post operations', async () =>
  postFixture(async (store, file, catalog) => {
    const request = await postRequest(store, catalog);
    await store.materials.reserve(request);
    const submit = await dispatchedPost(store, request);
    await store.materialPosts.verify(await postReceipt(store, request, submit));
    assert.deepEqual(await store.archivePreparation.pending(), []);
    await deliverPostNotices(store, request.context.profileId);
    assert.deepEqual(await store.archivePreparation.pending(), [request.attemptId]);
    const db = new DatabaseSync(file);
    const before = db.prepare('SELECT count(*) AS n FROM task_outbox').get()?.n;
    const errors: string[] = [];
    const worker = new MaterialArchiveWorker(
      store.archivePreparation,
      new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ),
      new FilesystemMaterialArchiveExecutor(store.archiveExecution),
      (_id, reason) => errors.push(reason),
    );
    try {
      await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
      assert.equal(await store.archiveExecution.completed(request.attemptId), true);
      assert.deepEqual(await store.archivePreparation.pending(), []);
      assert.deepEqual(errors, []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM task_outbox').get()?.n, before);
      assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
    } finally {
      await worker.close();
      db.close();
    }
  }));

test('archive worker records a changed source for review and never retries it automatically', async () =>
  postFixture(async (store, _file, catalog) => {
    const { request, plan } = await prepared(store, catalog);
    await writeFile(plan.files[0]!.sourcePath, 'changed after publication');
    const errors: string[] = [];
    const worker = new MaterialArchiveWorker(
      store.archivePreparation,
      new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ),
      new FilesystemMaterialArchiveExecutor(store.archiveExecution),
      (_id, reason) => errors.push(reason),
    );
    try {
      await worker.tick();
      await worker.tick();
      assert.equal(errors.length, 1);
      assert.equal(await store.archiveExecution.completed(request.attemptId), false);
      assert.deepEqual(await store.archivePreparation.pending(), []);
      assert.equal(await readFile(plan.files[0]!.sourcePath, 'utf8'), 'changed after publication');
      assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
    } finally {
      await worker.close();
    }
  }));

test('shutdown after verified copy prevents source deletion and drains the original archive claim before DB close', async () =>
  postFixture(async (store, _file, catalog) => {
    const { request, plan } = await prepared(store, catalog);
    let copied!: () => void, resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      copied = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Pause immediately after original copy proof; the next IO guard observes shutdown.
    let closing: Promise<void> | undefined;
    let closed = false;
    const journal = new InterruptedJournal(store.archiveExecution, (step) => {
      if (step.kind === 'COPY') {
        closing = worker.close().then(() => {
          closed = true;
        });
        copied();
      }
    });
    const executor = new FilesystemMaterialArchiveExecutor(journal);
    const errors: string[] = [];
    const worker = new MaterialArchiveWorker(
      store.archivePreparation,
      new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ),
      {
        execute: async (id, allowed) => {
          // Guard is synchronous. Stop is set by the original proof callback and a held
          // Promise ensures close waits for the executor rather than closing SQLite early.
          try {
            await executor.execute(id, allowed);
          } finally {
            await gate;
          }
        },
      },
      (_id, reason) => errors.push(reason),
    );
    const running = worker.tick();
    await reached;
    assert.ok(closing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    resume();
    await closing;
    await running;
    assert.equal(closed, true);
    assert.equal(await store.archiveExecution.completed(request.attemptId), false);
    assert.equal(await readFile(plan.files[0]!.sourcePath, 'utf8'), '生成发布事务测试正文');
    assert.deepEqual(
      await readFile(plan.files[0]!.targetPath),
      await readFile(plan.files[0]!.sourcePath),
    );
    assert.deepEqual(await store.archivePreparation.pending(), []);
    await worker.tick();
    assert.equal(errors.length, 1);
  }));
async function prepared(
  store: WorkspaceStore,
  catalog: Catalog,
  name = 'text.txt',
  repeat = false,
) {
  const request = await postRequest(store, catalog, { source: name, allowRepeat: repeat });
  await store.materials.reserve(request);
  if ((await store.materials.reservation(request.attemptId)).intent.snapshot.format !== 'text') {
    const upload = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    await store.materialPosts.verify(await postReceipt(store, request, upload));
    await deliverPostNotices(store, request.context.profileId);
  }
  const submit = await dispatchedPost(store, request);
  await store.materialPosts.verify(await postReceipt(store, request, submit));
  await deliverPostNotices(store, request.context.profileId);
  const ready = await new MaterialArchivePreparation(
    store.archivePreparation,
    new FilesystemMaterialArchivePlanner(),
  ).prepare(request.attemptId);
  assert.ok(ready.plan);
  return { request, plan: ready.plan };
}
test('archive management resumes the original interrupted IO once, refuses stale or foreign requests and never adds post input', async () =>
  postFixture(async (store, file, catalog) => {
    const { request, plan } = await prepared(store, catalog);
    const interrupted = new FilesystemMaterialArchiveExecutor(
      new InterruptedJournal(store.archiveExecution, (step) => {
        if (step.kind === 'COPY') throw Error('generated interruption after verified copy');
      }),
    );
    await assert.rejects(interrupted.execute(request.attemptId), /generated interruption/);
    const db = new DatabaseSync(file);
    const before = db.prepare('SELECT count(*) AS n FROM task_outbox').get()?.n;
    const worker = new MaterialArchiveWorker(
      store.archivePreparation,
      new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ),
      new FilesystemMaterialArchiveExecutor(store.archiveExecution),
    );
    const management = new ArchiveManagementService(store.archivePreparation, () => worker);
    const scope = { profileId: request.context.profileId, planId: request.jobId };
    try {
      const observed = await management.list(scope);
      assert.equal(observed.archives[0]?.resumable, true);
      assert.equal(observed.archives[0]?.state, 'REVIEW');
      assert.equal(observed.archives[0]?.files[0]?.source, plan.files[0]?.sourcePath);
      await assert.rejects(
        async () => await management.list({ ...scope, profileId: randomUUID() }),
        /归档记录不存在/,
      );
      const row = observed.archives[0]!;
      const resume = {
        ...scope,
        attemptId: request.attemptId,
        expectedRevision: row.revision,
        expectedPreparationRevision: row.preparationRevision,
      };
      await assert.rejects(
        async () => await management.resume({ ...resume, expectedRevision: row.revision + 1 }),
        /归档状态已变化/,
      );
      await assert.rejects(
        async () =>
          await new ArchiveManagementService(store.archivePreparation, () => undefined).resume(
            resume,
          ),
        /未启用归档执行/,
      );
      assert.deepEqual(await management.resume(resume), {
        accepted: true,
        attemptId: request.attemptId,
      });
      await assert.rejects(async () => await management.resume(resume), /正在处理其他文件/);
      await worker.tick();
      assert.equal((await management.list(scope)).archives[0]?.state, 'COMPLETED');
      assert.equal((await management.list(scope)).archives[0]?.resumable, false);
      await assert.rejects(async () => await management.resume(resume), /归档状态已变化/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM task_outbox').get()?.n, before);
      assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
      await assert.rejects(readFile(plan.files[0]!.sourcePath), /ENOENT/);
      assert.equal(await readFile(plan.files[0]!.targetPath, 'utf8'), '生成发布事务测试正文');
    } finally {
      await worker.close();
      db.close();
    }
  }));

test('explicit archive recovery keeps changed files in review instead of replacing the original publication or copying foreign bytes', async () =>
  postFixture(async (store, _file, catalog) => {
    const { request, plan } = await prepared(store, catalog);
    await writeFile(plan.files[0]!.sourcePath, 'changed source');
    const worker = new MaterialArchiveWorker(
      store.archivePreparation,
      new MaterialArchivePreparation(
        store.archivePreparation,
        new FilesystemMaterialArchivePlanner(),
      ),
      new FilesystemMaterialArchiveExecutor(store.archiveExecution),
    );
    try {
      await worker.tick();
      const management = new ArchiveManagementService(store.archivePreparation, () => worker);
      const scope = { profileId: request.context.profileId, planId: request.jobId },
        row = (await management.list(scope)).archives[0]!;
      await management.resume({
        ...scope,
        attemptId: request.attemptId,
        expectedRevision: row.revision,
        expectedPreparationRevision: row.preparationRevision,
      });
      await worker.tick();
      assert.equal((await management.list(scope)).archives[0]?.state, 'REVIEW');
      assert.equal(await readFile(plan.files[0]!.sourcePath, 'utf8'), 'changed source');
      assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
      assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
    } finally {
      await worker.close();
    }
  }));
// Fault injection delegates every journal operation to the original SQLite repository.
class InterruptedJournal implements MaterialArchiveExecutionRepository {
  constructor(
    private readonly base: MaterialArchiveExecutionRepository,
    private readonly afterProof: (step: ArchiveStep, proof: ArchiveProof) => void,
    private readonly beforeProof: (step: ArchiveStep) => void = () => {},
  ) {}
  async completed(id: string) {
    return await this.base.completed(id);
  }
  async claim(id: string) {
    return await this.base.claim(id);
  }
  async assertCurrent(c: ArchiveExecution) {
    await this.base.assertCurrent(c);
  }
  async step(c: ArchiveExecution, s: ArchiveStep) {
    return await this.base.step(c, s);
  }
  async prove(c: ArchiveExecution, s: ArchiveStep, p: ArchiveProof) {
    this.beforeProof(s);
    await this.base.prove(c, s, p);
    this.afterProof(s, p);
  }
  async protectSource(c: ArchiveExecution, s: string) {
    return await this.base.protectSource(c, s);
  }
  async complete(c: ArchiveExecution) {
    await this.base.complete(c);
  }
  async review(c: ArchiveExecution, r: string) {
    await this.base.review(c, r);
  }
  async recoverOnStartup() {
    return await this.base.recoverOnStartup();
  }
}
test('original four-format archive copies all bytes, confirms source removal, retains publication and is idempotent after reopen', async () => {
  for (const name of ['text.txt', 'image.png', 'album', 'video.mp4'])
    await postFixture(async (store, file, old) => {
      await writeFile(path.join(old.directory, 'image.png'), png);
      await writeFile(path.join(old.directory, 'image.txt'), '图片文案');
      await mkdir(path.join(old.directory, 'album'));
      await writeFile(path.join(old.directory, 'album', 'a.png'), png);
      await writeFile(path.join(old.directory, 'album', 'b.png'), png);
      await writeFile(path.join(old.directory, 'album', '正文.txt'), '相册文案');
      await writeFile(path.join(old.directory, 'video.mp4'), await readFile('public/sample.mp4'));
      const catalog = await store.materials.index(
        await new FilesystemMaterialScanner().scan(old.directory),
        randomUUID(),
      );
      const { request, plan } = await prepared(store, catalog, name);
      const originals = await Promise.all(plan.files.map((f) => readFile(f.sourcePath)));
      await new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(
        request.attemptId,
      );
      assert.equal(await store.archiveExecution.completed(request.attemptId), true);
      for (const [i, f] of plan.files.entries()) {
        assert.deepEqual(await readFile(f.targetPath), originals[i]);
        await assert.rejects(lstat(f.sourcePath), { code: 'ENOENT' });
      }
      assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
      assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
      const reopened = await WorkspaceStore.open(file);
      try {
        await new FilesystemMaterialArchiveExecutor(reopened.archiveExecution).execute(
          request.attemptId,
        );
        assert.equal(reopened.archiveExecution.recoverOnStartup(), 0);
      } finally {
        reopened.close();
      }
    });
});
test('allowRepeat makes verified archive copies while preserving all original source files', async () =>
  postFixture(async (store, _file, catalog) => {
    const { request, plan } = await prepared(store, catalog, 'text.txt', true);
    await new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(request.attemptId);
    assert.equal(await store.archiveExecution.completed(request.attemptId), true);
    for (const f of plan.files)
      assert.deepEqual(await readFile(f.sourcePath), await readFile(f.targetPath));
  }));
test('tampered source or occupied target never gets overwritten or consumed a second time', async () => {
  for (const kind of ['source', 'target'])
    await postFixture(async (store, file, catalog) => {
      const { request, plan } = await prepared(store, catalog);
      const first = plan.files[0];
      assert.ok(first);
      if (kind === 'source') await writeFile(first.sourcePath, 'tampered');
      else {
        await mkdir(path.dirname(first.targetPath), { recursive: true });
        await writeFile(first.targetPath, 'sentinel');
      }
      await assert.rejects(
        new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(request.attemptId),
      );
      assert.equal(await store.archiveExecution.completed(request.attemptId), false);
      const db = new DatabaseSync(file);
      try {
        assert.equal(
          db
            .prepare('SELECT state FROM material_archive_state WHERE attempt_id=?')
            .get(request.attemptId)?.state,
          'REVIEW',
        );
      } finally {
        db.close();
      }
      if (kind === 'target') assert.equal(await readFile(first.targetPath, 'utf8'), 'sentinel');
      assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
    });
});
test('verified-copy interruption permits explicit original journal continuation; passive reopen does not run IO', async () =>
  postFixture(async (store, file, catalog) => {
    const { request, plan } = await prepared(store, catalog);
    let interrupted = false;
    const journal = new InterruptedJournal(store.archiveExecution, (step) => {
      if (step.kind === 'COPY' && !interrupted) {
        interrupted = true;
        throw Error('INJECT_AFTER_COPY');
      }
    });
    await assert.rejects(
      new FilesystemMaterialArchiveExecutor(journal).execute(request.attemptId),
      /INJECT_AFTER_COPY/,
    );
    const first = plan.files[0];
    assert.ok(first);
    assert.deepEqual(await readFile(first.sourcePath), await readFile(first.targetPath));
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.archiveExecution.completed(request.attemptId), false);
      await new FilesystemMaterialArchiveExecutor(reopened.archiveExecution).execute(
        request.attemptId,
      );
      assert.equal(reopened.archiveExecution.completed(request.attemptId), true);
    } finally {
      reopened.close();
    }
  }));
test('an unconfirmed target creation or deletion keeps REVIEW and original source lock; no adoption or input replay', async () => {
  for (const phase of ['COPY', 'DELETE'])
    await postFixture(async (store, file, catalog) => {
      const { request, plan } = await prepared(store, catalog);
      const journal = new InterruptedJournal(
        store.archiveExecution,
        () => {},
        (step) => {
          if (step.kind === phase) throw Error('INJECT_LOST_PROOF');
        },
      );
      await assert.rejects(
        new FilesystemMaterialArchiveExecutor(journal).execute(request.attemptId),
        /INJECT_LOST_PROOF/,
      );
      await assert.rejects(
        new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(request.attemptId),
      );
      const first = plan.files[0];
      assert.ok(first);
      assert.equal(
        createHash('sha256')
          .update(await readFile(first.targetPath))
          .digest('hex'),
        first.original.digest,
      );
      const db = new DatabaseSync(file);
      try {
        assert.equal(
          db
            .prepare('SELECT state FROM material_archive_state WHERE attempt_id=?')
            .get(request.attemptId)?.state,
          'REVIEW',
        );
        if (phase === 'DELETE')
          assert.equal(
            db
              .prepare('SELECT state FROM material_archive_source_locks WHERE attempt_id=?')
              .get(request.attemptId)?.state,
            'LOCKED',
          );
      } finally {
        db.close();
      }
      assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
    });
});
test('two SQLite controllers cannot run one original archive and explicit startup recovery revokes the first worker', async () =>
  postFixture(async (store, file, catalog) => {
    const { request } = await prepared(store, catalog),
      claim = await store.archiveExecution.claim(request.attemptId);
    const other = await WorkspaceStore.open(file);
    try {
      assert.throws(
        () => other.archiveExecution.claim(request.attemptId),
        /PUBLISHED_REQUEST_REQUIRED|WORKER_HELD/,
      );
      await store.archiveExecution.assertCurrent(claim);
      assert.equal(other.archiveExecution.recoverOnStartup(), 1);
      await assert.rejects(
        async () => await store.archiveExecution.assertCurrent(claim),
        /WORKER_REVOKED/,
      );
      await new FilesystemMaterialArchiveExecutor(other.archiveExecution).execute(
        request.attemptId,
      );
      assert.equal(other.archiveExecution.completed(request.attemptId), true);
    } finally {
      other.close();
    }
  }));
test('archive-root junction after READY never touches an outside directory', async () =>
  postFixture(async (store, file, catalog) => {
    const { request } = await prepared(store, catalog);
    const outside = path.join(path.dirname(file), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel.txt'), 'keep');
    await symlink(outside, path.join(catalog.directory, '已发'), 'junction');
    await assert.rejects(
      new FilesystemMaterialArchiveExecutor(store.archiveExecution).execute(request.attemptId),
      /DIRECTORY_CHANGED/,
    );
    assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  }));

test('schema15 backup and append-only upgrade retain PUBLISHED, the original plan and pending archive; SQL rejects invented completion or premature lock release', async () =>
  postFixture(async (store, file, catalog) => {
    const { request, plan } = await prepared(store, catalog);
    const db = new DatabaseSync(file);
    try {
      db.exec(dropArchiveExecutionSchema + 'PRAGMA user_version=15');
    } finally {
      db.close();
    }
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.equal(upgraded.archiveExecution.completed(request.attemptId), false);
      assert.deepEqual(upgraded.archivePreparation.get(request.attemptId)?.plan, plan);
      const raw = new DatabaseSync(file);
      try {
        const claim = upgraded.archiveExecution.claim(request.attemptId),
          first = plan.files[0];
        assert.ok(first);
        assert.throws(
          () =>
            raw
              .prepare('INSERT INTO material_archive_completions VALUES(?,?,?)')
              .run(request.attemptId, JSON.stringify({ version: 1, plan }), Date.now()),
          /COMPLETION_PROOF_REQUIRED/,
        );
        assert.equal(upgraded.archiveExecution.protectSource(claim, first.sourcePath), 'DELETE');
        assert.throws(
          () => raw.exec("UPDATE material_archive_source_locks SET state='RELEASED'"),
          /LOCK_COMPLETION_REQUIRED/,
        );
        upgraded.archiveExecution.review(claim, 'explicit test continuation');
      } finally {
        raw.close();
      }
      const backupName = (await readdir(path.dirname(file))).find((n) =>
        n.includes(latestMigrationBackupMarker),
      );
      assert.ok(backupName);
      const backup = new DatabaseSync(path.join(path.dirname(file), backupName), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 15);
        assert.equal(
          backup
            .prepare('SELECT state FROM material_archive_state WHERE attempt_id=?')
            .get(request.attemptId)?.state,
          'PENDING',
        );
      } finally {
        backup.close();
      }
      await new FilesystemMaterialArchiveExecutor(upgraded.archiveExecution).execute(
        request.attemptId,
      );
      assert.equal(upgraded.archiveExecution.completed(request.attemptId), true);
      assert.equal(upgraded.materialPosts.result(request.attemptId)?.outcome, 'PUBLISHED');
    } finally {
      upgraded.close();
    }
  }));
