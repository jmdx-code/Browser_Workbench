import { KernelExecutor, type KernelStopEvidence } from '../src/application/kernel-executor.js';
import type { KernelJournal } from '../src/application/kernel-journal.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import {
  isBenignScrollPreconditionError,
  kernelAccessURL,
  kernelRequiresOperation,
  type KernelAccess,
} from '../src/shared/kernel-policy.js';
import {
  KernelJsonObject,
  KernelTargetInfo,
  type KernelTarget,
} from '../src/shared/kernel-protocol.js';
import type { TabProof } from '../src/shared/kernel-state.js';
import type { KernelRequest as Request } from '../src/shared/kernel-wire.js';
import type { PresentationRecoveryDecision } from '../src/shared/presentation-recovery.js';
import { sameBinding, sameExecution, type Binding } from '../src/shared/task-execution.js';
import type { KernelNativeBackend } from './kernel-backend.js';
import { withBoundedWait } from './workspace-page-group.js';
export { withBoundedWait };
export interface KernelChannelRpcHost {
  readonly abandoned: boolean;
  readonly stopUnconfirmed: boolean;
  readonly journal: KernelJournal;
  readonly businessPending: Set<Promise<unknown>>;
  readonly freezing: Promise<void> | undefined;
  readonly stoppingRpc: Promise<KernelStopEvidence> | undefined;
  executor: KernelExecutor | undefined;
  backend: KernelNativeBackend | undefined;
  activeLeaseId: string;
  activeOperation: Binding | undefined;
  activeInputs: number;
  access: KernelAccess;
  summaryOnly: boolean;
  quiesced: { requestId: string; scope: string; result: KernelJsonObject } | undefined;
  context(): { profileId: string; epoch: string; valid: boolean };
  createBackend(
    allowInput: () => boolean,
    journal: KernelJournal,
    access: KernelAccess,
    allowRead: () => boolean,
    currentOperation: () => Binding | undefined,
  ): KernelNativeBackend;
  requestPresentationRecovery(
    proof: TabProof,
    positionOnly?: boolean,
  ): Promise<PresentationRecoveryDecision>;
  emit(message: unknown): void;
  event(source: KernelTarget, method: string, value: unknown): void;
  freeze(): Promise<void>;
  stopExecutor(requestId: string, detach?: boolean): Promise<KernelStopEvidence>;
}
const SUMMARY_KINDS = new Set([
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
]);
const asJson = (v: unknown) => KernelJsonObject.parse(v);
const stopAndConfirmEnd = async (
  host: KernelChannelRpcHost,
  requestId: string,
  extraCheck = true,
) => {
  const stop = await host.stopExecutor(requestId);
  if (stop.state !== 'stopped' || host.activeInputs || !host.context().valid || !extraCheck)
    throw Error('KERNEL_END_STOP_UNCONFIRMED');
  return stop;
};
const assertReadyTab = async (host: KernelChannelRpcHost, proof: TabProof, err: string) => {
  const state = await host.journal.snapshot();
  host.executor?.lease.check();
  if (!state.tabs.some((t) => t.state === 'READY' && t.proof && sameTabProof(t.proof, proof)))
    throw Error(err);
};
export async function handleChannelRequest(
  host: KernelChannelRpcHost,
  request: Request,
): Promise<KernelJsonObject> {
  if (host.abandoned) throw Error('KERNEL_CHANNEL_ABANDONED');
  if (host.stopUnconfirmed && request.kind !== 'stop') throw Error('KERNEL_STOP_NOT_CONFIRMED');
  if (request.kind === 'open') {
    if (
      host.stopUnconfirmed ||
      (host.executor &&
        (host.executor.state !== 'stopped' ||
          (host.executor.reviewRequired && !request.summaryOnly))) ||
      host.freezing ||
      host.stoppingRpc ||
      host.businessPending.size
    )
      throw Error('KERNEL_ALREADY_OPEN_OR_REVIEW_REQUIRED');
    if (request.leaseId !== request.stamp.leaseId)
      throw Error('KERNEL_LEASE_REJECTED:lease_id_mismatch');
    const context = host.context(),
      lease = new KernelLease(context.profileId, context.epoch),
      access = request.access ?? 'fixture';
    if (request.summaryOnly && (access !== 'fixture' || request.files.length))
      throw Error('KERNEL_SUMMARY_SCOPE_REJECTED');
    if (access === 'facebook-readonly' && request.files.length)
      throw Error('KERNEL_READONLY_FILES_REJECTED');
    let executor: KernelExecutor;
    const canRead = () => {
      try {
        executor.lease.check();
        return (
          !host.abandoned &&
          !host.stopUnconfirmed &&
          executor.state === 'running' &&
          host.context().valid
        );
      } catch {
        return false;
      }
    };
    const backend = host.createBackend(
      () => {
        try {
          const stamp = executor.lease.check();
          return (
            canRead() &&
            !request.summaryOnly &&
            access !== 'facebook-readonly' &&
            host.activeOperation !== undefined &&
            sameExecution(
              { ...stamp, accountId: host.activeOperation.accountId },
              host.activeOperation,
            ) &&
            host.journal.writable
          );
        } catch {
          return false;
        }
      },
      host.journal,
      access,
      canRead,
      () => host.activeOperation,
    );
    executor = new KernelExecutor(lease, backend, [], new Set(request.files), access);
    executor.grant(request.stamp);
    host.backend = backend;
    host.executor = executor;
    backend.setPresentationRecoveryGate?.((proof, positionOnly) =>
      host.requestPresentationRecovery(proof, positionOnly),
    );
    backend.setPresentationObserver?.((proof, state) =>
      host.event({ tabId: proof.tabId }, 'Workbench.presentation', state),
    );
    host.activeLeaseId = request.leaseId;
    host.quiesced = undefined;
    host.access = access;
    host.summaryOnly = request.summaryOnly === true;
    return { opened: true };
  }
  const executor = host.executor,
    backend = host.backend;
  if (!executor || !backend) throw Error('KERNEL_NOT_OPEN');
  if (host.summaryOnly && !SUMMARY_KINDS.has(request.kind))
    throw Error('KERNEL_SUMMARY_INPUT_REJECTED');
  const checkSummaryStopOrLease = () => {
    if (!(host.summaryOnly && executor.state === 'stopped' && !host.stopUnconfirmed))
      executor.lease.check();
  };
  switch (request.kind) {
    case 'retireOperation': {
      if (
        !host.summaryOnly ||
        (request.binding.connectionEpoch === request.connectionEpoch &&
          request.binding.leaseId === request.leaseId) ||
        request.binding.profileId !== host.context().profileId
      )
        throw Error('KERNEL_RETIREMENT_CONTEXT_REJECTED');
      const stop = await stopAndConfirmEnd(host, request.requestId);
      await host.journal.retireOperation(request.binding, request.resolution);
      return asJson({
        binding: request.binding,
        resolution: request.resolution,
        stop,
        inventory: await host.journal.snapshot(),
        retired: true,
      });
    }
    case 'acknowledgeSessionEnd':
      if (!host.summaryOnly || host.activeOperation || host.activeInputs)
        throw Error('KERNEL_SESSION_END_BUSY');
      await host.journal.acknowledgeSessionEnd(request.browserSessionEpoch);
      return { acknowledged: true };
    case 'collectOperations':
      checkSummaryStopOrLease();
      if (host.activeOperation || host.activeInputs) throw Error('KERNEL_COLLECTION_BUSY');
      return {
        collected: await host.journal.collect(request.records, request.browserSessionEpoch),
      };
    case 'armTaskPresentation': {
      const stamp = executor.lease.check();
      if (host.access !== 'facebook-task' || !backend.armTaskPresentation)
        throw Error('TASK_PRESENTATION_UNAVAILABLE');
      await assertReadyTab(host, request.proof, 'TASK_PRESENTATION_PROOF_REJECTED');
      await backend.armTaskPresentation(request.proof);
      executor.lease.check(stamp);
      return { armed: true };
    }
    case 'renew':
      executor.grant(request.stamp);
      return { renewed: true };
    case 'stop':
      return asJson(await host.stopExecutor(request.requestId));
    case 'quiesce': {
      const scope = JSON.stringify({ context: request.context, proof: request.proof });
      if (host.quiesced?.requestId === request.requestId) {
        if (host.quiesced.scope !== scope) throw Error('KERNEL_PAGE_QUIESCE_REQUEST_CONFLICT');
        return host.quiesced.result;
      }
      const stamp = executor.lease.check();
      if (
        host.access !== 'facebook-task' ||
        host.summaryOnly ||
        host.activeOperation ||
        host.activeInputs ||
        host.businessPending.size ||
        host.stoppingRpc ||
        !sameExecution({ ...stamp, accountId: request.context.accountId }, request.context)
      )
        throw Error('KERNEL_PAGE_QUIESCE_NOT_IDLE');
      const inventory = await host.journal.snapshot();
      executor.lease.check(stamp);
      const tab = inventory.tabs.find((r) => r.ownershipId === request.proof.ownershipId);
      if (
        !tab?.proof ||
        tab.state !== 'READY' ||
        !sameTabProof(tab.proof, request.proof) ||
        !backend.owns(request.proof.tabId) ||
        host.activeOperation ||
        host.activeInputs ||
        host.businessPending.size ||
        inventory.operations.some((r) => r.state !== 'RECONCILED' && !r.disposition)
      )
        throw Error('KERNEL_PAGE_QUIESCE_PROOF_OR_OPERATION_CHANGED');
      const evidence = await host.stopExecutor(request.requestId, false),
        result = asJson({
          ...evidence,
          pageRetained: evidence.state === 'stopped',
          generation: executor.lease.generation,
        });
      if (evidence.state === 'stopped')
        host.quiesced = { requestId: request.requestId, scope, result };
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
      checkSummaryStopOrLease();
      return (await (backend.inventory?.() ?? host.journal.snapshot())) as KernelJsonObject;
    case 'observeFacebookIdentity':
      return asJson({ identity: await executor.observeFacebookIdentity(request.tabId) });
    case 'adopt':
      executor.lease.check();
      if (!backend.adopt) throw Error('KERNEL_ADOPTION_UNAVAILABLE');
      await backend.adopt(request.proof);
      await executor.adopt(request.proof.tabId);
      return { adopted: true };
    case 'revealOwnedPage': {
      executor.lease.check();
      if (host.access === 'fixture' || !backend.revealOwnedPage)
        throw Error('WORKSPACE_REVEAL_UNAVAILABLE');
      await assertReadyTab(host, request.proof, 'WORKSPACE_REVEAL_PROOF_REJECTED');
      const result = await backend.revealOwnedPage(request.proof, request.focus);
      executor.lease.check();
      return result;
    }
    case 'consolidateWorkspace':
    case 'recoverTabToHome': {
      executor.lease.check();
      const isConsolidate = request.kind === 'consolidateWorkspace',
        fn = isConsolidate
          ? backend.consolidateWorkspace?.(request.preferActiveTab)
          : backend.recoverTabToHome?.(request.proof);
      if (host.access !== 'facebook-task' || !fn)
        throw Error(isConsolidate ? 'WORKSPACE_CLEANUP_UNAVAILABLE' : 'TAB_RESET_UNAVAILABLE');
      const result = await fn;
      await executor.adopt(result.proof.tabId);
      executor.lease.check();
      return asJson(result);
    }
    case 'beginOperation': {
      if (host.access === 'facebook-readonly') throw Error('KERNEL_READONLY_OPERATION_REJECTED');
      const stamp = executor.lease.check();
      if (
        executor.state !== 'running' ||
        host.activeOperation ||
        request.binding.profileId !== stamp.profileId ||
        request.binding.connectionEpoch !== stamp.connectionEpoch ||
        request.binding.leaseId !== stamp.leaseId ||
        request.binding.generation !== stamp.generation
      )
        throw Error('KERNEL_OPERATION_CONTEXT_REJECTED');
      const result = await host.journal.begin(request.binding, request.operationSequence);
      try {
        executor.lease.check(stamp);
        if (executor.state !== 'running' || !host.context().valid) throw Error('KERNEL_FENCED');
        if (result.fresh) host.activeOperation = request.binding;
        return result as unknown as KernelJsonObject;
      } catch (error) {
        if (result.fresh) await host.journal.finish(request.binding, 'UNKNOWN', 'BEGIN_FENCED');
        throw error;
      }
    }
    case 'finishOperation': {
      if (!host.activeOperation || !sameBinding(host.activeOperation, request.binding))
        throw Error('KERNEL_OPERATION_NOT_ACTIVE');
      if (host.activeInputs) throw Error('KERNEL_OPERATION_STILL_IN_FLIGHT');
      const stamp = executor.lease.check();
      executor.revokeFiles();
      host.activeOperation = undefined;
      await host.journal.finish(request.binding, 'ACKNOWLEDGED');
      executor.lease.check(stamp);
      return { binding: request.binding, acknowledged: true };
    }
    case 'grantOperationFiles': {
      const binding = host.activeOperation;
      if (!binding || !sameBinding(binding, request.grant.binding) || host.activeInputs)
        throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
      const stamp = executor.lease.check();
      const assertOwner = (checkIdle = false) => {
        executor.lease.check(stamp);
        if (
          executor.state !== 'running' ||
          !host.context().valid ||
          !host.journal.writable ||
          !host.activeOperation ||
          !sameBinding(host.activeOperation, binding) ||
          (checkIdle && host.activeInputs)
        )
          throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
      };
      const inventory = await host.journal.snapshot();
      assertOwner(true);
      const tab = inventory.tabs.find((r) => r.ownershipId === request.grant.proof.ownershipId);
      if (!tab?.proof || tab.state !== 'READY' || !sameTabProof(tab.proof, request.grant.proof))
        throw Error('KERNEL_FILE_GRANT_TARGET_REJECTED');
      await executor.grantFiles(request.grant, () => assertOwner(false));
      assertOwner(true);
      return asJson({ granted: true, grant: request.grant });
    }
    case 'reconcileOperation': {
      const stamp = executor.lease.check();
      if (
        host.activeOperation ||
        host.activeInputs ||
        request.binding.profileId !== stamp.profileId
      )
        throw Error('KERNEL_RECONCILIATION_CONTEXT_REJECTED');
      await host.journal.reconcile(request.binding, request.resolution);
      executor.lease.check(stamp);
      return { reconciled: true, binding: request.binding, resolution: request.resolution };
    }
    case 'endUnknownOperation': {
      if (!host.summaryOnly) throw Error('KERNEL_END_SUMMARY_REQUIRED');
      if (request.binding.profileId !== host.context().profileId)
        throw Error('KERNEL_END_PROFILE_REJECTED');
      const stop = await stopAndConfirmEnd(
          host,
          request.requestId,
          request.connectionEpoch === host.context().epoch,
        ),
        orphan = (await host.journal.snapshot()).operations.find(
          (r) => r.binding.operationId === request.binding.operationId,
        );
      if (orphan?.state === 'DISPATCHING')
        await host.journal.finish(request.binding, 'UNKNOWN', 'IDLE_ORPHAN_ENDED');
      await host.journal.endUnknown(request.binding, request.disposition);
      return asJson({
        ended: true,
        binding: request.binding,
        resolution: request.disposition,
        stop,
        inventory: await host.journal.snapshot(),
      });
    }
    case 'withdrawTaskTab': {
      if (!host.summaryOnly || executor.state !== 'stopped')
        throw Error('KERNEL_TAB_WITHDRAW_STOP_REQUIRED');
      const record = (await host.journal.snapshot()).tabs.find(
        (r) => r.ownershipId === request.proof.ownershipId,
      );
      if (!record?.proof || !sameTabProof(record.proof, request.proof))
        throw Error('KERNEL_TAB_WITHDRAW_PROOF_REJECTED');
      if (record.state !== 'CLOSED' && record.state !== 'LOST')
        await host.journal.tabState(record.ownershipId, 'LOST', 'TASK_ENDED_OWNERSHIP_WITHDRAWN');
      return { withdrawn: true, proof: request.proof };
    }
    case 'withdrawIdleTaskTab': {
      if (!host.summaryOnly || executor.state !== 'stopped' || host.activeInputs)
        throw Error('KERNEL_TAB_WITHDRAW_STOP_REQUIRED');
      const snapshot = await host.journal.snapshot();
      if (snapshot.operations.some((op) => op.state !== 'RECONCILED' && !op.disposition))
        throw Error('KERNEL_TAB_WITHDRAW_OPERATION_PENDING');
      const record = snapshot.tabs.find((r) => r.ownershipId === request.record.ownershipId);
      const isFinal = !!record && ['CLOSED', 'LOST'].includes(record.state);
      if (
        !record ||
        record.url !== request.record.url ||
        JSON.stringify(record.proof) !== JSON.stringify(request.record.proof) ||
        (!isFinal && JSON.stringify(record) !== JSON.stringify(request.record))
      )
        throw Error('KERNEL_TAB_WITHDRAW_RECORD_REJECTED');
      if (!isFinal)
        await host.journal.tabState(
          record.ownershipId,
          'LOST',
          'USER_ENDED_UNCONFIRMED_TAB_OWNERSHIP',
        );
      return asJson({
        withdrawn: true,
        record: (await host.journal.snapshot()).tabs.find(
          (r) => r.ownershipId === record.ownershipId,
        ),
      });
    }
    case 'remove':
      await executor.remove(request.tabId);
      return {};
    case 'project':
      return asJson(await executor.project(request.tabId, request.projection));
    case 'send': {
      const input = kernelRequiresOperation(request.method, host.access);
      if (input && (!host.activeOperation || !host.journal.writable))
        throw Error('KERNEL_OPERATION_REQUIRED');
      const tracked =
        input ||
        (host.activeOperation !== undefined &&
          /^Runtime\.(evaluate|callFunctionOn)$/.test(request.method));
      if (tracked) host.activeInputs++;
      try {
        return await executor.send(request.target, request.method, request.params);
      } catch (error) {
        if (
          (executor.reviewRequired ||
            (input && !isBenignScrollPreconditionError(request.method, error))) &&
          host.activeOperation
        ) {
          const binding = host.activeOperation;
          executor.revokeFiles();
          host.activeOperation = undefined;
          await host.journal.finish(binding, 'UNKNOWN', 'NATIVE_RESULT_UNKNOWN');
        }
        throw error;
      } finally {
        if (tracked) host.activeInputs--;
      }
    }
  }
}
function truncateHugeRequestPostBody(rec: Record<string, unknown>): Record<string, unknown> {
  if (!rec.request || typeof rec.request !== 'object') return rec;
  const req = rec.request as Record<string, unknown>,
    BUDGET = 524_288,
    utf8Len = (s: string) =>
      s.length > 170_000 ? new TextEncoder().encode(s).byteLength : s.length,
    postData = typeof req.postData === 'string' ? req.postData : undefined,
    entries = Array.isArray(req.postDataEntries) ? req.postDataEntries : undefined,
    postDataBytes = postData !== undefined ? utf8Len(postData) : 0;
  let chars = 0;
  for (const e of entries ?? [])
    if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).bytes === 'string')
      chars += ((e as Record<string, unknown>).bytes as string).length;
  const entriesBytes =
    entries && chars > 170_000
      ? new TextEncoder().encode(JSON.stringify(entries)).byteLength
      : chars;
  if (postDataBytes <= BUDGET && entriesBytes <= BUDGET) return rec;
  const nextReq: Record<string, unknown> = { ...req };
  if (entriesBytes > BUDGET) {
    delete nextReq.postDataEntries;
    nextReq.__wbPostDataEntriesTruncated = true;
    nextReq.originalPostDataEntriesBytes = entriesBytes;
  }
  if (postDataBytes > BUDGET && postData !== undefined) {
    nextReq.postData = postData.slice(0, 16_384);
    nextReq.__wbPostDataTruncated = true;
    nextReq.originalPostDataBytes = postDataBytes;
  }
  return { ...rec, request: nextReq };
}
export function handleChannelEvent(
  host: KernelChannelRpcHost,
  source: KernelTarget,
  method: string,
  value: unknown,
): void {
  if (host.backend?.consumeRendering?.(source, method, value)) return;
  if (host.access !== 'fixture' && method === 'Page.screencastFrame') return;
  if (!host.activeInputs) void host.backend?.closingDialog?.(source, method, value).catch(() => {});
  const executor = host.executor;
  if (!executor || !executor.acceptsEvent(source)) return;
  if (host.access === 'facebook-readonly' && method.startsWith('Network.')) return;
  if (
    (host.access === 'facebook-task' || host.access === 'agent-browser') &&
    value &&
    typeof value === 'object'
  ) {
    const rec = value as Record<string, unknown>;
    const resource =
      method === 'Network.requestWillBeSent'
        ? rec.request
        : method === 'Network.responseReceived'
          ? rec.response
          : undefined;
    if (
      resource &&
      typeof resource === 'object' &&
      'url' in resource &&
      typeof resource.url === 'string' &&
      resource.url.startsWith('data:')
    )
      return;
    if (method === 'Network.requestWillBeSent') value = truncateHugeRequestPostBody(rec);
  }
  const params = KernelJsonObject.parse(value ?? {});
  if (
    method === 'Inspector.detached' &&
    !source.sessionId &&
    (!host.backend?.owns(source.tabId) || host.backend.isExpectedDetach?.(source.tabId))
  )
    return;
  const emitEvent = (evSource: KernelTarget, evMethod: string, evParams: unknown) =>
    host.emit({
      type: 'KERNEL_EVENT',
      connectionEpoch: host.context().epoch,
      leaseId: host.activeLeaseId,
      source: evSource,
      method: evMethod,
      params: evParams,
    });
  if (method === 'Page.frameNavigated') {
    const frame = KernelJsonObject.safeParse(params.frame);
    if (
      (host.access === 'facebook-task' || host.access === 'agent-browser') &&
      frame.success &&
      frame.data.parentId
    )
      return;
    if (
      frame.success &&
      (host.access !== 'facebook-readonly' || !frame.data.parentId) &&
      typeof frame.data.url === 'string' &&
      !kernelAccessURL(frame.data.url, host.access)
    ) {
      void host.freeze().catch(() => {});
      return emitEvent({ tabId: source.tabId }, 'Inspector.detached', {
        reason: 'main_frame_escaped',
      });
    }
  }
  if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') {
    const info = KernelTargetInfo.parse(params.targetInfo);
    if (info.type !== 'iframe' || !executor.registerChild(source, params.sessionId)) return;
  }
  if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string')
    executor.forgetChild(source.tabId, params.sessionId);
  emitEvent(source, method, params);
}
