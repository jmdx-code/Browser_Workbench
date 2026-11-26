import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProductError } from '../domain/workspace.js';
import * as BS from '../shared/bluestacks.js';
import {
  BumperSettings,
  isLocalAvatar,
  type BumperComment,
  type BumperDailyStat,
  type BumperLog,
  type BumperScope,
  type BumperTarget,
} from '../shared/group-bumper.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { ensurePostBumpRecordsSchema } from './post-bump-records-store.js';
import { saveRecordAvatar } from './record-avatar-store.js';
import { transaction } from './sqlite-transaction.js';
import {
  BumperLogInputSchema,
  ensureBumperCommentsSchema,
  listBumperCommentsFromDb,
  pickBumperCommentFromDb,
  queryBumperEligibilityCounts,
  recordBumpEntryInDb,
} from './stores/bumper-comments-helper.js';
import { ensureBumperEffectsSchema } from './group-bumper-store.js';
import {
  ensureTargetLibrarySchema,
  SqliteTargetLibraryRepository,
} from './target-library-store.js';

export function deterministicBluestacksId(instanceKey: string): string {
  const b = Uint8Array.from(
    createHash('sha256')
      .update('workbench-bluestacks-instance:' + instanceKey.trim())
      .digest()
      .subarray(0, 16),
  );
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export interface DiscoveredInstanceRecord {
  instanceKey: string;
  displayName: string;
  adbPort: number;
  fbWidth: number;
  fbHeight: number;
  online: boolean;
  fbLiteInstalled: boolean | null;
  androidSdk?: number | null;
  fbLiteVersion?: string | null;
}
export interface BluestacksSavedSettings {
  installDir: string | null;
  confPath: string | null;
  apkPath: string | null;
  bumperSettings: BumperSettings;
  pageBumperSettings: BumperSettings;
  riskLimitSettings: BS.BluestacksRiskLimitSettings;
}

const DEFAULT_BUMPER = BumperSettings.parse({
  searchMode: 'page_group_feed',
  maxConcurrentProfiles: 4,
});
const DEFAULT_PAGE_BUMPER = BumperSettings.parse({ maxPostsPerPage: 3, maxConcurrentProfiles: 4 });

function initBluestacksSchema(db: DatabaseSync): void {
  ensureTargetLibrarySchema(db);
  ensurePostBumpRecordsSchema(db);
  ensureBumperEffectsSchema(db);
  ensureBumperCommentsSchema(db);
  Q.ensureRecordAvatarSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bluestacks_folders( id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, sort_order INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS bluestacks_instances( id TEXT PRIMARY KEY, instance_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, alias TEXT, folder_id TEXT REFERENCES bluestacks_folders(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, adb_port INTEGER NOT NULL DEFAULT 5555, fb_width INTEGER NOT NULL DEFAULT 900, fb_height INTEGER NOT NULL DEFAULT 1600, fb_lite_installed INTEGER, account_state TEXT NOT NULL DEFAULT 'unknown' CHECK(account_state IN ('unknown','logged-in','logged-out','missing-app','restricted','verification')), account_id TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '', avatar_url TEXT, last_status TEXT, updated_at INTEGER NOT NULL, identity_type TEXT NOT NULL DEFAULT 'unknown', numeric_account_id TEXT NOT NULL DEFAULT '', managed_identities_json TEXT NOT NULL DEFAULT '[]', android_sdk INTEGER, fb_lite_version TEXT );
    CREATE INDEX IF NOT EXISTS idx_bluestacks_instances_folder_order ON bluestacks_instances(folder_id, sort_order, instance_key);
    CREATE TABLE IF NOT EXISTS bluestacks_settings( id INTEGER PRIMARY KEY CHECK(id=1), install_dir TEXT, conf_path TEXT, apk_path TEXT, bumper_settings TEXT NOT NULL DEFAULT '{}', page_bumper_settings TEXT NOT NULL DEFAULT '{}', risk_limit_settings TEXT NOT NULL DEFAULT '{}' );
    CREATE TABLE IF NOT EXISTS bluestacks_daily_actions( ymd TEXT NOT NULL, instance_id TEXT NOT NULL, active_likes INTEGER NOT NULL DEFAULT 0, active_actions INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(ymd, instance_id) );
    INSERT OR IGNORE INTO bluestacks_settings(id, install_dir, conf_path, bumper_settings) VALUES(1, NULL, NULL, '{}');
  `);
  Q.ensureColumns(db, 'bluestacks_settings', [
    ['page_bumper_settings', "TEXT NOT NULL DEFAULT '{}'"],
    ['apk_path', 'TEXT'],
    ['risk_limit_settings', "TEXT NOT NULL DEFAULT '{}'"],
  ]);
  const tableSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bluestacks_instances'")
    .get();
  const tableSql = String(tableSqlRow?.sql ?? '');
  if (tableSql && !tableSql.includes("'restricted'")) {
    const cols = Q.tableColumns(db, 'bluestacks_instances');
    transaction(db, () => {
      db.exec(`
        CREATE TABLE bluestacks_instances_v2( id TEXT PRIMARY KEY, instance_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, alias TEXT, folder_id TEXT REFERENCES bluestacks_folders(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, adb_port INTEGER NOT NULL DEFAULT 5555, fb_width INTEGER NOT NULL DEFAULT 900, fb_height INTEGER NOT NULL DEFAULT 1600, fb_lite_installed INTEGER, account_state TEXT NOT NULL DEFAULT 'unknown' CHECK(account_state IN ('unknown','logged-in','logged-out','missing-app','restricted','verification')), account_id TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '', avatar_url TEXT, last_status TEXT, updated_at INTEGER NOT NULL, identity_type TEXT NOT NULL DEFAULT 'unknown', numeric_account_id TEXT NOT NULL DEFAULT '', managed_identities_json TEXT NOT NULL DEFAULT '[]', android_sdk INTEGER, fb_lite_version TEXT );
        INSERT INTO bluestacks_instances_v2( id, instance_key, display_name, alias, folder_id, sort_order, adb_port, fb_width, fb_height, fb_lite_installed, account_state, account_id, account_name, avatar_url, last_status, updated_at, identity_type, numeric_account_id, managed_identities_json, android_sdk, fb_lite_version )
        SELECT id, instance_key, display_name, alias, folder_id, sort_order, adb_port, fb_width, fb_height, fb_lite_installed, account_state, account_id, account_name, avatar_url, last_status, updated_at, ${cols.has('identity_type') ? 'identity_type' : "'unknown'"}, ${cols.has('numeric_account_id') ? 'numeric_account_id' : "''"}, ${cols.has('managed_identities_json') ? 'managed_identities_json' : "'[]'"}, ${cols.has('android_sdk') ? 'android_sdk' : 'NULL'}, ${cols.has('fb_lite_version') ? 'fb_lite_version' : 'NULL'} FROM bluestacks_instances;
        DROP TABLE bluestacks_instances;
        ALTER TABLE bluestacks_instances_v2 RENAME TO bluestacks_instances;
        CREATE INDEX IF NOT EXISTS idx_bluestacks_instances_folder_order ON bluestacks_instances(folder_id, sort_order, instance_key);
      `);
    });
  } else {
    Q.ensureColumns(db, 'bluestacks_instances', [
      ['identity_type', "TEXT NOT NULL DEFAULT 'unknown'"],
      ['numeric_account_id', "TEXT NOT NULL DEFAULT ''"],
      ['managed_identities_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['android_sdk', 'INTEGER'],
      ['fb_lite_version', 'TEXT'],
    ]);
  }
}

function mapInstanceRow(r: Record<string, unknown>, online = false): BS.BluestacksInstance {
  const adbPort = Q.n(r.adb_port, 5555),
    rawSdk = Number(r.android_sdk),
    rawIds = Q.s(r.managed_identities_json).trim(),
    parsedIds = rawIds
      ? Q.parseWithFallback(
          () => z.array(BS.BluestacksManagedIdentitySchema).safeParse(JSON.parse(rawIds)),
          null,
        )
      : null;
  const { managedIdentitiesJson: _m, ...base } = Q.camel(r);
  return BS.BluestacksInstanceSchema.parse({
    ...base,
    alias: Q.nonEmptyTrimmed(r.alias),
    folderId: Q.nonEmptyTrimmed(r.folder_id),
    adbPort,
    serial: `127.0.0.1:${adbPort}`,
    fbWidth: Q.n(r.fb_width, 900),
    fbHeight: Q.n(r.fb_height, 1600),
    online,
    fbLiteInstalled: r.fb_lite_installed === 1 ? true : r.fb_lite_installed === 0 ? false : null,
    accountState: BS.BluestacksAccountState.parse(Q.s(r.account_state, 'unknown')),
    avatarUrl: Q.nonEmptyTrimmed(r.avatar_url),
    lastStatus: Q.nonEmptyTrimmed(r.last_status),
    identityType: BS.BluestacksIdentityType.parse(Q.s(r.identity_type, 'unknown')),
    managedIdentities: parsedIds?.success ? parsedIds.data : [],
    androidSdk: Number.isFinite(rawSdk) && rawSdk > 0 ? Math.round(rawSdk) : null,
    fbLiteVersion: Q.nonEmptyTrimmed(r.fb_lite_version),
  });
}

function saveBluestacksJsonCol<T>(db: DatabaseSync, col: string, parsed: T): T {
  Q.run(db, `UPDATE bluestacks_settings SET ${col}=? WHERE id=1`, JSON.stringify(parsed));
  return parsed;
}

export class SqliteBluestacksRepository {
  private readonly targetLibrary: SqliteTargetLibraryRepository;
  constructor(private readonly db: DatabaseSync) {
    initBluestacksSchema(db);
    this.targetLibrary = new SqliteTargetLibraryRepository(db);
  }
  savedSettings(): BluestacksSavedSettings {
    const row = Q.getRow(
      this.db,
      'SELECT install_dir, conf_path, apk_path, bumper_settings, page_bumper_settings, risk_limit_settings FROM bluestacks_settings WHERE id=1',
    );
    const parseBumper = (raw: unknown, extra: Record<string, unknown>, fallback: BumperSettings) =>
      Q.parseWithFallback(
        () => BumperSettings.parse({ ...extra, ...Q.parseJsonObject(raw) }),
        fallback,
      );
    return {
      installDir: Q.nonEmptyTrimmed(row?.install_dir),
      confPath: Q.nonEmptyTrimmed(row?.conf_path),
      apkPath: Q.nonEmptyTrimmed(row?.apk_path),
      bumperSettings: parseBumper(
        row?.bumper_settings,
        { maxConcurrentProfiles: 4 },
        DEFAULT_BUMPER,
      ),
      pageBumperSettings: parseBumper(
        row?.page_bumper_settings,
        { maxPostsPerPage: 3, maxConcurrentProfiles: 4 },
        DEFAULT_PAGE_BUMPER,
      ),
      riskLimitSettings: Q.parseWithFallback(
        () => BS.BluestacksRiskLimitSettings.parse(Q.parseJsonObject(row?.risk_limit_settings)),
        BS.DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
      ),
    };
  }
  saveRiskLimitSettings = (input: unknown) =>
    saveBluestacksJsonCol(
      this.db,
      'risk_limit_settings',
      BS.BluestacksRiskLimitSettings.parse(input),
    );
  saveBumperSettings = (input: unknown) =>
    saveBluestacksJsonCol(this.db, 'bumper_settings', BumperSettings.parse(input));
  savePageBumperSettings = (input: unknown) =>
    saveBluestacksJsonCol(this.db, 'page_bumper_settings', BumperSettings.parse(input));
  savePaths(input: unknown): BluestacksSavedSettings {
    const p = BS.UpdateBluestacksPathsInput.parse(input),
      c = this.savedSettings(),
      sql = 'UPDATE bluestacks_settings SET install_dir=?, conf_path=?, apk_path=? WHERE id=1';
    Q.run(
      this.db,
      sql,
      p.installDir !== undefined ? p.installDir?.trim() || null : c.installDir,
      p.confPath !== undefined ? p.confPath?.trim() || null : c.confPath,
      p.apkPath !== undefined ? p.apkPath?.trim() || null : c.apkPath,
    );
    return this.savedSettings();
  }
  recordDailyActiveAction(
    instanceId: string,
    kind: 'like' | 'action' = 'like',
    delta = 1,
    now = Date.now(),
  ): void {
    const parsedId = z.uuid().parse(instanceId),
      inc = Math.max(0, Math.round(delta));
    if (inc <= 0) return;
    const sql =
      'INSERT INTO bluestacks_daily_actions(ymd, instance_id, active_likes, active_actions, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(ymd, instance_id) DO UPDATE SET active_likes=active_likes+excluded.active_likes, active_actions=active_actions+excluded.active_actions, updated_at=excluded.updated_at';
    Q.run(
      this.db,
      sql,
      Q.formatLocalYmd(new Date(now)),
      parsedId,
      kind === 'like' ? inc : 0,
      inc,
      now,
    );
  }
  dailyInstanceUsage(now = Date.now()): BS.BluestacksDailyUsageOverview {
    const dateYmd = Q.formatLocalYmd(new Date(now)),
      dayStartMs = Q.localDayStartMs(now),
      risk = this.savedSettings().riskLimitSettings,
      counts = new Map<string, BS.BluestacksRawDailyCounts>();
    const slot = (id: string) => {
      let c = counts.get(id);
      if (!c) {
        c = {
          groupBumpsToday: 0,
          pageBumpsToday: 0,
          postsToday: 0,
          invitesToday: 0,
          activeLikesToday: 0,
          activeActionsToday: 0,
        };
        counts.set(id, c);
      }
      return c;
    };
    for (const r of Q.allRows(this.db, 'SELECT id FROM bluestacks_instances')) slot(Q.s(r.id));
    const bumpSql =
      'SELECT profile_id, source_mode, COUNT(*) n FROM group_bumper_effects WHERE applied_at>=? AND profile_id IN (SELECT id FROM bluestacks_instances) GROUP BY profile_id, source_mode';
    for (const r of Q.allRows(this.db, bumpSql, dayStartMs)) {
      const c = slot(Q.s(r.profile_id));
      if (Q.s(r.source_mode) === 'page') c.pageBumpsToday += Q.n(r.n);
      else c.groupBumpsToday += Q.n(r.n);
    }
    const postSql =
      "SELECT profile_id, COUNT(*) n FROM post_bump_records WHERE record_type='post' AND status='success' AND created_at>=? AND profile_id IN (SELECT id FROM bluestacks_instances) GROUP BY profile_id";
    for (const r of Q.allRows(this.db, postSql, dayStartMs))
      slot(Q.s(r.profile_id)).postsToday += Q.n(r.n);
    if (Q.sqliteTableExists(this.db, 'group_inviter_logs')) {
      const invSql =
        "SELECT profile_id, COUNT(*) n FROM group_inviter_logs WHERE invited_at>=? AND confirmation='CONFIRMED' AND profile_id IN (SELECT id FROM bluestacks_instances) GROUP BY profile_id";
      for (const r of Q.allRows(this.db, invSql, dayStartMs))
        slot(Q.s(r.profile_id)).invitesToday += Q.n(r.n);
    }
    const actSql =
      'SELECT instance_id, active_likes, active_actions FROM bluestacks_daily_actions WHERE ymd=?';
    for (const r of Q.allRows(this.db, actSql, dateYmd)) {
      const c = counts.get(Q.s(r.instance_id));
      if (c) {
        c.activeLikesToday += Q.n(r.active_likes);
        c.activeActionsToday += Q.n(r.active_actions);
      }
    }
    const out: BS.BluestacksDailyUsageOverview = {
      dateYmd,
      totalGroupBumps: 0,
      totalPageBumps: 0,
      totalPosts: 0,
      totalInvites: 0,
      totalActiveLikes: 0,
      totalActions: 0,
      reachedLimitInstances: 0,
      perInstance: {},
    };
    for (const [id, raw] of counts) {
      const ev = BS.evaluateBluestacksRiskQuota(risk, id, raw);
      out.perInstance[id] = {
        instanceId: id,
        ...raw,
        totalActionsToday: ev.totalActions,
        effectiveLimits: ev.effectiveLimits,
        hasOverride: ev.hasOverride,
        limitReached: !ev.allowed,
        limitReason: ev.reason,
      };
      out.totalGroupBumps += raw.groupBumpsToday;
      out.totalPageBumps += raw.pageBumpsToday;
      out.totalPosts += raw.postsToday;
      out.totalInvites += raw.invitesToday;
      out.totalActiveLikes += raw.activeLikesToday;
      out.totalActions += ev.totalActions;
      if (!ev.allowed) out.reachedLimitInstances++;
    }
    return out;
  }
  folders = (): BS.BluestacksFolder[] => {
    const sql = 'SELECT id, name, sort_order FROM bluestacks_folders ORDER BY sort_order, id';
    return Q.allRows(this.db, sql).map((r) => BS.BluestacksFolderSchema.parse(Q.camel(r)));
  };
  createFolder(input: unknown): BS.BluestacksFolder {
    const { name } = BS.CreateBluestacksFolderInput.parse(input);
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM bluestacks_folders WHERE lower(name)=lower(?)').get(name))
        throw new ProductError('FOLDER_NAME_EXISTS', '同名分组已存在', 409);
      const sortOrder = Q.nextSortOrder(this.db, 'bluestacks_folders'),
        id = randomUUID();
      Q.run(
        this.db,
        'INSERT INTO bluestacks_folders(id, name, sort_order) VALUES(?,?,?)',
        id,
        name,
        sortOrder,
      );
      return { id, name, sortOrder };
    });
  }
  renameFolder(input: unknown): BS.BluestacksFolder {
    const { id, name } = BS.RenameBluestacksFolderInput.parse(input);
    return transaction(this.db, () => {
      const ex = Q.getRow(this.db, 'SELECT id, sort_order FROM bluestacks_folders WHERE id=?', id);
      if (!ex) throw new ProductError('FOLDER_NOT_FOUND', '分组不存在', 404);
      const dupSql = 'SELECT 1 FROM bluestacks_folders WHERE lower(name)=lower(?) AND id<>?';
      if (this.db.prepare(dupSql).get(name, id))
        throw new ProductError('FOLDER_NAME_EXISTS', '同名分组已存在', 409);
      Q.run(this.db, 'UPDATE bluestacks_folders SET name=? WHERE id=?', name, id);
      return { id, name, sortOrder: Q.n(ex.sort_order) };
    });
  }
  deleteFolder(input: unknown): void {
    const { id } = BS.DeleteBluestacksFolderInput.parse(input);
    transaction(this.db, () => {
      Q.run(this.db, 'UPDATE bluestacks_instances SET folder_id=NULL WHERE folder_id=?', id);
      Q.run(this.db, 'DELETE FROM bluestacks_folders WHERE id=?', id);
    });
  }
  reorderFolders(input: unknown): void {
    const { ids } = BS.ReorderBluestacksFoldersInput.parse(input);
    transaction(this.db, () => {
      const folderIds = new Set(this.folders().map((f) => f.id));
      Q.assertCompleteIdOrder(ids, folderIds, 'FOLDER_ORDER_INVALID', '分组列表已变化，请刷新');
      const stmt = this.db.prepare('UPDATE bluestacks_folders SET sort_order=? WHERE id=?');
      ids.forEach((id, idx) => stmt.run(idx, id));
    });
  }
  listInstances(onlineKeys?: ReadonlyArray<string>): BS.BluestacksInstance[] {
    const onlineSet = new Set(onlineKeys ?? []),
      sql = 'SELECT * FROM bluestacks_instances ORDER BY sort_order, display_name, instance_key';
    return Q.allRows(this.db, sql).map((r) =>
      mapInstanceRow(r, onlineSet.has(Q.s(r.instance_key))),
    );
  }
  getInstance(id: string): BS.BluestacksInstance | null {
    const sql = 'SELECT * FROM bluestacks_instances WHERE id=?';
    const row = Q.getRow(this.db, sql, z.uuid().parse(id));
    return row ? mapInstanceRow(row, false) : null;
  }
  upsertDiscoveredInstances(
    items: ReadonlyArray<DiscoveredInstanceRecord>,
  ): BS.BluestacksInstance[] {
    const now = Date.now();
    return transaction(this.db, () => {
      let nextOrder = Q.nextSortOrder(this.db, 'bluestacks_instances', 'folder_id IS NULL');
      const selectByKey = this.db.prepare(
        'SELECT * FROM bluestacks_instances WHERE instance_key=?',
      );
      const insSql =
        'INSERT INTO bluestacks_instances(id,instance_key,display_name,sort_order,adb_port,fb_width,fb_height,fb_lite_installed,account_state,updated_at,android_sdk,fb_lite_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)';
      const ins = this.db.prepare(insSql),
        upd = this.db.prepare(
          'UPDATE bluestacks_instances SET display_name=?, adb_port=?, fb_width=?, fb_height=?, fb_lite_installed=?, account_state=?, android_sdk=COALESCE(?, android_sdk), fb_lite_version=COALESCE(?, fb_lite_version), updated_at=? WHERE instance_key=?',
        );
      for (const item of items) {
        const key = item.instanceKey.trim();
        if (!key) continue;
        const ex = selectByKey.get(key),
          inst = item.fbLiteInstalled,
          instNum = inst === true ? 1 : inst === false ? 0 : null;
        if (!ex) {
          const args = [
            deterministicBluestacksId(key),
            key,
            item.displayName.trim() || key,
            nextOrder++,
            item.adbPort,
            item.fbWidth,
            item.fbHeight,
            instNum,
            inst === false ? 'missing-app' : 'unknown',
            now,
            item.androidSdk ?? null,
            item.fbLiteVersion ?? null,
          ];
          ins.run(...args);
        } else {
          const prevInst =
            ex.fb_lite_installed === 1 ? true : ex.fb_lite_installed === 0 ? false : null;
          const merged = inst !== null ? inst : prevInst,
            prevState = BS.BluestacksAccountState.parse(Q.s(ex.account_state, 'unknown'));
          const nextState: BS.BluestacksAccountState =
            inst === false
              ? 'missing-app'
              : inst === true && prevState === 'missing-app'
                ? 'unknown'
                : prevState;
          upd.run(
            item.displayName.trim() || Q.s(ex.display_name),
            item.adbPort > 0 ? item.adbPort : Q.n(ex.adb_port),
            item.fbWidth > 0 ? item.fbWidth : Q.n(ex.fb_width),
            item.fbHeight > 0 ? item.fbHeight : Q.n(ex.fb_height),
            merged === true ? 1 : merged === false ? 0 : null,
            nextState,
            item.androidSdk ?? null,
            item.fbLiteVersion ?? null,
            now,
            key,
          );
        }
      }
      return this.listInstances(items.filter((i) => i.online).map((i) => i.instanceKey));
    });
  }
  saveInspectionResult(input: {
    id: string;
    fbLiteInstalled: boolean;
    accountState: BS.BluestacksAccountState;
    accountId?: string;
    accountName?: string;
    avatarUrl?: string | null;
    fbWidth?: number;
    fbHeight?: number;
    identityType?: BS.BluestacksIdentityType;
    numericAccountId?: string;
    managedIdentities?: ReadonlyArray<BS.BluestacksManagedIdentity>;
    androidSdk?: number | null;
    fbLiteVersion?: string | null;
  }): BS.BluestacksInstance {
    const parsedId = z.uuid().parse(input.id),
      now = Date.now();
    return transaction(this.db, () => {
      const ex = Q.getRow(this.db, 'SELECT * FROM bluestacks_instances WHERE id=?', parsedId);
      if (!ex) throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
      const cleared = input.accountState === 'logged-out' || input.accountState === 'missing-app',
        keep = ['logged-in', 'restricted', 'verification'].includes(input.accountState);
      const prevAv = typeof ex.avatar_url === 'string' ? ex.avatar_url : null;
      const nextAv = cleared
        ? null
        : input.avatarUrl && (isLocalAvatar(input.avatarUrl) || !isLocalAvatar(prevAv))
          ? input.avatarUrl
          : prevAv;
      const prevName = Q.s(ex.account_name),
        nextName = keep ? input.accountName?.trim() || prevName : '',
        inName = input.accountName?.trim();
      const nameCh = Boolean(inName && prevName && inName.toLowerCase() !== prevName.toLowerCase());
      const inNum =
        input.numericAccountId && /^\d{5,}$/.test(input.numericAccountId.trim())
          ? input.numericAccountId.trim()
          : '';
      const nextNumId = cleared ? '' : inNum || (nameCh ? '' : Q.s(ex.numeric_account_id));
      const nextAccId = keep ? input.accountId?.trim() || nextNumId || Q.s(ex.account_id) : '';
      const nextIdType: BS.BluestacksIdentityType = cleared
        ? 'unknown'
        : input.identityType && input.identityType !== 'unknown'
          ? input.identityType
          : BS.BluestacksIdentityType.parse(Q.s(ex.identity_type, 'unknown'));
      const nextManagedJson = cleared
        ? '[]'
        : input.managedIdentities !== undefined
          ? JSON.stringify(
              z.array(BS.BluestacksManagedIdentitySchema).parse(input.managedIdentities),
            )
          : Q.s(ex.managed_identities_json, '[]');
      const sql =
        'UPDATE bluestacks_instances SET fb_lite_installed=?, account_state=?, account_id=?, account_name=?, avatar_url=?, identity_type=?, numeric_account_id=?, managed_identities_json=?, android_sdk=COALESCE(?, android_sdk), fb_lite_version=COALESCE(?, fb_lite_version), fb_width=COALESCE(?, fb_width), fb_height=COALESCE(?, fb_height), updated_at=? WHERE id=?';
      Q.run(
        this.db,
        sql,
        input.fbLiteInstalled ? 1 : 0,
        input.accountState,
        nextAccId,
        nextName,
        nextAv,
        nextIdType,
        nextNumId,
        nextManagedJson,
        input.androidSdk ?? null,
        input.fbLiteVersion ?? null,
        input.fbWidth ?? null,
        input.fbHeight ?? null,
        now,
        parsedId,
      );
      if (nextAv && isLocalAvatar(nextAv)) {
        if (nextAccId) saveRecordAvatar(this.db, 'account', nextAccId, nextAv, now);
        if (nextNumId && nextNumId !== nextAccId)
          saveRecordAvatar(this.db, 'account', nextNumId, nextAv, now);
      }
      const updated = Q.getRow(this.db, 'SELECT * FROM bluestacks_instances WHERE id=?', parsedId);
      if (!updated) throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
      return mapInstanceRow(updated, true);
    });
  }
  saveLastStatus = (id: string, status: string | null): void => {
    const sql = 'UPDATE bluestacks_instances SET last_status=?, updated_at=? WHERE id=?';
    Q.run(this.db, sql, status?.slice(0, 300) ?? null, Date.now(), z.uuid().parse(id));
  };
  renameInstance(input: unknown): BS.BluestacksInstance {
    const { id, alias } = BS.RenameBluestacksInstanceInput.parse(input);
    Q.run(
      this.db,
      'UPDATE bluestacks_instances SET alias=?, updated_at=? WHERE id=?',
      alias?.trim() ? alias.trim() : null,
      Date.now(),
      id,
    );
    const row = this.getInstance(id);
    if (!row) throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
    return row;
  }
  reorderInstances(input: unknown): void {
    const { folderId, ids } = BS.ReorderBluestacksInstancesInput.parse(input);
    transaction(this.db, () => {
      if (folderId && !this.db.prepare('SELECT 1 FROM bluestacks_folders WHERE id=?').get(folderId))
        throw new ProductError('FOLDER_NOT_FOUND', '分组不存在', 404);
      const moved = [...new Set(ids)],
        sql = 'SELECT id FROM bluestacks_instances WHERE folder_id IS ? ORDER BY sort_order, id';
      const rest = Q.allRows(this.db, sql, folderId)
        .map((r) => Q.s(r.id))
        .filter((id) => !moved.includes(id));
      const stmt = this.db.prepare(
        'UPDATE bluestacks_instances SET folder_id=?, sort_order=? WHERE id=?',
      );
      [...moved, ...rest].forEach((id, idx) => stmt.run(folderId, idx, id));
    });
  }
  deleteInstances = (input: unknown): number =>
    Q.deleteByJsonIds(
      this.db,
      'bluestacks_instances',
      'id',
      BS.BluestacksInstanceIdsInput.parse(input).instanceIds,
    );
  eligibility(
    accountId: string,
    instanceId: string,
    postId: string,
    now = Date.now(),
    sourceMode: BumperScope = 'group',
  ) {
    const saved = this.savedSettings(),
      settings = sourceMode === 'page' ? saved.pageBumperSettings : saved.bumperSettings;
    const { today, postCount, duplicate } = queryBumperEligibilityCounts(
      this.db,
      accountId,
      instanceId,
      postId,
      now,
      sourceMode,
    );
    const instUsage = this.dailyInstanceUsage(now).perInstance[instanceId];
    const riskEval = instUsage
      ? BS.evaluateBluestacksRiskQuota(saved.riskLimitSettings, instanceId, instUsage, 'bump')
      : null;
    return {
      today,
      postCount,
      duplicate,
      riskLimitReason: riskEval?.reason ?? null,
      allowed:
        !duplicate &&
        (riskEval ? riskEval.allowed : true) &&
        today < settings.dailyMaxLikesPerAccount &&
        postCount < settings.maxLikesPerPost,
    };
  }
  recordBump(input: BumperLog, commentId?: string): boolean {
    const row = BumperLogInputSchema.parse(input);
    if (!row.liked && !row.commentText) return false;
    const mode: BumperScope = row.sourceMode ?? 'group',
      saved = this.savedSettings();
    return recordBumpEntryInDb({
      db: this.db,
      targetLibrary: this.targetLibrary,
      row: { ...row, storyShared: false },
      sourceMode: mode,
      carrier: 'bluestacks',
      commentId,
      consumeCommentOnUse: (mode === 'page' ? saved.pageBumperSettings : saved.bumperSettings)
        .consumeCommentOnUse,
      isDuplicate: () =>
        this.eligibility(row.accountId, row.profileId, row.postId, row.bumpedAt, mode).duplicate,
    });
  }
  targets = (kind: 'groups' | 'pages'): BumperTarget[] =>
    kind === 'groups' ? this.targetLibrary.listBumperGroups() : this.targetLibrary.listPages();
  comments = (scope: BumperScope = 'group'): BumperComment[] =>
    listBumperCommentsFromDb(this.db, scope, false);
  pickComment(
    postId: string,
    random = Math.random(),
    excludeIds: ReadonlyArray<string> = [],
    scope: BumperScope = 'group',
  ): BumperComment | null {
    const saved = this.savedSettings(),
      consume = (scope === 'page' ? saved.pageBumperSettings : saved.bumperSettings)
        .consumeCommentOnUse;
    return pickBumperCommentFromDb(this.db, postId, scope, consume, random, excludeIds, false);
  }
  todayCounts(now = Date.now(), sourceMode: BumperScope = 'group'): Record<string, number> {
    const sql =
      'SELECT profile_id, COUNT(*) n FROM group_bumper_effects WHERE applied_at>=? AND source_mode=? AND profile_id IN (SELECT id FROM bluestacks_instances) GROUP BY profile_id';
    return Object.fromEntries(
      Q.allRows(this.db, sql, Q.localDayStartMs(now), sourceMode).map((r) => [
        Q.s(r.profile_id),
        Q.n(r.n),
      ]),
    );
  }
  total = (sourceMode: BumperScope = 'group'): number => {
    const sql =
      "SELECT COUNT(*) n FROM post_bump_records WHERE record_type=? AND status='success' AND carrier='bluestacks'";
    return Q.countSql(this.db, sql, sourceMode === 'page' ? 'page_bump' : 'group_bump');
  };
  weeklyDailyCounts(now = Date.now(), sourceMode: BumperScope = 'group'): BumperDailyStat[] {
    const { startMs, endMs } = Q.localWeekWindow(now),
      sql =
        'SELECT applied_at AS bumped_at FROM group_bumper_effects WHERE applied_at>=? AND applied_at<? AND source_mode=? AND profile_id IN (SELECT id FROM bluestacks_instances)';
    return Q.collectWeeklyDailyCounts(
      Q.allRows(this.db, sql, startMs, endMs, sourceMode).map((r) => Q.n(r.bumped_at)),
      now,
    );
  }
}
