import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PublicDriveDownloader } from '../src/infrastructure/public-drive-download.js';
import { FilesystemResourceMaterialVerifier } from '../src/infrastructure/resource-material-verifier.js';
import { mediaReference } from '../src/domain/resource-table.js';
import { randomUUID } from 'node:crypto';
const source = 'https://drive.google.com/file/d/public_test_file/view?resourcekey=key_123';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
  'base64',
);
const noop = () => {};
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-drive-'));
  try {
    await run(root);
  } finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('wb-drive-'));
    await rm(root, { force: true, recursive: true });
  }
}
const bytesResponse = (bytes: Uint8Array, declared = bytes.length) =>
  new Response(new Uint8Array(bytes).buffer, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(declared) },
  });
function transport(
  replies: Response[],
  requests: { url: string; options?: RequestInit }[] = [],
): typeof fetch {
  return async (url, options) => {
    requests.push({ url: String(url), options });
    const reply = replies.shift();
    if (!reply) throw Error('TEST_UNEXPECTED_NETWORK_REQUEST');
    return reply;
  };
}
test('public media download follows limited Google redirect, carries resource key, commits real streamed SHA/proof and no cookies', async () =>
  temporary(async (root) => {
    const requests: { url: string; options?: RequestInit }[] = [];
    const downloader = new PublicDriveDownloader(
      root,
      undefined,
      transport(
        [
          new Response(null, {
            status: 302,
            headers: {
              location:
                'https://drive.usercontent.google.com/download?id=public_test_file&export=download&resourcekey=key_123',
            },
          }),
          bytesResponse(png),
        ],
        requests,
      ),
    );
    let read = 0;
    const result = await downloader.download(source, 0, (bytes = 0) => {
      read += bytes;
    });
    assert.equal(read, png.length);
    assert.equal(result.source, source);
    assert.equal(result.digest, createHash('sha256').update(png).digest('hex'));
    assert.equal(result.extension, '.png');
    assert.deepEqual(await readFile(result.path), png);
    assert.equal(result.proof.ino, String((await lstat(result.path, { bigint: true })).ino));
    const manifest = JSON.parse(
      await readFile(path.join(path.dirname(result.path), 'ready.json'), 'utf8'),
    );
    assert.equal(manifest.finalURL, requests[1]?.url);
    assert.deepEqual(
      await readdir(path.dirname(result.path)),
      [path.basename(result.path), 'ready.json'].sort(),
    );
    assert.equal(requests[0]?.options?.credentials, 'omit');
    assert.equal(requests[0]?.options?.redirect, 'manual');
    assert.equal(new URL(requests[0]?.url ?? '').searchParams.get('resourcekey'), 'key_123');
  }));
const confirmation = (
  id = 'public_test_file',
  action = 'https://drive.usercontent.google.com/download',
) =>
  '<form id="download-form" action="' +
  action +
  '" method="get"><input type="hidden" name="id" value="' +
  id +
  '"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="token_1"></form>';
test('normal public large-file confirmation stays on exact file and carries original resource key without executing HTML', async () =>
  temporary(async (root) => {
    const requests: { url: string; options?: RequestInit }[] = [];
    const downloader = new PublicDriveDownloader(
      root,
      undefined,
      transport(
        [
          new Response(confirmation(), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
          bytesResponse(png),
        ],
        requests,
      ),
    );
    assert.equal(
      (await downloader.download(source, 0, noop)).digest,
      createHash('sha256').update(png).digest('hex'),
    );
    assert.equal(new URL(requests[1]?.url ?? '').searchParams.get('resourcekey'), 'key_123');
    assert.equal(new URL(requests[1]?.url ?? '').searchParams.get('confirm'), 't');
  }));
test('login HTML, changed object, duplicate confirmation, hostile redirects and credentials never create READY media', async () => {
  const cases: [Response[], RegExp][] = [
    [
      [new Response('<html>Please sign in</html>', { headers: { 'content-type': 'text/html' } })],
      /PERMISSION_OR_CONFIRMATION_REQUIRED/,
    ],
    [
      [new Response(confirmation('different_file'), { headers: { 'content-type': 'text/html' } })],
      /CONFIRMATION_SCOPE/,
    ],
    [
      [new Response(confirmation() + confirmation(), { headers: { 'content-type': 'text/html' } })],
      /PERMISSION_OR_CONFIRMATION_REQUIRED/,
    ],
    [
      [
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:18767/private' },
        }),
      ],
      /REDIRECT_REJECTED/,
    ],
    [
      [
        new Response(null, {
          status: 302,
          headers: { location: 'https://drive.google.com.evil.test/' },
        }),
      ],
      /REDIRECT_REJECTED/,
    ],
    [
      [
        new Response(null, {
          status: 302,
          headers: { location: 'https://user:secret@drive.google.com/uc' },
        }),
      ],
      /REDIRECT_REJECTED/,
    ],
    [
      [
        new Response(null, {
          status: 302,
          headers: { location: 'https://drive.usercontent.google.com/download?id=foreign_file' },
        }),
      ],
      /FILE_ID_CHANGED/,
    ],
  ];
  for (const [responses, error] of cases)
    await temporary(async (root) => {
      await assert.rejects(
        new PublicDriveDownloader(root, undefined, transport(responses)).download(source, 0, noop),
        error,
      );
      assert.deepEqual(await readdir(root), []);
    });
});
test('size overflow, truncated stream and non-media bytes retain only unready cache; next independent download stays usable', async () => {
  for (const [response, pattern] of [
    [bytesResponse(png, png.length + 1), /DOWNLOAD_TRUNCATED/],
    [bytesResponse(Buffer.from('<html>not a video</html>')), /MEDIA_TYPE_UNSUPPORTED/],
    [bytesResponse(png, 999), /DOWNLOAD_SIZE_LIMIT/],
  ] as const)
    await temporary(async (root) => {
      const downloader = new PublicDriveDownloader(
        root,
        { maxBytes: 100, reserveBytes: 0, milliseconds: 1000, redirects: 3 },
        transport([response, bytesResponse(png)]),
      );
      await assert.rejects(downloader.download(source, 0, noop), pattern);
      for (const dir of await readdir(root))
        assert.ok(!(await readdir(path.join(root, dir))).includes('ready.json'));
      assert.equal((await downloader.download(source, 0, noop)).bytes, png.length);
    });
});
test('header detection supports arbitrarily split stream; timeout and actor revocation cannot mark READY', async () =>
  temporary(async (root) => {
    const split = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of png) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    );
    assert.equal(
      (
        await new PublicDriveDownloader(root, undefined, transport([split])).download(
          source,
          0,
          noop,
        )
      ).extension,
      '.png',
    );
    let revoked = false;
    const failure = new PublicDriveDownloader(root, undefined, async () => {
      revoked = true;
      return bytesResponse(png);
    });
    await assert.rejects(
      failure.download(source, 0, () => {
        if (revoked) throw Error('ACTOR_REVOKED');
      }),
      /ACTOR_REVOKED/,
    );
    const timeout = new PublicDriveDownloader(
      root,
      { maxBytes: 100, reserveBytes: 0, milliseconds: 15, redirects: 1 },
      async (_url, options) => {
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(Error('REQUEST_ABORTED')), {
            once: true,
          }),
        );
        throw Error('UNREACHABLE');
      },
    );
    await assert.rejects(timeout.download(source, 0, noop), /DOWNLOAD_TIMEOUT/);
  }));
test('stopped actor aborts an awaiting download before its long deadline and retains no ready resource', async () =>
  temporary(async (root) => {
    let current = true;
    const downloader = new PublicDriveDownloader(
      root,
      { maxBytes: 100, reserveBytes: 0, milliseconds: 10000, redirects: 1 },
      async (_url, options) => {
        current = false;
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(Error('FETCH_ABORTED')), {
            once: true,
          }),
        );
        throw Error('UNREACHABLE');
      },
    );
    const start = Date.now();
    await assert.rejects(
      downloader.download(source, 0, () => {
        if (!current) throw Error('ACTOR_STOPPED');
      }),
      /ACTOR_STOPPED/,
    );
    assert.ok(Date.now() - start < 1000);
    assert.deepEqual(await readdir(root), []);
  }));
test('Drive material preserves original saved link, canonical byte fingerprint and cached proof', async () =>
  temporary(async (root) => {
    const row = {
      id: randomUUID(),
      text: '网盘配文',
      media: [mediaReference(source)],
      background: 'plain' as const,
    };
    let downloads = 0;
    const verifier = new FilesystemResourceMaterialVerifier(
      undefined,
      undefined,
      new PublicDriveDownloader(root, undefined, async () => {
        downloads++;
        return bytesResponse(png);
      }),
    );
    const snapshot = await verifier.snapshot(row, noop);
    assert.equal(snapshot.format, 'single-image');
    assert.equal(snapshot.downloads?.[0]?.source, row.media[0]?.source);
    assert.equal(snapshot.files[0]?.relativePath, row.id + '/001.png');
    const localPath = snapshot.downloads?.[0]?.path;
    assert.ok(localPath);
    const local = await new FilesystemResourceMaterialVerifier().snapshot(
      { ...row, media: [mediaReference(localPath)] },
      noop,
    );
    assert.equal(local.fingerprint, snapshot.fingerprint);
    assert.equal(downloads, 1);
  }));
