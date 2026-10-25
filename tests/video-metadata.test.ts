import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readVideoMetadata,
  checkKnownFacebookVideo,
} from '../src/infrastructure/video-metadata.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';

// Container-only fixtures; none represents decoded media or Facebook upload acceptance.
function box(type: string, body: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, body]);
}
function video(width = 320, height = 180, seconds = 3, v1 = false) {
  const tkhd = Buffer.alloc(v1 ? 96 : 84);
  tkhd[0] = v1 ? 1 : 0;
  tkhd.writeUInt32BE(width * 65536, v1 ? 88 : 76);
  tkhd.writeUInt32BE(height * 65536, v1 ? 92 : 80);
  const mdhd = Buffer.alloc(v1 ? 36 : 24);
  mdhd[0] = v1 ? 1 : 0;
  mdhd.writeUInt32BE(1000, v1 ? 20 : 12);
  if (v1) mdhd.writeBigUInt64BE(BigInt(seconds * 1000), 24);
  else mdhd.writeUInt32BE(seconds * 1000, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.write('vide', 8, 'ascii');
  return box(
    'trak',
    Buffer.concat([
      box('tkhd', tkhd),
      box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr)])),
    ]),
  );
}
const container = (track = video()) =>
  Buffer.concat([
    box('ftyp', Buffer.from('isom0000')),
    box('mdat', Buffer.alloc(1024)),
    box('moov', track),
  ]);
async function fixture(bytes: Buffer, run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-metadata-'));
  try {
    const file = path.join(dir, 'source.mp4');
    await writeFile(file, bytes);
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('sparse MP4 metadata reads moov after mdat and both timestamp versions without claiming decode', async () => {
  for (const v1 of [false, true])
    await fixture(container(video(320, 180, 3, v1)), async (file) => {
      const handle = await open(file, 'r');
      try {
        const bytes = Number((await handle.stat()).size);
        assert.deepEqual(await readVideoMetadata(handle, bytes, () => {}), {
          width: 320,
          height: 180,
          durationSeconds: 3,
        });
        await checkKnownFacebookVideo(handle, file, bytes, () => {});
        await assert.rejects(
          readVideoMetadata(handle, bytes, () => {
            throw Error('cancelled');
          }),
          /cancelled/,
        );
      } finally {
        await handle.close();
      }
    });
});
test('video preflight rejects the observed undersized fixture before cataloguing and blocks malformed or ambiguous tracks', async () => {
  for (const [track, pattern] of [
    [video(160, 90), /至少120/],
    [video(320, 180, 0), /UNAVAILABLE/],
    [Buffer.concat([video(), video()]), /VIDEO_TRACK_REQUIRED/],
  ] as const)
    await fixture(container(track), async (file) => {
      const handle = await open(file, 'r');
      try {
        await assert.rejects(
          checkKnownFacebookVideo(handle, file, Number((await handle.stat()).size), () => {}),
          pattern,
        );
      } finally {
        await handle.close();
      }
    });
  const malformed = container();
  // Break the moov box header, not the unrelated payload at the end of hdlr.
  malformed.writeUInt32BE(0x7fffffff, 16 + 1032);
  await fixture(malformed, async (file) => {
    const handle = await open(file, 'r');
    try {
      await assert.rejects(
        readVideoMetadata(handle, malformed.length, () => {}),
        /BOX_SIZE/,
      );
    } finally {
      await handle.close();
    }
  });
  await fixture(container(video(160, 90)), async (file) => {
    const scan = await new FilesystemMaterialScanner(undefined, checkKnownFacebookVideo).scan(
      path.dirname(file),
    );
    assert.equal(scan.packages.length, 0);
    assert.ok(
      scan.issues.some(
        (issue) => issue.code === 'VIDEO_METADATA_INVALID' && issue.message.includes('120'),
      ),
    );
  });
});
