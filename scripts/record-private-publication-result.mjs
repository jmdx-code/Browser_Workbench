import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? ''),
  planId = process.argv[3];
assert.ok(root.startsWith(path.resolve('audit') + path.sep) && planId);
const prepared = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8'));
const db = new DatabaseSync(
  path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
  {
    readOnly: true,
  },
);
let report;
try {
  const plan = db
    .prepare(
      'SELECT id,batch_id,profile_id,state,reason,control_confirmed,ending_stop FROM task_plans WHERE id=?',
    )
    .get(planId);
  assert.equal(plan?.batch_id, prepared.scope.id);
  assert.equal(plan.profile_id, prepared.scope.profileId);
  assert.ok(['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state), 'WAIT_FOR_ORIGINAL_TASK_END');
  const submissions = db
    .prepare(
      `SELECT m.operation_id,m.attempt_id,o.status,o.receipt,o.control_ended
    FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id
    WHERE o.job_id=? AND m.purpose='SUBMIT' ORDER BY m.created_at`,
    )
    .all(planId);
  assert.ok(submissions.length <= prepared.scope.maximumPublications);
  report = {
    checkedAt: new Date().toISOString(),
    plan,
    submissions: submissions.map((submission) => {
      const verdict = db
        .prepare('SELECT outcome,body FROM material_attempt_verdicts WHERE attempt_id=?')
        .get(submission.attempt_id);
      const publication = db
        .prepare(
          'SELECT attempt_id,account_id,post_id,created_at FROM material_publications WHERE attempt_id=?',
        )
        .get(submission.attempt_id);
      const result = db
        .prepare('SELECT body FROM facebook_submission_results WHERE operation_id=?')
        .get(submission.operation_id);
      const reservation = db
        .prepare('SELECT state,reason FROM material_reservations WHERE attempt_id=?')
        .get(submission.attempt_id);
      const delivery = db
        .prepare('SELECT kind,state FROM task_settlement_delivery WHERE operation_id=?')
        .all(submission.operation_id);
      if (publication) {
        assert.equal(verdict?.outcome, 'PUBLISHED');
        assert.equal(reservation?.state, 'PUBLISHED');
        if (submission.status !== 'VERIFIED') {
          assert.equal(submission.status, 'UNKNOWN');
          assert.equal(submission.control_ended, 1);
          const review = db
            .prepare(
              "SELECT 1 AS present FROM task_events WHERE job_id=? AND type='ENDED_SUBMISSION_BUSINESS_REVIEWED' AND json_extract(detail,'$.operationId')=? AND json_extract(detail,'$.outcome')='PUBLISHED'",
            )
            .get(planId, submission.operation_id);
          assert.equal(review?.present, 1);
        }
      }
      return {
        ...submission,
        receipt: submission.receipt ? JSON.parse(submission.receipt) : null,
        verdict: verdict ? JSON.parse(verdict.body) : null,
        result: result ? JSON.parse(result.body) : null,
        publication,
        reservation,
        delivery,
      };
    }),
    taskAssignments: 0,
    nativeInputs: 0,
    operationReplays: 0,
    browserRestarts: 0,
  };
} finally {
  db.close();
}
const file = path.join(root, 'original-business-result.json');
await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(
  JSON.stringify({
    file,
    state: report.plan.state,
    submissions: report.submissions.map((row) => ({
      operationId: row.operation_id,
      state: row.status,
      postId: row.publication?.post_id ?? null,
      reservation: row.reservation?.state ?? null,
    })),
  }),
);
