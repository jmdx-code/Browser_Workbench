import { isBluestacksPortraitResolution } from '../../shared/bluestacks.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../../shared/facebook-target-id.js';
import { isTargetIncomplete } from '../../shared/group-bumper.js';
import * as M from './mcp-context.js';
const cnt = <T>(arr: readonly T[], fn: (x: T) => boolean) => arr.filter(fn).length;
async function handleOverview(deps: M.WorkbenchMcpDependencies) {
  const now = Date.now();
  const [
    snapshot,
    profiles,
    activeModules,
    posterSt,
    inviterSt,
    bsSt,
    taskOv,
    bumperSt,
    schedSt,
    sheetsOv,
  ] = await Promise.all([
    deps.workspaceService.snapshot(),
    M.buildEnrichedProfiles(deps),
    deps.featureExecution.activeModuleLabels(),
    deps.groupPosterService.state(),
    deps.groupInviterService.state(),
    deps.bluestacksService.state(false),
    deps.taskService ? deps.taskService.overview() : Promise.resolve(null),
    deps.getGroupBumperService()?.state(),
    deps
      .getAutoSchedulerService?.()
      ?.state()
      .catch(() => null) ?? Promise.resolve(null),
    deps
      .getGoogleSheetsService?.()
      ?.overview()
      .catch(() => null) ?? Promise.resolve(null),
  ]);
  const online = profiles.filter((p) => p.online);
  const posterTasks = posterSt.tasks ?? [];
  const schedTasks = posterTasks.filter((t) => t.status === 'scheduled');
  const runTasks = posterTasks.filter((t) => t.status === 'running');
  const activePlans =
    taskOv?.plans.filter((p) => !['STOPPED', 'COMPLETED', 'FAILED'].includes(p.state)) ?? [];
  const diag = M.recentDiagSlice(120, 12, { levels: ['WARN', 'ERROR'] });
  return {
    softwareVersion: deps.softwareVersion,
    extensionVersion: deps.extensionVersion,
    dataDirectory: M.resolveDataDirIntegrity(deps.dataDir),
    now,
    nowLocal: M.formatLocalDateTime(now),
    activeModules,
    profilesSummary: {
      total: profiles.length,
      online: online.length,
      offline: profiles.length - online.length,
      readyForTasks: cnt(online, (p) => p.readyForTasks),
      busy: cnt(online, (p) => p.busyModules.length > 0),
      unresolvedTotal: profiles.reduce((a, p) => a + p.unresolvedCount, 0),
      agentBrowserSupported: cnt(online, (p) => p.supportsAgentBrowser),
      restrictedOrVerification: cnt(online, (p) =>
        ['restricted', 'verification', 'logged-out'].includes(p.account.state),
      ),
    },
    onlineProfiles: online,
    activeAccounts: taskOv && {
      dispatchEnabled: taskOv.dispatchEnabled,
      maxConcurrentProfiles: taskOv.settings.maxConcurrentProfiles,
      combinationsCount: cnt(snapshot.combinations, (c) => c.saved !== null),
      runningPlansCount: cnt(activePlans, (p) => p.state === 'RUNNING'),
      queuedPlansCount: cnt(activePlans, (p) => p.state === 'QUEUED'),
      activePlans: activePlans.slice(0, 10).map((p) => M.mapActivePlan(p)),
    },
    groupPoster: {
      ...M.pick(posterSt, 'running statusText'),
      groupsCount: posterSt.groups.length,
      materialsCount: posterSt.materials.length,
      todayPostsTotal: Object.values(posterSt.profileCounts).reduce(
        (a, i) => a + (i.today ?? 0),
        0,
      ),
      scheduledTasksCount: schedTasks.length,
      runningTasksCount: runTasks.length,
      pendingReviewCount: (posterSt.pendingReviewOperations ?? []).length,
      scheduledTasks: schedTasks
        .slice(0, 10)
        .map((t) =>
          M.pick(t, 'id materialId captionPreview scheduledAt@ totalGroups accountMode profileIds'),
        ),
      runningTasks: runTasks.map((t) =>
        M.pick(t, 'id materialId postedCount skippedCount totalGroups statusReason'),
      ),
    },
    groupBumper: bumperSt
      ? {
          ...M.pick(bumperSt, 'running statusText pageBumperRunning pageBumperStatusText'),
          groupsCount: bumperSt.groups.length,
          pagesCount: bumperSt.pages.length,
          pendingReviewCount: (bumperSt.pendingReviewOperations ?? []).length,
        }
      : null,
    groupInviter: {
      ...M.pick(inviterSt, 'running statusText runId?'),
      groupsCount: inviterSt.groups.length,
    },
    bluestacks: {
      adbReady: Boolean(bsSt.config?.adbReady),
      playerReady: Boolean(bsSt.config?.playerReady),
      ...M.pick(bsSt, 'running statusText pageBumperRunning pageBumperStatusText'),
      groupEnableSound: Boolean(bsSt.bumperSettings?.enableSound),
      pageEnableSound: Boolean(bsSt.pageBumperSettings?.enableSound),
      totalInstances: bsSt.instances.length,
      onlineInstances: cnt(bsSt.instances, (i) => i.online),
      portraitReadyInstances: cnt(
        bsSt.instances,
        (i) => i.online && isBluestacksPortraitResolution(i.fbWidth, i.fbHeight),
      ),
    },
    autoScheduler: schedSt && {
      ...M.pick(
        schedSt,
        'running powerLockMode activeBrowserWorkers queuedBrowserTargets activeBluestacksWorkers queuedBluestacksTargets',
      ),
      schedulesCount: schedSt.schedules.length,
      enabledSchedulesCount: cnt(schedSt.schedules, (s) => s.enabled),
      activeRunsCount: schedSt.activeRuns.length,
    },
    googleSheets: sheetsOv && {
      ...M.pick(sheetsOv.auth, 'authorized authorizedEmail'),
      authError: sheetsOv.auth.lastError,
      ...M.pick(sheetsOv, 'runningScheduleCount runningRecordsCount'),
      linksCount: sheetsOv.links.length,
      enabledLinksCount: cnt(sheetsOv.links, (l) => l.enabled),
      errorLinksCount: cnt(sheetsOv.links, (l) => Boolean(l.runtime.lastError)),
    },
    agentBrowserSessions: deps.agentBrowser.listSessions(),
    recentWarningsAndErrors: diag.map((e) =>
      M.pick(e, 'id localTime level category event profileId? profileName? reason?'),
    ),
  };
}
const KNOWN_GATE_ERRORS = new Set([
  'FACEBOOK_ACCOUNT_LOGGED_OUT',
  'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED',
  'FACEBOOK_ACCOUNT_RESTRICTED',
]);
async function handleInspectProfiles(
  deps: M.WorkbenchMcpDependencies,
  args: Record<string, unknown>,
) {
  const inspection = deps.inspection;
  M.req(inspection, 'INSPECTION_UNAVAILABLE', '账号实时检测服务当前不可用', 503);
  const mode: 'auto' | 'passive' | 'active' =
    args.mode === 'passive' || args.mode === 'active' ? args.mode : 'auto';
  const before = await M.buildEnrichedProfiles(deps);
  const rawPids = M.strArrArg(args.profileIds);
  const requestedIds =
    rawPids.length > 0
      ? M.resolveUniqueIds(rawPids, (r) => M.resolveProfileIdentifierFromList(before, r))
      : before.filter((p) => p.readyForTasks).map((p) => p.id);
  if (requestedIds.length === 0)
    return {
      mode,
      inspectedIds: [],
      message: '当前没有符合条件的在线闲置浏览器可检测',
      profiles: [],
    };
  const deadline = Date.now() + M.clampInt(args.timeoutSeconds, 35, 3, 90) * 1000;
  const results: Record<
    string,
    {
      method: 'passive_existing_tab' | 'active_background_tab' | 'skipped';
      ok: boolean;
      reason: string;
    }
  > = {};
  const setRes = (
    id: string,
    method: 'passive_existing_tab' | 'active_background_tab' | 'skipped',
    ok: boolean,
    reason: string,
  ) => (results[id] = { method, ok, reason });
  if (mode !== 'active') {
    inspection.request(requestedIds);
    await M.pollUntil(
      Math.min(deadline, Date.now() + 8_000),
      300,
      async () =>
        !requestedIds.some((id) => ['QUEUED', 'READING'].includes(inspection.get(id)?.state ?? '')),
    );
    for (const id of requestedIds) {
      const row = inspection.get(id);
      setRes(
        id,
        'passive_existing_tab',
        row?.state === 'OBSERVED',
        row?.reason || row?.state || 'UNKNOWN',
      );
    }
  }
  const kernel = deps.getMainKernel();
  if (kernel) {
    const todo = requestedIds.filter(
      (i) =>
        mode === 'active' ||
        (mode === 'auto' && results[i]?.reason === 'INSPECTION_DOCUMENT_NOT_READY'),
    );
    for (const id of todo) {
      const remMs = deadline - Date.now();
      const peer = deps.core.peers.get(id);
      const [busy, unresolved] = await Promise.all([
        deps.featureExecution.busyModuleLabels([id]),
        deps.store.unresolved(id),
      ]);
      if (
        remMs < 2_500 ||
        !peer?.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED' ||
        busy.length > 0 ||
        unresolved.length > 0
      ) {
        setRes(
          id,
          'skipped',
          false,
          remMs < 2_500 ? 'INSPECTION_BATCH_TIMEOUT_EXCEEDED' : 'INSPECTION_PROFILE_NOT_IDLE',
        );
        continue;
      }
      const epoch = peer.epoch;
      try {
        const r = await kernel.inspectFacebookAccountSilently(
          peer,
          async () => {
            const p = deps.core.peers.get(id);
            if (!p?.online || p.epoch !== epoch || !p.synced || p.phase !== 'PAUSED')
              throw new Error('INSPECTION_CONNECTION_CHANGED');
          },
          Math.max(5_000, Math.min(22_000, remMs)),
        );
        setRes(id, 'active_background_tab', true, r.actor ? 'OBSERVED_LOGGED_IN' : 'OBSERVED_PAGE');
      } catch (err) {
        const msg = M.errMsg(err);
        setRes(id, 'active_background_tab', KNOWN_GATE_ERRORS.has(msg), msg);
      }
    }
  }
  const idSet = new Set(requestedIds);
  return {
    mode,
    inspectedIds: requestedIds,
    inspectionResults: results,
    profiles: (await M.buildEnrichedProfiles(deps)).filter((p) => idSet.has(p.id)),
  };
}
async function handleManageTargets(
  deps: M.WorkbenchMcpDependencies,
  args: Record<string, unknown>,
) {
  const action = M.strArg(args.action) || 'list';
  const kind: 'groups' | 'pages' = args.kind === 'pages' ? 'pages' : 'groups';
  const folders = (await deps.workspaceService.repository.targetFolders?.(kind)) ?? [];
  if (action === 'list_folders') return { kind, folders };
  const bumper = deps.getGroupBumperService();
  const poster = deps.groupPosterService;
  if (kind === 'pages') M.req(bumper, 'BUMPER_UNAVAILABLE', '专页顶贴目标库服务未加载', 503);
  const read = async () => {
    if (kind === 'groups') {
      const st = await poster.state();
      return {
        items: st.groups,
        refreshing: Boolean(st.groupAvatarRefreshing),
        statusText: st.statusText,
      };
    }
    const st = bumper ? await bumper.state() : null;
    return {
      items: st?.pages ?? [],
      refreshing: Boolean(st?.metadataRefreshing || st?.pageAvatarRefreshing),
      statusText: st?.pageBumperStatusText ?? '',
    };
  };
  const finishOp = async (extra: object) => {
    await M.pollUntil(
      Date.now() + Math.max(0, Math.min(60, Number(args.waitRefreshSeconds ?? 5))) * 1000,
      400,
      async () => !(await read()).refreshing,
    );
    const st = await read();
    return {
      kind,
      ...M.pick(st, 'refreshing statusText'),
      ...extra,
      items: st.items.slice(0, 200).map(M.summarizeTarget),
    };
  };
  const op = (method: 'add' | 'delete' | 'refresh' | 'refresh-stop', payload: object) => {
    if (kind === 'pages') return bumper?.manage(`pages/${method}`, payload);
    if (method === 'add') return poster.addGroups(payload as { items: Array<{ id: string }> });
    if (method === 'delete') return poster.deleteGroups(payload as { ids: string[] });
    return method === 'refresh'
      ? poster.refreshGroups(payload as { ids?: string[] })
      : poster.stopRefreshGroups();
  };
  return M.act(action, {
    list: async () => {
      const { items: allItems } = await read();
      const [rawSearch, folderFilter] = [M.strArg(args.search), M.strArg(args.folderId)];
      const extracted = rawSearch
        ? (kind === 'groups' ? extractFacebookGroupId : extractFacebookPageId)(
            rawSearch,
          ).toLowerCase()
        : '';
      const q = rawSearch.toLowerCase();
      const matched = allItems.filter(
        (i) =>
          (!folderFilter || (i.folderId ?? '') === folderFilter) &&
          (args.incompleteOnly !== true || isTargetIncomplete(i)) &&
          (!q ||
            (extracted && i.id.toLowerCase() === extracted) ||
            i.id.toLowerCase().includes(q) ||
            i.name.toLowerCase().includes(q)),
      );
      return {
        kind,
        totalInLibrary: allItems.length,
        totalMatched: matched.length,
        folders,
        items: matched.slice(0, M.clampInt(args.limit, 200, 1, 500)).map(M.summarizeTarget),
      };
    },
    add: async () => {
      const items = M.parseTargetAddItems(args, M.strArg(args.folderId) || undefined);
      M.req(
        items.length > 0,
        'EMPTY_TARGETS',
        '请通过 items 或 rawText 提供至少 1 个目标链接或 ID',
      );
      await op('add', { items });
      return {
        ...(await finishOp({ addedRequestedCount: items.length })),
        totalInLibrary: (await read()).items.length,
      };
    },
    delete: async () => {
      const ids = M.strArrArg(args.ids);
      M.req(ids.length > 0, 'IDS_REQUIRED', 'delete 操作必须提供要删除的 ids 数组');
      await op('delete', { ids });
      return { kind, deletedRequestedIds: ids, remainingCount: (await read()).items.length };
    },
    refresh: async () => {
      const ids = M.strArrArg(args.ids);
      await op('refresh', ids.length > 0 ? { ids } : {});
      return finishOp({ incompleteCount: cnt((await read()).items, isTargetIncomplete) });
    },
    stop_refresh: async () => (
      await op('refresh-stop', {}),
      { kind, statusText: (await read()).statusText }
    ),
  });
}
export function createWorkspaceAndTargetTools(
  deps: M.WorkbenchMcpDependencies,
): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_get_overview',
      '获取 Workbench 全景运行状态与近期异常。',
      {},
      () => handleOverview(deps),
      { readOnly: true },
    ),
    M.reg(
      'wb_list_profiles',
      '查询浏览器配置与账号缓存。',
      '@search|onlineOnly:b:仅在线|readyOnly:b:仅空闲就绪|accountState:e(logged-in logged-out restricted verification unknown):账号状态',
      async (args) => {
        const [q, acct] = [M.strArg(args.search).toLowerCase(), M.strArg(args.accountState)];
        const [snapshot, all] = await Promise.all([
          deps.workspaceService.snapshot(),
          M.buildEnrichedProfiles(deps),
        ]);
        const profiles = all.filter(
          (p) =>
            !(args.onlineOnly === true && !p.online) &&
            !(args.readyOnly === true && !p.readyForTasks) &&
            !(acct && p.account.state !== acct) &&
            (!q ||
              [
                p.id,
                p.alias,
                p.browserName,
                p.displayName,
                p.groupName,
                p.account.name,
                p.account.id,
              ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(q)),
        );
        return { totalMatched: profiles.length, groups: snapshot.groups, profiles };
      },
      { readOnly: true },
    ),
    M.reg(
      'wb_inspect_profiles',
      '触发在线闲置浏览器后台身份检测。',
      '@profileIds|mode:e(auto passive active):检测模式|timeoutSeconds:n(3,90):超时秒数',
      (args) => handleInspectProfiles(deps, args),
    ),
    M.reg(
      'wb_manage_targets',
      '管理共享 Facebook 小组库与专页库。',
      M.sp(
        '@search|action:e(list add delete refresh stop_refresh list_folders):操作|kind:e(groups pages):目标库|folderId:s:文件夹ID|incompleteOnly:b:仅未补齐|limit:n(1,500):条数上限|rawText:s:多行链接ID|ids:sa:目标ID列表|waitRefreshSeconds:n(0,60):刷新等待秒数',
        { items: M.arrObj('idOrUrl:s:链接或 ID|name:s:名称|folderId:s', '新增列表', 'idOrUrl') },
      ),
      (args) => handleManageTargets(deps, args),
      { req: 'action kind' },
    ),
    M.reg(
      'wb_read_table',
      '读取本地发帖排期/资源表。',
      'filePath:s:本地文件路径|sheet:u(string number):工作表名或索引|hasHeader:b:首行为表头|offset:n(0,):起始行偏移|limit:n(1,1000):返回行数上限',
      async (args) => {
        const filePath = M.strArg(args.filePath);
        M.req(filePath, 'FILE_PATH_REQUIRED', '必须提供本地表格文件路径 filePath');
        return M.readSpreadsheetOrTableFile(filePath, {
          sheet:
            typeof args.sheet === 'string' || typeof args.sheet === 'number'
              ? args.sheet
              : undefined,
          hasHeader: typeof args.hasHeader === 'boolean' ? args.hasHeader : true,
          ...M.pickTypes(args, 'offset:n limit:n'),
        });
      },
      { req: 'filePath', readOnly: true },
    ),
  ];
}
