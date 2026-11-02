import {
  BumperOperation,
  BumperResolution,
  type BumperOperationValue,
} from '../shared/bumper-operation.js';
import { sameBinding } from '../shared/task-execution.js';
import { ensureTargetColumns } from './target-list-store.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from './sqlite-transaction.js';
import { ProfileTaskResult } from '../shared/task-contracts.js';
import {
  BumperSettings,
  BumperTargetsInput,
  BumperIdsInput,
  BumperCommentsInput,
  isCompleteNumericId,
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperTarget,
  type BumperComment,
  type BumperLog,
  type BumperDailyStat,
} from '../shared/group-bumper.js';

function isHttpAvatarUrl(url: string | null | undefined): url is string {
  return (
    typeof url === 'string' &&
    /^https?:\/\//i.test(url.trim()) &&
    !/\/rsrc\.php\//i.test(url) &&
    !/\/emoji\.php\//i.test(url)
  );
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

// New migration only: the existing 1..42 migrations and task evidence stay unchanged.
export const groupBumperMigration = `
CREATE TABLE IF NOT EXISTS group_bumper_groups(group_id TEXT PRIMARY KEY,group_name TEXT NOT NULL,avatar_url TEXT,total_bumped_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_bumper_pages(page_id TEXT PRIMARY KEY,page_name TEXT NOT NULL,avatar_url TEXT,total_bumped_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_bumper_comments(id TEXT PRIMARY KEY,comment_text TEXT NOT NULL,used_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_bumper_logs(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,group_id TEXT NOT NULL,group_name TEXT NOT NULL,page_id TEXT NOT NULL,page_name TEXT NOT NULL,post_id TEXT NOT NULL,post_url TEXT NOT NULL,liked INTEGER NOT NULL DEFAULT 0,comment_text TEXT,bumped_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_post ON group_bumper_logs(post_id);
CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_account_time ON group_bumper_logs(account_id,bumped_at);
CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_profile_post ON group_bumper_logs(profile_id,post_id);
CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_bumped_at ON group_bumper_logs(bumped_at DESC);
CREATE TABLE IF NOT EXISTS group_bumper_settings(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
INSERT OR IGNORE INTO group_bumper_settings(id,body) VALUES(1,'{}');
`;

export const groupBumperOperationsMigration = `
CREATE TABLE IF NOT EXISTS group_bumper_operations(
 operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, profile_id TEXT NOT NULL,
 account_id TEXT NOT NULL, connection_epoch TEXT NOT NULL, lease_id TEXT NOT NULL,
 generation INTEGER NOT NULL, job_id TEXT NOT NULL, step_id TEXT NOT NULL, action_digest TEXT NOT NULL,
 action_kind TEXT NOT NULL CHECK(action_kind IN ('setup_navigate','setup_open_group','setup_welcome','setup_watch','setup_browse','setup_expand_comment','setup_fill_comment','setup_scroll','submit_like','submit_comment')),
 group_id TEXT NOT NULL, group_name TEXT NOT NULL, page_id TEXT, page_name TEXT, post_id TEXT,
 post_url TEXT, comment_id TEXT, comment_text TEXT, log_id TEXT,
 resolution_id TEXT, resolution_outcome TEXT CHECK(resolution_outcome IN ('VERIFIED','NOT_APPLIED','ENDED_UNKNOWN')), evidence_digest TEXT,
 status TEXT NOT NULL CHECK(status IN ('PREPARED','SETTLEMENT_PENDING','SETTLED','PENDING_REVIEW')),
 reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK((resolution_id IS NULL AND resolution_outcome IS NULL AND evidence_digest IS NULL) OR (resolution_id IS NOT NULL AND resolution_outcome IS NOT NULL AND evidence_digest IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_group_bumper_operations_profile_status ON group_bumper_operations(profile_id,status);
`;

function ensureProfileTaskResultTable(db: DatabaseSync) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='profile_task_results'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_task_results(
        profile_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('task','group-inviter','group-bumper')),
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')),
        reason TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        failed_steps INTEGER NOT NULL DEFAULT 0,
        skipped_steps INTEGER NOT NULL DEFAULT 0
      );
    `);
    return;
  }
  if (!row.sql.includes("'group-bumper'")) {
    transaction(db, () => {
      db.exec(`
        DROP TRIGGER IF EXISTS profile_task_result_terminal;
        CREATE TABLE profile_task_results_next(
          profile_id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK(source IN ('task','group-inviter','group-bumper')),
          run_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')),
          reason TEXT NOT NULL,
          finished_at INTEGER NOT NULL,
          failed_steps INTEGER NOT NULL DEFAULT 0,
          skipped_steps INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO profile_task_results_next SELECT * FROM profile_task_results;
        DROP TABLE profile_task_results;
        ALTER TABLE profile_task_results_next RENAME TO profile_task_results;
        CREATE TRIGGER profile_task_result_terminal AFTER INSERT ON task_events
          WHEN NEW.type IN ('COMPLETED','FAILED','STOPPED') BEGIN
          INSERT INTO profile_task_results
            SELECT profile_id,'task',id,json_extract(snapshot,'$.name'),state,reason,NEW.created_at,
              (SELECT count(*) FROM task_steps WHERE job_id=NEW.job_id AND json_extract(outcome,'$.kind')='FAILED'),
              (SELECT count(*) FROM task_steps WHERE job_id=NEW.job_id AND json_extract(outcome,'$.kind')='SKIPPED')
            FROM task_plans WHERE id=NEW.job_id AND state IN ('COMPLETED','FAILED','STOPPED')
          ON CONFLICT(profile_id) DO UPDATE SET source=excluded.source,run_id=excluded.run_id,
            name=excluded.name,state=excluded.state,reason=excluded.reason,finished_at=excluded.finished_at,failed_steps=excluded.failed_steps,skipped_steps=excluded.skipped_steps;
        END;
      `);
    });
  }
}

function ensureBumperSettingsDefault50(db: DatabaseSync) {
  const columns = db
    .prepare('PRAGMA table_info(group_bumper_settings)')
    .all()
    .map((r) => String(r.name));
  if (!columns.includes('default_max_likes_50_applied')) {
    db.exec(
      'ALTER TABLE group_bumper_settings ADD COLUMN default_max_likes_50_applied INTEGER NOT NULL DEFAULT 0;',
    );
  }
  if (!columns.includes('default_max_concurrent_8_applied')) {
    db.exec(
      'ALTER TABLE group_bumper_settings ADD COLUMN default_max_concurrent_8_applied INTEGER NOT NULL DEFAULT 0;',
    );
  }
  const row = db
    .prepare(
      'SELECT body, default_max_likes_50_applied, default_max_concurrent_8_applied FROM group_bumper_settings WHERE id=1',
    )
    .get();
  if (!row) return;
  if (Number(row.default_max_likes_50_applied ?? 0) === 0) {
    try {
      const parsed = BumperSettings.parse(JSON.parse(String(row.body ?? '{}')));
      const next = parsed.maxLikesPerPost === 10 ? { ...parsed, maxLikesPerPost: 50 } : parsed;
      db.prepare(
        'UPDATE group_bumper_settings SET body=?, default_max_likes_50_applied=1 WHERE id=1',
      ).run(JSON.stringify(next));
      row.body = JSON.stringify(next);
    } catch {
      db.prepare(
        'UPDATE group_bumper_settings SET default_max_likes_50_applied=1 WHERE id=1',
      ).run();
    }
  }
  if (Number(row.default_max_concurrent_8_applied ?? 0) === 0) {
    try {
      const parsed = BumperSettings.parse(JSON.parse(String(row.body ?? '{}')));
      const next =
        parsed.maxConcurrentProfiles === 4 ? { ...parsed, maxConcurrentProfiles: 8 } : parsed;
      db.prepare(
        'UPDATE group_bumper_settings SET body=?, default_max_concurrent_8_applied=1 WHERE id=1',
      ).run(JSON.stringify(next));
    } catch {
      db.prepare(
        'UPDATE group_bumper_settings SET default_max_concurrent_8_applied=1 WHERE id=1',
      ).run();
    }
  }
}

function formatLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function syncSharedGroupTables(db: DatabaseSync): void {
  const hasInviter = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_inviter_groups'")
      .get(),
  );
  const hasBumper = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_bumper_groups'")
      .get(),
  );
  if (!hasInviter || !hasBumper) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO group_bumper_groups(group_id,group_name,avatar_url,created_at,updated_at,sort_order)
     SELECT group_id,group_name,avatar_url,created_at,updated_at,
            (SELECT COALESCE(MAX(sort_order),-1) FROM group_bumper_groups)+ROW_NUMBER() OVER(ORDER BY sort_order,created_at DESC,group_id)
       FROM group_inviter_groups
      WHERE group_id NOT IN (SELECT group_id FROM group_bumper_groups)`,
  ).run();
  db.prepare(
    `INSERT INTO group_inviter_groups(group_id,group_name,avatar_url,created_at,updated_at,sort_order)
     SELECT group_id,group_name,avatar_url,created_at,updated_at,
            (SELECT COALESCE(MAX(sort_order),-1) FROM group_inviter_groups)+ROW_NUMBER() OVER(ORDER BY sort_order,created_at DESC,group_id)
       FROM group_bumper_groups
      WHERE group_id NOT IN (SELECT group_id FROM group_inviter_groups)`,
  ).run();
  const shared = db
    .prepare(
      `SELECT i.group_id,
              i.group_name AS inviter_name,
              i.avatar_url AS inviter_avatar,
              i.updated_at AS inviter_updated,
              b.group_name AS bumper_name,
              b.avatar_url AS bumper_avatar,
              b.updated_at AS bumper_updated
         FROM group_inviter_groups i
         JOIN group_bumper_groups b ON b.group_id = i.group_id`,
    )
    .all() as Array<{
    group_id: string;
    inviter_name: string;
    inviter_avatar: string | null;
    inviter_updated: number | null;
    bumper_name: string;
    bumper_avatar: string | null;
    bumper_updated: number | null;
  }>;
  const updateInviter = db.prepare(
    'UPDATE group_inviter_groups SET group_name=?, avatar_url=?, updated_at=? WHERE group_id=?',
  );
  const updateBumper = db.prepare(
    'UPDATE group_bumper_groups SET group_name=?, avatar_url=?, updated_at=? WHERE group_id=?',
  );
  for (const row of shared) {
    const id = String(row.group_id);
    const iName = String(row.inviter_name ?? '').trim();
    const bName = String(row.bumper_name ?? '').trim();
    const bumperNewer = Number(row.bumper_updated ?? 0) >= Number(row.inviter_updated ?? 0);
    const iPlaceholder = isPlaceholderTargetName(iName, id);
    const bPlaceholder = isPlaceholderTargetName(bName, id);
    // 名称统一：一侧占位取另一侧真实名；两侧都是真实名时按更新时间取较新一侧（支持任一模块改名）
    const unifiedName =
      iPlaceholder && !bPlaceholder
        ? bName
        : bPlaceholder && !iPlaceholder
          ? iName
          : (bumperNewer ? bName || iName : iName || bName) || id;
    const nextIName = unifiedName;
    const nextBName = unifiedName;
    // 两表头像统一为同一个值：本地 data:image 优先（防倒退），否则取最近更新一侧的外链，避免双向互换。
    const unifiedAvatar = bumperNewer
      ? mergedAvatar(row.inviter_avatar, row.bumper_avatar)
      : mergedAvatar(row.bumper_avatar, row.inviter_avatar);
    const nextIAvatar = unifiedAvatar;
    const nextBAvatar = unifiedAvatar;
    if (nextIName !== row.inviter_name || nextIAvatar !== row.inviter_avatar) {
      updateInviter.run(nextIName, nextIAvatar, now, id);
    }
    if (nextBName !== row.bumper_name || nextBAvatar !== row.bumper_avatar) {
      updateBumper.run(nextBName, nextBAvatar, now, id);
    }
  }
}

export class SqliteGroupBumperRepository {
  constructor(private readonly db: DatabaseSync) {
    ensureTargetColumns(db, 'group_bumper_groups');
    ensureTargetColumns(db, 'group_bumper_pages');
    ensureProfileTaskResultTable(db);
    ensureBumperSettingsDefault50(db);
    syncSharedGroupTables(db);
  }
  getOperation(operationId: string): BumperOperationValue | null {
    const r = this.db
      .prepare('SELECT * FROM group_bumper_operations WHERE operation_id=?')
      .get(z.uuid().parse(operationId));
    if (!r) return null;
    return BumperOperation.parse({
      binding: {
        operationId: r.operation_id,
        profileId: r.profile_id,
        accountId: r.account_id,
        connectionEpoch: r.connection_epoch,
        leaseId: r.lease_id,
        generation: r.generation,
        jobId: r.job_id,
        stepId: r.step_id,
        actionDigest: r.action_digest,
      },
      runId: r.run_id,
      actionKind: r.action_kind,
      groupId: r.group_id,
      groupName: r.group_name,
      pageId: r.page_id,
      pageName: r.page_name,
      postId: r.post_id,
      postUrl: r.post_url,
      commentId: r.comment_id,
      commentText: r.comment_text,
      logId: r.log_id,
      resolution:
        r.resolution_id === null
          ? null
          : {
              id: r.resolution_id,
              outcome: r.resolution_outcome,
              evidenceDigest: r.evidence_digest,
            },
      status: r.status,
      reason: r.reason,
    });
  }
  listOperationsByProfile(profileId: string) {
    return this.db
      .prepare('SELECT operation_id FROM group_bumper_operations WHERE profile_id=? AND status<>?')
      .all(z.uuid().parse(profileId), 'SETTLED')
      .flatMap((r) => {
        const row = this.getOperation(String(r.operation_id));
        return row ? [row] : [];
      });
  }
  prepareOperation(input: unknown) {
    const row = BumperOperation.parse(input),
      b = row.binding;
    if (row.status !== 'PREPARED' || row.resolution) throw Error('BUMPER_PREPARE_STATE_INVALID');
    return transaction(this.db, () => {
      const old = this.getOperation(b.operationId);
      if (old) {
        if (
          !sameBinding(old.binding, b) ||
          old.actionKind !== row.actionKind ||
          old.runId !== row.runId ||
          old.postId !== row.postId
        )
          throw Error('BUMPER_OPERATION_CONTEXT_CHANGED');
        return old;
      }
      const now = Date.now();
      this.db
        .prepare(
          'INSERT INTO group_bumper_operations VALUES(' + Array(27).fill('?').join(',') + ')',
        )
        .run(
          b.operationId,
          row.runId,
          b.profileId,
          b.accountId,
          b.connectionEpoch,
          b.leaseId,
          b.generation,
          b.jobId,
          b.stepId,
          b.actionDigest,
          row.actionKind,
          row.groupId,
          row.groupName,
          row.pageId,
          row.pageName,
          row.postId,
          row.postUrl,
          row.commentId,
          row.commentText,
          row.logId,
          null,
          null,
          null,
          'PREPARED',
          '',
          now,
          now,
        );
      return row;
    });
  }
  setOperationResolution(operationId: string, input: unknown) {
    const resolution = BumperResolution.parse(input);
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (!row) throw Error('BUMPER_OPERATION_MISSING');
      if (row.resolution) {
        if (row.resolution.outcome !== resolution.outcome)
          throw Error('BUMPER_RESOLUTION_CONFLICT');
        return row.resolution;
      }
      if (resolution.outcome === 'ENDED_UNKNOWN' && !row.actionKind.startsWith('setup_'))
        throw Error('BUMPER_BUSINESS_DISPOSITION_REJECTED');
      this.db
        .prepare(
          "UPDATE group_bumper_operations SET resolution_id=?,resolution_outcome=?,evidence_digest=?,status='SETTLEMENT_PENDING',updated_at=? WHERE operation_id=?",
        )
        .run(resolution.id, resolution.outcome, resolution.evidenceDigest, Date.now(), operationId);
      return resolution;
    });
  }
  markOperationSettled(operationId: string) {
    const row = this.getOperation(operationId);
    if (!row?.resolution) throw Error('BUMPER_RESOLUTION_MISSING');
    if (row.status !== 'SETTLED')
      this.db
        .prepare(
          "UPDATE group_bumper_operations SET status='SETTLED',updated_at=? WHERE operation_id=?",
        )
        .run(Date.now(), operationId);
  }
  markOperationReview(operationId: string, reason: string) {
    const row = this.getOperation(operationId);
    if (!row) throw Error('BUMPER_OPERATION_MISSING');
    if (row.resolution) return;
    this.db
      .prepare(
        "UPDATE group_bumper_operations SET status='PENDING_REVIEW',reason=?,updated_at=? WHERE operation_id=?",
      )
      .run(reason, Date.now(), operationId);
  }
  confirmSubmission(
    operationId: string,
    record: BumperLog,
    commentId: string | undefined,
    input: unknown,
  ) {
    const resolution = BumperResolution.parse(input);
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (
        !row ||
        !['submit_like', 'submit_comment'].includes(row.actionKind) ||
        row.binding.profileId !== record.profileId ||
        row.binding.accountId !== record.accountId ||
        row.postId !== record.postId ||
        row.logId !== record.id ||
        row.groupId !== record.groupId ||
        row.pageId !== record.pageId ||
        row.commentId !== (commentId ?? null) ||
        resolution.outcome !== 'VERIFIED'
      )
        throw Error('BUMPER_RESULT_CONTEXT_CHANGED');
      if (row.resolution) {
        if (row.resolution.outcome !== 'VERIFIED') throw Error('BUMPER_RESOLUTION_CONFLICT');
        return row.resolution;
      }
      if (
        (row.actionKind === 'submit_like' && !record.liked) ||
        (row.actionKind === 'submit_comment' &&
          (!record.commentText || record.commentText !== row.commentText))
      )
        throw Error('BUMPER_RESULT_EVIDENCE_MISSING');
      this.record(record, row.actionKind === 'submit_comment' ? commentId : undefined);
      return this.setOperationResolution(operationId, resolution);
    });
  }
  saveProfileResult(input: unknown) {
    const result = ProfileTaskResult.parse(input);
    this.db
      .prepare(
        `INSERT INTO profile_task_results VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(profile_id) DO UPDATE SET
           source=excluded.source,
           run_id=excluded.run_id,
           name=excluded.name,
           state=excluded.state,
           reason=excluded.reason,
           finished_at=excluded.finished_at,
           failed_steps=excluded.failed_steps,
           skipped_steps=excluded.skipped_steps`,
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
  settings(): BumperSettings {
    return BumperSettings.parse(
      JSON.parse(
        String(
          this.db.prepare('SELECT body FROM group_bumper_settings WHERE id=1').get()?.body ?? '{}',
        ),
      ),
    );
  }
  saveSettings(input: unknown) {
    const settings = BumperSettings.parse(input);
    this.db
      .prepare('UPDATE group_bumper_settings SET body=? WHERE id=1')
      .run(JSON.stringify(settings));
    return settings;
  }
  targets(kind: 'groups' | 'pages'): BumperTarget[] {
    const prefix = kind === 'groups' ? 'group' : 'page';
    return this.db
      .prepare(
        `SELECT * FROM group_bumper_${kind} ORDER BY sort_order,created_at DESC,${prefix}_id`,
      )
      .all()
      .map((r) => ({
        folderId: r.folder_id == null ? null : String(r.folder_id),
        sortOrder: Number(r.sort_order),
        id: String(r[`${prefix}_id`]),
        name: String(r[`${prefix}_name`]),
        avatarUrl: r.avatar_url == null ? null : String(r.avatar_url),
        totalBumpedCount: Number(r.total_bumped_count),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));
  }
  upsertTargets(kind: 'groups' | 'pages', input: unknown) {
    const { items } = BumperTargetsInput.parse(input),
      prefix = kind === 'groups' ? 'group' : 'page',
      now = Date.now();
    return transaction(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT INTO group_bumper_${kind}(${prefix}_id,${prefix}_name,created_at,updated_at,folder_id,sort_order) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM group_bumper_${kind})) ON CONFLICT(${prefix}_id) DO UPDATE SET ${prefix}_name=CASE WHEN excluded.${prefix}_name=excluded.${prefix}_id AND group_bumper_${kind}.${prefix}_name<>'' THEN group_bumper_${kind}.${prefix}_name ELSE excluded.${prefix}_name END,updated_at=excluded.updated_at`,
      );
      for (const item of items) {
        const effectiveName = item.name.trim() || item.id;
        stmt.run(item.id, effectiveName, now, now, item.folderId ?? null);
      }
      if (kind === 'groups') syncSharedGroupTables(this.db);
      return this.targets(kind);
    });
  }
  applyResolvedTargetMetadata(
    kind: 'groups' | 'pages',
    originalId: string,
    resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): boolean {
    const prefix = kind === 'groups' ? 'group' : 'page',
      table = 'group_bumper_' + kind;
    return transaction(this.db, () => {
      const current = this.db
        .prepare('SELECT * FROM ' + table + ' WHERE ' + prefix + '_id=?')
        .get(originalId);
      if (!current) return false;
      const id =
        resolved.canonicalId && isCompleteNumericId(resolved.canonicalId)
          ? resolved.canonicalId.trim()
          : originalId;
      const existing =
        id !== originalId
          ? this.db.prepare('SELECT * FROM ' + table + ' WHERE ' + prefix + '_id=?').get(id)
          : undefined;
      const resolvedName = resolved.name?.trim() ?? '';
      const existingName = existing ? String(existing[prefix + '_name'] ?? '').trim() : '';
      const currentName = String(current[prefix + '_name'] ?? '').trim();
      const name =
        resolvedName &&
        !isPlaceholderTargetName(resolvedName, id) &&
        !isPlaceholderTargetName(resolvedName, originalId)
          ? resolvedName
          : existingName && !isPlaceholderTargetName(existingName, id)
            ? existingName
            : currentName && !isPlaceholderTargetName(currentName, originalId)
              ? currentName
              : resolvedName || existingName || currentName || id;
      const currentAvatar = current.avatar_url == null ? null : String(current.avatar_url);
      const duplicateAvatar = existing?.avatar_url == null ? null : String(existing.avatar_url);
      const baseAvatar = mergedAvatar(duplicateAvatar, currentAvatar);
      const avatar = mergedAvatar(baseAvatar, resolved.avatarUrl);
      if (existing) {
        this.db
          .prepare(
            'UPDATE ' +
              table +
              ' SET ' +
              prefix +
              '_name=?,avatar_url=?,total_bumped_count=total_bumped_count+?,updated_at=? WHERE ' +
              prefix +
              '_id=?',
          )
          .run(name, avatar, Number(current.total_bumped_count ?? 0), Date.now(), id);
        this.db.prepare('DELETE FROM ' + table + ' WHERE ' + prefix + '_id=?').run(originalId);
      } else {
        this.db
          .prepare(
            'UPDATE ' +
              table +
              ' SET ' +
              prefix +
              '_id=?,' +
              prefix +
              '_name=?,avatar_url=?,updated_at=? WHERE ' +
              prefix +
              '_id=?',
          )
          .run(id, name, avatar, Date.now(), originalId);
      }
      this.db
        .prepare(
          'UPDATE group_bumper_logs SET ' +
            prefix +
            '_id=?,' +
            prefix +
            '_name=? WHERE ' +
            prefix +
            '_id=?',
        )
        .run(id, name, originalId);
      if (kind === 'groups') {
        const hasInviter = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_inviter_groups'",
            )
            .get(),
        );
        if (hasInviter) {
          if (id !== originalId) {
            const dupInviter = this.db
              .prepare('SELECT * FROM group_inviter_groups WHERE group_id=?')
              .get(id);
            if (dupInviter) {
              this.db.prepare('DELETE FROM group_inviter_groups WHERE group_id=?').run(originalId);
            } else {
              this.db
                .prepare('UPDATE group_inviter_groups SET group_id=? WHERE group_id=?')
                .run(id, originalId);
            }
          }
          // 同步把本次解析出的名称与头像写给邀请人侧，避免随后按更新时间统一时被旧值反向覆盖
          const inviterRow = this.db
            .prepare('SELECT avatar_url FROM group_inviter_groups WHERE group_id=?')
            .get(id) as { avatar_url?: string | null } | undefined;
          if (inviterRow) {
            const inviterAvatar = mergedAvatar(
              inviterRow.avatar_url == null ? null : String(inviterRow.avatar_url),
              avatar,
            );
            const resolvedAt = Date.now();
            if (!isPlaceholderTargetName(name, id))
              this.db
                .prepare(
                  'UPDATE group_inviter_groups SET group_name=?, avatar_url=?, updated_at=? WHERE group_id=?',
                )
                .run(name, inviterAvatar, resolvedAt, id);
            else
              this.db
                .prepare(
                  'UPDATE group_inviter_groups SET avatar_url=?, updated_at=? WHERE group_id=?',
                )
                .run(inviterAvatar, resolvedAt, id);
            this.db
              .prepare('UPDATE group_bumper_groups SET updated_at=? WHERE group_id=?')
              .run(resolvedAt, id);
          }
          syncSharedGroupTables(this.db);
        }
      }
      return true;
    });
  }

  deleteTargets(kind: 'groups' | 'pages', input: unknown) {
    const { ids } = BumperIdsInput.parse(input),
      prefix = kind === 'groups' ? 'group' : 'page';
    return transaction(this.db, () => {
      const deleted = Number(
        this.db
          .prepare(
            `DELETE FROM group_bumper_${kind} WHERE ${prefix}_id IN (SELECT value FROM json_each(?))`,
          )
          .run(JSON.stringify(ids)).changes,
      );
      if (kind === 'groups') {
        const hasInviter = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_inviter_groups'",
            )
            .get(),
        );
        if (hasInviter) {
          this.db
            .prepare(
              'DELETE FROM group_inviter_groups WHERE group_id IN (SELECT value FROM json_each(?))',
            )
            .run(JSON.stringify(ids));
        }
      }
      return deleted;
    });
  }
  updateAvatar(kind: 'groups' | 'pages', id: string, avatarUrl: string) {
    const trimmed = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (!isLocalAvatar(trimmed) && !isHttpAvatarUrl(trimmed)) return;
    const prefix = kind === 'groups' ? 'group' : 'page';
    const table = `group_bumper_${kind}`;
    const existing = this.db
      .prepare(`SELECT avatar_url FROM ${table} WHERE ${prefix}_id=?`)
      .get(id) as { avatar_url?: string | null } | undefined;
    if (!existing) return;
    const currentAvatar = existing.avatar_url == null ? null : String(existing.avatar_url);
    if (isLocalAvatar(currentAvatar) && !isLocalAvatar(trimmed)) return;
    this.db
      .prepare(`UPDATE ${table} SET avatar_url=?,updated_at=? WHERE ${prefix}_id=?`)
      .run(trimmed, Date.now(), id);
    if (kind === 'groups') syncSharedGroupTables(this.db);
  }
  importGroupsFromInviter() {
    const now = Date.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO group_bumper_groups(group_id,group_name,avatar_url,created_at,updated_at,sort_order) SELECT group_id,group_name,avatar_url,?,?,(SELECT COALESCE(MAX(sort_order),-1) FROM group_bumper_groups)+ROW_NUMBER() OVER(ORDER BY sort_order,created_at DESC,group_id) FROM group_inviter_groups WHERE 1 ON CONFLICT(group_id) DO UPDATE SET group_name=excluded.group_name,avatar_url=CASE WHEN group_bumper_groups.avatar_url LIKE 'data:image/%' AND (excluded.avatar_url IS NULL OR excluded.avatar_url NOT LIKE 'data:image/%') THEN group_bumper_groups.avatar_url ELSE COALESCE(excluded.avatar_url,group_bumper_groups.avatar_url) END,updated_at=excluded.updated_at`,
        )
        .run(now, now).changes,
    );
  }
  comments(): BumperComment[] {
    return this.db
      .prepare('SELECT * FROM group_bumper_comments ORDER BY created_at,id')
      .all()
      .map((r) => ({
        id: String(r.id),
        text: String(r.comment_text),
        usedCount: Number(r.used_count),
        createdAt: Number(r.created_at),
      }));
  }
  saveComments(input: unknown) {
    const { texts, consumeCommentOnUse } = BumperCommentsInput.parse(input);
    return transaction(this.db, () => {
      const existing = new Map(this.comments().map((r) => [r.text, r]));
      this.db.prepare('DELETE FROM group_bumper_comments').run();
      const add = this.db.prepare('INSERT INTO group_bumper_comments VALUES(?,?,?,?)');
      for (const text of new Set(texts)) {
        const previous = existing.get(text);
        add.run(
          previous?.id ?? randomUUID(),
          text,
          previous?.usedCount ?? 0,
          previous?.createdAt ?? Date.now(),
        );
      }
      this.saveSettings({ ...this.settings(), consumeCommentOnUse });
      return this.comments();
    });
  }
  pickComment(
    postId: string,
    random = Math.random(),
    excludeIds: ReadonlyArray<string> = [],
  ): BumperComment | null {
    const excluded = new Set(excludeIds);
    const used = new Set(
      this.db
        .prepare(
          'SELECT comment_text FROM group_bumper_logs WHERE post_id=? AND comment_text IS NOT NULL',
        )
        .all(postId)
        .map((r) => String(r.comment_text)),
    );
    const all = this.comments().filter((r) => !excluded.has(r.id)),
      unused = all.filter((r) => !used.has(r.text));
    const pool = unused.length ? unused : this.settings().consumeCommentOnUse ? [] : all;
    return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random * pool.length)))] ?? null;
  }
  eligibility(accountId: string, profileId: string, postId: string, now = Date.now()) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    const today = Number(
      this.db
        .prepare(
          'SELECT COUNT(*) n FROM group_bumper_logs WHERE (account_id=? OR profile_id=?) AND bumped_at>=?',
        )
        .get(accountId, profileId, date.getTime())?.n ?? 0,
    );
    const postCount = Number(
      this.db
        .prepare(
          'SELECT COUNT(*) n FROM group_bumper_logs WHERE post_id=? AND (liked=1 OR comment_text IS NOT NULL)',
        )
        .get(postId)?.n ?? 0,
    );
    const duplicate = Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM group_bumper_logs WHERE post_id=? AND (account_id=? OR profile_id=?) LIMIT 1',
        )
        .get(postId, accountId, profileId),
    );
    const settings = this.settings();
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
  record(input: BumperLog, commentId?: string) {
    // This method receives confirmed effects only. Unknown submissions remain in
    // the existing native operation journal, and are never turned into success.
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
      })
      .strict()
      .parse(input);
    if (!row.liked && !row.commentText) return false;
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM group_bumper_logs WHERE id=?').get(row.id);
      if (
        !previous &&
        this.eligibility(row.accountId, row.profileId, row.postId, row.bumpedAt).duplicate
      )
        return false;
      if (
        previous &&
        (previous.account_id !== row.accountId ||
          previous.post_id !== row.postId ||
          previous.profile_id !== row.profileId)
      )
        throw Error('BUMPER_RESULT_CONTEXT_CHANGED');
      const commentNew = !!row.commentText && !previous?.comment_text;
      this.db
        .prepare(
          `INSERT INTO group_bumper_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET liked=MAX(liked,excluded.liked),comment_text=COALESCE(comment_text,excluded.comment_text)`,
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
        );
      if (!previous)
        for (const [kind, prefix, id] of [
          ['groups', 'group', row.groupId],
          ['pages', 'page', row.pageId],
        ])
          this.db
            .prepare(
              `UPDATE group_bumper_${kind} SET total_bumped_count=total_bumped_count+1 WHERE ${prefix}_id=?`,
            )
            .run(id ?? '');
      if (commentNew && commentId) {
        if (this.settings().consumeCommentOnUse)
          this.db
            .prepare('DELETE FROM group_bumper_comments WHERE id=? AND comment_text=?')
            .run(commentId, row.commentText);
        else
          this.db
            .prepare(
              'UPDATE group_bumper_comments SET used_count=used_count+1 WHERE id=? AND comment_text=?',
            )
            .run(commentId, row.commentText);
      }
      return !previous;
    });
  }
  logs(search = '', limit = 200, before?: number, beforeId = '\uffff'): BumperLog[] {
    return this.db
      .prepare(
        `SELECT * FROM group_bumper_logs WHERE (bumped_at<? OR (bumped_at=? AND id<?)) AND (?='' OR instr(lower(group_name||' '||page_name||' '||page_id||' '||account_id||' '||COALESCE(comment_text,'')),lower(?))>0) ORDER BY bumped_at DESC,id DESC LIMIT ?`,
      )
      .all(
        before ?? Date.now(),
        before ?? Date.now(),
        beforeId,
        search,
        search,
        Math.max(1, Math.min(1000, limit)),
      )
      .map((r) => ({
        id: String(r.id),
        profileId: String(r.profile_id),
        accountId: String(r.account_id),
        groupId: String(r.group_id),
        groupName: String(r.group_name),
        pageId: String(r.page_id),
        pageName: String(r.page_name),
        postId: String(r.post_id),
        postUrl: String(r.post_url),
        liked: r.liked === 1,
        commentText: r.comment_text == null ? null : String(r.comment_text),
        bumpedAt: Number(r.bumped_at),
      }));
  }
  total() {
    return Number(this.db.prepare('SELECT COUNT(*) n FROM group_bumper_logs').get()?.n ?? 0);
  }
  todayCounts(): Record<string, number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Object.fromEntries(
      this.db
        .prepare(
          'SELECT profile_id,COUNT(*) n FROM group_bumper_logs WHERE bumped_at>=? GROUP BY profile_id',
        )
        .all(today.getTime())
        .map((r) => [String(r.profile_id), Number(r.n)]),
    );
  }
  weeklyDailyCounts(now = Date.now()): BumperDailyStat[] {
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
      .prepare('SELECT bumped_at FROM group_bumper_logs WHERE bumped_at >= ? AND bumped_at < ?')
      .all(startMs, endMs);
    for (const r of rows) {
      const ymd = formatLocalYmd(new Date(Number(r.bumped_at)));
      if (buckets.has(ymd)) {
        buckets.set(ymd, (buckets.get(ymd) ?? 0) + 1);
      }
    }

    return days.map((date) => ({ date, count: buckets.get(date) ?? 0 }));
  }
  deleteLogs(input: unknown) {
    const { ids, all } = z
      .object({ ids: z.array(z.uuid()).max(1000).default([]), all: z.boolean().default(false) })
      .strict()
      .parse(input);
    return Number(
      this.db
        .prepare(
          'DELETE FROM group_bumper_logs WHERE ?=1 OR id IN (SELECT value FROM json_each(?))',
        )
        .run(all ? 1 : 0, JSON.stringify(ids)).changes,
    );
  }
}
