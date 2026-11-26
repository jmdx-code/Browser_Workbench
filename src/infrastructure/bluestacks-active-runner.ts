import { existsSync } from 'node:fs';
import type { BluestacksInstance, BluestacksQuickActiveStepType } from '../shared/bluestacks.js';
import {
  createScreenOps,
  filterClickableNodes,
  type BluestacksDeviceManager,
  type ScreenOps,
} from './bluestacks-device-manager.js';
import {
  detectHomeTabBar,
  extractActionBars,
  findTextInputNode,
  getRegionSignature,
  isReactionButtonActive,
  isSolidBlueButton,
  makeCanonicalRect,
  signatureSimilarity,
  type OcrRecognizer,
} from './bluestacks-vision.js';
export interface BluestacksActiveStepSpec {
  type: BluestacksQuickActiveStepType;
  friendAction?: 'accept' | 'add_suggested';
  feedMode?: 'home' | 'random_profile' | 'random_page' | 'search_pages';
  durationMinutes?: number;
  maxLikes?: number;
  maxAccepts?: number;
  caption?: string;
  mediaPath?: string;
  background?: string;
}
export interface BluestacksActiveRunOutcome {
  completedSteps: number;
  skippedSteps: number;
  likes: number;
  acceptedFriends: number;
  published: number;
  notes: string[];
}
const stepDeadline = (mins: number, minMs = 10_000) =>
    Date.now() + Math.max(minMs, Math.round(mins * 60_000)),
  leftSec = (deadline: number) => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
  skipStep = (onStatus: (text: string) => void, note: string) => {
    onStatus(note);
    return { skipped: true, note };
  };
export class BluestacksActiveRunner {
  constructor(
    public readonly devices: BluestacksDeviceManager,
    private readonly ocr: OcrRecognizer,
  ) {}
  private async tryLikeBounds(
    ops: ScreenOps,
    png: Buffer,
    bounds: Parameters<typeof isReactionButtonActive>[1],
    waitMs: number,
    onAction: () => void,
  ): Promise<boolean> {
    if ((await isReactionButtonActive(png, bounds)) || !(await ops.tapLike(bounds, waitMs)).ok)
      return false;
    onAction();
    return true;
  }
  private async runFeedStep(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ likes: number }> {
    const deadline = stepDeadline(spec.durationMinutes ?? 1),
      maxLikes = Math.max(0, spec.maxLikes ?? 2);
    let likes = 0;
    onStatus('正在打开首页信息流…');
    await ops.open('https://www.facebook.com/', 2200);
    for (let scrollCount = 1; Date.now() < deadline; scrollCount++) {
      ops.guard();
      onStatus(`正在浏览首页 (${leftSec(deadline)}s · 已赞 ${likes}/${maxLikes})`);
      const { xml, png } = await ops.capture();
      if (scrollCount === 1 || scrollCount % 4 === 0) await ops.healthy(xml, png);
      if (likes < maxLikes && Math.random() < 0.45) {
        const targetBar = extractActionBars(xml).find(
          (b) => b.likeBounds.y1 >= 220 && b.likeBounds.y2 <= 1440,
        );
        if (targetBar && (await this.tryLikeBounds(ops, png, targetBar.likeBounds, 1200, onAction)))
          likes++;
      }
      await ops.wait(
        Math.min(Math.max(1500, deadline - Date.now()), 2800 + Math.floor(Math.random() * 2600)),
      );
      if (Date.now() >= deadline) break;
      await ops.swipe(
        450,
        1220 + Math.floor(Math.random() * 110),
        450,
        340 + Math.floor(Math.random() * 140),
        520,
        900 + Math.floor(Math.random() * 700),
      );
    }
    return { likes };
  }
  private async runReelsStep(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ likes: number }> {
    const deadline = stepDeadline(spec.durationMinutes ?? 1, 12_000),
      maxLikes = Math.max(0, spec.maxLikes ?? 2),
      centerFrameBounds = makeCanonicalRect(120, 260, 780, 1180);
    let likes = 0;
    onStatus('正在打开 Reels 短视频…');
    await ops.open('https://www.facebook.com/reel/', 3000);
    for (let reelIdx = 1; Date.now() < deadline; reelIdx++) {
      ops.guard();
      onStatus(`正在观看 Reels #${reelIdx} (${leftSec(deadline)}s · 已赞 ${likes}/${maxLikes})`);
      const firstPng = await ops.png();
      if (reelIdx === 1) await ops.healthy(await ops.xml(), firstPng);
      const sig1 = await getRegionSignature(firstPng, centerFrameBounds);
      await ops.wait(
        Math.min(Math.max(2000, deadline - Date.now()), 5000 + Math.floor(Math.random() * 4500)),
      );
      const secondPng = await ops.png(),
        sig2 = await getRegionSignature(secondPng, centerFrameBounds),
        videoMoved = !sig1 || !sig2 || signatureSimilarity(sig1, sig2) < 0.996;
      if (videoMoved && likes < maxLikes && Math.random() < 0.45) {
        const likeBtn = filterClickableNodes(
          await ops.xml(),
          (n) =>
            n.bounds.x1 >= 750 &&
            n.bounds.x2 <= 900 &&
            n.bounds.y1 >= 760 &&
            n.bounds.y2 <= 1280 &&
            n.bounds.w >= 48 &&
            n.bounds.w <= 145 &&
            n.bounds.h >= 48 &&
            n.bounds.h <= 145,
        )[0];
        if (likeBtn && (await this.tryLikeBounds(ops, secondPng, likeBtn.bounds, 1000, onAction)))
          likes++;
      }
      if (Date.now() >= deadline) break;
      await ops.swipe(450, 1300, 450, 320, 360, 1500);
    }
    await ops.back(700);
    return { likes };
  }
  private async runMarketplaceStep(
    inst: BluestacksInstance,
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
  ): Promise<{ skipped: boolean; note?: string }> {
    if (inst.identityType === 'page')
      return skipStep(onStatus, '跳过商城浏览：当前为专页身份，Facebook 专页不支持 Marketplace');
    const deadline = stepDeadline(spec.durationMinutes ?? 1);
    onStatus('正在打开 Marketplace 商城…');
    const { png: initPng } = await ops.openInspect('https://www.facebook.com/marketplace/', 2600),
      initText = await ops.ocr(initPng, makeCanonicalRect(0, 120, 900, 1100));
    if (/内容暂时无法显示|目前无法使用|isn'tavailable|marketplaceisn'tavailable/i.test(initText))
      return skipStep(onStatus, '跳过商城浏览：当前账号/专页无权访问 Marketplace');
    for (let openedDetails = 0; Date.now() < deadline;) {
      ops.guard();
      onStatus(`正在浏览 Marketplace 商城 (${leftSec(deadline)}s)`);
      await ops.swipe(450, 1250, 450, 460, 520, 2200);
      if (Date.now() >= deadline) break;
      if (openedDetails < 2 && Math.random() < 0.45) {
        await ops.tap(
          Math.random() < 0.5 ? 230 : 670,
          580 + Math.floor(Math.random() * 260),
          Math.min(Math.max(1500, deadline - Date.now()), 3200),
        );
        openedDetails++;
        await ops.back(1200);
      }
    }
    return { skipped: false };
  }
  private async runFriendsStep(
    inst: BluestacksInstance,
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ accepted: number; skipped: boolean; note?: string }> {
    if (inst.identityType === 'page')
      return {
        accepted: 0,
        ...skipStep(onStatus, '跳过接受好友请求：当前为专页身份，仅个人账号支持好友请求'),
      };
    const maxAccepts = Math.max(1, spec.maxAccepts ?? 5),
      deadline = stepDeadline(spec.durationMinutes ?? 15, 30_000);
    let accepted = 0;
    onStatus('正在打开好友请求列表…');
    let { xml, png } = await ops.openInspect('https://www.facebook.com/friends/requests/', 2600);
    const tabBar = detectHomeTabBar(xml);
    if (tabBar && tabBar.identityHint === 'personal' && tabBar.tabs[1]) {
      await ops.tap(tabBar.tabs[1].cx, tabBar.tabs[1].cy, 2200);
      ({ xml, png } = await ops.capture());
    }
    let emptyScrolls = 0;
    for (
      let iter = 0;
      iter < Math.max(18, maxAccepts * 3) &&
      accepted < maxAccepts &&
      emptyScrolls < 3 &&
      Date.now() < deadline;
      iter++
    ) {
      ops.guard();
      const blueBtns = filterClickableNodes(
        xml,
        (n) =>
          n.bounds.w >= 140 &&
          n.bounds.w <= 420 &&
          n.bounds.h >= 38 &&
          n.bounds.h <= 95 &&
          n.bounds.y1 >= 210 &&
          n.bounds.y2 <= 1480,
      );
      let acceptedThisScreen = 0;
      for (const btn of blueBtns) {
        if (accepted >= maxAccepts || Date.now() >= deadline) break;
        if (!(await isSolidBlueButton(png, btn.bounds))) continue;
        if (!/^确认$|^確認$|^confirm$/i.test(await ops.ocr(png, btn.bounds))) continue;
        onStatus(`正在接受好友请求 (${accepted + 1}/${maxAccepts})…`);
        await ops.tap(btn.bounds.cx, btn.bounds.cy, 1500);
        const afterPng = await ops.png();
        if (!(await isSolidBlueButton(afterPng, btn.bounds))) {
          accepted++;
          acceptedThisScreen++;
          onAction();
          png = afterPng;
          xml = await ops.xml();
          break;
        }
      }
      if (acceptedThisScreen === 0) {
        emptyScrolls++;
        if (emptyScrolls >= 3 || Date.now() >= deadline) break;
        await ops.swipe(450, 1240, 450, 520, 480, 1500);
        ({ xml, png } = await ops.capture());
      } else emptyScrolls = 0;
    }
    return { accepted, skipped: false };
  }
  private async runPostOrStoryStep(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ published: number; skipped: boolean; note?: string }> {
    const caption = spec.caption?.trim() ?? '',
      mediaPath = spec.mediaPath?.trim() ?? '';
    if (!caption && (!mediaPath || !existsSync(mediaPath)))
      return { published: 0, ...skipStep(onStatus, '跳过发布步骤：未提供有效文案或本地媒体文件') };
    const pushedRemote: string[] = [];
    let published = false;
    try {
      if (mediaPath && existsSync(mediaPath)) {
        onStatus('正在推送媒体文件到模拟器相册…');
        pushedRemote.push(await this.devices.pushMediaToGallery(ops.serial, mediaPath, signal));
      }
      onStatus(spec.type === 'story' ? '正在打开发布快拍入口…' : '正在打开时间线发帖编辑页…');
      await ops.open('https://www.facebook.com/', 2200);
      await ops.tapHomeTab0(1600);
      if (spec.type === 'story') {
        await ops.tap(150, 420, 2500);
        if (pushedRemote.length > 0) await ops.tap(150, 460, 2200);
        const { xml: storyXml, png: storyPng } = await ops.capture(),
          shareCands = filterClickableNodes(
            storyXml,
            (n) => n.bounds.y1 >= 1320 && n.bounds.w >= 140 && n.bounds.h >= 40,
          ),
          shareBtn = await ops.findOcr(storyPng, shareCands, /分享|发布|發佈|立即分享|share/i);
        if (shareBtn) {
          onStatus('正在发布快拍…');
          await ops.tap(shareBtn.node.bounds.cx, shareBtn.node.bounds.cy);
          let verified = false;
          for (const deadline = Date.now() + 12_000; Date.now() < deadline;) {
            await ops.wait(2000);
            const { xml: afterXml, png: afterPng } = await ops.capture();
            if (detectHomeTabBar(afterXml)) {
              verified = true;
              break;
            }
            const stillShare =
              filterClickableNodes(
                afterXml,
                (n) =>
                  Math.abs(n.bounds.cx - shareBtn.node.bounds.cx) <= 80 &&
                  Math.abs(n.bounds.cy - shareBtn.node.bounds.cy) <= 60,
              ).length > 0;
            if (
              !stillShare &&
              !/分享|发布|發佈|立即分享|share/i.test(await ops.ocr(afterPng, shareBtn.node.bounds))
            ) {
              verified = true;
              break;
            }
          }
          if (verified) return ((published = true), onAction(), { published: 1, skipped: false });
          return (
            await ops.back(0),
            { published: 0, skipped: true, note: '未能确认快拍发布完成，已安全退出' }
          );
        }
        return (
          await ops.back(0),
          { published: 0, skipped: true, note: '未找到快拍分享按钮，已安全退出' }
        );
      }
      await ops.tap(420, 240, 2200);
      let { xml: compXml, png: compPng } = await ops.capture();
      const inputNode = findTextInputNode(compXml);
      if (caption) {
        onStatus('正在输入帖子文案…');
        await ops.paste(inputNode?.bounds.cx ?? 420, inputNode?.bounds.cy ?? 420, caption);
        await ops.wait(900);
      }
      if (pushedRemote.length > 0) {
        onStatus('正在选择相册媒体…');
        const rows = filterClickableNodes(
            compXml,
            (n) => n.bounds.w >= 650 && n.bounds.y1 >= 800 && n.bounds.h >= 46 && n.bounds.h <= 115,
          ),
          mediaRow = await ops.findOcr(compPng, rows, /照片|视频|photo|video/i);
        if (mediaRow) {
          await ops.tap(mediaRow.node.bounds.cx, mediaRow.node.bounds.cy, 2400);
          await ops.attachMedia(false);
        }
      }
      ({ xml: compXml, png: compPng } = await ops.capture());
      const postBtnCands = filterClickableNodes(
        compXml,
        (n) =>
          (n.bounds.x1 >= 680 && n.bounds.y1 <= 140 && n.bounds.h >= 36) ||
          (n.bounds.w >= 450 && n.bounds.y1 >= 1360 && n.bounds.h >= 42),
      );
      for (const pb of postBtnCands) {
        const pt = await ops.ocr(compPng, pb.bounds);
        if (/发布|發佈|post/i.test(pt) || (await isSolidBlueButton(compPng, pb.bounds))) {
          onStatus('正在提交发布…');
          await ops.tap(pb.bounds.cx, pb.bounds.cy, 4500);
          const afterXml = await ops.xml();
          if (detectHomeTabBar(afterXml) || !findTextInputNode(afterXml))
            return ((published = true), onAction(), { published: 1, skipped: false });
        }
      }
      return (
        await ops.back(0),
        { published: 0, skipped: true, note: '未能确认发布按钮或发布结果' }
      );
    } finally {
      if (pushedRemote.length > 0 && !published)
        await this.devices.cleanupPushedMedia(ops.serial, pushedRemote).catch(() => {});
    }
  }
  async run(
    instanceId: string,
    steps: readonly BluestacksActiveStepSpec[],
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      action(kind?: 'like' | 'post' | 'action'): void;
      onStepChange?: (stepIndex: number) => void;
    },
  ): Promise<BluestacksActiveRunOutcome> {
    const outcome: BluestacksActiveRunOutcome = {
      completedSteps: 0,
      skippedSteps: 0,
      likes: 0,
      acceptedFriends: 0,
      published: 0,
      notes: [],
    };
    if (steps.length === 0) return outcome;
    callbacks.status('正在校验蓝蝶连接与 FB Lite 账号身份…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal),
      ops = createScreenOps(this.devices, this.ocr, inst, signal),
      recordSkipped = (r: { skipped: boolean; note?: string }) => {
        if (r.skipped) {
          outcome.skippedSteps++;
          if (r.note) outcome.notes.push(r.note);
        } else outcome.completedSteps++;
      };
    for (let i = 0; i < steps.length; i++) {
      ops.guard();
      const step = steps[i];
      if (!step) continue;
      callbacks.onStepChange?.(i);
      const prefix = steps.length > 1 ? `[${i + 1}/${steps.length}] ` : '',
        status = (t: string) => callbacks.status(prefix + t);
      if (step.type === 'feed') {
        if (step.feedMode && step.feedMode !== 'home')
          outcome.notes.push('蓝蝶暂不支持串门/搜专页浏览，已按首页 Feed 模式执行');
        outcome.likes += (
          await this.runFeedStep(ops, step, status, () => callbacks.action('like'))
        ).likes;
        outcome.completedSteps++;
      } else if (step.type === 'video') {
        outcome.likes += (
          await this.runReelsStep(ops, step, status, () => callbacks.action('like'))
        ).likes;
        outcome.completedSteps++;
      } else if (step.type === 'marketplace') {
        recordSkipped(await this.runMarketplaceStep(inst, ops, step, status));
      } else if (step.type === 'friends') {
        if (step.friendAction === 'add_suggested') {
          outcome.skippedSteps++;
          outcome.notes.push('蓝蝶暂不支持「加推荐好友」，已自动跳过');
          status('跳过「加推荐好友」（当前仅浏览器端支持）');
          continue;
        }
        const r = await this.runFriendsStep(inst, ops, step, status, () =>
          callbacks.action('action'),
        );
        outcome.acceptedFriends += r.accepted;
        recordSkipped(r);
      } else if (step.type === 'post' || step.type === 'story') {
        const r = await this.runPostOrStoryStep(ops, step, signal, status, () =>
          callbacks.action('post'),
        );
        outcome.published += r.published;
        recordSkipped(r);
      }
    }
    callbacks.onStepChange?.(steps.length);
    return outcome;
  }
}
