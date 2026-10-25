import { filterAsync } from '../shared/async-collections.js';
import type { Core } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import { terminal } from '../domain/tasks.js';
import type { Plan } from '../shared/task-contracts.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { retainEndedMain } from '../domain/task-ending-tabs.js';

// Uses the original plan, journal and durable notification delivery. No page/input port.
export class TaskEndingCoordinator {
  private readonly pending = new Map<string, Promise<Plan>>();
  private readonly notifier: SettlementNotifier;
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly store: WorkspaceStore,
  ) {
    this.notifier = new SettlementNotifier(store.tasks.settlements);
  }
  end(planId: string): Promise<Plan> {
    const previous = this.pending.get(planId);
    if (previous) return previous;
    const work = this.run(planId);
    this.pending.set(planId, work);
    void work
      .finally(() => {
        if (this.pending.get(planId) === work) this.pending.delete(planId);
      })
      .catch(() => {});
    return work;
  }
  private async run(planId: string): Promise<Plan> {
    const plan = await this.store.tasks.get(planId);
    if (terminal(plan.state)) {
      await this.reconcileClosedTabs(plan);
      return plan;
    }
    const endingId = await this.store.tasks.requestEnd(planId);
    const proofs = (await this.store.taskTabs.forPlan(plan.id)).map((row) => row.proof);
    const peer = this.core.peers.get(plan.profileId);
    if (!peer?.online || !peer.synced || peer.phase !== 'PAUSED')
      throw Error('任务正在结束，等待浏览器连接并确认控制停止');
    if (!peer.capabilities?.includes('kernel-unknown-end-v1'))
      throw Error('结束未决任务需要更新桥接插件');
    let withdraw = proofs;
    // Physical stop is independent of the original historical STOP, which stays untouched.
    await this.kernel.withSummary(peer, async (port) => {
      const inventory = await port.inventory();
      withdraw = proofs.filter(
        (proof) => !retainEndedMain(proof, inventory, peer.capabilities ?? [], proofs.length),
      );
      const stop = await port.stopCurrent(endingId, withdraw);
      await this.store.tasks.prepareEnd(planId, stop);
    });
    const count = (await this.store.tasks.settlements.list(plan.profileId)).length;
    for (let i = 0; i < count; i++) {
      const sent = await this.kernel.withSummary(peer, (port) => this.notifier.flushOne(port));
      if (!sent) break; // Respect persisted retry backoff; never retry native business input.
    }
    const finished = await this.kernel.withSummary(
      peer,
      async (port) =>
        await this.store.tasks.finishEnd(planId, await port.stopCurrent(endingId, withdraw)),
    );
    await this.reconcileClosedTabs(finished);
    if ((await this.store.tasks.stepEnding(planId))?.finished)
      return await this.store.tasks.finishStepContinuation(planId);
    return finished;
  }
  private async reconcileClosedTabs(plan: Plan) {
    if (
      (!(await this.store.tasks.stepEnding(plan.id))?.finished &&
        plan.state !== 'FAILED' &&
        !(plan.state === 'STOPPED' && plan.controlConfirmed)) ||
      !(await this.store.tasks.endingId(plan.id))
    )
      return;
    const rows = (await this.store.taskTabs.forPlan(plan.id)).filter(
      (row) =>
        ['READY', 'RECHECK_REQUIRED'].includes(row.state) ||
        (row.state === 'LOST' &&
          row.reason === 'ENDED_OWNERSHIP_RELEASED' &&
          this.core.peers
            .get(plan.profileId)
            ?.capabilities?.includes('kernel-stopped-main-reobserve-v1')),
    );
    const peer = this.core.peers.get(plan.profileId);
    if (!rows.length || !peer?.online || !peer.synced || peer.phase !== 'PAUSED') return;
    const inventory = await this.kernel.withSummary(peer, (port) => port.inventory());
    for (const row of rows) {
      // Current physical closure is separate from the retained UNKNOWN business result.
      // Repository checks the exact original proof, finished end and delivered disposition.
      const native = inventory.tabs.find((tab) => tab.ownershipId === row.proof.ownershipId);
      if (native?.state === 'CLOSED' && native.proof && sameTabProof(native.proof, row.proof))
        await this.store.taskTabs.confirmClosed(
          row.proof.ownershipId,
          row.revision,
          inventory,
          plan.id,
        );
      else if (
        retainEndedMain(row.proof, inventory, peer.capabilities ?? [], rows.length) &&
        native?.state === 'READY' &&
        native.proof &&
        sameTabProof(native.proof, row.proof)
      )
        await this.store.taskTabs.confirmEndedReleased(
          row.proof.ownershipId,
          row.revision,
          inventory,
          plan.id,
        );
      else
        await this.store.taskTabs.confirmEndedLost(
          row.proof.ownershipId,
          row.revision,
          inventory,
          plan.id,
        );
    }
  }
  async resumePending(profileId: string): Promise<void> {
    // Stop/disposition recovery is permitted with business execution gates closed.
    const activeTabJobIds = new Set(
      (await this.store.taskTabs.activeForProfile(profileId)).map((row) => row.jobId),
    );
    await Promise.allSettled(
      [
        ...(await filterAsync(
          await this.store.tasks.plansForProfile(profileId, [
            'QUEUED',
            'RUNNING',
            'PAUSING',
            'PAUSED',
            'STOPPING',
            'REVIEW',
          ]),
          async (plan) => (await this.store.tasks.endingId(plan.id)) !== null,
        )),
        ...(activeTabJobIds.size
          ? await filterAsync(
              await this.store.tasks.plansForProfile(profileId, ['FAILED', 'STOPPED']),
              async (plan) =>
                activeTabJobIds.has(plan.id) &&
                (plan.state === 'FAILED' || (plan.state === 'STOPPED' && plan.controlConfirmed)) &&
                (await this.store.tasks.endingId(plan.id)) !== null,
            )
          : []),
      ]
        .slice(0, 2)
        .map((p) => this.end(p.id)),
    );
  }
}
