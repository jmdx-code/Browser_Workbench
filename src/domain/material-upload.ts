import type { PostIntent } from '../shared/material-index.js';
import type { UploadManifest } from '../shared/material-upload.js';

export function stagedUploadName(file: UploadManifest['files'][number], index: number) {
  const content = file.derivation ?? file.original;
  const extension = file.derivation
    ? '.mp4'
    : /\.[^./\\]+$/.exec(file.original.relativePath)?.[0]?.toLowerCase();
  return String(index).padStart(2, '0') + '-' + content.digest + extension;
}
export function assertUploadManifestSource(
  intent: PostIntent,
  manifest: UploadManifest,
  mismatch = 'UPLOAD_STAGE_SOURCE_MISMATCH',
) {
  const media = intent.snapshot.files.filter((file) => file.role !== 'text');
  if (
    JSON.stringify(manifest.files.map((file) => file.original)) !== JSON.stringify(media) ||
    manifest.files.some(
      (file, index) =>
        file.name !==
        (manifest.sourcePaths
          ? manifest.sourcePaths[index]?.replaceAll('\\', '/').split('/').at(-1)
          : stagedUploadName(file, index)),
    )
  )
    throw Error(mismatch);
  if (
    manifest.version === 2 &&
    (intent.snapshot.format !== 'video' ||
      !intent.snapshot.text.trim() ||
      manifest.files[0]?.derivation?.text !== intent.snapshot.text)
  )
    throw Error('UPLOAD_STAGE_DERIVED_TEXT_MISMATCH');
}
