import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import {
  mkdir,
  lstat,
  realpath,
  open,
  readFile,
  rm,
  rmdir,
  statfs,
  chmod,
  type FileHandle,
} from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MaterialPostIntent, type PostIntent } from '../shared/material-index.js';
import {
  UploadStageManifest,
  uploadedFileContent,
  type UploadManifest,
} from '../shared/material-upload.js';
import { assertUploadManifestSource } from '../domain/material-upload.js';
import type { VideoDerivation } from '../shared/story-video-derivation.js';
import {
  DispatchBinding,
  sameBinding,
  sameExecution,
  type Binding,
} from '../shared/task-execution.js';
import { FilesystemMaterialSourceVerifier } from './material-source-verifier.js';
import {
  contained,
  proofOf,
  roleOf,
  headerMatches,
  stagedMaterialName as nameFor,
} from './material-file-utils.js';
import { validateSnapshot } from './material-snapshot-validation.js';
import { validateResourceMaterial, resourceEffectiveRow } from '../domain/resource-materials.js';
import type { NativeInputGuard } from '../application/native-input-gate.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pathKey = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
export interface UploadStagePolicy {
  totalBytes: number;
  reserveBytes: number;
  milliseconds: number;
}
const defaults: UploadStagePolicy = {
  totalBytes: 10 * 1024 ** 3,
  reserveBytes: 64 * 1024 ** 2,
  milliseconds: 30_000,
};

export interface StoryUploadDerivation {
  enabled(intent: PostIntent): Awaitable<boolean>;
  derive(
    source: string,
    folder: string,
    text: string,
    sourceSha256: string,
    guard: () => Awaitable<void>,
    created: (file: string) => void,
  ): Promise<{ name: string; derivation: VideoDerivation }>;
}

// Trusted local cache only. No public API accepts these paths or claims READY from filesystem names.
export class FilesystemMaterialUploadStage {
  private busy = false;
  private readonly verifier = new FilesystemMaterialSourceVerifier();
  constructor(
    private readonly directory: string,
    private readonly policy: UploadStagePolicy = defaults,
    private readonly storyDerivation?: StoryUploadDerivation,
  ) {}
  get cacheRoot() {
    return path.resolve(this.directory);
  }
  private async root() {
    if (!path.isAbsolute(this.directory)) throw Error('UPLOAD_STAGE_ROOT_INVALID');
    const root = path.resolve(this.directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      pathKey(await realpath(root)) !== pathKey(root)
    )
      throw Error('UPLOAD_STAGE_ROOT_INVALID');
    return root;
  }
  private identity(input: PostIntent, bindingInput: Binding) {
    const intent = MaterialPostIntent.parse(input),
      binding = DispatchBinding.parse(bindingInput);
    if ('resource' in intent) validateResourceMaterial(intent.snapshot, intent.resource);
    else validateSnapshot(intent.snapshot);
    if (
      intent.fingerprint !== intent.snapshot.fingerprint ||
      (intent.directory !== null &&
        (!path.isAbsolute(intent.directory) ||
          path.basename(intent.directory).toLowerCase() === '已发')) ||
      intent.jobId !== binding.jobId ||
      intent.stepId !== binding.stepId ||
      !sameExecution(intent.context, binding)
    )
      throw Error('UPLOAD_STAGE_BINDING_MISMATCH');
    return { intent, binding };
  }
  async stage(
    input: PostIntent,
    bindingInput: Binding,
    assertCurrent: () => Awaitable<void>,
  ): Promise<UploadManifest> {
    return this.stageAt(input, bindingInput, randomUUID(), assertCurrent, false);
  }
  async stageReserved(
    input: PostIntent,
    bindingInput: Binding,
    stageId: string,
    assertCurrent: () => Awaitable<void>,
  ): Promise<UploadManifest> {
    return this.stageAt(
      input,
      bindingInput,
      UploadStageManifest.shape.stageId.parse(stageId),
      assertCurrent,
      true,
    );
  }
  private async stageAt(
    input: PostIntent,
    bindingInput: Binding,
    stageId: string,
    assertCurrent: () => Awaitable<void>,
    retainOnFailure: boolean,
  ): Promise<UploadManifest> {
    const { intent, binding } = this.identity(input, bindingInput);
    const requestedCache = path.resolve(this.directory),
      resourceRoot = intent.directory !== null ? path.resolve(intent.directory) : null;
    if (
      !path.isAbsolute(this.directory) ||
      (resourceRoot !== null &&
        (pathKey(requestedCache) === pathKey(resourceRoot) ||
          contained(resourceRoot, requestedCache) ||
          contained(requestedCache, resourceRoot))) ||
      ('resource' in intent &&
        resourceEffectiveRow(intent.resource.row, intent.snapshot).media.some(
          (media) =>
            contained(requestedCache, path.resolve(media.source)) ||
            pathKey(requestedCache) === pathKey(path.resolve(media.source)),
        ))
    )
      throw Error('UPLOAD_STAGE_RESOURCE_OVERLAP');
    if (this.busy) throw Error('UPLOAD_STAGE_BUSY');
    this.busy = true;
    const created: string[] = [];
    const handles = new Map<string, FileHandle>();
    let folder: string | undefined;
    try {
      await assertCurrent();
      const root = await this.root();
      await assertCurrent();
      const media = intent.snapshot.files.filter((file) => file.role !== 'text');
      const bytes = media.reduce((sum, file) => sum + file.bytes, 0);
      if (bytes > this.policy.totalBytes) throw Error('UPLOAD_STAGE_BUDGET');
      const space = await statfs(root, { bigint: true });
      if (space.bavail * space.bsize < BigInt(bytes + this.policy.reserveBytes))
        throw Error('UPLOAD_STAGE_NO_SPACE');
      await assertCurrent();
      const candidate = path.join(root, stageId);
      await mkdir(candidate, { mode: 0o700 });
      folder = candidate;
      await assertCurrent();
      const files: UploadManifest['files'] = [];
      for (const [index, file] of media.entries()) {
        await assertCurrent();
        const name = nameFor(file, index),
          destination = path.join(folder, name);
        const handle = await open(destination, 'wx', 0o600);
        created.push(destination);
        handles.set(file.relativePath, handle);
        await assertCurrent();
        files.push({ original: file, name, proof: file.proof });
      }
      let started = performance.now();
      const check = async () => {
        await assertCurrent();
        if (performance.now() - started > this.policy.milliseconds)
          throw Error('UPLOAD_STAGE_BUDGET');
      };
      await this.verifier.copyVerified(intent, check, async (file, chunk) => {
        const handle = handles.get(file.relativePath);
        if (!handle) throw Error('UPLOAD_STAGE_FILE_NOT_DECLARED');
        let offset = 0;
        while (offset < chunk.length) {
          await check();
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          await check();
          if (!bytesWritten) throw Error('UPLOAD_STAGE_WRITE_INCOMPLETE');
          offset += bytesWritten;
        }
      });
      for (const handle of handles.values()) {
        await handle.sync();
        await check();
      }
      const closed = await Promise.allSettled(
        [...handles.values()].map((handle) => handle.close()),
      );
      handles.clear();
      if (closed.some((result) => result.status === 'rejected'))
        throw Error('UPLOAD_STAGE_CLOSE_FAILED');
      let derived = false;
      if (this.storyDerivation && (await this.storyDerivation.enabled(intent))) {
        const original = files[0];
        if (
          intent.snapshot.format !== 'video' ||
          files.length !== 1 ||
          original?.original.role !== 'video'
        )
          throw Error('STORY_VIDEO_DERIVATION_INPUT_REQUIRED');
        const source = path.join(folder, original.name);
        const rendered = await this.storyDerivation.derive(
          source,
          folder,
          intent.snapshot.text,
          original.original.digest,
          assertCurrent,
          (file) => {
            if (path.dirname(path.resolve(file)) !== folder)
              throw Error('UPLOAD_STAGE_CLEANUP_SCOPE');
            created.push(file);
          },
        );
        await assertCurrent();
        if (
          !/^00-[a-f0-9]{64}\.mp4$/.test(rendered.name) ||
          rendered.derivation.sourceSha256 !== original.original.digest
        )
          throw Error('STORY_VIDEO_DERIVATION_OUTPUT_INVALID');
        files[0] = { ...original, ...rendered };
        await rm(source);
        await assertCurrent();
        derived = true;
        started = performance.now();
      }
      for (const file of files) {
        const destination = path.join(folder, file.name);
        await chmod(destination, 0o400);
        file.proof = proofOf(await lstat(destination, { bigint: true }));
        await check();
      }
      const manifest = UploadStageManifest.parse({
        version: derived ? 2 : 1,
        stageId,
        attemptId: intent.attemptId,
        binding,
        intentDigest: digest(JSON.stringify(intent)),
        fingerprint: intent.fingerprint,
        createdAt: new Date().toISOString(),
        files,
      });
      assertUploadManifestSource(intent, manifest);
      await this.verifyFiles(folder, manifest, check);
      const manifestFile = path.join(folder, 'ready.json');
      await check();
      const manifestHandle = await open(manifestFile, 'wx', 0o400);
      created.push(manifestFile);
      try {
        await check();
        await manifestHandle.writeFile(JSON.stringify(manifest));
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      await check();
      return manifest;
    } catch (error) {
      await Promise.allSettled([...handles.values()].map((handle) => handle.close()));
      if (folder && !retainOnFailure) {
        const root = path.resolve(this.directory),
          target = path.resolve(folder);
        if (path.dirname(target) !== root || !/^[a-f0-9-]{36}$/.test(path.basename(target)))
          throw Error('UPLOAD_STAGE_CLEANUP_SCOPE');
        for (const file of created) {
          if (path.dirname(path.resolve(file)) !== target)
            throw Error('UPLOAD_STAGE_CLEANUP_SCOPE');
          await rm(file, { force: true });
        }
        await rmdir(target);
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async verifyFiles(
    folder: string,
    manifest: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ) {
    const folderStat = await lstat(folder);
    if (
      !folderStat.isDirectory() ||
      folderStat.isSymbolicLink() ||
      pathKey(await realpath(folder)) !== pathKey(folder)
    )
      throw Error('UPLOAD_STAGE_FOLDER_CHANGED');
    const result: string[] = [];
    let bytes = 0;
    const started = performance.now();
    const check = async () => {
      await assertCurrent();
      if (performance.now() - started > this.policy.milliseconds)
        throw Error('UPLOAD_STAGE_BUDGET');
    };
    for (const item of manifest.files) {
      const uploaded = uploadedFileContent(item);
      await check();
      const file = path.join(folder, item.name);
      if (
        !contained(folder, file) ||
        roleOf(file) !== item.original.role ||
        pathKey(await realpath(file)) !== pathKey(file)
      )
        throw Error('UPLOAD_STAGE_FILE_INVALID');
      const before = await lstat(file, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        JSON.stringify(proofOf(before)) !== JSON.stringify(item.proof)
      )
        throw Error('UPLOAD_STAGE_FILE_CHANGED');
      const handle = await open(file, 'r');
      try {
        await check();
        const hash = createHash('sha256'),
          buffer = Buffer.alloc(64 * 1024);
        let size = 0,
          head = Buffer.alloc(0);
        while (true) {
          await check();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          await check();
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          if (!size) head = Buffer.from(chunk.subarray(0, 16));
          size += bytesRead;
          bytes += bytesRead;
          if (size > uploaded.bytes || bytes > this.policy.totalBytes)
            throw Error('UPLOAD_STAGE_BUDGET');
          hash.update(chunk);
        }
        const after = await lstat(file, { bigint: true });
        if (
          size !== uploaded.bytes ||
          hash.digest('hex') !== uploaded.digest ||
          !headerMatches(file, head) ||
          !after.isFile() ||
          after.isSymbolicLink() ||
          JSON.stringify(proofOf(after)) !== JSON.stringify(item.proof) ||
          JSON.stringify(proofOf(await handle.stat({ bigint: true }))) !==
            JSON.stringify(item.proof) ||
          pathKey(await realpath(file)) !== pathKey(file)
        )
          throw Error('UPLOAD_STAGE_CONTENT_CHANGED');
      } finally {
        await handle.close();
      }
      result.push(file);
    }
    await check();
    return result;
  }
  async verify(
    input: PostIntent,
    bindingInput: Binding,
    manifestInput: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ): Promise<string[]> {
    const { intent, binding } = this.identity(input, bindingInput),
      manifest = UploadStageManifest.parse(manifestInput);
    const media = intent.snapshot.files.filter((file) => file.role !== 'text');
    if (
      manifest.attemptId !== intent.attemptId ||
      !sameBinding(manifest.binding, binding) ||
      manifest.intentDigest !== digest(JSON.stringify(intent)) ||
      manifest.fingerprint !== intent.fingerprint ||
      JSON.stringify(manifest.files.map((file) => file.original)) !== JSON.stringify(media)
    )
      throw Error('UPLOAD_STAGE_MANIFEST_MISMATCH');
    assertUploadManifestSource(intent, manifest);
    await assertCurrent();
    const root = await this.root();
    await assertCurrent();
    const folder = path.join(root, manifest.stageId);
    const folderStat = await lstat(folder);
    if (
      !folderStat.isDirectory() ||
      folderStat.isSymbolicLink() ||
      pathKey(await realpath(folder)) !== pathKey(folder)
    )
      throw Error('UPLOAD_STAGE_FOLDER_CHANGED');
    const saved = await lstat(path.join(folder, 'ready.json'));
    if (!saved.isFile() || saved.isSymbolicLink() || saved.size > 64 * 1024)
      throw Error('UPLOAD_STAGE_NOT_READY');
    const original = UploadStageManifest.parse(
      JSON.parse(await readFile(path.join(folder, 'ready.json'), 'utf8')) as unknown,
    );
    if (JSON.stringify(original) !== JSON.stringify(manifest))
      throw Error('UPLOAD_STAGE_MANIFEST_CHANGED');
    const files = await this.verifyFiles(folder, manifest, assertCurrent);
    await assertCurrent();
    return files;
  }
  guard(
    input: PostIntent,
    binding: Binding,
    manifest: UploadManifest,
    assertCurrent: () => Awaitable<void>,
  ): NativeInputGuard {
    // This resource guard is internal. A business adapter must additionally validate upload purpose.
    const original = MaterialPostIntent.parse(input);
    const originalBinding = DispatchBinding.parse(binding);
    const originalManifest = UploadStageManifest.parse(manifest);
    return async (command) => {
      await assertCurrent();
      if (command.target.tabId !== original.proof.tabId)
        throw Error('UPLOAD_STAGE_TARGET_MISMATCH');
      if (command.method === 'DOM.setFileInputFiles') {
        const files = await this.verify(original, originalBinding, originalManifest, assertCurrent);
        if (!files.length || JSON.stringify(command.params.files) !== JSON.stringify(files))
          throw Error('UPLOAD_STAGE_FILES_MISMATCH');
      }
      await assertCurrent();
    };
  }
}
