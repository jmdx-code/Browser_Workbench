import type { WorkspaceStorePort } from './persistence-port.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import { KernelFixtureTaskPort, type KernelConnection } from './kernel-fixture-task-port.js';
import { WorkspaceStore } from './workspace-store.js';
import { TaskDispatcher } from '../application/task-dispatcher.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import { sameTabProof } from '../domain/task-tabs.js';

// Opt-in local fixtures, isolated product DB per real profile, no production plans or FB actions.
export class KernelPersistenceAudit {
  private readonly attempted = new Set<string>();
  private disabled = false;
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
    private readonly output: string,
    private readonly associationAudit = false,
  ) {}
  disable(): void {
    this.disabled = true;
  }
  tick(): void {
    if (this.disabled) return;
    const ready = [...this.core.peers.values()].filter(
      (peer) =>
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED' &&
        peer.extensionVersion === '0.3.3' &&
        peer.capabilities?.includes('kernel-journal-v1'),
    );
    if (ready.length < 2) return;
    for (const peer of ready) {
      if (this.attempted.size >= 2) break;
      if (this.attempted.has(peer.profileId)) continue;
      this.attempted.add(peer.profileId);
      void this.run(peer).catch(() => {});
    }
  }
  private async run(initial: Peer): Promise<void> {
    await mkdir(this.output, { recursive: true });
    const file = path.join(
      this.output,
      `${this.associationAudit ? 'kernel-task-tab-live' : 'kernel-persistence-live'}-${initial.profileId}.json`,
    );
    try {
      await access(file);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const checks: string[] = [],
      failures: string[] = [];
    let connection: KernelConnection | undefined;
    let store: WorkspaceStorePort | undefined;
    const evidence: Record<string, unknown> = {};
    const directory = path.join(this.output, 'persistence-isolated-' + randomUUID());
    try {
      await mkdir(directory);
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      connection = await this.bridge.connect(initial);
      if (!connection.proof) throw Error('TAB_PROOF_MISSING');
      const owned = connection.proof;
      const page = connection.browser.contexts()[0]?.pages()[0];
      if (!page) throw Error('FIXTURE_PAGE_MISSING');
      const runtime: RuntimeProfile = {
        id: initial.profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: {
          state: 'logged-in',
          id: 'fixture-only-' + initial.profileId,
          name: null,
          avatar: null,
        },
      };
      const saved = await store.createCombination({
        name: '隔离SDK事务验收',
        note: '不是Facebook任务',
        steps: [
          { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: [runtime.id],
        },
        [runtime],
      );
      const plan = await store.tasks.claimNext([runtime], new Set(['video']));
      if (!plan) throw Error('ISOLATED_PLAN_NOT_CLAIMED');
      const step = (await store.tasks.steps(plan.id))[0];
      if (!step) throw Error('STEP_MISSING');
      const initialContext = await connection.context(runtime.account.id ?? '');
      if (!initialContext) throw Error('CURRENT_TAB_CONTEXT_MISSING');
      await store.taskTabs.register(plan.id, owned, initialContext);
      if (this.associationAudit) {
        const reopened = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
        try {
          const persisted = reopened.taskTabs.get(owned.ownershipId);
          if (
            persisted.jobId !== plan.id ||
            !sameTabProof(persisted.proof, owned) ||
            persisted.state !== 'READY'
          )
            throw Error('PLAN_TAB_PERSISTENCE_MISMATCH');
        } finally {
          reopened.close();
        }
        checks.push('plan-account-native-proof-association-persisted');
      }
      const action = {
        kind: 'click' as const,
        tabId: connection.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: '#counter' },
      };
      const id = randomUUID();
      await store.tasks.prepareOperation(plan.id, step.id, id, action);
      const dispatcher = new TaskDispatcher(
        store.tasks,
        new KernelFixtureTaskPort(connection, runtime, store.taskTabs),
      );
      await dispatcher.flushOne();
      const operation = (await store.tasks.operations(plan.id))[0];
      if (!operation?.binding || operation.status !== 'ACKNOWLEDGED')
        throw Error('BOUND_ACK_MISSING');
      if ((await store.tasks.steps(plan.id))[0]?.progress.likes !== 0)
        throw Error('ACK_ADVANCED_COUNTER');
      checks.push('outbox-to-sdk-to-extension-bound-ack-no-business-progress');
      const inventory = await connection.inventory();
      if (
        inventory.operations.find((row) => row.binding.operationId === id)?.state !== 'ACKNOWLEDGED'
      )
        throw Error('EXTENSION_SUMMARY_MISSING');
      checks.push('stable-operation-id-present-in-both-journals');
      const count = await page.locator('#count').innerText();
      if (count !== '1') throw Error('COUNTER_RESULT_MISMATCH');
      await dispatcher.verify(
        { binding: operation.binding, evidence: { fixtureCounter: count } },
        'VERIFIED',
        { ...step.progress, revision: 1, likes: 1 },
      );
      checks.push('independent-fixture-result-verified-once');
      const beforeDuplicate = connection.inputCalls;
      let duplicateRejected = false,
        callbackRan = false;
      try {
        await connection.execute(operation.binding, async () => {
          callbackRan = true;
          await page.locator('#counter').click();
        });
      } catch {
        duplicateRejected = true;
      }
      if (!duplicateRejected || callbackRan || connection.inputCalls !== beforeDuplicate)
        throw Error('DUPLICATE_OPERATION_REPLAYED');
      checks.push('duplicate-id-rejected-before-sdk-input');
      const previousTab = await store.taskTabs.get(owned.ownershipId);
      await store.taskTabs.requireRecheck(
        owned.ownershipId,
        previousTab.revision,
        'SDK_CONNECTION_CLOSED',
      );
      connection = await this.bridge.connect(initial, [], owned);
      const restoredPage = connection.browser.contexts()[0]?.pages()[0];
      if (!restoredPage || (await restoredPage.locator('#count').innerText()) !== '1')
        throw Error('OWNED_TAB_RECONCILIATION_FAILED');
      checks.push('exact-owned-proof-reconciled-without-url-adoption');
      const currentContext = await connection.context(runtime.account.id ?? '');
      if (!currentContext) throw Error('RECONNECTED_TAB_CONTEXT_MISSING');
      const pendingTab = await store.taskTabs.get(owned.ownershipId);
      if (pendingTab.state !== 'RECHECK_REQUIRED' || pendingTab.context !== null)
        throw Error('OLD_TAB_CONTEXT_RETAINED');
      await store.taskTabs.confirmObserved(
        owned.ownershipId,
        pendingTab.revision,
        owned,
        currentContext,
      );
      if (this.associationAudit)
        checks.push('new-sdk-lease-requires-matching-persisted-proof-confirmation');
      const second = randomUUID();
      await store.tasks.prepareOperation(plan.id, step.id, second, {
        ...action,
        target: { css: '#never-present' },
      });
      const waitingDispatcher = new TaskDispatcher(
        store.tasks,
        new KernelFixtureTaskPort(connection, runtime, store.taskTabs),
      );
      const waiting = waitingDispatcher.flushOne();
      let prepared = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (
          (await connection.inventory()).operations.some(
            (row) => row.binding.operationId === second && row.state === 'DISPATCHING',
          )
        ) {
          prepared = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!prepared) throw Error('WAITING_OPERATION_NOT_PERSISTED');
      const beforeStop = connection.inputCalls;
      const stopping = await store.tasks.requestControl(plan.id, 'pause');
      if (!stopping.controlRequestId) throw Error('CONTROL_REQUEST_MISSING');
      const receipt = await connection.close(stopping.controlRequestId);
      if (receipt.requestId !== stopping.controlRequestId || receipt.state !== 'stopped')
        throw Error('ACTUAL_CONTROL_RECEIPT_MISMATCH');
      await waiting;
      await store.tasks.confirmControl(plan.id, stopping.controlRequestId);
      const unknown = (await store.tasks.operations(plan.id)).find((row) => row.id === second);
      if (
        !unknown?.binding ||
        unknown.status !== 'UNKNOWN' ||
        (await store.tasks.get(plan.id)).state !== 'REVIEW'
      )
        throw Error('STOP_DID_NOT_RETAIN_UNCERTAINTY');
      if (connection.inputCalls !== beforeStop) throw Error('INPUT_AFTER_STOP');
      checks.push('matched-real-private-stop-retains-outbox-review');
      const stoppedTab = await store.taskTabs.get(owned.ownershipId);
      await store.taskTabs.requireRecheck(
        owned.ownershipId,
        stoppedTab.revision,
        'ACTUAL_EXECUTOR_STOPPED',
      );
      let peer = initial;
      try {
        connection = await this.bridge.connect(peer, [], owned);
      } catch (error) {
        evidence.reopenRequiredFreshParent = error instanceof Error ? error.message : 'UNKNOWN';
        peer.close();
        const reconnectDeadline = Date.now() + 40_000;
        while (Date.now() < reconnectDeadline) {
          const candidate = this.core.peers.get(initial.profileId);
          if (
            candidate &&
            candidate !== initial &&
            candidate.online &&
            candidate.synced &&
            candidate.phase === 'PAUSED'
          ) {
            peer = candidate;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        if (peer === initial) throw Error('FRESH_PAUSED_PARENT_MISSING');
        connection = await this.bridge.connect(peer, [], owned);
      }
      const observed = connection.browser.contexts()[0]?.pages()[0];
      if (!observed || (await observed.locator('#count').innerText()) !== '1' || beforeStop !== 0)
        throw Error('NOT_APPLIED_EVIDENCE_MISSING');
      const observedContext = await connection.context(runtime.account.id ?? '');
      if (!observedContext) throw Error('OBSERVED_TAB_CONTEXT_MISSING');
      const stoppedRecord = await store.taskTabs.get(owned.ownershipId);
      await store.taskTabs.confirmObserved(
        owned.ownershipId,
        stoppedRecord.revision,
        owned,
        observedContext,
      );
      const remoteUnknown = (await connection.inventory()).operations.find(
        (row) => row.binding.operationId === second,
      );
      if (remoteUnknown?.state !== 'UNKNOWN') throw Error('EXTENSION_UNCERTAINTY_MISSING');
      checks.push('extension-unknown-preserved-after-stop-and-reopen');
      const readEvidence = {
        fixtureCounter: '1',
        nativeInputsBeforeStop: beforeStop,
        nativeInputsAfterStop: 0,
      };
      await store.tasks.reconcileBound(
        { binding: unknown.binding, evidence: readEvidence },
        'NOT_APPLIED',
      );
      const resolution = {
        id: randomUUID(),
        outcome: 'NOT_APPLIED' as const,
        evidenceDigest: createHash('sha256').update(JSON.stringify(readEvidence)).digest('hex'),
      };
      await connection.reconcile(unknown.binding, resolution);
      const settled = (await connection.inventory()).operations.find(
        (row) => row.binding.operationId === second,
      );
      if (
        settled?.state !== 'RECONCILED' ||
        settled.resolution?.id !== resolution.id ||
        (await store.tasks.get(plan.id)).state !== 'PAUSED'
      )
        throw Error('EXPLICIT_RECONCILIATION_FAILED');
      checks.push('independent-not-applied-reconciliation-preserves-both-summaries');
      evidence.owned = owned;
      evidence.operationId = id;
      evidence.unknownOperationId = second;
      evidence.nativeInputsBeforeWaitingStop = beforeStop;
      evidence.controlRequestId = stopping.controlRequestId;
      evidence.isolatedFinalPlanState = (await store.tasks.get(plan.id)).state;
      await connection.close();
      if (this.associationAudit) {
        await store.taskTabs.recoverOnStartup();
        const restartRecord = await store.taskTabs.get(owned.ownershipId);
        if (
          restartRecord.state !== 'RECHECK_REQUIRED' ||
          restartRecord.context !== null ||
          !sameTabProof(restartRecord.proof, owned) ||
          (await store.tasks.get(plan.id)).state !== 'PAUSED'
        )
          throw Error('RECOVERY_RECLAIMED_OR_RESUMED');
        evidence.taskTabAfterExplicitRecovery = restartRecord;
        checks.push('explicit-service-recovery-retains-proof-and-does-not-resume');
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      await connection?.close().catch(() => {});
    } finally {
      await store?.close();
    }
    await writeFile(
      file,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          profileId: initial.profileId,
          extensionVersion: initial.extensionVersion,
          isolatedDirectory: directory,
          realBrowser: true,
          accountIdentity: 'fixture-only; not FB',
          facebookOperations: false,
          checks,
          failures,
          evidence,
          associationAudit: this.associationAudit,
          passed: checks.length === (this.associationAudit ? 11 : 8) && failures.length === 0,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
