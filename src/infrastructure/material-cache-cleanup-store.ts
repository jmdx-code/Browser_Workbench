import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import {
  CacheCleanupPlan,
  CacheCleanupClaim,
  CacheCleanupScope,
  CacheCleanupFile,
  CacheCleanupRecord,
  CacheCleanupCompletion,
  type CleanupPlan,
  type CleanupClaim,
  type CleanupScope,
  type CleanupFile,
  type CleanupCompletion,
} from '../shared/material-cache-cleanup.js';
import { sameBinding, sameExecution } from '../shared/task-execution.js';
import { AttemptVerdict } from '../shared/material-post.js';
import { TaskControlBinding, SessionStopReceipt, sameStop } from '../shared/task-control.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type { MaterialCacheCleanupRepository as CompatibleMaterialCacheCleanupRepository } from '../domain/material-cache-cleanup.js';
import type { SqliteMaterialUploadStageRepository } from './material-upload-stage-store.js';
import type { SqliteTaskTabRepository } from './task-tab-store.js';
import { postReservation } from './material-post-guards.js';
import { transaction } from './sqlite-transaction.js';
import { MaterialCacheOverview } from '../shared/material-cache-management.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class SqliteMaterialCacheCleanupRepository implements MaterialCacheCleanupRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stages: SqliteMaterialUploadStageRepository,
    private readonly tabs: SqliteTaskTabRepository,
  ) {}
  cleanupStop(stageId: string): string {
    const original = this.db
      .prepare('SELECT r.stop_request_id FROM material_cache_cleanup_requests r WHERE stage_id=?')
      .get(stageId);
    if (original) {
      const requestId = String(original.stop_request_id);
      this.release(stageId, requestId);
      return requestId;
    }
    const stage = this.stages.get(stageId);
    const controls = this.db
      .prepare(
        'SELECT b.request_id FROM task_control_bindings b JOIN task_control_receipts r USING(request_id) WHERE b.job_id=? ORDER BY r.created_at DESC LIMIT 20',
      )
      .all(stage.owner.binding.jobId);
    for (const control of controls) {
      try {
        this.release(stageId, String(control.request_id));
        return String(control.request_id);
      } catch {
        /* A previous stop cannot authorize a different execution. */
      }
    }
    throw Error('CACHE_CLEANUP_RELEASE_REQUIRED');
  }
  snapshot() {
    const rows = this.db
      .prepare(
        "SELECT o.stage_id,o.expected_bytes FROM material_upload_stage_owners o LEFT JOIN material_cache_cleanup_state s USING(stage_id) WHERE s.state IS NULL OR s.state<>'CLEANED' ORDER BY o.created_at LIMIT 201",
      )
      .all();
    return MaterialCacheOverview.parse({
      version: 1,
      truncated: rows.length > 200,
      entries: rows.slice(0, 200).map((row) => {
        const stageId = String(row.stage_id);
        const bytes = this.stages.cacheBytes(stageId);
        try {
          this.cleanupStop(stageId);
          return { stageId, bytes, eligible: true, reason: '' };
        } catch (error) {
          return {
            stageId,
            bytes,
            eligible: false,
            reason:
              error instanceof Error
                ? error.message.slice(0, 200)
                : 'CACHE_CLEANUP_RELEASE_REQUIRED',
          };
        }
      }),
    });
  }
  private release(stageId: string, stopRequestId: string): CleanupPlan {
    const stage = this.stages.get(stageId),
      owner = stage.owner,
      held = postReservation(this.db, owner.attemptId),
      intent = held.intent;
    if (!stage.manifest || stage.state === 'WRITING')
      throw Error('CACHE_CLEANUP_MANIFEST_REQUIRED');
    if (
      digest(JSON.stringify(intent)) !== owner.intentDigest ||
      owner.fingerprint !== intent.fingerprint ||
      !sameBinding(stage.manifest.binding, owner.binding)
    )
      throw Error('CACHE_CLEANUP_OWNER_CHANGED');
    const terminalRow = this.db
      .prepare('SELECT body FROM material_attempt_verdicts WHERE attempt_id=?')
      .get(owner.attemptId);
    if (!terminalRow) throw Error('CACHE_CLEANUP_BUSINESS_UNRESOLVED');
    const terminal = AttemptVerdict.parse(JSON.parse(String(terminalRow.body)) as unknown);
    if (terminal.attemptId !== owner.attemptId || terminal.outcome !== held.state)
      throw Error('CACHE_CLEANUP_TERMINAL_MISMATCH');
    if (
      this.db
        .prepare(
          "SELECT id FROM task_outbox WHERE job_id=? AND status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
        )
        .get(owner.binding.jobId)
    )
      throw Error('CACHE_CLEANUP_OPERATION_UNRESOLVED');
    if (
      this.db
        .prepare(
          "SELECT n.operation_id FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id,kind) JOIN task_outbox o ON o.id=n.operation_id WHERE o.job_id=? AND d.state<>'DELIVERED'",
        )
        .get(owner.binding.jobId)
    )
      throw Error('CACHE_CLEANUP_NOTICE_PENDING');
    const closedTab = this.tabs.get(intent.proof.ownershipId, owner.binding.jobId);
    const retained =
      closedTab.state === 'RELEASED' &&
      closedTab.reason === 'NATIVE_CONTROL_RELEASED_PAGE_RETAINED';
    if (
      (!retained && closedTab.state !== 'CLOSED') ||
      closedTab.context !== null ||
      (!retained && closedTab.reason !== 'NATIVE_TAB_CLOSED_CONFIRMED') ||
      closedTab.jobId !== owner.binding.jobId ||
      closedTab.accountId !== owner.binding.accountId ||
      !sameTabProof(closedTab.proof, intent.proof)
    )
      throw Error('CACHE_CLEANUP_NATIVE_CLOSE_REQUIRED');
    const control = this.db
      .prepare(
        'SELECT b.body,r.body AS receipt FROM task_control_bindings b JOIN task_control_receipts r USING(request_id) WHERE request_id=?',
      )
      .get(stopRequestId);
    if (!control) throw Error('CACHE_CLEANUP_NATIVE_STOP_REQUIRED');
    const stopBinding = TaskControlBinding.parse(JSON.parse(String(control.body)) as unknown),
      stopReceipt = SessionStopReceipt.parse(JSON.parse(String(control.receipt)) as unknown);
    if (
      stopBinding.jobId !== owner.binding.jobId ||
      !sameExecution(stopBinding, owner.binding) ||
      !sameStop(stopBinding, stopReceipt)
    )
      throw Error('CACHE_CLEANUP_STOP_MISMATCH');
    if (retained) {
      const saved = this.db
        .prepare('SELECT release_receipt FROM task_tab_state WHERE ownership_id=? AND job_id=?')
        .get(intent.proof.ownershipId, owner.binding.jobId)?.release_receipt;
      if (!saved || !sameStop(stopBinding, SessionStopReceipt.parse(JSON.parse(String(saved)))))
        throw Error('CACHE_CLEANUP_PAGE_RELEASE_UNCONFIRMED');
    }
    return CacheCleanupPlan.parse({
      owner,
      manifest: stage.manifest,
      terminal,
      closedTab,
      stopBinding,
      stopReceipt,
      createdAt: new Date().toISOString(),
    });
  }
  get(stageId: string) {
    const row = this.db
      .prepare(
        'SELECT r.body,s.state,s.revision,s.claim_token,s.reason,c.body AS scope FROM material_cache_cleanup_requests r JOIN material_cache_cleanup_state s USING(stage_id) LEFT JOIN material_cache_cleanup_scopes c USING(stage_id) WHERE stage_id=?',
      )
      .get(stageId);
    if (!row) throw Error('CACHE_CLEANUP_REQUEST_REQUIRED');
    return CacheCleanupRecord.parse({
      plan: JSON.parse(String(row.body)) as unknown,
      state: row.state,
      revision: row.revision,
      claimToken: row.claim_token,
      reason: row.reason,
      scope: row.scope === null ? null : (JSON.parse(String(row.scope)) as unknown),
      directoryRemovalStarted: !!this.db
        .prepare('SELECT stage_id FROM material_cache_directory_removals WHERE stage_id=?')
        .get(stageId),
      files: this.db
        .prepare(
          'SELECT body,state FROM material_cache_cleanup_files WHERE stage_id=? ORDER BY name',
        )
        .all(stageId)
        .map((file) => ({ file: JSON.parse(String(file.body)) as unknown, state: file.state })),
    });
  }
  prepare(stageId: string, stopRequestId: string) {
    return transaction(this.db, () => {
      if (
        this.db
          .prepare('SELECT stage_id FROM material_cache_cleanup_requests WHERE stage_id=?')
          .get(stageId)
      ) {
        const old = this.get(stageId);
        if (old.plan.stopBinding.requestId !== stopRequestId)
          throw Error('CACHE_CLEANUP_REQUEST_CONFLICT');
        return old;
      }
      const plan = this.release(stageId, stopRequestId),
        stage = this.stages.get(stageId);
      this.stages.review(
        { owner: stage.owner, claimToken: stage.claimToken },
        'CACHE_CLEANUP_PREPARED',
      );
      this.db
        .prepare('INSERT INTO material_cache_cleanup_requests VALUES(?,?,?,?)')
        .run(stageId, stopRequestId, JSON.stringify(plan), Date.now());
      this.db
        .prepare("INSERT INTO material_cache_cleanup_state VALUES(?,'PENDING',0,NULL,'',?)")
        .run(stageId, Date.now());
      return this.get(stageId);
    });
  }
  claim(stageId: string, expectedRevision: number) {
    return transaction(this.db, () => {
      const original = this.get(stageId);
      if (original.revision !== expectedRevision || !['PENDING', 'REVIEW'].includes(original.state))
        throw Error('CACHE_CLEANUP_CLAIM_REJECTED');
      const current = this.release(stageId, original.plan.stopBinding.requestId);
      const { createdAt: _current, ...now } = current,
        { createdAt: _original, ...saved } = original.plan;
      if (JSON.stringify(now) !== JSON.stringify(saved))
        throw Error('CACHE_CLEANUP_RELEASE_CHANGED');
      const claim = CacheCleanupClaim.parse({
        plan: original.plan,
        revision: expectedRevision + 1,
        claimToken: randomUUID(),
      });
      this.db
        .prepare(
          "UPDATE material_cache_cleanup_state SET state='DELETING',revision=revision+1,claim_token=?,reason='',updated_at=? WHERE stage_id=?",
        )
        .run(claim.claimToken, Date.now(), stageId);
      return claim;
    });
  }
  assertCurrent(input: CleanupClaim) {
    const claim = CacheCleanupClaim.parse(input),
      record = this.get(claim.plan.owner.stageId);
    if (
      record.state !== 'DELETING' ||
      record.revision !== claim.revision ||
      record.claimToken !== claim.claimToken ||
      JSON.stringify(record.plan) !== JSON.stringify(claim.plan)
    )
      throw Error('CACHE_CLEANUP_CLAIM_REVOKED');
    const current = this.release(claim.plan.owner.stageId, claim.plan.stopBinding.requestId);
    const { createdAt: _current, ...now } = current,
      { createdAt: _original, ...saved } = claim.plan;
    if (JSON.stringify(now) !== JSON.stringify(saved)) throw Error('CACHE_CLEANUP_RELEASE_CHANGED');
  }
  bindScope(claim: CleanupClaim, value: CleanupScope) {
    transaction(this.db, () => {
      this.assertCurrent(claim);
      const scope = CacheCleanupScope.parse(value),
        record = this.get(claim.plan.owner.stageId);
      if (record.scope) {
        if (JSON.stringify(record.scope) !== JSON.stringify(scope))
          throw Error('CACHE_CLEANUP_SCOPE_CHANGED');
        return;
      }
      this.db
        .prepare('INSERT INTO material_cache_cleanup_scopes VALUES(?,?)')
        .run(claim.plan.owner.stageId, JSON.stringify(scope));
    });
  }
  beginFile(claim: CleanupClaim, value: CleanupFile) {
    transaction(this.db, () => {
      this.assertCurrent(claim);
      const file = CacheCleanupFile.parse(value),
        stageId = claim.plan.owner.stageId,
        record = this.get(stageId);
      if (!record.scope || record.directoryRemovalStarted)
        throw Error('CACHE_CLEANUP_SCOPE_REQUIRED');
      const payload = claim.plan.manifest.files.find((row) => row.name === file.name),
        ready = JSON.stringify(claim.plan.manifest);
      if (
        payload
          ? file.bytes !== payload.original.bytes ||
            file.digest !== payload.original.digest ||
            JSON.stringify(file.proof) !== JSON.stringify(payload.proof)
          : file.name !== 'ready.json' ||
            file.bytes !== Buffer.byteLength(ready) ||
            file.digest !== digest(ready)
      )
        throw Error('CACHE_CLEANUP_FILE_MISMATCH');
      const existing = record.files.find((row) => row.file.name === file.name);
      if (existing) {
        if (JSON.stringify(existing.file) !== JSON.stringify(file) || existing.state === 'DELETED')
          throw Error('CACHE_CLEANUP_FILE_CHANGED');
        return;
      }
      this.db
        .prepare("INSERT INTO material_cache_cleanup_files VALUES(?,?,?,'DELETING')")
        .run(stageId, file.name, JSON.stringify(file));
    });
  }
  deletedFile(claim: CleanupClaim, name: string) {
    transaction(this.db, () => {
      this.assertCurrent(claim);
      const record = this.get(claim.plan.owner.stageId),
        file = record.files.find((row) => row.file.name === name);
      if (!file) throw Error('CACHE_CLEANUP_DELETE_INTENT_REQUIRED');
      if (file.state === 'DELETED') return;
      this.db
        .prepare(
          "UPDATE material_cache_cleanup_files SET state='DELETED' WHERE stage_id=? AND name=?",
        )
        .run(claim.plan.owner.stageId, name);
    });
  }
  beginDirectoryRemoval(claim: CleanupClaim) {
    transaction(this.db, () => {
      this.assertCurrent(claim);
      const record = this.get(claim.plan.owner.stageId);
      if (
        !record.scope ||
        record.files.length !== claim.plan.manifest.files.length + 1 ||
        record.files.some((file) => file.state !== 'DELETED')
      )
        throw Error('CACHE_CLEANUP_FILES_UNFINISHED');
      if (record.directoryRemovalStarted) return;
      this.db
        .prepare('INSERT INTO material_cache_directory_removals VALUES(?,?)')
        .run(claim.plan.owner.stageId, Date.now());
    });
  }
  complete(claim: CleanupClaim, value: CleanupCompletion) {
    transaction(this.db, () => {
      this.assertCurrent(claim);
      const completion = CacheCleanupCompletion.parse(value),
        record = this.get(claim.plan.owner.stageId);
      if (
        !record.directoryRemovalStarted ||
        record.files.length !== claim.plan.manifest.files.length + 1 ||
        record.files.some((row) => row.state !== 'DELETED') ||
        completion.stageId !== claim.plan.owner.stageId ||
        JSON.stringify(completion.scope) !== JSON.stringify(record.scope)
      )
        throw Error('CACHE_CLEANUP_COMPLETION_REJECTED');
      this.db
        .prepare('INSERT INTO material_cache_cleanup_completions VALUES(?,?,?)')
        .run(completion.stageId, JSON.stringify(completion), Date.now());
      this.db
        .prepare(
          "UPDATE material_cache_cleanup_state SET state='CLEANED',revision=revision+1,claim_token=NULL,reason='',updated_at=? WHERE stage_id=?",
        )
        .run(Date.now(), completion.stageId);
    });
  }
  review(claim: CleanupClaim, reason: string) {
    transaction(this.db, () => {
      const record = this.get(claim.plan.owner.stageId);
      if (record.state === 'CLEANED' || record.state === 'REVIEW') return;
      if (record.claimToken !== claim.claimToken || record.revision !== claim.revision)
        throw Error('CACHE_CLEANUP_CLAIM_REVOKED');
      this.db
        .prepare(
          "UPDATE material_cache_cleanup_state SET state='REVIEW',revision=revision+1,claim_token=NULL,reason=?,updated_at=? WHERE stage_id=?",
        )
        .run(reason.slice(0, 500), Date.now(), claim.plan.owner.stageId);
    });
  }
  recoverOnStartup() {
    return transaction(this.db, () =>
      Number(
        this.db
          .prepare(
            "UPDATE material_cache_cleanup_state SET state='REVIEW',revision=revision+1,claim_token=NULL,reason='SERVICE_RESTART',updated_at=? WHERE state='DELETING'",
          )
          .run(Date.now()).changes,
      ),
    );
  }
}

type MaterialCacheCleanupRepository =
  SynchronousRepository<CompatibleMaterialCacheCleanupRepository>;
