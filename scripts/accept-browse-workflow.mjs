import { taskRuntimeReader } from './task-runtime-reader.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findSavedBrowseCombination } from './saved-browse-combination.mjs';

const args = process.argv.slice(2);
assert.equal(
  args.length,
  6,
  'Use --profile UUID --mode feed|mixed|timing|navigation|video --report audit/file.json',
);
assert.equal(args[0], '--profile');
assert.equal(args[2], '--mode');
assert.equal(args[4], '--report');
const profileId = args[1],
  mode = args[3],
  file = path.resolve(args[5]);
assert.ok(
  ['9e4d39b2-90b0-4267-aee2-311089b78336', '066430e1-92cd-4ee4-8f43-98db3425239d'].includes(
    profileId,
  ),
);
assert.ok(['feed', 'mixed', 'timing', 'navigation', 'video'].includes(mode));
assert.ok(file.startsWith(path.resolve('audit') + path.sep) && file.endsWith('.json'));
try {
  await readFile(file);
  throw Error('RECORDED_SCOPE_MUST_NOT_REPLAY');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(path.dirname(file), { recursive: true });
const origin = 'http://127.0.0.1:18767';
let cookie;
const bootstrapDeadline = Date.now() + 30_000;
while (!cookie) {
  try {
    const response = await fetch(origin + '/workbench/', { signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok, 'WORKBENCH_BOOTSTRAP_REJECTED');
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'WORKBENCH_SESSION_REQUIRED');
  } catch (error) {
    // Only retry the pre-assignment GET during software restart, never a task POST.
    if (error.cause?.code !== 'ECONNREFUSED' || Date.now() >= bootstrapDeadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
assert.ok(cookie);
const readRuntime = taskRuntimeReader(request);
async function request(route, input, headers = {}) {
  if (route === '/tasks/runtime') return readRuntime();
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'x-workbench-runtime-contract': '1',
      'x-workbench-task-contract': '4',
      'x-workbench-task-capacity': '2',
      'x-workbench-workspace-contract': '6',
      ...headers,
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = Error(route + ':HTTP_' + response.status + ':' + JSON.stringify(value));
    error.code = value.code;
    throw error;
  }
  return value;
}
async function review() {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      return await request('/profiles/native-review', { profileId });
    } catch (error) {
      if (error.code !== 'NATIVE_REVIEW_BUSY' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
const report = {
  requestId: randomUUID(),
  profileId,
  mode,
  diagnosticOnly: ['timing', 'navigation', 'video'].includes(mode),
  startedAt: new Date().toISOString(),
  taskPageClaimedByCUA: false,
  likes: 0,
  publishing: false,
  browserRestarts: 0,
  samples: [],
  errors: [],
};
const save = () => writeFile(file, JSON.stringify(report, null, 2));
let planId;
const terminal = (state) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(state);
const idlePages = (review) =>
  review?.blockingCount === 0 &&
  (review.activeTabCount === 0 ||
    (review.activeTabCount === 1 && review.tabs[0]?.reason === 'WORKSPACE_MAIN_IDLE'));
try {
  const sourceVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const tasks = await request('/tasks');
  assert.ok(
    !tasks.plans.some((p) => p.profileId === profileId && !terminal(p.state)),
    'PROFILE_TASKS_NOT_IDLE',
  );
  const workspace = await request('');
  const selected = workspace.profiles.find((p) => p.id === profileId);
  assert.ok(selected?.online && selected.synced, 'PROFILE_NOT_CONNECTED');
  report.bridge = {
    profileId,
    browserName: selected.browserName,
    extensionVersion: selected.extensionVersion,
  };
  report.before = await review();
  assert.ok(idlePages(report.before), 'PROFILE_NATIVE_PAGES_NOT_IDLE');
  // The backup manifest reports the running controller version, not the version on disk.
  report.backup = await request('/backups/create', { directory: path.dirname(file) });
  assert.equal(report.backup.softwareVersion, sourceVersion, 'RUNNING_VERSION_DIFFERS');
  report.softwareVersion = report.backup.softwareVersion;
  const value = {
    name:
      mode === 'video'
        ? '诊断 · 原生Reels下一条'
        : mode === 'navigation'
          ? '诊断 · 原生导航往返'
          : mode === 'timing'
            ? '诊断 · 单资料浏览分段计时'
            : mode === 'mixed'
              ? '验收 · 首页2分钟 → Reels3分钟'
              : '验收 · 首页2分钟',
    note: 'New scope; original task chain; no likes or publishing.',
    steps: [
      {
        id: randomUUID(),
        type: mode === 'video' ? 'video' : 'feed',
        durationMinutes: ['timing', 'navigation', 'video'].includes(mode) ? 1 : 2,
        maxLikes: 0,
        minLikeCount: 0,
      },
      ...(mode === 'mixed' || mode === 'navigation'
        ? [
            {
              id: randomUUID(),
              type: 'video',
              durationMinutes: mode === 'navigation' ? 1 : 3,
              maxLikes: 0,
              minLikeCount: 0,
            },
          ]
        : []),
    ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  };
  await save();
  const saved = findSavedBrowseCombination(workspace.combinations, value);
  report.reusedCombination = !!saved;
  report.combination = saved ?? (await request('/combinations/create', { value }));
  report.start = await request('/tasks/start', {
    requestId: report.requestId,
    combinationId: report.combination.id,
    version: report.combination.version,
    profileIds: [profileId],
  });
  planId = report.start.plans[0]?.id;
  assert.ok(planId);
  report.planId = planId;
  await save();
  const deadline =
    Date.now() + (mode === 'timing' ? 90_000 : mode === 'mixed' ? 1_200_000 : 480_000);
  let lastPrint = 0;
  while (Date.now() < deadline) {
    const runtime = await request('/tasks/runtime');
    const plan = runtime.plans.find((p) => p.id === planId);
    assert.ok(plan);
    const step = runtime.currentSteps.find((s) => s.jobId === planId);
    const sample = {
      at: new Date().toISOString(),
      state: plan.state,
      reason: plan.reason,
      position: plan.position,
      type: step?.type,
      progress: step?.progress,
    };
    if (
      plan.state === 'RUNNING' &&
      plan.reason === 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' &&
      !report.display
    )
      report.display = await request('/profiles/show', { profileId });
    report.samples.push(sample);
    await save();
    if (Date.now() - lastPrint > 30_000 || terminal(plan.state)) {
      console.log(JSON.stringify(sample));
      lastPrint = Date.now();
    }
    if (terminal(plan.state) || ['PAUSED', 'REVIEW', 'PAUSING'].includes(plan.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} catch (error) {
  report.errors.push(String(error));
} finally {
  if (planId) {
    try {
      const current = (await request('/tasks')).plans.find((p) => p.id === planId);
      if (current && !terminal(current.state))
        report.stop = await request('/tasks/command', {
          command: 'stop',
          plans: [
            {
              planId,
              profileId,
              expectedState: current.state,
              expectedUpdatedAt: current.updatedAt,
            },
          ],
        });
      const stopDeadline = Date.now() + 45_000;
      while (Date.now() < stopDeadline) {
        const settled = (await request('/tasks')).plans.find((p) => p.id === planId);
        if (settled && terminal(settled.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      report.final = await request('/tasks/history', { profileId, planId });
      report.after = await review();
    } catch (error) {
      report.errors.push(String(error));
    }
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
    report.final.operations.every((op) => op.status === 'VERIFIED') &&
    idlePages(report.after);
  report.endedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      file,
      planId,
      passed: report.passed,
      errors: report.errors,
      finalState: final?.state,
      nativeBlocking: report.after?.blockingCount,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
