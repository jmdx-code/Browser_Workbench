import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import * as PB from '../shared/post-bump-records.js';
import type { BumperLog } from '../shared/group-bumper.js';
import type { PosterLog } from '../shared/group-poster.js';
import * as Q from './persistence/sqlite-query-helpers.js';

export const sqliteTableExists = Q.sqliteTableExists;

export function ensurePostBumpRecordsSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_bump_records( id TEXT PRIMARY KEY, record_type TEXT NOT NULL CHECK(record_type IN ('post','group_bump','page_bump')), carrier TEXT NOT NULL CHECK(carrier IN ('browser','bluestacks')), status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed')), profile_id TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '', page_id TEXT NOT NULL DEFAULT '', page_name TEXT NOT NULL DEFAULT '', post_id TEXT NOT NULL DEFAULT '', post_url TEXT NOT NULL DEFAULT '', liked INTEGER NOT NULL DEFAULT 0, comment_text TEXT, story_shared INTEGER NOT NULL DEFAULT 0, caption_preview TEXT NOT NULL DEFAULT '', error_reason TEXT NOT NULL DEFAULT '', source_log_id TEXT, created_at INTEGER NOT NULL );
    CREATE INDEX IF NOT EXISTS idx_post_bump_records_created ON post_bump_records(created_at DESC, id DESC); CREATE INDEX IF NOT EXISTS idx_post_bump_records_type_created ON post_bump_records(record_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_post_bump_records_carrier_created ON post_bump_records(carrier, created_at DESC); CREATE INDEX IF NOT EXISTS idx_post_bump_records_status_created ON post_bump_records(status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_post_bump_records_source ON post_bump_records(record_type, source_log_id) WHERE source_log_id IS NOT NULL;
  `);
}

const clean = (raw: string | null | undefined): string => {
  const t = (raw ?? '').trim();
  return !t || t === '__page_timeline__' || t === '-' ? '' : t;
};

function resolveCachedAccountIdentity(
  db: DatabaseSync,
  profileId: string,
  rawId: string,
  rawName: string,
): { accountId: string; accountName: string } {
  let accountId = clean(rawId),
    accountName = clean(rawName);
  if (Q.sqliteTableExists(db, 'profile_account_cache')) {
    const sql = accountId
      ? 'SELECT account_id, account_name FROM profile_account_cache WHERE profile_id=? AND account_id=? LIMIT 1'
      : 'SELECT account_id, account_name FROM profile_account_cache WHERE profile_id=? LIMIT 1';
    const c = accountId ? Q.getRow(db, sql, profileId, accountId) : Q.getRow(db, sql, profileId);
    accountId ||= Q.nonEmptyTrimmed(c?.account_id) ?? '';
    accountName ||= Q.nonEmptyTrimmed(c?.account_name) ?? '';
  }
  if ((!accountId || !accountName) && Q.sqliteTableExists(db, 'bluestacks_instances')) {
    const sql =
      'SELECT account_id, account_name, alias, display_name FROM bluestacks_instances WHERE id=? LIMIT 1';
    const bs = Q.getRow(db, sql, profileId);
    accountId ||= Q.nonEmptyTrimmed(bs?.account_id) ?? '';
    accountName ||=
      Q.nonEmptyTrimmed(bs?.account_name) ||
      Q.nonEmptyTrimmed(bs?.alias) ||
      Q.nonEmptyTrimmed(bs?.display_name) ||
      '';
  }
  if (!accountName && Q.sqliteTableExists(db, 'profile_metadata')) {
    const sql = 'SELECT alias FROM profile_metadata WHERE profile_id=? LIMIT 1';
    accountName = Q.nonEmptyTrimmed(Q.getRow(db, sql, profileId)?.alias) ?? '';
  }
  if (!accountName && Q.sqliteTableExists(db, 'profile_launch_bindings')) {
    const sql = 'SELECT browser_name FROM profile_launch_bindings WHERE profile_id=? LIMIT 1';
    accountName = Q.nonEmptyTrimmed(Q.getRow(db, sql, profileId)?.browser_name) ?? '';
  }
  return { accountId, accountName: accountName || accountId };
}

export const detectRecordCarrier = (
  db: DatabaseSync,
  profileId: string,
): PB.PostBumpCarrierValue =>
  Q.sqliteTableExists(db, 'bluestacks_instances') &&
  db.prepare('SELECT 1 FROM bluestacks_instances WHERE id=? LIMIT 1').get(profileId)
    ? 'bluestacks'
    : 'browser';

export function syncPosterLogToPostBumpRecords(db: DatabaseSync, i: PosterLog) {
  if (!Q.sqliteTableExists(db, 'post_bump_records')) return;
  const { accountId, accountName } = resolveCachedAccountIdentity(
      db,
      i.profileId,
      i.accountId,
      i.accountName,
    ),
    isPage = i.identityType === 'page';
  const sql = `INSERT INTO post_bump_records(id, record_type, carrier, status, profile_id, account_id, account_name, group_id, group_name, page_id, page_name, post_id, post_url, liked, comment_text, story_shared, caption_preview, error_reason, source_log_id, created_at)
     VALUES(?, 'post', ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, '', ?, ?) ON CONFLICT(record_type, source_log_id) WHERE source_log_id IS NOT NULL DO UPDATE SET
     account_name=CASE WHEN excluded.account_name<>'' THEN excluded.account_name ELSE post_bump_records.account_name END, group_name=CASE WHEN excluded.group_name<>'' THEN excluded.group_name ELSE post_bump_records.group_name END,
     post_id=CASE WHEN excluded.post_id<>'' THEN excluded.post_id ELSE post_bump_records.post_id END, post_url=CASE WHEN excluded.post_url<>'' THEN excluded.post_url ELSE post_bump_records.post_url END`;
  Q.run(
    db,
    sql,
    `pbp:${i.id}`,
    detectRecordCarrier(db, i.profileId),
    i.profileId,
    accountId,
    accountName,
    clean(i.groupId),
    clean(i.groupName),
    isPage ? accountId : '',
    isPage ? accountName : '',
    i.postId,
    i.postUrl,
    i.captionPreview,
    i.id,
    i.postedAt,
  );
}

export function syncBumperLogToPostBumpRecords(
  db: DatabaseSync,
  i: BumperLog,
  carrierOverride?: PB.PostBumpCarrierValue,
) {
  if (!Q.sqliteTableExists(db, 'post_bump_records')) return;
  const isPage = i.sourceMode === 'page' || i.groupId === '-',
    { accountId, accountName } = resolveCachedAccountIdentity(db, i.profileId, i.accountId, '');
  const sql = `INSERT INTO post_bump_records(id, record_type, carrier, status, profile_id, account_id, account_name, group_id, group_name, page_id, page_name, post_id, post_url, liked, comment_text, story_shared, caption_preview, error_reason, source_log_id, created_at)
     VALUES(?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?) ON CONFLICT(record_type, source_log_id) WHERE source_log_id IS NOT NULL DO UPDATE SET
     liked=MAX(post_bump_records.liked, excluded.liked), comment_text=COALESCE(post_bump_records.comment_text, excluded.comment_text), story_shared=MAX(post_bump_records.story_shared, excluded.story_shared)`;
  Q.run(
    db,
    sql,
    `pbb:${i.id}`,
    isPage ? 'page_bump' : 'group_bump',
    carrierOverride ?? detectRecordCarrier(db, i.profileId),
    i.profileId,
    accountId,
    accountName,
    isPage ? '' : clean(i.groupId),
    isPage ? '' : clean(i.groupName),
    clean(i.pageId),
    clean(i.pageName),
    i.postId,
    i.postUrl,
    i.liked ? 1 : 0,
    i.commentText ?? null,
    i.storyShared ? 1 : 0,
    i.id,
    i.bumpedAt,
  );
}

export function backfillPostBumpRecordsMigration(db: DatabaseSync) {
  ensurePostBumpRecordsSchema(db);
  const hasBs = Q.sqliteTableExists(db, 'bluestacks_instances'),
    hasAccCache = Q.sqliteTableExists(db, 'profile_account_cache');
  const carrierSql = hasBs
    ? `CASE WHEN EXISTS(SELECT 1 FROM bluestacks_instances bs WHERE bs.id = t.profile_id) THEN 'bluestacks' ELSE 'browser' END`
    : `'browser'`;
  const bsNameExpr = hasBs
    ? `(SELECT COALESCE(NULLIF(TRIM(bs.account_name), ''), NULLIF(TRIM(bs.alias), ''), NULLIF(TRIM(bs.display_name), '')) FROM bluestacks_instances bs WHERE bs.id = t.profile_id LIMIT 1)`
    : `NULL`;
  const cacheNameExpr = hasAccCache
    ? `(SELECT NULLIF(TRIM(pac.account_name), '') FROM profile_account_cache pac WHERE pac.profile_id = t.profile_id LIMIT 1)`
    : `NULL`;
  const resolvedFallbackSql = `COALESCE(${cacheNameExpr}, ${bsNameExpr}, NULLIF(TRIM(t.account_id), ''), '')`;
  const colsSql =
    'id, record_type, carrier, status, profile_id, account_id, account_name, group_id, group_name, page_id, page_name, post_id, post_url, liked, comment_text, story_shared, caption_preview, error_reason, source_log_id, created_at';
  if (Q.sqliteTableExists(db, 'group_poster_logs')) {
    const columns = Q.tableColumns(db, 'group_poster_logs'),
      acctNameExpr = columns.has('account_name')
        ? `COALESCE(NULLIF(TRIM(t.account_name), ''), ${resolvedFallbackSql})`
        : resolvedFallbackSql,
      hasIdentityType = columns.has('identity_type');
    db.exec(
      `INSERT OR IGNORE INTO post_bump_records(${colsSql}) SELECT 'pbp:'||t.id, 'post', ${carrierSql}, 'success', t.profile_id, COALESCE(t.account_id,''), ${acctNameExpr}, COALESCE(t.group_id,''), COALESCE(t.group_name,''), ${hasIdentityType ? `CASE WHEN t.identity_type='page' THEN COALESCE(t.account_id,'') ELSE '' END` : `''`}, ${hasIdentityType ? `CASE WHEN t.identity_type='page' THEN ${acctNameExpr} ELSE '' END` : `''`}, COALESCE(t.post_id,''), COALESCE(t.post_url,''), 0, NULL, 0, COALESCE(t.caption_preview,''), '', t.id, t.posted_at FROM group_poster_logs t`,
    );
  }
  if (Q.sqliteTableExists(db, 'group_bumper_logs')) {
    const columns = Q.tableColumns(db, 'group_bumper_logs'),
      recordTypeExpr = columns.has('source_mode')
        ? `CASE WHEN t.source_mode='page' OR t.group_id='-' THEN 'page_bump' ELSE 'group_bump' END`
        : `CASE WHEN t.group_id='-' THEN 'page_bump' ELSE 'group_bump' END`;
    db.exec(
      `INSERT OR IGNORE INTO post_bump_records(${colsSql}) SELECT 'pbb:'||t.id, ${recordTypeExpr}, ${carrierSql}, 'success', t.profile_id, COALESCE(t.account_id,''), ${resolvedFallbackSql}, CASE WHEN t.group_id='-' THEN '' ELSE COALESCE(t.group_id,'') END, CASE WHEN t.group_id='-' THEN '' ELSE COALESCE(t.group_name,'') END, COALESCE(t.page_id,''), COALESCE(t.page_name,''), COALESCE(t.post_id,''), COALESCE(t.post_url,''), COALESCE(t.liked,0), t.comment_text, ${columns.has('story_shared') ? 'COALESCE(t.story_shared,0)' : '0'}, '', '', t.id, t.bumped_at FROM group_bumper_logs t`,
    );
  }
}

const mapRow = (r: Record<string, unknown>): PB.PostBumpRecord =>
  PB.PostBumpRecordSchema.parse(Q.camel(r, 'liked,story_shared'));

export class SqlitePostBumpRecordsRepository {
  constructor(private readonly db: DatabaseSync) {
    ensurePostBumpRecordsSchema(db);
  }
  insert(input: PB.InsertPostBumpRecordInput): PB.PostBumpRecord {
    const p = PB.InsertPostBumpRecordInputSchema.parse(input),
      { accountId, accountName } = resolveCachedAccountIdentity(
        this.db,
        p.profileId,
        p.accountId,
        p.accountName,
      );
    const rec: PB.PostBumpRecord = {
      ...p,
      id: p.id ?? randomUUID(),
      accountId,
      accountName,
      groupId: clean(p.groupId),
      groupName: clean(p.groupName),
      pageId: clean(p.pageId),
      pageName: clean(p.pageName),
      createdAt: p.createdAt ?? Date.now(),
    };
    const cols =
      'id,record_type,carrier,status,profile_id,account_id,account_name,group_id,group_name,page_id,page_name,post_id,post_url,liked,comment_text,story_shared,caption_preview,error_reason,source_log_id,created_at';
    Q.insertFrom(this.db, 'post_bump_records', cols, rec, undefined, 'INSERT OR REPLACE INTO');
    return rec;
  }
  list(queryInput: PB.PostBumpRecordQuery = {}): PB.PostBumpRecordsResponse {
    const q = PB.PostBumpRecordQuerySchema.parse(queryInput),
      clauses: string[] = ['1=1'],
      params: SQLInputValue[] = [];
    if (q.recordType === 'bump_all') clauses.push("record_type IN ('group_bump', 'page_bump')");
    else if (q.recordType !== 'all') {
      clauses.push('record_type = ?');
      params.push(q.recordType);
    }
    for (const [cond, val] of [
      ['carrier = ?', q.carrier !== 'all' ? q.carrier : undefined],
      ['status = ?', q.status !== 'all' ? q.status : undefined],
      ['created_at >= ?', q.from],
      ['created_at <= ?', q.to],
    ] as const) {
      if (val !== undefined) {
        clauses.push(cond);
        params.push(val);
      }
    }
    const kw = q.search.trim().toLowerCase();
    if (kw) {
      clauses.push(
        "instr(lower(account_name||' '||account_id||' '||group_name||' '||group_id||' '||page_name||' '||page_id||' '||post_url||' '||caption_preview||' '||COALESCE(comment_text,'')||' '||error_reason), ?) > 0",
      );
      params.push(kw);
    }
    const whereSql = clauses.join(' AND ');
    const countSql = `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count, SUM(CASE WHEN status = 'success' AND record_type = 'post' AND (post_id = 'pending_approval' OR post_id LIKE 'pending-%') THEN 1 ELSE 0 END) AS pending_count FROM post_bump_records WHERE ${whereSql}`;
    const countRow = Q.getRow(this.db, countSql, ...params),
      total = Q.n(countRow?.n),
      failed = Q.n(countRow?.failed_count),
      pending = Q.n(countRow?.pending_count);
    const records = Q.allRows(
      this.db,
      `SELECT * FROM post_bump_records WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      q.limit,
      q.offset,
    ).map(mapRow);
    return {
      records,
      total,
      hasMore: q.offset + records.length < total,
      dailyStats: this.computeWeeklyDailyStats(q.carrier),
      statusCounts: { total, confirmed: Math.max(0, total - failed - pending), pending, failed },
    };
  }
  private computeWeeklyDailyStats(
    carrier: 'all' | PB.PostBumpCarrierValue,
  ): PB.PostBumpDailyStat[] {
    const startMs = Q.localDayStartMs(Date.now()) - 6 * 86_400_000,
      byDay = new Map<string, PB.PostBumpDailyStat>();
    for (let i = 0; i < 7; i++) {
      const d = Q.formatLocalYmd(new Date(startMs + i * 86_400_000));
      byDay.set(d, { dateKey: d, posts: 0, bumps: 0, failures: 0 });
    }
    const sql =
      carrier === 'all'
        ? 'SELECT created_at, record_type, status FROM post_bump_records WHERE created_at >= ?'
        : 'SELECT created_at, record_type, status FROM post_bump_records WHERE created_at >= ? AND carrier = ?';
    const rows =
      carrier === 'all'
        ? Q.allRows(this.db, sql, startMs)
        : Q.allRows(this.db, sql, startMs, carrier);
    for (const r of rows) {
      const b = byDay.get(Q.formatLocalYmd(new Date(Q.n(r.created_at))));
      if (b) {
        if (r.status === 'failed') b.failures++;
        else if (r.record_type === 'post') b.posts++;
        else b.bumps++;
      }
    }
    return [...byDay.values()];
  }
  deleteByIds = (ids: readonly string[]): { deleted: number } => ({
    deleted: Q.deleteByJsonIds(this.db, 'post_bump_records', 'id', [
      ...new Set(ids.map((i) => i.trim()).filter(Boolean)),
    ]),
  });
  clear(recordType?: PB.PostBumpRecordQueryTypeValue): { deleted: number } {
    const f = !recordType || recordType === 'all' ? null : recordType;
    const res =
      f === 'bump_all'
        ? Q.run(
            this.db,
            "DELETE FROM post_bump_records WHERE record_type IN ('group_bump', 'page_bump')",
          )
        : f
          ? Q.run(this.db, 'DELETE FROM post_bump_records WHERE record_type=?', f)
          : Q.run(this.db, 'DELETE FROM post_bump_records');
    return { deleted: Number(res.changes ?? 0) };
  }
  todayStats(nowMs = Date.now()): PB.TodayStatsSummary {
    const startMs = Q.localDayStartMs(nowMs),
      sql = `SELECT COALESCE(SUM(CASE WHEN status='success' AND record_type='post' THEN 1 ELSE 0 END), 0) AS posts, COALESCE(SUM(CASE WHEN status='success' AND record_type='group_bump' THEN 1 ELSE 0 END), 0) AS group_bumps, COALESCE(SUM(CASE WHEN status='success' AND record_type='page_bump' THEN 1 ELSE 0 END), 0) AS page_bumps, COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failures FROM post_bump_records WHERE created_at >= ?`,
      agg = Q.getRow(this.db, sql, startMs);
    const invSql = 'SELECT COUNT(*) AS n FROM group_inviter_logs WHERE invited_at >= ?';
    const invites = Q.sqliteTableExists(this.db, 'group_inviter_logs')
      ? Q.countSql(this.db, invSql, startMs)
      : 0;
    const posts = Q.n(agg?.posts),
      groupBumps = Q.n(agg?.group_bumps),
      pageBumps = Q.n(agg?.page_bumps);
    return {
      dateKey: Q.formatLocalYmd(new Date(startMs)),
      posts,
      groupBumps,
      pageBumps,
      bumps: groupBumps + pageBumps,
      invites,
      failures: Q.n(agg?.failures),
    };
  }
}
