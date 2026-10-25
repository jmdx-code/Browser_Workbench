import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  symlink,
  rm,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-build-clean-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    const helper = path.join(root, 'scripts/generated-output.mjs');
    await copyFile(new URL('../generated-output.mjs', import.meta.url), helper);
    const { clearGeneratedDirectory } = await import(pathToFileURL(helper).href);
    await run(root, clearGeneratedDirectory);
  } finally {
    assert.ok(root.startsWith(path.join(tmpdir(), 'workbench-build-clean-')));
    await rm(root, { recursive: true, force: true });
  }
}

test('build cleanup removes stale generated files and leaves adjacent source/data intact', () =>
  fixture(async (root, clear) => {
    await mkdir(path.join(root, 'dist'));
    await mkdir(path.join(root, 'data'));
    await writeFile(path.join(root, 'dist/retired-test.js'), 'stale');
    await writeFile(path.join(root, 'data/keep.txt'), 'keep');
    await clear('dist');
    await assert.rejects(access(path.join(root, 'dist')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'data/keep.txt'), 'utf8'), 'keep');
    await clear('dist');
  }));

test('build cleanup rejects data, releases and paths outside its fixed output allowlist', () =>
  fixture(async (_root, clear) => {
    for (const name of ['data', 'release', '../dist', '/tmp/dist', ''])
      await assert.rejects(clear(name), /GENERATED_OUTPUT_NOT_ALLOWED/);
  }));

test('build cleanup cannot follow a generated-output junction into retained data', () =>
  fixture(async (root, clear) => {
    const data = path.join(root, 'data');
    await mkdir(data);
    await writeFile(path.join(data, 'keep.txt'), 'keep');
    await symlink(
      data,
      path.join(root, 'extension-build'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(clear('extension-build'), /GENERATED_OUTPUT_LINK_REJECTED/);
    assert.equal(await readFile(path.join(data, 'keep.txt'), 'utf8'), 'keep');
  }));
