import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Awaitable } from '../domain/persistence.js';
import type { PostIntent } from '../shared/material-index.js';
import { sameBinding, type Binding } from '../shared/task-execution.js';
import { UploadStageManifest, type UploadManifest } from '../shared/material-upload.js';
import { assertUploadManifestSource } from '../domain/material-upload.js';
import { resourceEffectiveRow } from '../domain/resource-materials.js';
import { proofOf, contained } from './material-file-utils.js';
import { FilesystemMaterialSourceVerifier } from './material-source-verifier.js';
import type { NativeInputGuard } from '../application/native-input-gate.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// Ordinary uploads reference originals. Only the explicit video-caption feature creates media.
export class DirectMaterialUpload {
  private paths(intent: PostIntent): string[] {
    if ('resource' in intent)
      return resourceEffectiveRow(intent.resource.row, intent.snapshot).media.map((m) =>
        path.resolve(m.source),
      );
    return intent.snapshot.files
      .filter((f) => f.role !== 'text')
      .map((f) => {
        const file = path.resolve(intent.directory, f.relativePath);
        if (!contained(path.resolve(intent.directory), file))
          throw Error('UPLOAD_SOURCE_PATH_INVALID');
        return file;
      });
  }
  async stage(
    intent: PostIntent,
    binding: Binding,
    current: () => Awaitable<void>,
  ): Promise<UploadManifest> {
    await current();
    const paths = this.paths(intent);
    const manifest = UploadStageManifest.parse({
      version: 1,
      stageId: randomUUID(),
      attemptId: intent.attemptId,
      binding,
      intentDigest: digest(JSON.stringify(intent)),
      fingerprint: intent.fingerprint,
      createdAt: new Date().toISOString(),
      sourcePaths: paths,
      files: intent.snapshot.files
        .filter((f) => f.role !== 'text')
        .map((f, i) => {
          const file = paths[i];
          if (!file) throw Error('UPLOAD_SOURCE_MEMBER_MISSING');
          return { original: f, proof: f.proof, name: path.basename(file) };
        }),
    });
    await this.verify(intent, binding, manifest, current);
    return manifest;
  }
  async verify(
    intent: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    current: () => Awaitable<void>,
  ): Promise<string[]> {
    await current();
    const files = this.paths(intent);
    if (
      !sameBinding(binding, manifest.binding) ||
      manifest.attemptId !== intent.attemptId ||
      manifest.intentDigest !== digest(JSON.stringify(intent)) ||
      manifest.fingerprint !== intent.fingerprint ||
      JSON.stringify(files) !== JSON.stringify(manifest.sourcePaths)
    )
      throw Error('UPLOAD_SOURCE_MANIFEST_MISMATCH');
    assertUploadManifestSource(intent, manifest);
    for (const [i, file] of files.entries()) {
      const stat = await lstat(file, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        JSON.stringify(proofOf(stat)) !== JSON.stringify(manifest.files[i]?.original.proof)
      )
        throw Error('UPLOAD_SOURCE_CHANGED');
    }
    await current();
    return files;
  }
  guard(
    intent: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    current: () => Awaitable<void>,
  ): NativeInputGuard {
    let inspected = false;
    return async (command) => {
      await current();
      if (command.target.tabId !== intent.proof.tabId) throw Error('UPLOAD_SOURCE_TARGET_MISMATCH');
      if (command.method !== 'DOM.setFileInputFiles') return;
      const files = await this.verify(intent, binding, manifest, current);
      if (JSON.stringify(command.params.files) !== JSON.stringify(files))
        throw Error('UPLOAD_SOURCE_FILES_MISMATCH');
      if (!inspected) {
        // One content check at the input boundary, no copy and no repeated full-file hashing.
        let lastCheck = performance.now();
        await new FilesystemMaterialSourceVerifier().verify(intent, async () => {
          if (performance.now() - lastCheck >= 250) {
            await current();
            lastCheck = performance.now();
          }
        });
        inspected = true;
      }
      await this.verify(intent, binding, manifest, current);
    };
  }
}
