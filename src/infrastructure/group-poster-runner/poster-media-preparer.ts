import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  PosterMediaPreparerPort,
  PreparedPosterMedia,
} from '../../application/group-poster-service.js';
import type { PosterMediaStreamChunk } from '../../application/poster/poster-media-and-types.js';
import { mediaReference } from '../../domain/resource-table.js';
import type { PosterMediaKind } from '../../shared/group-poster.js';
import type { MediaRuntimeComponent } from '../media-runtime-component.js';
import {
  encodeImageBufferToPosterThumbnail,
  generatePosterImageThumbnail,
  generatePosterVideoThumbnail,
  removePosterCachedFileIfSafe,
} from '../poster-media-thumbnail.js';
import { PublicDriveDownloader } from '../public-drive-download.js';
const execFileAsync = promisify(execFile);
const VIDEO_BADGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" rx="16" fill="#1e293b"/><circle cx="160" cy="90" r="34" fill="#334155" stroke="#64748b" stroke-width="2"/><polygon points="150,73 150,107 179,90" fill="#f8fafc"/></svg>';
let fallbackBadge: Promise<string | null> | null = null;
async function systemFfmpegThumb(filePath: string): Promise<string | null> {
  const bins = [process.env.FFMPEG_PATH?.trim(), 'ffmpeg'].filter((v): v is string => Boolean(v));
  for (const bin of new Set(bins)) {
    const tmpFrame = path.join(os.tmpdir(), `wb-poster-thumb-${randomUUID()}.png`);
    const args = ['-y', '-ss', '0.1', '-i', filePath, '-frames:v', '1', '-f', 'image2', tmpFrame];
    try {
      await execFileAsync(bin, args, { timeout: 10_000, windowsHide: true });
      const thumb = await generatePosterImageThumbnail(tmpFrame);
      if (thumb) return thumb;
    } catch {
      // Try next ffmpeg candidate
    } finally {
      await rm(tmpFrame, { force: true }).catch(() => {});
    }
  }
  return null;
}
const bytesMatch = (buf: Buffer, offset: number, sig: readonly number[]) =>
  sig.every((b, i) => buf[offset + i] === b);
const range416 = (total: number): PosterMediaStreamChunk => ({
  status: 416,
  headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
});
const touchFile = (filePath: string) => {
  const now = new Date();
  return utimes(filePath, now, now).catch(() => {});
};
export class FilesystemPosterMediaPreparer implements PosterMediaPreparerPort {
  private static readonly SOURCE_DEDUP_TTL_MS = 20 * 60_000;
  private static readonly ACTIVE_REF_TTL_MS = 6 * 60 * 60_000;
  private readonly sourceToDedupPath = new Map<
    string,
    { localFilePath: string; mediaKind: PosterMediaKind; cachedAt: number }
  >();
  private readonly activeCacheRefs = new Map<string, { count: number; lastTouchedAt: number }>();
  constructor(
    private readonly cacheDir: string,
    private readonly request: typeof fetch = fetch,
    private readonly mediaComponent?: MediaRuntimeComponent | undefined,
  ) {}
  private acquireCacheRef(filePath: string): void {
    const key = path.resolve(filePath);
    const now = Date.now();
    const prev = this.activeCacheRefs.get(key);
    const prevCount =
      prev && now - prev.lastTouchedAt <= FilesystemPosterMediaPreparer.ACTIVE_REF_TTL_MS
        ? prev.count
        : 0;
    this.activeCacheRefs.set(key, { count: prevCount + 1, lastTouchedAt: now });
  }
  private async promoteToHashCache(
    sourceFile: string,
    digestHex: string,
    ext: string,
    cleanupFolder?: string,
  ): Promise<string> {
    const hashDir = path.join(this.cacheDir, 'by-hash');
    await mkdir(hashDir, { recursive: true });
    const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '.bin';
    const dest = path.join(hashDir, `${digestHex.toLowerCase()}${safeExt}`);
    const existingStat = await stat(dest).catch(() => null);
    if (existingStat?.isFile() && existingStat.size > 0) await touchFile(dest);
    else {
      await rename(sourceFile, dest).catch(async () => {
        const tmpDest = `${dest}.${randomUUID().slice(0, 8)}.tmp`;
        await copyFile(sourceFile, tmpDest);
        await rename(tmpDest, dest).catch(() => unlink(tmpDest).catch(() => {}));
      });
    }
    if (cleanupFolder) await rm(cleanupFolder, { recursive: true, force: true }).catch(() => {});
    else if (path.resolve(sourceFile) !== path.resolve(dest))
      await unlink(sourceFile).catch(() => {});
    return dest;
  }
  async prepare(
    mediaSource: string,
    assertCurrent: (bytesRead?: number) => void | Promise<void> = () => {},
  ): Promise<PreparedPosterMedia> {
    const trimmed = mediaSource.trim();
    const handleFileAction = (cachedPath: string, kind: PosterMediaKind) =>
      this.generateThumbnail(cachedPath, kind).then((thumbnailDataUrl) => ({
        localFilePath: cachedPath,
        mediaKind: kind,
        thumbnailDataUrl,
      }));
    if (mediaReference(trimmed).kind === 'drive') {
      const cached = this.sourceToDedupPath.get(trimmed);
      if (
        cached &&
        Date.now() - cached.cachedAt <= FilesystemPosterMediaPreparer.SOURCE_DEDUP_TTL_MS
      ) {
        if (await this.verifyExists(cached.localFilePath)) {
          await touchFile(cached.localFilePath);
          this.acquireCacheRef(cached.localFilePath);
          return handleFileAction(cached.localFilePath, cached.mediaKind);
        }
        this.sourceToDedupPath.delete(trimmed);
      }
      const downloaded = await new PublicDriveDownloader(
        this.cacheDir,
        undefined,
        this.request,
      ).download(trimmed, 0, assertCurrent);
      const dedupPath = await this.promoteToHashCache(
        downloaded.path,
        downloaded.digest,
        downloaded.extension,
        path.dirname(downloaded.path),
      );
      const mediaKind: PosterMediaKind = downloaded.extension === '.mp4' ? 'video' : 'image';
      this.sourceToDedupPath.set(trimmed, {
        localFilePath: dedupPath,
        mediaKind,
        cachedAt: Date.now(),
      });
      this.acquireCacheRef(dedupPath);
      return handleFileAction(dedupPath, mediaKind);
    }
    const resolved = path.resolve(trimmed);
    await access(resolved);
    return handleFileAction(
      resolved,
      /\.(?:mp4|mov|webm|mkv|avi)$/i.test(resolved) ? 'video' : 'image',
    );
  }
  verifyExists = (localFilePath: string): Promise<boolean> =>
    access(localFilePath).then(
      () => true,
      () => false,
    );
  generateThumbnail = async (localFilePath: string, mediaKind: PosterMediaKind) => {
    if (mediaKind === 'image') return generatePosterImageThumbnail(localFilePath);
    if (
      mediaKind !== 'video' ||
      !(await stat(localFilePath).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      return null;
    return (
      (await generatePosterVideoThumbnail(localFilePath, this.mediaComponent)) ??
      (await systemFfmpegThumb(localFilePath)) ??
      (await (fallbackBadge ??= encodeImageBufferToPosterThumbnail(Buffer.from(VIDEO_BADGE_SVG))))
    );
  };
  async removeCachedDriveFile(localFilePath: string): Promise<boolean> {
    const key = path.resolve(localFilePath);
    const now = Date.now();
    const prev = this.activeCacheRefs.get(key);
    const prevRefs =
      prev && now - prev.lastTouchedAt <= FilesystemPosterMediaPreparer.ACTIVE_REF_TTL_MS
        ? prev.count
        : 0;
    if (prevRefs > 1) {
      this.activeCacheRefs.set(key, { count: prevRefs - 1, lastTouchedAt: now });
      return false;
    }
    this.activeCacheRefs.delete(key);
    for (const [srcKey, entry] of this.sourceToDedupPath.entries()) {
      if (path.resolve(entry.localFilePath) === key) this.sourceToDedupPath.delete(srcKey);
    }
    return await removePosterCachedFileIfSafe(this.cacheDir, localFilePath);
  }
  async prepareWithOAuthFallback(
    mediaSource: string,
    getAccessToken?: (() => Promise<string>) | undefined,
  ): Promise<PreparedPosterMedia & { isTemporaryCache: boolean }> {
    const trimmed = mediaSource.trim();
    if (mediaReference(trimmed).kind !== 'drive') {
      return { ...(await this.prepare(trimmed)), isTemporaryCache: false };
    }
    try {
      return { ...(await this.prepare(trimmed)), isTemporaryCache: true };
    } catch (publicErr) {
      if (!getAccessToken) throw publicErr;
      let token: string;
      try {
        token = await getAccessToken();
      } catch {
        throw publicErr;
      }
      const fileId = /(?:\/file\/d\/|[?&]id=)([A-Za-z0-9_-]{10,})/.exec(trimmed)?.[1];
      if (!fileId) throw publicErr;
      const driveGet = (q: string, ms: number) =>
        this.request(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${q}&supportsAllDrives=true`,
          { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ms) },
        );
      const metaRes = await driveGet('fields=name,mimeType', 20_000);
      if (metaRes.status === 403 || metaRes.status === 404) {
        throw new Error(
          '该 Google 网盘素材未公开共享且当前授权无权读取私有网盘（请将素材设为「知道链接的任何人可查看」，或在菜单里重新授权 Google 读取私有网盘）',
        );
      }
      const metaJson = metaRes.ok
        ? ((await metaRes.json().catch(() => ({}))) as { name?: string; mimeType?: string })
        : {};
      const dlRes = await driveGet('alt=media', 120_000);
      if (!dlRes.ok) throw publicErr;
      const contentType = (
        dlRes.headers.get('content-type') ||
        metaJson.mimeType ||
        ''
      ).toLowerCase();
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/json') ||
        contentType.includes('application/pdf')
      ) {
        await dlRes.body?.cancel().catch(() => {});
        throw publicErr;
      }
      const origExt = metaJson.name ? path.extname(metaJson.name).toLowerCase() : '';
      const isVideo =
        contentType.startsWith('video/') || /\.(?:mp4|mov|webm|mkv|avi)$/i.test(origExt);
      const imgExt = contentType.includes('png')
        ? '.png'
        : contentType.includes('webp')
          ? '.webp'
          : contentType.includes('gif')
            ? '.gif'
            : '.jpg';
      const ext = isVideo
        ? /\.(?:mp4|mov|webm|mkv|avi)$/i.test(origExt)
          ? origExt
          : '.mp4'
        : imgExt;
      const maxOAuthMediaBytes = isVideo ? 512 * 1024 * 1024 : 32 * 1024 * 1024;
      const hashDir = path.join(this.cacheDir, 'by-hash');
      await mkdir(hashDir, { recursive: true });
      const tmpPath = path.join(hashDir, `.tmp-${randomUUID()}${ext}`);
      const hasher = createHash('sha256');
      const headChunks: Buffer[] = [];
      let headBytes = 0;
      let totalBytes = 0;
      let fh: Awaited<ReturnType<typeof open>> | null = null;
      try {
        fh = await open(tmpPath, 'w');
        if (!dlRes.body) throw publicErr;
        const reader = dlRes.body.getReader();
        try {
          for (let res = await reader.read(); !res.done; res = await reader.read()) {
            const chunk = Buffer.from(res.value);
            totalBytes += chunk.byteLength;
            if (totalBytes > maxOAuthMediaBytes) {
              await reader.cancel().catch(() => {});
              throw new Error('DRIVE_MEDIA_TOO_LARGE');
            }
            if (headBytes < 16) {
              const take = chunk.subarray(0, Math.min(chunk.byteLength, 16 - headBytes));
              headChunks.push(take);
              headBytes += take.byteLength;
            }
            hasher.update(chunk);
            await fh.write(chunk);
          }
        } finally {
          reader.releaseLock();
        }
        await fh.close();
        fh = null;
        const mediaKind: PosterMediaKind = isVideo ? 'video' : 'image';
        if (totalBytes < 64 || !this.hasValidMediaHeader(Buffer.concat(headChunks), mediaKind))
          throw publicErr;
        const targetPath = path.join(hashDir, `${hasher.digest('hex')}${ext}`);
        if (await this.verifyExists(targetPath)) {
          await rm(tmpPath, { force: true }).catch(() => {});
          await touchFile(targetPath);
        } else await rename(tmpPath, targetPath);
        this.sourceToDedupPath.set(trimmed, {
          localFilePath: targetPath,
          mediaKind,
          cachedAt: Date.now(),
        });
        this.acquireCacheRef(targetPath);
        return {
          localFilePath: targetPath,
          mediaKind,
          thumbnailDataUrl: await this.generateThumbnail(targetPath, mediaKind),
          isTemporaryCache: true,
        };
      } catch (streamErr) {
        await fh?.close().catch(() => {});
        await rm(tmpPath, { force: true }).catch(() => {});
        throw streamErr;
      }
    }
  }
  async pruneOldCachedFiles(
    maxAgeMs = 3 * 24 * 60 * 60_000,
    protectedPaths?: ReadonlySet<string>,
  ): Promise<number> {
    let removed = 0;
    const now = Date.now();
    const cutoff = now - Math.max(60_000, maxAgeMs);
    const resolvedProtected = new Set(
      Array.from(protectedPaths ?? [])
        .filter(Boolean)
        .map((p) => path.resolve(p).toLowerCase()),
    );
    const isProtected = (p: string) =>
      this.activeCacheRefs.has(path.resolve(p)) ||
      resolvedProtected.has(path.resolve(p).toLowerCase());
    for (const [k, v] of this.activeCacheRefs.entries())
      if (now - v.lastTouchedAt > FilesystemPosterMediaPreparer.ACTIVE_REF_TTL_MS)
        this.activeCacheRefs.delete(k);
    for (const [k, v] of this.sourceToDedupPath.entries())
      if (now - v.cachedAt > FilesystemPosterMediaPreparer.SOURCE_DEDUP_TTL_MS)
        this.sourceToDedupPath.delete(k);
    const tryRemoveFile = async (p: string) => {
      try {
        if ((await stat(p)).mtimeMs < cutoff && !isProtected(p)) {
          await unlink(p);
          removed++;
        }
      } catch {}
    };
    try {
      for (const ent of await readdir(this.cacheDir, { withFileTypes: true })) {
        const full = path.join(this.cacheDir, ent.name);
        if (ent.isFile()) await tryRemoveFile(full);
        else if (ent.isDirectory() && ent.name === 'by-hash') {
          for (const sub of await readdir(full, { withFileTypes: true }).catch(() => []))
            if (sub.isFile()) await tryRemoveFile(path.join(full, sub.name));
        } else if (ent.isDirectory()) {
          try {
            if ((await stat(full)).mtimeMs < cutoff) {
              await rm(full, { recursive: true, force: true });
              removed++;
            }
          } catch {}
        }
      }
    } catch {}
    return removed;
  }
  private hasValidMediaHeader(head: Buffer, mediaKind: PosterMediaKind): boolean {
    if (head.byteLength < 12) return false;
    const isRiff = bytesMatch(head, 0, [0x52, 0x49, 0x46, 0x46]);
    return mediaKind === 'image'
      ? (
          [
            [0x89, 0x50, 0x4e, 0x47],
            [0xff, 0xd8, 0xff],
            [0x47, 0x49, 0x46, 0x38],
            [0x42, 0x4d],
          ] as const
        ).some((sig) => bytesMatch(head, 0, sig)) ||
          (isRiff && bytesMatch(head, 8, [0x57, 0x45, 0x42, 0x50]))
      : bytesMatch(head, 4, [0x66, 0x74, 0x79, 0x70]) ||
          bytesMatch(head, 0, [0x1a, 0x45, 0xdf, 0xa3]) ||
          (isRiff && bytesMatch(head, 8, [0x41, 0x56, 0x49, 0x20]));
  }
  async readMediaRange(
    localFilePath: string,
    mediaKind: PosterMediaKind,
    rangeHeader?: string | undefined,
  ): Promise<PosterMediaStreamChunk | null> {
    try {
      const linkSt = await lstat(localFilePath);
      if (linkSt.isSymbolicLink() || !linkSt.isFile() || linkSt.size < 12) return null;
      const total = linkSt.size;
      const probeHandle = await open(localFilePath, 'r');
      try {
        const probe = Buffer.alloc(16);
        const { bytesRead } = await probeHandle.read(probe, 0, 16, 0);
        if (!this.hasValidMediaHeader(probe.subarray(0, bytesRead), mediaKind)) return null;
      } finally {
        await probeHandle.close();
      }
      const ext = path.extname(localFilePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
      };
      const contentType = mimeMap[ext] ?? (mediaKind === 'image' ? 'image/jpeg' : 'video/mp4');
      const maxChunkBytes = 4 * 1024 * 1024;
      let start = 0;
      let len =
        mediaKind === 'image' || total <= 32 * 1024 * 1024 ? total : Math.min(total, maxChunkBytes);
      let isExplicitRange = false;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
        if (!match || (!match[1] && !match[2])) return range416(total);
        start = match[1] ? Number.parseInt(match[1], 10) : 0;
        let end = match[2]
          ? Number.parseInt(match[2], 10)
          : Math.min(total - 1, start + maxChunkBytes - 1);
        if (!match[1] && match[2]) {
          start = Math.max(0, total - Number.parseInt(match[2], 10));
          end = total - 1;
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start >= total ||
          end < start
        )
          return range416(total);
        end = Math.min(end, total - 1, start + maxChunkBytes - 1);
        len = end - start + 1;
        isExplicitRange = true;
      }
      const handle = await open(localFilePath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, start);
        const partial = isExplicitRange || bytesRead < total;
        return {
          status: partial ? 206 : 200,
          headers: {
            'Content-Type': contentType,
            ...(partial
              ? { 'Content-Range': `bytes ${start}-${start + bytesRead - 1}/${total}` }
              : {}),
            'Content-Length': bytesRead,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
          },
          bytes: buf.subarray(0, bytesRead),
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
}
