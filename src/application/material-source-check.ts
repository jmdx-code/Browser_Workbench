import type { Awaitable } from '../domain/persistence.js';
import type { PostIntent } from '../shared/material-index.js';
import type { Binding } from '../shared/task-execution.js';
import { DispatchBinding, sameExecution } from '../shared/task-execution.js';
import { MaterialPostIntent } from '../shared/material-index.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import type { MaterialIndexRepository } from '../domain/material-index.js';
import type { MaterialPostRepository } from '../domain/material-post.js';
import type { MaterialFileSnapshot, MaterialPackageSnapshot } from '../shared/materials.js';
import { validatePostAction } from '../domain/material-post.js';

export interface SourceObservation {
  fingerprint: string;
  checkedAt: string;
  files: MaterialFileSnapshot[];
}
export interface MaterialSourceVerifier {
  // assertCurrent is checked around asynchronous IO, not a reusable input permit.
  verify(intent: PostIntent, assertCurrent: () => Awaitable<void>): Promise<SourceObservation>;
}
export interface MaterialSnapshotVerifier {
  verifySnapshot(
    input: { directory: string; snapshot: MaterialPackageSnapshot },
    assertCurrent: () => Awaitable<void>,
  ): Promise<SourceObservation>;
}
export class MaterialPostSourceCheck {
  constructor(
    private readonly index: MaterialIndexRepository,
    private readonly posts: MaterialPostRepository,
    private readonly tabs: TaskTabRepository,
    private readonly verifier: MaterialSourceVerifier,
  ) {}
  async check(input: Binding, assertActorCurrent: () => Awaitable<void>) {
    const { binding, intent, assertCurrent } = await this.current(input, assertActorCurrent);
    let checkedAt = performance.now();
    const observation = await this.verifier.verify(intent, async () => {
      if (performance.now() - checkedAt >= 250) {
        await assertCurrent();
        checkedAt = performance.now();
      }
    });
    await assertCurrent();
    if (observation.fingerprint !== intent.fingerprint)
      throw Error('MATERIAL_SOURCE_FINGERPRINT_MISMATCH');
    return { attemptId: intent.attemptId, binding, observation };
  }
  async current(input: Binding, assertActorCurrent: () => Awaitable<void>) {
    const binding = DispatchBinding.parse(input);
    const link = await this.posts.link(binding.operationId);
    const intent = MaterialPostIntent.parse((await this.index.reservation(link.attemptId)).intent);
    if (
      binding.jobId !== intent.jobId ||
      binding.stepId !== intent.stepId ||
      !sameExecution(binding, intent.context)
    )
      throw Error('MATERIAL_SOURCE_BINDING_MISMATCH');
    const assertCurrent = async () => {
      await assertActorCurrent();
      if ((await this.index.reservation(intent.attemptId)).state !== 'RESERVED')
        throw Error('MATERIAL_SOURCE_RESERVATION_NOT_READY');
      await this.tabs.assertForInput(binding, intent.proof);
    };
    await assertCurrent();
    return { binding, intent, link, assertCurrent };
  }
  async currentUpload(input: Binding, assertActorCurrent: () => Awaitable<void>) {
    const current = await this.current(input, assertActorCurrent);
    if (current.link.purpose !== 'UPLOAD_MEDIA') throw Error('UPLOAD_OPERATION_PURPOSE_REQUIRED');
    validatePostAction(current.intent, current.link.purpose, current.link.action);
    return current;
  }
}
