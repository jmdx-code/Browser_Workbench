import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { MaterialArchivePreparationRepository as CompatibleMaterialArchivePreparationRepository } from '../domain/material-archive.js';
import { ArchiveRequest, AttemptVerdict } from '../shared/material-post.js';
import {
  ArchivePreparationClaim,
  MaterialArchivePlan,
  MaterialArchivePreparationRecord,
  type ArchiveClaim,
  type ArchivePlan,
} from '../shared/material-archive.js';
import { postReservation } from './material-post-guards.js';
import { transaction } from './sqlite-transaction.js';
import { archiveLayout } from './material-archive-layout.js';
import { referenceArchiveLayout, assertArchivePlanLayout } from './material-reference-archive.js';
import type { ArchiveManagementRepository as CompatibleArchiveManagementRepository } from '../domain/archive-management.js';
import {
  ArchiveResumeRequest,
  type ArchiveResume,
  type ManagedArchiveList,
} from '../shared/archive-management.js';
import { ProductError } from '../domain/workspace.js';

export class SqliteMaterialArchivePreparationRepository
  implements MaterialArchivePreparationRepository, ArchiveManagementRepository
{
  constructor(private readonly db: DatabaseSync) {}
  listForPlan(profileId: string, planId: string): Omit<ManagedArchiveList, 'executionEnabled'> {
    return transaction(this.db, () => {
      if (
        !this.db
          .prepare('SELECT id FROM task_plans WHERE id=? AND profile_id=?')
          .get(planId, profileId)
      )
        throw new ProductError('ARCHIVE_PLAN_UNAVAILABLE', '这份浏览器的归档记录不存在', 409);
      const rows = this.db
        .prepare(
          `SELECT s.* FROM material_archive_state s
        JOIN material_reservations r USING(attempt_id) WHERE r.job_id=?
        ORDER BY s.updated_at DESC,s.attempt_id LIMIT 101`,
        )
        .all(planId);
      return {
        profileId,
        planId,
        truncated: rows.length > 100,
        archives: rows.slice(0, 100).map((row) => {
          const id = String(row.attempt_id),
            preparation = this.get(id);
          let resumable = false;
          if (
            (row.state === 'REVIEW' && preparation?.state === 'READY') ||
            (row.state === 'PENDING' && preparation?.state === 'REVIEW')
          ) {
            try {
              this.request(id, ['PENDING', 'REVIEW']);
              resumable = true;
            } catch {
              /* Remains blocked by original evidence. */
            }
          }
          return {
            attemptId: id,
            state: row.state as ManagedArchiveList['archives'][number]['state'],
            revision: Number(row.revision),
            preparationRevision: preparation?.revision ?? 0,
            preparationState: preparation?.state ?? null,
            reason: String(row.reason || preparation?.reason || '').slice(0, 500),
            resumable,
            files:
              preparation?.plan?.files.map((file) => ({
                source: file.sourcePath,
                target: file.targetPath,
                preserveSource:
                  preparation.plan?.version === 2 && 'preserveSource' in file
                    ? file.preserveSource
                    : preparation.request.intent.allowRepeat,
              })) ?? [],
          };
        }),
      };
    });
  }
  assertResume(input: ArchiveResume) {
    const request = ArchiveResumeRequest.parse(input);
    const record = this.listForPlan(request.profileId, request.planId).archives.find(
      (row) => row.attemptId === request.attemptId,
    );
    if (
      !record ||
      !record.resumable ||
      record.revision !== request.expectedRevision ||
      record.preparationRevision !== request.expectedPreparationRevision
    )
      throw new ProductError(
        'ARCHIVE_RESUME_CHANGED',
        '归档状态已变化或仍有未决操作，请重新读取记录',
        409,
      );
    this.request(request.attemptId, ['PENDING', 'REVIEW']);
  }
  pending(limit = 16) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error('ARCHIVE_QUEUE_LIMIT');
    return this.db
      .prepare(
        `
      SELECT r.attempt_id FROM material_archive_requests r
      JOIN material_archive_state s USING(attempt_id)
      JOIN material_reservations h USING(attempt_id)
      JOIN material_publications p USING(attempt_id)
      LEFT JOIN material_archive_preparation a USING(attempt_id)
      WHERE s.state='PENDING' AND (a.state IS NULL OR a.state='READY')
      AND NOT EXISTS (SELECT 1 FROM task_outbox o
        JOIN material_post_operations l ON l.operation_id=o.id WHERE l.attempt_id=r.attempt_id
        AND o.status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN'))
      AND NOT EXISTS (SELECT 1 FROM task_settlement_notices n
        JOIN task_settlement_delivery d USING(operation_id,kind)
        JOIN material_post_operations l ON l.operation_id=n.operation_id
        WHERE l.attempt_id=r.attempt_id AND d.state<>'DELIVERED')
      ORDER BY r.rowid LIMIT ?`,
      )
      .all(limit)
      .map((row) => String(row.attempt_id));
  }
  request(attemptId: string, permittedStates: readonly string[] = ['PENDING']) {
    const row = this.db
      .prepare(
        'SELECT r.body,s.state,p.account_id,p.fingerprint,p.post_id,v.body AS verdict FROM material_archive_requests r JOIN material_archive_state s USING(attempt_id) JOIN material_publications p USING(attempt_id) JOIN material_attempt_verdicts v USING(attempt_id) WHERE attempt_id=?',
      )
      .get(attemptId);
    if (!row || !permittedStates.includes(String(row.state)))
      throw Error('ARCHIVE_PUBLISHED_REQUEST_REQUIRED');
    const request = ArchiveRequest.parse(JSON.parse(String(row.body)) as unknown),
      held = postReservation(this.db, attemptId),
      verdict = AttemptVerdict.parse(JSON.parse(String(row.verdict)) as unknown);
    if (
      request.attemptId !== attemptId ||
      held.state !== 'PUBLISHED' ||
      JSON.stringify(request.intent) !== JSON.stringify(held.intent) ||
      verdict.basis !== 'SUBMIT_OPERATION' ||
      verdict.outcome !== 'PUBLISHED' ||
      verdict.receipt.evidence.postId !== request.postId ||
      row.post_id !== request.postId ||
      row.account_id !== held.intent.context.accountId ||
      row.fingerprint !== held.intent.fingerprint
    )
      throw Error('ARCHIVE_PUBLICATION_MISMATCH');
    if (
      this.db
        .prepare(
          "SELECT o.id FROM task_outbox o JOIN material_post_operations l ON l.operation_id=o.id WHERE l.attempt_id=? AND o.status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
        )
        .get(attemptId)
    )
      throw Error('ARCHIVE_OPERATION_UNRESOLVED');
    if (
      this.db
        .prepare(
          "SELECT n.operation_id FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id,kind) JOIN material_post_operations l ON l.operation_id=n.operation_id WHERE l.attempt_id=? AND d.state<>'DELIVERED'",
        )
        .get(attemptId)
    )
      throw Error('ARCHIVE_NOTICE_PENDING');
    if (request.archiveDirectory === null) referenceArchiveLayout(request);
    else archiveLayout(request);
    return request;
  }
  get(attemptId: string) {
    const row = this.db
      .prepare(
        'SELECT r.body,s.state,s.revision,s.claim_token,s.reason,p.body AS plan FROM material_archive_preparation s JOIN material_archive_requests r USING(attempt_id) LEFT JOIN material_archive_plans p USING(attempt_id) WHERE attempt_id=?',
      )
      .get(attemptId);
    return row
      ? MaterialArchivePreparationRecord.parse({
          request: JSON.parse(String(row.body)) as unknown,
          state: row.state,
          revision: row.revision,
          claimToken: row.claim_token,
          reason: row.reason,
          plan: row.plan === null ? null : (JSON.parse(String(row.plan)) as unknown),
        })
      : null;
  }
  claim(attemptId: string) {
    return transaction(this.db, () => {
      const request = this.request(attemptId),
        old = this.get(attemptId);
      if (old && old.state !== 'REVIEW') throw Error('ARCHIVE_PREPARATION_CLAIM_REJECTED');
      const claim = ArchivePreparationClaim.parse({
        request,
        revision: (old?.revision ?? 0) + 1,
        claimToken: randomUUID(),
      });
      if (old)
        this.db
          .prepare(
            "UPDATE material_archive_preparation SET state='PREPARING',revision=revision+1,claim_token=?,reason='',updated_at=? WHERE attempt_id=?",
          )
          .run(claim.claimToken, Date.now(), attemptId);
      else
        this.db
          .prepare("INSERT INTO material_archive_preparation VALUES(?,'PREPARING',1,?,'',?)")
          .run(attemptId, claim.claimToken, Date.now());
      return claim;
    });
  }
  assertCurrent(input: ArchiveClaim) {
    const claim = ArchivePreparationClaim.parse(input),
      record = this.get(claim.request.attemptId);
    if (
      !record ||
      record.state !== 'PREPARING' ||
      record.claimToken !== claim.claimToken ||
      record.revision !== claim.revision ||
      JSON.stringify(record.request) !== JSON.stringify(claim.request)
    )
      throw Error('ARCHIVE_PREPARATION_CLAIM_REVOKED');
    if (JSON.stringify(this.request(claim.request.attemptId)) !== JSON.stringify(claim.request))
      throw Error('ARCHIVE_PREPARATION_REQUEST_CHANGED');
  }
  ready(claim: ArchiveClaim, input: ArchivePlan) {
    return transaction(this.db, () => {
      this.assertCurrent(claim);
      const plan = MaterialArchivePlan.parse(input);
      const layout = claim.request.archiveDirectory === null ? null : archiveLayout(claim.request);
      if (layout === null) assertArchivePlanLayout(claim.request, plan);
      else if (plan.version !== 1) throw Error('ARCHIVE_PLAN_MISMATCH');
      if (
        JSON.stringify(plan.request) !== JSON.stringify(claim.request) ||
        (layout !== null &&
          plan.version === 1 &&
          (plan.folderPackage !== layout.folderPackage ||
            plan.destination !== layout.destination ||
            JSON.stringify(plan.files) !== JSON.stringify(layout.files)))
      )
        throw Error('ARCHIVE_PLAN_MISMATCH');
      this.db
        .prepare('INSERT INTO material_archive_plans VALUES(?,?,?,?)')
        .run(
          claim.request.attemptId,
          plan.version === 1 ? plan.destination : 'reference-plan:' + claim.request.attemptId,
          JSON.stringify(plan),
          Date.now(),
        );
      this.db
        .prepare(
          "UPDATE material_archive_preparation SET state='READY',revision=revision+1,claim_token=NULL,reason='',updated_at=? WHERE attempt_id=?",
        )
        .run(Date.now(), claim.request.attemptId);
      const saved = this.get(claim.request.attemptId);
      if (!saved) throw Error('ARCHIVE_PREPARATION_MISSING');
      return saved;
    });
  }
  review(claim: ArchiveClaim, reason: string) {
    transaction(this.db, () => {
      const saved = this.get(claim.request.attemptId);
      if (saved?.state === 'READY' || saved?.state === 'REVIEW') return;
      if (!saved || saved.claimToken !== claim.claimToken || saved.revision !== claim.revision)
        throw Error('ARCHIVE_PREPARATION_CLAIM_REVOKED');
      this.db
        .prepare(
          "UPDATE material_archive_preparation SET state='REVIEW',revision=revision+1,claim_token=NULL,reason=?,updated_at=? WHERE attempt_id=?",
        )
        .run(reason.slice(0, 500), Date.now(), claim.request.attemptId);
    });
  }
  recoverOnStartup() {
    return transaction(this.db, () =>
      Number(
        this.db
          .prepare(
            "UPDATE material_archive_preparation SET state='REVIEW',revision=revision+1,claim_token=NULL,reason='SERVICE_RESTART',updated_at=? WHERE state='PREPARING'",
          )
          .run(Date.now()).changes,
      ),
    );
  }
}

type MaterialArchivePreparationRepository =
  SynchronousRepository<CompatibleMaterialArchivePreparationRepository>;
type ArchiveManagementRepository = SynchronousRepository<CompatibleArchiveManagementRepository>;
