import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [source, output] = process.argv.slice(2).map((value) => path.resolve(value));
assert.ok(source && output && source !== output);
for (const file of [source, output])
  assert.ok(file.startsWith(path.resolve('audit') + path.sep) && file.endsWith('.json'));
const original = JSON.parse(await readFile(source, 'utf8'));
assert.equal(original.publishing, false);
assert.equal(original.likes, 0);
assert.equal(original.plans.length, 2);
const profiles = ['066430e1-92cd-4ee4-8f43-98db3425239d', '9e4d39b2-90b0-4267-aee2-311089b78336'];
assert.deepEqual(original.plans.map((p) => p.profileId).sort(), [...profiles].sort());
const evidence = {
  source,
  passed: false,
  reason: 'FOLLOW_UP_ORIGINAL_BROWSE_CONTROL_STOP',
  observerEnded: true,
  startedAt: new Date().toISOString(),
  rows: [],
  errors: [],
};
await writeFile(output, JSON.stringify(evidence, null, 2), { flag: 'wx' });
const save = () => writeFile(output, JSON.stringify(evidence, null, 2));
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin + '/workbench/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
assert.ok(landing.ok && cookie);
async function request(route, input) {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-workbench-task-contract': '3',
      'x-workbench-workspace-contract': '5',
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = Error(route + ':' + value.code);
    error.code = value.code;
    throw error;
  }
  return value;
}
const terminal = (state) => ['STOPPED', 'FAILED', 'COMPLETED'].includes(state);
for (const plan of original.plans) {
  const row = { plan };
  evidence.rows.push(row);
  try {
    let current = (await request('/tasks')).plans.find(
      (p) => p.id === plan.id && p.profileId === plan.profileId,
    );
    assert.ok(current);
    if (!terminal(current.state)) {
      // One CAS stop only. An unknown response is not replayed by this observer.
      row.stopRequest = {
        planId: plan.id,
        profileId: plan.profileId,
        expectedState: current.state,
        expectedUpdatedAt: current.updatedAt,
      };
      await save();
      row.stopResponse = await request('/tasks/command', {
        command: 'stop',
        plans: [row.stopRequest],
      });
    }
    const deadline = Date.now() + 60_000;
    while (!terminal(current.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = (await request('/tasks')).plans.find((p) => p.id === plan.id);
      assert.ok(current);
    }
    row.current = current;
    row.history = await request('/tasks/history', { profileId: plan.profileId, planId: plan.id });
  } catch (error) {
    evidence.errors.push({ planId: plan.id, phase: 'stop', error: String(error) });
  }
  await save();
}
// Review is separate from stopping: a busy first profile cannot prevent stopping the second.
for (const row of evidence.rows) {
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      try {
        row.native = await request('/profiles/native-review', { profileId: row.plan.profileId });
        break;
      } catch (error) {
        if (error.code !== 'NATIVE_REVIEW_BUSY' || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    evidence.errors.push({ planId: row.plan.id, phase: 'review', error: String(error) });
  }
  await save();
}
evidence.stopConfirmed = evidence.rows.every(
  (row) =>
    terminal(row.current?.state) && row.current.controlConfirmed && row.native?.blockingCount === 0,
);
evidence.finishedAt = new Date().toISOString();
await save();
console.log(
  JSON.stringify({
    output,
    stopConfirmed: evidence.stopConfirmed,
    errors: evidence.errors,
    rows: evidence.rows.map((row) => ({
      id: row.plan.id,
      state: row.current?.state,
      blocking: row.native?.blockingCount,
      active: row.native?.activeTabCount,
    })),
  }),
);
process.exitCode = evidence.stopConfirmed ? 0 : 1;
