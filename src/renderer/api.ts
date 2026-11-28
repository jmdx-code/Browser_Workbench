import { ActivityStatsResponseSchema, type ActivityStatsQuery } from '../shared/activity-stats.js';
import type { AutoSchedulerState } from '../shared/auto-scheduler.js';
import type { BluestacksState } from '../shared/bluestacks.js';
import {
  BridgeConnectionHealth,
  BridgeConnectionRecoveryResult,
} from '../shared/bridge-connection-health.js';
import { CleanupProfileTabsResult, ShowBrowserResult } from '../shared/browser-window.js';
import {
  RuntimeSummarySchema,
  SavedCombinationSchema,
  WorkspaceSchema,
  type Combination,
} from '../shared/contracts.js';
import { CleanupPreview, CleanupResult, CleanupSettings } from '../shared/data-cleanup.js';
import {
  BrowserRiskLimitsStateSchema,
  type DailyRiskLimitSettings,
} from '../shared/daily-risk-limits.js';
import type {
  GoogleAuthStatus,
  GoogleSheetLink,
  GoogleSheetsOverview,
  LibrarySyncSummary,
  SheetGridSnapshot,
  SheetImageHostStatus,
  SpreadsheetMeta,
} from '../shared/google-sheets.js';
import type { BumperState } from '../shared/group-bumper.js';
import {
  GroupInviterState,
  InviterRecordsResponseSchema,
  type AddInviterGroupsRequest,
  type DeleteInviterGroupsRequest,
  type GroupInviteLogRow,
  type InviterRecordsQuery,
  type StartGroupInviterRequest,
  type StopGroupInviterProfilesRequest,
  type UpdateGroupInviterSettingsRequest,
} from '../shared/group-inviter.js';
import type { PosterLog, PosterState } from '../shared/group-poster.js';
import {
  MaterialCacheCleanResult,
  MaterialCacheOverview,
} from '../shared/material-cache-management.js';
import {
  ClearedMaterialUsage,
  MaterialUsageSnapshot,
  type MaterialUsageClearRequest,
} from '../shared/material-usage.js';
import { materialMediaPreviewLimits } from '../shared/materials.js';
import { MediaComponentStatus } from '../shared/media-component.js';
import {
  PostBumpRecordsResponseSchema,
  type PostBumpRecordQuery,
  type PostBumpRecordQueryTypeValue,
} from '../shared/post-bump-records.js';
import { INSPECTION_DISPLAY_HEADER, ProfileInspections } from '../shared/profile-inspection.js';
import type { ResourceDownloadProgressValue } from '../shared/resource-download.js';
import {
  ResourceSourceReport,
  type ResourceCheckProgressValue,
} from '../shared/resource-source.js';
import {
  RESOURCE_SUMMARY_HEADER,
  ResourceTable,
  ResourceUsageSummaries,
  type ResourceRowValue,
} from '../shared/resource-table.js';
import {
  MaintenanceOverview,
  RuntimeLogExport,
  type MaintenanceUpdate,
} from '../shared/runtime-log.js';
import {
  ExtensionReloadResult,
  OpenAiWorkspaceResult,
  SoftwareUpdateStatus,
  type UpdateConfiguration,
} from '../shared/software-update.js';
import type { TargetFolder, TargetListCommand, TargetListKind } from '../shared/target-list.js';
import {
  TaskCapabilities,
  TaskCommandResult,
  TaskRuntimeOverview,
  TaskStartResult,
  type Assignment,
  type TaskCommand,
} from '../shared/task-contracts.js';
import { TaskTestResult, type TestRequest } from '../shared/task-tests.js';
import {
  WindowLayoutCommand,
  WindowLayoutOverview,
  windowLayoutMessage,
} from '../shared/window-layout.js';
import {
  WorkspaceBackupResult,
  WorkspaceBackupStatus,
  WorkspaceRestoreInspection,
  WorkspaceRestoreStatus,
} from '../shared/workspace-backup.js';
import { WorkspacePreferences, type PreferenceUpdate } from '../shared/workspace-preferences.js';
import { readResourceDownloadStream } from './resource-download-stream.js';
import { readResourceCheckStream } from './resource-source-stream.js';
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const combineTimeout = (sig: AbortSignal | undefined, ms: number): AbortSignal =>
  sig ? AbortSignal.any([sig, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: res.ok ? '服务返回格式异常' : `请求失败（HTTP ${res.status}）` };
  }
}
export async function request(
  route: string,
  input?: unknown,
  signal?: AbortSignal,
  root = '/api/workspace',
): Promise<unknown> {
  const h: Record<string, string> = {};
  if (route.startsWith('/tasks/runtime')) h['x-workbench-runtime-contract'] = '2';
  if (input !== undefined) h['content-type'] = 'application/json';
  if (route === '/profiles/inspect' || route === '/profiles/inspection')
    h[INSPECTION_DISPLAY_HEADER] = '2';
  if (route === '/resource-tables/summaries') h[RESOURCE_SUMMARY_HEADER] = '2';
  const opts: RequestInit =
    input === undefined
      ? { cache: 'no-store', signal, headers: h }
      : { method: 'POST', headers: h, body: JSON.stringify(input), signal };
  let res = await fetch(root + route, opts);
  let body: unknown = await parseJsonSafe(res);
  if (
    res.status === 401 &&
    root === '/api/workspace' &&
    route === '' &&
    input === undefined &&
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    body.error === 'ADMIN_REQUIRED'
  ) {
    const boot = await fetch('/workbench/', {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
    });
    if (boot.ok) {
      res = await fetch(root + route, opts);
      body = await parseJsonSafe(res);
    }
  }
  if (!res.ok) {
    const e =
      typeof body === 'object' && body !== null
        ? (body as { code?: unknown; error?: unknown })
        : {};
    throw new ApiError(
      typeof e.code === 'string' && e.code ? e.code : 'REQUEST_FAILED',
      typeof e.error === 'string' && e.error ? e.error : `请求失败（HTTP ${res.status}）`,
    );
  }
  return body;
}
async function requestNdjsonStream(
  route: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  fallbackCode: string,
  fallbackMessage: string,
  mismatchMessage: string,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch('/api/workspace' + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: combineTimeout(signal, timeoutMs),
  });
  if (!res.ok) {
    const v = (await res.json()) as { code?: string; error?: string };
    throw new ApiError(v.code ?? fallbackCode, v.error ?? fallbackMessage);
  }
  if (!res.body || res.headers.get('content-type') !== 'application/x-ndjson')
    throw Error(mismatchMessage);
  return res.body;
}
type Sig = AbortSignal;
type Fail = Array<{ profileId: string; errorCode: string; reason: string }>;
type Schema<T> = { parse: (v: unknown) => T };
type DiagSnap = {
  recorded: boolean;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  entryId: number;
  at: string;
};
const j = <T>(r: string, b?: unknown, ms?: number, sig?: Sig, root?: string) =>
  request(r, b, ms ? combineTimeout(sig, ms) : sig, root) as Promise<T>;
const p = async <T>(r: string, s: Schema<T>, b?: unknown, ms?: number, sig?: Sig, root?: string) =>
  s.parse(await request(r, b, ms ? combineTimeout(sig, ms) : sig, root));
const gs = <T>(r: string, b?: unknown, ms = 15_000, sig?: Sig) =>
  j<T>('/google-sheets' + r, b, ms, sig);
const inv = (r: string, b?: unknown, ms = 15_000, sig?: Sig) =>
  p('/group-inviter' + r, GroupInviterState, b, ms, sig);
const qs = (params: Record<string, string | number | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
};
export const api = {
  bumperState: (sig?: Sig) => j<BumperState>('/group-bumper/state', undefined, 15_000, sig),
  bumperAction: (a: string, b: unknown = {}) => j<BumperState>('/group-bumper/' + a, b, 60_000),
  posterState: (sig?: Sig) => j<PosterState>('/group-poster/state', undefined, 15_000, sig),
  posterAction: (a: string, b: unknown = {}) => j<PosterState>('/group-poster/' + a, b, 60_000),
  posterLogs: (search = '', before?: number, beforeId?: string, materialId?: string, sig?: Sig) =>
    j<PosterLog[]>(
      '/group-poster/logs' +
        qs({ search, ...(before ? { before, beforeId: beforeId ?? '' } : {}), materialId }),
      undefined,
      15_000,
      sig,
    ),
  savePosterMaterialThumbnail: (id: string, thumbnailDataUrl: string) =>
    j<{ saved: boolean }>('/group-poster/materials/thumbnail', { id, thumbnailDataUrl }),
  softwareUpdateStatus: () => p('/update/status', SoftwareUpdateStatus),
  checkSoftwareUpdate: () => p('/update/check', SoftwareUpdateStatus, {}),
  configureSoftwareUpdate: (c: UpdateConfiguration) => p('/update/config', SoftwareUpdateStatus, c),
  applySoftwareUpdate: () => request('/update/apply', {}),
  reloadExtensions: (ids?: string[]) =>
    p('/extensions/reload', ExtensionReloadResult, ids ? { profileIds: ids } : {}),
  openExtensionDirectory: () => request('/extensions/open-dir', {}),
  openAiWorkspaceDirectory: () => p('/ai-workspace/open-dir', OpenAiWorkspaceResult, {}),
  cleanupProfileTabs: (profileIds: string[], preferActiveTab = false) =>
    p('/profiles/cleanup-tabs', CleanupProfileTabsResult, { profileIds, preferActiveTab }),
  launchProfiles: (profileIds: string[]) =>
    j<{ requestedIds: string[]; readyIds: string[]; launchedIds: string[]; failed: Fail }>(
      '/profiles/launch',
      { profileIds },
      90_000,
    ),
  closeProfiles: (profileIds: string[]) =>
    j<{ requestedIds: string[]; closedIds: string[]; failed: Fail }>(
      '/profiles/close',
      { profileIds },
      45_000,
    ),
  mediaComponent: (a?: 'install' | 'cancel', sig?: Sig) =>
    p(
      '/media-component',
      MediaComponentStatus,
      a ? { action: a } : undefined,
      sig ? undefined : 15_000,
      sig,
    ),
  windowLayout: async (input?: unknown) => {
    try {
      return WindowLayoutOverview.parse(
        await j(
          '/window-layout',
          input === undefined ? undefined : WindowLayoutCommand.parse(input),
          60_000,
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
  cleanupProgress: (sig?: Sig) =>
    j<{ running: boolean; current: number; total: number }>(
      '/data-cleanup/progress',
      undefined,
      10_000,
      sig,
    ),
  cleanupPreview: (b: unknown, sig?: Sig) =>
    p('/data-cleanup/preview', CleanupPreview, b, undefined, sig),
  cleanupExecute: (token: string) =>
    p('/data-cleanup/execute', CleanupResult, { token, confirm: true }, 300_000),
  cleanupSettings: (sig?: Sig) =>
    p('/data-cleanup/settings', CleanupSettings, undefined, undefined, sig),
  saveCleanupSettings: (b: unknown) => p('/data-cleanup/settings', CleanupSettings, b, 10_000),
  resetStatus: (sig?: Sig) =>
    j<{ available: boolean; reason: string; dataDirectory: string }>(
      '/data-cleanup/reset-status',
      undefined,
      undefined,
      sig,
    ),
  resetWorkspace: (b: unknown) => j('/data-cleanup/reset', b, 15_000),
  compactData: () => j('/data-cleanup/compact', {}, 300_000),
  maintenance: (sig: Sig) => p('/maintenance', MaintenanceOverview, undefined, undefined, sig),
  saveMaintenance: (b: MaintenanceUpdate, sig: Sig) =>
    p('/maintenance/settings', MaintenanceOverview, b, undefined, sig),
  runtimeLogs: (sig: Sig) => p('/maintenance/logs', RuntimeLogExport, undefined, undefined, sig),
  workspacePreferences: (sig?: Sig) =>
    p('/preferences', WorkspacePreferences, undefined, undefined, sig),
  saveWorkspacePreferences: (b: PreferenceUpdate, sig?: Sig) =>
    p('/preferences', WorkspacePreferences, b, undefined, sig),
  bridgeConnectionHealth: (sig: Sig) =>
    p('/bridge-connection-health', BridgeConnectionHealth, undefined, undefined, sig, '/api'),
  recoverBridgeConnection: (b: { id: string; profileId: string }) =>
    p('/bridge-connections/recover', BridgeConnectionRecoveryResult, b, 20_000, undefined, '/api'),
  showBrowser: (profileId: string) => p('/profiles/show', ShowBrowserResult, { profileId }, 55_000),
  restartSoftware: () => j('/software/restart', {}, 10_000),
  backupStatus: (sig: Sig) =>
    p('/backups/status', WorkspaceBackupStatus, undefined, undefined, sig),
  createBackup: (directory: string, redact = false) =>
    p(
      '/backups/create',
      WorkspaceBackupResult,
      { directory, ...(redact ? { redactSecrets: true } : {}) },
      310_000,
    ),
  restoreStatus: (sig: Sig) =>
    p('/backups/restore-status', WorkspaceRestoreStatus, undefined, undefined, sig),
  inspectRestore: (directory: string) =>
    p('/backups/inspect-restore', WorkspaceRestoreInspection, { directory }, 310_000),
  prepareRestore: (directory: string) =>
    p('/backups/prepare-restore', WorkspaceRestoreStatus, { directory }, 310_000),
  inspectProfiles: (profileIds: string[]) =>
    p('/profiles/inspect', ProfileInspections, { profileIds }, 20_000),
  profileInspections: (sig?: Sig) =>
    p('/profiles/inspection', ProfileInspections, undefined, 10_000, sig),
  snapshot: (sig?: Sig) => p('', WorkspaceSchema, undefined, sig ? undefined : 10_000, sig),
  targetFolders: (k: TargetListKind) => j<TargetFolder[]>('/target-lists/folders?listKind=' + k),
  targetListCommand: (cmd: TargetListCommand) => request('/target-lists/command', cmd),
  reorderProfiles: (groupId: string | null, orderedProfileIds: string[]) =>
    request('/profiles/reorder', { groupId, orderedProfileIds }),
  reorderGroups: (orderedGroupIds: string[]) => request('/groups/reorder', { orderedGroupIds }),
  createGroup: (name: string, color: string) => request('/groups/create', { name, color }),
  renameGroup: (groupId: string, name: string) => request('/groups/rename', { groupId, name }),
  deleteGroup: (groupId: string) => request('/groups/delete', { groupId }),
  rename: (profileId: string, alias: string) => request('/profiles/rename', { profileId, alias }),
  deleteProfiles: (profileIds: string[]) => j('/profiles/delete', { profileIds }, 15_000),
  recordDiagnosticSnapshot: (
    b?: string | { note?: string; uiContext?: string; targetDir?: string; reveal?: boolean },
  ) =>
    j<DiagSnap>('/diagnostics/snapshot', typeof b === 'string' ? { note: b } : (b ?? {}), 30_000),
  revealDiagnosticPackage: (fileName?: string, targetDir?: string) =>
    j<{ revealed: boolean; filePath: string; fileName: string }>(
      '/diagnostics/reveal',
      { ...(fileName ? { fileName } : {}), ...(targetDir ? { targetDir } : {}) },
      10_000,
    ),
  bluestacksState: (refresh = false, sig?: Sig) =>
    j<BluestacksState>('/bluestacks/state' + (refresh ? '?refresh=1' : ''), undefined, 15_000, sig),
  bluestacksAction: (act: string, b: unknown = {}) =>
    j<BluestacksState>('/bluestacks/' + act, b, 90_000),
  autoSchedulerState: (sig?: Sig) =>
    j<AutoSchedulerState>('/auto-scheduler/state', undefined, 15_000, sig),
  autoSchedulerAction: (act: string, b: unknown = {}) =>
    j<AutoSchedulerState>('/auto-scheduler/' + act, b, 30_000),
  postBumpRecords: (q: PostBumpRecordQuery = {}, sig?: Sig) =>
    p(
      '/post-bump-records' +
        qs({
          recordType: q.recordType && q.recordType !== 'all' ? q.recordType : undefined,
          carrier: q.carrier && q.carrier !== 'all' ? q.carrier : undefined,
          status: q.status && q.status !== 'all' ? q.status : undefined,
          search: q.search?.trim() || undefined,
          accountQuery: q.accountQuery?.trim() || undefined,
          groupQuery: q.groupQuery?.trim() || undefined,
          pageQuery: q.pageQuery?.trim() || undefined,
          postUrlQuery: q.postUrlQuery?.trim() || undefined,
          from: q.from,
          to: q.to,
          limit: q.limit,
          offset: q.offset,
        }),
      PostBumpRecordsResponseSchema,
      undefined,
      15_000,
      sig,
    ),
  deletePostBumpRecords: (b: {
    ids?: string[];
    clearAll?: boolean;
    recordType?: PostBumpRecordQueryTypeValue;
  }) => j<{ deleted: number }>('/post-bump-records/delete', b, 20_000),
  activityStats: (q: ActivityStatsQuery = {}, sig?: Sig) =>
    p(
      '/activity-stats' +
        qs({
          from: q.from,
          to: q.to,
          carrier: q.carrier && q.carrier !== 'all' ? q.carrier : undefined,
          groupBy: q.groupBy,
          search: q.search?.trim() || undefined,
          onlyActive: q.onlyActive ? '1' : undefined,
        }),
      ActivityStatsResponseSchema,
      undefined,
      15_000,
      sig,
    ),
  browserRiskLimits: (sig?: Sig) =>
    p('/browser-risk-limits', BrowserRiskLimitsStateSchema, undefined, 15_000, sig),
  saveBrowserRiskLimits: (b: DailyRiskLimitSettings) =>
    p('/browser-risk-limits', BrowserRiskLimitsStateSchema, b, 20_000),
  inviterRecords: (q: InviterRecordsQuery = {}, sig?: Sig) =>
    p(
      '/inviter-records' +
        qs({
          carrier: q.carrier && q.carrier !== 'all' ? q.carrier : undefined,
          confirmation: q.confirmation,
          accountQuery: q.accountQuery?.trim() || undefined,
          groupQuery: q.groupQuery?.trim() || undefined,
          friendQuery: q.friendQuery?.trim() || undefined,
          from: q.from,
          to: q.to,
          limit: q.limit,
          offset: q.offset,
        }),
      InviterRecordsResponseSchema,
      undefined,
      15_000,
      sig,
    ),
  deleteInviterRecords: (b: { ids?: string[]; clearAll?: boolean }) =>
    j<{ deleted: number }>('/inviter-records/delete', b, 20_000),
  runtimeSummary: (sig?: Sig) => p('/runtime-summary', RuntimeSummarySchema, undefined, 8_000, sig),
  testTask: (b: TestRequest) => p('/tasks/test', TaskTestResult, b, 65_000),
  taskCapabilities: (sig: Sig) =>
    p('/tasks/capabilities', TaskCapabilities, undefined, undefined, sig),
  taskRuntime: (sig: Sig, cursor?: string) =>
    p(
      '/tasks/runtime' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      TaskRuntimeOverview,
      undefined,
      undefined,
      sig,
    ),
  startTasks: (b: Assignment) => p('/tasks/start', TaskStartResult, b, 65_000),
  commandTasks: (b: TaskCommand) => p('/tasks/command', TaskCommandResult, b, 45_000),
  create: (value: Combination) => p('/combinations/create', SavedCombinationSchema, { value }),
  saveCombination: (id: string, expectedRevision: number, value: Combination) =>
    p('/combinations/save', SavedCombinationSchema, { id, expectedRevision, value }, 10_000),
  deleteCombination: (id: string) => j('/combinations/delete', { id }, 15_000),
  materialUsage: (sig: Sig) =>
    p('/materials/usage', MaterialUsageSnapshot, undefined, undefined, sig),
  materialCache: (sig: Sig) =>
    p('/materials/cache', MaterialCacheOverview, undefined, undefined, sig),
  cleanMaterialCache: (stageIds: string[]) =>
    p('/materials/cache/clean', MaterialCacheCleanResult, { stageIds }, 120_000),
  clearMaterialUsage: (b: MaterialUsageClearRequest) =>
    p('/materials/usage/clear', ClearedMaterialUsage, b, 15_000),
  downloadResourceSources: async (
    combinationId: string,
    expectedRevision: number,
    sig: Sig,
    rowIds: string[] | undefined,
    onProgress: (v: ResourceDownloadProgressValue) => void,
  ) => {
    const report = await readResourceDownloadStream(
      await requestNdjsonStream(
        '/resource-tables/download',
        { combinationId, expectedRevision, ...(rowIds ? { rowIds } : {}) },
        31 * 60_000,
        sig,
        'RESOURCE_DOWNLOAD_FAILED',
        '下载未完成',
        '下载响应不一致，请更新软件',
      ),
      onProgress,
    );
    if (report.combinationId !== combinationId || report.expectedRevision !== expectedRevision)
      throw Error('下载结果与资源表不匹配');
    return report;
  },
  checkResourceSources: async (
    combinationId: string,
    expectedRevision: number,
    sig: Sig,
    rowIds?: string[],
    onProgress?: (v: ResourceCheckProgressValue) => void,
  ) => {
    const payload = { combinationId, expectedRevision, ...(rowIds ? { rowIds } : {}) };
    return onProgress
      ? readResourceCheckStream(
          await requestNdjsonStream(
            '/resource-tables/check',
            payload,
            40_000,
            sig,
            'RESOURCE_CHECK_FAILED',
            '资源检查未完成',
            '资源检查响应不一致，请更新软件',
          ),
          onProgress,
        )
      : p('/resource-tables/check', ResourceSourceReport, payload, 40_000, sig);
  },
  resourceTable: (combinationId: string) =>
    p('/resource-tables/read', ResourceTable, { combinationId }, 10_000),
  resourceMedia: async (
    combinationId: string,
    expectedRevision: number,
    rowId: string,
    fileIndex: number,
    sig: Sig,
  ) => {
    const res = await fetch('/api/workspace/resource-tables/media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ combinationId, expectedRevision, rowId, fileIndex }),
      cache: 'no-store',
      signal: combineTimeout(sig, 40_000),
    });
    if (!res.ok) {
      const r = (await res.json()) as { code?: string; error?: string };
      throw new ApiError(r.code ?? 'RESOURCE_PREVIEW_FAILED', r.error ?? '媒体预览未完成');
    }
    const type = res.headers.get('content-type'),
      length = Number(res.headers.get('content-length')),
      role = type?.startsWith('image/') ? 'image' : 'video';
    if (
      !type ||
      !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime'].includes(type) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > materialMediaPreviewLimits[role]
    )
      throw Error('RESOURCE_PREVIEW_RESPONSE_MISMATCH');
    const blob = await res.blob();
    if (blob.size !== length || blob.type !== type)
      throw Error('RESOURCE_PREVIEW_RESPONSE_MISMATCH');
    return blob;
  },
  resourceSummaries: () =>
    p('/resource-tables/summaries', ResourceUsageSummaries, undefined, 10_000),
  saveResourceTable: (combinationId: string, expectedRevision: number, rows: ResourceRowValue[]) =>
    p('/resource-tables/save', ResourceTable, { combinationId, expectedRevision, rows }, 15_000),
  groupInviterState: (sig?: Sig) => inv('/state', undefined, 10_000, sig),
  addInviterGroups: (b: AddInviterGroupsRequest) => inv('/groups/add', b),
  deleteInviterGroups: (b: DeleteInviterGroupsRequest) => inv('/groups/delete', b),
  refreshGroupInviterGroups: (b: { ids?: string[] } = {}) => inv('/groups/refresh', b, 60_000),
  stopRefreshGroupInviterGroups: () => inv('/groups/refresh-stop', {}, 10_000),
  saveGroupInviterSettings: (b: UpdateGroupInviterSettingsRequest) => inv('/settings', b, 10_000),
  startGroupInviter: (b: StartGroupInviterRequest) => inv('/start', b, 65_000),
  stopGroupInviter: () => inv('/stop', {}, 10_000),
  stopGroupInviterProfiles: (b: StopGroupInviterProfilesRequest) =>
    inv('/stop-profiles', b, 10_000),
  groupInviterLogs: (search = '', before?: number, beforeId?: string) =>
    j<GroupInviteLogRow[]>(
      '/group-inviter/logs' + qs({ search, ...(before ? { before, beforeId } : {}) }),
      undefined,
      10_000,
    ),
  googleSheetsOverview: (sig?: Sig) => gs<GoogleSheetsOverview>('', undefined, 15_000, sig),
  googleSheetsImportCredentials: (rawJson: string) =>
    gs<GoogleAuthStatus>('/auth/credentials', { rawJson }),
  googleSheetsStartAuth: () => gs<{ authUrl: string; status: GoogleAuthStatus }>('/auth/start', {}),
  googleSheetsCompleteManualAuth: (codeOrUrl: string) =>
    gs<GoogleAuthStatus>('/auth/manual', { codeOrUrl }, 30_000),
  googleSheetsRevokeAuth: () => gs<GoogleAuthStatus>('/auth/revoke', {}),
  googleSheetsImageHostTokens: () => gs<{ tokens: string[] }>('/image-host/tokens'),
  googleSheetsSaveImageHost: (b: unknown) => gs<SheetImageHostStatus>('/image-host', b),
  googleSheetsTestImageHost: () =>
    gs<{
      remoteUrl: string;
      host: 'gyazo' | 'drive';
      tokenIndex?: number;
      tokenCount?: number;
      fallbackFromGyazo?: boolean;
    }>('/image-host/test', {}, 45_000),
  googleSheetsInspect: (urlOrId: string) =>
    gs<SpreadsheetMeta & { suggestedGid: number | null }>('/inspect', { urlOrId }, 30_000),
  googleSheetsCreateLink: (b: unknown) => gs<GoogleSheetLink>('/links/create', b, 30_000),
  googleSheetsUpdateLink: (b: unknown) => gs<GoogleSheetLink>('/links/update', b, 20_000),
  googleSheetsDeleteLink: (id: string) => gs<{ deleted: boolean }>('/links/delete', { id }),
  googleSheetsReadGrid: (id: string, force = false) =>
    gs<SheetGridSnapshot>(
      `/links/grid?id=${encodeURIComponent(id)}${force ? '&force=1' : ''}`,
      undefined,
      30_000,
    ),
  googleSheetsImportLibrary: (id: string, mode: 'incremental' | 'overwrite') =>
    gs<LibrarySyncSummary>('/links/import-library', { id, mode }, 60_000),
  googleSheetsSyncLibrary: (id: string) =>
    gs<LibrarySyncSummary>('/links/sync-library', { id }, 180_000),
  googleSheetsPollSchedule: (id: string) =>
    gs<{ summary: string }>('/links/poll-schedule', { id }, 180_000),
  googleSheetsPollRecords: (id: string) =>
    gs<{ summary: string }>('/links/poll-records', { id }, 180_000),
  googleSheetsRefreshMetrics: (id: string) =>
    gs<{ updated: number; failed: number; summary: string }>(
      '/links/refresh-metrics',
      { id },
      180_000,
    ),
  googleSheetsStopLink: (id: string) => gs<{ stopped: boolean }>('/links/stop', { id }),
  googleSheetsResetStuckRows: (id: string) =>
    gs<{ linkId: string; resetCount: number; rowNumbers: number[]; summary: string }>(
      '/links/reset-stuck',
      { id },
      30_000,
    ),
  googleSheetsStopProfiles: (profileIds: string[]) =>
    gs<GoogleSheetsOverview>('/stop-profiles', { profileIds }),
};
