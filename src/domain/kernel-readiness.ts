import {
  KernelPersistentState,
  kernelOperationPending,
  type KernelState,
} from '../shared/kernel-state.js';
import { DispatchBinding, sameBinding } from '../shared/task-execution.js';
import { sameResolution, type Notice } from '../shared/settlement.js';
import type { Operation } from '../shared/task-contracts.js';
export type ReadinessIssue = {
  id: string;
  reason:
    | 'ORPHAN_OPERATION'
    | 'BINDING_CONFLICT'
    | 'BUSINESS_UNRESOLVED'
    | 'NOTICE_PENDING'
    | 'REMOTE_RESULT_MISMATCH'
    | 'REMOTE_MISSING'
    | 'TAB_CREATION_UNRESOLVED';
};

const INERT_UNREGISTERED_ACTION_KINDS: ReadonlySet<string> = new Set([
  'browseScroll',
  'browseNavigate',
  'browsePlay',
  'activateTab',
]);
const INERT_AUXILIARY_PURPOSES: ReadonlySet<string> = new Set([
  'play',
  'advance',
  'dismiss',
  'activate',
]);

export function isInertSettledBrowseOperation(op: Operation): boolean {
  if (
    op.status !== 'FAILED' ||
    !op.binding ||
    op.inertBrowseProof?.verified !== true ||
    !op.receipt ||
    typeof op.receipt !== 'object' ||
    Array.isArray(op.receipt)
  ) {
    return false;
  }
  const allowedAction =
    INERT_UNREGISTERED_ACTION_KINDS.has(op.action.kind) ||
    ((op.action.kind === 'click' || op.action.kind === 'mediaClick') &&
      op.inertBrowseProof.purpose !== undefined &&
      INERT_AUXILIARY_PURPOSES.has(op.inertBrowseProof.purpose));
  if (!allowedAction) return false;
  const receiptRecord = op.receipt as Record<string, unknown>;
  const receiptBinding = DispatchBinding.safeParse(receiptRecord.binding);
  if (!receiptBinding.success || !sameBinding(receiptBinding.data, op.binding)) {
    return false;
  }
  const ev = receiptRecord.evidence;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return false;
  }
  const evRecord = ev as Record<string, unknown>;
  return (
    evRecord.transientBrowseSettled === true ||
    (evRecord.offlineBrowseCancelled === true && op.inertBrowseProof.planConfirmedStopped === true)
  );
}

// Pure verdict, not an execution permit. A lifecycle owner must also guard its current live lease.
export function evaluateKernelReadiness(
  profileId: string,
  input: KernelState,
  operations: readonly Operation[],
  notices: readonly Notice[],
): { ready: boolean; issues: ReadinessIssue[] } {
  const inventory = KernelPersistentState.parse(input);
  if (inventory.profileId !== profileId) throw Error('READINESS_PROFILE_MISMATCH');
  const local = new Map(
    operations.filter((op) => op.binding?.profileId === profileId).map((op) => [op.id, op]),
  );
  const notifications = new Map(
    notices
      .filter(
        (notice) =>
          notice.binding.profileId === profileId &&
          (local.get(notice.binding.operationId)?.disposition
            ? notice.resolution.outcome === 'ENDED_UNKNOWN'
            : notice.resolution.outcome !== 'ENDED_UNKNOWN'),
      )
      .map((notice) => [notice.binding.operationId, notice]),
  );
  const settled = (op: Operation) =>
    ['VERIFIED', 'FAILED'].includes(op.status) ||
    (op.status === 'CANCELLED' &&
      notifications.get(op.id)?.resolution.outcome === 'CONTROL_RELEASED');
  const issues: ReadinessIssue[] = [];
  const add = (id: string, reason: ReadinessIssue['reason']) => {
    if (!issues.some((row) => row.id === id && row.reason === reason)) issues.push({ id, reason });
  };
  for (const remote of inventory.operations) {
    const id = remote.binding.operationId,
      op = local.get(id);
    if (!op?.binding) {
      if (kernelOperationPending(remote)) add(id, 'ORPHAN_OPERATION');
      continue;
    }
    if (!sameBinding(op.binding, remote.binding)) {
      add(id, 'BINDING_CONFLICT');
      continue;
    }
    if (
      isInertSettledBrowseOperation(op) &&
      (remote.disposition || remote.state === 'RECONCILED')
    ) {
      continue;
    }
    if (op.disposition) {
      const notice = notifications.get(id);
      if (!notice || notice.state !== 'DELIVERED') add(id, 'NOTICE_PENDING');
      if (
        !notice ||
        !sameBinding(notice.binding, op.binding) ||
        !sameResolution(notice.resolution, op.disposition) ||
        !remote.disposition ||
        !sameResolution(remote.disposition, op.disposition)
      )
        add(id, 'REMOTE_RESULT_MISMATCH');
      continue;
    }
    if (!settled(op)) {
      add(id, 'BUSINESS_UNRESOLVED');
      continue;
    }
    const notice = notifications.get(id);
    if (!notice || notice.state !== 'DELIVERED') add(id, 'NOTICE_PENDING');
    if (
      !notice ||
      !sameBinding(notice.binding, op.binding) ||
      notice.resolution.outcome !==
        (op.status === 'CANCELLED'
          ? 'CONTROL_RELEASED'
          : op.status === 'VERIFIED'
            ? 'VERIFIED'
            : 'NOT_APPLIED') ||
      remote.state !== 'RECONCILED' ||
      !remote.resolution ||
      !sameResolution(notice.resolution, remote.resolution)
    )
      add(id, 'REMOTE_RESULT_MISMATCH');
  }
  for (const op of local.values()) {
    if (isInertSettledBrowseOperation(op)) {
      const remote = inventory.operations.find((row) => row.binding.operationId === op.id);
      if (!remote || remote.disposition || remote.state === 'RECONCILED') continue;
    }
    if (!inventory.operations.some((row) => row.binding.operationId === op.id))
      add(op.id, 'REMOTE_MISSING');
    if (!op.disposition && !settled(op)) add(op.id, 'BUSINESS_UNRESOLVED');
    if ((op.disposition || settled(op)) && notifications.get(op.id)?.state !== 'DELIVERED')
      add(op.id, 'NOTICE_PENDING');
  }
  for (const tab of inventory.tabs)
    if (['CREATING', 'UNKNOWN'].includes(tab.state))
      add(tab.ownershipId, 'TAB_CREATION_UNRESOLVED');
  return { ready: issues.length === 0, issues };
}
