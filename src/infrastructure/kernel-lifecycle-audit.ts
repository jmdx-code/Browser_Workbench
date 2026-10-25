import type { WorkspaceStorePort } from './persistence-port.js';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { KernelConnection } from './kernel-fixture-task-port.js';
import { KernelManagedFixtureSession } from './kernel-managed-fixture-session.js';
import { WorkspaceStore } from './workspace-store.js';
import { ProfileActorRegistry } from '../application/profile-actor-registry.js';
import { TaskDispatcher } from '../application/task-dispatcher.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import { sameStop } from '../shared/task-control.js';
import { sameBinding } from '../shared/task-execution.js';

const ChromeProfile = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
// One opt-in cancellation test of our lifecycle owner; no historical replay or Facebook access.
export class KernelLifecycleAudit {
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
    const peer = this.core.peers.get(ChromeProfile);
    if (
      !peer?.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      peer.extensionVersion !== '0.3.3' ||
      !peer.capabilities?.includes('kernel-journal-v1')
    )
      return;
    this.attempted = true;
    void this.run(peer).catch((error: unknown) =>
      console.error('Lifecycle audit report failure', error),
    );
  }
  private async run(peer: Peer) {
    const file = path.join(this.output, `kernel-lifecycle-v2-live-${peer.profileId}.json`);
    try {
      await access(file);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const directory = path.join(this.output, 'lifecycle-isolated-' + randomUUID());
    const checks: string[] = [],
      failures: string[] = [],
      evidence: Record<string, unknown> = {};
    let store: WorkspaceStorePort | undefined, connection: KernelConnection | undefined;
    try {
      await mkdir(directory, { recursive: true });
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const repository = store;
      connection = await this.bridge.connect(peer);
      const initial = connection,
        proof = initial.proof,
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
          id: 'lifecycle-fixture-only-' + peer.profileId,
          name: null,
          avatar: null,
        },
      };
      const registry = new ProfileActorRegistry(
        () => [runtime],
        repository.tasks,
        repository.tasks.settlements,
        repository.taskControls,
        repository.taskTabs,
        randomUUID,
      );
      await registry.attach(
        await KernelManagedFixtureSession.open(initial, runtime, repository.taskTabs),
      );
      await registry.observe(peer.profileId);
      const saved = await repository.createCombination({
        name: '执行会话实际取消隔离测试',
        note: '不是FB',
        steps: [
          { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      await repository.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: [peer.profileId],
        },
        [runtime],
      );
      const plan = await repository.tasks.claimNext(
        await registry.schedulingProfiles(),
        new Set(['video']),
      );
      const context = await registry.session(peer.profileId);
      if (!plan || !context) throw Error('CURRENT_ACTOR_NOT_READY');
      const step = (await repository.tasks.steps(plan.id))[0];
      if (!step) throw Error('FIXTURE_STEP_MISSING');
      await repository.taskTabs.register(plan.id, proof, context);
      checks.push('registry-current-context-and-persisted-task-tab-enable-new-isolated-fixture');
      const operationId = randomUUID();
      await repository.tasks.prepareOperation(plan.id, step.id, operationId, {
        kind: 'click',
        tabId: initial.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: '#never-present' },
      });
      let dispatchReturned = false;
      const dispatcher = new TaskDispatcher(repository.tasks, registry);
      const dispatch = dispatcher.flushOne().then((value) => {
        dispatchReturned = true;
        return value;
      });
      let begun = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const inventory = await initial.inventory();
        begun = inventory.operations.some(
          (op) => op.binding.operationId === operationId && op.state === 'DISPATCHING',
        );
        if (begun) break;
        await delay(100);
      }
      await delay(250);
      if (!begun || dispatchReturned || initial.inputCalls !== 0)
        throw Error('REAL_SDK_WAIT_NOT_PROVEN');
      checks.push('actual-native-begin-persists-while-real-SDK-locator-is-still-waiting');
      const stopStarted = Date.now();
      const stopped = await registry.control(plan.id, 'stop');
      await dispatch;
      evidence.cancellationMilliseconds = Date.now() - stopStarted;
      const control = (await repository.taskControls.list())[0];
      if (
        !control?.receipt ||
        !sameStop(control.binding, control.receipt) ||
        control.binding.requestId !== stopped.controlRequestId ||
        !stopped.controlConfirmed ||
        stopped.state !== 'REVIEW' ||
        initial.inputCalls !== 0 ||
        Number(evidence.cancellationMilliseconds) >= 5000 ||
        (await registry.status()).length
      )
        throw Error('ACTUAL_CANCELLATION_NOT_CONFIRMED');
      evidence.control = control;
      evidence.nativeInputCalls = initial.inputCalls;
      evidence.planId = plan.id;
      evidence.operationId = operationId;
      evidence.nativeTrace = this.bridge.diagnostics(peer.profileId);
      checks.push(
        'service-cancels-fifteen-second-SDK-wait-within-five-seconds-and-persists-exact-native-stop',
      );
      connection = undefined;
      const operation = (await repository.tasks.operations(plan.id))[0];
      if (
        operation?.status !== 'UNKNOWN' ||
        !operation.binding ||
        (await repository.taskTabs.get(proof.ownershipId)).state !== 'RECHECK_REQUIRED'
      )
        throw Error('UNKNOWN_OR_TAB_PROOF_LOST');
      const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
      try {
        evidence.unknownAccountLocks = db
          .prepare('SELECT count(*) AS count FROM task_account_locks')
          .get()?.count;
      } finally {
        db.close();
      }
      if (evidence.unknownAccountLocks !== 1) throw Error('UNKNOWN_LOCK_RELEASED');
      checks.push('stopped-owner-retains-unknown-account-lock-and-tab-recheck-proof');
      const binding = operation.binding;
      await this.bridge.withSummary(peer, async (port) => {
        const remote = (await port.inventory()).operations.find(
          (op) => op.binding.operationId === operationId,
        );
        if (!remote || remote.state !== 'UNKNOWN' || !sameBinding(remote.binding, binding))
          throw Error('REMOTE_UNKNOWN_NOT_MATCHED');
        await repository.tasks.reconcileBound(
          {
            binding,
            evidence: {
              nativeInputCalls: 0,
              actualStop: control.receipt,
              scope: 'absent-selector-in-owned-local-fixture',
            },
          },
          'NOT_APPLIED',
        );
        await new SettlementNotifier(repository.tasks.settlements).flushOne(port);
        const inventory = await port.inventory();
        if (
          !inventory.tabs.some(
            (tab) => tab.ownershipId === proof.ownershipId && tab.state === 'READY',
          )
        )
          throw Error('SDK_STOP_INCORRECTLY_CLOSED_NATIVE_TAB');
      });
      const notice = (await repository.tasks.settlements.list(peer.profileId))[0];
      if (
        notice?.state !== 'DELIVERED' ||
        (await repository.tasks.get(plan.id)).state !== 'STOPPED' ||
        (await repository.tasks.steps(plan.id))[0]?.progress.likes !== 0
      )
        throw Error('BUSINESS_RECONCILIATION_FAILED');
      evidence.finalPlanState = (await repository.tasks.get(plan.id)).state;
      evidence.deliveredNotice = notice;
      checks.push(
        'zero-native-input-independent-verdict-settles-without-replay-and-native-tab-stays-open',
      );
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
          browser: 'Chrome (user-confirmed)',
          facebookOperations: false,
          accountIdentity: 'fixture-only; not Facebook',
          checks,
          failures,
          evidence,
          passed: failures.length === 0 && checks.length === 5,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
