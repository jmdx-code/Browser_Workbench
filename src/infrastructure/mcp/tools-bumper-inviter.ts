import { randomUUID } from 'node:crypto';
import { extractFacebookGroupId } from '../../shared/facebook-target-id.js';
import * as M from './mcp-context.js';
async function handleBumper(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const bumper = deps.getGroupBumperService();
  M.req(bumper, 'BUMPER_UNAVAILABLE', '顶贴服务当前不可用', 503);
  const mode: 'group-bumper' | 'page-bumper' =
    args.mode === 'page-bumper' ? 'page-bumper' : 'group-bumper';
  const action = M.strArg(args.action) || 'state';
  const isPage = mode === 'page-bumper';
  const scopeOf = (st: object) => M.pickBumperScope(st, isPage);
  const startBumper = async () => {
    const [profileIds, pageIds, groupIds] = [
      (await M.optPids(deps, args)) ?? [],
      M.extractPageIds(args.pageIds),
      M.extractGroupIds(args.groupIds),
    ];
    if (args.autoAddMissingTargets !== false)
      await M.ensureBumperTargets(deps, isPage ? [] : groupIds, pageIds);
    const st = isPage
      ? await bumper.startPageBumper({ profileIds, pageIds })
      : await bumper.start({ profileIds, groupIds, pageIds });
    return {
      mode,
      ...M.pick(scopeOf(st), 'running statusText profileCounts'),
      pendingReviewOperations: st.pendingReviewOperations ?? [],
    };
  };
  const cancelOrDel = async () => {
    const schedSvc = deps.getAutoSchedulerService?.();
    M.req(schedSvc, 'AUTO_SCHEDULER_UNAVAILABLE', '定时排班服务未加载', 503);
    const taskId = M.strArg(args.taskId);
    M.req(taskId, 'TASK_ID_REQUIRED', `${action} 需要提供 taskId`);
    const st =
      action === 'cancel_task'
        ? await schedSvc.toggleSchedule({ id: taskId, enabled: false })
        : await schedSvc.deleteSchedule({ id: taskId });
    return { mode, action, taskId, schedulesCount: st.schedules.length };
  };
  return M.act(action, {
    logs: async () => {
      const logs = await bumper.logs(
        typeof args.search === 'string' ? args.search : '',
        undefined,
        undefined,
        M.clampInt(args.limit, 50, 1, 200),
        isPage ? 'page' : 'group',
      );
      return { mode, count: logs.length, logs: M.mapAt(logs, 'bumpedAt') };
    },
    save_settings: async () => ({
      mode,
      settings: scopeOf(
        await bumper.manage(isPage ? 'page-settings' : 'settings', {
          ...scopeOf(await bumper.state()).settings,
          ...M.objArg(args.settings),
        }),
      ).settings,
    }),
    save_comments: async () => {
      const curConsume = Boolean(scopeOf(await bumper.state()).settings?.consumeCommentOnUse);
      const consume =
        typeof args.consumeCommentOnUse === 'boolean' ? args.consumeCommentOnUse : curConsume;
      return {
        mode,
        commentsCount: scopeOf(
          await bumper.manage(isPage ? 'page-comments' : 'comments', {
            texts: M.strArrArg(args.comments),
            consumeCommentOnUse: consume,
            scope: isPage ? 'page' : 'group',
          }),
        ).comments.length,
      };
    },
    schedule: async () => {
      const schedSvc = deps.getAutoSchedulerService?.();
      M.req(schedSvc, 'AUTO_SCHEDULER_UNAVAILABLE', '定时排班服务未加载', 503);
      const profileIds = await M.optPids(deps, args);
      M.req(profileIds?.length, 'PROFILE_IDS_REQUIRED', 'schedule 需要提供至少 1 个 profileIds');
      const [pageIds, groupIds, parsed] = [
        M.extractPageIds(args.pageIds),
        M.extractGroupIds(args.groupIds),
        M.parseFlexibleScheduleTime(args.scheduledAt),
      ];
      const onceAt = parsed.mode === 'scheduled' ? parsed.scheduledAt : null;
      M.req(onceAt, 'SCHEDULE_TIME_REQUIRED', 'schedule 需要提供未来的 scheduledAt 时间');
      if (args.autoAddMissingTargets !== false)
        await M.ensureBumperTargets(deps, isPage ? [] : groupIds, pageIds);
      const step = isPage
        ? { id: randomUUID(), type: 'page-bumper', pageIds }
        : { id: randomUUID(), type: 'group-bumper', groupIds, pageIds };
      const { schedState, created } = await M.scheduleOnceViaAutoScheduler(
        schedSvc,
        isPage ? '专页顶贴' : '小组顶贴',
        profileIds,
        onceAt,
        step,
      );
      return {
        mode,
        rolledToNextDay: parsed.rolledToNextDay,
        scheduledViaAutoScheduler: true,
        scheduledTasksCount: schedState.schedules.filter((s) => s.enabled).length,
        task: created
          ? {
              ...M.pick(created, 'id name'),
              mode,
              status: created.enabled ? 'scheduled' : 'cancelled',
              scheduledAt: onceAt,
              scheduledAtLocal: M.formatLocalDateTime(onceAt),
            }
          : null,
      };
    },
    cancel_task: cancelOrDel,
    delete_task: cancelOrDel,
    start: startBumper,
    stop: async () => ({
      mode,
      ...M.pick(
        scopeOf(await bumper.stop(await M.optPids(deps, args), mode)),
        'running statusText profileCounts',
      ),
    }),
    state: async () => {
      const [st, schedState] = await Promise.all([
        bumper.state(),
        deps.getAutoSchedulerService?.()?.state(),
      ]);
      const m = scopeOf(st);
      const matching = (schedState?.schedules ?? []).filter((s) =>
        s.steps.some((step) => step.type === mode),
      );
      return {
        mode,
        ...M.pick(m, 'running statusText settings total profileCounts'),
        commentsCount: m.comments.length,
        ...(args.includeComments === true && { comments: m.comments.map((c) => c.text) }),
        groupsCount: st.groups.length,
        pagesCount: st.pages.length,
        scheduledTasksCount: matching.length,
        scheduledTasks: matching.slice(0, 10).map((s) => ({
          ...M.pick(s, 'id name enabled'),
          nextRunAt: s.nextRun?.nextAt ?? null,
          nextRunAtLocal: M.formatLocalDateTime(s.nextRun?.nextAt ?? null),
        })),
        pendingReviewOperations: st.pendingReviewOperations ?? [],
      };
    },
  });
}
const INV_SETTINGS_KEYS =
  'invitesPerGroup maxConcurrentProfiles playSoundOnComplete closeBrowserOnFinish!';
const INV_SETTINGS_SPEC =
  'invitesPerGroup:n maxConcurrentProfiles:n playSoundOnComplete:b closeBrowserOnFinish:b';
async function handleInviter(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const action = M.strArg(args.action) || 'state';
  const inv = deps.groupInviterService;
  const sumG = (g: {
    groupId: string;
    groupName: string;
    avatarUrl: string | null;
    folderId?: string | null;
    totalInvitedCount: number;
    updatedAt: number;
  }) => ({ ...M.summarizeTarget(g), ...M.pick(g, 'groupId groupName totalInvitedCount') });
  return M.act(action, {
    list_groups: async () => {
      const st = await inv.state();
      const q = M.strArg(args.search).toLowerCase();
      const filtered = q
        ? st.groups.filter(
            (g) => g.groupId.toLowerCase().includes(q) || g.groupName.toLowerCase().includes(q),
          )
        : st.groups;
      return {
        totalCount: st.groups.length,
        matchedCount: filtered.length,
        groups: filtered.map(sumG),
      };
    },
    add_groups: async () => {
      const items: Array<{ groupId: string; groupName?: string; folderId?: string | null }> = [];
      for (const raw of Array.isArray(args.items) ? args.items : []) {
        const entry =
          typeof raw === 'string' ? { id: raw.trim() } : M.parseTargetAddItems({ items: [raw] })[0];
        const gid = entry ? extractFacebookGroupId(entry.id) : '';
        if (gid)
          items.push({
            groupId: gid,
            ...(entry?.name && { groupName: entry.name }),
            ...(entry?.folderId !== undefined && { folderId: entry.folderId }),
          });
      }
      for (const gid of M.extractGroupIds(args.groupIds))
        if (!items.some((i) => i.groupId === gid)) items.push({ groupId: gid });
      M.req(
        items.length > 0,
        'GROUP_ITEMS_REQUIRED',
        'add_groups 需要通过 items 或 groupIds 提供小组',
      );
      const st = await inv.addGroups({ items });
      return {
        addedOrUpdatedCount: items.length,
        groupsCount: st.groups.length,
        groups: st.groups.map(sumG),
      };
    },
    delete_groups: async () => {
      const gids = M.extractGroupIds(args.groupIds);
      M.req(gids.length > 0, 'GROUP_IDS_REQUIRED', 'delete_groups 需要提供 groupIds');
      return {
        deletedRequestedCount: gids.length,
        groupsCount: (await inv.deleteGroups({ groupIds: gids })).groups.length,
      };
    },
    refresh_groups: async () => {
      const gids = M.extractGroupIds(args.groupIds);
      const st = await inv.refreshGroups(gids.length > 0 ? gids : undefined);
      return {
        ...M.pick(st, 'groupAvatarRefreshing! avatarRefreshStatusText='),
        groupsCount: st.groups.length,
      };
    },
    stop_refresh_groups: async () =>
      M.pick(await inv.stopRefreshGroups(), 'groupAvatarRefreshing! avatarRefreshStatusText='),
    logs: async () => {
      const rows = await inv.logs(
        typeof args.search === 'string' ? args.search : '',
        undefined,
        M.clampInt(args.limit, 50, 1, 300),
      );
      return { count: rows.length, logs: M.mapAt(rows, 'invitedAt') };
    },
    save_settings: async () =>
      M.pick(
        await inv.updateSettings({
          ...M.pick(await inv.state(), INV_SETTINGS_KEYS),
          ...M.pickTypes(args, INV_SETTINGS_SPEC),
        } as Parameters<typeof inv.updateSettings>[0]),
        INV_SETTINGS_KEYS,
      ),
    start: async () => {
      const profileIds = (await M.optPids(deps, args)) ?? [];
      const groupIds = M.extractGroupIds(args.groupIds);
      if (args.autoAddMissingGroups !== false && groupIds.length > 0) {
        const known = new Set((await inv.state()).groups.map((g) => g.groupId));
        const missing = groupIds.filter((id) => !known.has(id)).map((groupId) => ({ groupId }));
        if (missing.length > 0) await inv.addGroups({ items: missing });
      }
      return M.pick(
        await inv.start({ profileIds, groupIds, ...M.pickTypes(args, INV_SETTINGS_SPEC) }),
        'running statusText profileCounts runId?',
      );
    },
    stop: async () => {
      const pids = await M.optPids(deps, args);
      return M.pick(
        pids?.length ? await inv.stopProfiles({ profileIds: pids }) : await inv.stop(),
        'running statusText profileCounts',
      );
    },
    state: async () => {
      const st = await inv.state();
      return {
        ...M.pick(
          st,
          `running statusText ${INV_SETTINGS_KEYS} profileCounts runId? groupAvatarRefreshing! lastRunSummary?`,
        ),
        groupsCount: st.groups.length,
        ...(args.includeGroups === true && { groups: st.groups.map(sumG) }),
      };
    },
  });
}
export function createBumperAndInviterTools(
  deps: M.WorkbenchMcpDependencies,
): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_bumper_control',
      '控制与监控「小组顶贴」和「专页顶贴」。',
      '@profileIds|@groupIds|@pageIds|@scheduledAt|@taskId|@settings|@comments|@consumeCommentOnUse|@search|@limit|@autoAddMissingTargets|@includeComments|mode:e(group-bumper page-bumper):顶贴模式|action:e(state logs save_settings save_comments start schedule cancel_task delete_task stop):操作类型',
      (args) => handleBumper(deps, args),
      { req: 'mode action' },
    ),
    M.reg(
      'wb_inviter_control',
      '控制与监控「小组邀请人」模块。',
      M.sp(
        '@profileIds|@groupIds|@search|action:e(state list_groups add_groups delete_groups refresh_groups stop_refresh_groups logs save_settings start stop):操作类型|autoAddMissingGroups:b:自动补入小组|includeGroups:b:返回小组列表|invitesPerGroup:n(1,200):每组邀请人数|maxConcurrentProfiles:n(1,50):最大并发数|playSoundOnComplete:b:完后提示音|closeBrowserOnFinish:b:完后关窗|limit:n(1,300):日志条数上限',
        {
          items: M.A(
            M.U('object string', undefined, {
              properties: M.sp(
                'id:s:小组ID|groupId:s:小组ID|name:s:名称|groupName:s:名称|folderId:u(string null)',
              ),
              additionalProperties: false,
            }),
            '小组列表',
          ),
        },
      ),
      (args) => handleInviter(deps, args),
      { req: 'action' },
    ),
  ];
}
