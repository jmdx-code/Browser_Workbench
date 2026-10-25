import { mapAsync } from '../shared/async-collections.js';
import type { WorkspaceStorePort } from './persistence-port.js';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import { WorkspaceStore } from './workspace-store.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import { evaluateKernelReadiness } from '../domain/kernel-readiness.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameNotice, type NoticeReceipt } from '../shared/settlement.js';

const HistoricalEvidence = z
  .object({
    profileId: z.uuid(),
    extensionVersion: z.literal('0.3.3'),
    realBrowser: z.literal(true),
    facebookOperations: z.literal(false),
    passed: z.literal(true),
    isolatedDirectory: z.string(),
    evidence: z.object({ operationId: z.uuid() }).passthrough(),
  })
  .passthrough();
async function businessSnapshot(store: WorkspaceStorePort, profileId: string) {
  return await mapAsync(
    (await store.tasks.list()).filter((plan) => plan.profileId === profileId),
    async (plan) => ({
      plan,
      steps: await store.tasks.steps(plan.id),
      operations: await store.tasks.operations(plan.id),
    }),
  );
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Opt-in, bounded real-summary audit. Historical evidence is copied, never imported into production.
export class KernelStartupAudit {
  private readonly attempted = new Set<string>();
  private disabled = false;
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
    private readonly production: WorkspaceStorePort,
    private readonly output: string,
  ) {}
  disable(): void {
    this.disabled = true;
  }
  tick(): void {
    if (this.disabled) return;
    const peers = [...this.core.peers.values()].filter(
      (peer) =>
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED' &&
        peer.extensionVersion === '0.3.3' &&
        peer.capabilities?.includes('kernel-journal-v1'),
    );
    if (peers.length < 2) return;
    for (const peer of peers) {
      if (this.attempted.size >= 2) break;
      if (this.attempted.has(peer.profileId)) continue;
      this.attempted.add(peer.profileId);
      void this.run(peer).catch((error: unknown) =>
        console.error('Startup audit report failure', error),
      );
    }
  }
  private async run(peer: Peer): Promise<void> {
    await mkdir(this.output, { recursive: true });
    const file = path.join(this.output, `kernel-startup-live-${peer.profileId}.json`);
    try {
      await access(file);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const checks: string[] = [],
      failures: string[] = [],
      evidence: Record<string, unknown> = {},
      traces: ReturnType<KernelBridge['diagnostics']>[] = [];
    let isolated: WorkspaceStorePort | undefined;
    const directory = path.join(this.output, 'startup-isolated-' + randomUUID());
    try {
      const canonicalBefore = digest(await businessSnapshot(this.production, peer.profileId));
      const historical = HistoricalEvidence.parse(
        JSON.parse(
          await readFile(
            path.join(this.output, `kernel-task-tab-live-${peer.profileId}.json`),
            'utf8',
          ),
        ) as unknown,
      );
      if (historical.profileId !== peer.profileId) throw Error('HISTORICAL_PROFILE_MISMATCH');
      const relative = path.relative(this.output, historical.isolatedDirectory);
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !relative.startsWith('persistence-isolated-')
      )
        throw Error('HISTORICAL_DIRECTORY_REJECTED');
      await mkdir(directory);
      const source = new DatabaseSync(path.join(historical.isolatedDirectory, 'workspace.sqlite'), {
        readOnly: true,
      });
      try {
        if (source.prepare('PRAGMA user_version').get()?.user_version !== 4)
          throw Error('HISTORICAL_SCHEMA_CHANGED');
        evidence.sourceDatabaseSha256 = createHash('sha256')
          .update(await readFile(path.join(historical.isolatedDirectory, 'workspace.sqlite')))
          .digest('hex');
        await backup(source, path.join(directory, 'workspace.sqlite'));
      } finally {
        source.close();
      }
      isolated = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const snapshot = await businessSnapshot(isolated, peer.profileId),
        operation = snapshot
          .flatMap((row) => row.operations)
          .find((op) => op.id === historical.evidence.operationId);
      if (operation?.status !== 'VERIFIED' || !operation.binding || !operation.receipt)
        throw Error('HISTORICAL_BUSINESS_VERDICT_MISSING');
      const binding = operation.binding,
        originalBusiness = digest(snapshot);
      evidence.operationId = operation.id;
      checks.push('readonly-historical-verdict-copied-to-schema5-without-production-import');
      const notice = await isolated.tasks.settlements.ensureSettled(binding);
      evidence.notice = { binding: notice.binding, resolution: notice.resolution };
      const notifier = new SettlementNotifier(isolated.tasks.settlements);
      let committed: NoticeReceipt | undefined;
      const first = await this.bridge.withSummary(peer, async (port) => {
        const remote = await port.inventory();
        const canonicalOperations = (
          await businessSnapshot(this.production, peer.profileId)
        ).flatMap((row) => row.operations);
        const readiness = evaluateKernelReadiness(
          peer.profileId,
          remote,
          canonicalOperations,
          await this.production.tasks.settlements.list(peer.profileId),
        );
        if (
          readiness.ready ||
          !readiness.issues.some((issue) => issue.reason === 'ORPHAN_OPERATION')
        )
          throw Error('ORPHAN_AUDIT_SUMMARY_DID_NOT_BLOCK');
        checks.push('canonical-orphan-summary-blocks-readiness-without-guessing-business-result');
        const prior = remote.operations.find((op) => op.binding.operationId === operation.id);
        if (prior?.state !== 'ACKNOWLEDGED' || !sameBinding(prior.binding, binding))
          throw Error('HISTORICAL_ACK_BINDING_MISMATCH');
        await notifier.flushOne({
          profileId: peer.profileId,
          notify: async (input, resolution) => {
            committed = await port.notify(input, resolution);
            throw Error('AUDIT_REPLY_DROPPED_AFTER_REAL_REMOTE_RECONCILIATION');
          },
        });
        return { readiness, remote: await port.inventory() };
      });
      traces.push(this.bridge.diagnostics(peer.profileId));
      evidence.canonicalReadinessBefore = first.readiness;
      if (!committed || !sameNotice(notice, committed))
        throw Error('REMOTE_NOTIFICATION_NOT_COMMITTED');
      const pending = (await isolated.tasks.settlements.list(peer.profileId))[0];
      if (pending?.state !== 'PENDING' || pending.attempts !== 1 || !sameNotice(notice, pending))
        throw Error('LOST_REPLY_NOT_PERSISTED');
      checks.push(
        'real-remote-reconciliation-followed-by-injected-reply-loss-retains-same-pending-notice',
      );
      await isolated.close();
      isolated = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      await isolated.tasks.settlements.recoverOnStartup();
      await delay(Math.max(0, pending.nextAttemptAt - Date.now()) + 50);
      const reopened = isolated;
      const second = await this.bridge.withSummary(peer, async (port) => {
        const remote = await port.inventory();
        const existing = remote.operations.find((op) => op.binding.operationId === operation.id);
        if (
          existing?.state !== 'RECONCILED' ||
          !existing.resolution ||
          !sameNotice(notice, { binding: existing.binding, resolution: existing.resolution })
        )
          throw Error('REOPENED_REMOTE_RESULT_MISMATCH');
        if (!(await new SettlementNotifier(reopened.tasks.settlements).flushOne(port)))
          throw Error('NOTIFICATION_RETRY_NOT_CLAIMED');
        return await port.inventory();
      });
      traces.push(this.bridge.diagnostics(peer.profileId));
      const delivered = (await isolated.tasks.settlements.list(peer.profileId))[0];
      if (
        delivered?.state !== 'DELIVERED' ||
        delivered.attempts !== 2 ||
        !sameNotice(notice, delivered)
      )
        throw Error('RETRY_DELIVERY_MISMATCH');
      evidence.deliveredNotice = delivered;
      checks.push(
        'software-store-reopened-and-new-summary-lease-retries-identical-notification-idempotently',
      );
      if (digest(await businessSnapshot(isolated, peer.profileId)) !== originalBusiness)
        throw Error('NOTIFICATION_CHANGED_BUSINESS_PROGRESS');
      checks.push('notification-retry-preserves-original-business-checkpoint-and-operation-count');
      if (
        digest(await businessSnapshot(this.production, peer.profileId)) !== canonicalBefore ||
        (await this.production.tasks.settlements.list(peer.profileId)).length
      )
        throw Error('AUDIT_MUTATED_PRODUCTION_TASKS');
      evidence.canonicalReadinessAfter = evaluateKernelReadiness(
        peer.profileId,
        second,
        (await businessSnapshot(this.production, peer.profileId)).flatMap((row) => row.operations),
        await this.production.tasks.settlements.list(peer.profileId),
      );
      checks.push('production-plans-and-notices-unchanged-and-other-orphans-remain-visible');
      const allowed = new Set([
        'rpc:open',
        'rpc:inventory',
        'rpc:renew',
        'rpc:reconcileOperation',
        'rpc:stop',
      ]);
      if (
        traces.length !== 2 ||
        traces.some(
          (trace) =>
            trace.some((row) => !allowed.has(row.event)) ||
            trace.filter((row) => row.event === 'rpc:stop').length !== 1,
        )
      )
        throw Error('SUMMARY_PATH_USED_UNEXPECTED_RPC');
      evidence.nativeInputCalls = 0;
      evidence.debuggerAttachCalls = 0;
      evidence.pageCreationCalls = 0;
      checks.push(
        'both-real-summary-sessions-use-only-allowed-rpc-and-matched-stop-no-page-or-native-input',
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      await isolated?.close();
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
          facebookOperations: false,
          checks,
          failures,
          evidence,
          traces,
          faultInjection:
            'software discards notification receipt after actual remote reconcile and inventory; no network-loss or browser-restart claim',
          passed: failures.length === 0 && checks.length === 7,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
