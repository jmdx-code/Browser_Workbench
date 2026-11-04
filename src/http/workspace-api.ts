import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import type { ArchiveManagementService } from '../application/archive-management.js';
import type { DataCleanupService } from '../application/data-cleanup.js';
import {
  ensureFeatureExecutionRegistry,
  type FeatureExecutionRegistry,
} from '../application/feature-execution-registry.js';
import type { GroupBumperService } from '../application/group-bumper-service.js';
import type { GroupInviterService } from '../application/group-inviter-service.js';
import type { GroupPosterService } from '../application/group-poster-service.js';
import type { MaterialCacheManagement } from '../application/material-cache-management.js';
import type { MaterialPreflightService } from '../application/material-preflight.js';
import type { MaterialUsageService } from '../application/material-usage-service.js';
import type { MediaComponentPort } from '../application/media-component.js';
import type { NativeReviewService } from '../application/native-review.js';
import type { ProfileInspectionService } from '../application/profile-inspection.js';
import type { ResourceTableService } from '../application/resource-table-service.js';
import type { SoftwareUpdateService } from '../application/software-update-service.js';
import type { TaskService } from '../application/task-service.js';
import { TaskTestService } from '../application/task-test-service.js';
import type { WorkspaceBackupService } from '../application/workspace-backup-service.js';
import type { WorkspaceMaintenance } from '../application/workspace-maintenance.js';
import type { WorkspaceService } from '../application/workspace-service.js';
import type { Awaitable } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import type { BrowserWindowPort } from '../shared/browser-window.js';
import {
  ChangeCombination,
  CreateCombination,
  CreateCombinationDraft,
  DeleteCombination,
  ExistingCombination,
  StartCombination,
  WorkspaceSchema,
} from '../shared/contracts.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { WindowLayoutPort } from '../shared/window-layout.js';
import { handleFeatureModuleRoutes } from './routes/feature-module-routes.js';
import { handleMaterialResourceRoutes } from './routes/material-resource-routes.js';
import { handleSystemMaintenanceRoutes } from './routes/system-maintenance-routes.js';
import { handleTaskRoutes } from './routes/task-routes.js';

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

export interface DiagnosticCaptureInput {
  note?: string;
  uiContext?: string;
  targetDir?: string;
  reveal?: boolean;
}
export interface DiagnosticCaptureOutput {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  entryId: number;
  at: string;
}

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
  captureDiagnostics?: (input?: DiagnosticCaptureInput) => Awaitable<DiagnosticCaptureOutput>,
  cleanup?: DataCleanupService,
  windowLayout?: WindowLayoutPort,
  mediaComponent?: MediaComponentPort,
  softwareUpdate?: SoftwareUpdateService,
  groupBumper?: GroupBumperService,
  revealDiagnostics?: (
    fileName?: string,
    targetDir?: string,
  ) => Awaitable<{ filePath: string; fileName: string }>,
  featureExecution?: FeatureExecutionRegistry,
  groupPoster?: GroupPosterService,
  isProfileOnline?: (profileId: string) => boolean | Promise<boolean>,
) {
  const resolvedFeatureExecution = ensureFeatureExecutionRegistry(featureExecution, {
    tasks,
    groupInviter,
    groupBumper,
    groupPoster,
  });
  groupBumper?.setFeatureExecutionRegistry?.(resolvedFeatureExecution);
  groupInviter?.setFeatureExecutionRegistry?.(resolvedFeatureExecution);
  const taskTests = tasks
    ? new TaskTestService(service, tasks, (profileId) =>
        resolvedFeatureExecution.isProfileBusy(profileId, 'active-accounts'),
      )
    : undefined;
  return async (req: IncomingMessage, res: ServerResponse, route: string, input?: unknown) => {
    if (!route.startsWith('/api/workspace')) return false;
    const reqStartAt = Date.now();
    try {
      if (
        await handleFeatureModuleRoutes({
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
          groupPoster,
          featureExecution: resolvedFeatureExecution,
        })
      ) {
        return true;
      }

      if (
        await handleSystemMaintenanceRoutes({
          req,
          res,
          route,
          input,
          json,
          service,
          tasks,
          backups,
          softwareControl,
          maintenance,
          groupInviter,
          groupBumper,
          groupPoster,
          featureExecution: resolvedFeatureExecution,
          captureDiagnostics,
          revealDiagnostics,
          cleanup,
          windowLayout,
          mediaComponent,
          softwareUpdate,
        })
      ) {
        return true;
      }

      if (req.method === 'POST') cleanup?.assertNotResetting();

      if (
        await handleMaterialResourceRoutes({
          req,
          res,
          route,
          input,
          json,
          service,
          materials,
          resources,
          archives,
          materialUsage,
          cacheManagement,
          cleanup,
        })
      ) {
        return true;
      }

      if (
        await handleTaskRoutes({
          req,
          res,
          route,
          input,
          json,
          service,
          tasks,
          taskTests,
          featureExecution: resolvedFeatureExecution,
          isProfileOnline,
        })
      ) {
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
        const row = (await repo.combinations()).find((item) => item.id === id);
        assertStoryWorkspaceClient(req.headers['x-workbench-workspace-contract'], [
          row?.saved,
          row?.draft,
        ]);
      };
      switch (route) {
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
