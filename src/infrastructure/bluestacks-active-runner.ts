import { existsSync } from 'node:fs';
import type {
  BluestacksActiveRunnerPort,
  BluestacksActiveStepParam,
} from '../application/bluestacks/bs-types.js';
import { resolveEffectiveBsAccountId, type BluestacksInstance } from '../shared/bluestacks.js';
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
  type RectBounds,
} from './bluestacks-vision.js';
type BluestacksActiveStepSpec = BluestacksActiveStepParam;
type RiskCheckFn = NonNullable<Parameters<BluestacksActiveRunnerPort['run']>[3]['checkRiskLimit']>;
type BluestacksActiveRunOutcome = Awaited<ReturnType<BluestacksActiveRunnerPort['run']>>;
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const FRIEND_NEGATIVE_OCR_RE =
  /delete|remove|cancel|reject|decline|删除|刪除|取消|拒绝|拒絕|忽略|ลบ|ยกเลิก|ไม่รับ|xóa|hủy|từchối|ဖျက်|ပယ်ဖျက်|မလက်ခံ/i;
const FRIEND_CONFIRM_OCR_RE =
  /confirm|accept|确认|確認|同意|接受|အတည်ပြု|လက်ခံ|ยืนยัน|ตกลง|ยอมรับ|xácnhận|chấpnhận|đồngý/i;
const POST_ERROR_OCR_RE =
  /无法发布|無法發佈|发帖受限|發帖受限|暂时受限|無法執行|无法执行此操作|发布失败|發佈失敗|couldn'tpost|youcan'tpost|somethingwentwrong|tryagain|errorposting|failedtoupload|无法上传|上傳失敗|မတင်နိုင်|ပို့စ်တင်မရ|ไม่สามารถโพสต์|เกิดข้อผิดพลาด|khôngthểđăng|đãxảyralỗi/i;
const POST_CONFIRM_TOAST_RE =
  /已发布|已發佈|已分享|分享成功|发布成功|發佈成功|已添加到你的快拍|已新增到你的限時動態|posted|shared|addedtoyourstory|yourpostisnowlive|storyshared|待审核|待審核|等待管理员审核|等待管理員審核|submittedforapproval|pendingapproval|postispending|စိစစ်|ခွင့်ပြု|ဆိုင်းငံ့|မျှဝေပြီး|တင်ပြီး|เผยแพร่แล้ว|แชร์แล้ว|รออนุมัติ|đãđăng|đãchiasẻ|chờphêduyệt/i;
const STORY_READBACK_RE = /你的快拍|你的限時動態|yourstory|查看快拍|viewstory/i;
const STORY_CREATE_RE = /(?:创建|建立|create|addto)(?:快拍|限時動態|story)/i;
const stepDeadline = (mins: number, minMs = 10_000) =>
    Date.now() + Math.max(minMs, Math.round(mins * 60_000)),
  leftSec = (deadline: number) => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
  skipStep = (onStatus: (text: string) => void, note: string) => (
    onStatus(note),
    { skipped: true, note }
  ),
  swipeVertical = (
    ops: ScreenOps,
    y1Min: number,
    y1Max: number,
    y2Min: number,
    y2Max: number,
    durMin: number,
    durMax: number,
    waitMin: number,
    waitMax: number,
  ) =>
    ops.swipe(
      randInt(425, 475),
      randInt(y1Min, y1Max),
      randInt(425, 475),
      randInt(y2Min, y2Max),
      randInt(durMin, durMax),
      randInt(waitMin, waitMax),
    );
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
  private async runLikeBrowseLoop(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
    onAction: () => void,
    checkRiskLimit: RiskCheckFn | undefined,
    cfg: {
      minMs?: number;
      openUrl: string;
      openWait: [number, number];
      openStatus: string;
      noun: string;
      step: (
        idx: number,
        deadline: number,
        status: string,
        tryLike: (
          png: Buffer,
          findBounds: () => Promise<RectBounds | undefined>,
        ) => Promise<boolean>,
      ) => Promise<void>;
      after?: () => Promise<void>;
    },
  ): Promise<{ likes: number }> {
    const deadline = stepDeadline(spec.durationMinutes ?? 1, cfg.minMs),
      maxLikes = Math.max(0, spec.maxLikes ?? 2),
      likeProb = Math.max(0, Math.min(1, (spec.likeProbability ?? 35) / 100));
    let likes = 0,
      likeLimitHit = false;
    onStatus(cfg.openStatus);
    await ops.open(cfg.openUrl, randInt(...cfg.openWait));
    for (let idx = 1; Date.now() < deadline; idx++) {
      ops.guard();
      const status = likeLimitHit
        ? `已达点赞上限 · 继续${cfg.noun} (${leftSec(deadline)}s)`
        : `正在${cfg.noun} (${leftSec(deadline)}s · 已赞 ${likes}/${maxLikes})`;
      onStatus(status);
      await cfg.step(idx, deadline, status, async (png, findBounds) => {
        if (likeLimitHit || likes >= maxLikes || Math.random() >= likeProb) return false;
        const cap = checkRiskLimit ? await checkRiskLimit('like') : { allowed: true, reason: null };
        if (!cap.allowed) {
          likeLimitHit = true;
          onStatus(`${cap.reason ?? '今日点赞已达上限'} · 继续${cfg.noun} (${leftSec(deadline)}s)`);
          return false;
        }
        const bounds = await findBounds();
        if (!bounds || !(await this.tryLikeBounds(ops, png, bounds, randInt(850, 1450), onAction)))
          return false;
        likes++;
        return true;
      });
    }
    await cfg.after?.();
    return { likes };
  }
  private runFeedStep(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
    onAction: () => void,
    checkRiskLimit?: RiskCheckFn,
  ) {
    return this.runLikeBrowseLoop(ops, spec, onStatus, onAction, checkRiskLimit, {
      openUrl: 'https://www.facebook.com/',
      openWait: [1900, 2600],
      openStatus: '正在打开首页信息流…',
      noun: '浏览首页',
      step: async (scrollCount, deadline, _st, tryLike) => {
        const { xml, png } = await ops.capture();
        if (scrollCount === 1 || scrollCount % 4 === 0) await ops.healthy(xml, png);
        await tryLike(
          png,
          async () =>
            extractActionBars(xml).find((b) => b.likeBounds.y1 >= 160 && b.likeBounds.y2 <= 1520)
              ?.likeBounds,
        );
        await ops.wait(Math.min(Math.max(1400, deadline - Date.now()), randInt(2500, 5400)));
        if (Date.now() < deadline)
          await swipeVertical(ops, 1190, 1330, 320, 490, 440, 620, 800, 1650);
      },
    });
  }
  private runReelsStep(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    onStatus: (text: string) => void,
    onAction: () => void,
    checkRiskLimit?: RiskCheckFn,
  ) {
    const centerFrameBounds = makeCanonicalRect(120, 260, 780, 1180);
    return this.runLikeBrowseLoop(ops, spec, onStatus, onAction, checkRiskLimit, {
      minMs: 12_000,
      openUrl: 'https://www.facebook.com/reel/',
      openWait: [2600, 3400],
      openStatus: '正在打开 Reels 短视频…',
      noun: '观看 Reels',
      step: async (reelIdx, deadline, _st, tryLike) => {
        const firstPng = await ops.png();
        if (reelIdx === 1) await ops.healthy(await ops.xml(), firstPng);
        const sig1 = await getRegionSignature(firstPng, centerFrameBounds);
        await ops.wait(Math.min(Math.max(1800, deadline - Date.now()), randInt(4400, 9600)));
        const secondPng = await ops.png(),
          sig2 = await getRegionSignature(secondPng, centerFrameBounds);
        if (!sig1 || !sig2 || signatureSimilarity(sig1, sig2) < 0.996)
          await tryLike(
            secondPng,
            async () =>
              filterClickableNodes(
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
              )[0]?.bounds,
          );
        if (Date.now() < deadline)
          await swipeVertical(ops, 1240, 1340, 290, 380, 310, 440, 1100, 2000);
      },
      after: () => ops.back(700),
    });
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
    const { png: initPng } = await ops.openInspect(
        'https://www.facebook.com/marketplace/',
        randInt(2300, 3000),
      ),
      initText = await ops.ocr(initPng, makeCanonicalRect(0, 120, 900, 1100));
    if (/内容暂时无法显示|目前无法使用|isn'tavailable|marketplaceisn'tavailable/i.test(initText))
      return skipStep(onStatus, '跳过商城浏览：当前账号/专页无权访问 Marketplace');
    for (let openedDetails = 0; Date.now() < deadline;) {
      ops.guard();
      onStatus(`正在浏览 Marketplace 商城 (${leftSec(deadline)}s)`);
      await swipeVertical(ops, 1190, 1300, 420, 520, 450, 620, 1700, 2700);
      if (Date.now() >= deadline) break;
      if (openedDetails < 2 && Math.random() < 0.45) {
        await ops.tap(
          Math.random() < 0.5 ? randInt(200, 260) : randInt(640, 700),
          randInt(560, 840),
          Math.min(Math.max(1500, deadline - Date.now()), randInt(2400, 3900)),
        );
        openedDetails++;
        await ops.back(randInt(950, 1450));
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
    checkRiskLimit?: RiskCheckFn,
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
        const btnCompact = (await ops.ocr(png, btn.bounds)).replace(/\s+/g, '');
        if (
          !btnCompact ||
          FRIEND_NEGATIVE_OCR_RE.test(btnCompact) ||
          !FRIEND_CONFIRM_OCR_RE.test(btnCompact)
        )
          continue;
        if (checkRiskLimit) {
          const cap = await checkRiskLimit('action');
          if (!cap.allowed) {
            const msg = cap.reason ?? '今日已达蓝蝶风控安全上限，停止接受好友请求';
            onStatus(msg);
            return { accepted, skipped: accepted === 0, note: msg };
          }
        }
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
        await ops.swipe(450, 1240, 450, 520, 480, randInt(1200, 1800));
        ({ xml, png } = await ops.capture());
      } else emptyScrolls = 0;
    }
    return { accepted, skipped: false };
  }
  private async verifyPublishOutcome(
    ops: ScreenOps,
    opts: {
      timeoutMs: number;
      abortLabel: string;
      errReason: string;
      unconfirmedReason: string;
      timeoutReason: string;
      homeWaitMs: number;
      homeRect: ReturnType<typeof makeCanonicalRect>;
      checkHome: (homeText: string, homeXml: Awaited<ReturnType<ScreenOps['xml']>>) => boolean;
    },
  ): Promise<{ ok: boolean; reason?: string }> {
    for (const deadline = Date.now() + opts.timeoutMs; Date.now() < deadline;) {
      await ops.wait(2000);
      const { xml: afterXml, png: afterPng } = await ops.capture();
      const abn = await ops.abnormal(afterXml, afterPng);
      if (abn) throw new Error(`账号异常 (${abn})，已中止${opts.abortLabel}`);
      const bodyText = (await ops.ocr(afterPng, makeCanonicalRect(0, 120, 900, 1480))).replace(
        /\s+/g,
        '',
      );
      if (POST_ERROR_OCR_RE.test(bodyText)) return { ok: false, reason: opts.errReason };
      if (POST_CONFIRM_TOAST_RE.test(bodyText)) return { ok: true };
      if (detectHomeTabBar(afterXml)) {
        await ops.wait(opts.homeWaitMs);
        const { xml: homeXml, png: homePng } = await ops.capture();
        const homeAbn = await ops.abnormal(homeXml, homePng);
        if (homeAbn) throw new Error(`账号异常 (${homeAbn})，已中止${opts.abortLabel}核验`);
        const homeText = (await ops.ocr(homePng, opts.homeRect)).replace(/\s+/g, '');
        if (POST_ERROR_OCR_RE.test(homeText)) return { ok: false, reason: opts.errReason };
        if (POST_CONFIRM_TOAST_RE.test(homeText) || opts.checkHome(homeText, homeXml))
          return { ok: true };
        return { ok: false, reason: opts.unconfirmedReason };
      }
    }
    return { ok: false, reason: opts.timeoutReason };
  }
  private async runPostOrStoryStep(
    ops: ScreenOps,
    spec: BluestacksActiveStepSpec,
    signal: AbortSignal,
    onStatus: (text: string) => void,
    onAction: () => void,
  ): Promise<{ published: number; skipped: boolean; attempted: boolean; note?: string }> {
    const caption = spec.caption?.trim() ?? '',
      mediaPath = spec.mediaPath?.trim() ?? '';
    if (!caption && (!mediaPath || !existsSync(mediaPath)))
      return {
        published: 0,
        attempted: false,
        ...skipStep(onStatus, '跳过发布步骤：未提供有效文案或本地媒体文件'),
      };
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
        const homeXml = await ops.xml();
        const storyCard = filterClickableNodes(
          homeXml,
          (n) =>
            n.bounds.x1 <= 40 &&
            n.bounds.w >= 180 &&
            n.bounds.w <= 320 &&
            n.bounds.y1 >= 240 &&
            n.bounds.y2 <= 860 &&
            n.bounds.h >= 280,
          (a, b) => a.bounds.x1 - b.bounds.x1,
        )[0];
        await ops.tap(storyCard?.bounds.cx ?? 150, storyCard?.bounds.cy ?? 480, 2500);
        if (pushedRemote.length > 0) await ops.tap(150, 460, 2200);
        const { xml: storyXml, png: storyPng } = await ops.capture(),
          shareCands = filterClickableNodes(
            storyXml,
            (n) => n.bounds.y1 >= 1320 && n.bounds.w >= 140 && n.bounds.h >= 40,
          ),
          shareBtn = await ops.findOcr(
            storyPng,
            shareCands,
            /分享|发布|發佈|立即分享|share|မျှဝေ|တင်|chiasẻ|แชร์/i,
          );
        if (shareBtn) {
          onStatus('正在发布快拍…');
          await ops.tap(shareBtn.node.bounds.cx, shareBtn.node.bounds.cy);
          const check = await this.verifyPublishOutcome(ops, {
            timeoutMs: 14_000,
            abortLabel: '快拍发布',
            errReason: '快拍发布受限或失败',
            unconfirmedReason:
              'UNKNOWN: UNCONFIRMED 快拍提交后未观察到明确发布成功提示或快拍栏回读证据',
            timeoutReason: 'UNKNOWN: UNCONFIRMED 未能确认快拍发布完成，已安全退出',
            homeWaitMs: 1800,
            homeRect: makeCanonicalRect(0, 140, 900, 620),
            checkHome: (t) => STORY_READBACK_RE.test(t) && !STORY_CREATE_RE.test(t),
          });
          if (check.ok)
            return (
              (published = true),
              onAction(),
              { published: 1, skipped: false, attempted: true }
            );
          return (
            await ops.back(0),
            {
              published: 0,
              skipped: true,
              attempted: true,
              note: check.reason ?? 'UNKNOWN: UNCONFIRMED 快拍未确认',
            }
          );
        }
        return (
          await ops.back(0),
          { published: 0, skipped: true, attempted: true, note: '未找到快拍分享按钮，已安全退出' }
        );
      }
      const { xml: homeXml, png: homePng } = await ops.capture();
      let openedComposer = findTextInputNode(homeXml) !== null;
      if (!openedComposer) {
        const cands = filterClickableNodes(
          homeXml,
          (n) =>
            n.bounds.y1 >= 110 &&
            n.bounds.y2 <= 620 &&
            n.bounds.w >= 260 &&
            n.bounds.h >= 38 &&
            n.bounds.h <= 135,
        );
        const hit =
          cands.find((n) =>
            /分享新鲜事|分享新鮮事|写点什么|寫點什麼|说点什么|說點什麼|what'?sonyourmind|createpost|တစ်ခုခုရေး|bạnđangnghĩgì/i.test(
              `${n.text} ${n.contentDesc}`.replace(/\s+/g, ''),
            ),
          ) ??
          (
            await ops.findOcr(
              homePng,
              cands,
              /分享新鲜事|分享新鮮事|写点什么|寫點什麼|说点什么|說點什麼|what'?sonyourmind|createpost|发布帖子|發佈貼文|တစ်ခုခုရေး|bạnđangnghĩgì/i,
            )
          )?.node ??
          null;
        for (const [x, y] of [
          ...(hit ? [[hit.bounds.cx, hit.bounds.cy] as [number, number]] : []),
          [420, 218] as [number, number],
          [420, 272] as [number, number],
        ]) {
          await ops.tap(x, y, 1800);
          if (await ops.waitForComposerReady(14000)) {
            openedComposer = true;
            break;
          }
          if (detectHomeTabBar(await ops.xml()) === null) break;
        }
      }
      let { xml: compXml, png: compPng } = await ops.capture();
      const inputNode = findTextInputNode(compXml);
      if (!openedComposer || !inputNode)
        return (
          await ops.back(0),
          {
            published: 0,
            skipped: true,
            attempted: false,
            note: '未能打开时间线发帖编辑框，已安全退出',
          }
        );
      if (caption) {
        onStatus('正在输入帖子文案…');
        await ops.paste(inputNode.bounds.cx, inputNode.bounds.cy, caption);
        await ops.wait(900);
      }
      if (pushedRemote.length > 0) {
        onStatus('正在选择相册媒体…');
        const MEDIA_RE =
          /照片|视频|相片|影片|图库|相册|photo|video|gallery|media|image|ဓာတ်ပုံ|ဗီဒီယို|ảnh/i;
        const findMediaNode = async () => {
          ({ xml: compXml, png: compPng } = await ops.capture());
          const rows = filterClickableNodes(
            compXml,
            (n) =>
              n.bounds.y1 >= 420 &&
              n.bounds.y2 <= 1560 &&
              n.bounds.w >= 40 &&
              n.bounds.h >= 36 &&
              n.bounds.h <= 130,
            (a, b) => b.bounds.w - a.bounds.w || a.bounds.y1 - b.bounds.y1,
          );
          return (
            rows.find((n) =>
              MEDIA_RE.test(`${n.text} ${n.contentDesc} ${n.resourceId}`.replace(/\s+/g, '')),
            ) ??
            (await ops.findOcr(compPng, rows, MEDIA_RE))?.node ??
            null
          );
        };
        const mediaNode = (await findMediaNode()) ?? (await ops.back(700), await findMediaNode());
        const attached = mediaNode
          ? (await ops.tap(mediaNode.bounds.cx, mediaNode.bounds.cy, 2400),
            await ops.attachMedia(true))
          : false;
        if (!attached)
          return (
            await ops.dismissDiscard(),
            {
              published: 0,
              skipped: true,
              attempted: false,
              note: '未能从模拟器相册附加图片/视频，已取消发布',
            }
          );
      }
      ({ xml: compXml, png: compPng } = await ops.capture());
      const postBtnCands = filterClickableNodes(
        compXml,
        (n) =>
          (n.bounds.x2 >= 800 &&
            n.bounds.x1 >= 440 &&
            n.bounds.y1 <= 155 &&
            n.bounds.h >= 34 &&
            n.bounds.h <= 115) ||
          (n.bounds.w >= 450 && n.bounds.y1 >= 880 && n.bounds.y2 <= 1585 && n.bounds.h >= 40),
        (a, b) => b.bounds.y1 - a.bounds.y1,
      );
      for (const pb of postBtnCands) {
        const pt = await ops.ocr(compPng, pb.bounds);
        if (
          /发布|發佈|post|တင်|đăng|โพสต์/i.test(pt) ||
          (await isSolidBlueButton(compPng, pb.bounds))
        ) {
          onStatus('正在提交发布…');
          await ops.tap(pb.bounds.cx, pb.bounds.cy, 1500);
          const captionNorm = caption.replace(/\s+/g, '').slice(0, 14);
          const check = await this.verifyPublishOutcome(ops, {
            timeoutMs: pushedRemote.length > 0 ? 22_000 : 12_000,
            abortLabel: '发帖',
            errReason: '时间线发帖受限或失败',
            unconfirmedReason: 'UNKNOWN: UNCONFIRMED 贴文提交后未确认到成功提示或信息流回读证据',
            timeoutReason: 'UNKNOWN: UNCONFIRMED 发帖结果未确认',
            homeWaitMs: 1500,
            homeRect: makeCanonicalRect(0, 160, 900, 1480),
            checkHome: (t, x) =>
              (captionNorm.length >= 4 && t.includes(captionNorm)) ||
              (/刚刚|剛剛|justnow|1分钟前|1m\b|ယခုလေးတင်|vừaxong|เมื่อสักครู่/i.test(t) &&
                extractActionBars(x).length > 0),
          });
          if (check.ok)
            return (
              (published = true),
              onAction(),
              { published: 1, skipped: false, attempted: true }
            );
          return (
            await ops.back(0),
            {
              published: 0,
              skipped: true,
              attempted: true,
              note: check.reason ?? 'UNKNOWN: UNCONFIRMED 发帖未确认',
            }
          );
        }
      }
      return (
        await ops.back(0),
        { published: 0, skipped: true, attempted: true, note: '未能确认发布按钮或发布结果' }
      );
    } finally {
      if (pushedRemote.length > 0 && !published)
        await this.devices.cleanupPushedMedia(ops.serial, pushedRemote).catch(() => {});
    }
  }
  run: BluestacksActiveRunnerPort['run'] = async (instanceId, steps, signal, callbacks) => {
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
      const stepStart = Date.now();
      let stepFriends = 0;
      const prefix = steps.length > 1 ? `[${i + 1}/${steps.length}] ` : '',
        status = (t: string) => callbacks.status(prefix + t);
      try {
        if (step.type === 'feed') {
          if (step.feedMode && step.feedMode !== 'home')
            outcome.notes.push('蓝蝶暂不支持串门/搜专页浏览，已按首页 Feed 模式执行');
          outcome.likes += (
            await this.runFeedStep(
              ops,
              step,
              status,
              () => callbacks.action('like'),
              callbacks.checkRiskLimit,
            )
          ).likes;
          outcome.completedSteps++;
        } else if (step.type === 'video') {
          outcome.likes += (
            await this.runReelsStep(
              ops,
              step,
              status,
              () => callbacks.action('like'),
              callbacks.checkRiskLimit,
            )
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
          const r = await this.runFriendsStep(
            inst,
            ops,
            step,
            status,
            () => callbacks.action('action'),
            callbacks.checkRiskLimit,
          );
          stepFriends = r.accepted;
          outcome.acceptedFriends += r.accepted;
          recordSkipped(r);
        } else if (step.type === 'post' || step.type === 'story') {
          if (callbacks.checkRiskLimit) {
            const cap = await callbacks.checkRiskLimit('post');
            if (!cap.allowed) {
              const reason = cap.reason ?? '今日已达蓝蝶发帖或总操作上限，跳过发布';
              status(reason);
              outcome.skippedSteps++;
              outcome.notes.push(reason);
              continue;
            }
          }
          const r = await this.runPostOrStoryStep(ops, step, signal, status, () =>
            callbacks.action('post'),
          );
          outcome.published += r.published;
          recordSkipped(r);
          const accountId = resolveEffectiveBsAccountId(inst);
          const accountName = inst.accountName || inst.displayName || '';
          const captionPreview = (step.caption ?? '').trim().slice(0, 80);
          if (r.published > 0) {
            await callbacks.recordPostResult?.({
              status: 'success',
              isStory: step.type === 'story',
              captionPreview,
              accountId,
              accountName,
            });
          } else if (r.attempted) {
            await callbacks.recordPostResult?.({
              status: 'failed',
              isStory: step.type === 'story',
              captionPreview,
              errorReason: (r.note ?? 'UNKNOWN: UNCONFIRMED').slice(0, 120),
              accountId,
              accountName,
            });
          }
        }
      } finally {
        const elapsed = Math.max(0, Date.now() - stepStart);
        if (elapsed > 0 || stepFriends > 0)
          callbacks.onProgressDelta?.({
            durationMsDelta: elapsed,
            friendsDelta: stepFriends,
            accountId: resolveEffectiveBsAccountId(inst),
          });
      }
    }
    callbacks.onStepChange?.(steps.length);
    return outcome;
  };
}
