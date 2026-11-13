import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProductError } from '../domain/workspace.js';
import {
  BluestacksAccountState,
  BluestacksFolderSchema,
  BluestacksInstanceIdsInput,
  BluestacksInstanceSchema,
  CreateBluestacksFolderInput,
  DeleteBluestacksFolderInput,
  RenameBluestacksFolderInput,
  RenameBluestacksInstanceInput,
  ReorderBluestacksFoldersInput,
  ReorderBluestacksInstancesInput,
  UpdateBluestacksPathsInput,
  type BluestacksFolder,
  type BluestacksInstance,
} from '../shared/bluestacks.js';
import {
  BumperSettings,
  isLocalAvatar,
  type BumperComment,
  type BumperDailyStat,
  type BumperLog,
  type BumperScope,
  type BumperTarget,
} from '../shared/group-bumper.js';
import { saveRecordAvatar } from './record-avatar-store.js';
import { ensureBumperEffects } from './record-retention-migration.js';
import { transaction } from './sqlite-transaction.js';
import {
  ensureTargetLibrarySchema,
  SqliteTargetLibraryRepository,
} from './target-library-store.js';

function formatLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function deterministicBluestacksId(instanceKey: string): string {
  const hash = createHash('sha256')
    .update('workbench-bluestacks-instance:' + instanceKey.trim())
    .digest();
  const b = Uint8Array.from(hash.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface DiscoveredInstanceRecord {
  instanceKey: string;
  displayName: string;
  adbPort: number;
  fbWidth: number;
  fbHeight: number;
  online: boolean;
  fbLiteInstalled: boolean | null;
}

export interface BluestacksSavedSettings {
  installDir: string | null;
  confPath: string | null;
  bumperSettings: BumperSettings;
  pageBumperSettings: BumperSettings;
}

const DEFAULT_BLUESTACKS_BUMPER_SETTINGS: BumperSettings = BumperSettings.parse({
  searchMode: 'page_group_feed',
  maxConcurrentProfiles: 4,
});

const DEFAULT_BLUESTACKS_PAGE_BUMPER_SETTINGS: BumperSettings = BumperSettings.parse({
  maxPostsPerPage: 3,
  maxConcurrentProfiles: 4,
});

export class SqliteBluestacksRepository {
  private readonly targetLibrary: SqliteTargetLibraryRepository;

  constructor(private readonly db: DatabaseSync) {
    ensureTargetLibrarySchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_bumper_comments(
        id TEXT PRIMARY KEY,
        comment_text TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT 'group' CHECK(scope IN ('group','page'))
      );
      CREATE INDEX IF NOT EXISTS idx_group_bumper_comments_scope
        ON group_bumper_comments(scope, created_at, id);
      CREATE TABLE IF NOT EXISTS group_bumper_logs(
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        page_id TEXT NOT NULL,
        page_name TEXT NOT NULL,
        post_id TEXT NOT NULL,
        post_url TEXT NOT NULL,
        liked INTEGER NOT NULL DEFAULT 0,
        comment_text TEXT,
        bumped_at INTEGER NOT NULL,
        source_mode TEXT NOT NULL DEFAULT 'group' CHECK(source_mode IN ('group','page'))
      );
      CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_post ON group_bumper_logs(post_id);
      CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_account_time ON group_bumper_logs(account_id,bumped_at);
      CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_profile_post ON group_bumper_logs(profile_id,post_id);
      CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_bumped_at ON group_bumper_logs(bumped_at DESC);
      CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_source_mode_bumped ON group_bumper_logs(source_mode, bumped_at DESC);
      CREATE TABLE IF NOT EXISTS bluestacks_folders(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bluestacks_instances(
        id TEXT PRIMARY KEY,
        instance_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        alias TEXT,
        folder_id TEXT REFERENCES bluestacks_folders(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        adb_port INTEGER NOT NULL DEFAULT 5555,
        fb_width INTEGER NOT NULL DEFAULT 900,
        fb_height INTEGER NOT NULL DEFAULT 1600,
        fb_lite_installed INTEGER,
        account_state TEXT NOT NULL DEFAULT 'unknown' CHECK(account_state IN ('unknown','logged-in','logged-out','missing-app')),
        account_id TEXT NOT NULL DEFAULT '',
        account_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        last_status TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bluestacks_instances_folder_order
        ON bluestacks_instances(folder_id, sort_order, instance_key);
      CREATE TABLE IF NOT EXISTS bluestacks_settings(
        id INTEGER PRIMARY KEY CHECK(id=1),
        install_dir TEXT,
        conf_path TEXT,
        bumper_settings TEXT NOT NULL DEFAULT '{}',
        page_bumper_settings TEXT NOT NULL DEFAULT '{}'
      );
      INSERT OR IGNORE INTO bluestacks_settings(id, install_dir, conf_path, bumper_settings)
        VALUES(1, NULL, NULL, '{}');
    `);
    const settingCols = db
      .prepare('PRAGMA table_info(bluestacks_settings)')
      .all()
      .map((r) => String(r.name));
    if (!settingCols.includes('page_bumper_settings')) {
      db.exec(
        "ALTER TABLE bluestacks_settings ADD COLUMN page_bumper_settings TEXT NOT NULL DEFAULT '{}';",
      );
    }
    ensureBumperEffects(db);
    this.targetLibrary = new SqliteTargetLibraryRepository(db);
  }

  savedSettings(): BluestacksSavedSettings {
    const row = this.db
      .prepare(
        'SELECT install_dir, conf_path, bumper_settings, page_bumper_settings FROM bluestacks_settings WHERE id=1',
      )
      .get();
    let bumperSettings = DEFAULT_BLUESTACKS_BUMPER_SETTINGS;
    try {
      const raw = JSON.parse(String(row?.bumper_settings ?? '{}')) as Record<string, unknown>;
      bumperSettings = BumperSettings.parse({
        maxConcurrentProfiles: 4,
        ...raw,
      });
    } catch {
      bumperSettings = DEFAULT_BLUESTACKS_BUMPER_SETTINGS;
    }
    let pageBumperSettings = DEFAULT_BLUESTACKS_PAGE_BUMPER_SETTINGS;
    try {
      const rawPage = JSON.parse(String(row?.page_bumper_settings ?? '{}')) as Record<
        string,
        unknown
      >;
      pageBumperSettings = BumperSettings.parse({
        maxPostsPerPage: 3,
        maxConcurrentProfiles: 4,
        ...rawPage,
      });
    } catch {
      pageBumperSettings = DEFAULT_BLUESTACKS_PAGE_BUMPER_SETTINGS;
    }
    return {
      installDir:
        typeof row?.install_dir === 'string' && row.install_dir.trim()
          ? row.install_dir.trim()
          : null,
      confPath:
        typeof row?.conf_path === 'string' && row.conf_path.trim() ? row.conf_path.trim() : null,
      bumperSettings,
      pageBumperSettings,
    };
  }

  savePaths(input: unknown): BluestacksSavedSettings {
    const parsed = UpdateBluestacksPathsInput.parse(input);
    const current = this.savedSettings();
    const nextInstall =
      parsed.installDir !== undefined ? parsed.installDir?.trim() || null : current.installDir;
    const nextConf =
      parsed.confPath !== undefined ? parsed.confPath?.trim() || null : current.confPath;
    this.db
      .prepare('UPDATE bluestacks_settings SET install_dir=?, conf_path=? WHERE id=1')
      .run(nextInstall, nextConf);
    return this.savedSettings();
  }

  saveBumperSettings(input: unknown): BumperSettings {
    const parsed = BumperSettings.parse(input);
    this.db
      .prepare('UPDATE bluestacks_settings SET bumper_settings=? WHERE id=1')
      .run(JSON.stringify(parsed));
    return parsed;
  }

  savePageBumperSettings(input: unknown): BumperSettings {
    const parsed = BumperSettings.parse(input);
    this.db
      .prepare('UPDATE bluestacks_settings SET page_bumper_settings=? WHERE id=1')
      .run(JSON.stringify(parsed));
    return parsed;
  }

  folders(): BluestacksFolder[] {
    return this.db
      .prepare('SELECT id, name, sort_order FROM bluestacks_folders ORDER BY sort_order, id')
      .all()
      .map((r) =>
        BluestacksFolderSchema.parse({
          id: String(r.id),
          name: String(r.name),
          sortOrder: Number(r.sort_order),
        }),
      );
  }

  createFolder(input: unknown): BluestacksFolder {
    const { name } = CreateBluestacksFolderInput.parse(input);
    return transaction(this.db, () => {
      const dup = this.db
        .prepare('SELECT 1 FROM bluestacks_folders WHERE lower(name)=lower(?)')
        .get(name);
      if (dup) throw new ProductError('FOLDER_NAME_EXISTS', '同名分组已存在', 409);
      const nextOrder = Number(
        this.db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM bluestacks_folders').get()
          ?.n ?? 0,
      );
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO bluestacks_folders(id, name, sort_order) VALUES(?,?,?)')
        .run(id, name, nextOrder);
      return { id, name, sortOrder: nextOrder };
    });
  }

  renameFolder(input: unknown): BluestacksFolder {
    const { id, name } = RenameBluestacksFolderInput.parse(input);
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id, sort_order FROM bluestacks_folders WHERE id=?')
        .get(id);
      if (!existing) throw new ProductError('FOLDER_NOT_FOUND', '分组不存在', 404);
      const dup = this.db
        .prepare('SELECT 1 FROM bluestacks_folders WHERE lower(name)=lower(?) AND id<>?')
        .get(name, id);
      if (dup) throw new ProductError('FOLDER_NAME_EXISTS', '同名分组已存在', 409);
      this.db.prepare('UPDATE bluestacks_folders SET name=? WHERE id=?').run(name, id);
      return { id, name, sortOrder: Number(existing.sort_order) };
    });
  }

  deleteFolder(input: unknown): void {
    const { id } = DeleteBluestacksFolderInput.parse(input);
    transaction(this.db, () => {
      this.db.prepare('UPDATE bluestacks_instances SET folder_id=NULL WHERE folder_id=?').run(id);
      this.db.prepare('DELETE FROM bluestacks_folders WHERE id=?').run(id);
    });
  }

  reorderFolders(input: unknown): void {
    const { ids } = ReorderBluestacksFoldersInput.parse(input);
    transaction(this.db, () => {
      const known = new Set(this.folders().map((f) => f.id));
      if (
        ids.length !== known.size ||
        new Set(ids).size !== known.size ||
        ids.some((id) => !known.has(id))
      ) {
        throw new ProductError('FOLDER_ORDER_INVALID', '分组列表已变化，请刷新');
      }
      const stmt = this.db.prepare('UPDATE bluestacks_folders SET sort_order=? WHERE id=?');
      ids.forEach((id, idx) => stmt.run(idx, id));
    });
  }

  private mapInstanceRow(r: Record<string, unknown>, online = false): BluestacksInstance {
    const adbPort = Number(r.adb_port ?? 5555);
    return BluestacksInstanceSchema.parse({
      id: String(r.id),
      instanceKey: String(r.instance_key),
      displayName: String(r.display_name),
      alias: typeof r.alias === 'string' && r.alias.trim() ? r.alias.trim() : null,
      folderId: typeof r.folder_id === 'string' && r.folder_id ? r.folder_id : null,
      sortOrder: Number(r.sort_order ?? 0),
      adbPort,
      serial: `127.0.0.1:${adbPort}`,
      fbWidth: Number(r.fb_width ?? 900),
      fbHeight: Number(r.fb_height ?? 1600),
      online,
      fbLiteInstalled: r.fb_lite_installed === 1 ? true : r.fb_lite_installed === 0 ? false : null,
      accountState: BluestacksAccountState.parse(String(r.account_state ?? 'unknown')),
      accountId: String(r.account_id ?? ''),
      accountName: String(r.account_name ?? ''),
      avatarUrl: typeof r.avatar_url === 'string' && r.avatar_url ? r.avatar_url : null,
      lastStatus: typeof r.last_status === 'string' && r.last_status ? r.last_status : null,
      updatedAt: Number(r.updated_at ?? 0),
    });
  }

  listInstances(onlineKeys?: ReadonlyArray<string>): BluestacksInstance[] {
    const onlineSet = new Set(onlineKeys ?? []);
    return this.db
      .prepare('SELECT * FROM bluestacks_instances ORDER BY sort_order, display_name, instance_key')
      .all()
      .map((r) => this.mapInstanceRow(r, onlineSet.has(String(r.instance_key))));
  }

  getInstance(id: string): BluestacksInstance | null {
    const parsedId = z.uuid().parse(id);
    const row = this.db.prepare('SELECT * FROM bluestacks_instances WHERE id=?').get(parsedId);
    return row ? this.mapInstanceRow(row, false) : null;
  }

  upsertDiscoveredInstances(items: ReadonlyArray<DiscoveredInstanceRecord>): BluestacksInstance[] {
    const now = Date.now();
    return transaction(this.db, () => {
      let nextOrder = Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(sort_order),-1)+1 n FROM bluestacks_instances WHERE folder_id IS NULL',
          )
          .get()?.n ?? 0,
      );
      const selectByKey = this.db.prepare(
        'SELECT * FROM bluestacks_instances WHERE instance_key=?',
      );
      const insertStmt = this.db.prepare(`
        INSERT INTO bluestacks_instances(
          id, instance_key, display_name, alias, folder_id, sort_order,
          adb_port, fb_width, fb_height, fb_lite_installed,
          account_state, account_id, account_name, avatar_url, last_status, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const updateStmt = this.db.prepare(`
        UPDATE bluestacks_instances
           SET display_name=?,
               adb_port=?,
               fb_width=?,
               fb_height=?,
               fb_lite_installed=?,
               account_state=?,
               updated_at=?
         WHERE instance_key=?
      `);

      for (const item of items) {
        const key = item.instanceKey.trim();
        if (!key) continue;
        const existing = selectByKey.get(key);
        if (!existing) {
          const id = deterministicBluestacksId(key);
          const fbLiteFlag =
            item.fbLiteInstalled === true ? 1 : item.fbLiteInstalled === false ? 0 : null;
          const initState: BluestacksAccountState =
            item.fbLiteInstalled === false ? 'missing-app' : 'unknown';
          insertStmt.run(
            id,
            key,
            item.displayName.trim() || key,
            null,
            null,
            nextOrder++,
            item.adbPort,
            item.fbWidth,
            item.fbHeight,
            fbLiteFlag,
            initState,
            '',
            '',
            null,
            null,
            now,
          );
        } else {
          const prevInstalled =
            existing.fb_lite_installed === 1
              ? true
              : existing.fb_lite_installed === 0
                ? false
                : null;
          const mergedInstalled =
            item.fbLiteInstalled !== null ? item.fbLiteInstalled : prevInstalled;
          const prevState = BluestacksAccountState.parse(
            String(existing.account_state ?? 'unknown'),
          );
          // Anti-regression: preserve confirmed logged-in account unless live check proves app was uninstalled
          let nextState: BluestacksAccountState = prevState;
          if (item.fbLiteInstalled === false) {
            nextState = 'missing-app';
          } else if (item.fbLiteInstalled === true && prevState === 'missing-app') {
            nextState = 'unknown';
          }
          updateStmt.run(
            item.displayName.trim() || String(existing.display_name),
            item.adbPort > 0 ? item.adbPort : Number(existing.adb_port),
            item.fbWidth > 0 ? item.fbWidth : Number(existing.fb_width),
            item.fbHeight > 0 ? item.fbHeight : Number(existing.fb_height),
            mergedInstalled === true ? 1 : mergedInstalled === false ? 0 : null,
            nextState,
            now,
            key,
          );
        }
      }

      const onlineKeys = items.filter((i) => i.online).map((i) => i.instanceKey);
      return this.listInstances(onlineKeys);
    });
  }

  saveInspectionResult(input: {
    id: string;
    fbLiteInstalled: boolean;
    accountState: BluestacksAccountState;
    accountId?: string;
    accountName?: string;
    avatarUrl?: string | null;
    fbWidth?: number;
    fbHeight?: number;
  }): BluestacksInstance {
    const parsedId = z.uuid().parse(input.id);
    const now = Date.now();
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM bluestacks_instances WHERE id=?')
        .get(parsedId);
      if (!existing) throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);

      const prevAvatar = typeof existing.avatar_url === 'string' ? existing.avatar_url : null;
      let nextAvatar = prevAvatar;
      if (input.accountState === 'logged-out' || input.accountState === 'missing-app') {
        nextAvatar = null;
      } else if (input.avatarUrl && isLocalAvatar(input.avatarUrl)) {
        nextAvatar = input.avatarUrl;
      } else if (input.avatarUrl && !isLocalAvatar(prevAvatar)) {
        nextAvatar = input.avatarUrl;
      }

      const nextAccountId =
        input.accountState === 'logged-in'
          ? input.accountId?.trim() || String(existing.account_id ?? '')
          : '';
      const nextAccountName =
        input.accountState === 'logged-in'
          ? input.accountName?.trim() || String(existing.account_name ?? '')
          : '';

      this.db
        .prepare(
          `UPDATE bluestacks_instances
              SET fb_lite_installed=?,
                  account_state=?,
                  account_id=?,
                  account_name=?,
                  avatar_url=?,
                  fb_width=COALESCE(?, fb_width),
                  fb_height=COALESCE(?, fb_height),
                  updated_at=?
            WHERE id=?`,
        )
        .run(
          input.fbLiteInstalled ? 1 : 0,
          input.accountState,
          nextAccountId,
          nextAccountName,
          nextAvatar,
          input.fbWidth ?? null,
          input.fbHeight ?? null,
          now,
          parsedId,
        );

      if (nextAccountId && nextAvatar && isLocalAvatar(nextAvatar)) {
        saveRecordAvatar(this.db, 'account', nextAccountId, nextAvatar, now);
      }

      const updated = this.db
        .prepare('SELECT * FROM bluestacks_instances WHERE id=?')
        .get(parsedId);
      if (!updated) throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
      return this.mapInstanceRow(updated, true);
    });
  }

  saveLastStatus(id: string, status: string | null): void {
    const parsedId = z.uuid().parse(id);
    this.db
      .prepare('UPDATE bluestacks_instances SET last_status=?, updated_at=? WHERE id=?')
      .run(status?.slice(0, 300) ?? null, Date.now(), parsedId);
  }

  renameInstance(input: unknown): BluestacksInstance {
    const { id, alias } = RenameBluestacksInstanceInput.parse(input);
    const cleaned = alias?.trim() ? alias.trim() : null;
    this.db
      .prepare('UPDATE bluestacks_instances SET alias=?, updated_at=? WHERE id=?')
      .run(cleaned, Date.now(), id);
    const row = this.getInstance(id);
    if (!row) throw new ProductError('INSTANCE_NOT_FOUND', '蓝蝶实例不存在', 404);
    return row;
  }

  reorderInstances(input: unknown): void {
    const { folderId, ids } = ReorderBluestacksInstancesInput.parse(input);
    transaction(this.db, () => {
      if (
        folderId &&
        !this.db.prepare('SELECT 1 FROM bluestacks_folders WHERE id=?').get(folderId)
      ) {
        throw new ProductError('FOLDER_NOT_FOUND', '分组不存在', 404);
      }
      const moved = [...new Set(ids)];
      const rest = this.db
        .prepare('SELECT id FROM bluestacks_instances WHERE folder_id IS ? ORDER BY sort_order, id')
        .all(folderId)
        .map((r) => String(r.id))
        .filter((id) => !moved.includes(id));
      const stmt = this.db.prepare(
        'UPDATE bluestacks_instances SET folder_id=?, sort_order=? WHERE id=?',
      );
      [...moved, ...rest].forEach((id, idx) => stmt.run(folderId, idx, id));
    });
  }

  deleteInstances(input: unknown): number {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    return Number(
      this.db
        .prepare('DELETE FROM bluestacks_instances WHERE id IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify(instanceIds)).changes,
    );
  }

  eligibility(
    accountId: string,
    instanceId: string,
    postId: string,
    now = Date.now(),
    sourceMode: BumperScope = 'group',
  ) {
    const saved = this.savedSettings();
    const settings = sourceMode === 'page' ? saved.pageBumperSettings : saved.bumperSettings;
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    const today = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM group_bumper_effects
            WHERE (account_id=? OR profile_id=?) AND applied_at>=? AND source_mode=?`,
        )
        .get(accountId, instanceId, date.getTime(), sourceMode)?.n ?? 0,
    );
    const postCount = postId
      ? Number(
          this.db
            .prepare(
              'SELECT COUNT(*) n FROM group_bumper_effects WHERE post_id=? AND (liked=1 OR commented=1)',
            )
            .get(postId)?.n ?? 0,
        )
      : 0;
    const duplicate = postId
      ? Boolean(
          this.db
            .prepare(
              'SELECT 1 FROM group_bumper_effects WHERE post_id=? AND (account_id=? OR profile_id=?) LIMIT 1',
            )
            .get(postId, accountId, instanceId),
        )
      : false;
    return {
      today,
      postCount,
      duplicate,
      allowed:
        !duplicate &&
        today < settings.dailyMaxLikesPerAccount &&
        postCount < settings.maxLikesPerPost,
    };
  }

  recordBump(input: BumperLog, commentId?: string): boolean {
    const row = z
      .object({
        id: z.uuid(),
        profileId: z.uuid(),
        accountId: z.string().min(1),
        groupId: z.string().min(1),
        groupName: z.string(),
        pageId: z.string().min(1),
        pageName: z.string(),
        postId: z.string().regex(/^\d+$/),
        postUrl: z.url(),
        liked: z.boolean(),
        commentText: z.string().nullable(),
        bumpedAt: z.number().int(),
        sourceMode: z.enum(['group', 'page']).optional(),
      })
      .strict()
      .parse(input);
    if (!row.liked && !row.commentText) return false;
    const mode: BumperScope = row.sourceMode ?? 'group';
    const saved = this.savedSettings();
    const settings = mode === 'page' ? saved.pageBumperSettings : saved.bumperSettings;

    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM group_bumper_logs WHERE id=?').get(row.id);
      if (
        !previous &&
        this.eligibility(row.accountId, row.profileId, row.postId, row.bumpedAt, mode).duplicate
      ) {
        return false;
      }
      const commentNew = Boolean(row.commentText && !previous?.comment_text);
      this.db
        .prepare(
          `INSERT INTO group_bumper_logs(
             id,profile_id,account_id,group_id,group_name,page_id,page_name,post_id,post_url,liked,comment_text,bumped_at,source_mode
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             liked=MAX(liked,excluded.liked),
             comment_text=COALESCE(comment_text,excluded.comment_text)`,
        )
        .run(
          row.id,
          row.profileId,
          row.accountId,
          row.groupId,
          row.groupName,
          row.pageId,
          row.pageName,
          row.postId,
          row.postUrl,
          row.liked ? 1 : 0,
          row.commentText,
          row.bumpedAt,
          mode,
        );
      if (row.commentText) {
        this.db.prepare('UPDATE group_bumper_effects SET comment_digest=? WHERE log_id=?').run(
          createHash('sha256')
            .update(String(previous?.comment_text ?? row.commentText))
            .digest('hex'),
          row.id,
        );
      }
      if (!previous) {
        if (row.groupId && row.groupId !== '-') {
          this.targetLibrary.incrementGroupBumpedCount(row.groupId, 1);
        }
        if (row.pageId) {
          this.targetLibrary.incrementPageBumpedCount(row.pageId, 1);
        }
      }
      if (commentNew && commentId) {
        if (settings.consumeCommentOnUse) {
          this.db
            .prepare('DELETE FROM group_bumper_comments WHERE id=? AND comment_text=?')
            .run(commentId, row.commentText);
        } else {
          this.db
            .prepare(
              'UPDATE group_bumper_comments SET used_count=used_count+1 WHERE id=? AND comment_text=?',
            )
            .run(commentId, row.commentText);
        }
      }
      return !previous;
    });
  }

  targets(kind: 'groups' | 'pages'): BumperTarget[] {
    return kind === 'groups'
      ? this.targetLibrary.listBumperGroups()
      : this.targetLibrary.listPages();
  }

  comments(scope: BumperScope = 'group'): BumperComment[] {
    return this.db
      .prepare('SELECT * FROM group_bumper_comments WHERE scope=? ORDER BY created_at, id')
      .all(scope)
      .map((r) => ({
        id: String(r.id),
        text: String(r.comment_text),
        usedCount: Number(r.used_count),
        createdAt: Number(r.created_at),
        scope,
      }));
  }

  pickComment(
    postId: string,
    random = Math.random(),
    excludeIds: ReadonlyArray<string> = [],
    scope: BumperScope = 'group',
  ): BumperComment | null {
    const excluded = new Set(excludeIds);
    const digests = new Set(
      this.db
        .prepare(
          'SELECT comment_digest FROM group_bumper_effects WHERE post_id=? AND comment_digest IS NOT NULL',
        )
        .all(postId)
        .map((r) => String(r.comment_digest)),
    );
    const used = new Set(
      this.db
        .prepare(
          'SELECT comment_text FROM group_bumper_logs WHERE post_id=? AND comment_text IS NOT NULL',
        )
        .all(postId)
        .map((r) => String(r.comment_text)),
    );
    const all = this.comments(scope).filter((r) => !excluded.has(r.id));
    const unused = all.filter(
      (r) => !used.has(r.text) && !digests.has(createHash('sha256').update(r.text).digest('hex')),
    );
    const saved = this.savedSettings();
    const consumeOnUse =
      scope === 'page'
        ? saved.pageBumperSettings.consumeCommentOnUse
        : saved.bumperSettings.consumeCommentOnUse;
    const pool = unused.length > 0 ? unused : consumeOnUse ? [] : all;
    return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random * pool.length)))] ?? null;
  }

  todayCounts(now = Date.now(), sourceMode: BumperScope = 'group'): Record<string, number> {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return Object.fromEntries(
      this.db
        .prepare(
          `SELECT profile_id, COUNT(*) n
             FROM group_bumper_effects
            WHERE applied_at>=?
              AND source_mode=?
              AND profile_id IN (SELECT id FROM bluestacks_instances)
            GROUP BY profile_id`,
        )
        .all(today.getTime(), sourceMode)
        .map((r) => [String(r.profile_id), Number(r.n)]),
    );
  }

  total(sourceMode: BumperScope = 'group'): number {
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) n
             FROM group_bumper_logs
            WHERE source_mode=?
              AND profile_id IN (SELECT id FROM bluestacks_instances)`,
        )
        .get(sourceMode)?.n ?? 0,
    );
  }

  weeklyDailyCounts(now = Date.now(), sourceMode: BumperScope = 'group'): BumperDailyStat[] {
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    const tomorrow = new Date(base);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sixDaysAgo = new Date(base);
    sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
    const startMs = sixDaysAgo.getTime();
    const endMs = tomorrow.getTime();

    const buckets = new Map<string, number>();
    const days: string[] = [];
    for (let offset = 0; offset <= 6; offset += 1) {
      const d = new Date(base);
      d.setDate(d.getDate() - offset);
      const ymd = formatLocalYmd(d);
      days.push(ymd);
      buckets.set(ymd, 0);
    }

    const rows = this.db
      .prepare(
        `SELECT applied_at AS bumped_at
           FROM group_bumper_effects
          WHERE applied_at >= ? AND applied_at < ?
            AND source_mode=?
            AND profile_id IN (SELECT id FROM bluestacks_instances)`,
      )
      .all(startMs, endMs, sourceMode);
    for (const r of rows) {
      const ymd = formatLocalYmd(new Date(Number(r.bumped_at)));
      if (buckets.has(ymd)) {
        buckets.set(ymd, (buckets.get(ymd) ?? 0) + 1);
      }
    }

    return days.map((date) => ({ date, count: buckets.get(date) ?? 0 }));
  }
}
