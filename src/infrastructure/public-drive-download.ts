import type { Awaitable } from '../domain/persistence.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, open, statfs, chmod } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mediaReference } from '../domain/resource-table.js';
import { headerMatches, proofOf } from './material-file-utils.js';
import type { DownloadedResourceMedia } from '../shared/resource-materials.js';

export interface DriveDownloadPolicy {
  maxBytes: number;
  reserveBytes: number;
  milliseconds: number;
  redirects: number;
}
const defaults: DriveDownloadPolicy = {
  maxBytes: 10 * 1024 ** 3,
  reserveBytes: 64 * 1024 ** 2,
  milliseconds: 300_000,
  redirects: 6,
};
const hosts = new Set(['drive.google.com', 'drive.usercontent.google.com', 'docs.google.com']);
function allowedURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.has(url.hostname)
  )
    throw Error('DRIVE_REDIRECT_REJECTED');
  return url;
}
function fileIdentity(source: string) {
  if (mediaReference(source).kind !== 'drive') throw Error('DRIVE_FILE_REFERENCE_REQUIRED');
  const url = new URL(source);
  const id =
    /^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
  if (!id || id.length > 256) throw Error('DRIVE_FILE_REFERENCE_REQUIRED');
  const resourceKey = url.searchParams.get('resourcekey');
  if (resourceKey && !/^[a-zA-Z0-9_-]{1,256}$/.test(resourceKey))
    throw Error('DRIVE_RESOURCE_KEY_INVALID');
  return { id, resourceKey };
}
function extension(head: Buffer) {
  return ['.png', '.jpg', '.webp', '.mp4'].find((ext) => headerMatches('media' + ext, head));
}
function confirmationURL(html: string, original: { id: string; resourceKey: string | null }) {
  const attributes = (tag: string) => {
    const result: Record<string, string> = {};
    for (const entry of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = entry[1],
        value = entry[2] ?? entry[3];
      if (!key || value === undefined || key.toLowerCase() in result)
        throw Error('DRIVE_CONFIRMATION_SCOPE');
      result[key.toLowerCase()] = value.replaceAll('&amp;', '&');
    }
    return result;
  };
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)].filter(
    (entry) => attributes(entry[1] ?? '').id === 'download-form',
  );
  if (forms.length !== 1) throw Error('DRIVE_PERMISSION_OR_CONFIRMATION_REQUIRED');
  const form = forms[0];
  if (!form) throw Error('DRIVE_PERMISSION_OR_CONFIRMATION_REQUIRED');
  const properties = attributes(form[1] ?? '');
  if (!properties.action || (properties.method && properties.method.toLowerCase() !== 'get'))
    throw Error('DRIVE_PERMISSION_OR_CONFIRMATION_REQUIRED');
  const url = allowedURL(properties.action);
  if (url.hostname !== 'drive.usercontent.google.com' || url.pathname !== '/download')
    throw Error('DRIVE_CONFIRMATION_SCOPE');
  const keys = new Set<string>();
  for (const tag of (form[2] ?? '').matchAll(/<input\b([^>]*)>/gi)) {
    const value = attributes(tag[1] ?? '');
    if (
      value.type?.toLowerCase() !== 'hidden' ||
      !value.name ||
      value.value === undefined ||
      !['id', 'export', 'confirm', 'uuid', 'resourcekey'].includes(value.name) ||
      keys.has(value.name) ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(value.value)
    )
      throw Error('DRIVE_CONFIRMATION_SCOPE');
    keys.add(value.name);
    url.searchParams.set(value.name, value.value);
  }
  if (
    url.searchParams.get('id') !== original.id ||
    url.searchParams.get('export') !== 'download' ||
    !url.searchParams.get('confirm')
  )
    throw Error('DRIVE_CONFIRMATION_SCOPE');
  if (original.resourceKey) {
    const key = url.searchParams.get('resourcekey');
    if (key && key !== original.resourceKey) throw Error('DRIVE_CONFIRMATION_SCOPE');
    url.searchParams.set('resourcekey', original.resourceKey);
  }
  return url;
}
async function boundedHTML(response: Response, check: (bytes?: number) => Awaitable<void>) {
  if (!response.body) throw Error('DRIVE_PERMISSION_OR_CONFIRMATION_REQUIRED');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      await check();
      const part = await reader.read();
      await check();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) throw Error('DRIVE_CONFIRMATION_SIZE_LIMIT');
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
// Public links only. No browser cookies, OAuth extraction, login or restriction bypass.
// HTML is never cached as a media file. Challenges remain explicit failures.
export class PublicDriveDownloader {
  private busy = false;
  constructor(
    private readonly directory: string,
    private readonly policy: DriveDownloadPolicy = defaults,
    private readonly request: typeof fetch = fetch,
  ) {}
  async download(
    source: string,
    index: number,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<DownloadedResourceMedia> {
    const identity = fileIdentity(source);
    if (this.busy) throw Error('DRIVE_DOWNLOAD_BUSY');
    if (!Number.isSafeInteger(index) || index < 0 || index >= 20) throw Error('DRIVE_MEMBER_INDEX');
    this.busy = true;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.policy.milliseconds);
    let revoked: unknown;
    const cancelOnRevocation = setInterval(async () => {
      if (revoked !== undefined) return;
      try {
        await assertCurrent();
      } catch (error) {
        revoked = error;
        controller.abort();
      }
    }, 100);
    const check = async (bytes = 0) => {
      if (revoked !== undefined) throw revoked;
      await assertCurrent(bytes);
      if (controller.signal.aborted || performance.now() - started > this.policy.milliseconds)
        throw Error('DRIVE_DOWNLOAD_TIMEOUT');
    };
    let response: Response | undefined;
    try {
      await check();
      if (!path.isAbsolute(this.directory)) throw Error('DRIVE_CACHE_ROOT_INVALID');
      const root = path.resolve(this.directory);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await check();
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await realpath(root)) !== root)
        throw Error('DRIVE_CACHE_ROOT_INVALID');
      const space = await statfs(root, { bigint: true });
      await check();
      const available = space.bavail * space.bsize - BigInt(this.policy.reserveBytes);
      const maximum = Math.min(this.policy.maxBytes, Number(available));
      if (maximum < 1) throw Error('DRIVE_CACHE_NO_SPACE');
      const url = new URL('https://drive.google.com/uc');
      url.searchParams.set('export', 'download');
      url.searchParams.set('id', identity.id);
      if (identity.resourceKey) url.searchParams.set('resourcekey', identity.resourceKey);
      let current = url;
      let confirmed = false;
      for (let hop = 0; ; hop++) {
        await check();
        response = await this.request(allowedURL(current.href), {
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
          headers: { 'accept-encoding': 'identity' },
        });
        await check();
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          if (
            response.status === 200 &&
            response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
              'text/html'
          ) {
            if (confirmed || hop >= this.policy.redirects)
              throw Error('DRIVE_PERMISSION_OR_CONFIRMATION_REQUIRED');
            current = confirmationURL(await boundedHTML(response, check), identity);
            await check();
            confirmed = true;
            continue;
          }
          break;
        }
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop >= this.policy.redirects) throw Error('DRIVE_REDIRECT_LIMIT');
        current = allowedURL(new URL(location, current).href);
        // A redirect must not change the requested Drive object.
        const redirectedId = current.searchParams.get('id');
        if (redirectedId && redirectedId !== identity.id) throw Error('DRIVE_FILE_ID_CHANGED');
      }
      if (!response.ok || response.status !== 200 || !response.body)
        throw Error('DRIVE_PUBLIC_DOWNLOAD_UNAVAILABLE');
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (type === 'text/html' || type === 'application/json' || type?.startsWith('text/'))
        throw Error('DRIVE_PERMISSION_OR_CONFIRMATION_REQUIRED');
      const lengthHeader = response.headers.get('content-length');
      const declared = lengthHeader === null ? null : Number(lengthHeader);
      if (
        declared !== null &&
        (!/^\d+$/.test(lengthHeader ?? '') ||
          !Number.isSafeInteger(declared) ||
          declared < 1 ||
          declared > maximum)
      )
        throw Error('DRIVE_DOWNLOAD_SIZE_LIMIT');
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity')
        throw Error('DRIVE_ENCODING_UNSUPPORTED');
      const folder = path.join(root, randomUUID());
      await mkdir(folder, { mode: 0o700 });
      await check();
      const partial = path.join(folder, 'media.part');
      const handle = await open(partial, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      let head = Buffer.alloc(0);
      try {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            await check();
            if (item.done) break;
            const chunk = item.value;
            await check(chunk.byteLength);
            bytes += chunk.byteLength;
            if (bytes > maximum || (declared !== null && bytes > declared))
              throw Error('DRIVE_DOWNLOAD_SIZE_LIMIT');
            if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk)]).subarray(0, 16);
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              await check();
              const written = await handle.write(chunk, offset, chunk.byteLength - offset, null);
              await check();
              if (!written.bytesWritten) throw Error('DRIVE_CACHE_WRITE_INCOMPLETE');
              offset += written.bytesWritten;
            }
          }
        } finally {
          reader.releaseLock();
        }
        await check();
        if (!bytes || (declared !== null && bytes !== declared))
          throw Error('DRIVE_DOWNLOAD_TRUNCATED');
        await handle.sync();
        await check();
      } finally {
        await handle.close();
      }
      const ext = extension(head);
      if (!ext) throw Error('DRIVE_MEDIA_TYPE_UNSUPPORTED');
      const digest = hash.digest('hex');
      const destination = path.join(folder, digest + ext);
      // Same-folder no-overwrite hard link, then retain partial on failure for inspection.
      const { link, unlink } = await import('node:fs/promises');
      await check();
      await link(partial, destination);
      await check();
      await unlink(partial);
      await chmod(destination, 0o400);
      await check();
      const stat = await lstat(destination, { bigint: true });
      const result: DownloadedResourceMedia = {
        index,
        source,
        path: destination,
        extension: ext as DownloadedResourceMedia['extension'],
        digest,
        bytes,
        proof: proofOf(stat),
      };
      const manifest = await open(path.join(folder, 'ready.json'), 'wx', 0o400);
      try {
        await manifest.writeFile(JSON.stringify({ version: 1, ...result, finalURL: current.href }));
        await manifest.sync();
      } finally {
        await manifest.close();
      }
      await check();
      return result;
    } catch (error) {
      if (revoked !== undefined) throw revoked;
      if (controller.signal.aborted) throw Error('DRIVE_DOWNLOAD_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(cancelOnRevocation);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      this.busy = false;
    }
  }
}
