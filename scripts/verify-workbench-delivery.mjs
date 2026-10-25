import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractFile, listPackage } from '@electron/asar';
import path from 'node:path';

const origin = 'http://127.0.0.1:18767';
const user8 = '9e4d39b2-90b0-4267-aee2-311089b78336';
const target = process.env.WORKBENCH_DELIVERY_PROFILE ?? user8;
assert.ok([user8, '066430e1-92cd-4ee4-8f43-98db3425239d'].includes(target));
const archive = 'release/win-unpacked/resources/app.asar';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const files = [];
const acceptanceScope = 'config/publication-acceptance-scope.json';
assert.ok(
  !listPackage(archive, {}).some(
    (file) => file.replaceAll('\\', '/').replace(/^\//, '') === acceptanceScope,
  ),
  'LOCAL_PUBLICATION_AUTHORIZATION_MUST_NOT_SHIP',
);
async function verify(directory, packaged = directory, external = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = directory + '/' + entry.name,
      inside = packaged + '/' + entry.name;
    if (file === acceptanceScope) continue;
    if (entry.isDirectory()) await verify(file, inside, external);
    else {
      const source = await readFile(file);
      const bytes = external
        ? await readFile(inside)
        : extractFile(archive, inside.split('/').join(path.sep));
      assert.equal(hash(source), hash(bytes), file);
      files.push({ file, match: true });
    }
  }
}
for (const directory of ['dist', 'config', 'web', 'public']) await verify(directory);
await verify('extension-build', 'release/win-unpacked/resources/extension', true);
const mediaRuntime = JSON.parse(await readFile('config/media-runtime.json', 'utf8'));
for (const [file, expectedHash] of Object.entries(mediaRuntime.binarySha256)) {
  const packagedFile = path.join(
    'release/win-unpacked/resources/media-runtime',
    mediaRuntime.directory,
    'bin',
    file,
  );
  assert.equal(
    hash(await readFile(packagedFile)),
    expectedHash,
    'PACKAGED_MEDIA_RUNTIME_DIFFERS:' + file,
  );
  files.push({ file: packagedFile, match: true });
}
for (const [source, target] of [
  [
    'vendor/media-runtime/' + mediaRuntime.directory + '/LICENSE.txt',
    mediaRuntime.directory + '/LICENSE.txt',
  ],
  ['docs/MEDIA_RUNTIME.md', 'NOTICE.md'],
]) {
  const packagedFile = path.join('release/win-unpacked/resources/media-runtime', target);
  assert.equal(
    hash(await readFile(packagedFile)),
    hash(await readFile(source)),
    'PACKAGED_MEDIA_NOTICE_DIFFERS:' + source,
  );
  files.push({ file: packagedFile, match: true });
}
const expected = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.match(expected, /^0\.1\.\d+$/);
assert.equal(JSON.parse(extractFile(archive, 'package.json').toString()).version, expected);
if (process.argv.includes('--assets-only')) {
  const report = {
    softwareVersion: expected,
    files,
    localPublicationAuthorizationExcluded: true,
    normalSoftwareVerified: false,
    taskAssignments: 0,
    softwareRestarts: 0,
    browserRestarts: 0,
  };
  assert.ok(process.env.WORKBENCH_DELIVERY_REPORT, 'ASSET_REPORT_PATH_REQUIRED');
  await writeFile(process.env.WORKBENCH_DELIVERY_REPORT, JSON.stringify(report, null, 2), {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      version: expected,
      verifiedFiles: files.length,
      normalSoftwareVerified: false,
    }),
  );
  process.exit(0);
}
let cookie;
async function bootstrap() {
  const landing = await fetch(origin + '/workbench/', { signal: AbortSignal.timeout(3000) });
  cookie = landing.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
}
async function request(route, input, extra = {}) {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'x-workbench-task-contract': '4',
      'x-workbench-task-capacity': '2',
      'x-workbench-workspace-contract': '6',
      ...extra,
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(50_000),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = Error('HTTP_' + response.status);
    error.code = value.code;
    throw error;
  }
  return value;
}
await bootstrap();
const before = await request('/tasks');
assert.ok(
  !before.plans.some((row) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(row.state)),
);
let idle;
const reviewDeadline = Date.now() + 30_000;
while (!idle) {
  try {
    idle = await request('/profiles/native-review', { profileId: target });
  } catch (error) {
    if (error.code !== 'NATIVE_REVIEW_BUSY' || Date.now() >= reviewDeadline) throw error;
    // A post-restart automatic display read may still hold the private owner. Retry only
    // this diagnostic, never restart, task assignment, input or publication.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
assert.equal(idle.blockingCount, 0);
assert.ok(
  idle.activeTabCount === 0 ||
    (idle.activeTabCount === 1 && idle.tabs[0]?.reason === 'WORKSPACE_MAIN_IDLE'),
);
if (!process.argv.includes('--already-reloaded')) {
  await request('/software/restart', {});
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
let workspace;
const deadline = Date.now() + 40_000;
do {
  try {
    await bootstrap();
    workspace = await request('');
    if (workspace.profiles.some((row) => row.id === target && row.online && row.synced)) break;
  } catch {
    /* Relaunch may briefly have no listener. */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
} while (Date.now() < deadline);
assert.ok(
  workspace?.profiles.some((row) => row.id === target && row.online && row.synced),
  'SELECTED_PROFILE_AUTHENTICATED_RECONNECT_REQUIRED',
);
const after = await request('/tasks');
const retained = before.plans.filter((row) => row.state === 'PAUSED');
assert.ok(
  retained.every((old) => after.plans.some((row) => row.id === old.id && row.state === 'PAUSED')),
);
const assets = [];
for (const file of await readdir('web/assets')) {
  const source = await readFile('web/assets/' + file);
  const served = await fetch(origin + '/workbench/assets/' + file);
  assert.ok(served.ok);
  assert.equal(hash(source), hash(Buffer.from(await served.arrayBuffer())));
  assets.push({ file, servedMatch: true });
}
const features = await request('/tasks/features', undefined, {
  'x-workbench-features-contract': '2',
});
const health = await fetch(origin + '/api/bridge-connection-health', { headers: { cookie } });
assert.ok(health.ok);
const report = {
  softwareVersion: expected,
  files,
  assets,
  profileCount: workspace.profiles.length,
  user8: workspace.profiles
    .filter((row) => row.id === user8)
    .map(({ id, online, synced, extensionVersion }) => ({ id, online, synced, extensionVersion })),
  selectedProfile: target,
  selectedNativeReview: idle,
  retainedPaused: retained.map((row) => row.id),
  features,
  browserRestarts: 0,
  taskAssignments: 0,
  connectionHealth: await health.json(),
};
await writeFile(
  process.env.WORKBENCH_DELIVERY_REPORT ?? 'audit/feed-049-delivered-20261013.json',
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    version: expected,
    verifiedFiles: files.length,
    user8: report.user8,
    retainedPaused: report.retainedPaused,
    assets,
  }),
);
