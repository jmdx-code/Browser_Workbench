import { flatMapAsync } from '../shared/async-collections.js';
import type { WorkspaceStorePort } from './persistence-port.js';
import { BusinessResolution } from '../shared/settlement.js';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { KernelConnection } from './kernel-fixture-task-port.js';
import { WorkspaceStore } from './workspace-store.js';
import { ProfileActor } from '../application/profile-actor.js';
import { ActorBrowserPort } from '../application/actor-browser-port.js';
import { TaskDispatcher } from '../application/task-dispatcher.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import type { GuardedBrowserPort } from '../domain/profile-actor.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { sameBinding } from '../shared/task-execution.js';

const ChromeProfile = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
const History = z
  .object({
    profileId: z.literal(ChromeProfile),
    passed: z.literal(true),
    facebookOperations: z.literal(false),
    isolatedDirectory: z.string(),
    evidence: z.object({ operationId: z.uuid() }).passthrough(),
  })
  .passthrough();
// Only a new actor/native-boundary test; no old audit runner or production task is launched.
export class KernelActorAudit {
  private attempted = false;
  private disabled = false;
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
    private readonly output: string,
  ) {}
  disable(): void {
    this.disabled = true;
  }
  tick(): void {
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
      console.error('Actor audit report failure', error),
    );
  }
  private async run(peer: Peer): Promise<void> {
    const file = path.join(this.output, `kernel-actor-live-${peer.profileId}.json`);
    try {
      await access(file);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const checks: string[] = [],
      failures: string[] = [],
      evidence: Record<string, unknown> = {},
      directory = path.join(this.output, 'actor-isolated-' + randomUUID());
    let connection: KernelConnection | undefined,
      store: WorkspaceStorePort | undefined,
      historyStore: WorkspaceStorePort | undefined;
    try {
      await mkdir(path.join(directory, 'history'), { recursive: true });
      const historical = History.parse(
        JSON.parse(
          await readFile(
            path.join(this.output, `kernel-persistence-live-${peer.profileId}.json`),
            'utf8',
          ),
        ) as unknown,
      );
      const relative = path.relative(this.output, historical.isolatedDirectory);
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !relative.startsWith('persistence-isolated-')
      )
        throw Error('HISTORICAL_DIRECTORY_REJECTED');
      const sourceFile = path.join(historical.isolatedDirectory, 'workspace.sqlite');
      evidence.historicalSource = sourceFile;
      evidence.historicalSha256 = createHash('sha256')
        .update(await readFile(sourceFile))
        .digest('hex');
      const source = new DatabaseSync(sourceFile, { readOnly: true });
      try {
        await backup(source, path.join(directory, 'history/workspace.sqlite'));
      } finally {
        source.close();
      }
      historyStore = await WorkspaceStore.open(path.join(directory, 'history/workspace.sqlite'));
      const prior = (
        await flatMapAsync(
          await historyStore.tasks.list(),
          async (plan) => (await historyStore?.tasks.operations(plan.id)) ?? [],
        )
      ).find((op) => op.id === historical.evidence.operationId);
      if (prior?.status !== 'VERIFIED' || !prior.binding) throw Error('HISTORICAL_VERDICT_MISSING');
      const notice = await historyStore.tasks.settlements.ensureSettled(prior.binding);
      const historyRepository = historyStore;
      await this.bridge.withSummary(peer, async (port) => {
        const remote = (await port.inventory()).operations.find(
          (op) => op.binding.operationId === prior.id,
        );
        if (remote?.state !== 'ACKNOWLEDGED' || !sameBinding(remote.binding, notice.binding))
          throw Error('HISTORICAL_ACK_MISMATCH');
        await new SettlementNotifier(historyRepository.tasks.settlements).flushOne(port);
        if (
          (await historyRepository.tasks.settlements.list(peer.profileId))[0]?.state !== 'DELIVERED'
        )
          throw Error('HISTORICAL_NOTICE_NOT_CONFIRMED');
      });
      evidence.historicalOperationId = prior.id;
      evidence.historicalNotice = notice;
      checks.push(
        'known-historical-ACK-reconciled-from-readonly-business-evidence-without-replaying-input',
      );
      await historyStore.close();
      historyStore = undefined;
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
          id: 'actor-fixture-only-' + peer.profileId,
          name: null,
          avatar: null,
        },
      };
      const accountId = runtime.account.id;
      if (!accountId) throw Error('FIXTURE_ACCOUNT_MISSING');
      const actor = new ProfileActor(
        {
          profileId: peer.profileId,
          profile: () => runtime,
          current: async () => await initial.context(accountId),
          inventory: () => initial.inventory(),
          notify: (binding, resolution) =>
            initial.reconcile(binding, BusinessResolution.parse(resolution)),
        },
        repository.tasks,
        repository.tasks.settlements,
      );
      await actor.observe();
      if ((await actor.status()).state !== 'READY')
        throw Error('ACTOR_NOT_READY_AFTER_TRUSTED_RECONCILIATION');
      const saved = await repository.createCombination({
        name: '资料actor原生边界隔离测试',
        note: '不是FB',
        steps: [
          { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 },
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
      const native: GuardedBrowserPort = {
        profiles: () => [runtime],
        session: async () => await initial.context(accountId),
        send: async () => {
          throw Error('UNGUARDED_AUDIT_SEND_FORBIDDEN');
        },
        sendGuarded: async (operation, guard) => {
          await repository.taskTabs.assertForInput(operation.binding, proof);
          const result = await initial.execute(
            operation.binding,
            async () => {
              await actor.invalidate('AUDIT_REVOKE_AFTER_BEGIN_BEFORE_SDK_INPUT');
              // Real SDK performs its asynchronous locator work; its Input command must hit the software fence.
              await page.locator('#counter').click({ timeout: 2000 });
            },
            guard,
          );
          return { binding: result.binding, evidence: { sdkReturned: true } };
        },
      };
      const browser = new ActorBrowserPort(native, [actor]);
      const plan = await repository.tasks.claimNext(
        await browser.schedulingProfiles(),
        new Set(['video']),
      );
      if (!plan) throw Error('ISOLATED_PLAN_NOT_CLAIMED');
      const step = (await repository.tasks.steps(plan.id))[0],
        context = await initial.context(accountId);
      if (!step || !context) throw Error('CURRENT_FIXTURE_CONTEXT_MISSING');
      await repository.taskTabs.register(plan.id, proof, context);
      checks.push('real-current-lease-actor-readiness-and-plan-tab-proof-enable-isolated-dispatch');
      const operationId = randomUUID();
      await repository.tasks.prepareOperation(plan.id, step.id, operationId, {
        kind: 'click',
        tabId: initial.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: '#counter' },
      });
      await new TaskDispatcher(repository.tasks, browser).flushOne();
      const operation = (await repository.tasks.operations(plan.id))[0];
      const trace = this.bridge.diagnostics(peer.profileId);
      evidence.nativeFenceTrace = trace;
      if (
        initial.inputCalls !== 0 ||
        !trace.some((row) => row.event === 'actor-input-fenced') ||
        operation?.status !== 'UNKNOWN' ||
        !operation.binding ||
        (await actor.session()) !== null
      )
        throw Error('ACTOR_NATIVE_FENCE_NOT_PROVEN');
      evidence.operationId = operationId;
      evidence.nativeInputCalls = initial.inputCalls;
      checks.push('actor-revocation-after-persisted-begin-fences-real-SDK-native-input');
      const previous = await repository.taskTabs.get(proof.ownershipId);
      await repository.taskTabs.requireRecheck(
        proof.ownershipId,
        previous.revision,
        'SDK_CONNECTION_CLOSED',
      );
      connection = await this.bridge.connect(peer, [], proof);
      const restored = connection,
        nextContext = await restored.context(accountId),
        restoredPage = restored.browser.contexts()[0]?.pages()[0];
      if (
        !restored.proof ||
        !sameTabProof(proof, restored.proof) ||
        !nextContext ||
        !restoredPage ||
        (await restoredPage.locator('#count').innerText()) !== '0'
      )
        throw Error('NATIVE_COUNTER_OR_PROOF_CHANGED');
      const current = await repository.taskTabs.get(proof.ownershipId);
      await repository.taskTabs.confirmObserved(
        proof.ownershipId,
        current.revision,
        proof,
        nextContext,
      );
      const remote = (await restored.inventory()).operations.find(
        (op) => op.binding.operationId === operationId,
      );
      if (remote?.state !== 'UNKNOWN' || !sameBinding(remote.binding, operation.binding))
        throw Error('REMOTE_UNKNOWN_NOT_RETAINED');
      checks.push(
        'same-native-proof-counter-zero-and-both-unknown-journals-independently-observed',
      );
      const control = await repository.tasks.requestControl(plan.id, 'stop');
      if (!control.controlRequestId) throw Error('CONTROL_ID_MISSING');
      const stopped = await restored.close(control.controlRequestId);
      connection = undefined;
      if (stopped.requestId !== control.controlRequestId || stopped.state !== 'stopped')
        throw Error('REAL_STOP_MISMATCH');
      await repository.tasks.confirmControl(plan.id, stopped.requestId);
      if ((await repository.tasks.get(plan.id)).state !== 'REVIEW')
        throw Error('UNKNOWN_RELEASED_ON_STOP');
      evidence.controlRequestId = stopped.requestId;
      checks.push('matching-real-stop-retains-review-until-independent-business-verdict');
      await repository.tasks.reconcileBound(
        {
          binding: operation.binding,
          evidence: {
            observedNativeCounter: '0',
            inputCalls: 0,
            controlRequestId: stopped.requestId,
          },
        },
        'NOT_APPLIED',
      );
      await this.bridge.withSummary(peer, async (port) => {
        await new SettlementNotifier(repository.tasks.settlements).flushOne(port);
      });
      const delivered = (await repository.tasks.settlements.list(peer.profileId))[0];
      if (
        delivered?.state !== 'DELIVERED' ||
        delivered.resolution.outcome !== 'NOT_APPLIED' ||
        (await repository.tasks.get(plan.id)).state !== 'STOPPED' ||
        (await repository.tasks.steps(plan.id))[0]?.progress.likes !== 0
      )
        throw Error('INDEPENDENT_NOT_APPLIED_SETTLEMENT_FAILED');
      evidence.finalPlanState = (await repository.tasks.get(plan.id)).state;
      evidence.deliveredNotice = delivered;
      checks.push(
        'independent-not-applied-verdict-and-notification-finish-without-input-replay-or-business-count',
      );
      if (
        createHash('sha256')
          .update(await readFile(sourceFile))
          .digest('hex') !== evidence.historicalSha256
      )
        throw Error('HISTORICAL_DATABASE_CHANGED');
      checks.push('historical-database-remains-unchanged-and-fixture-plans-stay-isolated');
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      await connection?.close().catch(() => {});
      await store?.close();
      await historyStore?.close();
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
          faultInjection:
            'actor revoked synchronously after actual begin persisted and before SDK locator input',
          checks,
          failures,
          evidence,
          passed: failures.length === 0 && checks.length === 7,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
