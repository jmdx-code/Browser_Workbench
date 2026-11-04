import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DataCleanupService } from '../../application/data-cleanup.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import type { MediaComponentPort } from '../../application/media-component.js';
import type { SoftwareUpdateService } from '../../application/software-update-service.js';
import type { TaskService } from '../../application/task-service.js';
import type { WorkspaceBackupService } from '../../application/workspace-backup-service.js';
import type { WorkspaceMaintenance } from '../../application/workspace-maintenance.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import type { Awaitable } from '../../domain/persistence.js';
import { ProductError } from '../../domain/workspace.js';
import {
  CreateGroup,
  DeleteGroup,
  MoveProfiles,
  RenameGroup,
  RenameProfile,
} from '../../shared/contracts.js';
import { ExtensionReloadRequest } from '../../shared/software-update.js';
import { windowLayoutMessage, type WindowLayoutPort } from '../../shared/window-layout.js';
import type { DiagnosticCaptureInput, DiagnosticCaptureOutput } from '../workspace-api.js';

export interface SystemMaintenanceRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  service: WorkspaceService;
  tasks?: TaskService | undefined;
  backups?: WorkspaceBackupService | undefined;
  softwareControl?: { restart: () => void } | undefined;
  maintenance?: WorkspaceMaintenance | undefined;
  groupInviter?: GroupInviterService | undefined;
  groupBumper?: GroupBumperService | undefined;
  groupPoster?: GroupPosterService | undefined;
  featureExecution?: FeatureExecutionRegistry | undefined;
  captureDiagnostics?:
    ((input?: DiagnosticCaptureInput) => Awaitable<DiagnosticCaptureOutput>) | undefined;
  revealDiagnostics?:
    | ((fileName?: string, targetDir?: string) => Awaitable<{ filePath: string; fileName: string }>)
    | undefined;
  cleanup?: DataCleanupService | undefined;
  windowLayout?: WindowLayoutPort | undefined;
  mediaComponent?: MediaComponentPort | undefined;
  softwareUpdate?: SoftwareUpdateService | undefined;
}

export async function handleSystemMaintenanceRoutes(
  ctx: SystemMaintenanceRouteContext,
): Promise<boolean> {
  const {
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
    featureExecution,
    captureDiagnostics,
    revealDiagnostics,
    cleanup,
    windowLayout,
    mediaComponent,
    softwareUpdate,
  } = ctx;

  if (route === '/api/workspace/window-layout' && (req.method === 'GET' || req.method === 'POST')) {
    if (!windowLayout)
      throw new ProductError('WINDOW_LAYOUT_UNAVAILABLE', '窗口布局服务未加载', 409);
    if (req.method === 'POST') cleanup?.assertNotResetting();

    try {
      json(
        res,
        200,
        req.method === 'GET' ? await windowLayout.snapshot() : await windowLayout.command(input),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WINDOW_LAYOUT_'))
        throw new ProductError(error.message, windowLayoutMessage(error.message), 409);
      throw error;
    }
    return true;
  }

  if (req.method === 'GET' && route === '/api/workspace/update/status') {
    if (!softwareUpdate) throw new ProductError('UPDATER_UNAVAILABLE', '当前服务未启用更新器', 409);
    json(res, 200, await softwareUpdate.status());
    return true;
  }

  if (mediaComponent && route === '/api/workspace/media-component') {
    if (req.method === 'POST') {
      cleanup?.assertNotResetting();
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
    cleanup?.assertNotResetting();
    const parsed = z
      .object({
        note: z.string().max(1000).optional(),
        uiContext: z.string().max(1000).optional(),
        targetDir: z.string().max(1024).optional(),
        reveal: z.boolean().optional(),
      })
      .strict()
      .parse(input ?? {});
    const snapshot = await captureDiagnostics(parsed);
    json(res, 200, { recorded: true, ...snapshot });
    return true;
  }

  if (req.method === 'POST' && route === '/api/workspace/diagnostics/reveal' && revealDiagnostics) {
    cleanup?.assertNotResetting();
    const parsed = z
      .object({
        fileName: z.string().max(1024).optional(),
        targetDir: z.string().max(1024).optional(),
      })
      .strict()
      .parse(input ?? {});
    const revealed = await revealDiagnostics(parsed.fileName, parsed.targetDir);
    json(res, 200, { revealed: true, ...revealed });
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
      cleanup.assertNotResetting();
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
    cleanup?.assertNotResetting();
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
    cleanup?.assertNotResetting();
    json(res, 200, await service.updatePreferences(input));
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

  if (req.method !== 'POST') return false;

  switch (route) {
    case '/api/workspace/profiles/reorder': {
      cleanup?.assertNotResetting();
      const value = z
        .object({
          groupId: z.uuid().nullable(),
          orderedProfileIds: z.array(z.uuid()).max(10000),
        })
        .strict()
        .parse(input);
      await service.requireProfiles(value.orderedProfileIds);
      await service.repository.reorderProfiles?.(value.orderedProfileIds, value.groupId);
      json(res, 200, { saved: true });
      return true;
    }
    case '/api/workspace/groups/reorder': {
      cleanup?.assertNotResetting();
      const value = z
        .object({ orderedGroupIds: z.array(z.uuid()).max(500) })
        .strict()
        .parse(input);
      await service.repository.reorderGroups?.(value.orderedGroupIds);
      json(res, 200, { saved: true });
      return true;
    }
    case '/api/workspace/groups/create': {
      cleanup?.assertNotResetting();
      const value = CreateGroup.parse(input);
      json(res, 201, await service.repository.createGroup(value.name, value.color));
      return true;
    }
    case '/api/workspace/groups/rename': {
      cleanup?.assertNotResetting();
      const value = RenameGroup.parse(input);
      await service.repository.renameGroup(value.groupId, value.name);
      json(res, 200, { saved: true });
      return true;
    }
    case '/api/workspace/groups/delete': {
      cleanup?.assertNotResetting();
      const value = DeleteGroup.parse(input);
      json(res, 200, {
        deleted: true,
        movedProfiles: await service.repository.deleteGroup(value.groupId),
      });
      return true;
    }
    case '/api/workspace/profiles/move': {
      cleanup?.assertNotResetting();
      const value = MoveProfiles.parse(input);
      await service.moveProfiles(value.profileIds, value.groupId);
      json(res, 200, { saved: true });
      return true;
    }
    case '/api/workspace/profiles/rename': {
      cleanup?.assertNotResetting();
      const value = RenameProfile.parse(input);
      await service.renameProfile(value.profileId, value.alias);
      json(res, 200, { saved: true });
      return true;
    }
    case '/api/workspace/software/restart': {
      cleanup?.assertNotResetting();
      if (!softwareControl)
        throw new ProductError(
          'SOFTWARE_RESTART_UNAVAILABLE',
          '当前不是桌面软件，请使用正常软件入口',
          409,
        );
      const activeLabels = (await featureExecution?.activeModuleLabels()) ?? [];
      if (activeLabels.length > 0 || (await tasks?.hasActiveExecution()))
        throw new ProductError(
          'TASKS_ACTIVE',
          activeLabels.length > 0
            ? `请先停止或暂停正在运行的任务（${activeLabels.join('、')}），再重启软件`
            : '请先停止或暂停任务，再重启软件',
          409,
        );
      backups?.assertIdle();
      json(res, 200, { requested: true });
      softwareControl.restart();
      return true;
    }
    case '/api/workspace/update/status':
    case '/api/workspace/update/check':
    case '/api/workspace/update/config':
    case '/api/workspace/update/apply':
    case '/api/workspace/extensions/reload':
    case '/api/workspace/extensions/open-dir': {
      cleanup?.assertNotResetting();
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
                ? await softwareUpdate.reload(ExtensionReloadRequest.parse(input ?? {}).profileIds)
                : await softwareUpdate.openDirectory();
      json(res, 200, result);
      return true;
    }
    case '/api/workspace/backups/create': {
      cleanup?.assertNotResetting();
      if (!backups) throw new ProductError('BACKUP_UNAVAILABLE', '请更新软件以使用数据备份', 409);
      json(res, 200, await backups.create(input));
      return true;
    }
    case '/api/workspace/backups/inspect-restore': {
      cleanup?.assertNotResetting();
      if (!backups) throw new ProductError('RESTORE_UNAVAILABLE', '恢复服务未加载', 409);
      json(res, 200, await backups.inspectRestore(input));
      return true;
    }
    case '/api/workspace/backups/prepare-restore': {
      cleanup?.assertNotResetting();
      if (!backups) throw new ProductError('RESTORE_UNAVAILABLE', '恢复服务未加载', 409);
      json(res, 200, await backups.prepareRestore(input));
      return true;
    }
    default:
      return false;
  }
}
