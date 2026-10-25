import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import type { FacebookSubmissionObservationRepository as CompatibleFacebookSubmissionObservationRepository } from '../domain/facebook-submission-observations.js';
import {
  FacebookSubmissionBaseline,
  FacebookPostResultCorrelation,
  type SubmissionBaseline,
  type PostResultCorrelation,
} from '../shared/facebook-post-observation.js';
import { DispatchBinding, sameBinding } from '../shared/task-execution.js';
import { assertPostReady, postLink } from './material-post-guards.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { transaction } from './sqlite-transaction.js';

export class SqliteFacebookSubmissionObservationRepository implements FacebookSubmissionObservationRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(operationId: string) {
    const row = this.db
      .prepare('SELECT body FROM facebook_submission_observations WHERE operation_id=?')
      .get(operationId);
    return row ? FacebookSubmissionBaseline.parse(JSON.parse(String(row.body))) : null;
  }
  result(operationId: string) {
    const row = this.db
      .prepare('SELECT body FROM facebook_submission_results WHERE operation_id=?')
      .get(operationId);
    return row ? FacebookPostResultCorrelation.parse(JSON.parse(String(row.body))) : null;
  }
  captureResult(input: PostResultCorrelation) {
    const value = FacebookPostResultCorrelation.parse(input);
    return transaction(this.db, () => {
      const baseline = this.get(value.binding.operationId);
      const row = this.db
        .prepare(
          'SELECT o.status,b.body FROM task_outbox o JOIN task_dispatch_bindings b ON b.operation_id=o.id WHERE o.id=?',
        )
        .get(value.binding.operationId);
      if (
        !baseline ||
        !['DISPATCHING', 'ACKNOWLEDGED'].includes(String(row?.status)) ||
        !sameBinding(DispatchBinding.parse(JSON.parse(String(row?.body))), value.binding) ||
        !sameBinding(value.binding, baseline.binding) ||
        value.attemptId !== baseline.attemptId ||
        value.fingerprint !== baseline.fingerprint ||
        !sameTabProof(value.proof, baseline.proof) ||
        baseline.postIds.includes(value.postId)
      )
        throw Error('ORIGINAL_PENDING_SUBMISSION_REQUIRED');
      assertPostReady(this.db, value.attemptId, value.binding);
      const old = this.result(value.binding.operationId);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(value))
          throw Error('SUBMISSION_RESULT_CONFLICT');
        return old;
      }
      this.db
        .prepare('INSERT INTO facebook_submission_results VALUES(?,?,?)')
        .run(value.binding.operationId, JSON.stringify(value), Date.now());
      return value;
    });
  }
  capture(input: SubmissionBaseline) {
    const value = FacebookSubmissionBaseline.parse(input);
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          'SELECT o.status,b.body FROM task_outbox o JOIN task_dispatch_bindings b ON b.operation_id=o.id WHERE o.id=?',
        )
        .get(value.operationId);
      const link = postLink(this.db, value.operationId);
      if (
        row?.status !== 'DISPATCHING' ||
        !link ||
        link.purpose !== 'SUBMIT' ||
        link.attemptId !== value.attemptId ||
        !sameBinding(DispatchBinding.parse(JSON.parse(String(row.body))), value.binding)
      )
        throw Error('ORIGINAL_ACTIVE_SUBMISSION_REQUIRED');
      const held = assertPostReady(this.db, value.attemptId, value.binding);
      if (
        held.intent.fingerprint !== value.fingerprint ||
        !sameTabProof(held.intent.proof, value.proof) ||
        value.checkedAt > Date.now() ||
        Date.now() - value.checkedAt > 5000 ||
        new URL(value.url).origin !== 'https://www.facebook.com' ||
        new Set(value.postIds).size !== value.postIds.length
      )
        throw Error('SUBMISSION_BASELINE_INVALID');
      const previous = this.get(value.operationId);
      if (previous) {
        // Repeated native input guards retain the original witness, never refresh it after input.
        if (
          !sameBinding(previous.binding, value.binding) ||
          previous.attemptId !== value.attemptId ||
          previous.fingerprint !== value.fingerprint ||
          previous.url !== value.url ||
          previous.timeOrigin !== value.timeOrigin ||
          JSON.stringify(previous.postIds) !== JSON.stringify(value.postIds)
        )
          throw Error('SUBMISSION_BASELINE_CHANGED');
        return previous;
      }
      this.db
        .prepare('INSERT INTO facebook_submission_observations VALUES(?,?,?,?)')
        .run(value.operationId, value.attemptId, JSON.stringify(value), Date.now());
      return value;
    });
  }
}

type FacebookSubmissionObservationRepository =
  SynchronousRepository<CompatibleFacebookSubmissionObservationRepository>;
