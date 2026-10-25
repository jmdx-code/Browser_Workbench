import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  Action,
  BridgeError,
  isWrite,
  type Intent,
  type Status,
  type JournalEntry,
} from './protocol.js';
export type RecordRow = {
  commandId: string;
  profileId: string;
  operationId: string;
  action: string;
  digest: string;
  status: Status;
  result: string | null;
  updatedAt: number;
  legacyFixture: number;
};
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    const schema = (this.db.prepare('PRAGMA user_version').get() as any).user_version;
    if (schema > 2) {
      this.db.close();
      throw new BridgeError('DATABASE_VERSION_TOO_NEW');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations(commandId TEXT PRIMARY KEY,profileId TEXT NOT NULL,operationId TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT,updatedAt INTEGER NOT NULL,UNIQUE(profileId,operationId));
      CREATE TABLE IF NOT EXISTS profiles(profileId TEXT PRIMARY KEY,secret TEXT NOT NULL,extensionId TEXT NOT NULL,alias TEXT NOT NULL);`);
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {}
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(operations)').all() as { name: string }[];
      if (!columns.some((c) => c.name === 'legacyFixture')) {
        this.db.exec(
          'ALTER TABLE operations ADD COLUMN legacyFixture INTEGER NOT NULL DEFAULT 0; UPDATE operations SET legacyFixture=1;',
        );
      }
      const profileColumns = this.db.prepare('PRAGMA table_info(profiles)').all() as {
        name: string;
      }[];
      if (!profileColumns.some((c) => c.name === 'facebookAllowed'))
        this.db.exec('ALTER TABLE profiles ADD COLUMN facebookAllowed INTEGER NOT NULL DEFAULT 0;');
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,commandId TEXT NOT NULL,decision TEXT NOT NULL,note TEXT NOT NULL,evidence TEXT,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(taskId TEXT PRIMARY KEY,profileId TEXT NOT NULL,operationId TEXT NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT,updatedAt INTEGER NOT NULL,UNIQUE(profileId,operationId));
      UPDATE tasks SET status='INTERRUPTED' WHERE status IN ('PREPARED','RUNNING');`);
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS operations_profile_status ON operations(profileId,status)',
      );
      this.db.exec('PRAGMA user_version=2; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
    this.db
      .prepare(
        "UPDATE operations SET status='UNKNOWN',updatedAt=? WHERE status IN ('DISPATCHING','ACKNOWLEDGED')",
      )
      .run(Date.now());
    this.db
      .prepare("UPDATE operations SET status='CANCELLED',updatedAt=? WHERE status='PREPARED'")
      .run(Date.now());
  }
  prepare(intent: Intent): { row: RecordRow; fresh: boolean } {
    const action = JSON.stringify(Action.parse(intent.action));
    const digest = createHash('sha256').update(action).digest('hex');
    const old = this.db
      .prepare('SELECT * FROM operations WHERE profileId=? AND operationId=?')
      .get(intent.profileId, intent.operationId) as RecordRow | undefined;
    if (old) {
      if (old.digest !== digest) throw new BridgeError('OPERATION_ID_CONFLICT');
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
    this.db
      .prepare(
        'INSERT INTO operations(commandId,profileId,operationId,action,digest,status,result,updatedAt,legacyFixture) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.commandId,
        row.profileId,
        row.operationId,
        row.action,
        row.digest,
        row.status,
        row.result,
        row.updatedAt,
        row.legacyFixture,
      );
    return { row, fresh: true };
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM operations WHERE commandId=?').get(id) as
      RecordRow | undefined;
  }
  cancelPrepared(profileId: string) {
    this.db
      .prepare(
        "UPDATE operations SET status='CANCELLED',updatedAt=? WHERE profileId=? AND status='PREPARED'",
      )
      .run(Date.now(), profileId);
  }
  set(id: string, status: Status, result?: unknown) {
    this.db
      .prepare('UPDATE operations SET status=?,result=?,updatedAt=? WHERE commandId=?')
      .run(status, result === undefined ? null : JSON.stringify(result), Date.now(), id);
  }
  list() {
    return this.db
      .prepare('SELECT * FROM operations ORDER BY updatedAt DESC LIMIT 100')
      .all() as RecordRow[];
  }
  unresolved(profileId: string) {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE profileId=? AND status IN ('UNKNOWN','ACKNOWLEDGED')",
      )
      .all(profileId) as RecordRow[];
  }
  review(
    commandId: string,
    decision: 'CONFIRMED_SUCCESS' | 'CONFIRMED_NOT_APPLIED' | 'ABANDON',
    note: string,
    evidence?: unknown,
  ) {
    const row = this.get(commandId);
    if (!row || !['UNKNOWN', 'ACKNOWLEDGED'].includes(row.status))
      throw new BridgeError('REVIEW_NOT_REQUIRED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO reviews(commandId,decision,note,evidence,createdAt) VALUES(?,?,?,?,?)',
        )
        .run(commandId, decision, note, evidence ? JSON.stringify(evidence) : null, Date.now());
      this.set(
        commandId,
        decision === 'CONFIRMED_SUCCESS'
          ? 'VERIFIED'
          : decision === 'CONFIRMED_NOT_APPLIED'
            ? 'FAILED'
            : 'ABANDONED',
        { previous: row.result ? JSON.parse(row.result) : null, decision, note, evidence },
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  reconcile(profileId: string, entries: JournalEntry[]) {
    // Validate the entire snapshot before mutating anything. Never downgrade a reviewed result.
    const incoming = new Set<string>();
    for (const entry of entries) {
      if (incoming.has(entry.operationId)) throw new BridgeError('DUPLICATE_JOURNAL_OPERATION');
      incoming.add(entry.operationId);
      const digest = createHash('sha256')
        .update(JSON.stringify(Action.parse(entry.action)))
        .digest('hex');
      if (digest !== entry.digest) throw new BridgeError('JOURNAL_DIGEST_CONFLICT');
      const old = this.db
        .prepare('SELECT * FROM operations WHERE profileId=? AND operationId=?')
        .get(profileId, entry.operationId) as RecordRow | undefined;
      if (old && old.digest !== digest) throw new BridgeError('OPERATION_ID_CONFLICT');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        if (!isWrite(entry.action)) continue;
        const old = this.db
          .prepare('SELECT * FROM operations WHERE profileId=? AND operationId=?')
          .get(profileId, entry.operationId) as RecordRow | undefined;
        if (old) {
          if (
            old.status === 'PREPARED' ||
            (old.status === 'CANCELLED' && entry.status !== 'FAILED')
          )
            this.set(old.commandId, 'UNKNOWN', { error: 'JOURNAL_RECONCILIATION_REQUIRED' });
          continue;
        }
        const status: Status = ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(entry.status)
          ? 'UNKNOWN'
          : entry.status;
        this.db
          .prepare(
            'INSERT INTO operations(commandId,profileId,operationId,action,digest,status,result,updatedAt,legacyFixture) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            entry.commandId,
            profileId,
            entry.operationId,
            JSON.stringify(entry.action),
            entry.digest,
            status,
            JSON.stringify({ recoveredFromExtension: true }),
            Date.now(),
            Number(entry.legacyFixture),
          );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  allowFacebook(profileId: string) {
    this.db.prepare('UPDATE profiles SET facebookAllowed=1 WHERE profileId=?').run(profileId);
  }
  facebookAllowed(profileId: string) {
    return Boolean(
      (
        this.db
          .prepare('SELECT facebookAllowed FROM profiles WHERE profileId=?')
          .get(profileId) as any
      )?.facebookAllowed,
    );
  }
  createTask(profileId: string, operationId: string, spec: unknown) {
    const old = this.db
      .prepare('SELECT * FROM tasks WHERE profileId=? AND operationId=?')
      .get(profileId, operationId) as any;
    if (old) {
      if (old.spec !== JSON.stringify(spec)) throw new BridgeError('TASK_ID_CONFLICT');
      return { row: old, fresh: false };
    }
    const row = {
      taskId: randomUUID(),
      profileId,
      operationId,
      spec: JSON.stringify(spec),
      status: 'PREPARED',
      evidence: null,
      updatedAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)')
      .run(row.taskId, profileId, operationId, row.spec, row.status, null, row.updatedAt);
    return { row, fresh: true };
  }
  taskByOperation(profileId: string, operationId: string) {
    return this.db
      .prepare('SELECT * FROM tasks WHERE profileId=? AND operationId=?')
      .get(profileId, operationId) as any;
  }
  setTask(taskId: string, status: string, evidence: unknown) {
    this.db
      .prepare('UPDATE tasks SET status=?,evidence=?,updatedAt=? WHERE taskId=?')
      .run(status, JSON.stringify(evidence), Date.now(), taskId);
  }
  tasks() {
    return this.db.prepare('SELECT * FROM tasks ORDER BY updatedAt DESC LIMIT 100').all();
  }
  profile(id: string) {
    return this.db.prepare('SELECT * FROM profiles WHERE profileId=?').get(id) as
      { profileId: string; secret: string; extensionId: string; alias: string } | undefined;
  }
  pair(profileId: string, secret: string, extensionId: string) {
    this.db
      .prepare('INSERT INTO profiles(profileId,secret,extensionId,alias) VALUES(?,?,?,?)')
      .run(profileId, secret, extensionId, 'Chrome ' + profileId.slice(0, 8));
  }
  profileList() {
    return this.db
      .prepare('SELECT profileId,alias,extensionId,facebookAllowed FROM profiles')
      .all();
  }
  profileSummary(profileId: string) {
    return this.db
      .prepare('SELECT profileId,alias,extensionId,facebookAllowed FROM profiles WHERE profileId=?')
      .get(profileId);
  }
  replaceConnectionSecret(profileId: string, extensionId: string, expected: string, next: string) {
    return (
      this.db
        .prepare('UPDATE profiles SET secret=? WHERE profileId=? AND extensionId=? AND secret=?')
        .run(next, profileId, extensionId, expected).changes === 1
    );
  }
  deleteProfile(profileId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          "DELETE FROM operations WHERE profileId=? AND status IN ('PREPARED','UNKNOWN','ACKNOWLEDGED')",
        )
        .run(profileId);
      const changed = this.db.prepare('DELETE FROM profiles WHERE profileId=?').run(profileId);
      this.db.exec('COMMIT');
      return changed.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
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
