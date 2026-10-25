import type { DatabaseSync } from 'node:sqlite';
import type { Operation } from '../shared/task-contracts.js';
import { AttemptVerdict, PostOperation } from '../shared/material-post.js';
import { postReservation } from './material-post-guards.js';

// Called only inside the original SQLite transaction. A persisted dispatch binding is
// irreversible evidence: even a subsequently failed/cancelled operation needs review.
export function cancelNeverDispatchedPost(
  db: DatabaseSync,
  attemptId: string,
  operations: readonly Operation[],
): boolean {
  const held = postReservation(db, attemptId),
    previous = db
      .prepare('SELECT body FROM material_attempt_verdicts WHERE attempt_id=?')
      .get(attemptId);
  if (previous) {
    const result = AttemptVerdict.parse(JSON.parse(String(previous.body)) as unknown);
    if (result.basis !== 'LOCAL_NEVER_DISPATCHED') throw Error('POST_ATTEMPT_VERDICT_CONFLICT');
    return true;
  }
  const links = db
    .prepare(
      'SELECT operation_id FROM material_post_operations WHERE attempt_id=? ORDER BY sequence',
    )
    .all(attemptId);
  if (
    links.some((link) => {
      const op = operations.find((value) => value.id === link.operation_id);
      return (
        !op ||
        op.jobId !== held.intent.jobId ||
        op.binding ||
        !['PREPARED', 'CANCELLED'].includes(op.status)
      );
    })
  )
    return false;
  const ids = links.map((link) => String(link.operation_id)),
    now = Date.now();
  for (const id of ids)
    db.prepare(
      "UPDATE task_outbox SET status='CANCELLED',updated_at=? WHERE id=? AND status='PREPARED'",
    ).run(now, id);
  const result = AttemptVerdict.parse({
    attemptId,
    outcome: 'NOT_PUBLISHED',
    basis: 'LOCAL_NEVER_DISPATCHED',
    operationIds: ids,
  });
  db.prepare('INSERT INTO material_attempt_verdicts VALUES(?,?,?,?)').run(
    attemptId,
    result.outcome,
    JSON.stringify(result),
    now,
  );
  db.prepare(
    "UPDATE material_reservations SET state='NOT_PUBLISHED',reason='LOCAL_NEVER_DISPATCHED',updated_at=? WHERE attempt_id=?",
  ).run(now, attemptId);
  return true;
}

// Unlike upload effect, never dispatching SUBMIT is a durable local fact. Call only after
// current physical stop and end-notice delivery, inside the original task transaction.
export function endPostWithoutSubmit(
  db: DatabaseSync,
  attemptId: string,
  operations: readonly Operation[],
  endingId: string,
): boolean {
  const held = postReservation(db, attemptId);
  if (!['RESERVED', 'REVIEW'].includes(held.state)) return held.state === 'NOT_PUBLISHED';
  const rows = db
    .prepare('SELECT body FROM material_post_operations WHERE attempt_id=? ORDER BY sequence')
    .all(attemptId);
  const ids: string[] = [];
  for (const row of rows) {
    const link = PostOperation.parse(JSON.parse(String(row.body)) as unknown);
    const op = operations.find((item) => item.id === link.operationId);
    if (
      !op ||
      op.jobId !== held.intent.jobId ||
      (link.purpose === 'SUBMIT' && (op.binding || !['PREPARED', 'CANCELLED'].includes(op.status)))
    )
      return false;
    ids.push(op.id);
  }
  // Missing operation-purpose links cannot prove that no final submit was sent.
  if (
    operations.some(
      (op) =>
        op.binding &&
        op.action.kind === 'click' &&
        !db.prepare('SELECT 1 FROM material_post_operations WHERE operation_id=?').get(op.id),
    )
  )
    return false;
  if (db.prepare('SELECT 1 FROM material_attempt_verdicts WHERE attempt_id=?').get(attemptId))
    return false;
  const result = AttemptVerdict.parse({
    attemptId,
    outcome: 'NOT_PUBLISHED',
    basis: 'CURRENT_STOP_NO_SUBMIT',
    endingId,
    operationIds: ids,
  });
  db.prepare('INSERT INTO material_attempt_verdicts VALUES(?,?,?,?)').run(
    attemptId,
    result.outcome,
    JSON.stringify(result),
    Date.now(),
  );
  db.prepare(
    "UPDATE material_reservations SET state='NOT_PUBLISHED',reason='CURRENT_STOP_NO_SUBMIT',updated_at=? WHERE attempt_id=?",
  ).run(Date.now(), attemptId);
  return true;
}
