import { taskRuntimeReader } from './task-runtime-reader.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { findSavedBrowseCombination } from './saved-browse-combination.mjs';

const profileId = '066430e1-92cd-4ee4-8f43-98db3425239d';
const file = path.resolve(process.argv[2] ?? '');
assert.ok(file.startsWith(path.resolve('audit') + path.sep) && file.endsWith('.json'));
await writeFile(file, '{}', { flag: 'wx' });
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin + '/workbench/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
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
      'x-workbench-workspace-contract': '6',
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json();
  if (!response.ok) throw Error(route + ':' + response.status + ':' + JSON.stringify(value));
  return value;
}
const report = {
  startedAt: new Date().toISOString(),
  profileId,
  likes: 0,
  publishing: false,
  browserRestarts: 0,
  trials: [],
  errors: [],
};
const save = () => writeFile(file, JSON.stringify(report, null, 2));
const terminal = (state) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(state);
let currentId;
function pages(planId) {
  const db = new DatabaseSync(
    path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
    { readOnly: true },
  );
  try {
    return db
      .prepare(
        'SELECT o.proof,s.state,s.reason,s.context FROM task_tab_ownership o JOIN task_tab_state s ON s.ownership_id=o.ownership_id AND s.job_id=o.job_id WHERE o.job_id=?',
      )
      .all(planId)
      .map((row) => ({
        ...row,
        proof: JSON.parse(row.proof),
        context: row.context ? JSON.parse(row.context) : null,
      }));
  } finally {
    db.close();
  }
}
async function stop(planId) {
  const current = (await request('/tasks')).plans.find((p) => p.id === planId);
  if (!current || terminal(current.state)) return;
  await request('/tasks/command', {
    command: 'stop',
    plans: [
      { planId, profileId, expectedState: current.state, expectedUpdatedAt: current.updatedAt },
    ],
  });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const plan = (await request('/tasks')).plans.find((p) => p.id === planId);
    if (terminal(plan?.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('STOP_CONFIRMATION_TIMEOUT');
}
try {
  const workspace = await request('');
  const profile = workspace.profiles.find((p) => p.id === profileId);
  assert.ok(['0.3.31', '0.3.32'].includes(profile?.extensionVersion), 'BRIDGE_VERSION_REQUIRED');
  assert.ok(profile.online && profile.synced);
  assert.ok(
    !(await request('/tasks')).plans.some((p) => p.profileId === profileId && !terminal(p.state)),
  );
  report.before = await request('/profiles/native-review', { profileId });
  assert.equal(report.before.blockingCount, 0);
  assert.ok(
    report.before.activeTabCount === 0 ||
      (report.before.activeTabCount === 1 &&
        report.before.tabs[0]?.reason === 'WORKSPACE_MAIN_IDLE'),
  );
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  report.backup = await request('/backups/create', { directory: path.dirname(file) });
  assert.equal(report.backup.softwareVersion, version);
  const value = {
    name: '验收 · 主页复用',
    note: 'Fresh read-only browsing scope; no likes or publishing.',
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  };
  const saved = findSavedBrowseCombination(workspace.combinations, value);
  report.reusedCombination = !!saved;
  report.combination = saved ?? (await request('/combinations/create', { value }));
  for (let index = 0; index < 2; index++) {
    const trial = { requestId: randomUUID(), samples: [] };
    report.trials.push(trial);
    await save();
    trial.start = await request('/tasks/start', {
      requestId: trial.requestId,
      combinationId: report.combination.id,
      version: report.combination.version,
      profileIds: [profileId],
    });
    currentId = trial.start.plans[0]?.id;
    assert.ok(currentId);
    trial.planId = currentId;
    await save();
    const deadline = Date.now() + 600_000;
    let lastPrint = 0;
    while (Date.now() < deadline) {
      const runtime = await request('/tasks/runtime');
      const plan = runtime.plans.find((p) => p.id === currentId);
      const step = runtime.currentSteps.find((s) => s.jobId === currentId);
      const sample = {
        at: new Date().toISOString(),
        state: plan?.state,
        reason: plan?.reason,
        progress: step?.progress,
      };
      if (
        plan?.state === 'RUNNING' &&
        plan.reason === 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' &&
        !trial.display
      ) {
        trial.display = await request('/profiles/show', { profileId });
      }
      trial.samples.push(sample);
      await save();
      if (Date.now() - lastPrint > 15_000 || terminal(plan?.state)) {
        console.log(JSON.stringify(sample));
        lastPrint = Date.now();
      }
      if (terminal(plan?.state) || ['PAUSED', 'REVIEW', 'PAUSING'].includes(plan?.state)) break;
      if (index === 1 && step?.progress.effectiveMilliseconds >= 10_000) {
        const history = await request('/tasks/history', { profileId, planId: currentId });
        if (
          !history.operations.some((op) =>
            ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
          )
        ) {
          await stop(currentId);
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await stop(currentId);
    trial.history = await request('/tasks/history', { profileId, planId: currentId });
    trial.pages = pages(currentId);
    trial.after = await request('/profiles/native-review', { profileId });
    await save();
    const plan = trial.history.plans.find((p) => p.id === currentId);
    assert.equal(plan?.state, index === 0 ? 'COMPLETED' : 'STOPPED');
    assert.equal(trial.pages.length, 1);
    assert.equal(trial.pages[0].state, 'RELEASED');
    assert.equal(trial.after.blockingCount, 0);
    assert.equal(trial.after.tabs[0]?.reason, 'WORKSPACE_MAIN_IDLE');
    if (index === 1) assert.deepEqual(trial.pages[0].proof, report.trials[0].pages[0].proof);
    currentId = undefined;
  }
  report.passed = true;
} catch (error) {
  report.errors.push(String(error));
  report.passed = false;
} finally {
  if (currentId) {
    try {
      await stop(currentId);
    } catch (error) {
      report.errors.push(String(error));
    }
  }
  report.endedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ file, passed: report.passed, errors: report.errors }));
  if (!report.passed) process.exitCode = 1;
}
