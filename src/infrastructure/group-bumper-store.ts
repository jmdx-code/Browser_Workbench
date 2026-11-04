import {
  BumperOperation,
  BumperResolution,
  type BumperOperationValue,
} from '../shared/bumper-operation.js';
import { sameBinding } from '../shared/task-execution.js';
import {
  ensureTargetLibrarySchema,
  mergedAvatar,
  SqliteTargetLibraryRepository,
} from './target-library-store.js';
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
  type BumperTarget,
  type BumperComment,
  type BumperLog,
  type BumperDailyStat,
  type BumperPendingOperation,
  type BumperScope,
} from '../shared/group-bumper.js';

export { mergedAvatar };

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

function applyBumperSettingsFlagUpgradeIfPending(db: DatabaseSync) {
  const row = db
    .prepare(
      'SELECT body, default_max_likes_50_applied, default_max_concurrent_8_applied FROM group_bumper_settings WHERE id=1',
    )
    .get();
  if (!row) return;
  if (Number(row.default_max_likes_50_applied ?? 1) === 0) {
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
  if (Number(row.default_max_concurrent_8_applied ?? 1) === 0) {
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

export function migrateBumperSettingsDefault50(db: DatabaseSync) {
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
  applyBumperSettingsFlagUpgradeIfPending(db);
}

function formatLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function ensureGroupBumperDecouplingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_bumper_settings(
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const hasPageRow = db.prepare('SELECT 1 FROM page_bumper_settings WHERE id = 1').get();
  if (!hasPageRow) {
    const groupRow = db.prepare('SELECT body FROM group_bumper_settings WHERE id = 1').get() as
      { body?: string } | undefined;
    const initialBody = typeof groupRow?.body === 'string' ? groupRow.body : '{}';
    db.prepare(
      'INSERT OR IGNORE INTO page_bumper_settings(id, value, updated_at) VALUES(1, ?, ?)',
    ).run(initialBody, Date.now());
  }

  const commentCols = db.prepare('PRAGMA table_info(group_bumper_comments)').all();
  if (!commentCols.some((c) => c.name === 'scope')) {
    db.exec(
      "ALTER TABLE group_bumper_comments ADD COLUMN scope TEXT NOT NULL DEFAULT 'group' CHECK(scope IN ('group', 'page'))",
    );
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_group_bumper_comments_scope ON group_bumper_comments(scope, created_at, id)',
  );

  const logCols = db.prepare('PRAGMA table_info(group_bumper_logs)').all();
  if (!logCols.some((c) => c.name === 'source_mode')) {
    db.exec(
      "ALTER TABLE group_bumper_logs ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'group' CHECK(source_mode IN ('group', 'page'))",
    );
  }
  db.exec(
    "UPDATE group_bumper_logs SET source_mode = 'page' WHERE group_id = '-' AND source_mode != 'page'",
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_source_mode_bumped ON group_bumper_logs(source_mode, bumped_at DESC)',
  );
}

export class SqliteGroupBumperRepository {
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
      CREATE TABLE IF NOT EXISTS group_bumper_settings(
        id INTEGER PRIMARY KEY CHECK(id=1),
        body TEXT NOT NULL,
        default_max_likes_50_applied INTEGER NOT NULL DEFAULT 1,
        default_max_concurrent_8_applied INTEGER NOT NULL DEFAULT 1
      );
      INSERT OR IGNORE INTO group_bumper_settings(id,body) VALUES(1,'{}');
      CREATE TABLE IF NOT EXISTS page_bumper_settings(
        id INTEGER PRIMARY KEY CHECK(id=1),
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO page_bumper_settings(id,value,updated_at) VALUES(1,'{}',0);
      CREATE TABLE IF NOT EXISTS profile_task_results(
        profile_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('task','group-inviter','group-bumper','page-bumper','group-poster')),
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')),
        reason TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        failed_steps INTEGER NOT NULL DEFAULT 0,
        skipped_steps INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec(groupBumperOperationsMigration);
    try {
      applyBumperSettingsFlagUpgradeIfPending(db);
    } catch {
      // Ignore during intermediate pre-v50 migration steps before flag columns exist
    }
    this.targetLibrary = new SqliteTargetLibraryRepository(db);
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
  pageSettings(): BumperSettings {
    const row = this.db.prepare('SELECT value FROM page_bumper_settings WHERE id=1').get() as
      { value?: string } | undefined;
    try {
      return BumperSettings.parse(JSON.parse(String(row?.value ?? '{}')));
    } catch {
      return BumperSettings.parse({});
    }
  }
  savePageSettings(input: unknown): BumperSettings {
    const settings = BumperSettings.parse(input);
    this.db
      .prepare('UPDATE page_bumper_settings SET value=?, updated_at=? WHERE id=1')
      .run(JSON.stringify(settings), Date.now());
    return settings;
  }
  targets(kind: 'groups' | 'pages'): BumperTarget[] {
    return kind === 'groups'
      ? this.targetLibrary.listBumperGroups()
      : this.targetLibrary.listPages();
  }
  upsertTargets(kind: 'groups' | 'pages', input: unknown): BumperTarget[] {
    const { items } = BumperTargetsInput.parse(input);
    const mapped = items.map((item) => ({
      id: item.id,
      name: item.name.trim() || item.id,
      folderId: item.folderId ?? null,
    }));
    if (kind === 'groups') {
      this.targetLibrary.upsertGroups(mapped);
      return this.targetLibrary.listBumperGroups();
    }
    return this.targetLibrary.upsertPages(mapped);
  }
  applyResolvedTargetMetadata(
    kind: 'groups' | 'pages',
    originalId: string,
    resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): boolean {
    return this.targetLibrary.applyResolvedTargetMetadata(kind, originalId, resolved);
  }

  deleteTargets(kind: 'groups' | 'pages', input: unknown): number {
    const { ids } = BumperIdsInput.parse(input);
    return transaction(this.db, () => {
      if (kind === 'groups') {
        return Number(
          this.db
            .prepare(
              'DELETE FROM shared_facebook_groups WHERE group_id IN (SELECT value FROM json_each(?))',
            )
            .run(JSON.stringify(ids)).changes,
        );
      }
      return Number(
        this.db
          .prepare(
            'DELETE FROM group_bumper_pages WHERE page_id IN (SELECT value FROM json_each(?))',
          )
          .run(JSON.stringify(ids)).changes,
      );
    });
  }
  updateAvatar(kind: 'groups' | 'pages', id: string, avatarUrl: string) {
    const trimmed = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (!trimmed) return;
    this.targetLibrary.applyResolvedTargetMetadata(kind, id, {
      avatarUrl: trimmed,
    });
  }
  comments(scope: BumperScope = 'group'): BumperComment[] {
    return this.db
      .prepare('SELECT * FROM group_bumper_comments WHERE scope=? ORDER BY created_at,id')
      .all(scope)
      .map((r) => ({
        id: String(r.id),
        text: String(r.comment_text),
        usedCount: Number(r.used_count),
        createdAt: Number(r.created_at),
        scope: r.scope === 'page' ? 'page' : 'group',
      }));
  }
  saveComments(input: unknown, scopeOverride?: BumperScope) {
    const parsed = BumperCommentsInput.parse(input);
    const scope: BumperScope = scopeOverride ?? parsed.scope ?? 'group';
    const { texts, consumeCommentOnUse } = parsed;
    return transaction(this.db, () => {
      const existing = new Map(this.comments(scope).map((r) => [r.text, r]));
      this.db.prepare('DELETE FROM group_bumper_comments WHERE scope=?').run(scope);
      const add = this.db.prepare(
        'INSERT INTO group_bumper_comments(id,comment_text,used_count,created_at,scope) VALUES(?,?,?,?,?)',
      );
      for (const text of new Set(texts)) {
        const previous = existing.get(text);
        add.run(
          previous?.id ?? randomUUID(),
          text,
          previous?.usedCount ?? 0,
          previous?.createdAt ?? Date.now(),
          scope,
        );
      }
      if (scope === 'page') {
        this.savePageSettings({ ...this.pageSettings(), consumeCommentOnUse });
      } else {
        this.saveSettings({ ...this.settings(), consumeCommentOnUse });
      }
      return this.comments(scope);
    });
  }
  pickComment(
    postId: string,
    random = Math.random(),
    excludeIds: ReadonlyArray<string> = [],
    scope: BumperScope = 'group',
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
    const all = this.comments(scope).filter((r) => !excluded.has(r.id)),
      unused = all.filter((r) => !used.has(r.text));
    const consumeOnUse =
      scope === 'page'
        ? this.pageSettings().consumeCommentOnUse
        : this.settings().consumeCommentOnUse;
    const pool = unused.length ? unused : consumeOnUse ? [] : all;
    return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random * pool.length)))] ?? null;
  }
  eligibility(
    accountId: string,
    profileId: string,
    postId: string,
    nowOrSourceMode: number | BumperScope = Date.now(),
    maybeSourceMode?: BumperScope,
  ) {
    const now = typeof nowOrSourceMode === 'number' ? nowOrSourceMode : Date.now();
    const sourceMode: BumperScope =
      typeof nowOrSourceMode === 'string' ? nowOrSourceMode : (maybeSourceMode ?? 'group');
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    const today = Number(
      this.db
        .prepare(
          'SELECT COUNT(*) n FROM group_bumper_logs WHERE (account_id=? OR profile_id=?) AND bumped_at>=? AND source_mode=?',
        )
        .get(accountId, profileId, date.getTime(), sourceMode)?.n ?? 0,
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
    const settings = sourceMode === 'page' ? this.pageSettings() : this.settings();
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
        sourceMode: z.enum(['group', 'page']).optional(),
      })
      .strict()
      .parse(input);
    if (!row.liked && !row.commentText) return false;
    const sourceMode: BumperScope = row.sourceMode ?? (row.groupId === '-' ? 'page' : 'group');
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM group_bumper_logs WHERE id=?').get(row.id);
      if (
        !previous &&
        this.eligibility(row.accountId, row.profileId, row.postId, row.bumpedAt, sourceMode)
          .duplicate
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
          sourceMode,
        );
      if (!previous) {
        if (row.groupId && row.groupId !== '-') {
          this.targetLibrary.incrementGroupBumpedCount(row.groupId, 1);
        }
        if (row.pageId) {
          this.targetLibrary.incrementPageBumpedCount(row.pageId, 1);
        }
      }
      if (commentNew && commentId) {
        const consumeOnUse =
          sourceMode === 'page'
            ? this.pageSettings().consumeCommentOnUse
            : this.settings().consumeCommentOnUse;
        if (consumeOnUse)
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
  logs(
    search = '',
    limit = 200,
    before?: number,
    beforeId = '\uffff',
    sourceMode: BumperScope | 'all' = 'all',
  ): BumperLog[] {
    return this.db
      .prepare(
        `SELECT * FROM group_bumper_logs
          WHERE (bumped_at<? OR (bumped_at=? AND id<?))
            AND (?='all' OR source_mode=?)
            AND (?='' OR instr(lower(group_name||' '||page_name||' '||page_id||' '||account_id||' '||COALESCE(comment_text,'')),lower(?))>0)
          ORDER BY bumped_at DESC,id DESC LIMIT ?`,
      )
      .all(
        before ?? Date.now(),
        before ?? Date.now(),
        beforeId,
        sourceMode,
        sourceMode,
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
        sourceMode: r.source_mode === 'page' ? 'page' : 'group',
      }));
  }
  total(sourceMode: BumperScope | 'all' = 'all') {
    if (sourceMode === 'all') {
      return Number(this.db.prepare('SELECT COUNT(*) n FROM group_bumper_logs').get()?.n ?? 0);
    }
    return Number(
      this.db
        .prepare('SELECT COUNT(*) n FROM group_bumper_logs WHERE source_mode=?')
        .get(sourceMode)?.n ?? 0,
    );
  }
  todayCounts(sourceMode: BumperScope | 'all' = 'group'): Record<string, number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Object.fromEntries(
      this.db
        .prepare(
          `SELECT profile_id,COUNT(*) n FROM group_bumper_logs
            WHERE bumped_at>=? AND (?='all' OR source_mode=?)
            GROUP BY profile_id`,
        )
        .all(today.getTime(), sourceMode, sourceMode)
        .map((r) => [String(r.profile_id), Number(r.n)]),
    );
  }
  weeklyDailyCounts(
    now = Date.now(),
    sourceMode: BumperScope | 'all' = 'group',
  ): BumperDailyStat[] {
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
        `SELECT bumped_at FROM group_bumper_logs
          WHERE bumped_at >= ? AND bumped_at < ?
            AND (?='all' OR source_mode=?)`,
      )
      .all(startMs, endMs, sourceMode, sourceMode);
    for (const r of rows) {
      const ymd = formatLocalYmd(new Date(Number(r.bumped_at)));
      if (buckets.has(ymd)) {
        buckets.set(ymd, (buckets.get(ymd) ?? 0) + 1);
      }
    }

    return days.map((date) => ({ date, count: buckets.get(date) ?? 0 }));
  }
  pendingReviewOperations(limit = 100): BumperPendingOperation[] {
    return this.db
      .prepare(
        `SELECT operation_id, profile_id, account_id, group_id, group_name, page_id, page_name, post_id, action_kind, reason, updated_at
           FROM group_bumper_operations
          WHERE status = 'PENDING_REVIEW'
          ORDER BY updated_at DESC, operation_id DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map((r) => ({
        id: String(r.operation_id),
        profileId: String(r.profile_id),
        accountId: String(r.account_id),
        groupId: String(r.group_id),
        groupName: String(r.group_name),
        pageId: String(r.page_id),
        pageName: String(r.page_name),
        postId: String(r.post_id),
        actionKind: String(r.action_kind).includes('comment') ? 'comment' : 'like',
        reason: String(r.reason ?? ''),
        updatedAt: Number(r.updated_at ?? 0),
      }));
  }
  deleteLogs(input: unknown) {
    const { ids, all, sourceMode } = z
      .object({
        ids: z.array(z.uuid()).max(1000).default([]),
        all: z.boolean().default(false),
        sourceMode: z.enum(['group', 'page', 'all']).optional(),
      })
      .strict()
      .parse(input);
    const mode = sourceMode ?? 'all';
    return transaction(this.db, () => {
      const changes = Number(
        this.db
          .prepare(
            `DELETE FROM group_bumper_logs
              WHERE (?=1 AND (?='all' OR source_mode=?))
                 OR id IN (SELECT value FROM json_each(?))`,
          )
          .run(all ? 1 : 0, mode, mode, JSON.stringify(ids)).changes,
      );
      if (changes > 0) {
        this.db
          .prepare(
            `UPDATE shared_facebook_groups
                SET bumped_count = (
                  SELECT COUNT(*) FROM group_bumper_logs
                   WHERE group_bumper_logs.group_id = shared_facebook_groups.group_id
                )`,
          )
          .run();
        this.db
          .prepare(
            `UPDATE group_bumper_pages
                SET total_bumped_count = (
                  SELECT COUNT(*) FROM group_bumper_logs
                   WHERE group_bumper_logs.page_id = group_bumper_pages.page_id
                )`,
          )
          .run();
      }
      return changes;
    });
  }
}
