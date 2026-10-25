import type { MediaComponentPort } from '../application/media-component.js';
import type { SoftwareUpdateService } from '../application/software-update-service.js';
import { ExtensionReloadRequest } from '../shared/software-update.js';
import type { DataCleanupService } from '../application/data-cleanup.js';
import type { Awaitable } from '../domain/persistence.js';
import { someAsync } from '../shared/async-collections.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError, z } from 'zod';
import { ProductError } from '../domain/workspace.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { WorkspaceService } from '../application/workspace-service.js';
import type { TaskService } from '../application/task-service.js';
import { TaskTestService } from '../application/task-test-service.js';
import { FEATURE_CONTRACT_HEADER } from '../shared/task-features.js';
import type { MaterialPreflightService } from '../application/material-preflight.js';
import { MATERIAL_PREVIEW_HEADER } from '../shared/materials.js';
import type { ProfileInspectionService } from '../application/profile-inspection.js';
import type { ResourceTableService } from '../application/resource-table-service.js';
import type { MaterialUsageService } from '../application/material-usage-service.js';
import type { MaterialCacheManagement } from '../application/material-cache-management.js';
import type { WorkspaceMaintenance } from '../application/workspace-maintenance.js';
import type { WorkspaceBackupService } from '../application/workspace-backup-service.js';
import type { GroupInviterService } from '../application/group-inviter-service.js';
import { RESOURCE_SUMMARY_HEADER } from '../shared/resource-table.js';
import {
  TaskHistoryRequest,
  AssignTasks,
  TaskCommandRequest,
  SchedulerSettings,
} from '../shared/task-contracts.js';
import { TASK_CAPACITY_HEADER } from '../shared/task-capacity.js';
import {
  assertTaskContract,
  assertTaskCapacity,
  TASK_CONTRACT_HEADER,
} from './task-contract-version.js';
import { ArchiveListRequest, ArchiveResumeRequest } from '../shared/archive-management.js';
import type { ArchiveManagementService } from '../application/archive-management.js';
import type { NativeReviewService } from '../application/native-review.js';
import { NativeReviewRequest, NATIVE_REVIEW_CONTRACT_HEADER } from '../shared/native-review.js';
import {
  ConsolidateBrowserRequest,
  ConsolidateBrowserResult,
  CleanupProfileTabsRequest,
  CleanupProfileTabsResult,
  ShowBrowserRequest,
  ShowBrowserResult,
  type BrowserWindowPort,
} from '../shared/browser-window.js';
import {
  InspectProfiles,
  inspectionResponse,
  INSPECTION_DISPLAY_HEADER,
} from '../shared/profile-inspection.js';
import {
  ChangeCombination,
  CreateCombination,
  CreateCombinationDraft,
  CreateGroup,
  DeleteCombination,
  DeleteProfiles,
  ExistingCombination,
  MoveProfiles,
  RenameGroup,
  DeleteGroup,
  RenameProfile,
  StartCombination,
  StopProfiles,
  StopResultsSchema,
  WorkspaceSchema,
} from '../shared/contracts.js';

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
function assertStoryWorkspaceClient(
  header: string | string[] | undefined,
  values: readonly (
    { steps: readonly { type: string; audience?: string; aiLabel?: string }[] } | null | undefined
  )[],
) {
  if (
    header !== '6' &&
    values.some((value) =>
      value?.steps.some((step) => step.type === 'post' && step.aiLabel !== undefined),
    )
  )
    throw new ProductError(
      'WORKBENCH_CLIENT_UPDATE_REQUIRED',
      'AI 声明选项需要新版界面，请刷新工作台；当前编辑请先保留',
      409,
    );
  if (
    header !== '5' &&
    header !== '6' &&
    values.some((value) =>
      value?.steps.some((step) => step.type === 'post' && step.audience === 'friends'),
    )
  )
    throw new ProductError(
      'WORKBENCH_CLIENT_UPDATE_REQUIRED',
      '快拍好友范围需要新版界面，请刷新工作台；当前编辑请先保留',
      409,
    );
}
import { windowLayoutMessage, type WindowLayoutPort } from '../shared/window-layout.js';
export function workspaceApi(
  service: WorkspaceService,
  tasks?: TaskService,
  materials?: MaterialPreflightService,
  inspection?: ProfileInspectionService,
  resources?: ResourceTableService,
  archives?: ArchiveManagementService,
  nativeReview?: NativeReviewService,
  materialUsage?: MaterialUsageService,
  backups?: WorkspaceBackupService,
  softwareControl?: { restart: () => void },
  browserWindows?: BrowserWindowPort,
  cacheManagement?: MaterialCacheManagement,
  maintenance?: WorkspaceMaintenance,
  groupInviter?: GroupInviterService,
  captureDiagnostics?: (
    note?: string,
  ) => Awaitable<{ filePath: string; entryId: number; at: string }>,
  cleanup?: DataCleanupService,
  windowLayout?: WindowLayoutPort,
  mediaComponent?: MediaComponentPort,
  softwareUpdate?: SoftwareUpdateService,
) {
  const taskTests = tasks
    ? new TaskTestService(
        service,
        tasks,
        (profileId) => groupInviter?.isProfileRunning(profileId) === true,
      )
    : undefined;
  return async (req: IncomingMessage, res: ServerResponse, route: string, input?: unknown) => {
    if (!route.startsWith('/api/workspace')) return false;
    const reqStartAt = Date.now();
    try {
      if (
        route === '/api/workspace/window-layout' &&
        (req.method === 'GET' || req.method === 'POST')
      ) {
        if (!windowLayout)
          throw new ProductError('WINDOW_LAYOUT_UNAVAILABLE', '窗口布局服务未加载', 409);
        if (req.method === 'POST') cleanup?.assertNotResetting();

        try {
          json(
            res,
            200,
            req.method === 'GET'
              ? await windowLayout.snapshot()
              : await windowLayout.command(input),
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('WINDOW_LAYOUT_'))
            throw new ProductError(error.message, windowLayoutMessage(error.message), 409);
          throw error;
        }
        return true;
      }
      if (req.method === 'POST') cleanup?.assertNotResetting();
      if (req.method === 'GET' && route === '/api/workspace/update/status') {
        if (!softwareUpdate)
          throw new ProductError('UPDATER_UNAVAILABLE', '当前服务未启用更新器', 409);
        json(res, 200, await softwareUpdate.status());
        return true;
      }
      if (mediaComponent && route === '/api/workspace/media-component') {
        if (req.method === 'POST') {
          const request = z
            .object({ action: z.enum(['install', 'cancel']) })
            .strict()
            .parse(input);
          if (request.action === 'cancel') mediaComponent.cancel();
          else {
            backups?.assertIdle();
            await mediaComponent.start();
          }
        }
        json(res, 200, await mediaComponent.status());
        return true;
      }

      if (
        req.method === 'POST' &&
        route === '/api/workspace/diagnostics/snapshot' &&
        captureDiagnostics
      ) {
        const parsed = z
          .object({ note: z.string().max(400).optional() })
          .strict()
          .parse(input ?? {});
        const snapshot = await captureDiagnostics(parsed.note);
        json(res, 200, { recorded: true, ...snapshot });
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/group-inviter/state' && groupInviter) {
        json(res, 200, await groupInviter.state());
        return true;
      }
      if (
        req.method === 'POST' &&
        route === '/api/workspace/group-inviter/groups/add' &&
        groupInviter
      ) {
        json(res, 200, await groupInviter.addGroups(input));
        return true;
      }
      if (
        req.method === 'POST' &&
        route === '/api/workspace/group-inviter/groups/delete' &&
        groupInviter
      ) {
        json(res, 200, await groupInviter.deleteGroups(input));
        return true;
      }
      if (
        req.method === 'POST' &&
        route === '/api/workspace/group-inviter/settings' &&
        groupInviter
      ) {
        json(res, 200, await groupInviter.updateSettings(input));
        return true;
      }
      if (req.method === 'POST' && route === '/api/workspace/group-inviter/start' && groupInviter) {
        json(res, 200, await groupInviter.start(input));
        return true;
      }
      if (req.method === 'POST' && route === '/api/workspace/group-inviter/stop' && groupInviter) {
        json(res, 200, await groupInviter.stop());
        return true;
      }
      if (
        req.method === 'POST' &&
        route === '/api/workspace/group-inviter/stop-profiles' &&
        groupInviter
      ) {
        json(res, 200, await groupInviter.stopProfiles(input));
        return true;
      }
      if (cleanup && route.startsWith('/api/workspace/data-cleanup/')) {
        const action = route.slice('/api/workspace/data-cleanup/'.length);
        if (req.method === 'GET' && action === 'progress') {
          json(res, 200, cleanup.progress());
          return true;
        }
        if (req.method === 'GET' && action === 'settings') {
          json(res, 200, await cleanup.settings());
          return true;
        }
        if (req.method === 'GET' && action === 'reset-status') {
          json(res, 200, await cleanup.resetStatus());
          return true;
        }
        if (req.method === 'POST') {
          const result =
            action === 'preview'
              ? await cleanup.preview(input)
              : action === 'execute'
                ? await cleanup.execute(input)
                : action === 'settings'
                  ? await cleanup.saveSettings(input)
                  : action === 'compact'
                    ? await cleanup.compact()
                    : action === 'reset'
                      ? await cleanup.resetAll(input)
                      : null;
          if (result) {
            json(res, 200, result);
            return true;
          }
        }
      }
      if (req.method === 'GET' && route === '/api/workspace/maintenance' && maintenance) {
        json(res, 200, await maintenance.snapshot());
        return true;
      }
      if (req.method === 'POST' && route === '/api/workspace/maintenance/settings' && maintenance) {
        json(res, 200, await maintenance.update(input));
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/maintenance/logs' && maintenance) {
        json(res, 200, await maintenance.export());
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/preferences') {
        json(res, 200, await service.preferences());
        return true;
      }
      if (req.method === 'POST' && route === '/api/workspace/preferences') {
        json(res, 200, await service.updatePreferences(input));
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/materials/cache' && cacheManagement) {
        json(res, 200, await cacheManagement.snapshot());
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/backups/status') {
        json(
          res,
          200,
          (await backups?.status()) ?? {
            available: false,
            busy: false,
            canCreate: false,
            reason: '数据备份服务尚未加载',
          },
        );
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/backups/restore-status') {
        json(
          res,
          200,
          (await backups?.restoreStatus()) ?? {
            available: false,
            state: 'NONE',
            reason: '恢复服务未加载',
            safetyDirectory: '',
          },
        );
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/materials/usage' && materialUsage) {
        json(res, 200, await materialUsage.snapshot());
        return true;
      }
      if (
        req.method === 'GET' &&
        route === '/api/workspace/resource-tables/summaries' &&
        resources
      ) {
        const contract = req.headers[RESOURCE_SUMMARY_HEADER];
        if (contract !== undefined && contract !== '2')
          throw new ProductError('RESOURCE_SUMMARY_VERSION_UNSUPPORTED', '请更新资源列表界面', 409);
        json(
          res,
          200,
          contract === '2' ? await resources.usageSummaries() : await resources.summaries(),
        );
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
      if (req.method === 'GET' && route === '/api/workspace/tasks' && tasks) {
        assertTaskCapacity(req.headers[TASK_CAPACITY_HEADER], await tasks.settings());
        const overview = await tasks.overview();
        assertTaskContract(req.headers[TASK_CONTRACT_HEADER], [], overview.plans);
        json(res, 200, overview);
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/tasks/capabilities' && tasks) {
        json(res, 200, await tasks.capabilities());
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/tasks/runtime' && tasks) {
        assertTaskCapacity(req.headers[TASK_CAPACITY_HEADER], await tasks.settings());
        if (req.aborted || res.destroyed) return true;
        if (req.headers['x-workbench-runtime-contract'] !== '2')
          throw new ProductError(
            'TASK_CONTRACT_UPGRADE_REQUIRED',
            '任务读取接口已更新，请刷新软件页面',
            409,
          );
        const cursor = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor');
        const overview = await tasks.runtimeOverview(cursor ? { cursor } : {});
        assertTaskContract(
          req.headers[TASK_CONTRACT_HEADER],
          overview.currentSteps,
          overview.plans,
        );
        json(res, 200, overview);
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace/tasks/features' && tasks) {
        json(
          res,
          200,
          await tasks.features(req.headers[FEATURE_CONTRACT_HEADER] === '2' ? '2' : '1'),
        );
        return true;
      }
      if (req.method === 'GET' && route === '/api/workspace') {
        const snapshot = WorkspaceSchema.parse(await service.snapshot());
        assertStoryWorkspaceClient(
          req.headers['x-workbench-workspace-contract'],
          snapshot.combinations.flatMap((row) => [row.saved, row.draft]),
        );
        if (
          !['4', '5', '6'].includes(String(req.headers['x-workbench-workspace-contract'])) &&
          snapshot.combinations.some((row) =>
            [row.saved, row.draft].some((value) =>
              value?.steps.some((step) => step.type === 'post' && step.audience !== undefined),
            ),
          )
        )
          throw new ProductError(
            'WORKBENCH_CLIENT_UPDATE_REQUIRED',
            '帖子分享范围需要新版界面，请刷新工作台；当前编辑请先保留',
            409,
          );
        if (
          !['2', '3', '4', '5', '6'].includes(
            String(req.headers['x-workbench-workspace-contract']),
          ) &&
          snapshot.combinations.some((row) =>
            [row.saved, row.draft].some((value) =>
              value?.steps.some((step) => step.type === 'post' && step.resourceMode !== undefined),
            ),
          )
        )
          throw new ProductError(
            'WORKBENCH_CLIENT_UPDATE_REQUIRED',
            '资源表需要新版界面，请重新打开工作台；当前编辑请先保留',
            409,
          );
        json(
          res,
          200,
          ['3', '4', '5', '6'].includes(String(req.headers['x-workbench-workspace-contract']))
            ? snapshot
            : {
                ...snapshot,
                profiles: snapshot.profiles.map(({ browserName: _name, ...profile }) => profile),
              },
        );
        return true;
      }
      if (req.method !== 'POST') {
        json(res, 405, { code: 'METHOD_NOT_ALLOWED', error: '不支持的请求方式' });
        return true;
      }
      const repo = service.repository;
      const assertExistingStoryClient = async (id: string) => {
        const row = (await repo.combinations()).find((row) => row.id === id);
        assertStoryWorkspaceClient(req.headers['x-workbench-workspace-contract'], [
          row?.saved,
          row?.draft,
        ]);
      };
      switch (route) {
        case '/api/workspace/materials/cache/clean': {
          if (!cacheManagement)
            throw new ProductError('CACHE_CLEANUP_UNAVAILABLE', '缓存管理服务未加载', 409);
          json(res, 200, await cacheManagement.clean(input));
          return true;
        }
        case '/api/workspace/profiles/show': {
          const { profileId } = ShowBrowserRequest.parse(input);
          await service.requireProfiles([profileId]);
          const profile = (await service.snapshot()).profiles.find((row) => row.id === profileId);
          if (!browserWindows || !profile)
            throw new ProductError('BROWSER_SHOW_UNAVAILABLE', '浏览器显示功能尚未加载', 409);
          json(
            res,
            200,
            ShowBrowserResult.parse(await browserWindows.show(profileId, profile.alias)),
          );
          break;
        }
        case '/api/workspace/profiles/consolidate-tabs': {
          const { profileId, preferActiveTab } = ConsolidateBrowserRequest.parse(input);
          await service.requireProfiles([profileId]);
          if (!browserWindows?.consolidate)
            throw new ProductError(
              'WORKSPACE_CLEANUP_UNAVAILABLE',
              '浏览器标签清理功能尚未加载',
              409,
            );
          json(
            res,
            200,
            ConsolidateBrowserResult.parse(
              await browserWindows.consolidate(profileId, preferActiveTab ?? true),
            ),
          );
          break;
        }
        case '/api/workspace/profiles/cleanup-tabs': {
          const { profileIds, preferActiveTab } = CleanupProfileTabsRequest.parse(input);
          await service.requireProfiles(profileIds);
          if (!browserWindows?.cleanupTabs)
            throw new ProductError(
              'WORKSPACE_CLEANUP_UNAVAILABLE',
              '浏览器标签清理功能尚未加载',
              409,
            );
          json(
            res,
            200,
            CleanupProfileTabsResult.parse(
              await browserWindows.cleanupTabs(profileIds, preferActiveTab ?? false),
            ),
          );
          break;
        }
        case '/api/workspace/software/restart': {
          if (!softwareControl)
            throw new ProductError(
              'SOFTWARE_RESTART_UNAVAILABLE',
              '当前不是桌面软件，请使用正常软件入口',
              409,
            );
          if ((await tasks?.hasActiveExecution()) || groupInviter?.hasActiveExecution())
            throw new ProductError('TASKS_ACTIVE', '请先停止或暂停任务，再重启软件', 409);
          backups?.assertIdle();
          json(res, 200, { requested: true });
          softwareControl.restart();
          break;
        }
        case '/api/workspace/update/status':
        case '/api/workspace/update/check':
        case '/api/workspace/update/config':
        case '/api/workspace/update/apply':
        case '/api/workspace/extensions/reload':
        case '/api/workspace/extensions/open-dir': {
          if (!softwareUpdate)
            throw new ProductError('UPDATER_UNAVAILABLE', '当前服务未启用更新器', 409);
          const result = route.endsWith('/status')
            ? await softwareUpdate.status()
            : route.endsWith('/check')
              ? await softwareUpdate.check()
              : route.endsWith('/config')
                ? await softwareUpdate.configure(input)
                : route.endsWith('/apply')
                  ? await softwareUpdate.apply()
                  : route.endsWith('/reload')
                    ? await softwareUpdate.reload(
                        ExtensionReloadRequest.parse(input ?? {}).profileIds,
                      )
                    : await softwareUpdate.openDirectory();
          json(res, 200, result);
          break;
        }
        case '/api/workspace/profiles/release-idle-pages': {
          if (!nativeReview)
            throw new ProductError('NATIVE_RELEASE_UNAVAILABLE', '浏览器占用处理服务尚未加载', 409);
          const value = NativeReviewRequest.parse(input);
          await service.requireProfiles([value.profileId]);
          json(res, 200, await nativeReview.releaseIdle(value));
          break;
        }
        case '/api/workspace/tasks/test': {
          if (!taskTests) throw new ProductError('TASKS_UNAVAILABLE', '测试执行服务尚未加载', 409);
          json(res, 200, await taskTests.start(input));
          break;
        }
        case '/api/workspace/backups/create': {
          if (!backups)
            throw new ProductError('BACKUP_UNAVAILABLE', '请更新软件以使用数据备份', 409);
          json(res, 200, await backups.create(input));
          return true;
        }
        case '/api/workspace/backups/inspect-restore': {
          if (!backups) throw new ProductError('RESTORE_UNAVAILABLE', '恢复服务未加载', 409);
          json(res, 200, await backups.inspectRestore(input));
          return true;
        }
        case '/api/workspace/backups/prepare-restore': {
          if (!backups) throw new ProductError('RESTORE_UNAVAILABLE', '恢复服务未加载', 409);
          json(res, 200, await backups.prepareRestore(input));
          return true;
        }
        case '/api/workspace/materials/usage/clear': {
          if (!materialUsage)
            throw new ProductError(
              'MATERIAL_USAGE_UNAVAILABLE',
              '素材使用记录服务未启用，请更新软件',
              409,
            );
          json(res, 200, await materialUsage.clear(input));
          break;
        }
        case '/api/workspace/tasks/settings': {
          if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务设置服务未启用', 409);
          assertTaskCapacity(req.headers[TASK_CAPACITY_HEADER], SchedulerSettings.parse(input));
          json(res, 200, await tasks.setSettings(input));
          break;
        }
        case '/api/workspace/profiles/native-review': {
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
          break;
        }
        case '/api/workspace/tasks/command': {
          if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务执行服务未启用', 409);
          const value = TaskCommandRequest.parse(input);
          await service.requireProfiles(value.plans.map((plan) => plan.profileId));
          json(res, 200, await tasks.command(value));
          break;
        }
        case '/api/workspace/tasks/start': {
          if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务执行服务未启用', 409);
          const value = AssignTasks.parse(input);
          const previous = await tasks.plansForBatch(value.requestId);
          const saved = (await service.snapshot()).combinations.find(
            (row) => row.id === value.combinationId,
          )?.saved;
          assertTaskContract(
            req.headers[TASK_CONTRACT_HEADER],
            [],
            previous.length ? previous : saved ? [{ snapshot: saved }] : [],
          );
          await service.requireProfiles(value.profileIds);
          if (!previous.length && groupInviter) {
            const remaining = value.profileIds.filter((id) => !groupInviter.isProfileRunning(id));
            if (remaining.length === 0)
              throw new ProductError(
                'PROFILE_GROUP_INVITER_BUSY',
                '所选浏览器正在执行小组邀请人任务，请先停止后再启动任务组合',
                409,
              );
            value.profileIds = remaining;
          }
          json(res, 200, await tasks.start(value));
          break;
        }
        case '/api/workspace/archives/list':
        case '/api/workspace/archives/resume': {
          if (!archives) throw new ProductError('ARCHIVES_UNAVAILABLE', '归档管理未启用', 409);
          const value = route.endsWith('/resume')
            ? ArchiveResumeRequest.parse(input)
            : ArchiveListRequest.parse(input);
          await service.requireProfiles([value.profileId]);
          json(
            res,
            200,
            route.endsWith('/resume') ? await archives.resume(value) : await archives.list(value),
          );
          break;
        }
        case '/api/workspace/tasks/history': {
          if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务记录服务未启用', 409);
          const value = TaskHistoryRequest.parse(input);
          await service.requireProfiles([value.profileId]);
          const history = await tasks.history(value);
          assertTaskContract(req.headers[TASK_CONTRACT_HEADER], history.steps);
          json(res, 200, history);
          break;
        }
        case '/api/workspace/tasks/records': {
          if (!tasks) throw new ProductError('TASKS_UNAVAILABLE', '任务记录服务未启用', 409);
          if (req.aborted || res.destroyed) return true;
          assertTaskContract(req.headers[TASK_CONTRACT_HEADER], []);
          if (req.headers['x-workbench-records-contract'] !== '1')
            throw new ProductError(
              'TASK_CONTRACT_UPGRADE_REQUIRED',
              '记录分页接口已更新，请刷新软件页面',
              409,
            );
          const records = await tasks.records(input, (await service.snapshot()).profiles);
          assertTaskContract(req.headers[TASK_CONTRACT_HEADER], records.records);
          json(res, 200, records);
          break;
        }
        case '/api/workspace/resource-tables/download':
        case '/api/workspace/resource-tables/check': {
          if (!resources) throw new ProductError('RESOURCES_UNAVAILABLE', '资源表服务未启用', 409);
          const downloading = route.endsWith('/download');
          if (downloading && req.headers.accept !== 'application/x-ndjson')
            throw new ProductError('RESOURCE_DOWNLOAD_STREAM_REQUIRED', '请更新资源下载界面', 409);
          if (req.headers.accept === 'application/x-ndjson') {
            const connected = () => {
              if (req.aborted || res.destroyed) throw Error('RESOURCE_CHECK_CLIENT_CLOSED');
            };
            const frame = async (value: unknown) => {
              connected();
              if (!res.headersSent)
                res.writeHead(200, {
                  'content-type': 'application/x-ndjson',
                  'cache-control': 'no-store',
                  'x-content-type-options': 'nosniff',
                });
              await new Promise<void>((resolve, reject) =>
                res.write(JSON.stringify(value) + '\n', (error) =>
                  error ? reject(error) : resolve(),
                ),
              );
              connected();
            };
            try {
              const report = downloading
                ? await resources.downloadSources(input, connected, (progress) =>
                    frame({ kind: 'progress', ...progress }),
                  )
                : await resources.checkSources(input, connected, (progress) =>
                    frame({ kind: 'progress', ...progress }),
                  );
              await frame({ kind: 'completed', report });
              res.end();
            } catch (error) {
              if (!res.headersSent) throw error;
              if (!res.destroyed) {
                await frame({
                  kind: 'failed',
                  code:
                    error instanceof ProductError
                      ? error.code
                      : downloading
                        ? 'RESOURCE_DOWNLOAD_INTERRUPTED'
                        : 'RESOURCE_CHECK_FAILED',
                  error:
                    error instanceof ProductError ? error.message : '检查未完成；已保存资源保持',
                });
                res.end();
              }
            }
            break;
          }
          json(
            res,
            200,
            await resources.checkSources(input, () => {
              if (req.aborted || res.destroyed) throw Error('RESOURCE_CHECK_CLIENT_CLOSED');
            }),
          );
          break;
        }
        case '/api/workspace/resource-tables/media': {
          if (!resources) throw new ProductError('RESOURCES_UNAVAILABLE', '资源表服务未启用', 409);
          const connected = () => {
            if (req.aborted || res.destroyed) throw Error('RESOURCE_PREVIEW_CLIENT_CLOSED');
          };
          await resources.previewMedia(input, connected, async ({ bytes, contentType }) => {
            connected();
            res.setTimeout(30_000, () => res.destroy());
            res.writeHead(200, {
              'content-type': contentType,
              'content-length': bytes.byteLength,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            await new Promise<void>((resolve, reject) => {
              const closed = () => reject(Error('RESOURCE_PREVIEW_CLIENT_CLOSED'));
              res.once('close', closed);
              res.end(bytes, () => {
                res.removeListener('close', closed);
                resolve();
              });
            });
          });
          break;
        }
        case '/api/workspace/resource-tables/read':
        case '/api/workspace/resource-tables/save': {
          if (!resources) throw new ProductError('RESOURCES_UNAVAILABLE', '资源表服务未启用', 409);
          json(
            res,
            200,
            route.endsWith('/read') ? await resources.read(input) : await resources.save(input),
          );
          break;
        }
        case '/api/workspace/profiles/inspect': {
          if (!inspection)
            throw new ProductError('INSPECTION_UNAVAILABLE', '资料检查服务未启用', 409);
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
          break;
        }
        case '/api/workspace/materials/preflight': {
          if (!materials)
            throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
          json(
            res,
            200,
            req.headers[MATERIAL_PREVIEW_HEADER] === '1'
              ? await materials.inspectForPreview(input)
              : await materials.inspect(input),
          );
          break;
        }
        case '/api/workspace/materials/preview': {
          if (!materials)
            throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
          json(res, 200, materials.preview(input));
          break;
        }
        case '/api/workspace/materials/arrangement': {
          if (!materials)
            throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
          json(res, 200, materials.arrangement(input, (await service.snapshot()).profiles));
          break;
        }
        case '/api/workspace/materials/review': {
          if (!materials)
            throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
          json(
            res,
            200,
            await materials.review(
              input,
              async () => (await service.snapshot()).profiles,
              () => {
                if (req.aborted || res.destroyed) throw Error('MATERIAL_REVIEW_CLIENT_CLOSED');
              },
            ),
          );
          break;
        }
        case '/api/workspace/materials/media': {
          if (!materials)
            throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
          const connected = () => {
            if (req.aborted || res.destroyed) throw Error('MATERIAL_MEDIA_CLIENT_CLOSED');
          };
          await materials.media(input, connected, async ({ bytes, contentType }) => {
            connected();
            res.setTimeout(30_000, () => res.destroy());
            res.writeHead(200, {
              'content-type': contentType,
              'content-length': bytes.byteLength,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            await new Promise<void>((resolve, reject) => {
              const closed = () => reject(Error('MATERIAL_MEDIA_CLIENT_CLOSED'));
              res.once('close', closed);
              res.end(bytes, () => {
                res.removeListener('close', closed);
                resolve();
              });
            });
          });
          break;
        }
        case '/api/workspace/groups/create': {
          const value = CreateGroup.parse(input);
          json(res, 201, await repo.createGroup(value.name, value.color));
          break;
        }
        case '/api/workspace/groups/rename': {
          const value = RenameGroup.parse(input);
          await repo.renameGroup(value.groupId, value.name);
          json(res, 200, { saved: true });
          break;
        }
        case '/api/workspace/groups/delete': {
          const value = DeleteGroup.parse(input);
          json(res, 200, { deleted: true, movedProfiles: await repo.deleteGroup(value.groupId) });
          break;
        }
        case '/api/workspace/profiles/move': {
          const value = MoveProfiles.parse(input);
          await service.moveProfiles(value.profileIds, value.groupId);
          json(res, 200, { saved: true });
          break;
        }
        case '/api/workspace/profiles/rename': {
          const value = RenameProfile.parse(input);
          await service.renameProfile(value.profileId, value.alias);
          json(res, 200, { saved: true });
          break;
        }
        case '/api/workspace/profiles/stop': {
          const value = StopProfiles.parse(input);
          await service.requireProfiles(value.profileIds);
          const results = await Promise.all(
            [...new Set(value.profileIds)].map(async (profileId) => {
              inspection?.invalidate(profileId);
              try {
                const inviterRunning = groupInviter?.isProfileRunning(profileId) === true;
                if (inviterRunning) {
                  await groupInviter?.stopProfiles({ profileIds: [profileId] });
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
          break;
        }
        case '/api/workspace/profiles/delete': {
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
            throw new ProductError(
              'PROFILE_TASK_ACTIVE',
              '请先停止该浏览器的运行任务后再删除',
              409,
            );
          if (value.profileIds.some((id) => groupInviter?.isProfileRunning(id) === true))
            throw new ProductError(
              'PROFILE_TASK_ACTIVE',
              '请先停止小组邀请人任务后再删除该浏览器',
              409,
            );
          const result = await service.deleteProfiles(value.profileIds);
          json(res, 200, { deleted: true, ...result });
          break;
        }
        case '/api/workspace/combinations/create': {
          const value = CreateCombination.parse(input);
          assertStoryWorkspaceClient(req.headers['x-workbench-workspace-contract'], [value.value]);
          json(res, 201, await repo.createCombination(value.value));
          break;
        }
        case '/api/workspace/combinations/copy': {
          const value = ExistingCombination.pick({ id: true }).strict().parse(input);
          await assertExistingStoryClient(value.id);
          json(res, 201, await repo.copyCombination(value.id));
          break;
        }
        case '/api/workspace/combinations/delete': {
          const value = DeleteCombination.parse(input);
          const activePlan = (await tasks?.livePlans())?.find(
            (plan) =>
              plan.combinationId === value.id &&
              !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state),
          );
          if (activePlan)
            throw new ProductError(
              'COMBINATION_TASK_ACTIVE',
              '该任务组合正在运行或排队中，请先停止相关任务后再删除',
              409,
            );
          const result = await service.deleteCombination(value.id);
          json(res, 200, { deleted: true, ...result });
          break;
        }
        case '/api/workspace/combinations/create-draft': {
          const value = CreateCombinationDraft.parse(input);
          assertStoryWorkspaceClient(req.headers['x-workbench-workspace-contract'], [value.value]);
          json(res, 201, await repo.createDraft(value.value));
          break;
        }
        case '/api/workspace/combinations/draft': {
          const value = ChangeCombination.parse(input);
          await assertExistingStoryClient(value.id);
          assertStoryWorkspaceClient(req.headers['x-workbench-workspace-contract'], [value.value]);
          json(res, 200, await repo.writeDraft(value.id, value.expectedRevision, value.value));
          break;
        }
        case '/api/workspace/combinations/publish': {
          const value = ExistingCombination.parse(input);
          await assertExistingStoryClient(value.id);
          json(res, 200, await repo.publish(value.id, value.expectedRevision));
          break;
        }
        case '/api/workspace/combinations/discard': {
          const value = ExistingCombination.parse(input);
          await assertExistingStoryClient(value.id);
          json(res, 200, await repo.discardDraft(value.id, value.expectedRevision));
          break;
        }
        case '/api/workspace/combinations/start': {
          StartCombination.parse(input);
          service.startCombination();
          break;
        }
        default:
          json(res, 404, { code: 'NOT_FOUND', error: '接口不存在' });
      }
    } catch (error) {
      const durationMs = Date.now() - reqStartAt;
      devDiag.record({
        level: 'ERROR',
        category: 'HTTP_API',
        event: 'HTTP_REQUEST_ERROR',
        durationMs,
        reason:
          error instanceof ProductError
            ? `${error.code}:${error.message}`
            : error instanceof Error
              ? error.message
              : 'INTERNAL_ERROR',
        data: { method: req.method ?? 'UNKNOWN', route },
      });
      if (res.destroyed || res.headersSent) return true;
      if (error instanceof ProductError)
        json(res, error.status, { code: error.code, error: error.message });
      else if (error instanceof ZodError)
        json(res, 400, {
          code: 'VALIDATION_FAILED',
          error: '参数不符合规则',
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        });
      else {
        console.error('Workspace request failed', error);
        json(res, 500, { code: 'INTERNAL_ERROR', error: '保存失败，请查看本机日志' });
      }
    } finally {
      if (
        req.method === 'POST' &&
        route !== '/api/workspace/diagnostics/snapshot' &&
        ![
          '/api/workspace/tasks/records',
          '/api/workspace/tasks/history',
          '/api/workspace/resource-tables/read',
          '/api/workspace/archives/list',
        ].includes(route)
      ) {
        const durationMs = Date.now() - reqStartAt;
        devDiag.record({
          level: durationMs >= 2000 ? 'SLOW' : 'INFO',
          category: 'HTTP_API',
          event: 'HTTP_POST_COMPLETED',
          durationMs,
          data: { route, statusCode: res.statusCode },
        });
      }
    }
    return true;
  };
}
