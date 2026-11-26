import { z } from 'zod';
export const MaterialFormat = z.enum(['text', 'single-image', 'multi-image', 'video']);
export const materialMediaPreviewLimits = {
  image: 20 * 1024 ** 2,
  video: 128 * 1024 ** 2,
} as const;
export type MaterialMediaType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/quicktime';
export interface MaterialFileSnapshot {
  relativePath: string;
  role: 'text' | 'image' | 'video';
  digest: string;
  bytes: number;
  proof: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
}
