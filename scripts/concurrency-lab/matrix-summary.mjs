import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const report = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
assert.equal(report.complete, true);
const cases = report.results.find((row) => row.experiment === 'E1').results;
assert.equal(cases.length, 11);
const mean = (rows, select) => rows.reduce((sum, row) => sum + select(row), 0) / rows.length;
const results = cases.map((row) => {
  assert.equal(row.plans, row.profiles * (row.historyDepth + 1));
  assert.equal(row.running + row.queued, row.profiles);
  assert.ok(row.running <= 50);
  const rows = row.measurements.filter((sample) => sample.name === 'runtime-idle');
  const baseline = row.groups['runtime-uninstrumented'];
  const changed = row.groups['runtime-one-progress-changed'];
  const wallMean = mean(rows, (sample) => sample.durationMs);
  const prepareMean = mean(rows, (sample) => sample.prepareMs);
  const sqlMean = mean(rows, (sample) => sample.sqlMs);
  return {
    id: row.scenarioId,
    profiles: row.profiles,
    historyDepth: row.historyDepth,
    plans: row.plans,
    running: row.running,
    queued: row.queued,
    fixtureStates: row.fixtureStates,
    uninstrumented: baseline.duration,
    changed: changed.duration,
    instrumented: row.groups['runtime-idle'].duration,
    serialization: baseline.serialize,
    bytes: baseline.representative.responseBytes,
    queryCount: rows[0].sqlCalls,
    queryCategories: rows[0].sqlCategories,
    prepareMeanMs: prepareMean,
    executeMeanMs: sqlMean,
    prepareSharePct: (100 * prepareMean) / wallMean,
    bytesStableAcrossWarmSamples: new Set(rows.map((sample) => sample.responseBytes)).size === 1,
    schemaMs: Object.fromEntries(
      ['TaskOverview', 'TaskRuntimeOverview', 'TaskStepV2'].map((name) => [
        name,
        mean(rows, (sample) => sample.schemaMs[name] ?? 0),
      ]),
    ),
  };
});
const summary = {
  run: directory,
  runtime: report.electronMain,
  results,
  limits: [
    'synthetic history/status, no actors or browser',
    '20 samples/phase; ordered scenarios and warm baselines; no confidence bounds',
    'prepare includes compiler/native boundary and statement object allocation, not pure compiler CPU',
    'unmodified current read service; no statement-cache or pagination performance A/B performed',
    'large history fixture built by direct bulk inserts of generated valid rows, not real business completion',
  ],
};
await writeFile(path.join(directory, 'matrix-summary.json'), JSON.stringify(summary, null, 2));
const lines = [
  '| scenario | plans | runtime p50/p95 ms | bytes | queries | prepare mean/share |',
  '| --- | ---: | --- | ---: | ---: | --- |',
];
for (const row of results)
  lines.push(
    `| ${row.id} | ${row.plans} | ${row.uninstrumented.p50Ms.toFixed(2)} / ${row.uninstrumented.p95Ms.toFixed(2)} | ${row.bytes} | ${row.queryCount} | ${row.prepareMeanMs.toFixed(2)}ms / ${row.prepareSharePct.toFixed(1)}% |`,
  );
await writeFile(path.join(directory, 'matrix-summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
