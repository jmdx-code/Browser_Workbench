import type {
  PostEffects,
  SubmissionBaseline,
  PostResultCorrelation,
} from '../shared/facebook-post-observation.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameTabProof } from './task-tabs.js';
import type { PostIntent } from '../shared/material-index.js';
import type { UploadManifest } from '../shared/material-upload.js';
import type { VideoTransfer } from '../shared/facebook-video-transfer.js';

// Displayed FB text collapses trailing control separators and whitespace. Never compare just a
// prefix, infer text from another post, or change the original stored/uploaded material text.
const rendered = (text: string) => text.replace(/\s+/gu, ' ').trim();
export function observedMediaUpload(
  effects: PostEffects,
  intent: PostIntent,
  manifest: UploadManifest,
  transfer?: VideoTransfer | null,
) {
  if (manifest.version !== 1) return null;
  const composer = effects.composer;
  const original = intent.snapshot.files.filter((f) => f.role !== 'text');
  const expectedFiles = manifest.files.map((f) => ({ name: f.name, size: f.original.bytes }));
  const imageMatches = (media: NonNullable<PostEffects['composer']>['media'][number], i: number) =>
    media.kind === 'image' &&
    media.ready &&
    (media.name === manifest.files[i]?.name ||
      (media.previewBytes?.source === 'owned-preview-blob' &&
        media.previewBytes.sha256 === original[i]?.digest &&
        media.previewBytes.size === original[i]?.bytes));
  const nativeVideo = Boolean(
    transfer &&
    transfer.source === 'owned-video-upload-transfer' &&
    sameBinding(transfer.binding, manifest.binding) &&
    sameTabProof(transfer.proof, intent.proof) &&
    transfer.attemptId === intent.attemptId &&
    transfer.stageId === manifest.stageId &&
    transfer.fingerprint === intent.fingerprint &&
    intent.snapshot.format === 'video' &&
    original.length === 1 &&
    original[0]?.role === 'video' &&
    transfer.digest === original[0].digest &&
    transfer.bytes === original[0].bytes &&
    transfer.receivedBytes === original[0].bytes &&
    transfer.timeOrigin === effects.timeOrigin &&
    transfer.url === effects.url &&
    composer?.media.length === 1 &&
    composer.media[0]?.kind === 'video' &&
    (composer.media[0].durationSeconds ?? 0) > 0,
  );
  // Facebook clears FileList after ingestion. A cleared image input is acceptable only when
  // every decoded uploaded card names its exact stage member or its local Blob matches
  // the original bytes in order. Modern homepage previews do not expose file names.
  // A nameless video/card count or a nonempty mismatching FileList cannot replace that proof.
  const clearedImageInput =
    composer?.files.length === 0 &&
    original.length > 0 &&
    original.every((file) => file.role === 'image') &&
    composer.media.length === manifest.files.length &&
    composer.media.every(imageMatches);
  const clearedVideoInput =
    intent.snapshot.format === 'video' &&
    composer?.files.length === 0 &&
    original.length === 1 &&
    original[0]?.role === 'video' &&
    composer.media.length === 1 &&
    composer.media[0]?.kind === 'video' &&
    (nativeVideo ||
      (composer.media[0].ready &&
        composer.media[0].previewBytes?.source === 'owned-preview-blob' &&
        composer.media[0].previewBytes.sha256 === original[0].digest &&
        composer.media[0].previewBytes.size === original[0].bytes));
  if (
    !composer ||
    effects.ready === 'loading' ||
    (!composer.uploaded && !clearedImageInput && !clearedVideoInput) ||
    composer.busy ||
    !(composer.submitEnabled || composer.advanceEnabled === true) ||
    composer.text !== intent.snapshot.text ||
    manifest.attemptId !== intent.attemptId ||
    manifest.fingerprint !== intent.fingerprint ||
    JSON.stringify(manifest.files.map((f) => f.original)) !== JSON.stringify(original) ||
    (!clearedImageInput &&
      !clearedVideoInput &&
      JSON.stringify(composer.files) !== JSON.stringify(expectedFiles)) ||
    composer.media.length !== original.length ||
    !composer.media.every(
      (m, i) =>
        (m.ready || (m.kind === 'video' && nativeVideo)) &&
        m.kind === (original[i]?.role === 'video' ? 'video' : 'image') &&
        (m.kind === 'video' || imageMatches(m, i)),
    )
  )
    return null;
  return intent.snapshot.format === 'text'
    ? null
    : { ready: true as const, format: intent.snapshot.format, count: original.length };
}

export function observedNewOwnPost(
  effects: PostEffects,
  intent: PostIntent,
  baseline: SubmissionBaseline,
  correlation?: PostResultCorrelation,
) {
  if (
    effects.ready === 'loading' ||
    effects.composer ||
    baseline.attemptId !== intent.attemptId ||
    baseline.fingerprint !== intent.fingerprint ||
    baseline.accountId !== intent.context.accountId
  )
    return null;
  // Pure media is supported only with an exact causal result; count/newness is insufficient.
  if (
    correlation &&
    (!sameBinding(correlation.binding, baseline.binding) ||
      !sameTabProof(correlation.proof, baseline.proof) ||
      correlation.attemptId !== intent.attemptId ||
      correlation.fingerprint !== intent.fingerprint)
  )
    return null;
  if (rendered(intent.snapshot.text) === '' && !correlation) return null;
  const count = intent.snapshot.files.filter((f) => f.role !== 'text').length;
  const candidates = effects.posts.filter(
    (p) =>
      p.accountId === intent.context.accountId &&
      p.postId &&
      p.permalink &&
      !baseline.postIds.includes(p.postId) &&
      !p.nestedShare &&
      p.expanded &&
      (rendered(intent.snapshot.text) === ''
        ? p.text === null || rendered(p.text) === ''
        : p.text !== null && rendered(p.text) === rendered(intent.snapshot.text)) &&
      (!correlation ||
        (p.postId === correlation.postId &&
          p.videoId === correlation.videoId &&
          JSON.stringify(p.photos) === JSON.stringify(correlation.photos))) &&
      (intent.snapshot.format === 'text'
        ? p.photos.length === 0 && p.videoId === null
        : intent.snapshot.format === 'video'
          ? p.photos.length === 0 && p.videoReady && p.videoId === p.postId
          : p.videoId === null && p.photos.length === count),
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
