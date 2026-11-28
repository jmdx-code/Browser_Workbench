import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError, z } from 'zod';
import type { DataCleanupService } from '../application/data-cleanup.js';
import {
  ensureFeatureExecutionRegistry,
  type FeatureExecutionRegistry,
} from '../application/feature-execution-registry.js';
import type { GroupBumperService } from '../application/group-bumper-service.js';
import type { GroupInviterService } from '../application/group-inviter-service.js';
import type { GroupPosterService } from '../application/group-poster-service.js';
import type { BluestacksService } from '../application/bluestacks-service.js';
import type { AutoSchedulerService } from '../application/auto-scheduler-service.js';
import type { GoogleSheetsService } from '../application/google-sheets-service.js';
import type {
  MaterialCacheManagement,
  MaterialUsageService,
  MediaComponentPort,
  WorkspaceMaintenance,
} from '../application/workspace-media-maintenance.js';
import type { ProfileInspectionService } from '../application/profile-inspection.js';
import type { ResourceTableService } from '../application/resource-table-service.js';
import type { SoftwareUpdateService } from '../application/software-update-service.js';
import type { TaskService } from '../application/task-service.js';
import { TaskTestService } from '../application/task-test-service.js';
import type { WorkspaceBackupService } from '../application/workspace-backup-service.js';
import type { WorkspaceService } from '../application/workspace-service.js';
import type { WorkspaceEventHub } from '../application/workspace-event-hub.js';
import type { Awaitable } from '../domain/persistence.js';
import { ProductError, failError } from '../domain/workspace.js';
import { emptyActivityTotals, type ActivityStatsPort } from '../shared/activity-stats.js';
import type { BrowserWindowPort } from '../shared/browser-window.js';
import {
  CreateCombination,
  CreateGroup,
  DeleteCombination,
  DeleteGroup,
  Id,
  RenameGroup,
  RenameProfile,
  SaveCombination,
  WorkspaceSchema,
  obj,
  strictObj,
} from '../shared/contracts.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import {
  PostBumpRecordQuerySchema,
  PostBumpRecordQueryType,
  type PostBumpRecordsPort,
} from '../shared/post-bump-records.js';
import { RESOURCE_SUMMARY_HEADER } from '../shared/resource-table.js';
import { ExtensionReloadRequest } from '../shared/software-update.js';
import { windowLayoutMessage, type WindowLayoutPort } from '../shared/window-layout.js';
import { inferEventTopicsForRoute } from '../shared/workspace-events.js';
import { handleFeatureModuleRoutes } from './routes/feature-module-routes.js';
import { handleTaskRoutes, needSvc } from './routes/task-routes.js';
export function isZodValidationError(
  err: unknown,
): err is { issues: Array<{ path?: unknown; message?: unknown }> } {
  const rec =
    typeof err === 'object' && err !== null ? (err as { name?: unknown; issues?: unknown }) : null;
  return (
    err instanceof ZodError || Boolean(rec && rec.name === 'ZodError' && Array.isArray(rec.issues))
  );
}
const DEFAULT_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="24" fill="#e3e7ed"/><circle cx="24" cy="18" r="8" fill="#929aa6"/><path d="M9 43a15 15 0 0 1 30 0" fill="#929aa6"/></svg>';
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};
interface DiagnosticCaptureInput {
  note?: string;
  uiContext?: string;
  targetDir?: string;
  reveal?: boolean;
}
interface DiagnosticCaptureOutput {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  entryId: number;
  at: string;
}
export function workspaceApi(
  service: WorkspaceService,
  tasks?: TaskService,
  inspection?: ProfileInspectionService,
  resources?: ResourceTableService,
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
  bluestacks?: BluestacksService,
  profileLifecycle?: ProfileLifecyclePort,
  autoScheduler?: AutoSchedulerService,
  googleSheets?: GoogleSheetsService,
  postBumpRecords?: PostBumpRecordsPort,
  eventHub?: WorkspaceEventHub,
  activityStats?: ActivityStatsPort,
  isCarrierBusy?: (profileId: string) => boolean,
) {
  const fe = ensureFeatureExecutionRegistry(featureExecution, {
    tasks,
    groupInviter,
    groupBumper,
    groupPoster,
    bluestacks,
  });
  groupBumper?.setFeatureExecutionRegistry?.(fe);
  groupInviter?.setFeatureExecutionRegistry?.(fe);
  if (profileLifecycle) {
    groupBumper?.setProfileLifecycle?.(profileLifecycle);
    groupInviter?.setProfileLifecycle?.(profileLifecycle);
    groupPoster?.setProfileLifecycle?.(profileLifecycle);
  }
  const taskTests = tasks
    ? new TaskTestService(service, tasks, (id) => fe.isProfileBusy(id, 'active-accounts'))
    : undefined;
  if (taskTests && profileLifecycle) taskTests.setProfileLifecycle(profileLifecycle);
  const skipPostDiag = new Set([
      '/api/workspace/diagnostics/snapshot',
      '/api/workspace/tasks/records',
      '/api/workspace/resource-tables/read',
    ]),
    sseHeaders = {
      'content-type': 'text/event-stream;charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
  return async (req: IncomingMessage, res: ServerResponse, route: string, input?: unknown) => {
    if (!route.startsWith('/api/workspace')) return false;
    const endRes = () => !res.writableEnded && res.end();
    if (req.method === 'GET' && route === '/api/workspace/events') {
      res.writeHead(200, sseHeaders);
      res.flushHeaders?.();
      if (!eventHub) {
        res.write('event: ready\nid: 0\ndata: {"topics":["workspace"],"version":0,"at":0}\n\n');
        req.on('close', endRes);
      } else {
        eventHub.attach({
          get closed() {
            return res.destroyed || res.writableEnded;
          },
          write: (c) => res.write(c),
          end: endRes,
          onClose: (cb) => req.on('close', cb),
        });
      }
      return true;
    }
    const reqStartAt = Date.now();
    try {
      const routeCtx = {
        req,
        res,
        route,
        input,
        json,
        service,
        tasks,
        taskTests,
        inspection,
        browserWindows,
        cleanup,
        groupInviter,
        groupBumper,
        groupPoster,
        bluestacks,
        autoScheduler,
        googleSheets,
        profileLifecycle,
        featureExecution: fe,
        isProfileOnline,
        isCarrierBusy,
      };
      if (await handleFeatureModuleRoutes(routeCtx)) return true;
      const ok = (body: unknown, status = 200) => (json(res, status, body), true),
        sendRaw = (status: number, headers: Record<string, string>, body?: string | Buffer) => (
          res.writeHead(status, headers),
          res.end(body),
          true
        ),
        dispatchMap = async (
          map: Record<string, (() => Promise<unknown>) | undefined>,
          key = route,
        ) => {
          const fn = map[key];
          if (!fn) return false;
          const out = await fn();
          return res.writableEnded ? true : ok(out);
        };
      if (
        route === '/api/workspace/window-layout' &&
        (req.method === 'GET' || req.method === 'POST')
      ) {
        const layout = needSvc(windowLayout, 'WINDOW_LAYOUT_UNAVAILABLE', '窗口布局服务未加载');
        if (req.method === 'POST') cleanup?.assertNotResetting();
        try {
          return ok(req.method === 'GET' ? await layout.snapshot() : await layout.command(input));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('WINDOW_LAYOUT_'))
            throw new ProductError(error.message, windowLayoutMessage(error.message), 409);
          throw error;
        }
      }
      if (mediaComponent && route === '/api/workspace/media-component') {
        if (req.method === 'POST') {
          cleanup?.assertNotResetting();
          const { action } = obj({ action: z.enum(['install', 'cancel']) }).parse(input);
          if (action === 'cancel') mediaComponent.cancel();
          else {
            backups?.assertIdle();
            await mediaComponent.start();
          }
        }
        return ok(await mediaComponent.status());
      }
      if (req.method === 'GET') {
        const sp = new URL(req.url ?? '/', 'http://localhost').searchParams,
          gs = (k: string, fb = '') => sp.get(k) ?? fb,
          intOpt = (k: string) => {
            const n = Number(sp.get(k) || NaN);
            return Number.isSafeInteger(n) ? n : undefined;
          };
        if (route === '/api/workspace/post-bump-records') {
          return ok(
            postBumpRecords
              ? await postBumpRecords.list(
                  PostBumpRecordQuerySchema.parse({
                    recordType: gs('recordType', 'all'),
                    carrier: gs('carrier', 'all'),
                    status: gs('status', 'all'),
                    search: gs('search'),
                    accountQuery: gs('accountQuery'),
                    groupQuery: gs('groupQuery'),
                    pageQuery: gs('pageQuery'),
                    postUrlQuery: gs('postUrlQuery'),
                    from: intOpt('from'),
                    to: intOpt('to'),
                    limit: intOpt('limit') ?? 200,
                    offset: intOpt('offset') ?? 0,
                  }),
                )
              : {
                  records: [],
                  total: 0,
                  hasMore: false,
                  statusCounts: { total: 0, confirmed: 0, pending: 0, failed: 0 },
                },
          );
        }
        if (route === '/api/workspace/activity-stats') {
          return ok(
            activityStats
              ? await activityStats.queryStats({
                  from: intOpt('from'),
                  to: intOpt('to'),
                  carrier: gs('carrier', 'all') as 'all' | 'browser' | 'bluestacks',
                  groupBy: gs('groupBy', 'profile') as 'profile' | 'account',
                  search: gs('search'),
                  onlyActive: sp.get('onlyActive') === '1' || sp.get('onlyActive') === 'true',
                })
              : { totals: emptyActivityTotals(), rows: [] },
          );
        }
        if (route === '/api/workspace/browser-risk-limits')
          return ok(
            await needSvc(
              activityStats,
              'ACTIVITY_STATS_UNAVAILABLE',
              '日限额与统计服务尚未加载',
            ).browserRiskLimitsState(),
          );
        if (route === '/api/workspace/inviter-records') {
          return ok(
            groupInviter
              ? await groupInviter.queryEnrichedLogs({
                  carrier: gs('carrier', 'all') as 'all' | 'browser' | 'bluestacks',
                  confirmation: gs('confirmation', 'CONFIRMED') as 'all' | 'CONFIRMED' | 'PENDING',
                  accountQuery: gs('accountQuery'),
                  groupQuery: gs('groupQuery'),
                  friendQuery: gs('friendQuery'),
                  from: intOpt('from'),
                  to: intOpt('to'),
                  limit: intOpt('limit') ?? 200,
                  offset: intOpt('offset') ?? 0,
                })
              : { records: [], total: 0, hasMore: false },
          );
        }
        if (cleanup && route === '/api/workspace/record-avatar') {
          const image = await cleanup.recordAvatar(
              z.enum(['account', 'page', 'group']).parse(sp.get('kind')),
              z.string().min(1).max(200).parse(sp.get('id')),
            ),
            inline =
              image && /^data:(image\/(?:jpeg|webp|png|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
          return inline
            ? sendRaw(
                200,
                {
                  'content-type': inline[1] ?? 'image/jpeg',
                  'cache-control': 'private,max-age=300',
                  'x-content-type-options': 'nosniff',
                },
                Buffer.from(inline[2] ?? '', 'base64'),
              )
            : image?.startsWith('https://')
              ? sendRaw(302, { location: image, 'cache-control': 'private,max-age=60' })
              : sendRaw(
                  200,
                  { 'content-type': 'image/svg+xml', 'cache-control': 'private,max-age=60' },
                  DEFAULT_AVATAR_SVG,
                );
        }
        if (
          await dispatchMap({
            '/api/workspace/update/status': () =>
              needSvc(softwareUpdate, 'UPDATER_UNAVAILABLE', '当前服务未启用更新器').status(),
            ...(cleanup
              ? {
                  '/api/workspace/data-cleanup/progress': () => Promise.resolve(cleanup.progress()),
                  '/api/workspace/data-cleanup/settings': () => cleanup.settings(),
                  '/api/workspace/data-cleanup/reset-status': () => cleanup.resetStatus(),
                }
              : {}),
            ...(maintenance
              ? {
                  '/api/workspace/maintenance': () => maintenance.snapshot(),
                  '/api/workspace/maintenance/logs': () => maintenance.export(),
                }
              : {}),
            '/api/workspace/preferences': () => service.preferences(),
            '/api/workspace/backups/status': async () =>
              (await backups?.status()) ?? {
                available: false,
                busy: false,
                canCreate: false,
                reason: '数据备份服务尚未加载',
              },
            '/api/workspace/backups/restore-status': async () =>
              (await backups?.restoreStatus()) ?? {
                available: false,
                state: 'NONE',
                reason: '恢复服务未加载',
                safetyDirectory: '',
              },
            '/api/workspace/materials/cache': cacheManagement
              ? () => cacheManagement.snapshot()
              : undefined,
            '/api/workspace/materials/usage': materialUsage
              ? () => materialUsage.snapshot()
              : undefined,
          })
        )
          return true;
      }
      if (req.method === 'POST') {
        cleanup?.assertNotResetting();
        if (
          cleanup &&
          route.startsWith('/api/workspace/data-cleanup/') &&
          (await dispatchMap(
            {
              preview: () => cleanup.preview(input),
              execute: () => cleanup.execute(input),
              settings: () => cleanup.saveSettings(input),
              compact: () => cleanup.compact(),
              reset: () => cleanup.resetAll(input),
            },
            route.slice('/api/workspace/data-cleanup/'.length),
          ))
        )
          return true;
        if (
          route.startsWith('/api/workspace/update/') ||
          route.startsWith('/api/workspace/extensions/') ||
          route.startsWith('/api/workspace/ai-workspace/')
        ) {
          const updater = needSvc(softwareUpdate, 'UPDATER_UNAVAILABLE', '当前服务未启用更新器');
          if (
            await dispatchMap({
              '/api/workspace/update/status': () => updater.status(),
              '/api/workspace/update/check': () => updater.check(),
              '/api/workspace/update/config': () => updater.configure(input),
              '/api/workspace/update/apply': () => updater.apply(),
              '/api/workspace/extensions/reload': () =>
                updater.reload(ExtensionReloadRequest.parse(input ?? {}).profileIds),
              '/api/workspace/ai-workspace/open-dir': () => updater.openAiWorkspace(),
              '/api/workspace/extensions/open-dir': () => updater.openDirectory(),
            })
          )
            return true;
        }
        const sOpt = z.string().max(1024).optional(),
          sNote = z.string().max(1000).optional(),
          save = async (run: unknown) => (await Promise.resolve(run), { saved: true }),
          needBackup = () => needSvc(backups, 'BACKUP_UNAVAILABLE', '请更新软件以使用数据备份'),
          needRestore = () => needSvc(backups, 'RESTORE_UNAVAILABLE', '恢复服务未加载');
        if (
          await dispatchMap({
            '/api/workspace/post-bump-records/delete': async () => {
              if (!postBumpRecords) return { deleted: 0 };
              const b = strictObj({
                ids: z.array(z.string().min(1)).max(1000).optional(),
                clearAll: z.boolean().optional(),
                recordType: PostBumpRecordQueryType.optional(),
              }).parse(input ?? {});
              return b.clearAll
                ? postBumpRecords.clear(b.recordType)
                : postBumpRecords.deleteByIds(b.ids ?? []);
            },
            '/api/workspace/inviter-records/delete': async () =>
              groupInviter ? groupInviter.deleteLogs(input ?? {}) : { deleted: 0 },
            '/api/workspace/browser-risk-limits': async () => {
              const svc = needSvc(
                activityStats,
                'ACTIVITY_STATS_UNAVAILABLE',
                '日限额与统计服务尚未加载',
              );
              await svc.saveBrowserRiskLimits(input ?? {});
              return svc.browserRiskLimitsState();
            },
            '/api/workspace/diagnostics/snapshot': captureDiagnostics
              ? async () => ({
                  recorded: true,
                  ...(await captureDiagnostics(
                    strictObj({
                      note: sNote,
                      uiContext: sNote,
                      targetDir: sOpt,
                      reveal: z.boolean().optional(),
                    }).parse(input ?? {}),
                  )),
                })
              : undefined,
            '/api/workspace/diagnostics/reveal': revealDiagnostics
              ? async () => {
                  const p = strictObj({ fileName: sOpt, targetDir: sOpt }).parse(input ?? {});
                  return { revealed: true, ...(await revealDiagnostics(p.fileName, p.targetDir)) };
                }
              : undefined,
            '/api/workspace/maintenance/settings': maintenance
              ? async () => maintenance.update(input)
              : undefined,
            '/api/workspace/preferences': () => service.updatePreferences(input),
            '/api/workspace/profiles/reorder': async () => {
              const v = strictObj({
                groupId: Id.nullable(),
                orderedProfileIds: z.array(Id).max(10000),
              }).parse(input);
              await service.requireProfiles(v.orderedProfileIds);
              return save(service.repository.reorderProfiles?.(v.orderedProfileIds, v.groupId));
            },
            '/api/workspace/groups/reorder': () =>
              save(
                service.repository.reorderGroups?.(
                  strictObj({ orderedGroupIds: z.array(Id).max(500) }).parse(input).orderedGroupIds,
                ),
              ),
            '/api/workspace/groups/create': async () => {
              const v = CreateGroup.parse(input);
              return ok(await service.repository.createGroup(v.name, v.color), 201);
            },
            '/api/workspace/groups/rename': () => {
              const v = RenameGroup.parse(input);
              return save(service.repository.renameGroup(v.groupId, v.name));
            },
            '/api/workspace/groups/delete': async () => ({
              deleted: true,
              movedProfiles: await service.repository.deleteGroup(DeleteGroup.parse(input).groupId),
            }),
            '/api/workspace/profiles/rename': () => {
              const v = RenameProfile.parse(input);
              return save(service.renameProfile(v.profileId, v.alias));
            },
            '/api/workspace/software/restart': async () => {
              const ctrl = needSvc(
                  softwareControl,
                  'SOFTWARE_RESTART_UNAVAILABLE',
                  '当前不是桌面软件，请使用正常软件入口',
                ),
                activeLabels = (await fe.activeModuleLabels()) ?? [];
              if (activeLabels.length > 0 || (await tasks?.hasActiveExecution()))
                failError(
                  'TASKS_ACTIVE',
                  activeLabels.length > 0
                    ? `请先停止或暂停正在运行的任务（${activeLabels.join('、')}），再重启软件`
                    : '请先停止或暂停任务，再重启软件',
                  409,
                );
              backups?.assertNotBusy();
              ok({ requested: true });
              ctrl.restart();
            },
            '/api/workspace/backups/create': () => needBackup().create(input),
            '/api/workspace/backups/inspect-restore': () => needRestore().inspectRestore(input),
            '/api/workspace/backups/prepare-restore': () => needRestore().prepareRestore(input),
          })
        )
          return true;
      }
      if (await handleTaskRoutes(routeCtx)) return true;
      if (
        route === '/api/workspace/resource-tables/summaries' &&
        req.method === 'GET' &&
        resources
      ) {
        const c = req.headers[RESOURCE_SUMMARY_HEADER];
        if (c !== undefined && c !== '2')
          throw new ProductError('RESOURCE_SUMMARY_VERSION_UNSUPPORTED', '请更新资源列表界面', 409);
        return ok(c === '2' ? await resources.usageSummaries() : await resources.summaries());
      }
      if (
        req.method === 'POST' &&
        (route.startsWith('/api/workspace/materials/') ||
          route.startsWith('/api/workspace/resource-tables/'))
      ) {
        const needRes = () => needSvc(resources, 'RESOURCES_UNAVAILABLE', '资源表服务未启用'),
          connected = (errCode: string) => () => {
            if (req.aborted || res.destroyed) throw Error(errCode);
          };
        if (
          await dispatchMap({
            '/api/workspace/materials/cache/clean': () =>
              needSvc(cacheManagement, 'CACHE_CLEANUP_UNAVAILABLE', '缓存管理服务未加载').clean(
                input,
              ),
            '/api/workspace/materials/usage/clear': () =>
              needSvc(
                materialUsage,
                'MATERIAL_USAGE_UNAVAILABLE',
                '素材使用记录服务未启用，请更新软件',
              ).clear(input),
            '/api/workspace/resource-tables/read': () => needRes().read(input),
            '/api/workspace/resource-tables/save': () => needRes().save(input),
          })
        )
          return true;
        if (route === '/api/workspace/resource-tables/media') {
          const checkAlive = connected('RESOURCE_PREVIEW_CLIENT_CLOSED');
          await needRes().previewMedia(input, checkAlive, async ({ bytes, contentType }) => {
            checkAlive();
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
              res.end(bytes, () => (res.removeListener('close', closed), resolve()));
            });
          });
          return true;
        }
        if (
          route === '/api/workspace/resource-tables/download' ||
          route === '/api/workspace/resource-tables/check'
        ) {
          const svc = needRes(),
            downloading = route.endsWith('/download'),
            checkAlive = connected('RESOURCE_CHECK_CLIENT_CLOSED'),
            isStream = req.headers.accept === 'application/x-ndjson';
          if (downloading && !isStream)
            throw new ProductError('RESOURCE_DOWNLOAD_STREAM_REQUIRED', '请更新资源下载界面', 409);
          if (!isStream) return ok(await svc.checkSources(input, checkAlive));
          const frame = async (value: unknown) => {
            checkAlive();
            if (!res.headersSent)
              res.writeHead(200, {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              });
            await new Promise<void>((resolve, reject) =>
              res.write(JSON.stringify(value) + '\n', (e) => (e ? reject(e) : resolve())),
            );
            checkAlive();
          };
          try {
            const onProgress = (p: unknown) => frame({ kind: 'progress', ...(p as object) }),
              report = downloading
                ? await svc.downloadSources(input, checkAlive, onProgress)
                : await svc.checkSources(input, checkAlive, onProgress);
            await frame({ kind: 'completed', report });
          } catch (error) {
            if (!res.headersSent) throw error;
            if (!res.destroyed)
              await frame({
                kind: 'failed',
                code:
                  error instanceof ProductError
                    ? error.code
                    : downloading
                      ? 'RESOURCE_DOWNLOAD_INTERRUPTED'
                      : 'RESOURCE_CHECK_FAILED',
                error: error instanceof ProductError ? error.message : '检查未完成；已保存资源保持',
              });
          }
          if (!res.destroyed) res.end();
          return true;
        }
      }
      if (req.method === 'GET' && route === '/api/workspace')
        return ok(WorkspaceSchema.parse(await service.snapshot()));
      if (req.method !== 'POST')
        return ok({ code: 'METHOD_NOT_ALLOWED', error: '不支持的请求方式' }, 405);
      const repo = service.repository;
      if (route === '/api/workspace/combinations/create')
        return ok(await repo.createCombination(CreateCombination.parse(input).value), 201);
      if (route === '/api/workspace/combinations/save') {
        const value = SaveCombination.parse(input);
        if (!repo.saveCombination)
          throw new ProductError('SAVE_COMBINATION_UNSUPPORTED', '当前存储不支持直接保存组合', 501);
        return ok(await repo.saveCombination(value.id, value.expectedRevision, value.value));
      }
      if (route === '/api/workspace/combinations/delete') {
        const value = DeleteCombination.parse(input);
        if (
          (await tasks?.livePlans())?.some(
            (p) =>
              p.combinationId === value.id && !['STOPPED', 'COMPLETED', 'FAILED'].includes(p.state),
          )
        )
          failError(
            'COMBINATION_TASK_ACTIVE',
            '该任务组合正在运行或排队中，请先停止相关任务后再删除',
            409,
          );
        return ok({ deleted: true, ...(await service.deleteCombination(value.id)) });
      }
      json(res, 404, { code: 'NOT_FOUND', error: '接口不存在' });
    } catch (error) {
      devDiag.emit('ERROR', 'HTTP_API', 'HTTP_REQUEST_ERROR', {
        durationMs: Date.now() - reqStartAt,
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
      else if (isZodValidationError(error))
        json(res, 400, {
          code: 'VALIDATION_FAILED',
          error: '参数不符合规则',
          issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      else {
        console.error('Workspace request failed', error);
        json(res, 500, { code: 'INTERNAL_ERROR', error: '保存失败，请查看本机日志' });
      }
    } finally {
      if (req.method === 'POST' && res.statusCode > 0 && res.statusCode < 400 && eventHub) {
        const topics = inferEventTopicsForRoute(route);
        if (topics.length > 0) eventHub.emit(topics, route);
      }
      if (req.method === 'POST' && !skipPostDiag.has(route)) {
        const durationMs = Date.now() - reqStartAt;
        devDiag.emit(durationMs >= 2000 ? 'SLOW' : 'INFO', 'HTTP_API', 'HTTP_POST_COMPLETED', {
          durationMs,
          data: { route, statusCode: res.statusCode },
        });
      }
    }
    return true;
  };
}
