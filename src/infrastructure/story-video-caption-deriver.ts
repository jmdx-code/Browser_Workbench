import { mediaRuntimeComponent } from './media-runtime-component.js';
import { productDataDirectory } from './paths.js';
import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, open, stat, copyFile, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { VideoDerivation } from '../shared/story-video-derivation.js';
import { renderStoryCaption } from './story-caption-raster.js';
import { runMediaProcess } from './media-process.js';
import { AsyncWorkBudget } from '../application/kernel-gates.js';
const Probe = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
    }),
  ),
  format: z.object({ duration: z.coerce.number().finite().positive() }),
});
async function probeStoryVideo(dir: string, file: string, guard: () => Awaitable<void>) {
  if (!path.isAbsolute(file)) throw Error('MEDIA_INPUT_PATH_REQUIRED');
  const bin = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const result = Probe.parse(
    JSON.parse(
      await runMediaProcess(
        bin,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          file,
        ],
        guard,
        30_000,
      ),
    ),
  );
  const videos = result.streams.filter((s) => s.codec_type === 'video'),
    video = videos.length === 1 ? videos[0] : null;
  if (!video?.width || !video.height || video.width * video.height > 12_000_000)
    throw Error('STORY_VIDEO_STREAM_UNSUPPORTED');
  const rotations =
    video.side_data_list?.flatMap((r) => (r.rotation === undefined ? [] : [r.rotation])) ?? [];
  if (rotations.length > 1 || rotations.some((r) => r % 90 !== 0))
    throw Error('STORY_VIDEO_ROTATION_UNSUPPORTED');
  const swap = Math.abs(rotations[0] ?? 0) % 180 === 90;
  return {
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    duration: result.format.duration,
  };
}
async function overlayStoryCaption(
  dir: string,
  input: string,
  caption: string,
  output: string,
  guard: () => Awaitable<void>,
  replaceOwnedEmpty = false,
) {
  const key = (f: string) => path.resolve(f).toLowerCase();
  if (
    ![input, caption, output].every(path.isAbsolute) ||
    new Set([input, caption, output].map(key)).size !== 3 ||
    path.extname(output).toLowerCase() !== '.mp4'
  )
    throw Error('MEDIA_DERIVATION_PATH_INVALID');
  if (replaceOwnedEmpty) {
    await guard();
    const owned = await lstat(output);
    await guard();
    if (
      !owned.isFile() ||
      owned.isSymbolicLink() ||
      owned.size !== 0 ||
      path.dirname(input) !== path.dirname(output) ||
      path.dirname(caption) !== path.dirname(output)
    )
      throw Error('MEDIA_DERIVATION_EMPTY_OUTPUT_REQUIRED');
  }
  await runMediaProcess(
    path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      replaceOwnedEmpty ? '-y' : '-n',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      input,
      '-protocol_whitelist',
      'file,pipe',
      '-loop',
      '1',
      '-i',
      caption,
      '-filter_complex',
      '[0:v:0]pad=ceil(iw/2)*2:ceil(ih/2)*2[v];[v][1:v:0]overlay=0:0:shortest=1:format=auto[out]',
      '-filter_complex_threads',
      '1',
      '-map',
      '[out]',
      '-map',
      '0:a?',
      '-c:v',
      'libopenh264',
      '-threads',
      '2',
      '-b:v',
      '4M',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '-shortest',
      output,
    ],
    guard,
  );
  return probeStoryVideo(dir, output, guard);
}
const videoDerivationBudget = new AsyncWorkBudget(2, 100);
const Runtime = z
  .object({
    version: z.literal(1),
    platform: z.enum([
      'win32-x64',
      'win32-arm64',
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
    ]),
    provider: z.literal('BtbN/FFmpeg-Builds'),
    release: z.string(),
    directory: z.string().regex(/^[a-zA-Z0-9.-]+$/),
    archiveUrl: z.url(),
    archiveBytes: z.number().int().positive(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    license: z.literal('LGPL-3.0-or-later'),
    encoder: z.literal('libopenh264'),
    binarySha256: z.record(z.string().regex(/^[a-z0-9.-]+$/), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
async function digest(file: string, guard: () => Awaitable<void>) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    await guard();
    hash.update(chunk);
  }
  await guard();
  return hash.digest('hex');
}
export class StoryVideoCaptionDeriver {
  constructor(private readonly dataDirectory = productDataDirectory()) {}
  async derive(
    source: string,
    folder: string,
    text: string,
    sourceSha256: string,
    guard: () => Awaitable<void>,
    created: (file: string) => void,
  ) {
    return videoDerivationBudget.run(guard, () =>
      this.deriveOwned(source, folder, text, sourceSha256, guard, created),
    );
  }
  private async deriveOwned(
    source: string,
    folder: string,
    text: string,
    sourceSha256: string,
    guard: () => Awaitable<void>,
    created: (file: string) => void,
  ) {
    await guard();
    const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const config = Runtime.parse(
      JSON.parse(await readFile(path.join(root, 'config/media-runtime.json'), 'utf8')),
    );
    await guard();
    const mediaDir = await mediaRuntimeComponent(this.dataDirectory).directory();
    if (!path.isAbsolute(mediaDir)) throw Error('MEDIA_RUNTIME_PATH_REQUIRED');
    const before = await probeStoryVideo(mediaDir, source, guard);
    const caption = await renderStoryCaption(
      text,
      Math.ceil(before.width / 2) * 2,
      Math.ceil(before.height / 2) * 2,
      guard,
    );
    const captionFile = path.join(folder, 'caption.png'),
      temporary = path.join(folder, 'captioned.mp4');
    const captionHandle = await open(captionFile, 'wx', 0o600);
    try {
      created(captionFile);
      await captionHandle.writeFile(caption.png);
    } finally {
      await captionHandle.close();
    }
    const outputHandle = await open(temporary, 'wx', 0o600);
    try {
      created(temporary);
    } finally {
      await outputHandle.close();
    }
    await guard();
    const after = await overlayStoryCaption(mediaDir, source, captionFile, temporary, guard, true);
    await guard();
    if (
      after.width !== caption.width ||
      after.height !== caption.height ||
      Math.abs(after.duration - before.duration) > 0.1
    )
      throw Error('STORY_VIDEO_DERIVATION_MEDIA_CHANGED');
    if ((await digest(source, guard)) !== sourceSha256)
      throw Error('STORY_VIDEO_DERIVATION_SOURCE_CHANGED');
    const hash = await digest(temporary, guard),
      bytes = (await stat(temporary)).size;
    if (bytes <= 0 || bytes > 10 * 1024 ** 3) throw Error('STORY_VIDEO_DERIVATION_BUDGET');
    const name = '00-' + hash + '.mp4',
      file = path.join(folder, name);
    if (file === source) throw Error('STORY_VIDEO_DERIVATION_SOURCE_COLLISION');
    await copyFile(temporary, file, constants.COPYFILE_EXCL);
    created(file);
    await guard();
    await rm(temporary);
    await rm(captionFile);
    await guard();
    const derivation: VideoDerivation = {
      version: 1,
      kind: 'story-caption-video',
      text,
      sourceSha256,
      textSha256: caption.textSha256,
      captionSha256: createHash('sha256').update(caption.png).digest('hex'),
      rendererVersion: 1,
      runtimeArchiveSha256: config.archiveSha256,
      digest: hash,
      bytes,
      ...after,
    };
    return { name, derivation };
  }
}
