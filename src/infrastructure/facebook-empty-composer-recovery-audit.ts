import type { WorkspaceStorePort } from './persistence-port.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { KernelBridge } from './kernel-bridge.js';
import type { Core, Peer } from '../bridge/core.js';
import { WorkspaceStore } from './workspace-store.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import { sameExecution, sameBinding } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';

// Recovery of exactly this new diagnostic OPEN, based on a complete unsaturated native
// transport trace (no input dispatch) and independently fetched CLOSED + matching STOP.
// Not a generic UNKNOWN recovery API; the protected historical upload is never eligible.
export async function recoverUndispatchedEmptyComposer(
  kernel: KernelBridge,
  core: Core,
  peer: Peer,
  output: string,
) {
  const reportPath = path.join(output, 'facebook-empty-composer-no-input-recovery-0311.json');
  try {
    await writeFile(reportPath, JSON.stringify({ state: 'RUNNING', newPosts: 0 }), { flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }
  let failure: string | null = null;
  let store: WorkspaceStorePort | null = null;
  const evidence: Record<string, unknown> = {};
  try {
    const source = z
      .object({
        state: z.literal('FAILED_OR_BLOCKED'),
        reason: z.literal('EMPTY_COMPOSER_OPEN_ACK_REQUIRED'),
        profileId: z.literal('2b32bd78-51d0-4576-a12b-252c4d3c2d9b'),
        inputRPCs: z.literal(0),
        directory: z.string(),
        evidence: z.object({ planId: z.literal('beaef4ab-891f-4add-9762-8c3e6e025bed') }),
        trace: z
          .array(z.object({ at: z.number(), event: z.string() }))
          .min(1)
          .max(511),
      })
      .parse(
        JSON.parse(
          await readFile(
            path.join(output, 'facebook-managed-empty-composer-0311-live.json'),
            'utf8',
          ),
        ),
      );
    if (
      path.dirname(source.directory) !== path.resolve(output) ||
      !path.basename(source.directory).startsWith('facebook-admission-isolated-') ||
      source.trace.filter((t) => t.event === 'rpc:beginOperation').length !== 1 ||
      source.trace.at(-1)?.event !== 'rpc:stop' ||
      source.trace.some((t) =>
        /^rpc:send:(Input\.|DOM\.setFileInputFiles|Page\.bringToFront)/.test(t.event),
      )
    )
      throw Error('EMPTY_COMPOSER_COMPLETE_NO_INPUT_TRACE_REQUIRED');
    store = await WorkspaceStore.open(path.join(source.directory, 'workspace.sqlite'));
    const workspace = store;
    const plan = await workspace.tasks.get(source.evidence.planId);
    const operations = await workspace.tasks.operations(plan.id);
    const op = operations[0];
    const tab = (await workspace.taskTabs.forPlan(plan.id))[0];
    const control = (await workspace.taskControls.list()).find((c) => c.binding.jobId === plan.id);
    if (
      operations.length !== 1 ||
      op?.id !== '56465f19-7837-4d58-8b07-3349ddea11b9' ||
      op.status !== 'UNKNOWN' ||
      !op.binding ||
      op.action.kind !== 'click' ||
      (await workspace.materialPosts.link(op.id)).purpose !== 'OPEN_COMPOSER' ||
      !tab ||
      (await workspace.taskTabs.forPlan(plan.id)).length !== 1 ||
      !control?.receipt ||
      control.receipt.state !== 'stopped' ||
      control.receipt.requestId !== plan.controlRequestId ||
      !plan.controlConfirmed ||
      !sameExecution(control.receipt, op.binding) ||
      tab.proof.tabId !== op.action.tabId
    )
      throw Error('EMPTY_COMPOSER_EXACT_ORIGINAL_BINDING_REQUIRED');
    const binding = op.binding;
    const held = await workspace.materials.reservation(
      (await workspace.materialPosts.link(op.id)).attemptId,
    );
    const epoch = peer.epoch;
    await kernel.withSummary(peer, async (summary) => {
      if (core.peers.get(peer.profileId) !== peer || peer.epoch !== epoch)
        throw Error('RECOVERY_CONNECTION_CHANGED');
      const inventory = await summary.inventory();
      const native = inventory.operations.find((n) => n.binding.operationId === op.id);
      if (
        inventory.profileId !== source.profileId ||
        native?.state !== 'UNKNOWN' ||
        !sameBinding(native.binding, binding) ||
        !inventory.tabs.some(
          (t) => t.state === 'CLOSED' && t.proof && sameTabProof(t.proof, tab.proof),
        )
      )
        throw Error('EMPTY_COMPOSER_NATIVE_CLOSED_AND_ORIGINAL_UNKNOWN_REQUIRED');
      evidence.completeTrace = {
        count: source.trace.length,
        inputDispatches: 0,
        beginOperations: 1,
      };
      evidence.nativeClosed = inventory.tabs.find(
        (t) => t.proof && sameTabProof(t.proof, tab.proof),
      );
      evidence.originalStop = control;
      await workspace.materialPosts.reconcile({
        binding,
        evidence: {
          kind: 'material-post-verification',
          independent: true,
          attemptId: held.intent.attemptId,
          fingerprint: held.intent.fingerprint,
          purpose: 'OPEN_COMPOSER',
          proof: tab.proof,
          observedAccountId: binding.accountId,
          observationId: randomUUID(),
          checkedAt: new Date().toISOString(),
          outcome: 'NOT_APPLIED',
          basis: 'verified-action-not-applied',
          postId: null,
        },
      });
      await workspace.materialPosts.resolveNotPublished({
        kind: 'material-post-verification',
        independent: true,
        attemptId: held.intent.attemptId,
        fingerprint: held.intent.fingerprint,
        proof: tab.proof,
        observedAccountId: binding.accountId,
        observationId: randomUUID(),
        checkedAt: new Date().toISOString(),
        outcome: 'NOT_PUBLISHED',
        basis: 'independently-verified-not-published',
      });
      await new SettlementNotifier(workspace.tasks.settlements).flushOne(summary);
      if (
        (await workspace.tasks.settlements.list(peer.profileId)).some(
          (n) => n.state !== 'DELIVERED',
        )
      )
        throw Error('RECOVERY_NOTICE_UNCONFIRMED');
      await workspace.taskTabs.confirmClosed(tab.proof.ownershipId, tab.revision, inventory);
      evidence.operations = await workspace.tasks.operations(plan.id);
      evidence.plan = await workspace.tasks.get(plan.id);
      evidence.reservation = await workspace.materials.reservation(held.intent.attemptId);
      evidence.notifications = await workspace.tasks.settlements.list(peer.profileId);
      evidence.tabs = await workspace.taskTabs.forPlan(plan.id);
    });
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 200) : 'RECOVERY_FAILED';
  } finally {
    await store?.close();
  }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        state: failure ? 'FAILED_OR_BLOCKED' : 'PASSED',
        reason: failure,
        evidence,
        newPosts: 0,
        inputRPCs: 0,
        oldUnknownModified: false,
        managedPublisherAcceptance: false,
      },
      null,
      2,
    ),
  );
  if (failure) throw Error(failure);
}
