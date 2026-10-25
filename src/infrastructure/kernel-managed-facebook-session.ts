import type { Awaitable } from '../domain/persistence.js';
import { BusinessResolution } from '../shared/settlement.js';
import { clickFacebookNativeTarget } from './facebook-native-click.js';
import { waitForBrowseVisibility } from './facebook-browse-visibility.js';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import { withStoryVideoTransfer } from '../domain/facebook-story-video.js';
import type { StoryPage } from '../shared/facebook-story.js';
import type { VideoTransfer } from '../shared/facebook-video-transfer.js';
import { readFacebookAILabel } from './facebook-ai-label-reader.js';
import type { TabProof } from '../shared/kernel-state.js';
import type { Peer } from '../bridge/core.js';
import type { ManagedProfileSession } from '../domain/profile-actor.js';
import type { RuntimeProfile, TaskRepository } from '../domain/tasks.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { Action, canonicalAction } from '../shared/browser-actions.js';
import { sameExecution, type Binding } from '../shared/task-execution.js';
import {
  SessionStopBinding,
  SessionStopReceipt,
  sameStop,
  type StopBinding,
} from '../shared/task-control.js';
import type { Operation, Plan } from '../shared/task-contracts.js';
import type { Resolution } from '../shared/settlement.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { MaterialPostSourceCheck } from '../application/material-source-check.js';
import type { KernelMaterialUpload } from './kernel-material-upload.js';
import { validatePostAction } from '../domain/material-post.js';
import type { PostIntent } from '../shared/material-index.js';
import type { PostLink } from '../shared/material-post.js';
import type { FacebookPostComposerObserver } from './facebook-composer-observer.js';
import { readFacebookPostPage } from './facebook-post-page-reader.js';
import type { FacebookUILocale } from '../shared/facebook-ui.js';
import type { StepExecution } from '../domain/browse-execution.js';
import type {
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from '../domain/facebook-post-execution.js';
import type { FacebookPostBusinessObserver } from './facebook-managed-post-source.js';
import { PostVerdict } from '../shared/post-execution.js';
import { sameBinding } from '../shared/task-execution.js';
import type { AcceptedNativeFacebookPost } from './facebook-native-submission-wire.js';
import type { FacebookSubmissionInputObserver } from './facebook-submission-observer.js';
import { matchObservedFacebookNativeResult } from './facebook-native-result-resolver.js';
import { readFacebookEmptySurface } from './facebook-empty-surface-reader.js';
import { readFacebookBrowsePage, type BrowsePage } from './facebook-browse-reader.js';
import { readFacebookSubmissionAudience } from './facebook-submission-audience.js';
import { readFacebookComposerAudience } from './facebook-composer-audience.js';
import { installAutomationPointer } from '../shared/automation-pointer.js';
import { BrowseWheelStart } from '../shared/browse-execution.js';
import { facebookBrowseSurface } from '../shared/facebook-browse-route.js';
import { readFacebookHomePreparation } from './facebook-home-preparation.js';
import {
  facebookBrowseNavigationSelector,
  facebookStoryNavigationSelector,
  readFacebookBrowseNavigation,
} from './facebook-native-browse-navigation.js';

export interface FacebookPostTarget {
  intent: PostIntent;
  link: PostLink;
}
// Private controller dependencies, not an HTTP/renderer permission to submit paths or intents.
export interface FacebookMaterialInputs {
  source: MaterialPostSourceCheck;
  upload: KernelMaterialUpload;
  composer: FacebookPostComposerObserver;
  submission: FacebookSubmissionInputObserver;
  storyVideoTransfer?: (
    page: Page,
    story: StoryPage,
    guard: () => Awaitable<void>,
  ) => Awaitable<VideoTransfer | null>;
}

// The lifecycle owner supplies this live authority. Display inspection and profile candidates
// cannot grant identity, page ownership or permission for a native business input.
export interface FacebookTaskAuthority {
  foregroundAllowed?(): boolean;
  canPresentTaskPage?(): Awaitable<boolean>;
  admissionTab?(): TabProof | undefined;
  bindPage?(page: Page, proof: TabProof): Promise<void>;
  refreshIdentity?(
    page: Page,
    guard: () => Awaitable<void>,
    pagePreparation?: boolean,
  ): Promise<void>;
  readBrowsePage?(page: Page, guard: () => Awaitable<void>): Promise<BrowsePage>;
  profile(): Awaitable<RuntimeProfile>;
  assertIdentity(accountId: string): Awaitable<void>;
  // Re-read the current document/route and the exact business target after each SDK wait.
  assertTarget(
    action: Action,
    appliedScrollDelta?: number,
    activationPreparation?: boolean,
  ): Promise<void>;
  // Must inspect composer purpose, original content and actor, not reuse a generic click check.
  assertPostTarget?(action: Action, post: FacebookPostTarget): Promise<void>;
  assertInputTarget?(
    action: Action,
    post: FacebookPostTarget | undefined,
    appliedScrollDelta: number,
    activationPreparation?: boolean,
  ): Promise<void>;
}
type Connection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;

export class KernelManagedFacebookSession implements ManagedProfileSession {
  private failure: ((reason: string) => Promise<void>) | null = null;
  private stopReceipt: ReturnType<typeof SessionStopReceipt.parse> | null = null;
  private postLocale: FacebookUILocale | undefined;
  private async movePointer(page: Page, x: number, y: number, guard: () => Awaitable<void>) {
    await guard();
    await page.mouse.move(x, y);
    await guard();
  }
  private constructor(
    private readonly context: NonNullable<Awaited<ReturnType<Connection['context']>>>,
    private readonly connection: Connection,
    private readonly plan: Plan,
    private readonly authority: FacebookTaskAuthority,
    private readonly tabs: TaskTabRepository,
    private readonly tasks: TaskRepository,
    private readonly materialInputs?: FacebookMaterialInputs,
    private readonly visiblePointer = false,
  ) {}
  static async open(
    kernel: KernelBridge,
    peer: Peer,
    input: Plan,
    authority: FacebookTaskAuthority,
    tasks: TaskRepository,
    tabs: TaskTabRepository,
    materialInputs?: FacebookMaterialInputs,
  ) {
    const plan = structuredClone(input);
    const assertIdentity = async () => {
      const current = await tasks.get(plan.id),
        profile = await authority.profile();
      if (
        !['RUNNING', 'REVIEW', 'PAUSING', 'STOPPING'].includes(current.state) ||
        current.profileId !== peer.profileId ||
        current.accountId !== plan.accountId ||
        profile.id !== peer.profileId ||
        !profile.online ||
        !profile.synced ||
        profile.unresolved ||
        !profile.dispatchAllowed ||
        profile.account.state !== 'logged-in' ||
        !plan.accountId ||
        profile.account.id !== plan.accountId
      )
        throw Error('FACEBOOK_MANAGED_IDENTITY_OR_PLAN_REJECTED');
      await authority.assertIdentity(plan.accountId);
    };
    await assertIdentity();
    if ((await tasks.get(plan.id)).state !== 'RUNNING')
      throw Error('FACEBOOK_MANAGED_RUNNING_PLAN_REQUIRED');
    const active = (await tasks.steps(plan.id)).find((step) => step.status === 'ACTIVE');
    if (
      active?.spec.type === 'post' &&
      (!materialInputs?.composer || !materialInputs.submission || !authority.assertPostTarget)
    )
      throw Error('FACEBOOK_MATERIAL_INPUTS_OR_TARGET_OBSERVER_REQUIRED');
    if (!plan.accountId) throw Error('FACEBOOK_MANAGED_IDENTITY_REQUIRED');
    const connection = await kernel.connectFacebook(
      peer,
      plan.accountId,
      assertIdentity,
      authority.admissionTab?.(),
      active?.spec.type === 'post' && active.spec.destination === 'story',
    );
    try {
      await assertIdentity();
      if ((await tasks.get(plan.id)).state !== 'RUNNING')
        throw Error('FACEBOOK_MANAGED_RUNNING_PLAN_REQUIRED');
      const context = plan.accountId ? await connection.context(plan.accountId) : null;
      if (!context || !connection.proof || connection.access !== 'facebook-task')
        throw Error('FACEBOOK_MANAGED_CONTEXT_REQUIRED');
      const session = new KernelManagedFacebookSession(
        context,
        connection,
        plan,
        authority,
        tabs,
        tasks,
        materialInputs,
        peer.capabilities?.includes('visible-pointer-v1') === true,
      );
      if (!connection.proof) throw Error('FACEBOOK_MANAGED_PROOF_REQUIRED');
      if (authority.bindPage) {
        const contexts = connection.browser.contexts(),
          pages = contexts[0]?.pages();
        if (contexts.length !== 1 || pages?.length !== 1 || !pages[0])
          throw Error('FACEBOOK_MANAGED_PAGE_REQUIRED');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            authority.bindPage(pages[0], connection.proof),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const trace = kernel.diagnostics(peer.profileId);
                const last = trace
                  .filter((row) => /context:|rejected:|dispatch:Runtime\./.test(row.event))
                  .slice(-3);
                reject(
                  Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT:' + last.map((row) => row.event).join('|')),
                );
              }, 40000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        await assertIdentity();
      }
      await tabs.register(plan.id, connection.proof, session.context);
      await assertIdentity();
      if (
        typeof kernel.revealOwnedFacebookPage === 'function' &&
        !kernel.usesExposedWindowLayout() &&
        peer.capabilities?.includes('kernel-owned-page-reveal-v1')
      ) {
        await kernel.revealOwnedFacebookPage(peer, connection.proof).catch(() => {});
        await assertIdentity();
      }
      return session;
    } catch (error) {
      // A registration error does not justify silently adopting or abandoning the native page.
      await connection.close();
      const inventory = connection.closedInventory,
        proof = connection.proof;
      if (inventory && proof) {
        const row = (await tabs.forPlan(plan.id)).find((item) => sameTabProof(item.proof, proof));
        if (
          row &&
          row.state !== 'CLOSED' &&
          !(await tasks.operations(plan.id)).some((op) =>
            ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
          )
        )
          await tabs.confirmClosed(proof.ownershipId, row.revision, inventory, plan.id);
      }
      throw error;
    }
  }
  get profileId() {
    return this.plan.profileId;
  }
  ownedPlanId(): string {
    return this.plan.id;
  }
  revokeInput(reason: string): void {
    this.connection.revokeInput(reason);
  }
  async profile() {
    const profile = await this.authority.profile();
    const failure =
      this.connection.failureReason ?? this.connection.executionFailure?.message.split('\n')[0];
    return failure && !profile.unreadyReason
      ? {
          ...profile,
          unreadyReason: /^[A-Z][A-Z0-9_:|.-]{0,199}$/.test(failure)
            ? failure
            : 'FACEBOOK_SESSION_FAILED',
        }
      : profile;
  }
  async current() {
    return await this.connection.context(this.context.accountId);
  }
  private async operation(id: string) {
    return this.tasks.findOperation
      ? await this.tasks.findOperation(this.plan.id, id)
      : (await this.tasks.operations(this.plan.id)).find((op) => op.id === id);
  }
  private async postReadContext(
    execution: StepExecution,
    guard: () => Awaitable<void>,
    browse = false,
  ) {
    const proof = this.connection.proof;
    const assertCurrent = async () => {
      await guard();
      await this.authority.assertIdentity(this.context.accountId);
      const current = await this.current();
      const plan = await this.tasks.get(this.plan.id);
      const step = (await this.tasks.steps(this.plan.id)).find(
        (item) => item.id === execution.step.id,
      );
      if (
        !current ||
        !sameExecution(current, execution.session) ||
        execution.plan.id !== this.plan.id ||
        (browse ? execution.step.spec.type === 'post' : execution.step.spec.type !== 'post') ||
        plan.state !== 'RUNNING' ||
        plan.accountId !== this.context.accountId ||
        step?.status !== 'ACTIVE' ||
        step.position !== plan.position ||
        JSON.stringify(step.spec) !== JSON.stringify(execution.step.spec) ||
        !proof ||
        !this.failure
      )
        throw Error('FACEBOOK_MANAGED_POST_READING_REJECTED');
      const row = (await this.tabs.forPlan(this.plan.id)).find((item) =>
        sameTabProof(item.proof, proof),
      );
      if (row?.state !== 'READY' || !row.context || !sameExecution(row.context, current))
        throw Error('FACEBOOK_MANAGED_POST_TARGET_NOT_READY');
    };
    await assertCurrent();
    const contexts = this.connection.browser.contexts(),
      pages = contexts[0]?.pages();
    if (contexts.length !== 1 || pages?.length !== 1 || !pages[0] || !proof)
      throw Error('FACEBOOK_MANAGED_PAGE_REQUIRED');
    return { page: pages[0], proof, assertCurrent };
  }
  async readPostPage(
    execution: StepExecution,
    guard: () => Awaitable<void>,
    requiredAudience?: 'SELF',
    readAILabel = false,
  ) {
    const { page, proof, assertCurrent } = await this.postReadContext(execution, guard);
    await this.authority.refreshIdentity?.(page, assertCurrent, true);
    await assertCurrent();
    if (execution.step.spec.type === 'post' && execution.step.spec.destination === 'story') {
      if (requiredAudience) throw Error('STORY_POST_AUDIENCE_SCOPE_MISMATCH');
      let story = [
        'https://www.facebook.com/stories/create/',
        'https://www.facebook.com/stories/create',
      ].includes(page.url())
        ? await readFacebookStoryPage(page, assertCurrent)
        : undefined;
      if (story?.nativeVideoCanvas && this.materialInputs?.storyVideoTransfer) {
        const transfer = await this.materialInputs.storyVideoTransfer(page, story, assertCurrent);
        await assertCurrent();
        if (transfer) story = withStoryVideoTransfer(story, transfer);
      }
      const preparation = story
        ? undefined
        : await readFacebookHomePreparation(page, assertCurrent);
      await assertCurrent();
      const document = story ?? preparation?.page;
      if (!document) throw Error('STORY_DOCUMENT_REQUIRED');
      return {
        context: structuredClone(this.context),
        proof: structuredClone(proof),
        observedAccountId: this.context.accountId,
        documentEpoch: 0,
        routeEpoch: 0,
        timeOrigin: document.timeOrigin,
        url: document.url,
        ready: document.ready ? 'complete' : 'loading',
        composerProjection: [],
        locale: undefined,
        opener: null,
        surface: null,
        text: story?.text ?? null,
        ...(story ? { story } : {}),
        ...(preparation
          ? { homePreparation: { safe: preparation.safe, reason: preparation.reason } }
          : {}),
      };
    }
    if (
      !['https://www.facebook.com/', 'https://www.facebook.com/post/create'].includes(page.url())
    ) {
      const preparation = await readFacebookHomePreparation(page, assertCurrent);
      await assertCurrent();
      return {
        context: structuredClone(this.context),
        proof: structuredClone(proof),
        observedAccountId: this.context.accountId,
        documentEpoch: 0,
        routeEpoch: 0,
        timeOrigin: preparation.page.timeOrigin,
        url: preparation.page.url,
        ready: preparation.page.ready ? 'complete' : 'loading',
        composerProjection: [],
        locale: undefined,
        opener: null,
        surface: null,
        text: null,
        homePreparation: { safe: preparation.safe, reason: preparation.reason },
      };
    }
    const configureAI =
      readAILabel ||
      (execution.step.spec.type === 'post' &&
        execution.step.spec.aiLabel !== undefined &&
        execution.step.spec.aiLabel !== 'preserve-current');
    const aiLabel = configureAI ? await readFacebookAILabel(page, assertCurrent) : undefined;
    await assertCurrent();
    if (aiLabel?.phase === 'settings') {
      return {
        context: structuredClone(this.context),
        proof: structuredClone(proof),
        observedAccountId: this.context.accountId,
        documentEpoch: 0,
        routeEpoch: 0,
        timeOrigin: aiLabel.timeOrigin,
        url: aiLabel.url,
        ready: aiLabel.ready ? 'complete' : 'loading',
        composerProjection: [],
        locale: this.postLocale,
        opener: null,
        surface: null,
        text: null,
        aiLabel,
      };
    }
    const observation = await readFacebookPostPage(page, this.postLocale, assertCurrent);
    await assertCurrent();
    if (
      aiLabel &&
      (aiLabel.url !== observation.projection.url ||
        aiLabel.timeOrigin !== observation.projection.timeOrigin)
    )
      throw Error('POST_AI_LABEL_DOCUMENT_CHANGED');
    const stepHasOperations = (await this.tasks.operations(this.plan.id)).some(
      (op) => op.stepId === execution.step.id && op.status !== 'CANCELLED',
    );
    const homePreparation =
      observation.projection.url === 'https://www.facebook.com/' &&
      ((!observation.opener && !observation.surface) ||
        (!stepHasOperations &&
          !!observation.surface &&
          observation.text === '' &&
          ['direct-submit', 'edit-before-review'].includes(observation.surface.phase)))
        ? await readFacebookHomePreparation(page, assertCurrent)
        : undefined;
    await assertCurrent();
    const configureSelf =
      execution.step.spec.type === 'post' && execution.step.spec.audience === 'self';
    const audience =
      configureSelf && !homePreparation
        ? await readFacebookComposerAudience(page, assertCurrent)
        : undefined;
    await assertCurrent();
    if (
      audience &&
      (audience.url !== observation.projection.url ||
        audience.timeOrigin !== observation.projection.timeOrigin)
    )
      throw Error('POST_AUDIENCE_DOCUMENT_CHANGED');
    // Finite private tests reject an incompatible empty editor before preparing text/upload.
    // Submission still performs its own fresh audience check after content is ready.
    if (
      requiredAudience &&
      !configureSelf &&
      observation.surface?.phase === 'direct-submit' &&
      observation.text === ''
    ) {
      const audience = await readFacebookSubmissionAudience(page, assertCurrent);
      await assertCurrent();
      if (
        audience.ready === 'loading' ||
        audience.url !== observation.projection.url ||
        audience.timeOrigin !== observation.projection.timeOrigin ||
        audience.audience !== requiredAudience
      )
        throw Error('POST_AUDIENCE_UNCONFIRMED_BEFORE_CONTENT');
    }
    this.postLocale = observation.locale;
    return {
      context: structuredClone(this.context),
      proof: structuredClone(proof),
      observedAccountId: this.context.accountId,
      ...(audience ? { audience } : {}),
      ...(aiLabel ? { aiLabel } : {}),
      ...(homePreparation
        ? { homePreparation: { safe: homePreparation.safe, reason: homePreparation.reason } }
        : {}),
      // These legacy action fields are unused by the private SDK relay. The original native
      // proof, SDK frame/document fencing and fresh business guard remain the input authority.
      documentEpoch: 0,
      routeEpoch: 0,
      timeOrigin: observation.projection.timeOrigin,
      url: observation.projection.url,
      ready: observation.projection.ready,
      composerProjection: observation.projection.rows.filter((row) =>
        row.key.startsWith('composer'),
      ),
      locale: observation.locale,
      opener: observation.opener,
      surface: observation.surface,
      text: observation.text,
      ...(observation.background ? { background: observation.background } : {}),
    };
  }
  async readBrowsePage(execution: StepExecution, guard: () => Awaitable<void>) {
    try {
      return await this.readBrowsePageOwned(execution, guard);
    } catch (error) {
      // SDK teardown can mask the transport fault with a generic page-closed error.
      if (this.connection.failureReason) throw Error(this.connection.failureReason);
      throw error;
    }
  }
  async foregroundAllowed(execution: StepExecution, guard: () => Awaitable<void>) {
    await this.postReadContext(execution, guard, true);
    return this.authority.foregroundAllowed?.();
  }
  async canPresentTaskPage(execution: StepExecution, guard: () => Awaitable<void>) {
    await this.postReadContext(execution, guard, true);
    return (await this.authority.canPresentTaskPage?.()) ?? this.authority.foregroundAllowed?.();
  }
  private async readBrowsePageOwned(execution: StepExecution, guard: () => Awaitable<void>) {
    const { page, proof, assertCurrent } = await this.postReadContext(execution, guard, true);
    if (this.authority.readBrowsePage) {
      const reading = await this.authority.readBrowsePage(page, assertCurrent);
      await assertCurrent();
      return {
        context: structuredClone(this.context),
        proof: structuredClone(proof),
        page: reading,
        foregroundAllowed: this.authority.foregroundAllowed?.() === true,
        canPresentTaskPage: (await this.authority.canPresentTaskPage?.()) === true,
      };
    }
    const reading = await readFacebookBrowsePage(page, assertCurrent);
    if (reading.ready && !reading.blocked) {
      await this.authority.refreshIdentity?.(page, assertCurrent);
      await assertCurrent();
    }
    return {
      context: structuredClone(this.context),
      proof: structuredClone(proof),
      page: reading,
      foregroundAllowed: this.authority.foregroundAllowed?.() === true,
      canPresentTaskPage: (await this.authority.canPresentTaskPage?.()) === true,
    };
  }
  async readEmptyPostStructure(execution: StepExecution, guard: () => Awaitable<void>) {
    const { page, assertCurrent } = await this.postReadContext(execution, guard);
    return readFacebookEmptySurface(page, assertCurrent);
  }
  async verifyPostBusiness(
    execution: StepExecution,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    observer: FacebookPostBusinessObserver,
    guard: () => Awaitable<void>,
  ) {
    const read = await this.postReadContext(execution, guard);
    const assertCurrent = async () => {
      await read.assertCurrent();
      const current = await this.operation(operation.id);
      if (
        !(observer.readyForPurpose?.(original.link.purpose) ?? (await observer.ready())) ||
        current?.status !== 'ACKNOWLEDGED' ||
        !current.binding ||
        !sameBinding(current.binding, operation.binding) ||
        !sameTabProof(read.proof, original.intent.proof) ||
        original.intent.context.accountId !== this.context.accountId ||
        original.intent.jobId !== this.plan.id ||
        original.link.operationId !== operation.id ||
        canonicalAction(original.link.action) !== canonicalAction(current.action)
      )
        throw Error('FACEBOOK_POST_BUSINESS_ORIGINAL_BINDING_REQUIRED');
    };
    await assertCurrent();
    const verdict = PostVerdict.parse(
      await observer.verify(read.page, operation, structuredClone(original), assertCurrent),
    );
    await assertCurrent();
    return verdict;
  }
  inventory() {
    return this.connection.inventory();
  }
  async confirmTaskTab(proof: TabProof) {
    const check = async () => {
      const current = await this.current(),
        plan = await this.tasks.get(this.plan.id);
      const row = (await this.tabs.forPlan(this.plan.id)).find((item) =>
        sameTabProof(item.proof, proof),
      );
      if (
        !current ||
        !sameExecution(current, this.context) ||
        !this.failure ||
        plan.state !== 'RUNNING' ||
        plan.accountId !== this.context.accountId ||
        !this.connection.proof ||
        !sameTabProof(this.connection.proof, proof) ||
        row?.state !== 'READY' ||
        !row.context ||
        !sameExecution(row.context, current)
      )
        throw Error('FACEBOOK_MANAGED_TASK_TAB_NOT_READY');
    };
    await check();
    await this.connection.confirmTaskTab(proof);
    await check();
  }
  async readNativePostResult(
    original: FacebookPostOriginal,
    result: AcceptedNativeFacebookPost,
    guard: () => Awaitable<void>,
  ) {
    const check = async () => {
      await guard();
      await this.authority.assertIdentity(this.context.accountId);
      const plan = await this.tasks.get(this.plan.id),
        current = await this.current(),
        proof = this.connection.proof;
      const operation = await this.operation(original.link.operationId);
      const active = (await this.tasks.steps(this.plan.id)).find(
        (step) => step.id === original.intent.stepId,
      );
      const row = (await this.tabs.forPlan(this.plan.id)).find(
        (tab) => proof && sameTabProof(tab.proof, proof),
      );
      if (
        !this.failure ||
        !proof ||
        !current ||
        !sameExecution(current, this.context) ||
        !sameExecution(original.intent.context, current) ||
        !sameTabProof(original.intent.proof, proof) ||
        original.link.purpose !== 'SUBMIT' ||
        original.intent.jobId !== this.plan.id ||
        plan.state !== 'RUNNING' ||
        plan.accountId !== this.context.accountId ||
        active?.status !== 'ACTIVE' ||
        active.position !== plan.position ||
        !operation?.binding ||
        !sameExecution(operation.binding, current) ||
        operation.stepId !== original.intent.stepId ||
        !['DISPATCHING', 'ACKNOWLEDGED'].includes(operation.status) ||
        canonicalAction(operation.action) !== canonicalAction(original.link.action) ||
        row?.state !== 'READY' ||
        !row.context ||
        !sameExecution(row.context, current)
      )
        throw Error('NATIVE_RESULT_ORIGINAL_SUBMIT_REVOKED');
      return operation;
    };
    const deadline = Date.now() + 5000;
    let operation = await check();
    // A response can arrive before SDK/native/software ACK. Reading an alias never overlaps
    // the original input; it waits for that same operation, never retries the click.
    while (
      (operation.status !== 'ACKNOWLEDGED' || this.connection.executing) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      operation = await check();
    }
    if (operation.status !== 'ACKNOWLEDGED' || this.connection.executing || !operation.binding)
      return null;
    const binding = operation.binding;
    return this.connection.readPostResultAlias(
      binding,
      result.nativePostId,
      async () => {
        const pending = await check();
        if (pending.status !== 'ACKNOWLEDGED') throw Error('NATIVE_RESULT_PENDING_ACK_REQUIRED');
      },
      result.videoId,
      (effects) => matchObservedFacebookNativeResult(result, original, effects) !== null,
      async (value) => {
        await check();
        await this.tasks.noteChildPageLifecycle?.(binding, value);
      },
    );
  }
  notify(binding: Binding, resolution: Resolution) {
    return this.connection.reconcile(binding, BusinessResolution.parse(resolution));
  }
  get nativeMutationCalls() {
    return { ...this.connection.nativeMutationCalls };
  }
  get executionFailure() {
    return this.connection.executionFailure;
  }
  setFailureHandler(handler: (reason: string) => Promise<void>) {
    if (this.failure) throw Error('MANAGED_SESSION_ALREADY_OWNED');
    this.failure = handler;
  }
  async sendGuarded(operation: Operation & { binding: Binding }, guard: () => Awaitable<void>) {
    if (!this.failure) throw Error('MANAGED_LIFECYCLE_OWNER_REQUIRED');
    const action = Action.parse(operation.action),
      proof = this.connection.proof;
    if (
      !proof ||
      operation.binding.jobId !== this.plan.id ||
      !sameExecution(operation.binding, this.context) ||
      createHash('sha256').update(canonicalAction(action)).digest('hex') !==
        operation.binding.actionDigest ||
      ![
        'click',
        'activateTab',
        'typeText',
        'uploadMedia',
        'browseNavigate',
        'browseScroll',
        'browsePlay',
      ].includes(action.kind) ||
      !('tabId' in action) ||
      action.tabId !== proof.tabId
    )
      throw Error('FACEBOOK_MANAGED_ACTION_REJECTED');
    const contexts = this.connection.browser.contexts(),
      pages = contexts[0]?.pages();
    if (contexts.length !== 1 || pages?.length !== 1 || !pages[0])
      throw Error('FACEBOOK_MANAGED_PAGE_REQUIRED');
    const page = pages[0];
    const assertCurrent = async () => {
      await guard();
      await this.authority.assertIdentity(this.context.accountId);
      const context = await this.current();
      if (!context || !sameExecution(context, this.context))
        throw Error('FACEBOOK_MANAGED_CONTEXT_CHANGED');
      await this.tabs.assertForInput(operation.binding, proof);
    };
    const step = (await this.tasks.steps(this.plan.id)).find((row) => row.id === operation.stepId);
    if (!step) throw Error('FACEBOOK_MANAGED_STEP_REQUIRED');
    const post = async (): Promise<FacebookPostTarget | undefined> => {
      if (step.spec.type !== 'post') {
        if (action.kind === 'typeText' || action.kind === 'uploadMedia')
          throw Error('FACEBOOK_MATERIAL_STEP_REQUIRED');
        return undefined;
      }
      if (!this.materialInputs) throw Error('FACEBOOK_MATERIAL_INPUTS_REQUIRED');
      if (!this.authority.assertPostTarget)
        throw Error('FACEBOOK_MATERIAL_TARGET_OBSERVER_REQUIRED');
      const current = await this.materialInputs.source.current(operation.binding, assertCurrent);
      if (
        current.link.operationId !== operation.id ||
        canonicalAction(current.link.action) !== canonicalAction(action) ||
        !sameTabProof(current.intent.proof, proof)
      )
        throw Error('FACEBOOK_MATERIAL_OPERATION_MISMATCH');
      validatePostAction(current.intent, current.link.purpose, action);
      return { intent: current.intent, link: current.link };
    };
    let appliedScrollDelta = 0;
    let browseNavigation:
      | { selector: string; target: { url: string; timeOrigin: number; href: string | null } }
      | undefined;
    const pressedSettingsKeys = new Set<string>();
    let wheelStart: ReturnType<typeof BrowseWheelStart.parse> | undefined;
    const assertTarget = async (activationPreparation = false) => {
      await assertCurrent();
      const original = await post();
      const check = async () => {
        if (this.authority.assertInputTarget)
          await this.authority.assertInputTarget(
            action,
            original,
            appliedScrollDelta,
            activationPreparation,
          );
        else await this.authority.assertTarget(action, appliedScrollDelta, activationPreparation);
      };
      if (!original && (action.kind === 'browseScroll' || action.kind === 'browsePlay'))
        await waitForBrowseVisibility(
          check,
          assertCurrent,
          activationPreparation ? undefined : () => page.bringToFront(),
          async () =>
            ((await this.authority.canPresentTaskPage?.()) ??
              this.authority.foregroundAllowed?.()) === true,
          undefined,
          async (waiting) => {
            await assertCurrent();
            const reason = 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED';
            if (waiting || (await this.tasks.get(this.plan.id)).reason === reason)
              await this.tasks.noteRunningWait?.(this.plan.id, waiting ? reason : '');
          },
        );
      else await check();
      await assertCurrent();
      await post();
      if (original) {
        if (!this.authority.assertPostTarget)
          throw Error('FACEBOOK_MATERIAL_TARGET_OBSERVER_REQUIRED');
        if (!this.authority.assertInputTarget)
          await this.authority.assertPostTarget(action, structuredClone(original));
        await assertCurrent();
        await post();
        if (!this.materialInputs) throw Error('FACEBOOK_MATERIAL_INPUTS_REQUIRED');
        await this.materialInputs.composer.assert(
          page,
          action,
          structuredClone(original),
          async () => {
            await assertCurrent();
            await post();
          },
          this.postLocale,
        );
      }
      await assertCurrent();
      await post(); // A wait must not let a settled/replaced reservation regain input authority.
    };
    await assertCurrent();
    await post();
    if (action.kind === 'uploadMedia') {
      if (!this.materialInputs) throw Error('FACEBOOK_MATERIAL_INPUTS_REQUIRED');
      await assertTarget();
      const result = await this.materialInputs.upload.send(
        this.connection,
        operation.binding,
        assertCurrent,
        this.failure,
        async (command) => {
          if (command.target.tabId !== proof.tabId) throw Error('FACEBOOK_MANAGED_TARGET_CHANGED');
          await assertTarget();
        },
      );
      return { binding: result.binding, evidence: { sdkReturned: true, ownedTab: proof } };
    }
    const result = await this.connection.execute(
      operation.binding,
      async () => {
        const playbackSatisfied = (error: unknown) =>
          action.kind === 'browsePlay' &&
          error instanceof Error &&
          error.message === 'FACEBOOK_BROWSE_PLAY_ALREADY_RUNNING';
        try {
          await assertTarget(true);
        } catch (error) {
          if (!playbackSatisfied(error)) throw error;
          await assertCurrent();
          return;
        }
        const submission = await post();
        if (submission?.link.purpose === 'SUBMIT') {
          if (!this.materialInputs) throw Error('FACEBOOK_MATERIAL_INPUTS_REQUIRED');
          await this.materialInputs.submission.prepare(
            page,
            operation,
            submission,
            assertCurrent,
            async () => {
              // Network responses may arrive after the input ACK. This is a read guard, never an
              // input guard: it retains the same actor/proof/step and original pending operation.
              await this.authority.assertIdentity(this.context.accountId);
              const current = await this.current(),
                plan = await this.tasks.get(this.plan.id);
              const pending = await this.operation(operation.id);
              const owned = (await this.tabs.forPlan(this.plan.id)).find((tab) =>
                sameTabProof(tab.proof, proof),
              );
              const active = (await this.tasks.steps(this.plan.id)).find(
                (step) => step.id === operation.stepId,
              );
              if (
                !current ||
                !sameExecution(current, operation.binding) ||
                plan.state !== 'RUNNING' ||
                plan.accountId !== operation.binding.accountId ||
                active?.status !== 'ACTIVE' ||
                active.position !== plan.position ||
                !pending?.binding ||
                !sameBinding(pending.binding, operation.binding) ||
                !['DISPATCHING', 'ACKNOWLEDGED'].includes(pending.status) ||
                owned?.state !== 'READY' ||
                !owned.context ||
                !sameExecution(owned.context, current)
              )
                throw Error('ORIGINAL_PENDING_POST_OBSERVATION_REVOKED');
            },
            () => this.connection.enablePostNetworkObservation(operation.binding, assertCurrent),
          );
          await assertTarget();
        }
        if (action.kind === 'typeText') {
          if (!this.materialInputs) throw Error('FACEBOOK_MATERIAL_INPUTS_REQUIRED');
          await this.materialInputs.source.check(operation.binding, assertCurrent);
          await assertTarget();
        }
        if (
          this.visiblePointer &&
          action.kind !== 'activateTab' &&
          action.kind !== 'browseNavigate' &&
          action.kind !== 'browseScroll'
        ) {
          await page.evaluate(installAutomationPointer);
          await assertTarget();
        }
        if (action.kind === 'activateTab') await page.bringToFront();
        else if (action.kind === 'browseNavigate') {
          // Establish native presentation before navigation can enter a loading/
          // verification wait. A later wheel is not guaranteed to happen: a covered
          // destination may otherwise never become ready enough to request one.
          if (step.spec.type !== 'post') {
            await page.bringToFront();
            await assertCurrent();
          }
          const selector =
            !submission ||
            (submission.link.purpose === 'PREPARE_HOME' &&
              page.url() === 'https://www.facebook.com/')
              ? null
              : (facebookBrowseNavigationSelector(action.url) ??
                (submission.link.purpose === 'PREPARE_STORY'
                  ? facebookStoryNavigationSelector(action.url, page.url())
                  : null));
          const target = selector
            ? await readFacebookBrowseNavigation(page, selector, assertCurrent)
            : null;
          if (selector && target) {
            if (step.spec.type === 'post') await page.bringToFront();
            browseNavigation = { selector, target };
            if (step.spec.type !== 'post')
              await clickFacebookNativeTarget(page, { css: selector }, page.url(), assertCurrent, {
                scrollFallback: () =>
                  page.locator(selector).click({ timeout: 10_000, noWaitAfter: true }),
              });
            else await page.locator(selector).click({ timeout: 10_000, noWaitAfter: true });
          } else await this.connection.navigateBoundPage(operation.binding, action, page.url());
        } else if (action.kind === 'browseScroll') {
          const surface = facebookBrowseSurface(action.url);
          const feed = surface === 'feed';
          const fastScroll = surface === 'feed' || surface === 'marketplace' || surface === 'video';
          // A visible feed/marketplace page needs no repeated tab activation. This negative decision
          // grants no input: the original native guard still checks each mouse write.
          const alreadyVisible =
            fastScroll && (await page.evaluate(() => document.visibilityState === 'visible'));
          await assertCurrent();
          if (alreadyVisible !== true || this.connection.taskRendering) await page.bringToFront();
          const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          if (!fastScroll) await assertTarget();
          await assertCurrent();
          if (fastScroll) {
            await assertCurrent();
            await page.mouse.move(viewport.width / 2, viewport.height / 2);
          } else
            await this.movePointer(page, viewport.width / 2, viewport.height / 2, assertCurrent);
          let humanScroll = surface === 'marketplace';
          if (feed) {
            const before = await readFacebookBrowsePage(page, assertCurrent);
            // Every actual Input is freshly checked by the original native resource gate.
            // The read itself needs cancellation/context guards, not a duplicate full read.
            await assertCurrent();
            if (before.url !== action.url || before.timeOrigin !== action.timeOrigin)
              throw Error('FACEBOOK_WHEEL_START_DOCUMENT_CHANGED');
            humanScroll = before.recommendedDwellMs !== undefined;
            wheelStart = BrowseWheelStart.parse({
              version: 2,
              url: before.url,
              timeOrigin: before.timeOrigin,
              scrollY: before.scrollY,
              anchor:
                before.contentKey && before.contentPosition
                  ? {
                      contentId: createHash('sha256').update(before.contentKey).digest('hex'),
                      position: before.contentPosition,
                    }
                  : null,
            });
          }
          const tickCount = Math.max(1, Math.min(12, Math.ceil(Math.abs(action.deltaY) / 90)));
          const weights: number[] = fastScroll
            ? [1]
            : Array.from({ length: tickCount }, () => 1 / tickCount);
          let remainingDelta = action.deltaY;
          for (let index = 0; index < weights.length; index++) {
            await assertCurrent();
            const stepDelta =
              index + 1 === weights.length
                ? remainingDelta
                : Math.round(action.deltaY * (weights[index] ?? 1));
            remainingDelta -= stepDelta;
            await page.mouse.wheel(0, stepDelta);
            appliedScrollDelta += stepDelta;
            if (index + 1 < weights.length)
              await new Promise<void>((resolve) =>
                setTimeout(resolve, humanScroll ? Math.round(38 + Math.random() * 44) : 35),
              );
          }
        } else if (action.kind === 'browsePlay') {
          await page.bringToFront();
          try {
            await assertTarget();
            await clickFacebookNativeTarget(page, { css: action.css }, action.url, assertCurrent, {
              scrollFallback: () => page.locator(action.css).click({ timeout: 15_000 }),
            });
          } catch (error) {
            if (!playbackSatisfied(error)) throw error;
            await assertCurrent();
          }
        } else if (action.kind === 'click' || action.kind === 'typeText') {
          // Read-only bootstrap keeps its page in the background. Real SDK actionability
          // waits for painted/stable frames: activate only the original owned page, inside
          // this bound operation and through the same native purpose/identity guards.
          await page.bringToFront();
          await assertTarget();
          let locator = action.target.scope
            ? page.locator(action.target.scope).locator(action.target.css)
            : page.locator(action.target.css);
          if (action.target.text !== undefined)
            locator = locator.filter({
              hasText: new RegExp(
                '^' + action.target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
              ),
            });
          // Locator click moves the real pointer itself; a separate pre-move duplicates input.
          if (action.kind === 'typeText') await locator.fill(action.text, { timeout: 15_000 });
          else if (
            submission?.link.purpose === 'OPEN_COMPOSER' &&
            step.spec.type === 'post' &&
            step.spec.destination !== 'story'
          ) {
            // The verified HOME entry is a focusable role=button. Keyboard activation avoids
            // the page's pointer overlays without force-clicking through them. This is only
            // OPEN: submit/advance retain normal pointer actionability and input guards.
            const visible = await locator.isVisible();
            const enabled = await locator.isEnabled();
            await assertTarget();
            if (!visible || !enabled) throw Error('FACEBOOK_COMPOSER_ENTRY_UNAVAILABLE');
            await locator.press('Enter', { timeout: 15_000 });
          } else if (
            submission &&
            ['OPEN_AUDIENCE', 'CONFIRM_AUDIENCE', 'OPEN_BACKGROUND', 'SET_BACKGROUND'].includes(
              submission.link.purpose,
            )
          ) {
            const visible = await locator.isVisible(),
              enabled = await locator.isEnabled();
            await assertTarget();
            if (!visible || !enabled) throw Error('FACEBOOK_POST_CONFIGURATION_TARGET_UNAVAILABLE');
            await locator.press('Enter', { timeout: 15_000 });
          } else if (step.spec.type !== 'post')
            await clickFacebookNativeTarget(page, action.target, page.url(), assertCurrent, {
              scrollFallback: () => locator.click({ timeout: 15_000 }),
            });
          else await locator.click({ timeout: 15_000 });
        }
      },
      assertCurrent,
      this.failure,
      async (command) => {
        await assertCurrent();
        if (command.target.tabId !== proof.tabId) throw Error('FACEBOOK_MANAGED_TARGET_CHANGED');
        const original = await post();
        const key =
          original &&
          command.method === 'Input.dispatchKeyEvent' &&
          [
            'OPEN_COMPOSER',
            'OPEN_AUDIENCE',
            'CONFIRM_AUDIENCE',
            'OPEN_BACKGROUND',
            'SET_BACKGROUND',
          ].includes(original.link.purpose)
            ? JSON.stringify([
                command.target,
                command.params.code ?? null,
                command.params.key ?? null,
                command.params.windowsVirtualKeyCode ?? null,
                command.params.nativeVirtualKeyCode ?? null,
              ])
            : null;
        if (
          key &&
          command.params.type === 'keyUp' &&
          pressedSettingsKeys.has(key) &&
          this.authority.refreshIdentity &&
          this.materialInputs?.composer.assertRelease &&
          original
        ) {
          // Complete this operation's already-approved key press. The UI may now show its
          // effect, so the old button's precondition is no longer the release condition.
          await this.authority.refreshIdentity(page, assertCurrent);
          await assertCurrent();
          await post();
          await this.materialInputs.composer.assertRelease(page, action, original, assertCurrent);
          await assertCurrent();
          await post();
          pressedSettingsKeys.delete(key);
          return;
        }
        await assertTarget(command.method === 'Page.bringToFront');
        if (browseNavigation) {
          const target = await readFacebookBrowseNavigation(
            page,
            browseNavigation.selector,
            assertCurrent,
          );
          if (
            !target ||
            target.url !== browseNavigation.target.url ||
            target.timeOrigin !== browseNavigation.target.timeOrigin ||
            target.href !== browseNavigation.target.href
          )
            throw Error('FACEBOOK_NATIVE_NAVIGATION_TARGET_CHANGED');
        }
        const submission = await post();
        if (submission?.link.purpose === 'SUBMIT') {
          if (!this.materialInputs) throw Error('FACEBOOK_MATERIAL_INPUTS_REQUIRED');
          await this.materialInputs.submission.assert(page, operation, submission, assertCurrent);
        }
        if (key && ['keyDown', 'rawKeyDown'].includes(String(command.params.type))) {
          if (pressedSettingsKeys.size >= 16) throw Error('POST_SETTINGS_KEY_SEQUENCE_LIMIT');
          pressedSettingsKeys.add(key);
        }
      },
    );
    // SDK completion is an input acknowledgement only; the business observer must verify it.
    return {
      binding: result.binding,
      evidence: { sdkReturned: true, ownedTab: proof, ...(wheelStart ? { wheelStart } : {}) },
    };
  }
  private async stopOwned(input: StopBinding, retry: boolean) {
    await this.materialInputs?.submission.stop?.();
    const binding = SessionStopBinding.parse(input);
    if (!sameExecution(binding, this.context)) throw Error('MANAGED_STOP_CONTEXT_MISMATCH');
    if (this.stopReceipt) {
      if (!sameStop(this.stopReceipt, binding)) throw Error('MANAGED_STOP_REQUEST_CONFLICT');
      return structuredClone(this.stopReceipt);
    }
    const current = await this.current();
    if (current && !sameExecution(current, this.context))
      throw Error('MANAGED_STOP_CONTEXT_REPLACED');
    const clean = !(await this.tasks.operations(this.plan.id)).some((op) =>
      ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
    );
    const keep =
      !retry &&
      clean &&
      (await this.profile()).online &&
      this.connection.retainsPage &&
      !this.connection.executing &&
      // Cancelling an in-flight SDK read can fence its Runtime result. Keep the
      // owned page, but close that session instead of regranting it as healthy.
      !this.connection.hasPendingCommands &&
      !this.connection.failureReason;
    const receipt = await (keep
      ? this.connection.park(binding.requestId)
      : retry
        ? this.connection.retryClose(binding.requestId)
        : this.connection.close(binding.requestId));
    this.stopReceipt = SessionStopReceipt.parse({ ...binding, state: receipt.state });
    const inventory = keep ? await this.connection.inventory() : this.connection.closedInventory,
      proof = this.connection.proof;
    if (
      !inventory ||
      !proof ||
      receipt.state !== 'stopped' ||
      receipt.requestId !== binding.requestId
    )
      throw Error('FACEBOOK_MANAGED_RELEASE_UNCONFIRMED');
    const plan = await this.tasks.get(this.plan.id);
    // Admission can be revoked before the registry persists a formal control binding.
    // Its private physical stop is real, but cannot confirm or release that original request.
    const formalRelease =
      plan.state === 'COMPLETED' ||
      (plan.state === 'FAILED' && plan.reason === 'PARTIAL_STEP_FAILURE') ||
      (['PAUSING', 'STOPPING', 'PAUSED', 'STOPPED'].includes(plan.state) &&
        plan.controlRequestId === binding.requestId);
    for (const row of await this.tabs.forPlan(this.plan.id))
      if (
        sameTabProof(row.proof, proof) &&
        ['READY', 'RECHECK_REQUIRED'].includes(row.state) &&
        !(await this.tasks.operations(this.plan.id)).some((op) =>
          ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
        )
      )
        if (
          inventory.tabs.some(
            (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, proof),
          )
        ) {
          if (!formalRelease) continue;
          if (!this.tabs.confirmReleased) throw Error('FACEBOOK_PAGE_RELEASE_REPOSITORY_REQUIRED');
          await this.tabs.confirmReleased(
            proof.ownershipId,
            row.revision,
            inventory,
            SessionStopReceipt.parse({ ...binding, state: receipt.state }),
            this.plan.id,
          );
        } else
          await this.tabs.confirmClosed(proof.ownershipId, row.revision, inventory, this.plan.id);
    return SessionStopReceipt.parse({ ...binding, state: receipt.state });
  }
  stop(binding: StopBinding) {
    return this.stopOwned(binding, false);
  }
  retryStop(binding: StopBinding) {
    return this.stopOwned(binding, true);
  }
}
