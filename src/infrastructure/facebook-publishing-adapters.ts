import type { Awaitable } from '../domain/persistence.js';
import { postAILabelSetting } from '../domain/material-post.js';
import { randomUUID } from 'node:crypto';
import { assertFacebookAILabelInput } from './facebook-ai-label-input.js';
import type { Plan } from '../shared/task-contracts.js';
import type { StepExecution } from '../domain/browse-execution.js';
import type { PostStepAdapter } from '../domain/post-execution.js';
import type { FacebookPostBusinessObserver } from './facebook-managed-post-source.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import type { FacebookMaterialInputs } from './kernel-managed-facebook-session.js';
import { KernelManagedFacebookSession } from './kernel-managed-facebook-session.js';
import { FacebookPlanMaterialCatalogs } from './facebook-plan-material-catalogs.js';
import { ManagedFacebookPostSource } from './facebook-managed-post-source.js';
import { FacebookPostStepExecutor } from './facebook-post-step-executor.js';
import { FacebookStoryStepExecutor } from './facebook-story-step-executor.js';
import { FacebookStorySubmissionObserver } from './facebook-story-submission-observer.js';
import { LookupNativeFacebookPostResultResolver } from './facebook-native-result-resolver.js';
import { NativeFacebookSubmissionWireAdapter } from './facebook-native-submission-wire.js';
import { FacebookSubmissionNetworkObserver } from './facebook-submission-network.js';
import type { PostSubmissionDiagnostic } from './facebook-submission-network.js';
import { DOMFacebookPostBusinessObserver } from './facebook-post-business-observer.js';
import { FacebookSubmissionObserver } from './facebook-submission-observer.js';
import { createFacebookMaterialInputs } from './facebook-material-inputs.js';
import { FacebookVideoUploadObserver } from './facebook-video-upload-observer.js';
import { sameBinding, sameExecution } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type { FacebookSubmissionAudiencePolicy } from './facebook-native-submission-wire.js';
import type { PostUploadDiagnostic } from './facebook-post-business-observer.js';
import type { FacebookPostOriginal } from '../domain/facebook-post-execution.js';
import { PostReceipt } from '../shared/material-post.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import { withStoryVideoTransfer } from '../domain/facebook-story-video.js';

// Software composition only. The lifecycle owner supplies an independent complete-format
// acceptance gate, default closed. Constructing adapters or a connection cannot enable V1.
// Session access always resolves the original registry owner; this map contains observers,
// not browser controllers, actor state, material reservations or publication ledgers.
export class FacebookPublishingAdapters {
  readonly post: PostStepAdapter;
  readonly catalogs: FacebookPlanMaterialCatalogs;
  private readonly observers = new Map<
    string,
    {
      profileId: string;
      inputs: FacebookMaterialInputs;
      network: FacebookSubmissionNetworkObserver;
      business: FacebookPostBusinessObserver;
      video: FacebookVideoUploadObserver;
      story: FacebookStorySubmissionObserver;
    }
  >();
  private closed = false;
  constructor(
    private readonly store: WorkspaceStore,
    private readonly directory: string,
    private readonly owner: (
      execution: StepExecution,
    ) => Awaitable<KernelManagedFacebookSession | null>,
    private readonly completePublicationAcceptance: () => boolean = () => false,
    private readonly audiencePolicy: FacebookSubmissionAudiencePolicy = 'preserve-current',
    private readonly uploadDiagnostic?: (value: PostUploadDiagnostic) => void,
    private readonly submissionDiagnostic?: (value: PostSubmissionDiagnostic) => void,
    private readonly authorizeOriginal: (original: FacebookPostOriginal) => void = () => {},
    selectSource: (execution: StepExecution) => Awaitable<string | undefined> = () => undefined,
    private readonly uploadCacheRoot?: string,
    private readonly storyAuthorized: (plan: Plan) => Awaitable<boolean> = () => false,
    private readonly submitEnabled: (plan: Plan) => boolean = () => true,
  ) {
    this.catalogs = new FacebookPlanMaterialCatalogs(store, directory);
    const source = new ManagedFacebookPostSource(
      owner,
      async (e) => await this.catalogs.current(e),
      store.tasks.resources,
      {
        ready: () => !this.closed && this.completePublicationAcceptance(),
        verify: async (page, operation, original, guard) => {
          await guard();
          const observed = this.observers.get(operation.jobId);
          if (
            this.closed ||
            !observed ||
            observed.profileId !== operation.binding.profileId ||
            original.intent.jobId !== operation.jobId
          )
            throw Error('FACEBOOK_ORIGINAL_POST_OBSERVER_REQUIRED');
          return observed.business.verify(page, operation, original, guard);
        },
      },
      (e, guard) => this.catalogs.prepare(e, guard),
      audiencePolicy === 'require-self' ? 'SELF' : undefined,
    );
    const ordinary = new FacebookPostStepExecutor(
      store.tasks,
      store.materialPosts,
      source,
      randomUUID,
      undefined,
      selectSource,
    );
    const story = new FacebookStoryStepExecutor(
      store.tasks,
      store.materialPosts,
      source,
      randomUUID,
      undefined,
      async (e) => await this.storyAuthorized(e.plan),
    );
    const executor = (e: StepExecution) =>
      e.step.spec.type === 'post' && e.step.spec.destination === 'story' ? story : ordinary;
    this.post = {
      materials: store.materials,
      posts: store.materialPosts,
      executor: {
        available: async () => await source.ready(),
        decide: async (e, reservations, guard) => {
          const decision = await executor(e).decide(e, reservations, guard);
          await guard();
          return decision.kind === 'action' &&
            decision.operation.purpose === 'SUBMIT' &&
            !this.submitEnabled(e.plan)
            ? { kind: 'wait', reason: 'PUBLICATION_ACCEPTANCE_SUBMIT_DISABLED' }
            : decision;
        },
        verify: (e, operation, original, guard) =>
          executor(e).verify(e, operation, original, guard),
      },
      resourceTablesAvailable: () => !this.closed && this.completePublicationAcceptance(),
    };
  }
  inputsFor(plan: Plan, newAdmission = false): FacebookMaterialInputs {
    if (this.closed || plan.state !== 'RUNNING' || !plan.accountId)
      throw Error('FACEBOOK_PUBLISHING_PLAN_REQUIRED');
    const existing = this.observers.get(plan.id);
    if (existing) {
      if (existing.profileId !== plan.profileId) throw Error('FACEBOOK_OBSERVER_PROFILE_CHANGED');
      if (!newAdmission) return existing.inputs;
      existing.network.stop();
      existing.story.stop();
      existing.video.stop();
      this.observers.delete(plan.id);
    }
    const resolver = new LookupNativeFacebookPostResultResolver({
      ready: () => !this.closed,
      read: async (original, result, guard) => {
        await guard();
        const current = await this.store.tasks.get(plan.id),
          step = (await this.store.tasks.steps(plan.id)).find(
            (s) => s.id === original.intent.stepId,
          );
        if (
          !step ||
          current.profileId !== plan.profileId ||
          current.accountId !== plan.accountId ||
          original.intent.jobId !== plan.id
        )
          throw Error('FACEBOOK_RESULT_ORIGINAL_PLAN_REQUIRED');
        const managed = await this.owner({ plan: current, step, session: original.intent.context });
        if (!managed) throw Error('FACEBOOK_RESULT_ORIGINAL_OWNER_REQUIRED');
        return managed.readNativePostResult(original, result, guard);
      },
    });
    // Product publishing preserves the audience selected in the Facebook composer.
    // Finite private research uses the wire adapter's separate require-self default.
    // The passive observer correlates the original UI request; it never changes privacy.
    const wire = new NativeFacebookSubmissionWireAdapter(resolver, async (original) => {
      const step = original
        ? (await this.store.tasks.steps(plan.id)).find(
            (value) => value.id === original.intent.stepId,
          )
        : undefined;
      return step?.spec.type === 'post' && step.spec.audience === 'self'
        ? 'require-self'
        : this.audiencePolicy;
    });
    // Each original plan/actor gets its own Network buffer. Stopping one profile cannot
    // revoke another profile's submission observation or combine their native responses.
    const network = new FacebookSubmissionNetworkObserver(
      this.store.submissionObservations,
      wire,
      this.submissionDiagnostic,
    );
    const video = new FacebookVideoUploadObserver();
    const readStory: typeof readFacebookStoryPage = async (page, guard) => {
      const reading = await readFacebookStoryPage(page, guard);
      return reading.nativeVideoCanvas
        ? withStoryVideoTransfer(reading, await video.readCurrent(page, reading, guard))
        : reading;
    };
    const ordinaryBusiness = new DOMFacebookPostBusinessObserver(
      this.store.submissionObservations,
      this.store.uploadStages,
      network,
      randomUUID,
      undefined,
      video,
      this.uploadDiagnostic,
    );
    const story = new FacebookStorySubmissionObserver(
      this.store.submissionObservations,
      async (value) => {
        if (await this.storyAuthorized(plan)) console.warn(JSON.stringify(value));
      },
      readStory,
    );
    const isStory = async (original: FacebookPostOriginal) => {
      const step = (await this.store.tasks.steps(plan.id)).find(
        (row) => row.id === original.intent.stepId,
      );
      return step?.spec.type === 'post' && step.spec.destination === 'story';
    };
    const business: FacebookPostBusinessObserver = {
      ready: async () => {
        const current = (await this.store.tasks.steps(plan.id)).find(
          (step) => step.status === 'ACTIVE',
        );
        return current?.spec.type === 'post' && current.spec.destination === 'story'
          ? story.ready()
          : ordinaryBusiness.ready();
      },
      verify: async (page, operation, original, guard) =>
        ((await isStory(original)) ? story : ordinaryBusiness).verify(
          page,
          operation,
          original,
          guard,
        ),
    };
    const ordinarySubmission = new FacebookSubmissionObserver(
      this.store.submissionObservations,
      undefined,
      network,
    );
    const inputs = createFacebookMaterialInputs(
      this.store,
      this.directory,
      {
        prepare: async (page, operation, original, guard, observe, enable) =>
          ((await isStory(original)) ? story : ordinarySubmission).prepare(
            page,
            operation,
            original,
            guard,
            observe,
            enable,
          ),
        assert: async (page, operation, original, guard) =>
          ((await isStory(original)) ? story : ordinarySubmission).assert(
            page,
            operation,
            original,
            guard,
          ),
        stop: () => {
          ordinarySubmission.stop();
          story.stop();
        },
      },
      async (page, binding, manifest, guard, enable) => {
        await guard();
        const original = await inputs.source.current(binding, guard);
        this.authorizeOriginal(original);
        const readingGuard = async () => {
          this.authorizeOriginal(original);
          const current = await this.store.tasks.get(plan.id),
            operation = await this.store.tasks.findOperation(plan.id, binding.operationId),
            step = (await this.store.tasks.steps(plan.id)).find(
              (s) => s.id === original.intent.stepId,
            ),
            tab = (await this.store.taskTabs.forPlan(plan.id)).find((t) =>
              sameTabProof(t.proof, original.intent.proof),
            );
          const owner = step
            ? await this.owner({ plan: current, step, session: original.intent.context })
            : null;
          const ownerContext = await owner?.current();
          const receipt =
            operation?.status === 'VERIFIED' ? PostReceipt.safeParse(operation.receipt) : null;
          const appliedUpload =
            receipt?.success &&
            sameBinding(receipt.data.binding, binding) &&
            receipt.data.evidence.purpose === 'UPLOAD_MEDIA' &&
            receipt.data.evidence.outcome === 'APPLIED' &&
            receipt.data.evidence.attemptId === original.intent.attemptId &&
            receipt.data.evidence.fingerprint === original.intent.fingerprint &&
            sameTabProof(receipt.data.evidence.proof, original.intent.proof);
          if (
            this.closed ||
            current.state !== 'RUNNING' ||
            current.accountId !== binding.accountId ||
            current.profileId !== binding.profileId ||
            !step ||
            step.status !== 'ACTIVE' ||
            step.position !== current.position ||
            step.round !== current.round ||
            !operation?.binding ||
            !sameBinding(operation.binding, binding) ||
            (!['DISPATCHING', 'ACKNOWLEDGED'].includes(operation.status) && !appliedUpload) ||
            tab?.state !== 'READY' ||
            !tab.context ||
            !sameExecution(tab.context, binding) ||
            !ownerContext ||
            !sameExecution(ownerContext, binding)
          )
            throw Error('VIDEO_UPLOAD_ORIGINAL_OWNER_REVOKED');
          await this.store.uploadStages.assertReady(manifest);
        };
        await video.begin(page, binding, manifest, original.intent, readingGuard, enable);
        await guard();
        this.authorizeOriginal(original);
      },
      this.uploadCacheRoot,
      readStory,
    );
    inputs.storyVideoTransfer = async (page, story, guard) => {
      await guard();
      const transfer = await video.readCurrent(page, story, guard);
      if ((await this.storyAuthorized(plan)) && process.env.WORKBENCH_TRACE_TIMING === '1')
        console.warn(
          JSON.stringify({
            event: 'STORY_VIDEO_TRANSFER_DIAGNOSTIC',
            jobId: plan.id,
            ...video.diagnostic(story),
            matchedOriginalTransfer: transfer !== null,
          }),
        );
      await guard();
      return transfer;
    };
    const composer = inputs.composer,
      submission = inputs.submission;
    const authorizedGuard =
      (original: FacebookPostOriginal, guard: () => Awaitable<void>) => async () => {
        await guard();
        this.authorizeOriginal(original);
      };
    const aiLabelSetting = async (original: FacebookPostOriginal) => {
      const step = (await this.store.tasks.steps(plan.id)).find(
        (value) => value.id === original.intent.stepId,
      );
      return step?.spec.type === 'post'
        ? postAILabelSetting(original.intent, step.spec.aiLabel)
        : 'preserve-current';
    };
    inputs.composer = {
      assertRelease: async (page, action, original, guard) => {
        const current = await authorizedGuard(original, guard);
        await current();
        if (!composer.assertRelease) throw Error('POST_SETTINGS_RELEASE_OBSERVER_REQUIRED');
        await composer.assertRelease(page, action, original, current);
        await current();
      },
      assert: async (page, action, original, guard, locale) => {
        const current = await authorizedGuard(original, guard);
        await current();
        if (
          await assertFacebookAILabelInput(
            page,
            action,
            original,
            await aiLabelSetting(original),
            current,
          )
        ) {
          await current();
          return;
        }
        await composer.assert(page, action, original, current, locale);
        await current();
      },
    };
    inputs.submission = {
      prepare: async (page, operation, original, guard, observeCurrent, enableBuffers) => {
        const current = await authorizedGuard(original, guard);
        await current();
        await submission.prepare(page, operation, original, current, observeCurrent, enableBuffers);
        await current();
      },
      assert: async (page, operation, original, guard) => {
        const current = await authorizedGuard(original, guard);
        await current();
        await assertFacebookAILabelInput(
          page,
          operation.action,
          original,
          await aiLabelSetting(original),
          current,
        );
        await current();
        await submission.assert(page, operation, original, current);
        await current();
      },
      stop: async () => await submission.stop?.(),
    };
    this.observers.set(plan.id, {
      profileId: plan.profileId,
      inputs,
      network,
      business,
      video,
      story,
    });
    return inputs;
  }
  async close() {
    this.closed = true;
    for (const entry of this.observers.values()) {
      entry.network.stop();
      entry.story.stop();
      entry.video.stop();
    }
    await this.catalogs.close();
    this.observers.clear();
  }
}
