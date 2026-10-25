import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { productDataDirectory } from '../dist/src/infrastructure/paths.js';

// Read-only: do not instantiate stores, recover operations, or export connection secrets.
const directory = productDataDirectory();
const product = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
const journal = new DatabaseSync(path.join(directory, 'journal.sqlite'), { readOnly: true });
try {
  const count = (db, sql) => Number(db.prepare(sql).get().count);
  const report = {
    recordedAt: new Date().toISOString(),
    readOnly: true,
    directory,
    schema: {
      product: product.prepare('PRAGMA user_version').get().user_version,
      journal: journal.prepare('PRAGMA user_version').get().user_version,
    },
    profiles: count(journal, 'SELECT count(*) AS count FROM profiles'),
    groups: product.prepare('SELECT name FROM groups ORDER BY sort_order').all(),
    plans: count(product, 'SELECT count(*) AS count FROM task_plans'),
    activePlans: count(
      product,
      "SELECT count(*) AS count FROM task_plans WHERE state NOT IN ('STOPPED','COMPLETED','FAILED')",
    ),
    unresolvedOutbox: count(
      product,
      "SELECT count(*) AS count FROM task_outbox WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
    ),
    unresolvedBridgeOperations: count(
      journal,
      "SELECT count(*) AS count FROM operations WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
    ),
    activeBridgeTasks: count(
      journal,
      "SELECT count(*) AS count FROM tasks WHERE status IN ('PREPARED','RUNNING')",
    ),
    combinations: product
      .prepare('SELECT version,body FROM combination_versions ORDER BY version')
      .all()
      .map((row) => {
        const body = JSON.parse(String(row.body));
        return {
          version: row.version,
          name: body.name,
          steps: body.steps,
          loop: body.loop,
          randomOrder: body.randomOrder,
        };
      }),
  };
  await writeFile(
    process.env.WORKBENCH_KERNEL_PREFLIGHT_REPORT ?? 'audit/kernel-preflight.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      ...report,
      combinations: report.combinations.map(({ name, version, steps }) => ({
        name,
        version,
        steps: steps.length,
      })),
    }),
  );
  if (
    report.schema.product !== 2 ||
    report.schema.journal !== 2 ||
    report.activePlans ||
    report.unresolvedOutbox ||
    report.unresolvedBridgeOperations ||
    report.activeBridgeTasks
  ) {
    throw Error('KERNEL_PREFLIGHT_REQUIRES_REVIEW');
  }
} finally {
  product.close();
  journal.close();
}
