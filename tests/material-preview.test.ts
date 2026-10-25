import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { MaterialPreflightService } from '../src/application/material-preflight.js';
import type { MaterialScan } from '../src/shared/materials.js';

test('preview preserves normalized bodies and original ordered files for four formats without rescanning or reading paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-preview-'));
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(root, 'text.txt'), '\uFEFF <img src=x onerror=alert(1)>\r\n中文 ');
    await writeFile(path.join(root, 'single.png'), png);
    await writeFile(path.join(root, 'single.txt'), 'caption');
    await mkdir(path.join(root, 'album'));
    await writeFile(path.join(root, 'album', '正文.txt'), 'album');
    await writeFile(path.join(root, 'album', '10.png'), png);
    await writeFile(path.join(root, 'album', '2.png'), png);
    await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'));
    const scanner = new FilesystemMaterialScanner();
    let calls = 0;
    const service = new MaterialPreflightService(
      {
        scan: async (directory) => {
          calls++;
          return scanner.scan(directory);
        },
      },
      () => new Date().toISOString(),
    );
    const scan = await service.inspectForPreview({ directory: root });
    assert.equal(JSON.stringify(scan).includes('onerror'), false);
    assert.deepEqual(scan.report.packages.map((p) => p.format).sort(), [
      'multi-image',
      'single-image',
      'text',
      'video',
    ]);
    for (const item of scan.report.packages) {
      const preview = service.preview({ scanId: scan.scanId, source: item.source });
      assert.equal(preview.currentness, 'scan-snapshot');
      assert.equal(preview.readonly, true);
      assert.equal(preview.publishingReady, false);
      assert.equal(Object.hasOwn(preview.files[0] ?? {}, 'proof'), false);
      if (item.format === 'text') assert.equal(preview.text, '<img src=x onerror=alert(1)>\n中文');
      if (item.format === 'multi-image')
        assert.deepEqual(
          preview.files.filter((f) => f.role === 'image').map((f) => path.basename(f.relativePath)),
          ['2.png', '10.png'],
        );
      if (item.format === 'video') assert.equal(preview.text, '');
      preview.text = 'tampered';
      assert.notEqual(
        service.preview({ scanId: scan.scanId, source: item.source }).text,
        'tampered',
      );
    }
    await writeFile(path.join(root, 'text.txt'), 'source changed');
    assert.ok(
      service.preview({ scanId: scan.scanId, source: 'text.txt' }).text.includes('onerror'),
    );
    assert.throws(
      () => service.preview({ scanId: scan.scanId, source: '../outside.txt' }),
      /本次检查/,
    );
    assert.throws(() => service.preview({ scanId: randomUUID(), source: 'text.txt' }), /失效/);
    assert.throws(() =>
      service.preview({ scanId: scan.scanId, source: 'text.txt', directory: root }),
    );
    assert.equal(calls, 1);
    const legacy = await service.inspect({ directory: root });
    assert.equal(Object.hasOwn(legacy, 'scanId'), false);
    assert.throws(() => service.preview({ scanId: scan.scanId, source: 'text.txt' }), /失效/);
    assert.equal(await readFile(path.join(root, 'text.txt'), 'utf8'), 'source changed');
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('wb-preview-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

function generated(): MaterialScan {
  return {
    directory: 'generated',
    complete: true,
    issues: [],
    excluded: 0,
    packages: [
      {
        source: 'body.txt',
        format: 'text',
        text: 'body',
        fingerprint: 'a'.repeat(64),
        files: [
          {
            relativePath: 'body.txt',
            role: 'text',
            bytes: 4,
            digest: 'b'.repeat(64),
            proof: { dev: '1', ino: '1', size: '4', mtimeNs: '1', ctimeNs: '1' },
          },
        ],
      },
    ],
  };
}
test('preview expiry is exact and permanent across wall-clock rollback', async () => {
  for (const change of [600_000, -1]) {
    let time = 1_000_000;
    const service = new MaterialPreflightService({ scan: async () => generated() }, () =>
      new Date(time).toISOString(),
    );
    const scan = await service.inspectForPreview({ directory: 'generated' });
    time += change;
    assert.throws(() => service.preview({ scanId: scan.scanId, source: 'body.txt' }), /失效/);
    time = 1_000_000;
    assert.throws(() => service.preview({ scanId: scan.scanId, source: 'body.txt' }), /失效/);
  }
});
test('new scan revokes prior preview before I/O, including scan failure and competing requests', async () => {
  let deferred = false,
    rejectScan: ((error: Error) => void) | undefined;
  const service = new MaterialPreflightService(
    {
      scan: async () =>
        deferred
          ? new Promise<MaterialScan>((_resolve, reject) => {
              rejectScan = reject;
            })
          : generated(),
    },
    () => new Date().toISOString(),
  );
  const first = await service.inspectForPreview({ directory: 'generated' });
  deferred = true;
  const pending = service.inspectForPreview({ directory: 'new' });
  assert.throws(() => service.preview({ scanId: first.scanId, source: 'body.txt' }), /失效/);
  await assert.rejects(service.inspectForPreview({ directory: 'competing' }), /正在检查/);
  assert.ok(rejectScan);
  rejectScan(Error('private source failure'));
  await assert.rejects(pending, /private source/);
  assert.throws(() => service.preview({ scanId: first.scanId, source: 'body.txt' }), /失效/);
});
test('duplicate preview anchors are rejected and never leave a partially usable cache', async () => {
  const scan = generated();
  const item = scan.packages[0];
  assert.ok(item);
  scan.packages.push(structuredClone(item));
  const service = new MaterialPreflightService({ scan: async () => scan }, () =>
    new Date().toISOString(),
  );
  await assert.rejects(service.inspectForPreview({ directory: 'generated' }), /来源重复/);
  assert.throws(() => service.preview({ scanId: randomUUID(), source: 'body.txt' }), /失效/);
});
