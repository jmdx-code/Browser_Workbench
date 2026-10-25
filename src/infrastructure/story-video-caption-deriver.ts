import { mediaRuntimeComponent } from './media-runtime-component.js';
import { productDataDirectory } from './paths.js';
import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, open, stat, copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { VideoDerivation } from '../shared/story-video-derivation.js';
import { renderStoryCaption } from './story-caption-raster.js';
import { FfmpegStoryMedia } from './ffmpeg-story-media.js';
import { AsyncWorkBudget } from '../application/async-work-budget.js';

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
    const media = new FfmpegStoryMedia(await mediaRuntimeComponent(this.dataDirectory).directory());
    const before = await media.probe(source, guard);
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
    const after = await media.overlay(source, captionFile, temporary, guard, true);
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
