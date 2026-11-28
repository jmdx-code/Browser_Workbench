import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './sqlite-transaction.js';
import { ProductError } from '../domain/workspace.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import * as GS from '../shared/google-sheets.js';
import { BumperSettings } from '../shared/group-bumper.js';
import type { GoogleSheetsRepositoryPort } from '../application/google-sheets-ports.js';
export interface SheetSecretProtector {
  isAvailable(): boolean;
  encryptBatch(values: readonly string[]): string[];
  decryptBatch(values: readonly string[]): string[];
}
const ENC_SAFE_PREFIX = 'enc:safe:v1:';
const ENC_DPAPI_PREFIX = 'enc:dpapi:v1:';
const ENC_CUSTOM_PREFIX = 'enc:custom:v1:';
export const isEncryptedSecret = (v: unknown): v is string =>
  typeof v === 'string' &&
  (v.startsWith(ENC_SAFE_PREFIX) ||
    v.startsWith(ENC_DPAPI_PREFIX) ||
    v.startsWith(ENC_CUSTOM_PREFIX));
interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}
function resolveElectronSafeStorage(): SafeStorageLike | null {
  if (!process.versions?.electron) return null;
  try {
    const mod = createRequire(import.meta.url)('electron') as {
      safeStorage?: Partial<SafeStorageLike>;
    };
    const ss = mod?.safeStorage;
    return ss?.isEncryptionAvailable?.() && ss.encryptString && ss.decryptString
      ? (ss as SafeStorageLike)
      : null;
  } catch {
    return null;
  }
}
const makeDpapiScript = (op: 'Protect' | 'Unprotect') =>
  '[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Security;' +
  '$items=[Console]::In.ReadToEnd()|ConvertFrom-Json;$out=@();foreach($s in @($items)){' +
  (op === 'Protect'
    ? '$b=[Text.Encoding]::UTF8.GetBytes([string]$s);$out+=[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,"CurrentUser"))'
    : '$b=[Convert]::FromBase64String([string]$s);$out+=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser"))') +
  '};ConvertTo-Json -InputObject @($out) -Compress';
function runPsDpapiBatch(op: 'Protect' | 'Unprotect', items: readonly string[]): string[] {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', makeDpapiScript(op)],
    { input: JSON.stringify(items), encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== items.length)
    throw new Error('DPAPI batch length mismatch');
  return parsed.map(String);
}
export function createDefaultSecretProtector(): SheetSecretProtector {
  const encCache = new Map<string, string>();
  const decCache = new Map<string, string>();
  const remember = (map: Map<string, string>, k: string, v: string) => {
    if (map.size >= 256) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(k, v);
  };
  let dpapiChecked = false;
  let dpapiAvailable = false;
  const checkDpapi = (): boolean => {
    if (process.env.WORKBENCH_DISABLE_DPAPI === '1' || process.platform !== 'win32') return false;
    if (!dpapiChecked) {
      dpapiChecked = true;
      try {
        dpapiAvailable = Boolean(runPsDpapiBatch('Protect', ['__probe__'])[0]);
      } catch {
        dpapiAvailable = false;
      }
    }
    return dpapiAvailable;
  };
  return {
    isAvailable: () =>
      process.env.WORKBENCH_DISABLE_DPAPI !== '1' &&
      (resolveElectronSafeStorage() !== null || checkDpapi()),
    encryptBatch(values: readonly string[]): string[] {
      const out = [...values];
      const safe = resolveElectronSafeStorage();
      const pending: Array<{ idx: number; val: string }> = [];
      values.forEach((v, i) => {
        if (!v || isEncryptedSecret(v)) return;
        const cached = encCache.get(v);
        if (cached) out[i] = cached;
        else if (safe) {
          const enc = `${ENC_SAFE_PREFIX}${safe.encryptString(v).toString('base64')}`;
          remember(encCache, v, enc);
          remember(decCache, enc, v);
          out[i] = enc;
        } else pending.push({ idx: i, val: v });
      });
      if (pending.length && checkDpapi()) {
        const encList = runPsDpapiBatch(
          'Protect',
          pending.map((p) => p.val),
        );
        pending.forEach((p, j) => {
          const enc = `${ENC_DPAPI_PREFIX}${encList[j] ?? ''}`;
          remember(encCache, p.val, enc);
          remember(decCache, enc, p.val);
          out[p.idx] = enc;
        });
      }
      return out;
    },
    decryptBatch(values: readonly string[]): string[] {
      const out = [...values];
      const safe = resolveElectronSafeStorage();
      const pending: Array<{ idx: number; b64: string; raw: string }> = [];
      values.forEach((v, i) => {
        if (!isEncryptedSecret(v)) return;
        const cached = decCache.get(v);
        if (cached !== undefined) out[i] = cached;
        else if (v.startsWith(ENC_SAFE_PREFIX) && safe) {
          try {
            const plain = safe.decryptString(
              Buffer.from(v.slice(ENC_SAFE_PREFIX.length), 'base64'),
            );
            remember(decCache, v, plain);
            out[i] = plain;
          } catch {
            out[i] = '';
          }
        } else if (v.startsWith(ENC_DPAPI_PREFIX)) {
          pending.push({ idx: i, b64: v.slice(ENC_DPAPI_PREFIX.length), raw: v });
        }
      });
      if (pending.length && process.platform === 'win32') {
        try {
          const decList = runPsDpapiBatch(
            'Unprotect',
            pending.map((p) => p.b64),
          );
          pending.forEach((p, j) => {
            const plain = decList[j] ?? '';
            remember(decCache, p.raw, plain);
            out[p.idx] = plain;
          });
        } catch {
          pending.forEach((p) => {
            out[p.idx] = '';
          });
        }
      }
      return out;
    },
  };
}
import type {
  SheetImageCachePortRecord,
  SheetRecordPostPortRecord,
  SheetScheduleItemPortRecord,
  StoredGoogleAuthDataPort,
} from '../application/google-sheets-ports.js';
export type {
  StoredGoogleAuthDataPort as StoredGoogleAuthData,
  SheetImageCachePortRecord as SheetImageCacheRecord,
  SheetScheduleItemPortRecord as SheetScheduleItemRecord,
  SheetRecordPostPortRecord as SheetRecordPostRecord,
};
type StoredGoogleAuthData = StoredGoogleAuthDataPort;
type SheetImageCacheRecord = SheetImageCachePortRecord;
type SheetScheduleItemRecord = SheetScheduleItemPortRecord;
type SheetRecordPostRecord = SheetRecordPostPortRecord;
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
const DEFAULT_IMAGE_HOST = GS.SheetImageHostConfig.parse({});
function initGoogleSheetsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_sheets_config ( id INTEGER PRIMARY KEY CHECK(id = 1), auth_json TEXT NOT NULL, image_host_json TEXT NOT NULL, updated_at INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS google_sheet_links ( id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('group_library','page_library','post_schedule','post_records')), title TEXT NOT NULL, spreadsheet_id TEXT NOT NULL, spreadsheet_title TEXT NOT NULL DEFAULT '', sheet_id INTEGER NOT NULL DEFAULT 0, sheet_name TEXT NOT NULL, spreadsheet_url TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', runtime_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
    CREATE INDEX IF NOT EXISTS idx_google_sheet_links_kind_sort ON google_sheet_links(kind, sort_order, created_at);
    CREATE TABLE IF NOT EXISTS sheet_image_cache ( content_hash TEXT PRIMARY KEY, host TEXT NOT NULL CHECK(host IN ('gyazo','drive')), remote_url TEXT NOT NULL, drive_file_id TEXT, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS sheet_schedule_items ( link_id TEXT NOT NULL, resource_code TEXT NOT NULL, page_id TEXT NOT NULL DEFAULT '', scheduled_at INTEGER NOT NULL DEFAULT 0, caption TEXT NOT NULL DEFAULT '', media_source TEXT NOT NULL DEFAULT '', ai_label TEXT NOT NULL DEFAULT 'default', post_timeline INTEGER NOT NULL DEFAULT 0, groups_spec TEXT NOT NULL DEFAULT '', thumbnail_url TEXT, status TEXT NOT NULL DEFAULT 'pending', timeline_posted INTEGER NOT NULL DEFAULT 0, posted_group_ids_json TEXT NOT NULL DEFAULT '[]', target_group_count INTEGER NOT NULL DEFAULT 0, posted_group_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(link_id, resource_code) );
    CREATE INDEX IF NOT EXISTS idx_sheet_schedule_items_link_status ON sheet_schedule_items(link_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS sheet_record_posts ( link_id TEXT NOT NULL, post_code TEXT NOT NULL, resource_code TEXT NOT NULL DEFAULT '', posted_at_text TEXT NOT NULL DEFAULT '', posted_at_ms INTEGER, group_id TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '', page_id TEXT NOT NULL DEFAULT '', page_name TEXT NOT NULL DEFAULT '', post_url TEXT NOT NULL DEFAULT '', post_id TEXT, thumbnail_url TEXT, likes_count INTEGER, comments_count INTEGER, metrics_stage INTEGER NOT NULL DEFAULT 0, metrics_updated_at INTEGER, local_bumped_count INTEGER NOT NULL DEFAULT 0, bumped_profile_ids_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(link_id, post_code) );
    CREATE INDEX IF NOT EXISTS idx_sheet_record_posts_link_created ON sheet_record_posts(link_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS sheet_sync_logs ( id TEXT PRIMARY KEY, link_id TEXT, level TEXT NOT NULL CHECK(level IN ('info','warn','error')), action TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL );
    CREATE INDEX IF NOT EXISTS idx_sheet_sync_logs_created ON sheet_sync_logs(created_at DESC);
  `);
  Q.ensureColumns(db, 'sheet_schedule_items', [
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_retry_at', 'INTEGER'],
    ['last_error', 'TEXT'],
  ]);
  const now = Date.now();
  db.prepare(
    "UPDATE sheet_schedule_items SET status = CASE WHEN timeline_posted = 1 OR posted_group_count > 0 THEN 'partial' ELSE 'pending' END, error_message = COALESCE(error_message, '上次发布时软件异常退出，已重置待续跑'), updated_at = ? WHERE status = 'running'",
  ).run(now);
  for (const r of Q.allRows(db, 'SELECT id, runtime_json FROM google_sheet_links')) {
    const parsed = Q.parseJsonObject(r.runtime_json);
    if (parsed.activeJobText || parsed.activeRunningCount) {
      parsed.activeJobText = '';
      parsed.activeRunningCount = 0;
      db.prepare('UPDATE google_sheet_links SET runtime_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(parsed),
        now,
        Q.s(r.id),
      );
    }
  }
}
const serializeLinkConfig = (
  kind: GS.GoogleSheetKind,
  sched?: Partial<GS.PostScheduleSheetConfig>,
  rec?: Partial<GS.PostRecordsSheetConfig>,
) =>
  kind === 'post_schedule'
    ? JSON.stringify(GS.PostScheduleSheetConfig.parse(sched ?? {}))
    : kind === 'post_records'
      ? JSON.stringify(GS.PostRecordsSheetConfig.parse(rec ?? {}))
      : '{}';
function deserializeLink(row: Record<string, unknown>): GS.GoogleSheetLink {
  const kind = GS.GoogleSheetKind.parse(Q.s(row.kind)),
    parsedConfig = Q.parseJsonObject(row.config_json);
  const runtime = Q.parseWithFallback(
    () => GS.GoogleSheetLinkRuntime.parse(JSON.parse(Q.s(row.runtime_json, '{}'))),
    GS.GoogleSheetLinkRuntime.parse({}),
  );
  const base = { ...Q.camel(row, 'enabled'), kind, enabled: Q.b(row.enabled ?? 1), runtime };
  return GS.GoogleSheetLink.parse(
    kind === 'post_schedule'
      ? { ...base, scheduleConfig: GS.PostScheduleSheetConfig.parse(parsedConfig) }
      : kind === 'post_records'
        ? { ...base, recordsConfig: GS.PostRecordsSheetConfig.parse(parsedConfig) }
        : base,
  );
}
function deserializeScheduleItem(r: Record<string, unknown>): SheetScheduleItemRecord {
  const ai = Q.s(r.ai_label, 'default'),
    st = Q.s(r.status, 'pending');
  return {
    ...(Q.camel(r, 'post_timeline,timeline_posted') as unknown as SheetScheduleItemRecord),
    aiLabel: ai === 'on' || ai === 'off' ? ai : 'default',
    status:
      st === 'running' || st === 'completed' || st === 'partial' || st === 'failed'
        ? st
        : 'pending',
    postedGroupIds: Q.parseJsonStringArray(r.posted_group_ids_json),
    thumbnailUrl: Q.nonEmptyTrimmed(r.thumbnail_url),
    errorMessage: Q.nonEmptyTrimmed(r.error_message),
    attemptCount: Math.max(0, Number(r.attempt_count ?? 0) || 0),
    nextRetryAt: Q.nn(r.next_retry_at),
    lastError: Q.nonEmptyTrimmed(r.last_error) ?? Q.nonEmptyTrimmed(r.error_message),
  };
}
const deserializeRecordPost = (r: Record<string, unknown>): SheetRecordPostRecord => ({
  ...(Q.camel(r) as unknown as SheetRecordPostRecord),
  postId: Q.nonEmptyTrimmed(r.post_id),
  thumbnailUrl: Q.nonEmptyTrimmed(r.thumbnail_url),
  bumpedProfileIds: Q.parseJsonStringArray(r.bumped_profile_ids_json),
});
function encryptSecretFields(
  fields: string[],
  protector: SheetSecretProtector,
): { values: string[]; migrated: boolean } {
  if (!protector.isAvailable() || !fields.some((f) => f && !isEncryptedSecret(f)))
    return { values: fields, migrated: false };
  const enc = protector.encryptBatch(fields);
  return { values: fields.map((f, i) => (f ? (enc[i] ?? f) : f)), migrated: true };
}
function encryptAuthSecrets(auth: StoredGoogleAuthData, protector: SheetSecretProtector) {
  const { values, migrated } = encryptSecretFields(
    [auth.clientSecret, auth.accessToken ?? '', auth.refreshToken ?? ''],
    protector,
  );
  if (!migrated) return { serialized: JSON.stringify(auth), migrated: false };
  return {
    serialized: JSON.stringify({
      ...auth,
      clientSecret: auth.clientSecret ? (values[0] ?? auth.clientSecret) : '',
      accessToken: auth.accessToken ? (values[1] ?? auth.accessToken) : null,
      refreshToken: auth.refreshToken ? (values[2] ?? auth.refreshToken) : null,
    }),
    migrated: true,
  };
}
function encryptImageHostSecrets(cfg: GS.SheetImageHostConfig, protector: SheetSecretProtector) {
  const toks = GS.resolveEffectiveGyazoTokens(cfg);
  const { values, migrated } = encryptSecretFields([cfg.gyazoAccessToken, ...toks], protector);
  if (!migrated) return { serialized: JSON.stringify(cfg), migrated: false };
  return {
    serialized: JSON.stringify({
      ...cfg,
      gyazoAccessToken: cfg.gyazoAccessToken ? (values[0] ?? cfg.gyazoAccessToken) : '',
      gyazoAccessTokens: toks.map((t, idx) => values[idx + 1] ?? t),
    }),
    migrated: true,
  };
}
const decryptFieldList = (fields: string[], protector: SheetSecretProtector) => {
  const hasEnc = fields.some(isEncryptedSecret);
  return {
    dec: hasEnc ? protector.decryptBatch(fields) : fields,
    hasPlain: fields.some((v) => v.trim().length > 0 && !isEncryptedSecret(v)),
  };
};
function ensureGoogleSheetsConfigRow(
  db: DatabaseSync,
  protector: SheetSecretProtector,
): { auth: StoredGoogleAuthData; imageHost: GS.SheetImageHostConfig } {
  const row = Q.getRow(
    db,
    'SELECT auth_json, image_host_json FROM google_sheets_config WHERE id = 1',
  );
  if (!row) {
    db.prepare(
      'INSERT OR IGNORE INTO google_sheets_config(id, auth_json, image_host_json, updated_at) VALUES(1,?,?,?)',
    ).run(JSON.stringify(DEFAULT_AUTH), JSON.stringify(DEFAULT_IMAGE_HOST), Date.now());
    return { auth: { ...DEFAULT_AUTH }, imageHost: { ...DEFAULT_IMAGE_HOST } };
  }
  const rawAuthObj = Q.parseWithFallback(
    () => JSON.parse(Q.s(row.auth_json, '{}')) as Partial<StoredGoogleAuthData>,
    {} as Partial<StoredGoogleAuthData>,
  );
  const rawAccessToken = typeof rawAuthObj.accessToken === 'string' ? rawAuthObj.accessToken : null;
  const rawRefreshToken =
    typeof rawAuthObj.refreshToken === 'string' ? rawAuthObj.refreshToken : null;
  const { dec: authDec, hasPlain: authHasPlain } = decryptFieldList(
    [
      typeof rawAuthObj.clientSecret === 'string' ? rawAuthObj.clientSecret : '',
      rawAccessToken ?? '',
      rawRefreshToken ?? '',
    ],
    protector,
  );
  const auth: StoredGoogleAuthData = {
    ...DEFAULT_AUTH,
    ...rawAuthObj,
    clientSecret: authDec[0] ?? '',
    accessToken: rawAccessToken ? authDec[1] || null : null,
    refreshToken: rawRefreshToken ? authDec[2] || null : null,
    scopes: Array.isArray(rawAuthObj.scopes) ? rawAuthObj.scopes.map(String) : [],
  };
  const rawImgObj = Q.parseWithFallback(
    () => JSON.parse(Q.s(row.image_host_json, '{}')) as Record<string, unknown>,
    {},
  );
  const { dec: imgDec, hasPlain: imgHasPlain } = decryptFieldList(
    [
      typeof rawImgObj.gyazoAccessToken === 'string' ? rawImgObj.gyazoAccessToken : '',
      ...(Array.isArray(rawImgObj.gyazoAccessTokens)
        ? rawImgObj.gyazoAccessTokens.filter((v): v is string => typeof v === 'string')
        : []),
    ],
    protector,
  );
  const imageHost = Q.parseWithFallback(
    () => {
      const p = GS.SheetImageHostConfig.parse({
        ...rawImgObj,
        gyazoAccessToken: imgDec[0] ?? '',
        gyazoAccessTokens: imgDec.slice(1).filter((v) => v.trim().length > 0),
      });
      const t = GS.resolveEffectiveGyazoTokens(p);
      return { ...p, gyazoAccessTokens: t, gyazoAccessToken: t[0] ?? '' };
    },
    { ...DEFAULT_IMAGE_HOST },
  );
  if (protector.isAvailable() && (authHasPlain || imgHasPlain)) {
    const encAuth = authHasPlain
      ? encryptAuthSecrets(auth, protector)
      : { serialized: Q.s(row.auth_json), migrated: false };
    const encImg = imgHasPlain
      ? encryptImageHostSecrets(imageHost, protector)
      : { serialized: Q.s(row.image_host_json), migrated: false };
    if (encAuth.migrated || encImg.migrated) {
      db.prepare(
        'UPDATE google_sheets_config SET auth_json = ?, image_host_json = ?, updated_at = ? WHERE id = 1',
      ).run(encAuth.serialized, encImg.serialized, Date.now());
    }
  }
  return { auth, imageHost };
}
function mustGetGoogleSheetLink(
  db: DatabaseSync,
  id: string,
  code = 'SHEET_LINK_NOT_FOUND',
  msg = '表格连接不存在',
  status = 404,
): GS.GoogleSheetLink {
  const r = Q.getRow(db, 'SELECT * FROM google_sheet_links WHERE id = ?', id);
  const link = r ? deserializeLink(r) : null;
  if (!link) throw new ProductError(code, msg, status);
  return link;
}
function saveSheetsConfigRow(
  db: DatabaseSync,
  protector: SheetSecretProtector,
  updateCol: 'auth_json' | 'image_host_json',
  auth: StoredGoogleAuthData,
  imageHost: GS.SheetImageHostConfig,
) {
  Q.upsert(
    db,
    'google_sheets_config',
    'id',
    'id,auth_json,image_host_json,updated_at',
    `${updateCol},updated_at`,
    1,
    encryptAuthSecrets(auth, protector).serialized,
    encryptImageHostSecrets(imageHost, protector).serialized,
    Date.now(),
  );
}
export class SqliteGoogleSheetsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly protector: SheetSecretProtector = createDefaultSecretProtector(),
  ) {
    initGoogleSheetsSchema(db);
  }
  getAuthConfig = () => ensureGoogleSheetsConfigRow(this.db, this.protector).auth;
  getImageHostConfig = () => ensureGoogleSheetsConfigRow(this.db, this.protector).imageHost;
  saveAuthConfig(patch: Partial<StoredGoogleAuthData>): StoredGoogleAuthData {
    const cur = ensureGoogleSheetsConfigRow(this.db, this.protector);
    const next: StoredGoogleAuthData = {
      ...cur.auth,
      ...patch,
      scopes: Array.isArray(patch.scopes) ? patch.scopes : cur.auth.scopes,
    };
    saveSheetsConfigRow(this.db, this.protector, 'auth_json', next, cur.imageHost);
    return next;
  }
  saveImageHostConfig(patch: Partial<GS.SheetImageHostConfig>): GS.SheetImageHostConfig {
    const cur = ensureGoogleSheetsConfigRow(this.db, this.protector);
    const tk =
      patch.gyazoAccessTokens !== undefined
        ? GS.parseGyazoTokenList(patch.gyazoAccessTokens)
        : patch.gyazoAccessToken !== undefined
          ? GS.parseGyazoTokenList(patch.gyazoAccessToken)
          : GS.resolveEffectiveGyazoTokens(cur.imageHost);
    const next = GS.SheetImageHostConfig.parse({
      ...cur.imageHost,
      ...patch,
      gyazoAccessTokens: tk,
      gyazoAccessToken: tk[0] ?? '',
    });
    saveSheetsConfigRow(this.db, this.protector, 'image_host_json', cur.auth, next);
    return next;
  }
  listLinks(kind?: GS.GoogleSheetKind): GS.GoogleSheetLink[] {
    const sql = kind
      ? 'SELECT * FROM google_sheet_links WHERE kind = ? ORDER BY sort_order ASC, created_at ASC'
      : 'SELECT * FROM google_sheet_links ORDER BY kind ASC, sort_order ASC, created_at ASC';
    return (kind ? Q.allRows(this.db, sql, kind) : Q.allRows(this.db, sql)).map(deserializeLink);
  }
  getLink = (id: string): GS.GoogleSheetLink | null => {
    const r = Q.getRow(this.db, 'SELECT * FROM google_sheet_links WHERE id = ?', id);
    return r ? deserializeLink(r) : null;
  };
  createLink(input: Parameters<GoogleSheetsRepositoryPort['createLink']>[0]): GS.GoogleSheetLink {
    const now = Date.now(),
      i = input,
      title = i.title.trim() || i.sheetName;
    if (i.kind === 'group_library' || i.kind === 'page_library') {
      const existing = this.listLinks(i.kind)[0];
      if (existing) {
        Q.run(
          this.db,
          'UPDATE google_sheet_links SET title=?, spreadsheet_id=?, spreadsheet_title=?, sheet_id=?, sheet_name=?, spreadsheet_url=?, updated_at=? WHERE id=?',
          title,
          i.spreadsheetId,
          i.spreadsheetTitle,
          i.sheetId,
          i.sheetName,
          i.spreadsheetUrl,
          now,
          existing.id,
        );
        return mustGetGoogleSheetLink(this.db, existing.id);
      }
    }
    const id = randomUUID();
    const machine = this.getImageHostConfig().defaultMachineName || '电脑1号';
    const cols =
      'id,kind,title,spreadsheet_id,spreadsheet_title,sheet_id,sheet_name,spreadsheet_url,sort_order,enabled,config_json,runtime_json,created_at,updated_at';
    Q.insertFrom(this.db, 'google_sheet_links', cols, i, {
      id,
      title,
      sort_order: this.listLinks(i.kind).length,
      enabled: 1,
      config_json: serializeLinkConfig(i.kind, i.scheduleConfig, {
        machineName: machine,
        ...(i.recordsConfig ?? {}),
      }),
      runtime_json: JSON.stringify(GS.GoogleSheetLinkRuntime.parse({})),
      created_at: now,
      updated_at: now,
    });
    return mustGetGoogleSheetLink(this.db, id, 'SHEET_LINK_CREATE_FAILED', '创建表格连接失败', 500);
  }
  updateLink(i: Parameters<GoogleSheetsRepositoryPort['updateLink']>[0]): GS.GoogleSheetLink {
    const ex = mustGetGoogleSheetLink(this.db, i.id);
    const mergedRec =
      ex.recordsConfig || i.recordsConfig
        ? {
            ...(ex.recordsConfig ?? {}),
            ...(i.recordsConfig ?? {}),
            ...(ex.recordsConfig?.bumperSettings || i.recordsConfig?.bumperSettings
              ? {
                  bumperSettings: BumperSettings.parse({
                    ...(ex.recordsConfig?.bumperSettings ?? {}),
                    ...(i.recordsConfig?.bumperSettings ?? {}),
                  }),
                }
              : {}),
          }
        : undefined;
    Q.run(
      this.db,
      'UPDATE google_sheet_links SET title=?, sheet_id=?, sheet_name=?, spreadsheet_title=?, enabled=?, config_json=?, updated_at=? WHERE id=?',
      i.title?.trim() || ex.title,
      i.sheetId ?? ex.sheetId,
      i.sheetName?.trim() || ex.sheetName,
      i.spreadsheetTitle ?? ex.spreadsheetTitle,
      (i.enabled ?? ex.enabled) ? 1 : 0,
      serializeLinkConfig(
        ex.kind,
        { ...(ex.scheduleConfig ?? {}), ...(i.scheduleConfig ?? {}) },
        mergedRec,
      ),
      Date.now(),
      ex.id,
    );
    return mustGetGoogleSheetLink(this.db, ex.id);
  }
  updateLinkRuntime(
    id: string,
    patch: Partial<GS.GoogleSheetLinkRuntime>,
  ): GS.GoogleSheetLink | null {
    const ex = this.getLink(id);
    if (!ex) return null;
    const rt = JSON.stringify(GS.GoogleSheetLinkRuntime.parse({ ...ex.runtime, ...patch }));
    Q.run(
      this.db,
      'UPDATE google_sheet_links SET runtime_json=?, updated_at=? WHERE id=?',
      rt,
      Date.now(),
      id,
    );
    return this.getLink(id);
  }
  deleteLink(id: string): boolean {
    return transaction(this.db, () => {
      const deleted = Q.run(this.db, 'DELETE FROM google_sheet_links WHERE id=?', id).changes > 0;
      if (deleted) {
        Q.run(this.db, 'DELETE FROM sheet_schedule_items WHERE link_id=?', id);
        Q.run(this.db, 'DELETE FROM sheet_record_posts WHERE link_id=?', id);
      }
      return deleted;
    });
  }
  getImageCache(contentHash: string): SheetImageCacheRecord | null {
    const r = Q.getRow(
      this.db,
      'SELECT * FROM sheet_image_cache WHERE content_hash=?',
      contentHash,
    );
    return r
      ? ({
          ...Q.camel(r),
          host: r.host === 'drive' ? 'drive' : 'gyazo',
          driveFileId: Q.nonEmptyTrimmed(r.drive_file_id),
        } as SheetImageCacheRecord)
      : null;
  }
  saveImageCache = (r: SheetImageCacheRecord): void =>
    Q.upsertFrom(
      this.db,
      'sheet_image_cache',
      'content_hash',
      'content_hash,host,remote_url,drive_file_id,mime_type,byte_size,created_at',
      'host,remote_url,drive_file_id,mime_type,byte_size',
      r,
    );
  countImageCache = () => Q.countSql(this.db, 'SELECT COUNT(*) AS n FROM sheet_image_cache');
  getScheduleItem(linkId: string, resourceCode: string): SheetScheduleItemRecord | null {
    const row = Q.getRow(
      this.db,
      'SELECT * FROM sheet_schedule_items WHERE link_id=? AND resource_code=?',
      linkId,
      resourceCode,
    );
    return row ? deserializeScheduleItem(row) : null;
  }
  upsertScheduleItem(item: SheetScheduleItemRecord): SheetScheduleItemRecord {
    const cols =
      'link_id,resource_code,page_id,scheduled_at,caption,media_source,ai_label,post_timeline,groups_spec,thumbnail_url,status,timeline_posted,posted_group_ids_json,target_group_count,posted_group_count,error_message,attempt_count,next_retry_at,last_error,updated_at';
    const sql = `INSERT INTO sheet_schedule_items(${cols}) VALUES(${Array(20).fill('?').join(',')}) ON CONFLICT(link_id, resource_code) DO UPDATE SET page_id=excluded.page_id, scheduled_at=excluded.scheduled_at, caption=excluded.caption, media_source=excluded.media_source, ai_label=excluded.ai_label, post_timeline=excluded.post_timeline, groups_spec=excluded.groups_spec, thumbnail_url=COALESCE(excluded.thumbnail_url, sheet_schedule_items.thumbnail_url), status=excluded.status, timeline_posted=excluded.timeline_posted, posted_group_ids_json=excluded.posted_group_ids_json, target_group_count=excluded.target_group_count, posted_group_count=excluded.posted_group_count, error_message=excluded.error_message, attempt_count=excluded.attempt_count, next_retry_at=excluded.next_retry_at, last_error=excluded.last_error, updated_at=excluded.updated_at`;
    const normalized: SheetScheduleItemRecord = {
      ...item,
      attemptCount: Math.max(0, Math.floor(item.attemptCount ?? 0)),
      nextRetryAt: item.nextRetryAt ?? null,
      lastError: item.lastError ?? item.errorMessage ?? null,
    };
    Q.run(
      this.db,
      sql,
      ...Q.pickVals(cols, normalized, {
        posted_group_ids_json: JSON.stringify([...new Set(normalized.postedGroupIds)]),
      }),
    );
    return normalized;
  }
  getRecordPost(linkId: string, postCode: string): SheetRecordPostRecord | null {
    const row = Q.getRow(
      this.db,
      'SELECT * FROM sheet_record_posts WHERE link_id=? AND post_code=?',
      linkId,
      postCode,
    );
    return row ? deserializeRecordPost(row) : null;
  }
  listRecordPosts(linkId: string, limit?: number): SheetRecordPostRecord[] {
    const hasLim = typeof limit === 'number' && limit > 0;
    const sql = `SELECT * FROM sheet_record_posts WHERE link_id=? ORDER BY created_at DESC${hasLim ? ' LIMIT ?' : ''}`;
    return (hasLim ? Q.allRows(this.db, sql, linkId, limit) : Q.allRows(this.db, sql, linkId)).map(
      deserializeRecordPost,
    );
  }
  upsertRecordPost(record: SheetRecordPostRecord): SheetRecordPostRecord {
    const exSql =
      'SELECT bumped_profile_ids_json FROM sheet_record_posts WHERE link_id=? AND post_code=?';
    const exRow = Q.getRow(this.db, exSql, record.linkId, record.postCode);
    const merged = [
      ...new Set([
        ...Q.parseJsonStringArray(exRow?.bumped_profile_ids_json),
        ...record.bumpedProfileIds,
      ]),
    ];
    const cols =
      'link_id,post_code,resource_code,posted_at_text,posted_at_ms,group_id,group_name,page_id,page_name,post_url,post_id,thumbnail_url,likes_count,comments_count,metrics_stage,metrics_updated_at,local_bumped_count,bumped_profile_ids_json,created_at,updated_at';
    const sql = `INSERT INTO sheet_record_posts(${cols}) VALUES(${Array(20).fill('?').join(',')}) ON CONFLICT(link_id, post_code) DO UPDATE SET
      posted_at_text=CASE WHEN excluded.posted_at_text != '' THEN excluded.posted_at_text ELSE sheet_record_posts.posted_at_text END, posted_at_ms=COALESCE(excluded.posted_at_ms, sheet_record_posts.posted_at_ms),
      group_id=CASE WHEN excluded.group_id != '' THEN excluded.group_id ELSE sheet_record_posts.group_id END, group_name=CASE WHEN excluded.group_name != '' THEN excluded.group_name ELSE sheet_record_posts.group_name END,
      page_id=CASE WHEN excluded.page_id != '' THEN excluded.page_id ELSE sheet_record_posts.page_id END, page_name=CASE WHEN excluded.page_name != '' THEN excluded.page_name ELSE sheet_record_posts.page_name END,
      post_url=CASE WHEN excluded.post_url != '' THEN excluded.post_url ELSE sheet_record_posts.post_url END, post_id=COALESCE(excluded.post_id, sheet_record_posts.post_id), thumbnail_url=COALESCE(excluded.thumbnail_url, sheet_record_posts.thumbnail_url),
      likes_count=COALESCE(excluded.likes_count, sheet_record_posts.likes_count), comments_count=COALESCE(excluded.comments_count, sheet_record_posts.comments_count),
      metrics_stage=MAX(sheet_record_posts.metrics_stage, excluded.metrics_stage), metrics_updated_at=COALESCE(excluded.metrics_updated_at, sheet_record_posts.metrics_updated_at),
      local_bumped_count=MAX(sheet_record_posts.local_bumped_count, excluded.local_bumped_count), bumped_profile_ids_json=excluded.bumped_profile_ids_json, updated_at=excluded.updated_at`;
    const vals = Q.pickVals(cols, record, {
      local_bumped_count: Math.max(record.localBumpedCount, merged.length),
      bumped_profile_ids_json: JSON.stringify(merged),
    });
    Q.run(this.db, sql, ...vals);
    return { ...record, bumpedProfileIds: merged };
  }
  appendLog(input: {
    linkId?: string | null;
    level: 'info' | 'warn' | 'error';
    action: string;
    summary: string;
  }): GS.SheetSyncLogEntry {
    const entry = GS.SheetSyncLogEntry.parse({
      id: randomUUID(),
      linkId: input.linkId ?? null,
      level: input.level,
      action: input.action,
      summary: input.summary.slice(0, 600),
      createdAt: Date.now(),
    });
    transaction(this.db, () => {
      Q.insertFrom(this.db, 'sheet_sync_logs', 'id,link_id,level,action,summary,created_at', entry);
      Q.run(
        this.db,
        "DELETE FROM sheet_sync_logs WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(link_id, '') ORDER BY created_at DESC) AS rn, created_at FROM sheet_sync_logs) WHERE rn <= 60 ORDER BY created_at DESC LIMIT 600)",
      );
    });
    return entry;
  }
  listLogs(limit = 60, linkId?: string | null): GS.SheetSyncLogEntry[] {
    const rows = linkId
      ? Q.allRows(
          this.db,
          'SELECT * FROM sheet_sync_logs WHERE link_id=? ORDER BY created_at DESC LIMIT ?',
          linkId,
          limit,
        )
      : Q.allRows(
          this.db,
          "SELECT id, link_id, level, action, summary, created_at FROM (SELECT id, link_id, level, action, summary, created_at, ROW_NUMBER() OVER (PARTITION BY COALESCE(link_id, '') ORDER BY created_at DESC) AS rn FROM sheet_sync_logs) ORDER BY rn ASC, created_at DESC LIMIT ?",
          limit,
        );
    const parsed = rows.map((r) => GS.SheetSyncLogEntry.parse(Q.camel(r)));
    return linkId ? parsed : parsed.sort((a, b) => b.createdAt - a.createdAt);
  }
}
