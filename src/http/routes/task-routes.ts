import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import { admitProfilesForStart } from '../../application/profile-start-admission.js';
import type { TaskService } from '../../application/task-service.js';
import type { TaskTestService } from '../../application/task-test-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import { ProductError } from '../../domain/workspace.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import { AssignTasks, SchedulerSettings, TaskCommandRequest } from '../../shared/task-contracts.js';
import { TaskTestRequest } from '../../shared/task-tests.js';
export interface RouteBase {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}
export function needSvc<T>(v: T | undefined, code: string, msg: string): T {
  if (!v) throw new ProductError(code, msg, 409);
  return v;
}
export interface TaskRouteContext extends RouteBase {
  service: WorkspaceService;
  tasks?: TaskService;
  taskTests?: TaskTestService;
  featureExecution?: FeatureExecutionRegistry;
  isProfileOnline?: (profileId: string) => boolean | Promise<boolean>;
  profileLifecycle?: ProfileLifecyclePort;
}
const ACTIVE_PLAN_STATES = ['QUEUED', 'RUNNING'] as const;
export async function handleTaskRoutes(ctx: TaskRouteContext): Promise<boolean> {
  const { req, res, route, input, json, service, tasks, taskTests, featureExecution: fe } = ctx;
  if (!route.startsWith('/api/workspace/tasks')) return false;
  const needTasks = (msg: string) => needSvc(tasks, 'TASKS_UNAVAILABLE', msg),
    ok = (body: unknown) => (json(res, 200, body), true),
    fail = (code: string, msg: string): never => {
      throw new ProductError(code, msg, 409);
    };
  if (req.method === 'GET') {
    if (!tasks) return false;
    if (route === '/api/workspace/tasks') return ok(await tasks.overview());
    if (route === '/api/workspace/tasks/capabilities') return ok(await tasks.capabilities());
    if (route === '/api/workspace/tasks/runtime') {
      if (req.aborted || res.destroyed) return true;
      if (req.headers['x-workbench-runtime-contract'] !== '2')
        fail('TASK_CONTRACT_UPGRADE_REQUIRED', '任务读取接口已更新，请刷新软件页面');
      const cursor = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor');
      return ok(await tasks.runtimeOverview(cursor ? { cursor } : {}));
    }
    return false;
  }
  if (req.method !== 'POST') return false;
  if (route === '/api/workspace/tasks/test') {
    const svc = needSvc(taskTests, 'TASKS_UNAVAILABLE', '测试执行服务尚未加载'),
      parsed = TaskTestRequest.parse(input),
      reservedIds = fe
        ? (await fe.tryReserve('active-accounts', parsed.profileIds)).reservedIds
        : parsed.profileIds;
    try {
      return ok(await svc.start(parsed));
    } finally {
      fe?.releaseReservation('active-accounts', reservedIds);
    }
  }
  if (route === '/api/workspace/tasks/settings') {
    const svc = needTasks('任务设置服务未启用');
    return ok(await svc.setSettings(SchedulerSettings.parse(input)));
  }
  if (route === '/api/workspace/tasks/command') {
    const svc = needTasks('任务执行服务未启用'),
      value = TaskCommandRequest.parse(input);
    await service.requireProfiles(value.plans.map((p) => p.profileId));
    return ok(await svc.command(value));
  }
  if (route === '/api/workspace/tasks/records') {
    const svc = needTasks('任务记录服务未启用');
    if (req.aborted || res.destroyed) return true;
    return ok(await svc.records(input, (await service.snapshot()).profiles));
  }
  if (route !== '/api/workspace/tasks/start') return false;
  const svc = needTasks('任务执行服务未启用'),
    value = AssignTasks.parse(input),
    previous = await svc.plansForBatch(value.requestId);
  await service.requireProfiles(value.profileIds);
  if (previous.length) return ok(await svc.start(value));
  const reservedIds = fe
    ? (await fe.tryReserve('active-accounts', value.profileIds)).reservedIds
    : value.profileIds;
  const reservedSet = new Set(reservedIds);
  try {
    const checkOnline = typeof ctx.isProfileOnline === 'function',
      launchableSet = new Set<string>();
    if (checkOnline && ctx.profileLifecycle && ctx.isProfileOnline) {
      const offline: string[] = [];
      for (const id of value.profileIds) {
        if (
          !reservedSet.has(id) ||
          (await svc.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES)) ||
          (await ctx.isProfileOnline(id))
        )
          continue;
        offline.push(id);
      }
      if (offline.length > 0)
        for (const st of await ctx.profileLifecycle.getStatus(offline))
          if (st.launchable) launchableSet.add(st.profileId);
    }
    const admission = await admitProfilesForStart({
      requestedProfileIds: value.profileIds,
      currentModuleId: 'active-accounts',
      isAlreadyRunningInCurrentModule: (id) => svc.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES),
      busyModuleLabelsForProfile: async (id) =>
        fe ? await fe.busyModuleLabels([id], 'active-accounts') : [],
      isProfileBusyInOtherModule: async (id) =>
        fe ? await fe.isProfileBusy(id, 'active-accounts') : false,
      isProfileReady: (id) =>
        checkOnline && ctx.isProfileOnline
          ? launchableSet.has(id) || ctx.isProfileOnline(id)
          : true,
    });
    if (!admission.admittedProfileIds.length)
      fail(
        admission.skippedBusy.length > 0
          ? 'PROFILE_BUSY'
          : admission.alreadyRunningIds.length > 0 && !admission.skippedOffline.length
            ? 'PROFILE_PLAN_BUSY'
            : 'PROFILE_OFFLINE',
        admission.skippedBusy.length > 0
          ? '所选浏览器正在执行其他功能模块任务，请先停止后再启动任务组合'
          : admission.alreadyRunningIds.length > 0 && !admission.skippedOffline.length
            ? '所选浏览器已有运行或等待中的任务组合'
            : (admission.skippedOffline[0]?.reason ?? '所选浏览器未连接，请先打开对应浏览器'),
      );
    value.profileIds = admission.admittedProfileIds;
    return ok(await svc.start(value));
  } finally {
    fe?.releaseReservation('active-accounts', reservedIds);
  }
}
