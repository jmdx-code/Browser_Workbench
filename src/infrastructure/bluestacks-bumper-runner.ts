import { createHash, randomUUID } from 'node:crypto';
import type { CompatibleRepository } from '../domain/persistence.js';
import {
  extractOcrReadableText,
  hasUnsupportedOcrScript,
  nameSimilarity,
  relativePostAge,
  type BluestacksInstance,
} from '../shared/bluestacks.js';
import type {
  BumperComment,
  BumperLog,
  BumperSettings,
  BumperTarget,
} from '../shared/group-bumper.js';
import { abortableWait, type BluestacksDeviceManager } from './bluestacks-device-manager.js';
import {
  compareAvatarToRegion,
  cropToDataUrl,
  extractActionBars,
  extractPostCards,
  findGroupSortButtonNode,
  findJoinGroupButtonNode,
  findRelatedGroupsCloseButtonNode,
  findSeeMoreButtonNode,
  findTextInputNode,
  flattenLiteNodes,
  getRegionSignature,
  isBottomSheetOpen,
  isDarkScreenOrReelMode,
  isLikeButtonBlue,
  makeCanonicalRect,
  resolveSharePostUrl,
  signatureSimilarity,
  type LitePostActionBar,
  type LitePostCard,
  type LiteXmlNode,
  type OcrRecognizer,
  type RectBounds,
} from './bluestacks-vision.js';

export interface BluestacksBumperRunnerRepo {
  eligibility(
    accountId: string,
    instanceId: string,
    postId: string,
    now?: number,
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
  ): Promise<void> {
    const guard = () => {
      if (signal.aborted) throw new Error('TASK_STOPPED');
    };

    callbacks.status('正在校验模拟器连接与 FB Lite 账号登录状态…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);
    const { serial, fbWidth: sw, fbHeight: sh, accountId } = inst;
    guard();

    const mutablePages = pages.map((p) => ({ ...p }));

    for (const rawGroup of groups) {
      guard();
      const initialQuota = await this.repo.eligibility(accountId, instanceId, '');
      if (initialQuota.today >= settings.dailyMaxLikesPerAccount) {
        callbacks.status(
          `今日已达上限 (${initialQuota.today}/${settings.dailyMaxLikesPerAccount})`,
          initialQuota.today,
        );
        return;
      }

      let group: BumperTarget;
      try {
        group = await this.enterAndVerifyGroup(inst, rawGroup, settings.searchMode, signal, (txt) =>
          callbacks.status(txt, initialQuota.today),
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

      const feeds: Array<BumperTarget | null> =
        settings.searchMode === 'page_group_feed' ? mutablePages : [null];

      for (const feed of feeds) {
        guard();
        let activeFeed = feed;
        try {
          if (activeFeed) {
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
          continue;
        }

        const expectedFeedUrl = activeFeed
          ? `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(activeFeed.id)}/`
          : this.buildGroupUrl(group.id, settings.searchMode);

        const seenFingerprints = new Set<string>();
        const seenCardSigs: Float32Array[] = [];
        const scannedPerTarget = new Map<string, number>();
        let emptyScrolls = 0;
        let consecutiveExpired = 0;
        const maxEmptyScrolls = activeFeed ? 2 : 5;
        const maxScrolls = activeFeed
          ? Math.max(6, settings.maxPostsPerGroupPage * 2)
          : settings.searchMode === 'random_browse'
            ? Math.max(12, settings.maxPostsPerGroupPage * 2)
            : Math.min(36, Math.max(22, settings.maxPostsPerGroupPage * 3));

        for (
          let scrollIdx = 0;
          scrollIdx < maxScrolls && emptyScrolls < maxEmptyScrolls;
          scrollIdx++
        ) {
          guard();
          callbacks.status(
            `正在扫描帖子 (${scrollIdx + 1}/${maxScrolls}) · ${group.name}${activeFeed ? ' · ' + activeFeed.name : ''}`,
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

          for (const card of cards) {
            guard();

            const bodyProbeY1 = Math.min(1460, card.header.bounds.y2 + 4);
            const bodyProbeY2 = Math.min(1520, bodyProbeY1 + 88);
            const cardSig = await getRegionSignature(
              png,
              makeCanonicalRect(20, bodyProbeY1, 880, Math.max(bodyProbeY1 + 16, bodyProbeY2)),
            );
            if (
              cardSig &&
              seenCardSigs.some((prev) => signatureSimilarity(cardSig, prev) >= 0.96)
            ) {
              continue;
            }
            if (cardSig) {
              seenCardSigs.push(cardSig);
            }
            newCardsInScroll++;

            if (settings.searchMode !== 'random_browse') {
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

            const match = await this.matchPostTarget(
              png,
              card,
              activeFeed ? [activeFeed] : mutablePages,
              Boolean(activeFeed),
            );
            if (!match) continue;
            const { target } = match;

            if ((scannedPerTarget.get(target.id) ?? 0) >= settings.maxPostsPerGroupPage) {
              continue;
            }

            if (!target.avatarUrl) {
              const cropped = await cropToDataUrl(png, card.header.avatarBounds, 96);
              if (cropped) {
                await Promise.resolve(
                  this.targetAvatarUpdater.applyResolvedTargetMetadata('pages', target.id, {
                    avatarUrl: cropped,
                  }),
                ).catch(() => null);
                target.avatarUrl = cropped;
              }
            }

            let postId = '';
            let postUrl = '';
            const moreBounds = card.header.moreMenuBounds;
            if (moreBounds) {
              callbacks.status(`正在提取帖子链接 · ${target.name}`);
              const rawClipUrl = await this.devices.copyLinkFromMoreMenu(
                serial,
                moreBounds,
                sw,
                sh,
                signal,
              );
              if (rawClipUrl) {
                const resolved = await resolveSharePostUrl(rawClipUrl, group.id);
                postId = resolved.postId;
                postUrl = resolved.postUrl;
              }
            }

            let workingActionBar: LitePostActionBar | null = card.actionBar;
            let workingPng = png;
            if (!workingActionBar) {
              for (let alignStep = 0; alignStep < 3 && !workingActionBar; alignStep++) {
                const startY = alignStep === 0 ? Math.max(820, card.header.bounds.y1 + 260) : 1220;
                await this.devices.swipe900(serial, 115, startY, 115, 280, 750, sw, sh, signal);
                await abortableWait(1350, signal);
                const { xml: nextXml, png: nextPng } = await this.recoverToFeedIfNeeded(
                  inst,
                  expectedFeedUrl,
                  signal,
                  (txt) => callbacks.status(txt),
                );
                const nextCards = extractPostCards(nextXml);
                const nextBars = extractActionBars(nextXml);

                const firstBar = nextBars[0];
                if (firstBar) {
                  const firstNextHeaderY = nextCards[0]?.header.bounds.y1 ?? 1600;
                  if (firstBar.y1 >= 150 && firstBar.y1 < firstNextHeaderY) {
                    workingActionBar = firstBar;
                    workingPng = nextPng;
                  }
                }

                const topNextCard = nextCards[0];
                if (!workingActionBar && topNextCard?.actionBar) {
                  const m = await this.matchPostTarget(
                    nextPng,
                    topNextCard,
                    [target],
                    Boolean(activeFeed),
                  );
                  if (m) {
                    workingActionBar = topNextCard.actionBar;
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
              postUrl = `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(target.id)}/`;
            }

            if (seenFingerprints.has(postId)) continue;
            seenFingerprints.add(postId);

            const scannedCount = scannedPerTarget.get(target.id) ?? 0;
            if (scannedCount >= settings.maxPostsPerGroupPage) continue;

            while (this.postClaims.has(postId)) {
              await abortableWait(100, signal);
            }
            this.postClaims.add(postId);

            let reservedCommentId: string | null = null;
            try {
              const q = await this.repo.eligibility(accountId, instanceId, postId);
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
                  ? await this.repo.pickComment(postId, Math.random(), [...this.commentClaims])
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
                groupId: group.id,
                groupName: group.name,
                pageId: target.id,
                pageName: target.name,
                postId,
                postUrl,
                liked: false,
                commentText: null,
                bumpedAt: Date.now(),
                sourceMode: 'group',
              };

              let credited = false;
              const persistRecord = async () => {
                await this.repo.recordBump(record, chosenComment?.id);
                if (!credited) {
                  credited = true;
                  scannedPerTarget.set(target.id, (scannedPerTarget.get(target.id) ?? 0) + 1);
                  const updatedQuota = await this.repo.eligibility(accountId, instanceId, postId);
                  callbacks.added(updatedQuota.today);
                }
              };

              if (doLike) {
                callbacks.status(`正在点赞 · ${group.name} · ${target.name}`, q.today);
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
                callbacks.status(`正在留言 · ${group.name} · ${target.name}`, q.today);
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
            (settings.searchMode === 'time_sort' || Boolean(activeFeed)) &&
            consecutiveExpired >= 2
          ) {
            break;
          }
          if (
            (activeFeed ? [activeFeed] : mutablePages).every(
              (p) => (scannedPerTarget.get(p.id) ?? 0) >= settings.maxPostsPerGroupPage,
            )
          ) {
            break;
          }

          const seeMoreNode = findSeeMoreButtonNode(xml);
          if (seeMoreNode) {
            callbacks.status(`正在展开更多帖子 · ${group.name}`);
            await this.devices.tap900(serial, 450, seeMoreNode.bounds.cy, sw, sh, signal);
            await abortableWait(1900, signal);
            emptyScrolls = 0;
          } else if (newCardsInScroll === 0) {
            emptyScrolls++;
            if (activeFeed && seenCardSigs.length > 0) {
              break;
            }
          } else {
            emptyScrolls = 0;
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
