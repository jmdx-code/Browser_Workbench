import { bluestacksDisplayTitle, isBluestacksPortraitResolution } from '../../shared/bluestacks.js';
import * as M from './mcp-context.js';

const BS_ACTIONS =
  'state refresh launch close show arrange install_apk inspect switch_identity rename_instance save_paths save_settings save_page_settings save_risk_limits save_comments logs start_active stop_active start_poster stop_poster start_bumper stop_bumper start_page_bumper stop_page_bumper start_inviter stop_inviter start_health_check stop_health_check stop_all';
type BsState = Awaited<ReturnType<M.WorkbenchMcpDependencies['bluestacksService']['state']>>;

async function formatBsState(
  deps: M.WorkbenchMcpDependencies,
  st: BsState,
  includeComments: boolean,
) {
  const bumperSt = await deps.getGroupBumperService()?.state();
  const gc = bumperSt?.comments ?? [];
  const pc = bumperSt?.pageComments ?? [];
  return {
    ok: true,
    ...M.pick(
      st,
      'running statusText pageBumperRunning pageBumperStatusText launchingIds closingIds inspectingIds config bumperSettings pageBumperSettings activeRunning! activeStatusText= posterRunning! posterStatusText= inviterRunning! inviterStatusText= installingIds# loggingInIds# switchingIds# healthCheck? riskLimitSettings? dailyUsage?',
    ),
    totalBumpedAllTime: st.total,
    totalPageBumpedAllTime: st.pageTotal,
    commentsCount: gc.length,
    pageCommentsCount: pc.length,
    ...(includeComments && {
      comments: gc.map((c) => c.text),
      pageComments: pc.map((c) => c.text),
    }),
    instances: st.instances.map((i) => ({
      ...M.pick(
        i,
        'id instanceKey displayName alias adbPort serial online fbLiteInstalled accountState accountId accountName fbLiteVersion? androidSdk? numericAccountId? managedIdentities#',
      ),
      displayTitle: bluestacksDisplayTitle(i),
      resolution: `${i.fbWidth}x${i.fbHeight}`,
      portraitReady: isBluestacksPortraitResolution(i.fbWidth, i.fbHeight),
      identityType: i.identityType ?? 'unknown',
      stat: st.profileCounts[i.id] ?? null,
      pageStat: st.pageBumperProfileCounts[i.id] ?? null,
      activeStat: st.activeProfileCounts?.[i.id] ?? null,
      posterStat: st.posterProfileCounts?.[i.id] ?? null,
      inviterStat: st.inviterProfileCounts?.[i.id] ?? null,
    })),
  };
}

async function handleBluestacks(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const action = M.strArg(args.action) || 'state';
  const scopeMode: 'group' | 'page' =
    ['save_page_settings', 'start_page_bumper', 'stop_page_bumper'].includes(action) ||
    args.mode === 'page'
      ? 'page'
      : 'group';
  const rawQueries = M.collectRawIds(args, 'instanceIds', 'instanceId');
  const bs = deps.bluestacksService;
  const render = (st: BsState) => formatBsState(deps, st, args.includeComments === true);
  const resolveIds = async (force = false) =>
    rawQueries.length === 0
      ? []
      : M.resolveBluestacksInstanceIds((await bs.state(force)).instances, rawQueries);
  const optIds = async () => ((await resolveIds(false)).length > 0 ? resolveIds(false) : undefined);
  const reqIds = async (force = false, single = false) => {
    M.req(
      rawQueries.length > 0,
      single ? 'INSTANCE_ID_REQUIRED' : 'INSTANCE_IDS_REQUIRED',
      `${action} 需要提供 instanceIds 或 instanceId`,
    );
    return resolveIds(force);
  };
  const prepRun = async (addGroup: boolean, addPage: boolean) => {
    const ids = await reqIds(true);
    const groupIds = addGroup ? M.extractGroupIds(args.groupIds) : [];
    const pageIds = addPage ? M.extractPageIds(args.pageIds) : [];
    if (args.autoAddMissingTargets !== false) await M.ensureBumperTargets(deps, groupIds, pageIds);
    return { ids, groupIds, pageIds };
  };

  if (action === 'save_settings' || action === 'save_page_settings') {
    const cur = await bs.state(false);
    const merged = {
      ...(scopeMode === 'page' ? cur.pageBumperSettings : cur.bumperSettings),
      ...M.objArg(args.settings),
    };
    const updated = await (scopeMode === 'page'
      ? bs.savePageBumperSettings(merged)
      : bs.saveBumperSettings(merged));
    return {
      ...(await render(updated)),
      updatedScope: scopeMode,
      appliedSettings: scopeMode === 'page' ? updated.pageBumperSettings : updated.bumperSettings,
    };
  }
  if (action === 'save_comments') {
    const bumper = deps.getGroupBumperService();
    M.req(bumper, 'BUMPER_UNAVAILABLE', '留言池服务当前不可用', 503);
    const curBs = await bs.state(false);
    const baseBs = scopeMode === 'page' ? curBs.pageBumperSettings : curBs.bumperSettings;
    const consume =
      typeof args.consumeCommentOnUse === 'boolean'
        ? args.consumeCommentOnUse
        : baseBs.consumeCommentOnUse;
    const bumperSt = await bumper.manage(scopeMode === 'page' ? 'page-comments' : 'comments', {
      texts: M.strArrArg(args.comments),
      consumeCommentOnUse: consume,
      scope: scopeMode,
    });
    if (consume !== baseBs.consumeCommentOnUse)
      await (scopeMode === 'page'
        ? bs.savePageBumperSettings({ ...baseBs, consumeCommentOnUse: consume })
        : bs.saveBumperSettings({ ...baseBs, consumeCommentOnUse: consume }));
    return {
      mode: scopeMode,
      consumeCommentOnUse: consume,
      commentsCount: ((scopeMode === 'page' ? bumperSt.pageComments : bumperSt.comments) ?? [])
        .length,
    };
  }
  if (action === 'logs') {
    const bumper = deps.getGroupBumperService();
    M.req(bumper, 'BUMPER_UNAVAILABLE', '顶贴日志服务当前不可用', 503);
    const limit = M.clampInt(args.limit, 50, 1, 200);
    const bsOnly = args.bluestacksOnly !== false;
    const instById = new Map((await bs.state(false)).instances.map((i) => [i.id, i]));
    const filterIds =
      rawQueries.length > 0
        ? new Set(M.resolveBluestacksInstanceIds([...instById.values()], rawQueries))
        : null;
    const logs = (
      await bumper.logs(
        typeof args.search === 'string' ? args.search : '',
        undefined,
        undefined,
        Math.max(limit * 3, 120),
        scopeMode,
      )
    )
      .filter(
        (r) => (!bsOnly || instById.has(r.profileId)) && (!filterIds || filterIds.has(r.profileId)),
      )
      .slice(0, limit)
      .map((row) => {
        const inst = instById.get(row.profileId);
        return {
          ...row,
          instanceDisplayTitle: inst ? bluestacksDisplayTitle(inst) : null,
          bumpedAtLocal: M.formatLocalDateTime(row.bumpedAt),
        };
      });
    return { mode: scopeMode, bluestacksOnly: bsOnly, count: logs.length, logs };
  }

  const stateHandlers: Record<string, () => Promise<BsState>> = {
    state: () => bs.state(false),
    refresh: () => bs.state(true),
    stop_health_check: () => bs.stopHealthCheck(),
    stop_all: async () => bs.stopAllForInstances(await optIds()),
    launch: async () => bs.launchInstances({ instanceIds: await reqIds() }),
    close: async () => bs.closeInstances({ instanceIds: await reqIds() }),
    inspect: async () => bs.inspectInstances({ instanceIds: await reqIds() }),
    show: async () => bs.showInstance({ instanceId: (await reqIds(false, true))[0] }),
    arrange: async () => {
      const ids = await optIds();
      return bs.arrangeWindows({
        ...(ids && { instanceIds: ids }),
        ...M.pickTypes(args, 'columns:n gap:n'),
      });
    },
    install_apk: async () =>
      bs.installApk({ instanceIds: await reqIds(), ...M.pickTypes(args, 'apkPath:s') }),
    switch_identity: async () =>
      bs.switchIdentity({
        instanceId: (await reqIds(false, true))[0],
        ...M.pickTypes(args, 'targetName:s'),
        ...(args.targetType === 'personal' || args.targetType === 'page'
          ? { targetType: args.targetType }
          : {}),
      }),
    start_active: async () =>
      bs.startActive({
        instanceIds: await reqIds(true),
        ...M.pickTypes(args, 'combinationId:s quickStep:o'),
        ...(args.closeWindowOnFinish === true && { closeWindowOnFinish: true }),
      }),
    stop_active: async () => bs.stopExtra('active', await optIds()),
    stop_poster: async () => bs.stopExtra('poster', await optIds()),
    stop_inviter: async () => bs.stopExtra('inviter', await optIds()),
    start_poster: async () => {
      const { ids: instanceIds, groupIds } = await prepRun(true, false);
      return bs.startPoster({
        instanceIds,
        materialIds: M.strArrArg(args.materialIds),
        groupIds,
        ...M.pickTypes(args, 'maxGroupsPerInstance:n postToTimeline:b'),
      });
    },
    start_inviter: async () => {
      const { ids: instanceIds, groupIds } = await prepRun(true, false);
      return bs.startInviter({ instanceIds, groupIds, ...M.pickTypes(args, 'invitesPerGroup:n') });
    },
    start_bumper: async () => {
      const { ids: profileIds, groupIds, pageIds } = await prepRun(true, true);
      return bs.startBumper({ profileIds, groupIds, pageIds });
    },
    start_page_bumper: async () => {
      const { ids: profileIds, pageIds } = await prepRun(false, true);
      return bs.startPageBumper({ profileIds, pageIds });
    },
    stop_bumper: async () => {
      const ids = await optIds();
      return bs.stopBumper(ids, ids ? undefined : 'group');
    },
    stop_page_bumper: async () => bs.stopBumper(await optIds(), 'page'),
    save_paths: () => {
      const p: Record<string, unknown> = {};
      for (const k of ['installDir', 'confPath', 'apkPath'] as const)
        if (k in args) p[k] = M.strArg(args[k]) || null;
      return bs.updatePaths(p);
    },
    rename_instance: async () =>
      bs.renameInstance({
        id: (await reqIds(false, true))[0],
        alias: M.strArg(args.alias) || null,
      }),
    save_risk_limits: async () => {
      const cur = await bs.state(false);
      return bs.saveRiskLimitSettings({
        ...(cur.riskLimitSettings ?? {}),
        ...(typeof args.riskLimits === 'object' && args.riskLimits !== null
          ? M.objArg(args.riskLimits)
          : M.objArg(args.settings)),
      });
    },
    start_health_check: async () => {
      let ids = await resolveIds(false);
      if (ids.length === 0) ids = (await bs.state(true)).instances.map((i) => i.id);
      M.req(ids.length > 0, 'INSTANCE_IDS_REQUIRED', '未找到可体检的蓝蝶实例');
      return bs.startHealthCheck({
        instanceIds: ids,
        ...M.pickTypes(args, 'maxConcurrency:n autoLaunch:b autoInstallApk:b closeOnFinish:b'),
      });
    },
  };
  return render(await (stateHandlers[action] ?? (() => bs.state(false)))());
}

export function createBluestacksTools(deps: M.WorkbenchMcpDependencies): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_bluestacks_control',
      '控制与监控蓝蝶模拟器多开全功能。',
      M.sp(
        `@groupIds|@pageIds|@autoAddMissingTargets|@settings|@comments|@consumeCommentOnUse|@includeComments|@search|@limit|action:e(${BS_ACTIONS}):操作类型|mode:e(group page):顶贴作用域|instanceIds:sa:实例标识列表|instanceId:s:单个实例标识|alias:u(string null):实例备注名|installDir:u(string null):蓝蝶安装目录|confPath:u(string null):conf路径|apkPath:u(string null):APK路径|columns:n(1,8):平铺列数|gap:n(0,40):平铺间距|targetName:s:目标身份名|targetType:e(personal page):身份类型|combinationId:s:活跃组合ID|quickStep:o:快捷单步|closeWindowOnFinish:b:完后关窗|materialIds:sa:发帖素材ID|maxGroupsPerInstance:n(1,50):单台发帖上限|postToTimeline:b:发到时间线|invitesPerGroup:n(1,50):每组邀请上限|bluestacksOnly:b:仅蓝蝶记录|maxConcurrency:n(1,10):体检并发|autoLaunch:b:自动拉起窗口|autoInstallApk:b:自动装包|closeOnFinish:b:体检后关窗|riskLimits:o:风控限额`,
      ),
      (args) => handleBluestacks(deps, args),
      { req: 'action' },
    ),
  ];
}
