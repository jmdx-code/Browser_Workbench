import { flatMapAsync } from '../shared/async-collections.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import { assertReadTabUnassociated } from '../domain/read-tab-protection.js';
import { observeFacebookSelfProfile } from '../domain/facebook-page-analysis.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { facebookSelfProfileProjection } from './facebook-read-adapter.js';
import type { TabProof } from '../shared/kernel-state.js';

// One-time software integration audit, only on the already user-confirmed Chrome profile.
export class FacebookFollowupAudit {
  private attempted = false;
  private disabled = false;
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
    private readonly repository: WorkspaceStore,
    private readonly output: string,
  ) {}
  disable() {
    this.disabled = true;
  }
  tick() {
    if (this.disabled || this.attempted) return;
    const peer = this.core.peers.get('2b32bd78-51d0-4576-a12b-252c4d3c2d9b');
    if (
      !peer?.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      !peer.capabilities?.includes('facebook-readonly-v1')
    )
      return;
    this.attempted = true;
    void this.run(peer).catch((error: unknown) =>
      console.error('Facebook followup report failure', error),
    );
  }
  private async assertUnassociated(proof: TabProof) {
    if (this.disabled) throw Error('FACEBOOK_FOLLOWUP_DISABLED');
    const plans = await this.repository.tasks.list();
    assertReadTabUnassociated(proof, {
      profilePlans: plans.filter((plan) => plan.profileId === proof.profileId).length,
      associated: await flatMapAsync(plans, async (plan) =>
        (await this.repository.taskTabs.forPlan(plan.id)).map((tab) => tab.proof),
      ),
    });
  }
  private async run(peer: Peer) {
    await mkdir(this.output, { recursive: true });
    const file = path.join(this.output, 'facebook-identity-followup-live.json');
    const base = {
      startedAt: new Date().toISOString(),
      profileId: peer.profileId,
      extensionVersion: peer.extensionVersion,
      businessInputEnabled: false,
      productionIdentityReady: false,
    };
    try {
      await writeFile(file, JSON.stringify({ ...base, state: 'RUNNING' }, null, 2), { flag: 'wx' });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
    const released: Awaited<ReturnType<KernelBridge['releaseReadTab']>>[] = [];
    try {
      const inventory = await this.bridge.withSummary(peer, (port) => port.inventory());
      // Persist authenticated source proofs before any native close. Keep every prior report intact.
      await writeFile(file, JSON.stringify({ ...base, state: 'RECONCILING', inventory }, null, 2));
      for (const row of inventory.tabs) {
        if (row.state !== 'READY' || !row.proof || !kernelFacebookReadURL(row.url)) continue;
        await this.assertUnassociated(row.proof);
        const result = await this.bridge.releaseReadTab(
          peer,
          row.proof,
          async (proof) => await this.assertUnassociated(proof),
        );
        released.push(result);
        await writeFile(
          file,
          JSON.stringify({ ...base, state: 'RECONCILING', inventory, released }, null, 2),
        );
      }
      if (this.disabled) throw Error('FACEBOOK_FOLLOWUP_DISABLED');
      const home = await this.bridge.readFacebookPage(peer, facebookSelfProfileProjection, 'home');
      await writeFile(
        file,
        JSON.stringify({ ...base, state: 'READING_SELF', inventory, released, home }, null, 2),
      );
      if (this.disabled) throw Error('FACEBOOK_FOLLOWUP_DISABLED');
      const self = await this.bridge.readFacebookPage(
        peer,
        facebookSelfProfileProjection,
        'self-profile',
      );
      await writeFile(
        file,
        JSON.stringify(
          {
            ...base,
            state: 'COMPLETED',
            finishedAt: new Date().toISOString(),
            inventory,
            released,
            home,
            self,
            observation: observeFacebookSelfProfile(self.page),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      // Retain already durable intermediate evidence, including successfully closed targets.
      const previous: unknown = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(
        file,
        JSON.stringify(
          {
            ...(typeof previous === 'object' && previous !== null ? previous : base),
            state: 'FAILED',
            finishedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : 'FOLLOWUP_FAILED',
            trace: this.bridge.diagnostics(peer.profileId),
          },
          null,
          2,
        ),
      );
    }
  }
}
