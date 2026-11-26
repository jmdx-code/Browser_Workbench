import { randomUUID } from 'node:crypto';
import type { Core, Peer } from '../../bridge/core.js';
import type { KernelExecutor } from '../../application/kernel-executor.js';
import type {
  PresentationFocusGate,
  PositionRecoveryGate,
} from '../../application/kernel-gates.js';
import { SessionCloser } from '../../application/session-closer.js';
import { sameTabProof } from '../../domain/task-tabs.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { kernelOperationPending, type TabProof } from '../../shared/kernel-state.js';
import { KernelEvent } from '../../shared/kernel-wire.js';
import {
  PresentationMonitorState,
  PresentationRecoveryRequest,
} from '../../shared/presentation-recovery.js';
import type { connectFixtureKernel } from '../kernel-browser.js';
import type { openKernelRelayEndpoint } from '../kernel-relay-endpoint.js';
import {
  isPeerPaused,
  type KernelRpcSession,
  type KernelSessionHost,
} from './kernel-rpc-session.js';
export interface KernelLifecycleHost extends KernelSessionHost {
  readonly presentationFocusGate: PresentationFocusGate;
  readonly positionRecoveryGate: PositionRecoveryGate;
  readonly lastFailureReasons: Map<string, { reason: string; epoch: string; at: number }>;
  usesExposedWindowLayout(): boolean;
  recoverWindow?: (profileId: string, guard: () => void, deadline: number) => Promise<void>;
  windowVisible?: (profileId: string, observedAt: number) => void;
}
export async function handleKernelMessage(
  host: KernelLifecycleHost,
  peer: Peer,
  value: unknown,
): Promise<boolean> {
  const rawType =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).type
      : undefined;
  if (rawType === 'PRESENTATION_RECOVERY_REQUEST') {
    const recovery = PresentationRecoveryRequest.safeParse(value);
    if (!recovery.success) return false;
    const request = recovery.data;
    const session = host.sessions.get(peer.profileId);
    const now = Date.now();
    let valid = false;
    try {
      valid =
        isPeerPaused(host, peer) &&
        session?.peer === peer &&
        session.access === 'facebook-task' &&
        session.opened &&
        !session.closing &&
        !session.inputRevoked &&
        !session.parked &&
        !session.parking &&
        request.connectionEpoch === peer.epoch &&
        request.proof.profileId === peer.profileId &&
        !!session.presentationProof &&
        sameTabProof(request.proof, session.presentationProof) &&
        request.leaseId === session.stamp.leaseId &&
        request.generation === session.lease.check().generation;
    } catch {}
    const exposed = request.positionOnly === true;
    let granted = false;
    if (exposed) {
      const deadline = now + 1500;
      const check = () => {
        if (
          !valid ||
          !peer.capabilities?.includes('task-window-occlusion-recovery-v1') ||
          !session ||
          host.sessions.get(peer.profileId) !== session ||
          host.core.peers.get(peer.profileId) !== peer ||
          !peer.online ||
          !peer.synced ||
          !host.usesExposedWindowLayout() ||
          session.closing ||
          session.inputRevoked ||
          session.parked ||
          session.parking ||
          !session.presentationProof ||
          !sameTabProof(session.presentationProof, request.proof) ||
          session.lease.check().leaseId !== request.leaseId ||
          session.lease.check().generation !== request.generation ||
          Date.now() >= deadline
        )
          throw Error('WINDOW_LAYOUT_RECOVERY_REVOKED');
        const status = session.presentationStatus;
        if (
          status?.visibility !== 'hidden' ||
          !status.visibilityAt ||
          Date.now() - status.visibilityAt > 5000
        )
          throw Error('WINDOW_LAYOUT_RECOVERY_VISIBILITY_CHANGED');
      };
      try {
        check();
        if (
          host.recoverWindow &&
          host.positionRecoveryGate.request(peer.profileId, performance.now())
        ) {
          await host.recoverWindow(peer.profileId, check, deadline);
          check();
          granted = true;
        }
      } catch (error) {
        if (
          session &&
          host.sessions.get(peer.profileId) === session &&
          !session.closing &&
          !session.inputRevoked &&
          !session.parked &&
          !session.parking &&
          error instanceof Error &&
          error.message.startsWith('WINDOW_LAYOUT_') &&
          !['WINDOW_LAYOUT_RECOVERY_REVOKED', 'WINDOW_LAYOUT_RECOVERY_VISIBILITY_CHANGED'].includes(
            error.message,
          )
        ) {
          session.presentationStatus = {
            active: true,
            checkedAt: session.presentationStatus?.checkedAt ?? 0,
            visibility: session.presentationStatus?.visibility ?? null,
            visibilityAt: session.presentationStatus?.visibilityAt ?? null,
            windowFocused: session.presentationStatus?.windowFocused ?? null,
            lastRecoveryAt: Date.now(),
            reportedFocused: null,
            recoveryAction: 'LAYOUT_MOVE',
            error: error.message,
          };
        }
        devDiag.record({
          level: 'WARN',
          category: 'KERNEL_RPC',
          event: 'TASK_WINDOW_OCCLUSION_RECOVERY_DEFERRED',
          profileId: peer.profileId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } else
      granted =
        valid &&
        !host.usesExposedWindowLayout() &&
        host.presentationFocusGate.request(peer.profileId, performance.now());
    peer.send({
      type: 'PRESENTATION_RECOVERY_PERMIT',
      requestId: request.requestId,
      connectionEpoch: request.connectionEpoch,
      leaseId: request.leaseId,
      generation: request.generation,
      granted,
      expiresAt: exposed ? Date.now() + 500 : now + 1000,
    });
    if (granted)
      devDiag.record({
        level: 'WARN',
        category: 'KERNEL_RPC',
        event: exposed ? 'TASK_WINDOW_OCCLUSION_MOVED' : 'TASK_PRESENTATION_RECOVERY_GRANTED',
        profileId: peer.profileId,
        reason: exposed ? 'HIDDEN_WINDOW_REPOSITIONED_UNVERIFIED' : 'TASK_PRESENTATION_RECOVERY',
        data: { tabId: request.proof.tabId },
      });
    return true;
  }
  if (rawType !== 'KERNEL_REPLY' && rawType !== 'KERNEL_EVENT') return false;
  const session = host.sessions.get(peer.profileId);
  if (!session) {
    if (rawType === 'KERNEL_EVENT') {
      const late = KernelEvent.safeParse(value);
      if (
        late.success &&
        late.data.connectionEpoch === peer.epoch &&
        late.data.method === 'Inspector.detached' &&
        late.data.params?.reason === 'canceled_by_user'
      )
        host.lastFailureReasons.set(peer.profileId, {
          reason: 'KERNEL_DEBUGGER_CANCELED_BY_USER',
          epoch: peer.epoch,
          at: Date.now(),
        });
    }
    return true;
  }
  if (session.peer !== peer) throw Error('KERNEL_SESSION_NOT_CURRENT');
  if (rawType === 'KERNEL_REPLY') session.response(value);
  else {
    const event = KernelEvent.parse(value);
    if (event.leaseId !== session.stamp.leaseId) return true;
    if (event.connectionEpoch !== peer.epoch) throw Error('KERNEL_EVENT_EPOCH_REJECTED');
    if (event.method === 'Workbench.presentation') {
      if (
        session.access !== 'facebook-task' ||
        event.source.sessionId ||
        event.source.tabId !== session.presentationProof?.tabId ||
        session.closing ||
        session.parked
      )
        return true;
      const state = PresentationMonitorState.parse(event.params);
      const at = Date.now();
      if (
        state.phase === 'CHECK' &&
        state.visibility === 'visible' &&
        state.visibilityAt &&
        at - state.visibilityAt <= 5000
      )
        host.windowVisible?.(peer.profileId, state.visibilityAt);
      const prior = state.phase === 'ARMED' ? null : session.presentationStatus;
      session.presentationStatus = {
        active: true,
        checkedAt: state.phase === 'CHECK' ? at : (prior?.checkedAt ?? 0),
        visibility: state.visibility ?? prior?.visibility ?? null,
        visibilityAt: state.visibilityAt ?? prior?.visibilityAt ?? null,
        windowFocused: state.windowFocused ?? prior?.windowFocused ?? null,
        lastRecoveryAt: state.phase === 'REQUEST' ? at : (prior?.lastRecoveryAt ?? null),
        recoveryAction:
          state.phase === 'REQUEST'
            ? null
            : state.phase === 'LAYOUT_RESULT'
              ? 'LAYOUT_MOVE'
              : state.phase === 'FOCUS_RESULT'
                ? 'FOCUS'
                : (prior?.recoveryAction ?? null),
        reportedFocused:
          state.phase === 'REQUEST'
            ? null
            : state.phase === 'FOCUS_RESULT'
              ? (state.windowFocused ?? null)
              : (prior?.reportedFocused ?? null),
        error: state.phase.endsWith('ERROR')
          ? (state.reason ?? '监测失败')
          : state.phase === 'CHECK'
            ? state.visibility === 'visible'
              ? null
              : prior?.error?.startsWith('WINDOW_LAYOUT_')
                ? prior.error
                : null
            : (prior?.error ?? null),
      };
      if (
        state.phase !== 'CHECK' ||
        at - session.presentationLogAt >= 15000 ||
        prior?.visibility !== session.presentationStatus.visibility ||
        prior?.windowFocused !== session.presentationStatus.windowFocused
      ) {
        session.presentationLogAt = at;
        devDiag.record({
          level: state.phase.endsWith('ERROR') ? 'WARN' : 'INFO',
          category: 'KERNEL_RPC',
          event: 'TASK_PRESENTATION_MONITOR',
          profileId: peer.profileId,
          data: { tabId: event.source.tabId, ...state },
        });
      }
      return true;
    }
    if (event.method === 'Inspector.detached') {
      const rawDetachReason = typeof event.params?.reason === 'string' ? event.params.reason : '';
      const detachFailure =
        rawDetachReason === 'canceled_by_user'
          ? 'KERNEL_DEBUGGER_CANCELED_BY_USER'
          : 'KERNEL_DEBUGGER_DETACHED';
      host.idlePages.delete(peer.profileId);
      session.record(
        'event:Inspector.detached' + (rawDetachReason ? ':' + rawDetachReason.slice(0, 64) : ''),
      );
      session.closing = true;
      if (
        detachFailure === 'KERNEL_DEBUGGER_CANCELED_BY_USER' &&
        session.failureReason === 'KERNEL_DEBUGGER_DETACHED'
      )
        session.failureReason = 'KERNEL_DEBUGGER_CANCELED_BY_USER';
      session.fail(detachFailure);
      host.lastFailureReasons.set(peer.profileId, {
        reason: session.failureReason ?? detachFailure,
        epoch: peer.epoch,
        at: Date.now(),
      });
      void session.endpoint?.close().catch(() => {});
      await host.stopOwnedSessionOnCloseFailure(peer, session, session.owner, true);
    } else session.model?.debuggerEventValidated(event.source, event.method, event.params);
  }
  return true;
}
export function handleKernelDisconnected(host: KernelLifecycleHost, peer: Peer): void {
  if (host.idlePages.get(peer.profileId)?.peer === peer) host.idlePages.delete(peer.profileId);
  const currentSession = host.sessions.get(peer.profileId);
  const session = currentSession?.peer === peer ? currentSession : host.sessionsByPeer.get(peer);
  if (!session || session.peer !== peer) return;
  host.sessionsByPeer.delete(peer);
  if (currentSession === session) {
    host.presentationFocusGate.cancel(peer.profileId);
    host.positionRecoveryGate.cancel(peer.profileId);
    host.idlePages.delete(peer.profileId);
  }
  session.closing = true;
  session.record('peer-disconnected' + (peer.transportFailure ? ':' + peer.transportFailure : ''));
  session.fail(
    'KERNEL_CONNECTION_LOST' + (peer.transportFailure ? ':' + peer.transportFailure : ''),
  );
  void session.endpoint?.close().catch(() => {});
  if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
}
export function handleKernelControlStopped(
  host: KernelSessionHost,
  peer: Peer,
  requestId?: string,
): void {
  const session = host.sessions.get(peer.profileId);
  if (
    !session ||
    session.peer !== peer ||
    host.core.peers.get(peer.profileId) !== peer ||
    !host.core.hasFixtureKernelOwner(peer, session.owner)
  )
    return;
  if (session.stopControlId) {
    if (requestId !== undefined && session.stopControlId !== requestId) return;
    if (peer.lastStoppedRequestId && peer.lastStoppedRequestId !== session.stopControlId) return;
  } else if (requestId !== undefined) {
    if (
      requestId === session.priorStopRequestId ||
      (peer.lastStoppedRequestId !== undefined && peer.lastStoppedRequestId !== requestId)
    )
      return;
  }
  if (
    !requestId ||
    !peer.online ||
    peer.epoch !== session.stamp.connectionEpoch ||
    peer.lastStoppedRequestId !== requestId
  )
    return;
  session.stopControlId = requestId;
  session.controlStopReceipt = {
    requestId,
    connectionEpoch: peer.epoch,
    owner: session.owner,
    state: 'stopped',
  };
  session.detachedByConfirmedStop = true;
  session.fail(session.failureReason ?? 'KERNEL_CONTROL_STOPPED');
  session.closing = true;
  void session.endpoint?.close().catch(() => {});
  if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
  if (host.idlePages.get(peer.profileId)?.peer === peer) host.idlePages.delete(peer.profileId);
  host.core.releaseFixtureKernel(peer, session.owner);
}
export function tickKernelSessions(
  core: Core,
  sessions: Map<string, KernelRpcSession>,
  renewing: Set<KernelRpcSession>,
): void {
  for (const session of sessions.values()) {
    if (!session.opened || session.closing || session.parking || renewing.has(session)) continue;
    renewing.add(session);
    void session
      .renew()
      .catch((error: unknown) => {
        if (
          session.closing ||
          sessions.get(session.peer.profileId) !== session ||
          core.peers.get(session.peer.profileId) !== session.peer
        ) {
          session.record('renew-owner-expired');
          return;
        }
        session.record(
          'renew-failed:' + (error instanceof Error ? error.message.slice(0, 160) : 'unknown'),
        );
      })
      .finally(() => renewing.delete(session));
  }
}
export function revokeKernelInputs(
  idlePages: Map<string, unknown>,
  sessions: Map<string, KernelRpcSession>,
  reason: string,
): void {
  idlePages.clear();
  for (const session of sessions.values()) {
    session.inputRevoked = true;
    session.closing = true;
    session.executor?.revokeFiles();
    session.fail(reason);
  }
}
export async function closeKernelSessions(
  idlePages: Map<string, unknown>,
  sessions: Map<string, KernelRpcSession>,
): Promise<void> {
  idlePages.clear();
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      session.closing = true;
      await session.endpoint?.close().catch(() => {});
      session.fail('KERNEL_SERVICE_SHUTDOWN');
    }),
  );
}
export function createOwnedRelayCloser(params: {
  host: KernelSessionHost;
  peer: Peer;
  owner: string;
  session: KernelRpcSession;
  executor: KernelExecutor;
  endpoint: Awaited<ReturnType<typeof openKernelRelayEndpoint>>;
  browser: Awaited<ReturnType<typeof connectFixtureKernel>>;
  beforeLocalClose: () => Promise<void>;
  beforeRetryClose: () => Promise<void>;
  onReleaseExtra?: () => void;
}) {
  const {
    host,
    peer,
    owner,
    session,
    executor,
    endpoint,
    browser,
    beforeLocalClose,
    beforeRetryClose,
    onReleaseExtra,
  } = params;
  let closingId: string | undefined;
  let endpointCloseStarted = false;
  const closeEndpointOnce = () => {
    endpointCloseStarted = true;
    return endpoint.close();
  };
  const retryEndpointClose = () =>
    endpointCloseStarted ? endpoint.retryClose() : closeEndpointOnce();
  const hasVerifiedStopReceipt = (expectedId = closingId ?? session.stopControlId) => {
    const receipt = session.controlStopReceipt;
    return (
      !!receipt &&
      receipt.state === 'stopped' &&
      receipt.owner === owner &&
      receipt.connectionEpoch === session.stamp.connectionEpoch &&
      receipt.requestId === expectedId &&
      host.core.peers.get(peer.profileId) === peer &&
      peer.online &&
      peer.epoch === session.stamp.connectionEpoch &&
      peer.lastStoppedRequestId === receipt.requestId
    );
  };
  const awaitingControlStop = () =>
    host.core.peers.get(peer.profileId) === peer &&
    peer.online &&
    peer.epoch === session.stamp.connectionEpoch &&
    peer.controlId !== undefined &&
    peer.controlId === session.stopControlId &&
    peer.lastStoppedRequestId !== session.stopControlId;
  const finishAbnormalLocal = async (closeFn: typeof closeEndpointOnce) => {
    let local = await closeFn();
    if (local.state !== 'stopped' && awaitingControlStop()) {
      const until = Date.now() + 14_000;
      while (!hasVerifiedStopReceipt() && awaitingControlStop() && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (local.state !== 'stopped' && hasVerifiedStopReceipt()) local = await retryEndpointClose();
    await browser.close().catch(() => {});
    if (local.state !== 'stopped') throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
    if (!hasVerifiedStopReceipt() && !awaitingControlStop())
      throw Error(session.failureReason ?? 'KERNEL_STOP_UNCONFIRMED');
  };
  const closer = new SessionCloser({
    closeLocal: async () => {
      session.closing = true;
      executor.revokeFiles();
      if (session.failureReason || hasVerifiedStopReceipt() || awaitingControlStop()) {
        await finishAbnormalLocal(closeEndpointOnce);
        return;
      }
      await beforeLocalClose();
      const local = await closeEndpointOnce();
      await browser.close();
      if (local.state !== 'stopped') throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
    },
    retryCloseLocal: async () => {
      if (session.failureReason || hasVerifiedStopReceipt() || awaitingControlStop()) {
        await finishAbnormalLocal(retryEndpointClose);
        return;
      }
      await beforeRetryClose();
      const local = await retryEndpointClose();
      await browser.close();
      if (local.state !== 'stopped') throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
    },
    assertTransport: () => {
      if (hasVerifiedStopReceipt() || awaitingControlStop()) return;
      if (host.sessions.get(peer.profileId) !== session || !isPeerPaused(host, peer))
        throw Error('KERNEL_STOP_TRANSPORT_CHANGED');
    },
    stopRemote: async (requestId) => {
      if (awaitingControlStop()) {
        const until = Date.now() + 14_000;
        while (!hasVerifiedStopReceipt(requestId) && awaitingControlStop() && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (hasVerifiedStopReceipt(requestId)) return { requestId, state: 'stopped' };
      if (session.failureReason) throw Error('KERNEL_STOP_UNCONFIRMED');
      const remote = await session.request({ kind: 'stop' }, requestId);
      if (remote.requestId !== requestId || remote.state !== 'stopped')
        throw Error('KERNEL_STOP_UNCONFIRMED');
      return { requestId, state: 'stopped' };
    },
    release: () => {
      host.core.releaseFixtureKernel(peer, owner);
      if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
      onReleaseExtra?.();
      session.fail('KERNEL_CLOSED');
    },
  });
  const close = (requestId: string = closingId ?? session.stopControlId ?? randomUUID()) => {
    if (closingId && closingId !== requestId)
      return Promise.reject(Error('KERNEL_CONTROL_ID_CONFLICT'));
    if (session.stopControlId && session.stopControlId !== requestId) {
      if (
        !closingId &&
        session.failureReason &&
        /^KERNEL_DEBUGGER_(?:DETACHED|CANCELED_BY_USER)/.test(session.failureReason)
      )
        return Promise.reject(Error(session.failureReason));
      return Promise.reject(Error('KERNEL_CONTROL_ID_CONFLICT'));
    }
    closingId = requestId;
    session.stopControlId = requestId;
    if (host.core.hasFixtureKernelOwner(peer, owner))
      host.core.bindFixtureStopRequest(peer, owner, requestId);
    return closer.close(requestId);
  };
  const retryClose = (requestId: string) =>
    closingId === null ? close(requestId) : closer.retry(requestId);
  return { close, retryClose, getClosingId: () => closingId };
}
export async function discardAdmissionTabImpl(
  deps: {
    core: Core;
    withSummary: <R>(
      peer: Peer,
      work: (port: {
        inventory: () => Promise<{
          tabs: Array<{ proof?: TabProof | null; state: string }>;
          operations: Array<Parameters<typeof kernelOperationPending>[0]>;
        }>;
      }) => Promise<R>,
    ) => Promise<R>;
    connectOwned: (
      peer: Peer,
      files: readonly string[],
      existingTab?: TabProof,
      facebook?: { accountId: null; readonlyIdentity: true; assertIdentity: () => void },
    ) => Promise<{
      stopRequestId: string;
      close: (id: string) => Promise<unknown>;
      stopOnCloseFailure: () => Promise<unknown>;
      retryClose: (id: string) => Promise<unknown>;
    }>;
  },
  peer: Peer,
  proof: TabProof,
) {
  const guard = () => {
    if (
      deps.core.peers.get(peer.profileId) !== peer ||
      !peer.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED'
    )
      throw Error('FACEBOOK_ADMISSION_CLEANUP_REVOKED');
  };
  guard();
  const inventory = await deps.withSummary(peer, (port) => port.inventory());
  guard();
  const record = inventory.tabs.find((row) => row.proof && sameTabProof(row.proof, proof));
  if (record?.state === 'CLOSED') return;
  if (record?.state !== 'READY' || inventory.operations.some(kernelOperationPending))
    throw Error('FACEBOOK_ADMISSION_CLEANUP_UNCONFIRMED');
  const conn = await deps.connectOwned(peer, [], proof, {
    accountId: null,
    readonlyIdentity: true,
    assertIdentity: guard,
  });
  try {
    await conn.close(conn.stopRequestId);
  } catch (error) {
    try {
      await conn.stopOnCloseFailure();
      await conn.retryClose(conn.stopRequestId);
    } catch {
      throw error;
    }
  }
}
