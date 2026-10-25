import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FilesystemMaterialUploadStage } from '../dist/src/infrastructure/material-upload-stage.js';
import { canonicalDataDirectory, productDataDirectory } from '../dist/src/infrastructure/paths.js';

const operationId = process.argv[2];
assert.ok(operationId, 'ORIGINAL_UPLOAD_REFERENCE_REQUIRED');
const data = await canonicalDataDirectory(productDataDirectory());
const db = new DatabaseSync(path.join(data, 'workspace.sqlite'), { readOnly: true });
let original;
try {
  original = db
    .prepare(
      'SELECT i.body,b.body AS binding FROM material_post_operations p JOIN material_post_intents i USING(attempt_id) JOIN task_dispatch_bindings b ON b.operation_id=p.operation_id WHERE p.operation_id=? AND p.purpose=?',
    )
    .get(operationId, 'UPLOAD_MEDIA');
  assert.ok(original);
} finally {
  db.close();
}
const intent = JSON.parse(original.body),
  binding = JSON.parse(original.binding);
const runId = randomUUID();
const reportRoot = path.resolve('audit/upload-preparation-measure-' + runId);
await mkdir(reportRoot);
const cacheRoot = await canonicalDataDirectory(path.join(data, 'upload-cache'));
const isolatedRoot = path.join(cacheRoot, 'local-measure-' + runId);
const writer = new FilesystemMaterialUploadStage(isolatedRoot);
let checks = 0;
const guard = () => {
  checks++;
};
const started = performance.now();
const manifest = await writer.stage(intent, binding, guard);
const stagedAt = performance.now();
const files = await writer.verify(intent, binding, manifest, guard);
const report = {
  originalOperationReference: operationId,
  referenceOnly: true,
  nativeInputs: 0,
  taskAssignments: 0,
  databaseWrites: 0,
  sourceFilesChanged: false,
  filesystemOnly: true,
  actorLedgerChecksMeasured: false,
  stagingMilliseconds: stagedAt - started,
  verificationMilliseconds: performance.now() - stagedAt,
  guardCalls: checks,
  fileCount: files.length,
  bytes: manifest.files.reduce((n, f) => n + f.original.bytes, 0),
  generatedCacheRoot: isolatedRoot,
  stageId: manifest.stageId,
};
await writeFile(path.join(reportRoot, 'result.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
});
console.log(JSON.stringify({ reportRoot, ...report }));
