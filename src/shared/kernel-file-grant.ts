import { z } from 'zod';
import { UploadMediaAction, canonicalAction } from './browser-actions.js';
import { DispatchBinding, sameBinding } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';
import { UploadStageManifest } from './material-upload.js';

// Private authenticated RPC only. Paths are software-derived verified cache files, never UI input.
const absoluteFile = z
  .string()
  .min(1)
  .max(4096)
  .refine((file) => {
    const normal = file.replaceAll('\\', '/');
    return (
      !file.includes('\0') &&
      !normal.startsWith('//') &&
      (/^[A-Za-z]:\//.test(normal) || normal.startsWith('/')) &&
      !normal
        .split('/')
        .some((part, index) => part === '.' || part === '..' || (part === '' && index !== 0))
    );
  }, 'KERNEL_FILE_PATH_INVALID');
export const KernelOperationFileGrant = z
  .object({
    binding: DispatchBinding,
    action: UploadMediaAction,
    proof: OwnedTabProof,
    manifest: UploadStageManifest,
    files: z.array(absoluteFile).min(1).max(20),
  })
  .strict()
  .superRefine((grant, ctx) => {
    const { binding, action, manifest, proof } = grant;
    if (
      !sameBinding(binding, manifest.binding) ||
      binding.profileId !== proof.profileId ||
      action.tabId !== proof.tabId ||
      action.attemptId !== manifest.attemptId ||
      action.fingerprint !== manifest.fingerprint ||
      grant.files.length !== manifest.files.length
    )
      ctx.addIssue({ code: 'custom', message: 'KERNEL_FILE_GRANT_BINDING_MISMATCH' });
    if (manifest.sourcePaths) {
      if (
        JSON.stringify(manifest.sourcePaths) !== JSON.stringify(grant.files) ||
        manifest.files.some(
          (file, index) =>
            file.original.role === 'text' ||
            file.name !== grant.files[index]?.replaceAll('\\', '/').split('/').at(-1),
        )
      )
        ctx.addIssue({ code: 'custom', message: 'KERNEL_FILE_GRANT_PATH_MISMATCH' });
      return;
    }
    let directory = '';
    for (const [index, file] of grant.files.entries()) {
      const normal = file.replaceAll('\\', '/'),
        parts = normal.split('/');
      const name = parts.pop(),
        stage = parts.pop(),
        parent = parts.join('/');
      if (
        manifest.files[index]?.original.role === 'text' ||
        name !== manifest.files[index]?.name ||
        stage !== manifest.stageId ||
        (index > 0 && parent !== directory)
      )
        ctx.addIssue({ code: 'custom', message: 'KERNEL_FILE_GRANT_PATH_MISMATCH' });
      directory = parent;
    }
  });
export type OperationFileGrant = z.infer<typeof KernelOperationFileGrant>;
export async function assertFileGrantActionDigest(grant: OperationFileGrant) {
  const bytes = new TextEncoder().encode(canonicalAction(grant.action));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== grant.binding.actionDigest) throw Error('KERNEL_FILE_GRANT_ACTION_MISMATCH');
}
