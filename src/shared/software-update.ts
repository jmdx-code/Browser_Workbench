import { z } from 'zod';
const httpOrHttpsUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}, 'URL 必须使用 HTTP 或 HTTPS 协议');
export const UpdateConfig = z
  .object({
    githubRepo: z
      .string()
      .trim()
      .regex(/^(?:(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+)?$/),
    autoCheck: z.boolean().default(true),
  })
  .strict();
export type UpdateConfiguration = z.infer<typeof UpdateConfig>;
export const ReleaseManifest = z
  .object({
    softwareVersion: z.string(),
    extensionVersion: z.string().nullable(),
    zipAssetName: z.literal('workbench-hot-update.zip'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    notes: z.string(),
    publishedAt: z.string().nullable(),
    engineFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
export type Manifest = z.infer<typeof ReleaseManifest>;
export const AvailableUpdate = z.object({
  softwareVersion: z.string(),
  extensionVersion: z.string().nullable(),
  publishedAt: z.string().nullable(),
  notes: z.string(),
  downloadUrl: z.union([z.literal(''), httpOrHttpsUrl]),
  sha256: z.string().nullable(),
  requiresInstaller: z.boolean(),
  releaseUrl: httpOrHttpsUrl,
});
export type UpdateRelease = z.infer<typeof AvailableUpdate>;
export const SoftwareUpdateStatus = z.object({
  currentSoftwareVersion: z.string(),
  currentExtensionVersion: z.string(),
  extensionDirectory: z.string(),
  githubRepo: z.string(),
  autoCheck: z.boolean(),
  checking: z.boolean(),
  applying: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  availableUpdate: AvailableUpdate.nullable(),
  error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof SoftwareUpdateStatus>;
export const ExtensionReloadRequest = z
  .object({ profileIds: z.array(z.uuid()).min(1).max(500).optional() })
  .strict();
export const ExtensionReloadResult = z
  .object({
    reloaded: z.number().int().nonnegative(),
    skippedBusy: z.number().int().nonnegative(),
    skippedOffline: z.number().int().nonnegative(),
    extensionDir: z.string(),
    bundledVersion: z.string(),
  })
  .strict();
export type ReloadResult = z.infer<typeof ExtensionReloadResult>;
export function semverCompare(a: string, b: string) {
  const parse = (s: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
    if (!m) throw Error('版本号格式无效');
    return { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') };
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i],
      q = y.pre[i];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
