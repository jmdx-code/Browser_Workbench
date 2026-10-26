import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { copyInstallerAliases } from '../build-release-bundle.mjs';

test('installer aliases contain exactly the current installer bytes and missing required installer fails', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'workbench-installer-alias-'));
  const output = path.join(root, 'release');
  try {
    await fs.mkdir(output);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ productName: 'Browser Workbench', version: '1.2.3' }),
    );
    assert.deepEqual(await copyInstallerAliases(root, output, false), []);
    await assert.rejects(copyInstallerAliases(root, output), /ENOENT/);
    const bytes = Buffer.from('MZ synthetic installer fixture');
    await fs.writeFile(path.join(output, 'Browser Workbench Setup 1.2.3.exe'), bytes);
    const names = await copyInstallerAliases(root, output);
    assert.deepEqual(names, ['Browser.Workbench.Setup.1.2.3.exe', 'Browser.Workbench.Setup.exe']);
    for (const name of names) assert.deepEqual(await fs.readFile(path.join(output, name)), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Chinese display names preserve the original product identity and persistent directory contract', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const extension = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
  assert.equal(pkg.productName, 'Browser Workbench');
  assert.equal(pkg.build.productName, 'Browser Workbench');
  assert.equal(pkg.build.nsis.shortcutName, '浏览器工作台');
  assert.equal(pkg.build.nsis.uninstallDisplayName, '浏览器工作台');
  assert.equal(extension.name, '浏览器工作台');
  assert.match(await fs.readFile('extension/options.html', 'utf8'), /<h1>浏览器工作台<\/h1>/);
});
