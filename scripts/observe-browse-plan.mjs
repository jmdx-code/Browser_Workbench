import { taskRuntimeReader } from './task-runtime-reader.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [originalFile, outputFile] = process.argv.slice(2);
assert.ok(originalFile && outputFile && originalFile !== outputFile);
for (const file of [originalFile, outputFile])
  assert.ok(path.resolve(file).startsWith(path.resolve('audit') + path.sep));
try {
  await readFile(outputFile);
  throw Error('RECORDED_OBSERVATION_MUST_NOT_OVERWRITE');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const original = JSON.parse(await readFile(originalFile, 'utf8'));
const { profileId, planId } = original;
assert.ok(
  ['066430e1-92cd-4ee4-8f43-98db3425239d', '9e4d39b2-90b0-4267-aee2-311089b78336'].includes(
    profileId,
  ),
);
assert.ok(planId && !original.endedAt);
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const readRuntime = taskRuntimeReader(request);
async function request(route, input) {
  if (route === '/tasks/runtime') return readRuntime();
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'x-workbench-runtime-contract': '1',
      'x-workbench-task-contract': '4',
      'x-workbench-task-capacity': '2',
      'x-workbench-workspace-contract': '5',
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json();
  if (!response.ok) throw Error(route + ':' + response.status + ':' + JSON.stringify(value));
  return value;
}
const terminal = (state) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(state);
const report = {
  originalFile,
  profileId,
  planId,
  softwareVersion: original.softwareVersion,
  bridge: original.bridge,
  startedAt: new Date().toISOString(),
  reason: 'Continue observing the same live plan after manual foreground waiting.',
  taskAssignments: 0,
  operationReplays: 0,
  browserRestarts: 0,
  samples: [],
  errors: [],
};
const save = () => writeFile(outputFile, JSON.stringify(report, null, 2));
const initial = (await request('/tasks')).plans.find((plan) => plan.id === planId);
assert.ok(initial && initial.profileId === profileId && initial.state === 'RUNNING');
report.initial = initial;
await save();
console.log(JSON.stringify({ observing: planId, taskAssignments: 0 }));
try {
  const deadline = Date.now() + 8 * 60_000;
  let lastPrint = 0;
  while (Date.now() < deadline) {
    const runtime = await request('/tasks/runtime');
    const plan = runtime.plans.find((p) => p.id === planId);
    assert.ok(plan && plan.profileId === profileId);
    const step = runtime.currentSteps.find((s) => s.jobId === planId);
    const sample = {
      at: new Date().toISOString(),
      state: plan.state,
      reason: plan.reason,
      position: plan.position,
      type: step?.type,
      progress: step?.progress,
    };
    report.samples.push(sample);
    await save();
    if (Date.now() - lastPrint > 30_000 || terminal(plan.state)) {
      console.log(JSON.stringify(sample));
      lastPrint = Date.now();
    }
    if (terminal(plan.state) || ['PAUSED', 'REVIEW', 'PAUSING', 'STOPPING'].includes(plan.state))
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} catch (error) {
  report.errors.push(String(error));
} finally {
  try {
    const plan = (await request('/tasks')).plans.find((p) => p.id === planId);
    if (plan && !terminal(plan.state))
      report.stop = await request('/tasks/command', {
        command: 'stop',
        plans: [
          { planId, profileId, expectedState: plan.state, expectedUpdatedAt: plan.updatedAt },
        ],
      });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const plan = (await request('/tasks')).plans.find((p) => p.id === planId);
      if (plan && terminal(plan.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    report.final = await request('/tasks/history', { profileId, planId });
    report.native = await request('/profiles/native-review', { profileId });
  } catch (error) {
    report.errors.push(String(error));
  }
  const final = report.final?.plans.find((p) => p.id === planId);
  report.passed =
    final?.state === 'COMPLETED' &&
    report.errors.length === 0 &&
    report.final.steps.every(
      (s) =>
        s.status === 'COMPLETED' &&
        s.budget?.kind === 'time' &&
        s.progress.effectiveMilliseconds === s.budget.milliseconds,
    ) &&
    report.final.operations.every((o) => o.status === 'VERIFIED') &&
    report.native?.blockingCount === 0 &&
    report.native?.activeTabCount === 0;
  report.endedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      outputFile,
      passed: report.passed,
      state: final?.state,
      blocking: report.native?.blockingCount,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
