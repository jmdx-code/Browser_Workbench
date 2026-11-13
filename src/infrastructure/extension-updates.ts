import type { TaskRepository } from '../domain/tasks.js';
import type { SettlementRepository } from '../domain/settlement.js';
import type { Core, Peer } from '../bridge/core.js';
import type { Awaitable } from '../domain/persistence.js';
import type { ReloadResult } from '../shared/software-update.js';
export class ExtensionUpdates {
  readonly autoReloadAttempted = new Map<string, string>();
  private readonly checking = new Set<string>();
  constructor(
    private readonly core: Core,
    private bundledVersion: string,
    private readonly extensionDir: string,
    private readonly busy: (id: string) => Awaitable<boolean>,
    private readonly releaseIdle: (peer: Peer) => Promise<void> = async () => {},
  ) {}
  setVersion(version: string) {
    this.bundledVersion = version;
  }
  async automatic(peer: Peer) {
    const missingRequiredCap =
      !peer.capabilities?.includes('browser-window-reveal-v1') ||
      !peer.capabilities?.includes('browser-window-close-v1') ||
      !peer.capabilities?.includes('kernel-passive-page-reveal-v1');
    if (peer.extensionVersion === this.bundledVersion && !missingRequiredCap) {
      this.autoReloadAttempted.delete(peer.profileId);
      return;
    }
    // Never downgrade an extension newer than this controller.
    const older = (version: string) => {
      const a = version.split('.').map(Number),
        b = this.bundledVersion.split('.').map(Number);
      for (let i = 0; i < 4; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff) return diff < 0;
      }
      return false;
    };
    if (
      !peer.extensionVersion ||
      (!older(peer.extensionVersion) && !missingRequiredCap) ||
      this.autoReloadAttempted.get(peer.profileId) === this.bundledVersion ||
      this.checking.has(peer.profileId)
    )
      return;
    this.checking.add(peer.profileId);
    try {
      if (await this.busy(peer.profileId)) return;
      await this.releaseIdle(peer);
      if (await this.busy(peer.profileId)) return;
      const result = await this.core.reloadExtension(peer.profileId);
      if (result.requested) this.autoReloadAttempted.set(peer.profileId, this.bundledVersion);
    } finally {
      this.checking.delete(peer.profileId);
    }
  }
  async reload(profileIds?: string[]): Promise<ReloadResult> {
    const result = {
      reloaded: 0,
      skippedBusy: 0,
      skippedOffline: 0,
      extensionDir: this.extensionDir,
      bundledVersion: this.bundledVersion,
    };
    for (const id of new Set(
      profileIds ?? [...this.core.peers.values()].filter((p) => p.online).map((p) => p.profileId),
    )) {
      this.autoReloadAttempted.delete(id);
      const p = this.core.peers.get(id);
      if (!p?.online) {
        result.skippedOffline++;
        continue;
      }
      if (await this.busy(id)) {
        result.skippedBusy++;
        continue;
      }
      await this.releaseIdle(p);
      if (await this.busy(id)) {
        result.skippedBusy++;
        continue;
      }
      const sent = await this.core.reloadExtension(id);
      if (sent.requested) {
        result.reloaded++;
        this.autoReloadAttempted.set(id, this.bundledVersion);
      } else result.skippedBusy++;
    }
    return result;
  }
}

// A queued plan alone has not acquired an execution session. Persisted operations and
// every undelivered notice still block reload, including notices excluded from readiness.
export async function extensionReloadTasksBusy(
  tasks: Pick<TaskRepository, 'plansForProfile' | 'blockingOperations' | 'operations'>,
  settlements: SettlementRepository,
  profileId: string,
): Promise<boolean> {
  const plans = await tasks.plansForProfile(profileId, [
    'QUEUED',
    'RUNNING',
    'PAUSING',
    'STOPPING',
    'REVIEW',
  ]);
  for (const plan of plans) {
    if (plan.state !== 'QUEUED') return true;
    const operations = tasks.blockingOperations
      ? await tasks.blockingOperations(plan.id)
      : await tasks.operations(plan.id);
    if (operations.length > 0) return true;
  }
  return (await settlements.list(profileId)).some((notice) => notice.state !== 'DELIVERED');
}
