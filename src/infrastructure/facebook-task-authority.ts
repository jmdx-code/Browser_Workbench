import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { BROWSE_VISIBILITY_WAIT } from './facebook-browse-visibility.js';
import { profileForegroundGranted } from '../shared/profile-foreground.js';
import type { Core, Peer } from '../bridge/core.js';
import type { TaskRepository, RuntimeProfile } from '../domain/tasks.js';
import type { Plan } from '../shared/task-contracts.js';
import { canonicalAction, type Action } from '../shared/browser-actions.js';
import type { TabProof } from '../shared/kernel-state.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type {
  FacebookTaskAuthority,
  FacebookPostTarget,
} from './kernel-managed-facebook-session.js';
import type { KernelProfileInspection } from './kernel-profile-inspection.js';
import { readCurrentFacebookIdentity } from './facebook-current-identity.js';
import { readCurrentFacebookStoryIdentity } from './facebook-story-identity.js';
import { readFacebookPostPage } from './facebook-post-page-reader.js';
import { validatePostAction } from '../domain/material-post.js';
import {
  readCurrentFacebookBrowseIdentity,
  readCurrentFacebookBrowseSample,
} from './facebook-browse-identity.js';
import {
  readFacebookBrowsePage,
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  browsePageDiagnostic,
} from './facebook-browse-reader.js';
import { taskTimingEligibility } from '../domain/task-timing.js';
import { readFacebookHomePreparation } from './facebook-home-preparation.js';
import {
  facebookBrowseSurface,
  facebookMarketplaceItemURL,
  matchesMarketplaceSearch,
  marketplaceBootstrap,
} from '../shared/facebook-browse-route.js';

type Bootstrap = NonNullable<Awaited<ReturnType<KernelProfileInspection['readQueuedNativeActor']>>>;

// Private composition only: no renderer field can create this authority. The fresh bootstrap
// permits SDK creation; each native Input's existing async resource guard re-reads this page.
export class NativeFacebookTaskAuthority implements FacebookTaskAuthority {
  private owned: { page: Page; proof: TabProof } | null = null;
  private revoked = false;
  private revocationReason: string | undefined;
  constructor(
    private readonly core: Core,
    private readonly peer: Peer,
    private readonly tasks: TaskRepository,
    private readonly plan: Plan,
    private readonly bootstrap: Bootstrap,
    private readonly now = Date.now,
    private readonly readIdentity = readCurrentFacebookIdentity,
    private readonly storyAuthorized: (plan: Plan) => Awaitable<boolean> = () => false,
  ) {
    this.plan = structuredClone(plan);
    this.bootstrap = structuredClone(bootstrap);
    if (
      bootstrap.connection.profileId !== peer.profileId ||
      bootstrap.connection.connectionEpoch !== peer.epoch ||
      bootstrap.actor.accountId !== plan.accountId ||
      plan.profileId !== peer.profileId ||
      (!('passive' in bootstrap && bootstrap.passive) &&
        (bootstrap.closedRecord?.state !==
          ('retained' in bootstrap && bootstrap.retained ? 'READY' : 'CLOSED') ||
          bootstrap.stop?.state !== 'stopped' ||
          !bootstrap.closedRecord.proof ||
          !bootstrap.proof ||
          !sameTabProof(bootstrap.proof, bootstrap.closedRecord.proof))) ||
      now() < bootstrap.actor.checkedAt ||
      now() - bootstrap.actor.checkedAt > 30_000
    )
      throw Error('FACEBOOK_FRESH_BOOTSTRAP_REQUIRED');
    // Construction stores evidence only. Every authority entry point below awaits
    // the current durable plan and local revocation checks before granting use.
  }
  private async assertLive() {
    const current = await this.tasks.get(this.plan.id);
    if (
      this.revoked ||
      this.core.peers.get(this.peer.profileId) !== this.peer ||
      this.peer.epoch !== this.bootstrap.connection.connectionEpoch ||
      !this.peer.online ||
      !this.peer.synced ||
      this.peer.phase !== 'PAUSED' ||
      current.profileId !== this.peer.profileId ||
      current.accountId !== this.bootstrap.actor.accountId ||
      !['RUNNING', 'REVIEW', 'PAUSING', 'STOPPING'].includes(current.state) ||
      (!this.owned &&
        (this.now() < this.bootstrap.actor.checkedAt ||
          this.now() - this.bootstrap.actor.checkedAt > 60_000))
    )
      throw Error('FACEBOOK_NATIVE_AUTHORITY_REVOKED');
  }
  async assertIdentity(accountId: string) {
    await this.assertLive();
    if (accountId !== this.bootstrap.actor.accountId)
      throw Error('FACEBOOK_NATIVE_ACCOUNT_MISMATCH');
  }
  async profile(): Promise<RuntimeProfile> {
    let allowed = true;
    try {
      await this.assertLive();
    } catch {
      allowed = false;
    }
    return {
      id: this.peer.profileId,
      online: this.peer.online,
      synced: this.peer.synced,
      unresolved: (await this.core.store.unresolved(this.peer.profileId)).length,
      dispatchAllowed: allowed,
      ...(!allowed
        ? { unreadyReason: this.revocationReason ?? 'FACEBOOK_NATIVE_AUTHORITY_REVOKED' }
        : {}),
      account: {
        state: 'logged-in',
        id: this.bootstrap.actor.accountId,
        name: this.bootstrap.actor.name,
        avatar: null,
      },
    };
  }
  async bindPage(page: Page, proof: TabProof) {
    await this.assertLive();
    if (
      this.owned ||
      proof.profileId !== this.peer.profileId ||
      (this.bootstrap.proof &&
        ('retained' in this.bootstrap && this.bootstrap.retained
          ? !sameTabProof(proof, this.bootstrap.proof)
          : sameTabProof(proof, this.bootstrap.proof)))
    )
      throw Error('FACEBOOK_NEW_TASK_IDENTITY_PAGE_REQUIRED');
    this.owned = { page, proof: structuredClone(proof) };
    await this.refreshIdentity(page, async () => await this.assertLive(), true);
  }
  admissionTab() {
    return 'retained' in this.bootstrap && this.bootstrap.retained
      ? (this.bootstrap.proof ?? undefined)
      : undefined;
  }
  foregroundAllowed() {
    return profileForegroundGranted(this.peer, this.now());
  }
  async canPresentTaskPage() {
    await this.assertLive();
    return (
      this.foregroundAllowed() ||
      this.peer.capabilities?.includes('kernel-background-presentation-v1') === true
    );
  }
  async refreshIdentity(page: Page, assertCurrent: () => Awaitable<void>, pagePreparation = false) {
    await this.assertLive();
    await assertCurrent();
    if (!this.owned || this.owned.page !== page)
      throw Error('FACEBOOK_OWNED_IDENTITY_PAGE_REQUIRED');
    try {
      const step = (await this.tasks.steps(this.plan.id)).find((s) => s.status === 'ACTIVE');
      const reader =
        step?.spec.type === 'post' &&
        step.spec.destination === 'story' &&
        [
          'https://www.facebook.com/stories/create/',
          'https://www.facebook.com/stories/create',
        ].includes(page.url())
          ? readCurrentFacebookStoryIdentity
          : step?.spec.type === 'post' &&
              (!pagePreparation || page.url() === 'https://www.facebook.com/post/create')
            ? this.readIdentity
            : readCurrentFacebookBrowseIdentity;
      const current = await reader(page, async () => {
        await this.assertLive();
        await assertCurrent();
      });
      await this.assertLive();
      await assertCurrent();
      if (current.actor.accountId !== this.bootstrap.actor.accountId)
        throw Error('FACEBOOK_NATIVE_ACCOUNT_CHANGED');
      this.bootstrap.actor.checkedAt = this.now();
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : '';
      this.revocationReason ??= /^[A-Z][A-Z0-9_:|.-]{0,199}$/.test(reason)
        ? reason
        : 'FACEBOOK_IDENTITY_READ_FAILED';
      this.revoked = true;
      throw error;
    }
  }
  async readBrowsePage(page: Page, guard: () => Awaitable<void>, inputFence = false) {
    await this.assertLive();
    await guard();
    if (!this.owned || this.owned.page !== page)
      throw Error('FACEBOOK_OWNED_IDENTITY_PAGE_REQUIRED');
    try {
      const sample = await readCurrentFacebookBrowseSample(
        page,
        async () => {
          await this.assertLive();
          await guard();
        },
        inputFence,
      );
      if (inputFence && !sample.actor) throw Error('FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED');
      if (sample.actor && sample.actor.accountId !== this.bootstrap.actor.accountId)
        throw Error('FACEBOOK_NATIVE_ACCOUNT_CHANGED');
      return sample.page;
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : '';
      this.revocationReason ??= /^[A-Z][A-Z0-9_:|.-]{0,199}$/.test(reason)
        ? reason
        : 'FACEBOOK_BROWSE_READ_FAILED';
      this.revoked = true;
      throw error;
    }
  }
  private async timingAllowsOriginalOperation(action: Action) {
    if (taskTimingEligibility(this.plan.timing, this.now(), true) === 'OPEN') return true;
    const current = await this.tasks.get(this.plan.id);
    if (current.state !== 'RUNNING' || current.controlMode) return false;
    const active = (await this.tasks.steps(this.plan.id)).find((step) => step.status === 'ACTIVE');
    const original = (await this.tasks.operations(this.plan.id)).filter(
      (op) =>
        op.status === 'DISPATCHING' &&
        op.stepId === active?.id &&
        op.binding?.jobId === this.plan.id &&
        op.binding.profileId === this.peer.profileId &&
        op.binding.accountId === this.bootstrap.actor.accountId &&
        op.binding.connectionEpoch === this.peer.epoch &&
        op.createdAt <= this.now() &&
        canonicalAction(op.action) === canonicalAction(action) &&
        taskTimingEligibility(this.plan.timing, op.createdAt, true) === 'OPEN',
    );
    // A wheel gesture/key sequence/upload already dispatched inside the window is
    // one atomic operation. Finish it; the runner refuses every subsequent operation.
    return original.length === 1;
  }
  async assertTarget(action: Action, appliedScrollDelta = 0, activationPreparation = false) {
    await this.assertLive();
    if (!(await this.timingAllowsOriginalOperation(action))) throw Error('SCHEDULE_WINDOW_CLOSED');
    if (
      !this.owned ||
      !('tabId' in action) ||
      action.tabId !== this.owned.proof.tabId ||
      ![
        'click',
        'typeText',
        'uploadMedia',
        'activateTab',
        'browseNavigate',
        'browseScroll',
        'browsePlay',
      ].includes(action.kind)
    )
      throw Error('FACEBOOK_NATIVE_TARGET_REQUIRED');
    const active = (await this.tasks.steps(this.plan.id)).find((step) => step.status === 'ACTIVE');
    const feedInput =
      action.kind === 'browseScroll' &&
      (active?.spec.type === 'feed' ||
        active?.spec.type === 'marketplace' ||
        active?.spec.type === 'video') &&
      facebookBrowseSurface(action.url) === active.spec.type
        ? await this.readBrowsePage(this.owned.page, async () => await this.assertLive(), true)
        : null;
    if (!feedInput)
      await this.refreshIdentity(this.owned.page, async () => await this.assertLive());
    if (
      (await this.tasks.steps(this.plan.id)).some(
        (step) =>
          step.status === 'ACTIVE' &&
          step.spec.type === 'post' &&
          step.spec.destination === 'story',
      )
    )
      throw Error('FACEBOOK_STORY_EXECUTOR_REQUIRED');
    if (action.kind === 'click' && action.target.css === FACEBOOK_REEL_NEXT_CSS) {
      const step = (await this.tasks.steps(this.plan.id)).find((s) => s.status === 'ACTIVE');
      const current = await readFacebookBrowsePage(
        this.owned.page,
        async () => await this.assertLive(),
      );
      if (
        step?.spec.type !== 'video' ||
        action.target.scope !== undefined ||
        action.target.text !== undefined ||
        action.documentEpoch !== 0 ||
        action.routeEpoch !== 0 ||
        facebookBrowseSurface(current.url) !== 'video' ||
        !current.ready ||
        (!current.visible && !(activationPreparation && (await this.canPresentTaskPage()))) ||
        current.blocked ||
        !current.video ||
        current.nextReelCSS !== FACEBOOK_REEL_NEXT_CSS
      )
        throw Error('FACEBOOK_REEL_NEXT_TARGET_CHANGED');
    }
    if (action.kind === 'click' && action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS) {
      const step = (await this.tasks.steps(this.plan.id)).find((s) => s.status === 'ACTIVE');
      const current = await readFacebookBrowsePage(
        this.owned.page,
        async () => await this.assertLive(),
      );
      if (
        step?.spec.type !== 'friends' ||
        step.spec.maxLikes > 0 ||
        action.target.scope !== undefined ||
        action.target.text !== undefined ||
        action.documentEpoch !== 0 ||
        action.routeEpoch !== 0 ||
        facebookBrowseSurface(current.url) !== 'friends' ||
        !/^\/friends\/requests\/?$/.test(new URL(current.url).pathname) ||
        !current.ready ||
        (!current.visible && !(activationPreparation && (await this.canPresentTaskPage()))) ||
        current.blocked ||
        current.friendConfirmCSS !== FACEBOOK_FRIEND_CONFIRM_CSS
      )
        throw Error('FACEBOOK_FRIEND_CONFIRM_TARGET_CHANGED');
    }
    if (action.kind === 'click' && action.target.css === FACEBOOK_BROWSE_LIKE_CSS) {
      const step = (await this.tasks.steps(this.plan.id)).find((s) => s.status === 'ACTIVE');
      const current = await readFacebookBrowsePage(
        this.owned.page,
        async () => await this.assertLive(),
      );
      if (
        (step?.spec.type !== 'feed' && step?.spec.type !== 'video') ||
        step.spec.maxLikes <= 0 ||
        step.progress.likes >= step.spec.maxLikes ||
        action.target.scope !== undefined ||
        action.target.text !== undefined ||
        action.documentEpoch !== 0 ||
        action.routeEpoch !== 0 ||
        facebookBrowseSurface(current.url) !== step.spec.type ||
        !current.ready ||
        (!current.visible && !(activationPreparation && (await this.canPresentTaskPage()))) ||
        current.blocked ||
        current.likeTarget?.css !== FACEBOOK_BROWSE_LIKE_CSS
      )
        throw Error('FACEBOOK_BROWSE_LIKE_TARGET_CHANGED');
    }
    if (['browseNavigate', 'browseScroll', 'browsePlay'].includes(action.kind)) {
      const step = (await this.tasks.steps(this.plan.id)).find((s) => s.status === 'ACTIVE');
      if (
        !step ||
        step.spec.type === 'post' ||
        (step.spec.maxLikes > 0 && !['feed', 'video'].includes(step.spec.type))
      )
        throw Error('FACEBOOK_BROWSE_STEP_REQUIRED');
      if (action.kind === 'browseNavigate') {
        if (facebookBrowseSurface(action.url) !== step.spec.type)
          throw Error('FACEBOOK_BROWSE_NAVIGATION_REJECTED');
        if (step.spec.type === 'marketplace') {
          const item = facebookMarketplaceItemURL(action.url);
          if (item) {
            const current = await readFacebookBrowsePage(
              this.owned.page,
              async () => await this.assertLive(),
            );
            if (
              item !== action.url ||
              !matchesMarketplaceSearch(current.url, step.spec) ||
              !current.ready ||
              !current.visible ||
              current.blocked ||
              !current.marketplaceItems?.includes(item)
            )
              throw Error('FACEBOOK_MARKETPLACE_ITEM_TARGET_CHANGED');
          } else if (
            !matchesMarketplaceSearch(action.url, step.spec) &&
            !marketplaceBootstrap(action.url, step.spec)
          )
            throw Error('FACEBOOK_MARKETPLACE_SEARCH_TARGET_CHANGED');
        }
      } else if (action.kind === 'browseScroll' || action.kind === 'browsePlay') {
        const current =
          feedInput ??
          (await readFacebookBrowsePage(this.owned.page, async () => await this.assertLive()));
        const inputFence =
          action.kind === 'browseScroll'
            ? {
                fromY: action.fromY,
                requestedDelta: action.deltaY,
                appliedDelta: Number.isFinite(appliedScrollDelta) ? appliedScrollDelta : null,
                positionMatches:
                  current.scrollY >=
                    Math.max(0, action.fromY + Math.min(0, appliedScrollDelta)) - 2 &&
                  current.scrollY <= action.fromY + Math.max(0, appliedScrollDelta) + 2,
                movementValid:
                  Number.isFinite(appliedScrollDelta) &&
                  (Math.sign(appliedScrollDelta) === 0 ||
                    Math.sign(appliedScrollDelta) === Math.sign(action.deltaY)) &&
                  Math.abs(appliedScrollDelta) <= Math.abs(action.deltaY) + 0.001,
                sameUrl: current.url === action.url,
                sameTimeOrigin: current.timeOrigin === action.timeOrigin,
              }
            : undefined;
        if (
          facebookBrowseSurface(current.url) !== step.spec.type ||
          action.url !== current.url ||
          current.timeOrigin !== action.timeOrigin ||
          !current.ready ||
          current.blocked ||
          (inputFence &&
            (!inputFence.movementValid ||
              (!['feed', 'marketplace', 'video'].includes(step.spec.type) &&
                !inputFence.positionMatches))) ||
          (action.kind === 'browsePlay' &&
            (step.spec.type !== 'video' ||
              current.video?.css !== action.css ||
              current.video.source !== action.source ||
              current.video.readyState === 0 ||
              current.video.failed === true ||
              current.video.ended))
        ) {
          if (inputFence || action.kind === 'browsePlay') {
            // Keep the last rejected read on the original task, even when the SDK
            // returns only a protocol-error string. Diagnostics never relax the guard.
            try {
              await this.assertLive();
              const op = (await this.tasks.operations(this.plan.id)).find(
                (row) =>
                  row.stepId === step.id &&
                  ['DISPATCHING', 'ACKNOWLEDGED'].includes(row.status) &&
                  row.binding &&
                  canonicalAction(row.action) === canonicalAction(action),
              );
              if (op?.binding) {
                const { profileId, accountId, connectionEpoch, leaseId, generation } = op.binding;
                await this.tasks.noteBrowseReadFailure(
                  this.plan.id,
                  step.id,
                  { profileId, accountId, connectionEpoch, leaseId, generation },
                  'FACEBOOK_BROWSE_DOCUMENT_OR_TARGET_CHANGED',
                  { ...browsePageDiagnostic(current), inputFence },
                  'input-fence',
                );
              }
            } catch {}
          }
          throw Error('FACEBOOK_BROWSE_DOCUMENT_OR_TARGET_CHANGED');
        }
        if (!current.visible && !(activationPreparation && (await this.canPresentTaskPage())))
          throw Error(BROWSE_VISIBILITY_WAIT);
        if (
          action.kind === 'browsePlay' &&
          current.visible &&
          current.video &&
          !current.video.paused
        )
          throw Error('FACEBOOK_BROWSE_PLAY_ALREADY_RUNNING');
      }
    }
  }
  async assertPostTarget(action: Action, post: FacebookPostTarget) {
    await this.assertLive();
    if (!this.owned) throw Error('FACEBOOK_NATIVE_TARGET_REQUIRED');
    await this.refreshIdentity(
      this.owned.page,
      async () => await this.assertLive(),
      post.link.purpose === 'PREPARE_HOME',
    );
    await this.assertOriginalPostTarget(action, post);
  }
  async assertInputTarget(
    action: Action,
    post: FacebookPostTarget | undefined,
    appliedScrollDelta: number,
    activationPreparation = false,
  ) {
    const active = (await this.tasks.steps(this.plan.id)).find((step) => step.status === 'ACTIVE');
    if (post && active?.spec.type === 'post' && active.spec.destination === 'story') {
      await this.assertLive();
      if (
        !(await this.storyAuthorized(await this.tasks.get(this.plan.id))) ||
        !this.owned ||
        !(await this.timingAllowsOriginalOperation(action))
      )
        throw Error('STORY_INPUT_AUTHORIZATION_REQUIRED');
      await this.refreshIdentity(
        this.owned.page,
        async () => await this.assertLive(),
        post.link.purpose === 'PREPARE_STORY',
      );
      await this.assertLive();
      await this.assertOriginalPostTarget(action, post);
      return;
    }
    if (post?.link.purpose === 'PREPARE_HOME') {
      await this.assertLive();
      if (!this.owned) throw Error('FACEBOOK_NATIVE_TARGET_REQUIRED');
      const step = (await this.tasks.steps(this.plan.id)).find((item) => item.status === 'ACTIVE');
      if (
        step?.spec.type !== 'post' ||
        step.spec.destination === 'story' ||
        !(await this.timingAllowsOriginalOperation(action))
      )
        throw Error('POST_HOME_PREPARATION_STEP_REVOKED');
      await this.refreshIdentity(this.owned.page, async () => await this.assertLive(), true);
    } else await this.assertTarget(action, appliedScrollDelta, activationPreparation);
    await this.assertLive();
    if (post) await this.assertOriginalPostTarget(action, post);
  }
  private async assertOriginalPostTarget(action: Action, post: FacebookPostTarget) {
    await this.assertLive();
    if (
      !this.owned ||
      post.intent.jobId !== this.plan.id ||
      post.intent.context.accountId !== this.bootstrap.actor.accountId ||
      !sameTabProof(post.intent.proof, this.owned.proof)
    )
      throw Error('FACEBOOK_NATIVE_ORIGINAL_POST_REQUIRED');
    validatePostAction(post.intent, post.link.purpose, action);
    const active = (await this.tasks.steps(this.plan.id)).find(
      (step) => step.id === post.intent.stepId && step.status === 'ACTIVE',
    );
    if (active?.spec.type === 'post' && active.spec.destination === 'story') {
      if (!(await this.storyAuthorized(await this.tasks.get(this.plan.id))))
        throw Error('STORY_INPUT_AUTHORIZATION_REQUIRED');
      return;
    }
    if (post.link.purpose === 'PREPARE_HOME') {
      const preparation = await readFacebookHomePreparation(
        this.owned.page,
        async () => await this.assertLive(),
      );
      await this.assertLive();
      if (!preparation.safe) throw Error('POST_HOME_PREPARATION_BLOCKED');
    }
    if (post.link.purpose === 'OPEN_COMPOSER') {
      const home = await readFacebookPostPage(
        this.owned.page,
        undefined,
        async () => await this.assertLive(),
      );
      await this.assertLive();
      if (
        !home.opener ||
        !('target' in action) ||
        action.target.scope !== home.opener.scope ||
        action.target.css !== home.opener.css ||
        action.target.text !== home.opener.text
      )
        throw Error('FACEBOOK_NATIVE_COMPOSER_ENTRY_MISMATCH');
    }
  }
}
