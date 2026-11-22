import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { open, type ZipFile, type Entry } from 'yauzl';
import { z } from 'zod';
import {
  UpdateConfig,
  ReleaseManifest,
  semverCompare,
  type UpdateConfiguration,
  type UpdateRelease,
  type Manifest,
} from '../shared/software-update.js';
import {
  sha256,
  engineFingerprint,
  runtimeDirectory,
  validateRuntime,
  safeRuntimeEntry,
} from './runtime-installation.js';
import { syncProductExtensionDirectory, productExtensionDirectory } from './paths.js';
import { syncProductAiWorkspaceDirectory } from './ai-workspace.js';
import { devDiag } from '../shared/dev-diagnostics.js';

const STALE_BACKUP_DIR_RX =
  /^(?:runtime-before-|runtime-backup-|runtime-wo53-|runtime-composer-|installation-before-)/i;

/**
 * Safely reclaim orphaned historical update backup folders inside `%APPDATA%\Browser Workbench`.
 * NEVER touches active `runtime`, single latest `runtime-previous`, `data`, or `extension`.
 */
export async function pruneStaleRuntimeBackups(
  appDataRoot: string,
): Promise<{ removedDirs: number }> {
  let removedDirs = 0;
  // Disable Electron's ASAR virtual FS interception while removing legacy `installation-before-*` dirs containing `app.asar`.
  const proc = process as NodeJS.Process & { noAsar?: boolean };
  const prevNoAsar = proc.noAsar;
  proc.noAsar = true;
  try {
    const entries = await readdir(appDataRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!STALE_BACKUP_DIR_RX.test(ent.name)) continue;
      try {
        await rm(path.join(appDataRoot, ent.name), { recursive: true, force: true });
        removedDirs++;
      } catch {}
    }
  } catch {
  } finally {
    proc.noAsar = Boolean(prevNoAsar);
  }
  return { removedDirs };
}

export async function extractRuntimeArchive(archive: string, destination: string) {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    open(archive, { lazyEntries: true, strictFileNames: true }, (error, file) =>
      error || !file ? reject(error ?? Error('UPDATE_ZIP_OPEN_FAILED')) : resolve(file),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    let bytes = 0;
    const seen = new Set<string>();
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.once('error', fail);
    zip.once('end', resolve);
    zip.on('entry', (entry: Entry) => {
      try {
        const name = entry.fileName;
        const directory = name.endsWith('/');
        if (
          !directory ||
          !['dist', 'dist/src', 'web', 'public', 'config', 'extension-build'].includes(
            name.slice(0, -1),
          )
        )
          safeRuntimeEntry(directory ? name.slice(0, -1) + '/placeholder' : name);
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 || seen.has(name))
          throw Error('UPDATE_ZIP_LINK_OR_DUPLICATE');
        seen.add(name);
        bytes += entry.uncompressedSize;
        if (bytes > 512 * 1024 * 1024 || seen.size > 20000) throw Error('UPDATE_ZIP_TOO_LARGE');
        if (directory) {
          zip.readEntry();
          return;
        }
        const target = path.join(destination, ...name.split('/'));
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error ?? Error('UPDATE_ZIP_STREAM_FAILED'));
            return;
          }
          void mkdir(path.dirname(target), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(target, { flags: 'wx' })))
            .then(() => zip.readEntry(), fail);
        });
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}
const allowedGithubHosts = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);
const Release = z.object({
  tag_name: z.string(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});
export class SoftwareUpdateBackend {
  private candidate: { release: UpdateRelease; manifest: Manifest } | undefined;
  constructor(
    private readonly options: {
      root: string;
      dataDir: string;
      softwareVersion: string;
      extensionVersion: string;
      runtimeDir?: string;
      extensionDir?: string;
      aiWorkspaceDir?: string;
      apiBase?: string;
      fetch?: typeof fetch;
    },
  ) {}
  private get fetcher() {
    return this.options.fetch ?? fetch;
  }
  private validateUrl(raw: string) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw Error('UPDATE_URL_INVALID');
    }
    const isCustomTestEndpoint = Boolean(this.options.apiBase || this.options.fetch);
    if (isCustomTestEndpoint) {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw Error('UPDATE_URL_PROTOCOL_REJECTED');
      return parsed.href;
    }
    if (parsed.protocol !== 'https:' || !allowedGithubHosts.has(parsed.hostname.toLowerCase()))
      throw Error('UPDATE_URL_HOST_REJECTED');
    return parsed.href;
  }
  async readConfig() {
    for (const file of [
      path.join(this.options.dataDir, 'update-config.json'),
      path.join(this.options.root, 'config/update-source.json'),
    ]) {
      try {
        return UpdateConfig.parse(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return UpdateConfig.parse({ githubRepo: '', autoCheck: true });
  }
  async saveConfig(config: UpdateConfiguration) {
    await mkdir(this.options.dataDir, { recursive: true });
    const file = path.join(this.options.dataDir, 'update-config.json');
    await writeFile(file + '.tmp', JSON.stringify(config, null, 2));
    await rename(file + '.tmp', file);
  }
  private async response(url: string, timeoutMs = 15000) {
    const validatedUrl = this.validateUrl(url);
    const response = await this.fetcher(validatedUrl, {
      headers: { 'User-Agent': 'Browser-Workbench-Updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Error('更新源请求失败：HTTP ' + response.status);
    return response;
  }
  private async renameWithRetry(fromPath: string, toPath: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await rename(fromPath, toPath);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  private async fingerprint() {
    const base = process.env.WORKBENCH_BASE_ROOT ?? this.options.root;
    return engineFingerprint(JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')));
  }
  async check(repo: string) {
    this.candidate = undefined;
    const validRepo = UpdateConfig.shape.githubRepo.parse(repo);
    if (!validRepo) throw Error('UPDATE_REPO_INVALID');
    const release = Release.parse(
      await (
        await this.response(
          (this.options.apiBase ?? 'https://api.github.com') +
            '/repos/' +
            validRepo +
            '/releases/latest',
        )
      ).json(),
    );
    const releaseUrl = this.validateUrl(release.html_url);
    const manifestAsset = release.assets.find((a) => a.name === 'release-manifest.json');
    const manifest = manifestAsset
      ? ReleaseManifest.parse(
          await (await this.response(manifestAsset.browser_download_url)).json(),
        )
      : null;
    const softwareVersion = manifest?.softwareVersion ?? release.tag_name.replace(/^v/, '');
    const extensionVersion = manifest?.extensionVersion ?? null;
    if (semverCompare(softwareVersion, this.options.softwareVersion) < 0) return null;
    if (
      semverCompare(softwareVersion, this.options.softwareVersion) === 0 &&
      (!extensionVersion || semverCompare(extensionVersion, this.options.extensionVersion) <= 0)
    )
      return null;
    const zip = release.assets.find((a) => a.name === 'workbench-hot-update.zip');
    const downloadUrl = zip ? this.validateUrl(zip.browser_download_url) : '';
    const result: UpdateRelease = {
      softwareVersion,
      extensionVersion,
      publishedAt: manifest?.publishedAt ?? release.published_at ?? null,
      notes: manifest?.notes ?? release.body ?? '',
      downloadUrl,
      sha256: manifest?.sha256 ?? null,
      requiresInstaller:
        !zip || !manifest || manifest.engineFingerprint !== (await this.fingerprint()),
      releaseUrl,
    };
    if (manifest) this.candidate = { release: result, manifest };
    return result;
  }
  async install(release: UpdateRelease, guard: () => Promise<void>) {
    const candidate = this.candidate;
    if (
      !candidate ||
      JSON.stringify(candidate.release) !== JSON.stringify(release) ||
      release.requiresInstaller
    )
      throw Error('UPDATE_RELEASE_RECHECK_REQUIRED');
    const runtime = this.options.runtimeDir ?? runtimeDirectory(),
      previous = runtime + '-previous';
    const stage = path.join(path.dirname(runtime), 'update-staging'),
      extracted = path.join(stage, 'extracted');
    const ext = this.options.extensionDir ?? productExtensionDirectory();
    await mkdir(path.dirname(runtime), { recursive: true });
    await rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    await mkdir(extracted, { recursive: true });
    let moved = false,
      installed = false;
    try {
      const response = await this.response(release.downloadUrl, 10 * 60_000);
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 256 * 1024 * 1024) throw Error('UPDATE_DOWNLOAD_TOO_LARGE');
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (!response.body) throw Error('UPDATE_DOWNLOAD_EMPTY');
      const reader = response.body.getReader();
      try {
        for (;;) {
          let chunkTimer: ReturnType<typeof setTimeout> | undefined;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              chunkTimer = setTimeout(() => {
                void reader.cancel().catch(() => {});
                reject(Error('更新包下载超时，请检查网络连接后重试'));
              }, 30_000);
            }),
          ]).finally(() => {
            if (chunkTimer) clearTimeout(chunkTimer);
          });
          if (chunk.done) break;
          const buffer = Buffer.from(chunk.value);
          bytes += buffer.length;
          if (bytes > 256 * 1024 * 1024) throw Error('UPDATE_DOWNLOAD_TOO_LARGE');
          chunks.push(buffer);
        }
      } finally {
        reader.releaseLock();
      }
      const zip = Buffer.concat(chunks);
      if (sha256(zip) !== candidate.manifest.sha256) throw Error('更新包 SHA-256 校验失败');
      const archive = path.join(stage, 'workbench-hot-update.zip');
      await writeFile(archive, zip);
      await extractRuntimeArchive(archive, extracted);
      await validateRuntime(extracted, candidate.manifest, await this.fingerprint());
      await writeFile(
        path.join(extracted, 'release-manifest.json'),
        JSON.stringify(candidate.manifest, null, 2),
      );
      await guard();
      await mkdir(path.dirname(runtime), { recursive: true });
      await rm(previous, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      try {
        await access(runtime);
        await this.renameWithRetry(runtime, previous);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.renameWithRetry(extracted, runtime);
      installed = true;
      await syncProductExtensionDirectory(path.join(runtime, 'extension-build'), ext);
      if (this.options.aiWorkspaceDir) {
        await syncProductAiWorkspaceDirectory({
          rootDir: runtime,
          softwareVersion: release.softwareVersion,
          targetDir: this.options.aiWorkspaceDir,
        });
      } else {
        await syncProductAiWorkspaceDirectory({
          rootDir: runtime,
          softwareVersion: release.softwareVersion,
        }).catch((err: unknown) => {
          devDiag.record({
            level: 'WARN',
            category: 'SYSTEM',
            event: 'AI_WORKSPACE_SYNC_FAILED',
            reason: err instanceof Error ? err.message : 'SYNC_FAILED',
          });
        });
      }
    } catch (error) {
      if (installed) {
        const failedRuntime = runtime + '-failed-' + Date.now();
        await this.renameWithRetry(runtime, failedRuntime)
          .then(() => rm(failedRuntime, { recursive: true, force: true }).catch(() => {}))
          .catch(() =>
            rm(runtime, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(
              () => {},
            ),
          );
      }
      if (moved) {
        await this.renameWithRetry(previous, runtime).catch(() => {});
      }
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(
        () => {},
      );
      await pruneStaleRuntimeBackups(path.dirname(runtime)).catch(() => {});
    }
  }
}
