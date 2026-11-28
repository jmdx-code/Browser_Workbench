import { z } from 'zod';
import { UploadMediaAction, canonicalAction } from './browser-actions.js';
import { Id, Sha256Hex, addIssue, sReq, strictObj } from './contracts.js';
import { DispatchBinding, sameBinding } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';
import { MaterialFile } from './resource-materials.js';
import { StoryVideoDerivation } from './story-video-derivation.js';
export const UploadStageManifest = strictObj({
  version: z.union([z.literal(1), z.literal(2)]),
  stageId: Id,
  sourcePaths: z.array(sReq(4096)).min(1).max(20).optional(),
  attemptId: Id,
  binding: DispatchBinding,
  intentDigest: Sha256Hex,
  fingerprint: Sha256Hex,
  createdAt: z.string().datetime(),
  files: z
    .array(
      strictObj({
        original: MaterialFile,
        name: sReq(255).refine((n) => !/[\\/\0]/.test(n)),
        proof: MaterialFile.shape.proof,
        derivation: StoryVideoDerivation.optional(),
      }),
    )
    .max(20),
}).superRefine((m, ctx) => {
  if (m.sourcePaths && (m.version !== 1 || m.sourcePaths.length !== m.files.length))
    addIssue(ctx, 'UPLOAD_SOURCE_PATHS_MISMATCH');
  const derived = m.files.filter((f) => f.derivation !== undefined);
  if (m.version === 1 ? derived.length !== 0 : m.files.length !== 1 || derived.length !== 1)
    addIssue(ctx, 'UPLOAD_DERIVATION_VERSION_MISMATCH');
  for (const file of derived)
    if (file.original.role !== 'video' || file.derivation?.sourceSha256 !== file.original.digest)
      addIssue(ctx, 'UPLOAD_DERIVATION_SOURCE_MISMATCH');
});
// Private authenticated RPC only. Paths are software-derived verified cache files, never UI input.
const absoluteFile = sReq(4096).refine((file) => {
  const normal = file.replaceAll('\\', '/');
  return (
    !file.includes('\0') &&
    !normal.startsWith('//') &&
    (/^[A-Za-z]:\//.test(normal) || normal.startsWith('/')) &&
    !normal.split('/').some((part, i) => part === '.' || part === '..' || (part === '' && i !== 0))
  );
}, 'KERNEL_FILE_PATH_INVALID');
export const KernelOperationFileGrant = strictObj({
  binding: DispatchBinding,
  action: UploadMediaAction,
  proof: OwnedTabProof,
  manifest: UploadStageManifest,
  files: z.array(absoluteFile).min(1).max(20),
}).superRefine((grant, ctx) => {
  const { binding, action, manifest, proof } = grant;
  if (
    !sameBinding(binding, manifest.binding) ||
    binding.profileId !== proof.profileId ||
    action.tabId !== proof.tabId ||
    action.attemptId !== manifest.attemptId ||
    action.fingerprint !== manifest.fingerprint ||
    grant.files.length !== manifest.files.length
  )
    addIssue(ctx, 'KERNEL_FILE_GRANT_BINDING_MISMATCH');
  if (manifest.sourcePaths) {
    if (
      JSON.stringify(manifest.sourcePaths) !== JSON.stringify(grant.files) ||
      manifest.files.some(
        (f, i) =>
          f.original.role === 'text' ||
          f.name !== grant.files[i]?.replaceAll('\\', '/').split('/').at(-1),
      )
    )
      addIssue(ctx, 'KERNEL_FILE_GRANT_PATH_MISMATCH');
    return;
  }
  let directory = '';
  for (const [index, file] of grant.files.entries()) {
    const parts = file.replaceAll('\\', '/').split('/'),
      name = parts.pop(),
      stage = parts.pop(),
      parent = parts.join('/');
    if (
      manifest.files[index]?.original.role === 'text' ||
      name !== manifest.files[index]?.name ||
      stage !== manifest.stageId ||
      (index > 0 && parent !== directory)
    )
      addIssue(ctx, 'KERNEL_FILE_GRANT_PATH_MISMATCH');
    directory = parent;
  }
});
export type OperationFileGrant = z.infer<typeof KernelOperationFileGrant>;
export async function assertFileGrantActionDigest(grant: OperationFileGrant) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalAction(grant.action)),
  );
  const actual = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  if (actual !== grant.binding.actionDigest) throw Error('KERNEL_FILE_GRANT_ACTION_MISMATCH');
}
