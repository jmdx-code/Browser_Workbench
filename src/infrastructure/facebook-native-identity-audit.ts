import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { TaskRepository } from '../domain/tasks.js';
import type { KernelBridge } from './kernel-bridge.js';
import { KernelProfileInspection } from './kernel-profile-inspection.js';
import { readCurrentFacebookIdentity } from './facebook-current-identity.js';
import { sameTabProof } from '../domain/task-tabs.js';

// New, explicitly enabled one-time read of the user-confirmed Chrome. Existing audits and
// UNKNOWN objects are never reopened. This does not assign an execution account or plan.
export class FacebookNativeIdentityAudit {
  private attempted = false;
  private disabled = false;
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly tasks: TaskRepository,
    private readonly output: string,
    private readonly diagnosticContinuation = false,
    private readonly sdkRead = false,
  ) {}
  disable() {
    this.disabled = true;
  }
  tick() {
    if (this.attempted || this.disabled) return;
    const peer = this.core.peers.get('2b32bd78-51d0-4576-a12b-252c4d3c2d9b');
    if (
      !peer?.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      peer.extensionVersion !== '0.3.11' ||
      !peer.capabilities?.includes('facebook-native-identity-v1')
    )
      return;
    this.attempted = true;
    void this.run(peer).catch((error) =>
      console.error('Native identity audit report failed', error),
    );
  }
  private async run(peer: Peer) {
    await mkdir(this.output, { recursive: true });
    const file = path.join(
      this.output,
      this.sdkRead
        ? 'facebook-native-identity-0311-sdk-main-page-live.json'
        : this.diagnosticContinuation
          ? 'facebook-native-identity-0311-decision-live.json'
          : 'facebook-native-identity-0311-live.json',
    );
    const base = {
      startedAt: new Date().toISOString(),
      profileId: peer.profileId,
      connectionEpoch: peer.epoch,
      extensionVersion: peer.extensionVersion,
      readonlyScope: true,
      newPosts: 0,
      productionIdentityAuthority: false,
      managedExecutorAcceptance: false,
      supersedesFailedRead: this.sdkRead
        ? 'facebook-native-identity-0311-sdk-initial-document-live.json'
        : 'facebook-native-identity-0310-decision-live.json',
      retainedPagesAdopted: false,
    };
    try {
      await writeFile(file, JSON.stringify({ ...base, state: 'RUNNING' }, null, 2), { flag: 'wx' });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
    try {
      const inspection = new KernelProfileInspection(this.kernel, this.core, this.tasks);
      let decision: unknown = null;
      const guard = () => {
        if (
          this.disabled ||
          this.core.peers.get(peer.profileId) !== peer ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED'
        )
          throw Error('NATIVE_IDENTITY_AUDIT_REVOKED');
      };
      const evidence = await inspection.readNativeActor(
        { profileId: peer.profileId, connectionEpoch: peer.epoch },
        () => {
          if (this.disabled || this.core.peers.get(peer.profileId) !== peer || !peer.online)
            throw Error('NATIVE_IDENTITY_AUDIT_REVOKED');
        },
        (value) => {
          decision = value;
        },
      );
      let sdkEvidence: unknown = null;
      if (this.sdkRead) {
        guard();
        // Read-only research of the exact user-confirmed account. A missing bootstrap never
        // becomes task authority: no operation is prepared/begun, and the SDK's unbound Input
        // gate remains enforced. The subject is independently checked on the new page.
        const subject = evidence?.actor.accountId ?? '10000000000001';
        const connection = await this.kernel.connectFacebook(peer, subject, guard);
        let sdkStop: Awaited<ReturnType<typeof connection.close>> | null = null;
        try {
          guard();
          const contexts = connection.browser.contexts(),
            pages = contexts[0]?.pages();
          const page = pages?.[0];
          if (contexts.length !== 1 || pages?.length !== 1 || !page || !connection.proof)
            throw Error('NATIVE_IDENTITY_SDK_PAGE_REQUIRED');
          await page.waitForLoadState('load', { timeout: 15000 });
          guard();
          const current = await readCurrentFacebookIdentity(page, guard);
          guard();
          if (current.actor.accountId !== subject)
            throw Error('NATIVE_IDENTITY_SDK_ACCOUNT_CHANGED');
          sdkEvidence = {
            actor: current.actor,
            document: current.document,
            transport: current.transport,
            bootstrapSource: evidence ? 'closed-native-read' : 'user-confirmed-readonly-subject',
            taskAuthorityGranted: false,
            proof: connection.proof,
            inputRPCs: this.kernel
              .diagnostics(peer.profileId)
              .filter((row) => /^rpc:send:(Input\.|DOM\.setFileInputFiles)/.test(row.event)).length,
          };
        } finally {
          sdkStop = await connection.close();
        }
        guard();
        const closed = connection.closedInventory?.tabs.find(
          (row) => row.proof && connection.proof && sameTabProof(row.proof, connection.proof),
        );
        if (closed?.state !== 'CLOSED') throw Error('NATIVE_IDENTITY_SDK_CLOSE_UNCONFIRMED');
        sdkEvidence = {
          observation: sdkEvidence,
          closedRecord: closed,
          stop: sdkStop,
        };
      }
      await writeFile(
        file,
        JSON.stringify(
          {
            ...base,
            finishedAt: new Date().toISOString(),
            state: evidence || sdkEvidence ? 'OBSERVED' : 'NO_CURRENT_NATIVE_ACTOR',
            evidence,
            sdkEvidence,
            decision,
            trace: this.kernel.diagnostics(peer.profileId),
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
            state: 'FAILED_OR_BLOCKED',
            reason:
              error instanceof Error ? error.message.slice(0, 200) : 'NATIVE_IDENTITY_READ_FAILED',
            trace: this.kernel.diagnostics(peer.profileId),
          },
          null,
          2,
        ),
      );
    }
  }
}
