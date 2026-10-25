import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MaterialPreflightService } from '../src/application/material-preflight.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialSnapshotVerifier } from '../src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialMediaReader } from '../src/infrastructure/material-media-reader.js';
import type { MaterialSnapshotVerifier } from '../src/application/material-source-check.js';
import type { Profile } from '../src/shared/contracts.js';
import { BROWSER_TEXT_INPUT_LIMIT } from '../src/shared/browser-actions.js';

const scanner = new FilesystemMaterialScanner(),
  verifier = new FilesystemMaterialSnapshotVerifier();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
function profile(online = true): Profile {
  return {
    id: randomUUID(),
    alias: online ? '已连接的生成资料' : '离线的生成资料',
    groupId: null,
    online,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.7',
    capabilities: [],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-review-'));
  await writeFile(path.join(root, 'body.txt'), '正文 <img src=x onerror=alert(1)>');
  await writeFile(path.join(root, 'image.png'), png);
  await writeFile(path.join(root, 'image.txt'), 'caption');
  await mkdir(path.join(root, 'album'));
  await writeFile(path.join(root, 'album', '正文.txt'), 'album');
  await writeFile(path.join(root, 'album', '10.png'), png);
  await writeFile(path.join(root, 'album', '2.png'), png);
  await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'));
  return root;
}
async function cleanup(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('wb-review-'));
  await rm(root, { recursive: true, force: true });
}
test('explicit review verifies all four packages and exact selected targets without inventing acting identity', async () => {
  const root = await fixture();
  try {
    const service = new MaterialPreflightService(
      scanner,
      () => new Date().toISOString(),
      new FilesystemMaterialMediaReader(),
      verifier,
    );
    const scan = await service.inspectForPreview({ directory: root });
    const targets = [profile(), profile(false)];
    // A display profile claiming logged-in must still not grant production authority.
    const first = targets[0];
    assert.ok(first);
    first.account = { state: 'logged-in', id: 'display-only', name: 'display', avatar: null };
    for (const item of scan.report.packages) {
      const request = {
        scanId: scan.scanId,
        source: item.source,
        profileIds: targets.map((target) => target.id),
      };
      const result = await service.review(
        request,
        () => targets,
        () => {},
      );
      assert.equal(result.publishingReady, false);
      assert.equal(result.readonly, true);
      assert.deepEqual(
        result.targets.map((target) => target.profileId),
        request.profileIds,
      );
      assert.deepEqual(result.targets[0]?.blockers, ['IDENTITY_UNVERIFIED']);
      assert.deepEqual(result.targets[1]?.blockers, ['PROFILE_OFFLINE', 'IDENTITY_UNVERIFIED']);
      assert.equal(result.targets[0]?.accountVerified, false);
      assert.deepEqual(result.blockers, []);
      assert.equal(result.fingerprint, item.fingerprint);
      assert.equal(JSON.stringify(result).includes('mtimeNs'), false);
      if (item.format === 'multi-image')
        assert.deepEqual(
          result.files
            .filter((file) => file.role === 'image')
            .map((file) => path.basename(file.relativePath)),
          ['2.png', '10.png'],
        );
    }
    assert.equal(
      await readFile(path.join(root, 'body.txt'), 'utf8'),
      '正文 <img src=x onerror=alert(1)>',
    );
  } finally {
    await cleanup(root);
  }
});
test('review rejects changed captions, changed media, missing members and added package files', async () => {
  for (const change of ['caption', 'media', 'missing', 'extra']) {
    const root = await fixture();
    try {
      const service = new MaterialPreflightService(
        scanner,
        () => new Date().toISOString(),
        undefined,
        verifier,
      );
      const scan = await service.inspectForPreview({ directory: root });
      if (change === 'caption') await writeFile(path.join(root, 'album', '正文.txt'), ' album ');
      if (change === 'media')
        await writeFile(
          path.join(root, 'album', '2.png'),
          Buffer.concat([png, Buffer.from('changed')]),
        );
      if (change === 'missing') await unlink(path.join(root, 'album', '2.png'));
      if (change === 'extra') await writeFile(path.join(root, 'album', '3.png'), png);
      const target = profile();
      await assert.rejects(
        service.review(
          { scanId: scan.scanId, source: 'album', profileIds: [target.id] },
          () => [target],
          () => {},
        ),
        /整包无法核对/,
      );
    } finally {
      await cleanup(root);
    }
  }
});
test('empty, duplicate, foreign or incomplete selections do not invoke source verification', async () => {
  const root = await fixture();
  try {
    let calls = 0;
    const never: MaterialSnapshotVerifier = {
      verifySnapshot: async () => {
        calls++;
        throw Error('must not read');
      },
    };
    const service = new MaterialPreflightService(
      scanner,
      () => new Date().toISOString(),
      undefined,
      never,
    );
    const scan = await service.inspectForPreview({ directory: root }),
      target = profile();
    const request = { scanId: scan.scanId, source: 'body.txt', profileIds: [target.id] };
    await assert.rejects(
      service.review(
        { ...request, profileIds: [] },
        () => [target],
        () => {},
      ),
    );
    await assert.rejects(
      service.review(
        { ...request, profileIds: [target.id, target.id] },
        () => [target],
        () => {},
      ),
    );
    await assert.rejects(
      service.review(
        { ...request, profileIds: [randomUUID()] },
        () => [target],
        () => {},
      ),
      /不存在/,
    );
    await assert.rejects(
      service.review(
        { ...request, directory: root },
        () => [target],
        () => {},
      ),
    );
    await assert.rejects(
      service.review(
        { ...request, publishingReady: true },
        () => [target],
        () => {},
      ),
    );
    const partialScan = await scanner.scan(root);
    partialScan.complete = false;
    const partial = new MaterialPreflightService(
      { scan: async () => partialScan },
      () => new Date().toISOString(),
      undefined,
      never,
    );
    const partialResult = await partial.inspectForPreview({ directory: root });
    await assert.rejects(
      partial.review(
        { ...request, scanId: partialResult.scanId },
        () => [target],
        () => {},
      ),
      /未完成/,
    );
    assert.equal(calls, 0);
  } finally {
    await cleanup(root);
  }
});
test('review shares media backpressure, observes targets after IO, and rejects superseded scans', async () => {
  const root = await fixture();
  try {
    let release: (() => void) | undefined;
    let wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new MaterialPreflightService(
      scanner,
      () => new Date().toISOString(),
      new FilesystemMaterialMediaReader(),
      {
        verifySnapshot: async (input) => {
          await wait;
          return {
            fingerprint: input.snapshot.fingerprint,
            checkedAt: new Date().toISOString(),
            files: input.snapshot.files,
          };
        },
      },
    );
    const scan = await service.inspectForPreview({ directory: root }),
      target = profile();
    const request = { scanId: scan.scanId, source: 'body.txt', profileIds: [target.id] };
    const pending = service.review(
      request,
      () => [target],
      () => {},
    );
    await assert.rejects(
      service.media({ scanId: scan.scanId, source: 'image.png', fileIndex: 0 }, () => {}),
      /另一份媒体/,
    );
    await assert.rejects(
      service.review(
        request,
        () => [target],
        () => {},
      ),
      /另一份媒体/,
    );
    target.online = false;
    release?.();
    assert.equal((await pending).targets[0]?.online, false);
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = service.review(
      request,
      () => [target],
      () => {},
    );
    const rejectedOld = assert.rejects(old, /失效/);
    await service.inspectForPreview({ directory: root });
    release?.();
    await rejectedOld;
  } finally {
    await cleanup(root);
  }
});
test('expired or cancelled review does not leave IO budget locked or revive an old result', async () => {
  const root = await fixture();
  try {
    let now = Date.now(),
      connected = true,
      release: (() => void) | undefined;
    let wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new MaterialPreflightService(
      scanner,
      () => new Date(now).toISOString(),
      undefined,
      {
        verifySnapshot: async (input) => {
          await wait;
          return {
            fingerprint: input.snapshot.fingerprint,
            checkedAt: new Date(now).toISOString(),
            files: input.snapshot.files,
          };
        },
      },
    );
    const scan = await service.inspectForPreview({ directory: root }),
      target = profile();
    const request = { scanId: scan.scanId, source: 'body.txt', profileIds: [target.id] };
    const pending = service.review(
      request,
      () => [target],
      () => {},
    );
    now += 600_000;
    release?.();
    await assert.rejects(pending, /失效/);
    const fresh = await service.inspectForPreview({ directory: root });
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assertConnected = () => {
      if (!connected) throw Error('disconnected');
    };
    const cancelled = service.review(
      { ...request, scanId: fresh.scanId },
      () => [target],
      assertConnected,
    );
    connected = false;
    release?.();
    await assert.rejects(cancelled, /整包无法核对/);
    connected = true;
    assert.equal(
      (await service.review({ ...request, scanId: fresh.scanId }, () => [target], assertConnected))
        .publishingReady,
      false,
    );
  } finally {
    await cleanup(root);
  }
});
test('long text is retained completely with a finite input-capacity blocker, never silently truncated', async () => {
  const root = await fixture();
  try {
    const text = '文'.repeat(BROWSER_TEXT_INPUT_LIMIT + 1);
    await writeFile(path.join(root, 'body.txt'), text);
    const service = new MaterialPreflightService(
      scanner,
      () => new Date().toISOString(),
      undefined,
      verifier,
    );
    const scan = await service.inspectForPreview({ directory: root }),
      target = profile();
    target.unresolved = 1;
    const result = await service.review(
      { scanId: scan.scanId, source: 'body.txt', profileIds: [target.id] },
      () => [target],
      () => {},
    );
    assert.equal(result.text, text);
    assert.deepEqual(result.blockers, ['TEXT_INPUT_LIMIT']);
    assert.deepEqual(result.targets[0]?.blockers, ['PROFILE_NOT_READY', 'IDENTITY_UNVERIFIED']);
    assert.equal(await readFile(path.join(root, 'body.txt'), 'utf8'), text);
  } finally {
    await cleanup(root);
  }
});
