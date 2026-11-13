import { isBluestacksPortraitResolution } from '../../shared/bluestacks.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../../shared/facebook-target-id.js';
import { isLocalAvatar, isTargetIncomplete } from '../../shared/group-bumper.js';
import {
  buildEnrichedProfiles,
  errorResult,
  formatLocalDateTime,
  okResult,
  readSpreadsheetOrTableFile,
  resolveDataDirIntegrity,
  resolveProfileIdentifierFromList,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

function summarizeTarget(item: {
  id: string;
  name: string;
  avatarUrl?: string | null;
  folderId?: string | null;
  totalBumpedCount?: number;
  updatedAt?: number;
}) {
  return {
    id: item.id,
    name: item.name,
    folderId: item.folderId ?? null,
    hasLocalAvatar: isLocalAvatar(item.avatarUrl),
    incomplete: isTargetIncomplete(item),
    totalBumpedCount: item.totalBumpedCount ?? 0,
    updatedAt: item.updatedAt ?? 0,
  };
}

export function createWorkspaceAndTargetTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  const wbGetOverview: McpToolDefinition = {
    name: 'wb_get_overview',
    description:
      '获取 Browser Workbench 全景真实运行状态：在线/就绪/忙碌/异常浏览器列表、当前运行模块、活跃账号（任务组合与计划计数）、小组发帖（含定时/运行中任务计数与待核对记录）、小组顶贴/专页顶贴、小组邀请人、蓝蝶多开状态（含蓝蝶小组顶贴与蓝蝶专页顶贴）、AI 浏览器会话以及最近 WARN/ERROR 诊断事件。开始任何操作前建议先调用一次。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const now = Date.now();
      const [
        snapshot,
        profiles,
        activeModules,
        posterState,
        inviterState,
        bluestacksState,
        taskOverview,
      ] = await Promise.all([
        deps.workspaceService.snapshot(),
        buildEnrichedProfiles(deps),
        deps.featureExecution.activeModuleLabels(),
        deps.groupPosterService.state(),
        deps.groupInviterService.state(),
        deps.bluestacksService.state(false),
        deps.taskService ? deps.taskService.overview() : Promise.resolve(null),
      ]);
      const bumperState = await deps.getGroupBumperService()?.state();
      const onlineProfiles = profiles.filter((p) => p.online);
      const posterTasks = posterState.tasks ?? [];
      const scheduledTasks = posterTasks.filter((t) => t.status === 'scheduled');
      const runningTasks = posterTasks.filter((t) => t.status === 'running');
      const todayPostsTotal = Object.values(posterState.profileCounts).reduce(
        (acc, item) => acc + (item.today ?? 0),
        0,
      );

      const recentAnomalies = devDiag
        .recent(120)
        .filter((e) => e.level === 'WARN' || e.level === 'ERROR')
        .slice(-12)
        .map((e) => ({
          id: e.id,
          localTime: e.localTime,
          level: e.level,
          category: e.category,
          event: e.event,
          profileId: e.profileId ?? null,
          profileName: e.profileName ?? null,
          reason: e.reason ?? null,
        }));

      const dataDirectory = resolveDataDirIntegrity(deps.dataDir);
      const activeAccountPlans = taskOverview
        ? taskOverview.plans.filter((p) => !['STOPPED', 'COMPLETED', 'FAILED'].includes(p.state))
        : [];

      return okResult({
        ok: true,
        softwareVersion: deps.softwareVersion,
        extensionVersion: deps.extensionVersion,
        dataDirectory,
        now,
        nowLocal: formatLocalDateTime(now),
        activeModules,
        profilesSummary: {
          total: profiles.length,
          online: onlineProfiles.length,
          offline: profiles.length - onlineProfiles.length,
          readyForTasks: onlineProfiles.filter((p) => p.readyForTasks).length,
          busy: onlineProfiles.filter((p) => p.busyModules.length > 0).length,
          unresolvedTotal: profiles.reduce((acc, p) => acc + p.unresolvedCount, 0),
          agentBrowserSupported: onlineProfiles.filter((p) => p.supportsAgentBrowser).length,
          restrictedOrVerification: onlineProfiles.filter((p) =>
            ['restricted', 'verification', 'logged-out'].includes(p.account.state),
          ).length,
        },
        onlineProfiles,
        activeAccounts: taskOverview
          ? {
              dispatchEnabled: taskOverview.dispatchEnabled,
              maxConcurrentProfiles: taskOverview.settings.maxConcurrentProfiles,
              combinationsCount: snapshot.combinations.filter((c) => c.saved !== null).length,
              runningPlansCount: activeAccountPlans.filter((p) => p.state === 'RUNNING').length,
              queuedPlansCount: activeAccountPlans.filter((p) => p.state === 'QUEUED').length,
              pausedPlansCount: activeAccountPlans.filter(
                (p) => p.state === 'PAUSED' || p.state === 'PAUSING',
              ).length,
              reviewPlansCount: activeAccountPlans.filter((p) => p.state === 'REVIEW').length,
              activePlans: activeAccountPlans.slice(0, 10).map((p) => ({
                id: p.id,
                profileId: p.profileId,
                combinationId: p.combinationId,
                combinationName: p.snapshot.name,
                state: p.state,
                reason: p.reason,
                round: p.round,
                position: p.position,
                updatedAtLocal: formatLocalDateTime(p.updatedAt),
              })),
            }
          : null,
        groupPoster: {
          running: posterState.running,
          statusText: posterState.statusText,
          groupsCount: posterState.groups.length,
          materialsCount: posterState.materials.length,
          todayPostsTotal,
          scheduledTasksCount: scheduledTasks.length,
          runningTasksCount: runningTasks.length,
          pendingReviewCount: (posterState.pendingReviewOperations ?? []).length,
          scheduledTasks: scheduledTasks.slice(0, 10).map((t) => ({
            id: t.id,
            materialId: t.materialId,
            captionPreview: t.captionPreview,
            scheduledAt: t.scheduledAt,
            scheduledAtLocal: formatLocalDateTime(t.scheduledAt),
            totalGroups: t.totalGroups,
            accountMode: t.accountMode,
            profileIds: t.profileIds,
          })),
          runningTasks: runningTasks.map((t) => ({
            id: t.id,
            materialId: t.materialId,
            postedCount: t.postedCount,
            skippedCount: t.skippedCount,
            totalGroups: t.totalGroups,
            statusReason: t.statusReason,
          })),
        },
        groupBumper: bumperState
          ? {
              running: bumperState.running,
              statusText: bumperState.statusText,
              pageBumperRunning: bumperState.pageBumperRunning,
              pageBumperStatusText: bumperState.pageBumperStatusText,
              groupsCount: bumperState.groups.length,
              pagesCount: bumperState.pages.length,
              scheduledTasksCount: (bumperState.scheduledTasks ?? []).filter(
                (t) => t.status === 'scheduled',
              ).length,
              scheduledTasks: (bumperState.scheduledTasks ?? [])
                .filter((t) => t.status === 'scheduled' || t.status === 'running')
                .slice(0, 10)
                .map((t) => ({
                  id: t.id,
                  mode: t.mode,
                  status: t.status,
                  scheduledAt: t.scheduledAt,
                  scheduledAtLocal: formatLocalDateTime(t.scheduledAt),
                  profilesCount: t.profileIds.length,
                  groupsCount: t.groupIds.length,
                  pagesCount: t.pageIds.length,
                })),
              pendingReviewCount: (bumperState.pendingReviewOperations ?? []).length,
            }
          : null,
        groupInviter: {
          running: inviterState.running,
          statusText: inviterState.statusText,
          groupsCount: inviterState.groups.length,
          runId: inviterState.runId ?? null,
        },
        bluestacks: {
          adbReady: Boolean(bluestacksState.config?.adbReady),
          playerReady: Boolean(bluestacksState.config?.playerReady),
          running: bluestacksState.running,
          statusText: bluestacksState.statusText,
          pageBumperRunning: bluestacksState.pageBumperRunning,
          pageBumperStatusText: bluestacksState.pageBumperStatusText,
          groupEnableSound: Boolean(bluestacksState.bumperSettings?.enableSound),
          pageEnableSound: Boolean(bluestacksState.pageBumperSettings?.enableSound),
          totalInstances: bluestacksState.instances.length,
          onlineInstances: bluestacksState.instances.filter((i) => i.online).length,
          portraitReadyInstances: bluestacksState.instances.filter(
            (i) => i.online && isBluestacksPortraitResolution(i.fbWidth, i.fbHeight),
          ).length,
        },
        agentBrowserSessions: deps.agentBrowser.listSessions(),
        recentWarningsAndErrors: recentAnomalies,
      });
    },
  };

  const wbListProfiles: McpToolDefinition = {
    name: 'wb_list_profiles',
    description:
      '查询所有浏览器配置与实时连接/Facebook 账号（或专页）身份缓存。支持按关键词匹配浏览器别名、Facebook 专页/个人号名称或数字 ID、分组名称，并可筛选仅在线或仅空闲就绪的浏览器。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        onlineOnly: {
          type: 'boolean',
          description: '是否只返回当前在线连接的浏览器（默认 false）',
        },
        readyOnly: {
          type: 'boolean',
          description: '是否只返回在线、已同步、无未决命令且未被任务占用的浏览器（默认 false）',
        },
        search: {
          type: 'string',
          description: '按浏览器别名、Facebook 专页/账号名称、Facebook 数字 ID 或分组名模糊匹配',
        },
        accountState: {
          type: 'string',
          enum: ['logged-in', 'logged-out', 'restricted', 'verification', 'unknown'],
          description: '按账号状态过滤',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const onlineOnly = args.onlineOnly === true;
      const readyOnly = args.readyOnly === true;
      const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
      const accountState = typeof args.accountState === 'string' ? args.accountState.trim() : '';

      const [snapshot, allProfiles] = await Promise.all([
        deps.workspaceService.snapshot(),
        buildEnrichedProfiles(deps),
      ]);

      const filtered = allProfiles.filter((p) => {
        if (onlineOnly && !p.online) return false;
        if (readyOnly && !p.readyForTasks) return false;
        if (accountState && p.account.state !== accountState) return false;
        if (search) {
          const hay = [
            p.id,
            p.alias,
            p.browserName ?? '',
            p.displayName,
            p.groupName ?? '',
            p.account.name ?? '',
            p.account.id ?? '',
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });

      return okResult({
        ok: true,
        totalMatched: filtered.length,
        groups: snapshot.groups,
        profiles: filtered,
      });
    },
  };

  const wbInspectProfiles: McpToolDefinition = {
    name: 'wb_inspect_profiles',
    description:
      '对在线闲置的 Chrome 浏览器触发后台只读 Facebook 身份实时检测（绝不关闭用户标签页、不抢窗口焦点），刷新该浏览器当前切换的 Facebook 专页或个人号名称、数字 ID 与本地头像。默认 mode="auto" 先检测已打开的 Facebook 标签页，若浏览器当前未打开 Facebook 页面则自动在后台静默打开临时页读取后立即关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            '指定要检测的浏览器列表（支持传 profileId UUID、浏览器名如 "用户8" 或专页名）；省略时自动检测所有在线闲置浏览器',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'passive', 'active'],
          description:
            'auto（默认）：先读已打开的 Facebook 页，无现成页则后台静默开临时页补读；passive：仅读已打开标签页；active：强制后台静默打开 Facebook 首页核验最新身份',
        },
        timeoutSeconds: {
          type: 'number',
          minimum: 3,
          maximum: 90,
          description: '最长等待检测完成的秒数（默认 35 秒）',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!deps.inspection) {
        return errorResult('INSPECTION_UNAVAILABLE', '账号实时检测服务当前不可用');
      }
      const mode: 'auto' | 'passive' | 'active' =
        args.mode === 'passive' || args.mode === 'active' ? args.mode : 'auto';
      const enrichedBefore = await buildEnrichedProfiles(deps);
      let requestedIds: string[];
      if (Array.isArray(args.profileIds) && args.profileIds.length > 0) {
        const seen = new Set<string>();
        requestedIds = [];
        for (const raw of args.profileIds) {
          const text = String(raw).trim();
          if (!text) continue;
          const resolvedId = resolveProfileIdentifierFromList(enrichedBefore, text);
          if (!seen.has(resolvedId)) {
            seen.add(resolvedId);
            requestedIds.push(resolvedId);
          }
        }
      } else {
        requestedIds = enrichedBefore.filter((p) => p.readyForTasks).map((p) => p.id);
      }

      if (requestedIds.length === 0) {
        return okResult({
          ok: true,
          mode,
          inspectedIds: [],
          message: '当前没有符合条件的在线闲置浏览器可检测',
          profiles: [],
        });
      }

      const totalTimeoutMs = Math.max(3, Math.min(90, Number(args.timeoutSeconds ?? 35))) * 1000;
      const overallDeadline = Date.now() + totalTimeoutMs;
      const inspectionResults: Record<
        string,
        {
          method: 'passive_existing_tab' | 'active_background_tab' | 'skipped';
          ok: boolean;
          reason: string;
        }
      > = {};

      if (mode !== 'active') {
        deps.inspection.request(requestedIds);
        const passiveWaitDeadline = Math.min(overallDeadline, Date.now() + 8_000);
        while (Date.now() < passiveWaitDeadline) {
          const stillPending = requestedIds.some((id) => {
            const row = deps.inspection?.get(id);
            return row !== null && row !== undefined && ['QUEUED', 'READING'].includes(row.state);
          });
          if (!stillPending) break;
          await new Promise<void>((r) => setTimeout(r, 300));
        }
        for (const id of requestedIds) {
          const row = deps.inspection.get(id);
          if (row?.state === 'OBSERVED') {
            inspectionResults[id] = {
              method: 'passive_existing_tab',
              ok: true,
              reason: row.reason || 'OBSERVED',
            };
          } else {
            inspectionResults[id] = {
              method: 'passive_existing_tab',
              ok: false,
              reason: row?.reason || row?.state || 'UNKNOWN',
            };
          }
        }
      }

      const needActiveIds = requestedIds.filter((id) => {
        if (mode === 'passive') return false;
        if (mode === 'active') return true;
        return inspectionResults[id]?.reason === 'INSPECTION_DOCUMENT_NOT_READY';
      });

      const kernel = deps.getMainKernel();
      if (needActiveIds.length > 0 && kernel) {
        for (const id of needActiveIds) {
          const remainingMs = overallDeadline - Date.now();
          if (remainingMs < 2_500) {
            inspectionResults[id] = {
              method: 'skipped',
              ok: false,
              reason: 'INSPECTION_BATCH_TIMEOUT_EXCEEDED',
            };
            continue;
          }
          const peer = deps.core.peers.get(id);
          const busyLabels = await deps.featureExecution.busyModuleLabels([id]);
          const unresolvedRows = await deps.store.unresolved(id);
          if (
            !peer ||
            !peer.online ||
            !peer.synced ||
            peer.phase !== 'PAUSED' ||
            busyLabels.length > 0 ||
            unresolvedRows.length > 0
          ) {
            inspectionResults[id] = {
              method: 'skipped',
              ok: false,
              reason: 'INSPECTION_PROFILE_NOT_IDLE',
            };
            continue;
          }

          const expectedEpoch = peer.epoch;
          const perProfileTimeoutMs = Math.max(5_000, Math.min(22_000, remainingMs));
          const guard = async () => {
            const latestPeer = deps.core.peers.get(id);
            if (
              !latestPeer ||
              !latestPeer.online ||
              latestPeer.epoch !== expectedEpoch ||
              !latestPeer.synced ||
              latestPeer.phase !== 'PAUSED'
            ) {
              throw new Error('INSPECTION_CONNECTION_CHANGED');
            }
          };

          try {
            const reading = await kernel.inspectFacebookAccountSilently(
              peer,
              guard,
              perProfileTimeoutMs,
            );
            inspectionResults[id] = {
              method: 'active_background_tab',
              ok: true,
              reason: reading.actor ? 'OBSERVED_LOGGED_IN' : 'OBSERVED_PAGE',
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isObservedAbnormal =
              errMsg === 'FACEBOOK_ACCOUNT_LOGGED_OUT' ||
              errMsg === 'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED' ||
              errMsg === 'FACEBOOK_ACCOUNT_RESTRICTED';
            inspectionResults[id] = {
              method: 'active_background_tab',
              ok: isObservedAbnormal,
              reason: errMsg,
            };
          }
        }
      }

      const afterAll = await buildEnrichedProfiles(deps);
      const idSet = new Set(requestedIds);
      const updatedProfiles = afterAll.filter((p) => idSet.has(p.id));

      return okResult({
        ok: true,
        mode,
        inspectedIds: requestedIds,
        inspectionResults,
        profiles: updatedProfiles,
      });
    },
  };

  const wbManageTargets: McpToolDefinition = {
    name: 'wb_manage_targets',
    description:
      '管理共享 Facebook 小组库（groups）与目标专页库（pages）：支持搜索查询（list）、批量新增（add，支持直接传链接/数字ID/名称）、删除（delete）、利用闲置浏览器补齐真实名称与本地头像（refresh / stop_refresh）以及查看分类文件夹（list_folders）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'delete', 'refresh', 'stop_refresh', 'list_folders'],
          description: '执行的操作类型',
        },
        kind: {
          type: 'string',
          enum: ['groups', 'pages'],
          description: '目标库类型：groups（共享 Facebook 小组库）或 pages（目标专页库）',
        },
        search: {
          type: 'string',
          description: 'list 时按名称、数字 ID 或 Facebook 链接模糊检索',
        },
        folderId: {
          type: 'string',
          description: 'list 时按文件夹 ID 过滤，或 add 时放入指定文件夹',
        },
        incompleteOnly: {
          type: 'boolean',
          description: 'list 时仅返回尚未补齐数字 ID/真实名称/本地头像的条目',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 500,
          description: 'list 返回的最大条数（默认 200）',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              idOrUrl: { type: 'string', description: 'Facebook 小组/专页链接或数字 ID' },
              name: {
                type: 'string',
                description: '可选备注名称（留空后可通过 refresh 自动抓取真实名称）',
              },
              folderId: { type: 'string' },
            },
            required: ['idOrUrl'],
          },
          description: 'add 时要新增的目标列表',
        },
        rawText: {
          type: 'string',
          description: 'add 时也支持直接粘贴多行链接或 ID（每行一个）',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'delete 或 refresh 时指定的目标 ID 列表（refresh 省略 ids 则自动刷新全部未补齐条目）',
        },
        waitRefreshSeconds: {
          type: 'number',
          minimum: 0,
          maximum: 60,
          description: 'add 或 refresh 触发后台资料抓取后等待多少秒再返回最新状态（默认 5 秒）',
        },
      },
      required: ['action', 'kind'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const action = String(args.action ?? 'list');
      const kind: 'groups' | 'pages' = args.kind === 'pages' ? 'pages' : 'groups';
      const bumper = deps.getGroupBumperService();
      const folders = (await deps.workspaceService.repository.targetFolders?.(kind)) ?? [];

      if (action === 'list_folders') {
        return okResult({ ok: true, kind, folders });
      }

      if (action === 'list') {
        const allItems =
          kind === 'groups'
            ? (await deps.groupPosterService.state()).groups
            : ((await bumper?.state())?.pages ?? []);
        const rawSearch = typeof args.search === 'string' ? args.search.trim() : '';
        const extractedId = rawSearch
          ? kind === 'groups'
            ? extractFacebookGroupId(rawSearch)
            : extractFacebookPageId(rawSearch)
          : '';
        const q = rawSearch.toLowerCase();
        const folderFilter = typeof args.folderId === 'string' ? args.folderId.trim() : '';
        const incompleteOnly = args.incompleteOnly === true;
        const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 200))));

        const matched = allItems.filter((item) => {
          if (folderFilter && (item.folderId ?? '') !== folderFilter) return false;
          if (incompleteOnly && !isTargetIncomplete(item)) return false;
          if (q) {
            const matchId = extractedId && item.id.toLowerCase() === extractedId.toLowerCase();
            const matchText =
              item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
            if (!matchId && !matchText) return false;
          }
          return true;
        });

        return okResult({
          ok: true,
          kind,
          totalInLibrary: allItems.length,
          totalMatched: matched.length,
          folders,
          items: matched.slice(0, limit).map(summarizeTarget),
        });
      }

      const waitMs = Math.max(0, Math.min(60, Number(args.waitRefreshSeconds ?? 5))) * 1000;

      if (action === 'add') {
        const defaultFolderId =
          typeof args.folderId === 'string' && args.folderId.trim()
            ? args.folderId.trim()
            : undefined;
        const parsedItems: Array<{ id: string; name?: string; folderId?: string | null }> = [];

        if (Array.isArray(args.items)) {
          for (const raw of args.items) {
            if (typeof raw !== 'object' || raw === null) continue;
            const rec = raw as Record<string, unknown>;
            const idOrUrl = typeof rec.idOrUrl === 'string' ? rec.idOrUrl.trim() : '';
            if (!idOrUrl) continue;
            const name = typeof rec.name === 'string' ? rec.name.trim() : '';
            const itemFolder =
              typeof rec.folderId === 'string' && rec.folderId.trim()
                ? rec.folderId.trim()
                : defaultFolderId;
            parsedItems.push({
              id: idOrUrl,
              ...(name ? { name } : {}),
              ...(itemFolder !== undefined ? { folderId: itemFolder } : {}),
            });
          }
        }

        if (typeof args.rawText === 'string' && args.rawText.trim()) {
          for (const line of args.rawText.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            parsedItems.push({
              id: trimmed,
              ...(defaultFolderId !== undefined ? { folderId: defaultFolderId } : {}),
            });
          }
        }

        if (parsedItems.length === 0) {
          return errorResult('EMPTY_TARGETS', '请通过 items 或 rawText 提供至少 1 个目标链接或 ID');
        }

        if (kind === 'groups') {
          await deps.groupPosterService.addGroups({ items: parsedItems });
          if (waitMs > 0) {
            const endAt = Date.now() + waitMs;
            while (Date.now() < endAt) {
              const st = await deps.groupPosterService.state();
              if (!st.groupAvatarRefreshing) break;
              await new Promise<void>((r) => setTimeout(r, 400));
            }
          }
          const st = await deps.groupPosterService.state();
          return okResult({
            ok: true,
            kind,
            addedRequestedCount: parsedItems.length,
            refreshing: Boolean(st.groupAvatarRefreshing),
            statusText: st.statusText,
            totalInLibrary: st.groups.length,
            items: st.groups.slice(0, 200).map(summarizeTarget),
          });
        }

        if (!bumper) {
          return errorResult('BUMPER_UNAVAILABLE', '专页顶贴目标库服务未加载');
        }
        await bumper.manage('pages/add', { items: parsedItems });
        if (waitMs > 0) {
          const endAt = Date.now() + waitMs;
          while (Date.now() < endAt) {
            const st = await bumper.state();
            if (!st.metadataRefreshing && !st.pageAvatarRefreshing) break;
            await new Promise<void>((r) => setTimeout(r, 400));
          }
        }
        const st = await bumper.state();
        return okResult({
          ok: true,
          kind,
          addedRequestedCount: parsedItems.length,
          refreshing: Boolean(st.metadataRefreshing || st.pageAvatarRefreshing),
          statusText: st.pageBumperStatusText,
          totalInLibrary: st.pages.length,
          items: st.pages.slice(0, 200).map(summarizeTarget),
        });
      }

      if (action === 'delete') {
        const ids = Array.isArray(args.ids)
          ? args.ids.map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (ids.length === 0) {
          return errorResult('IDS_REQUIRED', 'delete 操作必须提供要删除的 ids 数组');
        }
        if (kind === 'groups') {
          const st = await deps.groupPosterService.deleteGroups({ ids });
          return okResult({
            ok: true,
            kind,
            deletedRequestedIds: ids,
            remainingCount: st.groups.length,
          });
        }
        if (!bumper) {
          return errorResult('BUMPER_UNAVAILABLE', '专页库服务未加载');
        }
        const st = await bumper.manage('pages/delete', { ids });
        return okResult({
          ok: true,
          kind,
          deletedRequestedIds: ids,
          remainingCount: st.pages.length,
        });
      }

      if (action === 'refresh') {
        const ids = Array.isArray(args.ids)
          ? args.ids.map((x) => String(x).trim()).filter(Boolean)
          : undefined;
        if (kind === 'groups') {
          await deps.groupPosterService.refreshGroups(ids && ids.length > 0 ? { ids } : {});
          if (waitMs > 0) {
            const endAt = Date.now() + waitMs;
            while (Date.now() < endAt) {
              const st = await deps.groupPosterService.state();
              if (!st.groupAvatarRefreshing) break;
              await new Promise<void>((r) => setTimeout(r, 400));
            }
          }
          const st = await deps.groupPosterService.state();
          return okResult({
            ok: true,
            kind,
            refreshing: Boolean(st.groupAvatarRefreshing),
            statusText: st.statusText,
            incompleteCount: st.groups.filter(isTargetIncomplete).length,
            items: st.groups.slice(0, 200).map(summarizeTarget),
          });
        }
        if (!bumper) {
          return errorResult('BUMPER_UNAVAILABLE', '专页库服务未加载');
        }
        await bumper.manage('pages/refresh', ids && ids.length > 0 ? { ids } : {});
        if (waitMs > 0) {
          const endAt = Date.now() + waitMs;
          while (Date.now() < endAt) {
            const st = await bumper.state();
            if (!st.metadataRefreshing && !st.pageAvatarRefreshing) break;
            await new Promise<void>((r) => setTimeout(r, 400));
          }
        }
        const st = await bumper.state();
        return okResult({
          ok: true,
          kind,
          refreshing: Boolean(st.metadataRefreshing || st.pageAvatarRefreshing),
          statusText: st.pageBumperStatusText,
          incompleteCount: st.pages.filter(isTargetIncomplete).length,
          items: st.pages.slice(0, 200).map(summarizeTarget),
        });
      }

      if (action === 'stop_refresh') {
        if (kind === 'groups') {
          const st = await deps.groupPosterService.stopRefreshGroups();
          return okResult({ ok: true, kind, statusText: st.statusText });
        }
        if (!bumper) {
          return errorResult('BUMPER_UNAVAILABLE', '专页库服务未加载');
        }
        const st = await bumper.manage('pages/refresh-stop', {});
        return okResult({ ok: true, kind, statusText: st.pageBumperStatusText });
      }

      return errorResult('UNKNOWN_ACTION', `未知操作: ${action}`);
    },
  };

  const wbReadTable: McpToolDefinition = {
    name: 'wb_read_table',
    description:
      '直接读取本地发帖排期表/资源表文件（原生支持 .xlsx Excel 工作簿、.csv、.tsv、.json、.jsonl，无需安装 Python）。返回所有工作表名、表头列名与结构化行记录（含原始行号 _rowNumber），适合“按照表格里的专页和小组几点开始发帖”场景。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '本地表格文件的绝对路径（支持 .xlsx / .csv / .tsv / .json / .jsonl）',
        },
        sheet: {
          type: ['string', 'number'],
          description: 'Excel 工作表名称或从 0 开始的索引（默认读取第 1 个工作表）',
        },
        hasHeader: {
          type: 'boolean',
          description: '首行是否为列名表头（默认 true）',
        },
        offset: {
          type: 'number',
          minimum: 0,
          description: '分页起始行偏移（默认 0）',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          description: '本次最多返回的数据行数（默认 200，最大 1000）',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      if (!filePath) {
        return errorResult('FILE_PATH_REQUIRED', '必须提供本地表格文件路径 filePath');
      }
      const sheet =
        typeof args.sheet === 'string' || typeof args.sheet === 'number' ? args.sheet : undefined;
      const hasHeader = typeof args.hasHeader === 'boolean' ? args.hasHeader : true;
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : 200;

      const table = await readSpreadsheetOrTableFile(filePath, {
        sheet,
        hasHeader,
        offset,
        limit,
      });
      return okResult({
        ok: true,
        ...table,
      });
    },
  };

  return [wbGetOverview, wbListProfiles, wbInspectProfiles, wbManageTargets, wbReadTable];
}
