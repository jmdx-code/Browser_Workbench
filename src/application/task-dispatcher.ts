import type { TaskBrowserPort, TaskRepository } from '../domain/tasks.js';
import type { Progress } from '../shared/task-contracts.js';
import {
  BoundReceipt,
  ExecutionContext,
  sameBinding,
  sameExecution,
  type Binding,
  type ExecutionReceipt,
} from '../shared/task-execution.js';
import { devDiag } from '../shared/dev-diagnostics.js';
// Lifecycle owner enables this only after identity and every requested executor are ready.
export class TaskDispatcher {
  private readonly active = new Set<string>();
  private readonly selecting = new Set<string>();
  constructor(
    private readonly repository: TaskRepository,
    private readonly browser: TaskBrowserPort,
  ) {}
  private async current(binding: Binding): Promise<boolean> {
    const context = await this.browser.session(binding.profileId);
    const profile = this.browser.profile
      ? await this.browser.profile(binding.profileId)
      : (await this.browser.profiles()).find((row) => row.id === binding.profileId);
    return (
      context !== null &&
      sameExecution(ExecutionContext.parse(context), binding) &&
      profile?.online === true &&
      profile.synced &&
      profile.unresolved === 0 &&
      profile.dispatchAllowed &&
      profile.account.state === 'logged-in' &&
      profile.account.id === binding.accountId
    );
  }
  async flushOne(profileId?: string): Promise<boolean> {
    let profiles;
    if (
      profileId !== undefined &&
      this.browser.profile &&
      this.repository.reconcileProfileRuntime
    ) {
      const profile = await this.browser.profile(profileId);
      if (!profile) return false;
      await this.repository.reconcileProfileRuntime(profile);
      profiles = [profile];
    } else {
      profiles = await this.browser.profiles();
      await this.repository.reconcileRuntime(profiles);
    }
    for (const profile of profiles) {
      if (profileId !== undefined && profile.id !== profileId) continue;
      if (this.active.has(profile.id) || this.selecting.has(profile.id)) continue;
      this.selecting.add(profile.id);
      try {
        const context = await this.browser.session(profile.id);
        if (!context) continue;
        const parsed = ExecutionContext.parse(context);
        if (parsed.profileId !== profile.id) throw Error('EXECUTOR_PROFILE_MISMATCH');
        const operation = await this.repository.takeBoundOperation(parsed);
        if (!operation) continue;
        const binding = operation.binding;
        if (!binding) throw Error('DISPATCH_BINDING_MISSING');
        this.active.add(profile.id);
        const startedAt = Date.now();
        devDiag.record({
          level: 'INFO',
          category: 'BROWSER_ACTION',
          event: 'ACTION_DISPATCH_START',
          profileId: profile.id,
          planId: binding.jobId,
          stepId: binding.stepId,
          operationId: binding.operationId,
          actionKind: operation.action.kind,
          data: {
            tabId: 'tabId' in operation.action ? operation.action.tabId : undefined,
            url: 'url' in operation.action ? operation.action.url : undefined,
            deltaY: 'deltaY' in operation.action ? operation.action.deltaY : undefined,
          },
        });
        try {
          if (!(await this.current(binding))) throw Error('EXECUTION_CONTEXT_CHANGED');
          const receipt = BoundReceipt.parse(await this.browser.send({ ...operation, binding }));
          if (!sameBinding(receipt.binding, binding)) throw Error('EXECUTOR_RECEIPT_MISMATCH');
          if (!(await this.current(binding))) throw Error('EXECUTION_CONTEXT_CHANGED');
          await this.repository.acknowledgeBound(receipt);
          const durationMs = Date.now() - startedAt;
          devDiag.record({
            level: durationMs >= 1500 ? 'SLOW' : 'INFO',
            category: 'BROWSER_ACTION',
            event: 'ACTION_DISPATCH_DONE',
            profileId: profile.id,
            planId: binding.jobId,
            stepId: binding.stepId,
            operationId: binding.operationId,
            actionKind: operation.action.kind,
            durationMs,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'SEND_RESULT_UNKNOWN';
          const durationMs = Date.now() - startedAt;
          devDiag.record({
            level: 'ERROR',
            category: 'BROWSER_ACTION',
            event: 'ACTION_DISPATCH_ERROR',
            profileId: profile.id,
            planId: binding.jobId,
            stepId: binding.stepId,
            operationId: binding.operationId,
            actionKind: operation.action.kind,
            durationMs,
            reason,
          });
          // Input may have reached the browser; never resend or unlock on transport failure.
          await this.repository.markBoundUnknown(binding, reason);
        } finally {
          this.active.delete(profile.id);
        }
        return true;
      } finally {
        this.selecting.delete(profile.id);
      }
    }
    return false;
  }
  async verify(
    receipt: ExecutionReceipt,
    outcome: 'VERIFIED' | 'NOT_APPLIED',
    progress?: Progress,
  ): Promise<void> {
    const parsed = BoundReceipt.parse(receipt);
    if (!(await this.current(parsed.binding))) {
      await this.repository.markBoundUnknown(parsed.binding, 'EXECUTION_CONTEXT_CHANGED');
      throw Error('EXECUTION_CONTEXT_CHANGED');
    }
    await this.repository.settleBound(parsed, outcome, progress);
  }
}
