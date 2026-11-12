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
export type Phase =
  'SYNCING' | 'PAUSED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'RECOVERING' | 'OFFLINE';
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
export class Core {
  private readonly windowRequests = new Map<
    string,
    {
      peer: Peer;
      finish: (result: { tabId?: number; focused?: boolean; error?: string }) => void;
    }
  >();
  revealBrowserWindow(
    profileId: string,
  ): Promise<{ profileId: string; tabId: number; focused: true }> {
    const peer = this.peers.get(profileId);
    if (!peer?.online) throw Error('BROWSER_OFFLINE');
    if (!peer.capabilities?.includes('browser-window-reveal-v1'))
      throw Error('WORKSPACE_REVEAL_EXTENSION_UPDATE_REQUIRED');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: 'WORKSPACE_REVEAL_TIMEOUT' }), 5000);
      const finish = (result: { tabId?: number; focused?: boolean; error?: string }) => {
        clearTimeout(timer);
        this.windowRequests.delete(requestId);
        if (result.error || !result.tabId || result.focused !== true)
          reject(Error(result.error ?? 'WORKSPACE_REVEAL_UNCONFIRMED'));
        else resolve({ profileId, tabId: result.tabId, focused: true });
      };
      this.windowRequests.set(requestId, { peer, finish });
      try {
        peer.send({ type: 'REVEAL_BROWSER_WINDOW', requestId, connectionEpoch: peer.epoch });
      } catch (error) {
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  windowRevealed(
    peer: Peer,
    requestId: string,
    result: { tabId?: number; focused?: boolean; error?: string },
  ) {
    const pending = this.windowRequests.get(requestId);
    if (pending?.peer === peer && this.peers.get(peer.profileId) === peer && peer.online) {
      if (!result.error && result.tabId && result.focused === true) {
        peer.profileWindowFocused = true;
        peer.focusedWindowAt = Date.now();
      }
      pending.finish(result);
    }
  }
  private readonly cleanupTabRequests = new Map<
    string,
    {
      peer: Peer;
      finish: (result: {
        keptTabId?: number;
        closedTabIds?: number[];
        remainingTabCount?: number;
        error?: string;
      }) => void;
    }
  >();
  cleanupExtraTabs(
    profileId: string,
    preferActiveTab = true,
  ): Promise<{
    profileId: string;
    keptTabId: number;
    closedTabIds: number[];
    remainingTabCount: number;
  }> {
    const peer = this.peers.get(profileId);
    if (!peer?.online) throw Error('BROWSER_OFFLINE');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: 'WORKSPACE_CLEANUP_TIMEOUT' }), 8000);
      const finish = (result: {
        keptTabId?: number;
        closedTabIds?: number[];
        remainingTabCount?: number;
        error?: string;
      }) => {
        clearTimeout(timer);
        this.cleanupTabRequests.delete(requestId);
        if (result.error || !result.keptTabId)
          reject(Error(result.error ?? 'WORKSPACE_CLEANUP_TABS_UNCONFIRMED'));
        else
          resolve({
            profileId,
            keptTabId: result.keptTabId,
            closedTabIds: result.closedTabIds ?? [],
            remainingTabCount: result.remainingTabCount ?? 1,
          });
      };
      this.cleanupTabRequests.set(requestId, { peer, finish });
      try {
        peer.send({
          type: 'CLEANUP_EXTRA_TABS',
          requestId,
          connectionEpoch: peer.epoch,
          preferActiveTab,
        });
      } catch (error) {
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  extraTabsCleaned(
    peer: Peer,
    requestId: string,
    result: {
      keptTabId?: number;
      closedTabIds?: number[];
      remainingTabCount?: number;
      error?: string;
    },
  ) {
    const pending = this.cleanupTabRequests.get(requestId);
    if (pending?.peer === peer && this.peers.get(peer.profileId) === peer && peer.online)
      pending.finish(result);
  }
  private readonly closeWindowRequests = new Map<
    string,
    {
      peer: Peer;
      finish: (result: {
        ok?: boolean;
        closedCount?: number;
        remainingCount?: number;
        disconnected?: boolean;
        error?: string;
      }) => void;
    }
  >();
  closeBrowserWindows(
    profileId: string,
    timeoutMs = 8000,
  ): Promise<{
    profileId: string;
    closedCount: number;
    disconnected: boolean;
  }> {
    const peer = this.peers.get(profileId);
    if (!peer?.online) {
      return Promise.resolve({ profileId, closedCount: 0, disconnected: true });
    }
    if (!peer.capabilities?.includes('browser-window-close-v1')) {
      return Promise.reject(Error('BROWSER_CLOSE_CAPABILITY_MISSING'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: 'BROWSER_CLOSE_TIMEOUT' }), timeoutMs);
      const finish = (result: {
        ok?: boolean;
        closedCount?: number;
        remainingCount?: number;
        disconnected?: boolean;
        error?: string;
      }) => {
        clearTimeout(timer);
        this.closeWindowRequests.delete(requestId);
        if (result.error || result.ok === false || (result.remainingCount ?? 0) > 0) {
          reject(Error(result.error ?? 'BROWSER_CLOSE_UNCONFIRMED'));
        } else {
          resolve({
            profileId,
            closedCount: result.closedCount ?? 0,
            disconnected: Boolean(result.disconnected),
          });
        }
      };
      this.closeWindowRequests.set(requestId, { peer, finish });
      try {
        peer.send({
          type: 'CLOSE_BROWSER_WINDOWS',
          requestId,
          connectionEpoch: peer.epoch,
        });
      } catch (error) {
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  browserWindowsClosed(
    peer: Peer,
    requestId: string,
    result: {
      ok?: boolean;
      closedCount?: number;
      remainingCount?: number;
      error?: string;
    },
  ) {
    const pending = this.closeWindowRequests.get(requestId);
    if (pending?.peer === peer && this.peers.get(peer.profileId) === peer) {
      pending.finish(result);
    }
  }
  private readonly inspectWindowRequests = new Map<
    string,
    {
      peer: Peer;
      finish: (result: {
        windowId?: number;
        tabId?: number;
        focused?: boolean;
        lastFocusedAt?: number;
        state?: string;
        bounds?: WindowBounds;
        contentInsets?: { left: number; top: number; right: number; bottom: number };
        displays?: WindowDisplayBounds[];
        error?: string;
      }) => void;
    }
  >();
  inspectBrowserWindow(profileId: string): Promise<{
    profileId: string;
    windowId: number;
    tabId: number;
    focused: boolean;
    lastFocusedAt?: number;
    state: string;
    bounds: WindowBounds;
    contentInsets: { left: number; top: number; right: number; bottom: number };
    displays: WindowDisplayBounds[];
  }> {
    const peer = this.peers.get(profileId);
    if (!peer?.online) return Promise.reject(Error('WINDOW_LAYOUT_PROFILE_OFFLINE'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: 'WINDOW_LAYOUT_TIMEOUT' }), 4000);
      const finish = (result: {
        windowId?: number;
        tabId?: number;
        focused?: boolean;
        lastFocusedAt?: number;
        state?: string;
        bounds?: WindowBounds;
        contentInsets?: { left: number; top: number; right: number; bottom: number };
        displays?: WindowDisplayBounds[];
        error?: string;
      }) => {
        clearTimeout(timer);
        this.inspectWindowRequests.delete(requestId);
        if (result.error || result.windowId === undefined || !result.bounds)
          reject(Error(result.error ?? 'WINDOW_LAYOUT_UNCONFIRMED'));
        else
          resolve({
            profileId,
            windowId: result.windowId,
            tabId: result.tabId ?? 1,
            focused: Boolean(result.focused),
            ...(typeof result.lastFocusedAt === 'number' && result.lastFocusedAt > 0
              ? { lastFocusedAt: result.lastFocusedAt }
              : {}),
            state: result.state ?? 'normal',
            bounds: result.bounds,
            contentInsets: result.contentInsets ?? { left: 16, top: 104, right: 16, bottom: 16 },
            displays: result.displays ?? [],
          });
      };
      this.inspectWindowRequests.set(requestId, { peer, finish });
      try {
        peer.send({
          type: 'INSPECT_BROWSER_WINDOW',
          requestId,
          connectionEpoch: peer.epoch,
        });
      } catch (error) {
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  browserWindowInspected(
    peer: Peer,
    requestId: string,
    result: {
      windowId?: number;
      tabId?: number;
      focused?: boolean;
      lastFocusedAt?: number;
      state?: string;
      bounds?: WindowBounds;
      contentInsets?: { left: number; top: number; right: number; bottom: number };
      displays?: WindowDisplayBounds[];
      error?: string;
    },
  ) {
    const pending = this.inspectWindowRequests.get(requestId);
    if (pending?.peer === peer && this.peers.get(peer.profileId) === peer && peer.online) {
      if (!result.error) {
        if (
          typeof result.lastFocusedAt === 'number' &&
          result.lastFocusedAt > (peer.focusedWindowAt ?? 0)
        ) {
          peer.focusedWindowAt = result.lastFocusedAt;
        }
        if (result.focused === true) {
          peer.profileWindowFocused = true;
          peer.focusedWindowAt = Math.max(peer.focusedWindowAt ?? 0, Date.now());
        }
      }
      pending.finish(result);
    }
  }
  private readonly positionWindowRequests = new Map<
    string,
    {
      peer: Peer;
      finish: (result: {
        windowId?: number;
        tabId?: number;
        focused?: boolean;
        state?: string;
        bounds?: WindowBounds;
        contentInsets?: { left: number; top: number; right: number; bottom: number };
        error?: string;
      }) => void;
    }
  >();
  positionBrowserWindow(
    profileId: string,
    bounds: WindowBounds,
    focus = false,
  ): Promise<{
    profileId: string;
    windowId: number;
    tabId: number;
    focused: boolean;
    state: string;
    bounds: WindowBounds;
    contentInsets: { left: number; top: number; right: number; bottom: number };
  }> {
    const peer = this.peers.get(profileId);
    if (!peer?.online) return Promise.reject(Error('WINDOW_LAYOUT_PROFILE_OFFLINE'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: 'WINDOW_LAYOUT_TIMEOUT' }), 4000);
      const finish = (result: {
        windowId?: number;
        tabId?: number;
        focused?: boolean;
        state?: string;
        bounds?: WindowBounds;
        contentInsets?: { left: number; top: number; right: number; bottom: number };
        error?: string;
      }) => {
        clearTimeout(timer);
        this.positionWindowRequests.delete(requestId);
        if (result.error || result.windowId === undefined || !result.bounds)
          reject(Error(result.error ?? 'WINDOW_LAYOUT_MOVE_UNCONFIRMED'));
        else
          resolve({
            profileId,
            windowId: result.windowId,
            tabId: result.tabId ?? 1,
            focused: Boolean(result.focused),
            state: result.state ?? 'normal',
            bounds: result.bounds,
            contentInsets: result.contentInsets ?? { left: 16, top: 104, right: 16, bottom: 16 },
          });
      };
      this.positionWindowRequests.set(requestId, { peer, finish });
      try {
        peer.send({
          type: 'POSITION_BROWSER_WINDOW',
          requestId,
          connectionEpoch: peer.epoch,
          bounds,
          focus,
        });
      } catch (error) {
        finish({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  browserWindowPositioned(
    peer: Peer,
    requestId: string,
    result: {
      windowId?: number;
      tabId?: number;
      focused?: boolean;
      state?: string;
      bounds?: WindowBounds;
      contentInsets?: { left: number; top: number; right: number; bottom: number };
      error?: string;
    },
  ) {
    const pending = this.positionWindowRequests.get(requestId);
    if (pending?.peer === peer && this.peers.get(peer.profileId) === peer && peer.online) {
      if (!result.error && result.focused === true) {
        peer.profileWindowFocused = true;
        peer.focusedWindowAt = Date.now();
      }
      pending.finish(result);
    }
  }
  peers = new Map<string, Peer>();
  private readonly kernelOwners = new Map<string, string>();
  private readonly kernelStopRequests = new Map<string, string>();
  private readonly queuedIntents = new Map<string, number>();
  hasPendingControlOrOperation(profileId: string): boolean {
    return (
      !!this.queuedIntents.get(profileId) ||
      this.controls.has(profileId) ||
      this.stoppingControllers.has(profileId) ||
      [...this.pending.values()].some((entry) => entry.peer.profileId === profileId)
    );
  }
  async reloadExtension(profileId: string): Promise<{ requested: boolean; reason?: string }> {
    const peer = this.peers.get(profileId);
    const unresolved = await this.store.unresolved(profileId);
    const idle = peer?.synced && peer.phase === 'PAUSED';
    const recovering =
      peer?.phase === 'RECOVERING' &&
      !this.controls.has(profileId) &&
      [
        'SYNC_CONFIRMATION_TIMEOUT',
        'STOP_CONFIRMATION_TIMEOUT',
        'KERNEL_STOP_UNCONFIRMED',
      ].includes(peer.error ?? '');
    if (
      !peer ||
      !this.current(peer) ||
      (!idle && !recovering) ||
      this.kernelOwners.has(profileId) ||
      this.hasPendingControlOrOperation(profileId) ||
      unresolved.length
    )
      return { requested: false, reason: 'BUSY_OR_OFFLINE' };
    peer.send({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: peer.epoch });
    peer.synced = false;
    peer.phase = 'RECOVERING';
    return { requested: true };
  }
  private evaluateKernelAdmissionSync(
    peer: Peer | undefined,
    unresolved: ReadonlyArray<{ commandId: string; legacyFixture: number }>,
  ): KernelProfileIdleInspection {
    if (!peer || !this.current(peer)) {
      return {
        idle: false,
        reason: 'PEER_OFFLINE',
        unresolvedCount: unresolved.length,
        legacyFixtureCount: 0,
      };
    }
    const legacyFixtureCount = unresolved.filter((r) => r.legacyFixture === 1).length;
    if (this.kernelOwners.has(peer.profileId)) {
      return {
        idle: false,
        reason: 'KERNEL_OWNED',
        unresolvedCount: unresolved.length,
        legacyFixtureCount,
      };
    }
    if (this.queuedIntents.get(peer.profileId)) {
      return {
        idle: false,
        reason: 'QUEUED_INTENTS',
        unresolvedCount: unresolved.length,
        legacyFixtureCount,
      };
    }
    if (unresolved.length > 0) {
      return {
        idle: false,
        reason:
          legacyFixtureCount === unresolved.length
            ? 'UNRESOLVED_LEGACY_FIXTURE'
            : 'UNRESOLVED_BRIDGE_COMMANDS',
        unresolvedCount: unresolved.length,
        legacyFixtureCount,
      };
    }
    if (!peer.synced) {
      return {
        idle: false,
        reason: peer.phase === 'RECOVERING' ? 'RECOVERING_CONTROL_OR_SYNC' : 'NOT_SYNCED',
        unresolvedCount: 0,
        legacyFixtureCount: 0,
      };
    }
    if (peer.phase !== 'PAUSED') {
      const reason =
        peer.phase === 'STOPPING'
          ? 'PHASE_STOPPING'
          : peer.phase === 'STARTING'
            ? 'PHASE_STARTING'
            : peer.phase === 'RUNNING'
              ? 'PHASE_RUNNING'
              : 'RECOVERING_CONTROL_OR_SYNC';
      return { idle: false, reason, unresolvedCount: 0, legacyFixtureCount: 0 };
    }
    return { idle: true, reason: 'IDLE', unresolvedCount: 0, legacyFixtureCount: 0 };
  }
  async inspectKernelProfileIdle(profileId: string): Promise<KernelProfileIdleInspection> {
    const peer = this.peers.get(profileId);
    const unresolved = await this.store.unresolved(profileId);
    return this.evaluateKernelAdmissionSync(peer, unresolved);
  }
  async reconcileRecoveringPeerIfPossible(profileId: string): Promise<boolean> {
    const peer = this.peers.get(profileId);
    if (!peer || !this.current(peer)) return false;
    const unresolved = await this.store.unresolved(profileId);
    const inspection = this.evaluateKernelAdmissionSync(peer, unresolved);
    if (inspection.idle) return true;
    if (inspection.reason === 'UNRESOLVED_LEGACY_FIXTURE') {
      for (const row of unresolved) {
        if (row.legacyFixture === 1) {
          await this.review(
            profileId,
            row.commandId,
            'ABANDON',
            'AUTO_ABANDON_LEGACY_FIXTURE',
          ).catch(() => {});
        }
      }
      const next = await this.inspectKernelProfileIdle(profileId);
      return next.idle;
    }
    if (inspection.reason === 'RECOVERING_CONTROL_OR_SYNC') {
      if (this.controls.has(profileId) || this.stoppingControllers.has(profileId)) return false;
      await this.sync(peer);
      return true;
    }
    return false;
  }
  async claimFixtureKernel(peer: Peer, owner: string): Promise<void> {
    const unresolved = await this.store.unresolved(peer.profileId);
    const admission = this.evaluateKernelAdmissionSync(peer, unresolved);
    if (!admission.idle) {
      devDiag.record({
        level: 'WARN',
        category: 'KERNEL_RPC',
        event: 'KERNEL_PROFILE_NOT_IDLE',
        profileId: peer.profileId,
        reason: admission.reason,
        data: {
          current: this.current(peer),
          phase: peer.phase,
          synced: peer.synced,
          owned: this.kernelOwners.has(peer.profileId),
          queued: !!this.queuedIntents.get(peer.profileId),
          unresolvedCount: admission.unresolvedCount,
          legacyFixtureCount: admission.legacyFixtureCount,
          idleReason: admission.reason,
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
    if (
      this.peers.get(peer.profileId) === peer &&
      this.kernelOwners.get(peer.profileId) === owner
    ) {
      this.kernelOwners.delete(peer.profileId);
      this.kernelStopRequests.delete(owner);
    }
  }
  hasFixtureKernelOwner(peer: Peer, owner: string): boolean {
    return (
      this.peers.get(peer.profileId) === peer && this.kernelOwners.get(peer.profileId) === owner
    );
  }
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
  connect(profileId: string, send: Peer['send'], close: Peer['close']) {
    if (this.peers.get(profileId)?.online) throw new BridgeError('DUPLICATE_PROFILE');
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      send,
      close,
      online: true,
      paused: true,
      phase: 'SYNCING',
      synced: false,
    };
    this.peers.set(profileId, peer);
    return peer;
  }
  private current(peer: Peer) {
    return peer.online && this.peers.get(peer.profileId) === peer;
  }
  private clearControl(peer: Peer) {
    const timer = this.controls.get(peer.profileId);
    if (timer) clearTimeout(timer);
    this.controls.delete(peer.profileId);
    this.stoppingControllers.delete(peer.profileId);
  }
  private control(peer: Peer, type: 'SYNC' | 'STOP' | 'RESUME', preferredRequestId?: string) {
    this.clearControl(peer);
    peer.controlId = preferredRequestId ?? randomUUID();
    peer.error = undefined;
    const requestId = peer.controlId;
    const timer = setTimeout(() => {
      if (this.current(peer) && peer.controlId === requestId) {
        if (this.controls.get(peer.profileId) !== timer) return;
        this.controls.delete(peer.profileId);
        if (this.stoppingControllers.get(peer.profileId) === timer)
          this.stoppingControllers.delete(peer.profileId);
        peer.paused = true;
        peer.synced = false;
        peer.phase = 'RECOVERING';
        peer.error = type + '_CONFIRMATION_TIMEOUT';
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
    peer.paused = true;
    peer.synced = false;
    peer.phase = 'RECOVERING';
    peer.error = reason;
    return true;
  }
  async sync(peer: Peer) {
    if (!this.current(peer)) throw new BridgeError('OFFLINE');
    peer.paused = true;
    peer.phase = 'STOPPING';
    await this.store.cancelPrepared(peer.profileId);
    for (const [id, p] of this.pending)
      if (p.peer === peer)
        await this.finish(id, isWrite(p.action) ? 'UNKNOWN' : 'FAILED', {
          error: 'SYNC_IN_FLIGHT',
        });
    peer.synced = false;
    peer.phase = 'SYNCING';
    return await this.control(peer, 'SYNC');
  }
  async synced(peer: Peer, requestId: string, entries: JournalEntry[]) {
    if (!this.current(peer) || peer.phase !== 'SYNCING' || peer.controlId !== requestId)
      return false;
    try {
      await this.store.reconcile(peer.profileId, entries);
    } catch (error) {
      if (!this.current(peer) || peer.phase !== 'SYNCING' || peer.controlId !== requestId)
        return false;
      this.clearControl(peer);
      peer.phase = 'RECOVERING';
      peer.error = error instanceof Error ? error.message : 'RECONCILE_FAILED';
      return false;
    }
    const unresolved = await this.store.unresolved(peer.profileId);
    if (!this.current(peer) || peer.phase !== 'SYNCING' || peer.controlId !== requestId)
      return false;
    this.clearControl(peer);
    peer.synced = true;
    peer.paused = true;
    peer.phase = unresolved.length ? 'RECOVERING' : 'PAUSED';
    return true;
  }
  async disconnect(peer: Peer) {
    if (!this.current(peer)) return;
    this.clearControl(peer);
    peer.online = false;
    peer.paused = true;
    peer.synced = false;
    peer.phase = 'OFFLINE';
    const kernelOwner = this.kernelOwners.get(peer.profileId);
    if (kernelOwner) this.kernelStopRequests.delete(kernelOwner);
    this.kernelOwners.delete(peer.profileId);
    await this.store.cancelPrepared(peer.profileId);
    for (const [, req] of this.closeWindowRequests) {
      if (req.peer === peer) {
        req.finish({ ok: true, closedCount: 1, remainingCount: 0, disconnected: true });
      }
    }
    for (const [id, p] of this.pending)
      if (p.peer === peer)
        await this.finish(id, isWrite(p.action) ? 'UNKNOWN' : 'FAILED', {
          error: 'CONNECTION_LOST',
        });
  }
  async resume(profileId: string) {
    if (this.kernelOwners.has(profileId)) throw new BridgeError('KERNEL_PROFILE_BUSY');
    const p = this.peers.get(profileId);
    if (!p?.online) throw new BridgeError('OFFLINE');
    if (!p.synced) throw new BridgeError('RECONCILIATION_REQUIRED');
    if ((await this.store.unresolved(profileId)).length)
      throw new BridgeError('RESULT_REVIEW_REQUIRED');
    if (!this.current(p)) throw new BridgeError('OFFLINE');
    if (this.kernelOwners.has(profileId)) throw new BridgeError('KERNEL_PROFILE_BUSY');
    if (!p.synced) throw new BridgeError('RECONCILIATION_REQUIRED');
    if (p.phase === 'RUNNING') return { accepted: true, state: p.phase };
    if (p.phase !== 'PAUSED' && p.phase !== 'RECOVERING')
      throw new BridgeError('CONTROL_CONFIRMATION_PENDING');
    if (p.error) throw new BridgeError('STOP_OR_SYNC_UNCONFIRMED');
    p.phase = 'STARTING';
    p.paused = true;
    return await this.control(p, 'RESUME');
  }
  async resumed(peer: Peer, requestId: string) {
    if (!this.current(peer) || peer.phase !== 'STARTING' || peer.controlId !== requestId)
      return false;
    const unresolved = await this.store.unresolved(peer.profileId);
    if (!this.current(peer) || peer.phase !== 'STARTING' || peer.controlId !== requestId)
      return false;
    this.clearControl(peer);
    if (unresolved.length) {
      await this.stop(peer.profileId);
      return false;
    }
    peer.phase = 'RUNNING';
    peer.paused = false;
    return true;
  }
  async stop(profileId: string, preferredRequestId?: string) {
    const p = this.peers.get(profileId);
    if (!p?.online) throw new BridgeError('OFFLINE');
    if (p.phase === 'STOPPING') return { accepted: true, requestId: p.controlId, state: p.phase };
    p.paused = true;
    p.phase = 'STOPPING';
    const owner = this.kernelOwners.get(profileId);
    const physicalStop = this.control(
      p,
      'STOP',
      preferredRequestId ?? (owner ? this.kernelStopRequests.get(owner) : undefined),
    );
    p.lastStopRequestId = physicalStop.requestId;
    await this.store.cancelPrepared(profileId);
    for (const [id, pending] of this.pending)
      if (pending.peer === p)
        await this.finish(id, isWrite(pending.action) ? 'UNKNOWN' : 'FAILED', {
          error: 'STOP_IN_FLIGHT',
        });
    return { ...physicalStop, localStopConfirmed: false };
  }
  async stopped(peer: Peer, requestId: string) {
    if (!this.current(peer) || peer.phase !== 'STOPPING' || peer.controlId !== requestId)
      return false;
    const unresolved = await this.store.unresolved(peer.profileId);
    if (!this.current(peer) || peer.phase !== 'STOPPING' || peer.controlId !== requestId)
      return false;
    this.clearControl(peer);
    peer.lastStoppedRequestId = requestId;
    peer.paused = true;
    peer.phase = !peer.synced || unresolved.length ? 'RECOVERING' : 'PAUSED';
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
    if (!p?.synced || !['PAUSED', 'RECOVERING', 'RUNNING'].includes(p.phase))
      throw new BridgeError('REVIEW_NOT_READY');
    const row = await this.store.get(commandId);
    if (row?.profileId !== profileId) throw new BridgeError('PROFILE_MISMATCH');
    await this.store.review(commandId, decision, note, evidence);
    if (p.phase === 'RECOVERING' && !p.error && !(await this.store.unresolved(profileId)).length)
      p.phase = 'PAUSED';
  }
  async submit(intent: Intent) {
    if (intent.action.kind === 'uploadMedia') throw new BridgeError('SDK_BOUND_UPLOAD_REQUIRED');
    if (this.kernelOwners.has(intent.profileId)) throw new BridgeError('KERNEL_PROFILE_BUSY');
    const peer = this.peers.get(intent.profileId);
    if (!peer?.online) throw new BridgeError('OFFLINE');
    if (!peer.synced) throw new BridgeError('RECONCILIATION_REQUIRED');
    if (
      (intent.action.kind === 'readTabState' &&
        !peer.capabilities?.includes('local-window-status-v1')) ||
      (intent.action.kind === 'readFacebookDisplay' &&
        !peer.capabilities?.includes('facebook-existing-display-v1')) ||
      (intent.action.kind === 'activateTab' && !peer.capabilities?.includes('task-activation')) ||
      (intent.action.kind === 'mediaClick' &&
        intent.action.surface &&
        !peer.capabilities?.includes('media-surface-input'))
    )
      throw new BridgeError('EXTENSION_CAPABILITY_REQUIRED');
    if (isWrite(intent.action)) {
      if (peer.phase !== 'RUNNING') throw new BridgeError('PAUSED');
      if ((await this.store.unresolved(intent.profileId)).length)
        throw new BridgeError('RESULT_REVIEW_REQUIRED');
      if (
        intent.action.kind === 'createTaskTab' &&
        intent.action.url.startsWith('https:') &&
        !(await this.store.facebookAllowed(intent.profileId))
      )
        throw new BridgeError('FACEBOOK_NOT_AUTHORIZED');
    } else if (!['RUNNING', 'PAUSED', 'RECOVERING'].includes(peer.phase))
      throw new BridgeError('CONTROL_CONFIRMATION_PENDING');
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
    return (await this.store.get(row.commandId))!;
  }
  private async dispatch(peer: Peer, commandId: string, action: Action) {
    if ((await this.store.get(commandId))?.status !== 'PREPARED') return;
    if (
      !this.current(peer) ||
      !peer.synced ||
      (isWrite(action)
        ? peer.phase !== 'RUNNING' || (await this.store.unresolved(peer.profileId)).length
        : !['RUNNING', 'PAUSED', 'RECOVERING'].includes(peer.phase))
    ) {
      await this.store.set(commandId, 'CANCELLED', { error: 'QUEUE_INVALIDATED' });
      return;
    }
    await this.store.set(commandId, 'DISPATCHING');
    const command: Command = {
      type: 'COMMAND',
      version: VERSION,
      commandId,
      operationId: (await this.store.get(commandId))!.operationId,
      connectionEpoch: peer.epoch,
      deadline: Date.now() + this.timeoutMs,
      action,
    };
    // Every persistence wait can admit a stop, disconnect or replacement owner.
    // Recheck local transport authority immediately before the only send below.
    if (
      !this.current(peer) ||
      !peer.synced ||
      this.kernelOwners.has(peer.profileId) ||
      (isWrite(action)
        ? peer.phase !== 'RUNNING'
        : !['RUNNING', 'PAUSED', 'RECOVERING'].includes(peer.phase))
    ) {
      await this.store.set(commandId, 'CANCELLED', { error: 'QUEUE_INVALIDATED_BEFORE_SEND' });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          void this.finish(commandId, isWrite(action) ? 'UNKNOWN' : 'FAILED', {
            error: 'REPLY_TIMEOUT',
          }).catch(reject),
        this.timeoutMs,
      );
      this.pending.set(commandId, { peer, resolve, timer, action });
      try {
        peer.send(command);
      } catch {
        void this.finish(commandId, isWrite(action) ? 'UNKNOWN' : 'FAILED', {
          error: 'SEND_ERROR',
        }).catch(reject);
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
    if (status === 'UNKNOWN' && this.current(p.peer) && p.peer.phase !== 'STOPPING')
      await this.stop(p.peer.profileId);
  }
  async shutdown() {
    const peers = [...this.peers.values()];
    const disconnected = peers.map((p) => this.disconnect(p));
    for (const p of peers) p.close();
    await Promise.all(disconnected);
  }
}
