import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './sqlite-transaction.js';
import { ProductError } from '../domain/workspace.js';
import {
  GoogleSheetKind,
  GoogleSheetLink,
  GoogleSheetLinkRuntime,
  parseGyazoTokenList,
  PostRecordsSheetConfig,
  PostScheduleSheetConfig,
  resolveEffectiveGyazoTokens,
  SheetImageHostConfig,
  SheetSyncLogEntry,
  type GoogleSheetKind as GoogleSheetKindValue,
  type GoogleSheetLink as GoogleSheetLinkValue,
  type GoogleSheetLinkRuntime as GoogleSheetLinkRuntimeValue,
  type PostRecordsSheetConfig as PostRecordsSheetConfigValue,
  type PostScheduleSheetConfig as PostScheduleSheetConfigValue,
  type SheetImageHostConfig as SheetImageHostConfigValue,
  type SheetSyncLogEntry as SheetSyncLogEntryValue,
} from '../shared/google-sheets.js';

export interface StoredGoogleAuthData {
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

export interface SheetImageCacheRecord {
  contentHash: string;
  host: 'gyazo' | 'drive';
  remoteUrl: string;
  driveFileId: string | null;
  mimeType: string;
  byteSize: number;
  createdAt: number;
}

export interface SheetScheduleItemRecord {
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
  updatedAt: number;
}

export interface SheetRecordPostRecord {
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
  metricsStage: number; // 0 = never, 1 = 24h done, 2 = 72h finalized
  metricsUpdatedAt: number | null;
  localBumpedCount: number;
  bumpedProfileIds: string[];
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_AUTH: StoredGoogleAuthData = {
  clientId: '',
  clientSecret: '',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  accessToken: null,
  refreshToken: null,
  expiryDate: null,
  authorizedEmail: null,
  scopes: [],
  lastError: null,
};

const DEFAULT_IMAGE_HOST: SheetImageHostConfigValue = SheetImageHostConfig.parse({});

export class SqliteGoogleSheetsRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS google_sheets_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        auth_json TEXT NOT NULL,
        image_host_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS google_sheet_links (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('group_library','page_library','post_schedule','post_records')),
        title TEXT NOT NULL,
        spreadsheet_id TEXT NOT NULL,
        spreadsheet_title TEXT NOT NULL DEFAULT '',
        sheet_id INTEGER NOT NULL DEFAULT 0,
        sheet_name TEXT NOT NULL,
        spreadsheet_url TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        runtime_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_google_sheet_links_kind_sort
        ON google_sheet_links(kind, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS sheet_image_cache (
        content_hash TEXT PRIMARY KEY,
        host TEXT NOT NULL CHECK(host IN ('gyazo','drive')),
        remote_url TEXT NOT NULL,
        drive_file_id TEXT,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sheet_schedule_items (
        link_id TEXT NOT NULL,
        resource_code TEXT NOT NULL,
        page_id TEXT NOT NULL DEFAULT '',
        scheduled_at INTEGER NOT NULL DEFAULT 0,
        caption TEXT NOT NULL DEFAULT '',
        media_source TEXT NOT NULL DEFAULT '',
        ai_label TEXT NOT NULL DEFAULT 'default',
        post_timeline INTEGER NOT NULL DEFAULT 0,
        groups_spec TEXT NOT NULL DEFAULT '',
        thumbnail_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        timeline_posted INTEGER NOT NULL DEFAULT 0,
        posted_group_ids_json TEXT NOT NULL DEFAULT '[]',
        target_group_count INTEGER NOT NULL DEFAULT 0,
        posted_group_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(link_id, resource_code)
      );
      CREATE INDEX IF NOT EXISTS idx_sheet_schedule_items_link_status
        ON sheet_schedule_items(link_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS sheet_record_posts (
        link_id TEXT NOT NULL,
        post_code TEXT NOT NULL,
        resource_code TEXT NOT NULL DEFAULT '',
        posted_at_text TEXT NOT NULL DEFAULT '',
        posted_at_ms INTEGER,
        group_id TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        page_id TEXT NOT NULL DEFAULT '',
        page_name TEXT NOT NULL DEFAULT '',
        post_url TEXT NOT NULL DEFAULT '',
        post_id TEXT,
        thumbnail_url TEXT,
        likes_count INTEGER,
        comments_count INTEGER,
        metrics_stage INTEGER NOT NULL DEFAULT 0,
        metrics_updated_at INTEGER,
        local_bumped_count INTEGER NOT NULL DEFAULT 0,
        bumped_profile_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(link_id, post_code)
      );
      CREATE INDEX IF NOT EXISTS idx_sheet_record_posts_link_created
        ON sheet_record_posts(link_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS sheet_sync_logs (
        id TEXT PRIMARY KEY,
        link_id TEXT,
        level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sheet_sync_logs_created
        ON sheet_sync_logs(created_at DESC);
    `);

    // Startup crash recovery: reset stale 'running' schedule items & clear stale activeJobText
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE sheet_schedule_items
            SET status = CASE WHEN timeline_posted = 1 OR posted_group_count > 0 THEN 'partial' ELSE 'pending' END,
                error_message = COALESCE(error_message, '上次发布时软件异常退出，已重置待续跑'),
                updated_at = ?
          WHERE status = 'running'`,
      )
      .run(now);
    const linkRows = this.db
      .prepare('SELECT id, runtime_json FROM google_sheet_links')
      .all() as Array<{ id: string; runtime_json: string }>;
    for (const r of linkRows) {
      try {
        const parsed = JSON.parse(r.runtime_json || '{}') as Record<string, unknown>;
        if (parsed.activeJobText || parsed.activeRunningCount) {
          parsed.activeJobText = '';
          parsed.activeRunningCount = 0;
          this.db
            .prepare('UPDATE google_sheet_links SET runtime_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(parsed), now, r.id);
        }
      } catch {
        // Ignore malformed legacy JSON
      }
    }
  }

  private ensureConfigRow(): { auth: StoredGoogleAuthData; imageHost: SheetImageHostConfigValue } {
    const row = this.db
      .prepare('SELECT auth_json, image_host_json FROM google_sheets_config WHERE id = 1')
      .get() as { auth_json?: string; image_host_json?: string } | undefined;
    if (!row) {
      const now = Date.now();
      this.db
        .prepare(
          'INSERT OR IGNORE INTO google_sheets_config(id, auth_json, image_host_json, updated_at) VALUES(1, ?, ?, ?)',
        )
        .run(JSON.stringify(DEFAULT_AUTH), JSON.stringify(DEFAULT_IMAGE_HOST), now);
      return { auth: { ...DEFAULT_AUTH }, imageHost: { ...DEFAULT_IMAGE_HOST } };
    }
    let auth: StoredGoogleAuthData = { ...DEFAULT_AUTH };
    let imageHost: SheetImageHostConfigValue = { ...DEFAULT_IMAGE_HOST };
    try {
      const parsed = JSON.parse(row.auth_json ?? '{}') as Partial<StoredGoogleAuthData>;
      auth = {
        ...DEFAULT_AUTH,
        ...parsed,
        scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : [],
      };
    } catch {
      auth = { ...DEFAULT_AUTH };
    }
    try {
      const parsedHost = SheetImageHostConfig.parse(JSON.parse(row.image_host_json ?? '{}'));
      const tokens = resolveEffectiveGyazoTokens(parsedHost);
      imageHost = {
        ...parsedHost,
        gyazoAccessTokens: tokens,
        gyazoAccessToken: tokens[0] ?? '',
      };
    } catch {
      imageHost = { ...DEFAULT_IMAGE_HOST };
    }
    return { auth, imageHost };
  }

  getAuthConfig(): StoredGoogleAuthData {
    return this.ensureConfigRow().auth;
  }

  saveAuthConfig(patch: Partial<StoredGoogleAuthData>): StoredGoogleAuthData {
    const current = this.ensureConfigRow();
    const next: StoredGoogleAuthData = {
      ...current.auth,
      ...patch,
      scopes: Array.isArray(patch.scopes) ? patch.scopes : current.auth.scopes,
    };
    this.db
      .prepare(
        `INSERT INTO google_sheets_config(id, auth_json, image_host_json, updated_at) VALUES(1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET auth_json = excluded.auth_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(next), JSON.stringify(current.imageHost), Date.now());
    return next;
  }

  getImageHostConfig(): SheetImageHostConfigValue {
    return this.ensureConfigRow().imageHost;
  }

  saveImageHostConfig(patch: Partial<SheetImageHostConfigValue>): SheetImageHostConfigValue {
    const current = this.ensureConfigRow();
    const nextTokens =
      patch.gyazoAccessTokens !== undefined
        ? parseGyazoTokenList(patch.gyazoAccessTokens)
        : patch.gyazoAccessToken !== undefined
          ? parseGyazoTokenList(patch.gyazoAccessToken)
          : resolveEffectiveGyazoTokens(current.imageHost);
    const next = SheetImageHostConfig.parse({
      ...current.imageHost,
      ...patch,
      gyazoAccessTokens: nextTokens,
      gyazoAccessToken: nextTokens[0] ?? '',
    });
    this.db
      .prepare(
        `INSERT INTO google_sheets_config(id, auth_json, image_host_json, updated_at) VALUES(1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET image_host_json = excluded.image_host_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(current.auth), JSON.stringify(next), Date.now());
    return next;
  }

  private deserializeLink(row: Record<string, unknown>): GoogleSheetLinkValue {
    const kind = GoogleSheetKind.parse(String(row.kind));
    let parsedConfig: Record<string, unknown> = {};
    try {
      parsedConfig = JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>;
    } catch {
      parsedConfig = {};
    }
    let runtime: GoogleSheetLinkRuntimeValue;
    try {
      runtime = GoogleSheetLinkRuntime.parse(JSON.parse(String(row.runtime_json ?? '{}')));
    } catch {
      runtime = GoogleSheetLinkRuntime.parse({});
    }
    const base = {
      id: String(row.id),
      kind,
      title: String(row.title),
      spreadsheetId: String(row.spreadsheet_id),
      spreadsheetTitle: String(row.spreadsheet_title ?? ''),
      sheetId: Number(row.sheet_id ?? 0),
      sheetName: String(row.sheet_name),
      spreadsheetUrl: String(row.spreadsheet_url ?? ''),
      sortOrder: Number(row.sort_order ?? 0),
      enabled: Number(row.enabled ?? 1) === 1,
      runtime,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
    if (kind === 'post_schedule') {
      return GoogleSheetLink.parse({
        ...base,
        scheduleConfig: PostScheduleSheetConfig.parse(parsedConfig),
      });
    }
    if (kind === 'post_records') {
      return GoogleSheetLink.parse({
        ...base,
        recordsConfig: PostRecordsSheetConfig.parse(parsedConfig),
      });
    }
    return GoogleSheetLink.parse(base);
  }

  listLinks(kind?: GoogleSheetKindValue): GoogleSheetLinkValue[] {
    const rows = (
      kind
        ? this.db
            .prepare(
              'SELECT * FROM google_sheet_links WHERE kind = ? ORDER BY sort_order ASC, created_at ASC',
            )
            .all(kind)
        : this.db
            .prepare(
              'SELECT * FROM google_sheet_links ORDER BY kind ASC, sort_order ASC, created_at ASC',
            )
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeLink(row));
  }

  getLink(id: string): GoogleSheetLinkValue | null {
    const row = this.db.prepare('SELECT * FROM google_sheet_links WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row ? this.deserializeLink(row) : null;
  }

  createLink(input: {
    kind: GoogleSheetKindValue;
    title: string;
    spreadsheetId: string;
    spreadsheetTitle: string;
    sheetId: number;
    sheetName: string;
    spreadsheetUrl: string;
    scheduleConfig?: Partial<PostScheduleSheetConfigValue> | undefined;
    recordsConfig?: Partial<PostRecordsSheetConfigValue> | undefined;
  }): GoogleSheetLinkValue {
    const now = Date.now();
    const isSingle = input.kind === 'group_library' || input.kind === 'page_library';
    if (isSingle) {
      const existing = this.listLinks(input.kind)[0];
      if (existing) {
        this.db
          .prepare(
            `UPDATE google_sheet_links
             SET title = ?, spreadsheet_id = ?, spreadsheet_title = ?, sheet_id = ?, sheet_name = ?,
                 spreadsheet_url = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.title.trim() || input.sheetName,
            input.spreadsheetId,
            input.spreadsheetTitle,
            input.sheetId,
            input.sheetName,
            input.spreadsheetUrl,
            now,
            existing.id,
          );
        const updated = this.getLink(existing.id);
        if (!updated) throw new ProductError('SHEET_LINK_NOT_FOUND', '表格连接不存在', 404);
        return updated;
      }
    }

    const id = randomUUID();
    const sortOrder = this.listLinks(input.kind).length;
    const defaultMachineName = this.getImageHostConfig().defaultMachineName || '电脑1号';
    const configJson =
      input.kind === 'post_schedule'
        ? JSON.stringify(PostScheduleSheetConfig.parse(input.scheduleConfig ?? {}))
        : input.kind === 'post_records'
          ? JSON.stringify(
              PostRecordsSheetConfig.parse({
                machineName: defaultMachineName,
                ...(input.recordsConfig ?? {}),
              }),
            )
          : '{}';
    const runtimeJson = JSON.stringify(GoogleSheetLinkRuntime.parse({}));
    this.db
      .prepare(
        `INSERT INTO google_sheet_links(
          id, kind, title, spreadsheet_id, spreadsheet_title, sheet_id, sheet_name,
          spreadsheet_url, sort_order, enabled, config_json, runtime_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.title.trim() || input.sheetName,
        input.spreadsheetId,
        input.spreadsheetTitle,
        input.sheetId,
        input.sheetName,
        input.spreadsheetUrl,
        sortOrder,
        configJson,
        runtimeJson,
        now,
        now,
      );
    const created = this.getLink(id);
    if (!created) throw new ProductError('SHEET_LINK_CREATE_FAILED', '创建表格连接失败', 500);
    return created;
  }

  updateLink(input: {
    id: string;
    title?: string | undefined;
    sheetId?: number | undefined;
    sheetName?: string | undefined;
    spreadsheetTitle?: string | undefined;
    enabled?: boolean | undefined;
    scheduleConfig?: Partial<PostScheduleSheetConfigValue> | undefined;
    recordsConfig?: Partial<PostRecordsSheetConfigValue> | undefined;
  }): GoogleSheetLinkValue {
    const existing = this.getLink(input.id);
    if (!existing) throw new ProductError('SHEET_LINK_NOT_FOUND', '表格连接不存在', 404);
    const nextConfigJson =
      existing.kind === 'post_schedule'
        ? JSON.stringify(
            PostScheduleSheetConfig.parse({
              ...(existing.scheduleConfig ?? {}),
              ...(input.scheduleConfig ?? {}),
            }),
          )
        : existing.kind === 'post_records'
          ? JSON.stringify(
              PostRecordsSheetConfig.parse({
                ...(existing.recordsConfig ?? {}),
                ...(input.recordsConfig ?? {}),
              }),
            )
          : '{}';
    this.db
      .prepare(
        `UPDATE google_sheet_links
         SET title = ?, sheet_id = ?, sheet_name = ?, spreadsheet_title = ?,
             enabled = ?, config_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title?.trim() || existing.title,
        input.sheetId ?? existing.sheetId,
        input.sheetName?.trim() || existing.sheetName,
        input.spreadsheetTitle ?? existing.spreadsheetTitle,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        nextConfigJson,
        Date.now(),
        existing.id,
      );
    const updated = this.getLink(existing.id);
    if (!updated) throw new ProductError('SHEET_LINK_NOT_FOUND', '表格连接不存在', 404);
    return updated;
  }

  updateLinkRuntime(
    id: string,
    patch: Partial<GoogleSheetLinkRuntimeValue>,
  ): GoogleSheetLinkValue | null {
    const existing = this.getLink(id);
    if (!existing) return null;
    const nextRuntime = GoogleSheetLinkRuntime.parse({
      ...existing.runtime,
      ...patch,
    });
    this.db
      .prepare('UPDATE google_sheet_links SET runtime_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextRuntime), Date.now(), id);
    return this.getLink(id);
  }

  deleteLink(id: string): boolean {
    return transaction(this.db, () => {
      const res = this.db.prepare('DELETE FROM google_sheet_links WHERE id = ?').run(id);
      if (res.changes > 0) {
        this.db.prepare('DELETE FROM sheet_schedule_items WHERE link_id = ?').run(id);
        this.db.prepare('DELETE FROM sheet_record_posts WHERE link_id = ?').run(id);
      }
      return res.changes > 0;
    });
  }

  getImageCache(contentHash: string): SheetImageCacheRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sheet_image_cache WHERE content_hash = ?')
      .get(contentHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      contentHash: String(row.content_hash),
      host: row.host === 'drive' ? 'drive' : 'gyazo',
      remoteUrl: String(row.remote_url),
      driveFileId: row.drive_file_id ? String(row.drive_file_id) : null,
      mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size ?? 0),
      createdAt: Number(row.created_at ?? 0),
    };
  }

  saveImageCache(record: SheetImageCacheRecord): void {
    this.db
      .prepare(
        `INSERT INTO sheet_image_cache(
          content_hash, host, remote_url, drive_file_id, mime_type, byte_size, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
          host = excluded.host,
          remote_url = excluded.remote_url,
          drive_file_id = excluded.drive_file_id,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size`,
      )
      .run(
        record.contentHash,
        record.host,
        record.remoteUrl,
        record.driveFileId,
        record.mimeType,
        record.byteSize,
        record.createdAt,
      );
  }

  countImageCache(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sheet_image_cache').get() as {
      n?: number;
    };
    return Number(row?.n ?? 0);
  }

  getScheduleItem(linkId: string, resourceCode: string): SheetScheduleItemRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sheet_schedule_items WHERE link_id = ? AND resource_code = ?')
      .get(linkId, resourceCode) as Record<string, unknown> | undefined;
    return row ? this.deserializeScheduleItem(row) : null;
  }

  listScheduleItems(linkId: string, limit = 500): SheetScheduleItemRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM sheet_schedule_items WHERE link_id = ? ORDER BY updated_at DESC LIMIT ?',
      )
      .all(linkId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeScheduleItem(row));
  }

  private deserializeScheduleItem(row: Record<string, unknown>): SheetScheduleItemRecord {
    let postedGroupIds: string[] = [];
    try {
      const arr = JSON.parse(String(row.posted_group_ids_json ?? '[]'));
      if (Array.isArray(arr)) postedGroupIds = arr.map(String);
    } catch {
      postedGroupIds = [];
    }
    const ai = String(row.ai_label ?? 'default');
    const st = String(row.status ?? 'pending');
    return {
      linkId: String(row.link_id),
      resourceCode: String(row.resource_code),
      pageId: String(row.page_id ?? ''),
      scheduledAt: Number(row.scheduled_at ?? 0),
      caption: String(row.caption ?? ''),
      mediaSource: String(row.media_source ?? ''),
      aiLabel: ai === 'on' || ai === 'off' ? ai : 'default',
      postTimeline: Number(row.post_timeline ?? 0) === 1,
      groupsSpec: String(row.groups_spec ?? ''),
      thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
      status:
        st === 'running' || st === 'completed' || st === 'partial' || st === 'failed'
          ? st
          : 'pending',
      timelinePosted: Number(row.timeline_posted ?? 0) === 1,
      postedGroupIds,
      targetGroupCount: Number(row.target_group_count ?? 0),
      postedGroupCount: Number(row.posted_group_count ?? 0),
      errorMessage: row.error_message ? String(row.error_message) : null,
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  upsertScheduleItem(item: SheetScheduleItemRecord): SheetScheduleItemRecord {
    this.db
      .prepare(
        `INSERT INTO sheet_schedule_items(
          link_id, resource_code, page_id, scheduled_at, caption, media_source, ai_label,
          post_timeline, groups_spec, thumbnail_url, status, timeline_posted,
          posted_group_ids_json, target_group_count, posted_group_count, error_message, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(link_id, resource_code) DO UPDATE SET
          page_id = excluded.page_id,
          scheduled_at = excluded.scheduled_at,
          caption = excluded.caption,
          media_source = excluded.media_source,
          ai_label = excluded.ai_label,
          post_timeline = excluded.post_timeline,
          groups_spec = excluded.groups_spec,
          thumbnail_url = COALESCE(excluded.thumbnail_url, sheet_schedule_items.thumbnail_url),
          status = excluded.status,
          timeline_posted = excluded.timeline_posted,
          posted_group_ids_json = excluded.posted_group_ids_json,
          target_group_count = excluded.target_group_count,
          posted_group_count = excluded.posted_group_count,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
      )
      .run(
        item.linkId,
        item.resourceCode,
        item.pageId,
        item.scheduledAt,
        item.caption,
        item.mediaSource,
        item.aiLabel,
        item.postTimeline ? 1 : 0,
        item.groupsSpec,
        item.thumbnailUrl,
        item.status,
        item.timelinePosted ? 1 : 0,
        JSON.stringify([...new Set(item.postedGroupIds)]),
        item.targetGroupCount,
        item.postedGroupCount,
        item.errorMessage,
        item.updatedAt,
      );
    return item;
  }

  private deserializeRecordPost(row: Record<string, unknown>): SheetRecordPostRecord {
    let bumpedProfileIds: string[] = [];
    try {
      const arr = JSON.parse(String(row.bumped_profile_ids_json ?? '[]'));
      if (Array.isArray(arr)) bumpedProfileIds = arr.map(String);
    } catch {
      bumpedProfileIds = [];
    }
    return {
      linkId: String(row.link_id),
      postCode: String(row.post_code),
      resourceCode: String(row.resource_code ?? ''),
      postedAtText: String(row.posted_at_text ?? ''),
      postedAtMs:
        row.posted_at_ms === null || row.posted_at_ms === undefined
          ? null
          : Number(row.posted_at_ms),
      groupId: String(row.group_id ?? ''),
      groupName: String(row.group_name ?? ''),
      pageId: String(row.page_id ?? ''),
      pageName: String(row.page_name ?? ''),
      postUrl: String(row.post_url ?? ''),
      postId: row.post_id ? String(row.post_id) : null,
      thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
      likesCount:
        row.likes_count === null || row.likes_count === undefined ? null : Number(row.likes_count),
      commentsCount:
        row.comments_count === null || row.comments_count === undefined
          ? null
          : Number(row.comments_count),
      metricsStage: Number(row.metrics_stage ?? 0),
      metricsUpdatedAt:
        row.metrics_updated_at === null || row.metrics_updated_at === undefined
          ? null
          : Number(row.metrics_updated_at),
      localBumpedCount: Number(row.local_bumped_count ?? 0),
      bumpedProfileIds,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  getRecordPost(linkId: string, postCode: string): SheetRecordPostRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sheet_record_posts WHERE link_id = ? AND post_code = ?')
      .get(linkId, postCode) as Record<string, unknown> | undefined;
    return row ? this.deserializeRecordPost(row) : null;
  }

  listRecordPosts(linkId: string, limit?: number): SheetRecordPostRecord[] {
    const rows = (
      typeof limit === 'number' && limit > 0
        ? this.db
            .prepare(
              'SELECT * FROM sheet_record_posts WHERE link_id = ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(linkId, limit)
        : this.db
            .prepare('SELECT * FROM sheet_record_posts WHERE link_id = ? ORDER BY created_at DESC')
            .all(linkId)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeRecordPost(row));
  }

  upsertRecordPost(record: SheetRecordPostRecord): SheetRecordPostRecord {
    const existingRow = this.db
      .prepare(
        'SELECT bumped_profile_ids_json FROM sheet_record_posts WHERE link_id = ? AND post_code = ?',
      )
      .get(record.linkId, record.postCode) as { bumped_profile_ids_json?: string } | undefined;
    let prevIds: string[] = [];
    if (existingRow?.bumped_profile_ids_json) {
      try {
        const parsed: unknown = JSON.parse(existingRow.bumped_profile_ids_json);
        if (Array.isArray(parsed)) {
          prevIds = parsed.filter((item): item is string => typeof item === 'string');
        }
      } catch {
        prevIds = [];
      }
    }
    const mergedBumpedIds = [...new Set([...prevIds, ...record.bumpedProfileIds])];

    this.db
      .prepare(
        `INSERT INTO sheet_record_posts(
          link_id, post_code, resource_code, posted_at_text, posted_at_ms,
          group_id, group_name, page_id, page_name, post_url, post_id, thumbnail_url,
          likes_count, comments_count, metrics_stage, metrics_updated_at,
          local_bumped_count, bumped_profile_ids_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(link_id, post_code) DO UPDATE SET
          posted_at_text = CASE WHEN excluded.posted_at_text != '' THEN excluded.posted_at_text ELSE sheet_record_posts.posted_at_text END,
          posted_at_ms = COALESCE(excluded.posted_at_ms, sheet_record_posts.posted_at_ms),
          group_id = CASE WHEN excluded.group_id != '' THEN excluded.group_id ELSE sheet_record_posts.group_id END,
          group_name = CASE WHEN excluded.group_name != '' THEN excluded.group_name ELSE sheet_record_posts.group_name END,
          page_id = CASE WHEN excluded.page_id != '' THEN excluded.page_id ELSE sheet_record_posts.page_id END,
          page_name = CASE WHEN excluded.page_name != '' THEN excluded.page_name ELSE sheet_record_posts.page_name END,
          post_url = CASE WHEN excluded.post_url != '' THEN excluded.post_url ELSE sheet_record_posts.post_url END,
          post_id = COALESCE(excluded.post_id, sheet_record_posts.post_id),
          thumbnail_url = COALESCE(excluded.thumbnail_url, sheet_record_posts.thumbnail_url),
          likes_count = COALESCE(excluded.likes_count, sheet_record_posts.likes_count),
          comments_count = COALESCE(excluded.comments_count, sheet_record_posts.comments_count),
          metrics_stage = MAX(sheet_record_posts.metrics_stage, excluded.metrics_stage),
          metrics_updated_at = COALESCE(excluded.metrics_updated_at, sheet_record_posts.metrics_updated_at),
          local_bumped_count = MAX(sheet_record_posts.local_bumped_count, excluded.local_bumped_count),
          bumped_profile_ids_json = excluded.bumped_profile_ids_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.linkId,
        record.postCode,
        record.resourceCode,
        record.postedAtText,
        record.postedAtMs,
        record.groupId,
        record.groupName,
        record.pageId,
        record.pageName,
        record.postUrl,
        record.postId,
        record.thumbnailUrl,
        record.likesCount,
        record.commentsCount,
        record.metricsStage,
        record.metricsUpdatedAt,
        Math.max(record.localBumpedCount, mergedBumpedIds.length),
        JSON.stringify(mergedBumpedIds),
        record.createdAt,
        record.updatedAt,
      );
    return { ...record, bumpedProfileIds: mergedBumpedIds };
  }

  appendLog(input: {
    linkId?: string | null | undefined;
    level: 'info' | 'warn' | 'error';
    action: string;
    summary: string;
  }): SheetSyncLogEntryValue {
    const entry: SheetSyncLogEntryValue = SheetSyncLogEntry.parse({
      id: randomUUID(),
      linkId: input.linkId ?? null,
      level: input.level,
      action: input.action,
      summary: input.summary.slice(0, 600),
      createdAt: Date.now(),
    });
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO sheet_sync_logs(id, link_id, level, action, summary, created_at) VALUES(?, ?, ?, ?, ?, ?)',
        )
        .run(entry.id, entry.linkId, entry.level, entry.action, entry.summary, entry.createdAt);
      // Keep table bounded to last 500 log rows
      this.db
        .prepare(
          `DELETE FROM sheet_sync_logs WHERE id NOT IN (
          SELECT id FROM sheet_sync_logs ORDER BY created_at DESC LIMIT 500
        )`,
        )
        .run();
    });
    return entry;
  }

  listLogs(limit = 60, linkId?: string | null): SheetSyncLogEntryValue[] {
    const rows = (
      linkId
        ? this.db
            .prepare(
              'SELECT * FROM sheet_sync_logs WHERE link_id = ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(linkId, limit)
        : this.db
            .prepare('SELECT * FROM sheet_sync_logs ORDER BY created_at DESC LIMIT ?')
            .all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      SheetSyncLogEntry.parse({
        id: String(row.id),
        linkId: row.link_id ? String(row.link_id) : null,
        level: String(row.level),
        action: String(row.action),
        summary: String(row.summary),
        createdAt: Number(row.created_at),
      }),
    );
  }
}
