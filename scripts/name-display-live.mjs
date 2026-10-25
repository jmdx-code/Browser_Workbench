import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { ProfileInspections } from '../dist/src/shared/profile-inspection.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
const origin = 'http://127.0.0.1:18767';
const profileId = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
async function get(route, version) {
  const response = await fetch(origin + route, {
    headers: { cookie, ...(version ? { 'x-workbench-inspection-display': version } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const workspace = WorkspaceSchema.parse(await get('/api/workspace'));
const tasks = TaskOverview.parse(await get('/api/workspace/tasks'));
const rows = ProfileInspections.parse(await get('/api/workspace/profiles/inspection', '2'));
assert.equal(tasks.dispatchEnabled, false);
assert.equal(tasks.plans.length, 0);
assert.ok(rows.results.every((row) => !['QUEUED', 'READING'].includes(row.state)));
let inspection = null;
if (process.env.WORKBENCH_NAME_LIVE_INSPECT === '1') {
  const profile = workspace.profiles.find((p) => p.id === profileId);
  assert.ok(
    profile?.online && profile.synced && profile.unresolved === 0 && profile.phase === 'PAUSED',
  );
  assert.ok(profile.capabilities.includes('facebook-readonly-v2'));
  const response = await fetch(origin + '/api/workspace/profiles/inspect', {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-workbench-inspection-display': '2',
    },
    body: JSON.stringify({ profileIds: [profileId] }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = ProfileInspections.parse(
      await get('/api/workspace/profiles/inspection', '2'),
    ).results.find((row) => row.profileId === profileId);
    if (current && !['QUEUED', 'READING'].includes(current.state)) {
      inspection = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(inspection?.state, 'OBSERVED');
  assert.equal(inspection?.nameObservation?.name, 'Nway Myint');
  assert.equal(inspection.account.id, null);
  assert.equal(inspection.account.name, null);
}
const responseVersions = [];
for (const version of [undefined, '1', '2']) {
  const result = await get('/api/workspace/profiles/inspection', version);
  responseVersions.push({
    version: version ?? 'legacy',
    rows: result.results.length,
    nameIncluded: result.results.length
      ? Object.hasOwn(result.results[0], 'nameObservation')
      : null,
    avatarIncluded: result.results.length
      ? Object.hasOwn(result.results[0], 'avatarObservation')
      : null,
  });
}
await writeFile(
  process.env.WORKBENCH_NAME_LIVE_REPORT ?? 'audit/name-display-live.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      readOnly: true,
      inspectionRequested: process.env.WORKBENCH_NAME_LIVE_INSPECT === '1',
      profilesKnown: workspace.profiles.length,
      online: workspace.profiles.filter((p) => p.online).length,
      dispatchEnabled: tasks.dispatchEnabled,
      plans: tasks.plans.length,
      activeInspections: rows.results.filter((row) => ['QUEUED', 'READING'].includes(row.state))
        .length,
      inspection: inspection
        ? {
            profileId,
            state: inspection.state,
            reason: inspection.reason,
            checkedAt: inspection.checkedAt,
            nameObservation: inspection.nameObservation,
            avatarSource: inspection.avatarObservation?.source ?? null,
            account: inspection.account,
          }
        : null,
      responseVersions,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Name display evidence saved; no publish/input commands.');
