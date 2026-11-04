import { execFile } from 'node:child_process';
import { access, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaRuntimeComponent } from './media-runtime-component.js';

export const MAX_POSTER_THUMBNAIL_DIM = 120;
export const MAX_POSTER_THUMBNAIL_DATA_URL_BYTES = 24 * 1024;

export async function encodeImageBufferToPosterThumbnail(
  bytes: Buffer | Uint8Array,
): Promise<string | null> {
  if (!bytes || bytes.byteLength < 16 || bytes.byteLength > 64 * 1024 * 1024) return null;
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      return null;
    }
    const scale = Math.min(1, MAX_POSTER_THUMBNAIL_DIM / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, targetW, targetH);

    for (const quality of [78, 65, 50]) {
      try {
        const encoded = canvas.toBuffer('image/webp', quality);
        const dataUrl = `data:image/webp;base64,${Buffer.from(encoded).toString('base64')}`;
        if (dataUrl.length <= MAX_POSTER_THUMBNAIL_DATA_URL_BYTES) {
          return dataUrl;
        }
      } catch {
        // Try lower quality
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function generatePosterImageThumbnail(filePath: string): Promise<string | null> {
  try {
    const bytes = await readFile(filePath);
    return await encodeImageBufferToPosterThumbnail(bytes);
  } catch {
    return null;
  }
}

export async function generatePosterVideoThumbnail(
  filePath: string,
  mediaComponent?: MediaRuntimeComponent | undefined,
): Promise<string | null> {
  if (!mediaComponent) return null;
  try {
    const status = await mediaComponent.status();
    if (!status.installed) return null;
    const binDir = await mediaComponent.directory();
    const ffmpegBin = path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    await access(ffmpegBin);
    const tmpFrame = path.join(os.tmpdir(), `wb-poster-thumb-${randomUUID()}.png`);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpegBin,
          ['-y', '-ss', '0.1', '-i', filePath, '-frames:v', '1', '-f', 'image2', tmpFrame],
          { timeout: 10_000, windowsHide: true },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return await generatePosterImageThumbnail(tmpFrame);
    } finally {
      await rm(tmpFrame, { force: true }).catch(() => {});
    }
  } catch {
    return null;
  }
}

export function decodePosterThumbnailDataUrl(
  dataUrl: string | null | undefined,
): { bytes: Buffer; contentType: string } | null {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim(),
  );
  if (!match?.[1] || !match[2]) return null;
  try {
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.byteLength < 8 || bytes.byteLength > 48 * 1024) return null;
    return { bytes, contentType: match[1].toLowerCase() };
  } catch {
    return null;
  }
}

export function isPathInsidePosterCacheDir(cacheDir: string, targetPath: string): boolean {
  if (!cacheDir || !targetPath) return false;
  const resolvedBase = path.resolve(cacheDir);
  const resolvedTarget = path.resolve(targetPath);
  const normBase = process.platform === 'win32' ? resolvedBase.toLowerCase() : resolvedBase;
  const normTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
  const rel = path.relative(normBase, normTarget);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function removePosterCachedFileIfSafe(
  cacheDir: string,
  targetPath: string,
): Promise<boolean> {
  if (!isPathInsidePosterCacheDir(cacheDir, targetPath)) {
    return false;
  }
  try {
    const st = await stat(targetPath);
    if (!st.isFile()) return false;
    await unlink(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return true;
    }
    return false;
  }
}
