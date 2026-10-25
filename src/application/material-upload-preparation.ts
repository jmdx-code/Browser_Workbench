import type { Awaitable } from '../domain/persistence.js';
import type { PostIntent } from '../shared/material-index.js';
import type { Binding } from '../shared/task-execution.js';
import type { UploadManifest } from '../shared/material-upload.js';
import { UploadStageManifest } from '../shared/material-upload.js';
import { sameBinding } from '../shared/task-execution.js';
import type { MaterialPostSourceCheck } from './material-source-check.js';

export interface MaterialUploadStagePort {
  stage(
    intent: PostIntent,
    binding: Binding,
    assertCurrent: () => Awaitable<void>,
  ): Promise<UploadManifest>;
}
// Preparation is not a file-input action or a publishing permission.
export class MaterialUploadPreparation {
  constructor(
    private readonly source: MaterialPostSourceCheck,
    private readonly cache: MaterialUploadStagePort,
  ) {}
  async prepare(binding: Binding, assertActorCurrent: () => Awaitable<void>) {
    const current = await this.source.currentUpload(binding, assertActorCurrent);
    const started = performance.now();
    let guardCalls = 0,
      guardMilliseconds = 0;
    const check = async () => {
      const before = performance.now();
      try {
        await current.assertCurrent();
      } finally {
        guardCalls++;
        guardMilliseconds += performance.now() - before;
      }
    };
    const stage = async () => {
      try {
        return await this.cache.stage(current.intent, current.binding, check);
      } finally {
        if (process.env.WORKBENCH_TRACE_TIMING === '1')
          console.warn(
            JSON.stringify({
              event: 'UPLOAD_STAGE_TIMING',
              jobId: binding.jobId,
              operationId: binding.operationId,
              milliseconds: Math.round(performance.now() - started),
              guardCalls,
              guardMilliseconds: Math.round(guardMilliseconds),
            }),
          );
      }
    };
    const manifest = UploadStageManifest.parse(await stage());
    await current.assertCurrent();
    if (
      manifest.attemptId !== current.intent.attemptId ||
      manifest.fingerprint !== current.intent.fingerprint ||
      !sameBinding(manifest.binding, current.binding)
    )
      throw Error('UPLOAD_PREPARATION_MANIFEST_MISMATCH');
    return manifest;
  }
}
