import type { Awaitable } from '../domain/persistence.js';
import type { PostIntent } from '../shared/material-index.js';
import { UploadStageManifest, type UploadManifest } from '../shared/material-upload.js';
import { DispatchBinding, sameBinding, type Binding } from '../shared/task-execution.js';
import type { MaterialPostSourceCheck } from './material-source-check.js';
import type { NativeInputGuard } from './native-input-gate.js';

export interface MaterialUploadGuardPort {
  guard(
    intent: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ): NativeInputGuard;
}
// Internal business-purpose boundary around the generic filesystem resource guard.
export class MaterialUploadOperationGuard {
  constructor(
    private readonly source: MaterialPostSourceCheck,
    private readonly cache: MaterialUploadGuardPort,
  ) {}
  async forOperation(
    input: Binding,
    value: UploadManifest,
    assertActorCurrent: () => Awaitable<void>,
  ): Promise<NativeInputGuard> {
    const binding = DispatchBinding.parse(input),
      manifest = UploadStageManifest.parse(value);
    if (!sameBinding(binding, manifest.binding)) throw Error('UPLOAD_GUARD_BINDING_MISMATCH');
    const original = await this.source.currentUpload(binding, assertActorCurrent);
    if (
      manifest.attemptId !== original.intent.attemptId ||
      manifest.fingerprint !== original.intent.fingerprint
    )
      throw Error('UPLOAD_GUARD_INTENT_MISMATCH');
    const assertCurrent = async () => {
      await (await this.source.currentUpload(binding, assertActorCurrent)).assertCurrent();
    };
    const inspect = this.cache.guard(original.intent, binding, manifest, assertCurrent);
    return async (command) => {
      await assertCurrent();
      await inspect(command);
      await assertCurrent();
    };
  }
}
