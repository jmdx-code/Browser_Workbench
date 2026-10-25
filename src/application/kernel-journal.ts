import {
  KernelPersistentState,
  KernelOperationRecord,
  OwnedTabProof,
  type KernelState,
  type TabProof,
  kernelOperationPending,
} from '../shared/kernel-state.js';
import { OperationDisposition, type Disposition } from '../shared/task-ending.js';
import { DispatchBinding, sameBinding, type Binding } from '../shared/task-execution.js';

export interface KernelStateStorage {
  read(): Promise<unknown>;
  write(state: KernelState): Promise<void>;
}
export class KernelJournal {
  private state: KernelState | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private healthy = true;
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
  get writable(): boolean {
    return this.healthy && this.state !== undefined;
  }
  private async commit(next: KernelState): Promise<void> {
    const parsed = KernelPersistentState.parse(next);
    try {
      await this.storage.write(parsed);
      this.state = parsed;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
  initialize(profileId: string, browserSessionEpoch: string): Promise<void> {
    return this.serialized(async () => {
      if (this.state) {
        if (
          this.state.profileId !== profileId ||
          this.state.browserSessionEpoch !== browserSessionEpoch
        )
          throw Error('KERNEL_JOURNAL_CONTEXT_CHANGED');
        this.current();
        return;
      }
      const raw = await this.storage.read();
      const previous = raw === undefined ? undefined : KernelPersistentState.parse(raw);
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
      next.browserSessionEpoch = browserSessionEpoch;
      for (const row of next.operations)
        if (row.state === 'DISPATCHING') {
          row.state = 'UNKNOWN';
          row.reason = 'WORKER_RESTART';
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
      await this.commit(next);
    });
  }
  snapshot(): Promise<KernelState> {
    return this.serialized(async () => KernelPersistentState.parse(this.current()));
  }
  begin(input: Binding): Promise<{ fresh: boolean; record: KernelState['operations'][number] }> {
    const binding = DispatchBinding.parse(input);
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      if (binding.profileId !== next.profileId) throw Error('KERNEL_OPERATION_PROFILE_MISMATCH');
      const old = next.operations.find((row) => row.binding.operationId === binding.operationId);
      if (old) {
        if (!sameBinding(old.binding, binding)) throw Error('KERNEL_OPERATION_ID_CONFLICT');
        return { fresh: false, record: old };
      }
      if (
        next.operations.some(
          (row) =>
            kernelOperationPending(row) && (row.state === 'DISPATCHING' || row.state === 'UNKNOWN'),
        )
      )
        throw Error('KERNEL_OPERATION_REVIEW_REQUIRED');
      const record = { binding, state: 'DISPATCHING' as const, reason: '', resolution: null };
      next.operations.push(record);
      await this.commit(next);
      return { fresh: true, record };
    });
  }
  finish(input: Binding, state: 'ACKNOWLEDGED' | 'UNKNOWN', reason = ''): Promise<void> {
    const binding = DispatchBinding.parse(input);
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const record = next.operations.find((row) => row.binding.operationId === binding.operationId);
      if (!record || !sameBinding(record.binding, binding))
        throw Error('KERNEL_OPERATION_BINDING_REJECTED');
      if (record.state === 'UNKNOWN' && state === 'ACKNOWLEDGED')
        throw Error('KERNEL_OPERATION_LATE_ACK_REJECTED');
      if (record.state === state) return;
      if (record.state === 'ACKNOWLEDGED' || record.state === 'RECONCILED') return;
      record.state = state;
      record.reason = reason.slice(0, 200);
      await this.commit(next);
    });
  }
  reconcile(
    input: Binding,
    resolution: NonNullable<KernelState['operations'][number]['resolution']>,
  ): Promise<void> {
    const binding = DispatchBinding.parse(input);
    resolution = KernelOperationRecord.shape.resolution.unwrap().parse(resolution);
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const record = next.operations.find((row) => row.binding.operationId === binding.operationId);
      if (!record || !sameBinding(record.binding, binding))
        throw Error('KERNEL_OPERATION_BINDING_REJECTED');
      if (record.state === 'RECONCILED') {
        if (JSON.stringify(record.resolution) !== JSON.stringify(resolution))
          throw Error('KERNEL_RECONCILIATION_CONFLICT');
        return;
      }
      if (record.state !== 'UNKNOWN' && record.state !== 'ACKNOWLEDGED')
        throw Error('KERNEL_RECONCILIATION_NOT_REQUIRED');
      if (resolution.outcome === 'CONTROL_RELEASED' && record.state !== 'ACKNOWLEDGED')
        throw Error('KERNEL_CONTROL_RELEASE_ACK_REQUIRED');
      record.state = 'RECONCILED';
      record.resolution = resolution;
      await this.commit(next);
    });
  }
  prepareTab(ownershipId: string, url: string): Promise<void> {
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      if (next.tabs.some((row) => row.ownershipId === ownershipId))
        throw Error('KERNEL_TAB_CREATE_ALREADY_RECORDED');
      if (next.tabs.some((row) => ['CREATING', 'UNKNOWN'].includes(row.state)))
        throw Error('KERNEL_TAB_CREATE_REVIEW_REQUIRED');
      next.tabs.push({ ownershipId, url, state: 'CREATING', proof: null, reason: '' });
      await this.commit(next);
    });
  }
  endUnknown(input: Binding, value: Disposition): Promise<void> {
    const binding = DispatchBinding.parse(input),
      disposition = OperationDisposition.parse(value);
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const record = next.operations.find((row) => row.binding.operationId === binding.operationId);
      if (!record || !sameBinding(record.binding, binding))
        throw Error('KERNEL_OPERATION_BINDING_REJECTED');
      if (record.disposition) {
        if (JSON.stringify(record.disposition) !== JSON.stringify(disposition))
          throw Error('KERNEL_END_CONFLICT');
        return;
      }
      if (!['UNKNOWN', 'ACKNOWLEDGED'].includes(record.state))
        throw Error('KERNEL_END_NOT_REQUIRED');
      record.disposition = disposition;
      await this.commit(next);
    });
  }
  confirmTab(proof: TabProof): Promise<void> {
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const row = next.tabs.find((tab) => tab.ownershipId === proof.ownershipId);
      if (
        !row ||
        row.state !== 'CREATING' ||
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch
      )
        throw Error('KERNEL_TAB_PROOF_REJECTED');
      if (
        next.tabs.some(
          (tab) =>
            tab.state === 'READY' &&
            (tab.proof?.tabId === proof.tabId || tab.proof?.targetId === proof.targetId),
        )
      )
        throw Error('KERNEL_TAB_PROOF_DUPLICATE');
      row.proof = proof;
      row.state = 'READY';
      await this.commit(next);
    });
  }
  restoreWithdrawnTab(proof: TabProof): Promise<void> {
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const row = next.tabs.find((tab) => tab.ownershipId === proof.ownershipId);
      if (
        row?.state !== 'LOST' ||
        row.reason !== 'TASK_ENDED_OWNERSHIP_WITHDRAWN' ||
        JSON.stringify(row.proof) !== JSON.stringify(proof) ||
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch ||
        next.operations.some(kernelOperationPending)
      )
        throw Error('KERNEL_WITHDRAWN_PAGE_RESTORE_REJECTED');
      row.state = 'READY';
      row.reason = 'STOPPED_MAIN_PAGE_REOBSERVED';
      await this.commit(next);
    });
  }
  reobserveMain(previous: TabProof, proof: TabProof, url: string): Promise<void> {
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const old = next.tabs.find((tab) => tab.ownershipId === previous.ownershipId);
      if (
        old?.state !== 'LOST' ||
        old.reason !== 'BROWSER_SESSION_CHANGED' ||
        JSON.stringify(old.proof) !== JSON.stringify(previous) ||
        previous.profileId !== next.profileId ||
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch ||
        proof.tabId !== previous.tabId ||
        proof.targetId !== previous.targetId ||
        next.operations.some(kernelOperationPending) ||
        next.tabs.some(
          (tab) =>
            tab.ownershipId === proof.ownershipId ||
            (tab.state === 'READY' &&
              (tab.proof?.tabId === proof.tabId || tab.proof?.targetId === proof.targetId)),
        )
      )
        throw Error('KERNEL_MAIN_REOBSERVATION_REJECTED');
      next.tabs.push({
        ownershipId: proof.ownershipId,
        proof,
        state: 'READY',
        url,
        reason: 'WORKSPACE_MAIN_REOBSERVED',
      });
      await this.commit(next);
    });
  }
  bindWorkspaceMainTab(input: TabProof, url: string): Promise<TabProof> {
    const proof = OwnedTabProof.parse(input);
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      if (
        proof.profileId !== next.profileId ||
        proof.browserSessionEpoch !== next.browserSessionEpoch ||
        next.operations.some(kernelOperationPending)
      )
        throw Error('KERNEL_MAIN_BIND_REJECTED');
      let reused: TabProof | undefined;
      for (const row of next.tabs) {
        if (row.state === 'CLOSED') continue;
        if (
          row.state === 'READY' &&
          row.proof &&
          row.proof.tabId === proof.tabId &&
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
        next.tabs.push({
          ownershipId: activeProof.ownershipId,
          url,
          state: 'READY',
          proof: activeProof,
          reason: 'WORKSPACE_MAIN_BOUND',
        });
      }
      await this.commit(next);
      return activeProof;
    });
  }
  tabState(
    ownershipId: string,
    state: 'UNKNOWN' | 'LOST' | 'CLOSED',
    reason: string,
  ): Promise<void> {
    return this.serialized(async () => {
      const next = KernelPersistentState.parse(this.current());
      const row = next.tabs.find((tab) => tab.ownershipId === ownershipId);
      if (!row) throw Error('KERNEL_TAB_NOT_RECORDED');
      if (row.state === 'CLOSED') return;
      row.state = state;
      row.reason = reason.slice(0, 200);
      await this.commit(next);
    });
  }
}
