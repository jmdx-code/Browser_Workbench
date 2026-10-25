import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BoundReceipt,
  DispatchBinding,
  sameBinding,
  type Binding,
  type ExecutionReceipt,
} from '../shared/task-execution.js';
import {
  SettlementNotice,
  SettlementReceipt,
  sameNotice,
  type Notice,
  type NoticeReceipt,
  type Resolution,
} from '../shared/settlement.js';
import type { SettlementRepository as CompatibleSettlementRepository } from '../domain/settlement.js';
import { ProductError } from '../domain/workspace.js';
import { transaction } from './sqlite-transaction.js';
import { OperationDisposition, type Disposition } from '../shared/task-ending.js';

// Canonical JSON evidence makes retry identity independent of object property insertion order.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}
const digest = (receipt: ExecutionReceipt) =>
  createHash('sha256')
    .update(canonical(BoundReceipt.parse(receipt)))
    .digest('hex');
export class SqliteSettlementRepository implements SettlementRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: { id(): string; now(): number } = {
      id: randomUUID,
      now: Date.now,
    },
  ) {}
  private get(id: string, kind = 'BUSINESS'): Notice {
    const row = this.db
      .prepare(
        'SELECT n.body,d.* FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id,kind) WHERE operation_id=? AND kind=?',
      )
      .get(id, kind);
    if (!row) throw new ProductError('NOTICE_NOT_FOUND', '结算通知不存在', 404);
    const body = SettlementReceipt.parse(JSON.parse(String(row.body)) as unknown);
    return SettlementNotice.parse({
      ...body,
      state: row.state,
      claimToken: row.claim_token,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      reason: row.reason,
    });
  }
  list(profileId?: string): Notice[] {
    const rows =
      profileId === undefined
        ? this.db
            .prepare(
              'SELECT operation_id,kind FROM task_settlement_notices ORDER BY created_at,operation_id,kind',
            )
            .all()
        : this.db
            .prepare(
              'SELECT operation_id,kind FROM task_settlement_notices WHERE profile_id=? ORDER BY created_at,operation_id,kind',
            )
            .all(profileId);
    return rows.map((row) => this.get(String(row.operation_id), String(row.kind)));
  }
  // Trusted explicit backfill is allowed only from a persisted bound business verdict.
  // Called within the same outer transaction as business settlement for new operations.
  ensureSettled(
    input: Binding,
    expected?: Resolution['outcome'],
    evidence?: ExecutionReceipt,
  ): Notice {
    const binding = DispatchBinding.parse(input);
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          'SELECT o.status,o.receipt,o.action,b.body AS binding FROM task_outbox o JOIN task_dispatch_bindings b ON b.operation_id=o.id WHERE o.id=?',
        )
        .get(binding.operationId);
      if (
        !row ||
        !sameBinding(DispatchBinding.parse(JSON.parse(String(row.binding)) as unknown), binding) ||
        !(
          ['VERIFIED', 'FAILED'].includes(String(row.status)) ||
          (row.status === 'CANCELLED' &&
            JSON.parse(String(row.action)).kind === 'browseScroll' &&
            (expected === 'CONTROL_RELEASED' ||
              this.db
                .prepare(
                  "SELECT 1 FROM task_settlement_notices WHERE operation_id=? AND kind='BUSINESS'",
                )
                .get(binding.operationId)))
        )
      )
        throw new ProductError(
          'NOTICE_BUSINESS_VERDICT_REQUIRED',
          '通知必须对应已持久核验的业务结果',
          409,
        );
      const receipt = BoundReceipt.parse(JSON.parse(String(row.receipt)) as unknown);
      if (!sameBinding(receipt.binding, binding))
        throw new ProductError('NOTICE_EVIDENCE_BINDING_MISMATCH', '业务证据绑定不一致', 409);
      const outcome =
          row.status === 'CANCELLED'
            ? 'CONTROL_RELEASED'
            : row.status === 'VERIFIED'
              ? 'VERIFIED'
              : 'NOT_APPLIED',
        evidenceDigest = digest(receipt);
      if ((expected && expected !== outcome) || (evidence && digest(evidence) !== evidenceDigest))
        throw new ProductError('NOTICE_VERDICT_CONFLICT', '重复结算的结果或证据冲突', 409);
      if (
        this.db
          .prepare(
            "SELECT operation_id FROM task_settlement_notices WHERE operation_id=? AND kind='BUSINESS'",
          )
          .get(binding.operationId)
      ) {
        const existing = this.get(binding.operationId);
        if (
          !sameBinding(existing.binding, binding) ||
          existing.resolution.outcome !== outcome ||
          existing.resolution.evidenceDigest !== evidenceDigest
        )
          throw new ProductError('NOTICE_ID_CONFLICT', '原结算通知内容冲突', 409);
        return existing;
      }
      const body = SettlementReceipt.parse({
        binding,
        resolution: { id: this.dependencies.id(), outcome, evidenceDigest },
      });
      this.db
        .prepare(
          "INSERT INTO task_settlement_notices(operation_id,kind,profile_id,body,created_at) VALUES(?,'BUSINESS',?,?,?)",
        )
        .run(binding.operationId, binding.profileId, JSON.stringify(body), this.dependencies.now());
      this.db
        .prepare(
          "INSERT INTO task_settlement_delivery(operation_id,kind,state,claim_token,attempts,next_attempt_at,reason,updated_at) VALUES(?,'BUSINESS','PENDING',NULL,0,0,'BUSINESS_SETTLED',?)",
        )
        .run(binding.operationId, this.dependencies.now());
      return this.get(binding.operationId);
    });
  }
  claim(profileId: string): Notice | null {
    z.uuid().parse(profileId);
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT n.operation_id,n.kind FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id,kind) WHERE n.profile_id=? AND d.state='PENDING' AND d.next_attempt_at<=? AND NOT EXISTS(SELECT 1 FROM task_settlement_notices x JOIN task_settlement_delivery y USING(operation_id,kind) WHERE x.profile_id=n.profile_id AND y.state='SENDING') ORDER BY n.created_at,n.operation_id,n.kind LIMIT 1",
        )
        .get(profileId, this.dependencies.now());
      if (!row) return null;
      const id = String(row.operation_id);
      this.db
        .prepare(
          "UPDATE task_settlement_delivery SET state='SENDING',claim_token=?,attempts=attempts+1,updated_at=? WHERE operation_id=? AND kind=?",
        )
        .run(this.dependencies.id(), this.dependencies.now(), id, String(row.kind));
      return this.get(id, String(row.kind));
    });
  }
  private claimed(id: string, token: string): Notice {
    const claimed = this.db
      .prepare(
        "SELECT kind FROM task_settlement_delivery WHERE operation_id=? AND state='SENDING' AND claim_token=?",
      )
      .get(id, z.uuid().parse(token));
    if (!claimed) throw new ProductError('NOTICE_STALE_CLAIM', '结算通知发送代次已变化', 409);
    const notice = this.get(id, String(claimed.kind));
    if (notice.state !== 'SENDING' || notice.claimToken !== z.uuid().parse(token))
      throw new ProductError('NOTICE_STALE_CLAIM', '结算通知发送代次已变化', 409);
    return notice;
  }
  delivered(id: string, token: string, input: NoticeReceipt): void {
    const receipt = SettlementReceipt.parse(input);
    transaction(this.db, () => {
      if (!sameNotice(this.claimed(id, token), receipt))
        throw new ProductError('NOTICE_RECEIPT_MISMATCH', '结算通知回执不一致', 409);
      this.db
        .prepare(
          "UPDATE task_settlement_delivery SET state='DELIVERED',claim_token=NULL,reason='REMOTE_RECONCILED',updated_at=? WHERE operation_id=? AND claim_token=?",
        )
        .run(this.dependencies.now(), id, token);
    });
  }
  retry(id: string, token: string, reason: string): void {
    transaction(this.db, () => {
      const notice = this.claimed(id, token);
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(notice.attempts, 6));
      this.db
        .prepare(
          "UPDATE task_settlement_delivery SET state='PENDING',claim_token=NULL,next_attempt_at=?,reason=?,updated_at=? WHERE operation_id=? AND claim_token=?",
        )
        .run(
          this.dependencies.now() + delay,
          z.string().max(300).parse(reason),
          this.dependencies.now(),
          id,
          token,
        );
    });
  }
  recoverOnStartup(): void {
    transaction(this.db, () =>
      this.db
        .prepare(
          "UPDATE task_settlement_delivery SET state='PENDING',claim_token=NULL,next_attempt_at=0,reason='SERVICE_RESTART',updated_at=? WHERE state='SENDING'",
        )
        .run(this.dependencies.now()),
    );
  }
  ensureEnded(input: Binding, proposed: Disposition): Notice {
    const binding = DispatchBinding.parse(input),
      disposition = OperationDisposition.parse(proposed);
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          'SELECT o.status,b.body FROM task_outbox o JOIN task_dispatch_bindings b ON b.operation_id=o.id JOIN task_plans p ON p.id=o.job_id WHERE o.id=? AND p.ending_id IS NOT NULL AND p.ending_stop IS NOT NULL',
        )
        .get(binding.operationId);
      if (
        !row ||
        !['UNKNOWN', 'ACKNOWLEDGED'].includes(String(row.status)) ||
        !sameBinding(binding, DispatchBinding.parse(JSON.parse(String(row.body))))
      )
        throw Error('NOTICE_END_INTENT_AND_STOP_REQUIRED');
      if (
        this.db
          .prepare("SELECT 1 FROM task_settlement_notices WHERE operation_id=? AND kind='END'")
          .get(binding.operationId)
      ) {
        const old = this.get(binding.operationId, 'END');
        if (
          !sameBinding(old.binding, binding) ||
          old.resolution.evidenceDigest !== disposition.evidenceDigest
        )
          throw Error('NOTICE_END_CONFLICT');
        return old;
      }
      const body = SettlementReceipt.parse({ binding, resolution: disposition });
      this.db
        .prepare("INSERT INTO task_settlement_notices VALUES(?,'END',?,?,?)")
        .run(binding.operationId, binding.profileId, JSON.stringify(body), this.dependencies.now());
      this.db
        .prepare(
          "INSERT INTO task_settlement_delivery VALUES(?,'END','PENDING',NULL,0,0,'TASK_END_REQUESTED',?)",
        )
        .run(binding.operationId, this.dependencies.now());
      return this.get(binding.operationId, 'END');
    });
  }
}

type SettlementRepository = SynchronousRepository<CompatibleSettlementRepository>;
