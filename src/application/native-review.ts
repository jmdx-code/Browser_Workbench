import type { Awaitable } from '../domain/persistence.js';
import { flatMapAsync, someAsync, mapAsync } from '../shared/async-collections.js';
import type { TaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import {
  KernelPersistentState,
  kernelOperationPending,
  type KernelState,
} from '../shared/kernel-state.js';
import { sameBinding } from '../shared/task-execution.js';
import {
  NativeReviewReport,
  NativeReviewReportV2,
  NativeReviewRequest,
  type NativeReview,
  type NativeReviewV2,
} from '../shared/native-review.js';
import type { Binding } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';

export interface NativeReviewPort {
  read(profileId: string): Promise<KernelState>;
  releaseIdle?(
    profileId: string,
    assertIdle: () => Awaitable<void>,
    assertHistorical?: (binding: Binding) => Awaitable<void>,
  ): Promise<{ released: number; endedOperations?: number }>;
}
// Reads preserve the original journal. Explicit recovery ends orphan attempts administratively,
// never settles business results, retries inputs, or bypasses associated software tasks.
export class NativeReviewService {
  private readonly active = new Map<
    string,
    { current: Promise<NativeReviewV2>; legacy: Promise<NativeReview> }
  >();
  constructor(
    private readonly port: NativeReviewPort,
    private readonly tasks: TaskRepository,
  ) {}
  async releaseIdle(input: unknown) {
    const { profileId } = NativeReviewRequest.parse(input);
    const idle = async () => {
      if (
        await this.tasks.hasProfilePlanInStates(profileId, [
          'QUEUED',
          'RUNNING',
          'PAUSING',
          'PAUSED',
          'STOPPING',
          'REVIEW',
        ])
      )
        throw new ProductError(
          'NATIVE_REVIEW_BUSY',
          '请先停止这份浏览器的任务，再结束遗留占用',
          409,
        );
    };
    await idle();
    const retained = await this.tasks.retainedTaskPage?.(profileId);
    if (retained) {
      const current = KernelPersistentState.parse(await this.port.read(profileId));
      const main = current.workspaceMain ?? retained;
      await idle();
      if (
        current.profileId === profileId &&
        !current.operations.some(kernelOperationPending) &&
        current.tabs.every(
          (tab) =>
            ['CLOSED', 'LOST'].includes(tab.state) ||
            (tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, main)),
        )
      )
        return { released: 0, endedOperations: 0 };
      // Keeping the main page does not prevent ending unrelated, stopped orphan control.
      // The original-task check below still rejects every associated software operation.
    }
    if (!this.port.releaseIdle)
      throw new ProductError('NATIVE_RELEASE_UNAVAILABLE', '此版本尚不支持结束遗留占用', 409);
    const result = await this.port.releaseIdle(profileId, idle, async (binding) => {
      await idle();
      const hasTask = this.tasks.hasPlanOrOperation
        ? await this.tasks.hasPlanOrOperation(binding.jobId, binding.operationId)
        : await someAsync(
            await this.tasks.list(),
            async (plan) =>
              plan.id === binding.jobId ||
              (await this.tasks.operations(plan.id)).some((op) => op.id === binding.operationId),
          );
      if (binding.profileId !== profileId || hasTask)
        throw new ProductError(
          'NATIVE_ORIGINAL_TASK_REQUIRED',
          '此操作有关联任务，请从原任务记录结束，避免跳过原资源和通知结算',
          409,
        );
    });
    await idle();
    const final = KernelPersistentState.parse(await this.port.read(profileId));
    await idle();
    if (
      final.profileId !== profileId ||
      final.operations.some(kernelOperationPending) ||
      final.tabs.some(
        (tab) =>
          !['CLOSED', 'LOST'].includes(tab.state) &&
          !(
            tab.state === 'READY' &&
            tab.proof &&
            final.workspaceMain &&
            sameTabProof(tab.proof, final.workspaceMain)
          ),
      )
    )
      throw new ProductError(
        'NATIVE_RELEASE_UNCONFIRMED',
        '仍有遗留状态未结束，未报告恢复成功；请查看任务诊断',
        409,
      );
    return result;
  }
  read(input: unknown, contract?: '1'): Promise<NativeReview>;
  read(input: unknown, contract: '2'): Promise<NativeReviewV2>;
  read(input: unknown, contract: '1' | '2' = '1') {
    const { profileId } = NativeReviewRequest.parse(input),
      pending = this.active.get(profileId);
    if (pending) return contract === '2' ? pending.current : pending.legacy;
    const work = this.readOnce(profileId);
    const legacy = work.then((value) => {
      const { version: _version, browserSessionEpoch: _epoch, ...report } = value;
      return NativeReviewReport.parse(report);
    });
    const entry = { current: work, legacy };
    this.active.set(profileId, entry);
    void legacy.catch(() => {});
    void work
      .finally(() => {
        if (this.active.get(profileId) === entry) this.active.delete(profileId);
      })
      .catch(() => {});
    return contract === '2' ? work : legacy;
  }
  private async readOnce(profileId: string) {
    const idle = async () => {
      if (await this.tasks.hasProfilePlanInStates(profileId, ['RUNNING', 'PAUSING', 'STOPPING']))
        throw new ProductError('NATIVE_REVIEW_BUSY', '请先暂停任务并等待浏览器停止确认', 409);
    };
    await idle();
    const inventory = KernelPersistentState.parse(await this.port.read(profileId));
    await idle();
    if (inventory.profileId !== profileId) throw Error('NATIVE_REVIEW_PROFILE_MISMATCH');
    const unresolved = inventory.operations.filter((op) => op.state !== 'RECONCILED');
    const slicedUnresolved = unresolved.slice(-100).reverse();
    let fallbackOriginals:
      | Array<{
          plan: Awaited<ReturnType<TaskRepository['get']>>;
          op: Awaited<ReturnType<TaskRepository['operations']>>[number];
        }>
      | undefined;
    const findOriginal = async (nativeBinding: Binding) => {
      if (this.tasks.findOperation) {
        try {
          const op = await this.tasks.findOperation(nativeBinding.jobId, nativeBinding.operationId);
          if (op?.binding && sameBinding(op.binding, nativeBinding)) {
            const plan = await this.tasks.get(nativeBinding.jobId);
            if (plan.profileId === profileId) return { plan, op };
          }
          return undefined;
        } catch {
          return undefined;
        }
      }
      fallbackOriginals ??= await flatMapAsync(
        await this.tasks.plansForProfile(profileId),
        async (plan) => (await this.tasks.operations(plan.id)).map((op) => ({ plan, op })),
      );
      return fallbackOriginals.find(
        ({ op }) => op.binding && sameBinding(op.binding, nativeBinding),
      );
    };
    const retained = inventory.workspaceMain ?? (await this.tasks.retainedTaskPage?.(profileId));
    return NativeReviewReportV2.parse({
      version: 2,
      browserSessionEpoch: inventory.browserSessionEpoch,
      profileId,
      checkedAt: new Date().toISOString(),
      unresolvedCount: unresolved.length,
      blockingCount: inventory.operations.filter(kernelOperationPending).length,
      activeTabCount: inventory.tabs.filter((tab) => !['CLOSED', 'LOST'].includes(tab.state))
        .length,
      tabs: inventory.tabs
        .filter((tab) => !['CLOSED', 'LOST'].includes(tab.state))
        .map((tab) => ({
          id: tab.ownershipId,
          state: tab.state,
          hasProof: tab.proof !== null,
          reason:
            tab.state === 'READY' && tab.proof && retained && sameTabProof(tab.proof, retained)
              ? 'WORKSPACE_MAIN_IDLE'
              : tab.reason,
        })),
      unclosedTabCount: inventory.tabs.filter((tab) => tab.state !== 'CLOSED').length,
      operations: await mapAsync(slicedUnresolved, async (native) => {
        const original = await findOriginal(native.binding);
        return {
          id: native.binding.operationId,
          nativeState: native.state,
          ...(native.disposition ? { ended: true } : {}),
          accountId: native.binding.accountId,
          local: original
            ? {
                planId: original.plan.id,
                name: original.plan.snapshot.name,
                planState: original.plan.state,
                operationState: original.op.status,
                kind: original.op.action.kind,
                controlConfirmed: original.plan.controlConfirmed,
              }
            : null,
        };
      }),
      truncated: unresolved.length > 100,
    });
  }
}
