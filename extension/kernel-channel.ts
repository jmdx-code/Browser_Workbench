import { KernelExecutor } from '../src/application/kernel-executor.js';
import type { KernelStopEvidence } from '../src/application/kernel-executor.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import {
  KernelJsonObject,
  KernelTargetInfo,
  type KernelTarget,
} from '../src/shared/kernel-protocol.js';
import { KernelRequest, type KernelRequest as Request } from '../src/shared/kernel-wire.js';
import { ChromeKernelBackend, type KernelNativeBackend } from './kernel-backend.js';
import {
  kernelAccessURL,
  kernelRequiresOperation,
  type KernelAccess,
} from '../src/shared/kernel-policy.js';
import { sameBinding, sameExecution, type Binding } from '../src/shared/task-execution.js';
import type { KernelJournal } from '../src/application/kernel-journal.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import { kernelJournal } from './kernel-storage.js';
import type { TabProof } from '../src/shared/kernel-state.js';
import {
  PresentationRecoveryPermit,
  type PresentationRecoveryDecision,
} from '../src/shared/presentation-recovery.js';
import { TaskWindowController } from './task-window-controller.js';
import type { TaskRendering } from './task-rendering.js';

async function withBoundedWait<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ExtensionKernelChannel {
  private readonly windows = new TaskWindowController();
  private abandoned = false;
  private stopUnconfirmed = false;
  private readonly stopWrites = new Set<Promise<void>>();
  private stopWriteFailed = false;
  private customRendering: TaskRendering | undefined;
  abandon(): void {
    this.abandoned = true;
    this.stopUnconfirmed = true;
    this.activeOperation = undefined;
    for (const pending of this.recoveryPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.recoveryPending.clear();
    this.backend?.forgetRendering?.();
    this.customRendering?.forgetAll();
    this.executor?.markUnconfirmed();
  }
  isStopUnconfirmed(): boolean {
    return this.stopUnconfirmed;
  }
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
  private emit(message: unknown): void {
    if (this.abandoned) return;
    this.output(message);
  }
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
  private requestPresentationRecovery(
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
    const stamp = this.executor.lease.check();
    const requestId = crypto.randomUUID();
    return new Promise<PresentationRecoveryDecision>((resolve) => {
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
  private executor: KernelExecutor | undefined;
  private backend: KernelNativeBackend | undefined;
  private lastSequence = 0;
  private activeLeaseId = '';
  private readonly pending = new Set<Promise<unknown>>();
  private freezing: Promise<void> | undefined;
  private stoppingRpc: Promise<KernelStopEvidence> | undefined;
  private activeOperation: Binding | undefined;
  private activeInputs = 0;
  private readonly businessPending = new Set<Promise<unknown>>();
  private access: KernelAccess = 'fixture';
  private summaryOnly = false;
  private quiesced: { requestId: string; scope: string; result: KernelJsonObject } | undefined;
  constructor(
    private readonly context: () => { profileId: string; epoch: string; valid: boolean },
    private readonly output: (message: unknown) => void,
    private readonly createBackend: (
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
    private readonly journal: KernelJournal = kernelJournal,
  ) {}
  receive(value: unknown): void {
    if (this.abandoned) return;
    const request = KernelRequest.parse(value);
    const context = this.context();
    if (request.connectionEpoch !== context.epoch) throw Error('KERNEL_CONTEXT_REJECTED');
    if (!context.valid || request.sequence <= this.lastSequence) {
      this.emit({
        type: 'KERNEL_REPLY',
        requestId: request.requestId,
        connectionEpoch: request.connectionEpoch,
        leaseId: request.leaseId,
        error: 'KERNEL_CONTEXT_REJECTED',
      });
      return;
    }
    this.lastSequence = request.sequence;
    if (request.kind !== 'open' && request.leaseId !== this.activeLeaseId) {
      this.emit({
        type: 'KERNEL_REPLY',
        requestId: request.requestId,
        connectionEpoch: request.connectionEpoch,
        leaseId: request.leaseId,
        error: 'KERNEL_LEASE_NOT_CURRENT',
      });
      return;
    }
    if (
      this.pending.size >= 64 &&
      request.kind !== 'stop' &&
      request.kind !== 'quiesce' &&
      request.kind !== 'renew'
    )
      throw Error('KERNEL_RPC_BUDGET_EXCEEDED');
    const operation = this.handle(request)
      .then((result) => {
        if (!this.abandoned && request.connectionEpoch === this.context().epoch)
          this.emit({
            type: 'KERNEL_REPLY',
            requestId: request.requestId,
            connectionEpoch: request.connectionEpoch,
            leaseId: request.leaseId,
            result,
          });
      })
      .catch((error: unknown) => {
        if (!this.abandoned && request.connectionEpoch === this.context().epoch)
          this.emit({
            type: 'KERNEL_REPLY',
            requestId: request.requestId,
            connectionEpoch: request.connectionEpoch,
            leaseId: request.leaseId,
            error: error instanceof Error ? error.message.slice(0, 300) : 'KERNEL_RPC_FAILED',
          });
      });
    this.pending.add(operation);
    if (
      request.kind === 'beginOperation' ||
      request.kind === 'grantOperationFiles' ||
      request.kind === 'finishOperation' ||
      request.kind === 'reconcileOperation'
    )
      this.businessPending.add(operation);
    void operation
      .finally(() => {
        this.pending.delete(operation);
        this.businessPending.delete(operation);
      })
      .catch(() => {});
  }
  private async handle(request: Request): Promise<KernelJsonObject> {
    if (this.abandoned) throw Error('KERNEL_CHANNEL_ABANDONED');
    if (this.stopUnconfirmed && request.kind !== 'stop') throw Error('KERNEL_STOP_NOT_CONFIRMED');
    if (request.kind === 'open') {
      if (
        this.stopUnconfirmed ||
        (this.executor &&
          (this.executor.state !== 'stopped' ||
            (this.executor.reviewRequired && !request.summaryOnly))) ||
        this.freezing ||
        this.stoppingRpc ||
        this.businessPending.size
      )
        throw Error('KERNEL_ALREADY_OPEN_OR_REVIEW_REQUIRED');
      if (request.leaseId !== request.stamp.leaseId)
        throw Error('KERNEL_LEASE_REJECTED:lease_id_mismatch');
      const context = this.context();
      const lease = new KernelLease(context.profileId, context.epoch);
      const access = request.access ?? 'fixture';
      if (request.summaryOnly && (access !== 'fixture' || request.files.length))
        throw Error('KERNEL_SUMMARY_SCOPE_REJECTED');
      if (access === 'facebook-readonly' && request.files.length)
        throw Error('KERNEL_READONLY_FILES_REJECTED');
      let executor: KernelExecutor;
      const backend = this.createBackend(
        () => {
          try {
            const stamp = executor.lease.check();
            return (
              !this.abandoned &&
              !this.stopUnconfirmed &&
              !request.summaryOnly &&
              access !== 'facebook-readonly' &&
              executor.state === 'running' &&
              this.activeOperation !== undefined &&
              sameExecution(
                { ...stamp, accountId: this.activeOperation.accountId },
                this.activeOperation,
              ) &&
              this.context().valid &&
              this.journal.writable
            );
          } catch {
            return false;
          }
        },
        this.journal,
        access,
        () => {
          try {
            executor.lease.check();
            return (
              !this.abandoned &&
              !this.stopUnconfirmed &&
              executor.state === 'running' &&
              this.context().valid
            );
          } catch {
            return false;
          }
        },
        () => this.activeOperation,
      );
      executor = new KernelExecutor(lease, backend, [], new Set(request.files), access);
      executor.grant(request.stamp);
      this.backend = backend;
      this.executor = executor;
      backend.setPresentationRecoveryGate?.((proof, positionOnly) =>
        this.requestPresentationRecovery(proof, positionOnly),
      );
      backend.setPresentationObserver?.((proof, state) => {
        this.event({ tabId: proof.tabId }, 'Workbench.presentation', state);
      });
      this.activeLeaseId = request.leaseId;
      this.quiesced = undefined;
      this.access = access;
      this.summaryOnly = request.summaryOnly === true;
      return { opened: true };
    }
    const executor = this.executor,
      backend = this.backend;
    if (!executor || !backend) throw Error('KERNEL_NOT_OPEN');
    if (
      this.summaryOnly &&
      ![
        'renew',
        'stop',
        'inventory',
        'reconcileOperation',
        'endUnknownOperation',
        'withdrawTaskTab',
        'withdrawIdleTaskTab',
        'collectOperations',
        'acknowledgeSessionEnd',
        'retireOperation',
      ].includes(request.kind)
    )
      throw Error('KERNEL_SUMMARY_INPUT_REJECTED');
    switch (request.kind) {
      case 'retireOperation': {
        if (
          !this.summaryOnly ||
          (request.binding.connectionEpoch === request.connectionEpoch &&
            request.binding.leaseId === request.leaseId) ||
          request.binding.profileId !== this.context().profileId
        )
          throw Error('KERNEL_RETIREMENT_CONTEXT_REJECTED');
        const stop = await this.stopExecutor(request.requestId);
        if (stop.state !== 'stopped' || this.activeInputs || !this.context().valid)
          throw Error('KERNEL_END_STOP_UNCONFIRMED');
        await this.journal.retireOperation(request.binding, request.resolution);
        return KernelJsonObject.parse({
          binding: request.binding,
          resolution: request.resolution,
          stop,
          inventory: await this.journal.snapshot(),
          retired: true,
        });
      }
      case 'acknowledgeSessionEnd': {
        if (!this.summaryOnly || this.activeOperation || this.activeInputs)
          throw Error('KERNEL_SESSION_END_BUSY');
        await this.journal.acknowledgeSessionEnd(request.browserSessionEpoch);
        return { acknowledged: true };
      }
      case 'collectOperations': {
        if (!(this.summaryOnly && executor.state === 'stopped' && !this.stopUnconfirmed))
          executor.lease.check();
        if (this.activeOperation || this.activeInputs) throw Error('KERNEL_COLLECTION_BUSY');
        return {
          collected: await this.journal.collect(request.records, request.browserSessionEpoch),
        };
      }
      case 'inspectTaskWindow':
      case 'positionTaskWindow': {
        const stamp = executor.lease.check();
        if (this.access !== 'facebook-task') throw Error('WINDOW_LAYOUT_TASK_SCOPE_REQUIRED');
        const proof = request.kind === 'inspectTaskWindow' ? request.proof : request.expected.proof;
        const guard = () => {
          executor.lease.check(stamp);
          if (
            request.kind === 'positionTaskWindow' &&
            request.deadline !== undefined &&
            Date.now() >= request.deadline
          )
            throw Error('WINDOW_LAYOUT_RECOVERY_EXPIRED');
          if (
            !this.context().valid ||
            this.executor !== executor ||
            this.stoppingRpc ||
            this.freezing
          )
            throw Error('WINDOW_LAYOUT_REVOKED');
        };
        const state = await this.journal.snapshot();
        guard();
        if (!state.tabs.some((t) => t.state === 'READY' && t.proof && sameTabProof(t.proof, proof)))
          throw Error('WINDOW_LAYOUT_PROOF_REJECTED');
        const result =
          request.kind === 'inspectTaskWindow'
            ? await this.windows.inspect(proof, guard)
            : await this.windows.move(request.expected, request.rect, guard, request.focus ?? true);
        guard();
        if (request.kind === 'positionTaskWindow') {
          await backend.setWindowExposure?.(proof, request.exposed);
          guard();
        }
        return KernelJsonObject.parse(result);
      }
      case 'armTaskPresentation': {
        const stamp = executor.lease.check();
        if (this.access !== 'facebook-task' || !backend.armTaskPresentation)
          throw Error('TASK_PRESENTATION_UNAVAILABLE');
        const state = await this.journal.snapshot();
        executor.lease.check(stamp);
        if (
          !state.tabs.some(
            (t) => t.state === 'READY' && t.proof && sameTabProof(t.proof, request.proof),
          )
        )
          throw Error('TASK_PRESENTATION_PROOF_REJECTED');
        await backend.armTaskPresentation(request.proof);
        executor.lease.check(stamp);
        return { armed: true };
      }
      case 'renew':
        executor.grant(request.stamp);
        return { renewed: true };
      case 'stop':
        return KernelJsonObject.parse(await this.stopExecutor(request.requestId));
      case 'quiesce': {
        const scope = JSON.stringify({ context: request.context, proof: request.proof });
        if (this.quiesced?.requestId === request.requestId) {
          if (this.quiesced.scope !== scope) throw Error('KERNEL_PAGE_QUIESCE_REQUEST_CONFLICT');
          return this.quiesced.result;
        }
        const stamp = executor.lease.check();
        if (
          this.access !== 'facebook-task' ||
          this.summaryOnly ||
          this.activeOperation ||
          this.activeInputs ||
          this.businessPending.size ||
          this.stoppingRpc ||
          !sameExecution({ ...stamp, accountId: request.context.accountId }, request.context)
        )
          throw Error('KERNEL_PAGE_QUIESCE_NOT_IDLE');
        const inventory = await this.journal.snapshot();
        executor.lease.check(stamp);
        const tab = inventory.tabs.find((row) => row.ownershipId === request.proof.ownershipId);
        if (
          !tab?.proof ||
          tab.state !== 'READY' ||
          !sameTabProof(tab.proof, request.proof) ||
          !backend.owns(request.proof.tabId) ||
          this.activeOperation ||
          this.activeInputs ||
          this.businessPending.size ||
          inventory.operations.some((row) => row.state !== 'RECONCILED' && !row.disposition)
        )
          throw Error('KERNEL_PAGE_QUIESCE_PROOF_OR_OPERATION_CHANGED');
        const evidence = await this.stopExecutor(request.requestId, false);
        const result = KernelJsonObject.parse({
          ...evidence,
          pageRetained: evidence.state === 'stopped',
          generation: executor.lease.generation,
        });
        if (evidence.state === 'stopped') {
          this.quiesced = { requestId: request.requestId, scope, result };
        }
        return result;
      }
      case 'scope':
        executor.lease.check();
        await backend.scope(request.tabId);
        executor.lease.check();
        return {};
      case 'attach':
        return { info: await executor.attach(request.tabId) } as unknown as KernelJsonObject;
      case 'detach':
        await backend.detach(request.tabId);
        return {};
      case 'create':
        return await executor.create(request.url, request.ownershipId, request.foreground);
      case 'inventory':
        // STOP revokes input, not read-only receipt reconciliation in the same
        // authenticated summary channel.
        if (!(this.summaryOnly && executor.state === 'stopped' && !this.stopUnconfirmed))
          executor.lease.check();
        return (await (backend.inventory?.() ?? this.journal.snapshot())) as KernelJsonObject;
      case 'observeFacebookIdentity':
        return KernelJsonObject.parse({
          identity: await executor.observeFacebookIdentity(request.tabId),
        });
      case 'adopt':
        executor.lease.check();
        if (!backend.adopt) throw Error('KERNEL_ADOPTION_UNAVAILABLE');
        await backend.adopt(request.proof);
        await executor.adopt(request.proof.tabId);
        return { adopted: true };
      case 'revealOwnedPage': {
        executor.lease.check();
        if (this.access === 'fixture' || !backend.revealOwnedPage)
          throw Error('WORKSPACE_REVEAL_UNAVAILABLE');
        const state = await this.journal.snapshot();
        executor.lease.check();
        if (
          !state.tabs.some(
            (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, request.proof),
          )
        )
          throw Error('WORKSPACE_REVEAL_PROOF_REJECTED');
        const result = await backend.revealOwnedPage(request.proof, request.focus);
        executor.lease.check();
        return result;
      }
      case 'consolidateWorkspace': {
        executor.lease.check();
        if (this.access !== 'facebook-task' || !backend.consolidateWorkspace)
          throw Error('WORKSPACE_CLEANUP_UNAVAILABLE');
        const result = await backend.consolidateWorkspace(request.preferActiveTab);
        await executor.adopt(result.proof.tabId);
        executor.lease.check();
        return KernelJsonObject.parse(result);
      }
      case 'beginOperation': {
        if (this.access === 'facebook-readonly') throw Error('KERNEL_READONLY_OPERATION_REJECTED');
        const stamp = executor.lease.check();
        if (
          executor.state !== 'running' ||
          this.activeOperation ||
          request.binding.profileId !== stamp.profileId ||
          request.binding.connectionEpoch !== stamp.connectionEpoch ||
          request.binding.leaseId !== stamp.leaseId ||
          request.binding.generation !== stamp.generation
        )
          throw Error('KERNEL_OPERATION_CONTEXT_REJECTED');
        const result = await this.journal.begin(request.binding, request.operationSequence);
        try {
          executor.lease.check(stamp);
          if (executor.state !== 'running' || !this.context().valid) throw Error('KERNEL_FENCED');
          if (result.fresh) this.activeOperation = request.binding;
          return result as unknown as KernelJsonObject;
        } catch (error) {
          if (result.fresh) await this.journal.finish(request.binding, 'UNKNOWN', 'BEGIN_FENCED');
          throw error;
        }
      }
      case 'finishOperation': {
        if (!this.activeOperation || !sameBinding(this.activeOperation, request.binding))
          throw Error('KERNEL_OPERATION_NOT_ACTIVE');
        if (this.activeInputs) throw Error('KERNEL_OPERATION_STILL_IN_FLIGHT');
        const stamp = executor.lease.check();
        executor.revokeFiles();
        this.activeOperation = undefined;
        await this.journal.finish(request.binding, 'ACKNOWLEDGED');
        executor.lease.check(stamp);
        return { binding: request.binding, acknowledged: true };
      }
      case 'grantOperationFiles': {
        const binding = this.activeOperation;
        if (!binding || !sameBinding(binding, request.grant.binding) || this.activeInputs)
          throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
        const stamp = executor.lease.check();
        const assertCurrent = () => {
          executor.lease.check(stamp);
          if (
            executor.state !== 'running' ||
            !this.context().valid ||
            !this.journal.writable ||
            !this.activeOperation ||
            !sameBinding(this.activeOperation, binding) ||
            this.activeInputs
          )
            throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
        };
        const inventory = await this.journal.snapshot();
        assertCurrent();
        const tab = inventory.tabs.find(
          (row) => row.ownershipId === request.grant.proof.ownershipId,
        );
        if (!tab?.proof || tab.state !== 'READY' || !sameTabProof(tab.proof, request.grant.proof))
          throw Error('KERNEL_FILE_GRANT_TARGET_REJECTED');
        // During native sends activeInputs is expected; the input callback only checks ownership.
        const assertOwner = () => {
          executor.lease.check(stamp);
          if (
            executor.state !== 'running' ||
            !this.context().valid ||
            !this.journal.writable ||
            !this.activeOperation ||
            !sameBinding(this.activeOperation, binding)
          )
            throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
        };
        await executor.grantFiles(request.grant, assertOwner);
        assertCurrent();
        return KernelJsonObject.parse({ granted: true, grant: request.grant });
      }
      case 'reconcileOperation': {
        const stamp = executor.lease.check();
        if (
          this.activeOperation ||
          this.activeInputs ||
          request.binding.profileId !== stamp.profileId
        )
          throw Error('KERNEL_RECONCILIATION_CONTEXT_REJECTED');
        await this.journal.reconcile(request.binding, request.resolution);
        executor.lease.check(stamp);
        return { reconciled: true, binding: request.binding, resolution: request.resolution };
      }
      case 'endUnknownOperation': {
        if (!this.summaryOnly) throw Error('KERNEL_END_SUMMARY_REQUIRED');
        if (request.binding.profileId !== this.context().profileId)
          throw Error('KERNEL_END_PROFILE_REJECTED');
        // Not added to businessPending: stop drains that set before journal disposition.
        const stop = await this.stopExecutor(request.requestId);
        if (
          stop.state !== 'stopped' ||
          this.activeInputs ||
          !this.context().valid ||
          request.connectionEpoch !== this.context().epoch
        )
          throw Error('KERNEL_END_STOP_UNCONFIRMED');
        const orphan = (await this.journal.snapshot()).operations.find(
          (row) => row.binding.operationId === request.binding.operationId,
        );
        if (orphan?.state === 'DISPATCHING')
          await this.journal.finish(request.binding, 'UNKNOWN', 'IDLE_ORPHAN_ENDED');
        await this.journal.endUnknown(request.binding, request.disposition);
        return KernelJsonObject.parse({
          ended: true,
          binding: request.binding,
          resolution: request.disposition,
          stop,
          inventory: await this.journal.snapshot(),
        });
      }
      case 'withdrawTaskTab': {
        if (!this.summaryOnly || executor.state !== 'stopped')
          throw Error('KERNEL_TAB_WITHDRAW_STOP_REQUIRED');
        const snapshot = await this.journal.snapshot();
        const record = snapshot.tabs.find((row) => row.ownershipId === request.proof.ownershipId);
        if (!record?.proof || !sameTabProof(record.proof, request.proof))
          throw Error('KERNEL_TAB_WITHDRAW_PROOF_REJECTED');
        if (record.state !== 'CLOSED' && record.state !== 'LOST')
          await this.journal.tabState(record.ownershipId, 'LOST', 'TASK_ENDED_OWNERSHIP_WITHDRAWN');
        return { withdrawn: true, proof: request.proof };
      }
      case 'withdrawIdleTaskTab': {
        if (!this.summaryOnly || executor.state !== 'stopped' || this.activeInputs)
          throw Error('KERNEL_TAB_WITHDRAW_STOP_REQUIRED');
        const snapshot = await this.journal.snapshot();
        if (
          snapshot.operations.some(
            (operation) => operation.state !== 'RECONCILED' && !operation.disposition,
          )
        )
          throw Error('KERNEL_TAB_WITHDRAW_OPERATION_PENDING');
        const record = snapshot.tabs.find((row) => row.ownershipId === request.record.ownershipId);
        if (
          !record ||
          record.url !== request.record.url ||
          JSON.stringify(record.proof) !== JSON.stringify(request.record.proof) ||
          (!['CLOSED', 'LOST'].includes(record.state) &&
            JSON.stringify(record) !== JSON.stringify(request.record))
        )
          throw Error('KERNEL_TAB_WITHDRAW_RECORD_REJECTED');
        if (!['CLOSED', 'LOST'].includes(record.state))
          await this.journal.tabState(
            record.ownershipId,
            'LOST',
            'USER_ENDED_UNCONFIRMED_TAB_OWNERSHIP',
          );
        const after = (await this.journal.snapshot()).tabs.find(
          (row) => row.ownershipId === record.ownershipId,
        );
        return KernelJsonObject.parse({ withdrawn: true, record: after });
      }
      case 'remove':
        await executor.remove(request.tabId);
        return {};
      case 'project':
        return KernelJsonObject.parse(await executor.project(request.tabId, request.projection));
      case 'send': {
        const input = kernelRequiresOperation(request.method, this.access);
        if (input && (!this.activeOperation || !this.journal.writable))
          throw Error('KERNEL_OPERATION_REQUIRED');
        const tracked =
          input ||
          (this.activeOperation !== undefined &&
            /^Runtime\.(evaluate|callFunctionOn)$/.test(request.method));
        if (tracked) this.activeInputs++;
        try {
          return await executor.send(request.target, request.method, request.params);
        } catch (error) {
          const isBenignScrollPreconditionError =
            request.method === 'DOM.scrollIntoViewIfNeeded' &&
            /Node is detached from document|Could not find node|Node does not have a layout object|Cannot find context/i.test(
              error instanceof Error ? error.message : String(error),
            );
          if (
            (input || executor.reviewRequired) &&
            !isBenignScrollPreconditionError &&
            this.activeOperation
          ) {
            const binding = this.activeOperation;
            executor.revokeFiles();
            this.activeOperation = undefined;
            await this.journal.finish(binding, 'UNKNOWN', 'NATIVE_RESULT_UNKNOWN');
          }
          throw error;
        } finally {
          if (tracked) this.activeInputs--;
        }
      }
    }
  }
  event(source: KernelTarget, method: string, value: unknown): void {
    if (this.backend?.consumeRendering?.(source, method, value)) return;
    if (this.access !== 'fixture' && method === 'Page.screencastFrame') return;
    // A failed business operation can still be recorded while its owner closes the draft.
    // Native backend checks the exact pending owned removal; never handle during native input.
    if (!this.activeInputs)
      void this.backend?.closingDialog?.(source, method, value).catch(() => {});
    const executor = this.executor;
    if (!executor || !executor.acceptsEvent(source)) return;
    // The identity read returns selected actor fields only; raw native requests, headers and
    // response metadata must never escape the read-only inspection via the event relay.
    if (this.access === 'facebook-readonly' && method.startsWith('Network.')) return;
    // Stories can expose multi-megabyte inline resources as CDP network URLs. They
    // are local bytes, not HTTP upload/submission evidence; do not serialize them
    // across the task relay and disconnect the owning session. Fixture CDP is unchanged.
    if (
      (this.access === 'facebook-task' || this.access === 'agent-browser') &&
      value &&
      typeof value === 'object'
    ) {
      const resource =
        method === 'Network.requestWillBeSent' && 'request' in value
          ? value.request
          : method === 'Network.responseReceived' && 'response' in value
            ? value.response
            : undefined;
      if (
        resource &&
        typeof resource === 'object' &&
        'url' in resource &&
        typeof resource.url === 'string' &&
        resource.url.startsWith('data:')
      )
        return;
      if (
        method === 'Network.requestWillBeSent' &&
        'request' in value &&
        value.request &&
        typeof value.request === 'object'
      ) {
        const req = value.request as Record<string, unknown>;
        const postData = typeof req.postData === 'string' ? req.postData : undefined;
        const postDataEntries = Array.isArray(req.postDataEntries)
          ? req.postDataEntries
          : undefined;
        const PAYLOAD_BUDGET_BYTES = 524_288;
        const postDataUtf8Bytes =
          postData !== undefined
            ? postData.length > 170_000
              ? new TextEncoder().encode(postData).byteLength
              : postData.length
            : 0;
        let entriesUtf8Bytes = 0;
        if (postDataEntries !== undefined) {
          let approxChars = 0;
          for (const entry of postDataEntries) {
            if (entry && typeof entry === 'object' && 'bytes' in entry) {
              const b = (entry as Record<string, unknown>).bytes;
              if (typeof b === 'string') approxChars += b.length;
            }
          }
          entriesUtf8Bytes =
            approxChars > 170_000
              ? new TextEncoder().encode(JSON.stringify(postDataEntries)).byteLength
              : approxChars;
        }
        const hasLargePostData = postDataUtf8Bytes > PAYLOAD_BUDGET_BYTES;
        const hasLargePostDataEntries = entriesUtf8Bytes > PAYLOAD_BUDGET_BYTES;
        if (hasLargePostData || hasLargePostDataEntries) {
          const nextReq: Record<string, unknown> = { ...req };
          if (hasLargePostDataEntries) {
            delete nextReq.postDataEntries;
            nextReq.__wbPostDataEntriesTruncated = true;
            nextReq.originalPostDataEntriesBytes = entriesUtf8Bytes;
          }
          if (hasLargePostData && postData !== undefined) {
            nextReq.postData = postData.slice(0, 16_384);
            nextReq.__wbPostDataTruncated = true;
            nextReq.originalPostDataBytes = postDataUtf8Bytes;
          }
          value = { ...(value as Record<string, unknown>), request: nextReq };
        }
      }
    }
    const params = KernelJsonObject.parse(value ?? {});
    // Chrome may report both Inspector.detached and debugger.onDetach for an intentional
    // native close. Peeking must not consume the callback's expected-detach marker.
    if (
      method === 'Inspector.detached' &&
      !source.sessionId &&
      (!this.backend?.owns(source.tabId) || this.backend.isExpectedDetach?.(source.tabId))
    )
      return;
    if (method === 'Page.frameNavigated') {
      const frame = KernelJsonObject.safeParse(params.frame);
      // Task SDK owns the main page only. Embedded widgets can navigate to blank or
      // third-party documents without changing that page's ownership or input scope.
      if (
        (this.access === 'facebook-task' || this.access === 'agent-browser') &&
        frame.success &&
        frame.data.parentId
      )
        return;
      if (
        frame.success &&
        (this.access !== 'facebook-readonly' || !frame.data.parentId) &&
        typeof frame.data.url === 'string' &&
        !kernelAccessURL(frame.data.url, this.access)
      ) {
        void this.freeze().catch(() => {});
        this.emit({
          type: 'KERNEL_EVENT',
          connectionEpoch: this.context().epoch,
          leaseId: this.activeLeaseId,
          source: { tabId: source.tabId },
          method: 'Inspector.detached',
          params: { reason: 'main_frame_escaped' },
        });
        return;
      }
    }
    if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') {
      const info = KernelTargetInfo.parse(params.targetInfo);
      if (info.type !== 'iframe' || !executor.registerChild(source, params.sessionId)) return;
    }
    if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string')
      executor.forgetChild(source.tabId, params.sessionId);
    this.emit({
      type: 'KERNEL_EVENT',
      connectionEpoch: this.context().epoch,
      leaseId: this.activeLeaseId,
      source,
      method,
      params,
    });
  }
  detached(tabId: number): void {
    if (!this.backend?.owns(tabId)) return;
    this.backend.detached(tabId);
    if (this.backend.expectedDetach(tabId)) return;
    void this.freeze().catch(() => {});
    this.emit({
      type: 'KERNEL_EVENT',
      connectionEpoch: this.context().epoch,
      leaseId: this.activeLeaseId,
      source: { tabId },
      method: 'Inspector.detached',
      params: {},
    });
  }
  removed(tabId: number): void {
    const owned = this.backend?.owns(tabId) ?? false;
    const expected = this.backend?.expectedRemoval?.(tabId) ?? false;
    this.backend?.tabRemoved?.(tabId);
    if (owned && !expected) void this.freeze().catch(() => {});
  }
  freeze(): Promise<void> {
    if (this.freezing) return this.freezing;
    const executor = this.executor;
    if (!executor) {
      if (this.stopUnconfirmed) return Promise.reject(Error('KERNEL_STOP_UNCONFIRMED'));
      return Promise.resolve();
    }
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
    options?: {
      previousTimeoutMs?: number;
      journalTimeoutMs?: number;
      releaseTimeoutMs?: number;
      stopTimeoutMs?: number;
    },
  ): Promise<KernelStopEvidence> {
    const reqId = msg.requestId ?? msg.id ?? crypto.randomUUID();
    const epoch = msg.connectionEpoch ?? this.context().epoch;
    const stopped = await this.stopExecutor(reqId, true, options);
    if (stopped.state === 'stopped') {
      this.emit({
        type: 'STOPPED',
        ...(msg.id !== undefined ? { id: msg.id, ok: true, result: { type: 'STOPPED' } } : {}),
        requestId: reqId,
        connectionEpoch: epoch,
      });
    } else {
      this.emit({
        type: 'STOP_UNCONFIRMED',
        ...(msg.id !== undefined ? { id: msg.id } : {}),
        requestId: reqId,
        connectionEpoch: epoch,
        ok: false,
        error: 'KERNEL_STOP_UNCONFIRMED',
        unresolvedMethods: stopped.unresolvedMethods,
      });
    }
    return stopped;
  }
  stopExecutor(
    requestId: string,
    detach = true,
    options?: {
      previousTimeoutMs?: number;
      journalTimeoutMs?: number;
      releaseTimeoutMs?: number;
      stopTimeoutMs?: number;
    },
  ): Promise<KernelStopEvidence> {
    const executor = this.executor;
    if (!executor) return Promise.reject(Error('KERNEL_NOT_OPEN'));
    const binding = this.activeOperation;
    this.activeOperation = undefined; // Synchronous input gate, before storage or detach awaits.
    executor.revokeFiles();
    for (const pending of this.recoveryPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.recoveryPending.clear();
    const previous = this.stoppingRpc;
    const previousTimeoutMs = options?.previousTimeoutMs ?? 3_000;
    const journalTimeoutMs = options?.journalTimeoutMs ?? 3_000;
    const releaseTimeoutMs = options?.releaseTimeoutMs ?? 2_500;
    const stopTimeoutMs = options?.stopTimeoutMs ?? 10_000;
    const retainAttachments = !detach;
    // Start native detach immediately, before old stop promises or storage waits.
    let operation: Promise<KernelStopEvidence>;
    try {
      if (previous) {
        executor.fence();
        // A second STOP must not wait for a renderer before initiating native detach.
        if (detach) void withBoundedWait(executor.forceDetachAll(), stopTimeoutMs).catch(() => {});
        operation = (async () => {
          const earlier = await withBoundedWait(
            previous.catch(() => undefined),
            previousTimeoutMs,
          );
          if (!earlier.completed)
            return {
              requestId,
              state: 'unconfirmed' as const,
              unresolvedMethods: ['PreviousStop'],
            };
          return executor.stop(requestId, stopTimeoutMs, retainAttachments);
        })();
      } else operation = executor.stop(requestId, stopTimeoutMs, retainAttachments);
    } catch {
      if (detach) void withBoundedWait(executor.forceDetachAll(), stopTimeoutMs).catch(() => {});
      operation = Promise.resolve({
        requestId,
        state: 'unconfirmed',
        unresolvedMethods: ['PreviousStop'],
      });
    }
    // Attach rejection handlers now; storage can take longer than native stop.
    const stopped = withBoundedWait(operation, stopTimeoutMs + 200).catch(() => ({
      completed: false as const,
    }));
    const businessDrain = withBoundedWait(
      Promise.allSettled([...this.businessPending]),
      journalTimeoutMs,
    );
    if (detach) {
      this.backend?.forgetRendering?.();
      this.customRendering?.forgetAll();
    }
    const releaseWork = (async () => {
      if (!detach) {
        const rendering = this.customRendering ?? this.backend?.rendering;
        const release =
          this.backend?.releaseRendering && !this.customRendering
            ? this.backend.releaseRendering(undefined, releaseTimeoutMs)
            : (rendering?.release(undefined, releaseTimeoutMs) ?? Promise.resolve(true));
        const result = await withBoundedWait(release, releaseTimeoutMs + 100);
        if (!result.completed || !result.value) return false;
      }
      const windows = await withBoundedWait(this.windows.drain(), releaseTimeoutMs);
      return windows.completed;
    })().catch(() => false);
    const drained = (async (): Promise<KernelStopEvidence> => {
      let previousStopTimedOut = false;
      if (previous) {
        const prevResult = await withBoundedWait(
          previous.catch(() => undefined),
          previousTimeoutMs,
        );
        if (!prevResult.completed) {
          previousStopTimedOut = true;
        }
      }
      let journalTimedOut = false;
      if (binding) {
        try {
          const finishPromise = this.journal.finish(binding, 'UNKNOWN', 'CONTROL_STOPPED');
          this.stopWrites.add(finishPromise);
          void finishPromise
            .catch(() => {
              this.stopWriteFailed = true;
            })
            .finally(() => this.stopWrites.delete(finishPromise));
          void finishPromise.catch(() => {});
          const finishResult = await withBoundedWait(finishPromise, journalTimeoutMs);
          if (!finishResult.completed) {
            journalTimedOut = true;
          }
        } catch {
          journalTimedOut = true;
        }
      }
      const business = await businessDrain;
      const released = await releaseWork;
      const stopResult = await stopped;
      const stoppedEvidence: KernelStopEvidence = stopResult.completed
        ? stopResult.value
        : {
            requestId,
            state: 'unconfirmed',
            unresolvedMethods: ['KernelExecutor.stop'],
          };
      const unresolved = new Set<string>(stoppedEvidence.unresolvedMethods);
      if (!released) unresolved.add('TaskRendering.release');
      if (journalTimedOut) unresolved.add('KernelJournal.finish');
      if (this.stopWrites.size || this.stopWriteFailed) unresolved.add('KernelJournal.finish');
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
      if (confirmed) {
        this.stopUnconfirmed = false;
        return {
          requestId,
          state: 'stopped',
          unresolvedMethods: [...unresolved],
        };
      }
      this.stopUnconfirmed = true;
      executor.markUnconfirmed();
      return {
        requestId,
        state: 'unconfirmed',
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
    const backend = this.backend;
    if (!backend?.setWindowExposure) return;
    try {
      const state = await this.journal.snapshot();
      const ready =
        (tabId !== undefined
          ? state.tabs.find((t) => t.state === 'READY' && t.proof?.tabId === tabId)?.proof
          : undefined) ??
        state.workspaceMain ??
        state.tabs.find((t) => t.state === 'READY' && t.proof)?.proof;
      if (ready) await backend.setWindowExposure(ready, true).catch(() => {});
    } catch {}
  }
}
