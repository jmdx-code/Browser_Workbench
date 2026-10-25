import path from 'node:path';
import { DirectMaterialUpload } from './direct-material-upload.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import type { FacebookSubmissionInputObserver } from './facebook-submission-observer.js';
import type { FacebookMaterialInputs } from './kernel-managed-facebook-session.js';
import { MaterialPostSourceCheck } from '../application/material-source-check.js';
import { MaterialUploadPreparation } from '../application/material-upload-preparation.js';
import { MaterialFileGrantPreparation } from '../application/material-file-grant-preparation.js';
import { MaterialUploadOperationGuard } from '../application/material-upload-guard.js';
import { PersistentMaterialUploadStage } from '../application/persistent-material-upload-stage.js';
import { FilesystemMaterialSourceVerifier } from './material-source-verifier.js';
import { FilesystemMaterialUploadStage } from './material-upload-stage.js';
import { KernelMaterialUpload } from './kernel-material-upload.js';
import { FacebookComposerObserver } from './facebook-composer-observer.js';
import { FacebookStoryComposerObserver } from './facebook-story-composer-observer.js';
import { StoryVideoCaptionDeriver } from './story-video-caption-deriver.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';

// One composition of the original source/intent/stage/grant chain. The caller must supply the
// submission observer and its audience/network gates; no business readiness is inferred here.
export function createFacebookMaterialInputs(
  store: WorkspaceStore,
  dataDirectory: string,
  submission: FacebookSubmissionInputObserver,
  beforeUpload?: ConstructorParameters<typeof KernelMaterialUpload>[3],
  uploadCacheRoot = path.join(dataDirectory, 'upload-cache'),
  readStory: typeof readFacebookStoryPage = readFacebookStoryPage,
): FacebookMaterialInputs {
  const source = new MaterialPostSourceCheck(
    store.materials,
    store.materialPosts,
    store.taskTabs,
    new FilesystemMaterialSourceVerifier(),
  );
  const deriver = new StoryVideoCaptionDeriver(dataDirectory);
  const derivedCache = new PersistentMaterialUploadStage(
    store.uploadStages,
    new FilesystemMaterialUploadStage(uploadCacheRoot, undefined, {
      enabled: async (intent) => {
        if (intent.snapshot.format !== 'video' || !intent.snapshot.text.trim()) return false;
        const step = (await store.tasks.steps(intent.jobId)).find(
          (row) => row.id === intent.stepId,
        );
        if (step?.spec.type !== 'post' || step.spec.destination !== 'story') return false;
        await store.uploadStages.assertDerivationContract(intent);
        return true;
      },
      derive: deriver.derive.bind(deriver),
    }),
  );
  const direct = new DirectMaterialUpload();
  const needsDerivation = async (intent: Parameters<typeof direct.stage>[0]) => {
    if (intent.snapshot.format !== 'video' || !intent.snapshot.text.trim()) return false;
    const step = (await store.tasks.steps(intent.jobId)).find((row) => row.id === intent.stepId);
    return step?.spec.type === 'post' && step.spec.destination === 'story';
  };
  const cache = {
    stage: async (...args: Parameters<typeof direct.stage>) =>
      (await needsDerivation(args[0])) ? derivedCache.stage(...args) : direct.stage(...args),
    verify: (...args: Parameters<typeof direct.verify>) =>
      args[2].sourcePaths ? direct.verify(...args) : derivedCache.verify(...args),
    guard: (...args: Parameters<typeof direct.guard>) =>
      args[2].sourcePaths ? direct.guard(...args) : derivedCache.guard(...args),
  };
  return {
    source,
    upload: new KernelMaterialUpload(
      new MaterialUploadPreparation(source, cache),
      new MaterialFileGrantPreparation(source, cache),
      new MaterialUploadOperationGuard(source, cache),
      beforeUpload,
    ),
    composer: new FacebookComposerObserver(
      undefined,
      async (post) => {
        const step = (await store.tasks.steps(post.intent.jobId)).find(
          (row) => row.id === post.intent.stepId,
        );
        return step?.spec.type === 'post' && step.spec.destination === 'story';
      },
      new FacebookStoryComposerObserver(readStory),
    ),
    submission,
  };
}
