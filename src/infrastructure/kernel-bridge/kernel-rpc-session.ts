import { randomUUID } from 'node:crypto';
import type { Awaitable } from '../../domain/persistence.js';
import { KernelLease } from '../../domain/kernel-lease.js';
import type { Core, Peer } from '../../bridge/core.js';
import { KernelExecutor } from '../../application/kernel-executor.js';
import { guardNativeInput, type NativeInputGuard } from '../../application/kernel-gates.js';
import {
  KernelJsonObject,
  KernelTargetInfo,
  MAX_PENDING_KERNEL_RPC,
  RESERVED_KERNEL_CONTROL_RPC,
  type KernelBackend,
  type KernelStamp,
} from '../../shared/kernel-protocol.js';
import { KernelReply, type KernelRequestBody } from '../../shared/kernel-wire.js';
import { kernelRequiresOperation, type KernelAccess } from '../../shared/kernel-policy.js';
import {
  KernelPersistentState,
  kernelOperationPending,
  type KernelRecord,
  type KernelState,
  type TabProof,
  type TabRecord,
} from '../../shared/kernel-state.js';
import { sameBinding, type Binding } from '../../shared/task-execution.js';
import { sameNotice, type NoticeReceipt, type Resolution } from '../../shared/settlement.js';
import type { CurrentStop } from '../../shared/task-policies.js';
import type { ProfilePresentationStatus } from '../../shared/presentation-recovery.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import type { KernelRelayModel } from '../kernel-relay-model.js';
import type { openKernelRelayEndpoint } from '../kernel-relay-endpoint.js';
import type { OwnedConnection } from './kernel-owned-execution.js';
export interface KernelSummaryPort {
  profileId: string;
  inventory(): Promise<KernelState>;
  stopCurrent(
    requestId: string,
    proofs?: readonly TabProof[],
    incompleteTabs?: readonly TabRecord[],
  ): Promise<CurrentStop>;
  notify(binding: Binding, resolution: Resolution): Promise<NoticeReceipt>;
}
export interface AccountObserver {
  shouldRefreshAvatar(profileId: string, accountId: string): Awaitable<boolean>;
  onObserved(
    profileId: string,
    account: {
      state: 'unknown' | 'logged-in' | 'logged-out' | 'restricted' | 'verification';
      id?: string | null;
      name?: string | null;
      avatar?: string | null;
      scope?: import('../../shared/account-state-policy.js').AccountRestrictionScope;
      liveConfirmedLoggedIn?: boolean;
    },
  ): Awaitable<void>;
}
export interface IdlePageEntry {
  peer: Peer;
  connection: OwnedConnection;
  stop: { requestId: string; state: 'stopped' };
}
export interface FacebookOwnedOptions {
  accountId: string | null;
  assertIdentity: () => Awaitable<void>;
  readonlyIdentity?: boolean;
  initialUrl?: string;
  foreground?: boolean;
  preservePage?: () => boolean;
  backgroundMetadataRead?: boolean;
  forceNewTemporaryTab?: boolean;
  allowStuckTabRecovery?: boolean;
}
export interface KernelSessionHost {
  readonly core: Core;
  readonly sessions: Map<string, KernelRpcSession>;
  readonly sessionsByPeer: WeakMap<Peer, KernelRpcSession>;
  readonly idlePages: Map<string, IdlePageEntry>;
  readonly renewing: Set<KernelRpcSession>;
  readonly sequences: WeakMap<Peer, number>;
  readonly traces: Map<string, { at: number; event: string }[]>;
  registerSession(peer: Peer, session: KernelRpcSession): void;
  nextSequence(peer: Peer): number;
  stopOwnedSessionOnCloseFailure(
    peer: Peer,
    session: KernelRpcSession,
    owner: string,
    claimedOwnership?: boolean,
  ): Promise<void>;
}
export function sanitizeTraceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-error:'
      ? (parsed.protocol + '//' + parsed.hostname).slice(0, 80)
      : (parsed.origin + parsed.pathname).slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}
export function isPeerPaused(host: Pick<KernelSessionHost, 'core'>, peer: Peer): boolean {
  return (
    host.core.peers.get(peer.profileId) === peer &&
    peer.online &&
    peer.synced &&
    peer.phase === 'PAUSED'
  );
}
export const parseInventory = async (session: KernelRpcSession) =>
  KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
export function classifyAbnormalPathname(
  rawUrl: string,
): 'verification' | 'restricted' | 'logged-out' | null {
  try {
    const p = new URL(rawUrl, 'https://www.facebook.com').pathname.toLowerCase();
    if (/^\/checkpoint(?:\/|$)/.test(p)) return 'verification';
    if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(p)) return 'restricted';
    if (/^\/(?:login|recover)(?:\.php|\/|$)/.test(p)) return 'logged-out';
  } catch {}
  return null;
}
export function resolveSessionStopRequestId(
  host: KernelSessionHost,
  peer: Peer,
  owner: string,
  session: KernelRpcSession,
  getClosingId?: () => string | undefined,
): string {
  if (!session.stopControlId && peer.controlId && peer.controlId === peer.lastStopRequestId)
    session.stopControlId = peer.controlId;
  const requestId = (session.stopControlId ??= getClosingId?.() ?? randomUUID());
  if (host.core.hasFixtureKernelOwner(peer, owner))
    host.core.bindFixtureStopRequest(peer, owner, requestId);
  return requestId;
}
export function isStuckDocumentRecoveryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'FACEBOOK_TASK_DOCUMENT_TIMEOUT' ||
      error.message === 'FACEBOOK_TASK_DOCUMENT_ERROR_PAGE')
  );
}
export class KernelRpcSession {
  journalSize = 0;
  operationHighWater = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: KernelJsonObject) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      kind: KernelRequestBody['kind'];
      label: string;
      startedAt: number;
    }
  >();
  readonly stamp: KernelStamp;
  readonly lease: KernelLease;
  model: KernelRelayModel | undefined;
  executor: KernelExecutor | undefined;
  endpoint: Awaited<ReturnType<typeof openKernelRelayEndpoint>> | undefined;
  closing = false;
  inputRevoked = false;
  parked = false;
  parking = false;
  inputFence: (() => Awaitable<void>) | undefined;
  resourceGuard: NativeInputGuard | undefined;
  boundOperationActive = false;
  resultReading = false;
  boundInputRequired = false;
  activeBinding: Binding | undefined;
  presentationProof: TabProof | null = null;
  presentationStatus: ProfilePresentationStatus | null = null;
  presentationLogAt = 0;
  access: KernelAccess = 'fixture';
  identityFence: (() => Awaitable<void>) | undefined;
  readonly methods = new Set<string>();
  readonly methodCounts = new Map<string, number>();
  readonly submissionCalls = { mousePress: 0, enter: 0 };
  nativeInputCount = 0;
  readonly trace: { at: number; event: string }[] = [];
  private mutationRequested = false;
  get hasRequestedMutation() {
    return this.mutationRequested;
  }
  executionFailure: { binding: Binding; message: string } | null = null;
  failureReason: string | null = null;
  stopControlId: string | null = null;
  detachedByConfirmedStop = false;
  controlStopReceipt: {
    requestId: string;
    connectionEpoch: string;
    owner: string;
    state: 'stopped';
  } | null = null;
  readonly priorStopRequestId: string | null;
  opened = false;
  private diag(
    level: 'INFO' | 'WARN' | 'ERROR' | 'SLOW',
    event: string,
    reason: string,
    data: Record<string, unknown>,
    durationMs?: number,
  ): void {
    devDiag.record({
      level,
      category: 'KERNEL_RPC',
      event,
      profileId: this.peer.profileId,
      planId: this.activeBinding?.jobId,
      stepId: this.activeBinding?.stepId,
      operationId: this.activeBinding?.operationId,
      ...(durationMs !== undefined ? { durationMs } : {}),
      reason,
      data,
    });
  }
  record(event: string): void {
    if (this.trace.length >= 512) this.trace.splice(32, 1);
    this.trace.push({ at: Date.now(), event });
    if (
      /^(?:connect-error:|execution-error:|open-failed-page:|rpc-error:|peer-fenced:|retained-browse-page-recover-home:)/.test(
        event,
      ) ||
      event === 'actor-input-fenced'
    ) {
      const level = /^(?:connect-error:|execution-error:|rpc-error:)/.test(event)
        ? 'ERROR'
        : 'WARN';
      this.diag(level, 'KERNEL_SESSION_TRACE', event, { owner: this.owner, access: this.access });
    } else if (event.startsWith('rpc-finished:')) {
      const msMatch = /:(\d+)ms$/.exec(event),
        durationMs = msMatch ? Number(msMatch[1]) : 0;
      if (durationMs >= 2000 || event.includes(':UNKNOWN:')) {
        this.diag(
          event.includes(':UNKNOWN:') ? 'ERROR' : 'SLOW',
          'KERNEL_RPC_SLOW_OR_UNKNOWN',
          event,
          { owner: this.owner },
          durationMs,
        );
      }
    }
  }
  constructor(
    readonly peer: Peer,
    readonly owner: string,
    private readonly nextSequence: () => number,
  ) {
    this.priorStopRequestId = peer.lastStopRequestId ?? null;
    this.lease = new KernelLease(peer.profileId, peer.epoch);
    this.stamp = {
      profileId: peer.profileId,
      connectionEpoch: peer.epoch,
      leaseId: randomUUID(),
      generation: 0,
      expiresAt: Date.now() + 60_000,
    };
    this.lease.grant(this.stamp);
  }
  request(body: KernelRequestBody, requestId: string = randomUUID()): Promise<KernelJsonObject> {
    const control = [
        'renew',
        'stop',
        'quiesce',
        'detach',
        'remove',
        'withdrawTaskTab',
        'withdrawIdleTaskTab',
        'endUnknownOperation',
        'finishOperation',
        'reconcileOperation',
      ].includes(body.kind),
      limit = MAX_PENDING_KERNEL_RPC + (control ? RESERVED_KERNEL_CONTROL_RPC : 0);
    if (this.pending.size >= limit) return Promise.reject(Error('KERNEL_RPC_CAPACITY_REJECTED'));
    if (
      body.kind === 'beginOperation' ||
      body.kind === 'grantOperationFiles' ||
      (body.kind === 'send' && /^(Input\.|DOM\.setFileInputFiles)/.test(body.method))
    )
      this.mutationRequested = true;
    this.record('rpc:' + body.kind + (body.kind === 'send' ? ':' + body.method : ''));
    if (
      this.failureReason ||
      !this.peer.online ||
      this.peer.phase !== 'PAUSED' ||
      !this.peer.synced
    ) {
      this.record(
        `peer-fenced:${this.peer.phase}:online=${this.peer.online}:synced=${this.peer.synced}:reason=${this.failureReason ?? this.peer.error ?? 'unknown'}`,
      );
      return Promise.reject(Error(this.failureReason ?? 'KERNEL_PEER_NOT_IDLE'));
    }
    if (this.pending.has(requestId)) return Promise.reject(Error('KERNEL_RPC_ID_IN_USE'));
    const label = body.kind + (body.kind === 'send' ? ':' + body.method : ''),
      startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          this.record(
            'rpc-finished:' +
              label +
              ':UNKNOWN:' +
              Math.round(performance.now() - startedAt) +
              'ms',
          );
          reject(Error('KERNEL_RPC_RESULT_UNKNOWN'));
        },
        body.kind === 'send' ? 35_000 : 15_000,
      );
      this.pending.set(requestId, { resolve, reject, timer, kind: body.kind, label, startedAt });
      try {
        this.peer.send({
          type: 'KERNEL_REQUEST',
          requestId,
          sequence: this.nextSequence(),
          connectionEpoch: this.peer.epoch,
          leaseId: this.stamp.leaseId,
          ...body,
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(Error('KERNEL_RPC_SEND_UNKNOWN'));
      }
    });
  }
  response(value: unknown): void {
    const reply = KernelReply.parse(value);
    if (reply.leaseId !== this.stamp.leaseId) return;
    if (reply.connectionEpoch !== this.peer.epoch) throw Error('KERNEL_REPLY_EPOCH_REJECTED');
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.record(
      `rpc-finished:${pending.label}:${reply.error ? 'ERROR' : 'REPLY'}:${Math.round(performance.now() - pending.startedAt)}ms`,
    );
    if (reply.error) {
      this.record('rpc-error:' + reply.error.slice(0, 160));
      if (/\bKERNEL_LEASE_REJECTED\b/.test(reply.error)) {
        const subReason = reply.error.includes(':')
          ? reply.error.slice(reply.error.indexOf(':') + 1).trim() || 'unknown'
          : 'unspecified';
        this.record(
          `lease-rejected:${subReason}:stamp=${this.stamp.profileId}/${this.stamp.connectionEpoch}/${this.stamp.leaseId}/gen=${this.stamp.generation}:peer=${this.peer.profileId}/${this.peer.epoch}`,
        );
        this.diag('ERROR', 'KERNEL_LEASE_REJECTED_DIAG', reply.error, {
          subReason,
          owner: this.owner,
          access: this.access,
          controllerStamp: { ...this.stamp },
          replyEpoch: reply.connectionEpoch,
          replyLeaseId: reply.leaseId,
          peerEpoch: this.peer.epoch,
        });
      }
    }
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(Error(reply.error));
    else if (pending.kind === 'open') {
      if (reply.result?.opened !== true) pending.reject(Error('KERNEL_OPEN_UNCONFIRMED'));
      else {
        this.opened = true;
        pending.resolve(reply.result);
      }
    } else if (pending.kind === 'stop' && reply.result?.requestId !== reply.requestId)
      pending.reject(Error('KERNEL_STOP_RECEIPT_MISMATCH'));
    else pending.resolve(reply.result ?? {});
  }
  fail(reason: string): void {
    this.opened = false;
    this.failureReason ??= reason;
    this.lease.revoke();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error(reason));
    }
    this.pending.clear();
  }
  backend(): KernelBackend {
    return {
      ...(this.access === 'facebook-task' ? { scopeEnforcedBySend: true as const } : {}),
      scope: async (tabId) => {
        await this.request({ kind: 'scope', tabId });
      },
      attach: async (tabId) =>
        KernelTargetInfo.parse((await this.request({ kind: 'attach', tabId })).info),
      detach: async (tabId) => {
        if (this.detachedByConfirmedStop) return;
        await this.request({ kind: 'detach', tabId });
      },
      create: async (url, ownershipId, foreground) => {
        if (foreground && !this.peer.capabilities?.includes('kernel-create-foreground-v1'))
          throw Error('KERNEL_FOREGROUND_EXTENSION_UPDATE_REQUIRED');
        const result = await this.request({
          kind: 'create',
          url,
          ...(foreground !== undefined &&
          this.peer.capabilities?.includes('kernel-create-foreground-v1')
            ? { foreground }
            : {}),
          ...(this.peer.capabilities?.includes('kernel-journal-v1')
            ? { ownershipId: ownershipId ?? randomUUID() }
            : {}),
        });
        if (
          typeof result.tabId !== 'number' ||
          !Number.isSafeInteger(result.tabId) ||
          result.tabId <= 0
        )
          throw Error('KERNEL_TAB_REPLY_INVALID');
        return { tabId: result.tabId };
      },
      remove: async (tabId) => {
        await this.request({ kind: 'remove', tabId });
      },
      send: async (target, method, params) => {
        if (this.parking) throw Error('KERNEL_SESSION_PARKING');
        if (!this.closing) await this.identityFence?.();
        let command = { target, method, params };
        if (kernelRequiresOperation(method, this.access)) {
          try {
            const guard = this.resourceGuard;
            const assertInputLocal = () => {
              if (this.inputRevoked) throw Error('ACTOR_INPUT_FENCED');
              if (this.resultReading) throw Error('NATIVE_RESULT_READ_IN_PROGRESS');
              if (this.boundInputRequired && (!this.boundOperationActive || this.closing))
                throw Error('KERNEL_BOUND_INPUT_INACTIVE');
              if (
                guard &&
                (this.closing || !this.boundOperationActive || this.resourceGuard !== guard)
              )
                throw Error('KERNEL_RESOURCE_GUARD_REVOKED');
              this.lease.check();
            };
            const assertInput = async () => {
              assertInputLocal();
              await this.identityFence?.();
              await this.inputFence?.();
              assertInputLocal();
            };
            command = await guardNativeInput(command, assertInput, guard, this.access);
            await assertInput();
            assertInputLocal();
          } catch (error) {
            this.record('actor-input-fenced');
            throw error;
          }
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
          this.submissionCalls.mousePress++;
        if (
          method === 'Input.dispatchKeyEvent' &&
          ['keyDown', 'rawKeyDown'].includes(String(params.type)) &&
          (params.key === 'Enter' || params.code === 'Enter' || params.windowsVirtualKeyCode === 13)
        )
          this.submissionCalls.enter++;
        this.methods.add(method);
        this.methodCounts.set(method, (this.methodCounts.get(method) ?? 0) + 1);
        if (
          (method === 'Input.dispatchMouseEvent' &&
            ['mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(params.type))) ||
          (method === 'Input.dispatchKeyEvent' &&
            ['keyDown', 'rawKeyDown', 'keyUp', 'char'].includes(String(params.type))) ||
          method === 'Input.insertText' ||
          method === 'DOM.setFileInputFiles' ||
          method === 'Page.navigate'
        )
          this.nativeInputCount++;
        return await this.request({ kind: 'send', ...command });
      },
    };
  }
  async renew(): Promise<void> {
    if (this.closing) return;
    this.stamp.expiresAt = Date.now() + 60_000;
    this.lease.grant(this.stamp);
    await this.request({ kind: 'renew', stamp: { ...this.stamp } });
  }
}
export async function openKernelRpcSession(
  host: Pick<KernelSessionHost, 'core' | 'nextSequence' | 'registerSession' | 'traces'>,
  peer: Peer,
  access?: KernelAccess,
): Promise<{ owner: string; session: KernelRpcSession }> {
  const owner = randomUUID();
  await host.core.claimFixtureKernel(peer, owner);
  const session = new KernelRpcSession(peer, owner, () => host.nextSequence(peer));
  if (access) session.access = access;
  host.registerSession(peer, session);
  host.traces.set(peer.profileId, session.trace);
  return { owner, session };
}
export async function runEphemeralKernelSession<T>(
  host: KernelSessionHost,
  peer: Peer,
  opts: {
    recheckError: string;
    stopError: string;
    closedReason: string;
    guard?: () => Awaitable<void>;
    rethrowStopError?: () => boolean;
  },
  work: (session: KernelRpcSession, checkCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const { owner, session } = await openKernelRpcSession(host, peer, 'facebook-task');
  const checkCurrent = async () => {
    await opts.guard?.();
    if (
      !isPeerPaused(host, peer) ||
      host.sessions.get(peer.profileId) !== session ||
      session.closing ||
      session.failureReason
    )
      throw Error(opts.recheckError);
    session.lease.check();
  };
  try {
    await session.request({
      kind: 'open',
      stamp: { ...session.stamp },
      files: [],
      access: 'facebook-task',
    });
    await checkCurrent();
    return await work(session, checkCurrent);
  } finally {
    session.closing = true;
    try {
      const stopped = await session.request({ kind: 'stop' });
      if (stopped.state !== 'stopped') throw Error(opts.stopError);
      if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
      host.core.releaseFixtureKernel(peer, owner);
    } catch {
      await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
      if (opts.rethrowStopError?.()) throw Error(opts.stopError);
    } finally {
      session.fail(opts.closedReason);
    }
  }
}
export async function archivedOperations(
  core: Core,
  profileId: string,
  operationIds: readonly string[],
): Promise<KernelRecord[]> {
  if (!core.store.kernelReceipts) return [];
  const result: KernelRecord[] = [];
  for (let i = 0; i < operationIds.length; i += 200)
    result.push(...(await core.store.kernelReceipts(profileId, operationIds.slice(i, i + 200))));
  return result;
}
export async function archivedNotice(
  core: Core,
  binding: Binding,
  resolution: Resolution,
): Promise<boolean> {
  const rows = await archivedOperations(core, binding.profileId, [binding.operationId]);
  return rows.some(
    (row) =>
      sameBinding(row.binding, binding) &&
      [row.resolution, row.disposition].some(
        (v) => v && sameNotice({ binding, resolution }, { binding: row.binding, resolution: v }),
      ),
  );
}
export async function maintainJournal(
  core: Core,
  peer: Peer,
  session: KernelRpcSession,
  value?: unknown,
): Promise<KernelState> {
  let state = KernelPersistentState.parse(value ?? (await session.request({ kind: 'inventory' })));
  if (state.profileId !== peer.profileId) throw Error('KERNEL_COLLECTION_PROFILE_MISMATCH');
  session.journalSize = state.operations.length;
  session.operationHighWater = state.operationHighWater ?? 0;
  if (
    !peer.capabilities?.includes('kernel-journal-collection-v1') ||
    (state.operations.length < 1000 &&
      !state.operations.some((row) => row.executionEnded && !kernelOperationPending(row)))
  )
    return state;
  const terminal = state.operations.filter((row) => !kernelOperationPending(row));
  const retired = terminal.filter((row) => row.executionEnded);
  const retiredIds = new Set(retired.map((row) => row.binding.operationId));
  const eligible = [
    ...retired,
    ...terminal
      .filter((row) => !retiredIds.has(row.binding.operationId))
      .slice(0, Math.max(0, terminal.length - retired.length - 200)),
  ];
  for (let i = 0; i < eligible.length; i += 200) {
    const batch = eligible.slice(i, i + 200);
    await core.store.archiveKernelReceipts(peer.profileId, batch);
    const reply = await session.request({
      kind: 'collectOperations',
      records: batch,
      browserSessionEpoch: state.browserSessionEpoch,
    });
    if (typeof reply.collected !== 'number') throw Error('KERNEL_COLLECTION_UNCONFIRMED');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (eligible.length)
    state = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
  session.journalSize = state.operations.length;
  return state;
}
export async function stopOwnedSessionOnCloseFailure(
  core: Core,
  sessions: Map<string, KernelRpcSession>,
  peer: Peer,
  session: KernelRpcSession,
  owner: string,
  claimedOwnership = true,
): Promise<void> {
  if (
    !claimedOwnership ||
    core.peers.get(peer.profileId) !== peer ||
    sessions.get(peer.profileId) !== session ||
    !core.hasFixtureKernelOwner(peer, owner)
  )
    return;
  session.closing = true;
  session.stopControlId ??= randomUUID();
  core.bindFixtureStopRequest(peer, owner, session.stopControlId);
  const stopReq = await core.stop(peer.profileId, session.stopControlId);
  if (stopReq.requestId) {
    session.stopControlId = stopReq.requestId;
    if (core.hasFixtureKernelOwner(peer, owner))
      core.bindFixtureStopRequest(peer, owner, stopReq.requestId);
  }
}
