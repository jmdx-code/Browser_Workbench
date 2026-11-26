import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { BumperComment, BumperLog, BumperScope } from '../../shared/group-bumper.js';
import type { PostBumpCarrierValue } from '../../shared/post-bump-records.js';
import * as Q from '../persistence/sqlite-query-helpers.js';
import { syncBumperLogToPostBumpRecords } from '../post-bump-records-store.js';
import { transaction } from '../sqlite-transaction.js';
import type { SqliteTargetLibraryRepository } from '../target-library-store.js';

export function ensureBumperCommentsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_bumper_comments(id TEXT PRIMARY KEY, comment_text TEXT NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'group' CHECK(scope IN ('group','page')));
    CREATE INDEX IF NOT EXISTS idx_group_bumper_comments_scope ON group_bumper_comments(scope, created_at, id);
  `);
}

export const BumperLogInputSchema = z
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
    storyShared: z.boolean().optional(),
    bumpedAt: z.number().int(),
    sourceMode: z.enum(['group', 'page']).optional(),
  })
  .strict();

export function listBumperCommentsFromDb(
  db: DatabaseSync,
  scope: BumperScope = 'group',
  preserveRowScope = false,
): BumperComment[] {
  const sql = 'SELECT * FROM group_bumper_comments WHERE scope=? ORDER BY created_at,id';
  return Q.allRows(db, sql, scope).map((r) => ({
    id: String(r.id),
    text: String(r.comment_text),
    usedCount: Number(r.used_count),
    createdAt: Number(r.created_at),
    scope: preserveRowScope ? (r.scope === 'page' ? 'page' : 'group') : scope,
  }));
}

export function pickBumperCommentFromDb(
  db: DatabaseSync,
  postId: string,
  scope: BumperScope,
  consumeOnUse: boolean,
  random = Math.random(),
  excludeIds: ReadonlyArray<string> = [],
  preserveRowScope = false,
): BumperComment | null {
  const excluded = new Set(excludeIds),
    dSql =
      'SELECT comment_digest FROM group_bumper_effects WHERE post_id=? AND comment_digest IS NOT NULL',
    uSql =
      "SELECT comment_text FROM post_bump_records WHERE post_id=? AND record_type IN ('group_bump','page_bump') AND status='success' AND comment_text IS NOT NULL";
  const digests = new Set(Q.allRows(db, dSql, postId).map((r) => String(r.comment_digest))),
    used = new Set(Q.allRows(db, uSql, postId).map((r) => String(r.comment_text)));
  const all = listBumperCommentsFromDb(db, scope, preserveRowScope).filter(
      (r) => !excluded.has(r.id),
    ),
    unused = all.filter(
      (r) => !used.has(r.text) && !digests.has(createHash('sha256').update(r.text).digest('hex')),
    ),
    pool = unused.length > 0 ? unused : consumeOnUse ? [] : all;
  return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random * pool.length)))] ?? null;
}

export function queryBumperEligibilityCounts(
  db: DatabaseSync,
  accountId: string,
  targetId: string,
  postId: string,
  now: number,
  sourceMode: BumperScope,
) {
  const dSql =
      'SELECT COUNT(*) n FROM group_bumper_effects WHERE (account_id=? OR profile_id=?) AND applied_at>=? AND source_mode=?',
    pSql =
      'SELECT COUNT(*) n FROM group_bumper_effects WHERE post_id=? AND (liked=1 OR commented=1 OR story_shared=1)',
    dupSql =
      'SELECT 1 FROM group_bumper_effects WHERE post_id=? AND (account_id=? OR profile_id=?) LIMIT 1';
  return {
    today: Q.countSql(db, dSql, accountId, targetId, Q.localDayStartMs(now), sourceMode),
    postCount: postId ? Q.countSql(db, pSql, postId) : 0,
    duplicate: postId ? Boolean(db.prepare(dupSql).get(postId, accountId, targetId)) : false,
  };
}

export function recordBumpEntryInDb(options: {
  db: DatabaseSync;
  targetLibrary: SqliteTargetLibraryRepository;
  row: BumperLog;
  sourceMode: BumperScope;
  carrier: PostBumpCarrierValue;
  commentId: string | undefined;
  consumeCommentOnUse: boolean;
  isDuplicate: () => boolean;
}): boolean {
  const {
    db,
    targetLibrary,
    row,
    sourceMode,
    carrier,
    commentId,
    consumeCommentOnUse,
    isDuplicate,
  } = options;
  return transaction(db, () => {
    const pSql =
      'SELECT account_id, profile_id, post_id, commented, comment_digest FROM group_bumper_effects WHERE log_id=?';
    const prev = Q.getRow(db, pSql, row.id);
    if (!prev && isDuplicate()) return false;
    if (
      prev &&
      (prev.account_id !== row.accountId ||
        prev.post_id !== row.postId ||
        prev.profile_id !== row.profileId)
    )
      throw Error('BUMPER_RESULT_CONTEXT_CHANGED');
    const commentNew = Boolean(row.commentText && !prev?.commented),
      prevDigest = prev?.comment_digest ? String(prev.comment_digest) : null,
      digest = row.commentText
        ? (prevDigest ?? createHash('sha256').update(row.commentText).digest('hex'))
        : prevDigest;
    const sql = `INSERT INTO group_bumper_effects(log_id, profile_id, account_id, group_id, page_id, post_id, source_mode, liked, commented, comment_digest, applied_at, story_shared) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(log_id) DO UPDATE SET liked=MAX(liked, excluded.liked), commented=MAX(commented, excluded.commented), comment_digest=COALESCE(comment_digest, excluded.comment_digest), story_shared=MAX(story_shared, excluded.story_shared)`;
    const vals = [
      row.id,
      row.profileId,
      row.accountId,
      row.groupId,
      row.pageId,
      row.postId,
      sourceMode,
      row.liked ? 1 : 0,
      row.commentText ? 1 : 0,
      digest,
      row.bumpedAt,
      row.storyShared ? 1 : 0,
    ];
    Q.run(db, sql, ...vals);
    syncBumperLogToPostBumpRecords(
      db,
      { ...row, sourceMode, storyShared: Boolean(row.storyShared) },
      carrier,
    );
    if (!prev) {
      if (row.groupId && row.groupId !== '-')
        targetLibrary.incrementGroupBumpedCount(row.groupId, 1);
      if (row.pageId) targetLibrary.incrementPageBumpedCount(row.pageId, 1);
    }
    if (commentNew && commentId) {
      const cSql = consumeCommentOnUse
        ? 'DELETE FROM group_bumper_comments WHERE id=? AND comment_text=?'
        : 'UPDATE group_bumper_comments SET used_count=used_count+1 WHERE id=? AND comment_text=?';
      Q.run(db, cSql, commentId, row.commentText ?? '');
    }
    return !prev;
  });
}
