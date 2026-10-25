import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
import { ProfileInspections } from '../dist/src/shared/profile-inspection.js';
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin + '/workbench/', { signal: AbortSignal.timeout(10_000) });
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const headers = {
  cookie,
  origin,
  'content-type': 'application/json',
  'x-workbench-inspection-display': '2',
};
const get = async (route) => {
  const response = await fetch(origin + '/api/workspace' + route, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const workspace = WorkspaceSchema.parse(await get(''));
const tasks = TaskOverview.parse(await get('/tasks'));
const inspection = ProfileInspections.parse(await get('/profiles/inspection'));
assert.equal(tasks.dispatchEnabled, false);
assert.equal(tasks.plans.length, 0);
assert.equal(
  inspection.results.some((row) => ['READING', 'QUEUED'].includes(row.state)),
  false,
);
const response = await fetch(origin + '/api/workspace/materials/media', {
  method: 'POST',
  headers,
  body: JSON.stringify({ scanId: randomUUID(), source: 'unscanned.png', fileIndex: 0 }),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 409);
const failure = await response.json();
assert.equal(failure.code, 'MATERIAL_PREVIEW_EXPIRED');
assert.match(landing.headers.get('content-security-policy') ?? '', /media-src 'self' blob:/);
await writeFile(
  'audit/material-media-formal-api.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      sourceVersion: '0.1.32',
      authenticated: true,
      mediaRouteStatus: response.status,
      mediaRouteCode: failure.code,
      formalScanRequests: 0,
      browserInputs: 0,
      profilesKnown: workspace.profiles.length,
      online: workspace.profiles.filter((p) => p.online).length,
      dispatchEnabled: tasks.dispatchEnabled,
      plans: tasks.plans.length,
      activeInspections: 0,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
