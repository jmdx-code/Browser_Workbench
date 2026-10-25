import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { MaterialPostRepository as CompatibleMaterialPostRepository } from '../domain/material-post.js';
import {
  assertMaterialHistoryEligibility,
  validatePostAction,
  validatePostMediaObservation,
} from '../domain/material-post.js';
import { sameTabProof } from '../domain/task-tabs.js';
import {
  ArchiveRequest,
  AttemptVerdict,
  NegativeAttemptEvidence,
  PostOperation,
  PostReceipt,
  PreparePostOperation,
  type PreparePost,
  type NegativePostEvidence,
  type AttemptResult,
} from '../shared/material-post.js';
import { sameBinding, type ExecutionReceipt } from '../shared/task-execution.js';
import type { SqliteTaskRepository } from './task-store.js';
import {
  assertPostReady,
  assertPostMediaPreparation,
  postLink,
  postReservation,
} from './material-post-guards.js';
import { transaction } from './sqlite-transaction.js';
import { cancelNeverDispatchedPost } from './material-post-cancellation.js';
import {
  currentMaterialUsageAccounts,
  historicalArchiveTestEnabled,
  materialUsageSourceKey,
} from './material-usage-store.js';

export class SqliteMaterialPostRepository implements MaterialPostRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: SqliteTaskRepository,
  ) {}
  link(operationId: string) {
    const link = postLink(this.db, operationId);
    if (!link) throw Error('POST_OPERATION_INTENT_REQUIRED');
    return link;
  }
  result(attemptId: string) {
    const row = this.db
      .prepare('SELECT body FROM material_attempt_verdicts WHERE attempt_id=?')
      .get(attemptId);
    return row ? AttemptVerdict.parse(JSON.parse(String(row.body)) as unknown) : null;
  }
  archives() {
    return this.db
      .prepare(
        "SELECT r.body FROM material_archive_requests r JOIN material_archive_state s USING(attempt_id) WHERE s.state<>'COMPLETED' ORDER BY r.created_at,r.attempt_id",
      )
      .all()
      .map((row) => ArchiveRequest.parse(JSON.parse(String(row.body)) as unknown));
  }
  prepare(input: PreparePost) {
    const request = PreparePostOperation.parse(input);
    return transaction(this.db, () => {
      const existing = postLink(this.db, request.operationId);
      if (existing) {
        const { sequence: _sequence, ...original } = existing;
        if (JSON.stringify(original) !== JSON.stringify(request))
          throw Error('POST_OPERATION_ID_CONFLICT');
        const held = postReservation(this.db, request.attemptId);
        const operation = this.tasks
          .operations(held.intent.jobId)
          .find((op) => op.id === request.operationId);
        if (!operation) throw Error('POST_OUTBOX_REQUIRED');
        return operation;
      }
      const held = assertPostReady(this.db, request.attemptId),
        intent = held.intent;
      if (request.purpose === 'OPEN_BACKGROUND' || request.purpose === 'SET_BACKGROUND') {
        if (
          this.db
            .prepare(
              "SELECT version FROM workspace_execution_contracts WHERE name='post-native-background'",
            )
            .get()?.version !== 1
        )
          throw Error('POST_BACKGROUND_CONTRACT_REQUIRED');
        if (
          !this.db
            .prepare(
              "SELECT operation_id FROM material_post_operations WHERE attempt_id=? AND purpose='OPEN_COMPOSER'",
            )
            .get(request.attemptId)
        )
          throw Error('POST_BACKGROUND_PHASE_INVALID');
        if (
          this.db
            .prepare(
              "SELECT operation_id FROM material_post_operations WHERE attempt_id=? AND purpose IN ('SET_TEXT','PREPARE_MEDIA','UPLOAD_MEDIA','ADVANCE_COMPOSER','SUBMIT')",
            )
            .get(request.attemptId)
        )
          throw Error('POST_BACKGROUND_PHASE_INVALID');
      }
      if (request.purpose === 'PREPARE_HOME') {
        if (
          this.db
            .prepare(
              "SELECT version FROM workspace_execution_contracts WHERE name='post-home-preparation'",
            )
            .get()?.version !== 1
        )
          throw Error('POST_HOME_PREPARATION_CONTRACT_REQUIRED');
        if (
          this.db
            .prepare('SELECT operation_id FROM material_post_operations WHERE attempt_id=?')
            .get(request.attemptId)
        )
          throw Error('POST_HOME_PREPARATION_PHASE_INVALID');
      }
      if (
        this.tasks.settlements
          .list(intent.context.profileId)
          .some((notice) => notice.state !== 'DELIVERED')
      )
        throw Error('POST_SETTLEMENT_NOTICE_PENDING');
      if (
        this.db
          .prepare(
            "SELECT operation_id FROM material_post_operations WHERE attempt_id=? AND purpose='SUBMIT'",
          )
          .get(request.attemptId)
      )
        throw Error('POST_SUBMIT_ALREADY_PREPARED');
      validatePostAction(intent, request.purpose, request.action);
      assertPostMediaPreparation(this.db, intent, request.purpose);
      const sequence = Number(
        this.db
          .prepare(
            'SELECT coalesce(max(sequence),0)+1 AS n FROM material_post_operations WHERE attempt_id=?',
          )
          .get(request.attemptId)?.n,
      );
      if (sequence > 200) throw Error('POST_OPERATION_BUDGET_EXCEEDED');
      const body = PostOperation.parse({ ...request, sequence });
      this.db
        .prepare('INSERT INTO material_post_operations VALUES(?,?,?,?,?,?)')
        .run(
          request.operationId,
          request.attemptId,
          request.purpose,
          sequence,
          JSON.stringify(body),
          Date.now(),
        );
      return this.tasks.prepareOperation(
        intent.jobId,
        intent.stepId,
        request.operationId,
        request.action,
      );
    });
  }
  verify(input: ExecutionReceipt) {
    this.settle(input, false);
  }
  reconcile(input: ExecutionReceipt) {
    this.settle(input, true);
  }
  private settle(input: ExecutionReceipt, reconcile: boolean) {
    const receipt = PostReceipt.parse(input);
    transaction(this.db, () => {
      const link = this.link(receipt.binding.operationId),
        held = postReservation(this.db, link.attemptId),
        intent = held.intent;
      const operation = this.tasks
        .operations(intent.jobId)
        .find((op) => op.id === link.operationId);
      if (
        !operation?.binding ||
        !sameBinding(operation.binding, receipt.binding) ||
        link.attemptId !== receipt.evidence.attemptId ||
        link.purpose !== receipt.evidence.purpose ||
        intent.fingerprint !== receipt.evidence.fingerprint ||
        intent.context.accountId !== receipt.evidence.observedAccountId ||
        !sameTabProof(intent.proof, receipt.evidence.proof)
      )
        throw Error('POST_VERIFICATION_BINDING_MISMATCH');
      validatePostMediaObservation(intent, receipt.evidence);
      const previous = this.db
        .prepare('SELECT body FROM material_operation_verdicts WHERE operation_id=?')
        .get(operation.id);
      if (previous) {
        if (String(previous.body) !== JSON.stringify(receipt)) throw Error('POST_VERDICT_CONFLICT');
        return; // One immutable observation, one checkpoint, one notification and one archive request.
      }
      if (
        !['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(operation.status) ||
        !['RESERVED', 'REVIEW'].includes(held.state)
      )
        throw Error('POST_VERIFICATION_NOT_PENDING');
      if ((operation.status === 'UNKNOWN' || held.state === 'REVIEW') && !reconcile)
        throw Error('POST_EXPLICIT_RECONCILIATION_REQUIRED');
      if (reconcile && operation.status !== 'UNKNOWN' && held.state !== 'REVIEW')
        throw Error('POST_RECONCILIATION_NOT_REQUIRED');
      if (!reconcile) assertPostReady(this.db, link.attemptId, receipt.binding);
      const step = this.tasks.steps(intent.jobId).find((row) => row.id === intent.stepId);
      if (!step || step.progress.published !== intent.ordinal - 1)
        throw Error('POST_CHECKPOINT_CHANGED');
      const ended =
        this.db.prepare('SELECT control_ended FROM task_outbox WHERE id=?').get(operation.id)
          ?.control_ended === 1;
      if (ended) {
        const failed = step.outcome?.kind === 'FAILED' ? step.outcome : null;
        const currentStop = failed?.currentStop;
        const materialEnded =
          this.db
            .prepare('SELECT control_ended FROM material_reservations WHERE attempt_id=?')
            .get(intent.attemptId)?.control_ended === 1;
        if (
          !reconcile ||
          operation.status !== 'UNKNOWN' ||
          link.purpose !== 'SUBMIT' ||
          !['PUBLISHED', 'NOT_PUBLISHED'].includes(receipt.evidence.outcome) ||
          step.status !== 'FAILED' ||
          failed?.submissionPhase !== 'UNKNOWN' ||
          failed.businessResult !== 'UNKNOWN' ||
          !materialEnded ||
          currentStop?.state !== 'stopped' ||
          currentStop.profileId !== intent.context.profileId ||
          currentStop.requestId !== failed.endingId
        )
          throw Error('ENDED_SUBMISSION_BUSINESS_REVIEW_REQUIRED');
      }
      const outcome = ['APPLIED', 'PUBLISHED'].includes(receipt.evidence.outcome)
          ? 'VERIFIED'
          : 'NOT_APPLIED',
        now = Date.now();
      this.db
        .prepare('INSERT INTO material_operation_verdicts VALUES(?,?,?,?,?)')
        .run(
          operation.id,
          intent.attemptId,
          receipt.evidence.outcome,
          JSON.stringify(receipt),
          now,
        );
      if (link.purpose === 'SUBMIT') {
        const verdict = AttemptVerdict.parse({
          attemptId: intent.attemptId,
          outcome: receipt.evidence.outcome,
          basis: 'SUBMIT_OPERATION',
          receipt,
        });
        this.writeResult(verdict);
        if (receipt.evidence.outcome === 'PUBLISHED') {
          const postId = receipt.evidence.postId;
          if (!postId) throw Error('POST_ID_REQUIRED');
          if (historicalArchiveTestEnabled(this.db)) {
            const any = currentMaterialUsageAccounts(this.db, intent.fingerprint);
            assertMaterialHistoryEligibility(
              any.some((row) => row.account_id === intent.context.accountId),
              any.length > 0,
              intent.allowRepeat,
            );
          }
          this.db
            .prepare(
              'INSERT INTO material_publications(attempt_id,account_id,fingerprint,post_id,created_at,usage_source_key,usage_generation) VALUES(?,?,?,?,?,?,(SELECT generation FROM material_usage_policy WHERE id=1))',
            )
            .run(
              intent.attemptId,
              intent.context.accountId,
              intent.fingerprint,
              postId,
              now,
              materialUsageSourceKey(
                intent.directory,
                intent.snapshot.source,
                'resource' in intent ? intent.resource : undefined,
              ),
            );
          if (historicalArchiveTestEnabled(this.db)) {
            const archive = ArchiveRequest.parse({
              attemptId: intent.attemptId,
              intent,
              postId,
              archiveDirectory:
                intent.directory === null ? null : path.join(intent.directory, '已发'),
            });
            this.db
              .prepare('INSERT INTO material_archive_requests VALUES(?,?,?)')
              .run(intent.attemptId, JSON.stringify(archive), now);
            this.db
              .prepare("INSERT INTO material_archive_state VALUES(?,'PENDING',0,'',?)")
              .run(intent.attemptId, now);
          }
        }
        this.db
          .prepare(
            'UPDATE material_reservations SET state=?,reason=?,updated_at=? WHERE attempt_id=?',
          )
          .run(verdict.outcome, 'INDEPENDENT_SUBMIT_VERDICT', now, intent.attemptId);
      }
      const progress =
        outcome === 'VERIFIED'
          ? {
              ...step.progress,
              revision: step.progress.revision + 1,
              published: link.purpose === 'SUBMIT' ? intent.ordinal : step.progress.published,
            }
          : undefined;
      if (ended) {
        // The immutable failed step and ended input UNKNOWN remain historical facts.
        // Only the original business verdict/usage is settled; no control notice or progress.
        this.db
          .prepare('INSERT INTO task_events(job_id,type,detail,created_at) VALUES(?,?,?,?)')
          .run(
            intent.jobId,
            'ENDED_SUBMISSION_BUSINESS_REVIEWED',
            JSON.stringify({
              operationId: operation.id,
              attemptId: intent.attemptId,
              outcome: receipt.evidence.outcome,
              observationId: receipt.evidence.observationId,
            }),
            now,
          );
      } else if (operation.status === 'UNKNOWN')
        this.tasks.reconcileBound(receipt, outcome, progress);
      else this.tasks.settleBound(receipt, outcome, progress);
    });
  }
  private writeResult(input: AttemptResult) {
    const result = AttemptVerdict.parse(input),
      existing = this.result(result.attemptId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(result))
        throw Error('POST_ATTEMPT_VERDICT_CONFLICT');
      return;
    }
    this.db
      .prepare('INSERT INTO material_attempt_verdicts VALUES(?,?,?,?)')
      .run(result.attemptId, result.outcome, JSON.stringify(result), Date.now());
  }
  cancelUnsent(attemptId: string) {
    transaction(this.db, () => {
      const held = postReservation(this.db, attemptId);
      if (!cancelNeverDispatchedPost(this.db, attemptId, this.tasks.operations(held.intent.jobId)))
        throw Error('POST_ATTEMPT_DISPATCHED_REVIEW_REQUIRED');
      this.tasks.finishResolvedPostControl(held.intent.jobId);
    });
  }
  resolveNotPublished(input: NegativePostEvidence) {
    const evidence = NegativeAttemptEvidence.parse(input);
    transaction(this.db, () => {
      const held = postReservation(this.db, evidence.attemptId),
        intent = held.intent;
      if (
        !sameTabProof(intent.proof, evidence.proof) ||
        intent.context.accountId !== evidence.observedAccountId ||
        intent.fingerprint !== evidence.fingerprint
      )
        throw Error('POST_VERIFICATION_BINDING_MISMATCH');
      const result: AttemptResult = {
        attemptId: intent.attemptId,
        outcome: 'NOT_PUBLISHED',
        basis: 'INDEPENDENT_ATTEMPT',
        evidence,
      };
      const existing = this.result(intent.attemptId);
      if (existing) {
        this.writeResult(result);
        return;
      }
      if (held.state !== 'REVIEW') throw Error('POST_ATTEMPT_REVIEW_REQUIRED');
      const links = this.db
        .prepare('SELECT operation_id,purpose FROM material_post_operations WHERE attempt_id=?')
        .all(intent.attemptId);
      for (const link of links) {
        const op = this.tasks
          .operations(intent.jobId)
          .find((operation) => operation.id === link.operation_id);
        if (
          !op ||
          !['VERIFIED', 'FAILED', 'CANCELLED'].includes(op.status) ||
          (link.purpose === 'SUBMIT' && op.status !== 'CANCELLED')
        )
          throw Error('POST_OPERATION_VERDICT_REQUIRED');
      }
      this.writeResult(result);
      this.db
        .prepare(
          "UPDATE material_reservations SET state='NOT_PUBLISHED',reason='INDEPENDENT_ATTEMPT_VERDICT',updated_at=? WHERE attempt_id=?",
        )
        .run(Date.now(), intent.attemptId);
      this.tasks.finishResolvedPostControl(intent.jobId);
    });
  }
}

type MaterialPostRepository = SynchronousRepository<CompatibleMaterialPostRepository>;
