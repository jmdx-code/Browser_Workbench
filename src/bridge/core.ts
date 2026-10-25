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
  error?: string;
  transportFailure?: string;
  extensionVersion?: string;
  capabilities?: string[];
};
export class Core {
  peers = new Map<string, Peer>();
  private readonly kernelOwners = new Map<string, string>();
  private readonly queuedIntents = new Map<string, number>();
  async reloadExtension(profileId: string): Promise<{ requested: boolean; reason?: string }> {
    const peer = this.peers.get(profileId);
    const unresolved = await this.store.unresolved(profileId);
    if (
      !peer ||
      !this.current(peer) ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      this.kernelOwners.has(profileId) ||
      this.queuedIntents.get(profileId) ||
      unresolved.length
    )
      return { requested: false, reason: 'BUSY_OR_OFFLINE' };
    peer.send({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: peer.epoch });
    peer.synced = false;
    peer.phase = 'RECOVERING';
    return { requested: true };
  }
  async claimFixtureKernel(peer: Peer, owner: string): Promise<void> {
    const unresolved = await this.store.unresolved(peer.profileId);
    if (
      !this.current(peer) ||
      peer.phase !== 'PAUSED' ||
      !peer.synced ||
      this.kernelOwners.has(peer.profileId) ||
      this.queuedIntents.get(peer.profileId) ||
      unresolved.length
    )
      throw new BridgeError('KERNEL_PROFILE_NOT_IDLE');
    this.kernelOwners.set(peer.profileId, owner);
  }
  releaseFixtureKernel(peer: Peer, owner: string): void {
    if (this.peers.get(peer.profileId) === peer && this.kernelOwners.get(peer.profileId) === owner)
      this.kernelOwners.delete(peer.profileId);
  }
  private queues = new Map<string, Promise<void>>();
  private pending = new Map<
    string,
    { peer: Peer; resolve: () => void; timer: NodeJS.Timeout; action: Action }
  >();
  private controls = new Map<string, NodeJS.Timeout>();
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
  }
  private control(peer: Peer, type: 'SYNC' | 'STOP' | 'RESUME') {
    this.clearControl(peer);
    peer.controlId = randomUUID();
    peer.error = undefined;
    const requestId = peer.controlId;
    this.controls.set(
      peer.profileId,
      setTimeout(() => {
        if (this.current(peer) && peer.controlId === requestId) {
          peer.paused = true;
          peer.synced = false;
          peer.phase = 'RECOVERING';
          peer.error = type + '_CONFIRMATION_TIMEOUT';
        }
      }, this.timeoutMs),
    );
    try {
      peer.send({ type, requestId, connectionEpoch: peer.epoch });
    } catch {
      void this.disconnect(peer).catch(() => {});
    }
    return { accepted: true, requestId, state: peer.phase };
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
    this.kernelOwners.delete(peer.profileId);
    await this.store.cancelPrepared(peer.profileId);
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
  async stop(profileId: string) {
    const p = this.peers.get(profileId);
    if (!p?.online) throw new BridgeError('OFFLINE');
    if (p.phase === 'STOPPING') return { accepted: true, requestId: p.controlId, state: p.phase };
    p.paused = true;
    p.phase = 'STOPPING';
    const physicalStop = this.control(p, 'STOP');
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
