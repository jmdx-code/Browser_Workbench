import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import {
  BumperOperation,
  BumperResolution,
  type BumperOperationValue,
} from '../shared/bumper-operation.js';
import * as GB from '../shared/group-bumper.js';
import { sameBinding } from '../shared/task-execution.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { detectRecordCarrier, ensurePostBumpRecordsSchema } from './post-bump-records-store.js';
import { transaction } from './sqlite-transaction.js';
import {
  BumperLogInputSchema,
  ensureBumperCommentsSchema,
  listBumperCommentsFromDb,
  pickBumperCommentFromDb,
  queryBumperEligibilityCounts,
  recordBumpEntryInDb,
} from './stores/bumper-comments-helper.js';
import {
  ensureTargetLibrarySchema,
  mergedAvatar,
  SqliteTargetLibraryRepository,
} from './target-library-store.js';
export { mergedAvatar };
const ledgerTypeSql = (m: GB.BumperScope | 'all') =>
  m === 'page'
    ? "record_type = 'page_bump'"
    : m === 'group'
      ? "record_type = 'group_bump'"
      : "record_type IN ('group_bump', 'page_bump')";
export function ensureBumperEffectsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_bumper_effects(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL, page_id TEXT NOT NULL, post_id TEXT NOT NULL, source_mode TEXT NOT NULL DEFAULT 'group', liked INTEGER NOT NULL DEFAULT 0, commented INTEGER NOT NULL DEFAULT 0, comment_digest TEXT, applied_at INTEGER NOT NULL, story_shared INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS group_bumper_effects_post ON group_bumper_effects(post_id); CREATE INDEX IF NOT EXISTS group_bumper_effects_day ON group_bumper_effects(account_id, source_mode, applied_at); CREATE INDEX IF NOT EXISTS group_bumper_effects_week ON group_bumper_effects(source_mode, applied_at);
  `);
}
function initGroupBumperSchema(db: DatabaseSync): void {
  ensureTargetLibrarySchema(db);
  ensurePostBumpRecordsSchema(db);
  ensureBumperEffectsSchema(db);
  ensureBumperCommentsSchema(db);
  Q.ensureProfileTaskResultsSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_bumper_settings(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, default_max_likes_50_applied INTEGER NOT NULL DEFAULT 1, default_max_concurrent_8_applied INTEGER NOT NULL DEFAULT 1);
    INSERT OR IGNORE INTO group_bumper_settings(id,body) VALUES(1,'{}');
    CREATE TABLE IF NOT EXISTS page_bumper_settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO page_bumper_settings(id,value,updated_at) VALUES(1,'{}',0);
    CREATE TABLE IF NOT EXISTS group_bumper_operations(operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, connection_epoch TEXT NOT NULL, lease_id TEXT NOT NULL, generation INTEGER NOT NULL, job_id TEXT NOT NULL, step_id TEXT NOT NULL, action_digest TEXT NOT NULL, action_kind TEXT NOT NULL CHECK(action_kind IN ('setup_navigate','setup_open_group','setup_welcome','setup_watch','setup_browse','setup_expand_comment','setup_fill_comment','setup_open_share','setup_scroll','submit_like','submit_comment','submit_story_share')), group_id TEXT NOT NULL, group_name TEXT NOT NULL, page_id TEXT, page_name TEXT, post_id TEXT, post_url TEXT, comment_id TEXT, comment_text TEXT, log_id TEXT, resolution_id TEXT, resolution_outcome TEXT CHECK(resolution_outcome IN ('VERIFIED','NOT_APPLIED','ENDED_UNKNOWN')), evidence_digest TEXT, status TEXT NOT NULL CHECK(status IN ('PREPARED','SETTLEMENT_PENDING','SETTLED','PENDING_REVIEW')), reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK((resolution_id IS NULL AND resolution_outcome IS NULL AND evidence_digest IS NULL) OR (resolution_id IS NOT NULL AND resolution_outcome IS NOT NULL AND evidence_digest IS NOT NULL)));
    CREATE INDEX IF NOT EXISTS idx_group_bumper_operations_profile_status ON group_bumper_operations(profile_id,status); CREATE INDEX IF NOT EXISTS bumper_pending_log ON group_bumper_operations(log_id) WHERE status<>'SETTLED' OR resolution_outcome='ENDED_UNKNOWN'; CREATE INDEX IF NOT EXISTS bumper_detail_order ON group_bumper_operations(status,updated_at,operation_id);
  `);
  const sRow = Q.getRow(
    db,
    'SELECT body, default_max_likes_50_applied, default_max_concurrent_8_applied FROM group_bumper_settings WHERE id=1',
  );
  if (
    sRow &&
    (Q.n(sRow.default_max_likes_50_applied) === 0 ||
      Q.n(sRow.default_max_concurrent_8_applied) === 0)
  ) {
    try {
      const parsed = JSON.parse(Q.s(sRow.body, '{}')) as Record<string, unknown>;
      if (Q.n(sRow.default_max_likes_50_applied) === 0 && parsed.maxLikesPerPost === 10)
        parsed.maxLikesPerPost = 50;
      if (Q.n(sRow.default_max_concurrent_8_applied) === 0 && parsed.maxConcurrentProfiles === 4)
        parsed.maxConcurrentProfiles = 8;
      db.prepare(
        'UPDATE group_bumper_settings SET body=?, default_max_likes_50_applied=1, default_max_concurrent_8_applied=1 WHERE id=1',
      ).run(JSON.stringify(parsed));
    } catch {
      db.prepare(
        'UPDATE group_bumper_settings SET default_max_likes_50_applied=1, default_max_concurrent_8_applied=1 WHERE id=1',
      ).run();
    }
  }
}
export class SqliteGroupBumperRepository {
  private readonly targetLibrary: SqliteTargetLibraryRepository;
  private run = (sql: string, args: SQLInputValue[] = []) => Q.run(this.db, sql, ...args);
  constructor(private readonly db: DatabaseSync) {
    initGroupBumperSchema(db);
    this.targetLibrary = new SqliteTargetLibraryRepository(db);
  }
  getOperation(operationId: string): BumperOperationValue | null {
    const r = Q.getRow(
      this.db,
      'SELECT * FROM group_bumper_operations WHERE operation_id=?',
      z.uuid().parse(operationId),
    );
    return r
      ? BumperOperation.parse({
          binding: Q.rowBinding(r),
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
        })
      : null;
  }
  listOperationsByProfile(profileId: string): BumperOperationValue[] {
    const sql = 'SELECT operation_id FROM group_bumper_operations WHERE profile_id=? AND status<>?';
    return Q.allRows(this.db, sql, z.uuid().parse(profileId), 'SETTLED').flatMap((r) => {
      const op = this.getOperation(Q.s(r.operation_id));
      return op ? [op] : [];
    });
  }
  prepareOperation(input: unknown): BumperOperationValue {
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
      const now = Date.now(),
        cols =
          'operation_id,run_id,profile_id,account_id,connection_epoch,lease_id,generation,job_id,step_id,action_digest,action_kind,group_id,group_name,page_id,page_name,post_id,post_url,comment_id,comment_text,log_id,resolution_id,resolution_outcome,evidence_digest,status,reason,created_at,updated_at';
      Q.insertFrom(
        this.db,
        'group_bumper_operations',
        cols,
        { ...row, ...b },
        { status: 'PREPARED', reason: '', created_at: now, updated_at: now },
      );
      return row;
    });
  }
  setOperationResolution(operationId: string, input: unknown): z.infer<typeof BumperResolution> {
    const res = BumperResolution.parse(input),
      sql =
        "UPDATE group_bumper_operations SET resolution_id=?,resolution_outcome=?,evidence_digest=?,status='SETTLEMENT_PENDING',updated_at=? WHERE operation_id=?";
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (!row) throw Error('BUMPER_OPERATION_MISSING');
      if (row.resolution) {
        if (row.resolution.outcome !== res.outcome) throw Error('BUMPER_RESOLUTION_CONFLICT');
        return row.resolution;
      }
      Q.run(this.db, sql, res.id, res.outcome, res.evidenceDigest, Date.now(), operationId);
      return res;
    });
  }
  markOperationSettled(operationId: string): void {
    const row = this.getOperation(operationId),
      sql = "UPDATE group_bumper_operations SET status='SETTLED',updated_at=? WHERE operation_id=?";
    if (!row?.resolution) throw Error('BUMPER_RESOLUTION_MISSING');
    if (row.status !== 'SETTLED') Q.run(this.db, sql, Date.now(), operationId);
  }
  markOperationReview(operationId: string, reason: string): void {
    const row = this.getOperation(operationId),
      sql =
        "UPDATE group_bumper_operations SET status='PENDING_REVIEW',reason=?,updated_at=? WHERE operation_id=?";
    if (!row) throw Error('BUMPER_OPERATION_MISSING');
    if (!row.resolution) Q.run(this.db, sql, GB.stripAnsi(reason), Date.now(), operationId);
  }
  resolvePendingOperation(input: GB.ResolvePendingOperationInput): {
    operationId: string;
    resolution: GB.PendingOperationResolution;
    status: 'SETTLED';
  } {
    const parsed = GB.ResolvePendingOperationInput.parse(input);
    return transaction(this.db, () => {
      const row = this.getOperation(parsed.operationId);
      if (!row) throw Error('BUMPER_OPERATION_MISSING');
      const targetOutcome = parsed.resolution === 'confirmed' ? 'VERIFIED' : 'NOT_APPLIED';
      if (
        row.status === 'SETTLED' &&
        row.resolution &&
        row.resolution.outcome !== 'ENDED_UNKNOWN'
      ) {
        if (row.resolution.outcome === targetOutcome) {
          return {
            operationId: parsed.operationId,
            resolution: parsed.resolution,
            status: 'SETTLED',
          };
        }
        throw Error('BUMPER_RESOLUTION_CONFLICT');
      }
      const now = Date.now(),
        note = GB.stripAnsi((parsed.note ?? parsed.reason ?? '').trim()).slice(0, 500),
        nextReason = note || row.reason,
        resId = randomUUID(),
        evDigest = createHash('sha256')
          .update(
            JSON.stringify({
              manualResolution: parsed.resolution,
              operationId: parsed.operationId,
              note,
              at: now,
            }),
          )
          .digest('hex');
      if (parsed.resolution === 'not_applied') {
        this.run(
          "UPDATE group_bumper_operations SET resolution_id=?,resolution_outcome='NOT_APPLIED',evidence_digest=?,status='SETTLED',reason=?,updated_at=? WHERE operation_id=?",
          [resId, evDigest, nextReason, now, parsed.operationId],
        );
        return {
          operationId: parsed.operationId,
          resolution: parsed.resolution,
          status: 'SETTLED',
        };
      }
      let logId = row.logId ?? null;
      if (
        ['submit_like', 'submit_comment', 'submit_story_share'].includes(row.actionKind) &&
        row.postId &&
        /^\d+$/.test(row.postId) &&
        row.binding.accountId
      ) {
        logId = logId ?? randomUUID();
        const isPage = row.groupId === '-',
          pageId = row.pageId || (isPage ? row.binding.accountId : row.groupId) || '-',
          postUrl =
            row.postUrl && /^https?:\/\//i.test(row.postUrl)
              ? row.postUrl
              : isPage
                ? `https://www.facebook.com/${encodeURIComponent(pageId)}/posts/${row.postId}/`
                : `https://www.facebook.com/groups/${encodeURIComponent(row.groupId)}/posts/${row.postId}/`,
          liked = row.actionKind === 'submit_like',
          commentText = row.actionKind === 'submit_comment' ? (row.commentText ?? null) : null,
          storyShared = row.actionKind === 'submit_story_share';
        if (liked || commentText || storyShared) {
          this.record(
            {
              id: logId,
              profileId: row.binding.profileId,
              accountId: row.binding.accountId,
              groupId: row.groupId,
              groupName: row.groupName,
              pageId,
              pageName: row.pageName ?? '',
              postId: row.postId,
              postUrl,
              liked,
              commentText,
              ...(storyShared ? { storyShared: true } : {}),
              bumpedAt: now,
              sourceMode: isPage ? 'page' : 'group',
            },
            row.actionKind === 'submit_comment' ? (row.commentId ?? undefined) : undefined,
          );
        }
      }
      Q.run(
        this.db,
        "UPDATE group_bumper_operations SET log_id=COALESCE(log_id,?),resolution_id=?,resolution_outcome='VERIFIED',evidence_digest=?,status='SETTLED',reason=?,updated_at=? WHERE operation_id=?",
        logId,
        resId,
        evDigest,
        nextReason,
        now,
        parsed.operationId,
      );
      return { operationId: parsed.operationId, resolution: parsed.resolution, status: 'SETTLED' };
    });
  }
  confirmSubmission(
    operationId: string,
    record: GB.BumperLog,
    commentId: string | undefined,
    input: unknown,
  ): z.infer<typeof BumperResolution> {
    const res = BumperResolution.parse(input);
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (
        !row ||
        !['submit_like', 'submit_comment', 'submit_story_share'].includes(row.actionKind) ||
        row.binding.profileId !== record.profileId ||
        row.binding.accountId !== record.accountId ||
        row.postId !== record.postId ||
        row.logId !== record.id ||
        row.groupId !== record.groupId ||
        row.pageId !== record.pageId ||
        row.commentId !== (commentId ?? null) ||
        res.outcome !== 'VERIFIED'
      )
        throw Error('BUMPER_RESULT_CONTEXT_CHANGED');
      if (row.resolution) {
        if (row.resolution.outcome !== 'VERIFIED') throw Error('BUMPER_RESOLUTION_CONFLICT');
        return row.resolution;
      }
      if (
        (row.actionKind === 'submit_like' && !record.liked) ||
        (row.actionKind === 'submit_comment' &&
          (!record.commentText || record.commentText !== row.commentText)) ||
        (row.actionKind === 'submit_story_share' && !record.storyShared)
      )
        throw Error('BUMPER_RESULT_EVIDENCE_MISSING');
      this.record(record, row.actionKind === 'submit_comment' ? commentId : undefined);
      return this.setOperationResolution(operationId, res);
    });
  }
  saveProfileResult = (input: unknown) => Q.upsertProfileTaskResult(this.db, input);
  settings = (): GB.BumperSettings =>
    Q.readSingletonJson(
      this.db,
      'group_bumper_settings',
      'body',
      (o) => GB.BumperSettings.parse(o),
      () => GB.BumperSettings.parse({}),
    );
  saveSettings(input: unknown) {
    const s = GB.BumperSettings.parse(input);
    Q.run(this.db, 'UPDATE group_bumper_settings SET body=? WHERE id=1', JSON.stringify(s));
    return s;
  }
  pageSettings = (): GB.BumperSettings =>
    Q.readSingletonJson(
      this.db,
      'page_bumper_settings',
      'value',
      (o) => GB.BumperSettings.parse(o),
      () => GB.BumperSettings.parse({}),
    );
  savePageSettings(input: unknown): GB.BumperSettings {
    const s = GB.BumperSettings.parse(input);
    Q.run(
      this.db,
      'UPDATE page_bumper_settings SET value=?, updated_at=? WHERE id=1',
      JSON.stringify(s),
      Date.now(),
    );
    return s;
  }
  targets = (kind: 'groups' | 'pages'): GB.BumperTarget[] =>
    kind === 'groups' ? this.targetLibrary.listBumperGroups() : this.targetLibrary.listPages();
  upsertTargets(kind: 'groups' | 'pages', input: unknown): GB.BumperTarget[] {
    const mapped = GB.BumperTargetsInput.parse(input).items.map((item) => ({
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
  applyResolvedTargetMetadata = (
    kind: 'groups' | 'pages',
    originalId: string,
    resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): boolean => this.targetLibrary.applyResolvedTargetMetadata(kind, originalId, resolved);
  deleteTargets = (kind: 'groups' | 'pages', input: unknown): number =>
    transaction(this.db, () =>
      Q.deleteByJsonIds(
        this.db,
        kind === 'groups' ? 'shared_facebook_groups' : 'group_bumper_pages',
        kind === 'groups' ? 'group_id' : 'page_id',
        GB.BumperIdsInput.parse(input).ids,
      ),
    );
  updateAvatar(kind: 'groups' | 'pages', id: string, avatarUrl: string) {
    const trimmed = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (trimmed) this.targetLibrary.applyResolvedTargetMetadata(kind, id, { avatarUrl: trimmed });
  }
  comments = (scope: GB.BumperScope = 'group'): GB.BumperComment[] =>
    listBumperCommentsFromDb(this.db, scope, true);
  saveComments(input: unknown, scopeOverride?: GB.BumperScope): GB.BumperComment[] {
    const parsed = GB.BumperCommentsInput.parse(input),
      scope: GB.BumperScope = scopeOverride ?? parsed.scope ?? 'group';
    const { texts, consumeCommentOnUse, baseComments } = parsed;
    return transaction(this.db, () => {
      const existing = new Map(
        listBumperCommentsFromDb(this.db, scope, true).map((r) => [r.text, r]),
      );
      const orderedTexts = (() => {
        if (!baseComments) return [...new Set(texts)];
        const baseIds = new Set(baseComments.map((r) => r.id)),
          baseTexts = new Set(baseComments.map((r) => r.text)),
          inputSet = new Set(texts),
          out: string[] = [],
          seen = new Set<string>(),
          push = (t: string) => {
            if (!seen.has(t)) {
              seen.add(t);
              out.push(t);
            }
          };
        for (const text of texts) {
          if (!baseTexts.has(text) || existing.has(text)) push(text);
        }
        for (const row of existing.values()) {
          if (!baseIds.has(row.id) || inputSet.has(row.text)) push(row.text);
        }
        return out;
      })();
      const baseNow = Date.now();
      this.db.prepare('DELETE FROM group_bumper_comments WHERE scope=?').run(scope);
      const add = this.db.prepare(
        'INSERT INTO group_bumper_comments(id,comment_text,used_count,created_at,scope) VALUES(?,?,?,?,?)',
      );
      orderedTexts.forEach((text, idx) => {
        const prev = existing.get(text);
        add.run(prev?.id ?? randomUUID(), text, prev?.usedCount ?? 0, baseNow + idx, scope);
      });
      if (consumeCommentOnUse !== undefined) {
        if (scope === 'page')
          this.savePageSettings({ ...this.pageSettings(), consumeCommentOnUse });
        else this.saveSettings({ ...this.settings(), consumeCommentOnUse });
      }
      return listBumperCommentsFromDb(this.db, scope, true);
    });
  }
  pickComment = (
    postId: string,
    random = Math.random(),
    excludeIds: ReadonlyArray<string> = [],
    scope: GB.BumperScope = 'group',
  ): GB.BumperComment | null =>
    pickBumperCommentFromDb(
      this.db,
      postId,
      scope,
      (scope === 'page' ? this.pageSettings() : this.settings()).consumeCommentOnUse,
      random,
      excludeIds,
      true,
    );
  eligibility(
    accountId: string,
    profileId: string,
    postId: string,
    nowOrSourceMode: number | GB.BumperScope = Date.now(),
    maybeSourceMode?: GB.BumperScope,
  ) {
    const now = typeof nowOrSourceMode === 'number' ? nowOrSourceMode : Date.now(),
      sourceMode: GB.BumperScope =
        typeof nowOrSourceMode === 'string' ? nowOrSourceMode : (maybeSourceMode ?? 'group');
    const { today, postCount, duplicate } = queryBumperEligibilityCounts(
      this.db,
      accountId,
      profileId,
      postId,
      now,
      sourceMode,
    );
    const pendingSql =
      "SELECT 1 FROM group_bumper_operations WHERE post_id=? AND (account_id=? OR profile_id=?) AND action_kind IN ('submit_like','submit_comment','submit_story_share') AND (status='PENDING_REVIEW' OR resolution_outcome='ENDED_UNKNOWN') LIMIT 1";
    const pending = Boolean(this.db.prepare(pendingSql).get(postId, accountId, profileId)),
      settings = sourceMode === 'page' ? this.pageSettings() : this.settings();
    return {
      today,
      postCount,
      duplicate,
      allowed:
        !duplicate &&
        !pending &&
        today < settings.dailyMaxLikesPerAccount &&
        postCount < settings.maxLikesPerPost,
    };
  }
  record(input: GB.BumperLog, commentId?: string): boolean {
    const row = BumperLogInputSchema.parse(input);
    if (!row.liked && !row.commentText && !row.storyShared) return false;
    const sourceMode: GB.BumperScope = row.sourceMode ?? (row.groupId === '-' ? 'page' : 'group');
    return recordBumpEntryInDb({
      db: this.db,
      targetLibrary: this.targetLibrary,
      row,
      sourceMode,
      carrier: detectRecordCarrier(this.db, row.profileId),
      commentId,
      consumeCommentOnUse: (sourceMode === 'page' ? this.pageSettings() : this.settings())
        .consumeCommentOnUse,
      isDuplicate: () =>
        this.eligibility(row.accountId, row.profileId, row.postId, row.bumpedAt, sourceMode)
          .duplicate,
    });
  }
  logs(
    search = '',
    limit = 200,
    before?: number,
    beforeId = '\uffff',
    sourceMode: GB.BumperScope | 'all' = 'all',
    carrier: 'chrome' | 'bluestacks' | 'all' = 'all',
  ): GB.BumperLog[] {
    const cc =
      carrier === 'bluestacks'
        ? " AND carrier = 'bluestacks'"
        : carrier === 'chrome'
          ? " AND carrier = 'browser'"
          : '';
    const sql = `SELECT * FROM post_bump_records WHERE ${ledgerTypeSql(sourceMode)} AND status = 'success' AND (created_at < ? OR (created_at = ? AND COALESCE(source_log_id, id) < ?)) AND (?='' OR instr(lower(group_name||' '||page_name||' '||page_id||' '||account_id||' '||COALESCE(comment_text,'')),lower(?))>0)${cc} ORDER BY created_at DESC, COALESCE(source_log_id, id) DESC LIMIT ?`;
    const args = [
      ...Q.cursorPaginationParams(before ?? Date.now(), beforeId),
      search,
      search,
      Q.clampLimit(limit, 1, 1000),
    ];
    return Q.allRows(this.db, sql, ...args).map((r) => {
      const mode: GB.BumperScope = r.record_type === 'page_bump' ? 'page' : 'group',
        rg = Q.s(r.group_id);
      return {
        id: Q.s(r.source_log_id ?? r.id),
        profileId: Q.s(r.profile_id),
        accountId: Q.s(r.account_id),
        groupId: mode === 'page' && !rg ? '-' : rg,
        groupName: mode === 'page' && !Q.s(r.group_name) ? '专页主页' : Q.s(r.group_name),
        pageId: Q.s(r.page_id),
        pageName: Q.s(r.page_name),
        postId: Q.s(r.post_id),
        postUrl: Q.s(r.post_url),
        liked: Q.b(r.liked),
        commentText: Q.sn(r.comment_text),
        ...(Q.b(r.story_shared) ? { storyShared: true } : {}),
        bumpedAt: Q.n(r.created_at),
        sourceMode: mode,
      };
    });
  }
  total = (sourceMode: GB.BumperScope | 'all' = 'all') =>
    Q.countSql(
      this.db,
      `SELECT COUNT(*) n FROM post_bump_records WHERE ${ledgerTypeSql(sourceMode)} AND status='success' AND carrier='browser'`,
    );
  todayCounts(sourceMode: GB.BumperScope | 'all' = 'group'): Record<string, number> {
    const sql =
      "SELECT profile_id,COUNT(*) n FROM group_bumper_effects WHERE applied_at>=? AND (?='all' OR source_mode=?) GROUP BY profile_id";
    return Object.fromEntries(
      Q.allRows(this.db, sql, Q.localDayStartMs(), sourceMode, sourceMode).map((r) => [
        Q.s(r.profile_id),
        Q.n(r.n),
      ]),
    );
  }
  pendingReviewOperations(limit = 100): GB.BumperPendingOperation[] {
    const sql =
      "SELECT operation_id AS id, profile_id, account_id, group_id, group_name, page_id, page_name, post_id, action_kind, reason, updated_at FROM group_bumper_operations WHERE action_kind IN ('submit_like','submit_comment','submit_story_share') AND (status = 'PENDING_REVIEW' OR resolution_outcome = 'ENDED_UNKNOWN') ORDER BY updated_at DESC, operation_id DESC LIMIT ?";
    return Q.allRows(this.db, sql, Q.clampLimit(limit, 1, 500)).map(
      (r) =>
        ({
          ...Q.camel(r),
          actionKind:
            Q.s(r.action_kind) === 'submit_story_share'
              ? 'story_share'
              : Q.s(r.action_kind).includes('comment')
                ? 'comment'
                : 'like',
          reason:
            GB.stripAnsi(Q.s(r.reason))
              .split(/\r?\nCall log:/)[0]
              ?.trim() ?? '',
        }) as GB.BumperPendingOperation,
    );
  }
  deleteLogs(input: unknown): number {
    const { ids, all, sourceMode, carrier } = z
      .object({
        ids: z.array(z.uuid()).max(1000).default([]),
        all: z.boolean().default(false),
        sourceMode: z.enum(['group', 'page', 'all']).optional(),
        carrier: z.enum(['chrome', 'bluestacks', 'all']).optional(),
      })
      .strict()
      .parse(input);
    const mode = sourceMode ?? 'all',
      tc = carrier ?? 'all',
      idJson = JSON.stringify(ids),
      flag = all ? 1 : 0;
    const lc =
      tc === 'bluestacks'
        ? " AND carrier = 'bluestacks'"
        : tc === 'chrome'
          ? " AND carrier = 'browser'"
          : '';
    const ec =
      tc === 'bluestacks'
        ? ' AND profile_id IN (SELECT id FROM bluestacks_instances)'
        : tc === 'chrome'
          ? ' AND profile_id NOT IN (SELECT id FROM bluestacks_instances)'
          : '';
    return transaction(this.db, () => {
      const uSql = `DELETE FROM group_bumper_effects WHERE (?=1 AND (?='all' OR source_mode=?)${ec}) OR log_id IN(SELECT value FROM json_each(?))`;
      const pSql = `DELETE FROM post_bump_records WHERE ${ledgerTypeSql(mode)} AND ((?=1${lc}) OR source_log_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))`;
      const usageChanges = Number(this.run(uSql, [flag, mode, mode, idJson]).changes);
      const changes = Number(this.run(pSql, [flag, idJson, idJson]).changes);
      const oSql = `DELETE FROM group_bumper_operations WHERE (status='PENDING_REVIEW' OR resolution_outcome='ENDED_UNKNOWN') AND (?='all' OR (CASE WHEN group_id='-' THEN 'page' ELSE 'group' END)=?)${ec}`;
      if (all) this.run(oSql, [mode, mode]);
      if (changes > 0 || usageChanges > 0) {
        this.run(
          'UPDATE shared_facebook_groups SET bumped_count = (SELECT COUNT(*) FROM group_bumper_effects WHERE group_bumper_effects.group_id = shared_facebook_groups.group_id)',
        );
        this.run(
          'UPDATE group_bumper_pages SET total_bumped_count = (SELECT COUNT(*) FROM group_bumper_effects WHERE group_bumper_effects.page_id = group_bumper_pages.page_id)',
        );
      }
      return changes;
    });
  }
}
