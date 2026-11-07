import { createHash, randomUUID } from 'node:crypto';
import type { Peer } from '../bridge/core.js';
import type { WorkspaceStorePort } from './persistence-port.js';
import type { KernelSummaryPort } from './kernel-bridge.js';
import type { KernelState } from '../shared/kernel-state.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import { taskTimingEligibility } from '../domain/task-timing.js';

/** End obsolete runs; never restore their page input. All receipts are retained
 * in the existing repositories before the extension copy can be collected. */
export async function retireClosedKernelSession(
  repository: WorkspaceStorePort,
  peer: Peer,
  port: KernelSummaryPort,
  inventory: KernelState,
  controllerStartedAt: number,
): Promise<void> {
  const browserRestarted = Boolean(inventory.previousBrowserSessionEpoch);
  const cutoff = Math.max(
    controllerStartedAt,
    browserRestarted ? (inventory.browserSessionStartedAt ?? 0) : 0,
  );
  const plans = (
    await repository.tasks.plansForProfile(peer.profileId, [
      'QUEUED',
      'RUNNING',
      'PAUSING',
      'PAUSED',
      'STOPPING',
      'REVIEW',
    ])
  )
    .filter((p) => !['COMPLETED', 'FAILED', 'STOPPED'].includes(p.state) && p.createdAt < cutoff)
    .filter(
      (p) =>
        !(p.timing && !p.timingReleased && taskTimingEligibility(p.timing, Date.now()) === 'WAIT'),
    );
  const notifier = new SettlementNotifier(repository.tasks.settlements);
  // Deliver already committed business results first. Retiring control must not
  // replace a known successful publication with an unknown result.
  const pendingNotices = () =>
    repository.tasks.settlements.listForReconciliation
      ? repository.tasks.settlements.listForReconciliation(peer.profileId, [])
      : repository.tasks.settlements.list(peer.profileId);
  let notices = await pendingNotices();
  for (let i = 0; i < notices.length; i++)
    if (!(await notifier.flushOne(port, { kind: 'BUSINESS' }))) break;
  for (const original of plans) {
    const controlled = await repository.tasks.requestControl(
      original.id,
      'stop',
      'EXECUTION_INTERRUPTED',
    );
    if (['STOPPED', 'FAILED', 'COMPLETED'].includes(controlled.state)) continue;
    await repository.tasks.cancelStepContinuation(original.id);
    const endingId = await repository.tasks.requestEnd(original.id);
    const stop = await port.stopCurrent(endingId);
    await repository.tasks.prepareEnd(original.id, stop);
    notices = await pendingNotices();
    for (let i = 0; i < notices.length; i++)
      if (!(await notifier.flushOne(port, { kind: 'END' }))) break;
    await repository.tasks.finishEnd(original.id, stop);
  }
  const remaining = await port.inventory();
  for (const native of remaining.operations) {
    if (!kernelOperationPending(native)) continue;
    const b = native.binding;
    const bumper = await repository.groupBumper.getOperation(b.operationId);
    const poster = await repository.groupPoster.getOperation(b.operationId);
    if (!native.executionEnded && !(poster && poster.createdAt < controllerStartedAt)) continue;
    let resolution = bumper?.resolution ??
      poster?.resolution ?? {
        id: randomUUID(),
        outcome: 'ENDED_UNKNOWN' as const,
        evidenceDigest: createHash('sha256')
          .update(
            JSON.stringify({
              binding: b,
              browserSessionEpoch: inventory.browserSessionEpoch,
              reason: 'PREVIOUS_BROWSER_EXECUTION_ENDED',
            }),
          )
          .digest('hex'),
      };
    if (bumper)
      resolution = await repository.groupBumper.setOperationResolution(b.operationId, resolution);
    if (poster)
      resolution = await repository.groupPoster.setOperationResolution(b.operationId, resolution);
    await port.notify(b, resolution);
    if (bumper) await repository.groupBumper.markOperationSettled(b.operationId);
    if (poster) await repository.groupPoster.markOperationKernelSettled(b.operationId);
  }
  const settled = await port.inventory();
  if (!settled.operations.some(kernelOperationPending)) {
    for (const tab of await repository.taskTabs.activeForProfile(peer.profileId)) {
      const plan = await repository.tasks.get(tab.jobId);
      if (
        !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state) ||
        !(await repository.tasks.endingId(plan.id))
      )
        continue;
      const native = settled.tabs.find((t) => t.ownershipId === tab.proof.ownershipId);
      if (native?.state === 'READY')
        await repository.taskTabs.confirmEndedReleased(
          tab.proof.ownershipId,
          tab.revision,
          settled,
          tab.jobId,
        );
      else
        await repository.taskTabs.confirmEndedLost(
          tab.proof.ownershipId,
          tab.revision,
          settled,
          tab.jobId,
        );
    }
  }
}
