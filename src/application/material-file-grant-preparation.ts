import type { Awaitable } from '../domain/persistence.js';
import type { PostIntent } from '../shared/material-index.js';
import type { UploadManifest } from '../shared/material-upload.js';
import type { Binding } from '../shared/task-execution.js';
import { KernelOperationFileGrant } from '../shared/kernel-file-grant.js';
import type { MaterialPostSourceCheck } from './material-source-check.js';

export interface MaterialStagedFilesPort {
  verify(
    intent: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ): Promise<string[]>;
}
// Revalidates the original stage now. This value does not itself grant the browser permission.
export class MaterialFileGrantPreparation {
  constructor(
    private readonly source: MaterialPostSourceCheck,
    private readonly cache: MaterialStagedFilesPort,
  ) {}
  async prepare(
    binding: Binding,
    manifest: UploadManifest,
    assertActorCurrent: () => Awaitable<void>,
  ) {
    const current = await this.source.currentUpload(binding, assertActorCurrent);
    const files = await this.cache.verify(
      current.intent,
      current.binding,
      manifest,
      current.assertCurrent,
    );
    await current.assertCurrent();
    return KernelOperationFileGrant.parse({
      binding: current.binding,
      action: current.link.action,
      proof: current.intent.proof,
      manifest,
      files,
    });
  }
}
