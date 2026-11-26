import { devDiag } from '../shared/dev-diagnostics.js';
import { randomUUID } from 'node:crypto';
import {
  BridgeError,
  VERSION,
  isWrite,
  type Intent,
  type Reply,
  type Command,
  type Action,
  type JournalEntry,
  type WindowBounds,
  type WindowDisplayBounds,
} from './protocol.js';
import type { BridgeStorePort as Store } from '../infrastructure/persistence-port.js';
type PendingWinReq<TResult = { error?: string }> = {
  kind: string;
  peer: Peer;
  finish: (result: TResult) => void;
};
type Insets = { left: number; top: number; right: number; bottom: number };
type WinBase = { error?: string };
type InspectWindowResult = WinBase & {
  windowId?: number;
  tabId?: number;
  focused?: boolean;
  lastFocusedAt?: number;
  state?: string;
  bounds?: WindowBounds;
  contentInsets?: Insets;
  displays?: WindowDisplayBounds[];
};
const DEFAULT_INSETS: Insets = { left: 16, top: 104, right: 16, bottom: 16 };
export type Phase = 'PAUSED' | 'RUNNING' | 'OFFLINE';
export type Peer = {
  profileId: string;
  epoch: string;
  send: (msg: unknown) => void;
  close: () => void;
  online: boolean;
  browserWindowCount?: number;
  profileWindowFocused?: boolean;
  focusedWindowAt?: number;
  paused: boolean;
  phase: Phase;
  synced: boolean;
  controlId?: string;
  lastStopRequestId?: string;
  lastStoppedRequestId?: string;
  error?: string;
  transportFailure?: string;
  extensionVersion?: string;
  capabilities?: string[];
};
export type KernelProfileIdleInspection = {
  idle: boolean;
  reason:
    | 'IDLE'
    | 'PEER_OFFLINE'
    | 'NOT_SYNCED'
    | 'PHASE_STOPPING'
    | 'PHASE_STARTING'
    | 'PHASE_RUNNING'
    | 'RECOVERING_CONTROL_OR_SYNC'
    | 'UNRESOLVED_LEGACY_FIXTURE'
    | 'UNRESOLVED_BRIDGE_COMMANDS'
    | 'KERNEL_OWNED'
    | 'QUEUED_INTENTS';
  unresolvedCount: number;
  legacyFixtureCount: number;
};
const ACTION_CAPS: Partial<Record<Action['kind'], string>> = {
  readTabState: 'local-window-status-v1',
  readFacebookDisplay: 'facebook-existing-display-v1',
  activateTab: 'task-activation',
};
export class Core {
  peers = new Map<string, Peer>();
  private readonly winReqs = new Map<string, PendingWinReq<never>>();
  private readonly kernelOwners = new Map<string, string>();
  private readonly kernelStopRequests = new Map<string, string>();
  private readonly queuedIntents = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private pending = new Map<
    string,
    { peer: Peer; resolve: () => void; timer: NodeJS.Timeout; action: Action }
  >();
  private controls = new Map<string, NodeJS.Timeout>();
  readonly stoppingControllers = new Map<string, NodeJS.Timeout>();
  constructor(
    readonly store: Store,
    private timeoutMs = 12000,
  ) {}
  private winRpc<TResult extends { error?: string }, TOutput>(
    profileId: string,
    kind: string,
    type: string,
    timeoutMs: number,
    timeoutError: string,
    extra: Record<string, unknown>,
    mapResult: (result: TResult) => TOutput,
    opts?: { offlineError?: string; requiredCap?: string; capError?: string },
  ): Promise<TOutput> {
    const peer = this.peers.get(profileId);
    if (!peer?.online) return Promise.reject(Error(opts?.offlineError ?? 'BROWSER_OFFLINE'));
    if (opts?.requiredCap && !peer.capabilities?.includes(opts.requiredCap))
      return Promise.reject(Error(opts.capError ?? 'CAPABILITY_REQUIRED'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (result: TResult) => {
        clearTimeout(timer);
        this.winReqs.delete(requestId);
        try {
          resolve(mapResult(result));
        } catch (err) {
          reject(err);
        }
      };
      const timer = setTimeout(() => finish({ error: timeoutError } as TResult), timeoutMs);
      this.winReqs.set(requestId, { kind, peer, finish } as PendingWinReq<never>);
      try {
        peer.send({ type, requestId, connectionEpoch: peer.epoch, ...extra });
      } catch (err) {
        finish({ error: err instanceof Error ? err.message : String(err) } as TResult);
      }
    });
  }
  private winDone<TResult extends { error?: string }>(
    kind: string,
    peer: Peer,
    requestId: string,
    requireOnline: boolean,
    result: TResult,
    onSuccess?: (peer: Peer, result: TResult) => void,
  ): void {
    const p = this.winReqs.get(requestId) as PendingWinReq<TResult> | undefined;
    if (
      p?.kind !== kind ||
      p.peer !== peer ||
      this.peers.get(peer.profileId) !== peer ||
      (requireOnline && !peer.online)
    )
      return;
    if (!result.error) onSuccess?.(peer, result);
    p.finish(result);
  }
  private markFocused(peer: Peer, focused: boolean | undefined, at = Date.now()) {
    if (focused === true) {
      peer.profileWindowFocused = true;
      peer.focusedWindowAt = Math.max(peer.focusedWindowAt ?? 0, at);
    }
  }
  private mapWinGeo(profileId: string, r: InspectWindowResult, fallbackErr: string) {
    if (r.error || r.windowId === undefined || !r.bounds) throw Error(r.error ?? fallbackErr);
    return {
      profileId,
      windowId: r.windowId,
      tabId: r.tabId ?? 1,
      focused: Boolean(r.focused),
      state: r.state ?? 'normal',
      bounds: r.bounds,
      contentInsets: r.contentInsets ?? DEFAULT_INSETS,
    };
  }
  revealBrowserWindow = (profileId: string) =>
    this.winRpc(
      profileId,
      'reveal',
      'REVEAL_BROWSER_WINDOW',
      5000,
      'WORKSPACE_REVEAL_TIMEOUT',
      {},
      (r: WinBase & { tabId?: number; focused?: boolean }) => {
        if (r.error || !r.tabId || r.focused !== true)
          throw Error(r.error ?? 'WORKSPACE_REVEAL_UNCONFIRMED');
        return { profileId, tabId: r.tabId, focused: true as const };
      },
      {
        requiredCap: 'browser-window-reveal-v1',
        capError: 'WORKSPACE_REVEAL_EXTENSION_UPDATE_REQUIRED',
      },
    );
  windowRevealed = (p: Peer, id: string, r: WinBase & { tabId?: number; focused?: boolean }) =>
    this.winDone(
      'reveal',
      p,
      id,
      true,
      r,
      (peer, res) => res.tabId && this.markFocused(peer, res.focused),
    );
  cleanupExtraTabs = (profileId: string, preferActiveTab = true) =>
    this.winRpc(
      profileId,
      'cleanup',
      'CLEANUP_EXTRA_TABS',
      8000,
      'WORKSPACE_CLEANUP_TIMEOUT',
      { preferActiveTab },
      (
        r: WinBase & { keptTabId?: number; closedTabIds?: number[]; remainingTabCount?: number },
      ) => {
        if (r.error || !r.keptTabId) throw Error(r.error ?? 'WORKSPACE_CLEANUP_TABS_UNCONFIRMED');
        return {
          profileId,
          keptTabId: r.keptTabId,
          closedTabIds: r.closedTabIds ?? [],
          remainingTabCount: r.remainingTabCount ?? 1,
        };
      },
    );
  extraTabsCleaned = (p: Peer, id: string, r: WinBase & Record<string, unknown>) =>
    this.winDone('cleanup', p, id, true, r);
  closeBrowserWindows(profileId: string, timeoutMs = 8000) {
    if (!this.peers.get(profileId)?.online)
      return Promise.resolve({ profileId, closedCount: 0, disconnected: true });
    return this.winRpc(
      profileId,
      'close',
      'CLOSE_BROWSER_WINDOWS',
      timeoutMs,
      'BROWSER_CLOSE_TIMEOUT',
      {},
      (
        r: WinBase & {
          ok?: boolean;
          closedCount?: number;
          remainingCount?: number;
          disconnected?: boolean;
        },
      ) => {
        if (r.error || r.ok === false || (r.remainingCount ?? 0) > 0)
          throw Error(r.error ?? 'BROWSER_CLOSE_UNCONFIRMED');
        return {
          profileId,
          closedCount: r.closedCount ?? 0,
          disconnected: Boolean(r.disconnected),
        };
      },
      { requiredCap: 'browser-window-close-v1', capError: 'BROWSER_CLOSE_CAPABILITY_MISSING' },
    );
  }
  browserWindowsClosed = (p: Peer, id: string, r: WinBase & Record<string, unknown>) =>
    this.winDone('close', p, id, false, r);
  inspectBrowserWindow = (profileId: string) =>
    this.winRpc(
      profileId,
      'inspect',
      'INSPECT_BROWSER_WINDOW',
      4000,
      'WINDOW_LAYOUT_TIMEOUT',
      {},
      (r: InspectWindowResult) => ({
        ...this.mapWinGeo(profileId, r, 'WINDOW_LAYOUT_UNCONFIRMED'),
        ...(typeof r.lastFocusedAt === 'number' && r.lastFocusedAt > 0
          ? { lastFocusedAt: r.lastFocusedAt }
          : {}),
        displays: r.displays ?? [],
      }),
      { offlineError: 'WINDOW_LAYOUT_PROFILE_OFFLINE' },
    );
  browserWindowInspected = (p: Peer, id: string, r: InspectWindowResult) =>
    this.winDone('inspect', p, id, true, r, (peer, res) => {
      if (typeof res.lastFocusedAt === 'number' && res.lastFocusedAt > (peer.focusedWindowAt ?? 0))
        peer.focusedWindowAt = res.lastFocusedAt;
      this.markFocused(peer, res.focused);
    });
  positionBrowserWindow = (profileId: string, bounds: WindowBounds, focus = false) =>
    this.winRpc(
      profileId,
      'position',
      'POSITION_BROWSER_WINDOW',
      4000,
      'WINDOW_LAYOUT_TIMEOUT',
      { bounds, focus },
      (r: InspectWindowResult) => this.mapWinGeo(profileId, r, 'WINDOW_LAYOUT_MOVE_UNCONFIRMED'),
      { offlineError: 'WINDOW_LAYOUT_PROFILE_OFFLINE' },
    );
  browserWindowPositioned = (p: Peer, id: string, r: InspectWindowResult) =>
    this.winDone('position', p, id, true, r, (peer, res) => this.markFocused(peer, res.focused));
  private setPaused(p: Peer, synced = true, error?: string | null) {
    p.paused = true;
    p.synced = synced;
    p.phase = 'PAUSED';
    if (error === null) p.error = undefined;
    else if (error !== undefined) p.error = error;
  }
  private async failPendingForPeer(peer: Peer, error: string) {
    for (const [id, p] of this.pending)
      if (p.peer === peer)
        await this.finish(id, isWrite(p.action) ? 'UNKNOWN' : 'FAILED', { error });
  }
  hasPendingControlOrOperation(profileId: string): boolean {
    return (
      !!this.queuedIntents.get(profileId) ||
      this.controls.has(profileId) ||
      this.stoppingControllers.has(profileId) ||
      [...this.pending.values()].some((e) => e.peer.profileId === profileId)
    );
  }
  async reloadExtension(profileId: string): Promise<{ requested: boolean; reason?: string }> {
    const peer = this.peers.get(profileId);
    if (
      !peer ||
      !this.current(peer) ||
      this.kernelOwners.has(profileId) ||
      this.hasPendingControlOrOperation(profileId)
    )
      return { requested: false, reason: 'BUSY_OR_OFFLINE' };
    peer.send({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: peer.epoch });
    peer.synced = false;
    return { requested: true };
  }
  private evaluateKernelAdmission(
    peer: Peer | undefined,
    unresolved: ReadonlyArray<{ commandId: string; legacyFixture: number }>,
  ): KernelProfileIdleInspection {
    const res = (
      idle: boolean,
      reason: KernelProfileIdleInspection['reason'],
      unresolvedCount = 0,
    ): KernelProfileIdleInspection => ({
      idle,
      reason,
      unresolvedCount,
      legacyFixtureCount: 0,
    });
    if (!peer || !this.current(peer)) return res(false, 'PEER_OFFLINE', unresolved.length);
    if (this.kernelOwners.has(peer.profileId)) return res(false, 'KERNEL_OWNED');
    if (this.queuedIntents.get(peer.profileId)) return res(false, 'QUEUED_INTENTS');
    if (!peer.synced) return res(false, 'NOT_SYNCED');
    return peer.phase !== 'PAUSED' ? res(false, 'PHASE_RUNNING') : res(true, 'IDLE');
  }
  async inspectKernelProfileIdle(profileId: string): Promise<KernelProfileIdleInspection> {
    return this.evaluateKernelAdmission(this.peers.get(profileId), []);
  }
  async reconcileRecoveringPeerIfPossible(profileId: string): Promise<boolean> {
    const peer = this.peers.get(profileId);
    return !!peer && this.current(peer) && (await this.inspectKernelProfileIdle(profileId)).idle;
  }
  async claimFixtureKernel(peer: Peer, owner: string): Promise<void> {
    const admission = this.evaluateKernelAdmission(peer, []);
    if (!admission.idle) {
      devDiag.record({
        level: 'WARN',
        category: 'KERNEL_RPC',
        event: 'KERNEL_PROFILE_NOT_IDLE',
        profileId: peer.profileId,
        reason: admission.reason,
        data: {
          ...admission,
          current: this.current(peer),
          phase: peer.phase,
          synced: peer.synced,
          owned: this.kernelOwners.has(peer.profileId),
          queued: !!this.queuedIntents.get(peer.profileId),
        },
      });
      throw new BridgeError('KERNEL_PROFILE_NOT_IDLE');
    }
    this.kernelOwners.set(peer.profileId, owner);
  }
  bindFixtureStopRequest(peer: Peer, owner: string, requestId: string): void {
    if (!this.hasFixtureKernelOwner(peer, owner)) throw new BridgeError('KERNEL_OWNER_CHANGED');
    this.kernelStopRequests.set(owner, requestId);
  }
  releaseFixtureKernel(peer: Peer, owner: string): void {
    if (this.hasFixtureKernelOwner(peer, owner)) {
      this.kernelOwners.delete(peer.profileId);
      this.kernelStopRequests.delete(owner);
    }
  }
  hasFixtureKernelOwner = (peer: Peer, owner: string): boolean =>
    this.peers.get(peer.profileId) === peer && this.kernelOwners.get(peer.profileId) === owner;
  connect(profileId: string, send: Peer['send'], close: Peer['close']) {
    if (this.peers.get(profileId)?.online) throw new BridgeError('DUPLICATE_PROFILE');
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      send,
      close,
      online: true,
      paused: true,
      phase: 'PAUSED',
      synced: true,
    };
    this.peers.set(profileId, peer);
    return peer;
  }
  private current = (peer: Peer) => peer.online && this.peers.get(peer.profileId) === peer;
  private clearControl(peer: Peer) {
    if (this.peers.get(peer.profileId) !== peer) return;
    const timer = this.controls.get(peer.profileId);
    if (timer) clearTimeout(timer);
    this.controls.delete(peer.profileId);
    this.stoppingControllers.delete(peer.profileId);
  }
  private control(peer: Peer, type: 'SYNC' | 'STOP' | 'RESUME', preferredRequestId?: string) {
    this.clearControl(peer);
    const requestId = (peer.controlId = preferredRequestId ?? randomUUID());
    peer.error = undefined;
    const timer = setTimeout(() => {
      if (
        this.current(peer) &&
        peer.controlId === requestId &&
        this.controls.get(peer.profileId) === timer
      ) {
        this.controls.delete(peer.profileId);
        if (this.stoppingControllers.get(peer.profileId) === timer)
          this.stoppingControllers.delete(peer.profileId);
        this.setPaused(peer, true, type + '_CONFIRMATION_TIMEOUT');
      }
    }, this.timeoutMs);
    this.controls.set(peer.profileId, timer);
    if (type === 'STOP') this.stoppingControllers.set(peer.profileId, timer);
    try {
      peer.send({ type, requestId, connectionEpoch: peer.epoch });
    } catch {
      void this.disconnect(peer).catch(() => {});
    }
    return { accepted: true, requestId, state: peer.phase };
  }
  controlUnconfirmed(peer: Peer, requestId: string, reason = 'KERNEL_STOP_UNCONFIRMED'): boolean {
    if (!this.current(peer) || peer.controlId !== requestId) return false;
    this.clearControl(peer);
    this.setPaused(peer, true, reason);
    return true;
  }
  async sync(peer: Peer) {
    if (!this.current(peer)) throw new BridgeError('OFFLINE');
    this.setPaused(peer, true, null);
    await this.store.cancelPrepared(peer.profileId);
    await this.failPendingForPeer(peer, 'SYNC_IN_FLIGHT');
    if (!this.current(peer)) throw new BridgeError('OFFLINE');
    return { accepted: true, requestId: randomUUID(), state: peer.phase };
  }
  async synced(peer: Peer, requestId: string, _entries: JournalEntry[]) {
    if (!this.current(peer)) return false;
    if (peer.controlId === requestId) this.clearControl(peer);
    this.setPaused(peer, true, null);
    return true;
  }
  async disconnect(peer: Peer) {
    if (!this.current(peer)) return;
    this.clearControl(peer);
    peer.online = false;
    this.setPaused(peer, false);
    peer.phase = 'OFFLINE';
    const kernelOwner = this.kernelOwners.get(peer.profileId);
    if (kernelOwner) this.kernelStopRequests.delete(kernelOwner);
    this.kernelOwners.delete(peer.profileId);
    await this.store.cancelPrepared(peer.profileId);
    for (const [, req] of this.winReqs)
      if (req.kind === 'close' && req.peer === peer)
        (req as PendingWinReq<Record<string, unknown> & WinBase>).finish({
          ok: true,
          closedCount: 1,
          remainingCount: 0,
          disconnected: true,
        });
    await this.failPendingForPeer(peer, 'CONNECTION_LOST');
  }
  async resume(profileId: string) {
    if (this.kernelOwners.has(profileId)) throw new BridgeError('KERNEL_PROFILE_BUSY');
    const p = this.peers.get(profileId);
    if (!p?.online || !this.current(p)) throw new BridgeError('OFFLINE');
    if (p.phase === 'RUNNING') return { accepted: true, state: p.phase };
    p.phase = 'RUNNING';
    p.paused = false;
    return await this.control(p, 'RESUME');
  }
  async resumed(peer: Peer, requestId: string) {
    if (!this.current(peer) || peer.controlId !== requestId) return false;
    this.clearControl(peer);
    peer.phase = 'RUNNING';
    peer.paused = false;
    return true;
  }
  async stop(profileId: string, preferredRequestId?: string) {
    const p = this.peers.get(profileId);
    if (!p?.online) throw new BridgeError('OFFLINE');
    p.paused = true;
    p.phase = 'PAUSED';
    const owner = this.kernelOwners.get(profileId);
    const physicalStop = this.control(
      p,
      'STOP',
      preferredRequestId ?? (owner ? this.kernelStopRequests.get(owner) : undefined),
    );
    p.lastStopRequestId = physicalStop.requestId;
    await this.store.cancelPrepared(profileId);
    await this.failPendingForPeer(p, 'STOP_IN_FLIGHT');
    return { ...physicalStop, localStopConfirmed: true };
  }
  async stopped(peer: Peer, requestId: string) {
    if (!this.current(peer)) return false;
    if (peer.controlId === requestId) this.clearControl(peer);
    peer.lastStoppedRequestId = requestId;
    this.setPaused(peer, true);
    return true;
  }
  async review(
    profileId: string,
    commandId: string,
    decision: 'CONFIRMED_SUCCESS' | 'CONFIRMED_NOT_APPLIED' | 'ABANDON',
    note: string,
    evidence?: unknown,
  ) {
    const p = this.peers.get(profileId);
    if (!p?.synced || !['PAUSED', 'RUNNING'].includes(p.phase))
      throw new BridgeError('REVIEW_NOT_READY');
    const row = await this.store.get(commandId);
    if (row?.profileId !== profileId) throw new BridgeError('PROFILE_MISMATCH');
    await this.store.review(commandId, decision, note, evidence);
  }
  async submit(intent: Intent) {
    if (intent.action.kind === 'uploadMedia') throw new BridgeError('SDK_BOUND_UPLOAD_REQUIRED');
    if (this.kernelOwners.has(intent.profileId)) throw new BridgeError('KERNEL_PROFILE_BUSY');
    const peer = this.peers.get(intent.profileId);
    if (!peer?.online) throw new BridgeError('OFFLINE');
    const cap = ACTION_CAPS[intent.action.kind];
    if (cap && !peer.capabilities?.includes(cap))
      throw new BridgeError('EXTENSION_CAPABILITY_REQUIRED');
    if (isWrite(intent.action) && peer.phase !== 'RUNNING') throw new BridgeError('PAUSED');
    const prepared = await this.store.prepare(intent);
    if (!prepared.fresh) return prepared.row;
    this.queuedIntents.set(intent.profileId, (this.queuedIntents.get(intent.profileId) ?? 0) + 1);
    const chain = (this.queues.get(intent.profileId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.dispatch(peer, prepared.row.commandId, intent.action))
      .finally(() => {
        const remaining = (this.queuedIntents.get(intent.profileId) ?? 1) - 1;
        if (remaining > 0) this.queuedIntents.set(intent.profileId, remaining);
        else this.queuedIntents.delete(intent.profileId);
      });
    this.queues.set(intent.profileId, chain);
    void chain.catch(() => {});
    return prepared.row;
  }
  async run(intent: Intent) {
    const row = await this.submit(intent);
    await this.queues.get(intent.profileId);
    const finished = await this.store.get(row.commandId);
    if (!finished) throw Error('COMMAND_NOT_FOUND');
    return finished;
  }
  private async dispatch(peer: Peer, commandId: string, action: Action) {
    const preparedRow = await this.store.get(commandId);
    if (preparedRow?.status !== 'PREPARED') return;
    if (!this.current(peer) || (isWrite(action) && peer.phase !== 'RUNNING')) {
      await this.store.set(commandId, 'CANCELLED', { error: 'QUEUE_INVALIDATED' });
      return;
    }
    await this.store.set(commandId, 'DISPATCHING');
    const command: Command = {
      type: 'COMMAND',
      version: VERSION,
      commandId,
      operationId: preparedRow.operationId,
      connectionEpoch: peer.epoch,
      deadline: Date.now() + this.timeoutMs,
      action,
    };
    if (
      !this.current(peer) ||
      this.kernelOwners.has(peer.profileId) ||
      (isWrite(action) && peer.phase !== 'RUNNING')
    ) {
      await this.store.set(commandId, 'CANCELLED', { error: 'QUEUE_INVALIDATED_BEFORE_SEND' });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const failStatus = isWrite(action) ? 'UNKNOWN' : 'FAILED';
      const timer = setTimeout(
        () => void this.finish(commandId, failStatus, { error: 'REPLY_TIMEOUT' }).catch(reject),
        this.timeoutMs,
      );
      this.pending.set(commandId, { peer, resolve, timer, action });
      try {
        peer.send(command);
      } catch {
        void this.finish(commandId, failStatus, { error: 'SEND_ERROR' }).catch(reject);
      }
    });
  }
  async reply(peer: Peer, msg: Reply) {
    const p = this.pending.get(msg.commandId);
    if (!p || p.peer !== peer || !this.current(peer)) return false;
    await this.finish(msg.commandId, msg.status, msg);
    return true;
  }
  private async finish(id: string, status: Reply['status'], result: unknown) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    await this.store.set(id, status, result);
    p.resolve();
    if (status === 'UNKNOWN' && this.current(p.peer)) await this.stop(p.peer.profileId);
  }
  async shutdown() {
    const peers = [...this.peers.values()],
      disconnected = peers.map((p) => this.disconnect(p));
    for (const p of peers) p.close();
    await Promise.all(disconnected);
  }
}
