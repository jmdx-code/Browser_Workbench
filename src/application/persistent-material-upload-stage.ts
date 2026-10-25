import type { Awaitable } from '../domain/persistence.js';
import type { MaterialUploadStageRepository } from '../domain/material-upload-stages.js';
import type { PostIntent } from '../shared/material-index.js';
import type { Binding } from '../shared/task-execution.js';
import type { UploadManifest } from '../shared/material-upload.js';
import type { MaterialStagedFilesPort } from './material-file-grant-preparation.js';
import type { NativeInputGuard } from './native-input-gate.js';

export interface ReservedMaterialUploadWriter extends MaterialStagedFilesPort {
  readonly cacheRoot: string;
  stageReserved(
    intent: PostIntent,
    binding: Binding,
    stageId: string,
    assertCurrent: () => Awaitable<void>,
  ): Promise<UploadManifest>;
}
// Reserve before any file creation. Recovery never grants permission or restages an operation.
export class PersistentMaterialUploadStage {
  constructor(
    private readonly ledger: MaterialUploadStageRepository,
    private readonly writer: ReservedMaterialUploadWriter,
    private readonly capacityBytes = 10 * 1024 ** 3,
  ) {}
  async stage(intent: PostIntent, binding: Binding, assertCurrent: () => Awaitable<void>) {
    await assertCurrent();
    const claim = await this.ledger.reserve(
      intent,
      binding,
      this.writer.cacheRoot,
      this.capacityBytes,
    );
    const current = async () => {
      await assertCurrent();
      await this.ledger.assertWriting(claim);
    };
    try {
      const manifest = await this.writer.stageReserved(
        intent,
        binding,
        claim.owner.stageId,
        current,
      );
      await current();
      await this.ledger.complete(claim, manifest, this.capacityBytes);
      await assertCurrent();
      await this.ledger.assertReady(manifest);
      return manifest;
    } catch (error) {
      await this.ledger.review(
        claim,
        error instanceof Error ? error.message : 'UPLOAD_STAGE_PREPARATION_FAILED',
      );
      throw error;
    }
  }
  async verify(
    intent: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ) {
    const current = async () => {
      await assertCurrent();
      await this.ledger.assertReady(manifest);
      if ((await this.ledger.get(manifest.stageId)).owner.cacheRoot !== this.writer.cacheRoot)
        throw Error('UPLOAD_STAGE_CACHE_ROOT_MISMATCH');
    };
    await current();
    const files = await this.writer.verify(intent, binding, manifest, current);
    await current();
    return files;
  }
  guard(
    intent: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ): NativeInputGuard {
    return async (command) => {
      await assertCurrent();
      await this.ledger.assertReady(manifest);
      if ((await this.ledger.get(manifest.stageId)).owner.cacheRoot !== this.writer.cacheRoot)
        throw Error('UPLOAD_STAGE_CACHE_ROOT_MISMATCH');
      if (command.target.tabId !== intent.proof.tabId) throw Error('UPLOAD_STAGE_TARGET_MISMATCH');
      if (command.method === 'DOM.setFileInputFiles') {
        const files = await this.verify(intent, binding, manifest, assertCurrent);
        if (!files.length || JSON.stringify(command.params.files) !== JSON.stringify(files))
          throw Error('UPLOAD_STAGE_FILES_MISMATCH');
      }
      await assertCurrent();
      await this.ledger.assertReady(manifest);
    };
  }
}
