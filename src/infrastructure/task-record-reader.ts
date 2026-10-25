import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ProductError } from '../domain/workspace.js';
import {
  compareRecords,
  projectTaskRecords,
  recordMatches,
  type RecordProfile,
} from '../domain/task-record-projection.js';
import {
  TaskRecords,
  TaskRecordsRequest,
  type Plan,
  type Event,
  type Operation,
  type StepInstance,
  type TaskRecord,
  type TaskRecordsResponse,
} from '../shared/task-contracts.js';
import { beforeCommit, readSnapshot, transaction } from './sqlite-transaction.js';

const terminal = "p.state IN ('STOPPED','COMPLETED','FAILED')";
const expression = (prefix: string) =>
  `CASE WHEN r.${prefix}u=0 THEN r.${prefix} WHEN r.${prefix} IS NULL THEN p.updated_at ELSE min(r.${prefix},p.updated_at) END`;
const started = `CASE WHEN ${terminal} THEN ${expression('es')} ELSE ${expression('ls')} END`;
const finished = `CASE WHEN ${terminal} THEN ${expression('ef')} ELSE ${expression('lf')} END`;
const sort = `coalesce(${finished},${started},r.created_at)`;
const current = `(r.status='ACTIVE' OR (r.status='PENDING' AND r.round=p.round AND r.position=p.position AND NOT (${terminal})))`;
const running = `(${current} AND p.state IN ('QUEUED','RUNNING','PAUSING','PAUSED','STOPPING'))`;
const completed = "r.status='COMPLETED'";
const failed =
  "(r.status='FAILED' OR (r.status='ACTIVE' AND p.state='FAILED' AND coalesce(r.outcome_kind,'')<>'SKIPPED'))";
const review = `(( ${current} AND (p.state='REVIEW' OR EXISTS(SELECT 1 FROM task_outbox o WHERE o.job_id=p.id AND o.status='UNKNOWN' AND o.disposition IS NULL) OR (p.state='QUEUED' AND p.profile_id IN (SELECT value FROM json_each(?))) OR p.state IN ('PAUSING','STOPPING') OR (p.state='PAUSED' AND p.reason<>'' AND substr(p.reason,1,5)<>'USER_' AND substr(p.reason,1,7)<>'MANUAL_'))) OR r.business_unknown=1)`;
const idKey = (id: string) =>
  id.toLowerCase() + '|' + [...id].map((c) => (c === c.toLowerCase() ? '0' : '1')).join('');
const LOW = -Number.MAX_VALUE,
  HIGH = Number.MAX_VALUE;
function dependency(low: number | null, high: number | null): [number | null, number] {
  if (low === high) return [low, 0];
  if (low !== LOW || high === null) throw Error('RECORD_TIME_DEPENDENCY_UNSUPPORTED');
  return [high === HIGH ? null : high, 1];
}

/** Incrementally rebuilds ONLY dirty rounds. The original per-row rules also encode dynamic
 * plan.updatedAt dependencies, so legacy fallback rows never need a whole-history JS rebuild. */
export class TaskRecordReader {
  private backfilling = false;
  private responseCache: { key: string; value: TaskRecordsResponse } | null = null;
  private readonly epoch = randomUUID();
  constructor(
    private readonly db: DatabaseSync,
    private readonly getPlan: (id: string) => Plan,
    private readonly getSteps: (id: string, round: number) => StepInstance[],
    private readonly token: () => string | null,
  ) {
    beforeCommit(db, () => {
      // Live operation receipts only mark the current round dirty. Rebuilding that round on
      // every mouse/ACK/checkpoint would move history work onto the input hot path.
      // Closed rounds are materialized atomically at the boundary; current rounds are brought
      // up to date once when records are actually requested, before any row is exposed.
      if (!this.backfilling) this.flush(undefined, true);
    });
  }
  async initialize(onProgress?: (completed: number, total: number) => void) {
    const total = Number(
      this.db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()?.n ?? 0,
    );
    if (!total) return;
    onProgress?.(0, total);
    const previousCacheSize = Number(
      this.db.prepare('PRAGMA cache_size').get()?.cache_size ?? -2000,
    );
    this.backfilling = true;
    try {
      // A bounded transient pager cache avoids random-index page thrashing during backfill.
      // Restore the connection's original setting before accepting ordinary runtime work.
      this.db.exec('PRAGMA cache_size=-32768');
      while (this.db.prepare('SELECT 1 FROM task_record_dirty LIMIT 1').get()) {
        // Startup only (before serving requests): amortize FULL fsync across a bounded batch.
        // Small per-round transactions can spend minutes waiting for durable disk flushes.
        transaction(this.db, () => this.flush(256));
        onProgress?.(
          total -
            Number(this.db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()?.n ?? 0),
          total,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.backfilling = false;
      this.db.exec(`PRAGMA cache_size=${Math.trunc(previousCacheSize)}`);
    }
  }
  flush(limit?: number, closedOnly = false) {
    const dirty = this.db
      .prepare(
        closedOnly
          ? "SELECT d.job_id,d.round FROM task_record_dirty d JOIN task_plans p ON p.id=d.job_id WHERE d.round<p.round OR p.state IN ('STOPPED','COMPLETED','FAILED') ORDER BY d.job_id,d.round LIMIT ?"
          : 'SELECT job_id,round FROM task_record_dirty ORDER BY job_id,round LIMIT ?',
      )
      .all(limit ?? -1);
    if (!dirty.length) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO task_record_projection VALUES(${Array(23).fill('?').join(',')})`,
    );
    for (const item of dirty) {
      const id = String(item.job_id),
        round = Number(item.round),
        plan = this.getPlan(id),
        steps = this.getSteps(id, round);
      const ops = this.db
        .prepare(
          'SELECT o.step_id,o.created_at,o.updated_at,o.status,o.disposition FROM task_outbox o JOIN task_steps s ON s.id=o.step_id WHERE s.job_id=? AND s.round=?',
        )
        .all(id, round)
        .map((o) => ({
          stepId: String(o.step_id),
          createdAt: Number(o.created_at),
          updatedAt: Number(o.updated_at),
          status: o.status as Operation['status'],
          ...(o.disposition
            ? { disposition: JSON.parse(String(o.disposition)) as Operation['disposition'] }
            : {}),
        }));
      const rawEvents = this.db
        .prepare(
          `SELECT e.* FROM task_steps s JOIN task_events e ON e.job_id=s.job_id AND json_extract(e.detail,'$.stepId')=s.id WHERE s.job_id=? AND s.round=? UNION SELECT * FROM task_events WHERE job_id=? AND type='ROUND_CREATED' AND json_extract(detail,'$.round')=? UNION SELECT * FROM task_events WHERE sequence=(SELECT min(sequence) FROM task_events WHERE job_id=? AND type='RUNNING') ORDER BY sequence`,
        )
        .all(id, round, id, round, id);
      const events: Event[] = rawEvents.map((e) => ({
        sequence: Number(e.sequence),
        jobId: id,
        type: String(e.type),
        detail: JSON.parse(String(e.detail)),
        createdAt: Number(e.created_at),
      }));
      const calculate = (state: Plan['state'], updatedAt: number) =>
        projectTaskRecords({ ...plan, state, updatedAt }, steps, ops, events).map((x) => x.row);
      const liveLow = calculate('RUNNING', LOW),
        liveHigh = calculate('RUNNING', HIGH),
        endLow = calculate('STOPPED', LOW),
        endHigh = calculate('STOPPED', HIGH);
      const actual = projectTaskRecords(plan, steps, ops, events).map((x) => x.row);
      this.db
        .prepare('DELETE FROM task_record_projection WHERE job_id=? AND round=?')
        .run(id, round);
      const hidden = new Set(
        this.db.prepare("SELECT name FROM sqlite_master WHERE name='task_record_deletions'").get()
          ? this.db
              .prepare(
                'SELECT step_id FROM task_record_deletions WHERE step_id IN(SELECT id FROM task_steps WHERE job_id=? AND round=?)',
              )
              .all(id, round)
              .map((r) => String(r.step_id))
          : [],
      );
      actual.forEach((row, i) => {
        if (hidden.has(row.stepId)) return;
        const ll = liveLow[i],
          lh = liveHigh[i],
          el = endLow[i],
          eh = endHigh[i];
        if (!ll || !lh || !el || !eh) throw Error('RECORD_PROJECTION_ROW_MISSING');
        const ls = dependency(ll.startedAt, lh.startedAt),
          lf = dependency(ll.finishedAt, lh.finishedAt),
          es = dependency(el.startedAt, eh.startedAt),
          ef = dependency(el.finishedAt, eh.finishedAt);
        const stable =
          ['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) ||
          (!ls[1] && !lf[1] && !es[1] && !ef[1] && ls[0] === es[0] && lf[0] === ef[0]);
        insert.run(
          row.stepId,
          id,
          round,
          row.position,
          row.profileId,
          row.combinationName,
          row.type,
          row.destination ?? '',
          row.status,
          row.outcome?.kind ?? null,
          row.outcome?.kind === 'FAILED' && row.outcome.businessResult === 'UNKNOWN' ? 1 : 0,
          JSON.stringify(row),
          row.planCreatedAt,
          idKey(row.stepId),
          ...ls,
          ...lf,
          ...es,
          ...ef,
          stable ? (row.finishedAt ?? row.startedAt ?? row.planCreatedAt) : null,
        );
      });
      this.db.prepare('DELETE FROM task_record_dirty WHERE job_id=? AND round=?').run(id, round);
    }
  }
  page(input: unknown, profiles: readonly RecordProfile[]): TaskRecordsResponse {
    const request = TaskRecordsRequest.parse(input ?? {});
    // Direct SQL fixture/import writes are also tracked by triggers. Closed rounds flush before
    // COMMIT; live rounds coalesce here. Never expose a dirty or rolled-back projection.
    if (this.db.prepare('SELECT 1 FROM task_record_dirty LIMIT 1').get())
      transaction(this.db, () => this.flush());
    const state = this.token();
    const key = state === null ? null : state + JSON.stringify([request, profiles]);
    if (key && this.responseCache?.key === key) return structuredClone(this.responseCache.value);
    const value = readSnapshot(this.db, () => this.readPage(request, profiles));
    if (key) this.responseCache = { key, value: structuredClone(value) };
    return value;
  }
  private readPage(
    request: ReturnType<typeof TaskRecordsRequest.parse>,
    profiles: readonly RecordProfile[],
  ) {
    const scope = JSON.stringify([
      request.profileId ?? '',
      request.status,
      request.query ?? '',
      profiles,
    ]);
    const token = this.token();
    // token() deliberately returns null inside a transaction; use committed counters directly
    // for this short read snapshot, including per-reader epoch supplied by the token callback.
    const version = createHash('sha256')
      .update(
        this.epoch +
          scope +
          (token ??
            `${String(this.db.prepare('PRAGMA data_version').get()?.data_version)}:${String(this.db.prepare('SELECT total_changes() AS n').get()?.n)}`),
      )
      .digest('hex');
    type Cursor = {
      v: number;
      version: string;
      keys: [number, number, number, number, string];
      signature: string;
    };
    const sign = (keys: Cursor['keys']) =>
      createHmac('sha256', this.epoch)
        .update(JSON.stringify([version, keys]))
        .digest('base64url');
    let cursor: Cursor | null = null;
    if (request.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString()) as Cursor;
      } catch {}
      if (
        !cursor ||
        cursor.v !== 1 ||
        cursor.version !== version ||
        !Array.isArray(cursor.keys) ||
        cursor.keys.length !== 5 ||
        !cursor.keys.slice(0, 4).every((x) => typeof x === 'number' && Number.isFinite(x)) ||
        typeof cursor.keys[4] !== 'string' ||
        cursor.signature !== sign(cursor.keys)
      )
        throw new ProductError('RECORDS_VIEW_CHANGED', '记录已变化，请重新读取', 409);
    }
    const offline = JSON.stringify(profiles.filter((p) => p.online === false).map((p) => p.id));
    const params: SQLInputValue[] = [];
    let where = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='task_record_deletions'")
      .get()
      ? 'NOT EXISTS(SELECT 1 FROM task_record_deletions d WHERE d.step_id=r.step_id)'
      : '1=1';
    if (request.profileId) {
      where += ' AND r.profile_id=?';
      params.push(request.profileId);
    }
    const q = request.query?.trim().toLocaleLowerCase();
    if (q) {
      const byId = new Map(profiles.map((p) => [p.id, p]));
      const tuples = this.db
        .prepare(
          'SELECT DISTINCT combination_name,profile_id,type,destination FROM task_record_projection' +
            (request.profileId ? ' WHERE profile_id=?' : ''),
        )
        .all(...(request.profileId ? [request.profileId] : []));
      const matches = tuples
        .filter((t) =>
          recordMatches(
            {
              combinationName: String(t.combination_name),
              profileId: String(t.profile_id),
              type: t.type as TaskRecord['type'],
              ...(t.destination ? { destination: t.destination as 'post' | 'story' } : {}),
            },
            byId.get(String(t.profile_id)),
            q,
          ),
        )
        .map((t) => JSON.stringify([t.combination_name, t.profile_id, t.type, t.destination]));
      where +=
        ' AND json_array(r.combination_name,r.profile_id,r.type,r.destination) IN (SELECT value FROM json_each(?))';
      params.push(JSON.stringify(matches));
    }
    const base = ' FROM task_record_projection r JOIN task_plans p ON p.id=r.job_id WHERE ';
    const count = (
      predicate: string,
      candidate: string,
      join: boolean,
      reviewParameter = false,
    ) => {
      const from = join ? base : ' FROM task_record_projection r WHERE ';
      const row = this.db
        .prepare(
          'SELECT count(*) AS n' +
            from +
            where +
            ' AND (' +
            candidate +
            ') AND (' +
            predicate +
            ')',
        )
        .get(...params, ...(reviewParameter ? [offline] : []));
      return Number(row?.n ?? 0);
    };
    const counts = {
      all: count('1=1', '1=1', false),
      running: count(running, "r.status IN ('ACTIVE','PENDING')", true),
      completed: count(completed, "r.status='COMPLETED'", false),
      failed: count(failed, "r.status IN ('FAILED','ACTIVE')", true),
      review: count(review, "r.status IN ('ACTIVE','PENDING') OR r.business_unknown=1", true, true),
    };
    const predicates = { all: '1=1', running, completed, failed, review };
    where += ` AND (${predicates[request.status]})`;
    // Review predicate occurs after WHERE parameters here, unlike SELECT aggregation above.
    if (request.status === 'review') params.push(offline);
    const keys = cursor?.keys;
    const columns = `${sort},r.created_at,r.round,r.position,r.id_order`;
    const keyWhere = keys ? ` AND (${columns}) < (?,?,?,?,?)` : '';
    const select = `SELECT r.payload,r.id_order,${started} AS start_time,${finished} AS finish_time,${sort} AS sort_time,p.state,p.reason,p.updated_at`;
    const order =
      ' ORDER BY sort_time DESC,r.created_at DESC,r.round DESC,r.position DESC,r.id_order DESC LIMIT ?';
    // Two bounded candidate lists keep the stable-history ordering index usable. Dynamic
    // legacy fallback expressions remain inside SQLite, never all decoded into JavaScript.
    const get = (stable: boolean) =>
      this.db
        .prepare(
          (stable ? select.replace(`${sort} AS sort_time`, 'r.stable_sort AS sort_time') : select) +
            base +
            where +
            (stable ? ' AND r.stable_sort IS NOT NULL' : ' AND r.stable_sort IS NULL') +
            (stable ? keyWhere.replace(sort, 'r.stable_sort') : keyWhere) +
            order,
        )
        .all(...params, ...(keys ?? []), request.limit + 1);
    const decode = (value: ReturnType<typeof get>[number]) => ({
      row: {
        ...(JSON.parse(String(value.payload)) as TaskRecord),
        startedAt: value.start_time === null ? null : Number(value.start_time),
        finishedAt: value.finish_time === null ? null : Number(value.finish_time),
        planState: value.state as TaskRecord['planState'],
        planReason: String(value.reason),
        planUpdatedAt: Number(value.updated_at),
      },
      key: String(value.id_order),
    });
    const candidates = [...get(true), ...get(false)]
      .map(decode)
      .sort((a, b) => compareRecords(a.row, b.row));
    const selected: typeof candidates = [];
    let bytes = 0;
    for (const candidate of candidates.slice(0, request.limit)) {
      const size = Buffer.byteLength(JSON.stringify(candidate.row)) + 1;
      if (bytes + size > 240000) {
        if (!selected.length)
          throw new ProductError(
            'RECORD_DETAIL_REQUIRED',
            '单条记录超过页面预算，请查看任务详情',
            413,
          );
        break;
      }
      selected.push(candidate);
      bytes += size;
    }
    const last = selected.at(-1);
    const nextKeys: Cursor['keys'] | null = last
      ? [
          last.row.finishedAt ?? last.row.startedAt ?? last.row.planCreatedAt,
          last.row.planCreatedAt,
          last.row.round,
          last.row.position,
          last.key,
        ]
      : null;
    const nextCursor =
      candidates.length > selected.length && nextKeys
        ? Buffer.from(
            JSON.stringify({ v: 1, version, keys: nextKeys, signature: sign(nextKeys) }),
          ).toString('base64url')
        : null;
    return TaskRecords.parse({
      viewVersion: version,
      records: selected.map((x) => x.row),
      nextCursor,
      total: counts[request.status],
      counts,
    });
  }
}
