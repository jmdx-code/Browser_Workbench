import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { runMediaProcess } from './media-process.js';

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

export class FfmpegStoryMedia {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw Error('MEDIA_RUNTIME_PATH_REQUIRED');
  }
  async probe(file: string, guard: () => Awaitable<void>) {
    if (!path.isAbsolute(file)) throw Error('MEDIA_INPUT_PATH_REQUIRED');
    const result = Probe.parse(
      JSON.parse(
        await runMediaProcess(
          path.join(this.directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
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
    const videos = result.streams.filter((s) => s.codec_type === 'video');
    const video = videos.length === 1 ? videos[0] : null;
    if (!video?.width || !video.height || video.width * video.height > 12_000_000)
      throw Error('STORY_VIDEO_STREAM_UNSUPPORTED');
    const rotations =
      video.side_data_list?.flatMap((row) => (row.rotation === undefined ? [] : [row.rotation])) ??
      [];
    if (rotations.length > 1 || rotations.some((r) => r % 90 !== 0))
      throw Error('STORY_VIDEO_ROTATION_UNSUPPORTED');
    const swap = Math.abs(rotations[0] ?? 0) % 180 === 90;
    return {
      width: swap ? video.height : video.width,
      height: swap ? video.width : video.height,
      duration: result.format.duration,
    };
  }
  async overlay(
    input: string,
    caption: string,
    output: string,
    guard: () => Awaitable<void>,
    replaceOwnedEmpty = false,
  ) {
    const key = (file: string) => path.resolve(file).toLowerCase();
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
      path.join(this.directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
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
    return this.probe(output, guard);
  }
}
