import type { DatabaseSync } from 'node:sqlite';
import { AVATAR_URL_MAX_LENGTH, type InviterGroupRow } from '../shared/group-inviter.js';
import {
  isCompleteNumericId,
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperTarget,
} from '../shared/group-bumper.js';
import { ensureTargetColumns } from './target-list-store.js';
import { transaction } from './sqlite-transaction.js';

export interface SharedFacebookGroupRow {
  groupId: string;
  groupName: string;
  avatarUrl: string | null;
  folderId: string | null;
  sortOrder: number;
  invitedCount: number;
  bumpedCount: number;
  postedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertTargetInput {
  id: string;
  name?: string;
  avatarUrl?: string | null;
  folderId?: string | null;
}

export interface ResolvedTargetMetadataInput {
  canonicalId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}

function isHttpAvatarUrl(url: string | null | undefined): url is string {
  return (
    typeof url === 'string' &&
    /^https?:\/\//i.test(url.trim()) &&
    !/\/rsrc\.php\//i.test(url) &&
    !/\/emoji\.php\//i.test(url)
  );
}

export function sanitizeTargetAvatarUrl(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > AVATAR_URL_MAX_LENGTH) return null;
  if (isLocalAvatar(trimmed) || isHttpAvatarUrl(trimmed)) return trimmed;
  return null;
}

export function mergedAvatar(
  existingAvatar: string | null | undefined,
  incomingAvatar: string | null | undefined,
): string | null {
  if (typeof incomingAvatar === 'string' && isLocalAvatar(incomingAvatar))
    return incomingAvatar.trim();
  if (typeof existingAvatar === 'string' && isLocalAvatar(existingAvatar))
    return existingAvatar.trim();
  if (isHttpAvatarUrl(incomingAvatar)) return incomingAvatar.trim();
  if (isHttpAvatarUrl(existingAvatar)) return existingAvatar.trim();
  return null;
}

function chooseBetterTargetName(
  targetId: string,
  primaryName: string,
  primaryUpdatedAt: number,
  secondaryName: string,
  secondaryUpdatedAt: number,
  rawAliasId?: string,
): string {
  const primaryPlaceholder =
    isPlaceholderTargetName(primaryName, targetId) ||
    (rawAliasId ? isPlaceholderTargetName(primaryName, rawAliasId) : false);
  const secondaryPlaceholder =
    isPlaceholderTargetName(secondaryName, targetId) ||
    (rawAliasId ? isPlaceholderTargetName(secondaryName, rawAliasId) : false);
  if (!primaryPlaceholder && secondaryPlaceholder) return primaryName.trim();
  if (primaryPlaceholder && !secondaryPlaceholder) return secondaryName.trim();
  if (!primaryPlaceholder && !secondaryPlaceholder) {
    return secondaryUpdatedAt > primaryUpdatedAt ? secondaryName.trim() : primaryName.trim();
  }
  return primaryName.trim() || secondaryName.trim() || targetId;
}

function chooseBetterAvatarUrl(
  primaryAvatar: string | null,
  primaryUpdatedAt: number,
  secondaryAvatar: string | null,
  secondaryUpdatedAt: number,
): string | null {
  const p = sanitizeTargetAvatarUrl(primaryAvatar);
  const s = sanitizeTargetAvatarUrl(secondaryAvatar);
  const pLocal = isLocalAvatar(p);
  const sLocal = isLocalAvatar(s);
  if (pLocal && !sLocal) return p;
  if (!pLocal && sLocal) return s;
  if (pLocal && sLocal) {
    return secondaryUpdatedAt > primaryUpdatedAt ? s : p;
  }
  if (p && !s) return p;
  if (!p && s) return s;
  if (p && s) {
    return secondaryUpdatedAt > primaryUpdatedAt ? s : p;
  }
  return null;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

export function ensureTargetLibrarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_facebook_groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      avatar_url TEXT,
      folder_id TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      invited_count INTEGER NOT NULL DEFAULT 0,
      bumped_count INTEGER NOT NULL DEFAULT 0,
      posted_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_bumper_pages (
      page_id TEXT PRIMARY KEY,
      page_name TEXT NOT NULL,
      avatar_url TEXT,
      total_bumped_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      folder_id TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS target_list_folders (
      id TEXT PRIMARY KEY,
      list_kind TEXT NOT NULL CHECK(list_kind IN ('shared_groups', 'bumper_pages')),
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_target_list_folders_kind
      ON target_list_folders(list_kind, sort_order);
    CREATE INDEX IF NOT EXISTS idx_shared_facebook_groups_folder_sort
      ON shared_facebook_groups(folder_id, sort_order, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_group_bumper_pages_folder_sort
      ON group_bumper_pages(folder_id, sort_order, created_at DESC);
  `);
}

export function unifiedTargetLibraryMigration(db: DatabaseSync): void {
  const now = Date.now();
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_inviter_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      invites_per_group INTEGER NOT NULL DEFAULT 30 CHECK (invites_per_group BETWEEN 1 AND 200)
    );
    INSERT OR IGNORE INTO group_inviter_settings (id, invites_per_group)
    VALUES (1, 30);

    CREATE TABLE IF NOT EXISTS group_inviter_logs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      friend_name TEXT NOT NULL DEFAULT '',
      group_id TEXT NOT NULL,
      invited_at INTEGER NOT NULL,
      confirmation TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(confirmation IN ('PENDING','CONFIRMED')),
      operation_id TEXT,
      UNIQUE(group_id, friend_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_group
      ON group_inviter_logs(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_profile
      ON group_inviter_logs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_account
      ON group_inviter_logs(account_id);

    CREATE TABLE IF NOT EXISTS group_bumper_pages (
      page_id TEXT PRIMARY KEY,
      page_name TEXT NOT NULL,
      avatar_url TEXT,
      total_bumped_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      folder_id TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS group_bumper_comments (
      id TEXT PRIMARY KEY,
      comment_text TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_bumper_logs (
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
      bumped_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_post
      ON group_bumper_logs(post_id);
    CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_account_time
      ON group_bumper_logs(account_id, bumped_at);
    CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_profile_post
      ON group_bumper_logs(profile_id, post_id);
    CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_bumped_at
      ON group_bumper_logs(bumped_at DESC);

    CREATE TABLE IF NOT EXISTS group_bumper_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      body TEXT NOT NULL
    );
    INSERT OR IGNORE INTO group_bumper_settings(id, body) VALUES(1, '{}');

    CREATE TABLE IF NOT EXISTS group_bumper_operations (
      operation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      connection_epoch TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      action_kind TEXT NOT NULL CHECK(action_kind IN ('setup_navigate','setup_open_group','setup_welcome','setup_watch','setup_browse','setup_expand_comment','setup_fill_comment','setup_scroll','submit_like','submit_comment')),
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      page_id TEXT,
      page_name TEXT,
      post_id TEXT,
      post_url TEXT,
      comment_id TEXT,
      comment_text TEXT,
      log_id TEXT,
      resolution_id TEXT,
      resolution_outcome TEXT CHECK(resolution_outcome IN ('VERIFIED','NOT_APPLIED','ENDED_UNKNOWN')),
      evidence_digest TEXT,
      status TEXT NOT NULL CHECK(status IN ('PREPARED','SETTLEMENT_PENDING','SETTLED','PENDING_REVIEW')),
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK((resolution_id IS NULL AND resolution_outcome IS NULL AND evidence_digest IS NULL) OR (resolution_id IS NOT NULL AND resolution_outcome IS NOT NULL AND evidence_digest IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_group_bumper_operations_profile_status
      ON group_bumper_operations(profile_id, status);

    CREATE TABLE IF NOT EXISTS group_poster_materials (
      id TEXT PRIMARY KEY,
      caption TEXT NOT NULL,
      media_source TEXT NOT NULL DEFAULT '',
      background TEXT NOT NULL DEFAULT 'plain',
      local_file_path TEXT,
      media_kind TEXT NOT NULL DEFAULT 'none',
      cache_status TEXT NOT NULL DEFAULT 'ready',
      cache_error TEXT,
      selected INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_poster_logs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL DEFAULT '',
      account_avatar TEXT,
      identity_type TEXT NOT NULL DEFAULT 'personal',
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      group_avatar TEXT,
      material_id TEXT NOT NULL,
      caption_preview TEXT NOT NULL DEFAULT '',
      post_id TEXT NOT NULL,
      post_url TEXT NOT NULL,
      posted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_poster_logs_group_material
      ON group_poster_logs(group_id, material_id);
    CREATE INDEX IF NOT EXISTS idx_group_poster_logs_profile_time
      ON group_poster_logs(profile_id, posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_group_poster_logs_posted_at
      ON group_poster_logs(posted_at DESC);

    CREATE TABLE IF NOT EXISTS group_poster_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      body TEXT NOT NULL
    );
    INSERT OR IGNORE INTO group_poster_settings(id, body) VALUES(1, '{}');

    CREATE TABLE IF NOT EXISTS shared_facebook_groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      avatar_url TEXT,
      folder_id TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      invited_count INTEGER NOT NULL DEFAULT 0,
      bumped_count INTEGER NOT NULL DEFAULT 0,
      posted_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_facebook_groups_folder_sort
      ON shared_facebook_groups(folder_id, sort_order, created_at DESC);
  `);

  const posterColumns = db.prepare('PRAGMA table_info(group_poster_materials)').all();
  if (!posterColumns.some((col) => col.name === 'background')) {
    db.exec(
      "ALTER TABLE group_poster_materials ADD COLUMN background TEXT NOT NULL DEFAULT 'plain'",
    );
  }
  ensureTargetColumns(db, 'group_bumper_pages');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_group_bumper_pages_folder_sort ON group_bumper_pages(folder_id, sort_order, created_at DESC)',
  );

  // Step 2: Losslessly merge target_list_folders into ('shared_groups', 'bumper_pages')
  const folderIdRemap = new Map<string, string>();
  const existingFolders = tableExists(db, 'target_list_folders')
    ? (db
        .prepare(
          'SELECT id, list_kind, name, sort_order, created_at FROM target_list_folders ORDER BY sort_order ASC, created_at ASC, id ASC',
        )
        .all() as Array<{
        id: string;
        list_kind: string;
        name: string;
        sort_order: number;
        created_at: number;
      }>)
    : [];

  const mergedGroupFolders: Array<{
    id: string;
    name: string;
    sortOrder: number;
    createdAt: number;
  }> = [];
  const groupFolderByNormalizedName = new Map<string, { id: string }>();
  const mergedPageFolders: Array<{
    id: string;
    name: string;
    sortOrder: number;
    createdAt: number;
  }> = [];

  for (const row of existingFolders) {
    const id = String(row.id);
    const kind = String(row.list_kind);
    const name = String(row.name).trim();
    const createdAt = Number(row.created_at) || now;
    if (kind === 'bumper_pages' || kind === 'pages') {
      mergedPageFolders.push({
        id,
        name,
        sortOrder: mergedPageFolders.length,
        createdAt,
      });
      continue;
    }
    const normKey = name.toLowerCase();
    const existing = groupFolderByNormalizedName.get(normKey);
    if (existing) {
      folderIdRemap.set(id, existing.id);
    } else {
      const entry = {
        id,
        name,
        sortOrder: mergedGroupFolders.length,
        createdAt,
      };
      mergedGroupFolders.push(entry);
      groupFolderByNormalizedName.set(normKey, { id });
      folderIdRemap.set(id, id);
    }
  }

  db.exec(`
    DROP TABLE IF EXISTS target_list_folders_v49;
    CREATE TABLE target_list_folders_v49 (
      id TEXT PRIMARY KEY,
      list_kind TEXT NOT NULL CHECK(list_kind IN ('shared_groups', 'bumper_pages')),
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  const insertFolder = db.prepare(
    'INSERT INTO target_list_folders_v49 (id, list_kind, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const f of mergedGroupFolders) {
    insertFolder.run(f.id, 'shared_groups', f.name, f.sortOrder, f.createdAt);
  }
  for (const f of mergedPageFolders) {
    insertFolder.run(f.id, 'bumper_pages', f.name, f.sortOrder, f.createdAt);
  }
  db.exec(`
    DROP TABLE IF EXISTS target_list_folders;
    ALTER TABLE target_list_folders_v49 RENAME TO target_list_folders;
    CREATE INDEX IF NOT EXISTS idx_target_list_folders_kind
      ON target_list_folders(list_kind, sort_order);
  `);

  // Step 3: Merge group_bumper_groups & group_inviter_groups into shared_facebook_groups
  interface CandidateGroupRow {
    groupId: string;
    groupName: string;
    avatarUrl: string | null;
    folderId: string | null;
    sortOrder: number;
    createdAt: number;
    updatedAt: number;
  }

  const mergedById = new Map<string, CandidateGroupRow>();
  const unionIds = new Set<string>();
  const validGroupFolderIds = new Set(mergedGroupFolders.map((f) => f.id));

  const mergeCandidate = (incoming: CandidateGroupRow) => {
    const id = incoming.groupId.trim();
    if (!id) return;
    unionIds.add(id);
    const candidateFolderId = incoming.folderId
      ? (folderIdRemap.get(incoming.folderId) ?? incoming.folderId)
      : null;
    const remappedFolderId =
      candidateFolderId && validGroupFolderIds.has(candidateFolderId) ? candidateFolderId : null;
    const normalizedIncoming: CandidateGroupRow = {
      ...incoming,
      groupId: id,
      folderId: remappedFolderId,
    };
    const current = mergedById.get(id);
    if (!current) {
      mergedById.set(id, normalizedIncoming);
      return;
    }
    const groupName = chooseBetterTargetName(
      id,
      current.groupName,
      current.updatedAt,
      normalizedIncoming.groupName,
      normalizedIncoming.updatedAt,
    );
    const avatarUrl = chooseBetterAvatarUrl(
      current.avatarUrl,
      current.updatedAt,
      normalizedIncoming.avatarUrl,
      normalizedIncoming.updatedAt,
    );
    let folderId = current.folderId;
    let sortOrder = current.sortOrder;
    if (!current.folderId && normalizedIncoming.folderId) {
      folderId = normalizedIncoming.folderId;
      sortOrder = normalizedIncoming.sortOrder;
    } else if (
      current.folderId &&
      normalizedIncoming.folderId &&
      current.folderId !== normalizedIncoming.folderId &&
      normalizedIncoming.updatedAt > current.updatedAt
    ) {
      folderId = normalizedIncoming.folderId;
      sortOrder = normalizedIncoming.sortOrder;
    }
    mergedById.set(id, {
      groupId: id,
      groupName,
      avatarUrl,
      folderId,
      sortOrder,
      createdAt: Math.min(current.createdAt, normalizedIncoming.createdAt),
      updatedAt: Math.max(current.updatedAt, normalizedIncoming.updatedAt),
    });
  };

  const existingSharedRows = db
    .prepare(
      'SELECT group_id, group_name, avatar_url, folder_id, sort_order, created_at, updated_at FROM shared_facebook_groups',
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of existingSharedRows) {
    mergeCandidate({
      groupId: String(row.group_id),
      groupName: String(row.group_name ?? row.group_id),
      avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
      folderId: typeof row.folder_id === 'string' ? row.folder_id : null,
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: Number(row.created_at ?? now),
      updatedAt: Number(row.updated_at ?? now),
    });
  }

  for (const legacyTable of ['group_bumper_groups', 'group_inviter_groups'] as const) {
    if (!tableExists(db, legacyTable)) continue;
    ensureTargetColumns(db, legacyTable);
    const rows = db
      .prepare(
        `SELECT group_id, group_name, avatar_url, folder_id, sort_order, created_at, updated_at FROM ${legacyTable}`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      mergeCandidate({
        groupId: String(row.group_id),
        groupName: String(row.group_name ?? row.group_id),
        avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        folderId: typeof row.folder_id === 'string' ? row.folder_id : null,
        sortOrder: Number(row.sort_order ?? 0),
        createdAt: Number(row.created_at ?? now),
        updatedAt: Number(row.updated_at ?? now),
      });
    }
  }

  const byFolder = new Map<string | null, CandidateGroupRow[]>();
  for (const item of mergedById.values()) {
    const list = byFolder.get(item.folderId) ?? [];
    list.push(item);
    byFolder.set(item.folderId, list);
  }
  for (const list of byFolder.values()) {
    list.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        b.createdAt - a.createdAt ||
        a.groupId.localeCompare(b.groupId),
    );
    list.forEach((item, index) => {
      item.sortOrder = index;
    });
  }

  const countInvitedStmt = db.prepare(
    "SELECT COUNT(*) AS cnt FROM group_inviter_logs WHERE group_id = ? AND confirmation = 'CONFIRMED'",
  );
  const countBumpedStmt = db.prepare(
    'SELECT COUNT(*) AS cnt FROM group_bumper_logs WHERE group_id = ?',
  );
  const countPostedStmt = db.prepare(
    'SELECT COUNT(*) AS cnt FROM group_poster_logs WHERE group_id = ?',
  );
  const upsertSharedStmt = db.prepare(`
    INSERT INTO shared_facebook_groups (
      group_id, group_name, avatar_url, folder_id, sort_order,
      invited_count, bumped_count, posted_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = excluded.group_name,
      avatar_url = excluded.avatar_url,
      folder_id = excluded.folder_id,
      sort_order = excluded.sort_order,
      invited_count = excluded.invited_count,
      bumped_count = excluded.bumped_count,
      posted_count = excluded.posted_count,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);

  for (const item of mergedById.values()) {
    const invitedCount = Number(countInvitedStmt.get(item.groupId)?.cnt ?? 0);
    const bumpedCount = Number(countBumpedStmt.get(item.groupId)?.cnt ?? 0);
    const postedCount = Number(countPostedStmt.get(item.groupId)?.cnt ?? 0);
    upsertSharedStmt.run(
      item.groupId,
      item.groupName,
      item.avatarUrl,
      item.folderId,
      item.sortOrder,
      invitedCount,
      bumpedCount,
      postedCount,
      item.createdAt,
      item.updatedAt,
    );
  }

  const finalCount = Number(
    db.prepare('SELECT COUNT(*) AS cnt FROM shared_facebook_groups').get()?.cnt ?? 0,
  );
  if (finalCount < unionIds.size) {
    throw new Error(
      `SHARED_GROUPS_MIGRATION_COUNT_MISMATCH: expected >= ${unionIds.size}, got ${finalCount}`,
    );
  }

  db.exec(`
    DROP TABLE IF EXISTS group_inviter_groups;
    DROP TABLE IF EXISTS group_bumper_groups;
  `);
}

export class SqliteTargetLibraryRepository {
  constructor(private readonly db: DatabaseSync) {
    ensureTargetLibrarySchema(this.db);
  }

  private nextSortOrder(
    table: 'shared_facebook_groups' | 'group_bumper_pages',
    folderId: string | null,
  ): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${table} WHERE folder_id IS ?`)
      .get(folderId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  listGroups(): SharedFacebookGroupRow[] {
    const rows = this.db
      .prepare(
        `SELECT
          group_id,
          group_name,
          avatar_url,
          folder_id,
          sort_order,
          invited_count,
          bumped_count,
          posted_count,
          created_at,
          updated_at
        FROM shared_facebook_groups
        ORDER BY sort_order ASC, created_at DESC, group_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      groupId: String(row.group_id),
      groupName: String(row.group_name),
      avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
      folderId: typeof row.folder_id === 'string' ? row.folder_id : null,
      sortOrder: Number(row.sort_order ?? 0),
      invitedCount: Number(row.invited_count ?? 0),
      bumpedCount: Number(row.bumped_count ?? 0),
      postedCount: Number(row.posted_count ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  }

  listInviterGroups(): InviterGroupRow[] {
    return this.listGroups().map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      avatarUrl: row.avatarUrl,
      folderId: row.folderId,
      sortOrder: row.sortOrder,
      totalInvitedCount: row.invitedCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  listBumperGroups(): BumperTarget[] {
    return this.listGroups().map((row) => ({
      id: row.groupId,
      name: row.groupName,
      avatarUrl: row.avatarUrl,
      folderId: row.folderId,
      sortOrder: row.sortOrder,
      totalBumpedCount: row.bumpedCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  listPages(): BumperTarget[] {
    const rows = this.db
      .prepare(
        `SELECT
          page_id,
          page_name,
          avatar_url,
          folder_id,
          sort_order,
          total_bumped_count,
          created_at,
          updated_at
        FROM group_bumper_pages
        ORDER BY sort_order ASC, created_at DESC, page_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.page_id),
      name: String(row.page_name),
      avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
      folderId: typeof row.folder_id === 'string' ? row.folder_id : null,
      sortOrder: Number(row.sort_order ?? 0),
      totalBumpedCount: Number(row.total_bumped_count ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  }

  upsertGroups(items: readonly UpsertTargetInput[]): SharedFacebookGroupRow[] {
    if (items.length === 0) return this.listGroups();
    const now = Date.now();
    const selectStmt = this.db.prepare(
      'SELECT group_id, group_name, avatar_url, folder_id, sort_order FROM shared_facebook_groups WHERE group_id = ?',
    );
    const insertStmt = this.db.prepare(`
      INSERT INTO shared_facebook_groups (
        group_id, group_name, avatar_url, folder_id, sort_order,
        invited_count, bumped_count, posted_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    `);
    const updateStmt = this.db.prepare(`
      UPDATE shared_facebook_groups
      SET group_name = ?, avatar_url = ?, folder_id = ?, sort_order = ?, updated_at = ?
      WHERE group_id = ?
    `);

    transaction(this.db, () => {
      for (const item of items) {
        const id = item.id.trim();
        if (!id) continue;
        const incomingName = (item.name ?? '').trim();
        const incomingAvatar = sanitizeTargetAvatarUrl(item.avatarUrl);
        const incomingFolderId = item.folderId ?? null;
        const existing = selectStmt.get(id) as
          | {
              group_id: string;
              group_name: string;
              avatar_url: string | null;
              folder_id: string | null;
              sort_order: number;
            }
          | undefined;

        if (!existing) {
          const sortOrder = this.nextSortOrder('shared_facebook_groups', incomingFolderId);
          insertStmt.run(
            id,
            incomingName || id,
            incomingAvatar,
            incomingFolderId,
            sortOrder,
            now,
            now,
          );
          continue;
        }

        const nextName =
          incomingName && !isPlaceholderTargetName(incomingName, id)
            ? incomingName
            : existing.group_name;
        const existingAvatar = sanitizeTargetAvatarUrl(existing.avatar_url);
        const nextAvatar =
          isLocalAvatar(existingAvatar) && !isLocalAvatar(incomingAvatar)
            ? existingAvatar
            : (incomingAvatar ?? existingAvatar);

        let nextFolderId = existing.folder_id;
        let nextSortOrder = Number(existing.sort_order ?? 0);
        if (incomingFolderId !== null && incomingFolderId !== existing.folder_id) {
          nextFolderId = incomingFolderId;
          nextSortOrder = this.nextSortOrder('shared_facebook_groups', incomingFolderId);
        }

        updateStmt.run(nextName, nextAvatar, nextFolderId, nextSortOrder, now, id);
      }
    });

    return this.listGroups();
  }

  upsertPages(items: readonly UpsertTargetInput[]): BumperTarget[] {
    if (items.length === 0) return this.listPages();
    const now = Date.now();
    const selectStmt = this.db.prepare(
      'SELECT page_id, page_name, avatar_url, folder_id, sort_order FROM group_bumper_pages WHERE page_id = ?',
    );
    const insertStmt = this.db.prepare(`
      INSERT INTO group_bumper_pages (
        page_id, page_name, avatar_url, folder_id, sort_order, total_bumped_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `);
    const updateStmt = this.db.prepare(`
      UPDATE group_bumper_pages
      SET page_name = ?, avatar_url = ?, folder_id = ?, sort_order = ?, updated_at = ?
      WHERE page_id = ?
    `);

    transaction(this.db, () => {
      for (const item of items) {
        const id = item.id.trim();
        if (!id) continue;
        const incomingName = (item.name ?? '').trim();
        const incomingAvatar = sanitizeTargetAvatarUrl(item.avatarUrl);
        const incomingFolderId = item.folderId ?? null;
        const existing = selectStmt.get(id) as
          | {
              page_id: string;
              page_name: string;
              avatar_url: string | null;
              folder_id: string | null;
              sort_order: number;
            }
          | undefined;

        if (!existing) {
          const sortOrder = this.nextSortOrder('group_bumper_pages', incomingFolderId);
          insertStmt.run(
            id,
            incomingName || id,
            incomingAvatar,
            incomingFolderId,
            sortOrder,
            now,
            now,
          );
          continue;
        }

        const nextName =
          incomingName && !isPlaceholderTargetName(incomingName, id)
            ? incomingName
            : existing.page_name;
        const existingAvatar = sanitizeTargetAvatarUrl(existing.avatar_url);
        const nextAvatar =
          isLocalAvatar(existingAvatar) && !isLocalAvatar(incomingAvatar)
            ? existingAvatar
            : (incomingAvatar ?? existingAvatar);

        let nextFolderId = existing.folder_id;
        let nextSortOrder = Number(existing.sort_order ?? 0);
        if (incomingFolderId !== null && incomingFolderId !== existing.folder_id) {
          nextFolderId = incomingFolderId;
          nextSortOrder = this.nextSortOrder('group_bumper_pages', incomingFolderId);
        }

        updateStmt.run(nextName, nextAvatar, nextFolderId, nextSortOrder, now, id);
      }
    });

    return this.listPages();
  }

  deleteGroups(groupIds: readonly string[]): SharedFacebookGroupRow[] {
    if (groupIds.length === 0) return this.listGroups();
    const deleteStmt = this.db.prepare('DELETE FROM shared_facebook_groups WHERE group_id = ?');
    transaction(this.db, () => {
      for (const id of groupIds) {
        deleteStmt.run(id.trim());
      }
    });
    return this.listGroups();
  }

  deletePages(pageIds: readonly string[]): BumperTarget[] {
    if (pageIds.length === 0) return this.listPages();
    const deleteStmt = this.db.prepare('DELETE FROM group_bumper_pages WHERE page_id = ?');
    transaction(this.db, () => {
      for (const id of pageIds) {
        deleteStmt.run(id.trim());
      }
    });
    return this.listPages();
  }

  incrementGroupInvitedCount(groupId: string, delta = 1): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE shared_facebook_groups SET invited_count = invited_count + ?, updated_at = ? WHERE group_id = ?',
      )
      .run(delta, now, groupId);
  }

  incrementGroupBumpedCount(groupId: string, delta = 1): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE shared_facebook_groups SET bumped_count = bumped_count + ?, updated_at = ? WHERE group_id = ?',
      )
      .run(delta, now, groupId);
  }

  incrementGroupPostedCount(groupId: string, delta = 1): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE shared_facebook_groups SET posted_count = posted_count + ?, updated_at = ? WHERE group_id = ?',
      )
      .run(delta, now, groupId);
  }

  incrementPageBumpedCount(pageId: string, delta = 1): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE group_bumper_pages SET total_bumped_count = total_bumped_count + ?, updated_at = ? WHERE page_id = ?',
      )
      .run(delta, now, pageId);
  }

  applyResolvedTargetMetadata(
    kind: 'group' | 'groups' | 'page' | 'pages',
    rawId: string,
    metadata: ResolvedTargetMetadataInput,
  ): boolean {
    const cleanRawId = rawId.trim();
    if (!cleanRawId) return false;
    const isGroup = kind === 'group' || kind === 'groups';
    const canonicalId =
      metadata.canonicalId && isCompleteNumericId(metadata.canonicalId)
        ? metadata.canonicalId.trim()
        : cleanRawId;
    const incomingName = (metadata.name ?? '').trim();
    const incomingAvatar = sanitizeTargetAvatarUrl(metadata.avatarUrl);
    const now = Date.now();

    return transaction(this.db, () => {
      if (isGroup) {
        const selectGroup = this.db.prepare(
          `SELECT
            group_id, group_name, avatar_url, folder_id, sort_order,
            invited_count, bumped_count, posted_count, created_at, updated_at
          FROM shared_facebook_groups WHERE group_id = ?`,
        );
        const rawRow = selectGroup.get(cleanRawId) as Record<string, unknown> | undefined;
        if (!rawRow) return false;
        const canonicalRow =
          canonicalId !== cleanRawId
            ? (selectGroup.get(canonicalId) as Record<string, unknown> | undefined)
            : undefined;

        const existingName = canonicalRow ? String(canonicalRow.group_name ?? '').trim() : '';
        const currentName = String(rawRow.group_name ?? '').trim();
        const finalName =
          incomingName &&
          !isPlaceholderTargetName(incomingName, canonicalId) &&
          !isPlaceholderTargetName(incomingName, cleanRawId)
            ? incomingName
            : existingName && !isPlaceholderTargetName(existingName, canonicalId)
              ? existingName
              : currentName && !isPlaceholderTargetName(currentName, cleanRawId)
                ? currentName
                : incomingName || existingName || currentName || canonicalId;

        const currentAvatar = typeof rawRow.avatar_url === 'string' ? rawRow.avatar_url : null;
        const duplicateAvatar =
          canonicalRow && typeof canonicalRow.avatar_url === 'string'
            ? canonicalRow.avatar_url
            : null;
        const baseAvatar = mergedAvatar(duplicateAvatar, currentAvatar);
        const finalAvatar = mergedAvatar(baseAvatar, incomingAvatar);

        if (canonicalId !== cleanRawId) {
          // 1. Cascade group_inviter_logs with UNIQUE(group_id, friend_id) deduplication
          if (tableExists(this.db, 'group_inviter_logs')) {
            const rawLogs = this.db
              .prepare(
                'SELECT id, friend_id, confirmation FROM group_inviter_logs WHERE group_id = ?',
              )
              .all(cleanRawId) as Array<{ id: string; friend_id: string; confirmation: string }>;
            const findCanonLog = this.db.prepare(
              'SELECT id, confirmation FROM group_inviter_logs WHERE group_id = ? AND friend_id = ?',
            );
            const deleteLog = this.db.prepare('DELETE FROM group_inviter_logs WHERE id = ?');
            const updateSingleLog = this.db.prepare(
              'UPDATE group_inviter_logs SET group_id = ? WHERE id = ?',
            );
            for (const rLog of rawLogs) {
              const conflict = findCanonLog.get(canonicalId, rLog.friend_id) as
                { id: string; confirmation: string } | undefined;
              if (!conflict) {
                updateSingleLog.run(canonicalId, rLog.id);
              } else if (
                rLog.confirmation === 'CONFIRMED' &&
                conflict.confirmation !== 'CONFIRMED'
              ) {
                deleteLog.run(conflict.id);
                updateSingleLog.run(canonicalId, rLog.id);
              } else {
                deleteLog.run(rLog.id);
              }
            }
          }

          // 2. Cascade group_bumper_logs, group_poster_logs, group_bumper_operations, group_poster_operations
          if (tableExists(this.db, 'group_bumper_logs')) {
            this.db
              .prepare(
                'UPDATE group_bumper_logs SET group_id = ?, group_name = ? WHERE group_id = ?',
              )
              .run(canonicalId, finalName, cleanRawId);
          }
          if (tableExists(this.db, 'group_poster_logs')) {
            this.db
              .prepare(
                "UPDATE group_poster_logs SET group_id = ?, group_name = COALESCE(NULLIF(?, ''), group_name) WHERE group_id = ?",
              )
              .run(canonicalId, finalName, cleanRawId);
          }
          for (const table of ['group_bumper_effects', 'group_poster_usage']) {
            if (tableExists(this.db, table))
              this.db
                .prepare(`UPDATE ${table} SET group_id = ? WHERE group_id = ?`)
                .run(canonicalId, cleanRawId);
          }
          if (tableExists(this.db, 'group_bumper_operations')) {
            this.db
              .prepare('UPDATE group_bumper_operations SET group_id = ? WHERE group_id = ?')
              .run(canonicalId, cleanRawId);
          }
          if (tableExists(this.db, 'group_poster_operations')) {
            this.db
              .prepare('UPDATE group_poster_operations SET group_id = ? WHERE group_id = ?')
              .run(canonicalId, cleanRawId);
          }

          // 3. Merge or update shared_facebook_groups
          const calcInvited = tableExists(this.db, 'group_inviter_logs')
            ? Number(
                this.db
                  .prepare(
                    "SELECT COUNT(*) AS cnt FROM group_inviter_logs WHERE group_id = ? AND confirmation = 'CONFIRMED'",
                  )
                  .get(canonicalId)?.cnt ?? 0,
              )
            : 0;
          const bumperHistory = tableExists(this.db, 'group_bumper_effects')
            ? 'group_bumper_effects'
            : 'group_bumper_logs';
          const posterHistory = tableExists(this.db, 'group_poster_usage')
            ? 'group_poster_usage'
            : 'group_poster_logs';
          const calcBumped = tableExists(this.db, bumperHistory)
            ? Number(
                this.db
                  .prepare(`SELECT COUNT(*) AS cnt FROM ${bumperHistory} WHERE group_id = ?`)
                  .get(canonicalId)?.cnt ?? 0,
              )
            : 0;
          const calcPosted = tableExists(this.db, posterHistory)
            ? Number(
                this.db
                  .prepare(`SELECT COUNT(*) AS cnt FROM ${posterHistory} WHERE group_id = ?`)
                  .get(canonicalId)?.cnt ?? 0,
              )
            : 0;

          if (canonicalRow) {
            const folderId =
              (typeof canonicalRow.folder_id === 'string' ? canonicalRow.folder_id : null) ??
              (typeof rawRow.folder_id === 'string' ? rawRow.folder_id : null);
            const sortOrder =
              typeof canonicalRow.folder_id === 'string'
                ? Number(canonicalRow.sort_order ?? 0)
                : typeof rawRow.folder_id === 'string'
                  ? Number(rawRow.sort_order ?? 0)
                  : Number(canonicalRow.sort_order ?? 0);
            const fallbackInvited =
              Number(canonicalRow.invited_count ?? 0) + Number(rawRow.invited_count ?? 0);
            const fallbackBumped =
              Number(canonicalRow.bumped_count ?? 0) + Number(rawRow.bumped_count ?? 0);
            const fallbackPosted =
              Number(canonicalRow.posted_count ?? 0) + Number(rawRow.posted_count ?? 0);

            this.db
              .prepare(
                `UPDATE shared_facebook_groups
                 SET group_name = ?, avatar_url = ?, folder_id = ?, sort_order = ?,
                     invited_count = ?, bumped_count = ?, posted_count = ?, updated_at = ?
                 WHERE group_id = ?`,
              )
              .run(
                finalName,
                finalAvatar,
                folderId,
                sortOrder,
                calcInvited > 0 ? calcInvited : fallbackInvited,
                calcBumped > 0 ? calcBumped : fallbackBumped,
                calcPosted > 0 ? calcPosted : fallbackPosted,
                now,
                canonicalId,
              );
            this.db
              .prepare('DELETE FROM shared_facebook_groups WHERE group_id = ?')
              .run(cleanRawId);
          } else {
            const invitedCount = calcInvited > 0 ? calcInvited : Number(rawRow.invited_count ?? 0);
            const bumpedCount = calcBumped > 0 ? calcBumped : Number(rawRow.bumped_count ?? 0);
            const postedCount = calcPosted > 0 ? calcPosted : Number(rawRow.posted_count ?? 0);
            this.db
              .prepare(
                `UPDATE shared_facebook_groups
                 SET group_id = ?, group_name = ?, avatar_url = ?,
                     invited_count = ?, bumped_count = ?, posted_count = ?, updated_at = ?
                 WHERE group_id = ?`,
              )
              .run(
                canonicalId,
                finalName,
                finalAvatar,
                invitedCount,
                bumpedCount,
                postedCount,
                now,
                cleanRawId,
              );
          }
          return true;
        }

        // In-place update when canonicalId === cleanRawId
        this.db
          .prepare(
            'UPDATE shared_facebook_groups SET group_name = ?, avatar_url = ?, updated_at = ? WHERE group_id = ?',
          )
          .run(finalName, finalAvatar, now, cleanRawId);
        if (tableExists(this.db, 'group_bumper_logs')) {
          this.db
            .prepare('UPDATE group_bumper_logs SET group_name = ? WHERE group_id = ?')
            .run(finalName, cleanRawId);
        }
        return true;
      }

      // kind === 'page' / 'pages'
      const selectPage = this.db.prepare(
        `SELECT page_id, page_name, avatar_url, folder_id, sort_order, total_bumped_count, created_at, updated_at
         FROM group_bumper_pages WHERE page_id = ?`,
      );
      const rawPage = selectPage.get(cleanRawId) as Record<string, unknown> | undefined;
      if (!rawPage) return false;
      const canonicalPage =
        canonicalId !== cleanRawId
          ? (selectPage.get(canonicalId) as Record<string, unknown> | undefined)
          : undefined;

      const existingName = canonicalPage ? String(canonicalPage.page_name ?? '').trim() : '';
      const currentName = String(rawPage.page_name ?? '').trim();
      const finalName =
        incomingName &&
        !isPlaceholderTargetName(incomingName, canonicalId) &&
        !isPlaceholderTargetName(incomingName, cleanRawId)
          ? incomingName
          : existingName && !isPlaceholderTargetName(existingName, canonicalId)
            ? existingName
            : currentName && !isPlaceholderTargetName(currentName, cleanRawId)
              ? currentName
              : incomingName || existingName || currentName || canonicalId;

      const currentAvatar = typeof rawPage.avatar_url === 'string' ? rawPage.avatar_url : null;
      const duplicateAvatar =
        canonicalPage && typeof canonicalPage.avatar_url === 'string'
          ? canonicalPage.avatar_url
          : null;
      const baseAvatar = mergedAvatar(duplicateAvatar, currentAvatar);
      const finalAvatar = mergedAvatar(baseAvatar, incomingAvatar);

      if (canonicalId !== cleanRawId) {
        if (tableExists(this.db, 'group_bumper_effects'))
          this.db
            .prepare('UPDATE group_bumper_effects SET page_id = ? WHERE page_id = ?')
            .run(canonicalId, cleanRawId);
        if (tableExists(this.db, 'group_bumper_logs')) {
          this.db
            .prepare('UPDATE group_bumper_logs SET page_id = ?, page_name = ? WHERE page_id = ?')
            .run(canonicalId, finalName, cleanRawId);
        }
        if (tableExists(this.db, 'group_bumper_operations')) {
          this.db
            .prepare('UPDATE group_bumper_operations SET page_id = ? WHERE page_id = ?')
            .run(canonicalId, cleanRawId);
        }
        const bumperHistory = tableExists(this.db, 'group_bumper_effects')
          ? 'group_bumper_effects'
          : 'group_bumper_logs';
        const calcPageBumped = tableExists(this.db, bumperHistory)
          ? Number(
              this.db
                .prepare(`SELECT COUNT(*) AS cnt FROM ${bumperHistory} WHERE page_id = ?`)
                .get(canonicalId)?.cnt ?? 0,
            )
          : 0;
        if (canonicalPage) {
          const folderId =
            (typeof canonicalPage.folder_id === 'string' ? canonicalPage.folder_id : null) ??
            (typeof rawPage.folder_id === 'string' ? rawPage.folder_id : null);
          const sortOrder =
            typeof canonicalPage.folder_id === 'string'
              ? Number(canonicalPage.sort_order ?? 0)
              : typeof rawPage.folder_id === 'string'
                ? Number(rawPage.sort_order ?? 0)
                : Number(canonicalPage.sort_order ?? 0);
          const fallbackBumped =
            Number(canonicalPage.total_bumped_count ?? 0) + Number(rawPage.total_bumped_count ?? 0);

          this.db
            .prepare(
              `UPDATE group_bumper_pages
               SET page_name = ?, avatar_url = ?, folder_id = ?, sort_order = ?,
                   total_bumped_count = ?, updated_at = ?
               WHERE page_id = ?`,
            )
            .run(
              finalName,
              finalAvatar,
              folderId,
              sortOrder,
              calcPageBumped > 0 ? calcPageBumped : fallbackBumped,
              now,
              canonicalId,
            );
          this.db.prepare('DELETE FROM group_bumper_pages WHERE page_id = ?').run(cleanRawId);
        } else {
          const bumpedCount =
            calcPageBumped > 0 ? calcPageBumped : Number(rawPage.total_bumped_count ?? 0);
          this.db
            .prepare(
              `UPDATE group_bumper_pages
               SET page_id = ?, page_name = ?, avatar_url = ?, total_bumped_count = ?, updated_at = ?
               WHERE page_id = ?`,
            )
            .run(canonicalId, finalName, finalAvatar, bumpedCount, now, cleanRawId);
        }
        return true;
      }

      this.db
        .prepare(
          'UPDATE group_bumper_pages SET page_name = ?, avatar_url = ?, updated_at = ? WHERE page_id = ?',
        )
        .run(finalName, finalAvatar, now, cleanRawId);
      if (tableExists(this.db, 'group_bumper_logs')) {
        this.db
          .prepare('UPDATE group_bumper_logs SET page_name = ? WHERE page_id = ?')
          .run(finalName, cleanRawId);
      }
      return true;
    });
  }
}
