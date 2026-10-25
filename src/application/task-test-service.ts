import type { TaskService } from './task-service.js';
import type { WorkspaceService } from './workspace-service.js';
import { ProductError } from '../domain/workspace.js';
import { marketplaceBridgeSupported } from '../shared/task-features.js';
import { CombinationSchema } from '../shared/contracts.js';
import {
  TaskTestRequest,
  TaskTestResult,
  TEST_COMBINATION_NOTE,
  taskTestModules,
  taskTestStep,
} from '../shared/task-tests.js';

// Single-task testing creates an ordinary immutable combination and original assignment.
// Original plans contain the result/stop history. No second execution or test ledger exists.
export class TaskTestService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly tasks: TaskService,
    private readonly isProfileExternalBusy?: (profileId: string) => boolean,
  ) {}
  async start(input: unknown) {
    const request = TaskTestRequest.parse(input);
    request.profileIds = [...new Set(request.profileIds)].sort();
    await this.workspace.requireProfiles(request.profileIds);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(request)),
    );
    const note =
      TEST_COMBINATION_NOTE +
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const original = await this.tasks.plansForBatch(request.requestId);
    if (original.length) {
      if (original.some((plan) => plan.snapshot.note !== note))
        throw new ProductError('BATCH_ID_CONFLICT', '同一个测试请求不能改动参数或浏览器范围', 409);
      return TaskTestResult.parse({
        plans: original,
        rejected: request.profileIds
          .filter((id) => !original.some((plan) => plan.profileId === id))
          .map((profileId) => ({
            profileId,
            reason: '上一请求没有给此资料分配任务；请明确新建测试',
          })),
      });
    }
    const module = taskTestModules.find((item) => item.id === request.module);
    if (!module) throw new ProductError('TEST_MODULE_UNAVAILABLE', '未知测试模块', 400);
    if (!(await this.tasks.capabilities()).types.includes(request.module))
      throw new ProductError('TEST_MODULE_UNAVAILABLE', module.name + '的执行模块尚未加载', 409);
    await this.tasks.releaseErroredPausedPlans(request.profileIds);
    const snapshot = await this.workspace.snapshot();
    const live = await this.tasks.livePlans();
    const rejected = request.profileIds.flatMap((profileId) => {
      const profile = snapshot.profiles.find((item) => item.id === profileId);
      const reason = !profile?.online
        ? '浏览器未连接，请打开对应资料'
        : !marketplaceBridgeSupported(profile.extensionVersion, '0.3.21')
          ? '请将这份浏览器的桥接插件刷新到0.3.21或更新版本，再测试'
          : !profile.synced || profile.unresolved
            ? '连接正在对账或有待处理操作，请先查看状态'
            : this.isProfileExternalBusy?.(profileId)
              ? '正在执行小组邀请人任务，请先停止'
              : live.some((plan) => plan.profileId === profileId)
                ? '已有任务未结束，请先停止或处理原任务'
                : '';
      return reason ? [{ profileId, reason }] : [];
    });
    const eligible = request.profileIds.filter(
      (id) => !rejected.some((item) => item.profileId === id),
    );
    if (!eligible.length) return TaskTestResult.parse({ plans: [], rejected });
    const combination =
      (await this.workspace.repository.combinations()).find((row) => row.saved?.note === note) ??
      (await this.workspace.repository.createCombination(
        CombinationSchema.parse({
          name: '单项测试 · ' + module.name,
          note,
          steps: [taskTestStep(request, crypto.randomUUID())],
          randomOrder: false,
          loop: { mode: 'finite', rounds: 1 },
        }),
      ));
    const { plans } = await this.tasks.start({
      requestId: request.requestId,
      combinationId: combination.id,
      version: combination.version,
      profileIds: eligible,
    });
    return TaskTestResult.parse({ plans, rejected });
  }
}
