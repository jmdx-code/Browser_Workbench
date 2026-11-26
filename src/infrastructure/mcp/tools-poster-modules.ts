import { randomUUID } from 'node:crypto';
import { extractFacebookGroupId } from '../../shared/facebook-target-id.js';
import type { PosterTask } from '../../shared/group-poster.js';
import * as M from './mcp-context.js';
import { createBluestacksTools } from './tools-bluestacks.js';
import { createBumperAndInviterTools } from './tools-bumper-inviter.js';

const enrichPosterTask = (t: PosterTask) => ({
  ...t,
  ...M.pick(t, 'scheduledAt@ createdAt@ startedAt@ finishedAt@'),
});

async function prepareMaterials(
  deps: M.WorkbenchMcpDependencies,
  ids: readonly string[],
  withMat: boolean,
) {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const mat = await deps.groupPosterService.prepareMaterialById(id);
        const ready = mat?.cacheStatus === 'ready';
        const error = mat?.cacheError ?? null;
        return withMat
          ? error && !mat
            ? { id, ok: false, error }
            : { id, ok: mat !== null && ready, material: mat }
          : { id, ready, error };
      } catch (err) {
        const error = M.errMsg(err);
        return withMat ? { id, ok: false, error } : { id, ready: false, error };
      }
    }),
  );
}

async function handleSaveMaterial(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const poster = deps.groupPosterService;
  return M.act(M.strArg(args.action) || 'save', {
    save_settings: async () => {
      const cur = (await poster.state()).settings;
      return {
        settings: (
          await poster.saveSettings({
            ...cur,
            ...M.pickTypes(M.objArg(args.settings), 'maxConcurrentProfiles:n maxPostsPerAccount:n'),
          })
        ).settings,
      };
    },
    delete: async () => {
      const ids = M.strArrArg(args.ids);
      M.req(ids.length > 0, 'IDS_REQUIRED', '请提供要删除的素材 ids');
      return {
        deletedIds: ids,
        remainingMaterialsCount: (await poster.deleteMaterials({ ids })).materials.length,
      };
    },
    prepare: async () => {
      const ids = M.strArrArg(args.ids);
      M.req(ids.length > 0, 'IDS_REQUIRED', '请提供要预检的素材 ids');
      return { preparedResults: await prepareMaterials(deps, ids, true) };
    },
    save: async () => {
      const rawList = Array.isArray(args.items) ? args.items : [];
      M.req(rawList.length > 0, 'ITEMS_REQUIRED', 'save 操作必须提供至少 1 条贴文素材 items');
      const assignedIds: string[] = [];
      await poster.saveMaterials({
        items: rawList.map((raw) => {
          const rec = M.objArg(raw);
          const id = M.strArg(rec.id) || randomUUID();
          assignedIds.push(id);
          return {
            id,
            caption: typeof rec.caption === 'string' ? rec.caption : '',
            mediaSource: typeof rec.mediaSource === 'string' ? rec.mediaSource : '',
            background: rec.background === 'color' ? 'color' : 'plain',
            aiLabel: rec.aiLabel === 'on' || rec.aiLabel === 'off' ? rec.aiLabel : 'default',
            selected: typeof rec.selected === 'boolean' ? rec.selected : true,
          };
        }),
        replaceAll: false,
      });
      const prepareResults =
        args.prepareNow !== false ? await prepareMaterials(deps, assignedIds, false) : [];
      const idSet = new Set(assignedIds);
      const savedMaterials = (await poster.state()).materials.filter((m) => idSet.has(m.id));
      return { savedCount: savedMaterials.length, savedMaterials, prepareResults };
    },
  });
}

async function handlePosterDispatch(
  deps: M.WorkbenchMcpDependencies,
  args: Record<string, unknown>,
) {
  const action = M.strArg(args.action) || 'create_tasks';
  const poster = deps.groupPosterService;
  if (action === 'cancel_task' || action === 'delete_task') {
    const taskId = M.strArg(args.taskId);
    M.req(taskId, 'TASK_ID_REQUIRED', `${action} 需要提供 taskId`);
    const st =
      action === 'cancel_task'
        ? await poster.cancelTask({ id: taskId })
        : await poster.deleteTask({ id: taskId });
    const found = (st.tasks ?? []).find((t) => t.id === taskId);
    return action === 'cancel_task'
      ? {
          cancelledTaskId: taskId,
          task: found ? enrichPosterTask(found) : null,
          statusText: st.statusText,
        }
      : {
          deletedTaskId: taskId,
          remainingTasksCount: (st.tasks ?? []).length,
          statusText: st.statusText,
        };
  }
  if (action === 'stop_all') return M.pick(await poster.stop(), 'running statusText profileCounts');
  if (action === 'stop_profiles') {
    const pids = await M.optPids(deps, args);
    M.req(pids?.length, 'PROFILE_IDS_REQUIRED', 'stop_profiles 需要提供 profileIds');
    await poster.stopProfiles(pids);
    return {
      stoppedProfileIds: pids,
      ...M.pick(await poster.state(), 'running statusText profileCounts'),
    };
  }
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  M.req(rawTasks.length > 0, 'TASKS_REQUIRED', 'create_tasks 需要提供至少 1 条任务定义 tasks');
  const hasImmediate = rawTasks.some((i) => {
    try {
      return M.parseFlexibleScheduleTime(M.objArg(i).scheduledAt).mode === 'immediate';
    } catch {
      return false;
    }
  });
  let currentState = await poster.state();
  const knownGroups = new Set(currentState.groups.map((g) => g.id));
  if (args.autoAddMissingGroups !== false) {
    const missing = [
      ...new Set(
        rawTasks.flatMap((i) => M.strArrArg(M.objArg(i).groupIds).map(extractFacebookGroupId)),
      ),
    ]
      .filter((id) => id && !knownGroups.has(id))
      .map((id) => ({ id }));
    if (missing.length > 0) {
      currentState = await poster.addGroups({ items: missing }, { skipAutoRefresh: hasImmediate });
      currentState.groups.forEach((g) => knownGroups.add(g.id));
    }
  }
  const enriched = await M.buildEnrichedProfiles(deps);
  const schedulerSvc = deps.getAutoSchedulerService?.();
  const outcomes: Array<Record<string, unknown>> = [];
  for (let idx = 0; idx < rawTasks.length; idx++) {
    if (typeof rawTasks[idx] !== 'object' || rawTasks[idx] === null) continue;
    const rec = M.objArg(rawTasks[idx]);
    const materialId = M.strArg(rec.materialId);
    const groupIds = M.extractGroupIds(rec.groupIds);
    const accountMode: 'selected' | 'all_online' =
      rec.accountMode === 'all_online' ? 'all_online' : 'selected';
    try {
      const profileIds = M.resolveUniqueIds(M.strArrArg(rec.profileIds), (q) =>
        M.resolveProfileIdentifierFromList(enriched, q),
      );
      if (accountMode === 'selected' && profileIds.length === 0)
        throw new Error('PROFILE_IDS_REQUIRED: accountMode="selected" 时必须指定 profileIds');
      const sched = M.parseFlexibleScheduleTime(rec.scheduledAt);
      if (
        sched.mode === 'scheduled' &&
        sched.scheduledAt &&
        accountMode === 'selected' &&
        schedulerSvc
      ) {
        const { scheduleId } = await M.scheduleOnceViaAutoScheduler(
          schedulerSvc,
          '小组发帖',
          profileIds,
          sched.scheduledAt,
          {
            id: randomUUID(),
            type: 'group-poster',
            materialIds: [materialId],
            groupIds,
            maxGroupsPerProfile: 3,
          },
        );
        outcomes.push({
          index: idx,
          ok: true,
          created: true,
          scheduledViaAutoScheduler: true,
          scheduleId,
          scheduledAtLocal: M.formatLocalDateTime(sched.scheduledAt),
          rolledToNextDay: sched.rolledToNextDay,
        });
        continue;
      }
      const beforeIds = new Set((currentState.tasks ?? []).map((t) => t.id));
      currentState = await poster.createTask({
        materialId,
        groupIds,
        accountMode,
        profileIds,
        scheduledAt: sched.scheduledAt,
      });
      const created = (currentState.tasks ?? []).find((t) => !beforeIds.has(t.id)) ?? null;
      outcomes.push({
        index: idx,
        ok: true,
        created: created !== null,
        allAlreadyPostedSkipped: created === null,
        rolledToNextDay: sched.rolledToNextDay,
        task: created ? enrichPosterTask(created) : null,
        statusText: currentState.statusText,
      });
    } catch (err) {
      outcomes.push({ index: idx, ok: false, materialId, error: M.errMsg(err) });
    }
  }
  return {
    ok: outcomes.every((o) => o.ok === true),
    createdCount: outcomes.filter((o) => o.created === true).length,
    failedCount: outcomes.filter((o) => o.ok === false).length,
    outcomes,
    ...M.pick(await poster.state(), 'running statusText profileCounts'),
  };
}

export function createPosterAndModuleTools(
  deps: M.WorkbenchMcpDependencies,
): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_poster_state',
      '查询「小组发帖」模块真实状态与任务队列。',
      M.sp('includeGroups:b:是否返回共享小组列表'),
      async (args) => {
        const st = await deps.groupPosterService.state();
        const postedByMat = st.postedGroupIdsByMaterial ?? {};
        return {
          ...M.pick(
            st,
            'running statusText settings profileCounts dailyStats activeGroupsByMaterial pendingReviewOperations#',
          ),
          totalPostedAllTime: st.total,
          groupsCount: st.groups.length,
          ...(args.includeGroups === true && { groups: st.groups }),
          materials: st.materials.map((m) => ({
            ...M.pick(
              m,
              'id caption mediaSource background mediaKind cacheStatus cacheError localFilePath selected usedCount',
            ),
            aiLabel: m.aiLabel ?? 'default',
            alreadyPostedGroupsCount: (postedByMat[m.id] ?? []).length,
          })),
          tasks: (st.tasks ?? []).map(enrichPosterTask),
        };
      },
      { readOnly: true },
    ),
    M.reg(
      'wb_poster_save_material',
      '新增、更新、删除、预检发帖素材或修改并发参数。',
      M.sp(
        'action:e(save delete prepare save_settings):操作类型|prepareNow:b:立即预检媒体缓存|ids:sa:素材ID列表',
        {
          items: M.A(
            M.O(undefined, {
              properties: M.sp(
                'id:s:素材ID|caption:s:正文文案|mediaSource:s:本地路径或Drive链接|background:e(plain color):背景样式|aiLabel:e(default on off):AI内容声明|selected:b:是否勾选',
              ),
            }),
            '贴文素材列表',
          ),
          settings: M.O('发帖设置', {
            properties: M.sp('maxConcurrentProfiles:n(1,50)|maxPostsPerAccount:n(1,200)'),
          }),
        },
      ),
      (args) => handleSaveMaterial(deps, args),
    ),
    M.reg(
      'wb_poster_dispatch',
      '派发、取消、删除或停止「小组发帖」任务。',
      M.sp(
        '@taskId|@profileIds|action:e(create_tasks cancel_task delete_task stop_all stop_profiles):调度动作|autoAddMissingGroups:b:未入库小组自动补入',
        {
          tasks: M.A(
            M.O(undefined, {
              properties: M.sp(
                'materialId:s:素材ID|groupIds:sa:目标小组ID/链接|accountMode:e(selected all_online):账号选择模式|profileIds:sa:浏览器ID列表|scheduledAt:u(string number null):定时时间',
              ),
              required: ['materialId', 'groupIds'],
            }),
            '发帖任务列表',
          ),
        },
      ),
      (args) => handlePosterDispatch(deps, args),
    ),
    M.reg(
      'wb_poster_logs',
      '查询「小组发帖」已落盘回执日志与待核对记录。',
      M.sp('@search|@limit|materialId:s:按素材ID过滤'),
      async (args) => {
        const limit = M.clampInt(args.limit, 50, 1, 200);
        const [rows, st] = await Promise.all([
          deps.groupPosterService.logs(
            M.strArg(args.search),
            undefined,
            undefined,
            M.strArg(args.materialId) || undefined,
          ),
          deps.groupPosterService.state(),
        ]);
        return {
          returnedCount: Math.min(limit, rows.length),
          logs: M.mapAt(rows.slice(0, limit), 'postedAt'),
          pendingReviewOperations: st.pendingReviewOperations ?? [],
        };
      },
      { readOnly: true },
    ),
    ...createBumperAndInviterTools(deps),
    ...createBluestacksTools(deps),
  ];
}
