import { z } from 'zod';
import { Id, NonNegInt, Sha256Hex, StrNull, boolT, strictObj } from './contracts.js';
export const EXTENSION_VERSION = '0.3.92';
const httpOrHttpsUrl = z.string().refine((value) => {
  try {
    const p = new URL(value).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}, 'URL 必须使用 HTTP 或 HTTPS 协议');
export const UpdateConfig = strictObj({
  githubRepo: z
    .string()
    .trim()
    .regex(/^(?:(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+)?$/),
  autoCheck: boolT,
});
export type UpdateConfiguration = z.infer<typeof UpdateConfig>;
export const ReleaseManifest = strictObj({
  softwareVersion: z.string(),
  extensionVersion: StrNull,
  zipAssetName: z.literal('workbench-hot-update.zip'),
  sha256: Sha256Hex,
  notes: z.string(),
  publishedAt: StrNull,
  engineFingerprint: Sha256Hex,
  files: z.record(z.string(), Sha256Hex),
});
export type Manifest = z.infer<typeof ReleaseManifest>;
export const AvailableUpdate = z.object({
  softwareVersion: z.string(),
  extensionVersion: StrNull,
  publishedAt: StrNull,
  notes: z.string(),
  downloadUrl: z.union([z.literal(''), httpOrHttpsUrl]),
  sha256: StrNull,
  requiresInstaller: z.boolean(),
  releaseUrl: httpOrHttpsUrl,
});
export type UpdateRelease = z.infer<typeof AvailableUpdate>;
export const SoftwareUpdateStatus = z.object({
  currentSoftwareVersion: z.string(),
  currentExtensionVersion: z.string(),
  extensionDirectory: z.string(),
  aiWorkspaceDirectory: z.string().optional(),
  githubRepo: z.string(),
  autoCheck: z.boolean(),
  checking: z.boolean(),
  applying: z.boolean(),
  lastCheckedAt: StrNull,
  availableUpdate: AvailableUpdate.nullable(),
  error: StrNull,
});
export type UpdateStatus = z.infer<typeof SoftwareUpdateStatus>;
export const OpenAiWorkspaceResult = strictObj({ opened: z.boolean(), directory: z.string() });
export const ExtensionReloadRequest = strictObj({
  profileIds: z.array(Id).min(1).max(500).optional(),
});
export const ExtensionReloadResult = strictObj({
  reloaded: NonNegInt,
  skippedBusy: NonNegInt,
  skippedOffline: NonNegInt,
  extensionDir: z.string(),
  bundledVersion: z.string(),
});
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
