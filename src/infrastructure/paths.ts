import path from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { mkdir, realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export function productExtensionDirectory() {
  const applicationData = process.env.APPDATA ?? path.join(homedir(), '.config');
  return path.join(applicationData, 'Browser Workbench', 'extension');
}
export async function syncProductExtensionDirectory(
  sourceDir: string,
  targetDir = productExtensionDirectory(),
) {
  const names = ['worker.js', 'options.js', 'options.html', 'manifest.json'];
  const files = await Promise.all(
    names.map(async (name) => ({ name, bytes: await readFile(path.join(sourceDir, name)) })),
  );
  const manifest = JSON.parse(files[3]?.bytes.toString('utf8') ?? '{}') as { version?: string };
  if (!manifest.version || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version))
    throw Error('EXTENSION_MANIFEST_INVALID');
  await mkdir(targetDir, { recursive: true });
  const changed: { name: string; before: Buffer | null }[] = [];
  try {
    for (const file of files) {
      const target = path.join(targetDir, file.name);
      const before = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (before?.equals(file.bytes)) continue;
      const temporary = target + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, file.bytes);
        await rename(temporary, target);
        changed.push({ name: file.name, before });
      } finally {
        await rm(temporary, { force: true });
      }
    }
  } catch (error) {
    for (const row of changed.reverse()) {
      const target = path.join(targetDir, row.name);
      if (row.before) await writeFile(target, row.before);
      else await rm(target, { force: true });
    }
    throw error;
  }
  return { extensionDirectory: targetDir, version: manifest.version };
}
export function productDataDirectory() {
  const applicationData = process.env.APPDATA ?? path.join(homedir(), '.config');
  return path.join(applicationData, 'Browser Workbench', 'data');
}

export function defaultBackupDirectory() {
  const override = process.env.WORKBENCH_BACKUP_DIR?.trim();
  const directory = override
    ? path.resolve(override)
    : path.join(homedir(), 'Documents', 'Browser Workbench', '备份');
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // Keep path available even if directory creation is deferred.
  }
  return directory;
}

export async function canonicalDataDirectory(directory: string) {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true });
  return realpath(resolved);
}
