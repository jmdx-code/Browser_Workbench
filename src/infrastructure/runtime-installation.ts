import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { ReleaseManifest, semverCompare, type Manifest } from '../shared/software-update.js';
import { productExtensionDirectory } from './paths.js';

export const runtimeDirectory = () =>
  path.join(path.dirname(productExtensionDirectory()), 'runtime');
export function engineFingerprint(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workbenchEngine?: { electron: string };
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        electron: pkg.devDependencies?.electron ?? pkg.workbenchEngine?.electron ?? '',
        dependencies: Object.fromEntries(
          Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
    )
    .digest('hex');
}
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function safeRuntimeEntry(name: string) {
  if (
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.split('/').some((p) => !p || p === '.' || p === '..') ||
    !(
      /^(?:dist\/src\/|web\/|public\/|config\/|extension-build\/)/.test(name) ||
      name === 'package.json'
    )
  )
    throw Error('UPDATE_ARCHIVE_PATH_INVALID');
  return name;
}
export async function validateRuntime(directory: string, manifest: Manifest, fingerprint: string) {
  if (manifest.engineFingerprint !== fingerprint)
    throw Error('底层引擎或依赖已变化，请下载完整安装包更新');
  const required = [
    'package.json',
    'dist/src/server.js',
    'dist/src/desktop/main.js',
    'web/index.html',
    'extension-build/manifest.json',
  ];
  for (const name of required)
    if (!manifest.files[name]) throw Error('UPDATE_REQUIRED_FILE_MISSING:' + name);
  const expected = new Set(Object.keys(manifest.files));
  async function walk(dir: string, prefix = '') {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + file.name;
      if (!prefix && name === 'release-manifest.json') continue;
      if (file.isSymbolicLink()) throw Error('UPDATE_SYMLINK_REJECTED');
      if (file.isDirectory()) await walk(path.join(dir, file.name), name + '/');
      else if (!expected.has(name)) throw Error('UPDATE_UNLISTED_FILE:' + name);
    }
  }
  await walk(directory);
  for (const [name, digest] of Object.entries(manifest.files)) {
    safeRuntimeEntry(name);
    const file = path.join(directory, ...name.split('/'));
    if (!(await lstat(file)).isFile() || sha256(await readFile(file)) !== digest)
      throw Error('UPDATE_FILE_INTEGRITY_FAILED:' + name);
  }
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workbenchEngine?: { electron: string };
  };
  const ext = JSON.parse(
    await readFile(path.join(directory, 'extension-build/manifest.json'), 'utf8'),
  ) as { version: string };
  if (
    pkg.version !== manifest.softwareVersion ||
    ext.version !== manifest.extensionVersion ||
    engineFingerprint(pkg) !== fingerprint
  )
    throw Error('UPDATE_PACKAGE_VERSION_OR_ENGINE_MISMATCH');
}
export async function selectRuntime(baseRoot: string, directory = runtimeDirectory()) {
  try {
    const pkg = JSON.parse(await readFile(path.join(baseRoot, 'package.json'), 'utf8')) as {
      version: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      workbenchEngine?: { electron: string };
    };
    const manifest = ReleaseManifest.parse(
      JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8')),
    );
    if (semverCompare(manifest.softwareVersion, pkg.version) <= 0) return baseRoot;
    await validateRuntime(directory, manifest, engineFingerprint(pkg));
    return directory;
  } catch {
    return baseRoot;
  }
}
