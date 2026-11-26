import type { DatabaseSync } from 'node:sqlite';
import {
  isCompleteNumericId,
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperTarget,
} from '../shared/group-bumper.js';
import { AVATAR_URL_MAX_LENGTH } from '../shared/group-inviter.js';
import * as Q from './persistence/sqlite-query-helpers.js';
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

const isHttpAvatarUrl = (url: string | null | undefined): url is string =>
  typeof url === 'string' &&
  /^https?:\/\//i.test(url.trim()) &&
  !/\/(?:rsrc|emoji)\.php\//i.test(url);

export function sanitizeTargetAvatarUrl(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return !t || t.length > AVATAR_URL_MAX_LENGTH
    ? null
    : isLocalAvatar(t) || isHttpAvatarUrl(t)
      ? t
      : null;
}

export function mergedAvatar(
  existingAvatar: string | null | undefined,
  incomingAvatar: string | null | undefined,
): string | null {
  for (const v of [incomingAvatar, existingAvatar])
    if (typeof v === 'string' && isLocalAvatar(v)) return v.trim();
  for (const v of [incomingAvatar, existingAvatar]) if (isHttpAvatarUrl(v)) return v.trim();
  return null;
}

export function ensureTargetLibrarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_facebook_groups (group_id TEXT PRIMARY KEY, group_name TEXT NOT NULL, avatar_url TEXT, folder_id TEXT DEFAULT NULL, sort_order INTEGER NOT NULL DEFAULT 0, invited_count INTEGER NOT NULL DEFAULT 0, bumped_count INTEGER NOT NULL DEFAULT 0, posted_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS group_bumper_pages (page_id TEXT PRIMARY KEY, page_name TEXT NOT NULL, avatar_url TEXT, total_bumped_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, folder_id TEXT DEFAULT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS target_list_folders (id TEXT PRIMARY KEY, list_kind TEXT NOT NULL CHECK(list_kind IN ('shared_groups', 'bumper_pages')), name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_target_list_folders_kind ON target_list_folders(list_kind, sort_order); CREATE INDEX IF NOT EXISTS idx_shared_facebook_groups_folder_sort ON shared_facebook_groups(folder_id, sort_order, created_at DESC); CREATE INDEX IF NOT EXISTS idx_group_bumper_pages_folder_sort ON group_bumper_pages(folder_id, sort_order, created_at DESC);
  `);
}

function pickResolvedName(
  incomingName: string,
  existingName: string,
  currentName: string,
  canonicalId: string,
  cleanRawId: string,
): string {
  if (
    incomingName &&
    !isPlaceholderTargetName(incomingName, canonicalId) &&
    !isPlaceholderTargetName(incomingName, cleanRawId)
  )
    return incomingName;
  if (existingName && !isPlaceholderTargetName(existingName, canonicalId)) return existingName;
  if (currentName && !isPlaceholderTargetName(currentName, cleanRawId)) return currentName;
  return incomingName || existingName || currentName || canonicalId;
}

function cascadeCanonicalId(
  db: DatabaseSync,
  isGroup: boolean,
  cleanRawId: string,
  canonicalId: string,
  finalName: string,
): void {
  if (isGroup && Q.sqliteTableExists(db, 'group_inviter_logs')) {
    const find = db.prepare(
      'SELECT id, confirmation FROM group_inviter_logs WHERE group_id=? AND friend_id=?',
    );
    const del = db.prepare('DELETE FROM group_inviter_logs WHERE id=?'),
      upd = db.prepare('UPDATE group_inviter_logs SET group_id=? WHERE id=?'),
      rows = Q.allRows(
        db,
        'SELECT id, friend_id, confirmation FROM group_inviter_logs WHERE group_id=?',
        cleanRawId,
      );
    for (const rLog of rows) {
      const conflict = find.get(canonicalId, String(rLog.friend_id)) as
        { id: string; confirmation: string } | undefined;
      if (!conflict) upd.run(canonicalId, String(rLog.id));
      else if (rLog.confirmation === 'CONFIRMED' && conflict.confirmation !== 'CONFIRMED') {
        del.run(conflict.id);
        upd.run(canonicalId, String(rLog.id));
      } else del.run(String(rLog.id));
    }
  }
  const col = isGroup ? 'group_id' : 'page_id',
    nameCol = isGroup ? 'group_name' : 'page_name';
  const tables = isGroup
    ? [
        'group_bumper_effects',
        'group_poster_usage',
        'group_bumper_operations',
        'group_poster_operations',
      ]
    : ['group_bumper_effects', 'group_bumper_operations'];
  for (const t of tables)
    if (Q.sqliteTableExists(db, t))
      Q.run(db, `UPDATE ${t} SET ${col}=? WHERE ${col}=?`, canonicalId, cleanRawId);
  if (Q.sqliteTableExists(db, 'post_bump_records')) {
    const sql = `UPDATE post_bump_records SET ${col}=?, ${nameCol}=COALESCE(NULLIF(?,''), ${nameCol}) WHERE ${col}=?`;
    Q.run(db, sql, canonicalId, finalName, cleanRawId);
  }
}

export class SqliteTargetLibraryRepository {
  constructor(private readonly db: DatabaseSync) {
    ensureTargetLibrarySchema(this.db);
  }
  listGroups = (): SharedFacebookGroupRow[] => {
    const sql =
      'SELECT group_id, group_name, avatar_url, folder_id, sort_order, invited_count, bumped_count, posted_count, created_at, updated_at FROM shared_facebook_groups ORDER BY sort_order ASC, created_at DESC, group_id ASC';
    return Q.allRows(this.db, sql).map((r) => Q.camel(r) as unknown as SharedFacebookGroupRow);
  };
  listBumperGroups = (): BumperTarget[] =>
    this.listGroups().map((r) => ({
      id: r.groupId,
      name: r.groupName,
      avatarUrl: r.avatarUrl,
      folderId: r.folderId,
      sortOrder: r.sortOrder,
      totalBumpedCount: r.bumpedCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  listPages = (): BumperTarget[] => {
    const sql =
      'SELECT page_id AS id, page_name AS name, avatar_url, folder_id, sort_order, total_bumped_count, created_at, updated_at FROM group_bumper_pages ORDER BY sort_order ASC, created_at DESC, page_id ASC';
    return Q.allRows(this.db, sql).map((r) => Q.camel(r) as unknown as BumperTarget);
  };
  private upsertTargetsTable(
    table: 'shared_facebook_groups' | 'group_bumper_pages',
    items: readonly UpsertTargetInput[],
  ): void {
    const isGroup = table === 'shared_facebook_groups',
      idCol = isGroup ? 'group_id' : 'page_id',
      nameCol = isGroup ? 'group_name' : 'page_name',
      now = Date.now();
    const sel = this.db.prepare(
      `SELECT ${idCol} AS target_id, ${nameCol} AS target_name, avatar_url, folder_id, sort_order FROM ${table} WHERE ${idCol} = ?`,
    );
    const insSql = isGroup
      ? 'INSERT INTO shared_facebook_groups (group_id, group_name, avatar_url, folder_id, sort_order, invited_count, bumped_count, posted_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)'
      : 'INSERT INTO group_bumper_pages (page_id, page_name, avatar_url, folder_id, sort_order, total_bumped_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)';
    const updSql = `UPDATE ${table} SET ${nameCol}=?, avatar_url=?, folder_id=?, sort_order=?, updated_at=? WHERE ${idCol}=?`;
    const ins = this.db.prepare(insSql),
      upd = this.db.prepare(updSql);
    transaction(this.db, () => {
      for (const item of items) {
        const id = item.id.trim();
        if (!id) continue;
        const name = (item.name ?? '').trim(),
          av = sanitizeTargetAvatarUrl(item.avatarUrl),
          fid = item.folderId ?? null,
          ex = sel.get(id) as
            | {
                target_name: string;
                avatar_url: string | null;
                folder_id: string | null;
                sort_order: number;
              }
            | undefined;
        if (!ex) {
          const ord = Q.nextSortOrder(this.db, table, 'folder_id IS ?', fid);
          ins.run(id, name || id, av, fid, ord, now, now);
          continue;
        }
        const nextName = name && !isPlaceholderTargetName(name, id) ? name : ex.target_name,
          exAv = sanitizeTargetAvatarUrl(ex.avatar_url),
          nextAv = isLocalAvatar(exAv) && !isLocalAvatar(av) ? exAv : (av ?? exAv),
          moved = fid !== null && fid !== ex.folder_id,
          ord = moved
            ? Q.nextSortOrder(this.db, table, 'folder_id IS ?', fid)
            : Number(ex.sort_order ?? 0);
        upd.run(nextName, nextAv, moved ? fid : ex.folder_id, ord, now, id);
      }
    });
  }
  upsertGroups(items: readonly UpsertTargetInput[]): SharedFacebookGroupRow[] {
    if (items.length) this.upsertTargetsTable('shared_facebook_groups', items);
    return this.listGroups();
  }
  upsertPages(items: readonly UpsertTargetInput[]): BumperTarget[] {
    if (items.length) this.upsertTargetsTable('group_bumper_pages', items);
    return this.listPages();
  }
  private incCount = (table: string, col: string, idCol: string, id: string, delta: number) => {
    Q.run(
      this.db,
      `UPDATE ${table} SET ${col}=${col}+?, updated_at=? WHERE ${idCol}=?`,
      delta,
      Date.now(),
      id,
    );
  };
  incrementGroupInvitedCount = (groupId: string, delta = 1) =>
    this.incCount('shared_facebook_groups', 'invited_count', 'group_id', groupId, delta);
  incrementGroupBumpedCount = (groupId: string, delta = 1) =>
    this.incCount('shared_facebook_groups', 'bumped_count', 'group_id', groupId, delta);
  incrementGroupPostedCount = (groupId: string, delta = 1) =>
    this.incCount('shared_facebook_groups', 'posted_count', 'group_id', groupId, delta);
  incrementPageBumpedCount = (pageId: string, delta = 1) =>
    this.incCount('group_bumper_pages', 'total_bumped_count', 'page_id', pageId, delta);
  applyResolvedTargetMetadata(
    kind: 'group' | 'groups' | 'page' | 'pages',
    rawId: string,
    metadata: ResolvedTargetMetadataInput,
  ): boolean {
    const cleanRawId = rawId.trim();
    if (!cleanRawId) return false;
    const isGroup = kind === 'group' || kind === 'groups',
      canonId =
        metadata.canonicalId && isCompleteNumericId(metadata.canonicalId)
          ? metadata.canonicalId.trim()
          : cleanRawId,
      inName = (metadata.name ?? '').trim(),
      inAvatar = sanitizeTargetAvatarUrl(metadata.avatarUrl),
      now = Date.now(),
      table = isGroup ? 'shared_facebook_groups' : 'group_bumper_pages',
      idCol = isGroup ? 'group_id' : 'page_id',
      nameCol = isGroup ? 'group_name' : 'page_name';
    return transaction(this.db, () => {
      const rawRow = Q.getRow(this.db, `SELECT * FROM ${table} WHERE ${idCol}=?`, cleanRawId);
      if (!rawRow) return false;
      const canonRow =
        canonId !== cleanRawId
          ? Q.getRow(this.db, `SELECT * FROM ${table} WHERE ${idCol}=?`, canonId)
          : undefined;
      const finalName = pickResolvedName(
        inName,
        canonRow ? Q.s(canonRow[nameCol]).trim() : '',
        Q.s(rawRow[nameCol]).trim(),
        canonId,
        cleanRawId,
      );
      const finalAvatar = mergedAvatar(
        mergedAvatar(Q.sn(canonRow?.avatar_url), Q.sn(rawRow.avatar_url)),
        inAvatar,
      );
      if (canonId !== cleanRawId) {
        cascadeCanonicalId(this.db, isGroup, cleanRawId, canonId, finalName);
        const calc = (tbl: string, where: string) =>
          Q.sqliteTableExists(this.db, tbl)
            ? Q.countSql(this.db, `SELECT COUNT(*) AS n FROM ${tbl} WHERE ${where}`, canonId)
            : 0;
        const bCol = isGroup ? 'bumped_count' : 'total_bumped_count',
          bumped =
            calc('group_bumper_effects', `${idCol}=?`) || Q.n(canonRow?.[bCol]) + Q.n(rawRow[bCol]),
          extraSet = isGroup ? ', invited_count=?, posted_count=?' : '',
          extraArgs = isGroup
            ? [
                calc('group_inviter_logs', "group_id=? AND confirmation='CONFIRMED'") ||
                  Q.n(canonRow?.invited_count) + Q.n(rawRow.invited_count),
                calc('group_poster_usage', 'group_id=?') ||
                  Q.n(canonRow?.posted_count) + Q.n(rawRow.posted_count),
              ]
            : [];
        if (canonRow) {
          const folderId = Q.sn(canonRow.folder_id) ?? Q.sn(rawRow.folder_id),
            sortOrder =
              typeof canonRow.folder_id !== 'string' && typeof rawRow.folder_id === 'string'
                ? Q.n(rawRow.sort_order)
                : Q.n(canonRow.sort_order),
            sql = `UPDATE ${table} SET ${nameCol}=?, avatar_url=?, folder_id=?, sort_order=?, ${bCol}=?, updated_at=?${extraSet} WHERE ${idCol}=?`;
          Q.run(
            this.db,
            sql,
            finalName,
            finalAvatar,
            folderId,
            sortOrder,
            bumped,
            now,
            ...extraArgs,
            canonId,
          );
          Q.run(this.db, `DELETE FROM ${table} WHERE ${idCol}=?`, cleanRawId);
        } else {
          const sql = `UPDATE ${table} SET ${idCol}=?, ${nameCol}=?, avatar_url=?, ${bCol}=?, updated_at=?${extraSet} WHERE ${idCol}=?`;
          Q.run(
            this.db,
            sql,
            canonId,
            finalName,
            finalAvatar,
            bumped,
            now,
            ...extraArgs,
            cleanRawId,
          );
        }
        return true;
      }
      Q.run(
        this.db,
        `UPDATE ${table} SET ${nameCol}=?, avatar_url=?, updated_at=? WHERE ${idCol}=?`,
        finalName,
        finalAvatar,
        now,
        cleanRawId,
      );
      if (Q.sqliteTableExists(this.db, 'post_bump_records'))
        Q.run(
          this.db,
          `UPDATE post_bump_records SET ${nameCol}=? WHERE ${idCol}=?`,
          finalName,
          cleanRawId,
        );
      return true;
    });
  }
}
