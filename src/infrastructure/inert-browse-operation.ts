import type { DatabaseSync } from 'node:sqlite';
import { Action, type Action as BrowserAction } from '../shared/browser-actions.js';
import { BrowseOperationIntent } from '../shared/browse-execution.js';
import { validateBrowseIntent } from '../domain/browse-policy.js';
import { DispatchBinding, type Binding } from '../shared/task-execution.js';
import { TaskStepV2 } from '../shared/task-step-instance.js';
import { prepareCached } from './sqlite-statement-cache.js';

export type InertAuxiliaryPurpose = 'play' | 'advance' | 'dismiss' | 'activate';
export type InertAuxiliaryClassification =
  { ok: false } | { ok: true; purpose?: InertAuxiliaryPurpose };

const INERT_AUXILIARY_PURPOSES: ReadonlySet<string> = new Set([
  'play',
  'advance',
  'dismiss',
  'activate',
]);
const UNREGISTERED_INERT_ACTIONS: ReadonlySet<string> = new Set([
  'browseScroll',
  'browseNavigate',
  'browsePlay',
  'activateTab',
]);

export function classifySqliteInertAuxiliaryBrowseOperation(
  db: DatabaseSync,
  op: {
    id: string;
    jobId: string;
    stepId: string;
    action: BrowserAction;
    binding: Binding | null;
  },
): InertAuxiliaryClassification {
  try {
    if (
      prepareCached(db, 'SELECT 1 FROM material_post_operations WHERE operation_id=? LIMIT 1').get(
        op.id,
      )
    ) {
      return { ok: false };
    }
    if (
      op.binding &&
      (op.binding.operationId !== op.id ||
        op.binding.jobId !== op.jobId ||
        op.binding.stepId !== op.stepId)
    ) {
      return { ok: false };
    }
    const stepRow = prepareCached(db, 'SELECT * FROM task_steps WHERE id=? AND job_id=?').get(
      op.stepId,
      op.jobId,
    );
    if (!stepRow) return { ok: false };
    const step = TaskStepV2.parse({
      id: stepRow.id,
      jobId: stepRow.job_id,
      round: stepRow.round,
      position: stepRow.position,
      spec: JSON.parse(String(stepRow.spec)) as unknown,
      status: stepRow.status,
      progress: JSON.parse(String(stepRow.progress)) as unknown,
      ...(stepRow.outcome ? { outcome: JSON.parse(String(stepRow.outcome)) as unknown } : {}),
    });
    if (step.spec.type === 'post') return { ok: false };
    const intentRow = prepareCached(
      db,
      'SELECT body FROM task_browse_intents WHERE operation_id=?',
    ).get(op.id);
    if (intentRow) {
      const registered = BrowseOperationIntent.parse(JSON.parse(String(intentRow.body)) as unknown);
      if (
        registered.operationId !== op.id ||
        registered.jobId !== op.jobId ||
        registered.stepId !== op.stepId ||
        (op.binding && registered.intent.proof.profileId !== op.binding.profileId)
      ) {
        return { ok: false };
      }
      validateBrowseIntent(step, op.action, registered.intent);
      if (
        registered.intent.kind !== 'auxiliary' ||
        !INERT_AUXILIARY_PURPOSES.has(registered.intent.purpose) ||
        registered.intent.purpose === 'acceptFriend'
      ) {
        return { ok: false };
      }
      return { ok: true, purpose: registered.intent.purpose };
    }
    if (!UNREGISTERED_INERT_ACTIONS.has(op.action.kind)) {
      return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function classifySqliteInertAuxiliaryBrowseOperationById(
  db: DatabaseSync,
  operationId: string,
):
  | { ok: false }
  | {
      ok: true;
      purpose?: InertAuxiliaryPurpose;
      status: string;
      hasDisposition: boolean;
      hasBinding: boolean;
      planConfirmedStopped: boolean;
      settledEvidence: 'transient' | 'offline' | null;
    } {
  try {
    const row = prepareCached(
      db,
      'SELECT o.id,o.job_id,o.step_id,o.action,o.status,o.receipt,o.disposition,b.body AS binding,p.state AS plan_state,p.control_confirmed FROM task_outbox o LEFT JOIN task_dispatch_bindings b ON b.operation_id=o.id LEFT JOIN task_plans p ON p.id=o.job_id WHERE o.id=?',
    ).get(operationId);
    if (!row) return { ok: false };
    const action = Action.parse(JSON.parse(String(row.action)) as unknown);
    const binding =
      row.binding === null
        ? null
        : DispatchBinding.parse(JSON.parse(String(row.binding)) as unknown);
    const classification = classifySqliteInertAuxiliaryBrowseOperation(db, {
      id: String(row.id),
      jobId: String(row.job_id),
      stepId: String(row.step_id),
      action,
      binding,
    });
    if (!classification.ok) return { ok: false };
    let settledEvidence: 'transient' | 'offline' | null = null;
    if (row.receipt !== null) {
      const parsedReceipt = JSON.parse(String(row.receipt)) as unknown;
      if (parsedReceipt && typeof parsedReceipt === 'object' && !Array.isArray(parsedReceipt)) {
        const ev = (parsedReceipt as Record<string, unknown>).evidence;
        if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
          if ((ev as Record<string, unknown>).transientBrowseSettled === true) {
            settledEvidence = 'transient';
          } else if ((ev as Record<string, unknown>).offlineBrowseCancelled === true) {
            settledEvidence = 'offline';
          }
        }
      }
    }
    return {
      ok: true,
      ...(classification.purpose ? { purpose: classification.purpose } : {}),
      status: String(row.status),
      hasDisposition: row.disposition !== null && row.disposition !== undefined,
      hasBinding: binding !== null,
      planConfirmedStopped: row.plan_state === 'STOPPED' && row.control_confirmed === 1,
      settledEvidence,
    };
  } catch {
    return { ok: false };
  }
}
