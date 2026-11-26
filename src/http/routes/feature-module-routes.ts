import { z } from 'zod';
import type { AutoSchedulerService } from '../../application/auto-scheduler-service.js';
import type { BluestacksService } from '../../application/bluestacks-service.js';
import type { DataCleanupService } from '../../application/data-cleanup.js';
import {
  ensureFeatureExecutionRegistry,
  type FeatureExecutionRegistry,
} from '../../application/feature-execution-registry.js';
import type { GoogleSheetsService } from '../../application/google-sheets-service.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import type { ProfileInspectionService } from '../../application/profile-inspection.js';
import type { TaskService } from '../../application/task-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import { ProductError } from '../../domain/workspace.js';
import { someAsync } from '../../shared/async-collections.js';
import {
  CleanupProfileTabsRequest,
  CleanupProfileTabsResult,
  ShowBrowserRequest,
  ShowBrowserResult,
  type BrowserWindowPort,
} from '../../shared/browser-window.js';
import {
  DeleteProfiles,
  Id,
  StopProfiles,
  obj,
  profileDisplayName,
  sReq,
  strictObj,
  trimReq,
} from '../../shared/contracts.js';
import {
  INSPECTION_DISPLAY_HEADER,
  InspectProfiles,
  inspectionResponse,
} from '../../shared/profile-inspection.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import { TargetListCommand, TargetListKind } from '../../shared/target-list.js';
import { needSvc, type RouteBase } from '../task-contract-version.js';
interface FeatureModuleRouteContext extends RouteBase {
  service: WorkspaceService;
  tasks?: TaskService | undefined;
  inspection?: ProfileInspectionService | undefined;
  browserWindows?: BrowserWindowPort | undefined;
  cleanup?: DataCleanupService | undefined;
  groupInviter?: GroupInviterService | undefined;
  groupBumper?: GroupBumperService | undefined;
  groupPoster?: GroupPosterService | undefined;
  bluestacks?: BluestacksService | undefined;
  autoScheduler?: AutoSchedulerService | undefined;
  googleSheets?: GoogleSheetsService | undefined;
  profileLifecycle?: ProfileLifecyclePort | undefined;
  featureExecution?: FeatureExecutionRegistry | undefined;
}
const LinkIdInput = strictObj({ id: sReq(120) });
const ImportLibraryInput = strictObj({
  id: sReq(120),
  mode: z.enum(['incremental', 'overwrite']).default('incremental'),
});
const ThumbnailInput = strictObj({
  id: trimReq(120),
  thumbnailDataUrl: trimReq(128 * 1024).regex(
    /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/i,
  ),
});
const OptionalProfileIds = strictObj({ profileIds: z.array(Id).min(1).max(500).optional() });
export async function handleFeatureModuleRoutes(ctx: FeatureModuleRouteContext): Promise<boolean> {
  const {
    req,
    res,
    route,
    input,
    json,
    service,
    cleanup,
    groupBumper,
    groupInviter,
    groupPoster,
    bluestacks,
    autoScheduler,
    googleSheets: gs,
  } = ctx;
  const ok = (body: unknown, status = 200) => (json(res, status, body), true),
    queryUrl = () => new URL(req.url ?? '/', 'http://localhost'),
    parseBefore = (u: URL) => {
      const b = u.searchParams.get('before');
      return b ? z.coerce.number().finite().nonnegative().parse(b) : undefined;
    },
    postDispatch = async (
      action: string,
      handlers: Record<string, (() => Promise<unknown>) | undefined>,
      missingErr?: () => never,
    ) => {
      if (req.method !== 'POST') return false;
      cleanup?.assertNotResetting();
      const fn = handlers[action];
      return fn ? ok(await fn()) : missingErr ? missingErr() : false;
    },
    mapInput = <T extends object>(
      svc: T,
      routes: Record<string, keyof T>,
    ): Record<string, () => Promise<unknown>> =>
      Object.fromEntries(
        Object.entries(routes).map(([k, m]) => [
          k,
          () => (svc[m] as (v: unknown) => Promise<unknown>)(input),
        ]),
      );
  if (
    autoScheduler &&
    (route === '/api/workspace/auto-scheduler' ||
      route.startsWith('/api/workspace/auto-scheduler/'))
  ) {
    const action =
      route === '/api/workspace/auto-scheduler'
        ? ''
        : route.slice('/api/workspace/auto-scheduler/'.length);
    if (req.method === 'GET' && (action === '' || action === 'state'))
      return ok(await autoScheduler.state());
    return postDispatch(action, {
      ...mapInput(autoScheduler, {
        settings: 'saveSettings',
        'schedules/save': 'saveSchedule',
        'schedules/toggle': 'toggleSchedule',
        'schedules/duplicate': 'duplicateSchedule',
        'schedules/delete': 'deleteSchedule',
        'run-now': 'runNow',
        stop: 'stop',
      }),
      'clear-history': () => autoScheduler.clearHistory(),
    });
  }
  if (bluestacks && route.startsWith('/api/workspace/bluestacks/')) {
    const action = route.slice('/api/workspace/bluestacks/'.length);
    if (req.method === 'GET' && action === 'state')
      return ok(await bluestacks.state(queryUrl().searchParams.get('refresh') === '1'));
    const stopIds = () => bluestacks.parseStopInput(input);
    return postDispatch(action, {
      ...mapInput(bluestacks, {
        paths: 'updatePaths',
        settings: 'saveBumperSettings',
        'page-settings': 'savePageBumperSettings',
        'risk-limits': 'saveRiskLimitSettings',
        'folders/create': 'createFolder',
        'folders/rename': 'renameFolder',
        'folders/delete': 'deleteFolder',
        'folders/reorder': 'reorderFolders',
        'instances/rename': 'renameInstance',
        'instances/reorder': 'reorderInstances',
        'instances/delete': 'deleteInstances',
        'instances/launch': 'launchInstances',
        'instances/close': 'closeInstances',
        'instances/inspect': 'inspectInstances',
        'instances/show': 'showInstance',
        'instances/arrange': 'arrangeWindows',
        'instances/install-apk': 'installApk',
        'instances/switch-identity': 'switchIdentity',
        'instances/login': 'loginInstance',
        'batch-login/start': 'startBatchLogin',
        'health-check/start': 'startHealthCheck',
        'bumper/start': 'startBumper',
        'bumper/start-page': 'startPageBumper',
        'active/start': 'startActive',
        'poster/start': 'startPoster',
        'inviter/start': 'startInviter',
      }),
      refresh: () => bluestacks.state(true),
      'batch-login/stop': () => bluestacks.stopBatchLogin(),
      'health-check/stop': () => bluestacks.stopHealthCheck(),
      'bumper/stop': () => {
        const ids = stopIds();
        return bluestacks.stopBumper(ids, ids ? undefined : 'group');
      },
      'bumper/stop-page': () => bluestacks.stopBumper(stopIds(), 'page'),
      'active/stop': () => bluestacks.stopExtra('active', stopIds()),
      'poster/stop': () => bluestacks.stopExtra('poster', stopIds()),
      'inviter/stop': () => bluestacks.stopExtra('inviter', stopIds()),
      'stop-all': () => bluestacks.stopAllForInstances(stopIds()),
    });
  }
  if (gs && route.startsWith('/api/workspace/google-sheets')) {
    if (req.method === 'GET') {
      if (route === '/api/workspace/google-sheets') return ok(await gs.overview());
      if (route === '/api/workspace/google-sheets/image-host/tokens')
        return ok(await gs.getEditableGyazoTokens());
      if (route === '/api/workspace/google-sheets/links/grid') {
        const u = new URL(req.url ?? route, 'http://127.0.0.1'),
          { id } = LinkIdInput.parse({ id: u.searchParams.get('id') ?? '' });
        return ok(
          await gs.readGrid(id, {
            force: u.searchParams.get('force') === '1' || u.searchParams.get('force') === 'true',
          }),
        );
      }
      return false;
    }
    const byId = (fn: (id: string) => Promise<unknown>) => fn(LinkIdInput.parse(input).id),
      mapById = (
        routes: Record<
          string,
          keyof Pick<
            typeof gs,
            | 'deleteLink'
            | 'syncLibraryToSheet'
            | 'triggerSchedulePoll'
            | 'triggerRecordsPoll'
            | 'refreshRecordMetrics'
          >
        >,
      ) =>
        Object.fromEntries(
          Object.entries(routes).map(([k, m]) => [k, () => byId((id) => gs[m](id))]),
        );
    return postDispatch(route.slice('/api/workspace/google-sheets'.length), {
      ...mapInput(gs, {
        '/image-host': 'saveImageHostConfig',
        '/links/create': 'createLink',
        '/links/update': 'updateLink',
      }),
      ...mapById({
        '/links/delete': 'deleteLink',
        '/links/sync-library': 'syncLibraryToSheet',
        '/links/poll-schedule': 'triggerSchedulePoll',
        '/links/poll-records': 'triggerRecordsPoll',
        '/links/refresh-metrics': 'refreshRecordMetrics',
      }),
      '/auth/credentials': () =>
        gs.importCredentials(obj({ rawJson: sReq(200_000, 10) }).parse(input).rawJson),
      '/auth/start': () => gs.startAuth(),
      '/auth/manual': () =>
        gs.completeManualAuth(obj({ codeOrUrl: sReq(4000, 3) }).parse(input).codeOrUrl),
      '/auth/revoke': () => gs.revokeAuth(),
      '/image-host/test': () => gs.testImageHost(),
      '/inspect': () =>
        gs.inspectSpreadsheet(obj({ urlOrId: sReq(2000, 10) }).parse(input).urlOrId),
      '/links/import-library': () => {
        const p = ImportLibraryInput.parse(input);
        return gs.importLibraryFromSheet(p.id, p.mode);
      },
      '/links/stop': async () => (await byId((id) => gs.stopLinkWork(id)), { stopped: true }),
      '/stop-profiles': async () => (
        await gs.stopProfiles(
          obj({ profileIds: z.array(sReq(120)).min(1).max(500) }).parse(input).profileIds,
        ),
        gs.overview()
      ),
    });
  }
  if (groupPoster && route.startsWith('/api/workspace/group-poster/')) {
    const action = route.slice('/api/workspace/group-poster/'.length);
    if (req.method === 'GET') {
      const sp = queryUrl().searchParams;
      if (action === 'state') return ok(await groupPoster.state());
      if (action === 'logs')
        return ok(
          await groupPoster.logs(
            sp.get('search') ?? '',
            parseBefore(queryUrl()),
            sp.get('beforeId') ?? undefined,
            sp.get('materialId') ?? undefined,
          ),
        );
      if (action === 'materials/thumbnail' || action === 'materials/media') {
        const id = (sp.get('id') ?? '').trim();
        if (!id || id.length > 120)
          return ok(
            {
              code: action.endsWith('thumbnail')
                ? 'POSTER_THUMBNAIL_ID_INVALID'
                : 'POSTER_MEDIA_ID_INVALID',
              error: '素材 ID 无效',
            },
            400,
          );
        const send404 = () => (
          res.writeHead(404, { 'Cache-Control': 'no-store' }),
          res.end(),
          true
        );
        if (action === 'materials/thumbnail') {
          const dataUrl = (await groupPoster.getMaterialThumbnail(id))?.thumbnailDataUrl;
          const m =
            dataUrl &&
            /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
          if (!m?.[1] || !m[2]) return send404();
          const bytes = Buffer.from(m[2], 'base64');
          res.writeHead(200, {
            'Content-Type': m[1].toLowerCase(),
            'Content-Length': bytes.byteLength,
            'Cache-Control': 'private, max-age=86400, immutable',
          });
          res.end(bytes);
          return true;
        }
        const chunk = await groupPoster.streamMaterialMedia(
          id,
          typeof req.headers.range === 'string' ? req.headers.range : undefined,
        );
        if (!chunk) return send404();
        res.writeHead(chunk.status, chunk.headers);
        res.end(chunk.bytes);
        return true;
      }
      return false;
    }
    return postDispatch(
      action,
      {
        ...mapInput(groupPoster, {
          settings: 'saveSettings',
          'groups/add': 'addGroups',
          'groups/delete': 'deleteGroups',
          'groups/refresh': 'refreshGroups',
          'materials/save': 'saveMaterials',
          'materials/delete': 'deleteMaterials',
          'tasks/create': 'createTask',
          'tasks/cancel': 'cancelTask',
          'tasks/delete': 'deleteTask',
          'logs/delete': 'deleteLogs',
        }),
        'groups/refresh-stop': () => groupPoster.stopRefreshGroups(),
        'materials/thumbnail': async () => {
          const t = ThumbnailInput.parse(input);
          return { saved: await groupPoster.saveMaterialThumbnail(t.id, t.thumbnailDataUrl) };
        },
        stop: async () => {
          const p = OptionalProfileIds.parse(input ?? {});
          if (p.profileIds?.length) {
            await groupPoster.stopProfiles(p.profileIds);
            return groupPoster.state();
          }
          return groupPoster.stop();
        },
      },
      () => {
        throw new ProductError('POSTER_ACTION_UNKNOWN', `未知小组发帖操作: ${action}`, 404);
      },
    );
  }
  if (req.method === 'GET') {
    const sp = queryUrl().searchParams,
      before = parseBefore(queryUrl()),
      beforeId = sp.get('beforeId') ?? undefined,
      getMap: Record<string, (() => Promise<unknown>) | undefined> = {
        '/api/workspace/runtime-summary': async () => {
          const activeModules = new Set(
            await ensureFeatureExecutionRegistry(ctx.featureExecution, {
              tasks: ctx.tasks,
              groupInviter,
              groupBumper,
              groupPoster,
              bluestacks,
            }).activeModuleIds(),
          );
          if (gs?.hasActiveExecution()) activeModules.add('google-sheets');
          if (!activeModules.has('auto-scheduler') && (await autoScheduler?.state?.())?.running)
            activeModules.add('auto-scheduler');
          return { activeModules: [...activeModules], timestamp: Date.now() };
        },
        '/api/workspace/target-lists/folders': async () =>
          (await service.repository.targetFolders?.(TargetListKind.parse(sp.get('listKind')))) ??
          [],
        '/api/workspace/group-bumper/state': groupBumper ? () => groupBumper.state() : undefined,
        '/api/workspace/group-bumper/logs': groupBumper
          ? async () => {
              const rm = sp.get('sourceMode'),
                rc = sp.get('carrier');
              return groupBumper.logs(
                sp.get('search') ?? '',
                before,
                beforeId,
                200,
                rm === 'group' || rm === 'page' ? rm : undefined,
                rc === 'chrome' || rc === 'bluestacks' ? rc : undefined,
              );
            }
          : undefined,
        '/api/workspace/group-inviter/state': groupInviter ? () => groupInviter.state() : undefined,
        '/api/workspace/group-inviter/logs': groupInviter
          ? async () => groupInviter.logs(sp.get('search') ?? '', before, 200, beforeId)
          : undefined,
        '/api/workspace/profiles/inspection': ctx.inspection
          ? async () =>
              inspectionResponse(
                {
                  results: (await service.snapshot()).profiles.flatMap((p) => {
                    const r = ctx.inspection?.get(p.id);
                    return r ? [r] : [];
                  }),
                },
                req.headers[INSPECTION_DISPLAY_HEADER],
              )
          : undefined,
      },
      fn = getMap[route];
    return fn ? ok(await fn()) : false;
  }
  if (req.method !== 'POST') return false;
  if (route === '/api/workspace/target-lists/command') {
    cleanup?.assertNotResetting();
    await service.repository.targetListCommand?.(TargetListCommand.parse(input));
    return ok({ saved: true });
  }
  if (route.startsWith('/api/workspace/group-bumper/') && groupBumper) {
    const sub = route.slice('/api/workspace/group-bumper/'.length);
    return (
      postDispatch(sub, {
        'scan-only': () => groupBumper.startScanOnly(input),
        start: () => groupBumper.start(input),
        'start-page': () => groupBumper.startPageBumper(input),
        stop: () => {
          const { profileIds } = OptionalProfileIds.parse(input);
          return groupBumper.stop(profileIds, profileIds ? undefined : 'group-bumper');
        },
        'stop-page': () =>
          groupBumper.stop(OptionalProfileIds.parse(input).profileIds, 'page-bumper'),
      }) || (cleanup?.assertNotResetting(), ok(await groupBumper.manage(sub, input)))
    );
  }
  if (groupInviter && route.startsWith('/api/workspace/group-inviter/')) {
    return postDispatch(route.slice('/api/workspace/group-inviter/'.length), {
      ...mapInput(groupInviter, {
        'groups/add': 'addGroups',
        'groups/delete': 'deleteGroups',
        settings: 'updateSettings',
        start: 'start',
        'stop-profiles': 'stopProfiles',
      }),
      'groups/refresh': () =>
        groupInviter.refreshGroups(
          obj({ ids: z.array(sReq(120)).max(500).optional() }).parse(input ?? {}).ids,
        ),
      'groups/refresh-stop': () => groupInviter.stopRefreshGroups(),
      stop: () => groupInviter.stop(),
    });
  }
  const needLifecycle = () =>
    needSvc(ctx.profileLifecycle, 'PROFILE_LIFECYCLE_UNAVAILABLE', '浏览器生命周期控制尚未加载');
  const postProfileIds = async () => {
    const { profileIds } = StopProfiles.parse(input);
    await service.requireProfiles(profileIds);
    return [...new Set(profileIds)];
  };
  if (route === '/api/workspace/profiles/inspect') {
    cleanup?.assertNotResetting();
    const svc = needSvc(ctx.inspection, 'INSPECTION_UNAVAILABLE', '资料检查服务未启用'),
      { profileIds } = InspectProfiles.parse(input);
    await service.requireProfiles(profileIds);
    return ok(
      inspectionResponse(
        { results: svc.request(profileIds) },
        req.headers[INSPECTION_DISPLAY_HEADER],
      ),
      202,
    );
  }
  return postDispatch(route, {
    '/api/workspace/profiles/show': async () => {
      const { profileId } = ShowBrowserRequest.parse(input);
      await service.requireProfiles([profileId]);
      const profile = (await service.snapshot()).profiles.find((r) => r.id === profileId);
      if (!ctx.browserWindows || !profile)
        throw new ProductError('BROWSER_SHOW_UNAVAILABLE', '浏览器显示功能尚未加载', 409);
      return ShowBrowserResult.parse(
        await ctx.browserWindows.show(profileId, profileDisplayName(profile)),
      );
    },
    '/api/workspace/profiles/launch': async () =>
      needLifecycle().ensureProfilesOnline(await postProfileIds()),
    '/api/workspace/profiles/close': async () => {
      const lifecycle = needLifecycle(),
        uniqueIds = await postProfileIds();
      const items = await Promise.all(
        uniqueIds.map((id) => lifecycle.closeProfile(id, { stopTasksFirst: true })),
      );
      return {
        requestedIds: uniqueIds,
        closedIds: items.filter((i) => i.ok).map((i) => i.profileId),
        failed: items
          .filter((i) => !i.ok)
          .map((i) => ({
            profileId: i.profileId,
            errorCode: i.errorCode ?? 'CLOSE_FAILED',
            reason: i.reason ?? '关闭浏览器失败',
          })),
        items,
      };
    },
    '/api/workspace/profiles/cleanup-tabs': async () => {
      const { profileIds, preferActiveTab } = CleanupProfileTabsRequest.parse(input);
      await service.requireProfiles(profileIds);
      if (!ctx.browserWindows?.cleanupTabs)
        throw new ProductError('WORKSPACE_CLEANUP_UNAVAILABLE', '浏览器标签清理功能尚未加载', 409);
      return CleanupProfileTabsResult.parse(
        await ctx.browserWindows.cleanupTabs(profileIds, preferActiveTab ?? false),
      );
    },
    '/api/workspace/profiles/delete': async () => {
      const value = DeleteProfiles.parse(input),
        busy = ctx.featureExecution
          ? await ctx.featureExecution.busyModuleLabels(value.profileIds)
          : [];
      if (busy.length > 0)
        throw new ProductError(
          'PROFILE_TASK_ACTIVE',
          `请先停止该浏览器的运行任务（${busy.join('、')}）后再删除`,
          409,
        );
      if (
        await someAsync(
          value.profileIds,
          async (id) => await ctx.tasks?.hasProfilePlanInStates(id, ['QUEUED', 'RUNNING']),
        )
      )
        throw new ProductError('PROFILE_TASK_ACTIVE', '请先停止该浏览器的运行任务后再删除', 409);
      return { deleted: true, ...(await service.deleteProfiles(value.profileIds)) };
    },
  });
}
