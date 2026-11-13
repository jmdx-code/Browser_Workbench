import { open as openFile } from 'node:fs/promises';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  buildEnrichedProfiles,
  errorResult,
  formatLocalDateTime,
  okResult,
  resolveDataDirIntegrity,
  resolveProfileIdentifierFromList,
  resolveProfileIds,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

async function readTailJsonlLines(
  filePath: string,
  maxBytes = 262_144,
): Promise<Array<Record<string, unknown>>> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(filePath, 'r');
    const st = await handle.stat();
    if (st.size <= 0) return [];
    const readLen = Math.min(st.size, maxBytes);
    const startOffset = Math.max(0, st.size - readLen);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buf, 0, readLen, startOffset);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const rawLines = text.split(/\r?\n/);
    // Drop potentially partial first line when reading from middle of file
    const completeLines = startOffset > 0 ? rawLines.slice(1) : rawLines;
    const parsed: Array<Record<string, unknown>> = [];
    for (const line of completeLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          parsed.push(obj as Record<string, unknown>);
        }
      } catch {}
    }
    return parsed;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createMonitorAndDiagnosticTools(
  deps: WorkbenchMcpDependencies,
): McpToolDefinition[] {
  const wbWaitForTask: McpToolDefinition = {
    name: 'wb_wait_for_task',
    description:
      '阻塞等待并持续监控指定业务模块的任务真实进展（最长单次等待 90 秒，无需高频空转轮询）。返回真实落盘回执（如发帖 postId / postUrl、顶贴记录、邀请记录）、每个浏览器的实时步骤状态、受限账号预警、待核对未决操作（PENDING_REVIEW）以及期间新增的诊断异常，遇到账号受限或待核对异常时可提前唤醒以便 Agent 立即处置。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          enum: [
            'active-accounts',
            'group-poster',
            'group-bumper',
            'page-bumper',
            'group-inviter',
            'bluestacks-bumper',
            'bluestacks-page-bumper',
          ],
          description: '要监控的业务模块',
        },
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选传入要精确跟踪的任务 ID 或计划 planId 数组',
        },
        taskId: {
          type: 'string',
          description: '可选传入单个要跟踪的任务 ID 或计划 planId（等价于 taskIds: [taskId]）',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'active-accounts 模块可选按指定浏览器标识列表过滤跟踪计划',
        },
        waitSeconds: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: '本次最多等待的秒数（默认 25 秒，最大 90 秒）',
        },
        wakeOnAnomaly: {
          type: 'boolean',
          description: '检测到新增账号受限或待核对未决操作时是否提前唤醒返回（默认 true）',
        },
      },
      required: ['module'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawModule = String(args.module ?? 'group-poster').trim();
      const moduleAliasMap: Record<string, string> = {
        tasks: 'active-accounts',
        'active-accounts': 'active-accounts',
        poster: 'group-poster',
        'group-poster': 'group-poster',
        bumper: 'group-bumper',
        'group-bumper': 'group-bumper',
        'page-bumper': 'page-bumper',
        inviter: 'group-inviter',
        'group-inviter': 'group-inviter',
        bluestacks: 'bluestacks-bumper',
        'bluestacks-bumper': 'bluestacks-bumper',
        'bluestacks-group-bumper': 'bluestacks-bumper',
        'bluestacks-page-bumper': 'bluestacks-page-bumper',
      };
      const moduleName = moduleAliasMap[rawModule];
      if (!moduleName) {
        return errorResult(
          'INVALID_MODULE',
          `不支持的监控模块 "${rawModule}"，可选值：active-accounts、group-poster、group-bumper、page-bumper、group-inviter、bluestacks-bumper、bluestacks-page-bumper`,
        );
      }
      const waitMs = Math.max(1, Math.min(90, Number(args.waitSeconds ?? 25))) * 1000;
      const wakeOnAnomaly = args.wakeOnAnomaly !== false;
      const singleTaskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      const taskIds = [
        ...(Array.isArray(args.taskIds)
          ? args.taskIds.map((x) => String(x).trim()).filter(Boolean)
          : []),
        ...(singleTaskId ? [singleTaskId] : []),
      ];
      const startedAt = Date.now();
      const deadline = startedAt + waitMs;
      const baselineDiagSeq = devDiag.recent(1)[0]?.seq ?? 0;

      const collectNewDiagnostics = () =>
        devDiag
          .recent(200)
          .filter(
            (e) =>
              e.seq > baselineDiagSeq &&
              (e.level === 'WARN' || e.level === 'ERROR' || e.level === 'WAIT'),
          )
          .slice(-25)
          .map((e) => ({
            seq: e.seq,
            localTime: e.localTime,
            level: e.level,
            category: e.category,
            event: e.event,
            profileId: e.profileId ?? null,
            profileName: e.profileName ?? null,
            reason: e.reason ?? null,
            data: e.data ?? null,
          }));

      if (moduleName === 'active-accounts') {
        const taskService = deps.taskService;
        if (!taskService) {
          return errorResult('TASKS_UNAVAILABLE', '活跃账号任务执行服务未启用');
        }
        const rawFilterPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const filterProfileSet =
          rawFilterPids.length > 0 ? new Set(await resolveProfileIds(deps, rawFilterPids)) : null;
        const filterPlanSet = taskIds.length > 0 ? new Set(taskIds) : null;

        const initOverview = await taskService.overview();
        const initialReviewIds = new Set(
          initOverview.plans.filter((p) => p.state === 'REVIEW').map((p) => p.id),
        );

        let aaWake:
          | 'completed'
          | 'paused'
          | 'scheduled_in_future'
          | 'pending_review_detected'
          | 'timeout_still_running' = 'timeout_still_running';

        while (true) {
          const ov = await taskService.overview();
          const tracked = ov.plans.filter((p) => {
            if (filterPlanSet && !filterPlanSet.has(p.id)) return false;
            if (filterProfileSet && !filterProfileSet.has(p.profileId)) return false;
            if (!filterPlanSet && !filterProfileSet) {
              return !['STOPPED', 'COMPLETED', 'FAILED'].includes(p.state);
            }
            return true;
          });

          if (tracked.length === 0) {
            aaWake = 'completed';
            break;
          }
          if (tracked.every((p) => ['STOPPED', 'COMPLETED', 'FAILED'].includes(p.state))) {
            aaWake = 'completed';
            break;
          }
          if (
            tracked.every((p) => ['PAUSED', 'STOPPED', 'COMPLETED', 'FAILED'].includes(p.state))
          ) {
            aaWake = 'paused';
            break;
          }
          if (
            tracked.every(
              (p) =>
                p.state === 'QUEUED' &&
                p.timing?.mode === 'at' &&
                p.timing.startAt > Date.now() + Math.max(2000, deadline - Date.now()),
            )
          ) {
            aaWake = 'scheduled_in_future';
            break;
          }
          if (
            wakeOnAnomaly &&
            ov.plans.some((p) => p.state === 'REVIEW' && !initialReviewIds.has(p.id))
          ) {
            aaWake = 'pending_review_detected';
            break;
          }
          if (Date.now() >= deadline) break;
          await new Promise<void>((r) => setTimeout(r, 1000));
        }

        const finalOv = await taskService.overview();
        const monitoredPlans = finalOv.plans
          .filter((p) => {
            if (filterPlanSet && !filterPlanSet.has(p.id)) return false;
            if (filterProfileSet && !filterProfileSet.has(p.profileId)) return false;
            return true;
          })
          .slice(0, 30)
          .map((p) => ({
            id: p.id,
            profileId: p.profileId,
            combinationId: p.combinationId,
            combinationName: p.snapshot.name,
            state: p.state,
            reason: p.reason,
            round: p.round,
            position: p.position,
            updatedAtLocal: formatLocalDateTime(p.updatedAt),
          }));
        const stillRunning = monitoredPlans.some((p) =>
          ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(p.state),
        );

        return okResult({
          ok: true,
          module: moduleName,
          settled: !stillRunning,
          wakeReason: aaWake,
          elapsedMs: Date.now() - startedAt,
          running: stillRunning,
          monitoredPlansCount: monitoredPlans.length,
          monitoredPlans,
          reviewPlans: finalOv.plans
            .filter((p) => p.state === 'REVIEW')
            .map((p) => ({
              id: p.id,
              profileId: p.profileId,
              combinationName: p.snapshot.name,
              reason: p.reason,
            })),
          newDiagnostics: collectNewDiagnostics(),
        });
      }

      if (moduleName === 'group-poster') {
        const initialState = await deps.groupPosterService.state();
        const initialRestricted = new Set(
          Object.entries(initialState.profileCounts)
            .filter(([, stat]) => stat.restricted === true)
            .map(([pid]) => pid),
        );
        const initialPendingIds = new Set(
          (initialState.pendingReviewOperations ?? []).map((op) => op.id),
        );

        let wakeReason:
          | 'completed'
          | 'scheduled_in_future'
          | 'account_restricted_detected'
          | 'pending_review_detected'
          | 'timeout_still_running' = 'timeout_still_running';

        while (true) {
          const st = await deps.groupPosterService.state();
          const allTasks = st.tasks ?? [];
          const tracked =
            taskIds.length > 0
              ? allTasks.filter((t) => taskIds.includes(t.id))
              : allTasks.filter((t) => t.status === 'running' || t.status === 'scheduled');

          if (taskIds.length > 0 && tracked.length > 0) {
            const terminal = tracked.every((t) =>
              ['completed', 'partial', 'failed', 'cancelled'].includes(t.status),
            );
            if (terminal) {
              wakeReason = 'completed';
              break;
            }
            const allScheduledFuture = tracked.every(
              (t) =>
                t.status === 'scheduled' &&
                t.scheduledAt !== null &&
                t.scheduledAt > Date.now() + Math.max(2000, deadline - Date.now()),
            );
            if (allScheduledFuture) {
              wakeReason = 'scheduled_in_future';
              break;
            }
          } else if (taskIds.length === 0 && !st.running) {
            wakeReason = 'completed';
            break;
          }

          if (wakeOnAnomaly) {
            const newlyRestricted = Object.entries(st.profileCounts).some(
              ([pid, stat]) => stat.restricted === true && !initialRestricted.has(pid),
            );
            if (newlyRestricted) {
              wakeReason = 'account_restricted_detected';
              break;
            }
            const newlyPending = (st.pendingReviewOperations ?? []).some(
              (op) => !initialPendingIds.has(op.id),
            );
            if (newlyPending) {
              wakeReason = 'pending_review_detected';
              break;
            }
          }

          if (Date.now() >= deadline) {
            wakeReason = 'timeout_still_running';
            break;
          }
          await new Promise<void>((r) => setTimeout(r, 1000));
        }

        const [finalState, recentLogs] = await Promise.all([
          deps.groupPosterService.state(),
          deps.groupPosterService.logs('', undefined, undefined, undefined),
        ]);
        const trackedTasks =
          taskIds.length > 0
            ? (finalState.tasks ?? []).filter((t) => taskIds.includes(t.id))
            : (finalState.tasks ?? []).slice(0, 10);
        const newVerifiedPosts = recentLogs
          .filter((l) => l.postedAt >= startedAt - 2000)
          .slice(0, 50)
          .map((l) => ({
            ...l,
            postedAtLocal: formatLocalDateTime(l.postedAt),
          }));

        const settled =
          taskIds.length > 0
            ? trackedTasks.every((t) =>
                ['completed', 'partial', 'failed', 'cancelled'].includes(t.status),
              )
            : !finalState.running;

        return okResult({
          ok: true,
          module: moduleName,
          settled,
          wakeReason,
          elapsedMs: Date.now() - startedAt,
          running: finalState.running,
          statusText: finalState.statusText,
          monitoredTasks: trackedTasks.map((t) => ({
            ...t,
            scheduledAtLocal: formatLocalDateTime(t.scheduledAt),
            startedAtLocal: formatLocalDateTime(t.startedAt),
            finishedAtLocal: formatLocalDateTime(t.finishedAt),
            msUntilScheduled:
              t.status === 'scheduled' && t.scheduledAt !== null
                ? Math.max(0, t.scheduledAt - Date.now())
                : null,
          })),
          newVerifiedPostsCount: newVerifiedPosts.length,
          newVerifiedPosts,
          activeGroupsByMaterial: finalState.activeGroupsByMaterial ?? {},
          profileCounts: finalState.profileCounts,
          pendingReviewOperations: finalState.pendingReviewOperations ?? [],
          newDiagnostics: collectNewDiagnostics(),
        });
      }

      if (moduleName === 'group-bumper' || moduleName === 'page-bumper') {
        const bumper = deps.getGroupBumperService();
        if (!bumper) return errorResult('BUMPER_UNAVAILABLE', '顶贴服务未加载');
        const isPage = moduleName === 'page-bumper';
        const initial = await bumper.state();
        const initialPending = new Set((initial.pendingReviewOperations ?? []).map((op) => op.id));
        let wakeReason:
          | 'completed'
          | 'scheduled_in_future'
          | 'pending_review_detected'
          | 'timeout_still_running' = 'timeout_still_running';

        while (true) {
          const st = await bumper.state();
          const running = isPage ? st.pageBumperRunning : st.running;
          const allScheduled = (st.scheduledTasks ?? []).filter((t) => t.mode === moduleName);
          const tracked =
            taskIds.length > 0 ? allScheduled.filter((t) => taskIds.includes(t.id)) : [];

          if (taskIds.length > 0 && tracked.length > 0) {
            const terminal = tracked.every((t) =>
              ['completed', 'failed', 'cancelled'].includes(t.status),
            );
            if (terminal) {
              wakeReason = 'completed';
              break;
            }
            const allFuture = tracked.every(
              (t) =>
                t.status === 'scheduled' &&
                t.scheduledAt > Date.now() + Math.max(2000, deadline - Date.now()),
            );
            if (allFuture) {
              wakeReason = 'scheduled_in_future';
              break;
            }
          } else if (taskIds.length === 0 && !running) {
            wakeReason = 'completed';
            break;
          }

          if (
            wakeOnAnomaly &&
            (st.pendingReviewOperations ?? []).some((op) => !initialPending.has(op.id))
          ) {
            wakeReason = 'pending_review_detected';
            break;
          }
          if (Date.now() >= deadline) break;
          await new Promise<void>((r) => setTimeout(r, 1000));
        }

        const [finalSt, logs] = await Promise.all([
          bumper.state(),
          bumper.logs('', undefined, undefined, 50, isPage ? 'page' : 'group'),
        ]);
        const newBumps = logs.filter((l) => l.bumpedAt >= startedAt - 2000);
        const running = isPage ? finalSt.pageBumperRunning : finalSt.running;
        const modeTasks = (finalSt.scheduledTasks ?? []).filter((t) => t.mode === moduleName);
        const monitoredTasks = (
          taskIds.length > 0
            ? modeTasks.filter((t) => taskIds.includes(t.id))
            : modeTasks.slice(0, 10)
        ).map((t) => ({
          ...t,
          scheduledAtLocal: formatLocalDateTime(t.scheduledAt),
          startedAtLocal: formatLocalDateTime(t.startedAt),
          finishedAtLocal: formatLocalDateTime(t.finishedAt),
        }));
        const settled =
          taskIds.length > 0
            ? monitoredTasks.every((t) => ['completed', 'failed', 'cancelled'].includes(t.status))
            : !running;

        return okResult({
          ok: true,
          module: moduleName,
          settled,
          wakeReason,
          elapsedMs: Date.now() - startedAt,
          running,
          statusText: isPage ? finalSt.pageBumperStatusText : finalSt.statusText,
          profileCounts: isPage ? finalSt.pageBumperProfileCounts : finalSt.profileCounts,
          monitoredTasks,
          newVerifiedBumpsCount: newBumps.length,
          newVerifiedBumps: newBumps,
          pendingReviewOperations: finalSt.pendingReviewOperations ?? [],
          newDiagnostics: collectNewDiagnostics(),
        });
      }

      if (moduleName === 'group-inviter') {
        let wakeReason: 'completed' | 'timeout_still_running' = 'timeout_still_running';
        while (true) {
          const st = await deps.groupInviterService.state();
          if (!st.running) {
            wakeReason = 'completed';
            break;
          }
          if (Date.now() >= deadline) break;
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
        const [finalSt, logs] = await Promise.all([
          deps.groupInviterService.state(),
          deps.groupInviterService.logs('', undefined, 80),
        ]);
        const newInvites = logs.filter((l) => l.invitedAt >= startedAt - 2000);
        return okResult({
          ok: true,
          module: moduleName,
          settled: !finalSt.running,
          wakeReason,
          elapsedMs: Date.now() - startedAt,
          running: finalSt.running,
          runId: finalSt.runId ?? null,
          statusText: finalSt.statusText,
          profileCounts: finalSt.profileCounts,
          newVerifiedInvitesCount: newInvites.length,
          newVerifiedInvites: newInvites,
          newDiagnostics: collectNewDiagnostics(),
        });
      }

      // bluestacks-bumper | bluestacks-page-bumper
      const isBsPage = moduleName === 'bluestacks-page-bumper';
      let bsWake: 'completed' | 'timeout_still_running' = 'timeout_still_running';
      while (true) {
        const st = await deps.bluestacksService.state(false);
        const running = isBsPage ? st.pageBumperRunning : st.running;
        if (!running) {
          bsWake = 'completed';
          break;
        }
        if (Date.now() >= deadline) break;
        await new Promise<void>((r) => setTimeout(r, 1000));
      }
      const bumperSvc = deps.getGroupBumperService();
      const [finalBs, bsLogs] = await Promise.all([
        deps.bluestacksService.state(false),
        bumperSvc
          ? bumperSvc.logs('', undefined, undefined, 80, isBsPage ? 'page' : 'group')
          : Promise.resolve([]),
      ]);
      const bsInstIds = new Set(finalBs.instances.map((i) => i.id));
      const newBsBumps = bsLogs.filter(
        (l) => bsInstIds.has(l.profileId) && l.bumpedAt >= startedAt - 2000,
      );
      const finalRunning = isBsPage ? finalBs.pageBumperRunning : finalBs.running;
      return okResult({
        ok: true,
        module: moduleName,
        settled: !finalRunning,
        wakeReason: bsWake,
        elapsedMs: Date.now() - startedAt,
        running: finalRunning,
        statusText: isBsPage ? finalBs.pageBumperStatusText : finalBs.statusText,
        profileCounts: isBsPage ? finalBs.pageBumperProfileCounts : finalBs.profileCounts,
        newVerifiedBumpsCount: newBsBumps.length,
        newVerifiedBumps: newBsBumps,
        newDiagnostics: collectNewDiagnostics(),
      });
    },
  };

  const wbDiagnose: McpToolDefinition = {
    name: 'wb_diagnose',
    description:
      '深度故障排查与插件热重载工具：读取内存与磁盘 dev-diagnostics.jsonl 实时运行日志、核查桥接层未决命令（store.unresolved）与各模块待核对账本（PENDING_REVIEW）、一键热重载全部闲置 Chrome 扩展到最新版本（reload_extensions），或导出完整诊断快照压缩包（export_package）。当任何任务卡住、按钮未识别或插件版本落后时第一时间调用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inspect', 'tail_log_file', 'reload_extensions', 'export_package'],
          description: '诊断动作（默认 inspect）',
        },
        profileId: {
          type: 'string',
          description: '按指定浏览器 profileId 过滤日志或热重载指定浏览器扩展',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'reload_extensions 时可选指定多个 profileId（省略则热重载全部在线闲置浏览器）',
        },
        levels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['INFO', 'WARN', 'ERROR', 'SLOW', 'WAIT', 'SNAPSHOT'],
          },
          description: '按日志级别过滤（例如 ["WARN", "ERROR", "WAIT"]）',
        },
        search: {
          type: 'string',
          description: '按事件名、错误原因或 URL 关键词过滤诊断日志',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: '返回诊断日志条数上限（默认 60）',
        },
        note: {
          type: 'string',
          description: 'export_package 时写入诊断包的备注说明',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const action = typeof args.action === 'string' ? args.action : 'inspect';

      if (action === 'reload_extensions') {
        if (!deps.reloadExtensions) {
          return errorResult('RELOAD_UNAVAILABLE', '当前环境不支持扩展热重载');
        }
        const rawIds = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : typeof args.profileId === 'string' && args.profileId.trim()
            ? [args.profileId.trim()]
            : [];
        const ids = rawIds.length > 0 ? await resolveProfileIds(deps, rawIds) : undefined;
        const result = await deps.reloadExtensions(ids && ids.length > 0 ? ids : undefined);
        // Wait briefly so Chrome reconnects with the newly loaded manifest capabilities
        await new Promise<void>((r) => setTimeout(r, 1500));
        const profiles = await buildEnrichedProfiles(deps);
        return okResult({
          ok: true,
          reloadResult: result,
          onlineProfilesAfterReload: profiles
            .filter((p) => p.online)
            .map((p) => ({
              id: p.id,
              alias: p.alias,
              browserName: p.browserName,
              displayName: p.displayName,
              extensionVersion: p.extensionVersion,
              supportsAgentBrowser: p.supportsAgentBrowser,
              phase: p.phase,
              synced: p.synced,
            })),
        });
      }

      if (action === 'export_package') {
        if (!deps.captureDiagnostics) {
          return errorResult('CAPTURE_UNAVAILABLE', '诊断包导出服务未加载');
        }
        const note =
          typeof args.note === 'string' && args.note.trim()
            ? args.note.trim()
            : 'AI Agent 自动采集诊断包';
        const output = await deps.captureDiagnostics({
          note,
          uiContext: 'mcp-wb_diagnose',
          reveal: false,
        });
        return okResult({
          ok: true,
          diagnosticPackage: output,
        });
      }

      const rawProfileFilter = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      const levelSet =
        Array.isArray(args.levels) && args.levels.length > 0
          ? new Set(args.levels.map((x) => String(x)))
          : null;
      const q = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
      const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 60))));
      const dataDirectory = resolveDataDirIntegrity(deps.dataDir);
      const allKnownProfiles = await buildEnrichedProfiles(deps);
      const profileFilter = (() => {
        if (!rawProfileFilter) return '';
        try {
          return resolveProfileIdentifierFromList(allKnownProfiles, rawProfileFilter);
        } catch {
          return rawProfileFilter;
        }
      })();

      if (action === 'tail_log_file') {
        const diskEntries = await readTailJsonlLines(deps.devDiagFilePath);
        const filtered = diskEntries.filter((e) => {
          if (profileFilter && String(e.profileId ?? '') !== profileFilter) return false;
          if (levelSet && !levelSet.has(String(e.level ?? ''))) return false;
          if (q) {
            const hay = JSON.stringify(e).toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        return okResult({
          ok: true,
          dataDirectory,
          logFilePath: deps.devDiagFilePath,
          matchedInTail: filtered.length,
          entries: filtered.slice(-limit),
        });
      }

      // action === 'inspect'
      const [posterState, bumperState, bluestacksState, taskOverview] = await Promise.all([
        deps.groupPosterService.state(),
        deps.getGroupBumperService()?.state(),
        deps.bluestacksService.state(false),
        deps.taskService ? deps.taskService.overview() : Promise.resolve(null),
      ]);
      const profiles = allKnownProfiles;

      const bridgeUnresolvedByProfile: Record<string, unknown[]> = {};
      for (const p of profiles) {
        if (p.unresolvedCount > 0) {
          bridgeUnresolvedByProfile[p.id] = await deps.store.unresolved(p.id);
        }
      }

      const ringFiltered = devDiag
        .recent(400)
        .filter((e) => {
          if (profileFilter && (e.profileId ?? '') !== profileFilter) return false;
          if (levelSet && !levelSet.has(e.level)) return false;
          if (q) {
            const hay = [
              e.event,
              e.reason ?? '',
              e.url ?? '',
              e.profileName ?? '',
              e.data ? JSON.stringify(e.data) : '',
            ]
              .join(' ')
              .toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        })
        .slice(-limit);

      const outdatedExtensions = profiles
        .filter((p) => p.online && p.extensionVersion !== deps.extensionVersion)
        .map((p) => ({
          id: p.id,
          alias: p.alias,
          browserName: p.browserName,
          displayName: p.displayName,
          currentVersion: p.extensionVersion,
          bundledVersion: deps.extensionVersion,
        }));

      return okResult({
        ok: true,
        softwareVersion: deps.softwareVersion,
        bundledExtensionVersion: deps.extensionVersion,
        dataDirectory,
        logFilePath: deps.devDiagFilePath,
        outdatedExtensions,
        bridgeUnresolvedByProfile,
        activeAccountsReviewPlans: taskOverview
          ? taskOverview.plans
              .filter((p) => p.state === 'REVIEW')
              .map((p) => ({
                id: p.id,
                profileId: p.profileId,
                combinationName: p.snapshot.name,
                reason: p.reason,
                updatedAtLocal: formatLocalDateTime(p.updatedAt),
              }))
          : [],
        posterPendingReview: posterState.pendingReviewOperations ?? [],
        bumperPendingReview: bumperState?.pendingReviewOperations ?? [],
        bluestacks: {
          adbReady: Boolean(bluestacksState.config?.adbReady),
          playerReady: Boolean(bluestacksState.config?.playerReady),
          running: bluestacksState.running,
          pageBumperRunning: bluestacksState.pageBumperRunning,
          onlineInstances: bluestacksState.instances.filter((i) => i.online).length,
        },
        profilesWithIssues: profiles.filter(
          (p) =>
            p.online &&
            (!p.synced ||
              p.unresolvedCount > 0 ||
              ['restricted', 'verification', 'logged-out'].includes(p.account.state)),
        ),
        recentDiagnosticsCount: ringFiltered.length,
        recentDiagnostics: ringFiltered,
      });
    },
  };

  return [wbWaitForTask, wbDiagnose];
}
