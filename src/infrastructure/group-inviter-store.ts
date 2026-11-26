import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { transaction } from './sqlite-transaction.js';
import {
  ensureTargetLibrarySchema,
  SqliteTargetLibraryRepository,
  type ResolvedTargetMetadataInput,
} from './target-library-store.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { ProfileTaskResult } from '../shared/task-contracts.js';
import {
  InviterGroupRow,
  GroupInviteLogRow,
  AddInviterGroupsRequest,
  DeleteInviterGroupsRequest,
  UpdateGroupInviterSettingsRequest,
} from '../shared/group-inviter.js';

export function ensureGroupInviterSchema(db: DatabaseSync): void {
  ensureTargetLibrarySchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_inviter_logs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, friend_id TEXT NOT NULL, friend_name TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL, invited_at INTEGER NOT NULL, confirmation TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(confirmation IN ('PENDING','CONFIRMED')), operation_id TEXT, UNIQUE(group_id, friend_id));
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_group ON group_inviter_logs(group_id); CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_profile ON group_inviter_logs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_account ON group_inviter_logs(account_id); CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_invited_at ON group_inviter_logs(invited_at DESC);
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_operation ON group_inviter_logs(operation_id); CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_conf_invited_at ON group_inviter_logs(confirmation, invited_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_conf_profile ON group_inviter_logs(confirmation, profile_id);
    CREATE TABLE IF NOT EXISTS group_inviter_settings(id INTEGER PRIMARY KEY CHECK(id=1), invites_per_group INTEGER NOT NULL DEFAULT 30 CHECK(invites_per_group BETWEEN 1 AND 200), max_concurrent_profiles INTEGER NOT NULL DEFAULT 4 CHECK(max_concurrent_profiles BETWEEN 1 AND 50), play_sound_on_complete INTEGER NOT NULL DEFAULT 1);
    INSERT OR IGNORE INTO group_inviter_settings(id, invites_per_group, max_concurrent_profiles, play_sound_on_complete) VALUES(1, 30, 4, 1);
  `);
}

export class SqliteGroupInviterRepository {
  private readonly targetLibrary: SqliteTargetLibraryRepository;
  constructor(private readonly db: DatabaseSync) {
    ensureGroupInviterSchema(db);
    this.targetLibrary = new SqliteTargetLibraryRepository(db);
  }
  saveProfileResult(input: unknown): void {
    const result = ProfileTaskResult.parse(input);
    if (result.source !== 'group-inviter') throw Error('GROUP_INVITER_RESULT_SOURCE_INVALID');
    Q.upsertProfileTaskResult(this.db, result);
  }
  listGroups(): InviterGroupRow[] {
    const sql = `SELECT g.group_id, g.group_name, g.avatar_url, g.created_at, g.updated_at, g.folder_id, g.sort_order, MAX(g.invited_count, COALESCE(c.cnt, 0)) AS total_invited_count FROM shared_facebook_groups g LEFT JOIN (SELECT group_id, COUNT(*) AS cnt FROM group_inviter_logs WHERE confirmation='CONFIRMED' GROUP BY group_id) c ON c.group_id = g.group_id ORDER BY g.sort_order ASC, g.created_at DESC, g.group_id ASC`;
    return Q.allRows(this.db, sql).map((r) => InviterGroupRow.parse(Q.camel(r)));
  }
  upsertGroups(input: unknown): InviterGroupRow[] {
    this.targetLibrary.upsertGroups(
      AddInviterGroupsRequest.parse(input).items.map((i) => ({
        id: i.groupId,
        name: i.groupName.trim() || i.groupId,
        folderId: i.folderId ?? null,
      })),
    );
    return this.listGroups();
  }
  applyResolvedGroupMetadata = (
    rawGroupId: string,
    metadata: ResolvedTargetMetadataInput,
  ): void => {
    this.targetLibrary.applyResolvedTargetMetadata('group', rawGroupId, metadata);
  };
  deleteGroups = (input: unknown): number =>
    transaction(this.db, () =>
      Q.deleteByJsonIds(this.db, 'shared_facebook_groups', 'group_id', [
        ...new Set(DeleteInviterGroupsRequest.parse(input).groupIds),
      ]),
    );
  getSettings() {
    const sql =
      'SELECT invites_per_group, max_concurrent_profiles, play_sound_on_complete FROM group_inviter_settings WHERE id=1';
    const row = Q.getRow(this.db, sql),
      inv = Number(row?.invites_per_group ?? 30),
      conc = Number(row?.max_concurrent_profiles ?? 4);
    return {
      invitesPerGroup: Number.isInteger(inv) && inv >= 1 && inv <= 200 ? inv : 30,
      maxConcurrentProfiles: Number.isInteger(conc) && conc >= 1 && conc <= 50 ? conc : 4,
      playSoundOnComplete: Number(row?.play_sound_on_complete ?? 1) === 1,
    };
  }
  saveSettings(input: unknown) {
    const p = UpdateGroupInviterSettingsRequest.parse(input),
      cur = this.getSettings(),
      sql =
        'UPDATE group_inviter_settings SET invites_per_group=?, max_concurrent_profiles=?, play_sound_on_complete=? WHERE id=1';
    Q.run(
      this.db,
      sql,
      p.invitesPerGroup ?? cur.invitesPerGroup,
      p.maxConcurrentProfiles ?? cur.maxConcurrentProfiles,
      (p.playSoundOnComplete ?? cur.playSoundOnComplete) ? 1 : 0,
    );
    return this.getSettings();
  }
  getInvitedFriendIdsForGroup = (groupId: string): Set<string> =>
    new Set(
      Q.allRows(this.db, 'SELECT friend_id FROM group_inviter_logs WHERE group_id=?', groupId).map(
        (r) => Q.s(r.friend_id),
      ),
    );
  hasInvitesForOperation(operationId: string, profileId?: string, accountId?: string): boolean {
    const sql =
      'SELECT 1 FROM group_inviter_logs WHERE operation_id=? AND (? IS NULL OR profile_id=?) AND (? IS NULL OR account_id=?) LIMIT 1';
    return Boolean(
      this.db
        .prepare(sql)
        .get(
          operationId,
          profileId ?? null,
          profileId ?? null,
          accountId ?? null,
          accountId ?? null,
        ),
    );
  }
  reserveInvites(
    operationId: string,
    entries: ReadonlyArray<{
      profileId: string;
      accountId: string;
      friendId: string;
      friendName: string;
      groupId: string;
    }>,
  ): void {
    if (!/^[a-f0-9-]{36}$/.test(operationId) || !entries.length || entries.length > 200)
      throw Error('GROUP_INVITER_RESERVATION_INVALID');
    const sql =
      "INSERT INTO group_inviter_logs(id,profile_id,account_id,friend_id,friend_name,group_id,invited_at,confirmation,operation_id) VALUES(?,?,?,?,?,?,?,'PENDING',?)";
    transaction(this.db, () => {
      const insert = this.db.prepare(sql);
      for (const e of entries) {
        if (!/^\d{5,25}$/.test(e.friendId) || !/^\d{5,25}$/.test(e.accountId))
          throw Error('GROUP_INVITER_RECIPIENT_ID_REQUIRED');
        insert.run(
          randomUUID(),
          e.profileId,
          e.accountId,
          e.friendId,
          e.friendName.slice(0, 200),
          e.groupId,
          Date.now(),
          operationId,
        );
      }
    });
  }
  recordInvites(
    entries: ReadonlyArray<{
      profileId: string;
      accountId: string;
      friendId: string;
      friendName: string;
      groupId: string;
      invitedAt?: number;
    }>,
    operationId?: string,
  ): number {
    if (!entries.length) return 0;
    const insSql =
      'INSERT OR IGNORE INTO group_inviter_logs(id, profile_id, account_id, friend_id, friend_name, group_id, invited_at) VALUES(?,?,?,?,?,?,?)';
    const confSql =
      "UPDATE group_inviter_logs SET confirmation='CONFIRMED',invited_at=? WHERE group_id=? AND friend_id=? AND profile_id=? AND account_id=? AND operation_id=? AND confirmation='PENDING'";
    return transaction(this.db, () => {
      const ins = this.db.prepare(insSql),
        conf = this.db.prepare(confSql),
        now = Date.now();
      let inserted = 0;
      for (const item of entries) {
        if (operationId) {
          if (
            Number(
              conf.run(
                item.invitedAt ?? now,
                item.groupId,
                item.friendId,
                item.profileId,
                item.accountId,
                operationId,
              ).changes,
            ) !== 1
          )
            throw Error('GROUP_INVITER_RESERVATION_MISMATCH');
          this.targetLibrary.incrementGroupInvitedCount(item.groupId, 1);
          inserted++;
          continue;
        }
        const ch = Number(
          ins.run(
            randomUUID(),
            item.profileId,
            item.accountId || item.profileId,
            item.friendId,
            item.friendName.slice(0, 200),
            item.groupId,
            item.invitedAt ?? now,
          ).changes ?? 0,
        );
        if (ch > 0) {
          this.targetLibrary.incrementGroupInvitedCount(item.groupId, ch);
          inserted += ch;
        }
      }
      return inserted;
    });
  }
  getTotalInvitedByProfile = (): Map<string, number> => {
    const sql =
      "SELECT profile_id, COUNT(*) AS cnt FROM group_inviter_logs WHERE confirmation='CONFIRMED' GROUP BY profile_id";
    return new Map(Q.allRows(this.db, sql).map((r) => [Q.s(r.profile_id), Q.n(r.cnt)]));
  };
  listLogs(filter?: {
    groupId?: string;
    profileId?: string;
    accountId?: string;
    search?: string;
    before?: number;
    beforeId?: string;
    limit?: number;
  }): GroupInviteLogRow[] {
    const clauses: string[] = ["confirmation='CONFIRMED'"],
      params: Array<string | number> = [];
    for (const [col, val] of [
      ['group_id=?', filter?.groupId],
      ['profile_id=?', filter?.profileId],
      ['account_id=?', filter?.accountId],
    ] as const) {
      if (val) {
        clauses.push(col);
        params.push(val);
      }
    }
    if (typeof filter?.before === 'number' && Number.isFinite(filter.before)) {
      if (filter.beforeId) {
        clauses.push('(invited_at<? OR (invited_at=? AND id>?))');
        params.push(filter.before, filter.before, filter.beforeId);
      } else {
        clauses.push('invited_at<?');
        params.push(filter.before);
      }
    }
    if (filter?.search?.trim()) {
      const like = Q.likePattern(filter.search);
      clauses.push(
        "(LOWER(friend_name) LIKE ? ESCAPE '\\' OR LOWER(friend_id) LIKE ? ESCAPE '\\' OR LOWER(group_id) LIKE ? ESCAPE '\\' OR LOWER(profile_id) LIKE ? ESCAPE '\\' OR LOWER(account_id) LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like, like);
    }
    const limitClause =
      typeof filter?.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
        ? ' LIMIT ?'
        : '';
    if (limitClause) params.push(Q.clampLimit(Math.floor(filter?.limit ?? 300), 1, 5000));
    const sql = `SELECT id, profile_id, account_id, friend_id, friend_name, group_id, invited_at FROM group_inviter_logs WHERE ${clauses.join(' AND ')} ORDER BY invited_at DESC, id ASC${limitClause}`;
    return Q.allRows(this.db, sql, ...params).map((r) => GroupInviteLogRow.parse(Q.camel(r)));
  }
}
