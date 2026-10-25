import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MaterialArchiveExecutionRepository as CompatibleMaterialArchiveExecutionRepository } from '../domain/material-archive-execution.js';
import {
  ArchiveExecutionClaim,
  ArchiveIoStep,
  ArchiveIoProof,
  type ArchiveExecution,
  type ArchiveStep,
  type ArchiveProof,
} from '../shared/material-archive-execution.js';
import { SqliteMaterialArchivePreparationRepository } from './material-archive-store.js';
import { transaction } from './sqlite-transaction.js';
import { archiveSourceKey, sharedArchiveSource } from './material-archive-source-protection.js';

export class SqliteMaterialArchiveExecutionRepository implements MaterialArchiveExecutionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly preparation: SqliteMaterialArchivePreparationRepository,
  ) {}
  completed(id: string) {
    return (
      this.db.prepare('SELECT state FROM material_archive_state WHERE attempt_id=?').get(id)
        ?.state === 'COMPLETED'
    );
  }
  claim(attemptId: string) {
    return transaction(this.db, () => {
      const request = this.preparation.request(attemptId, ['PENDING', 'REVIEW']);
      const ready = this.preparation.get(attemptId);
      if (
        ready?.state !== 'READY' ||
        !ready.plan ||
        JSON.stringify(ready.plan.request) !== JSON.stringify(request)
      )
        throw Error('ARCHIVE_READY_PLAN_REQUIRED');
      const old = this.db
        .prepare('SELECT * FROM material_archive_workers WHERE attempt_id=?')
        .get(attemptId);
      if (old && old.token !== null) throw Error('ARCHIVE_WORKER_HELD');
      const claim = ArchiveExecutionClaim.parse({
        attemptId,
        revision: Number(old?.revision ?? 0) + 1,
        token: randomUUID(),
        plan: ready.plan,
      });
      this.db
        .prepare(
          'INSERT INTO material_archive_workers VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET token=excluded.token,revision=excluded.revision',
        )
        .run(attemptId, claim.token, claim.revision);
      this.db
        .prepare(
          "UPDATE material_archive_state SET state='MOVING',revision=revision+1,reason='',updated_at=? WHERE attempt_id=?",
        )
        .run(Date.now(), attemptId);
      return claim;
    });
  }
  assertCurrent(input: ArchiveExecution) {
    const claim = ArchiveExecutionClaim.parse(input);
    const row = this.db
      .prepare(
        'SELECT w.*,s.state,p.body FROM material_archive_workers w JOIN material_archive_state s USING(attempt_id) JOIN material_archive_plans p USING(attempt_id) WHERE attempt_id=?',
      )
      .get(claim.attemptId);
    if (
      !row ||
      row.state !== 'MOVING' ||
      row.token !== claim.token ||
      row.revision !== claim.revision ||
      row.body !== JSON.stringify(claim.plan)
    )
      throw Error('ARCHIVE_WORKER_REVOKED');
    this.preparation.request(claim.attemptId, ['MOVING']);
  }
  step(claim: ArchiveExecution, input: ArchiveStep) {
    return transaction(this.db, () => {
      this.assertCurrent(claim);
      const step = ArchiveIoStep.parse(input),
        old = this.db
          .prepare('SELECT body FROM material_archive_io WHERE attempt_id=? AND step_key=?')
          .get(claim.attemptId, step.key);
      const permitted = claim.plan.files.some((f) =>
        step.kind === 'COPY'
          ? step.path === f.targetPath
          : step.kind === 'DIRECTORY'
            ? [path.dirname(f.targetPath), path.dirname(path.dirname(f.targetPath))].includes(
                step.path,
              )
            : step.path === f.sourcePath,
      );
      if (!permitted || step.key !== step.kind + ':' + step.path)
        throw Error('ARCHIVE_IO_STEP_SCOPE');
      if (old && old.body !== JSON.stringify(step)) throw Error('ARCHIVE_IO_STEP_CONFLICT');
      if (!old)
        this.db
          .prepare('INSERT INTO material_archive_io VALUES(?,?,?,?)')
          .run(claim.attemptId, step.key, JSON.stringify(step), Date.now());
      const proof = this.db
        .prepare('SELECT body FROM material_archive_io_proofs WHERE attempt_id=? AND step_key=?')
        .get(claim.attemptId, step.key);
      return {
        fresh: !old,
        proof: proof ? ArchiveIoProof.parse(JSON.parse(String(proof.body)) as unknown) : null,
      };
    });
  }
  prove(claim: ArchiveExecution, step: ArchiveStep, input: ArchiveProof) {
    transaction(this.db, () => {
      const current = this.step(claim, step),
        proof = ArchiveIoProof.parse(input);
      if (proof.kind !== step.kind) throw Error('ARCHIVE_IO_PROOF_SCOPE');
      if (proof.kind === 'COPY') {
        const file = claim.plan.files.find((f) => f.targetPath === step.path);
        if (
          !file ||
          file.original.digest !== proof.digest ||
          String(file.original.bytes) !== proof.stat.size
        )
          throw Error('ARCHIVE_COPY_PROOF_SCOPE');
      }
      if (
        proof.kind === 'DELETE' &&
        !this.db
          .prepare(
            "SELECT attempt_id FROM material_archive_source_locks WHERE attempt_id=? AND source_key=? AND state='LOCKED'",
          )
          .get(claim.attemptId, archiveSourceKey(step.path))
      )
        throw Error('ARCHIVE_DELETE_LOCK_REQUIRED');
      if (current.proof) {
        if (JSON.stringify(current.proof) !== JSON.stringify(proof))
          throw Error('ARCHIVE_IO_PROOF_CONFLICT');
        return;
      }
      this.db
        .prepare('INSERT INTO material_archive_io_proofs VALUES(?,?,?,?)')
        .run(claim.attemptId, step.key, JSON.stringify(proof), Date.now());
    });
  }
  protectSource(claim: ArchiveExecution, source: string) {
    return transaction(this.db, () => {
      this.assertCurrent(claim);
      if (!claim.plan.files.some((f) => f.sourcePath === source))
        throw Error('ARCHIVE_SOURCE_SCOPE');
      const key = archiveSourceKey(source);
      const lock = this.db
        .prepare(
          "SELECT attempt_id FROM material_archive_source_locks WHERE source_key=? AND state='LOCKED'",
        )
        .get(key);
      if (lock) {
        if (lock.attempt_id !== claim.attemptId) throw Error('ARCHIVE_SOURCE_HELD');
        return 'DELETE' as const;
      }
      if (sharedArchiveSource(this.db, claim.plan.request.intent, source)) return 'KEEP' as const;
      this.db
        .prepare("INSERT INTO material_archive_source_locks VALUES(?,?,'LOCKED')")
        .run(claim.attemptId, key);
      return 'DELETE' as const;
    });
  }
  complete(claim: ArchiveExecution) {
    transaction(this.db, () => {
      this.assertCurrent(claim);
      for (const file of claim.plan.files) {
        const copy = this.step(claim, {
          key: 'COPY:' + file.targetPath,
          kind: 'COPY',
          path: file.targetPath,
        }).proof;
        const keep = this.db
          .prepare('SELECT body FROM material_archive_io_proofs WHERE attempt_id=? AND step_key=?')
          .get(claim.attemptId, 'KEEP:' + file.sourcePath);
        const removed = this.db
          .prepare('SELECT body FROM material_archive_io_proofs WHERE attempt_id=? AND step_key=?')
          .get(claim.attemptId, 'DELETE:' + file.sourcePath);
        if (copy?.kind !== 'COPY' || copy.digest !== file.original.digest || (!keep && !removed))
          throw Error('ARCHIVE_FILE_PROOF_REQUIRED');
      }
      this.db
        .prepare('INSERT INTO material_archive_completions VALUES(?,?,?)')
        .run(
          claim.attemptId,
          JSON.stringify({ version: 1, plan: claim.plan, sourceFolderRemoved: false }),
          Date.now(),
        );
      this.db
        .prepare(
          "UPDATE material_archive_state SET state='COMPLETED',revision=revision+1,reason='',updated_at=? WHERE attempt_id=?",
        )
        .run(Date.now(), claim.attemptId);
      this.db
        .prepare("UPDATE material_archive_source_locks SET state='RELEASED' WHERE attempt_id=?")
        .run(claim.attemptId);
      this.db
        .prepare('UPDATE material_archive_workers SET token=NULL WHERE attempt_id=?')
        .run(claim.attemptId);
    });
  }
  review(claim: ArchiveExecution, reason: string) {
    transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT token,revision FROM material_archive_workers WHERE attempt_id=?')
        .get(claim.attemptId);
      if (!row || row.token !== claim.token || row.revision !== claim.revision) return;
      this.db
        .prepare(
          "UPDATE material_archive_state SET state='REVIEW',revision=revision+1,reason=?,updated_at=? WHERE attempt_id=? AND state='MOVING'",
        )
        .run(reason.slice(0, 500), Date.now(), claim.attemptId);
      this.db
        .prepare(
          'UPDATE material_archive_workers SET token=NULL,revision=revision+1 WHERE attempt_id=?',
        )
        .run(claim.attemptId);
      // Source locks survive uncertain deletion, even after worker revocation.
    });
  }
  recoverOnStartup() {
    return transaction(this.db, () => {
      const count = Number(
        this.db
          .prepare(
            "UPDATE material_archive_state SET state='REVIEW',revision=revision+1,reason='ARCHIVE_SERVICE_RESTART',updated_at=? WHERE state='MOVING'",
          )
          .run(Date.now()).changes,
      );
      this.db
        .prepare(
          'UPDATE material_archive_workers SET token=NULL,revision=revision+1 WHERE token IS NOT NULL',
        )
        .run();
      return count;
    });
  }
}

type MaterialArchiveExecutionRepository =
  SynchronousRepository<CompatibleMaterialArchiveExecutionRepository>;
