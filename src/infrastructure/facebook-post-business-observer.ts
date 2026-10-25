import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import type { FacebookPostBusinessObserver } from './facebook-managed-post-source.js';
import type {
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from '../domain/facebook-post-execution.js';
import type { FacebookSubmissionObservationRepository } from '../domain/facebook-submission-observations.js';
import type { FacebookSubmissionResultSource } from '../domain/facebook-submission-result.js';
import type { MaterialUploadStageRepository } from '../domain/material-upload-stages.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';
import {
  FacebookPostResultCorrelation,
  FacebookPostEffects,
} from '../shared/facebook-post-observation.js';
import { PostReceipt } from '../shared/material-post.js';
import type { PostExecutionVerdict } from '../shared/post-execution.js';
import { observedMediaUpload, observedNewOwnPost } from '../domain/facebook-post-effects.js';
import { readFacebookPostEffects } from './facebook-post-effect-reader.js';
import type { FacebookVideoUploadObserver } from './facebook-video-upload-observer.js';
import type { PostEffects } from '../shared/facebook-post-observation.js';

// Diagnostic projection only. It cannot decide readiness or publish, and reads only
// the current composer's bounded element attributes; no HTML, body text or media URL.
export function projectComposerUploadStructure() {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !element.closest('[aria-hidden="true"]');
  };
  const roots = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  ).filter(visible);
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    roots: roots.slice(0, 2).map((root) => ({
      formCount: root.querySelectorAll('form').length,
      roleFormCount: root.querySelectorAll('[role="form"]').length,
      roleListCount: root.querySelectorAll('[role="list"]').length,
      inputs: Array.from(root.querySelectorAll('input[type="file"]'))
        .slice(0, 5)
        .map((element) => {
          const input = element as HTMLInputElement;
          return {
            accept: input.accept.slice(0, 300),
            multiple: input.multiple,
            fileCount: input.files?.length ?? 0,
          };
        }),
      images: Array.from(root.querySelectorAll('img'))
        .slice(0, 30)
        .map((element) => ({
          name: element.alt.slice(0, 200),
          visible: visible(element),
          complete: element.complete,
          width: element.naturalWidth,
          height: element.naturalHeight,
          sourceKind: element.currentSrc.startsWith('blob:')
            ? 'blob'
            : element.currentSrc.startsWith('data:')
              ? 'data'
              : element.currentSrc
                ? 'remote'
                : 'empty',
        })),
      buttons: Array.from(root.querySelectorAll('[role="button"]'))
        .filter(visible)
        .slice(0, 40)
        .map((element) => ({
          label: (element.getAttribute('aria-label') ?? '').slice(0, 200),
          disabled:
            element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled'),
        })),
      videoCount: root.querySelectorAll('video').length,
      videos: Array.from(root.querySelectorAll('video'))
        .slice(0, 3)
        .map((video) => ({
          visible: visible(video),
          readyState: video.readyState,
          width: video.videoWidth,
          height: video.videoHeight,
          durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
          errorCode: video.error?.code ?? null,
          sourceKind: video.currentSrc.startsWith('blob:')
            ? 'blob'
            : video.currentSrc
              ? 'remote'
              : 'empty',
        })),
    })),
  };
}

export type PostUploadDiagnostic = {
  jobId: string;
  operationId: string;
  attemptId: string;
  checkedAt: string;
  url: string;
  timeOrigin: number;
  ready: PostEffects['ready'];
  composer: (Omit<NonNullable<PostEffects['composer']>, 'text'> & { textMatches: boolean }) | null;
  expectedFiles: { name: string; size: number }[];
  mediaReady: boolean;
  structure?: ReturnType<typeof projectComposerUploadStructure>;
};

export class DOMFacebookPostBusinessObserver implements FacebookPostBusinessObserver {
  constructor(
    private readonly observations: FacebookSubmissionObservationRepository,
    private readonly stages: MaterialUploadStageRepository,
    private readonly results: FacebookSubmissionResultSource<Page>,
    private readonly id: () => string,
    private readonly read = readFacebookPostEffects,
    private readonly videoUploads?: FacebookVideoUploadObserver,
    private readonly diagnostic?: (value: PostUploadDiagnostic) => void,
  ) {}
  ready() {
    return this.results.ready();
  }
  readyForPurpose(purpose: FacebookPostOriginal['link']['purpose']) {
    return purpose === 'UPLOAD_MEDIA' || (purpose === 'SUBMIT' && this.results.ready());
  }
  async verify(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict> {
    await guard();
    if (
      operation.status !== 'ACKNOWLEDGED' ||
      operation.id !== original.link.operationId ||
      operation.binding.accountId !== original.intent.context.accountId
    )
      throw Error('ORIGINAL_ACKNOWLEDGED_POST_REQUIRED');
    const purpose = original.link.purpose;
    if (!this.readyForPurpose(purpose)) throw Error('POST_BUSINESS_PURPOSE_NOT_READY');
    const receipt = (
      postId: string | null,
      media?: { ready: true; format: 'single-image' | 'multi-image' | 'video'; count: number },
    ): PostExecutionVerdict => ({
      kind: 'verified',
      receipt: PostReceipt.parse({
        binding: operation.binding,
        evidence: {
          kind: 'material-post-verification',
          independent: true,
          attemptId: original.intent.attemptId,
          fingerprint: original.intent.fingerprint,
          purpose,
          proof: original.intent.proof,
          observedAccountId: original.intent.context.accountId,
          observationId: this.id(),
          checkedAt: new Date().toISOString(),
          outcome: postId === null ? 'APPLIED' : 'PUBLISHED',
          basis: postId === null ? 'media-upload-observed' : 'own-post-observed',
          postId,
          ...(media ? { media } : {}),
        },
      }),
    });
    if (purpose === 'UPLOAD_MEDIA') {
      const effects = await this.read(page, guard);
      await guard();
      const stages = (await this.stages.list()).filter(
        (stage) =>
          stage.state === 'READY' &&
          stage.owner.attemptId === original.intent.attemptId &&
          sameBinding(stage.owner.binding, operation.binding),
      );
      const manifest = stages.length === 1 ? stages[0]?.manifest : null;
      if (!manifest) return { kind: 'wait', reason: 'ORIGINAL_UPLOAD_MANIFEST_REQUIRED' };
      await this.stages.assertReady(manifest);
      const transfer = await this.videoUploads?.read(
        page,
        operation.binding,
        original.intent,
        manifest,
        effects,
        guard,
      );
      const media = observedMediaUpload(effects, original.intent, manifest, transfer);
      await guard();
      if (this.diagnostic) {
        let structure: ReturnType<typeof projectComposerUploadStructure> | undefined;
        if (!media) {
          try {
            structure = await page.evaluate(projectComposerUploadStructure);
          } catch {
            // Diagnostic reads are optional; original ownership guards remain mandatory.
          }
          await guard();
          if (
            structure &&
            (structure.url !== effects.url || structure.timeOrigin !== effects.timeOrigin)
          )
            structure = undefined;
        }
        const composer = effects.composer
          ? {
              files: effects.composer.files,
              media: effects.composer.media,
              uploaded: effects.composer.uploaded,
              busy: effects.composer.busy,
              submitEnabled: effects.composer.submitEnabled,
              ...(effects.composer.advanceEnabled === undefined
                ? {}
                : { advanceEnabled: effects.composer.advanceEnabled }),
              textMatches: effects.composer.text === original.intent.snapshot.text,
            }
          : null;
        try {
          this.diagnostic({
            jobId: operation.jobId,
            operationId: operation.id,
            attemptId: original.intent.attemptId,
            checkedAt: new Date().toISOString(),
            url: effects.url,
            timeOrigin: effects.timeOrigin,
            ready: effects.ready,
            composer,
            expectedFiles: manifest.files.map((file) => ({
              name: file.name,
              size: file.original.bytes,
            })),
            mediaReady: media !== null,
            ...(structure ? { structure } : {}),
          });
        } catch {
          // Optional diagnostic output cannot alter the original business verdict.
        }
      }
      return media
        ? receipt(null, media)
        : { kind: 'wait', reason: 'FACEBOOK_MEDIA_PROCESSING_OR_MISMATCH' };
    }
    if (purpose !== 'SUBMIT') throw Error('POST_BUSINESS_PURPOSE_REJECTED');
    const baseline = await this.observations.get(operation.id);
    if (
      !baseline ||
      !sameBinding(baseline.binding, operation.binding) ||
      !sameTabProof(baseline.proof, original.intent.proof)
    )
      return { kind: 'unknown', reason: 'ORIGINAL_SUBMISSION_BASELINE_REQUIRED' };
    // Baseline + full text is only a candidate. Require a causal native result, including media
    // IDs, before allowing the original PUBLISHED transaction to consume this resource.
    const input = await this.results.read(page, operation, original, guard);
    await guard();
    if (!input) return { kind: 'wait', reason: 'ORIGINAL_POST_RESULT_CORRELATION_REQUIRED' };
    const result = FacebookPostResultCorrelation.parse(input);
    if (
      !sameBinding(result.binding, operation.binding) ||
      !sameTabProof(result.proof, original.intent.proof) ||
      result.attemptId !== original.intent.attemptId ||
      result.fingerprint !== original.intent.fingerprint
    )
      return { kind: 'unknown', reason: 'ORIGINAL_POST_RESULT_CORRELATION_MISMATCH' };
    // The resolver already inspected the exact native result on a separate owned page and
    // confirmed its closure. Do not require the original homepage to also expose that post
    // (or fabricate a homepage observation). Legacy adapters still need current-page DOM.
    const independent = await this.results.observedEffects?.(original, result, guard);
    const effects = independent
      ? FacebookPostEffects.parse(independent)
      : await this.read(page, guard);
    await guard();
    const candidate = observedNewOwnPost(effects, original.intent, baseline, result);
    if (!candidate) return { kind: 'wait', reason: 'NEW_OWN_POST_NOT_INDEPENDENTLY_OBSERVED' };
    return receipt(candidate.postId);
  }
}
