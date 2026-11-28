import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  ActivityStatsQuerySchema,
  emptyActivityTotals,
  normalizeRecordAccountId,
  type AccountActivityRow,
  type ActivityStatsQuery,
  type ActivityStatsResponse,
  type ActivitySummaryTotals,
  type RecordDailyActivityInput,
} from '../shared/activity-stats.js';
import { BluestacksRiskLimitSettings } from '../shared/bluestacks.js';
import {
  DailyRiskLimitSettingsSchema,
  aggregateDailyUsageOverview,
  computeTotalDailyActions,
  evaluateDailyRiskQuota,
  type BrowserRiskLimitsState,
  type DailyRiskActionKind,
  type DailyRiskLimitSettings,
  type DailyUsageOverview,
  type RawDailyActionCounts,
} from '../shared/daily-risk-limits.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { loadKnownAvatarSets, recordAvatarURL } from './record-avatar-store.js';
const STAT_NUM_KEYS = [
  'posts',
  'pendingPosts',
  'groupBumps',
  'pageBumps',
  'bumps',
  'invites',
  'activeDurationMs',
  'activeLikes',
  'activeFriends',
  'failures',
  'totalActions',
] as const;
function addStatsCounts(dst: ActivitySummaryTotals, src: ActivitySummaryTotals) {
  for (const k of STAT_NUM_KEYS) dst[k] += src[k];
}
const emptyRawCounts = (): RawDailyActionCounts => ({
  groupBumpsToday: 0,
  pageBumpsToday: 0,
  postsToday: 0,
  invitesToday: 0,
  activeLikesToday: 0,
  activeActionsToday: 0,
  activeFriendsToday: 0,
});
export function ensureActivityStatsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_daily_activity_stats(ymd TEXT NOT NULL, carrier TEXT NOT NULL CHECK(carrier IN ('browser','bluestacks')), profile_id TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', active_duration_ms INTEGER NOT NULL DEFAULT 0, active_likes INTEGER NOT NULL DEFAULT 0, active_friends INTEGER NOT NULL DEFAULT 0, active_actions INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(ymd, carrier, profile_id));
    CREATE INDEX IF NOT EXISTS idx_account_daily_activity_ymd ON account_daily_activity_stats(ymd, carrier, profile_id);
    CREATE TABLE IF NOT EXISTS browser_risk_limit_settings(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO browser_risk_limit_settings(id, body, updated_at) VALUES(1, '{}', 0);
  `);
}
export function backfillActivityStatsV63(db: DatabaseSync): void {
  ensureActivityStatsSchema(db);
  if (Q.sqliteTableExists(db, 'task_steps') && Q.sqliteTableExists(db, 'task_plans')) {
    const sql = `SELECT p.profile_id, COALESCE(p.account_id, '') AS account_id, COALESCE(p.updated_at, p.created_at) AS ts,
      COALESCE(CAST(json_extract(s.progress, '$.effectiveMilliseconds') AS INTEGER), 0) AS dur,
      COALESCE(CAST(json_extract(s.progress, '$.likes') AS INTEGER), 0) AS likes,
      COALESCE(CAST(json_extract(s.progress, '$.accepted') AS INTEGER), 0) AS friends
      FROM task_steps s JOIN task_plans p ON p.id = s.job_id WHERE json_extract(s.spec, '$.type') <> 'post'`;
    const grouped = new Map<
      string,
      {
        ymd: string;
        profileId: string;
        accountId: string;
        dur: number;
        likes: number;
        friends: number;
        ts: number;
      }
    >();
    for (const r of Q.allRows(db, sql)) {
      const pid = Q.s(r.profile_id),
        ts = Q.n(r.ts),
        dur = Math.max(0, Q.n(r.dur)),
        likes = Math.max(0, Q.n(r.likes)),
        friends = Math.max(0, Q.n(r.friends));
      if (!pid || (!dur && !likes && !friends)) continue;
      const ymd = Q.formatLocalYmd(new Date(ts || Date.now())),
        key = `${ymd}|${pid}`,
        cur = grouped.get(key) ?? {
          ymd,
          profileId: pid,
          accountId: '',
          dur: 0,
          likes: 0,
          friends: 0,
          ts: 0,
        };
      cur.dur += dur;
      cur.likes += likes;
      cur.friends += friends;
      if (ts > cur.ts) cur.ts = ts;
      if (Q.s(r.account_id)) cur.accountId = Q.s(r.account_id);
      grouped.set(key, cur);
    }
    const ins = db.prepare(
      'INSERT OR IGNORE INTO account_daily_activity_stats(ymd, carrier, profile_id, account_id, active_duration_ms, active_likes, active_friends, active_actions, last_active_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    for (const g of grouped.values())
      ins.run(
        g.ymd,
        'browser',
        g.profileId,
        g.accountId,
        g.dur,
        g.likes,
        g.friends,
        g.likes + g.friends,
        g.ts || null,
        g.ts || Date.now(),
      );
  }
  if (Q.sqliteTableExists(db, 'bluestacks_daily_actions')) {
    db.exec(`
      INSERT OR IGNORE INTO account_daily_activity_stats(ymd, carrier, profile_id, account_id, active_duration_ms, active_likes, active_friends, active_actions, last_active_at, updated_at)
      SELECT d.ymd, 'bluestacks', d.instance_id, COALESCE(b.account_id, ''), 0, d.active_likes, 0, d.active_actions, d.updated_at, d.updated_at
      FROM bluestacks_daily_actions d LEFT JOIN bluestacks_instances b ON b.id = d.instance_id;
    `);
  }
}
interface ProfileMetaRow {
  carrier: 'browser' | 'bluestacks';
  profileId: string;
  windowName: string;
  accountId: string;
  accountName: string;
}
function loadKnownTargetMeta(db: DatabaseSync) {
  const map = new Map<string, ProfileMetaRow>(),
    bsIds = new Set<string>();
  const touch = (carrier: 'browser' | 'bluestacks', profileId: string) => {
    const key = `${carrier}:${profileId}`;
    let cur = map.get(key);
    if (!cur)
      map.set(key, (cur = { carrier, profileId, windowName: '', accountId: '', accountName: '' }));
    return cur;
  };
  const scanBrowser = (
    table: string,
    sql: string,
    fn: (r: Record<string, unknown>, cur: ProfileMetaRow) => void,
  ) => {
    if (!Q.sqliteTableExists(db, table)) return;
    for (const r of Q.allRows(db, sql)) {
      const id = Q.s(r.profile_id);
      if (id && !bsIds.has(id)) fn(r, touch('browser', id));
    }
  };
  if (Q.sqliteTableExists(db, 'bluestacks_instances')) {
    for (const r of Q.allRows(
      db,
      'SELECT id, instance_key, display_name, alias, account_id, numeric_account_id, account_name FROM bluestacks_instances',
    )) {
      const id = Q.s(r.id);
      if (!id) continue;
      bsIds.add(id);
      const cur = touch('bluestacks', id),
        norm = normalizeRecordAccountId(
          Q.s(r.numeric_account_id).trim() || Q.s(r.account_id).trim(),
        );
      cur.windowName = Q.s(r.alias).trim() || Q.s(r.display_name).trim() || Q.s(r.instance_key);
      cur.accountId = norm.accountId;
      cur.accountName = Q.s(r.account_name).trim() || norm.extractedName;
    }
  }
  scanBrowser(
    'profile_launch_bindings',
    'SELECT profile_id, browser_name, window_name FROM profile_launch_bindings',
    (r, cur) => {
      const bName = Q.s(r.browser_name).trim() || Q.s(r.window_name).trim();
      if (bName) cur.windowName = bName;
    },
  );
  scanBrowser('profile_metadata', 'SELECT profile_id, alias FROM profile_metadata', (r, cur) => {
    const alias = Q.s(r.alias).trim();
    if (alias) cur.windowName = alias;
  });
  scanBrowser(
    'profile_account_cache',
    'SELECT profile_id, account_id, account_name FROM profile_account_cache',
    (r, cur) => {
      const norm = normalizeRecordAccountId(Q.s(r.account_id));
      cur.accountId = cur.accountId || norm.accountId;
      cur.accountName = cur.accountName || Q.s(r.account_name).trim() || norm.extractedName;
    },
  );
  return { list: [...map.values()], byKey: map, bsIds };
}
function makeEmptyAccRow(
  rowKey: string,
  carrier: 'browser' | 'bluestacks',
  meta?: ProfileMetaRow,
  profileId = '',
): AccountActivityRow {
  return {
    rowKey,
    carrier,
    profileId: meta?.profileId ?? profileId,
    windowName: meta?.windowName || meta?.profileId || profileId,
    accountId: meta?.accountId ?? '',
    accountName: meta?.accountName ?? '',
    accountAvatarUrl: '',
    ...emptyActivityTotals(),
    lastActiveAt: null,
    dailyLimitReached: false,
    dailyLimitReason: null,
  };
}
function collectCarrierDailyCounts(
  db: DatabaseSync,
  carrier: 'browser' | 'bluestacks',
  seedIds: Iterable<string>,
  bsIds: ReadonlySet<string>,
  dayStartMs: number,
  dateYmd: string,
  autoCreate: boolean,
): Map<string, RawDailyActionCounts> {
  const counts = new Map<string, RawDailyActionCounts>();
  const getSlot = (id: string) => {
    let c = counts.get(id);
    if (!c && autoCreate) counts.set(id, (c = emptyRawCounts()));
    return c;
  };
  for (const id of seedIds) counts.set(id, emptyRawCounts());
  if (Q.sqliteTableExists(db, 'post_bump_records')) {
    for (const r of Q.allRows(
      db,
      "SELECT profile_id, record_type, COUNT(*) n FROM post_bump_records WHERE carrier=? AND status='success' AND created_at>=? GROUP BY profile_id, record_type",
      carrier,
      dayStartMs,
    )) {
      const pid = Q.s(r.profile_id),
        c = pid ? getSlot(pid) : undefined;
      if (!c) continue;
      const rt = Q.s(r.record_type);
      if (rt === 'post') c.postsToday += Q.n(r.n);
      else if (rt === 'page_bump') c.pageBumpsToday += Q.n(r.n);
      else c.groupBumpsToday += Q.n(r.n);
    }
  }
  if (Q.sqliteTableExists(db, 'group_inviter_logs')) {
    for (const r of Q.allRows(
      db,
      "SELECT profile_id, COUNT(*) n FROM group_inviter_logs WHERE invited_at>=? AND confirmation='CONFIRMED' GROUP BY profile_id",
      dayStartMs,
    )) {
      const pid = Q.s(r.profile_id);
      if (!pid || (carrier === 'browser' && bsIds.has(pid))) continue;
      const c = getSlot(pid);
      if (c) c.invitesToday += Q.n(r.n);
    }
  }
  const useBsDaily =
    carrier === 'bluestacks' && Q.sqliteTableExists(db, 'bluestacks_daily_actions');
  const actSql = useBsDaily
    ? 'SELECT instance_id AS id, active_likes, 0 AS active_friends, active_actions FROM bluestacks_daily_actions WHERE ymd=?'
    : 'SELECT profile_id AS id, active_likes, active_friends, active_actions FROM account_daily_activity_stats WHERE ymd=? AND carrier=?';
  const rows = useBsDaily
    ? Q.allRows(db, actSql, dateYmd)
    : Q.allRows(db, actSql, dateYmd, carrier);
  for (const r of rows) {
    const pid = Q.s(r.id),
      c = pid ? getSlot(pid) : undefined;
    if (!c) continue;
    c.activeLikesToday += Q.n(r.active_likes);
    c.activeFriendsToday = (c.activeFriendsToday ?? 0) + Q.n(r.active_friends);
    c.activeActionsToday += Q.n(r.active_actions);
  }
  return counts;
}
export class SqliteActivityStatsRepository {
  constructor(private readonly db: DatabaseSync) {
    ensureActivityStatsSchema(db);
  }
  recordDailyActivity(input: RecordDailyActivityInput): void {
    const at = input.at ?? Date.now(),
      ymd = input.ymd || Q.formatLocalYmd(new Date(at)),
      dur = Math.max(0, Math.round(input.durationMsDelta ?? 0)),
      likes = Math.max(0, Math.round(input.likesDelta ?? 0)),
      friends = Math.max(0, Math.round(input.friendsDelta ?? 0)),
      acts = Math.max(0, Math.round(input.actionsDelta ?? likes + friends));
    if (!input.profileId || (!dur && !likes && !friends && !acts)) return;
    const sql = `INSERT INTO account_daily_activity_stats(ymd, carrier, profile_id, account_id, active_duration_ms, active_likes, active_friends, active_actions, last_active_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ymd, carrier, profile_id) DO UPDATE SET
        account_id=CASE WHEN excluded.account_id<>'' THEN excluded.account_id ELSE account_daily_activity_stats.account_id END,
        active_duration_ms=active_duration_ms+excluded.active_duration_ms,
        active_likes=active_likes+excluded.active_likes, active_friends=active_friends+excluded.active_friends,
        active_actions=active_actions+excluded.active_actions,
        last_active_at=MAX(COALESCE(last_active_at, 0), excluded.last_active_at), updated_at=excluded.updated_at`;
    Q.run(
      this.db,
      sql,
      ymd,
      input.carrier,
      input.profileId,
      (input.accountId ?? '').trim(),
      dur,
      likes,
      friends,
      acts,
      at,
      at,
    );
  }
  getBrowserRiskLimits = (): DailyRiskLimitSettings =>
    Q.readSingletonJson(
      this.db,
      'browser_risk_limit_settings',
      'body',
      (o) => DailyRiskLimitSettingsSchema.parse(o),
      () => DailyRiskLimitSettingsSchema.parse({}),
    );
  saveBrowserRiskLimits(input: unknown): DailyRiskLimitSettings {
    const parsed = DailyRiskLimitSettingsSchema.parse(input);
    Q.run(
      this.db,
      'UPDATE browser_risk_limit_settings SET body=?, updated_at=? WHERE id=1',
      JSON.stringify(parsed),
      Date.now(),
    );
    return parsed;
  }
  browserDailyUsage(now = Date.now()): DailyUsageOverview {
    const dateYmd = Q.formatLocalYmd(new Date(now)),
      dayStartMs = Q.localDayStartMs(now),
      settings = this.getBrowserRiskLimits(),
      { list, bsIds } = loadKnownTargetMeta(this.db),
      counts = collectCarrierDailyCounts(
        this.db,
        'browser',
        list.filter((m) => m.carrier === 'browser').map((m) => m.profileId),
        bsIds,
        dayStartMs,
        dateYmd,
        true,
      );
    return aggregateDailyUsageOverview(
      dateYmd,
      counts,
      settings,
      settings.perTargetOverrides,
      '浏览器',
    );
  }
  browserRiskLimitsState = (now = Date.now()): BrowserRiskLimitsState => ({
    settings: this.getBrowserRiskLimits(),
    dailyUsage: this.browserDailyUsage(now),
  });
  checkBrowserRiskLimit(
    profileId: string,
    actionKind: DailyRiskActionKind,
    now = Date.now(),
  ): { allowed: boolean; reason: string | null } {
    const settings = this.getBrowserRiskLimits();
    if (!settings.enabled) return { allowed: true, reason: null };
    const usage = this.browserDailyUsage(now).perTarget[profileId] ?? emptyRawCounts();
    const ev = evaluateDailyRiskQuota(
      settings,
      settings.perTargetOverrides,
      profileId,
      usage,
      actionKind,
      '浏览器',
    );
    return { allowed: ev.allowed, reason: ev.reason };
  }
  queryStats(queryInput: ActivityStatsQuery = {}): ActivityStatsResponse {
    const q = ActivityStatsQuerySchema.parse(queryInput),
      { list, byKey, bsIds } = loadKnownTargetMeta(this.db),
      avatars = loadKnownAvatarSets(this.db),
      profileRows = new Map<string, AccountActivityRow>();
    const ensureProfile = (
      carrier: 'browser' | 'bluestacks',
      profileId: string,
      hintAccId = '',
      hintAccName = '',
    ) => {
      const key = `${carrier}:${profileId}`;
      let row = profileRows.get(key);
      if (!row)
        profileRows.set(key, (row = makeEmptyAccRow(key, carrier, byKey.get(key), profileId)));
      const normHint = normalizeRecordAccountId(hintAccId);
      if (!row.accountId && normHint.accountId) row.accountId = normHint.accountId;
      if (!row.accountName) row.accountName = hintAccName.trim() || normHint.extractedName;
      return row;
    };
    const bumpLast = (row: AccountActivityRow, rawAt: unknown) => {
      const lastAt = Q.nn(rawAt);
      if (lastAt && (!row.lastActiveAt || lastAt > row.lastActiveAt)) row.lastActiveAt = lastAt;
    };
    for (const m of list)
      if (q.carrier === 'all' || q.carrier === m.carrier) ensureProfile(m.carrier, m.profileId);
    const timeConds = (col: string, mapVal: (ms: number) => SQLInputValue = (ms) => ms) => {
      const parts: string[] = [],
        params: SQLInputValue[] = [];
      if (q.from !== undefined) {
        parts.push(`${col} >= ?`);
        params.push(mapVal(q.from));
      }
      if (q.to !== undefined) {
        parts.push(`${col} <= ?`);
        params.push(mapVal(q.to));
      }
      return { parts, params };
    };
    if (Q.sqliteTableExists(this.db, 'post_bump_records')) {
      const tc = timeConds('created_at'),
        clauses = ['1=1', ...tc.parts],
        params = [...tc.params];
      if (q.carrier !== 'all') {
        clauses.push('carrier = ?');
        params.push(q.carrier);
      }
      const sql = `SELECT carrier, profile_id, MAX(NULLIF(account_id,'')) AS account_id, MAX(NULLIF(account_name,'')) AS account_name,
        SUM(CASE WHEN status='success' AND record_type='post' THEN 1 ELSE 0 END) AS posts,
        SUM(CASE WHEN status='success' AND record_type='post' AND (post_id='pending_approval' OR post_id LIKE 'pending-%') THEN 1 ELSE 0 END) AS pending_posts,
        SUM(CASE WHEN status='success' AND record_type='group_bump' THEN 1 ELSE 0 END) AS group_bumps,
        SUM(CASE WHEN status='success' AND record_type='page_bump' THEN 1 ELSE 0 END) AS page_bumps,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures, MAX(created_at) AS last_at
        FROM post_bump_records WHERE ${clauses.join(' AND ')} GROUP BY carrier, profile_id`;
      for (const r of Q.allRows(this.db, sql, ...params)) {
        const pid = Q.s(r.profile_id);
        if (!pid) continue;
        const row = ensureProfile(
          Q.s(r.carrier) === 'bluestacks' ? 'bluestacks' : 'browser',
          pid,
          Q.s(r.account_id),
          Q.s(r.account_name),
        );
        row.posts += Q.n(r.posts);
        row.pendingPosts += Q.n(r.pending_posts);
        row.groupBumps += Q.n(r.group_bumps);
        row.pageBumps += Q.n(r.page_bumps);
        row.failures += Q.n(r.failures);
        bumpLast(row, r.last_at);
      }
    }
    if (Q.sqliteTableExists(this.db, 'group_inviter_logs')) {
      const tc = timeConds('invited_at'),
        sql = `SELECT profile_id, MAX(NULLIF(account_id,'')) AS account_id, COUNT(*) AS cnt, MAX(invited_at) AS last_at
          FROM group_inviter_logs WHERE ${["confirmation='CONFIRMED'", ...tc.parts].join(' AND ')} GROUP BY profile_id`;
      for (const r of Q.allRows(this.db, sql, ...tc.params)) {
        const pid = Q.s(r.profile_id);
        if (!pid) continue;
        const carrier = bsIds.has(pid) ? 'bluestacks' : 'browser';
        if (q.carrier !== 'all' && q.carrier !== carrier) continue;
        const row = ensureProfile(carrier, pid, Q.s(r.account_id));
        row.invites += Q.n(r.cnt);
        bumpLast(row, r.last_at);
      }
    }
    const actTc = timeConds('ymd', (ms) => Q.formatLocalYmd(new Date(ms))),
      actClauses = ['1=1', ...actTc.parts],
      actParams = [...actTc.params];
    if (q.carrier !== 'all') {
      actClauses.push('carrier = ?');
      actParams.push(q.carrier);
    }
    const actSql = `SELECT carrier, profile_id, MAX(NULLIF(account_id,'')) AS account_id,
      SUM(active_duration_ms) AS dur, SUM(active_likes) AS likes, SUM(active_friends) AS friends,
      MAX(COALESCE(last_active_at, updated_at)) AS last_at
      FROM account_daily_activity_stats WHERE ${actClauses.join(' AND ')} GROUP BY carrier, profile_id`;
    for (const r of Q.allRows(this.db, actSql, ...actParams)) {
      const pid = Q.s(r.profile_id);
      if (!pid) continue;
      const row = ensureProfile(
        Q.s(r.carrier) === 'bluestacks' ? 'bluestacks' : 'browser',
        pid,
        Q.s(r.account_id),
      );
      row.activeDurationMs += Math.max(0, Q.n(r.dur));
      row.activeLikes += Math.max(0, Q.n(r.likes));
      row.activeFriends += Math.max(0, Q.n(r.friends));
      bumpLast(row, r.last_at);
    }
    const browserUsage = this.browserDailyUsage().perTarget;
    let bsUsage: Record<string, { limitReached: boolean; limitReason: string | null }> = {};
    if (Q.sqliteTableExists(this.db, 'bluestacks_settings')) {
      const rawRisk = Q.getRow(
        this.db,
        'SELECT risk_limit_settings FROM bluestacks_settings WHERE id=1',
      )?.risk_limit_settings;
      const parsedBs =
        typeof rawRisk === 'string'
          ? Q.parseWithFallback(
              () => BluestacksRiskLimitSettings.parse(Q.parseJsonObject(rawRisk)),
              null,
            )
          : null;
      if (parsedBs) {
        const bsCounts = collectCarrierDailyCounts(
          this.db,
          'bluestacks',
          [...bsIds].filter((id) => profileRows.has(`bluestacks:${id}`)),
          bsIds,
          Q.localDayStartMs(),
          Q.formatLocalYmd(new Date()),
          false,
        );
        bsUsage = Object.fromEntries(
          [...bsCounts.entries()].map(([id, raw]) => {
            const ev = evaluateDailyRiskQuota(
              parsedBs,
              parsedBs.perInstanceOverrides,
              id,
              raw,
              undefined,
              '蓝蝶风控',
            );
            return [id, { limitReached: !ev.allowed, limitReason: ev.reason }];
          }),
        );
      }
    }
    for (const row of profileRows.values()) {
      row.bumps = row.groupBumps + row.pageBumps;
      row.totalActions = computeTotalDailyActions({
        groupBumpsToday: row.groupBumps,
        pageBumpsToday: row.pageBumps,
        postsToday: row.posts,
        invitesToday: row.invites,
        activeLikesToday: row.activeLikes,
        activeFriendsToday: row.activeFriends,
      });
      if (row.accountId && avatars.accounts.has(row.accountId))
        row.accountAvatarUrl = recordAvatarURL('account', row.accountId);
      const u = row.carrier === 'bluestacks' ? bsUsage[row.profileId] : browserUsage[row.profileId];
      if (u) {
        row.dailyLimitReached = u.limitReached;
        row.dailyLimitReason = u.limitReason;
      }
    }
    let finalRows = [...profileRows.values()];
    if (q.groupBy === 'account') {
      const grouped = new Map<string, AccountActivityRow>();
      for (const r of finalRows) {
        const gKey = r.accountId ? `acc:${r.accountId}` : `win:${r.rowKey}`,
          prev = grouped.get(gKey);
        if (!prev) {
          const names = r.windowName ? [r.windowName] : [];
          grouped.set(gKey, { ...r, rowKey: gKey, windowCount: 1, mergedWindowNames: names });
        } else {
          prev.carrier = prev.carrier === r.carrier ? prev.carrier : 'mixed';
          prev.windowCount = (prev.windowCount ?? 1) + 1;
          const names = prev.mergedWindowNames ?? (prev.windowName ? [prev.windowName] : []);
          if (r.windowName && !names.includes(r.windowName)) names.push(r.windowName);
          prev.mergedWindowNames = names;
          prev.windowName = names.join(' / ');
          if (!prev.accountName && r.accountName) prev.accountName = r.accountName;
          if (!prev.accountAvatarUrl && r.accountAvatarUrl)
            prev.accountAvatarUrl = r.accountAvatarUrl;
          addStatsCounts(prev, r);
          if (r.lastActiveAt && (!prev.lastActiveAt || r.lastActiveAt > prev.lastActiveAt))
            prev.lastActiveAt = r.lastActiveAt;
          prev.dailyLimitReached = prev.dailyLimitReached || r.dailyLimitReached;
          prev.dailyLimitReason = prev.dailyLimitReason ?? r.dailyLimitReason;
        }
      }
      finalRows = [...grouped.values()];
    }
    const kw = q.search.trim().toLowerCase();
    finalRows = finalRows
      .filter(
        (r) =>
          (!q.onlyActive || r.totalActions > 0 || r.activeDurationMs > 0 || r.failures > 0) &&
          (!kw ||
            `${r.windowName} ${r.accountName} ${r.accountId} ${r.profileId}`
              .toLowerCase()
              .includes(kw)),
      )
      .sort(
        (a, b) =>
          b.totalActions - a.totalActions ||
          b.activeDurationMs - a.activeDurationMs ||
          b.failures - a.failures ||
          a.windowName.localeCompare(b.windowName),
      );
    const totals = emptyActivityTotals();
    for (const r of finalRows) addStatsCounts(totals, r);
    return { totals, rows: finalRows };
  }
}
