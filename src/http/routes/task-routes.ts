import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import { admitProfilesForStart } from '../../application/profile-start-admission.js';
import type { TaskService } from '../../application/task-service.js';
import type { TaskTestService } from '../../application/task-test-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import { ProductError } from '../../domain/workspace.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import { TASK_CAPACITY_HEADER } from '../../shared/task-capacity.js';
import {
  AssignTasks,
  SchedulerSettings,
  TaskCommandRequest,
  TaskHistoryRequest,
} from '../../shared/task-contracts.js';
import { FEATURE_CONTRACT_HEADER } from '../../shared/task-features.js';
import {
  TASK_CONTRACT_HEADER,
  assertTaskCapacity,
  assertTaskContract,
} from '../task-contract-version.js';

export interface TaskRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  service: WorkspaceService;
  tasks?: TaskService | undefined;
  taskTests?: TaskTestService | undefined;
  featureExecution?: FeatureExecutionRegistry | undefined;
  isProfileOnline?: ((profileId: string) => boolean | Promise<boolean>) | undefined;
  profileLifecycle?: ProfileLifecyclePort | undefined;
}

const ACTIVE_PLAN_STATES = [
  'QUEUED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'REVIEW',
] as const;

export async function handleTaskRoutes(ctx: TaskRouteContext): Promise<boolean> {
  const { req, res, route, input, json, service, tasks, taskTests, featureExecution } = ctx;
  if (!route.startsWith('/api/workspace/tasks')) return false;

  if (req.method === 'GET' && route === '/api/workspace/tasks' && tasks) {
    assertTaskCapacity(req.headers[TASK_CAPACITY_HEADER], await tasks.settings());
    const overview = await tasks.overview();
    assertTaskContract(req.headers[TASK_CONTRACT_HEADER], [], overview.plans);
    json(res, 200, overview);
    return true;
  }
  if (req.method === 'GET' && route === '/api/workspace/tasks/capabilities' && tasks) {
    json(res, 200, await tasks.capabilities());
    return true;
  }
  if (req.method === 'GET' && route === '/api/workspace/tasks/runtime' && tasks) {
    assertTaskCapacity(req.headers[TASK_CAPACITY_HEADER], await tasks.settings());
    if (req.aborted || res.destroyed) return true;
    if (req.headers['x-workbench-runtime-contract'] !== '2')
      throw new ProductError(
        'TASK_CONTRACT_UPGRADE_REQUIRED',
        '任务读取接口已更新，请刷新软件页面',
        409,
      );
    const cursor = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor');
    const overview = await tasks.runtimeOverview(cursor ? { cursor } : {});
    assertTaskContract(req.headers[TASK_CONTRACT_HEADER], overview.currentSteps, overview.plans);
    json(res, 200, overview);
    return true;
  }
  if (req.method === 'GET' && route === '/api/workspace/tasks/features' && tasks) {
    json(res, 200, await tasks.features(req.headers[FEATURE_CONTRACT_HEADER] === '2' ? '2' : '1'));
    return true;
  }

  if (req.method !== 'POST') return false;

  switch (route) {
    case '/api/workspace/tasks/test': {
      if (!taskTests) throw new ProductError('TASKS_UNAVAILABLE', '测试执行服务尚未加载', 409);
      json(res, 200, await taskTests.start(input));
      return true;
    }
    case '/api/workspace/tasks/settings': {
      if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务设置服务未启用', 409);
      assertTaskCapacity(req.headers[TASK_CAPACITY_HEADER], SchedulerSettings.parse(input));
      json(res, 200, await tasks.setSettings(input));
      return true;
    }
    case '/api/workspace/tasks/command': {
      if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务执行服务未启用', 409);
      const value = TaskCommandRequest.parse(input);
      await service.requireProfiles(value.plans.map((plan) => plan.profileId));
      json(res, 200, await tasks.command(value));
      return true;
    }
    case '/api/workspace/tasks/start': {
      if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务执行服务未启用', 409);
      const value = AssignTasks.parse(input);
      const previous = await tasks.plansForBatch(value.requestId);
      const saved = (await service.snapshot()).combinations.find(
        (row) => row.id === value.combinationId,
      )?.saved;
      assertTaskContract(
        req.headers[TASK_CONTRACT_HEADER],
        [],
        previous.length ? previous : saved ? [{ snapshot: saved }] : [],
      );
      await service.requireProfiles(value.profileIds);
      if (!previous.length) {
        await tasks.releaseErroredPausedPlans(value.profileIds);
        const checkOnline = !value.timing && typeof ctx.isProfileOnline === 'function';
        if (checkOnline && ctx.profileLifecycle && ctx.isProfileOnline) {
          const offlineCandidates: string[] = [];
          for (const id of value.profileIds) {
            if (await tasks.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES)) continue;
            if (await ctx.isProfileOnline(id)) continue;
            const busyElsewhere = featureExecution
              ? await featureExecution.isProfileBusy(id, 'active-accounts')
              : false;
            if (!busyElsewhere) offlineCandidates.push(id);
          }
          if (offlineCandidates.length > 0) {
            await ctx.profileLifecycle.ensureProfilesOnline(offlineCandidates);
          }
        }
        const admission = await admitProfilesForStart({
          requestedProfileIds: value.profileIds,
          currentModuleId: 'active-accounts',
          isAlreadyRunningInCurrentModule: (id) =>
            tasks.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES),
          busyModuleLabelsForProfile: async (id) =>
            featureExecution
              ? await featureExecution.busyModuleLabels([id], 'active-accounts')
              : [],
          isProfileBusyInOtherModule: async (id) =>
            featureExecution ? await featureExecution.isProfileBusy(id, 'active-accounts') : false,
          isProfileReady: (id) =>
            checkOnline && ctx.isProfileOnline ? ctx.isProfileOnline(id) : true,
        });
        if (admission.admittedProfileIds.length === 0) {
          if (admission.skippedBusy.length > 0) {
            throw new ProductError(
              'PROFILE_GROUP_INVITER_BUSY',
              '所选浏览器正在执行其他功能模块任务，请先停止后再启动任务组合',
              409,
            );
          }
          if (admission.alreadyRunningIds.length > 0 && admission.skippedOffline.length === 0) {
            throw new ProductError(
              'PROFILE_PLAN_BUSY',
              '所选浏览器已有运行或等待中的任务组合',
              409,
            );
          }
          throw new ProductError(
            'PROFILE_OFFLINE',
            admission.skippedOffline[0]?.reason ?? '所选浏览器未连接，请先打开对应浏览器',
            409,
          );
        }
        value.profileIds = admission.admittedProfileIds;
      }
      json(res, 200, await tasks.start(value));
      return true;
    }
    case '/api/workspace/tasks/history': {
      if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务记录服务未启用', 409);
      const value = TaskHistoryRequest.parse(input);
      await service.requireProfiles([value.profileId]);
      const history = await tasks.history(value);
      assertTaskContract(req.headers[TASK_CONTRACT_HEADER], history.steps);
      json(res, 200, history);
      return true;
    }
    case '/api/workspace/tasks/records': {
      if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务记录服务未启用', 409);
      if (req.aborted || res.destroyed) return true;
      assertTaskContract(req.headers[TASK_CONTRACT_HEADER], []);
      if (req.headers['x-workbench-records-contract'] !== '1')
        throw new ProductError(
          'TASK_CONTRACT_UPGRADE_REQUIRED',
          '记录分页接口已更新，请刷新软件页面',
          409,
        );
      const records = await tasks.records(input, (await service.snapshot()).profiles);
      assertTaskContract(req.headers[TASK_CONTRACT_HEADER], records.records);
      json(res, 200, records);
      return true;
    }
    default:
      return false;
  }
}
