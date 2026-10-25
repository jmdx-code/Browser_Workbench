import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import type { FacebookSubmissionObservationRepository } from '../domain/facebook-submission-observations.js';
import type {
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from '../domain/facebook-post-execution.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { readFacebookPostEffects } from './facebook-post-effect-reader.js';
import type { FacebookSubmissionNetworkObserver } from './facebook-submission-network.js';
import { readFacebookSubmissionAudience } from './facebook-submission-audience.js';

// Called inside the original execute callback before locator.click, never after transport ACK.
// Native input guards only inspect the immutable saved baseline; they cannot refresh it.
export interface FacebookSubmissionInputObserver {
  prepare(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
    observeCurrent?: () => void,
    enableBuffers?: () => Promise<void>,
  ): Promise<void>;
  assert(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ): Promise<void>;
  stop?(): Awaitable<void>;
}
export class FacebookSubmissionObserver implements FacebookSubmissionInputObserver {
  constructor(
    private readonly observations: FacebookSubmissionObservationRepository,
    private readonly read = readFacebookPostEffects,
    private readonly network?: FacebookSubmissionNetworkObserver,
    private readonly readAudience = readFacebookSubmissionAudience,
  ) {}
  private async assertAudience(
    page: Page,
    document: { url: string; timeOrigin: number },
    guard: () => Awaitable<void>,
    original: FacebookPostOriginal,
  ) {
    const required = await this.network?.requiredAudience(original);
    if (!required) return;
    const reading = await this.readAudience(page, guard);
    await guard();
    if (
      reading.ready === 'loading' ||
      reading.url !== document.url ||
      reading.timeOrigin !== document.timeOrigin ||
      reading.audience !== required
    )
      throw Error('SUBMISSION_AUDIENCE_UNCONFIRMED_BEFORE_INPUT');
  }
  async prepare(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
    observeCurrent?: () => void,
    enableBuffers?: () => Promise<void>,
  ) {
    await guard();
    if (
      original.link.purpose !== 'SUBMIT' ||
      operation.status !== 'DISPATCHING' ||
      operation.id !== original.link.operationId
    )
      throw Error('ORIGINAL_SUBMIT_REQUIRED');
    if (await this.observations.get(operation.id))
      throw Error('SUBMISSION_ALREADY_PREPARED_NO_REPLAY');
    const effects = await this.read(page, guard);
    await guard();
    if (
      !effects.composer ||
      effects.ready === 'loading' ||
      effects.composer.text !== original.intent.snapshot.text ||
      !effects.composer.submitEnabled ||
      effects.composer.busy
    )
      throw Error('SUBMISSION_COMPOSER_NOT_READY');
    await this.assertAudience(page, effects, guard, original);
    await guard();
    await this.observations.capture({
      operationId: operation.id,
      binding: operation.binding,
      proof: original.intent.proof,
      attemptId: original.intent.attemptId,
      accountId: original.intent.context.accountId,
      fingerprint: original.intent.fingerprint,
      postIds: [...new Set(effects.posts.flatMap((post) => (post.postId ? [post.postId] : [])))],
      checkedAt: Date.now(),
      url: effects.url,
      timeOrigin: effects.timeOrigin,
    });
    await guard();
    if (this.network) {
      if (!enableBuffers) throw Error('NATIVE_BOUNDED_NETWORK_REQUIRED');
      await this.network.start(page, operation, original, observeCurrent ?? guard, enableBuffers);
    }
  }
  stop() {
    this.network?.stop();
  }
  async assert(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const baseline = await this.observations.get(operation.id);
    if (
      !baseline ||
      !sameBinding(baseline.binding, operation.binding) ||
      baseline.attemptId !== original.intent.attemptId ||
      baseline.fingerprint !== original.intent.fingerprint ||
      !sameTabProof(baseline.proof, original.intent.proof)
    )
      throw Error('ORIGINAL_SUBMISSION_BASELINE_REQUIRED');
    const effects = await this.read(page, guard);
    await guard();
    if (
      effects.url !== baseline.url ||
      effects.timeOrigin !== baseline.timeOrigin ||
      !effects.composer ||
      effects.composer.text !== original.intent.snapshot.text ||
      !effects.composer.submitEnabled ||
      effects.composer.busy
    )
      throw Error('SUBMISSION_DOCUMENT_OR_CONTENT_CHANGED');
    await this.assertAudience(page, effects, guard, original);
    await guard();
  }
}
