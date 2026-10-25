import type { WorkspaceStorePort } from './persistence-port.js';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { KernelConnection } from './kernel-fixture-task-port.js';
import { KernelManagedFixtureSession } from './kernel-managed-fixture-session.js';
import { WorkspaceStore } from './workspace-store.js';
import { ProfileActorRegistry } from '../application/profile-actor-registry.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import { sameStop, type StopBinding, type StopReceipt } from '../shared/task-control.js';

const eligibleProfiles = new Set([
  '2b32bd78-51d0-4576-a12b-252c4d3c2d9b',
  '066430e1-92cd-4ee4-8f43-98db3425239d',
]);
// Inject loss AFTER the actual native stop was confirmed, at the managed service boundary.
// This is not a wire disconnect test. Recovery may use the exact cached native receipt.
class LostServiceReceiptSession extends KernelManagedFixtureSession {
  nativeReceipt: StopReceipt | null = null;
  override async stop(binding: StopBinding): Promise<StopReceipt> {
    this.nativeReceipt = await super.stop(binding);
    throw Error('AUDIT_SERVICE_STOP_RECEIPT_LOST');
  }
}
export class KernelStopRetryAudit {
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
    const peer = [...this.core.peers.values()].find(
      (p) =>
        eligibleProfiles.has(p.profileId) &&
        p.online &&
        p.synced &&
        p.phase === 'PAUSED' &&
        p.extensionVersion === '0.3.3' &&
        p.capabilities?.includes('kernel-journal-v1'),
    );
    if (!peer) return;
    this.attempted = true;
    void this.run(peer).catch((error: unknown) =>
      console.error('Stop retry audit report failure', error),
    );
  }
  private async run(peer: Peer) {
    const file = path.join(this.output, 'kernel-stop-retry-live.json');
    try {
      await access(file);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const directory = path.join(this.output, 'stop-retry-isolated-' + randomUUID());
    const checks: string[] = [],
      failures: string[] = [],
      evidence: Record<string, unknown> = {};
    let store: WorkspaceStorePort | undefined, connection: KernelConnection | undefined;
    try {
      await mkdir(directory, { recursive: true });
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const initial = await this.bridge.connect(peer);
      connection = initial;
      const proof = initial.proof,
        page = initial.browser.contexts()[0]?.pages()[0];
      if (!proof || !page || (await page.locator('#count').innerText()) !== '0')
        throw Error('NEW_FIXTURE_NOT_READY');
      const runtime: RuntimeProfile = {
        id: peer.profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: {
          state: 'logged-in',
          id: 'stop-retry-fixture-only-' + peer.profileId,
          name: null,
          avatar: null,
        },
      };
      const context = await initial.context(runtime.account.id ?? '');
      if (!context) throw Error('NATIVE_CONTEXT_REQUIRED');
      const saved = await store.createCombination({
        name: '停止回执恢复隔离测试',
        note: 'fixture-only; no input',
        steps: [
          { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: [peer.profileId],
        },
        [runtime],
      );
      const plan = await store.tasks.claimNext([runtime], new Set(['video']));
      if (!plan) throw Error('ISOLATED_CONTROL_PLAN_REQUIRED');
      await store.taskTabs.register(plan.id, proof, context);
      const registry = new ProfileActorRegistry(
        () => [runtime],
        store.tasks,
        store.tasks.settlements,
        store.taskControls,
        store.taskTabs,
        randomUUID,
      );
      if (!runtime.account.id) throw Error('AUDIT_ACCOUNT_REQUIRED');
      const initialContext = await initial.context(runtime.account.id);
      if (!initialContext) throw Error('AUDIT_CONTEXT_REQUIRED');
      const managed = new LostServiceReceiptSession(
        initialContext,
        initial,
        runtime,
        store.taskTabs,
      );
      await registry.attach(managed);
      if (
        (await registry.session(peer.profileId)) !== null ||
        (await store.tasks.operations(plan.id)).length
      )
        throw Error('AUDIT_INPUT_NOT_BLOCKED');
      checks.push(
        'real-fixture-context-and-tab-persisted-without-actor-input-permission-or-outbox',
      );
      let rejected = false;
      try {
        await registry.control(plan.id, 'stop');
      } catch (error) {
        rejected = error instanceof Error && error.message === 'AUDIT_SERVICE_STOP_RECEIPT_LOST';
      }
      const pending = (await store.taskControls.list())[0];
      if (
        !rejected ||
        !managed.nativeReceipt ||
        !pending ||
        pending.receipt ||
        !sameStop(pending.binding, managed.nativeReceipt) ||
        (await store.tasks.get(plan.id)).controlConfirmed ||
        (await registry.status())[0]?.lifecycle !== 'STOP_UNCONFIRMED'
      )
        throw Error('SERVICE_RECEIPT_LOSS_NOT_PRESERVED');
      evidence.nativeReceiptBeforeLoss = managed.nativeReceipt;
      evidence.controlBeforeRetry = pending;
      checks.push(
        'actual-native-stop-confirmed-before-injected-service-result-loss-keeps-fenced-owner',
      );
      await registry.retryStop({ ...context, requestId: managed.nativeReceipt.requestId });
      const finished = await store.tasks.get(plan.id),
        control = (await store.taskControls.list())[0];
      if (
        !control?.receipt ||
        !sameStop(control.binding, control.receipt) ||
        !finished.controlConfirmed ||
        finished.state !== 'STOPPED' ||
        (await registry.status()).length
      )
        throw Error('EXACT_STOP_RETRY_NOT_COMMITTED');
      checks.push(
        'explicit-original-binding-retry-persists-native-receipt-and-confirms-stopped-plan',
      );
      const trace = this.bridge.diagnostics(peer.profileId),
        stopRequests = trace.filter((row) => row.event === 'rpc:stop').length;
      if (
        stopRequests !== 1 ||
        initial.inputCalls !== 0 ||
        (await store.tasks.operations(plan.id)).length ||
        (await store.tasks.settlements.list(peer.profileId)).length ||
        (await store.taskTabs.get(proof.ownershipId)).state !== 'RECHECK_REQUIRED'
      )
        throw Error('RECOVERY_REPLAYED_OR_LOST_TAB_PROOF');
      checks.push(
        'cached-exact-receipt-recovery-never-resends-native-stop-input-or-business-operation',
      );
      evidence.controlAfterRetry = control;
      evidence.planId = plan.id;
      evidence.finalPlanState = finished.state;
      evidence.nativeInputCalls = initial.inputCalls;
      evidence.nativeStopRequests = stopRequests;
      evidence.nativeTrace = trace;
      evidence.tab = await store.taskTabs.get(proof.ownershipId);
      connection = undefined;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      await connection?.close().catch(() => {});
      await store?.close();
    }
    await writeFile(
      file,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          profileId: peer.profileId,
          extensionVersion: peer.extensionVersion,
          isolatedDirectory: directory,
          realBrowser: true,
          browser:
            peer.profileId === '2b32bd78-51d0-4576-a12b-252c4d3c2d9b'
              ? 'Chrome (user-confirmed)'
              : 'vendor-unconfirmed',
          facebookOperations: false,
          accountIdentity: 'fixture-only; not Facebook',
          faultBoundary:
            'managed service result lost after actual native stop; not wire disconnection',
          checks,
          failures,
          evidence,
          passed: failures.length === 0 && checks.length === 4,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
