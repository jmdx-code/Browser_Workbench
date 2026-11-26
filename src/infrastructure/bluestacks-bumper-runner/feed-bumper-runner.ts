import { randomUUID } from 'node:crypto';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  relativePostAge,
  type BluestacksBumperMode,
  type BluestacksInstance,
} from '../../shared/bluestacks.js';
import {
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperLog,
  type BumperScope,
  type BumperSettings,
  type BumperTarget,
} from '../../shared/group-bumper.js';
import { createScreenOps, sha256NumericId, type ScreenOps } from '../bluestacks-device-manager.js';
import {
  cropToDataUrl,
  extractActionBars,
  extractPostCards,
  findSeeMoreButtonNode,
  getRegionSignature,
  isReactionButtonActive,
  makeCanonicalRect,
  resolveSharePostUrl,
  signatureSimilarity,
  type LitePostActionBar,
  type LitePostCard,
  type LiteXmlNode,
} from '../bluestacks-vision.js';
import {
  buildGroupUrl,
  enterAndVerifyGroup,
  enterAndVerifyPage,
  executeBarActions,
  isFatalDeviceOrStopError,
  matchPageTimelinePost,
  matchPostTarget,
  openPageGroupFeed,
  recoverToFeedIfNeeded,
  resolveLiveEnableSound,
  switchGroupSortToNewest,
  syncVideoSpeakerIfVisible,
  type BluestacksBumperContext,
} from '../bluestacks-bumper-runner.js';
interface FeedScanCtx {
  ctx: BluestacksBumperContext;
  ops: ScreenOps;
  inst: BluestacksInstance;
  instanceId: string;
  isPageMode: boolean;
  sourceMode: BumperScope;
  group: BumperTarget;
  activeFeed: BumperTarget | null;
  mutablePages: BumperTarget[];
  settings: BumperSettings;
  maxPostsPerTarget: number;
  expectedFeedUrl: string;
  seenFingerprints: Set<string>;
  seenCardSigs: Float32Array[];
  scannedPerTarget: Map<string, number>;
  stats: {
    cardsSeen: number;
    ageNullSkips: number;
    ageExpiredSkips: number;
    targetMismatchSkips: number;
    alreadyLikedSkips: number;
    quotaSkips: number;
    missingActionBarSkips: number;
    bumped: number;
  };
  syncStreamSound: () => Promise<boolean>;
  signal: AbortSignal;
  callbacks: { status(text: string, today?: number): void; added(today: number): void };
}
async function processBumperCard(
  sc: FeedScanCtx,
  scrollIdx: number,
  cards: LitePostCard[],
  cardIdx: number,
  xml: LiteXmlNode | null,
  png: Buffer,
  consecutiveExpired: number,
): Promise<{
  action: 'continue' | 'break-cards' | 'return';
  newCard: boolean;
  consecutiveExpired: number;
  scrolledDuringCards: boolean;
  png: Buffer;
}> {
  const {
    ctx,
    ops,
    inst,
    instanceId,
    isPageMode,
    sourceMode,
    group,
    activeFeed,
    mutablePages,
    settings,
    maxPostsPerTarget,
    expectedFeedUrl,
    seenFingerprints,
    seenCardSigs,
    scannedPerTarget,
    stats,
    syncStreamSound,
    signal,
    callbacks,
  } = sc;
  const { serial, fbWidth: sw, fbHeight: sh, accountId } = inst;
  let scrolledDuringCards = false;
  const cont = (newCard = true, action: 'continue' | 'break-cards' | 'return' = 'continue') => ({
    action,
    newCard,
    consecutiveExpired,
    scrolledDuringCards,
    png,
  });
  const card = cards[cardIdx];
  if (!card) return cont(false);
  const bodyProbeY1 = Math.max(108, Math.min(1440, card.header.bounds.y2 - 24)),
    bodyProbeY2 = Math.min(1520, card.header.bounds.y2 + 164),
    cardSig =
      bodyProbeY2 - bodyProbeY1 >= 48
        ? await getRegionSignature(png, makeCanonicalRect(18, bodyProbeY1, 882, bodyProbeY2))
        : null;
  if (cardSig && seenCardSigs.some((prev) => signatureSimilarity(cardSig, prev) >= 0.988))
    return cont(false);
  if (cardSig) seenCardSigs.push(cardSig);
  stats.cardsSeen++;
  if (!isPageMode && settings.searchMode !== 'random_browse') {
    let timeText = await ctx.ocr.recognizeBounds(png, card.header.timestampBounds),
      ageHours = relativePostAge(timeText);
    if (ageHours === null) {
      timeText = await ctx.ocr.recognizeBounds(
        png,
        makeCanonicalRect(
          card.header.timestampBounds.x1,
          Math.max(0, card.header.timestampBounds.y1 - 6),
          card.header.timestampBounds.x2,
          Math.min(1600, card.header.timestampBounds.y2 + 6),
        ),
      );
      ageHours = relativePostAge(timeText);
    }
    if (ageHours === null || ageHours > settings.maxPostAgeHours) {
      if (ageHours === null) stats.ageNullSkips++;
      else {
        stats.ageExpiredSkips++;
        consecutiveExpired++;
        if ((settings.searchMode === 'time_sort' || Boolean(activeFeed)) && consecutiveExpired >= 2)
          return cont(true, 'break-cards');
      }
      return cont();
    }
    consecutiveExpired = 0;
  }
  const match =
    isPageMode && activeFeed
      ? await matchPageTimelinePost(ctx, png, card, activeFeed, inst.accountName)
      : await matchPostTarget(
          ctx,
          png,
          card,
          activeFeed ? [activeFeed] : mutablePages,
          Boolean(activeFeed),
        );
  if (!match) {
    stats.targetMismatchSkips++;
    return cont();
  }
  const { target } = match;
  if ((scannedPerTarget.get(target.id) ?? 0) >= maxPostsPerTarget) return cont();
  const needAvatar = !isLocalAvatar(target.avatarUrl),
    needName =
      isPageMode &&
      isPlaceholderTargetName(target.name, target.id) &&
      match.authorName.trim().length > 0 &&
      !isPlaceholderTargetName(match.authorName, target.id);
  if (needAvatar || needName) {
    const cropped = needAvatar ? await cropToDataUrl(png, card.header.avatarBounds, 96) : null;
    if (cropped || needName) {
      await Promise.resolve(
        ctx.targetAvatarUpdater.applyResolvedTargetMetadata('pages', target.id, {
          ...(cropped ? { avatarUrl: cropped } : {}),
          ...(needName ? { name: match.authorName.trim() } : {}),
        }),
      ).catch(() => null);
      if (cropped) target.avatarUrl = cropped;
      if (needName) target.name = match.authorName.trim();
    }
  }
  const earlyWantSound = await syncStreamSound(),
    nextVisibleCard = cards[cardIdx + 1],
    earlyMaxY = card.actionBar
      ? card.actionBar.y1 + 16
      : nextVisibleCard
        ? nextVisibleCard.header.bounds.y1
        : 1600;
  png = (
    await syncVideoSpeakerIfVisible(
      ops,
      xml,
      png,
      card.header.bounds.y2,
      earlyMaxY,
      true,
      earlyWantSound,
    )
  ).png;
  let postId = '',
    postUrl = '';
  const moreBounds = card.header.moreMenuBounds;
  if (moreBounds) {
    callbacks.status(`正在提取帖子链接 · ${target.name}`);
    try {
      const rawClipUrl = await ctx.devices.copyLinkFromMoreMenu(serial, moreBounds, sw, sh, signal);
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
      )
        throw linkErr;
    }
  }
  let workingActionBar: LitePostActionBar | null = card.actionBar,
    workingXml: LiteXmlNode | null = xml,
    workingPng = png,
    workingHeaderBottomY = card.header.bounds.y2,
    workingHeaderOnScreen = true;
  if (!workingActionBar) {
    let currentHeaderY = card.header.bounds.y1,
      prevStepBars = extractActionBars(xml);
    for (let alignStep = 0; alignStep < 5 && !workingActionBar; alignStep++) {
      await ops.swipe(115, 1120, 115, 420, 900, 1350);
      scrolledDuringCards = true;
      const { xml: nextXml, png: nextPng } = await recoverToFeedIfNeeded(
          ops,
          expectedFeedUrl,
          (txt) => callbacks.status(txt),
        ),
        nextCards = extractPostCards(nextXml),
        nextBars = extractActionBars(nextXml),
        hadBarAboveBefore = prevStepBars.some((b) => b.y1 < currentHeaderY),
        candidateShifted = nextCards.find(
          (nc) =>
            nc.header.bounds.y1 <= currentHeaderY - 180 &&
            nc.header.bounds.y1 >= currentHeaderY - 920,
        ),
        topUnparentedBar = nextBars[0],
        hasUnparentedBarAboveCandidate = Boolean(
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
  if (!workingActionBar) {
    stats.missingActionBarSkips++;
    return cont();
  }
  if (!postId) {
    postId = sha256NumericId(`${group.id}:${target.id}:${scrollIdx}:${card.header.bounds.y1}`);
    postUrl = isPageMode
      ? `https://www.facebook.com/${encodeURIComponent(target.id)}`
      : `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(target.id)}/`;
  }
  if (seenFingerprints.has(postId)) return cont();
  seenFingerprints.add(postId);
  const scannedCount = scannedPerTarget.get(target.id) ?? 0;
  if (scannedCount >= maxPostsPerTarget) return cont();
  if (isPageMode) scannedPerTarget.set(target.id, scannedCount + 1);
  while (ctx.postClaims.has(postId)) await ops.wait(100);
  ctx.postClaims.add(postId);
  let reservedCommentId: string | null = null;
  try {
    const q = await ctx.repo.eligibility(accountId, instanceId, postId, Date.now(), sourceMode);
    if (q.today >= settings.dailyMaxLikesPerAccount) {
      stats.quotaSkips++;
      callbacks.status(`今日已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`, q.today);
      return cont(true, 'return');
    }
    if (!q.allowed) {
      stats.quotaSkips++;
      if (q.riskLimitReason)
        return (callbacks.status(q.riskLimitReason, q.today), cont(true, 'return'));
      return cont();
    }
    const alreadyLiked = await isReactionButtonActive(workingPng, workingActionBar.likeBounds),
      doLike = !alreadyLiked && Math.random() * 100 < settings.likeProbability,
      chosenComment =
        Math.random() * 100 < settings.commentProbability
          ? await ctx.repo.pickComment(postId, Math.random(), [...ctx.commentClaims], sourceMode)
          : null;
    if (chosenComment) {
      reservedCommentId = chosenComment.id;
      ctx.commentClaims.add(chosenComment.id);
    }
    if (!doLike && !chosenComment) {
      if (alreadyLiked) stats.alreadyLikedSkips++;
      return cont();
    }
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
    const persistRecord = async (consumedCommentId?: string) => {
      await ctx.repo.recordBump(record, consumedCommentId);
      if (!credited) {
        credited = true;
        if (!isPageMode)
          scannedPerTarget.set(target.id, (scannedPerTarget.get(target.id) ?? 0) + 1);
        callbacks.added(
          (await ctx.repo.eligibility(accountId, instanceId, postId, Date.now(), sourceMode)).today,
        );
      }
    };
    const actionTargetLabel = isPageMode ? target.name : `${group.name} · ${target.name}`,
      liveWantSound = await syncStreamSound(),
      syncedVideo = await syncVideoSpeakerIfVisible(
        ops,
        workingXml,
        workingPng,
        workingHeaderBottomY,
        workingActionBar.y1 + 16,
        workingHeaderOnScreen,
        liveWantSound,
      );
    workingPng = syncedVideo.png;
    if (syncedVideo.controls.videoBounds && !syncedVideo.controls.ended) {
      callbacks.status(`正在观看视频 · ${actionTargetLabel}`, q.today);
      await ops.wait(liveWantSound ? 2800 : 1100);
    }
    const { didLike, didComment } = await executeBarActions(
      ops,
      workingActionBar,
      settings,
      doLike,
      chosenComment?.text,
      (mode) =>
        callbacks.status(
          mode === 'like'
            ? `${settings.useLongPressReaction ? '正在长按表情互动' : '正在点赞'} · ${actionTargetLabel}`
            : `正在留言 · ${actionTargetLabel}`,
          q.today,
        ),
    );
    if (didLike) {
      record.liked = true;
      await persistRecord(undefined);
    }
    if (didComment && chosenComment) {
      record.commentText = didComment;
      await persistRecord(chosenComment.id);
    }
    if (didLike || (didComment && chosenComment)) stats.bumped++;
  } finally {
    if (reservedCommentId) ctx.commentClaims.delete(reservedCommentId);
    ctx.postClaims.delete(postId);
  }
  return cont();
}
export async function runFeedBumperFlow(
  ctx: BluestacksBumperContext,
  instanceId: string,
  groups: readonly BumperTarget[],
  pages: readonly BumperTarget[],
  settings: BumperSettings,
  signal: AbortSignal,
  callbacks: { status(text: string, today?: number): void; added(today: number): void },
  mode: BluestacksBumperMode = 'group',
  options?: { lockEnableSound?: boolean },
): Promise<void> {
  const isPageMode = mode === 'page' || (groups.length === 1 && groups[0]?.id === '-'),
    sourceMode: BumperScope = isPageMode ? 'page' : 'group',
    maxPostsPerTarget = isPageMode
      ? (settings.maxPostsPerPage ?? 3)
      : settings.maxPostsPerGroupPage;
  callbacks.status('正在校验模拟器连接与 FB Lite 账号登录状态…');
  const inst = await ctx.devices.ensureReadyAndLoggedIn(instanceId, signal),
    ops = createScreenOps(ctx.devices, ctx.ocr, inst, signal),
    { accountId } = inst;
  ops.guard();
  let lastAppliedStreamSound: boolean | null = null;
  const syncStreamSound = async (): Promise<boolean> => {
    const wantSound = await resolveLiveEnableSound(
      ctx.repo,
      settings,
      sourceMode,
      Boolean(options?.lockEnableSound),
    );
    if (
      wantSound !== lastAppliedStreamSound &&
      typeof ctx.devices.setMediaSoundEnabled === 'function'
    ) {
      await ctx.devices.setMediaSoundEnabled(ops.serial, wantSound, signal);
      lastAppliedStreamSound = wantSound;
    }
    return wantSound;
  };
  await syncStreamSound();
  ops.guard();
  const mutablePages = pages.map((p) => ({ ...p })),
    outerGroups: readonly BumperTarget[] = isPageMode
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
  const checkDailyQuota = async (): Promise<number | null> => {
    const q = await ctx.repo.eligibility(accountId, instanceId, '', Date.now(), sourceMode);
    if (q.today < settings.dailyMaxLikesPerAccount) return q.today;
    callbacks.status(`今日已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`, q.today);
    return null;
  };
  for (const rawGroup of outerGroups) {
    ops.guard();
    const initialToday = await checkDailyQuota();
    if (initialToday === null) return;
    let group: BumperTarget = rawGroup;
    if (!isPageMode) {
      try {
        group = await enterAndVerifyGroup(
          ctx,
          ops,
          inst,
          rawGroup,
          settings.searchMode,
          signal,
          (txt) => callbacks.status(txt, initialToday),
        );
        if (settings.searchMode === 'time_sort') {
          callbacks.status(`正在切换最新帖子排序 · ${group.name}`, initialToday);
          await switchGroupSortToNewest(ops);
        }
      } catch (err) {
        if (isFatalDeviceOrStopError(err, signal)) throw err;
        callbacks.status(`小组访问超时或不可用，跳过 · ${rawGroup.name}`, initialToday);
        continue;
      }
    }
    const feeds: Array<BumperTarget | null> =
      isPageMode || settings.searchMode === 'page_group_feed' ? mutablePages : [null];
    for (const feed of feeds) {
      ops.guard();
      if (isPageMode && (await checkDailyQuota()) === null) return;
      let activeFeed = feed;
      try {
        if (isPageMode && activeFeed)
          activeFeed = await enterAndVerifyPage(ctx, ops, inst, activeFeed, signal, (txt) =>
            callbacks.status(txt),
          );
        else if (activeFeed)
          activeFeed = await openPageGroupFeed(ctx, ops, inst, group, activeFeed, signal, (txt) =>
            callbacks.status(txt),
          );
        else if (extractPostCards(await ops.xml()).length === 0)
          await ops.swipe(115, 1180, 115, 580, 520, 1300);
      } catch (err) {
        if (isFatalDeviceOrStopError(err, signal)) throw err;
        if (isPageMode && feed) callbacks.status(`专页访问超时或不可用，跳过 · ${feed.name}`);
        continue;
      }
      const expectedFeedUrl =
        isPageMode && activeFeed
          ? `https://www.facebook.com/${encodeURIComponent(activeFeed.id)}`
          : activeFeed
            ? `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(activeFeed.id)}/`
            : buildGroupUrl(group.id, settings.searchMode);
      const seenFingerprints = new Set<string>(),
        seenCardSigs: Float32Array[] = [],
        scannedPerTarget = new Map<string, number>(),
        feedStats = {
          cardsSeen: 0,
          ageNullSkips: 0,
          ageExpiredSkips: 0,
          targetMismatchSkips: 0,
          alreadyLikedSkips: 0,
          quotaSkips: 0,
          missingActionBarSkips: 0,
          bumped: 0,
        };
      let emptyScrolls = 0,
        consecutiveExpired = 0,
        prevScrollDidAlign = false;
      const maxEmptyScrolls = isPageMode ? 4 : activeFeed ? 2 : 5,
        maxScrolls = isPageMode
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
        ops.guard();
        callbacks.status(
          isPageMode && activeFeed
            ? `正在扫描帖子 (${scrollIdx + 1}/${maxScrolls}) · ${activeFeed.name}`
            : `正在扫描帖子 (${scrollIdx + 1}/${maxScrolls}) · ${group.name}${activeFeed ? ' · ' + activeFeed.name : ''}`,
        );
        let xml: LiteXmlNode | null = null,
          png: Buffer;
        try {
          ({ xml, png } = await recoverToFeedIfNeeded(ops, expectedFeedUrl, (txt) =>
            callbacks.status(txt),
          ));
        } catch (err) {
          if (isFatalDeviceOrStopError(err, signal)) throw err;
          break;
        }
        const cards = extractPostCards(xml);
        let newCardsInScroll = 0,
          scrolledDuringCards = false;
        await syncStreamSound();
        const scanCtx: FeedScanCtx = {
          ctx,
          ops,
          inst,
          instanceId,
          isPageMode,
          sourceMode,
          group,
          activeFeed,
          mutablePages,
          settings,
          maxPostsPerTarget,
          expectedFeedUrl,
          seenFingerprints,
          seenCardSigs,
          scannedPerTarget,
          stats: feedStats,
          syncStreamSound,
          signal,
          callbacks,
        };
        for (let cardIdx = 0; cardIdx < cards.length && !scrolledDuringCards; cardIdx++) {
          ops.guard();
          const res = await processBumperCard(
            scanCtx,
            scrollIdx,
            cards,
            cardIdx,
            xml,
            png,
            consecutiveExpired,
          );
          png = res.png;
          consecutiveExpired = res.consecutiveExpired;
          if (res.newCard) newCardsInScroll++;
          if (res.scrolledDuringCards) scrolledDuringCards = true;
          if (res.action === 'return') return;
          if (res.action === 'break-cards') break;
        }
        if (
          !isPageMode &&
          (settings.searchMode === 'time_sort' || Boolean(activeFeed)) &&
          consecutiveExpired >= 2
        )
          break;
        if (
          (activeFeed ? [activeFeed] : mutablePages).every(
            (p) => (scannedPerTarget.get(p.id) ?? 0) >= maxPostsPerTarget,
          )
        )
          break;
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
          await ops.tap(450, seeMoreNode.bounds.cy, 1900);
          emptyScrolls = 0;
          prevScrollDidAlign = false;
        } else if (newCardsInScroll === 0) {
          if (!prevScrollDidAlign) {
            emptyScrolls++;
            if (!isPageMode && activeFeed && seenCardSigs.length > 0) break;
          }
          prevScrollDidAlign = false;
        } else {
          emptyScrolls = 0;
          prevScrollDidAlign = false;
        }
        if (emptyScrolls >= maxEmptyScrolls) break;
        await ops.swipe(
          115,
          1260 + Math.floor(Math.random() * 90),
          115,
          360 + Math.floor(Math.random() * 110),
          560,
          1100 + Math.floor(Math.random() * 700),
        );
      }
      if (feedStats.bumped === 0) {
        devDiag.record({
          level: 'WARN',
          category: 'TASK_RUNNER',
          event: 'BLUESTACKS_BUMPER_FEED_ZERO_BUMPS',
          data: {
            instanceId,
            mode,
            groupId: group.id,
            pageId: activeFeed?.id ?? null,
            searchMode: settings.searchMode,
            maxPostAgeHours: settings.maxPostAgeHours,
            ...feedStats,
          },
        });
      }
    }
  }
}
