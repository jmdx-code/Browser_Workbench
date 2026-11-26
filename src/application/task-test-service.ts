import type { TaskService } from './task-service.js';
import type { WorkspaceService } from './workspace-service.js';
import { ProductError } from '../domain/workspace.js';
import { marketplaceBridgeSupported } from '../shared/task-policies.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
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
  private profileLifecycle?: ProfileLifecyclePort;
  private readonly batchDigests = new Map<string, string>();
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly tasks: TaskService,
    private readonly isProfileExternalBusy?: (profileId: string) => boolean | Promise<boolean>,
  ) {}
  setProfileLifecycle(lifecycle: ProfileLifecyclePort): void {
    this.profileLifecycle = lifecycle;
  }
  private async sha256Hex(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async start(input: unknown) {
    const request = TaskTestRequest.parse(input);
    request.profileIds = [...new Set(request.profileIds)].sort();
    await this.workspace.requireProfiles(request.profileIds);
    // Hash ONLY the step spec for combination reuse so repeated quick tasks do not
    // leak zombie rows in SQLite `combinations`, while hashing the full request
    // (including profileIds & params) for strict same-requestId idempotency checks.
    const stepSpec = taskTestStep(request, '00000000-0000-4000-8000-000000000000');
    const [requestDigest, comboDigest] = await Promise.all([
      this.sha256Hex(request),
      this.sha256Hex(stepSpec),
    ]);
    const note = TEST_COMBINATION_NOTE + comboDigest;
    const original = await this.tasks.plansForBatch(request.requestId);
    if (original.length) {
      const recordedDigest = this.batchDigests.get(request.requestId);
      if (
        original.some((plan) => plan.snapshot.note !== note) ||
        (recordedDigest !== undefined && recordedDigest !== requestDigest)
      )
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
    if (!module || !module.type)
      throw new ProductError('TEST_MODULE_UNAVAILABLE', '未知测试模块', 400);
    if (!(await this.tasks.capabilities()).types.includes(module.type))
      throw new ProductError('TEST_MODULE_UNAVAILABLE', module.name + '的执行模块尚未加载', 409);
    const snapshot = await this.workspace.snapshot();
    const live = await this.tasks.livePlans();
    const launchableSet = new Set<string>();
    if (this.profileLifecycle) {
      const offlineCandidates = request.profileIds.filter((profileId) => {
        const profile = snapshot.profiles.find((item) => item.id === profileId);
        return !profile?.online;
      });
      if (offlineCandidates.length > 0) {
        const statuses = await this.profileLifecycle.getStatus(offlineCandidates);
        for (const s of statuses) {
          if (s.launchable) launchableSet.add(s.profileId);
        }
      }
    }
    const rejected: { profileId: string; reason: string }[] = [];
    for (const profileId of request.profileIds) {
      const profile = snapshot.profiles.find((item) => item.id === profileId);
      const externalBusy = (await this.isProfileExternalBusy?.(profileId)) === true;
      const canAutoLaunch = !profile?.online && launchableSet.has(profileId);
      const reason =
        !profile?.online && !canAutoLaunch
          ? '浏览器未连接，请打开对应资料'
          : profile?.online && !marketplaceBridgeSupported(profile.extensionVersion, '0.3.21')
            ? '请将这份浏览器的桥接插件刷新到0.3.21或更新版本，再测试'
            : externalBusy
              ? '该浏览器正在执行其他任务，请先停止'
              : live.some((plan) => plan.profileId === profileId)
                ? '已有任务未结束，请先停止或处理原任务'
                : '';
      if (reason) rejected.push({ profileId, reason });
    }
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
      ...(request.closeBrowserOnFinish ? { closeBrowserOnFinish: true } : {}),
    });
    if (this.batchDigests.size >= 512) {
      const oldest = this.batchDigests.keys().next().value;
      if (oldest) this.batchDigests.delete(oldest);
    }
    this.batchDigests.set(request.requestId, requestDigest);
    return TaskTestResult.parse({ plans, rejected });
  }
}
