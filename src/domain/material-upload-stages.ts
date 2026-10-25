import type { Awaitable } from './persistence.js';
import type { PostIntent } from '../shared/material-index.js';
import type { Binding } from '../shared/task-execution.js';
import type { UploadManifest } from '../shared/material-upload.js';
import type { StageClaim, StageRecord } from '../shared/material-upload-stages.js';

export interface MaterialUploadStageRepository {
  reserve(
    intent: PostIntent,
    binding: Binding,
    cacheRoot: string,
    capacityBytes: number,
  ): Awaitable<StageClaim>;
  assertWriting(claim: StageClaim): Awaitable<void>;
  complete(claim: StageClaim, manifest: UploadManifest, capacityBytes?: number): Awaitable<void>;
  assertReady(manifest: UploadManifest): Awaitable<void>;
  review(claim: StageClaim, reason: string): Awaitable<void>;
  get(stageId: string): Awaitable<StageRecord>;
  list(): Awaitable<StageRecord[]>;
  recoverOnStartup(): Awaitable<number>;
}
