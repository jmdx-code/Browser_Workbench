import { createHash, randomUUID } from 'node:crypto';
import type { CompatibleRepository } from '../domain/persistence.js';
import {
  extractOcrReadableText,
  hasUnsupportedOcrScript,
  nameSimilarity,
  relativePostAge,
  type BluestacksBumperMode,
  type BluestacksInstance,
} from '../shared/bluestacks.js';
import {
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperComment,
  type BumperLog,
  type BumperScope,
  type BumperSettings,
  type BumperTarget,
} from '../shared/group-bumper.js';
import { abortableWait, type BluestacksDeviceManager } from './bluestacks-device-manager.js';
import {
  compareAvatarToRegion,
  cropToDataUrl,
  detectVideoSpeakerState,
  extractActionBars,
  extractInlineVideoControls,
  extractPostCards,
  findGroupSortButtonNode,
  findJoinGroupButtonNode,
  findRelatedGroupsCloseButtonNode,
  findSeeMoreButtonNode,
  findTextInputNode,
  flattenLiteNodes,
  getRegionSignature,
  hasPageHeroHeader,
  hasPageTopBar,
  isBottomSheetOpen,
  isDarkScreenOrReelMode,
  isLikeButtonBlue,
  makeCanonicalRect,
  resolveSharePostUrl,
  signatureSimilarity,
  type LiteInlineVideoControls,
  type LitePostActionBar,
  type LitePostCard,
  type LiteXmlNode,
  type OcrRecognizer,
  type RectBounds,
} from './bluestacks-vision.js';

export interface BluestacksBumperRunnerRepo {
  savedSettings?(): {
    bumperSettings: BumperSettings;
    pageBumperSettings?: BumperSettings;
  };
  eligibility(
    accountId: string,
    instanceId: string,
    postId: string,
    now?: number,
    sourceMode?: BumperScope,
  ): {
    today: number;
    postCount: number;
    duplicate: boolean;
    allowed: boolean;
  };
  pickComment(
    postId: string,
    random?: number,
    excludeIds?: ReadonlyArray<string>,
    scope?: BumperScope,
  ): BumperComment | null;
  recordBump(input: BumperLog, commentId?: string): boolean;
  saveInspectionResult(input: {
    id: string;
    fbLiteInstalled: boolean;
    accountState: 'unknown' | 'logged-in' | 'logged-out' | 'missing-app';
    accountId?: string;
    accountName?: string;
    avatarUrl?: string | null;
    fbWidth?: number;
    fbHeight?: number;
  }): BluestacksInstance;
}

export interface BluestacksTargetAvatarUpdater {
  applyResolvedTargetMetadata(
    kind: 'groups' | 'pages',
    rawId: string,
    metadata: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): Promise<unknown> | unknown;
}

class AccountCircuitBreakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountCircuitBreakError';
  }
}

function isFatalDeviceOrStopError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err instanceof AccountCircuitBreakError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /TASK_STOPPED|device offline|device '.*' not found|closed|ECONNREFUSED/i.test(msg);
}

export class BluestacksGroupBumperRunner {
  private readonly postClaims = new Set<string>();
  private readonly commentClaims = new Set<string>();

  constructor(
    private readonly repo: CompatibleRepository<BluestacksBumperRunnerRepo>,
    private readonly targetAvatarUpdater: BluestacksTargetAvatarUpdater,
    public readonly devices: BluestacksDeviceManager,
    private readonly ocr: OcrRecognizer,
  ) {}

  private async resolveLiveEnableSound(
    fallback: BumperSettings,
    sourceMode: BumperScope,
  ): Promise<boolean> {
    if (typeof this.repo.savedSettings !== 'function') {
      return Boolean(fallback.enableSound);
    }
    try {
      const saved = await this.repo.savedSettings();
      const effective =
        sourceMode === 'page'
          ? (saved.pageBumperSettings?.enableSound ?? fallback.enableSound)
          : (saved.bumperSettings.enableSound ?? fallback.enableSound);
      return Boolean(effective);
    } catch {
      return Boolean(fallback.enableSound);
    }
  }

  private async applyDeviceStreamSound(
    serial: string,
    wantSound: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (typeof this.devices.setMediaSoundEnabled === 'function') {
      await this.devices.setMediaSoundEnabled(serial, wantSound, signal);
    }
  }

  private async syncVideoSpeakerIfVisible(
    serial: string,
    sw: number,
    sh: number,
    xml: LiteXmlNode | null,
    png: Buffer,
    minY: number,
    maxY: number,
    headerOnScreen: boolean,
    wantSound: boolean,
    signal: AbortSignal,
  ): Promise<{ png: Buffer; controls: LiteInlineVideoControls }> {
    const controls = extractInlineVideoControls(xml, minY, maxY, headerOnScreen);
    if (!controls.soundBounds) {
      return { png, controls };
    }
    let currentPng = png;
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await detectVideoSpeakerState(currentPng, controls.soundBounds);
      const needsTap = (wantSound && state === 'muted') || (!wantSound && state === 'unmuted');
      if (!needsTap) break;
      await this.devices.tap900(
        serial,
        controls.soundBounds.cx,
        controls.soundBounds.cy,
        sw,
        sh,
        signal,
      );
      await abortableWait(attempt === 0 ? 600 : 450, signal);
      currentPng = await this.devices.screencap(serial, signal);
    }
    return { png: currentPng, controls };
  }

  private async recoverToFeedIfNeeded(
    inst: BluestacksInstance,
    expectedFeedUrl: string,
    signal: AbortSignal,
    status: (text: string) => void,
  ): Promise<{ xml: LiteXmlNode | null; png: Buffer }> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    let [xml, png] = await Promise.all([
      this.devices.dumpXml(serial, sw, sh, signal),
      this.devices.screencap(serial, signal),
    ]);
    if (!xml) {
      await this.devices.swipe900(serial, 115, 920, 115, 720, 300, sw, sh, signal);
      await abortableWait(900, signal);
      [xml, png] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);
    }

    const inReelOrDark = await isDarkScreenOrReelMode(png);
    const sheetOpen = !inReelOrDark && (await isBottomSheetOpen(png));
    const unexpectedInput = flattenLiteNodes(xml).some(
      (n) => n.focused && n.clickable && n.longClickable && n.bounds.w >= 400 && n.bounds.y1 <= 200,
    );

    if (inReelOrDark || sheetOpen || unexpectedInput) {
      status(inReelOrDark ? '检测到视频/暗色视图，正在返回帖子流…' : '正在关闭弹窗层…');
      await this.devices.keyevent(serial, 4, signal);
      await abortableWait(1300, signal);
      [xml, png] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);

      if ((await isDarkScreenOrReelMode(png)) || !xml || xml.packageName !== 'com.facebook.lite') {
        status('正在重新回到目标小组帖子流…');
        await this.devices.tap900(serial, 36, 70, sw, sh, signal).catch(() => null);
        await abortableWait(800, signal);
        await this.devices.openDeepLink(serial, expectedFeedUrl, sw, sh, signal);
        await abortableWait(2200, signal);
        [xml, png] = await Promise.all([
          this.devices.dumpXml(serial, sw, sh, signal),
          this.devices.screencap(serial, signal),
        ]);
      }
    }
    return { xml, png };
  }

  private buildGroupUrl(groupId: string, searchMode: BumperSettings['searchMode']): string {
    const base = `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/`;
    return searchMode === 'time_sort' ? `${base}?sorting_setting=CHRONOLOGICAL` : base;
  }

  private async enterAndVerifyGroup(
    inst: BluestacksInstance,
    group: BumperTarget,
    searchMode: BumperSettings['searchMode'],
    signal: AbortSignal,
    status: (text: string) => void,
  ): Promise<BumperTarget> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    let currentGroup = group;
    const targetUrl = this.buildGroupUrl(currentGroup.id, searchMode);

    status(`正在进入目标小组 · ${currentGroup.name}`);
    await this.devices.openDeepLink(serial, targetUrl, sw, sh, signal);
    await abortableWait(2400, signal);

    let [groupXml, groupPng] = await Promise.all([
      this.devices.dumpXml(serial, sw, sh, signal),
      this.devices.screencap(serial, signal),
    ]);
    if (this.devices.isLoginOrLoggedOutXml(groupXml)) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: true,
        accountState: 'logged-out',
        fbWidth: sw,
        fbHeight: sh,
      });
      throw new AccountCircuitBreakError('FB Lite 账号已退出登录或需验证');
    }

    const joinBtn = searchMode !== 'random_browse' ? findJoinGroupButtonNode(groupXml) : null;
    if (joinBtn && (await isLikeButtonBlue(groupPng, joinBtn.bounds))) {
      status(`检测到尚未加入该小组，正在自动加入 · ${currentGroup.name}`);
      await this.devices.tap900(serial, joinBtn.bounds.cx, joinBtn.bounds.cy, sw, sh, signal);
      await abortableWait(2400, signal);
      groupXml = await this.devices.dumpXml(serial, sw, sh, signal);
      const questionInput = findTextInputNode(groupXml);
      if (questionInput && questionInput.bounds.y2 <= 1350) {
        // Membership questionnaire popped up — exit back to group feed so public posts can still be bumped
        await this.devices.keyevent(serial, 4, signal);
        await abortableWait(1200, signal);
        await this.devices.openDeepLink(serial, targetUrl, sw, sh, signal);
        await abortableWait(1800, signal);
        groupXml = await this.devices.dumpXml(serial, sw, sh, signal);
      } else if (extractPostCards(groupXml).length === 0 && !findGroupSortButtonNode(groupXml)) {
        // Feature intervention / temporary join block dialog popped up — press Back to dismiss and fall back to public feed
        await this.devices.keyevent(serial, 4, signal);
        await abortableWait(1000, signal);
        groupXml = await this.devices.dumpXml(serial, sw, sh, signal);
      }
    }
    const closeCarouselBtn = findRelatedGroupsCloseButtonNode(groupXml);
    if (closeCarouselBtn) {
      await this.devices.tap900(
        serial,
        closeCarouselBtn.bounds.cx,
        closeCarouselBtn.bounds.cy,
        sw,
        sh,
        signal,
      );
      await abortableWait(1000, signal);
    }

    if (!currentGroup.avatarUrl) {
      const coverBounds = makeCanonicalRect(225, 68, 675, 358);
      const captured = await cropToDataUrl(groupPng, coverBounds, 96);
      if (captured) {
        await Promise.resolve(
          this.targetAvatarUpdater.applyResolvedTargetMetadata('groups', currentGroup.id, {
            avatarUrl: captured,
          }),
        ).catch(() => null);
        currentGroup = { ...currentGroup, avatarUrl: captured };
      }
    }
    return currentGroup;
  }

  private async switchGroupSortToNewest(
    inst: BluestacksInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    let xml = await this.devices.dumpXml(serial, sw, sh, signal);
    const closeCarouselBtn = findRelatedGroupsCloseButtonNode(xml);
    if (closeCarouselBtn) {
      await this.devices.tap900(
        serial,
        closeCarouselBtn.bounds.cx,
        closeCarouselBtn.bounds.cy,
        sw,
        sh,
        signal,
      );
      await abortableWait(1000, signal);
      xml = await this.devices.dumpXml(serial, sw, sh, signal);
    }

    let sortBtn = findGroupSortButtonNode(xml);
    if (!sortBtn && extractPostCards(xml).length === 0) {
      await this.devices.swipe900(serial, 115, 1180, 115, 680, 420, sw, sh, signal);
      await abortableWait(1100, signal);
      xml = await this.devices.dumpXml(serial, sw, sh, signal);
      sortBtn = findGroupSortButtonNode(xml);
    }
    // Never tap arbitrary coordinates when FB Lite hides the sort button (already opened with ?sorting_setting=CHRONOLOGICAL)
    if (!sortBtn) return;

    await this.devices.tap900(serial, sortBtn.bounds.cx, sortBtn.bounds.cy, sw, sh, signal);
    await abortableWait(1400, signal);
    const [png, sheetXml] = await Promise.all([
      this.devices.screencap(serial, signal),
      this.devices.dumpXml(serial, sw, sh, signal),
    ]);
    if (await isBottomSheetOpen(png)) {
      let optionY = 1490;
      const rows = flattenLiteNodes(sheetXml).filter(
        (n) =>
          n.clickable &&
          n.bounds.x1 <= 60 &&
          n.bounds.x2 >= 800 &&
          n.bounds.y1 >= 900 &&
          n.bounds.h >= 50 &&
          n.bounds.h <= 140,
      );
      for (const row of rows) {
        const txt = (await this.ocr.recognizeBounds(png, row.bounds)).replace(/\s+/g, '');
        if (/新帖子|最新帖子|新貼文|recentposts|newposts/i.test(txt)) {
          optionY = row.bounds.cy;
          break;
        }
      }
      await this.devices.tap900(serial, 450, optionY, sw, sh, signal);
      await abortableWait(2000, signal);
    }
  }

  private async openPageGroupFeed(
    inst: BluestacksInstance,
    group: BumperTarget,
    page: BumperTarget,
    signal: AbortSignal,
    status: (text: string) => void,
  ): Promise<BumperTarget> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    status(`正在打开专页小组贴 · ${group.name} · ${page.name}`);
    await this.devices.openDeepLink(
      serial,
      `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(page.id)}/`,
      sw,
      sh,
      signal,
    );
    await abortableWait(2200, signal);

    const feedXml = await this.devices.dumpXml(serial, sw, sh, signal);
    if (this.devices.isLoginOrLoggedOutXml(feedXml)) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: true,
        accountState: 'logged-out',
        fbWidth: sw,
        fbHeight: sh,
      });
      throw new AccountCircuitBreakError('FB Lite 账号已退出登录或需验证');
    }

    const topCards = extractPostCards(feedXml);
    if (topCards.length === 0) {
      if (extractActionBars(feedXml).length > 0) {
        // FB Lite preserved a mid-post scroll position from an earlier visit; pull back up to post header
        await this.devices.swipe900(serial, 450, 360, 450, 1260, 450, sw, sh, signal);
        await abortableWait(1200, signal);
        const pulledXml = await this.devices.dumpXml(serial, sw, sh, signal);
        if (extractPostCards(pulledXml).length === 0) {
          await this.devices.swipe900(serial, 115, 1180, 115, 760, 450, sw, sh, signal);
          await abortableWait(1100, signal);
        }
      } else {
        await this.devices.swipe900(serial, 115, 1180, 115, 760, 450, sw, sh, signal);
        await abortableWait(1200, signal);
      }
    }
    return page;
  }

  private async enterAndVerifyPage(
    inst: BluestacksInstance,
    page: BumperTarget,
    signal: AbortSignal,
    status: (text: string) => void,
  ): Promise<BumperTarget> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const targetUrl = `https://www.facebook.com/${encodeURIComponent(page.id)}`;
    status(`正在进入目标专页 · ${page.name}`);
    await this.devices.openDeepLink(serial, targetUrl, sw, sh, signal);
    await abortableWait(2400, signal);

    let pageXml = await this.devices.dumpXml(serial, sw, sh, signal);
    if (this.devices.isLoginOrLoggedOutXml(pageXml)) {
      await this.repo.saveInspectionResult({
        id: inst.id,
        fbLiteInstalled: true,
        accountState: 'logged-out',
        fbWidth: sw,
        fbHeight: sh,
      });
      throw new AccountCircuitBreakError('FB Lite 账号已退出登录或需验证');
    }

    const closeCarouselBtn = findRelatedGroupsCloseButtonNode(pageXml);
    if (closeCarouselBtn) {
      await this.devices.tap900(
        serial,
        closeCarouselBtn.bounds.cx,
        closeCarouselBtn.bounds.cy,
        sw,
        sh,
        signal,
      );
      await abortableWait(900, signal);
      pageXml = await this.devices.dumpXml(serial, sw, sh, signal);
    }

    // When FB Lite re-opens the currently active Page, Android delivers the intent without resetting scroll.
    // Pull back up to the Page hero header first so Post #1 at the top of the timeline is never skipped.
    for (
      let pullStep = 0;
      pullStep < 3 && hasPageTopBar(pageXml) && !hasPageHeroHeader(pageXml);
      pullStep++
    ) {
      await this.devices.swipe900(serial, 450, 300, 450, 1400, 320, sw, sh, signal);
      await abortableWait(1050, signal);
      pageXml = await this.devices.dumpXml(serial, sw, sh, signal);
    }

    if (extractPostCards(pageXml).length === 0) {
      await this.devices.swipe900(serial, 115, 1280, 115, 360, 650, sw, sh, signal);
      await abortableWait(1350, signal);
    }
    return page;
  }

  private async matchPageTimelinePost(
    png: Buffer,
    card: LitePostCard,
    page: BumperTarget,
    actingAccountName: string,
  ): Promise<{ target: BumperTarget; authorName: string } | null> {
    const cleanPageName = page.name.replace(/\s*\|.*$/, '').trim() || page.name.trim();
    const ocrName = await this.ocr.recognizeBounds(png, card.header.authorNameBounds);
    const ocrAuthorOnly = ocrName.replace(/关注|關注|follow/gi, '').trim();
    const ocrReadable = extractOcrReadableText(ocrAuthorOnly);

    const nameSim = Math.max(
      nameSimilarity(ocrAuthorOnly, cleanPageName),
      nameSimilarity(ocrAuthorOnly, page.name),
      nameSimilarity(ocrAuthorOnly, page.id),
    );
    const avatarSim = isLocalAvatar(page.avatarUrl)
      ? await compareAvatarToRegion(png, card.header.avatarBounds, page.avatarUrl)
      : 0;

    // Reject self-posts authored by the acting personal account when distinct from the Page
    const cleanActing = actingAccountName.trim();
    if (
      cleanActing.length >= 2 &&
      ocrReadable.length >= 3 &&
      nameSimilarity(ocrAuthorOnly, cleanActing) >= 0.78 &&
      nameSim < 0.45 &&
      avatarSim < 0.85
    ) {
      return null;
    }

    // Reject visitor posts whose avatar or Latin/CJK author name strongly disagrees with the Page
    const candReadable = extractOcrReadableText(cleanPageName);
    const candPureOcrScript =
      !isPlaceholderTargetName(page.name, page.id) &&
      candReadable.length >= 3 &&
      !hasUnsupportedOcrScript(cleanPageName);

    if (candPureOcrScript && ocrReadable.length >= 5 && nameSim < 0.2 && avatarSim < 0.85) {
      return null;
    }
    if (
      !isPlaceholderTargetName(page.name, page.id) &&
      candReadable.length === 0 &&
      ocrReadable.length >= 5 &&
      avatarSim < 0.85
    ) {
      return null;
    }
    if (avatarSim > 0 && avatarSim < 0.65 && nameSim < 0.45) {
      return null;
    }

    return {
      target: page,
      authorName: ocrAuthorOnly || cleanPageName || page.name,
    };
  }

  private async matchPostTarget(
    png: Buffer,
    card: LitePostCard,
    candidates: readonly BumperTarget[],
    isDedicatedMemberFeed: boolean,
  ): Promise<{ target: BumperTarget; authorName: string } | null> {
    if (isDedicatedMemberFeed) {
      const only = candidates[0];
      if (!only) return null;
      if (only.avatarUrl) {
        const sim = await compareAvatarToRegion(png, card.header.avatarBounds, only.avatarUrl);
        if (sim > 0 && sim < 0.72) return null;
      }
      return { target: only, authorName: only.name };
    }

    const ocrName = await this.ocr.recognizeBounds(png, card.header.authorNameBounds);
    const ocrAuthorOnly = ocrName.replace(/关注|關注|follow/gi, '');
    const ocrReadable = extractOcrReadableText(ocrAuthorOnly);
    const ocrHasReadableText = ocrReadable.length >= 3;
    let best: { target: BumperTarget; score: number } | null = null;

    for (const candidate of candidates) {
      const candReadable = extractOcrReadableText(candidate.name);
      const candPureOcrScript =
        candReadable.length >= 3 && !hasUnsupportedOcrScript(candidate.name);
      const nameSim = Math.max(
        nameSimilarity(ocrAuthorOnly, candidate.name),
        nameSimilarity(ocrAuthorOnly, candidate.id),
      );

      const avatarSim = candidate.avatarUrl
        ? await compareAvatarToRegion(png, card.header.avatarBounds, candidate.avatarUrl)
        : 0;

      // Veto when BOTH candidate and OCR output are pure supported scripts and strongly disagree
      if (candPureOcrScript && ocrReadable.length >= 4 && nameSim < 0.25 && avatarSim < 0.92) {
        continue;
      }
      // Veto when candidate has zero Latin/CJK chars (e.g. pure Myanmar) while screen shows a long Latin/CJK author name
      if (candReadable.length === 0 && ocrReadable.length >= 5 && avatarSim < 0.92) {
        continue;
      }

      const matchedByName = candPureOcrScript && ocrHasReadableText && nameSim >= 0.52;
      const matchedByAvatar = Boolean(candidate.avatarUrl) && avatarSim >= 0.86;
      const score = Math.max(matchedByName ? nameSim : 0, matchedByAvatar ? avatarSim : 0);

      if ((matchedByName || matchedByAvatar) && (!best || score > best.score)) {
        best = { target: candidate, score };
      }
    }
    return best ? { target: best.target, authorName: ocrName || best.target.name } : null;
  }

  async run(
    instanceId: string,
    groups: readonly BumperTarget[],
    pages: readonly BumperTarget[],
    settings: BumperSettings,
    signal: AbortSignal,
    callbacks: {
      status(text: string, today?: number): void;
      added(today: number): void;
    },
    mode: BluestacksBumperMode = 'group',
  ): Promise<void> {
    const guard = () => {
      if (signal.aborted) throw new Error('TASK_STOPPED');
    };

    const isPageMode = mode === 'page' || (groups.length === 1 && groups[0]?.id === '-');
    const sourceMode: BumperScope = isPageMode ? 'page' : 'group';
    const maxPostsPerTarget = isPageMode
      ? (settings.maxPostsPerPage ?? 3)
      : settings.maxPostsPerGroupPage;

    callbacks.status('正在校验模拟器连接与 FB Lite 账号登录状态…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);
    const { serial, fbWidth: sw, fbHeight: sh, accountId } = inst;
    guard();

    let lastAppliedStreamSound: boolean | null = null;
    const syncStreamSound = async (): Promise<boolean> => {
      const wantSound = await this.resolveLiveEnableSound(settings, sourceMode);
      if (wantSound !== lastAppliedStreamSound) {
        await this.applyDeviceStreamSound(serial, wantSound, signal);
        lastAppliedStreamSound = wantSound;
      }
      return wantSound;
    };
    await syncStreamSound();
    guard();

    const mutablePages = pages.map((p) => ({ ...p }));
    const outerGroups: readonly BumperTarget[] = isPageMode
      ? [
          {
            id: '-',
            name: '专页主页',
            avatarUrl: null,
            folderId: null,
            sortOrder: 0,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ]
      : groups;

    for (const rawGroup of outerGroups) {
      guard();
      const initialQuota = await this.repo.eligibility(
        accountId,
        instanceId,
        '',
        Date.now(),
        sourceMode,
      );
      if (initialQuota.today >= settings.dailyMaxLikesPerAccount) {
        callbacks.status(
          `今日已达上限 (${initialQuota.today}/${settings.dailyMaxLikesPerAccount})`,
          initialQuota.today,
        );
        return;
      }

      let group: BumperTarget = rawGroup;
      if (!isPageMode) {
        try {
          group = await this.enterAndVerifyGroup(
            inst,
            rawGroup,
            settings.searchMode,
            signal,
            (txt) => callbacks.status(txt, initialQuota.today),
          );
          if (settings.searchMode === 'time_sort') {
            callbacks.status(`正在切换最新帖子排序 · ${group.name}`, initialQuota.today);
            await this.switchGroupSortToNewest(inst, signal);
          }
        } catch (err) {
          if (isFatalDeviceOrStopError(err, signal)) throw err;
          callbacks.status(`小组访问超时或不可用，跳过 · ${rawGroup.name}`, initialQuota.today);
          continue;
        }
      }

      const feeds: Array<BumperTarget | null> = isPageMode
        ? mutablePages
        : settings.searchMode === 'page_group_feed'
          ? mutablePages
          : [null];

      for (const feed of feeds) {
        guard();
        if (isPageMode) {
          const pageQuota = await this.repo.eligibility(
            accountId,
            instanceId,
            '',
            Date.now(),
            sourceMode,
          );
          if (pageQuota.today >= settings.dailyMaxLikesPerAccount) {
            callbacks.status(
              `今日已达上限 (${pageQuota.today}/${settings.dailyMaxLikesPerAccount})`,
              pageQuota.today,
            );
            return;
          }
        }
        let activeFeed = feed;
        try {
          if (isPageMode && activeFeed) {
            activeFeed = await this.enterAndVerifyPage(inst, activeFeed, signal, (txt) =>
              callbacks.status(txt),
            );
          } else if (activeFeed) {
            activeFeed = await this.openPageGroupFeed(inst, group, activeFeed, signal, (txt) =>
              callbacks.status(txt),
            );
          } else {
            const initialXml = await this.devices.dumpXml(serial, sw, sh, signal);
            if (extractPostCards(initialXml).length === 0) {
              await this.devices.swipe900(serial, 115, 1180, 115, 580, 520, sw, sh, signal);
              await abortableWait(1300, signal);
            }
          }
        } catch (err) {
          if (isFatalDeviceOrStopError(err, signal)) throw err;
          if (isPageMode && feed) {
            callbacks.status(`专页访问超时或不可用，跳过 · ${feed.name}`);
          }
          continue;
        }

        const expectedFeedUrl =
          isPageMode && activeFeed
            ? `https://www.facebook.com/${encodeURIComponent(activeFeed.id)}`
            : activeFeed
              ? `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(activeFeed.id)}/`
              : this.buildGroupUrl(group.id, settings.searchMode);

        const seenFingerprints = new Set<string>();
        const seenCardSigs: Float32Array[] = [];
        const scannedPerTarget = new Map<string, number>();
        let emptyScrolls = 0;
        let consecutiveExpired = 0;
        let prevScrollDidAlign = false;
        const maxEmptyScrolls = isPageMode ? 4 : activeFeed ? 2 : 5;
        const maxScrolls = isPageMode
          ? Math.min(36, Math.max(12, maxPostsPerTarget * 6))
          : activeFeed
            ? Math.max(6, maxPostsPerTarget * 2)
            : settings.searchMode === 'random_browse'
              ? Math.max(12, maxPostsPerTarget * 2)
              : Math.min(36, Math.max(22, maxPostsPerTarget * 3));

        for (
          let scrollIdx = 0;
          scrollIdx < maxScrolls && emptyScrolls < maxEmptyScrolls;
          scrollIdx++
        ) {
          guard();
          callbacks.status(
            isPageMode && activeFeed
              ? `正在扫描帖子 (${scrollIdx + 1}/${maxScrolls}) · ${activeFeed.name}`
              : `正在扫描帖子 (${scrollIdx + 1}/${maxScrolls}) · ${group.name}${activeFeed ? ' · ' + activeFeed.name : ''}`,
          );

          let xml: LiteXmlNode | null = null;
          let png: Buffer;
          try {
            const recovered = await this.recoverToFeedIfNeeded(
              inst,
              expectedFeedUrl,
              signal,
              (txt) => callbacks.status(txt),
            );
            xml = recovered.xml;
            png = recovered.png;
          } catch (err) {
            if (isFatalDeviceOrStopError(err, signal)) throw err;
            break;
          }

          const cards = extractPostCards(xml);
          let newCardsInScroll = 0;
          let scrolledDuringCards = false;
          await syncStreamSound();

          for (let cardIdx = 0; cardIdx < cards.length; cardIdx++) {
            const card = cards[cardIdx];
            if (!card) continue;
            if (scrolledDuringCards) break;
            guard();

            const bodyProbeY1 = Math.max(108, Math.min(1440, card.header.bounds.y2 - 24));
            const bodyProbeY2 = Math.min(1520, card.header.bounds.y2 + 164);
            const cardSig =
              bodyProbeY2 - bodyProbeY1 >= 48
                ? await getRegionSignature(
                    png,
                    makeCanonicalRect(18, bodyProbeY1, 882, bodyProbeY2),
                  )
                : null;
            if (
              cardSig &&
              seenCardSigs.some((prev) => signatureSimilarity(cardSig, prev) >= 0.988)
            ) {
              continue;
            }
            if (cardSig) {
              seenCardSigs.push(cardSig);
            }
            newCardsInScroll++;

            if (!isPageMode && settings.searchMode !== 'random_browse') {
              let timeText = await this.ocr.recognizeBounds(png, card.header.timestampBounds);
              let ageHours = relativePostAge(timeText);
              if (ageHours === null) {
                const fallbackTsBounds = makeCanonicalRect(
                  card.header.timestampBounds.x1,
                  Math.max(0, card.header.timestampBounds.y1 - 6),
                  card.header.timestampBounds.x2,
                  Math.min(1600, card.header.timestampBounds.y2 + 6),
                );
                timeText = await this.ocr.recognizeBounds(png, fallbackTsBounds);
                ageHours = relativePostAge(timeText);
              }
              if (ageHours === null || ageHours > settings.maxPostAgeHours) {
                if (ageHours !== null && ageHours > settings.maxPostAgeHours) {
                  consecutiveExpired++;
                  if (
                    (settings.searchMode === 'time_sort' || Boolean(activeFeed)) &&
                    consecutiveExpired >= 2
                  ) {
                    break;
                  }
                }
                continue;
              }
              consecutiveExpired = 0;
            }

            const match =
              isPageMode && activeFeed
                ? await this.matchPageTimelinePost(png, card, activeFeed, inst.accountName)
                : await this.matchPostTarget(
                    png,
                    card,
                    activeFeed ? [activeFeed] : mutablePages,
                    Boolean(activeFeed),
                  );
            if (!match) continue;
            const { target } = match;

            if ((scannedPerTarget.get(target.id) ?? 0) >= maxPostsPerTarget) {
              continue;
            }

            const needAvatar = !isLocalAvatar(target.avatarUrl);
            const needName =
              isPageMode &&
              isPlaceholderTargetName(target.name, target.id) &&
              match.authorName.trim().length > 0 &&
              !isPlaceholderTargetName(match.authorName, target.id);
            if (needAvatar || needName) {
              const cropped = needAvatar
                ? await cropToDataUrl(png, card.header.avatarBounds, 96)
                : null;
              if (cropped || needName) {
                await Promise.resolve(
                  this.targetAvatarUpdater.applyResolvedTargetMetadata('pages', target.id, {
                    ...(cropped ? { avatarUrl: cropped } : {}),
                    ...(needName ? { name: match.authorName.trim() } : {}),
                  }),
                ).catch(() => null);
                if (cropped) target.avatarUrl = cropped;
                if (needName) target.name = match.authorName.trim();
              }
            }

            const earlyWantSound = await syncStreamSound();
            const nextVisibleCard = cards[cardIdx + 1];
            const earlyMaxY = card.actionBar
              ? card.actionBar.y1 + 16
              : nextVisibleCard
                ? nextVisibleCard.header.bounds.y1
                : 1600;
            const earlyVideoSync = await this.syncVideoSpeakerIfVisible(
              serial,
              sw,
              sh,
              xml,
              png,
              card.header.bounds.y2,
              earlyMaxY,
              true,
              earlyWantSound,
              signal,
            );
            png = earlyVideoSync.png;

            let postId = '';
            let postUrl = '';
            const moreBounds = card.header.moreMenuBounds;
            if (moreBounds) {
              callbacks.status(`正在提取帖子链接 · ${target.name}`);
              try {
                const rawClipUrl = await this.devices.copyLinkFromMoreMenu(
                  serial,
                  moreBounds,
                  sw,
                  sh,
                  signal,
                );
                if (rawClipUrl) {
                  const resolved = await resolveSharePostUrl(
                    rawClipUrl,
                    isPageMode ? target.id : group.id,
                    sourceMode,
                  );
                  postId = resolved.postId;
                  postUrl = resolved.postUrl;
                }
              } catch (linkErr) {
                const msg = linkErr instanceof Error ? linkErr.message : String(linkErr);
                if (
                  signal?.aborted ||
                  /TASK_STOPPED|device\s+offline|device\s+'.*'\s+not\s+found|cannot\s+connect\s+to\s+daemon/i.test(
                    msg,
                  )
                ) {
                  throw linkErr;
                }
              }
            }

            let workingActionBar: LitePostActionBar | null = card.actionBar;
            let workingXml: LiteXmlNode | null = xml;
            let workingPng = png;
            let workingHeaderBottomY = card.header.bounds.y2;
            let workingHeaderOnScreen = true;
            if (!workingActionBar) {
              let currentHeaderY = card.header.bounds.y1;
              let prevStepBars = extractActionBars(xml);
              for (let alignStep = 0; alignStep < 5 && !workingActionBar; alignStep++) {
                await this.devices.swipe900(serial, 115, 1120, 115, 420, 900, sw, sh, signal);
                scrolledDuringCards = true;
                await abortableWait(1350, signal);
                const { xml: nextXml, png: nextPng } = await this.recoverToFeedIfNeeded(
                  inst,
                  expectedFeedUrl,
                  signal,
                  (txt) => callbacks.status(txt),
                );
                const nextCards = extractPostCards(nextXml);
                const nextBars = extractActionBars(nextXml);
                const hadBarAboveBefore = prevStepBars.some((b) => b.y1 < currentHeaderY);

                const candidateShifted = nextCards.find(
                  (nc) =>
                    nc.header.bounds.y1 <= currentHeaderY - 180 &&
                    nc.header.bounds.y1 >= currentHeaderY - 920,
                );
                const topUnparentedBar = nextBars[0];
                const hasUnparentedBarAboveCandidate = Boolean(
                  candidateShifted &&
                  topUnparentedBar &&
                  topUnparentedBar.y1 >= 115 &&
                  topUnparentedBar.y1 < candidateShifted.header.bounds.y1,
                );

                if (
                  candidateShifted &&
                  (hadBarAboveBefore || currentHeaderY >= 960 || !hasUnparentedBarAboveCandidate)
                ) {
                  currentHeaderY = candidateShifted.header.bounds.y1;
                  prevStepBars = nextBars;
                  workingHeaderBottomY = candidateShifted.header.bounds.y2;
                  workingHeaderOnScreen = true;
                  if (candidateShifted.actionBar) {
                    workingActionBar = candidateShifted.actionBar;
                    workingXml = nextXml;
                    workingPng = nextPng;
                  }
                  continue;
                }

                if (currentHeaderY >= 960) {
                  currentHeaderY -= 680;
                  prevStepBars = nextBars;
                  continue;
                }

                currentHeaderY = -100;
                prevStepBars = nextBars;
                workingHeaderBottomY = 106;
                workingHeaderOnScreen = false;
                if (topUnparentedBar) {
                  const firstNextHeaderY = nextCards[0]?.header.bounds.y1 ?? 1600;
                  if (topUnparentedBar.y1 >= 115 && topUnparentedBar.y1 < firstNextHeaderY) {
                    workingActionBar = topUnparentedBar;
                    workingXml = nextXml;
                    workingPng = nextPng;
                  }
                }
              }
            }

            if (!workingActionBar) continue;

            if (!postId) {
              const fallbackKey = `${group.id}:${target.id}:${scrollIdx}:${card.header.bounds.y1}`;
              postId = BigInt(
                '0x' + createHash('sha256').update(fallbackKey).digest('hex').slice(0, 14),
              ).toString(10);
              postUrl = isPageMode
                ? `https://www.facebook.com/${encodeURIComponent(target.id)}`
                : `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(target.id)}/`;
            }

            if (seenFingerprints.has(postId)) continue;
            seenFingerprints.add(postId);

            const scannedCount = scannedPerTarget.get(target.id) ?? 0;
            if (scannedCount >= maxPostsPerTarget) continue;
            if (isPageMode) {
              scannedPerTarget.set(target.id, scannedCount + 1);
            }

            while (this.postClaims.has(postId)) {
              await abortableWait(100, signal);
            }
            this.postClaims.add(postId);

            let reservedCommentId: string | null = null;
            try {
              const q = await this.repo.eligibility(
                accountId,
                instanceId,
                postId,
                Date.now(),
                sourceMode,
              );
              if (q.today >= settings.dailyMaxLikesPerAccount) {
                callbacks.status(
                  `今日已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`,
                  q.today,
                );
                return;
              }
              if (!q.allowed) continue;

              const alreadyLiked = await isLikeButtonBlue(workingPng, workingActionBar.likeBounds);
              const doLike = !alreadyLiked && Math.random() * 100 < settings.likeProbability;
              const chosenComment =
                Math.random() * 100 < settings.commentProbability
                  ? await this.repo.pickComment(
                      postId,
                      Math.random(),
                      [...this.commentClaims],
                      sourceMode,
                    )
                  : null;
              if (chosenComment) {
                reservedCommentId = chosenComment.id;
                this.commentClaims.add(chosenComment.id);
              }

              if (!doLike && !chosenComment) continue;

              const record: BumperLog = {
                id: randomUUID(),
                profileId: instanceId,
                accountId,
                groupId: isPageMode ? '-' : group.id,
                groupName: isPageMode ? '专页主页' : group.name,
                pageId: target.id,
                pageName: target.name,
                postId,
                postUrl,
                liked: false,
                commentText: null,
                bumpedAt: Date.now(),
                sourceMode,
              };

              let credited = false;
              const persistRecord = async () => {
                await this.repo.recordBump(record, chosenComment?.id);
                if (!credited) {
                  credited = true;
                  if (!isPageMode) {
                    scannedPerTarget.set(target.id, (scannedPerTarget.get(target.id) ?? 0) + 1);
                  }
                  const updatedQuota = await this.repo.eligibility(
                    accountId,
                    instanceId,
                    postId,
                    Date.now(),
                    sourceMode,
                  );
                  callbacks.added(updatedQuota.today);
                }
              };

              const actionTargetLabel = isPageMode ? target.name : `${group.name} · ${target.name}`;

              const liveWantSound = await syncStreamSound();
              const syncedVideo = await this.syncVideoSpeakerIfVisible(
                serial,
                sw,
                sh,
                workingXml,
                workingPng,
                workingHeaderBottomY,
                workingActionBar.y1 + 16,
                workingHeaderOnScreen,
                liveWantSound,
                signal,
              );
              workingPng = syncedVideo.png;
              if (syncedVideo.controls.videoBounds && !syncedVideo.controls.ended) {
                callbacks.status(`正在观看视频 · ${actionTargetLabel}`, q.today);
                await abortableWait(liveWantSound ? 2800 : 1100, signal);
              }

              if (doLike) {
                callbacks.status(`正在点赞 · ${actionTargetLabel}`, q.today);
                await this.devices.tap900(
                  serial,
                  workingActionBar.likeBounds.cx,
                  workingActionBar.likeBounds.cy,
                  sw,
                  sh,
                  signal,
                );
                await abortableWait(1400, signal);
                const verifyPng = await this.devices.screencap(serial, signal);
                const confirmedBlue = await isLikeButtonBlue(
                  verifyPng,
                  workingActionBar.likeBounds,
                );
                if (confirmedBlue) {
                  record.liked = true;
                  await persistRecord();
                }
              }

              if (chosenComment) {
                guard();
                callbacks.status(`正在留言 · ${actionTargetLabel}`, q.today);
                await this.devices.tap900(
                  serial,
                  workingActionBar.commentBounds.cx,
                  workingActionBar.commentBounds.cy,
                  sw,
                  sh,
                  signal,
                );
                await abortableWait(1800, signal);

                const commentOpenXml = await this.devices.dumpXml(serial, sw, sh, signal);
                const inputNode = findTextInputNode(commentOpenXml);
                const inputX = inputNode?.bounds.cx ?? 300;
                const inputY = inputNode?.bounds.cy ?? 1480;

                await this.devices.pasteIntoFocused(
                  serial,
                  inputX,
                  inputY,
                  chosenComment.text,
                  sw,
                  sh,
                  signal,
                );
                await abortableWait(800, signal);

                const sendRowY = inputNode ? inputNode.bounds.cy : 1484;
                const primarySendBounds: RectBounds = makeCanonicalRect(
                  790,
                  Math.max(0, sendRowY - 42),
                  900,
                  Math.min(1600, sendRowY + 42),
                );
                const fallbackSendBounds: RectBounds = makeCanonicalRect(790, 1440, 900, 1520);

                const typedPng = await this.devices.screencap(serial, signal);
                const primaryBlue = await isLikeButtonBlue(typedPng, primarySendBounds);
                const activeSendBounds = primaryBlue
                  ? primarySendBounds
                  : (await isLikeButtonBlue(typedPng, fallbackSendBounds))
                    ? fallbackSendBounds
                    : null;

                if (activeSendBounds) {
                  await this.devices.tap900(serial, 854, activeSendBounds.cy, sw, sh, signal);
                  await abortableWait(2400, signal);

                  const afterSendPng = await this.devices.screencap(serial, signal);
                  const stillBlueAfterSend = await isLikeButtonBlue(afterSendPng, activeSendBounds);
                  if (!stillBlueAfterSend) {
                    record.commentText = chosenComment.text;
                    await persistRecord();
                  }
                }

                await this.devices.keyevent(serial, 4, signal);
                await abortableWait(950, signal);
                const afterBackXml = await this.devices.dumpXml(serial, sw, sh, signal);
                if (findTextInputNode(afterBackXml)) {
                  await this.devices.keyevent(serial, 4, signal);
                  await abortableWait(1100, signal);
                }
              }
            } finally {
              if (reservedCommentId) {
                this.commentClaims.delete(reservedCommentId);
              }
              this.postClaims.delete(postId);
            }
          }

          if (
            !isPageMode &&
            (settings.searchMode === 'time_sort' || Boolean(activeFeed)) &&
            consecutiveExpired >= 2
          ) {
            break;
          }
          if (
            (activeFeed ? [activeFeed] : mutablePages).every(
              (p) => (scannedPerTarget.get(p.id) ?? 0) >= maxPostsPerTarget,
            )
          ) {
            break;
          }

          // If alignStep already scrolled the feed to expose the current post's action bar,
          // re-scan the newly exposed viewport immediately instead of flinging past the next post's header!
          if (scrolledDuringCards) {
            emptyScrolls = 0;
            prevScrollDidAlign = true;
            continue;
          }

          const seeMoreNode = findSeeMoreButtonNode(xml);
          if (seeMoreNode) {
            callbacks.status(
              `正在展开更多帖子 · ${isPageMode && activeFeed ? activeFeed.name : group.name}`,
            );
            await this.devices.tap900(serial, 450, seeMoreNode.bounds.cy, sw, sh, signal);
            await abortableWait(1900, signal);
            emptyScrolls = 0;
            prevScrollDidAlign = false;
          } else if (newCardsInScroll === 0) {
            if (!prevScrollDidAlign) {
              emptyScrolls++;
              if (!isPageMode && activeFeed && seenCardSigs.length > 0) {
                break;
              }
            }
            prevScrollDidAlign = false;
          } else {
            emptyScrolls = 0;
            prevScrollDidAlign = false;
          }

          if (emptyScrolls >= maxEmptyScrolls) {
            break;
          }

          const swipeStart = 1260 + Math.floor(Math.random() * 90);
          const swipeEnd = 360 + Math.floor(Math.random() * 110);
          await this.devices.swipe900(serial, 115, swipeStart, 115, swipeEnd, 560, sw, sh, signal);
          await abortableWait(1100 + Math.floor(Math.random() * 700), signal);
        }
      }
    }
  }
}
