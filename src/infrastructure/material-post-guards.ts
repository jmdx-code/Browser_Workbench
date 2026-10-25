import type { DatabaseSync } from 'node:sqlite';
import { MaterialPostIntent, MaterialReservation } from '../shared/material-index.js';
import { PostOperation, PostReceipt } from '../shared/material-post.js';
import type { Action } from '../shared/browser-actions.js';
import {
  ExecutionContext,
  sameExecution,
  type ExecutionSession,
  type ExecutionReceipt,
} from '../shared/task-execution.js';
import { OwnedTabProof } from '../shared/kernel-state.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { validatePostAction, postAILabelSetting } from '../domain/material-post.js';
import { TaskProgress } from '../shared/task-contracts.js';
import { StepSchema } from '../shared/contracts.js';

export function postLink(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT body FROM material_post_operations WHERE operation_id=?').get(id);
  return row ? PostOperation.parse(JSON.parse(String(row.body)) as unknown) : null;
}
export function postReservation(db: DatabaseSync, id: string) {
  const row = db
    .prepare(
      'SELECT i.body,i.created_at,r.state,r.reason,r.updated_at FROM material_post_intents i JOIN material_reservations r USING(attempt_id) WHERE attempt_id=?',
    )
    .get(id);
  if (!row) throw Error('POST_RESERVATION_REQUIRED');
  return MaterialReservation.parse({
    intent: JSON.parse(String(row.body)) as unknown,
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export function assertPostReady(db: DatabaseSync, id: string, context?: ExecutionSession) {
  const held = postReservation(db, id),
    intent = MaterialPostIntent.parse(held.intent);
  if (held.state !== 'RESERVED' || (context && !sameExecution(context, intent.context)))
    throw Error('POST_RESERVATION_NOT_READY');
  const row = db
    .prepare(
      'SELECT p.state,p.profile_id,p.account_id,p.round,p.position,s.round AS step_round,s.position AS step_position,s.status,s.progress FROM task_plans p JOIN task_steps s ON s.job_id=p.id WHERE p.id=? AND s.id=?',
    )
    .get(intent.jobId, intent.stepId);
  if (
    !row ||
    row.state !== 'RUNNING' ||
    row.profile_id !== intent.context.profileId ||
    row.account_id !== intent.context.accountId ||
    row.round !== row.step_round ||
    row.position !== row.step_position ||
    row.status !== 'ACTIVE'
  )
    throw Error('POST_PLAN_NOT_READY');
  const progress = TaskProgress.parse(JSON.parse(String(row.progress)) as unknown);
  if (
    progress.published !== intent.ordinal - 1 ||
    progress.revision < intent.expectedProgressRevision
  )
    throw Error('POST_CHECKPOINT_CHANGED');
  const lock = db
    .prepare('SELECT job_id FROM task_account_locks WHERE account_id=?')
    .get(intent.context.accountId);
  if (lock?.job_id !== intent.jobId) throw Error('POST_ACCOUNT_LOCK_REQUIRED');
  const tab = db
    .prepare(
      'SELECT o.job_id,o.proof,s.state,s.context FROM task_tab_ownership o JOIN task_tab_state s USING(ownership_id,job_id) WHERE ownership_id=? AND job_id=?',
    )
    .get(intent.proof.ownershipId, intent.jobId);
  if (
    !tab ||
    tab.job_id !== intent.jobId ||
    tab.state !== 'READY' ||
    !tab.context ||
    !sameExecution(
      ExecutionContext.parse(JSON.parse(String(tab.context)) as unknown),
      intent.context,
    ) ||
    !sameTabProof(OwnedTabProof.parse(JSON.parse(String(tab.proof)) as unknown), intent.proof)
  )
    throw Error('POST_TARGET_NOT_READY');
  return held;
}
export function assertPostPreparation(
  db: DatabaseSync,
  jobId: string,
  stepId: string,
  operationId: string,
  action: Action,
) {
  const link = postLink(db, operationId);
  if (!link) throw Error('POST_OPERATION_INTENT_REQUIRED');
  const held = assertPostReady(db, link.attemptId);
  if (
    held.intent.jobId !== jobId ||
    held.intent.stepId !== stepId ||
    JSON.stringify(action) !== JSON.stringify(link.action)
  )
    throw Error('POST_OPERATION_INTENT_MISMATCH');
  validatePostAction(held.intent, link.purpose, action);
  assertPostMediaPreparation(db, held.intent, link.purpose);
}
export function assertPostMediaPreparation(
  db: DatabaseSync,
  intent: import('../shared/material-index.js').PostIntent,
  purpose: import('../shared/material-post.js').PostLink['purpose'],
) {
  if (['OPEN_AI_LABEL', 'SET_AI_LABEL', 'CONFIRM_AI_LABEL'].includes(purpose)) {
    const raw = db
      .prepare('SELECT spec FROM task_steps WHERE id=? AND job_id=?')
      .get(intent.stepId, intent.jobId);
    const step = StepSchema.parse(JSON.parse(String(raw?.spec)) as unknown);
    if (
      step.type !== 'post' ||
      step.destination === 'story' ||
      !['on', 'off'].includes(postAILabelSetting(intent, step.aiLabel)) ||
      db
        .prepare("SELECT version FROM workspace_execution_contracts WHERE name='post-ai-label'")
        .get()?.version !== 1
    )
      throw Error('POST_AI_LABEL_STEP_REQUIRED');
    const verified = (value: string) =>
      !!db
        .prepare(
          "SELECT o.operation_id FROM material_post_operations o JOIN material_operation_verdicts v USING(operation_id) WHERE o.attempt_id=? AND o.purpose=? AND v.outcome='APPLIED'",
        )
        .get(intent.attemptId, value);
    if (
      !verified('OPEN_COMPOSER') ||
      (purpose !== 'OPEN_AI_LABEL' && !verified('OPEN_AI_LABEL')) ||
      db
        .prepare(
          "SELECT operation_id FROM material_post_operations WHERE attempt_id=? AND purpose IN ('SET_TEXT','PREPARE_MEDIA','UPLOAD_MEDIA','ADVANCE_COMPOSER','SUBMIT')",
        )
        .get(intent.attemptId)
    )
      throw Error('POST_AI_LABEL_PHASE_INVALID');
  }
  const storyPurpose = [
    'PREPARE_STORY',
    'SELECT_FRIENDS',
    'VERIFY_AUDIENCE',
    'CLOSE_AUDIENCE',
  ].includes(purpose);
  if (storyPurpose || purpose === 'SET_TEXT' || purpose === 'SUBMIT') {
    const row = db
      .prepare('SELECT spec FROM task_steps WHERE id=? AND job_id=?')
      .get(intent.stepId, intent.jobId);
    const step = StepSchema.parse(JSON.parse(String(row?.spec)) as unknown);
    const story = step.type === 'post' && step.destination === 'story';
    if (storyPurpose && (!story || step.audience !== 'friends'))
      throw Error('STORY_PRIVACY_STEP_REQUIRED');
    if (story && (purpose === 'SET_TEXT' || purpose === 'SUBMIT')) {
      const closed = db
        .prepare(
          "SELECT o.operation_id FROM material_post_operations o JOIN material_operation_verdicts v USING(operation_id) WHERE o.attempt_id=? AND o.purpose='CLOSE_AUDIENCE' AND v.outcome='APPLIED'",
        )
        .get(intent.attemptId);
      if (step.audience !== 'friends' || !closed) throw Error('STORY_VERIFIED_AUDIENCE_REQUIRED');
    }
  }
  if (intent.snapshot.format === 'text') return;
  const applied = db
    .prepare(
      "SELECT o.operation_id FROM material_post_operations o JOIN material_operation_verdicts v USING(operation_id) WHERE o.attempt_id=? AND o.purpose='UPLOAD_MEDIA' AND v.outcome='APPLIED'",
    )
    .get(intent.attemptId);
  if (['SUBMIT', 'ADVANCE_COMPOSER'].includes(purpose) && !applied)
    throw Error('POST_MEDIA_UPLOAD_NOT_VERIFIED');
  if (purpose === 'UPLOAD_MEDIA' && applied) throw Error('POST_MEDIA_ALREADY_UPLOADED');
}
export function assertPostDispatch(db: DatabaseSync, id: string, context: ExecutionSession) {
  const link = postLink(db, id);
  if (!link) throw Error('POST_OPERATION_INTENT_REQUIRED');
  const held = assertPostReady(db, link.attemptId, context);
  assertPostMediaPreparation(db, held.intent, link.purpose);
  if (
    db
      .prepare(
        "SELECT n.operation_id FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id,kind) WHERE n.profile_id=? AND d.state<>'DELIVERED'",
      )
      .get(context.profileId)
  )
    throw Error('POST_SETTLEMENT_NOTICE_PENDING');
}
export function canonicalPostReceipt(input: ExecutionReceipt) {
  return PostReceipt.parse(input);
}
export function assertPostSettlement(
  db: DatabaseSync,
  input: ExecutionReceipt,
  outcome: 'VERIFIED' | 'NOT_APPLIED',
) {
  const link = postLink(db, input.binding.operationId);
  if (!link) return;
  const receipt = canonicalPostReceipt(input),
    expected = ['APPLIED', 'PUBLISHED'].includes(receipt.evidence.outcome)
      ? 'VERIFIED'
      : 'NOT_APPLIED';
  const row = db
    .prepare('SELECT body FROM material_operation_verdicts WHERE operation_id=?')
    .get(input.binding.operationId);
  if (outcome !== expected || !row || String(row.body) !== JSON.stringify(receipt))
    throw Error('POST_BUSINESS_SETTLEMENT_REQUIRED');
}
