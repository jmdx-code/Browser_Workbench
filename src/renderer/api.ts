import { MediaComponentStatus } from '../shared/media-component.js';
import {
  SoftwareUpdateStatus,
  ExtensionReloadResult,
  type UpdateConfiguration,
} from '../shared/software-update.js';
import { CleanupPreview, CleanupResult, CleanupSettings } from '../shared/data-cleanup.js';
import {
  WorkspaceBackupResult,
  WorkspaceBackupStatus,
  WorkspaceRestoreInspection,
  WorkspaceRestoreStatus,
} from '../shared/workspace-backup.js';
import { TASK_CAPACITY_HEADER, TASK_CAPACITY_VERSION } from '../shared/task-capacity.js';
import { SavedCombinationSchema, WorkspaceSchema, StopResultsSchema } from '../shared/contracts.js';
import type { Combination } from '../shared/contracts.js';
import {
  TaskOverview,
  TaskHistory,
  TaskRecords,
  TaskRuntimeOverview,
  TaskCapabilities,
  TaskStartResult,
  TaskCommandResult,
  SchedulerSettings,
  type Settings,
  type TaskCommand,
  type Assignment,
} from '../shared/task-contracts.js';
import { TaskFeatureOverviewV2, FEATURE_CONTRACT_HEADER } from '../shared/task-features.js';
import { TaskTestResult, type TestRequest } from '../shared/task-tests.js';
import { ShowBrowserResult, CleanupProfileTabsResult } from '../shared/browser-window.js';
import {
  WindowLayoutOverview,
  windowLayoutMessage,
  WindowLayoutCommand,
} from '../shared/window-layout.js';
import { WorkspacePreferences, type PreferenceUpdate } from '../shared/workspace-preferences.js';
import {
  MaintenanceOverview,
  RuntimeLogExport,
  type MaintenanceUpdate,
} from '../shared/runtime-log.js';
import {
  MaterialCacheOverview,
  MaterialCacheCleanResult,
} from '../shared/material-cache-management.js';
import {
  MaterialPreviewScan,
  MaterialPackagePreview,
  MATERIAL_PREVIEW_HEADER,
  type PackagePreview,
  materialMediaPreviewLimits,
  MaterialPublishingReview,
} from '../shared/materials.js';
import { ProfileInspections, INSPECTION_DISPLAY_HEADER } from '../shared/profile-inspection.js';
import { NativeReviewReport, NativeReleaseResult } from '../shared/native-review.js';
import {
  BridgeConnectionHealth,
  BridgeConnectionRecoveryResult,
} from '../shared/bridge-connection-health.js';
import { MaterialArrangement, type ArrangementRequest } from '../shared/material-arrangement.js';
import {
  ResourceTable,
  ResourceUsageSummaries,
  RESOURCE_SUMMARY_HEADER,
  type ResourceRowValue,
} from '../shared/resource-table.js';
import {
  ResourceSourceReport,
  type ResourceCheckProgressValue,
} from '../shared/resource-source.js';
import { readResourceCheckStream } from './resource-source-stream.js';
import { readResourceDownloadStream } from './resource-download-stream.js';
import type { ResourceDownloadProgressValue } from '../shared/resource-download.js';
import {
  MaterialUsageSnapshot,
  ClearedMaterialUsage,
  type MaterialUsageClearRequest,
} from '../shared/material-usage.js';
import { ArchiveManagementList } from '../shared/archive-management.js';
import {
  GroupInviterState,
  type AddInviterGroupsRequest,
  type DeleteInviterGroupsRequest,
  type StartGroupInviterRequest,
  type StopGroupInviterProfilesRequest,
  type UpdateGroupInviterSettingsRequest,
} from '../shared/group-inviter.js';
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
async function request(
  route: string,
  input?: unknown,
  signal?: AbortSignal,
  root = '/api/workspace',
): Promise<unknown> {
  const headers: Record<string, string> = {};
  headers['x-workbench-workspace-contract'] = '6';
  headers[TASK_CAPACITY_HEADER] = TASK_CAPACITY_VERSION;
  if (route === '/tasks' || route.startsWith('/tasks/')) headers['x-workbench-task-contract'] = '4';
  if (route === '/tasks/records') headers['x-workbench-records-contract'] = '1';
  if (route.startsWith('/tasks/runtime')) headers['x-workbench-runtime-contract'] = '2';
  if (route === '/tasks/features') headers[FEATURE_CONTRACT_HEADER] = '2';
  if (input !== undefined) headers['content-type'] = 'application/json';
  if (route === '/profiles/inspect' || route === '/profiles/inspection')
    headers[INSPECTION_DISPLAY_HEADER] = '2';
  if (route === '/materials/preflight') headers[MATERIAL_PREVIEW_HEADER] = '1';
  if (route === '/resource-tables/summaries') headers[RESOURCE_SUMMARY_HEADER] = '2';
  const options: RequestInit =
    input === undefined
      ? { cache: 'no-store', signal, headers }
      : {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
          signal,
        };
  let response = await fetch(root + route, options);
  let result: unknown = await response.json();
  if (
    response.status === 401 &&
    root === '/api/workspace' &&
    route === '' &&
    input === undefined &&
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    result.error === 'ADMIN_REQUIRED'
  ) {
    // Restore only the normal same-origin bootstrap cookie. Never replay a command.
    const bootstrap = await fetch('/workbench/', {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
    });
    if (bootstrap.ok) {
      response = await fetch(root + route, options);
      result = await response.json();
    }
  }
  if (!response.ok) {
    const error = result as { code?: string; error?: string };
    throw new ApiError(error.code ?? 'REQUEST_FAILED', error.error ?? '请求失败');
  }
  return result;
}
export const api = {
  softwareUpdateStatus: async () => SoftwareUpdateStatus.parse(await request('/update/status')),
  checkSoftwareUpdate: async () => SoftwareUpdateStatus.parse(await request('/update/check', {})),
  configureSoftwareUpdate: async (config: UpdateConfiguration) =>
    SoftwareUpdateStatus.parse(await request('/update/config', config)),
  applySoftwareUpdate: () => request('/update/apply', {}),
  reloadExtensions: async (profileIds?: string[]) =>
    ExtensionReloadResult.parse(
      await request('/extensions/reload', profileIds ? { profileIds } : {}),
    ),
  openExtensionDirectory: () => request('/extensions/open-dir', {}),
  cleanupProfileTabs: async (profileIds: string[], preferActiveTab = false) =>
    CleanupProfileTabsResult.parse(
      await request('/profiles/cleanup-tabs', { profileIds, preferActiveTab }),
    ),
  mediaComponent: async (action?: 'install' | 'cancel', signal?: AbortSignal) =>
    MediaComponentStatus.parse(
      await request(
        '/media-component',
        action ? { action } : undefined,
        signal ?? AbortSignal.timeout(15_000),
      ),
    ),
  windowLayout: async (input?: unknown) => {
    try {
      return WindowLayoutOverview.parse(
        await request(
          '/window-layout',
          input === undefined ? undefined : WindowLayoutCommand.parse(input),
          AbortSignal.timeout(60000),
        ),
      );
    } catch (e) {
      throw Error(
        e instanceof ApiError && e.code.startsWith('WINDOW_LAYOUT_')
          ? windowLayoutMessage(e.code)
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  },
  cleanupProgress: async () =>
    request('/data-cleanup/progress', undefined, AbortSignal.timeout(10000)) as Promise<{
      running: boolean;
      current: number;
      total: number;
    }>,
  cleanupPreview: async (input: unknown, signal?: AbortSignal) =>
    CleanupPreview.parse(await request('/data-cleanup/preview', input, signal)),
  cleanupExecute: async (token: string) =>
    CleanupResult.parse(
      await request('/data-cleanup/execute', { token, confirm: true }, AbortSignal.timeout(300000)),
    ),
  cleanupSettings: async (signal?: AbortSignal) =>
    CleanupSettings.parse(await request('/data-cleanup/settings', undefined, signal)),
  saveCleanupSettings: async (input: unknown) =>
    CleanupSettings.parse(
      await request('/data-cleanup/settings', input, AbortSignal.timeout(10000)),
    ),
  resetStatus: async (signal?: AbortSignal) =>
    (await request('/data-cleanup/reset-status', undefined, signal)) as {
      available: boolean;
      reason: string;
      dataDirectory: string;
    },
  resetWorkspace: async (input: unknown) =>
    request('/data-cleanup/reset', input, AbortSignal.timeout(15000)),
  compactData: async () => request('/data-cleanup/compact', {}, AbortSignal.timeout(300000)),
  maintenance: async (signal: AbortSignal) =>
    MaintenanceOverview.parse(await request('/maintenance', undefined, signal)),
  saveMaintenance: async (input: MaintenanceUpdate, signal: AbortSignal) =>
    MaintenanceOverview.parse(await request('/maintenance/settings', input, signal)),
  runtimeLogs: async (signal: AbortSignal) =>
    RuntimeLogExport.parse(await request('/maintenance/logs', undefined, signal)),
  workspacePreferences: async (signal?: AbortSignal) =>
    WorkspacePreferences.parse(await request('/preferences', undefined, signal)),
  saveWorkspacePreferences: async (input: PreferenceUpdate, signal?: AbortSignal) =>
    WorkspacePreferences.parse(await request('/preferences', input, signal)),
  bridgeConnectionHealth: async (signal: AbortSignal) =>
    BridgeConnectionHealth.parse(
      await request('/bridge-connection-health', undefined, signal, '/api'),
    ),
  recoverBridgeConnection: async (input: { id: string; profileId: string }) =>
    BridgeConnectionRecoveryResult.parse(
      await request('/bridge-connections/recover', input, AbortSignal.timeout(20_000), '/api'),
    ),
  showBrowser: async (profileId: string) =>
    ShowBrowserResult.parse(
      await request('/profiles/show', { profileId }, AbortSignal.timeout(55000)),
    ),
  restartSoftware: async () => request('/software/restart', {}, AbortSignal.timeout(10000)),
  releaseIdlePages: async (profileId: string) => {
    const result = await request(
      '/profiles/release-idle-pages',
      { profileId },
      AbortSignal.timeout(60000),
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      !('released' in result) ||
      typeof result.released !== 'number'
    )
      throw Error('占用处理回执无效');
    return NativeReleaseResult.parse(result);
  },
  testTask: async (input: TestRequest) =>
    TaskTestResult.parse(await request('/tasks/test', input, AbortSignal.timeout(20_000))),
  backupStatus: async (signal: AbortSignal) =>
    WorkspaceBackupStatus.parse(await request('/backups/status', undefined, signal)),
  createBackup: async (directory: string) =>
    WorkspaceBackupResult.parse(
      await request('/backups/create', { directory }, AbortSignal.timeout(310_000)),
    ),
  restoreStatus: async (signal: AbortSignal) =>
    WorkspaceRestoreStatus.parse(await request('/backups/restore-status', undefined, signal)),
  inspectRestore: async (directory: string) =>
    WorkspaceRestoreInspection.parse(
      await request('/backups/inspect-restore', { directory }, AbortSignal.timeout(310_000)),
    ),
  prepareRestore: async (directory: string) =>
    WorkspaceRestoreStatus.parse(
      await request('/backups/prepare-restore', { directory }, AbortSignal.timeout(310_000)),
    ),
  taskFeatures: async (signal: AbortSignal) =>
    TaskFeatureOverviewV2.parse(await request('/tasks/features', undefined, signal)),
  saveTaskSettings: async (input: Settings, signal: AbortSignal) =>
    SchedulerSettings.parse(await request('/tasks/settings', input, signal)),
  nativeReview: async (profileId: string, signal: AbortSignal) =>
    NativeReviewReport.parse(
      await request(
        '/profiles/native-review',
        { profileId },
        AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      ),
    ),
  taskCapabilities: async (signal: AbortSignal) =>
    TaskCapabilities.parse(await request('/tasks/capabilities', undefined, signal)),
  taskRuntime: async (signal: AbortSignal, cursor?: string) =>
    TaskRuntimeOverview.parse(
      await request(
        '/tasks/runtime' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        undefined,
        signal,
      ),
    ),
  startTasks: async (input: Assignment) =>
    TaskStartResult.parse(await request('/tasks/start', input, AbortSignal.timeout(15_000))),
  commandTasks: async (input: TaskCommand) =>
    TaskCommandResult.parse(await request('/tasks/command', input, AbortSignal.timeout(45_000))),
  archives: async (profileId: string, planId: string, signal: AbortSignal) =>
    ArchiveManagementList.parse(
      await request(
        '/archives/list',
        { profileId, planId },
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      ),
    ),
  materialUsage: async (signal: AbortSignal) =>
    MaterialUsageSnapshot.parse(await request('/materials/usage', undefined, signal)),
  materialCache: async (signal: AbortSignal) =>
    MaterialCacheOverview.parse(await request('/materials/cache', undefined, signal)),
  cleanMaterialCache: async (stageIds: string[]) =>
    MaterialCacheCleanResult.parse(
      await request('/materials/cache/clean', { stageIds }, AbortSignal.timeout(120_000)),
    ),
  clearMaterialUsage: async (input: MaterialUsageClearRequest) =>
    ClearedMaterialUsage.parse(
      await request('/materials/usage/clear', input, AbortSignal.timeout(15_000)),
    ),
  downloadResourceSources: async (
    combinationId: string,
    expectedRevision: number,
    signal: AbortSignal,
    rowIds: string[] | undefined,
    onProgress: (value: ResourceDownloadProgressValue) => void,
  ) => {
    const response = await fetch('/api/workspace/resource-tables/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ combinationId, expectedRevision, ...(rowIds ? { rowIds } : {}) }),
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(31 * 60_000)]),
    });
    if (!response.ok) {
      const value = (await response.json()) as { code?: string; error?: string };
      throw new ApiError(value.code ?? 'RESOURCE_DOWNLOAD_FAILED', value.error ?? '下载未完成');
    }
    if (!response.body || response.headers.get('content-type') !== 'application/x-ndjson')
      throw Error('下载响应不一致，请更新软件');
    const report = await readResourceDownloadStream(response.body, onProgress);
    if (report.combinationId !== combinationId || report.expectedRevision !== expectedRevision)
      throw Error('下载结果与资源表不匹配');
    return report;
  },
  checkResourceSources: async (
    combinationId: string,
    expectedRevision: number,
    signal: AbortSignal,
    rowIds?: string[],
    onProgress?: (value: ResourceCheckProgressValue) => void,
  ) => {
    if (onProgress) {
      const response = await fetch('/api/workspace/resource-tables/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ combinationId, expectedRevision, ...(rowIds ? { rowIds } : {}) }),
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
      });
      if (!response.ok) {
        const value = (await response.json()) as { code?: string; error?: string };
        throw new ApiError(value.code ?? 'RESOURCE_CHECK_FAILED', value.error ?? '资源检查未完成');
      }
      if (!response.body || response.headers.get('content-type') !== 'application/x-ndjson')
        throw Error('资源检查响应不一致，请更新软件');
      return readResourceCheckStream(response.body, onProgress);
    }
    return ResourceSourceReport.parse(
      await request(
        '/resource-tables/check',
        { combinationId, expectedRevision, ...(rowIds ? { rowIds } : {}) },
        AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      ),
    );
  },
  copyCombination: async (id: string) =>
    SavedCombinationSchema.parse(await request('/combinations/copy', { id })),
  resourceTable: async (combinationId: string) =>
    ResourceTable.parse(
      await request('/resource-tables/read', { combinationId }, AbortSignal.timeout(10_000)),
    ),
  resourceMedia: async (
    combinationId: string,
    expectedRevision: number,
    rowId: string,
    fileIndex: number,
    signal: AbortSignal,
  ) => {
    const response = await fetch('/api/workspace/resource-tables/media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ combinationId, expectedRevision, rowId, fileIndex }),
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
    });
    if (!response.ok) {
      const result = (await response.json()) as { code?: string; error?: string };
      throw new ApiError(
        result.code ?? 'RESOURCE_PREVIEW_FAILED',
        result.error ?? '媒体预览未完成',
      );
    }
    const type = response.headers.get('content-type');
    const length = Number(response.headers.get('content-length'));
    const role = type?.startsWith('image/') ? 'image' : 'video';
    if (
      !type ||
      !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime'].includes(type) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > materialMediaPreviewLimits[role]
    )
      throw Error('RESOURCE_PREVIEW_RESPONSE_MISMATCH');
    const blob = await response.blob();
    if (blob.size !== length || blob.type !== type)
      throw Error('RESOURCE_PREVIEW_RESPONSE_MISMATCH');
    return blob;
  },
  resourceSummaries: async () =>
    ResourceUsageSummaries.parse(
      await request('/resource-tables/summaries', undefined, AbortSignal.timeout(10_000)),
    ),
  saveResourceTable: async (
    combinationId: string,
    expectedRevision: number,
    rows: ResourceRowValue[],
  ) =>
    ResourceTable.parse(
      await request(
        '/resource-tables/save',
        { combinationId, expectedRevision, rows },
        AbortSignal.timeout(15_000),
      ),
    ),
  materialArrangement: async (input: ArrangementRequest, signal: AbortSignal) =>
    MaterialArrangement.parse(
      await request(
        '/materials/arrangement',
        input,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      ),
    ),
  materialReview: async (
    scanId: string,
    source: string,
    profileIds: string[],
    signal: AbortSignal,
  ) =>
    MaterialPublishingReview.parse(
      await request(
        '/materials/review',
        { scanId, source, profileIds },
        AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      ),
    ),
  materialMedia: async (preview: PackagePreview, fileIndex: number, signal: AbortSignal) => {
    const file = preview.files[fileIndex];
    if (!file || file.role === 'text' || file.bytes > materialMediaPreviewLimits[file.role])
      throw new ApiError('MATERIAL_PREVIEW_MEDIA_LIMIT', '媒体超过预览范围');
    const response = await fetch('/api/workspace/materials/media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanId: preview.scanId, source: preview.source, fileIndex }),
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    });
    if (!response.ok) {
      const result: unknown = await response.json();
      const error = result as { code?: string };
      throw new ApiError(error.code ?? 'REQUEST_FAILED', '媒体预览未完成');
    }
    const types =
      file.role === 'image'
        ? ['image/png', 'image/jpeg', 'image/webp']
        : ['video/mp4', 'video/quicktime'];
    const type = response.headers.get('content-type');
    if (
      !type ||
      !types.includes(type) ||
      response.headers.get('content-length') !== String(file.bytes)
    )
      throw Error('MATERIAL_MEDIA_MISMATCH');
    const blob = await response.blob();
    if (blob.size !== file.bytes || blob.type !== type) throw Error('MATERIAL_MEDIA_MISMATCH');
    return blob;
  },
  inspectProfiles: async (profileIds: string[]) =>
    ProfileInspections.parse(await request('/profiles/inspect', { profileIds })),
  profileInspections: async () =>
    ProfileInspections.parse(
      await request('/profiles/inspection', undefined, AbortSignal.timeout(10_000)),
    ),
  materialPreflight: async (directory: string) =>
    MaterialPreviewScan.parse(
      await request('/materials/preflight', { directory }, AbortSignal.timeout(40_000)),
    ),
  materialPreview: async (scanId: string, source: string) =>
    MaterialPackagePreview.parse(
      await request('/materials/preview', { scanId, source }, AbortSignal.timeout(10_000)),
    ),
  taskOverview: async (signal?: AbortSignal) =>
    TaskOverview.parse(await request('/tasks', undefined, signal)),
  taskHistory: async (
    profileId: string,
    planId: string | null,
    signal: AbortSignal,
    round?: number,
  ) =>
    TaskHistory.parse(
      await request(
        '/tasks/history',
        { profileId, ...(planId ? { planId } : {}), ...(round ? { round } : {}) },
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      ),
    ),
  taskRecords: async (
    input: {
      groupBy?: 'run';
      profileId?: string;
      status?: 'all' | 'running' | 'completed' | 'failed' | 'review';
      query?: string;
      cursor?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ) =>
    TaskRecords.parse(
      await request(
        '/tasks/records',
        input,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      ),
    ),
  snapshot: async (signal?: AbortSignal) =>
    WorkspaceSchema.parse(await request('', undefined, signal ?? AbortSignal.timeout(10_000))),
  createGroup: (name: string, color: string) => request('/groups/create', { name, color }),
  renameGroup: (groupId: string, name: string) => request('/groups/rename', { groupId, name }),
  deleteGroup: (groupId: string) => request('/groups/delete', { groupId }),
  move: (profileIds: string[], groupId: string | null) =>
    request('/profiles/move', { profileIds, groupId }),
  rename: (profileId: string, alias: string) => request('/profiles/rename', { profileId, alias }),
  deleteProfiles: (profileIds: string[]) =>
    request('/profiles/delete', { profileIds }, AbortSignal.timeout(15_000)),
  stop: async (profileIds: string[]) =>
    StopResultsSchema.parse(await request('/profiles/stop', { profileIds })),
  create: async (value: Combination) =>
    SavedCombinationSchema.parse(await request('/combinations/create', { value })),
  deleteCombination: (id: string) =>
    request('/combinations/delete', { id }, AbortSignal.timeout(15_000)),
  createDraft: async (value: Combination) =>
    SavedCombinationSchema.parse(await request('/combinations/create-draft', { value })),

  draft: async (id: string, expectedRevision: number, value: Combination) =>
    SavedCombinationSchema.parse(
      await request(
        '/combinations/draft',
        { id, expectedRevision, value },
        AbortSignal.timeout(10_000),
      ),
    ),
  publish: async (id: string, expectedRevision: number) =>
    SavedCombinationSchema.parse(await request('/combinations/publish', { id, expectedRevision })),
  discard: async (id: string, expectedRevision: number) =>
    SavedCombinationSchema.parse(await request('/combinations/discard', { id, expectedRevision })),
  start: (id: string, version: number, profileIds: string[]) =>
    request('/combinations/start', { id, version, profileIds }),
  groupInviterState: async (signal?: AbortSignal) =>
    GroupInviterState.parse(
      await request(
        '/group-inviter/state',
        undefined,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      ),
    ),
  addInviterGroups: async (input: AddInviterGroupsRequest) =>
    GroupInviterState.parse(
      await request('/group-inviter/groups/add', input, AbortSignal.timeout(15_000)),
    ),
  deleteInviterGroups: async (input: DeleteInviterGroupsRequest) =>
    GroupInviterState.parse(
      await request('/group-inviter/groups/delete', input, AbortSignal.timeout(15_000)),
    ),
  saveGroupInviterSettings: async (input: UpdateGroupInviterSettingsRequest) =>
    GroupInviterState.parse(
      await request('/group-inviter/settings', input, AbortSignal.timeout(10_000)),
    ),
  startGroupInviter: async (input: StartGroupInviterRequest) =>
    GroupInviterState.parse(
      await request('/group-inviter/start', input, AbortSignal.timeout(15_000)),
    ),
  stopGroupInviter: async () =>
    GroupInviterState.parse(await request('/group-inviter/stop', {}, AbortSignal.timeout(10_000))),
  stopGroupInviterProfiles: async (input: StopGroupInviterProfilesRequest) =>
    GroupInviterState.parse(
      await request('/group-inviter/stop-profiles', input, AbortSignal.timeout(10_000)),
    ),
  recordDiagnosticSnapshot: async (note?: string) =>
    (await request('/diagnostics/snapshot', note ? { note } : {}, AbortSignal.timeout(10_000))) as {
      recorded: boolean;
      filePath: string;
      entryId: number;
      at: string;
    },
};
