import path from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { MaterialPreflightReport } from '../dist/src/shared/materials.js';

const output = 'audit/material-preflight-http-live.json';
try {
  await writeFile(
    output,
    JSON.stringify({ state: 'RUNNING', startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.log('Completed or interrupted preflight evidence already exists; not rerunning.');
    process.exit(0);
  }
  throw error;
}
const directory = path.resolve('audit', 'material-preflight-fixture-' + randomUUID());
await mkdir(directory);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
await writeFile(path.join(directory, 'text.txt'), 'Generated material preflight test');
await writeFile(path.join(directory, 'copy.txt'), 'Generated material preflight test');
await writeFile(path.join(directory, 'image.png'), png);
await writeFile(path.join(directory, 'image.txt'), 'Generated image caption');
await mkdir(path.join(directory, 'album'));
await writeFile(path.join(directory, 'album', '正文.txt'), 'Generated album caption');
await writeFile(path.join(directory, 'album', '1.png'), png);
await writeFile(path.join(directory, 'album', '2.png'), png);
await writeFile(path.join(directory, 'video.mp4'), await readFile('public/sample.mp4'));
await writeFile(path.join(directory, 'video.txt'), 'Generated clip caption');
await writeFile(path.join(directory, 'invalid.png'), 'Not an image');
await mkdir(path.join(directory, '已发'));
await writeFile(path.join(directory, '已发', 'ignored.txt'), 'excluded archive');
await writeFile(path.join(directory, 'upload.part'), 'excluded temporary file');
async function hashes(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const output = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(output, await hashes(file));
    else
      output[path.relative(directory, file)] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
  }
  return output;
}
const before = await hashes(directory);
const origin = 'http://127.0.0.1:18767';
try {
  const landing = await fetch(origin);
  const cookie = (landing.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw Error('LOCAL_BOOTSTRAP_COOKIE_MISSING');
  const response = await fetch(origin + '/api/workspace/materials/preflight', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) throw Error('MATERIAL_HTTP_' + response.status);
  const report = MaterialPreflightReport.parse(await response.json());
  const after = await hashes(directory);
  const formats = [...new Set(report.packages.map((item) => item.format))].sort();
  if (
    !report.complete ||
    report.publishingReady ||
    report.packages.length !== 5 ||
    report.uniqueContents !== 4 ||
    report.excluded !== 2 ||
    report.issues.length !== 1 ||
    report.issues[0].code !== 'MEDIA_HEADER_MISMATCH' ||
    JSON.stringify(formats) !== JSON.stringify(['multi-image', 'single-image', 'text', 'video']) ||
    JSON.stringify(before) !== JSON.stringify(after)
  )
    throw Error('MATERIAL_HTTP_EVIDENCE_MISMATCH');
  await writeFile(
    output,
    JSON.stringify(
      {
        state: 'COMPLETED',
        finishedAt: new Date().toISOString(),
        generatedFixture: true,
        userResourceDirectoriesRead: false,
        nativeBrowserOperations: false,
        published: false,
        archived: false,
        directory,
        httpStatus: response.status,
        filesUnchanged: true,
        hashes: after,
        report,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Actual local HTTP preflight passed: four formats, duplicate content, invalid header, exclusions; source files unchanged.',
  );
} catch (error) {
  await writeFile(
    output,
    JSON.stringify(
      { state: 'FAILED', directory, error: error instanceof Error ? error.message : 'FAILED' },
      null,
      2,
    ),
  );
  throw error;
}
