import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FilesystemMaterialScanner,
  materialScanBudget,
} from '../src/infrastructure/material-scanner.js';
import { MaterialPreflightService } from '../src/application/material-preflight.js';
import { summarizeMaterialScan } from '../src/domain/materials.js';
import type { MaterialScan } from '../src/shared/materials.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-material-test-'));
  const root = path.join(dir, 'source');
  await mkdir(root);
  return {
    root,
    dir,
    scanner: new FilesystemMaterialScanner(),
    async close() {
      const resolved = path.resolve(dir);
      if (
        path.dirname(resolved) !== path.resolve(tmpdir()) ||
        !path.basename(resolved).startsWith('wb-material-test-')
      )
        throw Error('TEMP_CLEANUP_SCOPE');
      await rm(resolved, { recursive: true, force: true });
    },
  };
}

test('material filesystem preflight parses text/single image/multi-image/video as whole posts', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'text.txt'), 'only text');
    await writeFile(path.join(f.root, 'image.PNG'), png);
    await writeFile(path.join(f.root, 'image.txt'), 'caption');
    const multi = path.join(f.root, 'multi');
    await mkdir(multi);
    await writeFile(path.join(multi, '正文.txt'), 'album');
    await writeFile(path.join(multi, '01.png'), png);
    await writeFile(path.join(multi, '02.png'), png);
    await writeFile(path.join(f.root, 'video.mp4'), await readFile('public/sample.mp4'));
    await writeFile(path.join(f.root, 'video.txt'), 'clip');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.complete, true);
    assert.deepEqual(scan.issues, []);
    assert.deepEqual(scan.packages.map((item) => item.format).sort(), [
      'multi-image',
      'single-image',
      'text',
      'video',
    ]);
    assert.equal(scan.packages.find((item) => item.format === 'multi-image')?.files.length, 3);
    assert.equal(scan.packages.find((item) => item.format === 'single-image')?.text, 'caption');
    assert.equal(scan.packages.find((item) => item.format === 'single-image')?.source, 'image.PNG');
    assert.equal(summarizeMaterialScan(scan, new Date().toISOString()).publishingReady, false);
  } finally {
    await f.close();
  }
});
test('renaming/reordering files and folders does not bypass package content fingerprints', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.root, 'original');
    await mkdir(folder);
    await writeFile(path.join(folder, '正文.txt'), 'caption');
    await writeFile(path.join(folder, '1.png'), png);
    await writeFile(path.join(folder, '2.jpg'), Buffer.from([255, 216, 255, 224, 0, 0, 0]));
    const first = await f.scanner.scan(f.root);
    await rename(path.join(folder, '1.png'), path.join(folder, '9.png'));
    await rename(folder, path.join(f.root, 'renamed'));
    const second = await f.scanner.scan(f.root);
    assert.equal(first.packages.length, 1);
    assert.equal(second.packages.length, 1);
    assert.equal(first.packages[0]?.fingerprint, second.packages[0]?.fingerprint);
  } finally {
    await f.close();
  }
});
test('normalized UTF-8 text shares a fingerprint but content changes produce a new one', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), '\uFEFF cafe\u0301\r\nhello ');
    await writeFile(path.join(f.root, 'b.txt'), 'café\nhello');
    const first = await f.scanner.scan(f.root);
    const report = summarizeMaterialScan(first, new Date().toISOString());
    assert.equal(report.uniqueContents, 1);
    assert.equal(report.packages.filter((item) => item.duplicateOf).length, 1);
    await writeFile(path.join(f.root, 'b.txt'), 'different');
    const second = await f.scanner.scan(f.root);
    assert.equal(summarizeMaterialScan(second, new Date().toISOString()).uniqueContents, 2);
  } finally {
    await f.close();
  }
});
test('caption and media are both included in package identity, separate from names', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'a.png'), png);
    await writeFile(path.join(f.root, 'a.txt'), 'first');
    await writeFile(path.join(f.root, 'b.png'), png);
    await writeFile(path.join(f.root, 'b.txt'), 'second');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages.length, 2);
    assert.notEqual(scan.packages[0]?.fingerprint, scan.packages[1]?.fingerprint);
  } finally {
    await f.close();
  }
});
test('archive and temporary files are excluded without deleting or moving any source', async () => {
  const f = await fixture();
  try {
    const archive = path.join(f.root, '已发');
    await mkdir(archive);
    await writeFile(path.join(archive, 'old.txt'), 'archive');
    await writeFile(path.join(f.root, 'draft.tmp'), 'temp');
    await writeFile(path.join(f.root, 'ok.txt'), 'keep');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.excluded, 2);
    assert.equal(scan.packages.length, 1);
    assert.equal(await readFile(path.join(archive, 'old.txt'), 'utf8'), 'archive');
    assert.equal(await readFile(path.join(f.root, 'draft.tmp'), 'utf8'), 'temp');
    await assert.rejects(f.scanner.scan(archive), /资源目录/);
  } finally {
    await f.close();
  }
});
test('ambiguous standalone sidecars fail as one group and do not emit a detached caption', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'same.png'), png);
    await writeFile(path.join(f.root, 'same.jpg'), Buffer.from([255, 216, 255]));
    await writeFile(path.join(f.root, 'same.txt'), 'body');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages.length, 0);
    assert.equal(scan.issues[0]?.code, 'AMBIGUOUS_SIDECAR');
  } finally {
    await f.close();
  }
});
test('mixed media and multiple videos reject the whole folder without splitting a post', async () => {
  const f = await fixture();
  try {
    const video = await readFile('public/sample.mp4');
    const mixed = path.join(f.root, 'mixed');
    await mkdir(mixed);
    await writeFile(path.join(mixed, 'a.png'), png);
    await writeFile(path.join(mixed, 'b.mp4'), video);
    const doubled = path.join(f.root, 'doubled');
    await mkdir(doubled);
    await writeFile(path.join(doubled, 'a.mp4'), video);
    await writeFile(path.join(doubled, 'b.mp4'), video);
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages.length, 0);
    assert.equal(scan.issues.length, 2);
    assert.ok(scan.issues.every((item) => item.code === 'MIXED_MEDIA'));
  } finally {
    await f.close();
  }
});
test('unknown folder members/nested folders/nonstandard captions cannot be silently dropped', async () => {
  const f = await fixture();
  try {
    for (const name of ['unknown', 'nested', 'caption']) {
      const folder = path.join(f.root, name);
      await mkdir(folder);
      await writeFile(path.join(folder, 'a.png'), png);
    }
    await writeFile(path.join(f.root, 'unknown', 'ignored.bin'), 'unknown');
    await mkdir(path.join(f.root, 'nested', '已发'));
    await writeFile(path.join(f.root, 'caption', 'notes.txt'), 'body');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages.length, 0);
    assert.equal(scan.issues.length, 3);
    assert.deepEqual(scan.issues.map((item) => item.code).sort(), [
      'AMBIGUOUS_TEXT',
      'LINK_OR_NESTED',
      'UNSUPPORTED_FILE',
    ]);
  } finally {
    await f.close();
  }
});
test('empty or invalid UTF-8 text and mismatched media headers are explicit problems', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'blank.txt'), '  ');
    await writeFile(path.join(f.root, 'encoding.txt'), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(f.root, 'wrong.png'), 'not an image');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages.length, 0);
    assert.deepEqual(scan.issues.map((item) => item.code).sort(), [
      'EMPTY_PACKAGE',
      'MEDIA_HEADER_MISMATCH',
      'TEXT_ENCODING',
    ]);
  } finally {
    await f.close();
  }
});
test('junctions and root links cannot escape into external material directories', async () => {
  const f = await fixture();
  try {
    const external = path.join(f.dir, 'external');
    await mkdir(external);
    await writeFile(path.join(external, 'private.txt'), 'outside');
    const junction = path.join(f.root, 'linked');
    await symlink(external, junction, 'junction');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages.length, 0);
    assert.equal(scan.issues[0]?.code, 'LINK_OR_NONFILE');
    await assert.rejects(f.scanner.scan(junction), /链接/);
    assert.equal(await readFile(path.join(external, 'private.txt'), 'utf8'), 'outside');
  } finally {
    await f.close();
  }
});
test('directory entry budget reports incomplete scan rather than a complete partial inventory', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'a');
    await writeFile(path.join(f.root, 'b.txt'), 'b');
    const scan = await new FilesystemMaterialScanner({ ...materialScanBudget, entries: 1 }).scan(
      f.root,
    );
    assert.equal(scan.complete, false);
    assert.equal(scan.packages.length, 0);
    assert.equal(scan.issues[0]?.code, 'SCAN_BUDGET');
  } finally {
    await f.close();
  }
});
test('global byte budget fails incomplete; per-file text limit rejects only that package', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'a.txt'), 'long text');
    const global = await new FilesystemMaterialScanner({
      ...materialScanBudget,
      totalBytes: 1,
    }).scan(f.root);
    assert.equal(global.complete, false);
    assert.equal(global.issues[0]?.code, 'SCAN_BUDGET');
    const individual = await new FilesystemMaterialScanner({
      ...materialScanBudget,
      textBytes: 1,
    }).scan(f.root);
    assert.equal(individual.complete, true);
    assert.equal(individual.packages.length, 0);
    assert.equal(individual.issues[0]?.code, 'TEXT_BUDGET');
  } finally {
    await f.close();
  }
});
test('source snapshots capture exact bytes and metadata while public reports omit bodies and file proofs', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'body.txt'), 'private body');
    const scan = await f.scanner.scan(f.root);
    assert.equal(scan.packages[0]?.files[0]?.bytes, 12);
    assert.match(scan.packages[0]?.files[0]?.digest ?? '', /^[a-f0-9]{64}$/);
    assert.ok(scan.packages[0]?.files[0]?.proof.ino);
    const publicReport = JSON.stringify(summarizeMaterialScan(scan, new Date().toISOString()));
    assert.equal(publicReport.includes('private body'), false);
    assert.equal(publicReport.includes('mtimeNs'), false);
  } finally {
    await f.close();
  }
});
test('relative paths and unavailable roots reject without inventing empty valid inventories', async () => {
  await assert.rejects(new FilesystemMaterialScanner().scan('relative'), /绝对路径/);
  const f = await fixture();
  try {
    await assert.rejects(f.scanner.scan(path.join(f.root, 'missing')), /不可读取/);
  } finally {
    await f.close();
  }
});
test('material preflight service serializes scans, validates input and releases its gate on failure', async () => {
  let release: ((scan: MaterialScan) => void) | undefined;
  const scanner = {
    scan: async () =>
      new Promise<MaterialScan>((resolve) => {
        release = resolve;
      }),
  };
  const service = new MaterialPreflightService(scanner, () => new Date().toISOString());
  const request = service.inspect({ directory: 'test' });
  await assert.rejects(service.inspect({ directory: 'other' }), /正在检查/);
  assert.ok(release);
  release({ directory: 'test', complete: true, packages: [], issues: [], excluded: 0 });
  assert.equal((await request).readonly, true);
  await assert.rejects(service.inspect({ directory: '', script: 'anything' }));
  let attempts = 0;
  const failing = new MaterialPreflightService(
    {
      scan: async () => {
        attempts++;
        throw Error('source failure');
      },
    },
    () => new Date().toISOString(),
  );
  await assert.rejects(failing.inspect({ directory: 'test' }));
  await assert.rejects(failing.inspect({ directory: 'test' }));
  assert.equal(attempts, 2);
});
