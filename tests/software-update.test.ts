import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { ExtensionUpdates } from '../src/infrastructure/extension-updates.js';
import {
  SoftwareUpdateBackend,
  extractRuntimeArchive,
} from '../src/infrastructure/software-update-backend.js';
import { SoftwareUpdateService } from '../src/application/software-update-service.js';
import {
  engineFingerprint,
  selectRuntime,
  validateRuntime,
} from '../src/infrastructure/runtime-installation.js';
import { syncProductExtensionDirectory } from '../src/infrastructure/paths.js';
import { semverCompare, UpdateConfig, type UpdateRelease } from '../src/shared/software-update.js';
import type { SoftwareUpdatePort } from '../src/domain/software-update.js';

async function fixture(
  run: (f: {
    dir: string;
    base: string;
    candidate: string;
    runtime: string;
    extension: string;
    backend: SoftwareUpdateBackend;
    release: () => Promise<UpdateRelease>;
    manifest: Record<string, unknown>;
    origin: string;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-software-update-')),
    base = path.join(dir, 'base'),
    candidate = path.join(dir, 'candidate'),
    output = path.join(dir, 'release'),
    runtime = path.join(dir, 'application/runtime'),
    extension = path.join(dir, 'application/extension');
  const pkg = {
    name: 'browser-workbench',
    type: 'module',
    version: '1.1.0',
    dependencies: { zod: '4.6.7' },
    devDependencies: { electron: '44.9.3' },
  };
  const content: Record<string, string> = {
    'package.json': JSON.stringify(pkg),
    'dist/src/server.js': 'export const version="1.1.0"',
    'dist/src/desktop/main.js': 'export const desktop=true',
    'web/index.html': 'updated-web',
    'extension-build/manifest.json': JSON.stringify({ manifest_version: 3, version: '0.3.55' }),
    'extension-build/worker.js': 'worker',
    'extension-build/options.js': 'options',
    'extension-build/options.html': 'html',
    'public/app-icon.svg': '<svg/>',
    'config/update-source.json': '{"githubRepo":"","autoCheck":true}',
  };
  for (const [name, value] of Object.entries(content)) {
    const target = path.join(candidate, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ ...pkg, version: '1.0.0' }));
  const { buildReleaseBundle } = await import(
    pathToFileURL(path.resolve('scripts/build-release-bundle.mjs')).href
  );
  const manifest = (await buildReleaseBundle(candidate, output)) as Record<string, unknown>;
  let origin = '';
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/repos/')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: 'v1.1.0',
          html_url: origin + '/releases/v1.1.0',
          body: 'fixture',
          published_at: new Date().toISOString(),
          assets: [
            { name: 'release-manifest.json', browser_download_url: origin + '/manifest' },
            { name: 'workbench-hot-update.zip', browser_download_url: origin + '/zip' },
          ],
        }),
      );
    } else if (req.url === '/manifest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(manifest));
    } else if (req.url === '/zip')
      res.end(await readFile(path.join(output, 'workbench-hot-update.zip')));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  origin = 'http://127.0.0.1:' + addr.port;
  const backend = new SoftwareUpdateBackend({
    root: base,
    dataDir: path.join(dir, 'data'),
    softwareVersion: '1.0.0',
    extensionVersion: '0.3.54',
    runtimeDir: runtime,
    extensionDir: extension,
    apiBase: origin,
  });
  try {
    await run({
      dir,
      base,
      candidate,
      runtime,
      extension,
      backend,
      manifest,
      origin,
      release: async () => {
        const release = await backend.check('owner/repo');
        assert.ok(release);
        return release;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
}

test('semantic versions, prerelease ordering and empty source configuration', () => {
  assert.equal(semverCompare('1.10.0', '1.9.9'), 1);
  assert.equal(semverCompare('1.0.0', '1.0.0-beta.9'), 1);
  assert.equal(semverCompare('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(semverCompare('1.0.0+abc', '1.0.0'), 0);
  assert.throws(() => semverCompare('wat', '1.0.0'));
  assert.equal(UpdateConfig.parse({ githubRepo: '' }).autoCheck, true);
  assert.equal(UpdateConfig.safeParse({ githubRepo: 'https://github.com/a/b' }).success, false);
});

test('packaged metadata keeps engine fingerprint after electron-builder strips devDependencies', () => {
  const source = {
    dependencies: { zod: '4.6.7' },
    devDependencies: { electron: '44.9.3' },
    workbenchEngine: { electron: '44.9.3' },
  };
  assert.equal(
    engineFingerprint(source),
    engineFingerprint({
      dependencies: source.dependencies,
      workbenchEngine: source.workbenchEngine,
    }),
  );
  assert.notEqual(
    engineFingerprint(source),
    engineFingerprint({ ...source, dependencies: { zod: '4.6.8' } }),
  );
});

test('update configuration round-trips in data directory independently of software location', async () =>
  fixture(async (f) => {
    assert.equal((await f.backend.readConfig()).githubRepo, '');
    await f.backend.saveConfig({ githubRepo: 'owner/repo', autoCheck: false });
    assert.deepEqual(await f.backend.readConfig(), { githubRepo: 'owner/repo', autoCheck: false });
  }));

test('fixed extension directory syncs all four files, updates atomically and never copies browser profile files', async () =>
  fixture(async (f) => {
    const a = await syncProductExtensionDirectory(
      path.join(f.candidate, 'extension-build'),
      f.extension,
    );
    assert.equal(a.version, '0.3.55');
    for (const name of ['manifest.json', 'worker.js', 'options.js', 'options.html'])
      await access(path.join(f.extension, name));
    await writeFile(path.join(f.candidate, 'extension-build/worker.js'), 'new worker');
    await syncProductExtensionDirectory(path.join(f.candidate, 'extension-build'), f.extension);
    assert.equal(await readFile(path.join(f.extension, 'worker.js'), 'utf8'), 'new worker');
    await rm(path.join(f.candidate, 'extension-build/options.js'));
    await assert.rejects(
      syncProductExtensionDirectory(path.join(f.candidate, 'extension-build'), f.extension),
    );
    assert.equal(await readFile(path.join(f.extension, 'worker.js'), 'utf8'), 'new worker');
  }));

test('HTTP release fixture downloads, verifies, installs complete runtime and fixed extension; loader selects only newer intact code', async () =>
  fixture(async (f) => {
    const release = await f.release();
    assert.equal(release.requiresInstaller, false);
    assert.equal(release.softwareVersion, '1.1.0');
    let guards = 0;
    await f.backend.install(release, async () => {
      guards++;
    });
    assert.equal(guards, 1);
    assert.equal(await readFile(path.join(f.extension, 'worker.js'), 'utf8'), 'worker');
    assert.equal(await selectRuntime(f.base, f.runtime), f.runtime);
    await writeFile(path.join(f.runtime, 'web/index.html'), 'corrupt');
    assert.equal(await selectRuntime(f.base, f.runtime), f.base);
    await assert.rejects(access(path.join(f.dir, 'data/update-staging')));
  }));

test('SHA256 tampering is rejected before replacing the current runtime', async () =>
  fixture(async (f) => {
    f.manifest.sha256 = '0'.repeat(64);
    const release = await f.release();
    await mkdir(f.runtime, { recursive: true });
    await writeFile(path.join(f.runtime, 'keep'), 'old');
    await assert.rejects(
      f.backend.install(release, async () => {}),
      /SHA-256/,
    );
    assert.equal(await readFile(path.join(f.runtime, 'keep'), 'utf8'), 'old');
  }));

test('commit guard stops a task race; failed extension synchronization rolls runtime back', async () =>
  fixture(async (f) => {
    const release = await f.release();
    await mkdir(f.runtime, { recursive: true });
    await writeFile(path.join(f.runtime, 'keep'), 'old');
    await assert.rejects(
      f.backend.install(release, async () => {
        throw Error('TASK_STARTED');
      }),
      /TASK_STARTED/,
    );
    assert.equal(await readFile(path.join(f.runtime, 'keep'), 'utf8'), 'old');
    await mkdir(path.dirname(f.extension), { recursive: true });
    await writeFile(f.extension, 'blocked directory');
    await assert.rejects(f.backend.install(release, async () => {}));
    assert.equal(await readFile(path.join(f.runtime, 'keep'), 'utf8'), 'old');
  }));

test('engine/native dependency differences require installer instead of hot replacement', async () =>
  fixture(async (f) => {
    f.manifest.engineFingerprint = '1'.repeat(64);
    assert.equal((await f.release()).requiresInstaller, true);
  }));

test('runtime boot rejects same-version and unlisted or incomplete files', async () =>
  fixture(async (f) => {
    const release = await f.release();
    await f.backend.install(release, async () => {});
    await writeFile(
      path.join(f.base, 'package.json'),
      await readFile(path.join(f.candidate, 'package.json')),
    );
    assert.equal(await selectRuntime(f.base, f.runtime), f.base);
    await writeFile(path.join(f.runtime, 'web/extra.js'), 'unlisted');
    const pkg = JSON.parse(await readFile(path.join(f.base, 'package.json'), 'utf8'));
    await assert.rejects(
      validateRuntime(
        f.runtime,
        JSON.parse(await readFile(path.join(f.runtime, 'release-manifest.json'), 'utf8')),
        engineFingerprint(pkg),
      ),
      /UNLISTED/,
    );
  }));

test('zip-slip, absolute paths and symlinks are rejected', async () =>
  fixture(async (f) => {
    const yazl = await import('yazl' as string);
    const archive = new yazl.ZipFile();
    archive.addBuffer(Buffer.from('x'), 'evil.txt');
    const chunks: Buffer[] = [];
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((r) => archive.outputStream.on('end', r));
    archive.end();
    await done;
    const bytes = Buffer.concat(chunks); // same length path traversal replacement, preserving a real ZIP central directory
    const bad = Buffer.from(bytes.toString('latin1').replaceAll('evil.txt', '../x.txt'), 'latin1');
    const file = path.join(f.dir, 'slip.zip');
    await writeFile(file, bad);
    await assert.rejects(extractRuntimeArchive(file, path.join(f.dir, 'extracted')));
    await writeFile(
      file,
      Buffer.from(bytes.toString('latin1').replaceAll('evil.txt', '/tmp.txt'), 'latin1'),
    );
    await assert.rejects(extractRuntimeArchive(file, path.join(f.dir, 'absolute')));
    const link = new yazl.ZipFile(),
      linkChunks: Buffer[] = [];
    link.addBuffer(Buffer.from('../outside'), 'web/link', { mode: 0o120777 });
    link.outputStream.on('data', (chunk: Buffer) => linkChunks.push(chunk));
    const linked = new Promise<void>((r) => link.outputStream.on('end', r));
    link.end();
    await linked;
    await writeFile(file, Buffer.concat(linkChunks));
    await assert.rejects(extractRuntimeArchive(file, path.join(f.dir, 'link')));
    assert.equal(await readFile(path.join(f.base, 'package.json'), 'utf8').then(Boolean), true);
  }));

test('old idle extensions reload once per target, busy accounts are skipped, manual retry resets attempt', async () => {
  const store = new Store(':memory:'),
    core = new Core(store),
    sent: unknown[] = [];
  let busy = false;
  const id = randomUUID();
  let peer = core.connect(
    id,
    (m) => sent.push(m),
    () => {},
  );
  peer.phase = 'PAUSED';
  peer.synced = true;
  peer.extensionVersion = '0.3.53';
  const manager = new ExtensionUpdates(core, '0.3.54', 'fixed', () => busy);
  try {
    busy = true;
    await manager.automatic(peer);
    assert.equal(sent.length, 0);
    busy = false;
    await manager.automatic(peer);
    assert.equal(sent.length, 1);
    assert.equal(peer.synced, false);
    await core.disconnect(peer);
    peer = core.connect(
      id,
      (m) => sent.push(m),
      () => {},
    );
    peer.phase = 'PAUSED';
    peer.synced = true;
    peer.extensionVersion = '0.3.53';
    await manager.automatic(peer);
    assert.equal(sent.length, 1);
    assert.deepEqual(await manager.reload([id, randomUUID()]), {
      reloaded: 1,
      skippedBusy: 0,
      skippedOffline: 1,
      extensionDir: 'fixed',
      bundledVersion: '0.3.54',
    });
    await core.disconnect(peer);
    peer = core.connect(
      id,
      (m) => sent.push(m),
      () => {},
    );
    peer.phase = 'PAUSED';
    peer.synced = true;
    peer.extensionVersion = '0.3.54';
    await manager.automatic(peer);
    assert.equal(manager.autoReloadAttempted.has(id), false);
    const owner = randomUUID();
    await core.claimFixtureKernel(peer, owner);
    assert.equal((await core.reloadExtension(id)).requested, false);
    core.releaseFixtureKernel(peer, owner);
  } finally {
    await core.shutdown();
    store.close();
  }
});

test('empty update source stays silent; busy tasks prevent download and restart', async () => {
  let busy = true,
    installs = 0,
    restarts = 0;
  const release: UpdateRelease = {
    softwareVersion: '2.0.0',
    extensionVersion: '0.3.55',
    notes: '',
    publishedAt: null,
    downloadUrl: 'https://fixture/zip',
    sha256: '0'.repeat(64),
    requiresInstaller: false,
    releaseUrl: 'https://github.com/a/b/releases',
  };
  const port: SoftwareUpdatePort = {
    readConfig: async () => ({ githubRepo: '', autoCheck: true }),
    saveConfig: async () => {},
    check: async () => release,
    install: async () => {
      installs++;
    },
    assertCanApply: async () => {
      if (busy) throw Error('TASKS_ACTIVE');
    },
    restart: () => {
      restarts++;
    },
    reloadExtensions: async () => ({
      reloaded: 0,
      skippedBusy: 0,
      skippedOffline: 0,
      extensionDir: 'fixed',
      bundledVersion: '0.3.55',
    }),
    openExtensionDirectory: () => {},
  };
  const service = new SoftwareUpdateService(port, {
    software: '1.0.0',
    extension: '0.3.54',
    directory: 'fixed',
  });
  assert.equal((await service.status()).error, null);
  assert.equal((await service.status()).availableUpdate, null);
  await service.configure({ githubRepo: 'owner/repo', autoCheck: true });
  await assert.rejects(service.apply(), /TASKS_ACTIVE/);
  assert.equal(installs, 0);
  busy = false;
  await service.apply();
  assert.equal(installs, 1);
  assert.equal(restarts, 1);
  assert.throws(() => service.assertIdle(), /正在更新/);
});

test('external ESM and CommonJS reuse installed dependency exports without NODE_PATH or copying node_modules', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-external-deps-'));
  try {
    const file = path.join(dir, 'entry.mjs');
    await writeFile(
      file,
      "import{z}from'zod';import{chromium}from'playwright-core';import{createRequire}from'node:module';const require=createRequire(import.meta.url);if(!require('ws').WebSocket||!chromium||z.string().parse('ok')!=='ok')throw Error('DEPENDENCY_FAILED');console.log('REUSED');",
    );
    const hook = pathToFileURL(
      path.resolve('dist/src/infrastructure/runtime-dependencies.js'),
    ).href;
    const source = `import{useInstalledDependencies}from ${JSON.stringify(hook)};useInstalledDependencies(${JSON.stringify(process.cwd())});await import(${JSON.stringify(pathToFileURL(file).href)});`;
    const result = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      source,
    ]);
    assert.match(result.stdout, /REUSED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
