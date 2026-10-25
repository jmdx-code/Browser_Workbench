import { taskRuntimeReader } from './task-runtime-reader.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findSavedBrowseCombination } from './saved-browse-combination.mjs';

assert.ok([4, 6].includes(process.argv.length), 'Use --report audit/fresh.json [--mode mixed]');
assert.equal(process.argv[2], '--report');
const mode = process.argv.length === 6 ? process.argv[5] : 'isolation';
if (process.argv.length === 6) assert.equal(process.argv[4], '--mode');
assert.ok(['mixed', 'isolation'].includes(mode));
const file = path.resolve(process.argv[3]);
assert.ok(file.startsWith(path.resolve('audit') + path.sep) && file.endsWith('.json'));
const profiles = ['066430e1-92cd-4ee4-8f43-98db3425239d', '9e4d39b2-90b0-4267-aee2-311089b78336'];
const origin = 'http://127.0.0.1:18767';
let cookie;
const bootstrapDeadline = Date.now() + 30_000;
while (!cookie) {
  try {
    const landing = await fetch(origin + '/workbench/', { signal: AbortSignal.timeout(3000) });
    cookie = landing.headers.get('set-cookie')?.split(';')[0];
    assert.ok(landing.ok && cookie);
  } catch (error) {
    // Retry only this pre-assignment GET while the normal software starts.
    if (error.cause?.code !== 'ECONNREFUSED' || Date.now() >= bootstrapDeadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
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
      'x-workbench-workspace-contract': '6',
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
const report = {
  requestId: randomUUID(),
  mode,
  startedAt: new Date().toISOString(),
  profiles,
  publishing: false,
  likes: 0,
  browserRestarts: 0,
  samples: [],
  displays: [],
  errors: [],
  plans: [],
  final: [],
};
// Reserve the report before assignment. Recorded scopes cannot be started again.
await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
const save = () => writeFile(file, JSON.stringify(report, null, 2));
const terminal = (state) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(state);
const pending = (history) =>
  history.operations.some((op) => ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status));
const idle = (review) =>
  review.blockingCount === 0 &&
  (review.activeTabCount === 0 ||
    (review.activeTabCount === 1 && review.tabs[0]?.reason === 'WORKSPACE_MAIN_IDLE'));
async function sample() {
  const runtime = await request('/tasks/runtime');
  const rows = report.plans.map(({ id, profileId }) => {
    const plan = runtime.plans.find((p) => p.id === id);
    assert.ok(plan, 'ASSIGNED_PLAN_MISSING');
    const step = runtime.currentSteps.find((s) => s.jobId === id);
    return {
      planId: id,
      profileId,
      state: plan.state,
      reason: plan.reason,
      progress: step?.progress,
    };
  });
  report.samples.push({ at: new Date().toISOString(), rows });
  await save();
  return rows;
}
async function waitFor(predicate, label, milliseconds = 180_000) {
  const deadline = Date.now() + milliseconds;
  let lastPrint = 0;
  while (Date.now() < deadline) {
    const rows = await sample();
    if (Date.now() - lastPrint > 15_000) {
      console.log(JSON.stringify({ label, rows }));
      lastPrint = Date.now();
    }
    if (await predicate(rows)) return rows;
    assert.ok(
      !rows.some(
        (row) =>
          ['FAILED', 'PAUSED', 'REVIEW', 'PAUSING'].includes(row.state) ||
          (mode === 'mixed' && ['STOPPED', 'STOPPING'].includes(row.state)),
      ),
      'UNEXPECTED_TASK_INTERRUPTION',
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error('ACCEPTANCE_TIMEOUT:' + label);
}
async function display(index) {
  const expected = readyOriginalPage(index);
  assert.ok(expected, 'ORIGINAL_MAIN_PAGE_NOT_READY');
  let result;
  const deadline = Date.now() + 10_000;
  while (!result) {
    try {
      result = await request('/profiles/show', { profileId: profiles[index] });
    } catch (error) {
      if (
        ![
          'WORKSPACE_REVEAL_CHANNEL_BUSY',
          'WORKSPACE_REVEAL_UNCONFIRMED',
          'BROWSER_BUSY',
          'BROWSER_SHOW_PENDING',
        ].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.equal(result.tabId, expected.tabId, 'DISPLAY_MUST_REUSE_ORIGINAL_MAIN');
  report.displays.push({
    profileId: profiles[index],
    result,
    at: new Date().toISOString(),
  });
  await save();
}
function readyOriginalPage(index) {
  const plan = report.plans[index];
  if (!plan) return null;
  const db = new DatabaseSync(
    path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
    { readOnly: true },
  );
  try {
    const rows = db
      .prepare(
        "SELECT o.proof,s.context FROM task_tab_ownership o JOIN task_tab_state s ON s.ownership_id=o.ownership_id AND s.job_id=o.job_id JOIN task_plans p ON p.id=o.job_id WHERE o.job_id=? AND s.profile_id=? AND s.state='READY' AND p.state='RUNNING'",
      )
      .all(plan.id, plan.profileId);
    if (rows.length !== 1 || !rows[0]?.context) return null;
    const proof = JSON.parse(String(rows[0].proof)),
      context = JSON.parse(String(rows[0].context));
    if (proof.profileId !== plan.profileId || context.profileId !== plan.profileId) return null;
    // Test prerequisite only. The software rechecks native ownership before display;
    // neither this read-only row nor display grants permission for task input.
    return proof;
  } finally {
    db.close();
  }
}
async function review(profileId) {
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
async function stop(plan) {
  const current = (await request('/tasks')).plans.find((p) => p.id === plan.id);
  if (current && !terminal(current.state))
    await request('/tasks/command', {
      command: 'stop',
      plans: [
        {
          planId: plan.id,
          profileId: plan.profileId,
          expectedState: current.state,
          expectedUpdatedAt: current.updatedAt,
        },
      ],
    });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const settled = (await request('/tasks')).plans.find((p) => p.id === plan.id);
    if (settled && terminal(settled.state)) return settled;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error('STOP_UNCONFIRMED:' + plan.id);
}
try {
  const workspace = await request('');
  const tasks = await request('/tasks');
  assert.ok(tasks.settings.maxConcurrentProfiles >= 2, 'TWO_PROFILE_CAPACITY_REQUIRED');
  for (const profileId of profiles) {
    const selected = workspace.profiles.find((p) => p.id === profileId);
    assert.ok(
      selected?.online &&
        selected.synced &&
        ['0.3.31', '0.3.32'].includes(selected.extensionVersion),
      'PROFILE_NOT_READY',
    );
    assert.ok(
      !tasks.plans.some((p) => p.profileId === profileId && !terminal(p.state)),
      'PROFILE_TASK_NOT_IDLE',
    );
    const native = await review(profileId);
    assert.ok(idle(native), 'PROFILE_NATIVE_NOT_IDLE');
  }
  report.backup = await request('/backups/create', { directory: path.dirname(file) });
  assert.equal(
    report.backup.softwareVersion,
    JSON.parse(await readFile('package.json', 'utf8')).version,
  );
  const value = {
    name: mode === 'mixed' ? '验收 · 两份完整首页→Reels' : '验收 · 两份资料停止隔离',
    note: 'Fresh two-profile browsing only; explicit display is separate from automatic focus.',
    steps:
      mode === 'mixed'
        ? [
            { id: randomUUID(), type: 'feed', durationMinutes: 2, maxLikes: 0, minLikeCount: 0 },
            { id: randomUUID(), type: 'video', durationMinutes: 3, maxLikes: 0, minLikeCount: 0 },
          ]
        : [{ id: randomUUID(), type: 'feed', durationMinutes: 3, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  };
  const saved = findSavedBrowseCombination(workspace.combinations, value);
  report.combination = saved ?? (await request('/combinations/create', { value }));
  await save();
  const start = await request('/tasks/start', {
    requestId: report.requestId,
    combinationId: report.combination.id,
    version: report.combination.version,
    profileIds: profiles,
  });
  report.plans = profiles.map((profileId) => {
    const plan = start.plans.find((p) => p.profileId === profileId);
    assert.ok(plan);
    return { id: plan.id, profileId };
  });
  await save();
  if (mode === 'mixed') {
    // Both original plans stay admitted; explicit display selects the visible budget.
    // This tests full workflows with foreground waiting, not background timing or fairness.
    for (let index = 0; index < profiles.length; index++) {
      await waitFor(
        (rows) =>
          rows[index].state === 'RUNNING' &&
          rows.every((row) => ['RUNNING', 'COMPLETED'].includes(row.state)) &&
          !!readyOriginalPage(index),
        'mixed-profile-admission-' + index,
      );
      await display(index);
      await waitFor(
        (rows) => rows[index].state === 'COMPLETED',
        'mixed-profile-complete-' + index,
        900_000,
      );
    }
    report.fullWorkflowsCompleted = true;
  } else {
    await waitFor(
      (rows) => rows[0].state === 'RUNNING' && !!readyOriginalPage(0),
      'first-admission-ready',
    );
    await display(0);
    await waitFor(
      (rows) => (rows[0].progress?.effectiveMilliseconds ?? 0) >= 10_000,
      'first-profile-progress',
    );
    await waitFor(
      (rows) => rows[1].state === 'RUNNING' && !!readyOriginalPage(1),
      'second-admission-ready',
    );
    await display(1);
    await waitFor(
      (rows) =>
        rows.every((row) => row.state === 'RUNNING') &&
        (rows[1].progress?.effectiveMilliseconds ?? 0) >= 10_000,
      'both-running-with-real-progress',
    );
    await waitFor(
      async () =>
        !pending(
          await request('/tasks/history', { profileId: profiles[0], planId: report.plans[0].id }),
        ),
      'first-original-input-settled',
      45_000,
    );
    const beforeStop = await sample();
    report.stoppedFirst = await stop(report.plans[0]);
    assert.equal(report.stoppedFirst.state, 'STOPPED');
    const baseline = beforeStop[1].progress.effectiveMilliseconds;
    const after = await waitFor(
      (rows) =>
        rows[0].state === 'STOPPED' &&
        rows[1].state === 'RUNNING' &&
        rows[1].progress.effectiveMilliseconds >= baseline + 10_000,
      'second-continues-after-first-stop',
    );
    report.isolation = { beforeStop, after, minimumSecondAdditionalMilliseconds: 10_000 };
    await waitFor(
      async () =>
        !pending(
          await request('/tasks/history', { profileId: profiles[1], planId: report.plans[1].id }),
        ),
      'second-original-input-settled',
      45_000,
    );
  }
} catch (error) {
  report.errors.push(String(error));
} finally {
  for (const plan of report.plans) {
    try {
      await stop(plan);
    } catch (error) {
      report.errors.push(String(error));
    }
    try {
      const history = await request('/tasks/history', {
        profileId: plan.profileId,
        planId: plan.id,
      });
      const native = await review(plan.profileId);
      report.final.push({ plan, history, native });
    } catch (error) {
      report.errors.push(String(error));
    }
  }
  report.passed =
    (mode === 'mixed' ? !!report.fullWorkflowsCompleted : !!report.isolation) &&
    !report.errors.length &&
    report.final.length === 2 &&
    report.final.every(
      ({ plan, history, native }) =>
        history.plans.find((p) => p.id === plan.id)?.state ===
          (mode === 'mixed' ? 'COMPLETED' : 'STOPPED') &&
        (mode !== 'mixed' ||
          (history.steps.length === 2 &&
            history.steps.every(
              (step) =>
                step.status === 'COMPLETED' &&
                step.round === 1 &&
                step.type ===
                  (step.position === 0 ? 'feed' : step.position === 1 ? 'video' : null) &&
                step.progress.effectiveMilliseconds >= (step.type === 'feed' ? 120_000 : 180_000),
            ))) &&
        history.operations.every((op) => op.status === 'VERIFIED') &&
        idle(native),
    );
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ file, passed: report.passed, errors: report.errors }));
}
process.exitCode = report.passed ? 0 : 1;
