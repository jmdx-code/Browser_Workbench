import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { assertMaterialHistoryEligibility } from '../src/domain/material-post.js';
import { PostReceipt } from '../src/shared/material-post.js';
import {
  postFixture,
  postRequest,
  postAction,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import { dropMaterialPostSchema } from './fixtures/material-post-schema.js';

function facts(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        'material_post_operations',
        'material_operation_verdicts',
        'material_attempt_verdicts',
        'material_publications',
        'material_archive_requests',
        'task_settlement_notices',
      ].map((table) => [table, Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n)]),
    );
  } finally {
    db.close();
  }
}
test('home preparation is a gated first operation; its independent page effect cannot publish or be repeated after editing begins', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const request = await postAction(store, r, 'PREPARE_HOME');
    await assert.rejects(
      async () =>
        await store.materialPosts.prepare({
          ...request,
          action: {
            kind: 'browseNavigate',
            tabId: r.proof.tabId,
            url: 'https://www.facebook.com/watch/',
          },
        }),
      /TARGET_MISMATCH/,
    );
    const dispatched = await dispatchedPost(store, r, 'PREPARE_HOME');
    const receipt = await postReceipt(store, r, dispatched);
    assert.equal(receipt.evidence.basis, 'page-preparation-observed');
    assert.throws(
      () =>
        PostReceipt.parse({
          ...receipt,
          evidence: { ...receipt.evidence, basis: 'composer-effect-observed' },
        }),
      /BASIS_INVALID/,
    );
    await store.materialPosts.verify(receipt);
    await deliverPostNotices(store, r.context.profileId);
    assert.equal(await store.materialPosts.result(r.attemptId), null);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.equal(facts(file).material_publications, 0);
    await assert.rejects(
      async () => await store.materialPosts.prepare(await postAction(store, r, 'PREPARE_HOME')),
      /PHASE_INVALID/,
    );
    await store.materialPosts.prepare(await postAction(store, r, 'OPEN_COMPOSER'));
  });
});

test('Next is an original nonterminal operation: ACK cannot permit Submit, independent application cannot consume content', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const advance = await dispatchedPost(store, r, 'ADVANCE_COMPOSER');
    await store.tasks.acknowledgeBound({
      binding: advance.binding,
      evidence: { inputReturned: true },
    });
    await assert.rejects(
      async () => await store.materialPosts.prepare(await postAction(store, r, 'SUBMIT')),
      /上一指令尚未结算/,
    );
    const receipt = await postReceipt(store, r, advance);
    assert.throws(() =>
      PostReceipt.parse({
        ...receipt,
        evidence: {
          ...receipt.evidence,
          outcome: 'PUBLISHED',
          basis: 'own-post-observed',
          postId: 'wrong-next-post',
        },
      }),
    );
    await store.materialPosts.verify(receipt);
    assert.equal(await store.materialPosts.result(r.attemptId), null);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.equal(facts(file).material_publications, 0);
    assert.equal(facts(file).material_archive_requests, 0);
    await deliverPostNotices(store, r.context.profileId);
    const submit = await store.materialPosts.prepare(await postAction(store, r, 'SUBMIT'));
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(
        reopened.materialPosts.link(advance.prepared.operationId).purpose,
        'ADVANCE_COMPOSER',
      );
      assert.equal(reopened.tasks.takeBoundOperation(r.context)?.id, submit.id);
    } finally {
      await reopened.close();
    }
  });
});
test('post preparation atomically links original attempt to immutable outbox; unknown-purpose and unbound dispatch are rejected', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const prepare = await postAction(store, r, 'SET_TEXT'),
      op = await store.materialPosts.prepare(prepare);
    assert.equal(op.status, 'PREPARED');
    assert.equal((await store.materialPosts.link(op.id)).sequence, 1);
    assert.deepEqual(await store.materialPosts.prepare(prepare), op);
    await assert.rejects(
      async () => await store.tasks.takeOperation(),
      /POST_BOUND_DISPATCH_REQUIRED/,
    );
    await assert.rejects(
      async () => await store.materialPosts.prepare({ ...prepare, purpose: 'SUBMIT' }),
      /POST_OPERATION_ID_CONFLICT/,
    );
    const bound = await store.tasks.takeBoundOperation(r.context);
    assert.ok(bound?.binding);
    assert.equal(bound.binding.accountId, r.context.accountId);
    assert.equal(facts(file).material_post_operations, 1);
  });
});
test('stale context cannot bind a prepared post operation; the source, text and target remain original', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const action = await postAction(store, r, 'SET_TEXT');
    assert.equal(action.action.kind, 'typeText');
    await assert.rejects(
      async () =>
        await store.materialPosts.prepare({
          ...action,
          action: {
            kind: 'typeText',
            tabId: 42,
            documentEpoch: 0,
            routeEpoch: 0,
            target: { css: '#text' },
            text: '变造正文',
          },
        }),
      /POST_TEXT_SNAPSHOT_MISMATCH/,
    );
    await store.materialPosts.prepare(action);
    await assert.rejects(
      async () => await store.tasks.takeBoundOperation({ ...r.context, leaseId: randomUUID() }),
      /POST_RESERVATION_NOT_READY/,
    );
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'PREPARED');
    assert.equal((await store.tasks.operations(r.jobId))[0]?.binding, null);
  });
});
test('post intent insertion and outbox preparation roll back together', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_post_outbox BEFORE INSERT ON task_outbox BEGIN SELECT RAISE(ABORT,'INJECT_POST_OUTBOX_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.materialPosts.prepare(await postAction(store, r)),
        /INJECT_POST_OUTBOX_FAILURE/,
      );
      assert.equal(facts(file).material_post_operations, 0);
      assert.equal((await store.tasks.operations(r.jobId)).length, 0);
    } finally {
      db.exec('DROP TRIGGER fail_post_outbox');
      db.close();
    }
  });
});
test('ACK and generic business receipt cannot consume content or advance the publication checkpoint', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      ack = { binding: op.binding, evidence: { inputReturned: true } };
    await store.tasks.acknowledgeBound(ack);
    await assert.rejects(async () => await store.materialPosts.verify(ack));
    await assert.rejects(
      async () =>
        await store.tasks.settleBound(ack, 'VERIFIED', {
          ...(await store.tasks.steps(r.jobId))[0]?.progress,
          revision: 1,
          effectiveMilliseconds: 0,
          likes: 0,
          published: 1,
          cursor: null,
        }),
    );
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.equal(facts(file).material_publications, 0);
    assert.equal(facts(file).material_archive_requests, 0);
  });
});
test('independent publication atomically records consumption, checkpoint, one notification and pending archive; replay is idempotent', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op);
    await store.tasks.acknowledgeBound({ binding: op.binding, evidence: { inputReturned: true } });
    await store.materialPosts.verify(receipt);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'PUBLISHED');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 1);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.revision, 1);
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'VERIFIED');
    assert.deepEqual(facts(file), {
      material_post_operations: 1,
      material_operation_verdicts: 1,
      material_attempt_verdicts: 1,
      material_publications: 1,
      material_archive_requests: 1,
      task_settlement_notices: 1,
    });
    assert.equal(
      (await store.materialPosts.archives())[0]?.archiveDirectory,
      path.join(catalog.directory, '已发'),
    );
    assert.equal((await store.materialPosts.archives())[0]?.intent.snapshot.source, 'text.txt');
    await store.materialPosts.verify(receipt);
    await store.materialPosts.reconcile(receipt);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 1);
    await assert.rejects(
      async () =>
        await store.materialPosts.verify({
          ...receipt,
          evidence: { ...receipt.evidence, postId: 'contradictory-post' },
        }),
      /POST_VERDICT_CONFLICT/,
    );
    await assert.rejects(
      async () => await store.materialPosts.prepare(await postAction(store, r)),
      /POST_RESERVATION_NOT_READY/,
    );
  });
});
test('notification insert failure rolls back publication, reservation, checkpoint and archive together', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_post_notice BEFORE INSERT ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'INJECT_POST_NOTICE_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.materialPosts.verify(receipt),
        /INJECT_POST_NOTICE_FAILURE/,
      );
      assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
      assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'DISPATCHING');
      assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
      assert.equal(facts(file).material_publications, 0);
      assert.equal(facts(file).material_operation_verdicts, 0);
      assert.equal(facts(file).material_archive_requests, 0);
    } finally {
      db.exec('DROP TRIGGER fail_post_notice');
      db.close();
    }
    await store.materialPosts.verify(receipt);
    assert.equal(facts(file).material_publications, 1);
  });
});
test('archive queue insert failure cannot consume material or commit a successful submit', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_post_archive BEFORE INSERT ON material_archive_requests BEGIN SELECT RAISE(ABORT,'INJECT_POST_ARCHIVE_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.materialPosts.verify(await postReceipt(store, r, op)),
        /INJECT_POST_ARCHIVE_FAILURE/,
      );
      assert.equal(facts(file).material_publications, 0);
      assert.equal(facts(file).material_attempt_verdicts, 0);
      assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
    } finally {
      db.exec('DROP TRIGGER fail_post_archive');
      db.close();
    }
  });
});
test('wrong account, attempt, fingerprint, proof or original lease does not settle publication', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op);
    for (const bad of [
      { ...receipt, binding: { ...receipt.binding, leaseId: randomUUID() } },
      { ...receipt, evidence: { ...receipt.evidence, observedAccountId: 'other-account' } },
      { ...receipt, evidence: { ...receipt.evidence, attemptId: randomUUID() } },
      { ...receipt, evidence: { ...receipt.evidence, fingerprint: 'b'.repeat(64) } },
      {
        ...receipt,
        evidence: {
          ...receipt.evidence,
          proof: { ...receipt.evidence.proof, targetId: 'other-target' },
        },
      },
    ])
      await assert.rejects(
        async () => await store.materialPosts.verify(bad),
        /POST_VERIFICATION_BINDING_MISMATCH/,
      );
    assert.equal(facts(file).material_publications, 0);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.throws(() =>
      PostReceipt.parse({ ...receipt, evidence: { ...receipt.evidence, postId: null } }),
    );
  });
});
test('UNKNOWN submit preserves occupancy and rejects late normal success; explicit original-binding reconciliation settles once', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op);
    await store.tasks.markBoundUnknown(op.binding, 'simulated-lost-response');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'REVIEW');
    await assert.rejects(
      async () => await store.materialPosts.verify(receipt),
      /POST_EXPLICIT_RECONCILIATION_REQUIRED/,
    );
    await assert.rejects(
      async () => await store.materialPosts.cancelUnsent(r.attemptId),
      /POST_ATTEMPT_DISPATCHED/,
    );
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    assert.equal(await store.materialPosts.result(r.attemptId), null);
    await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    assert.equal((await store.tasks.get(r.jobId)).state, 'REVIEW');
    await store.materialPosts.reconcile(receipt);
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPED');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'PUBLISHED');
    assert.equal(facts(file).material_publications, 1);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 1);
  });
});
test('verified negative submit releases content without a post count/history/archive and cannot be resubmitted under original attempt', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op, 'NOT_PUBLISHED');
    await store.materialPosts.verify(receipt);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'FAILED');
    assert.equal(facts(file).material_publications, 0);
    assert.equal(facts(file).material_archive_requests, 0);
    assert.equal((await store.tasks.settlements.list())[0]?.resolution.outcome, 'NOT_APPLIED');
    await assert.rejects(
      async () => await store.materialPosts.prepare(await postAction(store, r)),
      /POST_RESERVATION_NOT_READY/,
    );
    const second = await postRequest(store, catalog);
    assert.equal((await store.materials.reserve(second)).state, 'RESERVED');
  });
});
test('auxiliary effects do not increment published; pending settlement notification blocks the next operation', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const aux = await dispatchedPost(store, r, 'SET_TEXT');
    await store.materialPosts.verify(await postReceipt(store, r, aux));
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.revision, 1);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
    await assert.rejects(
      async () => await store.materialPosts.prepare(await postAction(store, r)),
      /POST_SETTLEMENT_NOTICE_PENDING/,
    );
    await deliverPostNotices(store, r.context.profileId);
    const submit = await dispatchedPost(store, r);
    await store.materialPosts.verify(await postReceipt(store, r, submit));
    assert.equal((await store.materialPosts.link(submit.binding.operationId)).sequence, 2);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.revision, 2);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 1);
    assert.equal(facts(file).task_settlement_notices, 2);
  });
});
test('stopping before any dispatch can cancel using durable local proof, including prepared but unsent submit', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await store.materialPosts.prepare(await postAction(store, r));
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    assert.equal((await store.materialPosts.result(r.attemptId))?.basis, 'LOCAL_NEVER_DISPATCHED');
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPING');
    assert.equal((await store.tasks.get(r.jobId)).controlConfirmed, false);
    await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPED');
    await store.materialPosts.cancelUnsent(r.attemptId);
    await store.materialPosts.cancelUnsent(r.attemptId);
    assert.equal((await store.materialPosts.result(r.attemptId))?.basis, 'LOCAL_NEVER_DISPATCHED');
    assert.equal(
      (await store.tasks.operations(r.jobId)).find((row) => row.id === op.id)?.status,
      'CANCELLED',
    );
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPED');
    assert.equal(facts(file).material_publications, 0);
    assert.equal(facts(file).task_settlement_notices, 0);
  });
});
test('dispatched auxiliary preparation needs independent negative attempt proof; stop alone never releases material', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const aux = await dispatchedPost(store, r, 'OPEN_COMPOSER'),
      receipt = await postReceipt(store, r, aux);
    await store.materialPosts.verify(receipt);
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    await assert.rejects(
      async () => await store.materialPosts.cancelUnsent(r.attemptId),
      /POST_ATTEMPT_DISPATCHED/,
    );
    const { purpose: _purpose, outcome: _outcome, postId: _postId, ...fields } = receipt.evidence;
    const negative = {
      ...fields,
      outcome: 'NOT_PUBLISHED' as const,
      basis: 'independently-verified-not-published' as const,
    };
    await store.materialPosts.resolveNotPublished(negative);
    await store.materialPosts.resolveNotPublished(negative);
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPED');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
  });
});
test('publication history uses stable account/content even on another profile; archive pending blocks cross-account reuse', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r);
    await store.materialPosts.verify(await postReceipt(store, r, op));
    await store.tasks.completeStep(r.jobId, r.stepId);
    const same = await postRequest(store, catalog, {
      accountId: r.context.accountId,
      allowRepeat: true,
      source: 'copy.txt',
    });
    await assert.rejects(
      async () => await store.materials.reserve(same),
      /MATERIAL_CONTENT_ALREADY_USED_BY_ACCOUNT/,
    );
    const different = await postRequest(store, catalog, { allowRepeat: true });
    await assert.rejects(
      async () => await store.materials.reserve(different),
      /MATERIAL_ARCHIVE_PENDING/,
    );
    assert.throws(
      () => assertMaterialHistoryEligibility(false, true, false),
      /MATERIAL_CONTENT_ALREADY_CONSUMED/,
    );
    assert.doesNotThrow(() => assertMaterialHistoryEligibility(false, true, true));
    assert.throws(
      () => assertMaterialHistoryEligibility(true, true, true),
      /MATERIAL_CONTENT_ALREADY_USED_BY_ACCOUNT/,
    );
  });
});
test('completed publication remains consumed after reopening; no archive completion or input replay is manufactured', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op);
    await store.materialPosts.verify(receipt);
    const before = facts(file),
      reopened = await WorkspaceStore.open(file);
    try {
      reopened.materialPosts.verify(receipt);
      assert.deepEqual(facts(file), before);
      assert.equal(reopened.materialPosts.archives().length, 1);
      reopened.tasks.recoverOnStartup();
      assert.equal(reopened.tasks.get(r.jobId).state, 'PAUSED');
      assert.equal(reopened.materials.reservation(r.attemptId).state, 'PUBLISHED');
      assert.equal(reopened.materialPosts.archives().length, 1);
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () => db.exec("UPDATE material_archive_state SET state='COMPLETED'"),
        /ARCHIVE_COMPLETION_PROOF_REQUIRED/,
      );
      for (const table of [
        'material_post_operations',
        'material_operation_verdicts',
        'material_attempt_verdicts',
        'material_publications',
        'material_archive_requests',
      ]) {
        assert.throws(
          () => db.exec('UPDATE ' + table + ' SET rowid=rowid'),
          /IMMUTABLE_POST_RECORD/,
        );
        assert.throws(() => db.exec('DELETE FROM ' + table), /RETAIN_POST_RECORD/);
      }
    } finally {
      db.close();
    }
  });
});
test('schema8 migration preserves existing reserved intent, running plan and backup without manufacturing publication', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    const held = await store.materials.reserve(r),
      plan = await store.tasks.get(r.jobId),
      db = new DatabaseSync(file);
    db.exec(dropMaterialPostSchema + 'PRAGMA user_version=8');
    db.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(migrated.materials.reservation(r.attemptId), held);
      assert.deepEqual(migrated.tasks.get(r.jobId), plan);
      assert.equal(migrated.materialPosts.result(r.attemptId), null);
      assert.equal(migrated.materialPosts.archives().length, 0);
      const backupFile = (await readdir(path.dirname(file))).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(backupFile);
      const original = new DatabaseSync(path.join(path.dirname(file), backupFile), {
        readOnly: true,
      });
      try {
        assert.equal(original.prepare('PRAGMA user_version').get()?.user_version, 8);
        assert.equal(
          original.prepare('SELECT state FROM material_reservations').get()?.state,
          'RESERVED',
        );
      } finally {
        original.close();
      }
    } finally {
      migrated.close();
    }
  });
});

test('cancel write failure preserves the unsent operation and original hold for a subsequent explicit cancellation', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await store.materialPosts.prepare(await postAction(store, r)),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_cancel_hold BEFORE UPDATE OF state ON material_reservations BEGIN SELECT RAISE(ABORT,'INJECT_CANCEL_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.materialPosts.cancelUnsent(r.attemptId),
        /INJECT_CANCEL_FAILURE/,
      );
      await assert.rejects(
        async () => await store.tasks.requestControl(r.jobId, 'stop'),
        /INJECT_CANCEL_FAILURE/,
      );
      assert.equal((await store.tasks.get(r.jobId)).state, 'RUNNING');
      assert.equal((await store.tasks.get(r.jobId)).controlRequestId, null);
      assert.equal(await store.materialPosts.result(r.attemptId), null);
      assert.equal((await store.materials.reservation(r.attemptId)).state, 'RESERVED');
      assert.equal(
        (await store.tasks.operations(r.jobId)).find((row) => row.id === op.id)?.status,
        'PREPARED',
      );
    } finally {
      db.exec('DROP TRIGGER fail_cancel_hold');
      db.close();
    }
    await store.materialPosts.cancelUnsent(r.attemptId);
    assert.equal(
      (await store.tasks.operations(r.jobId)).find((row) => row.id === op.id)?.status,
      'CANCELLED',
    );
  });
});

test('multiple publications in one step use independent attempts and monotonic ordinals without sharing original submit IDs', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog, { count: 2 });
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r);
    await store.materialPosts.verify(await postReceipt(store, r, op));
    await deliverPostNotices(store, r.context.profileId);
    const source = catalog.sources.find((row) => row.snapshot.source === 'other.txt');
    assert.ok(source);
    const next = {
      ...r,
      attemptId: randomUUID(),
      sourceId: source.id,
      expectedProgressRevision: 1,
    };
    assert.equal((await store.materials.reserve(next)).intent.ordinal, 2);
    const submit = await dispatchedPost(store, next);
    assert.notEqual(submit.binding.operationId, op.binding.operationId);
    await store.materialPosts.verify(await postReceipt(store, next, submit));
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 2);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.revision, 2);
    assert.equal(facts(file).material_publications, 2);
    assert.equal((await store.tasks.completeStep(r.jobId, r.stepId)).state, 'COMPLETED');
  });
});

test('UNKNOWN negative submit requires explicit binding reconciliation and removes no content history', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r),
      receipt = await postReceipt(store, r, op, 'NOT_PUBLISHED');
    await store.tasks.markBoundUnknown(op.binding, 'simulated-unknown');
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    await assert.rejects(
      async () => await store.materialPosts.verify(receipt),
      /POST_EXPLICIT_RECONCILIATION_REQUIRED/,
    );
    await store.materialPosts.reconcile(receipt);
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPED');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
    assert.equal(facts(file).material_publications, 0);
    assert.equal(facts(file).material_archive_requests, 0);
  });
});

test('the final task input guard rejects a reserved post whose material becomes REVIEW after binding', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r);
    await assert.doesNotReject(
      async () => await store.taskTabs.assertForInput(op.binding, r.proof),
    );
    const db = new DatabaseSync(file);
    try {
      db.prepare(
        "UPDATE material_reservations SET state='REVIEW',reason='simulated-source-review' WHERE attempt_id=?",
      ).run(r.attemptId);
    } finally {
      db.close();
    }
    assert.equal((await store.tasks.get(r.jobId)).state, 'RUNNING');
    await assert.rejects(
      async () => await store.taskTabs.assertForInput(op.binding, r.proof),
      /POST_RESERVATION_NOT_READY/,
    );
    const receipt = await postReceipt(store, r, op);
    assert.throws(() =>
      PostReceipt.parse({
        ...receipt,
        evidence: { ...receipt.evidence, basis: 'composer-effect-observed' },
      }),
    );
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
  });
});
