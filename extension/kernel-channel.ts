import type { KernelExecutor, KernelStopEvidence } from '../src/application/kernel-executor.js';
import type { KernelJournal } from '../src/application/kernel-journal.js';
import type { KernelAccess } from '../src/shared/kernel-policy.js';
import type { KernelJsonObject, KernelTarget } from '../src/shared/kernel-protocol.js';
import type { TabProof } from '../src/shared/kernel-state.js';
import { KernelRequest } from '../src/shared/kernel-wire.js';
import {
  PresentationRecoveryPermit,
  type PresentationRecoveryDecision,
} from '../src/shared/presentation-recovery.js';
import type { Binding } from '../src/shared/task-execution.js';
import { ChromeKernelBackend, type KernelNativeBackend } from './kernel-backend.js';
import {
  handleChannelEvent,
  handleChannelRequest,
  type KernelChannelRpcHost,
} from './kernel-channel-rpc.js';
import { kernelJournal } from './kernel-storage.js';
import type { TaskRendering } from './task-rendering.js';
import { TaskWindowController } from './task-window-controller.js';
import { withBoundedWait } from './workspace-page-group.js';
type StopOptions = {
  previousTimeoutMs?: number;
  journalTimeoutMs?: number;
  releaseTimeoutMs?: number;
  stopTimeoutMs?: number;
};
export class ExtensionKernelChannel implements KernelChannelRpcHost {
  private readonly windows = new TaskWindowController();
  abandoned = false;
  stopUnconfirmed = false;
  private readonly stopWrites = new Set<Promise<void>>();
  private stopWriteFailed = false;
  private customRendering: TaskRendering | undefined;
  private readonly recoveryPending = new Map<
    string,
    {
      leaseId: string;
      generation: number;
      epoch: string;
      resolve: (granted: PresentationRecoveryDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  executor: KernelExecutor | undefined;
  backend: KernelNativeBackend | undefined;
  private lastSequence = 0;
  activeLeaseId = '';
  private readonly pending = new Set<Promise<unknown>>();
  freezing: Promise<void> | undefined;
  stoppingRpc: Promise<KernelStopEvidence> | undefined;
  activeOperation: Binding | undefined;
  activeInputs = 0;
  readonly businessPending = new Set<Promise<unknown>>();
  access: KernelAccess = 'fixture';
  summaryOnly = false;
  quiesced: { requestId: string; scope: string; result: KernelJsonObject } | undefined;
  constructor(
    readonly context: () => { profileId: string; epoch: string; valid: boolean },
    private readonly output: (message: unknown) => void,
    readonly createBackend: (
      allowInput: () => boolean,
      journal: KernelJournal,
      access: KernelAccess,
      allowRead: () => boolean,
      currentOperation: () => Binding | undefined,
    ) => KernelNativeBackend = (allowInput, journal, access, allowRead, currentOperation) =>
      new ChromeKernelBackend(
        journal,
        allowInput,
        access,
        allowRead,
        currentOperation,
        undefined,
        this.windows,
      ),
    readonly journal: KernelJournal = kernelJournal,
  ) {}
  private clearRecoveryPending(): void {
    for (const p of this.recoveryPending.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.recoveryPending.clear();
  }
  abandon(): void {
    this.abandoned = true;
    this.stopUnconfirmed = true;
    this.activeOperation = undefined;
    this.clearRecoveryPending();
    this.backend?.forgetRendering?.();
    this.customRendering?.forgetAll();
    this.executor?.markUnconfirmed();
  }
  isStopUnconfirmed = () => this.stopUnconfirmed;
  setStopUnconfirmed(unconfirmed = true): void {
    this.stopUnconfirmed = unconfirmed;
    if (unconfirmed) {
      this.activeOperation = undefined;
      this.executor?.markUnconfirmed();
    }
  }
  get rendering(): TaskRendering | undefined {
    return this.customRendering ?? this.backend?.rendering;
  }
  set rendering(value: TaskRendering | undefined) {
    this.customRendering = value;
  }
  emit(message: unknown): void {
    if (!this.abandoned) this.output(message);
  }
  presentationRecoveryPermit(value: unknown): void {
    const permit = PresentationRecoveryPermit.parse(value);
    const pending = this.recoveryPending.get(permit.requestId);
    if (
      !pending ||
      pending.epoch !== permit.connectionEpoch ||
      pending.leaseId !== permit.leaseId ||
      pending.generation !== permit.generation
    )
      return;
    clearTimeout(pending.timer);
    this.recoveryPending.delete(permit.requestId);
    let live = false;
    try {
      const stamp = this.executor?.lease.check();
      live =
        this.context().valid &&
        this.executor?.state === 'running' &&
        stamp?.leaseId === permit.leaseId &&
        stamp.connectionEpoch === permit.connectionEpoch &&
        stamp.generation === permit.generation;
    } catch {}
    pending.resolve(
      live && permit.granted && !permit.focusFallback && Date.now() < permit.expiresAt,
    );
  }
  requestPresentationRecovery(
    proof: TabProof,
    positionOnly = false,
  ): Promise<PresentationRecoveryDecision> {
    if (
      this.access !== 'facebook-task' ||
      !this.context().valid ||
      !this.executor ||
      this.recoveryPending.size
    )
      return Promise.resolve(false);
    const stamp = this.executor.lease.check(),
      requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.recoveryPending.delete(requestId);
        resolve(false);
      }, 2000);
      this.recoveryPending.set(requestId, {
        leaseId: stamp.leaseId,
        generation: stamp.generation,
        epoch: stamp.connectionEpoch,
        resolve,
        timer,
      });
      try {
        this.emit({
          type: 'PRESENTATION_RECOVERY_REQUEST',
          requestId,
          proof,
          ...(positionOnly ? { positionOnly: true } : {}),
          connectionEpoch: stamp.connectionEpoch,
          leaseId: stamp.leaseId,
          generation: stamp.generation,
        });
      } catch {
        clearTimeout(timer);
        this.recoveryPending.delete(requestId);
        resolve(false);
      }
    });
  }
  private emitReply = (
    request: ReturnType<typeof KernelRequest.parse>,
    extra: Record<string, unknown>,
  ) =>
    this.emit({
      type: 'KERNEL_REPLY',
      requestId: request.requestId,
      connectionEpoch: request.connectionEpoch,
      leaseId: request.leaseId,
      ...extra,
    });
  receive(value: unknown): void {
    if (this.abandoned) return;
    const request = KernelRequest.parse(value),
      context = this.context();
    if (request.connectionEpoch !== context.epoch) throw Error('KERNEL_CONTEXT_REJECTED');
    if (!context.valid || request.sequence <= this.lastSequence)
      return this.emitReply(request, { error: 'KERNEL_CONTEXT_REJECTED' });
    this.lastSequence = request.sequence;
    if (request.kind !== 'open' && request.leaseId !== this.activeLeaseId)
      return this.emitReply(request, { error: 'KERNEL_LEASE_NOT_CURRENT' });
    if (this.pending.size >= 64 && !['stop', 'quiesce', 'renew'].includes(request.kind))
      throw Error('KERNEL_RPC_BUDGET_EXCEEDED');
    const operation = handleChannelRequest(this, request)
      .then((result) => {
        if (!this.abandoned && request.connectionEpoch === this.context().epoch)
          this.emitReply(request, { result });
      })
      .catch((error: unknown) => {
        if (!this.abandoned && request.connectionEpoch === this.context().epoch)
          this.emitReply(request, {
            error: error instanceof Error ? error.message.slice(0, 300) : 'KERNEL_RPC_FAILED',
          });
      });
    this.pending.add(operation);
    const isBiz = [
      'beginOperation',
      'grantOperationFiles',
      'finishOperation',
      'reconcileOperation',
    ].includes(request.kind);
    if (isBiz) this.businessPending.add(operation);
    void operation
      .finally(() => {
        this.pending.delete(operation);
        this.businessPending.delete(operation);
      })
      .catch(() => {});
  }
  event = (source: KernelTarget, method: string, value: unknown) =>
    handleChannelEvent(this, source, method, value);
  private emitDetached = (
    tabId: number,
    epoch: string,
    leaseId: string,
    params: Record<string, unknown>,
  ) =>
    this.emit({
      type: 'KERNEL_EVENT',
      connectionEpoch: epoch,
      leaseId,
      source: { tabId },
      method: 'Inspector.detached',
      params,
    });
  detached(tabId: number, reason?: string): void {
    if (!this.backend?.owns(tabId)) return;
    this.backend.detached(tabId);
    if (this.backend.expectedDetach(tabId)) return;
    const leaseId = this.activeLeaseId,
      epoch = this.context().epoch;
    void this.freeze().catch(() => {});
    this.emitDetached(
      tabId,
      epoch,
      leaseId,
      typeof reason === 'string' && reason.length > 0 ? { reason } : {},
    );
  }
  removed(tabId: number): void {
    const owned = this.backend?.owns(tabId) ?? false,
      expected = this.backend?.expectedRemoval?.(tabId) ?? false,
      leaseId = this.activeLeaseId,
      epoch = this.context().epoch;
    this.backend?.tabRemoved?.(tabId);
    if (owned && !expected) {
      void this.freeze().catch(() => {});
      if (leaseId && epoch) this.emitDetached(tabId, epoch, leaseId, { reason: 'target_closed' });
    }
  }
  freeze(): Promise<void> {
    if (this.freezing) return this.freezing;
    if (!this.executor)
      return this.stopUnconfirmed
        ? Promise.reject(Error('KERNEL_STOP_UNCONFIRMED'))
        : Promise.resolve();
    this.freezing = (async () => {
      const evidence = await this.stopExecutor(crypto.randomUUID(), true);
      if (evidence.state !== 'stopped') {
        this.stopUnconfirmed = true;
        throw Error('KERNEL_STOP_UNCONFIRMED');
      }
    })().finally(() => {
      this.freezing = undefined;
    });
    return this.freezing;
  }
  async control(
    msg: { type: 'STOP'; id?: string; requestId?: string; connectionEpoch?: string },
    options?: StopOptions,
  ): Promise<KernelStopEvidence> {
    const reqId = msg.requestId ?? msg.id ?? crypto.randomUUID(),
      epoch = msg.connectionEpoch ?? this.context().epoch,
      stopped = await this.stopExecutor(reqId, true, options),
      base = {
        ...(msg.id !== undefined ? { id: msg.id } : {}),
        requestId: reqId,
        connectionEpoch: epoch,
      };
    this.emit(
      stopped.state === 'stopped'
        ? {
            type: 'STOPPED',
            ...base,
            ...(msg.id !== undefined ? { ok: true, result: { type: 'STOPPED' } } : {}),
          }
        : {
            type: 'STOP_UNCONFIRMED',
            ...base,
            ok: false,
            error: 'KERNEL_STOP_UNCONFIRMED',
            unresolvedMethods: stopped.unresolvedMethods,
          },
    );
    return stopped;
  }
  stopExecutor(
    requestId: string,
    detach = true,
    options?: StopOptions,
  ): Promise<KernelStopEvidence> {
    const executor = this.executor;
    if (!executor) return Promise.reject(Error('KERNEL_NOT_OPEN'));
    const binding = this.activeOperation;
    this.activeOperation = undefined;
    executor.revokeFiles();
    this.clearRecoveryPending();
    const previous = this.stoppingRpc,
      prevMs = options?.previousTimeoutMs ?? 3_000,
      journalMs = options?.journalTimeoutMs ?? 3_000,
      releaseMs = options?.releaseTimeoutMs ?? 2_500,
      stopMs = options?.stopTimeoutMs ?? 10_000,
      retain = !detach,
      prevDone = previous
        ? withBoundedWait(
            previous.catch(() => undefined),
            prevMs,
          )
        : null;
    let operation: Promise<KernelStopEvidence>;
    try {
      if (prevDone) {
        executor.fence();
        if (detach) void withBoundedWait(executor.forceDetachAll(), stopMs).catch(() => {});
        operation = prevDone.then((earlier) =>
          !earlier.completed
            ? { requestId, state: 'unconfirmed' as const, unresolvedMethods: ['PreviousStop'] }
            : executor.stop(requestId, stopMs, retain),
        );
      } else operation = executor.stop(requestId, stopMs, retain);
    } catch {
      if (detach) void withBoundedWait(executor.forceDetachAll(), stopMs).catch(() => {});
      operation = Promise.resolve({
        requestId,
        state: 'unconfirmed',
        unresolvedMethods: ['PreviousStop'],
      });
    }
    const stopped = withBoundedWait(operation, stopMs + 200).catch(() => ({
        completed: false as const,
      })),
      businessDrain = withBoundedWait(Promise.allSettled([...this.businessPending]), journalMs);
    if (detach) {
      this.backend?.forgetRendering?.();
      this.customRendering?.forgetAll();
    }
    const releaseWork = (async () => {
      if (!detach) {
        const rendering = this.customRendering ?? this.backend?.rendering,
          release =
            this.backend?.releaseRendering && !this.customRendering
              ? this.backend.releaseRendering(undefined, releaseMs)
              : (rendering?.release(undefined, releaseMs) ?? Promise.resolve(true)),
          result = await withBoundedWait(release, releaseMs + 100);
        if (!result.completed || !result.value) return false;
      }
      return (await withBoundedWait(this.windows.drain(), releaseMs)).completed;
    })().catch(() => false);
    const drained = (async (): Promise<KernelStopEvidence> => {
      const previousStopTimedOut = prevDone ? !(await prevDone).completed : false;
      let journalTimedOut = false;
      if (binding) {
        try {
          const p = this.journal.finish(binding, 'UNKNOWN', 'CONTROL_STOPPED');
          this.stopWrites.add(p);
          void p
            .catch(() => (this.stopWriteFailed = true))
            .finally(() => this.stopWrites.delete(p));
          if (!(await withBoundedWait(p, journalMs)).completed) journalTimedOut = true;
        } catch {
          journalTimedOut = true;
        }
      }
      const business = await businessDrain,
        released = await releaseWork,
        stopResult = await stopped,
        stoppedEvidence: KernelStopEvidence = stopResult.completed
          ? stopResult.value
          : { requestId, state: 'unconfirmed', unresolvedMethods: ['KernelExecutor.stop'] },
        unresolved = new Set<string>(stoppedEvidence.unresolvedMethods);
      if (!released) unresolved.add('TaskRendering.release');
      if (journalTimedOut || this.stopWrites.size || this.stopWriteFailed)
        unresolved.add('KernelJournal.finish');
      if (previousStopTimedOut) unresolved.add('PreviousStop');
      if (!business.completed || this.businessPending.size) unresolved.add('BusinessPending');
      const confirmed =
        stoppedEvidence.state === 'stopped' &&
        released &&
        business.completed &&
        this.businessPending.size === 0 &&
        !this.abandoned &&
        !journalTimedOut &&
        this.stopWrites.size === 0 &&
        !this.stopWriteFailed &&
        !previousStopTimedOut;
      this.stopUnconfirmed = !confirmed;
      if (!confirmed) executor.markUnconfirmed();
      return {
        requestId,
        state: confirmed ? 'stopped' : 'unconfirmed',
        unresolvedMethods: [...unresolved],
      };
    })();
    this.stoppingRpc = drained;
    void drained
      .finally(() => {
        if (this.stoppingRpc === drained) this.stoppingRpc = undefined;
      })
      .catch(() => {});
    return drained;
  }
  expire(): void {
    if (!this.executor || this.executor.state !== 'running') return;
    try {
      this.executor.lease.check();
      this.backend?.maintainPresentation?.();
    } catch {
      void this.freeze().catch(() => {});
    }
  }
  async exposePositionedWindow(tabId?: number): Promise<void> {
    if (!this.backend?.setWindowExposure) return;
    try {
      const state = await this.journal.snapshot();
      const ready =
        (tabId !== undefined
          ? state.tabs.find((t) => t.state === 'READY' && t.proof?.tabId === tabId)?.proof
          : undefined) ??
        state.workspaceMain ??
        state.tabs.find((t) => t.state === 'READY' && t.proof)?.proof;
      if (ready) await this.backend.setWindowExposure(ready, true).catch(() => {});
    } catch {}
  }
}
