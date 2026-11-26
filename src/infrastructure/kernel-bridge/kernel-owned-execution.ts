import { createHash } from 'node:crypto';
import type { Awaitable } from '../../domain/persistence.js';
import { sameTabProof } from '../../domain/task-tabs.js';
import type { Peer } from '../../bridge/core.js';
import type { KernelExecutor } from '../../application/kernel-executor.js';
import { guardNativeInput, type NativeInputGuard } from '../../application/kernel-gates.js';
import { Action, canonicalAction } from '../../shared/browser-actions.js';
import type { PostEffects } from '../../shared/facebook-post-observation.js';
import {
  KernelOperationFileGrant,
  type OperationFileGrant,
} from '../../shared/kernel-file-grant.js';
import { kernelRequiresOperation, type KernelAccess } from '../../shared/kernel-policy.js';
import { KernelJsonObject, type KernelBackend } from '../../shared/kernel-protocol.js';
import {
  KernelOperationRecord,
  KernelPersistentState,
  kernelOperationPending,
  type KernelRecord,
  type TabProof,
} from '../../shared/kernel-state.js';
import { SettlementReceipt, sameNotice } from '../../shared/settlement.js';
import type { ChildPageLifecycle, CurrentStop } from '../../shared/task-policies.js';
import {
  DispatchBinding,
  ExecutionContext,
  sameBinding,
  sameExecution,
  type Binding,
  type ExecutionSession,
} from '../../shared/task-execution.js';
import type { connectFixtureKernel } from '../kernel-browser.js';
import type { openKernelRelayEndpoint } from '../kernel-relay-endpoint.js';
import { finishKernelOperation } from '../kernel-operation-finish.js';
import { navigateFacebookBoundPage } from '../facebook-bound-navigation.js';
import { readOwnedFacebookNativeResult } from './kernel-page-readers.js';
import {
  archivedNotice,
  isPeerPaused,
  KernelRpcSession,
  maintainJournal,
  parseInventory,
  resolveSessionStopRequestId,
  type FacebookOwnedOptions,
  type KernelSessionHost,
} from './kernel-rpc-session.js';
interface BuildOwnedConnectionParams {
  host: KernelSessionHost;
  peer: Peer;
  owner: string;
  session: KernelRpcSession;
  executor: KernelExecutor;
  backend: KernelBackend;
  endpoint: Awaited<ReturnType<typeof openKernelRelayEndpoint>>;
  browser: Awaited<ReturnType<typeof connectFixtureKernel>>;
  tab: { tabId: number };
  proof: TabProof | null;
  persistent: boolean;
  access: KernelAccess;
  baseline: KernelJsonObject;
  facebook?: FacebookOwnedOptions;
  arrangeWindow?: (profileId: string, guard: () => void) => Promise<void>;
  close: (requestId?: string) => Promise<{ requestId: string; state: 'stopped' }>;
  retryClose: (requestId: string) => Promise<{ requestId: string; state: 'stopped' }>;
  getClosingId: () => string | undefined;
  getClosedInventory: () => ReturnType<typeof KernelPersistentState.parse> | null;
}
export function buildOwnedConnection(p: BuildOwnedConnectionParams) {
  const {
    host,
    peer,
    owner,
    session,
    executor,
    backend,
    endpoint,
    browser,
    tab,
    proof,
    persistent,
    access,
    facebook,
    close,
  } = p;
  const peerReady = () =>
    !session.closing &&
    !session.inputRevoked &&
    !session.parked &&
    !session.parking &&
    isPeerPaused(host, peer);
  const context = async (accountId: string): Promise<ExecutionSession | null> => {
    if (
      facebook?.readonlyIdentity ||
      (facebook && accountId !== facebook.accountId) ||
      !peerReady()
    )
      return null;
    try {
      session.lease.check();
      await facebook?.assertIdentity();
    } catch {
      return null;
    }
    if (!peerReady()) return null;
    session.lease.check();
    return {
      profileId: peer.profileId,
      accountId,
      connectionEpoch: peer.epoch,
      leaseId: session.stamp.leaseId,
      generation: session.stamp.generation,
    };
  };
  const assertOp = async (
    binding: Binding,
    err: string,
    requireActive: boolean,
    checkExtra?: () => boolean,
  ) => {
    const cur = await context(binding.accountId);
    if (
      !cur ||
      !sameExecution(cur, binding) ||
      (requireActive &&
        (!session.boundOperationActive ||
          !session.activeBinding ||
          !sameBinding(session.activeBinding, binding))) ||
      (checkExtra && !checkExtra())
    )
      throw Error(err);
  };
  const execute = async <T>(
    input: Binding,
    work: () => Promise<T>,
    inputFence?: () => Awaitable<void>,
    failureStop?: (reason: string) => Promise<void>,
    resourceGuard?: NativeInputGuard,
    allowTargetMiss = false,
  ) => {
    if (facebook?.readonlyIdentity) throw Error('FACEBOOK_IDENTITY_READONLY_INPUT_REJECTED');
    const binding = DispatchBinding.parse(input),
      current = await context(binding.accountId);
    if (!persistent || !current || !sameExecution(current, binding))
      throw Error('KERNEL_BOUND_EXECUTION_UNAVAILABLE');
    if (session.boundOperationActive) throw Error('KERNEL_OPERATION_IN_FLIGHT');
    if (session.resultReading) throw Error('NATIVE_RESULT_READ_IN_PROGRESS');
    await inputFence?.();
    session.boundInputRequired = true;
    session.boundOperationActive = true;
    session.activeBinding = binding;
    session.inputFence = inputFence;
    session.resourceGuard = resourceGuard;
    const inputCountBefore = session.nativeInputCount,
      finishBoundOp = async (requireActive: boolean) =>
        finishKernelOperation(
          () => session.request({ kind: 'finishOperation', binding }),
          async () => {
            await inputFence?.();
            await assertOp(binding, 'KERNEL_BOUND_EXECUTION_UNAVAILABLE', requireActive);
          },
        );
    try {
      let operationSequence: number | undefined;
      if (peer.capabilities?.includes('kernel-journal-collection-v1')) {
        if (session.journalSize >= 1000) await maintainJournal(host.core, peer, session);
        operationSequence = await host.core.store.kernelOperationSequence(
          binding,
          session.operationHighWater,
        );
      }
      const begin = await session.request({
        kind: 'beginOperation',
        binding,
        ...(operationSequence === undefined ? {} : { operationSequence }),
      });
      session.journalSize++;
      session.operationHighWater = operationSequence ?? session.operationHighWater;
      const record = KernelOperationRecord.parse(begin.record);
      if (begin.fresh !== true) throw Error('KERNEL_OPERATION_ALREADY_RECORDED');
      if (!sameBinding(record.binding, binding) || record.state !== 'DISPATCHING')
        throw Error('KERNEL_OPERATION_BEGIN_REJECTED');
      await inputFence?.();
      let executeTimer: ReturnType<typeof setTimeout> | undefined;
      const value = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          executeTimer = setTimeout(
            () => reject(Error('KERNEL_EXECUTE_TIMEOUT')),
            allowTargetMiss ? 45_000 : 210_000,
          );
          executeTimer.unref?.();
        }),
      ]).finally(() => {
        if (executeTimer !== undefined) clearTimeout(executeTimer);
      });
      await inputFence?.();
      const result = await finishBoundOp(true),
        returned = DispatchBinding.parse(result.binding),
        latest = await context(binding.accountId);
      if (
        result.acknowledged !== true ||
        !sameBinding(returned, binding) ||
        !latest ||
        !sameExecution(latest, binding)
      )
        throw Error('KERNEL_OPERATION_ACK_REJECTED');
      return { value, binding: returned, targetUnavailableBeforeInput: false };
    } catch (error) {
      if (
        allowTargetMiss &&
        session.nativeInputCount === inputCountBefore &&
        error instanceof Error &&
        /(?:^|:\s*)(?:FACEBOOK_NATIVE_CLICK_TARGET_UNAVAILABLE|FACEBOOK_BROWSE_LIKE_TARGET_CHANGED|FACEBOOK_BROWSE_DIALOG_DISMISS_TARGET_CHANGED|FACEBOOK_REEL_NEXT_TARGET_CHANGED|FACEBOOK_FRIEND_CONFIRM_TARGET_CHANGED|FACEBOOK_FRIEND_ADD_TARGET_CHANGED|FACEBOOK_BROWSE_PLAY_TARGET_UNAVAILABLE|FACEBOOK_BROWSE_PLAY_ALREADY_RUNNING|FACEBOOK_BROWSE_TARGET_MISSING|FACEBOOK_BROWSE_PLAY_UNVERIFIED|FACEBOOK_BROWSE_SCROLL_STALLED|FACEBOOK_BROWSE_DOCUMENT_OR_TARGET_CHANGED|FACEBOOK_WHEEL_START_DOCUMENT_CHANGED)\b/.test(
          error.message,
        )
      ) {
        await inputFence?.();
        await assertOp(binding, 'KERNEL_BOUND_EXECUTION_UNAVAILABLE', false);
        const result = await finishBoundOp(false),
          returned = DispatchBinding.parse(result.binding);
        if (result.acknowledged !== true || !sameBinding(returned, binding))
          throw Error('KERNEL_OPERATION_ACK_REJECTED');
        session.record('target-unavailable-before-input:' + error.message);
        return { value: undefined as T, binding: returned, targetUnavailableBeforeInput: true };
      }
      session.executionFailure = {
        binding: structuredClone(binding),
        message: error instanceof Error ? error.message.slice(0, 8192) : 'KERNEL_EXECUTION_FAILED',
      };
      if (
        process.env.WORKBENCH_TRACE_TIMING === '1' &&
        error instanceof Error &&
        (/^locator\.(?:click|press): Timeout /.test(error.message) ||
          error.message === 'KERNEL_RPC_RESULT_UNKNOWN')
      ) {
        console.warn(
          JSON.stringify({
            event:
              error.message === 'KERNEL_RPC_RESULT_UNKNOWN'
                ? 'KERNEL_EXECUTION_RPC_UNKNOWN'
                : 'SDK_ACTIONABILITY_TIMEOUT',
            profileId: peer.profileId,
            operationId: binding.operationId,
            message: error.message.slice(0, 8192),
            methods: [...session.methodCounts].filter(([m]) =>
              kernelRequiresOperation(m, 'facebook-task'),
            ),
            recent: session.trace.slice(-20),
          }),
        );
      }
      const reason =
        error instanceof Error ? error.message.slice(0, 200) : 'KERNEL_EXECUTION_FAILED';
      session.record('execution-error:' + reason.split('\n')[0]);
      if (failureStop) {
        try {
          await failureStop(reason);
        } catch (stopError) {
          session.record(
            'execution-stop-unconfirmed:' +
              (stopError instanceof Error
                ? stopError.message.split('\n')[0]?.slice(0, 160)
                : 'unknown'),
          );
        }
      } else {
        await close().catch(() => host.stopOwnedSessionOnCloseFailure(peer, session, owner, true));
      }
      throw error;
    } finally {
      executor.revokeFiles();
      session.inputFence = undefined;
      session.resourceGuard = undefined;
      session.boundOperationActive = false;
      session.activeBinding = undefined;
    }
  };
  let retainConnection = (_stop: { requestId: string; state: 'stopped' }): void => {};
  const connection = {
    browser,
    get stopRequestId() {
      return resolveSessionStopRequestId(host, peer, owner, session, p.getClosingId);
    },
    closeLocalAfterDisconnect: async () => {
      session.inputRevoked = true;
      executor.revokeFiles();
      const local = await endpoint.close();
      await browser.close().catch(() => {});
      return local;
    },
    confirmReconnectedStop: async (
      receipt: Pick<CurrentStop, 'profileId' | 'connectionEpoch' | 'requestId' | 'state'>,
    ) => {
      const current = host.core.peers.get(peer.profileId);
      if (
        !current ||
        current === peer ||
        !current.online ||
        !current.synced ||
        current.phase !== 'PAUSED' ||
        receipt.profileId !== peer.profileId ||
        receipt.connectionEpoch !== current.epoch ||
        receipt.requestId !== session.stopControlId ||
        receipt.state !== 'stopped'
      )
        throw Error('KERNEL_RECONNECTED_STOP_MISMATCH');
      session.detachedByConfirmedStop = true;
      const local = await endpoint.retryClose();
      if (local.state !== 'stopped') throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
    },
    revokeInput: (reason: string) => {
      session.inputRevoked = true;
      executor.revokeFiles();
      session.record('local-input-revoked:' + reason.slice(0, 100));
    },
    taskRendering: peer.capabilities?.includes('kernel-task-rendering-v1') === true,
    tabId: tab.tabId,
    proof,
    access,
    get closedInventory() {
      const inv = p.getClosedInventory();
      return inv ? structuredClone(inv) : null;
    },
    context,
    execute,
    navigateBoundPage: async (binding: Binding, input: Action, previousUrl: string) => {
      const action = Action.parse(input),
        guard = async () => {
          await assertOp(
            binding,
            'FACEBOOK_NAVIGATION_ORIGINAL_OPERATION_REQUIRED',
            true,
            () =>
              access === 'facebook-task' &&
              !facebook?.readonlyIdentity &&
              action.kind === 'browseNavigate' &&
              Boolean(proof) &&
              action.tabId === proof?.tabId &&
              createHash('sha256').update(canonicalAction(action)).digest('hex') ===
                binding.actionDigest,
          );
          await session.inputFence?.();
        };
      await guard();
      if (action.kind !== 'browseNavigate') throw Error('FACEBOOK_NAVIGATION_ACTION_REQUIRED');
      await navigateFacebookBoundPage(executor, action.tabId, action.url, previousUrl, guard);
      await guard();
    },
    get executing() {
      return session.boundOperationActive;
    },
    get hasPendingCommands() {
      return executor.hasPendingCommands;
    },
    get retainsPage() {
      return peer.capabilities?.includes('kernel-page-quiesce-v1') === true;
    },
    get executionFailure() {
      return session.executionFailure ? structuredClone(session.executionFailure) : null;
    },
    get failureReason() {
      return session.failureReason;
    },
    readPostResultAlias: async (
      input: Binding,
      nativePostId: string,
      guard: () => Awaitable<void>,
      videoId?: string | null,
      accept?: (effects: PostEffects) => boolean,
      lifecycle?: (value: ChildPageLifecycle) => void,
    ) => {
      const binding = DispatchBinding.parse(input),
        check = async () => {
          await guard();
          const current = await context(binding.accountId);
          if (
            access !== 'facebook-task' ||
            !proof ||
            !current ||
            !sameExecution(current, binding) ||
            session.boundOperationActive ||
            host.sessions.get(peer.profileId) !== session
          )
            throw Error('NATIVE_RESULT_ORIGINAL_CONTEXT_REQUIRED');
        };
      await check();
      if (session.resultReading) throw Error('NATIVE_RESULT_READ_IN_PROGRESS');
      session.resultReading = true;
      try {
        if (!proof) throw Error('NATIVE_RESULT_ORIGINAL_CONTEXT_REQUIRED');
        let lastObs = '';
        return await readOwnedFacebookNativeResult(
          executor,
          async () => KernelPersistentState.parse(await session.request({ kind: 'inventory' })),
          proof,
          binding.accountId,
          nativePostId,
          check,
          {
            videoId,
            accept,
            lifecycle,
            observe: (value) => {
              const { elapsedMilliseconds: _, ...state } = value,
                sig = JSON.stringify(state);
              if (sig !== lastObs) {
                lastObs = sig;
                session.record('result-page:' + JSON.stringify(value));
              }
            },
          },
        );
      } finally {
        session.resultReading = false;
      }
    },
    enablePostNetworkObservation: async (input: Binding, guard: () => Awaitable<void>) => {
      const binding = DispatchBinding.parse(input),
        check = async () => {
          await guard();
          await assertOp(
            binding,
            'ORIGINAL_NETWORK_OBSERVATION_REQUIRED',
            true,
            () => access === 'facebook-task' && Boolean(proof),
          );
        };
      await check();
      await backend.send({ tabId: proof?.tabId ?? -1 }, 'Network.enable', {
        maxTotalBufferSize: 2097152,
        maxResourceBufferSize: 524288,
        maxPostDataSize: 524288,
        enableDurableMessages: true,
      });
      await check();
    },
    grantOperationFiles: async (input: OperationFileGrant) => {
      if (!peer.capabilities?.includes('kernel-operation-files-v1'))
        throw Error('KERNEL_OPERATION_FILES_CAPABILITY_REQUIRED');
      const grant = KernelOperationFileGrant.parse(input),
        guard = session.resourceGuard,
        caps = peer.capabilities;
      if (grant.manifest.sourcePaths && !caps.includes('kernel-direct-operation-files-v1'))
        throw Error('原路径上传需要刷新桥接扩展');
      if (grant.manifest.version === 2 && !caps.includes('kernel-derived-operation-files-v1'))
        throw Error('KERNEL_DERIVED_FILES_EXTENSION_UPDATE_REQUIRED');
      const assertCurrent = async () => {
        if (
          session.closing ||
          session.resourceGuard !== guard ||
          !guard ||
          !proof ||
          !sameTabProof(proof, grant.proof)
        )
          throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
        await assertOp(grant.binding, 'KERNEL_FILE_GRANT_OPERATION_REJECTED', true);
        await session.inputFence?.();
      };
      await assertCurrent();
      await guardNativeInput(
        {
          target: { tabId: grant.proof.tabId },
          method: 'DOM.setFileInputFiles',
          params: { files: grant.files },
        },
        assertCurrent,
        guard,
      );
      await assertCurrent();
      const result = await session.request({ kind: 'grantOperationFiles', grant });
      await assertCurrent();
      const returned = KernelOperationFileGrant.parse(result.grant);
      if (result.granted !== true || JSON.stringify(returned) !== JSON.stringify(grant))
        throw Error('KERNEL_FILE_GRANT_ACK_MISMATCH');
      await executor.grantFiles(grant, assertCurrent);
      await assertCurrent();
      return returned;
    },
    reconcile: async (binding: Binding, resolution: NonNullable<KernelRecord['resolution']>) => {
      if (await archivedNotice(host.core, binding, resolution)) return { binding, resolution };
      const result = await session.request({ kind: 'reconcileOperation', binding, resolution }),
        receipt = SettlementReceipt.parse({
          binding: result.binding,
          resolution: result.resolution,
        });
      if (result.reconciled !== true || !sameNotice(receipt, { binding, resolution }))
        throw Error('KERNEL_RECONCILIATION_RECEIPT_REJECTED');
      const inv = KernelPersistentState.parse(await session.request({ kind: 'inventory' })),
        remote = inv.operations.find((op) => op.binding.operationId === binding.operationId);
      if (
        inv.profileId !== peer.profileId ||
        remote?.state !== 'RECONCILED' ||
        !remote.resolution ||
        !sameNotice(receipt, { binding: remote.binding, resolution: remote.resolution })
      )
        throw Error('KERNEL_RECONCILIATION_INVENTORY_REJECTED');
      return receipt;
    },
    confirmTaskTab: async (expected: TabProof) => {
      const check = () => {
        session.lease.check();
        if (
          !proof ||
          !sameTabProof(proof, expected) ||
          session.closing ||
          session.parked ||
          session.failureReason ||
          host.sessions.get(peer.profileId) !== session ||
          host.core.peers.get(peer.profileId) !== peer
        )
          throw Error('KERNEL_TASK_TAB_CONTEXT_CHANGED');
      };
      check();
      await session.request({ kind: 'scope', tabId: expected.tabId });
      check();
    },
    inventory: () => parseInventory(session),
    baseline: p.baseline,
    get methods() {
      return [...session.methods];
    },
    get inputCalls() {
      return [...session.methodCounts]
        .filter(([m]) => m.startsWith('Input.'))
        .reduce((s, [, c]) => s + c, 0);
    },
    get submissionCalls() {
      return { ...session.submissionCalls };
    },
    get nativeMutationCalls() {
      return Object.fromEntries(
        [...session.methodCounts].filter(([m]) => kernelRequiresOperation(m, session.access)),
      );
    },
    close,
    rebind: async (accountId: string, guard: () => Awaitable<void>) => {
      if (
        !facebook ||
        !session.parked ||
        session.closing ||
        session.failureReason ||
        session.boundOperationActive ||
        session.resultReading
      )
        throw Error('FACEBOOK_WORKSPACE_NOT_IDLE');
      await guard();
      facebook.accountId = accountId;
      facebook.assertIdentity = guard;
      session.identityFence = guard;
      session.inputRevoked = false;
      session.parked = false;
      session.executionFailure = null;
      if (proof)
        await p.arrangeWindow?.(peer.profileId, () => {
          session.lease.check();
          if (
            host.sessions.get(peer.profileId) !== session ||
            session.closing ||
            session.inputRevoked
          )
            throw Error('WINDOW_LAYOUT_REVOKED');
        });
      if (proof && peer.capabilities?.includes('task-presentation-recovery-v1')) {
        await session.request({ kind: 'armTaskPresentation', proof });
        await guard();
      }
      session.record('workspace-task-rebound');
    },
    park: async (requestId: string) => {
      if (
        !facebook ||
        !proof ||
        access !== 'facebook-task' ||
        !peer.capabilities?.includes('kernel-page-quiesce-v1') ||
        session.closing ||
        session.boundOperationActive ||
        session.resultReading ||
        session.failureReason
      )
        throw Error('FACEBOOK_WORKSPACE_PARK_NOT_IDLE');
      const { profileId, connectionEpoch, leaseId, generation } = session.stamp,
        original = ExecutionContext.parse({
          profileId,
          connectionEpoch,
          leaseId,
          generation,
          accountId: facebook.accountId,
        });
      session.parking = true;
      session.identityFence = undefined;
      try {
        const deadline = Date.now() + 5_000;
        while (host.renewing.has(session)) {
          if (
            Date.now() >= deadline ||
            host.core.peers.get(peer.profileId) !== peer ||
            !peer.online
          )
            throw Error('FACEBOOK_WORKSPACE_RENEW_DRAIN_UNCONFIRMED');
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        const before = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
        if (before.operations.some(kernelOperationPending))
          throw Error('FACEBOOK_WORKSPACE_RECONCILIATION_PENDING');
        const res = await session.request({ kind: 'quiesce', context: original, proof }, requestId);
        if (
          res.state !== 'stopped' ||
          res.pageRetained !== true ||
          res.requestId !== requestId ||
          res.generation !== session.stamp.generation + 1
        )
          throw Error('FACEBOOK_WORKSPACE_PARK_UNCONFIRMED');
        const local = await executor.stop(requestId, 12_000, true);
        if (local.state !== 'stopped' || executor.lease.generation !== res.generation)
          throw Error('FACEBOOK_WORKSPACE_LOCAL_PARK_UNCONFIRMED');
        session.stamp.generation = res.generation;
        session.stamp.expiresAt = Date.now() + 10_000;
        await session.request({ kind: 'renew', stamp: { ...session.stamp } });
        executor.grant(session.stamp);
        session.parked = true;
        const stop = { requestId, state: 'stopped' as const };
        retainConnection(stop);
        session.record('workspace-control-released-page-retained');
        return stop;
      } catch (error) {
        session.closing = true;
        throw error;
      } finally {
        session.parking = false;
      }
    },
    retryClose: p.retryClose,
    stopOnCloseFailure: () => host.stopOwnedSessionOnCloseFailure(peer, session, owner, true),
  };
  retainConnection = (stop) => host.idlePages.set(peer.profileId, { peer, connection, stop });
  return connection;
}
export type OwnedConnection = ReturnType<typeof buildOwnedConnection>;
