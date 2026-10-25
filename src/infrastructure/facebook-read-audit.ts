import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import { analyzeFacebookIdentityPage } from '../domain/facebook-page-analysis.js';
import { facebookIdentityProjection } from './facebook-read-adapter.js';
import type { KernelBridge } from './kernel-bridge.js';

// Explicit one-time read on the user-confirmed Chrome, independent of production input readiness.
export class FacebookReadAudit {
  private attempted = false;
  private disabled = false;
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
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
      console.error('Facebook read report failure', error),
    );
  }
  private async run(peer: Peer) {
    await mkdir(this.output, { recursive: true });
    const file = path.join(this.output, 'facebook-identity-read-v2-live.json');
    const base = {
      startedAt: new Date().toISOString(),
      profileId: peer.profileId,
      extensionVersion: peer.extensionVersion,
      readonlyScope: true,
      businessInputEnabled: false,
      productionIdentityReady: false,
    };
    try {
      await writeFile(file, JSON.stringify({ ...base, state: 'RUNNING' }, null, 2), { flag: 'wx' });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
    try {
      const evidence = await this.bridge.readFacebookPage(peer, facebookIdentityProjection);
      const analysis = analyzeFacebookIdentityPage(evidence.page);
      await writeFile(
        file,
        JSON.stringify(
          {
            ...base,
            finishedAt: new Date().toISOString(),
            state: 'READ_COMPLETED',
            realPageRead: true,
            evidence,
            analysis,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await writeFile(
        file,
        JSON.stringify(
          {
            ...base,
            finishedAt: new Date().toISOString(),
            state: 'FAILED',
            error: error instanceof Error ? error.message.slice(0, 300) : 'READ_FAILED',
            trace: this.bridge.diagnostics(peer.profileId),
          },
          null,
          2,
        ),
      );
    }
  }
}
