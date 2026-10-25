import { z } from 'zod';

export const MaterialFormat = z.enum(['text', 'single-image', 'multi-image', 'video']);
export const MaterialPreflightRequest = z
  .object({ directory: z.string().trim().min(1).max(2048) })
  .strict();
export const MaterialIssue = z
  .object({ source: z.string().max(2048), code: z.string().max(80), message: z.string().max(300) })
  .strict();
export const MaterialPreflightReport = z
  .object({
    directory: z.string().max(2048),
    scannedAt: z.string().datetime(),
    complete: z.boolean(),
    readonly: z.literal(true),
    publishingReady: z.literal(false),
    fingerprintVersion: z.literal(1),
    packages: z
      .array(
        z
          .object({
            source: z.string().max(2048),
            format: MaterialFormat,
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z.number().int().nonnegative(),
            mediaCount: z.number().int().min(0).max(20),
            duplicateOf: z.string().max(2048).nullable(),
          })
          .strict(),
      )
      .max(500),
    issues: z.array(MaterialIssue).max(200),
    excluded: z.number().int().nonnegative(),
    uniqueContents: z.number().int().nonnegative(),
  })
  .strict();
export type PreflightReport = z.infer<typeof MaterialPreflightReport>;
export const MATERIAL_PREVIEW_HEADER = 'x-workbench-material-preview';
export const MaterialPreviewScan = z
  .object({
    report: MaterialPreflightReport,
    scanId: z.string().uuid(),
  })
  .strict();
export const MaterialPreviewRequest = z
  .object({
    scanId: z.string().uuid(),
    source: z.string().min(1).max(2048),
  })
  .strict();
export const MaterialPackagePreview = z
  .object({
    scanId: z.string().uuid(),
    directory: z.string().max(2048),
    scannedAt: z.string().datetime(),
    source: z.string().min(1).max(2048),
    format: MaterialFormat,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(256 * 1024),
    files: z
      .array(
        z
          .object({
            relativePath: z.string().min(1).max(2048),
            role: z.enum(['text', 'image', 'video']),
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(21),
    readonly: z.literal(true),
    publishingReady: z.literal(false),
    currentness: z.literal('scan-snapshot'),
  })
  .strict();
export type PreviewScan = z.infer<typeof MaterialPreviewScan>;
export type PackagePreview = z.infer<typeof MaterialPackagePreview>;
export const MaterialReviewRequest = MaterialPreviewRequest.extend({
  profileIds: z
    .array(z.uuid())
    .min(1)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, '浏览器资料不能重复'),
}).strict();
export const MaterialPublishingReview = MaterialPackagePreview.extend({
  sourceVerifiedAt: z.string().datetime(),
  reviewedAt: z.string().datetime(),
  blockers: z.array(z.enum(['PUBLISHER_UNAVAILABLE', 'TEXT_INPUT_LIMIT'])).max(2),
  targets: z
    .array(
      z
        .object({
          profileId: z.uuid(),
          alias: z.string().max(2048),
          online: z.boolean(),
          accountVerified: z.literal(false),
          blockers: z
            .array(z.enum(['PROFILE_OFFLINE', 'PROFILE_NOT_READY', 'IDENTITY_UNVERIFIED']))
            .min(1)
            .max(3),
        })
        .strict(),
    )
    .min(1)
    .max(1000),
}).strict();
export type PublishingReview = z.infer<typeof MaterialPublishingReview>;
export const MaterialMediaPreviewRequest = MaterialPreviewRequest.extend({
  fileIndex: z.number().int().min(0).max(20),
}).strict();
export const materialMediaPreviewLimits = {
  image: 20 * 1024 ** 2,
  video: 128 * 1024 ** 2,
} as const;
export type MaterialMediaType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/quicktime';
export type MaterialProblem = z.infer<typeof MaterialIssue>;
export interface MaterialFileSnapshot {
  relativePath: string;
  role: 'text' | 'image' | 'video';
  digest: string;
  bytes: number;
  proof: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
}
export interface MaterialPackageSnapshot {
  source: string;
  format: z.infer<typeof MaterialFormat>;
  text: string;
  fingerprint: string;
  files: MaterialFileSnapshot[];
}
export interface MaterialScan {
  directory: string;
  complete: boolean;
  packages: MaterialPackageSnapshot[];
  issues: MaterialProblem[];
  excluded: number;
}
