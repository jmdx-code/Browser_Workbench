import { randomUUID } from 'node:crypto';
import { admitProfilesForStart } from '../../application/profile-start-admission.js';
import { ProductError } from '../../domain/workspace.js';
import type { SavedCombination } from '../../shared/contracts.js';
import { MAX_CONCURRENT_PROFILES } from '../../shared/task-capacity.js';
import type { Plan } from '../../shared/task-contracts.js';
import { TaskTiming, taskTimingLabel, type Timing } from '../../shared/task-timing.js';
import {
  buildEnrichedProfiles,
  errorResult,
  formatLocalDateTime,
  okResult,
  parseFlexibleScheduleTime,
  resolveProfileId,
  resolveProfileIds,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

const ACTIVE_PLAN_STATES = [
  'QUEUED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'REVIEW',
] as const;

function resolveSavedCombination(
  combinations: readonly SavedCombination[],
  rawQuery: string,
): SavedCombination {
  const query = rawQuery.trim();
  if (!query) {
    throw new ProductError(
      'COMBINATION_ID_REQUIRED',
      '请提供 combinationId（UUID 或任务组合名称）',
      400,
    );
  }
  const lower = query.toLowerCase();

  const exactById = combinations.find((c) => c.id.toLowerCase() === lower);
  if (exactById) return exactById;

  const exactByName = combinations.filter((c) => {
    const savedName = c.saved?.name?.trim().toLowerCase() ?? '';
    const draftName = c.draft?.name?.trim().toLowerCase() ?? '';
    return (savedName && savedName === lower) || (draftName && draftName === lower);
  });
  if (exactByName.length === 1 && exactByName[0]) return exactByName[0];
  if (exactByName.length > 1) {
    const labels = exactByName
      .slice(0, 6)
      .map((c) => `${c.saved?.name ?? c.draft?.name ?? c.id} (id=${c.id})`)
      .join('；');
    throw new ProductError(
      'AMBIGUOUS_COMBINATION_IDENTIFIER',
      `名称 "${query}" 同时匹配多个任务组合，请改传明确的 combinationId UUID：${labels}`,
      409,
    );
  }

  if (lower.length >= 2) {
    const fuzzy = combinations.filter((c) => {
      const savedName = c.saved?.name?.trim().toLowerCase() ?? '';
      const draftName = c.draft?.name?.trim().toLowerCase() ?? '';
      return savedName.includes(lower) || draftName.includes(lower);
    });
    if (fuzzy.length === 1 && fuzzy[0]) return fuzzy[0];
    if (fuzzy.length > 1) {
      const labels = fuzzy
        .slice(0, 6)
        .map((c) => `${c.saved?.name ?? c.draft?.name ?? c.id} (id=${c.id})`)
        .join('；');
      throw new ProductError(
        'AMBIGUOUS_COMBINATION_IDENTIFIER',
        `关键词 "${query}" 同时匹配多个任务组合，请改传明确的 combinationId UUID：${labels}`,
        409,
      );
    }
  }

  const availableHints = combinations
    .filter((c) => c.saved !== null)
    .slice(0, 8)
    .map((c) => `${c.saved?.name ?? c.id} (id=${c.id})`)
    .join('；');
  throw new ProductError(
    'COMBINATION_NOT_FOUND',
    `未找到匹配 "${query}" 的任务组合。${availableHints ? `当前可用组合：${availableHints}` : '当前尚未创建已保存的任务组合'}`,
    404,
  );
}

function summarizePlan(plan: Plan, profileNameById: ReadonlyMap<string, string>) {
  return {
    id: plan.id,
    batchId: plan.batchId,
    profileId: plan.profileId,
    profileDisplayName: profileNameById.get(plan.profileId) ?? plan.profileId,
    combinationId: plan.combinationId,
    combinationName: plan.snapshot.name,
    version: plan.version,
    accountId: plan.accountId,
    state: plan.state,
    reason: plan.reason,
    controlConfirmed: plan.controlConfirmed,
    round: plan.round,
    position: plan.position,
    stepsCount: plan.snapshot.steps.length,
    timing: plan.timing ?? null,
    timingLabel: plan.timing ? taskTimingLabel(plan.timing) : null,
    timingReleased: plan.timingReleased ?? null,
    createdAt: plan.createdAt,
    createdAtLocal: formatLocalDateTime(plan.createdAt),
    updatedAt: plan.updatedAt,
    updatedAtLocal: formatLocalDateTime(plan.updatedAt),
  };
}

export function createActiveAccountsTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  const wbActiveAccountsControl: McpToolDefinition = {
    name: 'wb_active_accounts_control',
    description:
      '控制与监控「活跃账号（active-accounts）」任务组合与全局「执行记录」：查询已保存的任务组合（如浏览视频 Reels、浏览动态 Feed、浏览商城 Marketplace、通过好友申请、发布贴文/快拍）及当前运行/排队/定时计划（state）、对指定浏览器立即或定时/时间窗启动任务组合（start，支持离线浏览器自动启动）、暂停/继续/停止运行中计划（pause / resume / stop）、修改最大并发浏览器数（save_settings）、以及分页检索全局执行记录（records）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'start', 'pause', 'resume', 'stop', 'save_settings', 'records'],
          description: '操作类型',
        },
        combinationId: {
          type: 'string',
          description: 'start 时指定的任务组合 UUID 或任务组合名称（如 "浏览 Reels"）',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'start 或 pause/resume/stop 时指定的浏览器标识列表（UUID、浏览器名如 "用户8" 或专页名；pause/resume/stop 省略且未传 planIds 时作用于全部符合状态的计划）',
        },
        profileId: {
          type: 'string',
          description: '单个浏览器标识（records 过滤，或等价于 profileIds: [profileId]）',
        },
        planIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'pause / resume / stop 时可选精确指定计划 planId 列表',
        },
        scheduledAt: {
          type: ['string', 'number', 'null'],
          description:
            'start 时可选单次定时启动时间（支持 "20:30"、"明天 09:00"、"2026-11-14 20:30"、ISO 时间或毫秒时间戳；省略则立即启动）',
        },
        timeZone: {
          type: 'string',
          description: 'scheduledAt 定时使用的 IANA 时区（默认自动取本机时区，如 "Asia/Shanghai"）',
        },
        timing: {
          type: 'object',
          description:
            'start 时可选高级定时/时间窗配置：单次定时 { mode: "at", startAt, timeZone } 或每日/按周时间窗 { mode: "window", startTime: "09:00", endTime: "22:00", weekdays: [1,2,3,4,5,6,7], timeZone }',
          properties: {
            mode: { type: 'string', enum: ['at', 'window'] },
            startAt: { type: 'number' },
            startTime: { type: 'string' },
            endTime: { type: 'string' },
            timeZone: { type: 'string' },
            weekdays: { type: 'array', items: { type: 'number' } },
          },
          additionalProperties: false,
        },
        maxConcurrentProfiles: {
          type: 'number',
          minimum: 1,
          maximum: MAX_CONCURRENT_PROFILES,
          description: `save_settings 时设置活跃账号调度器最大并发浏览器数（1-${MAX_CONCURRENT_PROFILES}）`,
        },
        status: {
          type: 'string',
          enum: ['all', 'running', 'completed', 'failed', 'review'],
          description: 'records 查询时的状态过滤（默认 "all"）',
        },
        query: {
          type: 'string',
          description: 'records 查询时的搜索关键词（匹配组合名、浏览器名等）',
        },
        cursor: {
          type: 'string',
          description: 'records 分页游标',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: 'records 返回条数上限（默认 50，最大 200）',
        },
        includeTerminalPlans: {
          type: 'boolean',
          description:
            'state 查询时是否同时返回最近已结束的历史计划（默认 false 仅返回活跃/等待计划）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const taskService = deps.taskService;
      if (!taskService) {
        return errorResult('TASKS_UNAVAILABLE', '活跃账号任务执行服务未启用');
      }
      const action = String(args.action ?? 'state').trim();

      if (action === 'save_settings') {
        if (typeof args.maxConcurrentProfiles !== 'number') {
          return errorResult(
            'MAX_CONCURRENT_REQUIRED',
            'save_settings 需要提供 maxConcurrentProfiles 数字参数',
          );
        }
        const settings = await taskService.setSettings({
          maxConcurrentProfiles: Math.floor(args.maxConcurrentProfiles),
        });
        return okResult({
          ok: true,
          settings,
        });
      }

      if (action === 'records') {
        const rawProfileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
        const resolvedPid = rawProfileId ? await resolveProfileId(deps, rawProfileId) : undefined;
        const statusRaw = typeof args.status === 'string' ? args.status.trim() : 'all';
        const status = ['all', 'running', 'completed', 'failed', 'review'].includes(statusRaw)
          ? statusRaw
          : 'all';
        const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 50))));
        const snapshot = await deps.workspaceService.snapshot();
        const page = await taskService.records(
          {
            ...(resolvedPid ? { profileId: resolvedPid } : {}),
            status,
            ...(typeof args.query === 'string' && args.query.trim()
              ? { query: args.query.trim().slice(0, 100) }
              : {}),
            ...(typeof args.cursor === 'string' && args.cursor.trim()
              ? { cursor: args.cursor.trim() }
              : {}),
            limit,
          },
          snapshot.profiles,
        );
        return okResult({
          ok: true,
          total: page.total,
          counts: page.counts,
          nextCursor: page.nextCursor,
          recordsCount: page.records.length,
          records: page.records.map((r) => ({
            ...r,
            startedAtLocal: formatLocalDateTime(r.startedAt),
            finishedAtLocal: formatLocalDateTime(r.finishedAt),
            planUpdatedAtLocal: formatLocalDateTime(r.planUpdatedAt),
          })),
        });
      }

      const collectRawProfileIds = (): string[] => {
        const single = typeof args.profileId === 'string' ? args.profileId.trim() : '';
        return [
          ...(Array.isArray(args.profileIds)
            ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
            : []),
          ...(single ? [single] : []),
        ];
      };

      if (action === 'start') {
        const rawCombo = typeof args.combinationId === 'string' ? args.combinationId.trim() : '';
        if (!rawCombo) {
          return errorResult(
            'COMBINATION_ID_REQUIRED',
            'start 需要提供 combinationId（任务组合 UUID 或名称，可先通过 action="state" 查询）',
          );
        }
        const rawPids = collectRawProfileIds();
        if (rawPids.length === 0) {
          return errorResult('PROFILE_IDS_REQUIRED', 'start 需要提供至少 1 个 profileIds');
        }

        const [snapshot, profileIds] = await Promise.all([
          deps.workspaceService.snapshot(),
          resolveProfileIds(deps, rawPids),
        ]);
        const comboRow = resolveSavedCombination(snapshot.combinations, rawCombo);
        if (!comboRow.saved || comboRow.version < 1) {
          return errorResult(
            'COMBINATION_NOT_PUBLISHED',
            `任务组合 "${comboRow.draft?.name || comboRow.id}" 尚未保存发布（仍为草稿），请先在工作台界面保存该组合后再启动`,
          );
        }

        let timing: Timing | undefined;
        let rolledToNextDay = false;
        if (args.timing !== undefined && args.timing !== null) {
          timing = TaskTiming.parse(args.timing);
        } else if (args.scheduledAt !== undefined && args.scheduledAt !== null) {
          const parsed = parseFlexibleScheduleTime(args.scheduledAt);
          rolledToNextDay = parsed.rolledToNextDay;
          if (parsed.mode === 'scheduled' && parsed.scheduledAt) {
            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
            const tz =
              typeof args.timeZone === 'string' && args.timeZone.trim()
                ? args.timeZone.trim()
                : localTz;
            timing = TaskTiming.parse({
              mode: 'at',
              startAt: parsed.scheduledAt,
              timeZone: tz,
            });
          }
        }

        await deps.workspaceService.requireProfiles(profileIds);
        await taskService.releaseErroredPausedPlans(profileIds);

        const isOnline = (id: string) => Boolean(deps.core.peers.get(id)?.online);
        if (!timing && deps.profileLifecycle) {
          const offlineCandidates: string[] = [];
          for (const id of profileIds) {
            if (await taskService.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES)) continue;
            if (isOnline(id)) continue;
            const busyElsewhere = await deps.featureExecution.isProfileBusy(id, 'active-accounts');
            if (!busyElsewhere) offlineCandidates.push(id);
          }
          if (offlineCandidates.length > 0) {
            await deps.profileLifecycle.ensureProfilesOnline(offlineCandidates);
          }
        }

        const admission = await admitProfilesForStart({
          requestedProfileIds: profileIds,
          currentModuleId: 'active-accounts',
          isAlreadyRunningInCurrentModule: (id) =>
            taskService.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES),
          busyModuleLabelsForProfile: (id) =>
            deps.featureExecution.busyModuleLabels([id], 'active-accounts'),
          isProfileBusyInOtherModule: (id) =>
            deps.featureExecution.isProfileBusy(id, 'active-accounts'),
          isProfileReady: (id) => (!timing ? isOnline(id) : true),
        });

        if (admission.admittedProfileIds.length === 0) {
          if (admission.skippedBusy.length > 0) {
            return errorResult(
              'PROFILE_BUSY',
              admission.skippedBusy[0]?.reason ??
                '所选浏览器正在执行其他功能模块任务，请先停止后再启动任务组合',
              { skippedBusy: admission.skippedBusy },
            );
          }
          if (admission.alreadyRunningIds.length > 0 && admission.skippedOffline.length === 0) {
            return errorResult('PROFILE_PLAN_BUSY', '所选浏览器已有运行或等待中的任务组合', {
              alreadyRunningIds: admission.alreadyRunningIds,
            });
          }
          return errorResult(
            'PROFILE_OFFLINE',
            admission.skippedOffline[0]?.reason ?? '所选浏览器未连接，请先打开对应浏览器',
            { skippedOffline: admission.skippedOffline },
          );
        }

        const startRes = await taskService.start({
          requestId: randomUUID(),
          combinationId: comboRow.id,
          version: comboRow.version,
          profileIds: admission.admittedProfileIds,
          ...(timing ? { timing } : {}),
        });

        const enrichedProfiles = await buildEnrichedProfiles(deps);
        const profileNameById = new Map(enrichedProfiles.map((p) => [p.id, p.displayName]));

        return okResult({
          ok: true,
          combinationId: comboRow.id,
          combinationName: comboRow.saved.name,
          version: comboRow.version,
          mode: timing ? timing.mode : 'immediate',
          rolledToNextDay,
          timing: timing ?? null,
          timingLabel: timing ? taskTimingLabel(timing) : null,
          admittedProfileIds: admission.admittedProfileIds,
          skippedBusy: admission.skippedBusy,
          skippedOffline: admission.skippedOffline,
          alreadyRunningIds: admission.alreadyRunningIds,
          plansCount: startRes.plans.length,
          plans: startRes.plans.map((p) => summarizePlan(p, profileNameById)),
        });
      }

      if (action === 'pause' || action === 'resume' || action === 'stop') {
        const rawPids = collectRawProfileIds();
        const filterProfileIds =
          rawPids.length > 0 ? new Set(await resolveProfileIds(deps, rawPids)) : null;
        const filterPlanIds =
          Array.isArray(args.planIds) && args.planIds.length > 0
            ? new Set(args.planIds.map((x) => String(x).trim()).filter(Boolean))
            : null;

        const eligibleStates: ReadonlySet<Plan['state']> =
          action === 'pause'
            ? new Set(['QUEUED', 'RUNNING'])
            : action === 'resume'
              ? new Set(['PAUSED'])
              : new Set(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'REVIEW']);

        const overview = await taskService.overview();
        const targets = overview.plans.filter((plan) => {
          if (!eligibleStates.has(plan.state)) return false;
          if (filterPlanIds && !filterPlanIds.has(plan.id)) return false;
          if (filterProfileIds && !filterProfileIds.has(plan.profileId)) return false;
          return true;
        });

        if (targets.length === 0) {
          return okResult({
            ok: true,
            action,
            matchedPlansCount: 0,
            results: [],
          });
        }

        if (action === 'resume' && deps.profileLifecycle) {
          const offlineToOpen = [...new Set(targets.map((p) => p.profileId))].filter(
            (pid) => !deps.core.peers.get(pid)?.online,
          );
          if (offlineToOpen.length > 0) {
            await deps.profileLifecycle.ensureProfilesOnline(offlineToOpen);
          }
        }

        await deps.workspaceService.requireProfiles([
          ...new Set(targets.map((plan) => plan.profileId)),
        ]);

        const cmdRes = await taskService.command({
          command: action,
          plans: targets.map((plan) => ({
            profileId: plan.profileId,
            planId: plan.id,
            expectedState: plan.state,
            expectedUpdatedAt: plan.updatedAt,
          })),
        });

        return okResult({
          ok: cmdRes.results.every((r) => r.accepted),
          action,
          matchedPlansCount: targets.length,
          acceptedCount: cmdRes.results.filter((r) => r.accepted).length,
          results: cmdRes.results,
        });
      }

      // action === 'state'
      const [snapshot, overview, capabilities, enrichedProfiles] = await Promise.all([
        deps.workspaceService.snapshot(),
        taskService.overview(),
        taskService.capabilities(),
        buildEnrichedProfiles(deps),
      ]);
      const capById = new Map(capabilities.combinations.map((c) => [c.id, c]));
      const profileNameById = new Map(enrichedProfiles.map((p) => [p.id, p.displayName]));
      const includeTerminal = args.includeTerminalPlans === true;

      const combinations = snapshot.combinations.map((row) => {
        const cap = capById.get(row.id);
        const spec = row.saved;
        return {
          id: row.id,
          name: spec?.name ?? row.draft?.name ?? '未命名组合',
          note: spec?.note ?? row.draft?.note ?? '',
          published: spec !== null && row.version >= 1,
          hasUnsavedDraft: row.draft !== null,
          version: row.version,
          revision: row.revision,
          enabled: cap?.enabled ?? Boolean(spec),
          reason: cap?.reason ?? (spec ? '' : '草稿尚未保存'),
          randomOrder: spec?.randomOrder ?? false,
          loop: spec?.loop ?? null,
          stepsCount: spec?.steps.length ?? 0,
          steps: (spec?.steps ?? []).map((s) => ({
            id: s.id,
            type: s.type,
            ...(s.type === 'post'
              ? {
                  destination: s.destination ?? 'post',
                  count: s.count,
                  resourceMode: s.resourceMode ?? 'directory',
                }
              : s.type === 'friends'
                ? {
                    acceptMode: s.acceptMode,
                    maxAccepts: s.maxAccepts,
                    durationMinutes: s.durationMinutes,
                  }
                : {
                    durationMinutes: s.durationMinutes,
                    maxLikes: s.maxLikes,
                  }),
          })),
          updatedAt: row.updatedAt,
          updatedAtLocal: formatLocalDateTime(row.updatedAt),
        };
      });

      const activeSet = new Set<string>(ACTIVE_PLAN_STATES);
      const visiblePlans = includeTerminal
        ? overview.plans.slice(0, 80)
        : overview.plans.filter((p) => activeSet.has(p.state));

      return okResult({
        ok: true,
        dispatchEnabled: overview.dispatchEnabled,
        supportedStepTypes: capabilities.types,
        settings: overview.settings,
        combinationsCount: combinations.length,
        combinations,
        activePlansCount: overview.plans.filter((p) => activeSet.has(p.state)).length,
        plans: visiblePlans.map((p) => summarizePlan(p, profileNameById)),
      });
    },
  };

  return [wbActiveAccountsControl];
}
