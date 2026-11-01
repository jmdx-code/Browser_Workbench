import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArchiveManagementService } from '../../application/archive-management.js';
import type { DataCleanupService } from '../../application/data-cleanup.js';
import type { MaterialCacheManagement } from '../../application/material-cache-management.js';
import type { MaterialPreflightService } from '../../application/material-preflight.js';
import type { MaterialUsageService } from '../../application/material-usage-service.js';
import type { ResourceTableService } from '../../application/resource-table-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import { ProductError } from '../../domain/workspace.js';
import { ArchiveListRequest, ArchiveResumeRequest } from '../../shared/archive-management.js';
import { MATERIAL_PREVIEW_HEADER } from '../../shared/materials.js';
import { RESOURCE_SUMMARY_HEADER } from '../../shared/resource-table.js';

export interface MaterialResourceRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  service: WorkspaceService;
  materials?: MaterialPreflightService | undefined;
  resources?: ResourceTableService | undefined;
  archives?: ArchiveManagementService | undefined;
  materialUsage?: MaterialUsageService | undefined;
  cacheManagement?: MaterialCacheManagement | undefined;
  cleanup?: DataCleanupService | undefined;
}

export async function handleMaterialResourceRoutes(
  ctx: MaterialResourceRouteContext,
): Promise<boolean> {
  const {
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
  } = ctx;

  if (req.method === 'GET' && route === '/api/workspace/materials/cache' && cacheManagement) {
    json(res, 200, await cacheManagement.snapshot());
    return true;
  }
  if (req.method === 'GET' && route === '/api/workspace/materials/usage' && materialUsage) {
    json(res, 200, await materialUsage.snapshot());
    return true;
  }
  if (req.method === 'GET' && route === '/api/workspace/resource-tables/summaries' && resources) {
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

  if (req.method !== 'POST') return false;

  switch (route) {
    case '/api/workspace/materials/cache/clean': {
      cleanup?.assertNotResetting();
      if (!cacheManagement)
        throw new ProductError('CACHE_CLEANUP_UNAVAILABLE', '缓存管理服务未加载', 409);
      json(res, 200, await cacheManagement.clean(input));
      return true;
    }
    case '/api/workspace/materials/usage/clear': {
      cleanup?.assertNotResetting();
      if (!materialUsage)
        throw new ProductError(
          'MATERIAL_USAGE_UNAVAILABLE',
          '素材使用记录服务未启用，请更新软件',
          409,
        );
      json(res, 200, await materialUsage.clear(input));
      return true;
    }
    case '/api/workspace/archives/list':
    case '/api/workspace/archives/resume': {
      cleanup?.assertNotResetting();
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
      return true;
    }
    case '/api/workspace/resource-tables/download':
    case '/api/workspace/resource-tables/check': {
      cleanup?.assertNotResetting();
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
            res.write(JSON.stringify(value) + '\n', (error) => (error ? reject(error) : resolve())),
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
              error: error instanceof ProductError ? error.message : '检查未完成；已保存资源保持',
            });
            res.end();
          }
        }
        return true;
      }
      json(
        res,
        200,
        await resources.checkSources(input, () => {
          if (req.aborted || res.destroyed) throw Error('RESOURCE_CHECK_CLIENT_CLOSED');
        }),
      );
      return true;
    }
    case '/api/workspace/resource-tables/media': {
      cleanup?.assertNotResetting();
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
      return true;
    }
    case '/api/workspace/resource-tables/read':
    case '/api/workspace/resource-tables/save': {
      cleanup?.assertNotResetting();
      if (!resources) throw new ProductError('RESOURCES_UNAVAILABLE', '资源表服务未启用', 409);
      json(
        res,
        200,
        route.endsWith('/read') ? await resources.read(input) : await resources.save(input),
      );
      return true;
    }
    case '/api/workspace/materials/preflight': {
      cleanup?.assertNotResetting();
      if (!materials)
        throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
      json(
        res,
        200,
        req.headers[MATERIAL_PREVIEW_HEADER] === '1'
          ? await materials.inspectForPreview(input)
          : await materials.inspect(input),
      );
      return true;
    }
    case '/api/workspace/materials/preview': {
      cleanup?.assertNotResetting();
      if (!materials)
        throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
      json(res, 200, materials.preview(input));
      return true;
    }
    case '/api/workspace/materials/arrangement': {
      cleanup?.assertNotResetting();
      if (!materials)
        throw new ProductError('MATERIAL_PREFLIGHT_UNAVAILABLE', '素材预检服务未启用', 409);
      json(res, 200, materials.arrangement(input, (await service.snapshot()).profiles));
      return true;
    }
    case '/api/workspace/materials/review': {
      cleanup?.assertNotResetting();
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
      return true;
    }
    case '/api/workspace/materials/media': {
      cleanup?.assertNotResetting();
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
      return true;
    }
    default:
      return false;
  }
}
