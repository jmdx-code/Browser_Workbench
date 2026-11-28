import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { admitProfilesForStart } from '../../application/profile-start-admission.js';
import { failError } from '../../domain/workspace.js';
import { isUserSavedCombination } from '../../shared/auto-scheduler.js';
import type { SavedCombination } from '../../shared/contracts.js';
import type { Plan } from '../../shared/task-contracts.js';
import { MAX_CONCURRENT_PROFILES } from '../../shared/task-policies.js';
import * as M from './mcp-context.js';
const ACTIVE_STATES = ['QUEUED', 'RUNNING'] as const;
const summarizePlan = (p: Plan, names: ReadonlyMap<string, string>) => ({
  ...M.pick(
    p,
    'id batchId profileId combinationId version accountId state reason controlConfirmed round position createdAt@ updatedAt@ closeBrowserOnFinish!',
  ),
  profileDisplayName: names.get(p.profileId) ?? p.profileId,
  combinationName: p.snapshot.name,
  stepsCount: p.snapshot.steps.length,
});
const summarizeStep = (s: NonNullable<SavedCombination['saved']>['steps'][number]) => {
  if (s.type === 'post')
    return {
      id: s.id,
      type: s.type,
      destination: s.destination ?? 'post',
      count: s.count,
      resourceMode: s.resourceMode ?? 'directory',
    };
  if (s.type === 'friends')
    return {
      id: s.id,
      type: s.type,
      friendAction: s.friendAction ?? 'accept',
      ...M.pick(s, 'acceptMode maxAccepts durationMinutes'),
    };
  if (s.type === 'feed')
    return {
      id: s.id,
      type: s.type,
      ...M.pick(s, 'durationMinutes maxLikes'),
      feedMode: s.feedMode ?? 'home',
      ...M.pickTypes(
        s as unknown as Record<string, unknown>,
        'detourDwellSeconds:n randomProfileVisitChance:n randomPageVisitChance:n',
      ),
      ...(s.targetPages?.length && { targetPagesCount: s.targetPages.length }),
    };
  return { id: s.id, type: s.type, ...M.pick(s, 'durationMinutes maxLikes') };
};
async function startActiveAction(
  deps: M.WorkbenchMcpDependencies,
  taskService: NonNullable<M.WorkbenchMcpDependencies['taskService']>,
  args: Record<string, unknown>,
  rawPids: string[],
) {
  const rawCombo = M.strArg(args.combinationId);
  M.req(rawCombo, 'COMBINATION_ID_REQUIRED', 'start 需要提供 combinationId');
  M.req(rawPids.length > 0, 'PROFILE_IDS_REQUIRED', 'start 需要提供至少 1 个 profileIds');
  const [snapshot, profileIds] = await Promise.all([
    deps.workspaceService.snapshot(),
    M.resolveProfileIds(deps, rawPids),
  ]);
  const comboRow = M.resolveEntityIdentifier(
    snapshot.combinations.filter(isUserSavedCombination),
    rawCombo,
    {
      prefix: 'COMBINATION',
      label: '任务组合',
      emptyMsg: '请提供 combinationId（UUID 或任务组合名称）',
      emptyHints: '当前尚未创建已保存的任务组合',
      exactFields: (c) => [c.saved?.name],
      formatLabel: (c) => `${c.saved?.name ?? c.id} (id=${c.id})`,
    },
  );
  if (!comboRow.saved || comboRow.version < 1)
    return M.errorResult('COMBINATION_NOT_PUBLISHED', `任务组合 "${comboRow.id}" 尚未保存发布`);
  if (args.timing != null)
    failError(
      'TASK_TIMING_REMOVED',
      '活跃账号旧版 timing 定时已移除，请改用 scheduledAt（单次定时排班）或 wb_scheduler_control',
      400,
    );
  await deps.workspaceService.requireProfiles(profileIds);
  if (args.scheduledAt != null) {
    const parsed = M.parseFlexibleScheduleTime(args.scheduledAt);
    if (parsed.mode === 'scheduled' && parsed.scheduledAt) {
      const schedSvc = deps.getAutoSchedulerService?.();
      M.req(schedSvc, 'AUTO_SCHEDULER_UNAVAILABLE', '定时排班服务未加载', 503);
      const { scheduleId, created } = await M.scheduleOnceViaAutoScheduler(
        schedSvc,
        `活跃 · ${comboRow.saved.name}`,
        profileIds,
        parsed.scheduledAt,
        { id: randomUUID(), type: 'active-combination', combinationId: comboRow.id },
      );
      return {
        combinationId: comboRow.id,
        combinationName: comboRow.saved.name,
        version: comboRow.version,
        mode: 'scheduled',
        rolledToNextDay: parsed.rolledToNextDay,
        scheduledViaAutoScheduler: true,
        scheduleId,
        scheduledAt: parsed.scheduledAt,
        scheduledAtLocal: M.formatLocalDateTime(parsed.scheduledAt),
        task: created ? { id: created.id, name: created.name } : null,
      };
    }
  }
  const isOnline = (id: string) => Boolean(deps.core.peers.get(id)?.online);
  const launchable = new Set<string>();
  if (deps.profileLifecycle) {
    const offline: string[] = [];
    for (const id of profileIds)
      if (!isOnline(id) && !(await taskService.hasProfilePlanInStates(id, ACTIVE_STATES)))
        offline.push(id);
    if (offline.length > 0) {
      if (typeof deps.profileLifecycle.getStatus === 'function') {
        for (const st of await deps.profileLifecycle.getStatus(offline))
          if (st.launchable) launchable.add(st.profileId);
      } else offline.forEach((id) => launchable.add(id));
    }
  }
  const admission = await admitProfilesForStart({
    requestedProfileIds: profileIds,
    currentModuleId: 'active-accounts',
    isAlreadyRunningInCurrentModule: (id) => taskService.hasProfilePlanInStates(id, ACTIVE_STATES),
    busyModuleLabelsForProfile: (id) =>
      deps.featureExecution.busyModuleLabels([id], 'active-accounts'),
    isProfileBusyInOtherModule: (id) => deps.featureExecution.isProfileBusy(id, 'active-accounts'),
    isProfileReady: (id) => isOnline(id) || launchable.has(id),
  });
  if (admission.admittedProfileIds.length === 0) {
    if (admission.skippedBusy.length > 0)
      return M.errorResult(
        'PROFILE_BUSY',
        admission.skippedBusy[0]?.reason ?? '所选浏览器正在执行其他任务',
        { skippedBusy: admission.skippedBusy },
      );
    if (admission.alreadyRunningIds.length > 0 && admission.skippedOffline.length === 0)
      return M.errorResult('PROFILE_PLAN_BUSY', '所选浏览器已有运行或等待中的任务组合', {
        alreadyRunningIds: admission.alreadyRunningIds,
      });
    return M.errorResult(
      'PROFILE_OFFLINE',
      admission.skippedOffline[0]?.reason ?? '所选浏览器未连接',
      { skippedOffline: admission.skippedOffline },
    );
  }
  const startRes = await taskService.start({
    requestId: randomUUID(),
    combinationId: comboRow.id,
    version: comboRow.version,
    profileIds: admission.admittedProfileIds,
    ...(args.closeBrowserOnFinish === true && { closeBrowserOnFinish: true }),
  });
  const names = await M.buildProfileDisplayNameMap(deps);
  return {
    combinationId: comboRow.id,
    combinationName: comboRow.saved.name,
    version: comboRow.version,
    mode: 'immediate',
    ...M.pick(admission, 'admittedProfileIds skippedBusy skippedOffline alreadyRunningIds'),
    plansCount: startRes.plans.length,
    plans: startRes.plans.map((p) => summarizePlan(p, names)),
  };
}
async function queryActiveRecordsSql(
  deps: M.WorkbenchMcpDependencies,
  args: Record<string, unknown>,
) {
  const rawPid = M.strArg(args.profileId);
  const resolvedPid = rawPid ? await M.resolveProfileId(deps, rawPid) : undefined;
  const stRaw = M.strArg(args.status);
  const status = ['all', 'running', 'completed', 'failed', 'review'].includes(stRaw)
    ? stRaw
    : 'all';
  const q = M.strArg(args.query).slice(0, 100);
  const offset = Math.max(0, Number.parseInt(M.strArg(args.cursor), 10) || 0);
  const limit = M.clampInt(args.limit, 50, 1, 200);
  const dbPath = path.join(deps.dataDir, 'workspace.sqlite');
  if (!existsSync(dbPath)) return { total: 0, recordsCount: 0, nextCursor: null, records: [] };
  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (resolvedPid) (conds.push('p.profile_id = ?'), params.push(resolvedPid));
  const statusSql: Record<string, string> = {
    running: "s.status = 'ACTIVE' AND p.state IN ('QUEUED','RUNNING')",
    completed: "s.status = 'COMPLETED'",
    failed: "(s.status = 'FAILED' OR (s.status = 'ACTIVE' AND p.state = 'FAILED'))",
    review: "(s.status = 'FAILED' AND json_extract(s.outcome, '$.businessResult') = 'UNKNOWN')",
  };
  if (statusSql[status]) conds.push(statusSql[status]);
  if (q) {
    const pat = `%${q}%`;
    conds.push(
      "(p.profile_id LIKE ? OR json_extract(p.snapshot, '$.name') LIKE ? OR p.reason LIKE ?)",
    );
    params.push(pat, pat, pat);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM task_steps s JOIN task_plans p ON p.id = s.job_id ${where}`,
      )
      .get(...params) as { cnt?: number } | undefined;
    const total = Number(totalRow?.cnt ?? 0);
    const rows = db
      .prepare(
        `SELECT s.id AS stepId, s.job_id AS planId, p.profile_id AS profileId, p.combination_id AS combinationId, json_extract(p.snapshot, '$.name') AS combinationName, s.round, s.position, json_extract(s.spec, '$.type') AS type, s.status, p.state AS planState, p.reason AS planReason, s.progress, s.outcome, p.created_at AS planCreatedAt, p.updated_at AS planUpdatedAt FROM task_steps s JOIN task_plans p ON p.id = s.job_id ${where} ORDER BY p.updated_at DESC, s.round DESC, s.position DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    const records = rows.map((r) => ({
      ...r,
      progress: typeof r.progress === 'string' ? (JSON.parse(r.progress) as unknown) : r.progress,
      outcome: typeof r.outcome === 'string' ? (JSON.parse(r.outcome) as unknown) : null,
      planCreatedAtLocal: M.formatLocalDateTime(Number(r.planCreatedAt ?? 0)),
      planUpdatedAtLocal: M.formatLocalDateTime(Number(r.planUpdatedAt ?? 0)),
    }));
    return {
      total,
      recordsCount: records.length,
      nextCursor: offset + records.length < total ? String(offset + records.length) : null,
      records,
    };
  } finally {
    db.close();
  }
}
async function handleActiveAccounts(
  deps: M.WorkbenchMcpDependencies,
  args: Record<string, unknown>,
) {
  const taskService = deps.taskService;
  M.req(taskService, 'TASKS_UNAVAILABLE', '活跃账号任务执行服务未启用', 503);
  const action = M.strArg(args.action) || 'state';
  const rawPids = M.collectRawIds(args, 'profileIds', 'profileId');
  const stopPlans = async () => {
    const filterPids =
      rawPids.length > 0 ? new Set(await M.resolveProfileIds(deps, rawPids)) : null;
    const planIds = M.strArrArg(args.planIds);
    const filterPlans = planIds.length > 0 ? new Set(planIds) : null;
    const targets = (await taskService.overview()).plans.filter(
      (p) =>
        (p.state === 'QUEUED' || p.state === 'RUNNING') &&
        (!filterPlans || filterPlans.has(p.id)) &&
        (!filterPids || filterPids.has(p.profileId)),
    );
    if (targets.length === 0)
      return { action, matchedPlansCount: 0, acceptedCount: 0, results: [] };
    await deps.workspaceService.requireProfiles([...new Set(targets.map((p) => p.profileId))]);
    const cmdRes = await taskService.command({
      command: 'stop',
      plans: targets.map((p) => ({
        profileId: p.profileId,
        planId: p.id,
        expectedState: p.state,
        expectedUpdatedAt: p.updatedAt,
      })),
    });
    return {
      ok: cmdRes.results.every((r) => r.accepted),
      action,
      matchedPlansCount: targets.length,
      acceptedCount: cmdRes.results.filter((r) => r.accepted).length,
      results: cmdRes.results,
    };
  };
  return M.act(action, {
    save_settings: async () => {
      M.req(
        typeof args.maxConcurrentProfiles === 'number',
        'MAX_CONCURRENT_REQUIRED',
        '需要 maxConcurrentProfiles 参数',
      );
      return {
        settings: await taskService.setSettings({
          maxConcurrentProfiles: Math.floor(args.maxConcurrentProfiles as number),
        }),
      };
    },
    records: () => queryActiveRecordsSql(deps, args),
    start: () => startActiveAction(deps, taskService, args, rawPids),
    stop: stopPlans,
    state: async () => {
      const [snapshot, overview, capabilities, names] = await Promise.all([
        deps.workspaceService.snapshot(),
        taskService.overview(),
        taskService.capabilities(),
        M.buildProfileDisplayNameMap(deps),
      ]);
      const capById = new Map(capabilities.combinations.map((c) => [c.id, c]));
      const combinations = snapshot.combinations.filter(isUserSavedCombination).map((row) => {
        const cap = capById.get(row.id);
        const spec = row.saved;
        return {
          id: row.id,
          name: spec?.name ?? '未命名组合',
          note: spec?.note ?? '',
          published: spec !== null && row.version >= 1,
          ...M.pick(row, 'version revision updatedAt@'),
          enabled: cap?.enabled ?? Boolean(spec),
          reason: cap?.reason ?? '',
          randomOrder: spec?.randomOrder ?? false,
          loop: spec?.loop ?? null,
          stepsCount: spec?.steps.length ?? 0,
          steps: (spec?.steps ?? []).map(summarizeStep),
        };
      });
      const activeSet = new Set<string>(ACTIVE_STATES);
      const visiblePlans =
        args.includeTerminalPlans === true
          ? overview.plans.slice(0, 80)
          : overview.plans.filter((p) => activeSet.has(p.state));
      return {
        dispatchEnabled: overview.dispatchEnabled,
        supportedStepTypes: capabilities.types,
        settings: overview.settings,
        combinationsCount: combinations.length,
        combinations,
        activePlansCount: overview.plans.filter((p) => activeSet.has(p.state)).length,
        plans: visiblePlans.map((p) => summarizePlan(p, names)),
      };
    },
  });
}
async function runSheetsLinkAction(
  svc: NonNullable<ReturnType<NonNullable<M.WorkbenchMcpDependencies['getGoogleSheetsService']>>>,
  linkId: string,
  work: () => Promise<object>,
  opts?: { failOnAllSkipped?: boolean },
) {
  const beforeOv = await svc.overview().catch(() => null);
  const beforeIds = new Set((beforeOv?.logs ?? []).map((l) => l.id));
  const raw = (await work()) as Record<string, unknown>;
  const afterOv = await svc.overview().catch(() => null);
  const linkAfter = afterOv?.links?.find((l) => l.id === linkId);
  const newLogs = (afterOv?.logs ?? []).filter((l) => l.linkId === linkId && !beforeIds.has(l.id));
  const newErrors = newLogs.filter((l) => l.level === 'error').map((l) => l.summary);
  const newWarnings = newLogs.filter((l) => l.level === 'warn');
  const critWarnings = newWarnings
    .filter((w) =>
      /writeback|retry|error|no_browser|no_workers|failed|media|metrics_scrape/i.test(w.action),
    )
    .map((w) => w.summary);
  const runtimeError = linkAfter?.runtime?.lastError ?? null;
  const num = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : 0);
  const failedCount = num('failed') || num('failedCount');
  const writebackFailedCount = num('writebackFailedCount');
  const avatarUploadFailures = num('avatarUploadFailures');
  const rawErrors = Array.isArray(raw.errors) ? (raw.errors as unknown[]).map(String) : [];
  const allSkipped =
    Boolean(opts?.failOnAllSkipped) &&
    num('added') === 0 &&
    num('updated') === 0 &&
    num('deleted') === 0 &&
    num('skipped') > 0;
  const errors = [
    ...new Set([
      ...rawErrors,
      ...newErrors,
      ...critWarnings,
      ...(runtimeError ? [runtimeError] : []),
      ...(allSkipped ? [`导入未命中任何有效记录（跳过 ${num('skipped')} 行）`] : []),
    ]),
  ];
  const warnings = newWarnings.map((w) => w.summary);
  const partialFailure =
    raw.ok === false ||
    raw.partialFailure === true ||
    failedCount > 0 ||
    writebackFailedCount > 0 ||
    avatarUploadFailures > 0 ||
    errors.length > 0;
  return {
    ok: !partialFailure,
    partialFailure,
    ...raw,
    errorCount: Math.max(errors.length, failedCount + writebackFailedCount + avatarUploadFailures),
    warningCount: warnings.length,
    ...(errors.length > 0 && { errors }),
    ...(warnings.length > 0 && { warnings }),
    ...(runtimeError && { runtimeError }),
  };
}
export function createActiveAccountsTools(deps: M.WorkbenchMcpDependencies): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_active_accounts_control',
      '控制与监控「活跃账号」任务组合及全局执行记录。',
      `@profileIds|@profileId|@limit|action:e(state start stop save_settings records):操作类型|combinationId:s:任务组合ID或名称|planIds:sa:计划ID列表|scheduledAt:u(string number null):定时时间（将创建单次定时排班）|maxConcurrentProfiles:n(1,${MAX_CONCURRENT_PROFILES}):最大并发数|status:e(all running completed failed review):状态过滤|query:s:搜索关键词|cursor:s:分页游标|includeTerminalPlans:b:包含已结束计划|closeBrowserOnFinish:b:完后自动关窗`,
      (args) => handleActiveAccounts(deps, args),
      { req: 'action' },
    ),
    M.reg(
      'wb_scheduler_control',
      '管理与监控「定时排班（无人值守全自动流水线）」模块。',
      '@settings|action:e(state save_settings save_schedule toggle duplicate delete run_now stop clear_history):操作类型|schedule:o:排班配置|id:s:排班ID|enabled:b:启用状态|runId:s:场次runId|scheduleId:s:排班scheduleId|targetIds:sa:目标ID列表|keepWindowsOpen:b:保留已开窗口',
      async (a) => {
        const svc = deps.getAutoSchedulerService?.();
        M.req(svc, 'AUTO_SCHEDULER_UNAVAILABLE', '定时排班服务尚未初始化', 503);
        return M.act(M.strArg(a.action) || 'state', {
          state: () => svc.state(),
          save_settings: async () =>
            M.pick(await svc.saveSettings(M.objArg(a.settings)), 'settings powerLockMode'),
          save_schedule: async () => ({
            schedules: (await svc.saveSchedule(a.schedule)).schedules,
          }),
          toggle: async () =>
            M.pick(
              await svc.toggleSchedule({ id: a.id, enabled: Boolean(a.enabled) }),
              'schedules powerLockMode',
            ),
          duplicate: async () => ({
            schedules: (await svc.duplicateSchedule({ id: a.id })).schedules,
          }),
          delete: async () => ({ schedules: (await svc.deleteSchedule({ id: a.id })).schedules }),
          run_now: async () => M.pick(await svc.runNow({ id: a.id }), 'activeRuns running'),
          stop: async () =>
            M.pick(
              await svc.stop({
                ...M.pickTypes(a, 'runId:rs scheduleId:rs keepWindowsOpen:b'),
                ...(Array.isArray(a.targetIds) && { targetIds: a.targetIds }),
              }),
              'running activeRuns',
            ),
          clear_history: async () => ({
            recentRunsCount: (await svc.clearHistory()).recentRuns.length,
          }),
        });
      },
      { req: 'action', errCode: 'SCHEDULER_ERROR' },
    ),
    M.reg(
      'wb_google_sheets_control',
      '管理与控制「Google 云表协同」模块。',
      'action:e(overview read_grid import_library sync_library poll_schedule poll_records refresh_metrics reset_stuck stop):操作类型|linkId:s:表格连接ID|mode:e(incremental overwrite):导入模式',
      async (a) => {
        const svc = deps.getGoogleSheetsService?.();
        M.req(svc, 'GOOGLE_SHEETS_UNAVAILABLE', 'Google 云表协同服务尚未初始化', 503);
        const linkId = M.strArg(a.linkId);
        const reqId = () => (M.req(linkId, 'LINK_ID_REQUIRED', '缺少 linkId'), linkId);
        const linkAct = (fn: (id: string) => Promise<object>, failOnAllSkipped?: boolean) => () =>
          runSheetsLinkAction(
            svc,
            reqId(),
            () => fn(reqId()),
            failOnAllSkipped ? { failOnAllSkipped } : undefined,
          );
        return M.act(M.strArg(a.action) || 'overview', {
          overview: async () => {
            const ov = await svc.overview();
            const errorLinks = ov.links
              .filter((l) => Boolean(l.runtime.lastError))
              .map((l) => ({
                id: l.id,
                title: l.title,
                kind: l.kind,
                lastError: l.runtime.lastError,
              }));
            const recentErrors = ov.logs.filter((l) => l.level === 'error').slice(0, 10);
            return {
              ...ov,
              linksCount: ov.links.length,
              errorLinksCount: errorLinks.length,
              ...(errorLinks.length > 0 && { errorLinks }),
              recentErrorsCount: recentErrors.length,
              ...(recentErrors.length > 0 && { recentErrors }),
            };
          },
          read_grid: async () => {
            const g = await svc.readGrid(reqId());
            return {
              ...M.pick(g, 'linkId sheetName headers totalRows'),
              previewCount: Math.min(50, g.rows.length),
              truncated: g.rows.length > 50,
              rowsPreview: g.rows.slice(0, 50),
            };
          },
          stop: async () => {
            await (linkId ? svc.stopLinkWork(linkId) : svc.stopAll());
            return { stopped: true, scope: linkId ? 'link' : 'all', ...(linkId && { linkId }) };
          },
          import_library: linkAct(
            (id) =>
              svc.importLibraryFromSheet(id, a.mode === 'overwrite' ? 'overwrite' : 'incremental'),
            true,
          ),
          sync_library: linkAct((id) => svc.syncLibraryToSheet(id)),
          poll_schedule: linkAct((id) => svc.triggerSchedulePoll(id)),
          poll_records: linkAct((id) => svc.triggerRecordsPoll(id)),
          refresh_metrics: linkAct((id) => svc.refreshRecordMetrics(id)),
          reset_stuck: linkAct((id) => svc.resetStuckRows(id)),
        });
      },
      { req: 'action', errCode: 'GOOGLE_SHEETS_ERROR' },
    ),
  ];
}
