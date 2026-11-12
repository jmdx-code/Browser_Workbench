import { randomUUID } from 'node:crypto';
import { bluestacksDisplayTitle, isBluestacksPortraitResolution } from '../../shared/bluestacks.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../../shared/facebook-target-id.js';
import type { BumperScheduledTask } from '../../shared/group-bumper.js';
import type { PosterTask } from '../../shared/group-poster.js';
import {
  buildEnrichedProfiles,
  errorResult,
  formatLocalDateTime,
  okResult,
  parseFlexibleScheduleTime,
  resolveProfileIdentifierFromList,
  resolveProfileIds,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

function enrichPosterTask(t: PosterTask) {
  return {
    ...t,
    scheduledAtLocal: formatLocalDateTime(t.scheduledAt),
    createdAtLocal: formatLocalDateTime(t.createdAt),
    startedAtLocal: formatLocalDateTime(t.startedAt),
    finishedAtLocal: formatLocalDateTime(t.finishedAt),
  };
}

function enrichBumperScheduledTask(t: BumperScheduledTask) {
  return {
    ...t,
    scheduledAtLocal: formatLocalDateTime(t.scheduledAt),
    createdAtLocal: formatLocalDateTime(t.createdAt),
    startedAtLocal: formatLocalDateTime(t.startedAt),
    finishedAtLocal: formatLocalDateTime(t.finishedAt),
  };
}

export function createPosterAndModuleTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  const wbPosterState: McpToolDefinition = {
    name: 'wb_poster_state',
    description:
      '查询「小组发帖」模块的完整真实状态：贴文素材库（含本地文件/Google Drive 缓存就绪状态）、定时与运行中任务列表（含成功数/跳过重复数/原因）、每个浏览器的实时运行状态与受限标记、正在发帖的队列明细以及待人工核对的未决操作。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        includeGroups: {
          type: 'boolean',
          description:
            '是否同时返回全部共享小组列表（默认 false；检索小组建议用 wb_manage_targets）',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const st = await deps.groupPosterService.state();
      const postedByMat = st.postedGroupIdsByMaterial ?? {};
      return okResult({
        ok: true,
        running: st.running,
        statusText: st.statusText,
        settings: st.settings,
        totalPostedAllTime: st.total,
        groupsCount: st.groups.length,
        ...(args.includeGroups === true ? { groups: st.groups } : {}),
        materials: st.materials.map((m) => ({
          id: m.id,
          caption: m.caption,
          mediaSource: m.mediaSource,
          background: m.background,
          aiLabel: m.aiLabel ?? 'default',
          mediaKind: m.mediaKind,
          cacheStatus: m.cacheStatus,
          cacheError: m.cacheError,
          localFilePath: m.localFilePath,
          selected: m.selected,
          usedCount: m.usedCount,
          alreadyPostedGroupsCount: (postedByMat[m.id] ?? []).length,
        })),
        tasks: (st.tasks ?? []).map(enrichPosterTask),
        profileCounts: st.profileCounts,
        activeGroupsByMaterial: st.activeGroupsByMaterial ?? {},
        pendingReviewOperations: st.pendingReviewOperations ?? [],
        dailyStats: st.dailyStats,
      });
    },
  };

  const wbPosterSaveMaterial: McpToolDefinition = {
    name: 'wb_poster_save_material',
    description:
      '新增、更新、删除、预检缓存发帖素材（支持纯文字/彩色背景、本地图片/视频路径、Google Drive 公开分享链接），或调整小组发帖并发参数（maxConcurrentProfiles / maxPostsPerAccount / materialsPerGroup）。保存素材后默认同步执行媒体预检，确保定时或立即发帖前缓存就绪。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'delete', 'toggle', 'prepare', 'save_settings'],
          description: '操作类型（默认 save）',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '更新已有素材时传原 id；新建可省略自动生成' },
              caption: { type: 'string', description: '贴文正文文案' },
              mediaSource: {
                type: 'string',
                description: '本地图片/视频绝对路径，或 Google Drive 分享链接（纯文字留空）',
              },
              background: {
                type: 'string',
                enum: ['plain', 'color'],
                description: '纯文字短贴（<=120字且<=4行且无媒体）可选 color 彩色背景，默认 plain',
              },
              aiLabel: {
                type: 'string',
                enum: ['default', 'on', 'off'],
                description: 'Facebook AI 内容声明开关（默认 default）',
              },
              selected: { type: 'boolean', description: '是否勾选（默认 true）' },
            },
          },
          description: 'save 时要保存的贴文素材列表（增量保存，不会清空已有素材）',
        },
        prepareNow: {
          type: 'boolean',
          description: 'save 后是否立即同步预检/下载媒体缓存并返回真实就绪状态（默认 true）',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'delete / toggle / prepare 时的素材 ID 列表',
        },
        selected: {
          type: 'boolean',
          description: 'toggle 时的目标勾选状态',
        },
        settings: {
          type: 'object',
          properties: {
            maxConcurrentProfiles: { type: 'number', minimum: 1, maximum: 50 },
            maxPostsPerAccount: { type: 'number', minimum: 1, maximum: 200 },
            materialsPerGroup: { type: 'number', minimum: 1, maximum: 50 },
          },
          description: 'save_settings 时的发帖全局设置',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const action = typeof args.action === 'string' ? args.action : 'save';

      if (action === 'save_settings') {
        const current = (await deps.groupPosterService.state()).settings;
        const patch =
          typeof args.settings === 'object' && args.settings !== null
            ? (args.settings as Record<string, unknown>)
            : {};
        const merged = {
          maxConcurrentProfiles:
            typeof patch.maxConcurrentProfiles === 'number'
              ? patch.maxConcurrentProfiles
              : current.maxConcurrentProfiles,
          maxPostsPerAccount:
            typeof patch.maxPostsPerAccount === 'number'
              ? patch.maxPostsPerAccount
              : current.maxPostsPerAccount,
          materialsPerGroup:
            typeof patch.materialsPerGroup === 'number'
              ? patch.materialsPerGroup
              : current.materialsPerGroup,
        };
        const st = await deps.groupPosterService.saveSettings(merged);
        return okResult({ ok: true, settings: st.settings });
      }

      if (action === 'delete') {
        const ids = Array.isArray(args.ids)
          ? args.ids.map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (ids.length === 0) return errorResult('IDS_REQUIRED', '请提供要删除的素材 ids');
        const st = await deps.groupPosterService.deleteMaterials({ ids });
        return okResult({
          ok: true,
          deletedIds: ids,
          remainingMaterialsCount: st.materials.length,
        });
      }

      if (action === 'toggle') {
        const ids = Array.isArray(args.ids)
          ? args.ids.map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (ids.length === 0) return errorResult('IDS_REQUIRED', '请提供要切换勾选的素材 ids');
        const st = await deps.groupPosterService.toggleMaterials({
          ids,
          selected: args.selected !== false,
        });
        return okResult({
          ok: true,
          toggledIds: ids,
          materialsCount: st.materials.length,
        });
      }

      if (action === 'prepare') {
        const ids = Array.isArray(args.ids)
          ? args.ids.map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (ids.length === 0) return errorResult('IDS_REQUIRED', '请提供要预检的素材 ids');
        const results: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          try {
            const prepared = await deps.groupPosterService.prepareMaterialById(id);
            results.push({
              id,
              ok: prepared !== null && prepared.cacheStatus === 'ready',
              material: prepared,
            });
          } catch (err) {
            results.push({
              id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return okResult({ ok: true, preparedResults: results });
      }

      const rawList = Array.isArray(args.items) ? args.items : [];
      if (rawList.length === 0) {
        return errorResult('ITEMS_REQUIRED', 'save 操作必须提供至少 1 条贴文素材 items');
      }

      const assignedIds: string[] = [];
      const normalizedItems = rawList.map((raw) => {
        const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : randomUUID();
        assignedIds.push(id);
        return {
          id,
          caption: typeof rec.caption === 'string' ? rec.caption : '',
          mediaSource: typeof rec.mediaSource === 'string' ? rec.mediaSource : '',
          background: rec.background === 'color' ? 'color' : 'plain',
          aiLabel: rec.aiLabel === 'on' || rec.aiLabel === 'off' ? rec.aiLabel : 'default',
          selected: typeof rec.selected === 'boolean' ? rec.selected : true,
        };
      });

      await deps.groupPosterService.saveMaterials({
        items: normalizedItems,
        replaceAll: false,
      });

      const prepareResults: Array<{ id: string; ready: boolean; error: string | null }> = [];
      if (args.prepareNow !== false) {
        for (const id of assignedIds) {
          try {
            const mat = await deps.groupPosterService.prepareMaterialById(id);
            prepareResults.push({
              id,
              ready: mat?.cacheStatus === 'ready',
              error: mat?.cacheError ?? null,
            });
          } catch (err) {
            prepareResults.push({
              id,
              ready: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const st = await deps.groupPosterService.state();
      const idSet = new Set(assignedIds);
      const savedMaterials = st.materials.filter((m) => idSet.has(m.id));

      return okResult({
        ok: true,
        savedCount: savedMaterials.length,
        savedMaterials,
        prepareResults,
      });
    },
  };

  const wbPosterDispatch: McpToolDefinition = {
    name: 'wb_poster_dispatch',
    description:
      '派发、取消、删除或停止「小组发帖」任务。支持单条或批量创建立即发帖或定时发帖任务（scheduledAt 支持 "2026-11-11 20:30"、"20:30"、"明天 09:00"、ISO 字符串、毫秒时间戳或 null 立即执行）。若小组尚未在共享小组库中，设置 autoAddMissingGroups=true 可自动入库后再建单。返回每条任务的真实持久化 ID、预计发帖组数、因历史已发而自动跳过的组数与实时状态。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_tasks', 'cancel_task', 'delete_task', 'stop_all', 'stop_profiles'],
          description: '调度动作（默认 create_tasks）',
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              materialId: { type: 'string', description: '已保存的贴文素材 ID' },
              groupIds: {
                type: 'array',
                items: { type: 'string' },
                description: '目标 Facebook 小组 ID 或小组链接数组',
              },
              accountMode: {
                type: 'string',
                enum: ['selected', 'all_online'],
                description:
                  'selected 指定浏览器（默认），或 all_online 动态使用全部在线闲置浏览器',
              },
              profileIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'accountMode=selected 时指定的浏览器 profileId 数组',
              },
              scheduledAt: {
                type: ['string', 'number', 'null'],
                description:
                  '定时启动时间：传 null 或省略为立即发帖；支持 "20:30"、"明天 09:00"、"2026-11-11 20:30" 或毫秒时间戳',
              },
            },
            required: ['materialId', 'groupIds'],
          },
          description: 'create_tasks 时要创建的 1 条或多条发帖任务',
        },
        autoAddMissingGroups: {
          type: 'boolean',
          description:
            '若 groupIds 中包含尚未加入共享小组库的新小组 ID/链接，是否自动先入库（默认 true）',
        },
        taskId: {
          type: 'string',
          description: 'cancel_task 或 delete_task 时的任务 ID',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'stop_profiles 时指定停止的浏览器 profileId 列表',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const action = typeof args.action === 'string' ? args.action : 'create_tasks';

      if (action === 'cancel_task') {
        const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
        if (!taskId) return errorResult('TASK_ID_REQUIRED', 'cancel_task 需要提供 taskId');
        const st = await deps.groupPosterService.cancelTask({ id: taskId });
        const target = (st.tasks ?? []).find((t) => t.id === taskId) ?? null;
        return okResult({
          ok: true,
          cancelledTaskId: taskId,
          task: target ? enrichPosterTask(target) : null,
          statusText: st.statusText,
        });
      }

      if (action === 'delete_task') {
        const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
        if (!taskId) return errorResult('TASK_ID_REQUIRED', 'delete_task 需要提供 taskId');
        const st = await deps.groupPosterService.deleteTask({ id: taskId });
        return okResult({
          ok: true,
          deletedTaskId: taskId,
          remainingTasksCount: (st.tasks ?? []).length,
          statusText: st.statusText,
        });
      }

      if (action === 'stop_all') {
        const st = await deps.groupPosterService.stop();
        return okResult({
          ok: true,
          running: st.running,
          statusText: st.statusText,
          profileCounts: st.profileCounts,
        });
      }

      if (action === 'stop_profiles') {
        const rawPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (rawPids.length === 0) {
          return errorResult('PROFILE_IDS_REQUIRED', 'stop_profiles 需要提供 profileIds');
        }
        const pids = await resolveProfileIds(deps, rawPids);
        await deps.groupPosterService.stopProfiles(pids);
        const st = await deps.groupPosterService.state();
        return okResult({
          ok: true,
          stoppedProfileIds: pids,
          running: st.running,
          statusText: st.statusText,
          profileCounts: st.profileCounts,
        });
      }

      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      if (rawTasks.length === 0) {
        return errorResult('TASKS_REQUIRED', 'create_tasks 需要提供至少 1 条任务定义 tasks');
      }

      const hasImmediateTask = rawTasks.some((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const rec = item as Record<string, unknown>;
        try {
          return parseFlexibleScheduleTime(rec.scheduledAt).mode === 'immediate';
        } catch {
          return false;
        }
      });

      const autoAdd = args.autoAddMissingGroups !== false;
      let currentState = await deps.groupPosterService.state();
      const knownGroupIds = new Set(currentState.groups.map((g) => g.id));

      if (autoAdd) {
        const missingToAdd: Array<{ id: string }> = [];
        const missingSeen = new Set<string>();
        for (const item of rawTasks) {
          if (typeof item !== 'object' || item === null) continue;
          const rec = item as Record<string, unknown>;
          const gids = Array.isArray(rec.groupIds) ? rec.groupIds : [];
          for (const g of gids) {
            const extracted = extractFacebookGroupId(String(g).trim());
            if (extracted && !knownGroupIds.has(extracted) && !missingSeen.has(extracted)) {
              missingSeen.add(extracted);
              missingToAdd.push({ id: extracted });
            }
          }
        }
        if (missingToAdd.length > 0) {
          currentState = await deps.groupPosterService.addGroups(
            { items: missingToAdd },
            { skipAutoRefresh: hasImmediateTask },
          );
          for (const g of currentState.groups) knownGroupIds.add(g.id);
        }
      }

      const enrichedProfiles = await buildEnrichedProfiles(deps);
      const outcomes: Array<Record<string, unknown>> = [];
      for (let idx = 0; idx < rawTasks.length; idx++) {
        const raw = rawTasks[idx];
        if (typeof raw !== 'object' || raw === null) continue;
        const rec = raw as Record<string, unknown>;
        const materialId = typeof rec.materialId === 'string' ? rec.materialId.trim() : '';
        const groupIds = Array.isArray(rec.groupIds)
          ? rec.groupIds.map((g) => extractFacebookGroupId(String(g).trim())).filter(Boolean)
          : [];
        const accountMode: 'selected' | 'all_online' =
          rec.accountMode === 'all_online' ? 'all_online' : 'selected';
        const rawProfileInputs = Array.isArray(rec.profileIds)
          ? rec.profileIds.map((p) => String(p).trim()).filter(Boolean)
          : [];

        try {
          const seenPids = new Set<string>();
          const profileIds: string[] = [];
          for (const rawPid of rawProfileInputs) {
            const resolvedPid = resolveProfileIdentifierFromList(enrichedProfiles, rawPid);
            if (!seenPids.has(resolvedPid)) {
              seenPids.add(resolvedPid);
              profileIds.push(resolvedPid);
            }
          }
          if (accountMode === 'selected' && profileIds.length === 0) {
            throw new Error(
              'PROFILE_IDS_REQUIRED: accountMode="selected" 时必须指定 profileIds（支持 UUID、浏览器名如 "用户8" 或专页名），或改传 accountMode="all_online"',
            );
          }

          const parsedSchedule = parseFlexibleScheduleTime(rec.scheduledAt);
          const beforeIds = new Set((currentState.tasks ?? []).map((t) => t.id));
          currentState = await deps.groupPosterService.createTask({
            materialId,
            groupIds,
            accountMode,
            profileIds,
            scheduledAt: parsedSchedule.scheduledAt,
          });
          const created = (currentState.tasks ?? []).find((t) => !beforeIds.has(t.id)) ?? null;
          outcomes.push({
            index: idx,
            ok: true,
            created: created !== null,
            allAlreadyPostedSkipped: created === null,
            rolledToNextDay: parsedSchedule.rolledToNextDay,
            task: created ? enrichPosterTask(created) : null,
            statusText: currentState.statusText,
          });
        } catch (err) {
          outcomes.push({
            index: idx,
            ok: false,
            materialId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const finalState = await deps.groupPosterService.state();
      return okResult({
        ok: outcomes.every((o) => o.ok === true),
        createdCount: outcomes.filter((o) => o.created === true).length,
        failedCount: outcomes.filter((o) => o.ok === false).length,
        outcomes,
        running: finalState.running,
        statusText: finalState.statusText,
        profileCounts: finalState.profileCounts,
      });
    },
  };

  const wbPosterLogs: McpToolDefinition = {
    name: 'wb_poster_logs',
    description:
      '查询「小组发帖」已落盘确认的真实发帖回执日志（含真实 postId、postUrl 帖子链接、使用的专页/个人身份 identityType、accountName、groupId、groupName、postedAt）以及待核对未决记录。严禁在未查到真实 postUrl 或任务计数未完成时凭主观宣称发帖成功。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: '按小组名、小组 ID、账号名或文案预览过滤',
        },
        materialId: {
          type: 'string',
          description: '按指定素材 ID 精确过滤',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: '返回条数上限（默认 50，最大 200）',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const search = typeof args.search === 'string' ? args.search.trim() : '';
      const materialId =
        typeof args.materialId === 'string' && args.materialId.trim()
          ? args.materialId.trim()
          : undefined;
      const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 50))));

      const [rows, st] = await Promise.all([
        deps.groupPosterService.logs(search, undefined, undefined, materialId),
        deps.groupPosterService.state(),
      ]);

      return okResult({
        ok: true,
        returnedCount: Math.min(limit, rows.length),
        logs: rows.slice(0, limit).map((r) => ({
          ...r,
          postedAtLocal: formatLocalDateTime(r.postedAt),
        })),
        pendingReviewOperations: st.pendingReviewOperations ?? [],
      });
    },
  };

  const wbBumperControl: McpToolDefinition = {
    name: 'wb_bumper_control',
    description:
      '控制与监控「小组顶贴（group-bumper）」和「专页顶贴（page-bumper）」模块：查询状态与定时任务（state）、读取历史顶贴回执日志（logs）、配置点赞/留言参数（save_settings）、保存留言话术池（save_comments）、立即启动或仅扫描（start / scan_only，支持自动唤醒已选离线浏览器）、创建定时顶贴任务（schedule，到点自动唤醒离线浏览器）、取消或删除定时任务（cancel_task / delete_task）以及停止运行（stop）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['group-bumper', 'page-bumper'],
          description: '模块模式：group-bumper（小组顶贴）或 page-bumper（专页顶贴）',
        },
        action: {
          type: 'string',
          enum: [
            'state',
            'logs',
            'save_settings',
            'save_comments',
            'start',
            'scan_only',
            'schedule',
            'cancel_task',
            'delete_task',
            'stop',
          ],
          description: '操作类型',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'start / scan_only / schedule / stop 时指定的已注册浏览器标识列表（支持离线浏览器，启动或到点时将自动唤醒；stop 省略则停止当前模式的全部运行中浏览器）',
        },
        groupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'group-bumper 启动或定时时选择的目标小组 ID / 链接列表',
        },
        pageIds: {
          type: 'array',
          items: { type: 'string' },
          description: '启动或定时时选择的目标主页/专页 ID / 链接列表',
        },
        scheduledAt: {
          type: ['string', 'number'],
          description:
            'action="schedule" 时的预定启动时间（支持 "20:30"、"2026-11-12T20:30:00"、"+30m" 或毫秒时间戳）',
        },
        taskId: {
          type: 'string',
          description: 'action="cancel_task" 或 "delete_task" 时的定时任务 ID',
        },
        settings: {
          type: 'object',
          description: 'save_settings 时的参数补丁（未传字段自动保留当前设置）',
        },
        comments: {
          type: 'array',
          items: { type: 'string' },
          description: 'save_comments 时的留言话术文本列表',
        },
        consumeCommentOnUse: {
          type: 'boolean',
          description: 'save_comments 时是否每使用一条话术即消耗移除',
        },
        search: {
          type: 'string',
          description: 'logs 搜索关键词',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: 'logs 返回条数上限（默认 50）',
        },
      },
      required: ['mode', 'action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const bumper = deps.getGroupBumperService();
      if (!bumper) {
        return errorResult('BUMPER_UNAVAILABLE', '顶贴服务当前不可用');
      }
      const mode: 'group-bumper' | 'page-bumper' =
        args.mode === 'page-bumper' ? 'page-bumper' : 'group-bumper';
      const action = String(args.action ?? 'state');

      if (action === 'logs') {
        const search = typeof args.search === 'string' ? args.search : '';
        const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 50))));
        const sourceMode = mode === 'page-bumper' ? 'page' : 'group';
        const logs = await bumper.logs(search, undefined, undefined, limit, sourceMode);
        return okResult({ ok: true, mode, count: logs.length, logs });
      }

      if (action === 'save_settings') {
        const current = await bumper.state();
        const base = mode === 'page-bumper' ? current.pageSettings : current.settings;
        const patch =
          typeof args.settings === 'object' && args.settings !== null
            ? (args.settings as Record<string, unknown>)
            : {};
        const merged = { ...base, ...patch };
        const st = await bumper.manage(
          mode === 'page-bumper' ? 'page-settings' : 'settings',
          merged,
        );
        return okResult({
          ok: true,
          mode,
          settings: mode === 'page-bumper' ? st.pageSettings : st.settings,
        });
      }

      if (action === 'save_comments') {
        const texts = Array.isArray(args.comments)
          ? args.comments.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const current = await bumper.state();
        const baseSettings = mode === 'page-bumper' ? current.pageSettings : current.settings;
        const consume =
          typeof args.consumeCommentOnUse === 'boolean'
            ? args.consumeCommentOnUse
            : (baseSettings?.consumeCommentOnUse ?? false);
        const st = await bumper.manage(mode === 'page-bumper' ? 'page-comments' : 'comments', {
          texts,
          consumeCommentOnUse: consume,
          scope: mode === 'page-bumper' ? 'page' : 'group',
        });
        const savedComments = (mode === 'page-bumper' ? st.pageComments : st.comments) ?? [];
        return okResult({
          ok: true,
          mode,
          commentsCount: savedComments.length,
        });
      }

      if (action === 'schedule') {
        const rawPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (rawPids.length === 0) {
          return errorResult('PROFILE_IDS_REQUIRED', 'schedule 需要提供至少 1 个 profileIds');
        }
        const profileIds = await resolveProfileIds(deps, rawPids);
        const pageIds = Array.isArray(args.pageIds)
          ? args.pageIds.map((x) => extractFacebookPageId(String(x).trim())).filter(Boolean)
          : [];
        const groupIds = Array.isArray(args.groupIds)
          ? args.groupIds.map((x) => extractFacebookGroupId(String(x).trim())).filter(Boolean)
          : [];
        const parsedSchedule = parseFlexibleScheduleTime(args.scheduledAt);
        if (parsedSchedule.mode !== 'scheduled' || !parsedSchedule.scheduledAt) {
          return errorResult(
            'SCHEDULE_TIME_REQUIRED',
            'schedule 需要提供未来的 scheduledAt 时间（如 "20:30"、"+30m" 或 ISO 时间）',
          );
        }

        const current = await bumper.state();
        const knownGroups = new Set(current.groups.map((g) => g.id));
        const knownPages = new Set(current.pages.map((p) => p.id));
        const missingGroups = groupIds.filter((id) => !knownGroups.has(id)).map((id) => ({ id }));
        const missingPages = pageIds.filter((id) => !knownPages.has(id)).map((id) => ({ id }));
        if (missingGroups.length > 0) {
          await bumper.manage('groups/add', { items: missingGroups });
        }
        if (missingPages.length > 0) {
          await bumper.manage('pages/add', { items: missingPages });
        }

        const beforeIds = new Set((current.scheduledTasks ?? []).map((t) => t.id));
        const st = await bumper.manage('tasks/create', {
          mode,
          profileIds,
          groupIds: mode === 'page-bumper' ? [] : groupIds,
          pageIds,
          scheduledAt: parsedSchedule.scheduledAt,
        });
        const created = (st.scheduledTasks ?? []).find((t) => !beforeIds.has(t.id)) ?? null;
        return okResult({
          ok: true,
          mode,
          rolledToNextDay: parsedSchedule.rolledToNextDay,
          task: created ? enrichBumperScheduledTask(created) : null,
          scheduledTasksCount: (st.scheduledTasks ?? []).filter((t) => t.mode === mode).length,
        });
      }

      if (action === 'cancel_task' || action === 'delete_task') {
        const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
        if (!taskId) {
          return errorResult('TASK_ID_REQUIRED', `${action} 需要提供 taskId`);
        }
        const st = await bumper.manage(action === 'cancel_task' ? 'tasks/cancel' : 'tasks/delete', {
          id: taskId,
        });
        return okResult({
          ok: true,
          mode,
          action,
          taskId,
          scheduledTasks: (st.scheduledTasks ?? [])
            .filter((t) => t.mode === mode)
            .map(enrichBumperScheduledTask),
        });
      }

      if (action === 'start' || action === 'scan_only') {
        const rawPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const profileIds = await resolveProfileIds(deps, rawPids);
        const pageIds = Array.isArray(args.pageIds)
          ? args.pageIds.map((x) => extractFacebookPageId(String(x).trim())).filter(Boolean)
          : [];
        const groupIds = Array.isArray(args.groupIds)
          ? args.groupIds.map((x) => extractFacebookGroupId(String(x).trim())).filter(Boolean)
          : [];

        const st =
          mode === 'page-bumper'
            ? await bumper.startPageBumper({ profileIds, pageIds })
            : action === 'scan_only'
              ? await bumper.startScanOnly({ profileIds, groupIds, pageIds })
              : await bumper.start({ profileIds, groupIds, pageIds });

        return okResult({
          ok: true,
          mode,
          running: mode === 'page-bumper' ? st.pageBumperRunning : st.running,
          statusText: mode === 'page-bumper' ? st.pageBumperStatusText : st.statusText,
          profileCounts: mode === 'page-bumper' ? st.pageBumperProfileCounts : st.profileCounts,
          pendingReviewOperations: st.pendingReviewOperations ?? [],
        });
      }

      if (action === 'stop') {
        const rawPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const profileIds = rawPids.length > 0 ? await resolveProfileIds(deps, rawPids) : undefined;
        const st = await bumper.stop(
          profileIds && profileIds.length > 0 ? profileIds : undefined,
          mode,
        );
        return okResult({
          ok: true,
          mode,
          running: mode === 'page-bumper' ? st.pageBumperRunning : st.running,
          statusText: mode === 'page-bumper' ? st.pageBumperStatusText : st.statusText,
          profileCounts: mode === 'page-bumper' ? st.pageBumperProfileCounts : st.profileCounts,
        });
      }

      const st = await bumper.state();
      return okResult({
        ok: true,
        mode,
        running: mode === 'page-bumper' ? st.pageBumperRunning : st.running,
        statusText: mode === 'page-bumper' ? st.pageBumperStatusText : st.statusText,
        settings: mode === 'page-bumper' ? st.pageSettings : st.settings,
        commentsCount: ((mode === 'page-bumper' ? st.pageComments : st.comments) ?? []).length,
        groupsCount: st.groups.length,
        pagesCount: st.pages.length,
        total: mode === 'page-bumper' ? st.pageTotal : st.total,
        profileCounts: mode === 'page-bumper' ? st.pageBumperProfileCounts : st.profileCounts,
        scheduledTasks: (st.scheduledTasks ?? [])
          .filter((t) => t.mode === mode)
          .map(enrichBumperScheduledTask),
        pendingReviewOperations: st.pendingReviewOperations ?? [],
      });
    },
  };

  const wbInviterControl: McpToolDefinition = {
    name: 'wb_inviter_control',
    description:
      '控制与监控「小组邀请人（group-inviter）」模块：查询运行状态（state）、查看邀请成功记录（logs）、修改每组邀请人数与并发数（save_settings）、启动邀请任务（start）以及停止全部或指定浏览器（stop）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'logs', 'save_settings', 'start', 'stop'],
          description: '操作类型',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'start 或 stop 时指定的浏览器 profileId 列表（stop 省略则停止全部）',
        },
        groupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'start 时指定的目标小组 ID 列表',
        },
        invitesPerGroup: {
          type: 'number',
          minimum: 1,
          maximum: 500,
          description: 'save_settings 或 start 时每组邀请好友人数',
        },
        maxConcurrentProfiles: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'save_settings 时最大并发浏览器数',
        },
        search: {
          type: 'string',
          description: 'logs 检索关键词',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 300,
          description: 'logs 返回条数上限（默认 50）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const action = String(args.action ?? 'state');

      if (action === 'logs') {
        const search = typeof args.search === 'string' ? args.search : '';
        const limit = Math.max(1, Math.min(300, Math.floor(Number(args.limit ?? 50))));
        const rows = await deps.groupInviterService.logs(search, undefined, limit);
        return okResult({ ok: true, count: rows.length, logs: rows });
      }

      if (action === 'save_settings') {
        const cur = await deps.groupInviterService.state();
        const st = await deps.groupInviterService.updateSettings({
          invitesPerGroup:
            typeof args.invitesPerGroup === 'number' ? args.invitesPerGroup : cur.invitesPerGroup,
          maxConcurrentProfiles:
            typeof args.maxConcurrentProfiles === 'number'
              ? args.maxConcurrentProfiles
              : cur.maxConcurrentProfiles,
          playSoundOnComplete: cur.playSoundOnComplete,
        });
        return okResult({
          ok: true,
          invitesPerGroup: st.invitesPerGroup,
          maxConcurrentProfiles: st.maxConcurrentProfiles,
        });
      }

      if (action === 'start') {
        const rawPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const profileIds = await resolveProfileIds(deps, rawPids);
        const groupIds = Array.isArray(args.groupIds)
          ? args.groupIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const st = await deps.groupInviterService.start({
          profileIds,
          groupIds,
          ...(typeof args.invitesPerGroup === 'number'
            ? { invitesPerGroup: args.invitesPerGroup }
            : {}),
        });
        return okResult({
          ok: true,
          running: st.running,
          runId: st.runId ?? null,
          statusText: st.statusText,
          profileCounts: st.profileCounts,
        });
      }

      if (action === 'stop') {
        const rawPids = Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const profileIds = rawPids.length > 0 ? await resolveProfileIds(deps, rawPids) : [];
        const st =
          profileIds.length > 0
            ? await deps.groupInviterService.stopProfiles({ profileIds })
            : await deps.groupInviterService.stop();
        return okResult({
          ok: true,
          running: st.running,
          statusText: st.statusText,
          profileCounts: st.profileCounts,
        });
      }

      const st = await deps.groupInviterService.state();
      return okResult({
        ok: true,
        running: st.running,
        runId: st.runId ?? null,
        statusText: st.statusText,
        invitesPerGroup: st.invitesPerGroup,
        maxConcurrentProfiles: st.maxConcurrentProfiles,
        groupsCount: st.groups.length,
        profileCounts: st.profileCounts,
      });
    },
  };

  const wbBluestacksControl: McpToolDefinition = {
    name: 'wb_bluestacks_control',
    description:
      '控制与监控「蓝蝶模拟器多开（BlueStacks FB Lite）」模块：查询/强制刷新全部模拟器实例与在线竖屏状态（state / refresh）、启动模拟器窗口（launch）、关闭模拟器窗口（close）、识别 FB Lite 登录账号（inspect）、启动或停止蓝蝶小组顶贴（start_bumper / stop_bumper）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'refresh', 'launch', 'close', 'inspect', 'start_bumper', 'stop_bumper'],
          description: '操作类型',
        },
        instanceIds: {
          type: 'array',
          items: { type: 'string' },
          description: '目标蓝蝶实例 ID 列表（如 Nougat64、Nougat64_1 等）',
        },
        groupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'start_bumper 时选择的目标小组 ID 列表',
        },
        pageIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'start_bumper 时选择的目标主页/专页 ID 列表',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const action = String(args.action ?? 'state');
      const instanceIds = Array.isArray(args.instanceIds)
        ? args.instanceIds.map((x) => String(x).trim()).filter(Boolean)
        : [];

      const formatBsState = (st: Awaited<ReturnType<typeof deps.bluestacksService.state>>) => ({
        ok: true,
        running: st.running,
        statusText: st.statusText,
        launchingIds: st.launchingIds,
        closingIds: st.closingIds,
        inspectingIds: st.inspectingIds,
        totalBumpedAllTime: st.total,
        bumperSettings: st.bumperSettings,
        instances: st.instances.map((inst) => ({
          id: inst.id,
          displayTitle: bluestacksDisplayTitle(inst),
          displayName: inst.displayName,
          alias: inst.alias,
          adbPort: inst.adbPort,
          online: inst.online,
          resolution: `${inst.fbWidth}x${inst.fbHeight}`,
          portraitReady: isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight),
          fbLiteInstalled: inst.fbLiteInstalled,
          accountState: inst.accountState,
          accountName: inst.accountName,
          stat: st.profileCounts[inst.id] ?? null,
        })),
      });

      if (action === 'refresh') {
        return okResult(formatBsState(await deps.bluestacksService.state(true)));
      }
      if (action === 'launch') {
        if (instanceIds.length === 0) {
          return errorResult('INSTANCE_IDS_REQUIRED', 'launch 需要提供 instanceIds');
        }
        return okResult(
          formatBsState(await deps.bluestacksService.launchInstances({ instanceIds })),
        );
      }
      if (action === 'close') {
        if (instanceIds.length === 0) {
          return errorResult('INSTANCE_IDS_REQUIRED', 'close 需要提供 instanceIds');
        }
        return okResult(
          formatBsState(await deps.bluestacksService.closeInstances({ instanceIds })),
        );
      }
      if (action === 'inspect') {
        if (instanceIds.length === 0) {
          return errorResult('INSTANCE_IDS_REQUIRED', 'inspect 需要提供 instanceIds');
        }
        return okResult(
          formatBsState(await deps.bluestacksService.inspectInstances({ instanceIds })),
        );
      }
      if (action === 'start_bumper') {
        const groupIds = Array.isArray(args.groupIds)
          ? args.groupIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const pageIds = Array.isArray(args.pageIds)
          ? args.pageIds.map((x) => String(x).trim()).filter(Boolean)
          : [];
        return okResult(
          formatBsState(
            await deps.bluestacksService.startBumper({
              profileIds: instanceIds,
              groupIds,
              pageIds,
            }),
          ),
        );
      }
      if (action === 'stop_bumper') {
        const st = await deps.bluestacksService.stopBumper(
          instanceIds.length > 0 ? instanceIds : undefined,
        );
        return okResult(formatBsState(st));
      }

      return okResult(formatBsState(await deps.bluestacksService.state(false)));
    },
  };

  return [
    wbPosterState,
    wbPosterSaveMaterial,
    wbPosterDispatch,
    wbPosterLogs,
    wbBumperControl,
    wbInviterControl,
    wbBluestacksControl,
  ];
}
