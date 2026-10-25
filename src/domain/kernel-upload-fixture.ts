import { KernelUploadFixtureObservation } from '../shared/kernel-upload-fixture.js';
import { uploadedFileContent, type UploadManifest } from '../shared/material-upload.js';

export function verifyKernelUploadFixture(manifest: UploadManifest, value: unknown) {
  const observed = KernelUploadFixtureObservation.parse(value);
  if (observed.files.length !== manifest.files.length) throw Error('FIXTURE_UPLOAD_COUNT_MISMATCH');
  for (const [index, file] of observed.files.entries()) {
    const expected = manifest.files[index];
    if (
      !expected ||
      file.name !== expected.name ||
      file.bytes !== uploadedFileContent(expected).bytes ||
      file.digest !== uploadedFileContent(expected).digest
    )
      throw Error('FIXTURE_UPLOAD_CONTENT_MISMATCH');
  }
  return observed;
}
