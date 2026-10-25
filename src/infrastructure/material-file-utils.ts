import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { PostIntent } from '../shared/material-index.js';
export const stagedMaterialName = (file: PostIntent['snapshot']['files'][number], index: number) =>
  String(index).padStart(2, '0') +
  '-' +
  file.digest +
  path.extname(file.relativePath).toLowerCase();
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const videoExtensions = new Set(['.mp4', '.mov']);
export const temporaryMaterialFile = (name: string) =>
  name.startsWith('.') || name.startsWith('~') || /\.(?:tmp|part|crdownload)$/i.test(name);
export const proofOf = (stat: BigIntStats) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
});
export const sameStat = (a: BigIntStats, b: BigIntStats) =>
  JSON.stringify(proofOf(a)) === JSON.stringify(proofOf(b));
export const contained = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
};
export const roleOf = (file: string) => {
  const extension = path.extname(file).toLowerCase();
  return imageExtensions.has(extension)
    ? 'image'
    : videoExtensions.has(extension)
      ? 'video'
      : extension === '.txt'
        ? 'text'
        : null;
};
export function headerMatches(file: string, head: Buffer): boolean {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png')
    return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.jpg' || ext === '.jpeg')
    return head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (ext === '.webp')
    return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  if (videoExtensions.has(ext)) return head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp';
  return true;
}
