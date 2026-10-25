import type { CurrentTaskTabSource, TaskCycleRuntime } from '../domain/browse-execution.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type { Plan, Operation } from '../shared/task-contracts.js';
import { sameExecution, type Binding, type ExecutionSession } from '../shared/task-execution.js';
import { OwnedTabProof, type TabProof } from '../shared/kernel-state.js';
import type { ProfileActorRegistry } from './profile-actor-registry.js';

// The native source must independently return exact current owned proof. No guessed tab adoption.
export class TaskCycleHost implements TaskCycleRuntime {
  constructor(
    private readonly registry: ProfileActorRegistry,
    private readonly tabs: TaskTabRepository,
    private readonly source: CurrentTaskTabSource,
  ) {}
  async profiles() {
    return await this.registry.profiles();
  }
  async schedulingProfiles() {
    return await this.registry.schedulingProfiles();
  }
  async session(profileId: string) {
    return await this.registry.session(profileId);
  }
  send(operation: Operation & { binding: Binding }) {
    return this.registry.send(operation);
  }
  observe(profileId: string) {
    return this.registry.observe(profileId);
  }
  control(jobId: string, mode: 'pause' | 'stop', reason?: string) {
    return this.registry.control(jobId, mode, reason);
  }
  detach(profileId: string, expected: ExecutionSession, reason: string) {
    return this.registry.detach(profileId, expected, reason);
  }
  async preparePlan(plan: Plan, context: ExecutionSession, observedProof?: TabProof) {
    const proof = OwnedTabProof.parse(
      observedProof ?? (await this.source.currentTaskTab(plan, context)),
    );
    const current = await this.session(plan.profileId);
    if (!current || !sameExecution(current, context) || proof.profileId !== plan.profileId)
      throw Error('TASK_TAB_SOURCE_CONTEXT_CHANGED');
    const existing = (await this.tabs.forPlan(plan.id)).find((row) =>
      sameTabProof(row.proof, proof),
    );
    if (
      observedProof &&
      (!existing ||
        existing.state !== 'READY' ||
        !existing.context ||
        !sameExecution(existing.context, context))
    )
      throw Error('TASK_TAB_OBSERVATION_CHANGED');
    if (!existing) await this.tabs.register(plan.id, proof, context);
    else if (existing.state === 'RECHECK_REQUIRED')
      await this.tabs.confirmObserved(
        proof.ownershipId,
        existing.revision,
        proof,
        context,
        plan.id,
      );
    else if (
      existing.state !== 'READY' ||
      !existing.context ||
      !sameExecution(existing.context, context)
    )
      throw Error('TASK_TAB_SOURCE_PROOF_REJECTED');
  }
}
