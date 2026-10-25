import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { transaction } from './sqlite-transaction.js';
import { ProfileTaskResult } from '../shared/task-contracts.js';
import {
  InviterGroupRow,
  GroupInviteLogRow,
  AddInviterGroupsRequest,
  DeleteInviterGroupsRequest,
  UpdateGroupInviterSettingsRequest,
} from '../shared/group-inviter.js';

// Append-only schema gate. The existing invitation log owns both pending and
// confirmed recipients; no second submission ledger is introduced.
export const groupInviterConfirmationMigration = `
CREATE TABLE IF NOT EXISTS group_inviter_logs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, friend_id TEXT NOT NULL, friend_name TEXT NOT NULL, group_id TEXT NOT NULL, invited_at INTEGER NOT NULL, UNIQUE(group_id, friend_id));
ALTER TABLE group_inviter_logs ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(confirmation IN ('PENDING','CONFIRMED'));
ALTER TABLE group_inviter_logs ADD COLUMN operation_id TEXT;
`;

export function ensureGroupInviterSchema(db: DatabaseSync): void {
  db.exec(
    [
      'CREATE TABLE IF NOT EXISTS group_inviter_groups(group_id TEXT PRIMARY KEY, group_name TEXT NOT NULL, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS group_inviter_logs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, friend_id TEXT NOT NULL, friend_name TEXT NOT NULL, group_id TEXT NOT NULL, invited_at INTEGER NOT NULL, UNIQUE(group_id, friend_id))',
      'CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_group ON group_inviter_logs(group_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_profile ON group_inviter_logs(profile_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_account ON group_inviter_logs(account_id)',
      'CREATE TABLE IF NOT EXISTS group_inviter_settings(id INTEGER PRIMARY KEY CHECK(id=1), invites_per_group INTEGER NOT NULL DEFAULT 30 CHECK(invites_per_group BETWEEN 1 AND 200))',
      'INSERT OR IGNORE INTO group_inviter_settings(id, invites_per_group) VALUES(1, 30)',
    ].join('; '),
  );
}

export class SqliteGroupInviterRepository {
  constructor(private readonly db: DatabaseSync) {
    ensureGroupInviterSchema(db);
  }

  saveProfileResult(input: unknown): void {
    const result = ProfileTaskResult.parse(input);
    if (result.source !== 'group-inviter') throw Error('GROUP_INVITER_RESULT_SOURCE_INVALID');
    this.db
      .prepare(
        `INSERT INTO profile_task_results VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id) DO UPDATE SET source=excluded.source,run_id=excluded.run_id,name=excluded.name,
      state=excluded.state,reason=excluded.reason,finished_at=excluded.finished_at,failed_steps=excluded.failed_steps,skipped_steps=excluded.skipped_steps`,
      )
      .run(
        result.profileId,
        result.source,
        result.runId,
        result.name,
        result.state,
        result.reason,
        result.finishedAt,
        result.failedSteps,
        result.skippedSteps,
      );
  }

  listGroups(): InviterGroupRow[] {
    const rows = this.db
      .prepare(
        `SELECT g.group_id, g.group_name, g.avatar_url, g.created_at, g.updated_at,
                COALESCE(c.cnt, 0) AS total_invited_count
           FROM group_inviter_groups g
           LEFT JOIN (
             SELECT group_id, COUNT(*) AS cnt
               FROM group_inviter_logs WHERE confirmation='CONFIRMED'
              GROUP BY group_id
           ) c ON c.group_id = g.group_id
          ORDER BY g.created_at DESC, g.group_id ASC`,
      )
      .all();

    return rows.map((row) =>
      InviterGroupRow.parse({
        groupId: String(row.group_id),
        groupName: String(row.group_name),
        avatarUrl: row.avatar_url === null ? null : String(row.avatar_url),
        totalInvitedCount: Number(row.total_invited_count ?? 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }),
    );
  }

  upsertGroups(input: unknown): InviterGroupRow[] {
    const parsed = AddInviterGroupsRequest.parse(input);
    const now = Date.now();
    return transaction(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT INTO group_inviter_groups(group_id, group_name, avatar_url, created_at, updated_at)
         VALUES(?, ?, NULL, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           group_name = excluded.group_name,
           updated_at = excluded.updated_at`,
      );
      for (const item of parsed.items) {
        stmt.run(item.groupId, item.groupName, now, now);
      }
      return this.listGroups();
    });
  }

  updateGroupAvatar(groupId: string, avatarUrl: string): void {
    const trimmed = avatarUrl.trim();
    if (!trimmed) return;
    this.db
      .prepare('UPDATE group_inviter_groups SET avatar_url=?, updated_at=? WHERE group_id=?')
      .run(trimmed, Date.now(), groupId);
  }

  deleteGroups(input: unknown): number {
    const parsed = DeleteInviterGroupsRequest.parse(input);
    return transaction(this.db, () => {
      const stmt = this.db.prepare('DELETE FROM group_inviter_groups WHERE group_id=?');
      let deleted = 0;
      for (const id of new Set(parsed.groupIds)) {
        const res = stmt.run(id);
        deleted += Number(res.changes ?? 0);
      }
      return deleted;
    });
  }

  getInvitesPerGroup(): number {
    const row = this.db
      .prepare('SELECT invites_per_group FROM group_inviter_settings WHERE id=1')
      .get();
    const val = Number(row?.invites_per_group ?? 30);
    return Number.isInteger(val) && val >= 1 && val <= 200 ? val : 30;
  }

  setInvitesPerGroup(input: unknown): number {
    const parsed = UpdateGroupInviterSettingsRequest.parse(input);
    this.db
      .prepare('UPDATE group_inviter_settings SET invites_per_group=? WHERE id=1')
      .run(parsed.invitesPerGroup);
    return this.getInvitesPerGroup();
  }

  getInvitedFriendIdsForGroup(groupId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT friend_id FROM group_inviter_logs WHERE group_id=?')
      .all(groupId);
    return new Set(rows.map((r) => String(r.friend_id)));
  }

  hasInvitesForOperation(operationId: string, profileId?: string, accountId?: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM group_inviter_logs WHERE operation_id=? AND (? IS NULL OR profile_id=?) AND (? IS NULL OR account_id=?) LIMIT 1',
        )
        .get(
          operationId,
          profileId ?? null,
          profileId ?? null,
          accountId ?? null,
          accountId ?? null,
        ) !== undefined
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
    transaction(this.db, () => {
      const insert = this.db.prepare(
        `INSERT INTO group_inviter_logs(id,profile_id,account_id,friend_id,friend_name,group_id,invited_at,confirmation,operation_id) VALUES(?,?,?,?,?,?,?,'PENDING',?)`,
      );
      for (const entry of entries) {
        if (!/^\d{5,25}$/.test(entry.friendId) || !/^\d{5,25}$/.test(entry.accountId))
          throw Error('GROUP_INVITER_RECIPIENT_ID_REQUIRED');
        insert.run(
          randomUUID(),
          entry.profileId,
          entry.accountId,
          entry.friendId,
          entry.friendName.slice(0, 200),
          entry.groupId,
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
    if (entries.length === 0) return 0;
    return transaction(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO group_inviter_logs(
           id, profile_id, account_id, friend_id, friend_name, group_id, invited_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      );
      let inserted = 0;
      const now = Date.now();
      for (const item of entries) {
        if (operationId) {
          const confirmed = this.db
            .prepare(
              `UPDATE group_inviter_logs SET confirmation='CONFIRMED',invited_at=? WHERE group_id=? AND friend_id=? AND profile_id=? AND account_id=? AND operation_id=? AND confirmation='PENDING'`,
            )
            .run(
              item.invitedAt ?? now,
              item.groupId,
              item.friendId,
              item.profileId,
              item.accountId,
              operationId,
            );
          if (Number(confirmed.changes) !== 1) throw Error('GROUP_INVITER_RESERVATION_MISMATCH');
          inserted++;
          continue;
        }
        const res = stmt.run(
          randomUUID(),
          item.profileId,
          item.accountId || item.profileId,
          item.friendId,
          item.friendName.slice(0, 200),
          item.groupId,
          item.invitedAt ?? now,
        );
        inserted += Number(res.changes ?? 0);
      }
      return inserted;
    });
  }

  getTotalInvitedByProfile(): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT profile_id, COUNT(*) AS cnt FROM group_inviter_logs WHERE confirmation='CONFIRMED' GROUP BY profile_id",
      )
      .all();
    return new Map(rows.map((r) => [String(r.profile_id), Number(r.cnt ?? 0)]));
  }

  listLogs(filter?: {
    groupId?: string;
    profileId?: string;
    accountId?: string;
  }): GroupInviteLogRow[] {
    const clauses: string[] = ["confirmation='CONFIRMED'"];
    const params: string[] = [];
    if (filter?.groupId) {
      clauses.push('group_id=?');
      params.push(filter.groupId);
    }
    if (filter?.profileId) {
      clauses.push('profile_id=?');
      params.push(filter.profileId);
    }
    if (filter?.accountId) {
      clauses.push('account_id=?');
      params.push(filter.accountId);
    }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db
      .prepare(
        `SELECT id, profile_id, account_id, friend_id, friend_name, group_id, invited_at
           FROM group_inviter_logs${where}
          ORDER BY invited_at DESC, id ASC`,
      )
      .all(...params);
    return rows.map((row) =>
      GroupInviteLogRow.parse({
        id: String(row.id),
        profileId: String(row.profile_id),
        accountId: String(row.account_id),
        friendId: String(row.friend_id),
        friendName: String(row.friend_name),
        groupId: String(row.group_id),
        invitedAt: Number(row.invited_at),
      }),
    );
  }
}
