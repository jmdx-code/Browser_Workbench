import type { Awaitable } from '../domain/persistence.js';
import { createHash } from 'node:crypto';
import type { BrowseStepExecutor, StepExecution } from '../domain/browse-execution.js';
import type { ExecutionSession } from '../shared/task-execution.js';
import { sameExecution, sameBinding, BoundReceipt } from '../shared/task-execution.js';
import type { TabProof } from '../shared/kernel-state.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type { BrowseReading, Decision, Intent, Verdict } from '../shared/browse-execution.js';
import {
  BrowseReadTimeout,
  BrowseWheelStart,
  BrowsePendingDiagnostic,
} from '../shared/browse-execution.js';
import type { Operation } from '../shared/task-contracts.js';
import type { Binding } from '../shared/task-execution.js';
import {
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  browsePageDiagnostic,
  type BrowsePage,
} from './facebook-browse-reader.js';
import {
  facebookBrowseSurface,
  facebookMarketplaceUnavailableURL,
  facebookMarketplaceURL,
  facebookMarketplaceItemURL,
  matchesMarketplaceSearch,
  marketplaceBootstrap,
  MARKETPLACE_HOME,
  FACEBOOK_FRIENDS_REQUESTS_URL,
} from '../shared/facebook-browse-route.js';
import { FRIENDS_EXHAUSTED_CURSOR } from '../domain/tasks.js';
import { devDiag } from '../shared/dev-diagnostics.js';

export interface FacebookBrowseSource {
  foregroundAllowed?(
    execution: StepExecution,
    guard: () => Awaitable<void>,
  ): Awaitable<boolean | undefined>;
  canPresentTaskPage?(
    execution: StepExecution,
    guard: () => Awaitable<void>,
  ): Awaitable<boolean | undefined>;
  read(
    execution: StepExecution,
    guard: () => Awaitable<void>,
  ): Promise<{
    context: ExecutionSession;
    proof: TabProof;
    page: BrowsePage;
    foregroundAllowed?: boolean;
    canPresentTaskPage?: boolean;
  }>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Feed/video/marketplace/friends reuse the existing runner, actor, outbox and progress. This adapter
// only returns decisions and reads effects; all actual input is dispatched by the original bound operation.
export class FacebookBrowseStepExecutor implements BrowseStepExecutor {
  private readonly foregroundWaits = new Map<
    string,
    { jobId: string; stepId: string; context: ExecutionSession; readAt: number }
  >();
  private readonly dwells = new Map<
    string,
    {
      stepId: string;
      contentId: string;
      since: number;
      observations: number;
      targetDwellMs: number;
    }
  >();
  private readonly waits = new Map<string, { stepId: string; since: number }>();
  private readonly viewedItems = new Map<string, { stepId: string; items: Set<string> }>();
  private readonly marketplaceTargets = new Map<string, { stepId: string; url: string }>();
  private readonly likeStates = new Map<
    string,
    { stepId: string; evaluated: Set<string>; lastLikeAt: number }
  >();
  private readonly likeVerifyWaits = new Map<string, { operationId: string; since: number }>();
  constructor(
    readonly type: 'feed' | 'video' | 'marketplace' | 'friends',
    private readonly source: FacebookBrowseSource,
    private readonly accepted: () => boolean = () => false,
    private readonly now = performance.now.bind(performance),
    private readonly observed?: (execution: StepExecution, page: BrowsePage) => void,
    private readonly hasAccountLiked?: (
      accountId: string | null,
      contentId: string,
    ) => Awaitable<boolean>,
    private readonly random: () => number = Math.random,
  ) {}
  available() {
    return this.accepted();
  }
  private contentId(page: BrowsePage) {
    if (this.type === 'friends' && page.contentKey === 'FRIENDS_REQUESTS_EXHAUSTED')
      return FRIENDS_EXHAUSTED_CURSOR;
    return hash(
      page.url +
        '|' +
        page.timeOrigin +
        '|' +
        (page.contentKey ?? (this.type === 'feed' ? 'feed-viewport' : page.scrollY)),
    );
  }
  private defaultDwellMs(page: BrowsePage) {
    if (page.recommendedDwellMs !== undefined) return page.recommendedDwellMs;
    if (this.type === 'video') return 30000;
    if (this.type === 'friends') return 2000;
    return page.contentKey ? 8000 : 5000;
  }
  private diagnostic(page: BrowsePage) {
    return browsePageDiagnostic(page);
  }
  private wait(
    execution: StepExecution,
    reason: string,
    page?: BrowsePage,
    diagPage?: BrowsePage,
  ): Decision {
    const key = execution.plan.profileId,
      at = this.now(),
      previous = this.waits.get(key),
      infoPage = page ?? diagPage;
    if (!previous || previous.stepId !== execution.step.id || at < previous.since)
      this.waits.set(key, { stepId: execution.step.id, since: at });
    else if (at - previous.since >= 30000) {
      devDiag.clearWait(`browse-wait:${key}`);
      devDiag.record({
        level: 'ERROR',
        category: 'BROWSE_DECISION',
        event: 'BROWSE_DECIDE_WAIT_TIMEOUT',
        profileId: key,
        planId: execution.plan.id,
        stepId: execution.step.id,
        stepType: this.type,
        reason: reason + '_TIMEOUT',
        data: infoPage ? this.diagnostic(infoPage) : undefined,
      });
      if (page) throw new BrowseReadTimeout(reason + '_TIMEOUT', this.diagnostic(page));
      throw Error(reason + '_TIMEOUT');
    }
    const elapsedMs =
      previous && previous.stepId === execution.step.id && at >= previous.since
        ? Math.round(at - previous.since)
        : 0;
    devDiag.recordWait(
      `browse-wait:${key}`,
      {
        level: 'WAIT',
        category: 'BROWSE_DECISION',
        event: 'BROWSE_DECIDE_WAIT',
        profileId: key,
        planId: execution.plan.id,
        stepId: execution.step.id,
        stepType: this.type,
        reason,
        data: {
          elapsedMs,
          url: infoPage?.url ?? null,
          ready: infoPage?.ready ?? null,
          visible: infoPage?.visible ?? null,
          blocked: infoPage?.blocked ?? null,
          scrollY: infoPage?.scrollY ?? null,
          scrollMaxY: infoPage?.scrollMaxY ?? null,
          hasContentKey: Boolean(infoPage?.contentKey),
          mainCount: infoPage?.structure?.mainCount ?? null,
          marketplaceItems: infoPage?.marketplaceItems?.length ?? null,
        },
      },
      5_000,
    );
    return { kind: 'wait', reason };
  }
  private async read(execution: StepExecution, guard: () => Awaitable<void>) {
    await guard();
    if (!this.available() || execution.step.spec.type !== this.type)
      throw Error('BROWSE_EXECUTOR_UNAVAILABLE');
    const reading = await this.source.read(execution, guard);
    await guard();
    if (
      !sameExecution(reading.context, execution.session) ||
      reading.proof.profileId !== execution.plan.profileId
    )
      throw Error('BROWSE_ORIGINAL_OWNER_REQUIRED');
    this.observed?.(execution, structuredClone(reading.page));
    if (
      !['marketplace', 'friends'].includes(this.type) &&
      !reading.page.visible &&
      reading.page.ready &&
      !reading.page.blocked &&
      facebookBrowseSurface(reading.page.url) &&
      reading.foregroundAllowed === false &&
      reading.canPresentTaskPage !== true
    )
      this.foregroundWaits.set(execution.plan.profileId, {
        jobId: execution.plan.id,
        stepId: execution.step.id,
        context: structuredClone(execution.session),
        readAt: this.now(),
      });
    else this.foregroundWaits.delete(execution.plan.profileId);
    return reading;
  }
  async decide(execution: StepExecution, guard: () => Awaitable<void>): Promise<Decision> {
    await guard();
    if (!this.available() || execution.step.spec.type !== this.type)
      throw Error('BROWSE_EXECUTOR_UNAVAILABLE');
    const denied = this.foregroundWaits.get(execution.plan.profileId),
      checkedAt = this.now();
    if (
      denied &&
      denied.jobId === execution.plan.id &&
      denied.stepId === execution.step.id &&
      sameExecution(denied.context, execution.session) &&
      checkedAt >= denied.readAt &&
      checkedAt - denied.readAt < 2000 &&
      (await this.source.foregroundAllowed?.(execution, guard)) === false &&
      (await this.source.canPresentTaskPage?.(execution, guard)) !== true
    ) {
      await guard();
      this.dwells.delete(execution.plan.profileId);
      return this.wait(execution, 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED');
    }
    const { page, proof, foregroundAllowed, canPresentTaskPage } = await this.read(
      execution,
      guard,
    );
    this.assertAvailableSurface(page);
    const decision = await this.decidePage(
      execution,
      page,
      proof,
      foregroundAllowed,
      canPresentTaskPage,
    );
    const observation = this.continuousObservation(page, proof);
    return decision.kind === 'action' && observation ? { ...decision, observation } : decision;
  }
  private assertAvailableSurface(page: BrowsePage) {
    if (
      this.type === 'marketplace' &&
      (facebookMarketplaceUnavailableURL(page.url) || page.marketplaceUnavailable === true)
    )
      throw new BrowseReadTimeout('FACEBOOK_MARKETPLACE_UNAVAILABLE', this.diagnostic(page));
  }
  private continuousObservation(page: BrowsePage, proof: TabProof): BrowseReading | undefined {
    if (
      !['feed', 'marketplace'].includes(this.type) ||
      !page.contentKey ||
      !page.ready ||
      page.blocked ||
      !page.visible ||
      facebookBrowseSurface(page.url) !== this.type
    )
      return undefined;
    return {
      type: this.type as 'feed' | 'marketplace',
      proof,
      documentEpoch: 0,
      routeEpoch: 0,
      contentId: hash(page.url + '|' + page.timeOrigin),
      visible: true,
      ready: true,
    };
  }
  private async decidePage(
    execution: StepExecution,
    page: BrowsePage,
    proof: TabProof,
    foregroundAllowed?: boolean,
    canPresentTaskPage?: boolean,
  ): Promise<Decision> {
    if (execution.step.spec.type !== this.type) throw Error('BROWSE_EXECUTOR_UNAVAILABLE');
    if (execution.step.spec.maxLikes > 0 && !['feed', 'video'].includes(this.type))
      return { kind: 'wait', reason: 'BROWSE_LIKE_EXECUTOR_UNAVAILABLE' };
    const scope = { proof, documentEpoch: 0, routeEpoch: 0 };
    let url =
      execution.step.spec.type === 'marketplace'
        ? facebookMarketplaceURL(execution.step.spec)
        : this.type === 'friends'
          ? FACEBOOK_FRIENDS_REQUESTS_URL
          : this.type === 'feed'
            ? ('https://www.facebook.com/' as const)
            : ('https://www.facebook.com/reels/' as const);
    if (execution.step.spec.type === 'marketplace' && execution.step.spec.categoryId) {
      const spec = execution.step.spec,
        key = execution.plan.profileId;
      const cached = this.marketplaceTargets.get(key);
      if (cached?.stepId === execution.step.id) url = cached.url;
      else {
        const native = (page.marketplaceCategories ?? []).find((value) =>
          matchesMarketplaceSearch(value, { keyword: '', categoryId: spec.categoryId }),
        );
        if (native) {
          url = facebookMarketplaceURL(spec, native);
          this.marketplaceTargets.set(key, { stepId: execution.step.id, url });
        } else if (page.url === MARKETPLACE_HOME && page.ready && !page.blocked)
          return this.wait(execution, 'FACEBOOK_MARKETPLACE_CATEGORY_UNAVAILABLE', undefined, page);
        // Restart on a detail route without cached native links bootstraps the list again.
      }
    }
    const detail = this.type === 'marketplace' ? facebookMarketplaceItemURL(page.url) : null;
    const detailFromCurrentStep =
      detail !== null &&
      (this.dwells.get(execution.plan.profileId)?.stepId === execution.step.id ||
        this.viewedItems.get(execution.plan.profileId)?.stepId === execution.step.id);
    if (facebookMarketplaceUnavailableURL(page.url) && !page.blocked)
      return {
        kind: 'action',
        action: { kind: 'browseNavigate', tabId: proof.tabId, url },
        intent: { kind: 'auxiliary', purpose: 'advance', ...scope },
      };
    if (!facebookBrowseSurface(page.url))
      return this.wait(execution, 'FACEBOOK_BROWSE_ROUTE_REQUIRED', undefined, page);
    if (page.blocked || !page.ready) {
      this.dwells.delete(execution.plan.profileId);
      return this.wait(execution, 'FACEBOOK_BROWSE_LOADING_OR_DIALOG', undefined, page);
    }
    if (
      !['marketplace', 'friends'].includes(this.type) &&
      !page.visible &&
      foregroundAllowed !== true &&
      canPresentTaskPage !== true
    ) {
      this.dwells.delete(execution.plan.profileId);
      return this.wait(execution, 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED', page);
    }
    if (
      facebookBrowseSurface(page.url) !== this.type ||
      (this.type === 'friends' && !/^\/friends\/requests\/?$/.test(new URL(page.url).pathname)) ||
      (execution.step.spec.type === 'marketplace' &&
        ((!detailFromCurrentStep && !matchesMarketplaceSearch(page.url, execution.step.spec)) ||
          (execution.step.spec.categoryId && url === MARKETPLACE_HOME)))
    )
      return {
        kind: 'action',
        action: { kind: 'browseNavigate', tabId: proof.tabId, url },
        intent: { kind: 'auxiliary', purpose: 'advance', ...scope },
      };
    if (!page.visible)
      return {
        kind: 'action',
        action: { kind: 'activateTab', tabId: proof.tabId },
        intent: { kind: 'auxiliary', purpose: 'activate', ...scope },
      };
    if (this.type === 'marketplace' && !page.contentKey)
      return this.wait(execution, 'FACEBOOK_MARKETPLACE_ITEMS_REQUIRED', undefined, page);
    if (
      this.type === 'video' &&
      page.video?.paused &&
      !page.video.ended &&
      page.video.css &&
      page.video.readyState !== 0 &&
      !page.video.failed
    )
      return {
        kind: 'action',
        action: {
          kind: 'browsePlay',
          tabId: proof.tabId,
          documentEpoch: 0,
          routeEpoch: 0,
          url: page.url,
          timeOrigin: page.timeOrigin,
          css: page.video.css,
          source: page.video.source,
        },
        intent: { kind: 'auxiliary', purpose: 'play', ...scope },
      };
    const contentId = this.contentId(page);
    const previous = this.dwells.get(execution.plan.profileId),
      at = this.now();
    const sameDwell = previous?.stepId === execution.step.id && previous.contentId === contentId;
    const targetDwellMs = sameDwell ? previous.targetDwellMs : this.defaultDwellMs(page);
    if (!sameDwell) {
      devDiag.clearWait(`browse-wait:${execution.plan.profileId}`);
      devDiag.record({
        level: 'INFO',
        category: 'BROWSE_DECISION',
        event: 'BROWSE_DWELL_START',
        profileId: execution.plan.profileId,
        planId: execution.plan.id,
        stepId: execution.step.id,
        stepType: this.type,
        data: {
          url: page.url,
          targetDwellMs,
          recommendedDwellMs: page.recommendedDwellMs ?? null,
          scrollY: page.scrollY,
          scrollMaxY: page.scrollMaxY ?? null,
          nextScrollDeltaY: page.nextScrollDeltaY ?? null,
          marketplaceItems: page.marketplaceItems?.length ?? null,
        },
      });
    }
    this.dwells.set(execution.plan.profileId, {
      stepId: execution.step.id,
      contentId,
      since: sameDwell ? previous.since : at,
      observations: sameDwell ? Math.min(2, previous.observations + 1) : 1,
      targetDwellMs,
    });
    const dwell =
      previous?.stepId === execution.step.id && previous.contentId === contentId
        ? at - previous.since
        : 0;
    if (this.type === 'friends') {
      this.waits.delete(execution.plan.profileId);
      if (page.friendConfirmCSS === FACEBOOK_FRIEND_CONFIRM_CSS && dwell >= targetDwellMs)
        return {
          kind: 'action',
          action: {
            kind: 'click',
            tabId: proof.tabId,
            documentEpoch: 0,
            routeEpoch: 0,
            target: { css: page.friendConfirmCSS },
          },
          intent: {
            kind: 'auxiliary',
            purpose: 'acceptFriend',
            beforeContentId: contentId,
            ...scope,
          },
        };
      const settledContentId =
        page.contentKey === 'FRIENDS_REQUESTS_EXHAUSTED' && dwell < 2000
          ? hash(page.url + '|' + page.timeOrigin + '|friends-settling')
          : contentId;
      return {
        kind: 'observe',
        observation: {
          ...scope,
          type: 'friends',
          contentId: settledContentId,
          visible: page.visible,
          ready: page.ready && !page.blocked,
        },
      };
    }
    if (this.type === 'marketplace') {
      let viewed = this.viewedItems.get(execution.plan.profileId);
      if (!viewed || viewed.stepId !== execution.step.id) {
        viewed = { stepId: execution.step.id, items: new Set() };
        this.viewedItems.set(execution.plan.profileId, viewed);
      }
      // This is bounded browsing variety, not a second task ledger. Restarting resets variety;
      // original operation bindings, progress and completion still belong to the runner.
      if (detail) {
        if (viewed.items.size >= 128 && !viewed.items.has(detail)) viewed.items.clear();
        viewed.items.add(detail);
      }
      const next = (page.marketplaceItems ?? [])
        .filter((item) => facebookMarketplaceItemURL(item) === item)
        .find((item) => !viewed.items.has(item));
      const marketplaceDwellThreshold =
        page.recommendedDwellMs !== undefined ? targetDwellMs : 8000;
      const scrollMaxY = page.scrollMaxY ?? 0;
      const canScrollList =
        !detail &&
        page.recommendedDwellMs !== undefined &&
        scrollMaxY > 0 &&
        page.scrollY < scrollMaxY - 4;
      const preferListScroll =
        canScrollList && viewed.items.size > 0 && viewed.items.size % 2 === 1 && page.scrollY < 200;
      const destination = detail ? url : preferListScroll ? undefined : next;
      if (dwell >= marketplaceDwellThreshold && destination)
        return {
          kind: 'action',
          action: { kind: 'browseNavigate', tabId: proof.tabId, url: destination },
          intent: { kind: 'auxiliary', purpose: 'advance', ...scope },
        };
    }
    if (this.type === 'video' && !page.video && page.videoEntry && page.videoEntry !== page.url)
      return {
        kind: 'action',
        action: { kind: 'browseNavigate', tabId: proof.tabId, url: page.videoEntry },
        intent: { kind: 'auxiliary', purpose: 'advance', ...scope },
      };
    if (
      this.type === 'video' &&
      !page.video &&
      dwell >= 5000 &&
      new URL(page.url).pathname === '/watch/'
    )
      return {
        kind: 'action',
        action: { kind: 'browseNavigate', tabId: proof.tabId, url },
        intent: { kind: 'auxiliary', purpose: 'advance', ...scope },
      };
    if (
      (execution.step.spec.type === 'feed' || execution.step.spec.type === 'video') &&
      execution.step.spec.maxLikes > 0 &&
      execution.step.progress.likes < execution.step.spec.maxLikes &&
      page.contentKey &&
      page.likeTarget?.css === FACEBOOK_BROWSE_LIKE_CSS &&
      dwell >= Math.min(Math.round(targetDwellMs * 0.5), 1600)
    ) {
      const spec = execution.step.spec;
      const key = execution.plan.profileId;
      let likeState = this.likeStates.get(key);
      if (!likeState || likeState.stepId !== execution.step.id) {
        likeState = { stepId: execution.step.id, evaluated: new Set(), lastLikeAt: -Infinity };
        this.likeStates.set(key, likeState);
      }
      if (!likeState.evaluated.has(contentId)) {
        if (likeState.evaluated.size >= 256) likeState.evaluated.clear();
        likeState.evaluated.add(contentId);
        const target = page.likeTarget;
        const cooldownElapsed = at - likeState.lastLikeAt >= 8000;
        const skipSponsored = spec.skipSponsored ?? true;
        const sponsoredOk = !(skipSponsored && target.sponsored);
        const countOk = target.likeCount >= spec.minLikeCount;
        const textLower = target.text.toLowerCase();
        const parseKeywords = (raw?: string) =>
          (raw ?? '')
            .split(/[,，\n]/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        const includeList = parseKeywords(spec.includeKeywords);
        const excludeList = parseKeywords(spec.excludeKeywords);
        const includeOk =
          includeList.length === 0 || includeList.some((kw) => textLower.includes(kw));
        const excludeOk =
          excludeList.length === 0 || !excludeList.some((kw) => textLower.includes(kw));
        const notAlreadyLiked =
          !target.liked && !(await this.hasAccountLiked?.(execution.plan.accountId, contentId));
        const probability = (spec.likeProbability ?? 35) / 100;
        const roll = this.random();
        const chosen =
          cooldownElapsed &&
          sponsoredOk &&
          countOk &&
          includeOk &&
          excludeOk &&
          notAlreadyLiked &&
          roll < probability;
        devDiag.record({
          level: 'INFO',
          category: 'BROWSE_DECISION',
          event: chosen ? 'BROWSE_LIKE_TRIGGERED' : 'BROWSE_LIKE_SKIPPED',
          profileId: key,
          planId: execution.plan.id,
          stepId: execution.step.id,
          stepType: this.type,
          data: {
            contentId,
            likeCount: target.likeCount,
            minLikeCount: spec.minLikeCount,
            sponsored: target.sponsored,
            alreadyLiked: target.liked,
            cooldownElapsed,
            includeOk,
            excludeOk,
            probability,
            roll: Math.round(roll * 1000) / 1000,
            likesProgress: `${execution.step.progress.likes}/${spec.maxLikes}`,
          },
        });
        if (chosen && target.css === FACEBOOK_BROWSE_LIKE_CSS) {
          likeState.lastLikeAt = at;
          return {
            kind: 'action',
            action: {
              kind: 'click',
              tabId: proof.tabId,
              documentEpoch: 0,
              routeEpoch: 0,
              target: { css: target.css },
            },
            intent: {
              kind: 'like',
              contentId,
              observedLikeCount: target.likeCount,
              observedLiked: false,
              ...scope,
            },
          };
        }
      }
    }
    if (
      this.type === 'video' &&
      page.video &&
      page.nextReelCSS &&
      (page.video.ended || dwell >= targetDwellMs)
    )
      return {
        kind: 'action',
        action: {
          kind: 'click',
          tabId: proof.tabId,
          documentEpoch: 0,
          routeEpoch: 0,
          target: { css: page.nextReelCSS },
        },
        intent: { kind: 'auxiliary', purpose: 'advance', beforeContentId: contentId, ...scope },
      };
    const canScrollFeedOrMarketplace =
      this.type === 'feed' && page.recommendedDwellMs !== undefined
        ? true
        : !(page.scrollMaxY !== undefined && page.scrollY >= page.scrollMaxY - 20);
    if (
      (this.type !== 'video' &&
        dwell >= targetDwellMs &&
        // Slow control work must not starve visible observations by repeatedly scrolling.
        (this.type !== 'feed' || !page.contentKey || (sameDwell && previous.observations >= 2)) &&
        canScrollFeedOrMarketplace) ||
      (this.type === 'video' && page.video && (page.video.ended || dwell >= targetDwellMs))
    )
      return {
        kind: 'action',
        action: {
          kind: 'browseScroll',
          tabId: proof.tabId,
          documentEpoch: 0,
          routeEpoch: 0,
          url: page.url,
          timeOrigin: page.timeOrigin,
          fromY: page.scrollY,
          deltaY:
            page.nextScrollDeltaY ??
            Math.max(100, Math.min(1200, Math.floor(page.viewportHeight * 0.8))),
        },
        intent: {
          kind: 'auxiliary',
          purpose: 'advance',
          ...(page.contentKey ? { beforeContentId: hash(page.contentKey) } : {}),
          ...scope,
        },
      };
    if (this.type === 'video' && !page.video)
      return this.wait(execution, 'FACEBOOK_VIDEO_PLAYER_REQUIRED');
    if (this.type !== 'video' && !page.contentKey)
      return this.wait(
        execution,
        this.type === 'marketplace'
          ? 'FACEBOOK_MARKETPLACE_ITEMS_REQUIRED'
          : 'FACEBOOK_FEED_CONTENT_REQUIRED',
        page,
      );
    // Feed/marketplace duration measures a usable visible document, not changing card text.
    // Auto-playing inline video timers may change post text every second without a navigation.
    // Dwell and wheel-effect anchors above remain scoped to the observed individual content.
    const base = {
      ...scope,
      contentId: ['feed', 'marketplace'].includes(this.type)
        ? hash(page.url + '|' + page.timeOrigin)
        : contentId,
      visible: page.visible,
      ready: page.ready && !page.blocked,
    };
    if (this.type === 'video' && page.video) {
      if (page.video.failed || page.video.paused || page.video.buffering)
        this.wait(
          execution,
          page.video.failed ? 'FACEBOOK_VIDEO_DECODE_FAILED' : 'FACEBOOK_VIDEO_PLAYBACK_STALLED',
        );
      else this.waits.delete(execution.plan.profileId);
      return {
        kind: 'observe',
        observation: {
          ...base,
          type: 'video',
          paused: page.video.paused,
          buffering: page.video.buffering,
          timeSeconds: page.video.timeSeconds,
          playbackRate: page.video.playbackRate,
        },
      };
    }
    this.waits.delete(execution.plan.profileId);
    return {
      kind: 'observe',
      observation: { ...base, type: this.type === 'marketplace' ? 'marketplace' : 'feed' },
    };
  }
  async verify(
    execution: StepExecution,
    operation: Operation & { binding: Binding },
    intent: Intent,
    guard: () => Awaitable<void>,
  ): Promise<Verdict> {
    const { page, proof } = await this.read(execution, guard);
    if (
      operation.status !== 'ACKNOWLEDGED' ||
      !sameBinding(operation.binding, {
        ...execution.session,
        operationId: operation.id,
        jobId: execution.plan.id,
        stepId: execution.step.id,
        actionDigest: hash(JSON.stringify(operation.action)),
      }) ||
      !sameTabProof(proof, intent.proof)
    )
      throw Error('BROWSE_ACKNOWLEDGED_ORIGINAL_REQUIRED');
    this.assertAvailableSurface(page);
    if (intent.kind === 'like') {
      const action = operation.action;
      if (
        (this.type !== 'feed' && this.type !== 'video') ||
        (execution.step.spec.type !== 'feed' && execution.step.spec.type !== 'video') ||
        execution.step.spec.maxLikes <= 0 ||
        action.kind !== 'click' ||
        action.target.css !== FACEBOOK_BROWSE_LIKE_CSS ||
        action.target.scope !== undefined ||
        action.target.text !== undefined
      )
        throw Error('BROWSE_ACKNOWLEDGED_ORIGINAL_REQUIRED');
      const likeReceipt = {
        binding: operation.binding,
        evidence: {
          independent: true,
          url: page.url,
          timeOrigin: page.timeOrigin,
          contentId: intent.contentId,
        },
      };
      const sameContent = this.contentId(page) === intent.contentId;
      if (
        page.ready &&
        !page.blocked &&
        page.visible &&
        facebookBrowseSurface(page.url) === this.type &&
        sameContent &&
        page.likeTarget?.liked === true
      ) {
        this.likeVerifyWaits.delete(operation.id);
        return {
          outcome: 'VERIFIED',
          receipt: likeReceipt,
          effect: {
            kind: 'liked',
            contentId: intent.contentId,
            observedLiked: true,
          },
        };
      }
      const at = this.now();
      const prevWait = this.likeVerifyWaits.get(operation.id);
      const since = prevWait?.operationId === operation.id ? prevWait.since : at;
      if (!prevWait || prevWait.operationId !== operation.id)
        this.likeVerifyWaits.set(operation.id, { operationId: operation.id, since });
      if (
        page.ready &&
        !page.blocked &&
        page.visible &&
        (!sameContent || !page.likeTarget || at - since >= 3500)
      ) {
        this.likeVerifyWaits.delete(operation.id);
        return { outcome: 'NOT_APPLIED', receipt: likeReceipt };
      }
      return {
        outcome: 'WAIT',
        receipt: {
          ...likeReceipt,
          evidence: {
            ...likeReceipt.evidence,
            pending: BrowsePendingDiagnostic.parse(this.diagnostic(page)),
          },
        },
        reason:
          !page.visible && page.ready && !page.blocked
            ? 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED'
            : 'FACEBOOK_BROWSE_LIKE_EFFECT_PENDING',
      };
    }
    const receipt = {
      binding: operation.binding,
      evidence: {
        independent: true,
        url: page.url,
        timeOrigin: page.timeOrigin,
        purpose: intent.purpose,
      },
    };
    const action = operation.action;
    let wheelStart: ReturnType<typeof BrowseWheelStart.parse> | undefined;
    let fromY = action.kind === 'browseScroll' ? action.fromY : 0;
    if (action.kind === 'browseScroll' && this.type === 'feed') {
      const ack = BoundReceipt.safeParse(operation.receipt);
      const evidence = ack.success ? ack.data.evidence : null;
      if (
        evidence &&
        typeof evidence === 'object' &&
        !Array.isArray(evidence) &&
        'wheelStart' in evidence
      ) {
        const start = BrowseWheelStart.parse(evidence.wheelStart);
        if (
          !ack.success ||
          !sameBinding(ack.data.binding, operation.binding) ||
          start.url !== action.url ||
          start.timeOrigin !== action.timeOrigin
        )
          throw Error('BROWSE_WHEEL_START_ORIGINAL_REQUIRED');
        fromY = start.scrollY;
        wheelStart = start;
      }
    }
    const beforePosition = wheelStart?.version === 2 ? wheelStart.anchor : null;
    const currentPosition = page.contentPosition;
    const visualAdvance =
      this.type === 'feed' &&
      action.kind === 'browseScroll' &&
      !!beforePosition &&
      !!currentPosition &&
      !!page.contentKey &&
      beforePosition.contentId === intent.beforeContentId &&
      hash(page.contentKey) === beforePosition.contentId &&
      Math.abs(currentPosition.left - beforePosition.position.left) <= 2 &&
      Math.abs(currentPosition.width - beforePosition.position.width) <= 2 &&
      Math.abs(currentPosition.height - beforePosition.position.height) <= 2 &&
      Math.abs(currentPosition.viewportHeight - beforePosition.position.viewportHeight) <= 2 &&
      Math.sign(action.deltaY) * (beforePosition.position.top - currentPosition.top) > 20 &&
      Math.abs(beforePosition.position.top - currentPosition.top) <= Math.abs(action.deltaY) + 20;
    // A downward wheel can be clipped after feed layout shrinks. This is a confirmed
    // no-effect auxiliary input, not an unknown publication or credited scroll movement.
    if (
      this.type !== 'video' &&
      action.kind === 'browseScroll' &&
      !visualAdvance &&
      page.ready &&
      page.visible &&
      !page.blocked &&
      page.url === action.url &&
      page.timeOrigin === action.timeOrigin &&
      page.scrollMaxY !== undefined &&
      page.scrollY >= page.scrollMaxY - 20 &&
      page.scrollY <= fromY + 20 &&
      (!intent.beforeContentId ||
        !page.contentKey ||
        hash(page.contentKey) === intent.beforeContentId)
    ) {
      this.dwells.set(execution.plan.profileId, {
        stepId: execution.step.id,
        contentId: this.contentId(page),
        since: this.now(),
        observations: 0,
        targetDwellMs: this.defaultDwellMs(page),
      });
      return { outcome: 'NOT_APPLIED', receipt };
    }
    const nextReel =
      this.type === 'video' &&
      action.kind === 'click' &&
      action.target.css === FACEBOOK_REEL_NEXT_CSS &&
      action.target.scope === undefined &&
      action.target.text === undefined &&
      intent.purpose === 'advance' &&
      !!intent.beforeContentId &&
      !!page.video &&
      page.video.readyState !== 0 &&
      !page.video.failed &&
      !page.video.buffering &&
      !!page.contentKey &&
      page.visible &&
      facebookBrowseSurface(page.url) === 'video' &&
      this.contentId(page) !== intent.beforeContentId;
    const friendAccepted =
      this.type === 'friends' &&
      action.kind === 'click' &&
      action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS &&
      action.target.scope === undefined &&
      action.target.text === undefined &&
      intent.purpose === 'acceptFriend' &&
      !!intent.beforeContentId &&
      !!page.contentKey &&
      page.visible &&
      facebookBrowseSurface(page.url) === 'friends' &&
      this.contentId(page) !== intent.beforeContentId;
    const applied =
      page.ready &&
      !page.blocked &&
      (nextReel ||
        friendAccepted ||
        (action.kind === 'browseNavigate' &&
          facebookBrowseSurface(page.url) === this.type &&
          (this.type !== 'friends' ||
            /^\/friends\/requests\/?$/.test(new URL(page.url).pathname)) &&
          (execution.step.spec.type !== 'marketplace' ||
            (facebookMarketplaceItemURL(action.url)
              ? facebookMarketplaceItemURL(page.url) === facebookMarketplaceItemURL(action.url) &&
                !!page.contentKey
              : (marketplaceBootstrap(action.url, execution.step.spec) &&
                  page.url === MARKETPLACE_HOME) ||
                (matchesMarketplaceSearch(action.url, execution.step.spec) &&
                  matchesMarketplaceSearch(page.url, execution.step.spec))))) ||
        (action.kind === 'browseScroll' &&
          page.timeOrigin === action.timeOrigin &&
          ((page.url === action.url && page.scrollY > fromY + 20) ||
            (page.visible && page.url === action.url && visualAdvance) ||
            // Exploration starts without a content anchor. Once usable content is
            // independently visible, its goal is met even if feed virtualization
            // lowered scrollTop. This auxiliary verdict credits no browsing time.
            (this.type === 'feed' &&
              page.visible &&
              page.url === action.url &&
              !intent.beforeContentId &&
              !!page.contentKey) ||
            (page.visible &&
              page.url === action.url &&
              !!page.contentKey &&
              !!intent.beforeContentId &&
              hash(page.contentKey) !== intent.beforeContentId) ||
            (this.type === 'video' &&
              page.url !== action.url &&
              facebookBrowseSurface(page.url) === 'video' &&
              !!page.video))) ||
        (action.kind === 'activateTab' && page.visible) ||
        (action.kind === 'browsePlay' &&
          intent.purpose === 'play' &&
          page.url === action.url &&
          page.timeOrigin === action.timeOrigin &&
          page.video?.css === action.css &&
          page.video.source === action.source &&
          !page.video.paused &&
          !page.video.buffering));
    if (applied && (action.kind === 'browseScroll' || nextReel || friendAccepted))
      this.dwells.set(execution.plan.profileId, {
        stepId: execution.step.id,
        contentId: this.contentId(page),
        since: this.now(),
        observations: 0,
        targetDwellMs: this.defaultDwellMs(page),
      });
    if (applied && action.kind === 'activateTab' && intent.purpose === 'activate') {
      this.dwells.delete(execution.plan.profileId);
    }
    return applied
      ? {
          outcome: 'VERIFIED',
          receipt,
          effect: {
            kind: 'auxiliary',
            purpose: intent.purpose,
            observed: true,
            ...(friendAccepted ? { afterContentId: this.contentId(page) } : {}),
          },
          ...(this.continuousObservation(page, proof)
            ? { observation: this.continuousObservation(page, proof) }
            : {}),
        }
      : {
          outcome: 'WAIT',
          receipt: {
            ...receipt,
            evidence: {
              ...receipt.evidence,
              pending: BrowsePendingDiagnostic.parse({
                ...this.diagnostic(page),
                ...(wheelStart?.version === 2
                  ? { version: 2, contentPosition: page.contentPosition ?? null, wheelStart }
                  : {}),
              }),
            },
          },
          reason:
            !page.visible &&
            page.ready &&
            !page.blocked &&
            (action.kind === 'activateTab' ||
              (this.type === 'video' &&
                action.kind === 'click' &&
                action.target.css === FACEBOOK_REEL_NEXT_CSS &&
                action.target.scope === undefined &&
                action.target.text === undefined &&
                intent.purpose === 'advance') ||
              (this.type === 'friends' &&
                action.kind === 'click' &&
                action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS &&
                action.target.scope === undefined &&
                action.target.text === undefined &&
                intent.purpose === 'acceptFriend') ||
              ((action.kind === 'browseScroll' || action.kind === 'browsePlay') &&
                page.url === action.url &&
                page.timeOrigin === action.timeOrigin))
              ? 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED'
              : 'FACEBOOK_BROWSE_EFFECT_PENDING',
        };
  }
}
