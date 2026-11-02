import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DataCleanupService } from '../../application/data-cleanup.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import type { NativeReviewService } from '../../application/native-review.js';
import type { ProfileInspectionService } from '../../application/profile-inspection.js';
import type { TaskService } from '../../application/task-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import { ProductError } from '../../domain/workspace.js';
import { someAsync } from '../../shared/async-collections.js';
import {
  CleanupProfileTabsRequest,
  CleanupProfileTabsResult,
  ConsolidateBrowserRequest,
  ConsolidateBrowserResult,
  ShowBrowserRequest,
  ShowBrowserResult,
  type BrowserWindowPort,
} from '../../shared/browser-window.js';
import { DeleteProfiles, StopProfiles, StopResultsSchema } from '../../shared/contracts.js';
import { NativeReviewRequest, NATIVE_REVIEW_CONTRACT_HEADER } from '../../shared/native-review.js';
import {
  INSPECTION_DISPLAY_HEADER,
  InspectProfiles,
  inspectionResponse,
} from '../../shared/profile-inspection.js';
import { TargetListCommand, TargetListKind } from '../../shared/target-list.js';

export interface FeatureModuleRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  service: WorkspaceService;
  tasks?: TaskService | undefined;
  inspection?: ProfileInspectionService | undefined;
  nativeReview?: NativeReviewService | undefined;
  browserWindows?: BrowserWindowPort | undefined;
  cleanup?: DataCleanupService | undefined;
  groupInviter?: GroupInviterService | undefined;
  groupBumper?: GroupBumperService | undefined;
  featureExecution?: FeatureExecutionRegistry | undefined;
}

export async function handleFeatureModuleRoutes(ctx: FeatureModuleRouteContext): Promise<boolean> {
  const {
    req,
    res,
    route,
    input,
    json,
    service,
    tasks,
    inspection,
    nativeReview,
    browserWindows,
    cleanup,
    groupInviter,
    groupBumper,
    featureExecution,
  } = ctx;

  if (route === '/api/workspace/target-lists/folders' && req.method === 'GET') {
    const kind = TargetListKind.parse(
      new URL(req.url ?? '', 'http://localhost').searchParams.get('listKind'),
    );
    json(res, 200, (await service.repository.targetFolders?.(kind)) ?? []);
    return true;
  }
  if (route === '/api/workspace/target-lists/command' && req.method === 'POST') {
    cleanup?.assertNotResetting();
    await service.repository.targetListCommand?.(TargetListCommand.parse(input));
    json(res, 200, { saved: true });
    return true;
  }

  if (route.startsWith('/api/workspace/group-bumper/') && groupBumper) {
    const action = route.slice('/api/workspace/group-bumper/'.length);
    if (req.method === 'GET' && action === 'state') {
      json(res, 200, await groupBumper.state());
      return true;
    }
    if (req.method === 'GET' && action === 'logs') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const before = url.searchParams.get('before');
      json(
        res,
        200,
        await groupBumper.logs(
          url.searchParams.get('search') ?? '',
          before ? z.coerce.number().finite().nonnegative().parse(before) : undefined,
          url.searchParams.get('beforeId') ?? undefined,
        ),
      );
      return true;
    }
    if (req.method === 'POST') {
      cleanup?.assertNotResetting();
      json(
        res,
        200,
        action === 'scan-only'
          ? await groupBumper.startScanOnly(input)
          : action === 'start'
            ? await groupBumper.start(input)
            : action === 'start-page'
              ? await groupBumper.startPageBumper(input)
              : action === 'stop' || action === 'stop-page'
                ? await (() => {
                    const { profileIds } = z
                      .object({
                        profileIds: z.array(z.string().uuid()).min(1).max(500).optional(),
                      })
                      .strict()
                      .parse(input);
                    // 指定浏览器时按 ID 精确停止；「停止全部」只停对应模块（小组/专页）的浏览器
                    return groupBumper.stop(
                      profileIds,
                      action === 'stop-page'
                        ? 'page-bumper'
                        : profileIds
                          ? undefined
                          : 'group-bumper',
                    );
                  })()
                : await groupBumper.manage(action, input),
      );
      return true;
    }
  }

  if (req.method === 'GET' && route === '/api/workspace/group-inviter/state' && groupInviter) {
    json(res, 200, await groupInviter.state());
    return true;
  }
  if (req.method === 'GET' && route === '/api/workspace/group-inviter/logs' && groupInviter) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const before = url.searchParams.get('before');
    json(
      res,
      200,
      await groupInviter.logs(
        url.searchParams.get('search') ?? '',
        before ? z.coerce.number().finite().nonnegative().parse(before) : undefined,
        200,
      ),
    );
    return true;
  }
  if (
    req.method === 'POST' &&
    route === '/api/workspace/group-inviter/groups/add' &&
    groupInviter
  ) {
    cleanup?.assertNotResetting();
    json(res, 200, await groupInviter.addGroups(input));
    return true;
  }
  if (
    req.method === 'POST' &&
    route === '/api/workspace/group-inviter/groups/delete' &&
    groupInviter
  ) {
    cleanup?.assertNotResetting();
    json(res, 200, await groupInviter.deleteGroups(input));
    return true;
  }
  if (req.method === 'POST' && route === '/api/workspace/group-inviter/settings' && groupInviter) {
    cleanup?.assertNotResetting();
    json(res, 200, await groupInviter.updateSettings(input));
    return true;
  }
  if (req.method === 'POST' && route === '/api/workspace/group-inviter/start' && groupInviter) {
    cleanup?.assertNotResetting();
    json(res, 200, await groupInviter.start(input));
    return true;
  }
  if (req.method === 'POST' && route === '/api/workspace/group-inviter/stop' && groupInviter) {
    cleanup?.assertNotResetting();
    json(res, 200, await groupInviter.stop());
    return true;
  }
  if (
    req.method === 'POST' &&
    route === '/api/workspace/group-inviter/stop-profiles' &&
    groupInviter
  ) {
    cleanup?.assertNotResetting();
    json(res, 200, await groupInviter.stopProfiles(input));
    return true;
  }

  if (req.method === 'GET' && route === '/api/workspace/profiles/inspection' && inspection) {
    json(
      res,
      200,
      inspectionResponse(
        {
          results: (await service.snapshot()).profiles.flatMap((profile) => {
            const row = inspection.get(profile.id);
            return row ? [row] : [];
          }),
        },
        req.headers[INSPECTION_DISPLAY_HEADER],
      ),
    );
    return true;
  }

  if (req.method !== 'POST') return false;

  switch (route) {
    case '/api/workspace/profiles/inspect': {
      cleanup?.assertNotResetting();
      if (!inspection) throw new ProductError('INSPECTION_UNAVAILABLE', '资料检查服务未启用', 409);
      const value = InspectProfiles.parse(input);
      await service.requireProfiles(value.profileIds);
      json(
        res,
        202,
        inspectionResponse(
          { results: inspection.request(value.profileIds) },
          req.headers[INSPECTION_DISPLAY_HEADER],
        ),
      );
      return true;
    }
    case '/api/workspace/profiles/show': {
      cleanup?.assertNotResetting();
      const { profileId } = ShowBrowserRequest.parse(input);
      await service.requireProfiles([profileId]);
      const profile = (await service.snapshot()).profiles.find((row) => row.id === profileId);
      if (!browserWindows || !profile)
        throw new ProductError('BROWSER_SHOW_UNAVAILABLE', '浏览器显示功能尚未加载', 409);
      json(res, 200, ShowBrowserResult.parse(await browserWindows.show(profileId, profile.alias)));
      return true;
    }
    case '/api/workspace/profiles/consolidate-tabs': {
      cleanup?.assertNotResetting();
      const { profileId, preferActiveTab } = ConsolidateBrowserRequest.parse(input);
      await service.requireProfiles([profileId]);
      if (!browserWindows?.consolidate)
        throw new ProductError('WORKSPACE_CLEANUP_UNAVAILABLE', '浏览器标签清理功能尚未加载', 409);
      json(
        res,
        200,
        ConsolidateBrowserResult.parse(
          await browserWindows.consolidate(profileId, preferActiveTab ?? true),
        ),
      );
      return true;
    }
    case '/api/workspace/profiles/cleanup-tabs': {
      cleanup?.assertNotResetting();
      const { profileIds, preferActiveTab } = CleanupProfileTabsRequest.parse(input);
      await service.requireProfiles(profileIds);
      if (!browserWindows?.cleanupTabs)
        throw new ProductError('WORKSPACE_CLEANUP_UNAVAILABLE', '浏览器标签清理功能尚未加载', 409);
      json(
        res,
        200,
        CleanupProfileTabsResult.parse(
          await browserWindows.cleanupTabs(profileIds, preferActiveTab ?? false),
        ),
      );
      return true;
    }
    case '/api/workspace/profiles/release-idle-pages': {
      cleanup?.assertNotResetting();
      if (!nativeReview)
        throw new ProductError('NATIVE_RELEASE_UNAVAILABLE', '浏览器占用处理服务尚未加载', 409);
      const value = NativeReviewRequest.parse(input);
      await service.requireProfiles([value.profileId]);
      json(res, 200, await nativeReview.releaseIdle(value));
      return true;
    }
    case '/api/workspace/profiles/native-review': {
      cleanup?.assertNotResetting();
      if (!nativeReview)
        throw new ProductError('NATIVE_REVIEW_UNAVAILABLE', '任务诊断服务未启用', 409);
      const value = NativeReviewRequest.parse(input);
      await service.requireProfiles([value.profileId]);
      const contract = req.headers[NATIVE_REVIEW_CONTRACT_HEADER];
      if (contract !== undefined && contract !== '1' && contract !== '2')
        throw new ProductError('NATIVE_REVIEW_VERSION_UNSUPPORTED', '请更新任务诊断界面', 409);
      json(
        res,
        200,
        contract === '2' ? await nativeReview.read(value, '2') : await nativeReview.read(value),
      );
      return true;
    }
    case '/api/workspace/profiles/stop': {
      cleanup?.assertNotResetting();
      const value = StopProfiles.parse(input);
      await service.requireProfiles(value.profileIds);
      const results = await Promise.all(
        [...new Set(value.profileIds)].map(async (profileId) => {
          inspection?.invalidate(profileId);
          try {
            if (
              featureExecution &&
              (await featureExecution.stopProfilesAcrossModules([profileId]))
            ) {
              return { profileId, requested: true as const };
            }
            const inviterRunning =
              groupInviter?.isProfileRunning(profileId) === true ||
              groupBumper?.isProfileRunning(profileId) === true;
            if (inviterRunning) {
              await groupInviter?.stopProfiles({ profileIds: [profileId] });
              if (groupBumper?.isProfileRunning(profileId)) await groupBumper.stop([profileId]);
            }
            if (await tasks?.stopActiveProfile(profileId))
              return { profileId, requested: true as const };
            if (inviterRunning) return { profileId, requested: true as const };
            const result = (await service.stopProfiles([profileId]))[0];
            if (!result) throw Error('停止结果缺失，请重新读取任务状态');
            return result;
          } catch (error) {
            return {
              profileId,
              requested: false as const,
              reason: error instanceof Error ? error.message : '停止失败',
            };
          }
        }),
      );
      json(res, 200, StopResultsSchema.parse({ results }));
      return true;
    }
    case '/api/workspace/profiles/delete': {
      cleanup?.assertNotResetting();
      const value = DeleteProfiles.parse(input);
      const activePlan = await someAsync(
        value.profileIds,
        async (profileId) =>
          await tasks?.hasProfilePlanInStates(profileId, [
            'QUEUED',
            'RUNNING',
            'PAUSING',
            'PAUSED',
            'STOPPING',
            'REVIEW',
          ]),
      );
      if (activePlan)
        throw new ProductError('PROFILE_TASK_ACTIVE', '请先停止该浏览器的运行任务后再删除', 409);
      if (
        value.profileIds.some(
          (id) =>
            groupInviter?.isProfileRunning(id) === true ||
            groupBumper?.isProfileRunning(id) === true,
        )
      )
        throw new ProductError(
          'PROFILE_TASK_ACTIVE',
          '请先停止小组邀请人任务后再删除该浏览器',
          409,
        );
      const result = await service.deleteProfiles(value.profileIds);
      json(res, 200, { deleted: true, ...result });
      return true;
    }
    default:
      return false;
  }
}
