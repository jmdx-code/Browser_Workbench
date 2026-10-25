import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { taskRuntimeReader } from './task-runtime-reader.mjs';

// One explicit, non-replayable scope on the two previously designated test profiles.
const file = process.argv[2] ?? 'audit/release-098-live-browse-stop.json';
assert.ok(path.resolve(file).startsWith(path.resolve('audit') + path.sep));
assert.ok(file.endsWith('.json'));
const stopOnly = process.argv[3] === '--stop-only';
const module = process.argv.includes('--video') ? 'video' : 'feed';
const backgroundStrict = process.argv.includes('--background');
const completeBoth = process.argv.includes('--complete-both');
const stopOnAdvance = process.argv.includes('--stop-on-advance');
assert.ok(!stopOnAdvance || (stopOnly && module === 'video'));
try {
  await readFile(file);
  throw Error('RECORDED_SCOPE_MUST_NOT_REPLAY');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const profileIds = ['066430e1-92cd-4ee4-8f43-98db3425239d', '9e4d39b2-90b0-4267-aee2-311089b78336'];
if (stopOnly) profileIds.shift();
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
      origin,
      'content-type': 'application/json',
      'x-workbench-workspace-contract': '6',
      'x-workbench-task-contract': '4',
      'x-workbench-task-capacity': '2',
      'x-workbench-runtime-contract': '1',
      'x-workbench-records-contract': '1',
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(45000),
  });
  const value = await response.json();
  assert.ok(response.ok, route + ':' + response.status + ':' + JSON.stringify(value));
  return value;
}
const terminal = (p) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(p.state);
const report = {
  at: new Date().toISOString(),
  requestId: randomUUID(),
  profileIds,
  likes: 0,
  module,
  backgroundStrict,
  completeBoth,
  stopOnAdvance,
  posts: 0,
  browserRestarts: 0,
  samples: [],
  errors: [],
};
const save = () => writeFile(file, JSON.stringify(report, null, 2));
let plans = [];
async function stop(plan) {
  const start = performance.now();
  const value = await request('/tasks/command', {
    command: 'stop',
    plans: [
      {
        planId: plan.id,
        profileId: plan.profileId,
        expectedState: plan.state,
        expectedUpdatedAt: plan.updatedAt,
      },
    ],
  });
  return { wallMs: performance.now() - start, value };
}
try {
  const runtime = await request('/tasks/runtime');
  assert.ok(
    !runtime.plans.some((p) => profileIds.includes(p.profileId) && !terminal(p)),
    'TEST_PROFILES_NOT_IDLE',
  );
  const workspace = await request('');
  for (const id of profileIds) {
    const p = workspace.profiles.find((p) => p.id === id);
    assert.ok(p?.online && p.synced && !p.unresolved, 'TEST_PROFILE_NOT_READY');
  }
  report.before = [];
  for (const profileId of profileIds) {
    const review = await request('/profiles/native-review', { profileId });
    assert.equal(review.blockingCount, 0, 'NATIVE_REVIEW_BLOCKING');
    assert.ok(
      review.activeTabCount === 0 ||
        (review.activeTabCount === 1 && review.tabs[0]?.reason === 'WORKSPACE_MAIN_IDLE'),
    );
    report.before.push(review);
  }
  await save();
  report.start = await request('/tasks/test', {
    requestId: report.requestId,
    profileIds,
    module,
    durationMinutes: 1,
    maxLikes: 0,
    minLikeCount: 0,
  });
  plans = report.start.plans;
  assert.equal(plans.length, profileIds.length, JSON.stringify(report.start.rejected));
  await save();
  const stopId = plans.find((p) => p.profileId === profileIds.at(-1)).id;
  const completeId = stopOnly ? null : plans.find((p) => p.profileId === profileIds[0]).id;
  const started = Date.now();
  let shown = false;
  while (Date.now() - started < 240000) {
    const overview = await request('/tasks/runtime');
    const current = overview.plans.filter((p) => plans.some((x) => x.id === p.id));
    report.samples.push({
      at: new Date().toISOString(),
      plans: current.map((p) => ({
        id: p.id,
        state: p.state,
        reason: p.reason,
        controlConfirmed: p.controlConfirmed,
      })),
      steps: overview.currentSteps.filter((s) => plans.some((p) => p.id === s.jobId)),
    });
    const stopPlan = current.find((p) => p.id === stopId);
    const completePlan = current.find((p) => p.id === completeId);
    const activeStopStep = overview.currentSteps.find(
      (s) => s.jobId === stopId && s.progress.effectiveMilliseconds > 0,
    );
    let advance;
    if (stopOnAdvance && !report.stop && stopPlan && !terminal(stopPlan)) {
      const history = await request('/tasks/history', {
        profileId: stopPlan.profileId,
        planId: stopPlan.id,
      });
      advance = history.operations.find(
        (operation) =>
          operation.kind === 'click' && ['DISPATCHING', 'ACKNOWLEDGED'].includes(operation.status),
      );
    }
    if (
      !completeBoth &&
      !report.stop &&
      stopPlan &&
      !terminal(stopPlan) &&
      (stopOnAdvance ? !!advance : !!activeStopStep) &&
      (!backgroundStrict || Date.now() - started >= 45000)
    ) {
      if (advance) report.stopTrigger = advance;
      report.stop = await stop(stopPlan);
    }
    if (
      !backgroundStrict &&
      report.stop &&
      completePlan?.reason === 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' &&
      !shown
    ) {
      report.show = await request('/profiles/show', { profileId: profileIds[0] });
      shown = true;
    }
    if (backgroundStrict && Date.now() - started >= 20000 && !report.backgroundSnapshot)
      report.backgroundSnapshot = await request('/diagnostics/snapshot', {
        note: 'BACKGROUND_0102_' + report.requestId,
      });
    await save();
    if (current.length === profileIds.length && current.every(terminal)) break;
    if (completePlan && ['PAUSED', 'REVIEW'].includes(completePlan.state)) break;
    await new Promise((resolve) => setTimeout(resolve, stopOnAdvance ? 100 : 2000));
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error));
} finally {
  for (const original of plans) {
    try {
      const overview = await request('/tasks/runtime');
      const plan = overview.plans.find((p) => p.id === original.id);
      if (plan && !terminal(plan)) {
        report.cleanup ??= [];
        report.cleanup.push(await stop(plan));
      }
    } catch (error) {
      report.errors.push(String(error));
    }
  }
  report.final = [];
  for (const original of plans) {
    try {
      const history = await request('/tasks/history', {
        profileId: original.profileId,
        planId: original.id,
      });
      history.plans = history.plans.filter((p) => p.id === original.id);
      const records = await request('/tasks/records', {
        profileId: original.profileId,
        limit: 200,
      });
      const review = await request('/profiles/native-review', { profileId: original.profileId });
      report.final.push({
        history,
        records: records.records.filter((r) => r.planId === original.id),
        review,
      });
    } catch (error) {
      report.errors.push(String(error));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed =
    (!stopOnAdvance || !!report.stopTrigger) &&
    (!backgroundStrict || !report.show) &&
    report.errors.length === 0 &&
    report.final.length === profileIds.length &&
    (stopOnly ||
      report.final.some(
        (f) =>
          f.history.profileId === profileIds[0] &&
          f.history.plans.some((p) => p.state === 'COMPLETED'),
      )) &&
    (completeBoth
      ? report.final.every((f) => f.history.plans.some((p) => p.state === 'COMPLETED'))
      : report.final.some(
          (f) =>
            f.history.profileId === profileIds.at(-1) &&
            f.history.plans.some((p) => p.state === 'STOPPED' && p.controlConfirmed),
        )) &&
    report.final.every((f) => f.review.blockingCount === 0);
  await save();
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        stop: report.stop,
        errors: report.errors,
        final: report.final.map((f) =>
          f.history.plans.map((p) => ({
            id: p.id,
            state: p.state,
            reason: p.reason,
            controlConfirmed: p.controlConfirmed,
          })),
        ),
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
}
