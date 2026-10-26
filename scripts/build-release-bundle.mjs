import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { engineFingerprint, sha256 } from '../dist/src/infrastructure/runtime-installation.js';
import { ReleaseManifest } from '../dist/src/shared/software-update.js';
export async function copyInstallerAliases(
  root = process.cwd(),
  output = path.join(root, 'release'),
  required = true,
) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const installer = path.join(
    output,
    `${pkg.productName ?? 'Browser Workbench'} Setup ${pkg.version}.exe`,
  );
  try {
    await access(installer);
  } catch (error) {
    if (!required && error.code === 'ENOENT') return [];
    throw error;
  }
  const aliases = [`Browser.Workbench.Setup.${pkg.version}.exe`, 'Browser.Workbench.Setup.exe'];
  for (const alias of aliases) await copyFile(installer, path.join(output, alias));
  return aliases;
}
export async function buildReleaseBundle(
  root = process.cwd(),
  output = path.join(root, 'release'),
) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.workbenchEngine && pkg.workbenchEngine.electron !== pkg.devDependencies?.electron)
    throw Error('RELEASE_ENGINE_METADATA_MISMATCH');
  const extension = JSON.parse(
    await readFile(path.join(root, 'extension-build/manifest.json'), 'utf8'),
  );
  const zip = new ZipFile(),
    files = {};
  async function add(name) {
    const file = path.join(root, ...name.split('/'));
    const bytes = await readFile(file);
    files[name] = sha256(bytes);
    zip.addBuffer(bytes, name, { mtime: new Date('2020-01-01T00:00:00Z'), mode: 0o100644 });
  }
  async function walk(name) {
    for (const entry of await readdir(path.join(root, name), { withFileTypes: true })) {
      const next = name + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('RELEASE_SYMLINK_REJECTED');
      if (next === 'config/publication-acceptance-scope.json' || next.endsWith('.map')) continue;
      if (entry.isDirectory()) await walk(next);
      else await add(next);
    }
  }
  for (const name of ['dist/src', 'web', 'public', 'config', 'extension-build']) await walk(name);
  await add('package.json');
  await mkdir(output, { recursive: true });
  const zipPath = path.join(output, 'workbench-hot-update.zip');
  const done = pipeline(zip.outputStream, createWriteStream(zipPath));
  zip.end();
  await done;
  const manifest = ReleaseManifest.parse({
    softwareVersion: pkg.version,
    extensionVersion: extension.version,
    zipAssetName: 'workbench-hot-update.zip',
    sha256: sha256(await readFile(zipPath)),
    publishedAt: new Date().toISOString(),
    notes: process.env.RELEASE_NOTES ?? '自动构建发布包',
    engineFingerprint: engineFingerprint(pkg),
    files,
  });
  await writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
  await copyInstallerAliases(root, output, false);
  console.log(
    JSON.stringify({
      zipPath,
      softwareVersion: pkg.version,
      extensionVersion: extension.version,
      files: Object.keys(files).length,
      sha256: manifest.sha256,
    }),
  );
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--installer-aliases'))
    console.log(JSON.stringify({ installerAliases: await copyInstallerAliases() }));
  else await buildReleaseBundle();
}
