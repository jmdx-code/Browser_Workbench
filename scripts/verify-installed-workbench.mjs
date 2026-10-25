import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractFile } from '@electron/asar';

assert.equal(process.argv.length, 4, 'Use --report audit/fresh.json');
assert.equal(process.argv[2], '--report');
const report = path.resolve(process.argv[3]);
assert.ok(report.startsWith(path.resolve('audit') + path.sep) && report.endsWith('.json'));
assert.ok(process.env.LOCALAPPDATA);
const installed = path.join(process.env.LOCALAPPDATA, 'Programs/Browser Workbench');
const packaged = path.resolve('release/win-unpacked');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const files = [];
const mediaRuntime = JSON.parse(await readFile('config/media-runtime.json', 'utf8'));
for (const file of [
  'resources/app.asar',
  'Browser Workbench.exe',
  'resources/extension/manifest.json',
  ...Object.keys(mediaRuntime.binarySha256).map(
    (file) => 'resources/media-runtime/' + mediaRuntime.directory + '/bin/' + file,
  ),
  'resources/media-runtime/' + mediaRuntime.directory + '/LICENSE.txt',
  'resources/media-runtime/NOTICE.md',
]) {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const actual = hash(await readFile(path.join(installed, file)));
  const expected = hash(await readFile(path.join(packaged, file)));
  assert.equal(actual, expected, 'INSTALLED_FILE_DIFFERS:' + file);
  files.push({ file, sha256: actual, match: true });
}
assert.equal(
  JSON.parse(extractFile(path.join(installed, 'resources/app.asar'), 'package.json')).version,
  version,
);
const evidence = {
  softwareVersion: version,
  installedDirectory: installed,
  files,
  isolatedSmokeVerified: false,
  normalSoftwareVerified: false,
  userDataModified: false,
};
await writeFile(report, JSON.stringify(evidence, null, 2), { flag: 'wx' });
console.log(JSON.stringify(evidence));
