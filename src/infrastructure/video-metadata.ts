import type { Awaitable } from '../domain/persistence.js';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import type { MaterialFileSnapshot } from '../shared/materials.js';
import { proofOf, sameStat } from './material-file-utils.js';

export type VideoMetadata = { width: number; height: number; durationSeconds: number };
type Box = { type: string; start: number; end: number };

// MP4/QuickTime container metadata only, not a decoder or a promise of Facebook acceptance.
// Positional reads skip media payloads, including mdat before moov; bounded at 64KiB/4096 boxes.
export async function readVideoMetadata(
  handle: FileHandle,
  bytes: number,
  guard: () => Awaitable<void>,
): Promise<VideoMetadata> {
  let readBytes = 0,
    boxes = 0;
  if (!Number.isSafeInteger(bytes) || bytes < 8) throw Error('VIDEO_METADATA_UNAVAILABLE');
  const read = async (offset: number, size: number) => {
    await guard();
    if (offset < 0 || offset + size > bytes || (readBytes += size) > 65536)
      throw Error('VIDEO_METADATA_BUDGET');
    const result = Buffer.alloc(size);
    const reading = await handle.read(result, 0, size, offset);
    await guard();
    if (reading.bytesRead !== size) throw Error('VIDEO_METADATA_TRUNCATED');
    return result;
  };
  const children = async (start: number, end: number) => {
    const result: Box[] = [];
    while (start < end) {
      if (++boxes > 4096 || end - start < 8) throw Error('VIDEO_METADATA_BOXES');
      const head = await read(start, 8);
      let size = head.readUInt32BE(0),
        header = 8;
      if (size === 1) {
        const extended = (await read(start + 8, 8)).readBigUInt64BE();
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('VIDEO_METADATA_BOX_SIZE');
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || size > end - start) throw Error('VIDEO_METADATA_BOX_SIZE');
      result.push({ type: head.toString('ascii', 4, 8), start: start + header, end: start + size });
      start += size;
    }
    return result;
  };
  const only = (list: Box[], type: string) => {
    const matching = list.filter((box) => box.type === type);
    if (matching.length !== 1 || !matching[0]) throw Error('VIDEO_METADATA_UNAVAILABLE');
    return matching[0];
  };
  const top = await children(0, bytes),
    moov = only(top, 'moov');
  const tracks = (await children(moov.start, moov.end)).filter((box) => box.type === 'trak');
  const videos: VideoMetadata[] = [];
  for (const track of tracks) {
    const parts = await children(track.start, track.end),
      mdia = only(parts, 'mdia');
    const media = await children(mdia.start, mdia.end),
      hdlr = only(media, 'hdlr');
    if (hdlr.end - hdlr.start < 12) throw Error('VIDEO_METADATA_TRUNCATED');
    if ((await read(hdlr.start + 8, 4)).toString('ascii') !== 'vide') continue;
    const tkhd = only(parts, 'tkhd'),
      mdhd = only(media, 'mdhd');
    const version = (await read(tkhd.start, 1))[0];
    const dimensionOffset = version === 0 ? 76 : version === 1 ? 88 : -1;
    if (dimensionOffset < 0 || tkhd.end - tkhd.start < dimensionOffset + 8)
      throw Error('VIDEO_METADATA_TRACK');
    const dimensions = await read(tkhd.start + dimensionOffset, 8);
    const timeVersion = (await read(mdhd.start, 1))[0];
    const timeOffset = timeVersion === 0 ? 12 : timeVersion === 1 ? 20 : -1;
    const timeSize = timeVersion === 1 ? 12 : 8;
    if (timeOffset < 0 || mdhd.end - mdhd.start < timeOffset + timeSize)
      throw Error('VIDEO_METADATA_DURATION');
    const time = await read(mdhd.start + timeOffset, timeSize),
      scale = time.readUInt32BE(0);
    const ticks = timeVersion === 1 ? time.readBigUInt64BE(4) : BigInt(time.readUInt32BE(4));
    if (
      !scale ||
      ticks > BigInt(Number.MAX_SAFE_INTEGER) ||
      ticks === (timeVersion === 1 ? 0xffffffffffffffffn : 0xffffffffn)
    )
      throw Error('VIDEO_METADATA_DURATION');
    const value = {
      width: dimensions.readUInt32BE(0) / 65536,
      height: dimensions.readUInt32BE(4) / 65536,
      durationSeconds: Number(ticks) / scale,
    };
    if (value.width <= 0 || value.height <= 0 || value.durationSeconds <= 0)
      throw Error('VIDEO_METADATA_UNAVAILABLE');
    videos.push(value);
  }
  await guard();
  if (videos.length !== 1 || !videos[0]) throw Error('VIDEO_METADATA_VIDEO_TRACK_REQUIRED');
  return videos[0];
}

// A conservative rejection of limits actually returned by the tested composer (2026-10-11).
// Passing is not permission or complete codec validation; server-side limits can change.
export async function checkKnownFacebookVideo(
  handle: FileHandle,
  file: string,
  bytes: number,
  guard: () => Awaitable<void>,
) {
  if (!/\.(mp4|mov)$/i.test(file)) return;
  const metadata = await readVideoMetadata(handle, bytes, guard);
  if (metadata.width < 120 || metadata.height < 120) throw Error('视频宽、高都应至少120像素');
  if (metadata.durationSeconds < 1 || metadata.durationSeconds > 14460)
    throw Error('视频时长应在1秒到241分钟之间');
  const aspect = metadata.width / metadata.height;
  if (aspect < 0.25 || aspect > 4) throw Error('视频宽高比应在1:4到4:1之间');
  if (bytes < 1024) throw Error('视频文件小于当前页面要求的1KiB');
}

export async function checkKnownFacebookVideoPath(
  file: string,
  expected: MaterialFileSnapshot,
  guard: () => Awaitable<void>,
) {
  if (expected.role !== 'video') return;
  await guard();
  const before = await lstat(file, { bigint: true });
  await guard();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    JSON.stringify(proofOf(before)) !== JSON.stringify(expected.proof)
  )
    throw Error('VIDEO_METADATA_SOURCE_CHANGED');
  const handle = await open(file, 'r');
  try {
    await guard();
    if (!sameStat(before, await handle.stat({ bigint: true })))
      throw Error('VIDEO_METADATA_SOURCE_CHANGED');
    await checkKnownFacebookVideo(handle, file, expected.bytes, guard);
    const after = await lstat(file, { bigint: true });
    await guard();
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameStat(before, after) ||
      !sameStat(before, await handle.stat({ bigint: true }))
    )
      throw Error('VIDEO_METADATA_SOURCE_CHANGED');
    await guard();
  } finally {
    await handle.close();
  }
}
