import { flatMapAsync } from '../shared/async-collections.js';
import type { Awaitable } from '../domain/persistence.js';
import type { TaskRepository } from '../domain/tasks.js';
import type { ProfileActorSession, ProfileActorState } from '../domain/profile-actor.js';
import type { SettlementRepository } from '../domain/settlement.js';
import { evaluateKernelReadiness, type ReadinessIssue } from '../domain/kernel-readiness.js';
import { SettlementNotifier } from './settlement-notifier.js';
import {
  ExecutionContext,
  BoundReceipt,
  sameExecution,
  sameBinding,
  type Binding,
  type ExecutionSession,
  type ExecutionReceipt,
} from '../shared/task-execution.js';
import type { Operation } from '../shared/task-contracts.js';
import { canonicalAction } from '../shared/browser-actions.js';
import type { KernelState } from '../shared/kernel-state.js';

// Per-profile logical actor. It does not create plans, resume paused work or infer business results.
export class ProfileActor {
  private phase: ProfileActorState = 'BLOCKED';
  private reason = 'OBSERVATION_REQUIRED';
  private issues: ReadinessIssue[] = [];
  private permit: ExecutionSession | null = null;
  private revision = 0;
  private observing: Promise<KernelState | void> | undefined;
  private inFlight = false;
  private pending: Binding | null = null;
  private readonly notifier: SettlementNotifier;
  constructor(
    private readonly port: ProfileActorSession,
    private readonly tasks: TaskRepository,
    private readonly settlements: SettlementRepository,
  ) {
    this.notifier = new SettlementNotifier(settlements);
  }
  get profileId(): string {
    return this.port.profileId;
  }
  async status() {
    await this.session(); // A stale cached READY can never be reported as current.
    return {
      profileId: this.profileId,
      state: this.phase,
      reason: this.reason,
      issues: [...this.issues],
    };
  }
  private async current(): Promise<ExecutionSession | null> {
    const raw = await this.port.current(),
      profile = await this.port.profile();
    if (!raw) return null;
    const context = ExecutionContext.parse(raw);
    if (context.profileId !== this.profileId || profile.id !== this.profileId)
      throw Error('ACTOR_PROFILE_MISMATCH');
    if (
      !profile.online ||
      !profile.synced ||
      profile.unresolved ||
      !profile.dispatchAllowed ||
      profile.account.state !== 'logged-in' ||
      profile.account.id !== context.accountId
    )
      return null;
    return context;
  }
  private revoke(reason: string): void {
    this.revision++;
    this.permit = null;
    this.phase = 'BLOCKED';
    this.reason = reason;
  }
  revokeInput(reason: string): void {
    this.revoke(reason);
  }
  async invalidate(reason: string): Promise<void> {
    this.revoke(reason);
    if (this.pending) {
      const op = await this.operation(this.pending.operationId, this.pending.jobId);
      if (op && ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status))
        await this.tasks.markBoundUnknown(this.pending, reason);
    }
  }
  private async operations() {
    return await flatMapAsync(
      await this.tasks.plansForProfile(this.profileId, [
        'QUEUED',
        'RUNNING',
        'PAUSING',
        'PAUSED',
        'STOPPING',
        'REVIEW',
      ]),
      async (plan) => await this.tasks.operations(plan.id),
    );
  }
  private async operation(id: string, jobId: string) {
    return this.tasks.findOperation
      ? await this.tasks.findOperation(jobId, id)
      : (await this.tasks.operations(jobId)).find((op) => op.id === id);
  }
  async session(): Promise<ExecutionSession | null> {
    if (!this.permit) return null;
    const current = await this.current();
    if (!current || !sameExecution(current, this.permit)) {
      this.revoke('CONTEXT_CHANGED');
      return null;
    }
    if (this.phase === 'READY') return { ...this.permit };
    if (this.pending && ['DISPATCHING', 'AWAITING_VERIFICATION'].includes(this.phase)) {
      const op = await this.operation(this.pending.operationId, this.pending.jobId);
      if (op && ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status)) return { ...this.permit };
    }
    return null;
  }
  observe(): Promise<KernelState | void> {
    if (this.observing) return this.observing;
    const work = this.observeOnce();
    this.observing = work;
    void work
      .finally(() => {
        if (this.observing === work) this.observing = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async observeOnce(): Promise<KernelState | void> {
    if (this.inFlight) return;
    if (this.pending) {
      const op = await this.operation(this.pending.operationId, this.pending.jobId);
      if (op && ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status)) {
        if (!(await this.session())) await this.invalidate('CONTEXT_CHANGED_WITH_PENDING_RESULT');
        return;
      }
      if (op?.status === 'UNKNOWN') {
        this.revoke('BUSINESS_UNRESOLVED');
        return;
      }
      if (
        !op ||
        !(
          ['VERIFIED', 'FAILED'].includes(op.status) ||
          (op.status === 'CANCELLED' && op.action.kind === 'browseScroll')
        )
      ) {
        this.revoke('BUSINESS_RESULT_REQUIRED');
        return;
      }
      this.pending = null;
    }
    this.revoke('OBSERVATION_REQUIRED');
    const context = await this.current();
    if (!context) {
      this.reason = 'IDENTITY_OR_CHANNEL_REQUIRED';
      return;
    }
    const revision = this.revision;
    this.phase = 'OBSERVING';
    this.issues = [];
    try {
      await this.notifier.flushOne(this.port);
      const inventory = await this.port.inventory();
      const current = await this.current();
      if (revision !== this.revision || !current || !sameExecution(context, current)) {
        if (revision === this.revision) this.revoke('CONTEXT_CHANGED_DURING_OBSERVATION');
        return;
      }
      const result = evaluateKernelReadiness(
        this.profileId,
        inventory,
        await this.operations(),
        await this.settlements.list(this.profileId),
      );
      this.issues = result.issues;
      this.phase = result.ready ? 'READY' : 'BLOCKED';
      this.reason = result.ready ? 'CURRENT_SESSION_RECONCILED' : 'RECONCILIATION_REQUIRED';
      this.permit = result.ready ? context : null;
      if (result.ready) return inventory;
    } catch (error) {
      if (revision === this.revision)
        this.revoke(error instanceof Error ? error.message.slice(0, 200) : 'OBSERVATION_FAILED');
      throw error;
    }
  }
  async execute(
    operation: Operation & { binding: Binding },
    send: (assertCurrent: () => Awaitable<void>) => Promise<ExecutionReceipt>,
  ): Promise<ExecutionReceipt> {
    const context = await this.session(),
      binding = operation.binding,
      persisted = await this.operation(operation.id, binding.jobId);
    if (
      this.phase !== 'READY' ||
      this.pending ||
      this.inFlight ||
      !context ||
      !sameExecution(context, binding) ||
      !persisted?.binding ||
      !sameBinding(persisted.binding, binding) ||
      persisted.status !== 'DISPATCHING' ||
      operation.id !== binding.operationId ||
      operation.jobId !== binding.jobId ||
      operation.stepId !== binding.stepId ||
      canonicalAction(operation.action) !== canonicalAction(persisted.action)
    )
      throw Error('ACTOR_INPUT_NOT_READY');
    this.pending = binding;
    this.inFlight = true;
    this.phase = 'DISPATCHING';
    this.reason = 'INPUT_IN_FLIGHT';
    const revision = this.revision;
    const assertCurrent = async () => {
      const current = await this.session(),
        op = await this.operation(binding.operationId, binding.jobId);
      const plan = await this.tasks.get(binding.jobId);
      if (
        revision !== this.revision ||
        this.phase !== 'DISPATCHING' ||
        !this.inFlight ||
        !current ||
        !sameExecution(current, binding) ||
        !this.pending ||
        !sameBinding(this.pending, binding) ||
        op?.status !== 'DISPATCHING' ||
        plan.state !== 'RUNNING' ||
        plan.accountId !== binding.accountId
      )
        throw Error('ACTOR_INPUT_FENCED');
    };
    try {
      await assertCurrent();
      const receipt = BoundReceipt.parse(await send(assertCurrent));
      await assertCurrent();
      if (!sameBinding(receipt.binding, binding)) throw Error('ACTOR_RECEIPT_MISMATCH');
      this.phase = 'AWAITING_VERIFICATION';
      this.reason = 'BUSINESS_RESULT_REQUIRED';
      return receipt;
    } catch (error) {
      await this.invalidate(
        error instanceof Error ? error.message.slice(0, 200) : 'INPUT_RESULT_UNKNOWN',
      );
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}
