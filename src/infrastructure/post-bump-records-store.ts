import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { normalizeRecordAccountId } from '../shared/activity-stats.js';
import * as PB from '../shared/post-bump-records.js';
import type { BumperLog } from '../shared/group-bumper.js';
import type { PosterLog } from '../shared/group-poster.js';
import { stripAnsi } from '../shared/relative-post-age.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { transaction } from './sqlite-transaction.js';
import { loadKnownAvatarSets, recordAvatarURL } from './record-avatar-store.js';
export const sqliteTableExists = Q.sqliteTableExists;
const runIfExists = (db: DatabaseSync, tbl: string, sql: string, args: SQLInputValue[] = []) => {
  if (Q.sqliteTableExists(db, tbl)) Q.run(db, sql, ...args);
};
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
  const normRaw = normalizeRecordAccountId(clean(rawId));
  let accountId = normRaw.accountId,
    accountName = clean(rawName) || normRaw.extractedName;
  if (Q.sqliteTableExists(db, 'profile_account_cache')) {
    const sql = accountId
      ? 'SELECT account_id, account_name FROM profile_account_cache WHERE profile_id=? AND account_id=? LIMIT 1'
      : 'SELECT account_id, account_name FROM profile_account_cache WHERE profile_id=? LIMIT 1';
    const c = accountId ? Q.getRow(db, sql, profileId, accountId) : Q.getRow(db, sql, profileId);
    const normPac = normalizeRecordAccountId(Q.nonEmptyTrimmed(c?.account_id) ?? '');
    accountId ||= normPac.accountId;
    accountName ||= Q.nonEmptyTrimmed(c?.account_name) ?? normPac.extractedName;
  }
  if ((!accountId || !accountName) && Q.sqliteTableExists(db, 'bluestacks_instances')) {
    const sql =
      'SELECT numeric_account_id, account_id, account_name, alias, display_name FROM bluestacks_instances WHERE id=? LIMIT 1';
    const bs = Q.getRow(db, sql, profileId);
    const normBs = normalizeRecordAccountId(
      Q.nonEmptyTrimmed(bs?.numeric_account_id) || Q.nonEmptyTrimmed(bs?.account_id) || '',
    );
    accountId ||= normBs.accountId;
    accountName ||=
      Q.nonEmptyTrimmed(bs?.account_name) ||
      normBs.extractedName ||
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
const mapRow = (
  r: Record<string, unknown>,
  winNames: ReadonlyMap<string, string>,
  avatars: ReturnType<typeof loadKnownAvatarSets>,
): PB.PostBumpRecord => {
  const base = Q.camel(r, 'liked,story_shared');
  const normAcc = normalizeRecordAccountId(Q.s(r.account_id));
  const pid = Q.s(r.profile_id),
    accId = normAcc.accountId,
    accName = Q.s(r.account_name).trim() || normAcc.extractedName,
    pageId = Q.s(r.page_id).trim(),
    groupId = Q.s(r.group_id).trim();
  const accountAvatarUrl =
    accId && avatars.accounts.has(accId)
      ? recordAvatarURL('account', accId)
      : accId && avatars.pages.has(accId)
        ? recordAvatarURL('page', accId)
        : '';
  const pageAvatarUrl = pageId && avatars.pages.has(pageId) ? recordAvatarURL('page', pageId) : '';
  const groupAvatarUrl =
    groupId && avatars.groups.has(groupId) ? recordAvatarURL('group', groupId) : '';
  return PB.PostBumpRecordSchema.parse({
    ...base,
    accountId: accId,
    accountName: accName,
    errorReason: stripAnsi(Q.s(r.error_reason)),
    windowName: winNames.get(pid) ?? pid,
    accountAvatarUrl,
    pageAvatarUrl,
    groupAvatarUrl,
  });
};
function loadWindowNamesMap(db: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>();
  const sources: ReadonlyArray<[string, string, (r: Record<string, unknown>) => [string, string]]> =
    [
      [
        'profile_launch_bindings',
        'SELECT profile_id, browser_name, window_name FROM profile_launch_bindings',
        (r) => [Q.s(r.profile_id), Q.s(r.browser_name).trim() || Q.s(r.window_name).trim()],
      ],
      [
        'profile_metadata',
        'SELECT profile_id, alias FROM profile_metadata',
        (r) => [Q.s(r.profile_id), Q.s(r.alias).trim()],
      ],
      [
        'bluestacks_instances',
        'SELECT id, instance_key, display_name, alias FROM bluestacks_instances',
        (r) => [
          Q.s(r.id),
          Q.s(r.alias).trim() || Q.s(r.display_name).trim() || Q.s(r.instance_key),
        ],
      ],
    ];
  for (const [tbl, sql, pick] of sources) {
    if (!Q.sqliteTableExists(db, tbl)) continue;
    for (const r of Q.allRows(db, sql)) {
      const [id, name] = pick(r);
      if (id && name) map.set(id, name);
    }
  }
  return map;
}
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
      ),
      sourceLogId = p.sourceLogId?.trim() || null,
      errorReason = stripAnsi(p.errorReason).trim();
    if (p.status === 'failed') {
      const existing =
        (sourceLogId
          ? Q.getRow(
              this.db,
              'SELECT * FROM post_bump_records WHERE record_type=? AND source_log_id=? LIMIT 1',
              p.recordType,
              sourceLogId,
            )
          : undefined) ??
        (p.id
          ? Q.getRow(this.db, 'SELECT * FROM post_bump_records WHERE id=? LIMIT 1', p.id)
          : undefined);
      if (existing)
        return mapRow(existing, loadWindowNamesMap(this.db), loadKnownAvatarSets(this.db));
    }
    const rawInsert = {
      ...p,
      id: p.id ?? randomUUID(),
      accountId,
      accountName,
      groupId: clean(p.groupId),
      groupName: clean(p.groupName),
      pageId: clean(p.pageId),
      pageName: clean(p.pageName),
      errorReason,
      sourceLogId,
      createdAt: p.createdAt ?? Date.now(),
    };
    const cols =
      'id,record_type,carrier,status,profile_id,account_id,account_name,group_id,group_name,page_id,page_name,post_id,post_url,liked,comment_text,story_shared,caption_preview,error_reason,source_log_id,created_at';
    Q.insertFrom(
      this.db,
      'post_bump_records',
      cols,
      rawInsert,
      undefined,
      p.status === 'failed' ? 'INSERT OR IGNORE INTO' : 'INSERT OR REPLACE INTO',
    );
    return {
      ...rawInsert,
      windowName: '',
      accountAvatarUrl: '',
      pageAvatarUrl: '',
      groupAvatarUrl: '',
    };
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
    const pushKw = (expr: string, raw: string) => {
      const kw = raw.trim().toLowerCase();
      if (!kw) return;
      clauses.push(`instr(lower(${expr}), ?) > 0`);
      params.push(kw);
    };
    pushKw(
      "account_name||' '||account_id||' '||group_name||' '||group_id||' '||page_name||' '||page_id||' '||post_url||' '||caption_preview||' '||COALESCE(comment_text,'')||' '||error_reason",
      q.search,
    );
    pushKw("account_name||' '||account_id||' '||profile_id", q.accountQuery);
    pushKw("group_name||' '||group_id", q.groupQuery);
    pushKw("page_name||' '||page_id", q.pageQuery);
    pushKw("post_url||' '||post_id", q.postUrlQuery);
    const whereSql = clauses.join(' AND ');
    const countSql = `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count, SUM(CASE WHEN status = 'success' AND record_type = 'post' AND (post_id = 'pending_approval' OR post_id LIKE 'pending-%') THEN 1 ELSE 0 END) AS pending_count FROM post_bump_records WHERE ${whereSql}`;
    const countRow = Q.getRow(this.db, countSql, ...params),
      total = Q.n(countRow?.n),
      failed = Q.n(countRow?.failed_count),
      pending = Q.n(countRow?.pending_count);
    const winNames = loadWindowNamesMap(this.db),
      avatars = loadKnownAvatarSets(this.db);
    const records = Q.allRows(
      this.db,
      `SELECT * FROM post_bump_records WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      q.limit,
      q.offset,
    ).map((r) => mapRow(r, winNames, avatars));
    return {
      records,
      total,
      hasMore: q.offset + records.length < total,
      statusCounts: { total, confirmed: Math.max(0, total - failed - pending), pending, failed },
    };
  }
  private syncDerivedTargetAndUsageCounts() {
    for (const [tbl1, tbl2, sql] of [
      [
        'shared_facebook_groups',
        'group_poster_usage',
        'UPDATE shared_facebook_groups SET posted_count=(SELECT COUNT(*) FROM group_poster_usage WHERE group_poster_usage.group_id=shared_facebook_groups.group_id)',
      ],
      [
        'shared_facebook_groups',
        'group_bumper_effects',
        'UPDATE shared_facebook_groups SET bumped_count=(SELECT COUNT(*) FROM group_bumper_effects WHERE group_bumper_effects.group_id=shared_facebook_groups.group_id)',
      ],
      [
        'group_bumper_pages',
        'group_bumper_effects',
        'UPDATE group_bumper_pages SET total_bumped_count=(SELECT COUNT(*) FROM group_bumper_effects WHERE group_bumper_effects.page_id=group_bumper_pages.page_id)',
      ],
      [
        'group_poster_materials',
        'group_poster_usage',
        'UPDATE group_poster_materials SET used_count=(SELECT COUNT(*) FROM group_poster_usage WHERE group_poster_usage.material_id=group_poster_materials.id)',
      ],
    ] as const)
      if (Q.sqliteTableExists(this.db, tbl1)) runIfExists(this.db, tbl2, sql);
  }
  deleteByIds = (ids: readonly string[]): { deleted: number } => {
    const uniq = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
    if (!uniq.length) return { deleted: 0 };
    return transaction(this.db, () => {
      const targets = Q.allRows(
        this.db,
        'SELECT id, record_type, source_log_id FROM post_bump_records WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(uniq),
      );
      const logIds = [
        ...new Set(targets.map((r) => Q.sn(r.source_log_id)).filter((v): v is string => !!v)),
      ];
      if (logIds.length > 0) {
        const logJson = JSON.stringify(logIds);
        for (const [tbl, sql] of [
          [
            'group_poster_usage',
            'DELETE FROM group_poster_usage WHERE log_id IN (SELECT value FROM json_each(?))',
          ],
          [
            'group_bumper_effects',
            'DELETE FROM group_bumper_effects WHERE log_id IN (SELECT value FROM json_each(?))',
          ],
          [
            'group_poster_operations',
            "DELETE FROM group_poster_operations WHERE kernel_settled=1 AND status='VERIFIED' AND log_id IN (SELECT value FROM json_each(?))",
          ],
          [
            'group_bumper_operations',
            "DELETE FROM group_bumper_operations WHERE status='SETTLED' AND log_id IN (SELECT value FROM json_each(?))",
          ],
        ] as const)
          runIfExists(this.db, tbl, sql, [logJson]);
      }
      const deleted = Q.deleteByJsonIds(this.db, 'post_bump_records', 'id', uniq);
      this.syncDerivedTargetAndUsageCounts();
      return { deleted };
    });
  };
  clear(recordType?: PB.PostBumpRecordQueryTypeValue): { deleted: number } {
    const f = !recordType || recordType === 'all' ? null : recordType;
    return transaction(this.db, () => {
      const clearPosts = f === null || f === 'post',
        clearGroupBumps = f === null || f === 'bump_all' || f === 'group_bump',
        clearPageBumps = f === null || f === 'bump_all' || f === 'page_bump';
      if (clearPosts) {
        runIfExists(this.db, 'group_poster_usage', 'DELETE FROM group_poster_usage');
        runIfExists(
          this.db,
          'group_poster_operations',
          "DELETE FROM group_poster_operations WHERE kernel_settled=1 AND status='VERIFIED'",
        );
      }
      if (clearGroupBumps && clearPageBumps) {
        runIfExists(this.db, 'group_bumper_effects', 'DELETE FROM group_bumper_effects');
        runIfExists(
          this.db,
          'group_bumper_operations',
          "DELETE FROM group_bumper_operations WHERE status='SETTLED'",
        );
      } else if (clearGroupBumps || clearPageBumps) {
        const sm = clearPageBumps ? 'page' : 'group';
        runIfExists(
          this.db,
          'group_bumper_effects',
          'DELETE FROM group_bumper_effects WHERE source_mode=?',
          [sm],
        );
        runIfExists(
          this.db,
          'group_bumper_operations',
          sm === 'page'
            ? "DELETE FROM group_bumper_operations WHERE status='SETTLED' AND group_id='-'"
            : "DELETE FROM group_bumper_operations WHERE status='SETTLED' AND group_id<>'-'",
        );
      }
      const res =
        f === 'bump_all'
          ? Q.run(
              this.db,
              "DELETE FROM post_bump_records WHERE record_type IN ('group_bump', 'page_bump')",
            )
          : f
            ? Q.run(this.db, 'DELETE FROM post_bump_records WHERE record_type=?', f)
            : Q.run(this.db, 'DELETE FROM post_bump_records');
      this.syncDerivedTargetAndUsageCounts();
      return { deleted: Number(res.changes ?? 0) };
    });
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
