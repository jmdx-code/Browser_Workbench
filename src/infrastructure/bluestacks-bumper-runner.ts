import { randomUUID } from 'node:crypto';
import type { CompatibleRepository } from '../domain/persistence.js';
import {
  extractOcrReadableText,
  hasUnsupportedOcrScript,
  nameSimilarity,
  type BluestacksAccountState,
  type BluestacksBumperMode,
  type BluestacksInstance,
} from '../shared/bluestacks.js';
import { inferBumperSourceMode, isDirectFacebookPostUrl } from '../shared/google-sheets.js';
import {
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperComment,
  type BumperLog,
  type BumperReactionType,
  type BumperScope,
  type BumperSettings,
  type BumperTarget,
} from '../shared/group-bumper.js';
import {
  createScreenOps,
  sha256NumericId,
  type BluestacksDeviceManager,
  type ScreenOps,
} from './bluestacks-device-manager.js';
import {
  compareAvatarToRegion,
  cropToDataUrl,
  detectHomeTabBar,
  detectVideoSpeakerState,
  extractActionBars,
  extractInlineVideoControls,
  extractPostCards,
  extractReactionPopupButtons,
  findGroupSortButtonNode,
  findJoinGroupButtonNode,
  findRelatedGroupsCloseButtonNode,
  findTextInputNode,
  flattenLiteNodes,
  hasPageHeroHeader,
  hasPageTopBar,
  isBottomSheetOpen,
  isDarkScreenOrReelMode,
  isLikeButtonBlue,
  isReactionButtonActive,
  makeCanonicalRect,
  type LiteInlineVideoControls,
  type LitePostActionBar,
  type LitePostCard,
  type LiteXmlNode,
  type OcrRecognizer,
  type RectBounds,
} from './bluestacks-vision.js';
import { runFeedBumperFlow } from './bluestacks-bumper-runner/feed-bumper-runner.js';
export async function executeBarActions(
  ops: ScreenOps,
  bar: Pick<LitePostActionBar, 'likeBounds' | 'commentBounds'>,
  settings: BumperSettings,
  wantLike: boolean,
  commentText: string | null | undefined,
  onStatus?: (mode: 'like' | 'comment') => void,
): Promise<{ didLike: boolean; didComment: string | null }> {
  let didLike = false,
    didComment: string | null = null;
  if (wantLike) {
    onStatus?.('like');
    didLike = await applyLikeOrReaction(ops, bar.likeBounds, settings);
  }
  if (commentText) {
    ops.guard();
    onStatus?.('comment');
    if (await submitCommentOnActionBar(ops, bar.commentBounds, commentText))
      didComment = commentText;
  }
  return { didLike, didComment };
}
export interface BluestacksBumperRunnerRepo {
  savedSettings?(): { bumperSettings: BumperSettings; pageBumperSettings?: BumperSettings };
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
    riskLimitReason?: string | null;
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
    accountState: BluestacksAccountState;
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
export interface BluestacksBumperContext {
  readonly repo: CompatibleRepository<BluestacksBumperRunnerRepo>;
  readonly targetAvatarUpdater: BluestacksTargetAvatarUpdater;
  readonly devices: BluestacksDeviceManager;
  readonly ocr: OcrRecognizer;
  readonly postClaims: Set<string>;
  readonly commentClaims: Set<string>;
}
export class AccountCircuitBreakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountCircuitBreakError';
  }
}
export function isFatalDeviceOrStopError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || err instanceof AccountCircuitBreakError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /TASK_STOPPED|device offline|device '.*' not found|closed|ECONNREFUSED/i.test(msg);
}
export function pickConfiguredReaction(settings: BumperSettings): BumperReactionType {
  const pool =
    settings.reactionTypes && settings.reactionTypes.length > 0
      ? settings.reactionTypes
      : (['like'] as const);
  return pool[Math.floor(Math.random() * pool.length)] ?? 'like';
}
export async function applyLikeOrReaction(
  ops: ScreenOps,
  likeBounds: RectBounds,
  settings: BumperSettings,
): Promise<boolean> {
  const chosenReaction = settings.useLongPressReaction ? pickConfiguredReaction(settings) : 'like';
  if (settings.useLongPressReaction && chosenReaction !== 'like') {
    await ops.swipe(likeBounds.cx, likeBounds.cy, likeBounds.cx, likeBounds.cy, 750, 650);
    const popupMap = extractReactionPopupButtons(await ops.xml(), likeBounds);
    const targetRect = popupMap[chosenReaction] ?? popupMap.love ?? popupMap.like;
    if (targetRect) {
      const { ok } = await ops.tapLike(targetRect, 1400);
      if (ok) return true;
    } else await ops.back(500);
  }
  return (await ops.tapLike(likeBounds, 1400)).ok;
}
export async function submitCommentOnActionBar(
  ops: ScreenOps,
  commentBounds: RectBounds,
  commentText: string,
): Promise<boolean> {
  await ops.tap(commentBounds.cx, commentBounds.cy, 1800);
  const inputNode = findTextInputNode(await ops.xml());
  await ops.paste(inputNode?.bounds.cx ?? 300, inputNode?.bounds.cy ?? 1480, commentText);
  await ops.wait(800);
  const sendRowY = inputNode ? inputNode.bounds.cy : 1484;
  const primarySendBounds = makeCanonicalRect(
    790,
    Math.max(0, sendRowY - 42),
    900,
    Math.min(1600, sendRowY + 42),
  );
  const fallbackSendBounds = makeCanonicalRect(790, 1440, 900, 1520);
  const typedPng = await ops.png();
  const activeSendBounds = (await isLikeButtonBlue(typedPng, primarySendBounds))
    ? primarySendBounds
    : (await isLikeButtonBlue(typedPng, fallbackSendBounds))
      ? fallbackSendBounds
      : null;
  let sent = false;
  if (activeSendBounds) {
    await ops.tap(854, activeSendBounds.cy, 2400);
    sent = !(await isLikeButtonBlue(await ops.png(), activeSendBounds));
  }
  await ops.back(950);
  if (findTextInputNode(await ops.xml())) await ops.back(1100);
  return sent;
}
export async function resolveLiveEnableSound(
  repo: CompatibleRepository<BluestacksBumperRunnerRepo>,
  fallback: BumperSettings,
  sourceMode: BumperScope,
  lockEnableSound = false,
): Promise<boolean> {
  if (lockEnableSound || typeof repo.savedSettings !== 'function')
    return Boolean(fallback.enableSound);
  try {
    const saved = await repo.savedSettings();
    return Boolean(
      sourceMode === 'page'
        ? (saved.pageBumperSettings?.enableSound ?? fallback.enableSound)
        : (saved.bumperSettings.enableSound ?? fallback.enableSound),
    );
  } catch {
    return Boolean(fallback.enableSound);
  }
}
export async function syncVideoSpeakerIfVisible(
  ops: ScreenOps,
  xml: LiteXmlNode | null,
  png: Buffer,
  minY: number,
  maxY: number,
  headerOnScreen: boolean,
  wantSound: boolean,
): Promise<{ png: Buffer; controls: LiteInlineVideoControls }> {
  const controls = extractInlineVideoControls(xml, minY, maxY, headerOnScreen);
  if (!controls.soundBounds) return { png, controls };
  let currentPng = png;
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await detectVideoSpeakerState(currentPng, controls.soundBounds);
    if (!((wantSound && state === 'muted') || (!wantSound && state === 'unmuted'))) break;
    await ops.tap(controls.soundBounds.cx, controls.soundBounds.cy, attempt === 0 ? 600 : 450);
    currentPng = await ops.png();
  }
  return { png: currentPng, controls };
}
export function buildGroupUrl(groupId: string, searchMode: BumperSettings['searchMode']): string {
  const base = `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/`;
  return searchMode === 'time_sort' ? `${base}?sorting_setting=CHRONOLOGICAL` : base;
}
async function assertBumperScreenHealthy(
  ctx: BluestacksBumperContext,
  ops: ScreenOps,
  inst: BluestacksInstance,
  xml: LiteXmlNode | null,
  png: Buffer,
): Promise<void> {
  const abnormal = await ops.abnormal(xml, png);
  if (abnormal) {
    await ctx.repo.saveInspectionResult({
      id: inst.id,
      fbLiteInstalled: true,
      accountState: abnormal,
      fbWidth: inst.fbWidth,
      fbHeight: inst.fbHeight,
    });
    throw new AccountCircuitBreakError('FB Lite 账号已退出、需验证或受限');
  }
}
async function openBumperFeedScreen(
  ctx: BluestacksBumperContext,
  ops: ScreenOps,
  inst: BluestacksInstance,
  url: string,
  waitMs: number,
  _signal: AbortSignal,
): Promise<{ xml: LiteXmlNode | null; png: Buffer }> {
  await ops.open(url, waitMs);
  const { xml, png } = await ops.capture();
  await assertBumperScreenHealthy(ctx, ops, inst, xml, png);
  return { xml, png };
}
export async function recoverToFeedIfNeeded(
  ops: ScreenOps,
  expectedFeedUrl: string,
  status: (text: string) => void,
): Promise<{ xml: LiteXmlNode | null; png: Buffer }> {
  let { xml, png } = await ops.capture();
  if (!xml) {
    await ops.swipe(115, 920, 115, 720, 300, 900);
    ({ xml, png } = await ops.capture());
  }
  const inReelOrDark = await isDarkScreenOrReelMode(png),
    sheetOpen = !inReelOrDark && (await isBottomSheetOpen(png)),
    unexpectedInput = flattenLiteNodes(xml).some(
      (n) => n.focused && n.clickable && n.longClickable && n.bounds.w >= 400 && n.bounds.y1 <= 200,
    );
  if (inReelOrDark || sheetOpen || unexpectedInput) {
    status(inReelOrDark ? '检测到视频/暗色视图，正在返回帖子流…' : '正在关闭弹窗层…');
    await ops.back(1300);
    ({ xml, png } = await ops.capture());
    if ((await isDarkScreenOrReelMode(png)) || !xml || xml.packageName !== 'com.facebook.lite') {
      status('正在重新回到目标小组帖子流…');
      await ops.tap(36, 70, 800).catch(() => null);
      await ops.open(expectedFeedUrl, 2200);
      ({ xml, png } = await ops.capture());
    }
  }
  return { xml, png };
}
export async function enterAndVerifyGroup(
  ctx: BluestacksBumperContext,
  ops: ScreenOps,
  inst: BluestacksInstance,
  group: BumperTarget,
  searchMode: BumperSettings['searchMode'],
  signal: AbortSignal,
  status: (text: string) => void,
): Promise<BumperTarget> {
  let currentGroup = group;
  const targetUrl = buildGroupUrl(currentGroup.id, searchMode);
  status(`正在进入目标小组 · ${currentGroup.name}`);
  let { xml: groupXml, png: groupPng } = await openBumperFeedScreen(
    ctx,
    ops,
    inst,
    targetUrl,
    2400,
    signal,
  );
  const joinBtn = searchMode !== 'random_browse' ? findJoinGroupButtonNode(groupXml) : null;
  if (joinBtn && (await isLikeButtonBlue(groupPng, joinBtn.bounds))) {
    status(`检测到尚未加入该小组，正在自动加入 · ${currentGroup.name}`);
    await ops.tap(joinBtn.bounds.cx, joinBtn.bounds.cy, 2400);
    groupXml = await ops.xml();
    const questionInput = findTextInputNode(groupXml);
    if (questionInput && questionInput.bounds.y2 <= 1350) {
      await ops.back(1200);
      await ops.open(targetUrl, 1800);
      groupXml = await ops.xml();
    } else if (extractPostCards(groupXml).length === 0 && !findGroupSortButtonNode(groupXml)) {
      await ops.back(1000);
      groupXml = await ops.xml();
    }
  }
  const closeCarouselBtn = findRelatedGroupsCloseButtonNode(groupXml);
  if (closeCarouselBtn) await ops.tap(closeCarouselBtn.bounds.cx, closeCarouselBtn.bounds.cy, 1000);
  if (!currentGroup.avatarUrl) {
    const captured = await cropToDataUrl(groupPng, makeCanonicalRect(225, 68, 675, 358), 96);
    if (captured) {
      await Promise.resolve(
        ctx.targetAvatarUpdater.applyResolvedTargetMetadata('groups', currentGroup.id, {
          avatarUrl: captured,
        }),
      ).catch(() => null);
      currentGroup = { ...currentGroup, avatarUrl: captured };
    }
  }
  return currentGroup;
}
export async function switchGroupSortToNewest(ops: ScreenOps): Promise<void> {
  let xml = await ops.xml();
  const closeCarouselBtn = findRelatedGroupsCloseButtonNode(xml);
  if (closeCarouselBtn) {
    await ops.tap(closeCarouselBtn.bounds.cx, closeCarouselBtn.bounds.cy, 1000);
    xml = await ops.xml();
  }
  let sortBtn = findGroupSortButtonNode(xml);
  if (!sortBtn && extractPostCards(xml).length === 0) {
    await ops.swipe(115, 1180, 115, 680, 420, 1100);
    sortBtn = findGroupSortButtonNode(await ops.xml());
  }
  if (!sortBtn) return;
  await ops.tap(sortBtn.bounds.cx, sortBtn.bounds.cy, 1400);
  const { xml: sheetXml, png } = await ops.capture();
  if (await isBottomSheetOpen(png)) {
    const rows = flattenLiteNodes(sheetXml).filter(
      (n) =>
        n.clickable &&
        n.bounds.x1 <= 60 &&
        n.bounds.x2 >= 800 &&
        n.bounds.y1 >= 900 &&
        n.bounds.h >= 50 &&
        n.bounds.h <= 140,
    );
    const match = await ops.findOcr(png, rows, /新帖子|最新帖子|新貼文|recentposts|newposts/i);
    await ops.tap(450, match?.node.bounds.cy ?? 1490, 2000);
  }
}
export async function openPageGroupFeed(
  ctx: BluestacksBumperContext,
  ops: ScreenOps,
  inst: BluestacksInstance,
  group: BumperTarget,
  page: BumperTarget,
  signal: AbortSignal,
  status: (text: string) => void,
): Promise<BumperTarget> {
  status(`正在打开专页小组贴 · ${group.name} · ${page.name}`);
  const { xml: feedXml } = await openBumperFeedScreen(
    ctx,
    ops,
    inst,
    `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/user/${encodeURIComponent(page.id)}/`,
    2200,
    signal,
  );
  if (extractPostCards(feedXml).length === 0) {
    if (extractActionBars(feedXml).length > 0) {
      await ops.swipe(450, 360, 450, 1260, 450, 1200);
      if (extractPostCards(await ops.xml()).length === 0)
        await ops.swipe(115, 1180, 115, 760, 450, 1100);
    } else await ops.swipe(115, 1180, 115, 760, 450, 1200);
  }
  return page;
}
export async function enterAndVerifyPage(
  ctx: BluestacksBumperContext,
  ops: ScreenOps,
  inst: BluestacksInstance,
  page: BumperTarget,
  signal: AbortSignal,
  status: (text: string) => void,
): Promise<BumperTarget> {
  status(`正在进入目标专页 · ${page.name}`);
  let { xml: pageXml } = await openBumperFeedScreen(
    ctx,
    ops,
    inst,
    `https://www.facebook.com/${encodeURIComponent(page.id)}`,
    2400,
    signal,
  );
  const closeCarouselBtn = findRelatedGroupsCloseButtonNode(pageXml);
  if (closeCarouselBtn) {
    await ops.tap(closeCarouselBtn.bounds.cx, closeCarouselBtn.bounds.cy, 900);
    pageXml = await ops.xml();
  }
  for (
    let pullStep = 0;
    pullStep < 3 && hasPageTopBar(pageXml) && !hasPageHeroHeader(pageXml);
    pullStep++
  ) {
    await ops.swipe(450, 300, 450, 1400, 320, 1050);
    pageXml = await ops.xml();
  }
  if (extractPostCards(pageXml).length === 0) await ops.swipe(115, 1280, 115, 360, 650, 1350);
  return page;
}
export async function matchPageTimelinePost(
  ctx: BluestacksBumperContext,
  png: Buffer,
  card: LitePostCard,
  page: BumperTarget,
  actingAccountName: string,
): Promise<{ target: BumperTarget; authorName: string } | null> {
  const cleanPageName = page.name.replace(/\s*\|.*$/, '').trim() || page.name.trim(),
    ocrName = await ctx.ocr.recognizeBounds(png, card.header.authorNameBounds),
    ocrAuthorOnly = ocrName.replace(/关注|關注|follow/gi, '').trim(),
    ocrReadable = extractOcrReadableText(ocrAuthorOnly),
    nameSim = Math.max(
      nameSimilarity(ocrAuthorOnly, cleanPageName),
      nameSimilarity(ocrAuthorOnly, page.name),
      nameSimilarity(ocrAuthorOnly, page.id),
    ),
    avatarSim = isLocalAvatar(page.avatarUrl)
      ? await compareAvatarToRegion(png, card.header.avatarBounds, page.avatarUrl)
      : 0,
    cleanActing = actingAccountName.trim();
  if (
    cleanActing.length >= 2 &&
    ocrReadable.length >= 3 &&
    nameSimilarity(ocrAuthorOnly, cleanActing) >= 0.78 &&
    nameSim < 0.45 &&
    avatarSim < 0.85
  )
    return null;
  const candReadable = extractOcrReadableText(cleanPageName),
    candPureOcrScript =
      !isPlaceholderTargetName(page.name, page.id) &&
      candReadable.length >= 3 &&
      !hasUnsupportedOcrScript(cleanPageName);
  if (candPureOcrScript && ocrReadable.length >= 5 && nameSim < 0.2 && avatarSim < 0.85)
    return null;
  if (
    !isPlaceholderTargetName(page.name, page.id) &&
    candReadable.length === 0 &&
    ocrReadable.length >= 5 &&
    avatarSim < 0.85
  )
    return null;
  if (avatarSim > 0 && avatarSim < 0.65 && nameSim < 0.45) return null;
  return { target: page, authorName: ocrAuthorOnly || cleanPageName || page.name };
}
export async function matchPostTarget(
  ctx: BluestacksBumperContext,
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
  const ocrName = await ctx.ocr.recognizeBounds(png, card.header.authorNameBounds),
    ocrAuthorOnly = ocrName.replace(/关注|關注|follow/gi, ''),
    ocrReadable = extractOcrReadableText(ocrAuthorOnly),
    ocrHasReadableText = ocrReadable.length >= 3;
  let best: { target: BumperTarget; score: number } | null = null;
  for (const candidate of candidates) {
    const candReadable = extractOcrReadableText(candidate.name),
      candPureOcrScript = candReadable.length >= 3 && !hasUnsupportedOcrScript(candidate.name),
      nameSim = Math.max(
        nameSimilarity(ocrAuthorOnly, candidate.name),
        nameSimilarity(ocrAuthorOnly, candidate.id),
      ),
      avatarSim = candidate.avatarUrl
        ? await compareAvatarToRegion(png, card.header.avatarBounds, candidate.avatarUrl)
        : 0;
    if (candPureOcrScript && ocrReadable.length >= 4 && nameSim < 0.25 && avatarSim < 0.92)
      continue;
    if (candReadable.length === 0 && ocrReadable.length >= 5 && avatarSim < 0.92) continue;
    const matchedByName = candPureOcrScript && ocrHasReadableText && nameSim >= 0.52,
      matchedByAvatar = Boolean(candidate.avatarUrl) && avatarSim >= 0.86,
      score = Math.max(matchedByName ? nameSim : 0, matchedByAvatar ? avatarSim : 0);
    if ((matchedByName || matchedByAvatar) && (!best || score > best.score))
      best = { target: candidate, score };
  }
  return best ? { target: best.target, authorName: ocrName || best.target.name } : null;
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
  private context(): BluestacksBumperContext {
    return {
      repo: this.repo,
      targetAvatarUpdater: this.targetAvatarUpdater,
      devices: this.devices,
      ocr: this.ocr,
      postClaims: this.postClaims,
      commentClaims: this.commentClaims,
    };
  }
  async runDirectPosts(
    instanceId: string,
    posts: ReadonlyArray<{
      postId: string;
      postUrl: string;
      groupId: string;
      groupName: string;
      pageId: string;
      pageName: string;
    }>,
    settings: BumperSettings,
    commentPool: readonly string[],
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      onPostDone?: (res: {
        postId: string;
        liked: boolean;
        commented: boolean;
        commentText: string | null;
      }) => void | Promise<void>;
    },
  ): Promise<{ bumped: number; attempted: number }> {
    const ctx = this.context();
    callbacks.status('正在校验蓝蝶账号与连接…');
    const inst = await ctx.devices.ensureReadyAndLoggedIn(instanceId, signal),
      ops = createScreenOps(ctx.devices, ctx.ocr, inst, signal),
      { accountId } = inst;
    ops.guard();
    let bumped = 0,
      attempted = 0;
    const localComments = [...commentPool];
    for (const post of posts) {
      ops.guard();
      if (!isDirectFacebookPostUrl(post.postUrl)) continue;
      const sourceMode = inferBumperSourceMode({ groupId: post.groupId, postUrl: post.postUrl }),
        rawPostKey = post.postId.trim(),
        normalizedPostId = /^\d+$/.test(rawPostKey)
          ? rawPostKey
          : sha256NumericId(rawPostKey || post.postUrl.trim()),
        q = await ctx.repo.eligibility(
          accountId,
          instanceId,
          normalizedPostId,
          Date.now(),
          sourceMode,
        );
      if (q.today >= settings.dailyMaxLikesPerAccount) {
        callbacks.status(`今日顶贴已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`);
        break;
      }
      if (!q.allowed) {
        if (q.riskLimitReason) {
          callbacks.status(q.riskLimitReason);
          break;
        }
        continue;
      }
      attempted++;
      callbacks.status(`云表直达顶贴 · ${post.pageName || post.groupName || post.postId}`);
      try {
        let { xml, png } = await openBumperFeedScreen(ctx, ops, inst, post.postUrl, 2600, signal);
        if (detectHomeTabBar(xml)) continue;
        const screenText = await ops
          .ocr(png, makeCanonicalRect(40, 180, 860, 1180))
          .catch(() => '');
        if (
          /此内容目前无法查看|无法查看此内容|contentisn'?tavailable|内容不可用|贴文已删除|linkmaybebroken/i.test(
            screenText,
          )
        )
          continue;
        let bar = extractActionBars(xml)[0] ?? null;
        if (!bar) {
          await ops.swipe(115, 1180, 115, 520, 520, 1400);
          ({ xml, png } = await ops.capture());
          if (detectHomeTabBar(xml)) continue;
          bar = extractActionBars(xml)[0] ?? null;
        }
        if (!bar) continue;
        const wantLike =
          !(await isReactionButtonActive(png, bar.likeBounds)) &&
          Math.random() * 100 < settings.likeProbability;
        let chosenCommentIdx = -1,
          chosenText: string | null = null;
        if (localComments.length > 0 && Math.random() * 100 < settings.commentProbability) {
          chosenCommentIdx = Math.floor(Math.random() * localComments.length);
          chosenText = localComments[chosenCommentIdx] ?? null;
        }
        if (!wantLike && !chosenText) continue;
        const { didLike, didComment } = await executeBarActions(
          ops,
          bar,
          settings,
          wantLike,
          chosenText,
        );
        if (didLike || didComment) {
          await ctx.repo.recordBump({
            id: randomUUID(),
            profileId: instanceId,
            accountId,
            groupId: post.groupId || '-',
            groupName: post.groupName || '云表直达',
            pageId: post.pageId || '-',
            pageName: post.pageName || '云表帖子',
            postId: normalizedPostId,
            postUrl: post.postUrl,
            liked: didLike,
            commentText: didComment,
            bumpedAt: Date.now(),
            sourceMode,
          });
          if (didComment && settings.consumeCommentOnUse && chosenCommentIdx >= 0)
            localComments.splice(chosenCommentIdx, 1);
          bumped++;
          await callbacks.onPostDone?.({
            postId: post.postId,
            liked: didLike,
            commented: Boolean(didComment),
            commentText: didComment,
          });
        }
        await ops.wait(1500 + Math.floor(Math.random() * 1500));
      } catch (err) {
        if (isFatalDeviceOrStopError(err, signal)) throw err;
      }
    }
    return { bumped, attempted };
  }
  async run(
    instanceId: string,
    groups: readonly BumperTarget[],
    pages: readonly BumperTarget[],
    settings: BumperSettings,
    signal: AbortSignal,
    callbacks: { status(text: string, today?: number): void; added(today: number): void },
    mode: BluestacksBumperMode = 'group',
    options?: { lockEnableSound?: boolean },
  ): Promise<void> {
    await runFeedBumperFlow(
      this.context(),
      instanceId,
      groups,
      pages,
      settings,
      signal,
      callbacks,
      mode,
      options,
    );
  }
}
