import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { materialFingerprintPayload } from '../src/domain/materials.js';
import { MaterialPreflightService } from '../src/application/material-preflight.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialMediaReader } from '../src/infrastructure/material-media-reader.js';
import { materialMediaPreviewLimits } from '../src/shared/materials.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
async function cleanup(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('wb-media-'));
  await rm(root, { recursive: true, force: true });
}
const scanner = new FilesystemMaterialScanner();
const reader = new FilesystemMaterialMediaReader();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-media-'));
  await mkdir(path.join(root, 'album'));
  await writeFile(path.join(root, 'album/2.png'), png);
  await writeFile(path.join(root, 'album/10.png'), png);
  await writeFile(path.join(root, 'album/正文.txt'), 'caption');
  await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'));
  const service = new MaterialPreflightService(scanner, () => new Date().toISOString(), reader);
  const scan = await service.inspectForPreview({ directory: root });
  return { root, service, scan };
}
test('visual preview reads only ordered selected media and checks full bytes without publishing or writing', async () => {
  const { root, service, scan } = await fixture();
  try {
    const first = await service.media(
      { scanId: scan.scanId, source: 'album', fileIndex: 0 },
      () => {},
    );
    assert.equal(first.contentType, 'image/png');
    assert.deepEqual(Buffer.from(first.bytes), png);
    const video = await service.media(
      { scanId: scan.scanId, source: 'video.mp4', fileIndex: 0 },
      () => {},
    );
    assert.equal(video.contentType, 'video/mp4');
    assert.deepEqual(Buffer.from(video.bytes), await readFile('public/sample.mp4'));
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'album', fileIndex: 2 }, () => {}),
      /不是可预览/,
    );
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'album', fileIndex: 3 }, () => {}),
      /不是可预览/,
    );
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: '../video.mp4', fileIndex: 0 }, () => {}),
      /本次检查/,
    );
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'album', fileIndex: 0, path: root }, () => {}),
    );
    assert.equal(service.preview({ scanId: scan.scanId, source: 'album' }).publishingReady, false);
    assert.deepEqual(await readFile(path.join(root, 'album/2.png')), png);
  } finally {
    await cleanup(root);
  }
});
test('media changes, digest contradictions and directory links reject before returning display bytes', async () => {
  const { root, service, scan } = await fixture();
  try {
    await writeFile(path.join(root, 'album/2.png'), Buffer.concat([png, Buffer.from('changed')]));
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'album', fileIndex: 0 }, () => {}),
      /重新检查/,
    );
    const snapshot = (await scanner.scan(root)).packages.find((p) => p.source === 'album');
    assert.ok(snapshot);
    const bad = structuredClone(snapshot);
    const first = bad.files[0];
    assert.ok(first);
    first.digest = '0'.repeat(64);
    // Keep the scanner fingerprint: contradictory snapshot must fail its independent validation.
    await assert.rejects(
      reader.read(root, bad, 0, () => {}),
      /FINGERPRINT/,
    );
    bad.fingerprint = createHash('sha256')
      .update(materialFingerprintPayload(bad.text, bad.files))
      .digest('hex');
    await assert.rejects(
      reader.read(root, bad, 0, () => {}),
      /MEDIA_CHANGED/,
    );
    await rename(path.join(root, 'album'), path.join(root, 'outside'));
    await symlink(
      path.join(root, 'outside'),
      path.join(root, 'album'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      reader.read(root, snapshot, 1, () => {}),
      /PATH_CHANGED/,
    );
  } finally {
    await cleanup(root);
  }
});
test('source reader cancellation after opening releases its handle without producing bytes', async () => {
  const { root } = await fixture();
  try {
    const snapshot = (await scanner.scan(root)).packages.find((p) => p.source === 'video.mp4');
    assert.ok(snapshot);
    let checks = 0;
    await assert.rejects(
      reader.read(root, snapshot, 0, () => {
        if (++checks === 29) throw Error('CANCELLED');
      }),
      /CANCELLED/,
    );
    // Windows rename/delete catches leaked file handles; no publish cache or source replacement is used.
    await rename(path.join(root, 'video.mp4'), path.join(root, 'renamed.mp4'));
    assert.ok(checks >= 29);
  } finally {
    await cleanup(root);
  }
});
test('scan replacement revokes an in-flight media read; slow delivery retains global single-read budget', async () => {
  const { root } = await fixture();
  try {
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const service = new MaterialPreflightService(scanner, () => new Date().toISOString(), {
      read: async () => {
        reads++;
        await wait;
        return { bytes: png, contentType: 'image/png' };
      },
    });
    const scan = await service.inspectForPreview({ directory: root });
    const request = { scanId: scan.scanId, source: 'album', fileIndex: 0 };
    const original = service.media(request, () => {});
    await assert.rejects(
      service.media(request, () => {}),
      /另一份媒体/,
    );
    await service.inspectForPreview({ directory: root });
    release?.();
    await assert.rejects(original, /失效/);
    assert.equal(reads, 1);
    const fresh = await service.inspectForPreview({ directory: root });
    let delivered: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const pending = service.media(
      { ...request, scanId: fresh.scanId },
      () => {},
      async () => delivery,
    );
    await Promise.resolve();
    await assert.rejects(
      service.media({ ...request, scanId: fresh.scanId }, () => {}),
      /另一份媒体/,
    );
    delivered?.();
    await pending;
    await service.media({ ...request, scanId: fresh.scanId }, () => {});
  } finally {
    await cleanup(root);
  }
});
test('oversized files and expired snapshots never invoke a media reader', async () => {
  const { root } = await fixture();
  try {
    const original = await scanner.scan(root);
    const item = original.packages.find((p) => p.source === 'video.mp4');
    assert.ok(item);
    const file = item.files[0];
    assert.ok(file);
    file.bytes = materialMediaPreviewLimits.video + 1;
    file.proof.size = String(file.bytes);
    let now = Date.now(),
      reads = 0;
    const service = new MaterialPreflightService(
      { scan: async () => original },
      () => new Date(now).toISOString(),
      {
        read: async () => {
          reads++;
          throw Error('should not read');
        },
      },
    );
    const scan = await service.inspectForPreview({ directory: root });
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'video.mp4', fileIndex: 0 }, () => {}),
      /上限/,
    );
    now += 600_000;
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'album', fileIndex: 0 }, () => {}),
      /失效/,
    );
    await assert.rejects(
      service.media({ scanId: randomUUID(), source: 'album', fileIndex: 0 }, () => {}),
      /失效/,
    );
    assert.equal(reads, 0);
  } finally {
    await cleanup(root);
  }
});
