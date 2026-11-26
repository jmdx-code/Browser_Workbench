import { open as openFile } from 'node:fs/promises';
import { devDiag, type DevDiagLevel } from '../../shared/dev-diagnostics.js';
import * as M from './mcp-context.js';

const MODULES =
  'active-accounts group-poster group-bumper page-bumper group-inviter bluestacks-bumper bluestacks-page-bumper auto-scheduler google-sheets';
const MOD_MAP: Record<string, string> = {
  tasks: 'active-accounts',
  poster: 'group-poster',
  bumper: 'group-bumper',
  inviter: 'group-inviter',
  bluestacks: 'bluestacks-bumper',
  'bluestacks-group-bumper': 'bluestacks-bumper',
  scheduler: 'auto-scheduler',
  sheets: 'google-sheets',
};
const DONE_PLAN = new Set(['STOPPED', 'COMPLETED', 'FAILED']);
const DONE_POST = new Set(['completed', 'partial', 'failed', 'cancelled']);

async function readTailJsonlLines(filePath: string, maxBytes = 262_144) {
  const h = await openFile(filePath, 'r').catch(() => null);
  if (!h) return [];
  try {
    const size = (await h.stat()).size;
    const len = Math.min(size, maxBytes);
    if (len <= 0) return [];
    const off = Math.max(0, size - len);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await h.read(buf, 0, len, off);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    const out: Array<Record<string, unknown>> = [];
    for (const raw of off > 0 ? lines.slice(1) : lines) {
      if (!raw.trim()) continue;
      try {
        const o = JSON.parse(raw.trim()) as unknown;
        if (typeof o === 'object' && o !== null && !Array.isArray(o))
          out.push(o as Record<string, unknown>);
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    await h.close().catch(() => {});
  }
}

async function readSimpleStatus(
  deps: M.WorkbenchMcpDependencies,
  mod: string,
  since: (ms: number) => boolean,
): Promise<{ running: boolean; payload: object }> {
  if (mod === 'auto-scheduler') {
    const svc = deps.getAutoSchedulerService?.();
    M.req(svc, 'AUTO_SCHEDULER_UNAVAILABLE', '定时排班服务尚未初始化', 503);
    const st = await svc.state();
    return {
      running: st.running,
      payload: {
        running: st.running,
        activeRuns: st.activeRuns,
        recentRuns: st.recentRuns.slice(0, 5),
      },
    };
  }
  if (mod === 'google-sheets') {
    const svc = deps.getGoogleSheetsService?.();
    M.req(svc, 'GOOGLE_SHEETS_UNAVAILABLE', 'Google 云表协同服务尚未初始化', 503);
    const ov = await svc.overview();
    return {
      running: svc.hasActiveExecution(),
      payload: {
        ...M.pick(ov, 'runningScheduleCount runningRecordsCount'),
        recentLogs: ov.logs.slice(0, 15),
      },
    };
  }
  if (mod === 'group-inviter') {
    const [st, logs] = await Promise.all([
      deps.groupInviterService.state(),
      deps.groupInviterService.logs('', undefined, 80),
    ]);
    const entries = logs.filter((l) => since(l.invitedAt));
    return {
      running: st.running,
      payload: {
        ...M.pick(st, 'running statusText profileCounts runId?'),
        newVerifiedInvitesCount: entries.length,
        newVerifiedInvites: entries,
      },
    };
  }
  const isPage = mod === 'bluestacks-page-bumper';
  const bumper = deps.getGroupBumperService();
  const [st, logs] = await Promise.all([
    deps.bluestacksService.state(false),
    bumper
      ? bumper.logs('', undefined, undefined, 80, isPage ? 'page' : 'group')
      : Promise.resolve([]),
  ]);
  const instIds = new Set(st.instances.map((i) => i.id));
  const entries = logs.filter((l) => instIds.has(l.profileId) && since(l.bumpedAt));
  const scope = M.pickBumperScope(st, isPage);
  return {
    running: scope.running,
    payload: {
      ...M.pick(scope, 'running statusText profileCounts'),
      newVerifiedBumpsCount: entries.length,
      newVerifiedBumps: entries,
    },
  };
}

async function handleWaitForTask(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const rawMod = M.strArg(args.module) || 'group-poster';
  const mod = MOD_MAP[rawMod] ?? (MODULES.split(' ').includes(rawMod) ? rawMod : '');
  M.req(mod, 'INVALID_MODULE', `不支持的监控模块 "${rawMod}"`);
  const waitMs = Math.max(1, Math.min(90, Number(args.waitSeconds ?? 25))) * 1000;
  const wakeOnAnomaly = args.wakeOnAnomaly !== false;
  const taskIds = M.collectRawIds(args, 'taskIds', 'taskId');
  const startedAt = Date.now();
  const baseSeq = devDiag.recent(1)[0]?.seq ?? 0;
  const deadline = startedAt + waitMs;
  const since = (ms: number) => ms >= startedAt - 2000;
  const isFut = (ms: number | null) =>
    ms !== null && ms > Date.now() + Math.max(2000, deadline - Date.now());
  const pollWake = async (fn: (done: (w: string) => true) => Promise<boolean>) => {
    let wake = 'timeout_still_running';
    await M.pollUntil(deadline, 1000, () => fn((w) => ((wake = w), true)));
    return wake;
  };
  const finish = (wakeReason: string, settled: boolean, extra: object) => {
    const diag = M.recentDiagSlice(200, 25, { minSeq: baseSeq, levels: ['WARN', 'ERROR', 'WAIT'] });
    return {
      module: mod,
      settled,
      wakeReason,
      elapsedMs: Date.now() - startedAt,
      ...extra,
      newDiagnostics: diag.map((e) =>
        M.pick(e, 'seq localTime level category event profileId? profileName? reason? data?'),
      ),
    };
  };
  const checkBatch = (
    hasIds: boolean,
    empty: boolean,
    doneAll: boolean,
    futAll: boolean,
    run: boolean,
  ) => {
    if (!hasIds) return !run ? 'completed' : null;
    if (empty) return 'task_not_found';
    return doneAll ? 'completed' : futAll ? 'scheduled_in_future' : null;
  };
  const pendIds = (st?: { pendingReviewOperations?: Array<{ id: string }> }) =>
    new Set((st?.pendingReviewOperations ?? []).map((o) => o.id));
  const hasNewPend = (st: { pendingReviewOperations?: Array<{ id: string }> }, seen: Set<string>) =>
    wakeOnAnomaly && (st.pendingReviewOperations ?? []).some((o) => !seen.has(o.id));

  if (mod === 'active-accounts') {
    const svc = deps.taskService;
    M.req(svc, 'TASKS_UNAVAILABLE', '活跃账号任务执行服务未启用', 503);
    const pids = await M.optPids(deps, args);
    const [fPids, fPlans] = [
      pids ? new Set(pids) : null,
      taskIds.length > 0 ? new Set(taskIds) : null,
    ];
    const matchP = (p: { id: string; profileId: string }) =>
      (!fPlans || fPlans.has(p.id)) && (!fPids || fPids.has(p.profileId));
    const initFail = new Set(
      (await svc.overview()).plans.filter((p) => p.state === 'FAILED').map((p) => p.id),
    );
    const wake = await pollWake(async (done) => {
      const ov = await svc.overview();
      const tracked = ov.plans.filter(
        (p) => matchP(p) && (fPlans || fPids || !DONE_PLAN.has(p.state)),
      );
      if (tracked.every((p) => DONE_PLAN.has(p.state))) return done('completed');
      if (
        tracked.every(
          (p) => p.state === 'QUEUED' && p.timing?.mode === 'at' && isFut(p.timing.startAt),
        )
      )
        return done('scheduled_in_future');
      return wakeOnAnomaly && ov.plans.some((p) => p.state === 'FAILED' && !initFail.has(p.id))
        ? done('failure_detected')
        : false;
    });
    const ov = await svc.overview();
    const matched = ov.plans.filter(matchP).slice(0, 30);
    const running = matched.some((p) => ['QUEUED', 'RUNNING'].includes(p.state));
    return finish(wake, !running, {
      running,
      monitoredPlansCount: matched.length,
      monitoredPlans: matched.map((p) => M.mapActivePlan(p)),
      failedPlans: ov.plans
        .filter((p) => p.state === 'FAILED')
        .map((p) => M.mapActivePlan(p, 'id profileId reason')),
    });
  }

  if (mod === 'group-poster') {
    const initSt = await deps.groupPosterService.state();
    const initRestr = new Set(
      Object.entries(initSt.profileCounts)
        .filter(([, s]) => s.restricted)
        .map(([k]) => k),
    );
    const initPend = pendIds(initSt);
    const wake = await pollWake(async (done) => {
      const st = await deps.groupPosterService.state();
      const all = st.tasks ?? [];
      const tracked = all.filter((t) =>
        taskIds.length > 0
          ? taskIds.includes(t.id)
          : t.status === 'running' || t.status === 'scheduled',
      );
      const w = checkBatch(
        taskIds.length > 0,
        tracked.length === 0,
        tracked.every((t) => DONE_POST.has(t.status)),
        tracked.every((t) => t.status === 'scheduled' && isFut(t.scheduledAt)),
        st.running,
      );
      if (w) return done(w);
      if (
        wakeOnAnomaly &&
        Object.entries(st.profileCounts).some(([k, s]) => s.restricted && !initRestr.has(k))
      )
        return done('account_restricted_detected');
      return hasNewPend(st, initPend) ? done('pending_review_detected') : false;
    });
    const [finalSt, logs] = await Promise.all([
      deps.groupPosterService.state(),
      deps.groupPosterService.logs('', undefined, undefined, undefined),
    ]);
    const allT = finalSt.tasks ?? [];
    const tracked =
      taskIds.length > 0 ? allT.filter((t) => taskIds.includes(t.id)) : allT.slice(0, 10);
    const newPosts = M.mapAt(logs.filter((l) => since(l.postedAt)).slice(0, 50), 'postedAt');
    const settled =
      taskIds.length > 0
        ? tracked.length > 0 && tracked.every((t) => DONE_POST.has(t.status))
        : !finalSt.running;
    return finish(wake, settled, {
      ...M.pick(
        finalSt,
        'running statusText profileCounts activeGroupsByMaterial pendingReviewOperations#',
      ),
      monitoredTasks: tracked.map((t) => ({
        ...t,
        ...M.pick(t, 'scheduledAt@ startedAt@ finishedAt@'),
        msUntilScheduled:
          t.status === 'scheduled' && t.scheduledAt !== null
            ? Math.max(0, t.scheduledAt - Date.now())
            : null,
      })),
      newVerifiedPostsCount: newPosts.length,
      newVerifiedPosts: newPosts,
    });
  }

  if (mod === 'group-bumper' || mod === 'page-bumper') {
    const bumper = deps.getGroupBumperService();
    M.req(bumper, 'BUMPER_UNAVAILABLE', '顶贴服务未加载', 503);
    const isPage = mod === 'page-bumper';
    const initPend = pendIds(await bumper.state());
    const wake = await pollWake(async (done) => {
      const st = await bumper.state();
      const ss = taskIds.length > 0 ? await deps.getAutoSchedulerService?.()?.state() : null;
      const tracked = ss ? ss.schedules.filter((s) => taskIds.includes(s.id)) : [];
      const activeRun = Boolean(ss?.activeRuns.some((r) => taskIds.includes(r.scheduleId)));
      const finishedRun = Boolean(ss?.recentRuns.some((r) => taskIds.includes(r.scheduleId)));
      const fut =
        !activeRun &&
        tracked.every((s) => s.enabled && s.trigger.mode === 'once' && isFut(s.trigger.onceAt));
      const w = checkBatch(
        Boolean(ss),
        tracked.length === 0 && !activeRun && !finishedRun,
        !activeRun && finishedRun,
        fut,
        M.pickBumperScope(st, isPage).running,
      );
      return w ? done(w) : hasNewPend(st, initPend) ? done('pending_review_detected') : false;
    });
    const [finalSt, logs] = await Promise.all([
      bumper.state(),
      bumper.logs('', undefined, undefined, 50, isPage ? 'page' : 'group'),
    ]);
    const newBumps = logs.filter((l) => since(l.bumpedAt));
    const scope = M.pickBumperScope(finalSt, isPage);
    return finish(wake, !scope.running && wake === 'completed', {
      ...M.pick(scope, 'running statusText profileCounts'),
      monitoredTasks: [],
      newVerifiedBumpsCount: newBumps.length,
      newVerifiedBumps: newBumps,
      pendingReviewOperations: finalSt.pendingReviewOperations ?? [],
    });
  }

  const wake = await pollWake(async (done) =>
    !(await readSimpleStatus(deps, mod, since)).running ? done('completed') : false,
  );
  const fin = await readSimpleStatus(deps, mod, since);
  return finish(wake, !fin.running, fin.payload);
}

async function handleDiagnose(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const action = M.strArg(args.action) || 'inspect';
  if (action === 'reload_extensions') {
    M.req(deps.reloadExtensions, 'RELOAD_UNAVAILABLE', '当前环境不支持扩展热重载', 503);
    const rawIds = M.collectRawIds(args, 'profileIds', 'profileId');
    const reloadResult = await deps.reloadExtensions(
      rawIds.length > 0 ? await M.resolveProfileIds(deps, rawIds) : undefined,
    );
    await M.sleep(1500);
    return {
      reloadResult,
      onlineProfilesAfterReload: (await M.buildEnrichedProfiles(deps))
        .filter((p) => p.online)
        .map((p) =>
          M.pick(
            p,
            'id alias browserName displayName extensionVersion supportsAgentBrowser phase synced',
          ),
        ),
    };
  }
  if (action === 'export_package') {
    M.req(deps.captureDiagnostics, 'CAPTURE_UNAVAILABLE', '诊断包导出服务未加载', 503);
    const note = M.strArg(args.note) || 'AI Agent 自动采集诊断包';
    return {
      diagnosticPackage: await deps.captureDiagnostics({
        note,
        uiContext: 'mcp-wb_diagnose',
        reveal: false,
      }),
    };
  }
  const [rawFilter, q, limit] = [
    M.strArg(args.profileId),
    M.strArg(args.search).toLowerCase(),
    M.clampInt(args.limit, 60, 1, 200),
  ];
  const [dataDirectory, profiles] = [
    M.resolveDataDirIntegrity(deps.dataDir),
    await M.buildEnrichedProfiles(deps),
  ];
  const levels =
    Array.isArray(args.levels) && args.levels.length > 0
      ? (args.levels.map(String) as DevDiagLevel[])
      : undefined;
  let profileFilter = rawFilter;
  if (rawFilter)
    try {
      profileFilter = M.resolveProfileIdentifierFromList(profiles, rawFilter);
    } catch {}
  if (action === 'tail_log_file') {
    const lvl = levels ? new Set<string>(levels) : null;
    const entries = (await readTailJsonlLines(deps.devDiagFilePath)).filter(
      (e) =>
        (!profileFilter || String(e.profileId ?? '') === profileFilter) &&
        (!lvl || lvl.has(String(e.level ?? ''))) &&
        (!q || JSON.stringify(e).toLowerCase().includes(q)),
    );
    return {
      dataDirectory,
      logFilePath: deps.devDiagFilePath,
      matchedInTail: entries.length,
      entries: entries.slice(-limit),
    };
  }
  const [posterSt, bumperSt, bsSt, taskOv] = await Promise.all([
    deps.groupPosterService.state(),
    deps.getGroupBumperService()?.state(),
    deps.bluestacksService.state(false),
    deps.taskService ? deps.taskService.overview() : Promise.resolve(null),
  ]);
  const bridgeUnresolvedByProfile: Record<string, unknown[]> = {};
  const outdatedExtensions: Array<Record<string, unknown>> = [];
  const profilesWithIssues: M.EnrichedProfileSummary[] = [];
  for (const p of profiles) {
    if (p.unresolvedCount > 0) bridgeUnresolvedByProfile[p.id] = await deps.store.unresolved(p.id);
    if (!p.online) continue;
    if (p.extensionVersion !== deps.extensionVersion)
      outdatedExtensions.push({
        ...M.pick(p, 'id alias browserName displayName'),
        currentVersion: p.extensionVersion,
        bundledVersion: deps.extensionVersion,
      });
    if (
      !p.synced ||
      p.unresolvedCount > 0 ||
      ['restricted', 'verification', 'logged-out'].includes(p.account.state)
    )
      profilesWithIssues.push(p);
  }
  const recentDiagnostics = M.recentDiagSlice(400, limit, {
    levels,
    profileFilter: profileFilter || undefined,
    query: q || undefined,
  });
  return {
    softwareVersion: deps.softwareVersion,
    bundledExtensionVersion: deps.extensionVersion,
    dataDirectory,
    logFilePath: deps.devDiagFilePath,
    outdatedExtensions,
    bridgeUnresolvedByProfile,
    activeAccountsFailedPlans: (taskOv?.plans ?? [])
      .filter((p) => p.state === 'FAILED')
      .map((p) => M.mapActivePlan(p, 'id profileId reason updatedAt@')),
    posterPendingReview: posterSt.pendingReviewOperations ?? [],
    bumperPendingReview: bumperSt?.pendingReviewOperations ?? [],
    bluestacks: {
      adbReady: Boolean(bsSt.config?.adbReady),
      playerReady: Boolean(bsSt.config?.playerReady),
      ...M.pick(bsSt, 'running pageBumperRunning'),
      onlineInstances: bsSt.instances.filter((i) => i.online).length,
    },
    profilesWithIssues,
    recentDiagnosticsCount: recentDiagnostics.length,
    recentDiagnostics,
  };
}

export function createMonitorAndDiagnosticTools(
  deps: M.WorkbenchMcpDependencies,
): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_wait_for_task',
      '阻塞监控指定业务模块任务进展。',
      `@taskIds|@taskId|@profileIds|module:e(${MODULES}):业务模块|waitSeconds:n(1,90):最多等待秒数|wakeOnAnomaly:b:异常时提前唤醒`,
      (args) => handleWaitForTask(deps, args),
      { req: 'module', readOnly: true },
    ),
    M.reg(
      'wb_diagnose',
      '诊断日志、未决命令、扩展热重载与导出诊断包。',
      M.sp(
        '@profileId|@profileIds|@search|@limit|action:e(inspect tail_log_file reload_extensions export_package):诊断动作|note:s:诊断包备注',
        {
          levels: M.A(M.E('INFO WARN ERROR SLOW WAIT SNAPSHOT'), '日志级别过滤'),
        },
      ),
      (args) => handleDiagnose(deps, args),
    ),
  ];
}
