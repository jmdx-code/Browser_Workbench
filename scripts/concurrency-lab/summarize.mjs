import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [e5Dir, e1Dir] = process.argv.slice(2).map((value) => path.resolve(value));
const e5Run = JSON.parse(await readFile(path.join(e5Dir, 'results.json'), 'utf8'));
const e1Run = JSON.parse(await readFile(path.join(e1Dir, 'results.json'), 'utf8'));
if (!e5Run.complete || !e1Run.complete) throw Error('INCOMPLETE_RUN');
const e5 = e5Run.results
  .filter((row) => row.experiment === 'E5')
  .map((row) => ({
    name: row.name,
    actionMs: row.durationMs,
    requestWallMs: row.requestWallMs,
    utilityTimerGapMaxMs: row.gatewayTimerGapMaxMs,
    histogramMaxMs: row.gatewayDelayMaxMs,
    error: row.error,
    value: row.value,
    count: row.count,
    expectationMet: row.expectationMet,
    workerExited: row.workerExited ?? null,
    workerVersions: row.workerVersions ?? null,
  }));
const e1 = e1Run.results
  .find((row) => row.experiment === 'E1')
  .results.map((row) => {
    const names = [
      'workspace-first-account-cache',
      'workspace-idle',
      'runtime-idle',
      'runtime-one-progress-changed',
      'runtime-uninstrumented',
    ];
    const phases = Object.fromEntries(names.map((name) => [name, row.groups[name]]));
    const idle = row.measurements.filter((sample) => sample.name === 'runtime-idle');
    const rootTotal = idle.reduce(
      (sum, sample) =>
        sum +
        Object.values(sample.repositoryMs).reduce((a, b) => a + b, 0) +
        (sample.schemaMs.TaskOverview ?? 0) +
        (sample.schemaMs.TaskRuntimeOverview ?? 0),
      0,
    );
    return {
      profiles: row.profiles,
      plans: row.plans,
      activePlans: row.activePlans,
      phases,
      readpathRootAttributionPercent:
        (100 * rootTotal) / idle.reduce((sum, sample) => sum + sample.durationMs, 0),
    };
  });
const summary = {
  createdAt: new Date().toISOString(),
  evidence: { e5: e5Dir, e1: e1Dir },
  runtime: e5Run.electronMain,
  host: e5Run.host,
  e5,
  e1,
  limitations: [
    'generated data; no browser/RPC or business execution',
    'E5 one sample per case in final run',
    'E1 twenty warm samples per phase; sequential 12/50/100 sizes, JIT/cache/order effects',
    'Root attribution includes nested SQL/JSON/schema time: do not add all timing fields',
    'First exploratory run missed a long block in histogram; explicit timer gaps captured it; final run warmed sampling before action',
    'E5 dev Electron 44.7 utilityProcess/worker verified, packaged server entry not executed',
    'E1 readpath only; no live transport/event flow, no production profiler or full scheduling mix',
    'No E2/E3/E4/E6/E7 result or hundred-browser acceptance implied',
  ],
  nodeUpgrade: {
    current: e5Run.host.versions.node,
    status: 'not_performed',
    reason:
      'automatic approval rejected official MSI download-and-silent-install command: blocked by policy; no workaround attempted',
  },
};
await writeFile(path.join(e1Dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({
    summary: path.join(e1Dir, 'summary.json'),
    cases: e5.length,
    allMechanismExpectationsMet: e5.every((row) => row.expectationMet),
    sizes: e1.map((row) => row.profiles),
  }),
);
