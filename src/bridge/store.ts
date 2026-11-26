import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import { DetailBoundary, type DetailBoundaryValue } from '../shared/data-cleanup.js';
import {
  KernelOperationRecord,
  kernelOperationPending,
  type KernelRecord,
} from '../shared/kernel-state.js';
import { DispatchBinding, sameBinding, type Binding } from '../shared/task-execution.js';
import { Action, BridgeError, type Intent, type JournalEntry, type Status } from './protocol.js';
const terminalReceiptDigest = (row: KernelRecord): string =>
  createHash('sha256')
    .update(JSON.stringify({ resolution: row.resolution, disposition: row.disposition ?? null }))
    .digest('hex');
const DETAIL_UNION_SQL = `SELECT 'legacy' source,commandId id,updatedAt at,'legacy:'||commandId key FROM operations WHERE detailsPruned=0 AND status IN ('VERIFIED','FAILED','CANCELLED','ABANDONED') AND operationId NOT IN(SELECT value FROM json_each(?)) UNION ALL SELECT 'kernel',profile_id||':'||operation_id,updated_at,'kernel:'||profile_id||':'||operation_id FROM kernel_operation_receipts WHERE receipt IS NOT NULL AND retired=0 AND operation_id NOT IN(SELECT value FROM json_each(?))`;
const PROFILE_COLS = 'profileId,alias,extensionId,facebookAllowed,0 AS unresolvedCount';
const assertSameBinding = (rawBinding: unknown, binding: Binding) => {
  if (!sameBinding(DispatchBinding.parse(JSON.parse(String(rawBinding))), binding))
    throw Error('KERNEL_OPERATION_ID_CONFLICT');
};
type RecordRow = {
  commandId: string;
  profileId: string;
  operationId: string;
  action: string;
  digest: string;
  status: Status;
  result: string | null;
  updatedAt: number;
  legacyFixture: number;
  detailsPruned?: number;
};
export const bridgeSchemaVersion = 4;
export class Store {
  readonly db: DatabaseSync;
  private prep = (sql: string) => this.db.prepare(sql);
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    const schema = Number(
      (this.prep('PRAGMA user_version').get() as { user_version?: number } | undefined)
        ?.user_version ?? 0,
    );
    if (schema > bridgeSchemaVersion) {
      this.db.close();
      throw new BridgeError('DATABASE_VERSION_TOO_NEW');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations(commandId TEXT PRIMARY KEY,profileId TEXT NOT NULL,operationId TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT,updatedAt INTEGER NOT NULL,UNIQUE(profileId,operationId));
      CREATE TABLE IF NOT EXISTS profiles(profileId TEXT PRIMARY KEY,secret TEXT NOT NULL,extensionId TEXT NOT NULL,alias TEXT NOT NULL);`);
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {}
    try {
      this.withTx(() => {
        const cols = (t: string) =>
          (this.prep(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
        const addCol = (table: string, existing: string[], col: string, ddl: string) => {
          if (!existing.includes(col))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
        };
        const opCols = cols('operations');
        if (!opCols.includes('legacyFixture'))
          this.db.exec(
            'ALTER TABLE operations ADD COLUMN legacyFixture INTEGER NOT NULL DEFAULT 0; UPDATE operations SET legacyFixture=1;',
          );
        addCol('profiles', cols('profiles'), 'facebookAllowed', 'INTEGER NOT NULL DEFAULT 0');
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,commandId TEXT NOT NULL,decision TEXT NOT NULL,note TEXT NOT NULL,evidence TEXT,createdAt INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks(taskId TEXT PRIMARY KEY,profileId TEXT NOT NULL,operationId TEXT NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT,updatedAt INTEGER NOT NULL,UNIQUE(profileId,operationId));
          UPDATE tasks SET status='INTERRUPTED' WHERE status IN ('PREPARED','RUNNING');
          CREATE INDEX IF NOT EXISTS operations_profile_status ON operations(profileId,status);
          CREATE INDEX IF NOT EXISTS operations_updated_at ON operations(updatedAt DESC);
          CREATE TABLE IF NOT EXISTS kernel_operation_watermarks(profile_id TEXT PRIMARY KEY, high_water INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS kernel_operation_receipts(profile_id TEXT NOT NULL,operation_id TEXT NOT NULL,binding TEXT NOT NULL,sequence INTEGER,receipt TEXT,PRIMARY KEY(profile_id,operation_id));
          PRAGMA user_version=4;`);
        const receiptCols = cols('kernel_operation_receipts');
        for (const [col, ddl] of [
          ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
          ['retired', 'INTEGER NOT NULL DEFAULT 0'],
          ['receipt_digest', 'TEXT'],
        ] as const)
          addCol('kernel_operation_receipts', receiptCols, col, ddl);
        addCol('operations', opCols, 'detailsPruned', 'INTEGER NOT NULL DEFAULT 0');
        this.db.exec(
          'CREATE INDEX IF NOT EXISTS kernel_receipt_retention ON kernel_operation_receipts(retired,updated_at)',
        );
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.prep(
      "UPDATE operations SET status='CANCELLED',updatedAt=? WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
    ).run(Date.now());
  }
  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private kernelReceiptRow = (profileId: string, operationId: string) =>
    this.prep('SELECT * FROM kernel_operation_receipts WHERE profile_id=? AND operation_id=?').get(
      profileId,
      operationId,
    );
  kernelOperationSequence(value: Binding, floor = 0): number {
    const binding = DispatchBinding.parse(value);
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(floor);
    return this.withTx(() => {
      const old = this.kernelReceiptRow(binding.profileId, binding.operationId);
      if (old) assertSameBinding(old.binding, binding);
      if (old?.retired === 1 || (old?.receipt && old.sequence === null))
        throw Error('KERNEL_OPERATION_RETIRED');
      if (old?.sequence != null) return Number(old.sequence);
      const prior = this.prep(
        'SELECT high_water FROM kernel_operation_watermarks WHERE profile_id=?',
      ).get(binding.profileId);
      const sequence = Math.max(Number(prior?.high_water ?? 0), floor) + 1;
      if (!Number.isSafeInteger(sequence)) throw Error('KERNEL_OPERATION_SEQUENCE_EXHAUSTED');
      this.prep(
        'INSERT INTO kernel_operation_watermarks VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET high_water=excluded.high_water',
      ).run(binding.profileId, sequence);
      this.prep(
        'INSERT INTO kernel_operation_receipts(profile_id,operation_id,binding,sequence,updated_at) VALUES(?,?,?,?,?)',
      ).run(binding.profileId, binding.operationId, JSON.stringify(binding), sequence, Date.now());
      return sequence;
    });
  }
  archiveKernelReceipts(profileId: string, input: KernelRecord[]): void {
    z.uuid().parse(profileId);
    const records = z.array(KernelOperationRecord).max(200).parse(input);
    this.withTx(() => {
      for (const row of records) {
        if (row.binding.profileId !== profileId || kernelOperationPending(row))
          throw Error('KERNEL_ARCHIVE_NOT_TERMINAL');
        const old = this.kernelReceiptRow(profileId, row.binding.operationId);
        if (old) assertSameBinding(old.binding, row.binding);
        if (old?.retired === 1) {
          if (old.receipt_digest !== terminalReceiptDigest(row))
            throw Error('KERNEL_ARCHIVE_CONFLICT');
          continue;
        }
        if (old?.receipt) {
          const prior = KernelOperationRecord.parse(JSON.parse(String(old.receipt)));
          for (const key of ['resolution', 'disposition'] as const) {
            const a = prior[key],
              b = row[key];
            if (
              a &&
              (!b ||
                a.id !== b.id ||
                a.outcome !== b.outcome ||
                a.evidenceDigest !== b.evidenceDigest)
            )
              throw Error('KERNEL_ARCHIVE_CONFLICT');
          }
        }
        this.prep(
          'INSERT INTO kernel_operation_receipts(profile_id,operation_id,binding,sequence,receipt,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,operation_id) DO UPDATE SET receipt=excluded.receipt, updated_at=excluded.updated_at',
        ).run(
          profileId,
          row.binding.operationId,
          JSON.stringify(row.binding),
          row.operationSequence ?? null,
          JSON.stringify(row),
          Date.now(),
        );
      }
    });
  }
  kernelReceipts(profileId: string, operationIds: readonly string[]): KernelRecord[] {
    z.uuid().parse(profileId);
    z.array(z.uuid()).max(3000).parse(operationIds);
    return operationIds.length
      ? this.prep(
          'SELECT receipt FROM kernel_operation_receipts WHERE profile_id=? AND operation_id IN (SELECT value FROM json_each(?)) AND receipt IS NOT NULL',
        )
          .all(profileId, JSON.stringify(operationIds))
          .map((r) => KernelOperationRecord.parse(JSON.parse(String(r.receipt))))
      : [];
  }
  detailHead(maximum: number, protectedIds: readonly string[] = []): DetailBoundaryValue[] {
    const excluded = JSON.stringify(protectedIds);
    return this.prep(`SELECT at,key FROM (${DETAIL_UNION_SQL}) ORDER BY at DESC,key DESC LIMIT ?`)
      .all(excluded, excluded, z.number().int().min(1).max(100000).parse(maximum))
      .map((r) => ({ at: Number(r.at), key: String(r.key) }));
  }
  pruneDetails(input: unknown, protectedIds: readonly string[] = [], maximum = 100): number {
    const boundary = DetailBoundary.parse(input),
      excluded = JSON.stringify(protectedIds),
      limit = z.number().int().min(1).max(200).parse(maximum);
    return this.withTx(() => {
      const rows = this.prep(
        `SELECT * FROM (${DETAIL_UNION_SQL}) WHERE (at,key)<(?,?) ORDER BY at,key LIMIT ?`,
      ).all(excluded, excluded, boundary.at, boundary.key, limit);
      for (const r of rows)
        if (r.source === 'legacy') {
          this.prep(
            'UPDATE operations SET result=?,action=?,detailsPruned=1 WHERE commandId=?',
          ).run('{"detailsReclaimed":true}', '{"kind":"history-reclaimed"}', r.id as string);
          this.prep('UPDATE reviews SET evidence=NULL WHERE commandId=?').run(r.id as string);
        } else {
          const [pid = '', oid = ''] = String(r.id).split(':'),
            old = this.kernelReceiptRow(pid, oid);
          this.prep(
            'UPDATE kernel_operation_receipts SET receipt_digest=?,receipt=NULL,retired=1 WHERE profile_id=? AND operation_id=?',
          ).run(
            terminalReceiptDigest(KernelOperationRecord.parse(JSON.parse(String(old?.receipt)))),
            pid,
            oid,
          );
        }
      return rows.length;
    });
  }
  prepare(intent: Intent): { row: RecordRow; fresh: boolean } {
    const action = JSON.stringify(Action.parse(intent.action)),
      digest = createHash('sha256').update(action).digest('hex'),
      old = this.prep('SELECT * FROM operations WHERE profileId=? AND operationId=?').get(
        intent.profileId,
        intent.operationId,
      ) as RecordRow | undefined;
    if (old) {
      if (old.digest !== digest) throw new BridgeError('OPERATION_ID_CONFLICT');
      if (old.detailsPruned) throw new BridgeError('OPERATION_DETAILS_RECLAIMED');
      return { row: old, fresh: false };
    }
    const row: RecordRow = {
      commandId: randomUUID(),
      profileId: intent.profileId,
      operationId: intent.operationId,
      action,
      digest,
      status: 'PREPARED',
      result: null,
      updatedAt: Date.now(),
      legacyFixture: 0,
    };
    this.prep(
      'INSERT INTO operations(commandId,profileId,operationId,action,digest,status,result,updatedAt,legacyFixture) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      row.commandId,
      row.profileId,
      row.operationId,
      action,
      digest,
      row.status,
      null,
      row.updatedAt,
      0,
    );
    return { row, fresh: true };
  }
  get = (id: string) =>
    this.prep('SELECT * FROM operations WHERE commandId=? AND detailsPruned=0').get(id) as
      RecordRow | undefined;
  cancelPrepared = (profileId: string) =>
    this.prep(
      "UPDATE operations SET status='CANCELLED',updatedAt=? WHERE profileId=? AND status='PREPARED'",
    ).run(Date.now(), profileId);
  set = (id: string, status: Status, result?: unknown) =>
    this.prep('UPDATE operations SET status=?,result=?,updatedAt=? WHERE commandId=?').run(
      status,
      result === undefined ? null : JSON.stringify(result),
      Date.now(),
      id,
    );
  list = () =>
    this.prep(
      'SELECT * FROM operations WHERE detailsPruned=0 ORDER BY updatedAt DESC LIMIT 100',
    ).all() as RecordRow[];
  unresolved = (_profileId: string): RecordRow[] => [];
  review(
    commandId: string,
    decision: 'CONFIRMED_SUCCESS' | 'CONFIRMED_NOT_APPLIED' | 'ABANDON',
    note: string,
    evidence?: unknown,
  ) {
    const row = this.get(commandId);
    if (!row || !['UNKNOWN', 'ACKNOWLEDGED'].includes(row.status))
      throw new BridgeError('REVIEW_NOT_REQUIRED');
    const nextStatus =
      decision === 'CONFIRMED_SUCCESS'
        ? 'VERIFIED'
        : decision === 'CONFIRMED_NOT_APPLIED'
          ? 'FAILED'
          : 'ABANDONED';
    this.withTx(() => {
      this.prep(
        'INSERT INTO reviews(commandId,decision,note,evidence,createdAt) VALUES(?,?,?,?,?)',
      ).run(commandId, decision, note, evidence ? JSON.stringify(evidence) : null, Date.now());
      this.set(commandId, nextStatus, {
        previous: row.result ? JSON.parse(row.result) : null,
        decision,
        note,
        evidence,
      });
    });
  }
  reconcile(_profileId: string, _entries: JournalEntry[]) {}
  profile = (id: string) =>
    this.prep('SELECT * FROM profiles WHERE profileId=?').get(id) as
      { profileId: string; secret: string; extensionId: string; alias: string } | undefined;
  pair = (profileId: string, secret: string, extensionId: string) =>
    this.prep('INSERT INTO profiles(profileId,secret,extensionId,alias) VALUES(?,?,?,?)').run(
      profileId,
      secret,
      extensionId,
      'Chrome ' + profileId.slice(0, 8),
    );
  profileList = () => this.prep(`SELECT ${PROFILE_COLS} FROM profiles`).all();
  profileSummary = (profileId: string) =>
    this.prep(`SELECT ${PROFILE_COLS} FROM profiles WHERE profileId=?`).get(profileId);
  replaceConnectionSecret = (
    profileId: string,
    extensionId: string,
    expected: string,
    next: string,
  ) =>
    this.prep('UPDATE profiles SET secret=? WHERE profileId=? AND extensionId=? AND secret=?').run(
      next,
      profileId,
      extensionId,
      expected,
    ).changes === 1;
  deleteProfile = (profileId: string): boolean =>
    this.withTx(() => {
      this.prep(
        "DELETE FROM operations WHERE profileId=? AND status IN ('PREPARED','UNKNOWN','ACKNOWLEDGED')",
      ).run(profileId);
      return this.prep('DELETE FROM profiles WHERE profileId=?').run(profileId).changes > 0;
    });
  async backup(path: string) {
    await backup(this.db, path);
  }
  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
  }
}
