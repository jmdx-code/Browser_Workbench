import type {
  GoogleAuthStatus,
  GoogleSheetKind,
  GoogleSheetLink,
  GoogleSheetLinkRuntime,
  PostRecordsSheetConfig,
  PostScheduleSheetConfig,
  SheetImageHostConfig,
  SheetSyncLogEntry,
  SpreadsheetMeta,
} from '../shared/google-sheets.js';
import type { BumperSettings, BumperTarget } from '../shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../shared/group-poster.js';
export interface StoredGoogleAuthDataPort {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  authorizedEmail: string | null;
  scopes: string[];
  lastError: string | null;
}
export interface SheetImageCachePortRecord {
  contentHash: string;
  host: 'gyazo' | 'drive';
  remoteUrl: string;
  driveFileId: string | null;
  mimeType: string;
  byteSize: number;
  createdAt: number;
}
export interface SheetScheduleItemPortRecord {
  linkId: string;
  resourceCode: string;
  pageId: string;
  scheduledAt: number;
  caption: string;
  mediaSource: string;
  aiLabel: 'default' | 'on' | 'off';
  postTimeline: boolean;
  groupsSpec: string;
  thumbnailUrl: string | null;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  timelinePosted: boolean;
  postedGroupIds: string[];
  targetGroupCount: number;
  postedGroupCount: number;
  errorMessage: string | null;
  attemptCount?: number;
  nextRetryAt?: number | null;
  lastError?: string | null;
  updatedAt: number;
}
export interface SheetRecordPostPortRecord {
  linkId: string;
  postCode: string;
  resourceCode: string;
  postedAtText: string;
  postedAtMs: number | null;
  groupId: string;
  groupName: string;
  pageId: string;
  pageName: string;
  postUrl: string;
  postId: string | null;
  thumbnailUrl: string | null;
  likesCount: number | null;
  commentsCount: number | null;
  metricsStage: number;
  metricsUpdatedAt: number | null;
  localBumpedCount: number;
  bumpedProfileIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface GoogleSheetsRepositoryPort {
  getAuthConfig(): StoredGoogleAuthDataPort;
  saveAuthConfig(patch: Partial<StoredGoogleAuthDataPort>): StoredGoogleAuthDataPort;
  getImageHostConfig(): SheetImageHostConfig;
  saveImageHostConfig(patch: Partial<SheetImageHostConfig>): SheetImageHostConfig;
  listLinks(kind?: GoogleSheetKind): GoogleSheetLink[];
  getLink(id: string): GoogleSheetLink | null;
  createLink(input: {
    kind: GoogleSheetKind;
    title: string;
    spreadsheetId: string;
    spreadsheetTitle: string;
    sheetId: number;
    sheetName: string;
    spreadsheetUrl: string;
    scheduleConfig?: Partial<PostScheduleSheetConfig>;
    recordsConfig?: Partial<PostRecordsSheetConfig>;
  }): GoogleSheetLink;
  updateLink(input: {
    id: string;
    title?: string;
    sheetId?: number;
    sheetName?: string;
    spreadsheetTitle?: string;
    enabled?: boolean;
    scheduleConfig?: Partial<PostScheduleSheetConfig>;
    recordsConfig?: Partial<PostRecordsSheetConfig>;
  }): GoogleSheetLink;
  updateLinkRuntime(id: string, patch: Partial<GoogleSheetLinkRuntime>): GoogleSheetLink | null;
  deleteLink(id: string): boolean;
  getImageCache(contentHash: string): SheetImageCachePortRecord | null;
  saveImageCache(record: SheetImageCachePortRecord): void;
  countImageCache(): number;
  getScheduleItem(linkId: string, resourceCode: string): SheetScheduleItemPortRecord | null;
  upsertScheduleItem(item: SheetScheduleItemPortRecord): SheetScheduleItemPortRecord;
  getRecordPost(linkId: string, postCode: string): SheetRecordPostPortRecord | null;
  listRecordPosts(linkId: string, limit?: number): SheetRecordPostPortRecord[];
  upsertRecordPost(record: SheetRecordPostPortRecord): SheetRecordPostPortRecord;
  appendLog(input: {
    linkId?: string | null;
    level: 'info' | 'warn' | 'error';
    action: string;
    summary: string;
  }): SheetSyncLogEntry;
  listLogs(limit?: number, linkId?: string | null): SheetSyncLogEntry[];
}
export interface GoogleOAuthPort {
  status(): Promise<GoogleAuthStatus>;
  importCredentialsJson(rawJson: string): Promise<GoogleAuthStatus>;
  startAuthSession(): Promise<{ authUrl: string; status: GoogleAuthStatus }>;
  completeManualAuth(codeOrCallbackUrl: string): Promise<GoogleAuthStatus>;
  revokeAuth(): Promise<GoogleAuthStatus>;
  getValidAccessToken(): Promise<string>;
  invalidateAccessToken?(expectedToken?: string): Promise<void>;
  shutdown(): Promise<void>;
}
export type SheetValuesDualRead = { formulaRows: string[][]; formattedRows: string[][] };
export interface GoogleSheetsApiPort {
  getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta>;
  readSheetValues(spreadsheetId: string, sheetName: string): Promise<SheetValuesDualRead>;
  readHeaderRow?(spreadsheetId: string, sheetName: string): Promise<string[]>;
  readColumnValues?(spreadsheetId: string, sheetName: string, colIndex: number): Promise<string[]>;
  batchUpdateCells(
    spreadsheetId: string,
    sheetName: string,
    updates: ReadonlyArray<{ rowNumber: number; colIndex: number; value: string }>,
  ): Promise<void>;
  appendRows(
    spreadsheetId: string,
    sheetName: string,
    rows: readonly (readonly (string | null)[])[],
  ): Promise<void>;
  deleteRowsDescending(
    spreadsheetId: string,
    numericSheetId: number,
    rowNumbersDesc: readonly number[],
  ): Promise<void>;
  ensureHeaderColumn(
    spreadsheetId: string,
    sheetName: string,
    headers: readonly string[],
    columnTitle: string,
  ): Promise<number>;
}
export interface SheetImageHostTestResult {
  remoteUrl: string;
  host: 'gyazo' | 'drive';
  tokenIndex?: number;
  tokenCount?: number;
  fallbackFromGyazo?: boolean;
}
export interface SheetImageHostPort {
  uploadDataUrlOrUrl(input: {
    source: string;
    filenameHint: string;
  }): Promise<{ remoteUrl: string; host: 'gyazo' | 'drive'; cached: boolean } | null>;
  testUpload(): Promise<SheetImageHostTestResult>;
}
export interface DirectPostBumpItem {
  postCode: string;
  postUrl: string;
  postId: string | null;
  groupId: string;
  groupName: string;
  pageId: string;
  pageName: string;
}
export interface DirectPostBumpResult {
  postCode: string;
  postUrl: string;
  bumped: boolean;
  liked: boolean;
  commented: boolean;
  skippedReason?: string;
}
export interface ScrapedPostMetrics {
  postCode: string;
  postUrl: string;
  likes: number | null;
  comments: number | null;
  needsAuthFallback?: boolean;
  unavailable?: boolean;
  error?: string;
}
export interface SheetAutomationBridgePort {
  publishScheduledMaterial(input: {
    profileId: string;
    material: PosterMaterial;
    targets: BumperTarget[];
    targetPageId?: string;
    targetPageName?: string;
    onPosted: (log: PosterLog, isTimeline: boolean) => Promise<void>;
    onStatus: (text: string) => void;
    cancelled: () => boolean;
  }): Promise<{ postedCount: number; timelinePosted: boolean; error?: string }>;
  switchProfilePageIdentity?(input: {
    profileId: string;
    targetPageId: string;
    targetPageName?: string;
  }): Promise<boolean>;
  prepareMaterialMedia(mediaSource: string): Promise<{
    localFilePath: string;
    mediaKind: 'image' | 'video';
    thumbnailDataUrl: string | null;
    isTemporaryCache?: boolean;
  }>;
  cleanupPreparedMedia?(localFilePath: string): Promise<void>;
  bumpDirectPosts(input: {
    profileId: string;
    posts: DirectPostBumpItem[];
    settings: BumperSettings;
    commentPool: string[];
    onPostBumped: (result: DirectPostBumpResult) => Promise<void>;
    onCommentConsumed?: (comment: string) => Promise<void>;
    onStatus: (text: string) => void;
    cancelled: () => boolean;
  }): Promise<DirectPostBumpResult[]>;
  scrapePublicPostMetrics?(input: {
    posts: Array<{ postCode: string; postUrl: string }>;
    signal?: AbortSignal;
  }): Promise<ScrapedPostMetrics[]>;
  scrapePostMetrics(input: {
    profileId: string;
    posts: Array<{ postCode: string; postUrl: string }>;
    signal?: AbortSignal;
  }): Promise<ScrapedPostMetrics[]>;
}
