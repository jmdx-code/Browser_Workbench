import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const ffmpeg = process.argv[2];
assert.ok(ffmpeg && path.isAbsolute(ffmpeg), 'EXPLICIT_FFMPEG_REQUIRED');
const root = path.resolve('audit/story-test-media-' + randomUUID());
await mkdir(root);
async function render(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (data) => {
      error = (error + String(data)).slice(-4096);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error('MEDIA_RENDER_FAILED: ' + error)),
    );
  });
}
const image = path.join(root, 'test-pattern.png');
const video = path.join(root, 'test-pattern.mp4');
await render(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=1', '-frames:v', '1', image]);
await render([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=720x1280:rate=24',
  '-t',
  '6',
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  video,
]);
const assets = [];
for (const [source, role] of [
  [image, 'image'],
  [video, 'video'],
]) {
  const bytes = await readFile(source);
  assets.push({
    source,
    role,
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  path.join(root, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      root,
      generated: 'FFmpeg lavfi testsrc2; synthetic pattern only; no personal data or source media',
      assets,
      uploads: 0,
      publications: 0,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ root, assets }));
