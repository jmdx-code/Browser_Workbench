import {
  KernelOperationRecord,
  KernelPersistentState,
  OwnedTabProof,
  kernelOperationPending,
  type KernelRecord,
  type KernelState,
  type TabProof,
} from '../shared/kernel-state.js';
import { DispatchBinding, sameBinding, type Binding } from '../shared/task-execution.js';
import { OperationDisposition, type Disposition } from '../shared/task-policies.js';

export interface KernelStateStorage {
  read(): Promise<unknown>;
  write(state: KernelState): Promise<void>;
}

const ResolutionSchema = KernelOperationRecord.shape.resolution.unwrap();

const sameTabProof = (a: TabProof | null | undefined, b: TabProof | null | undefined): boolean =>
  Boolean(
    a &&
    b &&
    a.ownershipId === b.ownershipId &&
    a.profileId === b.profileId &&
    a.browserSessionEpoch === b.browserSessionEpoch &&
    a.tabId === b.tabId &&
    a.targetId === b.targetId,
  );

function pruneHistoricalTabs(next: KernelState): void {
  if (next.tabs.length <= 80) return;
  const keepRequired: KernelState['tabs'] = [];
  const currentEpochEnded: KernelState['tabs'] = [];
  const previousEpochEnded: KernelState['tabs'] = [];
  for (const row of next.tabs) {
    const isProtected =
      row.state === 'CREATING' ||
      row.state === 'READY' ||
      row.state === 'UNKNOWN' ||
      Boolean(next.workspaceMain && sameTabProof(row.proof, next.workspaceMain));
    if (isProtected) keepRequired.push(row);
    else if (row.proof?.browserSessionEpoch === next.browserSessionEpoch)
      currentEpochEnded.push(row);
    else previousEpochEnded.push(row);
  }
  const budget = Math.max(0, Math.min(40, 480 - keepRequired.length));
  const retainedCurrent = currentEpochEnded.slice(-budget);
  const remaining = Math.max(0, budget - retainedCurrent.length);
  next.tabs = [
    ...(remaining > 0 ? previousEpochEnded.slice(-remaining) : []),
    ...retainedCurrent,
    ...keepRequired,
  ];
}

function rescueRawTabs(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('tabs' in raw)) return raw;
  const obj = raw as Record<string, unknown> & { tabs?: unknown };
  if (!Array.isArray(obj.tabs) || obj.tabs.length <= 500) return raw;
  const protectedTabs: unknown[] = [];
  const endedTabs: unknown[] = [];
  for (const row of obj.tabs) {
    const st = row && typeof row === 'object' ? (row as { state?: unknown }).state : undefined;
    (st === 'CLOSED' || st === 'LOST' ? endedTabs : protectedTabs).push(row);
  }
  return {
    ...obj,
    tabs: [...endedTabs.slice(-Math.max(0, 450 - protectedTabs.length)), ...protectedTabs],
  };
}

function findBoundOperation(next: KernelState, binding: Binding) {
  const record = next.operations.find((row) => row.binding.operationId === binding.operationId);
  if (!record || !sameBinding(record.binding, binding))
    throw Error('KERNEL_OPERATION_BINDING_REJECTED');
  return record;
}

const hasReadyTabDuplicate = (next: KernelState, tabId: number, targetId: string) =>
  next.tabs.some(
    (t) => t.state === 'READY' && (t.proof?.tabId === tabId || t.proof?.targetId === targetId),
  );

export class KernelJournal {
  private state: KernelState | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private healthy = true;
  private revision = 0;

  constructor(private readonly storage: KernelStateStorage) {}

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.tail.catch(() => {}).then(run);
    this.tail = pending;
    return pending;
  }

  private current(): KernelState {
    if (!this.healthy || !this.state) throw Error('KERNEL_JOURNAL_NOT_READY');
    return this.state;
  }

  private mutate<R>(fn: (next: KernelState) => { commit: boolean; result: R }): Promise<R> {
    return this.serialized(async () => {
      const next = structuredClone(this.current());
      const { commit, result } = fn(next);
      if (commit) await this.commit(next);
      return result;
    });
  }

  private mutateVoid(fn: (next: KernelState) => boolean): Promise<void> {
    return this.mutate((next) => ({ commit: fn(next), result: undefined }));
  }

  get writable(): boolean {
    return this.healthy && this.state !== undefined;
  }

  get currentRevision(): number {
    return this.revision;
  }

  private async commit(next: KernelState): Promise<void> {
    const parsed = KernelPersistentState.parse(next);
    try {
      await this.storage.write(parsed);
      this.state = parsed;
      this.revision++;
    } catch (error) {
      this.healthy = false;
      this.revision += 1;
      throw error;
    }
  }

  initialize(profileId: string, browserSessionEpoch: string): Promise<void> {
    return this.serialized(async () => {
      if (this.state) {
        if (
          this.state.profileId !== profileId ||
          this.state.browserSessionEpoch !== browserSessionEpoch
        ) {
          throw Error('KERNEL_JOURNAL_CONTEXT_CHANGED');
        }
        this.current();
        return;
      }
      const rescuedRaw = rescueRawTabs(await this.storage.read());
      const previous =
        rescuedRaw === undefined ? undefined : KernelPersistentState.parse(rescuedRaw);
      if (previous && previous.profileId !== profileId)
        throw Error('KERNEL_JOURNAL_PROFILE_MISMATCH');
      const next: KernelState = previous ?? {
        version: 1,
        profileId,
        browserSessionEpoch,
        operations: [],
        tabs: [],
      };
      const changedSession = next.browserSessionEpoch !== browserSessionEpoch;
      if (changedSession) {
        next.previousBrowserSessionEpoch = next.browserSessionEpoch;
        next.browserSessionStartedAt = Date.now();
        for (const row of next.operations) row.executionEnded = true;
      }
      next.browserSessionEpoch = browserSessionEpoch;
      for (const row of next.operations) {
        if (row.state === 'DISPATCHING') {
          row.state = 'UNKNOWN';
          row.reason = 'WORKER_RESTART';
        }
      }
      for (const row of next.tabs) {
        if (row.state === 'CREATING') {
          row.state = 'UNKNOWN';
          row.reason = 'CREATE_RESULT_UNKNOWN';
        } else if (changedSession && row.state === 'READY') {
          row.state = 'LOST';
          row.reason = 'BROWSER_SESSION_CHANGED';
        }
      }
      pruneHistoricalTabs(next);
      await this.commit(next);
    });
  }

  snapshot(): Promise<KernelState> {
    return this.serialized(async () => structuredClone(this.current()));
  }

  begin(
    input: Binding,
    operationSequence?: number,
  ): Promise<{ fresh: boolean; record: KernelState['operations'][number] }> {
    const binding = DispatchBinding.parse(input);
    return this.mutate<{ fresh: boolean; record: KernelState['operations'][number] }>((next) => {
      if (binding.profileId !== next.profileId) throw Error('KERNEL_OPERATION_PROFILE_MISMATCH');
      const old = next.operations.find((row) => row.binding.operationId === binding.operationId);
      if (old) {
        if (!sameBinding(old.binding, binding)) throw Error('KERNEL_OPERATION_ID_CONFLICT');
        if (old.operationSequence !== operationSequence)
          throw Error('KERNEL_OPERATION_SEQUENCE_CONFLICT');
        return { commit: false, result: { fresh: false, record: old } };
      }
      if (operationSequence === undefined && next.operationHighWater !== undefined) {
        throw Error('KERNEL_OPERATION_SEQUENCE_REQUIRED');
      }
      if (operationSequence !== undefined) {
        if (
          !Number.isSafeInteger(operationSequence) ||
          operationSequence <= (next.operationHighWater ?? 0)
        ) {
          throw Error('KERNEL_OPERATION_RETIRED');
        }
        next.version = 2;
        next.operationHighWater = operationSequence;
      }
      if (
        next.operations.some(
          (r) => kernelOperationPending(r) && (r.state === 'DISPATCHING' || r.state === 'UNKNOWN'),
        )
      ) {
        throw Error('KERNEL_OPERATION_REVIEW_REQUIRED');
      }
      const record = {
        binding,
        state: 'DISPATCHING' as const,
        reason: '',
        resolution: null,
        ...(operationSequence === undefined ? {} : { operationSequence }),
      };
      next.operations.push(record);
      return { commit: true, result: { fresh: true, record } };
    });
  }

  collect(records: KernelRecord[], browserSessionEpoch: string): Promise<number> {
    return this.mutate<number>((next) => {
      if (next.browserSessionEpoch !== browserSessionEpoch)
        throw Error('KERNEL_COLLECTION_CONTEXT_CHANGED');
      const ids = new Set<string>();
      for (const value of records) {
        const expected = KernelOperationRecord.parse(value);
        const row = next.operations.find(
          (r) => r.binding.operationId === expected.binding.operationId,
        );
        if (!row) continue;
        if (kernelOperationPending(row) || JSON.stringify(row) !== JSON.stringify(expected)) {
          throw Error('KERNEL_COLLECTION_RECEIPT_MISMATCH');
        }
        ids.add(row.binding.operationId);
      }
      if (!ids.size) return { commit: false, result: 0 };
      next.version = 2;
      next.operationHighWater ??= 0;
      next.operations = next.operations.filter((r) => !ids.has(r.binding.operationId));
      return { commit: true, result: ids.size };
    });
  }

  finish(input: Binding, state: 'ACKNOWLEDGED' | 'UNKNOWN', reason = ''): Promise<void> {
    const binding = DispatchBinding.parse(input);
    return this.mutateVoid((next) => {
      const record = findBoundOperation(next, binding);
      if (record.state === 'UNKNOWN' && state === 'ACKNOWLEDGED')
        throw Error('KERNEL_OPERATION_LATE_ACK_REJECTED');
      if (
        record.state === state ||
        record.state === 'ACKNOWLEDGED' ||
        record.state === 'RECONCILED'
      )
        return false;
      record.state = state;
      record.reason = reason.slice(0, 200);
      return true;
    });
  }

  reconcile(
    input: Binding,
    resolution: NonNullable<KernelState['operations'][number]['resolution']>,
  ): Promise<void> {
    const binding = DispatchBinding.parse(input);
    resolution = ResolutionSchema.parse(resolution);
    return this.mutateVoid((next) => {
      const record = findBoundOperation(next, binding);
      if (record.state === 'RECONCILED') {
        if (JSON.stringify(record.resolution) !== JSON.stringify(resolution))
          throw Error('KERNEL_RECONCILIATION_CONFLICT');
        return false;
      }
      if (
        record.state !== 'UNKNOWN' &&
        record.state !== 'ACKNOWLEDGED' &&
        !(record.state === 'DISPATCHING' && resolution.outcome === 'NOT_APPLIED')
      ) {
        throw Error('KERNEL_RECONCILIATION_NOT_REQUIRED');
      }
      if (resolution.outcome === 'CONTROL_RELEASED' && record.state !== 'ACKNOWLEDGED') {
        throw Error('KERNEL_CONTROL_RELEASE_ACK_REQUIRED');
      }
      record.state = 'RECONCILED';
      record.resolution = resolution;
      return true;
    });
  }

  prepareTab(ownershipId: string, url: string): Promise<void> {
    return this.mutateVoid((next) => {
      if (next.tabs.some((row) => row.ownershipId === ownershipId))
        throw Error('KERNEL_TAB_CREATE_ALREADY_RECORDED');
      if (next.tabs.some((row) => ['CREATING', 'UNKNOWN'].includes(row.state)))
        throw Error('KERNEL_TAB_CREATE_REVIEW_REQUIRED');
      pruneHistoricalTabs(next);
      next.tabs.push({ ownershipId, url, state: 'CREATING', proof: null, reason: '' });
      return true;
    });
  }

  endUnknown(input: Binding, value: Disposition): Promise<void> {
    const binding = DispatchBinding.parse(input);
    const disposition = OperationDisposition.parse(value);
    return this.mutateVoid((next) => {
      const record = findBoundOperation(next, binding);
      if (record.disposition) {
        if (JSON.stringify(record.disposition) !== JSON.stringify(disposition))
          throw Error('KERNEL_END_CONFLICT');
        return false;
      }
      if (!['DISPATCHING', 'UNKNOWN', 'ACKNOWLEDGED'].includes(record.state))
        throw Error('KERNEL_END_NOT_REQUIRED');
      if (record.state === 'DISPATCHING') record.state = 'UNKNOWN';
      record.disposition = disposition;
      return true;
    });
  }

  acknowledgeSessionEnd(browserSessionEpoch: string): Promise<void> {
    return this.mutateVoid((next) => {
      if (
        next.browserSessionEpoch !== browserSessionEpoch ||
        next.operations.some((row) => row.executionEnded && kernelOperationPending(row))
      ) {
        throw Error('KERNEL_SESSION_END_UNCONFIRMED');
      }
      if (!next.previousBrowserSessionEpoch) return false;
      delete next.previousBrowserSessionEpoch;
      return true;
    });
  }

  retireOperation(
    input: Binding,
    resolution: NonNullable<KernelRecord['resolution']> | Disposition,
  ): Promise<void> {
    const binding = DispatchBinding.parse(input);
    return this.mutateVoid((next) => {
      if (binding.profileId !== next.profileId) throw Error('KERNEL_OPERATION_PROFILE_MISMATCH');
      let row = next.operations.find((r) => r.binding.operationId === binding.operationId);
      if (row && !sameBinding(row.binding, binding)) throw Error('KERNEL_OPERATION_ID_CONFLICT');
      if (!row) {
        row = {
          binding,
          state: 'UNKNOWN',
          reason: 'CONTROLLER_SETTLEMENT_AFTER_EXECUTION_ENDED',
          resolution: null,
          executionEnded: true,
        };
        next.operations.push(row);
      }
      const old = resolution.outcome === 'ENDED_UNKNOWN' ? row.disposition : row.resolution;
      if (old) {
        if (
          old.id !== resolution.id ||
          old.outcome !== resolution.outcome ||
          old.evidenceDigest !== resolution.evidenceDigest
        ) {
          throw Error('KERNEL_RECONCILIATION_CONFLICT');
        }
        return false;
      }
      if (resolution.outcome === 'ENDED_UNKNOWN') {
        row.disposition = OperationDisposition.parse(resolution);
        if (row.state === 'DISPATCHING') row.state = 'UNKNOWN';
      } else {
        row.resolution = ResolutionSchema.parse(resolution);
        row.state = 'RECONCILED';
      }
      row.executionEnded = true;
      return true;
    });
  }

  confirmTab(proof: TabProof): Promise<void> {
    return this.mutateVoid((next) => {
      const row = next.tabs.find((tab) => tab.ownershipId === proof.ownershipId);
      if (
        !row ||
        row.state !== 'CREATING' ||
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch
      ) {
        throw Error('KERNEL_TAB_PROOF_REJECTED');
      }
      if (hasReadyTabDuplicate(next, proof.tabId, proof.targetId))
        throw Error('KERNEL_TAB_PROOF_DUPLICATE');
      row.proof = proof;
      row.state = 'READY';
      return true;
    });
  }

  restoreWithdrawnTab(proof: TabProof): Promise<void> {
    return this.mutateVoid((next) => {
      const row = next.tabs.find((tab) => tab.ownershipId === proof.ownershipId);
      if (
        row?.state !== 'LOST' ||
        row.reason !== 'TASK_ENDED_OWNERSHIP_WITHDRAWN' ||
        !sameTabProof(row.proof, proof) ||
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch ||
        next.operations.some(kernelOperationPending)
      ) {
        throw Error('KERNEL_WITHDRAWN_PAGE_RESTORE_REJECTED');
      }
      row.state = 'READY';
      row.reason = 'STOPPED_MAIN_PAGE_REOBSERVED';
      return true;
    });
  }

  reobserveMain(previous: TabProof, proof: TabProof, url: string): Promise<void> {
    return this.mutateVoid((next) => {
      const old = next.tabs.find((tab) => tab.ownershipId === previous.ownershipId);
      if (
        old?.state !== 'LOST' ||
        old.reason !== 'BROWSER_SESSION_CHANGED' ||
        !sameTabProof(old.proof, previous) ||
        previous.profileId !== next.profileId ||
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch ||
        proof.tabId !== previous.tabId ||
        proof.targetId !== previous.targetId ||
        next.operations.some(kernelOperationPending) ||
        next.tabs.some((tab) => tab.ownershipId === proof.ownershipId) ||
        hasReadyTabDuplicate(next, proof.tabId, proof.targetId)
      ) {
        throw Error('KERNEL_MAIN_REOBSERVATION_REJECTED');
      }
      pruneHistoricalTabs(next);
      next.tabs.push({
        ownershipId: proof.ownershipId,
        proof,
        state: 'READY',
        url,
        reason: 'WORKSPACE_MAIN_REOBSERVED',
      });
      return true;
    });
  }

  bindWorkspaceMainTab(input: TabProof, url: string): Promise<TabProof> {
    const proof = OwnedTabProof.parse(input);
    return this.mutate<TabProof>((next) => {
      if (
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch ||
        next.operations.some(kernelOperationPending)
      ) {
        throw Error('KERNEL_MAIN_BIND_REJECTED');
      }
      let reused: TabProof | undefined;
      for (const row of next.tabs) {
        if (row.state === 'CLOSED') continue;
        if (
          row.state === 'READY' &&
          row.proof?.tabId === proof.tabId &&
          row.proof.targetId === proof.targetId &&
          row.proof.browserSessionEpoch === next.browserSessionEpoch
        ) {
          reused = row.proof;
        } else {
          row.state = 'CLOSED';
          row.reason = 'CLOSED_BY_WORKSPACE_CLEANUP';
        }
      }
      const activeProof = reused ?? proof;
      if (!reused) {
        pruneHistoricalTabs(next);
        next.tabs.push({
          ownershipId: activeProof.ownershipId,
          url,
          state: 'READY',
          proof: activeProof,
          reason: 'WORKSPACE_MAIN_BOUND',
        });
      }
      return { commit: true, result: activeProof };
    });
  }

  rebindRecoveredTab(previousInput: TabProof, nextInput: TabProof, url: string): Promise<TabProof> {
    const previous = OwnedTabProof.parse(previousInput);
    const nextProof = OwnedTabProof.parse(nextInput);
    return this.mutate<TabProof>((next) => {
      const oldRow = next.tabs.find(
        (r) =>
          r.state === 'READY' &&
          r.ownershipId === previous.ownershipId &&
          sameTabProof(r.proof, previous),
      );
      if (
        !oldRow ||
        previous.profileId !== next.profileId ||
        nextProof.profileId !== next.profileId ||
        previous.browserSessionEpoch !== next.browserSessionEpoch ||
        nextProof.browserSessionEpoch !== next.browserSessionEpoch ||
        nextProof.tabId !== previous.tabId ||
        nextProof.ownershipId === previous.ownershipId ||
        next.operations.some(kernelOperationPending) ||
        next.tabs.some((r) => r.ownershipId === nextProof.ownershipId)
      ) {
        throw Error('KERNEL_TAB_REBIND_REJECTED');
      }
      oldRow.state = 'CLOSED';
      oldRow.reason = 'TAB_TARGET_REBOUND';
      pruneHistoricalTabs(next);
      next.tabs.push({
        ownershipId: nextProof.ownershipId,
        url,
        state: 'READY',
        proof: nextProof,
        reason: 'TAB_TARGET_REBOUND',
      });
      if (next.workspaceMain && sameTabProof(next.workspaceMain, previous))
        next.workspaceMain = nextProof;
      return { commit: true, result: nextProof };
    });
  }

  tabState(
    ownershipId: string,
    state: 'UNKNOWN' | 'LOST' | 'CLOSED',
    reason: string,
  ): Promise<void> {
    return this.mutateVoid((next) => {
      const row = next.tabs.find((tab) => tab.ownershipId === ownershipId);
      if (!row) throw Error('KERNEL_TAB_NOT_RECORDED');
      if (row.state === 'CLOSED') return false;
      row.state = state;
      row.reason = reason.slice(0, 200);
      return true;
    });
  }
}
