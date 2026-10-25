import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { renderStoryCaption } from '../dist/src/infrastructure/story-caption-raster.js';
import { FfmpegStoryMedia } from '../dist/src/infrastructure/ffmpeg-story-media.js';
import { runMediaProcess } from '../dist/src/infrastructure/media-process.js';
import { StoryVideoCaptionDeriver } from '../dist/src/infrastructure/story-video-caption-deriver.js';

const [input, text] = process.argv.slice(2);
assert.ok(input && path.isAbsolute(input) && text, 'ABSOLUTE_SOURCE_AND_TEXT_REQUIRED');
const config = JSON.parse(await readFile('config/media-runtime.json', 'utf8'));
const binary = path.resolve('vendor/media-runtime', config.directory, 'bin');
const media = new FfmpegStoryMedia(binary);
const directory = path.resolve('audit/captioned-story-media-' + randomUUID());
await mkdir(directory);
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const before = { digest: await digest(input), bytes: (await stat(input)).size };
const original = await media.probe(input, () => {});
const width = Math.ceil(original.width / 2) * 2,
  height = Math.ceil(original.height / 2) * 2;
const raster = await renderStoryCaption(text, width, height, () => {});
const caption = path.join(directory, 'caption.png'),
  stage = path.join(directory, 'stage');
await writeFile(caption, raster.png, { flag: 'wx' });
await mkdir(stage);
const stagedSource = path.join(stage, '00-' + before.digest + '.mp4');
await copyFile(input, stagedSource);
const created = [];
const workerProof = await new StoryVideoCaptionDeriver().derive(
  stagedSource,
  stage,
  text,
  before.digest,
  () => {},
  (file) => created.push(file),
);
const output = path.join(stage, workerProof.name);
const derived = await media.probe(output, () => {});
assert.equal(await digest(stagedSource), before.digest);
assert.equal(await digest(output), workerProof.derivation.digest);
assert.equal(derived.width, width);
assert.equal(derived.height, height);
assert.ok(Math.abs(derived.duration - original.duration) < 0.1, 'DURATION_CHANGED');
assert.deepEqual(
  { digest: await digest(input), bytes: (await stat(input)).size },
  before,
  'SOURCE_CHANGED',
);
await runMediaProcess(
  path.join(binary, 'ffmpeg.exe'),
  [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-n',
    '-ss',
    String(original.duration / 2),
    '-i',
    output,
    '-frames:v',
    '1',
    path.join(directory, 'frame.png'),
  ],
  () => {},
  30_000,
);
const report = {
  passed: true,
  realFacebook: false,
  uploads: 0,
  submissions: 0,
  sourceUnchanged: true,
  workerProof,
  created,
  source: before,
  original,
  derived: { ...derived, digest: await digest(output), bytes: (await stat(output)).size },
  caption: {
    rendererVersion: raster.rendererVersion,
    textSha256: raster.textSha256,
    fontSize: raster.fontSize,
    lines: raster.lines,
    bounds: raster.bounds,
  },
  runtime: { release: config.release, archiveSha256: config.archiveSha256 },
  directory,
};
await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
});
console.log(JSON.stringify(report));
