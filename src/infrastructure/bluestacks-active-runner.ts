import { existsSync } from 'node:fs';
import type { BluestacksInstance, BluestacksQuickActiveStepType } from '../shared/bluestacks.js';
import type { Step } from '../shared/contracts.js';
import { abortableWait, type BluestacksDeviceManager } from './bluestacks-device-manager.js';
import {
  detectHomeTabBar,
  extractActionBars,
  findTextInputNode,
  flattenLiteNodes,
  getRegionSignature,
  isReactionButtonActive,
  isSolidBlueButton,
  makeCanonicalRect,
  signatureSimilarity,
  type LiteXmlNode,
  type OcrRecognizer,
} from './bluestacks-vision.js';

export interface BluestacksActiveStepSpec {
  type: BluestacksQuickActiveStepType;
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

export function mapCombinationStepsToBluestacks(
  steps: readonly Step[],
): BluestacksActiveStepSpec[] {
  const out: BluestacksActiveStepSpec[] = [];
  for (const step of steps) {
    switch (step.type) {
      case 'feed':
      case 'video':
        out.push({
          type: step.type,
          durationMinutes: step.durationMinutes,
          maxLikes: step.maxLikes,
        });
        break;
      case 'marketplace':
        out.push({
          type: 'marketplace',
          durationMinutes: step.durationMinutes,
        });
        break;
      case 'friends':
        out.push({
          type: 'friends',
          durationMinutes: step.durationMinutes,
          maxAccepts: step.maxAccepts,
        });
        break;
      case 'post':
        out.push({
          type: step.destination === 'story' ? 'story' : 'post',
          caption: '',
        });
        break;
    }
  }
  return out;
}

export class BluestacksActiveRunner {
  constructor(
    public readonly devices: BluestacksDeviceManager,
    private readonly ocr: OcrRecognizer,
  ) {}

  private async checkAccountHealth(
    inst: BluestacksInstance,
    xml: LiteXmlNode | null,
    png: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    const abnormal = await this.devices.detectAbnormalScreen(inst.serial, xml, png, signal);
    if (abnormal === 'logged-out') {
      throw new Error('FB Lite 账号已退出登录');
    }
    if (abnormal === 'verification') {
      throw new Error('FB Lite 账号触发安全验证 (Checkpoint)');
    }
    if (abnormal === 'restricted') {
      throw new Error('FB Lite 账号已被封禁或停用');
    }
  }

  private async runFeedStep(
    inst: BluestacksInstance,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ likes: number }> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const durationMs = Math.max(10_000, Math.round((spec.durationMinutes ?? 1) * 60_000));
    const maxLikes = Math.max(0, spec.maxLikes ?? 2);
    const deadline = Date.now() + durationMs;
    let likes = 0;

    onStatus('正在打开首页信息流…');
    await this.devices.openDeepLink(serial, 'https://www.facebook.com/', sw, sh, signal);
    await abortableWait(2200, signal);

    let scrollCount = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      scrollCount++;
      const remainSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      onStatus(`正在浏览首页 (${remainSec}s · 已赞 ${likes}/${maxLikes})`);

      const [xml, png] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);
      if (scrollCount === 1 || scrollCount % 4 === 0) {
        await this.checkAccountHealth(inst, xml, png, signal);
      }

      if (likes < maxLikes && Math.random() < 0.45) {
        const bars = extractActionBars(xml).filter(
          (b) => b.likeBounds.y1 >= 220 && b.likeBounds.y2 <= 1440,
        );
        const targetBar = bars[0];
        if (targetBar && !(await isReactionButtonActive(png, targetBar.likeBounds))) {
          await this.devices.tap900(
            serial,
            targetBar.likeBounds.cx,
            targetBar.likeBounds.cy,
            sw,
            sh,
            signal,
          );
          await abortableWait(1200, signal);
          const verifyPng = await this.devices.screencap(serial, signal);
          if (await isReactionButtonActive(verifyPng, targetBar.likeBounds)) {
            likes++;
            onAction();
          }
        }
      }

      const dwellMs = Math.min(
        Math.max(1500, deadline - Date.now()),
        2800 + Math.floor(Math.random() * 2600),
      );
      await abortableWait(dwellMs, signal);
      if (Date.now() >= deadline) break;

      const startY = 1220 + Math.floor(Math.random() * 110);
      const endY = 340 + Math.floor(Math.random() * 140);
      await this.devices.swipe900(serial, 450, startY, 450, endY, 520, sw, sh, signal);
      await abortableWait(900 + Math.floor(Math.random() * 700), signal);
    }

    return { likes };
  }

  private async runReelsStep(
    inst: BluestacksInstance,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ likes: number }> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const durationMs = Math.max(12_000, Math.round((spec.durationMinutes ?? 1) * 60_000));
    const maxLikes = Math.max(0, spec.maxLikes ?? 2);
    const deadline = Date.now() + durationMs;
    let likes = 0;

    // Works cleanly on BOTH Personal and Page identities!
    onStatus('正在打开 Reels 短视频…');
    await this.devices.openDeepLink(serial, 'https://www.facebook.com/reel/', sw, sh, signal);
    await abortableWait(3000, signal);

    let reelIdx = 0;
    const centerFrameBounds = makeCanonicalRect(120, 260, 780, 1180);

    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      reelIdx++;
      const remainSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      onStatus(`正在观看 Reels #${reelIdx} (${remainSec}s · 已赞 ${likes}/${maxLikes})`);

      const firstPng = await this.devices.screencap(serial, signal);
      if (reelIdx === 1) {
        const xml = await this.devices.dumpXml(serial, sw, sh, signal);
        await this.checkAccountHealth(inst, xml, firstPng, signal);
      }
      const sig1 = await getRegionSignature(firstPng, centerFrameBounds);

      const watchMs = Math.min(
        Math.max(2000, deadline - Date.now()),
        5000 + Math.floor(Math.random() * 4500),
      );
      await abortableWait(watchMs, signal);

      // Verify frame actually progressed (not frozen black screen) before liking
      const secondPng = await this.devices.screencap(serial, signal);
      const sig2 = await getRegionSignature(secondPng, centerFrameBounds);
      const videoMoved = !sig1 || !sig2 || signatureSimilarity(sig1, sig2) < 0.996;

      if (videoMoved && likes < maxLikes && Math.random() < 0.45) {
        const reelXml = await this.devices.dumpXml(serial, sw, sh, signal);
        // Reels right-column Like button sits around x=775..895, y=820..1240
        const rightButtons = flattenLiteNodes(reelXml)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.x1 >= 750 &&
              n.bounds.x2 <= 900 &&
              n.bounds.y1 >= 760 &&
              n.bounds.y2 <= 1280 &&
              n.bounds.w >= 48 &&
              n.bounds.w <= 145 &&
              n.bounds.h >= 48 &&
              n.bounds.h <= 145,
          )
          .sort((a, b) => a.bounds.y1 - b.bounds.y1);
        const likeBtn = rightButtons[0];
        if (likeBtn && !(await isReactionButtonActive(secondPng, likeBtn.bounds))) {
          await this.devices.tap900(serial, likeBtn.bounds.cx, likeBtn.bounds.cy, sw, sh, signal);
          await abortableWait(1000, signal);
          const afterLikePng = await this.devices.screencap(serial, signal);
          if (await isReactionButtonActive(afterLikePng, likeBtn.bounds)) {
            likes++;
            onAction();
          }
        }
      }

      if (Date.now() >= deadline) break;
      // Swipe up to next Reel
      await this.devices.swipe900(serial, 450, 1300, 450, 320, 360, sw, sh, signal);
      await abortableWait(1500, signal);
    }

    await this.devices.keyevent(serial, 4, signal).catch(() => null);
    await abortableWait(700, signal);
    return { likes };
  }

  private async runMarketplaceStep(
    inst: BluestacksInstance,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
  ): Promise<{ skipped: boolean; note?: string }> {
    if (inst.identityType === 'page') {
      const note = '跳过商城浏览：当前为专页身份，Facebook 专页不支持 Marketplace';
      onStatus(note);
      return { skipped: true, note };
    }

    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const durationMs = Math.max(10_000, Math.round((spec.durationMinutes ?? 1) * 60_000));
    const deadline = Date.now() + durationMs;

    onStatus('正在打开 Marketplace 商城…');
    await this.devices.openDeepLink(
      serial,
      'https://www.facebook.com/marketplace/',
      sw,
      sh,
      signal,
    );
    await abortableWait(2600, signal);

    const [initXml, initPng] = await Promise.all([
      this.devices.dumpXml(serial, sw, sh, signal),
      this.devices.screencap(serial, signal),
    ]);
    await this.checkAccountHealth(inst, initXml, initPng, signal);
    const initText = (
      await this.ocr.recognizeBounds(initPng, makeCanonicalRect(0, 120, 900, 1100))
    ).replace(/\s+/g, '');
    if (/内容暂时无法显示|目前无法使用|isn'tavailable|marketplaceisn'tavailable/i.test(initText)) {
      const note = '跳过商城浏览：当前账号/专页无权访问 Marketplace';
      onStatus(note);
      return { skipped: true, note };
    }

    let openedDetails = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      const remainSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      onStatus(`正在浏览 Marketplace 商城 (${remainSec}s)`);

      await this.devices.swipe900(serial, 450, 1250, 450, 460, 520, sw, sh, signal);
      await abortableWait(2200, signal);
      if (Date.now() >= deadline) break;

      if (openedDetails < 2 && Math.random() < 0.45) {
        // Tap a product tile in the 2-column Marketplace grid
        const tapX = Math.random() < 0.5 ? 230 : 670;
        const tapY = 580 + Math.floor(Math.random() * 260);
        await this.devices.tap900(serial, tapX, tapY, sw, sh, signal);
        openedDetails++;
        const viewMs = Math.min(Math.max(1500, deadline - Date.now()), 3200);
        await abortableWait(viewMs, signal);
        await this.devices.keyevent(serial, 4, signal).catch(() => null);
        await abortableWait(1200, signal);
      }
    }

    return { skipped: false };
  }

  private async runFriendsStep(
    inst: BluestacksInstance,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ accepted: number; skipped: boolean; note?: string }> {
    if (inst.identityType === 'page') {
      const note = '跳过接受好友请求：当前为专页身份，仅个人账号支持好友请求';
      onStatus(note);
      return { accepted: 0, skipped: true, note };
    }

    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const maxAccepts = Math.max(1, spec.maxAccepts ?? 5);
    let accepted = 0;

    onStatus('正在打开好友请求列表…');
    await this.devices.openDeepLink(
      serial,
      'https://www.facebook.com/friends/requests/',
      sw,
      sh,
      signal,
    );
    await abortableWait(2600, signal);

    let [xml, png] = await Promise.all([
      this.devices.dumpXml(serial, sw, sh, signal),
      this.devices.screencap(serial, signal),
    ]);
    await this.checkAccountHealth(inst, xml, png, signal);

    // If deep link landed on Home, tap the Friends tab (index 1 of 6-tab Personal bar)
    const tabBar = detectHomeTabBar(xml);
    if (tabBar && tabBar.identityHint === 'personal' && tabBar.tabs[1]) {
      await this.devices.tap900(serial, tabBar.tabs[1].cx, tabBar.tabs[1].cy, sw, sh, signal);
      await abortableWait(2200, signal);
      [xml, png] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);
    }

    let emptyScrolls = 0;
    for (let scroll = 0; scroll < 6 && accepted < maxAccepts && emptyScrolls < 2; scroll++) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      const blueBtns = flattenLiteNodes(xml)
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.w >= 140 &&
            n.bounds.w <= 420 &&
            n.bounds.h >= 38 &&
            n.bounds.h <= 95 &&
            n.bounds.y1 >= 210 &&
            n.bounds.y2 <= 1480,
        )
        .sort((a, b) => a.bounds.y1 - b.bounds.y1);

      let acceptedThisScreen = 0;
      for (const btn of blueBtns) {
        if (accepted >= maxAccepts) break;
        if (!(await isSolidBlueButton(png, btn.bounds))) continue;
        const label = (await this.ocr.recognizeBounds(png, btn.bounds)).replace(/\s+/g, '');
        // Strictly match Confirm / 确认 — NEVER tap "添加好友" / "Add friend"!
        if (!/^确认$|^確認$|^confirm$/i.test(label)) continue;

        onStatus(`正在接受好友请求 (${accepted + 1}/${maxAccepts})…`);
        await this.devices.tap900(serial, btn.bounds.cx, btn.bounds.cy, sw, sh, signal);
        await abortableWait(1500, signal);
        const afterPng = await this.devices.screencap(serial, signal);
        // Verify the blue "确认" button disappeared / turned non-blue before counting!
        if (!(await isSolidBlueButton(afterPng, btn.bounds))) {
          accepted++;
          acceptedThisScreen++;
          onAction();
          png = afterPng;
          xml = await this.devices.dumpXml(serial, sw, sh, signal);
          break; // Re-read fresh layout because rows shift upward after confirming
        }
      }

      if (acceptedThisScreen === 0) {
        emptyScrolls++;
        await this.devices.swipe900(serial, 450, 1240, 450, 520, 480, sw, sh, signal);
        await abortableWait(1500, signal);
        [xml, png] = await Promise.all([
          this.devices.dumpXml(serial, sw, sh, signal),
          this.devices.screencap(serial, signal),
        ]);
      } else {
        emptyScrolls = 0;
      }
    }

    return { accepted, skipped: false };
  }

  private async runPostOrStoryStep(
    inst: BluestacksInstance,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ published: number; skipped: boolean; note?: string }> {
    const caption = spec.caption?.trim() ?? '';
    const mediaPath = spec.mediaPath?.trim() ?? '';
    if (!caption && (!mediaPath || !existsSync(mediaPath))) {
      const note = '跳过发布步骤：未提供有效文案或本地媒体文件';
      onStatus(note);
      return { published: 0, skipped: true, note };
    }

    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const pushedRemote: string[] = [];

    try {
      if (mediaPath && existsSync(mediaPath)) {
        onStatus('正在推送媒体文件到模拟器相册…');
        const remote = await this.devices.pushMediaToGallery(serial, mediaPath, signal);
        pushedRemote.push(remote);
      }

      onStatus(spec.type === 'story' ? '正在打开发布快拍入口…' : '正在打开时间线发帖编辑页…');
      await this.devices.openDeepLink(serial, 'https://www.facebook.com/', sw, sh, signal);
      await abortableWait(2200, signal);

      // Tap Home tab icon to scroll back to top and expose the `+` create button / composer bar
      let xml = await this.devices.dumpXml(serial, sw, sh, signal);
      const tabBar = detectHomeTabBar(xml);
      if (tabBar?.tabs[0]) {
        await this.devices.tap900(serial, tabBar.tabs[0].cx, tabBar.tabs[0].cy, sw, sh, signal);
        await abortableWait(1600, signal);
      }

      if (spec.type === 'story') {
        // Tap "创建快拍" card on Home top carousel (~x=150, y=420)
        await this.devices.tap900(serial, 150, 420, sw, sh, signal);
        await abortableWait(2500, signal);
        if (pushedRemote.length > 0) {
          // Select newest gallery tile (top-left of story gallery grid)
          await this.devices.tap900(serial, 150, 460, sw, sh, signal);
          await abortableWait(2200, signal);
        }
        const [storyPng, storyXml] = await Promise.all([
          this.devices.screencap(serial, signal),
          this.devices.dumpXml(serial, sw, sh, signal),
        ]);
        const shareCands = flattenLiteNodes(storyXml).filter(
          (n) => n.clickable && n.bounds.y1 >= 1320 && n.bounds.w >= 140 && n.bounds.h >= 40,
        );
        for (const btn of shareCands) {
          const t = (await this.ocr.recognizeBounds(storyPng, btn.bounds)).replace(/\s+/g, '');
          if (/分享|发布|立即分享|share/i.test(t)) {
            onStatus('正在发布快拍…');
            await this.devices.tap900(serial, btn.bounds.cx, btn.bounds.cy, sw, sh, signal);
            await abortableWait(4000, signal);
            onAction();
            return { published: 1, skipped: false };
          }
        }
        await this.devices.keyevent(serial, 4, signal).catch(() => null);
        return { published: 0, skipped: true, note: '未找到快拍分享按钮，已安全退出' };
      }

      // Standard timeline post: tap composer bar ("分享新鲜事...") around (420, 240)
      await this.devices.tap900(serial, 420, 240, sw, sh, signal);
      await abortableWait(2200, signal);

      let [compPng, compXml] = await Promise.all([
        this.devices.screencap(serial, signal),
        this.devices.dumpXml(serial, sw, sh, signal),
      ]);
      const inputNode = findTextInputNode(compXml);
      if (caption) {
        onStatus('正在输入帖子文案…');
        await this.devices.pasteIntoFocused(
          serial,
          inputNode?.bounds.cx ?? 420,
          inputNode?.bounds.cy ?? 420,
          caption,
          sw,
          sh,
          signal,
        );
        await abortableWait(900, signal);
      }

      if (pushedRemote.length > 0) {
        onStatus('正在选择相册媒体…');
        const rows = flattenLiteNodes(compXml)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.w >= 650 &&
              n.bounds.y1 >= 800 &&
              n.bounds.h >= 46 &&
              n.bounds.h <= 115,
          )
          .sort((a, b) => a.bounds.y1 - b.bounds.y1);
        for (const r of rows) {
          const rt = (await this.ocr.recognizeBounds(compPng, r.bounds)).replace(/\s+/g, '');
          if (/照片|视频|photo|video/i.test(rt)) {
            await this.devices.tap900(serial, r.bounds.cx, r.bounds.cy, sw, sh, signal);
            await abortableWait(2400, signal);
            await this.devices.tap900(serial, 150, 340, sw, sh, signal);
            await abortableWait(1800, signal);
            // Tap top-right Next / Done ("下一步" / "完成") if still in gallery
            const [galPng, galXml] = await Promise.all([
              this.devices.screencap(serial, signal),
              this.devices.dumpXml(serial, sw, sh, signal),
            ]);
            const nextBtns = flattenLiteNodes(galXml).filter(
              (n) => n.clickable && n.bounds.x1 >= 650 && n.bounds.y1 <= 160 && n.bounds.h >= 36,
            );
            for (const nb of nextBtns) {
              const nt = (await this.ocr.recognizeBounds(galPng, nb.bounds)).replace(/\s+/g, '');
              if (/下一步|完成|确定|next|done/i.test(nt)) {
                await this.devices.tap900(serial, nb.bounds.cx, nb.bounds.cy, sw, sh, signal);
                await abortableWait(2200, signal);
                break;
              }
            }
            break;
          }
        }
      }

      [compPng, compXml] = await Promise.all([
        this.devices.screencap(serial, signal),
        this.devices.dumpXml(serial, sw, sh, signal),
      ]);
      const postBtnCands = flattenLiteNodes(compXml).filter(
        (n) =>
          n.clickable &&
          ((n.bounds.x1 >= 680 && n.bounds.y1 <= 140 && n.bounds.h >= 36) ||
            (n.bounds.w >= 450 && n.bounds.y1 >= 1360 && n.bounds.h >= 42)),
      );
      for (const pb of postBtnCands) {
        const pt = (await this.ocr.recognizeBounds(compPng, pb.bounds)).replace(/\s+/g, '');
        if (/发布|發佈|post/i.test(pt) || (await isSolidBlueButton(compPng, pb.bounds))) {
          onStatus('正在提交发布…');
          await this.devices.tap900(serial, pb.bounds.cx, pb.bounds.cy, sw, sh, signal);
          await abortableWait(4500, signal);
          const afterXml = await this.devices.dumpXml(serial, sw, sh, signal);
          if (detectHomeTabBar(afterXml) || !findTextInputNode(afterXml)) {
            onAction();
            return { published: 1, skipped: false };
          }
        }
      }

      await this.devices.keyevent(serial, 4, signal).catch(() => null);
      return { published: 0, skipped: true, note: '未能确认发布按钮或发布结果' };
    } finally {
      if (pushedRemote.length > 0) {
        await this.devices.cleanupPushedMedia(serial, pushedRemote);
      }
    }
  }

  async run(
    instanceId: string,
    steps: readonly BluestacksActiveStepSpec[],
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      action(): void;
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
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);

    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      const step = steps[i];
      if (!step) continue;
      const prefix = steps.length > 1 ? `[${i + 1}/${steps.length}] ` : '';

      if (step.type === 'feed') {
        const r = await this.runFeedStep(
          inst,
          step,
          signal,
          (t) => callbacks.status(prefix + t),
          callbacks.action,
        );
        outcome.likes += r.likes;
        outcome.completedSteps++;
      } else if (step.type === 'video') {
        const r = await this.runReelsStep(
          inst,
          step,
          signal,
          (t) => callbacks.status(prefix + t),
          callbacks.action,
        );
        outcome.likes += r.likes;
        outcome.completedSteps++;
      } else if (step.type === 'marketplace') {
        const r = await this.runMarketplaceStep(inst, step, signal, (t) =>
          callbacks.status(prefix + t),
        );
        if (r.skipped) {
          outcome.skippedSteps++;
          if (r.note) outcome.notes.push(r.note);
        } else {
          outcome.completedSteps++;
        }
      } else if (step.type === 'friends') {
        const r = await this.runFriendsStep(
          inst,
          step,
          signal,
          (t) => callbacks.status(prefix + t),
          callbacks.action,
        );
        outcome.acceptedFriends += r.accepted;
        if (r.skipped) {
          outcome.skippedSteps++;
          if (r.note) outcome.notes.push(r.note);
        } else {
          outcome.completedSteps++;
        }
      } else if (step.type === 'post' || step.type === 'story') {
        const r = await this.runPostOrStoryStep(
          inst,
          step,
          signal,
          (t) => callbacks.status(prefix + t),
          callbacks.action,
        );
        outcome.published += r.published;
        if (r.skipped) {
          outcome.skippedSteps++;
          if (r.note) outcome.notes.push(r.note);
        } else {
          outcome.completedSteps++;
        }
      }
    }

    return outcome;
  }
}
