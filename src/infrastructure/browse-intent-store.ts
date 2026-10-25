import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskRepository as CompatibleTaskRepository } from '../domain/tasks.js';
import type { BrowseIntentRepository as CompatibleBrowseIntentRepository } from '../domain/browse-execution.js';
import { validateBrowseIntent } from '../domain/browse-policy.js';
import { BrowseIntent, BrowseOperationIntent, type Intent } from '../shared/browse-execution.js';
import type { Action } from '../shared/browser-actions.js';
import { transaction } from './sqlite-transaction.js';

export class SqliteBrowseIntentRepository implements BrowseIntentRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: TaskRepository,
  ) {}
  get(operationId: string) {
    const row = this.db
      .prepare('SELECT body FROM task_browse_intents WHERE operation_id=?')
      .get(operationId);
    if (!row) throw Error('BROWSE_INTENT_REQUIRED');
    return BrowseOperationIntent.parse(JSON.parse(String(row.body)) as unknown);
  }
  hasAccountLiked(accountId: string | null, contentId: string): boolean {
    if (!accountId) return false;
    const rows = this.db
      .prepare(
        "SELECT i.body FROM task_browse_intents i JOIN task_outbox o ON o.id=i.operation_id JOIN task_plans p ON p.id=i.job_id WHERE p.account_id=? AND o.status IN ('DISPATCHING','ACKNOWLEDGED','UNKNOWN','VERIFIED')",
      )
      .all(accountId);
    return rows.some((row) => {
      try {
        const previous = BrowseOperationIntent.parse(
          JSON.parse(String(row.body)) as unknown,
        ).intent;
        return previous.kind === 'like' && previous.contentId === contentId;
      } catch {
        return false;
      }
    });
  }
  prepare(jobId: string, stepId: string, operationId: string, action: Action, input: Intent) {
    const intent = BrowseIntent.parse(input),
      body = BrowseOperationIntent.parse({ operationId, jobId, stepId, intent });
    return transaction(this.db, () => {
      const step = this.tasks.steps(jobId).find((row) => row.id === stepId);
      if (!step) throw Error('BROWSE_STEP_NOT_FOUND');
      validateBrowseIntent(step, action, intent);
      const exists = this.db
        .prepare('SELECT operation_id FROM task_browse_intents WHERE operation_id=?')
        .get(operationId);
      if (exists && JSON.stringify(this.get(operationId)) !== JSON.stringify(body))
        throw Error('BROWSE_INTENT_ID_CONFLICT');
      const plan = this.tasks.get(jobId);
      if (plan.profileId !== intent.proof.profileId) throw Error('BROWSE_INTENT_PROFILE_MISMATCH');
      if (intent.kind === 'like') {
        const rows = this.db
          .prepare(
            "SELECT i.body FROM task_browse_intents i JOIN task_outbox o ON o.id=i.operation_id JOIN task_plans p ON p.id=i.job_id WHERE p.account_id=? AND o.id<>? AND o.status IN ('DISPATCHING','ACKNOWLEDGED','UNKNOWN','VERIFIED')",
          )
          .all(plan.accountId, operationId);
        if (
          rows.some((row) => {
            const previous = BrowseOperationIntent.parse(
              JSON.parse(String(row.body)) as unknown,
            ).intent;
            return previous.kind === 'like' && previous.contentId === intent.contentId;
          })
        )
          throw Error('LIKE_CONTENT_ALREADY_USED_BY_ACCOUNT');
      }
      const operation = this.tasks.prepareOperation(jobId, stepId, operationId, action);
      if (!exists)
        this.db
          .prepare('INSERT INTO task_browse_intents VALUES(?,?,?,?,?)')
          .run(operationId, jobId, stepId, JSON.stringify(body), Date.now());
      return operation;
    });
  }
}

type TaskRepository = SynchronousRepository<CompatibleTaskRepository>;
type BrowseIntentRepository = SynchronousRepository<CompatibleBrowseIntentRepository>;
