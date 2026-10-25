import { ZodError } from 'zod';
import {
  endInvitationSetupOperations,
  prepareFacebookWorkspace,
} from './facebook-workspace-preparation.js';
import { ProductError } from '../domain/workspace.js';
import type { Awaitable } from '../domain/persistence.js';
import { TaskWindowSnapshot, type TaskWindow, type Rect } from '../shared/window-layout.js';
import { randomUUID, createHash } from 'node:crypto';
import { MAX_PENDING_KERNEL_RPC, RESERVED_KERNEL_CONTROL_RPC } from '../shared/kernel-capacity.js';
import { Action, canonicalAction, FacebookBrowseURL } from '../shared/browser-actions.js';
import { navigateFacebookBoundPage } from './facebook-bound-navigation.js';
import type { Core, Peer } from '../bridge/core.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import type { KernelBridgeHooks } from '../bridge/server.js';
import type { WatchTasks } from '../bridge/watch.js';
import { KernelExecutor } from '../application/kernel-executor.js';
import { SessionCloser } from '../application/session-closer.js';
import { KernelLease } from '../domain/kernel-lease.js';
import { KernelEvent, KernelReply, type KernelRequestBody } from '../shared/kernel-wire.js';
import {
  KernelJsonObject,
  KernelTargetInfo,
  type KernelBackend,
  type KernelStamp,
} from '../shared/kernel-protocol.js';
import { KernelRelayModel } from './kernel-relay-model.js';
import { openKernelRelayEndpoint } from './kernel-relay-endpoint.js';
import { connectFixtureKernel } from './kernel-browser.js';
import { SettlementReceipt, sameNotice, type Resolution } from '../shared/settlement.js';
import {
  KernelPersistentState,
  KernelOperationRecord,
  kernelOperationPending,
  type KernelRecord,
  type TabProof,
} from '../shared/kernel-state.js';
import {
  DispatchBinding,
  ExecutionContext,
  sameExecution,
  sameBinding,
  type Binding,
  type ExecutionSession,
} from '../shared/task-execution.js';
import { PageReadRequest, type PageProjectionRequest } from '../shared/page-read.js';
import { validateProjection } from '../shared/page-read.js';
import { projectPage } from '../shared/page-projection.js';
import { facebookDisplayInspectionProjection } from './facebook-read-adapter.js';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { OwnedTabProof, OwnedTabRecord, type TabRecord } from '../shared/kernel-state.js';
import {
  kernelFacebookReadURL,
  kernelRequiresOperation,
  type KernelAccess,
} from '../shared/kernel-policy.js';
import { sampleFacebookPage } from '../application/page-read-sampler.js';
import { releaseFacebookReadTab } from '../application/read-tab-release.js';
import { profileForegroundGranted } from '../shared/profile-foreground.js';
import { awaitFacebookTaskDocument } from './facebook-task-document-ready.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { guardNativeInput, type NativeInputGuard } from '../application/native-input-gate.js';
import { KernelOperationFileGrant, type OperationFileGrant } from '../shared/kernel-file-grant.js';
import { FacebookNativeIdentityRead } from '../shared/facebook-native-identity.js';
import { readOwnedFacebookNativeResult } from './kernel-facebook-result-lookup.js';
import { readCurrentFacebookIdentity } from './facebook-current-identity.js';
import { readCurrentFacebookStoryIdentity } from './facebook-story-identity.js';
import { readFacebookPostPage } from './facebook-post-page-reader.js';
import type { Page } from 'playwright-core';
import type { FacebookUILocale } from '../shared/facebook-ui.js';
import { readFacebookEmptySurface } from './facebook-empty-surface-reader.js';
import type { PostEffects } from '../shared/facebook-post-observation.js';
import { projectFacebookReelResult } from './facebook-reel-result-reader.js';
import { readFacebookBrowsePage } from './facebook-browse-reader.js';
import { projectFacebookDocumentIdentity } from '../shared/facebook-document-identity.js';
import { finishKernelOperation } from './kernel-operation-finish.js';
import { readCurrentFacebookBrowseIdentity } from './facebook-browse-identity.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import {
  PresentationRecoveryRequest,
  PresentationMonitorState,
  type ProfilePresentationStatus,
} from '../shared/presentation-recovery.js';
import {
  PresentationFocusGate,
  PositionRecoveryGate,
} from '../application/presentation-focus-gate.js';

class KernelRpcSession {
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
  readonly trace: { at: number; event: string }[] = [];
  private mutationRequested = false;
  get hasRequestedMutation() {
    return this.mutationRequested;
  }
  executionFailure: { binding: Binding; message: string } | null = null;
  failureReason: string | null = null;
  opened = false;
  record(event: string): void {
    // Keep setup plus recent events; a long browsing run must retain its eventual failure.
    // Input authority never depends on evictable diagnostic entries.
    if (this.trace.length >= 512) this.trace.splice(32, 1);
    this.trace.push({ at: Date.now(), event });
    if (
      event.startsWith('connect-error:') ||
      event.startsWith('execution-error:') ||
      event.startsWith('open-failed-page:') ||
      event.startsWith('rpc-error:') ||
      event.startsWith('peer-fenced:') ||
      event === 'actor-input-fenced' ||
      event.startsWith('retained-browse-page-recover-home:')
    ) {
      devDiag.record({
        level:
          event.startsWith('connect-error:') ||
          event.startsWith('execution-error:') ||
          event.startsWith('rpc-error:')
            ? 'ERROR'
            : 'WARN',
        category: 'KERNEL_RPC',
        event: 'KERNEL_SESSION_TRACE',
        profileId: this.peer.profileId,
        planId: this.activeBinding?.jobId,
        stepId: this.activeBinding?.stepId,
        operationId: this.activeBinding?.operationId,
        reason: event,
        data: { owner: this.owner, access: this.access },
      });
    } else if (event.startsWith('rpc-finished:')) {
      const msMatch = /:(\d+)ms$/.exec(event);
      const durationMs = msMatch ? Number(msMatch[1]) : 0;
      if (durationMs >= 2000 || event.includes(':UNKNOWN:')) {
        devDiag.record({
          level: event.includes(':UNKNOWN:') ? 'ERROR' : 'SLOW',
          category: 'KERNEL_RPC',
          event: 'KERNEL_RPC_SLOW_OR_UNKNOWN',
          profileId: this.peer.profileId,
          planId: this.activeBinding?.jobId,
          stepId: this.activeBinding?.stepId,
          operationId: this.activeBinding?.operationId,
          durationMs,
          reason: event,
          data: { owner: this.owner },
        });
      }
    }
  }
  constructor(
    readonly peer: Peer,
    readonly owner: string,
    private readonly nextSequence: () => number,
  ) {
    this.lease = new KernelLease(peer.profileId, peer.epoch);
    this.stamp = {
      profileId: peer.profileId,
      connectionEpoch: peer.epoch,
      leaseId: randomUUID(),
      generation: 0,
      expiresAt: Date.now() + 10_000,
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
    ].includes(body.kind);
    const limit = MAX_PENDING_KERNEL_RPC + (control ? RESERVED_KERNEL_CONTROL_RPC : 0);
    if (this.pending.size >= limit) return Promise.reject(Error('KERNEL_RPC_CAPACITY_REJECTED'));
    if (
      body.kind === 'beginOperation' ||
      body.kind === 'grantOperationFiles' ||
      (body.kind === 'send' && /^(Input\.|DOM\.setFileInputFiles)/.test(body.method))
    )
      this.mutationRequested = true;
    this.record('rpc:' + body.kind + (body.kind === 'send' ? ':' + body.method : ''));
    if (!this.peer.online || this.peer.phase !== 'PAUSED' || !this.peer.synced) {
      this.record(
        'peer-fenced:' +
          this.peer.phase +
          ':online=' +
          this.peer.online +
          ':synced=' +
          this.peer.synced +
          ':reason=' +
          (this.failureReason ?? this.peer.error ?? 'unknown'),
      );
      return Promise.reject(Error(this.failureReason ?? 'KERNEL_PEER_NOT_IDLE'));
    }
    if (this.pending.has(requestId)) return Promise.reject(Error('KERNEL_RPC_ID_IN_USE'));
    const label = body.kind + (body.kind === 'send' ? ':' + body.method : '');
    const startedAt = performance.now();
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
      'rpc-finished:' +
        pending.label +
        ':' +
        (reply.error ? 'ERROR' : 'REPLY') +
        ':' +
        Math.round(performance.now() - pending.startedAt) +
        'ms',
    );
    if (reply.error) this.record('rpc-error:' + reply.error.slice(0, 160));
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
            // The caller resumes on another microtask after the asynchronous gate returns.
            await assertInput();
            // No await between this local cancellation fence and request().
            assertInputLocal();
          } catch (error) {
            this.record('actor-input-fenced');
            throw error;
          }
        }
        this.methods.add(method);
        this.methodCounts.set(method, (this.methodCounts.get(method) ?? 0) + 1);
        return await this.request({ kind: 'send', ...command });
      },
    };
  }
  async renew(): Promise<void> {
    if (this.closing) return;
    this.stamp.expiresAt = Date.now() + 10_000;
    this.lease.grant(this.stamp);
    await this.request({ kind: 'renew', stamp: { ...this.stamp } });
  }
}

// Private transport owner. Production inspection exposes projections, never raw commands.
export class KernelBridge implements KernelBridgeHooks {
  private arrangeWindow?: (profileId: string, guard: () => void) => Promise<void>;
  private exposedLayoutEnabled?: () => boolean;
  private recoverWindow?: (profileId: string, guard: () => void, deadline: number) => Promise<void>;
  private windowVisible?: (profileId: string, observedAt: number) => void;
  usesExposedWindowLayout() {
    return this.exposedLayoutEnabled?.() === true;
  }
  setWindowLayoutHook(
    hook: (profileId: string, guard: () => void) => Promise<void>,
    enabled?: () => boolean,
    recover?: (profileId: string, guard: () => void, deadline: number) => Promise<void>,
    visible?: (profileId: string, observedAt: number) => void,
  ) {
    this.arrangeWindow = hook;
    this.exposedLayoutEnabled = enabled;
    this.recoverWindow = recover;
    this.windowVisible = visible;
  }
  async taskWindow(
    profileId: string,
    expected?: TaskWindow,
    rect?: Rect,
    exposed = false,
    deadline?: number,
    focus = true,
  ): Promise<TaskWindow> {
    const peer = this.core.peers.get(profileId);
    if (!peer?.online || !peer.synced) throw Error('WINDOW_LAYOUT_PROFILE_OFFLINE');
    if (!peer.capabilities?.includes('task-window-layout-v1'))
      throw Error('WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED');
    if (!peer.capabilities.includes('task-window-content-layout-v1'))
      throw Error('WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED');
    if (!peer.capabilities.includes('task-window-simple-recovery-v1'))
      throw Error('WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED');
    let session = this.sessions.get(profileId);
    let temporary = false;
    if (!session) {
      const owner = randomUUID();
      await this.core.claimFixtureKernel(peer, owner);
      session = new KernelRpcSession(peer, owner, () => {
        const next = (this.sequences.get(peer) ?? 0) + 1;
        this.sequences.set(peer, next);
        return next;
      });
      session.access = 'facebook-task';
      this.sessions.set(profileId, session);
      temporary = true;
    }
    const current = session;
    const guard = () => {
      if (
        this.sessions.get(profileId) !== current ||
        this.core.peers.get(profileId) !== peer ||
        !peer.online ||
        !peer.synced ||
        current.closing ||
        current.failureReason ||
        current.access !== 'facebook-task'
      )
        throw Error('WINDOW_LAYOUT_CHANNEL_CHANGED');
      current.lease.check();
    };
    try {
      if (temporary)
        await current.request({
          kind: 'open',
          stamp: { ...current.stamp },
          files: [],
          access: 'facebook-task',
        });
      guard();
      const inventory = KernelPersistentState.parse(await current.request({ kind: 'inventory' }));
      guard();
      const proof = inventory.workspaceMain;
      if (!proof || (expected && !sameTabProof(expected.proof, proof)))
        throw Error('WINDOW_LAYOUT_MAIN_CHANGED');
      const value = await current.request(
        expected && rect
          ? {
              kind: 'positionTaskWindow',
              expected,
              rect,
              exposed,
              ...(peer.capabilities.includes('task-window-passive-layout-v1') ? { focus } : {}),
              ...(deadline !== undefined ? { deadline } : {}),
            }
          : { kind: 'inspectTaskWindow', proof },
      );
      guard();
      return TaskWindowSnapshot.parse(value);
    } finally {
      if (temporary) {
        current.closing = true;
        try {
          const stopped = await current.request({ kind: 'stop' });
          if (stopped.state !== 'stopped') throw Error('WINDOW_LAYOUT_STOP_UNCONFIRMED');
          if (this.sessions.get(profileId) === current) this.sessions.delete(profileId);
          this.core.releaseFixtureKernel(peer, current.owner);
        } catch {
          if (this.core.peers.get(profileId) === peer) await this.core.stop(profileId);
          throw Error('WINDOW_LAYOUT_STOP_UNCONFIRMED');
        } finally {
          current.fail('WINDOW_LAYOUT_CLOSED');
        }
      }
    }
  }
  private readonly presentationFocusGate = new PresentationFocusGate();
  async releaseIdleForExtension(peer: Peer) {
    const idle = this.idlePages.get(peer.profileId);
    if (idle?.peer === peer) await idle.connection.close();
  }
  private readonly positionRecoveryGate = new PositionRecoveryGate();
  async consolidateFacebookWorkspace(peer: Peer, preferActiveTab = true) {
    if (
      this.core.peers.get(peer.profileId) !== peer ||
      !peer.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED'
    )
      throw Error('WORKSPACE_CLEANUP_SESSION_RECHECK_REQUIRED');
    const inventory = await endInvitationSetupOperations(this, peer);
    if (inventory.operations.some(kernelOperationPending))
      throw Error('WORKSPACE_CLEANUP_OPERATION_PENDING');
    const idle = this.idlePages.get(peer.profileId);
    if (idle) {
      if (idle.peer !== peer) throw Error('WORKSPACE_CLEANUP_CHANNEL_BUSY');
      await idle.connection.close();
    }
    if (!peer.capabilities?.includes('kernel-workspace-cleanup-v1'))
      throw Error('WORKSPACE_CLEANUP_EXTENSION_UPDATE_REQUIRED');
    if (
      !peer.capabilities.includes('facebook-task-kernel-v1') ||
      this.watches.busy(peer.profileId) ||
      this.sessions.has(peer.profileId)
    )
      throw Error('WORKSPACE_CLEANUP_CHANNEL_BUSY');
    const guard = () => {
      if (
        this.core.peers.get(peer.profileId) !== peer ||
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED'
      )
        throw Error('WORKSPACE_CLEANUP_SESSION_RECHECK_REQUIRED');
    };
    guard();
    const owner = randomUUID();
    await this.core.claimFixtureKernel(peer, owner);
    const session = new KernelRpcSession(peer, owner, () => {
      const sequence = (this.sequences.get(peer) ?? 0) + 1;
      this.sequences.set(peer, sequence);
      return sequence;
    });
    session.access = 'facebook-task';
    this.sessions.set(peer.profileId, session);
    this.traces.set(peer.profileId, session.trace);
    const current = () => {
      guard();
      if (this.sessions.get(peer.profileId) !== session || session.closing || session.failureReason)
        throw Error('WORKSPACE_CLEANUP_SESSION_RECHECK_REQUIRED');
      session.lease.check();
    };
    try {
      await session.request({
        kind: 'open',
        stamp: { ...session.stamp },
        files: [],
        access: 'facebook-task',
      });
      current();
      const result = await session.request({
        kind: 'consolidateWorkspace',
        preferActiveTab,
      });
      current();
      const proof = OwnedTabProof.parse(result.proof);
      const closedTabIds = Array.isArray(result.closedTabIds)
        ? result.closedTabIds.filter((id): id is number => typeof id === 'number')
        : [];
      const remainingTabCount =
        typeof result.remainingTabCount === 'number' ? result.remainingTabCount : 1;
      if (remainingTabCount !== 1) throw Error('WORKSPACE_CLEANUP_TABS_UNCONFIRMED');
      const url = typeof result.url === 'string' ? result.url : '';
      return {
        profileId: peer.profileId,
        proof,
        url,
        closedTabIds,
        remainingTabCount,
      };
    } finally {
      session.closing = true;
      try {
        const stopped = await session.request({ kind: 'stop' });
        if (stopped.state !== 'stopped') throw Error('WORKSPACE_CLEANUP_STOP_UNCONFIRMED');
        if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
        this.core.releaseFixtureKernel(peer, owner);
      } catch {
        if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
      } finally {
        session.fail('WORKSPACE_CLEANUP_CLOSED');
      }
    }
  }
  async revealRegisteredFacebookPage(peer: Peer) {
    const inventory = await this.withSummary(peer, (port) => port.inventory());
    if (inventory.operations.some(kernelOperationPending))
      throw Error('WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED');
    if (!inventory.workspaceMain) return null;
    return this.revealOwnedFacebookPage(peer, inventory.workspaceMain);
  }
  async revealOwnedFacebookPage(
    peer: Peer,
    proof: TabProof,
  ): Promise<{ profileId: string; tabId: number; focused: true }> {
    if (!peer.capabilities?.includes('kernel-owned-page-reveal-v1'))
      throw Error('WORKSPACE_REVEAL_EXTENSION_UPDATE_REQUIRED');
    const session = this.sessions.get(peer.profileId);
    if (!session) {
      const guard = () => {
        if (
          this.core.peers.get(peer.profileId) !== peer ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED'
        )
          throw Error('WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED');
      };
      guard();
      return this.revealIdleFacebookPage(peer, proof, guard);
    }
    if (session.peer !== peer || session.closing || session.failureReason)
      throw Error('WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED');
    if (!session.opened || session.access === 'fixture')
      throw Error('WORKSPACE_REVEAL_CHANNEL_BUSY');
    const inventory = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
    if (
      !inventory.tabs.some(
        (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, proof),
      )
    )
      throw Error('WORKSPACE_REVEAL_PROOF_REJECTED');
    const result = await session.request({ kind: 'revealOwnedPage', proof });
    if (result.tabId !== proof.tabId || result.focused !== true)
      throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
    return { profileId: peer.profileId, tabId: proof.tabId, focused: true as const };
  }
  private async revealIdleFacebookPage(peer: Peer, proof: TabProof, guard: () => Awaitable<void>) {
    if (
      !peer.capabilities?.includes('facebook-task-kernel-v1') ||
      this.watches.busy(peer.profileId)
    )
      throw Error('WORKSPACE_REVEAL_CHANNEL_BUSY');
    const owner = randomUUID();
    await this.core.claimFixtureKernel(peer, owner);
    const session = new KernelRpcSession(peer, owner, () => {
      const sequence = (this.sequences.get(peer) ?? 0) + 1;
      this.sequences.set(peer, sequence);
      return sequence;
    });
    session.access = 'facebook-task';
    this.sessions.set(peer.profileId, session);
    this.traces.set(peer.profileId, session.trace);
    const current = async () => {
      await guard();
      if (this.sessions.get(peer.profileId) !== session || session.closing || session.failureReason)
        throw Error('WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED');
      session.lease.check();
    };
    let displayed = false;
    try {
      // Window display needs native ownership, not debugger attachment or an SDK page.
      await session.request({
        kind: 'open',
        stamp: { ...session.stamp },
        files: [],
        access: 'facebook-task',
      });
      await current();
      const inventory = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
      await current();
      if (
        inventory.profileId !== peer.profileId ||
        !inventory.workspaceMain ||
        !sameTabProof(inventory.workspaceMain, proof) ||
        !inventory.tabs.some(
          (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, proof),
        )
      )
        throw Error('WORKSPACE_REVEAL_PROOF_REJECTED');
      await session.request({ kind: 'adopt', proof });
      await current();
      const result = await session.request({ kind: 'revealOwnedPage', proof });
      await current();
      if (result.tabId !== proof.tabId || result.focused !== true)
        throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
      displayed = true;
      return { profileId: peer.profileId, tabId: proof.tabId, focused: true as const };
    } finally {
      session.closing = true;
      try {
        const stopped = await session.request({ kind: 'stop' });
        if (stopped.state !== 'stopped') throw Error('WORKSPACE_REVEAL_STOP_UNCONFIRMED');
        if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
        this.core.releaseFixtureKernel(peer, owner);
      } catch {
        if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
        if (displayed) throw Error('WORKSPACE_REVEAL_STOP_UNCONFIRMED');
      } finally {
        session.fail('WORKSPACE_REVEAL_CLOSED');
      }
    }
  }
  private readonly sessions = new Map<string, KernelRpcSession>();
  private readonly idlePages = new Map<
    string,
    {
      peer: Peer;
      connection: Awaited<ReturnType<KernelBridge['connect']>>;
      stop: { requestId: string; state: 'stopped' };
    }
  >();
  private readonly renewing = new Set<KernelRpcSession>();
  private readonly sequences = new WeakMap<Peer, number>();
  private readonly traces = new Map<string, { at: number; event: string }[]>();
  private accountObserver?: {
    shouldRefreshAvatar(profileId: string, accountId: string): Awaitable<boolean>;
    onObserved(
      profileId: string,
      account: {
        state: 'unknown' | 'logged-in' | 'logged-out' | 'restricted' | 'verification';
        id?: string | null;
        name?: string | null;
        avatar?: string | null;
      },
    ): Awaitable<void>;
  };
  setAccountObserver(observer: NonNullable<KernelBridge['accountObserver']>) {
    this.accountObserver = observer;
  }
  async observeExternalPageAccount(
    profileId: string,
    page: Page,
    actor: { accountId: string; name: string | null } | null,
  ) {
    if (!this.accountObserver) return;
    try {
      if (actor) {
        let avatar: string | null | undefined = undefined;
        if (await this.accountObserver.shouldRefreshAvatar(profileId, actor.accountId)) {
          avatar = await page
            .evaluate(() => {
              const selectors = [
                '[role="navigation"] svg image',
                '[role="banner"] svg image',
                '[aria-label*="Account" i] svg image',
                '[aria-label*="账号"] svg image',
                '[aria-label*="個人檔案"] svg image',
                'a[href*="/profile.php"] svg image',
                '[role="navigation"] img',
                '[role="banner"] img',
              ];
              for (const sel of selectors) {
                const nodes = Array.from(document.querySelectorAll(sel));
                for (const node of nodes) {
                  const src =
                    node.getAttribute('xlink:href') ||
                    node.getAttribute('href') ||
                    node.getAttribute('src') ||
                    '';
                  if (src.startsWith('https://') && /fbcdn\.net|fbsbx\.com/i.test(src)) {
                    return src;
                  }
                }
              }
              return null;
            })
            .catch(() => null);
        }
        await this.accountObserver.onObserved(profileId, {
          state: 'logged-in',
          id: actor.accountId,
          name: actor.name,
          ...(avatar ? { avatar } : {}),
        });
        return;
      }
      const abnormal = await page
        .evaluate(() => {
          const path = location.pathname.toLowerCase();
          if (/^\/checkpoint(?:\/|$)/.test(path)) return 'verification' as const;
          if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(path))
            return 'restricted' as const;
          const hasLogin = Boolean(
            document.querySelector('input[name="email"]') &&
            document.querySelector('input[name="pass"]'),
          );
          if (/^\/login(?:\.php|\/|$)/.test(path) || hasLogin) return 'logged-out' as const;
          const bodyText = (document.body?.innerText || '').slice(0, 2000);
          if (
            /account has been disabled|your account is disabled|we suspended your account|账号已被停用|账户已被停用|已停用你的账户/i.test(
              bodyText,
            )
          ) {
            return 'restricted' as const;
          }
          return null;
        })
        .catch(() => null);
      if (abnormal) {
        await this.accountObserver.onObserved(profileId, {
          state: abnormal,
          avatar: null,
        });
      }
    } catch {
      // Cache observation must never interfere with kernel execution.
    }
  }
  async observeProjectedAccount(
    profileId: string,
    page: import('../shared/page-read.js').PageProjection,
    actor: { accountId: string; name: string | null } | null,
  ) {
    if (!this.accountObserver) return;
    try {
      if (actor) {
        let avatar: string | null | undefined = undefined;
        if (await this.accountObserver.shouldRefreshAvatar(profileId, actor.accountId)) {
          const imgNodes = [
            ...(page.rows.find((r) => r.key === 'profileControlImages')?.nodes ?? []),
            ...(page.rows.find((r) => r.key === 'accountControlImages')?.nodes ?? []),
          ];
          for (const n of imgNodes) {
            if (!n.visible) continue;
            const src = n.attributes['xlink:href'] || n.attributes.href || n.attributes.src || '';
            if (src.startsWith('https://') && /fbcdn\.net|fbsbx\.com/i.test(src)) {
              avatar = src;
              break;
            }
          }
        }
        await this.accountObserver.onObserved(profileId, {
          state: 'logged-in',
          id: actor.accountId,
          name: actor.name,
          ...(avatar ? { avatar } : {}),
        });
        return;
      }
      const path = new URL(page.url).pathname.toLowerCase();
      if (/^\/checkpoint(?:\/|$)/.test(path)) {
        await this.accountObserver.onObserved(profileId, { state: 'verification', avatar: null });
      } else if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(path)) {
        await this.accountObserver.onObserved(profileId, { state: 'restricted', avatar: null });
      } else {
        const loginForms = page.rows.find((row) => row.key === 'loginForm')?.nodes ?? [];
        if (loginForms.some((n) => n.visible) || /^\/login(?:\.php|\/|$)/.test(path)) {
          await this.accountObserver.onObserved(profileId, { state: 'logged-out', avatar: null });
        }
      }
    } catch {
      // Ignore projection cache errors.
    }
  }
  diagnostics(profileId: string) {
    return [...(this.traces.get(profileId) ?? [])];
  }
  presentationStatus(profileId: string): ProfilePresentationStatus | null {
    const session = this.sessions.get(profileId);
    if (
      !session ||
      !session.presentationStatus ||
      this.core.peers.get(profileId) !== session.peer ||
      !session.peer.online
    )
      return null;
    return {
      ...session.presentationStatus,
      active: !session.closing && !session.inputRevoked && !session.parked && !session.parking,
    };
  }
  constructor(
    private readonly core: Core,
    private readonly watches: WatchTasks,
  ) {}

  async readFacebookPage(
    peer: Peer,
    input: PageProjectionRequest,
    destination: 'home' | 'self-profile' = 'home',
    assertAllowed: () => Awaitable<void> = () => {},
    withIdentity = false,
  ) {
    await assertAllowed();
    if (
      withIdentity &&
      (destination !== 'home' || !peer.capabilities?.includes('facebook-native-identity-v1'))
    )
      throw Error('FACEBOOK_NATIVE_IDENTITY_CAPABILITY_REQUIRED');
    if (destination !== 'home' && destination !== 'self-profile')
      throw Error('FACEBOOK_READ_DESTINATION_REJECTED');
    const projection = PageReadRequest.parse(input);
    if (
      projection.queries.some((query) => query.attributes.includes('xlink:href')) &&
      !peer.capabilities?.includes('facebook-readonly-v2')
    )
      throw Error('FACEBOOK_RICH_READ_CAPABILITY_REQUIRED');
    if (!peer.capabilities?.includes('facebook-readonly-v1') || this.watches.busy(peer.profileId))
      throw Error('FACEBOOK_READ_CAPABILITY_REQUIRED');
    const owner = randomUUID();
    await this.core.claimFixtureKernel(peer, owner);
    const session = new KernelRpcSession(peer, owner, () => {
      const sequence = (this.sequences.get(peer) ?? 0) + 1;
      this.sequences.set(peer, sequence);
      return sequence;
    });
    this.sessions.set(peer.profileId, session);
    this.traces.set(peer.profileId, session.trace);
    let proof: TabProof | undefined;
    let displayRemoveRequested = false;
    try {
      await session.request({
        kind: 'open',
        access: 'facebook-readonly',
        stamp: { ...session.stamp },
        files: [],
      });
      await assertAllowed();
      const ownershipId = randomUUID();
      const tab = await session.request({
        kind: 'create',
        ownershipId,
        url: destination === 'home' ? 'https://www.facebook.com/' : 'https://www.facebook.com/me/',
      });
      const inventory = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
      await assertAllowed();
      proof = OwnedTabProof.parse(
        inventory.tabs.find((row) => row.ownershipId === ownershipId && row.state === 'READY')
          ?.proof,
      );
      if (inventory.profileId !== peer.profileId || proof.tabId !== tab.tabId)
        throw Error('FACEBOOK_READ_PROOF_MISMATCH');
      const attached = KernelTargetInfo.parse(
        (await session.request({ kind: 'attach', tabId: proof.tabId })).info,
      );
      await assertAllowed();
      if (
        attached.type !== 'page' ||
        attached.targetId !== proof.targetId ||
        !kernelFacebookReadURL(attached.url)
      )
        throw Error('FACEBOOK_READ_ATTACHED_TARGET_MISMATCH');
      await session.request({
        kind: 'send',
        target: { tabId: proof.tabId },
        method: 'Page.enable',
        params: {},
      });
      const nativeIdentity = withIdentity
        ? (await session.request({ kind: 'observeFacebookIdentity', tabId: proof.tabId })).identity
        : null;
      const identityRead =
        nativeIdentity === null ? null : FacebookNativeIdentityRead.parse(nativeIdentity);
      const tabId = proof.tabId;
      const assertIdentityDocument = async () => {
        if (!identityRead) return;
        await assertAllowed();
        const frameReply = await session.request({
          kind: 'send',
          target: { tabId },
          method: 'Page.getFrameTree',
          params: {},
        });
        const frame = KernelJsonObject.parse(KernelJsonObject.parse(frameReply.frameTree).frame);
        await assertAllowed();
        if (
          frame.id !== identityRead.frameId ||
          frame.loaderId !== identityRead.loaderId ||
          frame.url !== 'https://www.facebook.com/'
        )
          throw Error('FACEBOOK_IDENTITY_DOCUMENT_CHANGED');
      };
      await assertIdentityDocument();
      const page = await sampleFacebookPage(projection, {
        assertCurrent: async () => {
          await assertAllowed();
          if (
            this.sessions.get(peer.profileId) !== session ||
            this.core.peers.get(peer.profileId) !== peer ||
            session.closing ||
            !peer.online ||
            !peer.synced ||
            peer.phase !== 'PAUSED'
          )
            throw Error('FACEBOOK_READ_CONTEXT_CHANGED');
          session.lease.check();
        },
        read: () => session.request({ kind: 'project', tabId, projection }),
        wait: () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      });
      await assertIdentityDocument();
      await assertAllowed();
      displayRemoveRequested = true;
      await session.request({ kind: 'remove', tabId: proof.tabId });
      const closedInventory = KernelPersistentState.parse(
        await session.request({ kind: 'inventory' }),
      );
      const closed = closedInventory.tabs.find((row) => row.ownershipId === ownershipId);
      if (closed?.state !== 'CLOSED' || !closed.proof || !sameTabProof(closed.proof, proof))
        throw Error('FACEBOOK_READ_TAB_CLOSE_UNCONFIRMED');
      await assertAllowed();
      session.closing = true;
      const requestId = randomUUID();
      const stop = await session.request({ kind: 'stop' }, requestId);
      if (stop.state !== 'stopped' || stop.requestId !== requestId)
        throw Error('FACEBOOK_READ_STOP_UNCONFIRMED');
      this.core.releaseFixtureKernel(peer, owner);
      if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
      session.fail('FACEBOOK_READ_CLOSED');
      return {
        profileId: peer.profileId,
        connectionEpoch: peer.epoch,
        leaseId: session.stamp.leaseId,
        proof,
        destination,
        page,
        nativeIdentity: identityRead?.actor ?? null,
        nativeIdentityTransport: identityRead?.transport ?? null,
        closed: true,
        closedRecord: closed,
        stop: { requestId, state: 'stopped' },
        inputRPCs: session.trace.filter((item) =>
          /^rpc:send:(Input\.|DOM\.setFileInputFiles)/.test(item.event),
        ).length,
        trace: [...session.trace],
      };
    } catch (error) {
      // A display read has no business input. Close only its exact journal-owned target
      // before withdrawing the lease, so a failed check does not block future tasks.
      if (
        !displayRemoveRequested &&
        proof &&
        this.core.peers.get(peer.profileId) === peer &&
        peer.online
      ) {
        const failedProof = proof;
        try {
          await session.request({ kind: 'remove', tabId: failedProof.tabId });
          const cleanup = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
          const row = cleanup.tabs.find((tab) => tab.ownershipId === failedProof.ownershipId);
          if (row?.state === 'CLOSED' && row.proof && sameTabProof(row.proof, failedProof))
            session.record('display-read-failed-page:CLOSED');
        } catch {
          session.record('display-read-failed-page:REVIEW');
        }
      }
      session.closing = true;
      // No guessing ownership or retrying a failed read. Global stop also protects a late create/attach.
      if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
      session.fail('FACEBOOK_READ_FAILED');
      throw error;
    }
  }
  async releaseReadTab(
    peer: Peer,
    input: TabProof,
    assertUnassociated: (proof: TabProof) => Awaitable<void>,
  ) {
    const proof = OwnedTabProof.parse(input);
    if (
      proof.profileId !== peer.profileId ||
      !peer.capabilities?.includes('facebook-readonly-v2') ||
      this.watches.busy(peer.profileId)
    )
      throw Error('FACEBOOK_READ_RELEASE_UNAVAILABLE');
    await assertUnassociated(proof);
    const owner = randomUUID();
    await this.core.claimFixtureKernel(peer, owner);
    const session = new KernelRpcSession(peer, owner, () => {
      const sequence = (this.sequences.get(peer) ?? 0) + 1;
      this.sequences.set(peer, sequence);
      return sequence;
    });
    this.sessions.set(peer.profileId, session);
    this.traces.set(peer.profileId, session.trace);
    const assertCurrent = () => {
      if (
        this.sessions.get(peer.profileId) !== session ||
        this.core.peers.get(peer.profileId) !== peer ||
        session.closing ||
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED'
      )
        throw Error('FACEBOOK_READ_CONTEXT_CHANGED');
      session.lease.check();
    };
    try {
      await session.request({
        kind: 'open',
        access: 'facebook-readonly',
        stamp: { ...session.stamp },
        files: [],
      });
      const evidence = await releaseFacebookReadTab(proof, {
        assertCurrent,
        assertUnassociated,
        inventory: () => session.request({ kind: 'inventory' }),
        adopt: async (owned) => {
          await session.request({ kind: 'adopt', proof: owned });
        },
        remove: async (tabId) => {
          await session.request({ kind: 'remove', tabId });
        },
      });
      assertCurrent();
      session.closing = true;
      const requestId = randomUUID();
      const stop = await session.request({ kind: 'stop' }, requestId);
      if (stop.state !== 'stopped' || stop.requestId !== requestId)
        throw Error('FACEBOOK_READ_STOP_UNCONFIRMED');
      this.core.releaseFixtureKernel(peer, owner);
      if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
      session.fail('FACEBOOK_READ_RELEASED');
      return {
        ...evidence,
        connectionEpoch: peer.epoch,
        leaseId: session.stamp.leaseId,
        stop: { requestId, state: 'stopped' },
        trace: [...session.trace],
      };
    } catch (error) {
      session.closing = true;
      if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
      session.fail('FACEBOOK_READ_RELEASE_FAILED');
      throw error;
    }
  }
  async withSummary<T>(
    peer: Peer,
    work: (port: {
      profileId: string;
      inventory(): Promise<import('../shared/kernel-state.js').KernelState>;
      stopCurrent(
        requestId: string,
        proofs?: readonly TabProof[],
        incompleteTabs?: readonly TabRecord[],
      ): Promise<import('../shared/task-ending.js').CurrentStop>;
      notify(
        binding: Binding,
        resolution: Resolution,
      ): Promise<import('../shared/settlement.js').NoticeReceipt>;
    }) => Promise<T>,
  ): Promise<T> {
    if (!peer.capabilities?.includes('kernel-journal-v1') || this.watches.busy(peer.profileId))
      throw Error('KERNEL_SUMMARY_UNAVAILABLE');
    const idle = this.idlePages.get(peer.profileId);
    if (idle) {
      if (idle.peer !== peer || !peer.online || !peer.synced || peer.phase !== 'PAUSED')
        throw Error('KERNEL_RETAINED_PAGE_CONNECTION_CHANGED');
      return work({
        profileId: peer.profileId,
        inventory: () => idle.connection.inventory(),
        notify: async (binding, resolution) => {
          if (resolution.outcome === 'ENDED_UNKNOWN') {
            await idle.connection.close();
            return this.withSummary(peer, (port) => port.notify(binding, resolution));
          }
          return idle.connection.reconcile(
            binding,
            KernelOperationRecord.shape.resolution.unwrap().parse(resolution),
          );
        },
        stopCurrent: async (requestId, proofs = [], incompleteTabs = []) => {
          if (
            this.idlePages.get(peer.profileId) !== idle ||
            this.core.peers.get(peer.profileId) !== peer ||
            !peer.online ||
            !peer.synced ||
            peer.phase !== 'PAUSED'
          )
            throw Error('KERNEL_RETAINED_PAGE_CONNECTION_CHANGED');
          // Retire only the parked SDK. Its normal closer preserves the registered main page.
          await idle.connection.close();
          if (
            this.idlePages.has(peer.profileId) ||
            this.core.peers.get(peer.profileId) !== peer ||
            !peer.online ||
            !peer.synced ||
            peer.phase !== 'PAUSED'
          )
            throw Error('KERNEL_RETAINED_PAGE_CONNECTION_CHANGED');
          return this.withSummary(peer, (port) =>
            port.stopCurrent(requestId, proofs, incompleteTabs),
          );
        },
      });
    }
    const owner = randomUUID();
    await this.core.claimFixtureKernel(peer, owner);
    const session = new KernelRpcSession(peer, owner, () => {
      const next = (this.sequences.get(peer) ?? 0) + 1;
      this.sequences.set(peer, next);
      return next;
    });
    this.sessions.set(peer.profileId, session);
    this.traces.set(peer.profileId, session.trace);
    const assertCurrent = () => {
      if (
        this.sessions.get(peer.profileId) !== session ||
        this.core.peers.get(peer.profileId) !== peer ||
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED'
      )
        throw Error('SUMMARY_SESSION_CHANGED');
      session.lease.check();
    };
    let opened = false,
      closed = false;
    try {
      await session.request({
        kind: 'open',
        stamp: { ...session.stamp },
        files: [],
        ...(peer.capabilities?.includes('kernel-unknown-end-v1') ? { summaryOnly: true } : {}),
      });
      opened = true;
      assertCurrent();
      const inventory = async () => {
        if (closed) throw Error('SUMMARY_SESSION_CLOSED');
        assertCurrent();
        const result = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
        assertCurrent();
        if (result.profileId !== peer.profileId) throw Error('SUMMARY_PROFILE_MISMATCH');
        return result;
      };
      const value = await work({
        profileId: peer.profileId,
        inventory,
        stopCurrent: async (requestId, proofs = [], incompleteTabs = []) => {
          assertCurrent();
          // Native STOP revokes this lease. Do not let its old heartbeat fence a
          // successful stop or race the remaining read-only disposition work.
          session.closing = true;
          const stop = await session.request({ kind: 'stop' }, requestId);
          assertCurrent();
          if (stop.state !== 'stopped' || stop.requestId !== requestId)
            throw Error('SUMMARY_STOP_UNCONFIRMED');
          for (const proof of proofs) {
            if (proof.profileId !== peer.profileId) throw Error('SUMMARY_TAB_PROFILE_REJECTED');
            const reply = await session.request({ kind: 'withdrawTaskTab', proof });
            assertCurrent();
            if (reply.withdrawn !== true || !sameTabProof(OwnedTabProof.parse(reply.proof), proof))
              throw Error('SUMMARY_TAB_WITHDRAW_UNCONFIRMED');
          }
          for (const record of incompleteTabs) {
            if (record.proof || !peer.capabilities?.includes('kernel-idle-tab-end-v1'))
              throw Error('SUMMARY_INCOMPLETE_TAB_UPDATE_REQUIRED');
            const reply = await session.request({ kind: 'withdrawIdleTaskTab', record });
            assertCurrent();
            const retained = OwnedTabRecord.parse(reply.record);
            if (
              reply.withdrawn !== true ||
              retained.ownershipId !== record.ownershipId ||
              retained.url !== record.url ||
              retained.proof !== null ||
              !['LOST', 'CLOSED'].includes(retained.state)
            )
              throw Error('SUMMARY_TAB_WITHDRAW_UNCONFIRMED');
          }
          return {
            profileId: peer.profileId,
            connectionEpoch: peer.epoch,
            requestId,
            state: 'stopped',
          };
        },
        notify: async (binding, resolution) => {
          if (closed || binding.profileId !== peer.profileId)
            throw Error('SUMMARY_NOTIFICATION_PROFILE_REJECTED');
          const expected = SettlementReceipt.parse({ binding, resolution });
          if (resolution.outcome === 'ENDED_UNKNOWN') {
            if (!peer.capabilities?.includes('kernel-unknown-end-v1'))
              throw Error('KERNEL_END_EXTENSION_UPDATE_REQUIRED');
            assertCurrent();
            session.closing = true;
            const reply = await session.request(
              { kind: 'endUnknownOperation', binding, disposition: resolution },
              resolution.id,
            );
            assertCurrent();
            const receipt = SettlementReceipt.parse({
              binding: reply.binding,
              resolution: reply.resolution,
            });
            const stop = KernelJsonObject.parse(reply.stop);
            const snapshot = KernelPersistentState.parse(reply.inventory);
            const remote = snapshot.operations.find(
              (op) => op.binding.operationId === binding.operationId,
            );
            if (
              reply.ended !== true ||
              stop.state !== 'stopped' ||
              stop.requestId !== resolution.id ||
              snapshot.profileId !== peer.profileId ||
              !sameNotice(expected, receipt) ||
              !remote?.disposition ||
              !sameNotice(receipt, { binding: remote.binding, resolution: remote.disposition })
            )
              throw Error('SUMMARY_END_RECEIPT_MISMATCH');
            return receipt;
          }
          const reply = await session.request({ kind: 'reconcileOperation', binding, resolution });
          const receipt = SettlementReceipt.parse({
            binding: reply.binding,
            resolution: reply.resolution,
          });
          if (reply.reconciled !== true || !sameNotice(expected, receipt))
            throw Error('SUMMARY_NOTICE_RECEIPT_MISMATCH');
          const remote = (await inventory()).operations.find(
            (op) => op.binding.operationId === binding.operationId,
          );
          if (
            remote?.state !== 'RECONCILED' ||
            !remote.resolution ||
            !sameNotice(receipt, { binding: remote.binding, resolution: remote.resolution })
          )
            throw Error('SUMMARY_NOTICE_INVENTORY_MISMATCH');
          return receipt;
        },
      });
      assertCurrent();
      closed = true;
      session.closing = true;
      const stop = await session.request({ kind: 'stop' });
      if (stop.state !== 'stopped') throw Error('SUMMARY_STOP_UNCONFIRMED');
      if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
      session.fail('SUMMARY_CLOSED');
      this.core.releaseFixtureKernel(peer, owner);
      return value;
    } catch (error) {
      closed = true;
      session.closing = true;
      if (opened) {
        try {
          const stopped = await session.request({ kind: 'stop' });
          if (stopped.state !== 'stopped') throw Error('SUMMARY_STOP_UNCONFIRMED');
          if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
          this.core.releaseFixtureKernel(peer, owner);
        } catch {
          if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
        }
      } else if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
      session.fail('SUMMARY_FAILED');
      throw error;
    }
  }
  async connect(peer: Peer, files: readonly string[] = [], existingTab?: TabProof) {
    return this.connectOwned(peer, files, existingTab);
  }
  // Internal only: the authority must be supplied by the real acting-identity observer.
  // Profile display state and /me links are not valid implementations of this callback.
  async connectFacebook(
    peer: Peer,
    accountId: string,
    assertIdentity: () => Awaitable<void>,
    retainedTab?: TabProof,
    storyAdmission = false,
  ) {
    ExecutionContext.shape.accountId.parse(accountId);
    if (!accountId.trim()) throw Error('FACEBOOK_ACTING_IDENTITY_REQUIRED');
    await assertIdentity();
    if (
      !peer.capabilities?.includes('facebook-task-kernel-v1') ||
      !peer.capabilities.includes('facebook-task-main-frame-v1') ||
      !peer.capabilities.includes('kernel-journal-v1') ||
      !peer.capabilities.includes('kernel-operation-files-v1')
    )
      throw Error('FACEBOOK_TASK_EXTENSION_UPDATE_REQUIRED');
    const prepared = await prepareFacebookWorkspace(this, peer, retainedTab, assertIdentity);
    retainedTab = prepared.proof;
    const idle = this.idlePages.get(peer.profileId);
    if (idle) {
      if (
        idle.peer !== peer ||
        !retainedTab ||
        !idle.connection.proof ||
        !sameTabProof(idle.connection.proof, retainedTab)
      )
        throw Error('FACEBOOK_WORKSPACE_REBIND_REQUIRED');
      const inventory = await idle.connection.inventory();
      await assertIdentity();
      const tab = inventory.tabs.find((row) => row.ownershipId === retainedTab.ownershipId);
      if (
        inventory.operations.some(kernelOperationPending) ||
        tab?.state !== 'READY' ||
        !tab.proof ||
        !sameTabProof(tab.proof, retainedTab)
      )
        throw Error('FACEBOOK_WORKSPACE_NATIVE_RECHECK_REQUIRED');
      await idle.connection.rebind(accountId, assertIdentity);
      this.idlePages.delete(peer.profileId);
      return idle.connection;
    }
    const inventory = prepared.inventory;
    await assertIdentity();
    if (
      inventory.operations.some(kernelOperationPending) ||
      inventory.tabs.some(
        (row) =>
          !['CLOSED', 'LOST'].includes(row.state) &&
          !(
            retainedTab &&
            row.state === 'READY' &&
            row.proof &&
            sameTabProof(row.proof, retainedTab)
          ),
      )
    )
      throw Error(
        'FACEBOOK_TASK_NATIVE_REVIEW_REQUIRED:' +
          JSON.stringify({
            pendingOperations: inventory.operations.filter(kernelOperationPending).map((row) => ({
              id: row.binding.operationId,
              state: row.state,
            })),
            activeTabs: inventory.tabs
              .filter((row) => !['CLOSED', 'LOST'].includes(row.state))
              .map((row) => ({
                ownershipId: row.ownershipId,
                state: row.state,
                retained: !!(retainedTab && row.proof && sameTabProof(row.proof, retainedTab)),
              })),
          }),
      );
    return this.connectOwned(peer, [], retainedTab, {
      accountId,
      assertIdentity,
      ...(storyAdmission && retainedTab
        ? { initialUrl: 'https://www.facebook.com/stories/create/' }
        : {}),
      preservePage: () => peer.capabilities?.includes('kernel-page-quiesce-v1') === true,
      foreground:
        peer.capabilities?.includes('kernel-create-foreground-v1') === true &&
        profileForegroundGranted(peer),
    });
  }
  private isRetainedSafeFacebookUrl(url: string): boolean {
    if (!url || !/^https:\/\/www\.facebook\.com\//.test(url)) return false;
    try {
      const p = new URL(url).pathname.toLowerCase();
      return !/^\/(?:login|recover|checkpoint|disabled|suspended|account_status|restriction|messages)(?:\.php|\/|$)/.test(
        p,
      );
    } catch {
      return false;
    }
  }
  private async navigateRetainedPageHome(
    page: Page,
    guard: () => Awaitable<void>,
  ): Promise<boolean> {
    const url = typeof page.url === 'function' ? page.url() : '';
    if (!this.isRetainedSafeFacebookUrl(url)) return false;
    await guard();
    await page
      .evaluate(() => {
        location.assign('https://www.facebook.com/');
      })
      .catch(() => {});
    const started = performance.now();
    while (performance.now() - started < 15_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      await guard();
      const state = await page
        .evaluate(() => ({ url: location.href, ready: document.readyState }))
        .catch(() => null);
      if (
        state &&
        FacebookBrowseURL.safeParse(state.url).success &&
        (state.ready === 'interactive' || state.ready === 'complete')
      ) {
        return true;
      }
    }
    return false;
  }
  private async prepareInvitationHome(page: Page, guard: () => Awaitable<void>) {
    if (page.url() === 'https://www.facebook.com/') return false;
    if (!(await this.navigateRetainedPageHome(page, guard)))
      throw new ProductError(
        'GROUP_INVITER_HOME_REQUIRED',
        '无法打开 Facebook 首页，请检查登录或验证页面',
        409,
      );
    return true;
  }
  private async waitInvitationHomeIdentity(page: Page, guard: () => Awaitable<void>) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      await guard();
      const url = page.url();
      if (
        /^https:\/\/www\.facebook\.com\/(?:login|checkpoint|recover|disabled|suspended)(?:[/.?]|$)/.test(
          url,
        )
      )
        throw new ProductError(
          'GROUP_INVITER_LOGIN_REQUIRED',
          'Facebook 尚未登录或需要完成账号验证',
          409,
        );
      try {
        const current = await readCurrentFacebookBrowseIdentity(page, guard);
        if (current.document.url === 'https://www.facebook.com/') return current;
      } catch (error) {
        await guard();
        // Skeleton pages may not have mounted their native User menu yet.
        if (
          !(error instanceof ZodError) &&
          !(
            error instanceof Error &&
            /IDENTITY_UNCONFIRMED|IDENTITY_DOCUMENT_CHANGED|NAVIGATION_READ/.test(error.message)
          )
        )
          throw error;
      }
      if (Date.now() >= deadline)
        throw new ProductError(
          'GROUP_INVITER_IDENTITY_TIMEOUT',
          '首页已打开，但未能读取当前登录账号，请检查页面是否正常加载',
          409,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  private async ensureRetainedBrowsePage(
    page: Page,
    guard: () => Awaitable<void>,
    storyAdmission = false,
  ): Promise<boolean> {
    const url = typeof page.url === 'function' ? page.url() : '';
    if (!url) return false;
    if (storyAdmission && /^https:\/\/www\.facebook\.com\/stories\/create\/?$/.test(url))
      return false;
    if (FacebookBrowseURL.safeParse(url).success) return false;
    return this.navigateRetainedPageHome(page, guard);
  }
  async inspectIdleFacebookPage(
    peer: Peer,
    guard: () => Awaitable<void>,
    storyAdmission = false,
    homeAdmission = false,
  ) {
    const idle = this.idlePages.get(peer.profileId);
    if (!idle) return null;
    await guard();
    if (
      idle.peer !== peer ||
      this.core.peers.get(peer.profileId) !== peer ||
      idle.connection.failureReason ||
      !idle.connection.proof
    )
      throw Error('FACEBOOK_WORKSPACE_CONNECTION_CHANGED');
    const proof = idle.connection.proof;
    const inventory = await idle.connection.inventory();
    await guard();
    const row = inventory.tabs.find((tab) => tab.ownershipId === proof.ownershipId);
    if (
      inventory.operations.some(kernelOperationPending) ||
      row?.state !== 'READY' ||
      !row.proof ||
      !sameTabProof(row.proof, proof)
    )
      throw Error('FACEBOOK_WORKSPACE_NATIVE_RECHECK_REQUIRED');
    const page = idle.connection.browser.contexts()[0]?.pages()[0];
    if (!page) throw Error('FACEBOOK_WORKSPACE_PAGE_REQUIRED');
    if (
      !this.usesExposedWindowLayout() &&
      peer.capabilities?.includes('kernel-owned-page-reveal-v1')
    ) {
      await this.revealOwnedFacebookPage(peer, proof).catch(() => {});
      await guard();
    }
    let current;
    try {
      const navigated = homeAdmission
        ? await this.prepareInvitationHome(page, guard)
        : await this.ensureRetainedBrowsePage(page, guard, storyAdmission);
      const readIdentity = () =>
        (storyAdmission && /^https:\/\/www\.facebook\.com\/stories\/create\/?$/.test(page.url())
          ? readCurrentFacebookStoryIdentity
          : readCurrentFacebookBrowseIdentity)(page, guard);
      try {
        current = homeAdmission
          ? await this.waitInvitationHomeIdentity(page, guard)
          : await readIdentity();
      } catch (firstError) {
        await guard();
        if (
          !homeAdmission &&
          !navigated &&
          !storyAdmission &&
          (await this.navigateRetainedPageHome(page, guard))
        ) {
          current = await readIdentity();
        } else {
          throw firstError;
        }
      }
    } catch (error) {
      await this.observeExternalPageAccount(peer.profileId, page, null);
      throw error;
    }
    await this.observeExternalPageAccount(peer.profileId, page, current.actor);
    await guard();
    const visibility = await page.evaluate(() => document.visibilityState);
    await guard();
    return {
      actor: current.actor,
      transport: 'document-preload' as const,
      connection: { profileId: peer.profileId, connectionEpoch: peer.epoch },
      proof,
      closedRecord: row,
      stop: idle.stop,
      retained: true as const,
      workspaceRetained: true as const,
      page: {
        url: current.document.url,
        ready: current.document.ready,
        timeOrigin: current.document.timeOrigin,
        visibility,
        rows: [],
      },
    };
  }
  async discardAdmissionTab(peer: Peer, proof: TabProof) {
    const guard = () => {
      if (
        this.core.peers.get(peer.profileId) !== peer ||
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED'
      )
        throw Error('FACEBOOK_ADMISSION_CLEANUP_REVOKED');
    };
    guard();
    const inventory = await this.withSummary(peer, (port) => port.inventory());
    guard();
    const record = inventory.tabs.find((row) => row.proof && sameTabProof(row.proof, proof));
    if (record?.state === 'CLOSED') return;
    if (record?.state !== 'READY' || inventory.operations.some(kernelOperationPending))
      throw Error('FACEBOOK_ADMISSION_CLEANUP_UNCONFIRMED');
    const connection = await this.connectOwned(peer, [], proof, {
      accountId: null,
      readonlyIdentity: true,
      assertIdentity: guard,
    });
    await connection.close();
  }
  // Private read of a new owned SDK page before an account exists. No execution context or
  // execute callback can be obtained; unbound native input remains rejected by the original gate.
  async inspectFacebookIdentity(
    peer: Peer,
    assertAllowed: () => Awaitable<void>,
    retainForTask = false,
    existingTab?: TabProof,
    browseAdmission = false,
    storyAdmission = false,
    homeAdmission = false,
  ) {
    const observed = await this.inspectOwnedFacebookPage(
      peer,
      assertAllowed,
      storyAdmission && existingTab
        ? 'https://www.facebook.com/stories/create/'
        : 'https://www.facebook.com/',
      async (page, reusedTab) => {
        existingTab = reusedTab;
        try {
          if (!browseAdmission) {
            const res = await readCurrentFacebookIdentity(page, assertAllowed);
            await this.observeExternalPageAccount(peer.profileId, page, res.actor);
            return res;
          }
          const navigated = homeAdmission
            ? await this.prepareInvitationHome(page, assertAllowed)
            : existingTab !== undefined
              ? await this.ensureRetainedBrowsePage(page, assertAllowed, storyAdmission)
              : false;
          const readIdentity = () =>
            (storyAdmission && /^https:\/\/www\.facebook\.com\/stories\/create\/?$/.test(page.url())
              ? readCurrentFacebookStoryIdentity
              : readCurrentFacebookBrowseIdentity)(page, assertAllowed);
          let current;
          try {
            current = homeAdmission
              ? await this.waitInvitationHomeIdentity(page, assertAllowed)
              : await readIdentity();
          } catch (firstError) {
            await assertAllowed();
            if (
              existingTab !== undefined &&
              !homeAdmission &&
              !navigated &&
              !storyAdmission &&
              (await this.navigateRetainedPageHome(page, assertAllowed))
            ) {
              current = await readIdentity();
            } else {
              throw firstError;
            }
          }
          await this.observeExternalPageAccount(peer.profileId, page, current.actor);
          const visibility = await page.evaluate(() => document.visibilityState);
          await assertAllowed();
          return {
            actor: current.actor,
            transport: 'document-preload' as const,
            creator: { ...current.document, visibility, rows: [] },
          };
        } catch (error) {
          await this.observeExternalPageAccount(peer.profileId, page, null);
          throw error;
        }
      },
      retainForTask &&
        peer.capabilities?.includes('kernel-create-foreground-v1') === true &&
        profileForegroundGranted(peer),
      retainForTask,
      existingTab,
    );
    return {
      actor: observed.reading.actor,
      transport: observed.reading.transport,
      connection: observed.connection,
      proof: observed.proof,
      closedRecord: observed.closedRecord,
      stop: observed.stop,
      page: observed.reading.creator,
      retained: retainForTask || existingTab !== undefined,
      workspaceRetained: existingTab !== undefined,
    };
  }

  private async readFacebookDisplayDocument(
    page: Page,
    guard: () => Awaitable<void>,
    currentRoute = false,
  ) {
    await guard();
    const projection = validateProjection(
      facebookDisplayInspectionProjection,
      await page.evaluate(projectPage, facebookDisplayInspectionProjection),
    );
    await guard();
    const identity = await page.evaluate(
      projectFacebookDocumentIdentity,
      currentRoute && projection.url !== 'https://www.facebook.com/post/create'
        ? ('browse' as const)
        : ('task' as const),
    );
    await guard();
    const after = await page.evaluate(() => ({
      url: location.href,
      timeOrigin: performance.timeOrigin,
      ready: document.readyState,
    }));
    await guard();
    if (
      projection.url !== after.url ||
      projection.timeOrigin !== after.timeOrigin ||
      projection.ready !== 'complete' ||
      after.ready !== 'complete' ||
      identity.url !== after.url
    )
      throw Error('FACEBOOK_DISPLAY_DOCUMENT_CHANGED');
    return { page: projection, actor: FacebookNativeActor.nullable().parse(identity.actor) };
  }
  async inspectRetainedFacebookDisplay(peer: Peer, proof: TabProof, guard: () => Awaitable<void>) {
    await guard();
    const idle = this.idlePages.get(peer.profileId);
    if (idle) {
      if (
        idle.peer !== peer ||
        idle.connection.failureReason ||
        !idle.connection.proof ||
        !sameTabProof(idle.connection.proof, proof)
      )
        throw Error('FACEBOOK_WORKSPACE_CONNECTION_CHANGED');
      const inventory = await idle.connection.inventory();
      await guard();
      if (
        inventory.operations.some(kernelOperationPending) ||
        !inventory.tabs.some(
          (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, proof),
        )
      )
        throw Error('INSPECTION_NATIVE_REVIEW_REQUIRED');
      const page = idle.connection.browser.contexts()[0]?.pages()[0];
      if (!page) throw Error('FACEBOOK_WORKSPACE_PAGE_REQUIRED');
      return this.readFacebookDisplayDocument(page, guard, true);
    }
    const observed = await this.inspectOwnedFacebookPage(
      peer,
      guard,
      'https://www.facebook.com/',
      (page) => this.readFacebookDisplayDocument(page, guard, true),
      false,
      false,
      proof,
    );
    return observed.reading;
  }
  async inspectFacebookDisplay(peer: Peer, assertAllowed: () => Awaitable<void>) {
    const observed = await this.inspectOwnedFacebookPage(
      peer,
      assertAllowed,
      'https://www.facebook.com/',
      (page) => this.readFacebookDisplayDocument(page, assertAllowed),
    );
    return observed.reading;
  }
  // Fixed feature entry research only. No execution context, page input, file access or
  // submission can be obtained; stop/close uses the existing owned-page lifecycle.
  async inspectFacebookFeatureSurface(
    peer: Peer,
    feature: 'marketplace' | 'marketplace-item' | 'story',
    assertAllowed: () => Awaitable<void>,
    itemId?: string,
  ) {
    if (feature === 'marketplace-item' && (!itemId || !/^\d{1,30}$/.test(itemId)))
      throw Error('MARKETPLACE_ITEM_READ_SCOPE');
    const url =
      feature === 'marketplace-item'
        ? 'https://www.facebook.com/marketplace/item/' + itemId + '/'
        : feature === 'marketplace'
          ? 'https://www.facebook.com/marketplace/'
          : 'https://www.facebook.com/stories/create/';
    return this.inspectOwnedFacebookPage(
      peer,
      assertAllowed,
      url,
      async (page) => {
        const structure = await page.evaluate(() => {
          const visible = (el: Element) => {
            const r = el.getBoundingClientRect(),
              s = getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              r.right > 0 &&
              r.bottom > 0 &&
              r.left < innerWidth &&
              r.top < innerHeight &&
              s.display !== 'none' &&
              s.visibility !== 'hidden'
            );
          };
          const nodes = (selector: string, max: number) =>
            Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, max);
          return {
            url: location.href,
            locale: document.documentElement.lang,
            ready: document.readyState,
            mains: nodes('main,[role="main"]', 8).length,
            dialogs: nodes('[role="dialog"]', 8).length,
            headings: nodes('h1,h2,[role="heading"]', 12).map(
              (el) => el.textContent?.slice(0, 200) ?? '',
            ),
            buttons: nodes('button,[role="button"]', 24).map((el) => ({
              text: el.textContent?.slice(0, 120) ?? '',
              label: el.getAttribute('aria-label')?.slice(0, 120) ?? '',
              disabled:
                el.getAttribute('aria-disabled') === 'true' ||
                (el instanceof HTMLButtonElement && el.disabled),
            })),
            inputs: Array.from(document.querySelectorAll('input'))
              .slice(0, 16)
              .map((el) => ({ type: el.type, accept: el.accept, multiple: el.multiple })),
            textboxes: nodes('[contenteditable="true"],textarea,[role="textbox"]', 16).length,
            itemLinks: nodes('a[href*="/marketplace/item/"]', 32).length,
          };
        });
        await assertAllowed();
        return feature !== 'story'
          ? {
              structure,
              browse: await readFacebookBrowsePage(page, assertAllowed),
              identity: await page.evaluate(projectFacebookDocumentIdentity, 'browse' as const),
            }
          : { structure, story: await readFacebookStoryPage(page, assertAllowed) };
      },
      true,
    );
  }
  // Software-only inspection of a new empty composer. This connection cannot obtain an
  // execution context or send input, upload, navigation commands or publication operations.
  async inspectFacebookPostSurface(
    peer: Peer,
    locale: FacebookUILocale,
    assertAllowed: () => Awaitable<void>,
  ) {
    return this.inspectOwnedFacebookPage(
      peer,
      assertAllowed,
      'https://www.facebook.com/post/create',
      async (page) => {
        let reading = await readFacebookPostPage(page, locale, assertAllowed);
        for (let n = 0; !reading.surface && n < 20; n++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          await assertAllowed();
          reading = await readFacebookPostPage(page, locale, assertAllowed);
        }
        if (reading.surface && reading.text !== '')
          throw Error('FACEBOOK_READONLY_EMPTY_SURFACE_NOT_EMPTY');
        const structure = await readFacebookEmptySurface(page, assertAllowed);
        if (
          structure.url !== reading.projection.url ||
          structure.timeOrigin !== reading.projection.timeOrigin
        )
          throw Error('FACEBOOK_EMPTY_SURFACE_DOCUMENT_CHANGED');
        return { ...reading, structure };
      },
    );
  }
  // Bounded research of an already submitted native video. No input context is
  // obtainable; this cannot settle a former task or consume its resource.
  async inspectFacebookVideoResult(
    peer: Peer,
    videoId: string,
    expectedText: string,
    assertAllowed: () => Awaitable<void>,
  ) {
    if (!/^\d{1,30}$/.test(videoId) || expectedText.length > 262144)
      throw Error('FACEBOOK_RESULT_READ_SCOPE');
    return this.inspectOwnedFacebookPage(
      peer,
      assertAllowed,
      'https://www.facebook.com/reel/' + videoId + '/',
      async (page) => {
        const started = performance.now();
        let reading = await page.evaluate(projectFacebookReelResult);
        // A complete document may still contain the initial React skeleton. Use
        // the same bounded result readiness as publication, without any input.
        while (
          performance.now() - started < 30000 &&
          !reading.posts.some((post) => post.videoReady && post.text === expectedText)
        ) {
          await assertAllowed();
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          await assertAllowed();
          reading = await page.evaluate(projectFacebookReelResult);
        }
        await assertAllowed();
        const structure = await page.evaluate(
          (expected) => ({
            url: location.href,
            ready: document.readyState,
            mainCount: document.querySelectorAll('main,[role="main"]').length,
            captionPresent: document.body.innerText.includes(expected),
            videoCount: document.querySelectorAll('video').length,
            groups: Array.from(
              document.querySelectorAll('main [role="group"],[role="main"] [role="group"]'),
            )
              .slice(0, 20)
              .map((group) => ({
                label: group.getAttribute('aria-label'),
                videos: group.querySelectorAll('video').length,
                headings: Array.from(group.querySelectorAll('h2 a[href],[role="heading"] a[href]'))
                  .slice(0, 4)
                  .map((link) => link.getAttribute('href')),
                captionSpans: group.querySelectorAll('span[dir="auto"]').length,
              })),
          }),
          expectedText,
        );
        await assertAllowed();
        return { reading, structure };
      },
      true,
    );
  }
  private async inspectOwnedFacebookPage<T>(
    peer: Peer,
    assertAllowed: () => Awaitable<void>,
    initialUrl: string,
    read: (page: Page, reusedTab?: TabProof) => Promise<T>,
    foreground = false,
    retainForTask = false,
    existingTab?: TabProof,
  ) {
    await assertAllowed();
    if (
      !peer.capabilities?.includes('facebook-task-kernel-v1') ||
      !peer.capabilities.includes('facebook-task-main-frame-v1')
    )
      throw Error('FACEBOOK_TASK_EXTENSION_UPDATE_REQUIRED');
    const prepared = await prepareFacebookWorkspace(this, peer, existingTab, assertAllowed);
    existingTab = prepared.proof;
    const inventory = prepared.inventory;
    await assertAllowed();
    if (
      inventory.operations.some(kernelOperationPending) ||
      inventory.tabs.some(
        (row) =>
          !['CLOSED', 'LOST'].includes(row.state) &&
          !(
            existingTab &&
            row.state === 'READY' &&
            row.proof &&
            sameTabProof(row.proof, existingTab)
          ),
      )
    )
      throw Error('FACEBOOK_IDENTITY_NATIVE_REVIEW_REQUIRED');
    let keepPage = existingTab !== undefined;
    const connection = await this.connectOwned(peer, [], existingTab, {
      accountId: null,
      assertIdentity: assertAllowed,
      readonlyIdentity: true,
      initialUrl,
      foreground,
      preservePage: () => keepPage,
    });
    let current: T;
    let stop: Awaited<ReturnType<typeof connection.close>>;
    try {
      await assertAllowed();
      const contexts = connection.browser.contexts(),
        pages = contexts[0]?.pages();
      if (contexts.length !== 1 || pages?.length !== 1 || !pages[0] || !connection.proof)
        throw Error('FACEBOOK_IDENTITY_OWNED_PAGE_REQUIRED');
      if (
        retainForTask &&
        !this.usesExposedWindowLayout() &&
        peer.capabilities?.includes('kernel-owned-page-reveal-v1')
      ) {
        await this.revealOwnedFacebookPage(peer, connection.proof).catch(() => {});
        await assertAllowed();
      }
      // A page.evaluate can wait for an SDK execution context without producing a CDP
      // request. The RPC deadline therefore cannot bound this read on its own.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        current = await Promise.race([
          read(pages[0], existingTab),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT')), 40_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await assertAllowed();
      keepPage = retainForTask || existingTab !== undefined;
    } finally {
      stop = await connection.close();
    }
    await assertAllowed();
    const proof = connection.proof,
      closedRecord = connection.closedInventory?.tabs.find(
        (row) => proof && row.proof && sameTabProof(proof, row.proof),
      );
    if (
      !proof ||
      closedRecord?.state !== (keepPage ? 'READY' : 'CLOSED') ||
      stop.state !== 'stopped'
    )
      throw Error('FACEBOOK_IDENTITY_READ_RELEASE_UNCONFIRMED');
    return {
      reading: current,
      connection: { profileId: peer.profileId, connectionEpoch: peer.epoch },
      proof,
      closedRecord,
      stop,
    };
  }
  private async connectOwned(
    peer: Peer,
    files: readonly string[],
    existingTab?: TabProof,
    facebook?: {
      accountId: string | null;
      assertIdentity: () => Awaitable<void>;
      readonlyIdentity?: boolean;
      initialUrl?: string;
      foreground?: boolean;
      preservePage?: () => boolean;
    },
  ) {
    const access: KernelAccess = facebook ? 'facebook-task' : 'fixture';
    if (
      !peer.capabilities?.includes(facebook ? 'facebook-task-kernel-v1' : 'fixture-kernel-v1') ||
      this.watches.busy(peer.profileId)
    )
      throw Error('KERNEL_CAPABILITY_OR_PROFILE_REJECTED');
    await facebook?.assertIdentity();
    const owner = randomUUID();
    await this.core.claimFixtureKernel(peer, owner);
    const session = new KernelRpcSession(peer, owner, () => {
      const sequence = (this.sequences.get(peer) ?? 0) + 1;
      this.sequences.set(peer, sequence);
      return sequence;
    });
    this.sessions.set(peer.profileId, session);
    this.traces.set(peer.profileId, session.trace);
    session.access = access;
    session.identityFence = facebook?.assertIdentity;
    session.boundInputRequired = !!facebook;
    let initialProof: TabProof | null = null;
    try {
      await session.request({
        kind: 'open',
        stamp: { ...session.stamp },
        files: [...files],
        access,
      });
      await facebook?.assertIdentity();
      const backend = session.backend();
      const persistent = peer.capabilities?.includes('kernel-journal-v1') ?? false;
      if (existingTab && (!persistent || existingTab.profileId !== peer.profileId))
        throw Error('KERNEL_TAB_ADOPTION_UNAVAILABLE');
      const ownershipId = existingTab?.ownershipId ?? randomUUID();
      const tab = existingTab
        ? (await session.request({ kind: 'adopt', proof: existingTab }),
          { tabId: existingTab.tabId })
        : await backend.create(
            facebook
              ? (facebook.initialUrl ?? 'https://www.facebook.com/')
              : 'http://127.0.0.1:18767/kernel-fixture',
            ownershipId,
            facebook?.foreground,
          );
      let proof: TabProof | null = null;
      if (persistent) {
        const inventory = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
        proof =
          inventory.tabs.find((row) => row.ownershipId === ownershipId && row.state === 'READY')
            ?.proof ?? null;
        if (!proof || proof.tabId !== tab.tabId) throw Error('KERNEL_TAB_PERSISTENCE_UNCONFIRMED');
        session.presentationProof = proof;
        if (!existingTab) initialProof = proof;
      }
      await facebook?.assertIdentity();
      const executor = new KernelExecutor(
        session.lease,
        backend,
        [tab.tabId],
        new Set(files),
        access,
      );
      executor.grant(session.stamp);
      session.executor = executor;
      const attachStarted = Date.now();
      for (;;) {
        try {
          await executor.attach(tab.tabId);
          break;
        } catch (error) {
          if (
            !facebook ||
            !(error instanceof Error && error.message === 'KERNEL_INITIAL_DOCUMENT_PENDING') ||
            Date.now() - attachStarted > 15_000
          )
            throw error;
          await facebook.assertIdentity();
          session.lease.check();
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
      }
      if (facebook && proof)
        await this.arrangeWindow?.(peer.profileId, () => {
          session.lease.check();
          if (
            this.sessions.get(peer.profileId) !== session ||
            session.closing ||
            session.inputRevoked
          )
            throw Error('WINDOW_LAYOUT_REVOKED');
        });
      if (facebook && proof && peer.capabilities?.includes('task-presentation-recovery-v1'))
        await session.request({ kind: 'armTaskPresentation', proof });
      if (facebook)
        await awaitFacebookTaskDocument(
          executor,
          tab.tabId,
          async () => {
            await facebook.assertIdentity();
            session.lease.check();
            if (
              this.sessions.get(peer.profileId) !== session ||
              this.core.peers.get(peer.profileId) !== peer ||
              !peer.online ||
              !peer.synced ||
              peer.phase !== 'PAUSED' ||
              session.closing
            )
              throw Error('FACEBOOK_TASK_DOCUMENT_CONTEXT_CHANGED');
          },
          {
            expectedUrl: facebook.initialUrl,
            retainedPage: existingTab !== undefined,
            observe: async (document) => {
              session.record('initial-document:' + document.scope + ':' + document.ready);
              if (document.scope === 'other' && document.url && this.accountObserver) {
                try {
                  const p = new URL(document.url).pathname.toLowerCase();
                  if (/^\/checkpoint(?:\/|$)/.test(p)) {
                    await this.accountObserver.onObserved(peer.profileId, {
                      state: 'verification',
                      avatar: null,
                    });
                  } else if (
                    /^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(p)
                  ) {
                    await this.accountObserver.onObserved(peer.profileId, {
                      state: 'restricted',
                      avatar: null,
                    });
                  } else if (/^\/(?:login|recover)(?:\.php|\/|$)/.test(p)) {
                    await this.accountObserver.onObserved(peer.profileId, {
                      state: 'logged-out',
                      avatar: null,
                    });
                  }
                } catch {
                  // Ignore URL parse errors.
                }
              }
            },
          },
        );
      const baselineReply = await executor.send({ tabId: tab.tabId }, 'Runtime.evaluate', {
        expression: facebook
          ? 'JSON.stringify({webdriver:navigator.webdriver,userAgent:navigator.userAgent,language:navigator.language,languages:navigator.languages,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,visibility:document.visibilityState,focused:document.hasFocus(),rafFired:true})'
          : '(async()=>{let rafFired=false;const raf=requestAnimationFrame(()=>{rafFired=true});await new Promise(resolve=>setTimeout(resolve,1500));cancelAnimationFrame(raf);return JSON.stringify({webdriver:navigator.webdriver,userAgent:navigator.userAgent,language:navigator.language,languages:navigator.languages,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,visibility:document.visibilityState,focused:document.hasFocus(),rafFired})})()',
        returnByValue: true,
        awaitPromise: !facebook,
      });
      const baselineResult = KernelJsonObject.parse(baselineReply.result);
      if (typeof baselineResult.value !== 'string') throw Error('KERNEL_BASELINE_INVALID');
      const baseline = KernelJsonObject.parse(JSON.parse(baselineResult.value) as unknown);
      if (typeof baseline.userAgent !== 'string') throw Error('KERNEL_BASELINE_UA_INVALID');
      const major = baseline.userAgent.match(/(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/)?.[1];
      // Only activate our task tab; do not enable focus emulation or change browser launch flags.
      if (!facebook) await executor.send({ tabId: tab.tabId }, 'Page.bringToFront', {});
      const model = new KernelRelayModel(
        executor,
        [tab.tabId],
        {
          product: major ? 'Chrome/' + major : 'Chrome/Extension-Bridge',
          userAgent: baseline.userAgent,
        },
        (event) => session.record(event),
        access,
      );
      session.model = model;
      const endpoint = await openKernelRelayEndpoint(model);
      session.endpoint = endpoint;
      const browser = await connectFixtureKernel(endpoint.endpoint, endpoint.headers);
      await facebook?.assertIdentity();
      let closingId: string | undefined;
      let closedInventory: ReturnType<typeof KernelPersistentState.parse> | null = null;
      let closedPageState: 'READY' | 'CLOSED' | null = null;
      const closer = new SessionCloser({
        closeLocal: async () => {
          session.closing = true;
          executor.revokeFiles();
          if (facebook) {
            const before = KernelPersistentState.parse(
              await session.request({ kind: 'inventory' }),
            );
            const original = before.tabs.find((row) => row.ownershipId === ownershipId);
            if (
              !proof ||
              !original?.proof ||
              !sameTabProof(original.proof, proof) ||
              !['READY', 'CLOSED'].includes(original.state)
            )
              throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
            // Input is synchronously fenced by session.closing. Keep the event channel alive
            // until exact page removal: a filled draft can raise beforeunload during close.
            // The native owner handles only that pending owned-page close, never general dialogs.
            if (
              this.sessions.get(peer.profileId) !== session ||
              this.core.peers.get(peer.profileId) !== peer
            )
              throw Error('KERNEL_STOP_TRANSPORT_CHANGED');
            const preservePage = original.state === 'READY' && facebook.preservePage?.() === true;
            if (original.state !== 'CLOSED' && !preservePage)
              await session.request({ kind: 'remove', tabId: tab.tabId });
            const inventory = KernelPersistentState.parse(
              await session.request({ kind: 'inventory' }),
            );
            const closed = inventory.tabs.find((row) => row.ownershipId === ownershipId);
            if (
              !proof ||
              closed?.state !== (preservePage ? 'READY' : 'CLOSED') ||
              !closed.proof ||
              !sameTabProof(closed.proof, proof)
            )
              throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
            closedInventory = inventory;
            closedPageState = preservePage ? 'READY' : 'CLOSED';
          }
          const local = await endpoint.close();
          await browser.close();
          if (local.state !== 'stopped') throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
        },
        retryCloseLocal: async () => {
          // Never repeat removal. The first attempt must have observed this exact closed
          // or retained main before retrying the same local/remote cancellation.
          if (facebook) {
            const closed = closedInventory?.tabs.find((row) => row.ownershipId === ownershipId);
            if (
              !proof ||
              !closedPageState ||
              closed?.state !== closedPageState ||
              !closed.proof ||
              !sameTabProof(closed.proof, proof)
            )
              throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
            const current = KernelPersistentState.parse(
              await session.request({ kind: 'inventory' }),
            );
            const original = current.tabs.find((row) => row.ownershipId === ownershipId);
            if (
              !original ||
              (original.state !== closedPageState && original.state !== 'CLOSED') ||
              !original.proof ||
              !sameTabProof(original.proof, proof)
            )
              throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
            closedInventory = current;
            if (original.state === 'CLOSED') closedPageState = 'CLOSED';
          }
          const local = await endpoint.retryClose();
          await browser.close();
          if (local.state !== 'stopped') throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
        },
        assertTransport: () => {
          if (
            this.sessions.get(peer.profileId) !== session ||
            this.core.peers.get(peer.profileId) !== peer ||
            !peer.online ||
            !peer.synced ||
            peer.phase !== 'PAUSED'
          )
            throw Error('KERNEL_STOP_TRANSPORT_CHANGED');
        },
        stopRemote: async (requestId) => {
          const remote = await session.request({ kind: 'stop' }, requestId);
          if (remote.requestId !== requestId || remote.state !== 'stopped')
            throw Error('KERNEL_STOP_UNCONFIRMED');
          return { requestId, state: 'stopped' };
        },
        release: () => {
          this.core.releaseFixtureKernel(peer, owner);
          if (this.sessions.get(peer.profileId) === session) {
            this.sessions.delete(peer.profileId);
            this.idlePages.delete(peer.profileId);
          }
          session.fail('KERNEL_CLOSED');
        },
      });
      const close = (requestId: string = closingId ?? randomUUID()) => {
        if (closingId && closingId !== requestId)
          return Promise.reject(Error('KERNEL_CONTROL_ID_CONFLICT'));
        closingId = requestId;
        return closer.close(requestId);
      };
      const context = async (accountId: string): Promise<ExecutionSession | null> => {
        if (facebook?.readonlyIdentity) return null;
        if (facebook && accountId !== facebook.accountId) return null;
        if (
          session.closing ||
          session.inputRevoked ||
          session.parked ||
          session.parking ||
          this.core.peers.get(peer.profileId) !== peer ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED'
        )
          return null;
        try {
          session.lease.check();
          await facebook?.assertIdentity();
        } catch {
          return null;
        }
        if (
          session.closing ||
          session.inputRevoked ||
          session.parked ||
          session.parking ||
          this.core.peers.get(peer.profileId) !== peer ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED'
        )
          return null;
        session.lease.check();
        return {
          profileId: peer.profileId,
          accountId,
          connectionEpoch: peer.epoch,
          leaseId: session.stamp.leaseId,
          generation: session.stamp.generation,
        };
      };
      const execute = async <T>(
        input: Binding,
        work: () => Promise<T>,
        inputFence?: () => Awaitable<void>,
        failureStop?: (reason: string) => Promise<void>,
        resourceGuard?: NativeInputGuard,
      ) => {
        if (facebook?.readonlyIdentity) throw Error('FACEBOOK_IDENTITY_READONLY_INPUT_REJECTED');
        const binding = DispatchBinding.parse(input);
        const current = await context(binding.accountId);
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
        try {
          const begin = await session.request({ kind: 'beginOperation', binding });
          const record = KernelOperationRecord.parse(begin.record);
          if (begin.fresh !== true) throw Error('KERNEL_OPERATION_ALREADY_RECORDED');
          if (!sameBinding(record.binding, binding) || record.state !== 'DISPATCHING')
            throw Error('KERNEL_OPERATION_BEGIN_REJECTED');
          await inputFence?.();
          const value = await work();
          await inputFence?.();
          const result = await finishKernelOperation(
            () => session.request({ kind: 'finishOperation', binding }),
            async () => {
              await inputFence?.();
              const latest = await context(binding.accountId);
              if (
                !latest ||
                !sameExecution(latest, binding) ||
                !session.activeBinding ||
                !sameBinding(session.activeBinding, binding)
              )
                throw Error('KERNEL_BOUND_EXECUTION_UNAVAILABLE');
            },
          );
          const returned = DispatchBinding.parse(result.binding);
          const latest = await context(binding.accountId);
          if (
            result.acknowledged !== true ||
            !sameBinding(returned, binding) ||
            !latest ||
            !sameExecution(latest, binding)
          )
            throw Error('KERNEL_OPERATION_ACK_REJECTED');
          return { value, binding: returned };
        } catch (error) {
          // Keep the SDK actionability log for the private owner before the short control
          // reason is persisted. A timeout can occur before any input was dispatched.
          session.executionFailure = {
            binding: structuredClone(binding),
            message:
              error instanceof Error ? error.message.slice(0, 8192) : 'KERNEL_EXECUTION_FAILED',
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
                methods: [...session.methodCounts].filter(([method]) =>
                  kernelRequiresOperation(method, 'facebook-task'),
                ),
                recent: session.trace.slice(-20),
              }),
            );
          }
          const reason =
            error instanceof Error ? error.message.slice(0, 200) : 'KERNEL_EXECUTION_FAILED';
          session.record('execution-error:' + reason.split('\n')[0]);
          if (failureStop) {
            // The lifecycle owner persists and chooses the actual plan control ID before close.
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
          } else
            await close().catch(async () => {
              if (this.core.peers.get(peer.profileId) === peer)
                await this.core.stop(peer.profileId);
            });
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
          return closedInventory ? structuredClone(closedInventory) : null;
        },
        context,
        execute,
        navigateBoundPage: async (binding: Binding, input: Action, previousUrl: string) => {
          const action = Action.parse(input);
          const guard = async () => {
            const current = await context(binding.accountId);
            if (
              access !== 'facebook-task' ||
              facebook?.readonlyIdentity ||
              action.kind !== 'browseNavigate' ||
              !proof ||
              action.tabId !== proof.tabId ||
              !session.boundOperationActive ||
              !session.activeBinding ||
              !sameBinding(binding, session.activeBinding) ||
              !current ||
              !sameExecution(current, binding) ||
              createHash('sha256').update(canonicalAction(action)).digest('hex') !==
                binding.actionDigest
            )
              throw Error('FACEBOOK_NAVIGATION_ORIGINAL_OPERATION_REQUIRED');
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
          lifecycle?: (value: import('../shared/task-child-page.js').ChildPageLifecycle) => void,
        ) => {
          const binding = DispatchBinding.parse(input);
          const check = async () => {
            await guard();
            const current = await context(binding.accountId);
            if (
              access !== 'facebook-task' ||
              !proof ||
              !current ||
              !sameExecution(current, binding) ||
              session.boundOperationActive ||
              this.sessions.get(peer.profileId) !== session
            )
              throw Error('NATIVE_RESULT_ORIGINAL_CONTEXT_REQUIRED');
          };
          await check();
          if (session.resultReading) throw Error('NATIVE_RESULT_READ_IN_PROGRESS');
          session.resultReading = true;
          try {
            if (!proof) throw Error('NATIVE_RESULT_ORIGINAL_CONTEXT_REQUIRED');
            let lastObservation = '';
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
                  const { elapsedMilliseconds, ...state } = value;
                  const signature = JSON.stringify(state);
                  if (signature !== lastObservation) {
                    lastObservation = signature;
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
          const binding = DispatchBinding.parse(input);
          const check = async () => {
            await guard();
            const current = await context(binding.accountId);
            if (
              access !== 'facebook-task' ||
              !proof ||
              !current ||
              !sameExecution(current, binding) ||
              !session.boundOperationActive ||
              !session.activeBinding ||
              !sameBinding(session.activeBinding, binding)
            )
              throw Error('ORIGINAL_NETWORK_OBSERVATION_REQUIRED');
          };
          await check();
          // Native Chrome bounds response retention, including chunked/compressed HTTP2/3.
          // No cache disabling, interception, cookies, headers or browser-wide session changes.
          await backend.send({ tabId: proof?.tabId ?? -1 }, 'Network.enable', {
            maxTotalBufferSize: 2097152,
            maxResourceBufferSize: 524288,
            maxPostDataSize: 524288,
          });
          await check();
        },
        grantOperationFiles: async (input: OperationFileGrant) => {
          if (!peer.capabilities?.includes('kernel-operation-files-v1'))
            throw Error('KERNEL_OPERATION_FILES_CAPABILITY_REQUIRED');
          const grant = KernelOperationFileGrant.parse(input),
            guard = session.resourceGuard;
          if (
            grant.manifest.sourcePaths &&
            !peer.capabilities.includes('kernel-direct-operation-files-v1')
          )
            throw Error('原路径上传需要刷新桥接扩展');
          if (
            grant.manifest.version === 2 &&
            !peer.capabilities?.includes('kernel-derived-operation-files-v1')
          )
            throw Error('KERNEL_DERIVED_FILES_EXTENSION_UPDATE_REQUIRED');
          const assertCurrent = async () => {
            if (
              session.closing ||
              !session.boundOperationActive ||
              !session.activeBinding ||
              !sameBinding(session.activeBinding, grant.binding) ||
              session.resourceGuard !== guard ||
              !guard ||
              !proof ||
              !sameTabProof(proof, grant.proof)
            )
              throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
            const current = await context(grant.binding.accountId);
            if (!current || !sameExecution(current, grant.binding))
              throw Error('KERNEL_FILE_GRANT_OPERATION_REJECTED');
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
        reconcile: async (
          binding: Binding,
          resolution: NonNullable<KernelRecord['resolution']>,
        ) => {
          const result = await session.request({ kind: 'reconcileOperation', binding, resolution });
          const receipt = SettlementReceipt.parse({
            binding: result.binding,
            resolution: result.resolution,
          });
          if (result.reconciled !== true || !sameNotice(receipt, { binding, resolution }))
            throw Error('KERNEL_RECONCILIATION_RECEIPT_REJECTED');
          const inventory = KernelPersistentState.parse(
            await session.request({ kind: 'inventory' }),
          );
          const remote = inventory.operations.find(
            (op) => op.binding.operationId === binding.operationId,
          );
          if (
            inventory.profileId !== peer.profileId ||
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
              this.sessions.get(peer.profileId) !== session ||
              this.core.peers.get(peer.profileId) !== peer
            )
              throw Error('KERNEL_TASK_TAB_CONTEXT_CHANGED');
          };
          check();
          await session.request({ kind: 'scope', tabId: expected.tabId });
          check();
        },
        inventory: async () =>
          KernelPersistentState.parse(await session.request({ kind: 'inventory' })),
        baseline,
        get methods() {
          return [...session.methods];
        },
        get inputCalls() {
          return [...session.methodCounts]
            .filter(([method]) => method.startsWith('Input.'))
            .reduce((sum, [, count]) => sum + count, 0);
        },
        get nativeMutationCalls() {
          return Object.fromEntries(
            [...session.methodCounts].filter(([method]) =>
              kernelRequiresOperation(method, session.access),
            ),
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
            await this.arrangeWindow?.(peer.profileId, () => {
              session.lease.check();
              if (
                this.sessions.get(peer.profileId) !== session ||
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
          const { profileId, connectionEpoch, leaseId, generation } = session.stamp;
          const original = ExecutionContext.parse({
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
            while (this.renewing.has(session)) {
              if (
                Date.now() >= deadline ||
                this.core.peers.get(peer.profileId) !== peer ||
                !peer.online
              )
                throw Error('FACEBOOK_WORKSPACE_RENEW_DRAIN_UNCONFIRMED');
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            const before = KernelPersistentState.parse(
              await session.request({ kind: 'inventory' }),
            );
            if (before.operations.some(kernelOperationPending))
              throw Error('FACEBOOK_WORKSPACE_RECONCILIATION_PENDING');
            const result = await session.request(
              { kind: 'quiesce', context: original, proof },
              requestId,
            );
            if (
              result.state !== 'stopped' ||
              result.pageRetained !== true ||
              result.requestId !== requestId ||
              result.generation !== session.stamp.generation + 1
            )
              throw Error('FACEBOOK_WORKSPACE_PARK_UNCONFIRMED');
            const local = await executor.stop(requestId, 12_000, true);
            if (local.state !== 'stopped' || executor.lease.generation !== result.generation)
              throw Error('FACEBOOK_WORKSPACE_LOCAL_PARK_UNCONFIRMED');
            session.stamp.generation = result.generation;
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
        retryClose: (requestId: string) => closer.retry(requestId),
      };
      retainConnection = (stop) => this.idlePages.set(peer.profileId, { peer, connection, stop });
      return connection;
    } catch (error) {
      const originalFailure = session.failureReason;
      session.record(
        'connect-error:' + (error instanceof Error ? error.message.slice(0, 180) : 'unknown'),
      );
      let released = false;
      // Only a new, still-current pre-input page can be cleaned here. Existing task targets,
      // unknown RPC outcomes or any native operation remain under their original review.
      if (
        facebook &&
        initialProof &&
        !existingTab &&
        error instanceof Error &&
        !error.message.includes('_UNKNOWN') &&
        !session.hasRequestedMutation
      ) {
        try {
          const check = () => {
            session.lease.check();
            if (
              this.sessions.get(peer.profileId) !== session ||
              this.core.peers.get(peer.profileId) !== peer ||
              !peer.online ||
              !peer.synced ||
              peer.phase !== 'PAUSED' ||
              session.closing
            )
              throw Error('FACEBOOK_OPEN_CLEANUP_CONTEXT_CHANGED');
          };
          check();
          const inventory = KernelPersistentState.parse(
            await session.request({ kind: 'inventory' }),
          );
          check();
          const original = inventory.tabs.find(
            (row) => row.proof && initialProof && sameTabProof(row.proof, initialProof),
          );
          if (
            inventory.profileId !== peer.profileId ||
            original?.state !== 'READY' ||
            inventory.operations.some(kernelOperationPending)
          )
            throw Error('FACEBOOK_OPEN_CLEANUP_REVIEW_REQUIRED');
          await session.request({ kind: 'remove', tabId: initialProof.tabId });
          check();
          const closed = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
          check();
          if (
            !closed.tabs.some(
              (row) =>
                row.state === 'CLOSED' &&
                row.proof &&
                initialProof &&
                sameTabProof(row.proof, initialProof),
            )
          )
            throw Error('FACEBOOK_OPEN_CLEANUP_CLOSE_UNCONFIRMED');
          const requestId = randomUUID(),
            stop = await session.request({ kind: 'stop' }, requestId);
          if (stop.state !== 'stopped' || stop.requestId !== requestId)
            throw Error('FACEBOOK_OPEN_CLEANUP_STOP_UNCONFIRMED');
          this.core.releaseFixtureKernel(peer, owner);
          if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
          session.record('open-failed-page:CLOSED');
          released = true;
        } catch {
          session.record('open-failed-page:REVIEW');
        }
      }
      session.closing = true;
      session.fail('KERNEL_OPEN_FAILED');
      await session.endpoint?.close().catch(() => {});
      if (!released && this.core.peers.get(peer.profileId) === peer)
        await this.core.stop(peer.profileId);
      throw originalFailure ? Error(originalFailure) : error;
    }
  }
  disconnectFixture(peer: Peer): void {
    const session = this.sessions.get(peer.profileId);
    if (
      !session ||
      session.peer !== peer ||
      !peer.online ||
      this.core.peers.get(peer.profileId) !== peer
    )
      throw Error('KERNEL_SESSION_NOT_CURRENT');
    session.record('diagnostic-real-transport-close');
    peer.close();
  }
  async message(peer: Peer, value: unknown): Promise<boolean> {
    const recovery = PresentationRecoveryRequest.safeParse(value);
    if (recovery.success) {
      const request = recovery.data;
      const session = this.sessions.get(peer.profileId);
      const now = Date.now();
      let valid = false;
      try {
        valid =
          this.core.peers.get(peer.profileId) === peer &&
          peer.online &&
          peer.synced &&
          peer.phase === 'PAUSED' &&
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
            this.sessions.get(peer.profileId) !== session ||
            this.core.peers.get(peer.profileId) !== peer ||
            !peer.online ||
            !peer.synced ||
            !this.usesExposedWindowLayout() ||
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
            this.recoverWindow &&
            this.positionRecoveryGate.request(peer.profileId, performance.now())
          ) {
            await this.recoverWindow(peer.profileId, check, deadline);
            check();
            granted = true;
          }
        } catch (error) {
          if (
            session &&
            this.sessions.get(peer.profileId) === session &&
            !session.closing &&
            !session.inputRevoked &&
            !session.parked &&
            !session.parking &&
            error instanceof Error &&
            error.message.startsWith('WINDOW_LAYOUT_') &&
            ![
              'WINDOW_LAYOUT_RECOVERY_REVOKED',
              'WINDOW_LAYOUT_RECOVERY_VISIBILITY_CHANGED',
            ].includes(error.message)
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
          !this.usesExposedWindowLayout() &&
          this.presentationFocusGate.request(peer.profileId, performance.now());
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
    const header = KernelJsonObject.safeParse(value);
    if (!header.success || !['KERNEL_REPLY', 'KERNEL_EVENT'].includes(String(header.data.type)))
      return false;
    const session = this.sessions.get(peer.profileId);
    // Late replies from a closed fixture session cannot affect any new session.
    if (!session) return true;
    if (session.peer !== peer) throw Error('KERNEL_SESSION_NOT_CURRENT');
    if (header.data.type === 'KERNEL_REPLY') session.response(value);
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
          this.windowVisible?.(peer.profileId, state.visibilityAt);
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
        this.idlePages.delete(peer.profileId);
        session.record('event:Inspector.detached');
        session.closing = true;
        session.fail('KERNEL_DEBUGGER_DETACHED');
        void session.endpoint?.close().catch(() => {});
        if (this.core.peers.get(peer.profileId) === peer) await this.core.stop(peer.profileId);
      } else session.model?.debuggerEvent(event.source, event.method, event.params);
    }
    return true;
  }
  disconnected(peer: Peer): void {
    const session = this.sessions.get(peer.profileId);
    if (!session || session.peer !== peer) return;
    this.presentationFocusGate.cancel(peer.profileId);
    this.positionRecoveryGate.cancel(peer.profileId);
    this.idlePages.delete(peer.profileId);
    session.closing = true;
    session.record(
      'peer-disconnected' + (peer.transportFailure ? ':' + peer.transportFailure : ''),
    );
    session.fail(
      'KERNEL_CONNECTION_LOST' + (peer.transportFailure ? ':' + peer.transportFailure : ''),
    );
    void session.endpoint?.close().catch(() => {});
    if (this.sessions.get(peer.profileId) === session) this.sessions.delete(peer.profileId);
  }
  controlStopped(peer: Peer): void {
    const session = this.sessions.get(peer.profileId);
    if (!session || session.peer !== peer) return;
    this.disconnected(peer);
    // The parent bridge has matched the actual global STOPPED request; fixtures cannot resume.
    this.core.releaseFixtureKernel(peer, session.owner);
  }
  tick(): void {
    for (const session of this.sessions.values()) {
      if (!session.opened || session.closing || session.parking || this.renewing.has(session))
        continue;
      this.renewing.add(session);
      void session
        .renew()
        .catch(async (error: unknown) => {
          if (
            session.closing ||
            this.sessions.get(session.peer.profileId) !== session ||
            this.core.peers.get(session.peer.profileId) !== session.peer
          ) {
            session.record('renew-owner-expired');
            return;
          }
          session.record(
            'renew-failed:' + (error instanceof Error ? error.message.slice(0, 160) : 'unknown'),
          );
          session.closing = true;
          this.idlePages.delete(session.peer.profileId);
          session.fail(
            'KERNEL_LEASE_RENEW_FAILED:' +
              (error instanceof Error ? error.message.slice(0, 160) : 'unknown'),
          );
          void session.endpoint?.close().catch(() => {});
          if (session.peer.online) await this.core.stop(session.peer.profileId);
        })
        .finally(() => this.renewing.delete(session));
    }
  }
  revokeInputs(reason: string): void {
    this.idlePages.clear();
    for (const session of this.sessions.values()) {
      session.inputRevoked = true;
      session.closing = true;
      session.executor?.revokeFiles();
      session.fail(reason);
    }
  }
  async close(): Promise<void> {
    this.idlePages.clear();
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        session.closing = true;
        await session.endpoint?.close().catch(() => {});
        session.fail('KERNEL_SERVICE_SHUTDOWN');
      }),
    );
  }
}
