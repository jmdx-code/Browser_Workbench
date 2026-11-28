import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BluestacksPosterRunnerPort } from '../application/bluestacks/bs-types.js';
import { resolveEffectiveBsAccountId, type BluestacksInstance } from '../shared/bluestacks.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import {
  canPosterMaterialUseColorBackground,
  formatPosterCaptionPreview,
  type PosterLog,
  type PosterMaterial,
} from '../shared/group-poster.js';
import {
  GALLERY_NEXT_RE,
  createScreenOps,
  extractGalleryGridTiles,
  filterClickableNodes,
  type BluestacksDeviceManager,
  type ScreenOps,
} from './bluestacks-device-manager.js';
import {
  detectHomeTabBar,
  extractActionBars,
  extractPostCards,
  findJoinGroupButtonNode,
  findTextInputNode,
  flattenLiteNodes,
  getRegionSignature,
  isGalleryCameraTile,
  isLikeButtonBlue,
  isSolidBlueButton,
  makeCanonicalRect,
  resolveSharePostUrl,
  signatureSimilarity,
  type LiteXmlNode,
  type OcrRecognizer,
} from './bluestacks-vision.js';
const POST_ERROR_OCR_RE =
  /无法发布|無法發佈|发帖受限|發帖受限|暂时受限|無法執行|无法执行此操作|发布失败|發佈失敗|重试|couldn'tpost|youcan'tpost|somethingwentwrong|tryagain|errorposting|failedtoupload|无法上传|上傳失敗|မတင်နိုင်|ပို့စ်တင်မရ|ไม่สามารถโพสต์|เกิดข้อผิดพลาด|khôngthểđăng|đãxảyralỗi/i;
const PENDING_APPROVAL_RE =
  /待审核|待審核|等待管理员审核|等待管理員審核|submittedforapproval|pendingapproval|postispending|adminapproval|စိစစ်|ခွင့်ပြု|ဆိုင်းငံ့|chờphêduyệt|đangchờduyệt|รออนุมัติ/i;
const POST_CONFIRM_TOAST_RE =
  /已发布|已發佈|已分享|分享成功|发布成功|發佈成功|posted|shared|yourpostisnowlive|postpublished|မျှဝေပြီး|တင်ပြီး|เผยแพร่แล้ว|แชร์แล้ว|đãđăng|đãchiasẻ/i;
const RECENT_POST_RE = /刚刚|剛剛|justnow|1分钟前|1m\b|ယခုလေးတင်|vừaxong|เมื่อสักครู่/i;
const CAMERA_TILE_RE = /相机|相機|camera|拍照|录像|錄影|ကင်မရာ|máyảnh|กล้อง/i;
const URL_IN_NODE_RE = /https?:\/\/(?:www\.|m\.|mbasic\.)?facebook\.com\/[^\s"'<>]+/i;
export interface BluestacksPosterLogSink {
  recordPost(input: PosterLog): Promise<boolean> | boolean;
}
const matchNodeXmlOrOcr = async (
  ops: ScreenOps,
  png: Buffer,
  cands: readonly LiteXmlNode[],
  re: RegExp,
  includeRid = false,
): Promise<LiteXmlNode | null> =>
  cands.find((n) =>
    re.test(`${n.text} ${n.contentDesc} ${includeRid ? n.resourceId : ''}`.replace(/\s+/g, '')),
  ) ??
  (await ops.findOcr(png, cands, re))?.node ??
  null;
export class BluestacksGroupPosterRunner {
  constructor(
    public readonly devices: BluestacksDeviceManager,
    private readonly ocr: OcrRecognizer,
    private readonly logSink?: BluestacksPosterLogSink,
  ) {}
  private async openGroupAndEnterComposer(
    ops: ScreenOps,
    group: BumperTarget,
    onStatus: (text: string) => void,
  ): Promise<boolean> {
    onStatus(`正在进入小组 · ${group.name}`);
    let { xml, png } = await ops.openInspect(
      `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`,
      2600,
    );
    const joinBtn = findJoinGroupButtonNode(xml);
    if (joinBtn && (await isLikeButtonBlue(png, joinBtn.bounds))) {
      const joinLabel = await ops.ocr(png, joinBtn.bounds);
      if (
        /加入|join|ပါဝင်|thamgia/i.test(joinLabel) &&
        !/邀请|邀請|invite|已加入|joined|已申请|已申請|pending|访问|訪問|visit|ဖိတ်/i.test(
          joinLabel,
        )
      ) {
        onStatus(`正在自动加入小组 · ${group.name}`);
        await ops.tap(joinBtn.bounds.cx, joinBtn.bounds.cy, 2600);
        ({ xml, png } = await ops.capture());
        if (findTextInputNode(xml)) return (await ops.back(0), false);
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const composerBars = filterClickableNodes(
          xml,
          (n) =>
            n.bounds.w >= 360 &&
            n.bounds.h >= 46 &&
            n.bounds.h <= 115 &&
            n.bounds.y1 >= 340 &&
            n.bounds.y2 <= 1280,
        ),
        hit = await ops.findOcr(
          png,
          composerBars,
          /写点什么|寫點什麼|分享新鲜事|分享新鮮事|发帖|發帖|说点什么|說點什麼|writesomething|createapublicpost|တစ်ခုခုရေး|bạnđangnghĩgì/i,
        ),
        fallbackBar = composerBars.find(
          (n) =>
            n.bounds.x1 >= 60 &&
            n.bounds.x1 <= 150 &&
            n.bounds.x2 >= 760 &&
            n.bounds.x2 <= 850 &&
            n.bounds.w >= 600 &&
            n.bounds.h >= 45 &&
            n.bounds.h <= 100 &&
            n.bounds.y1 >= 720 &&
            n.bounds.y2 <= 1120,
        ),
        targetBar = hit?.node ?? fallbackBar;
      if (targetBar) {
        await ops.tap(targetBar.bounds.cx, targetBar.bounds.cy, 1800);
        if (await ops.waitForComposerReady(8000)) return true;
      }
      await ops.swipe(450, 960, 450, 560, 420, 1200);
      ({ xml, png } = await ops.capture());
    }
    return false;
  }
  private async openOwnTimelineComposer(
    ops: ScreenOps,
    onStatus: (text: string) => void,
  ): Promise<boolean> {
    onStatus('正在打开个人/专页时间线发帖框…');
    await ops.openInspect('https://www.facebook.com/', 2200).catch((e) => {
      if (e instanceof Error && e.message.startsWith('FB Lite 账号'))
        throw new Error(`账号异常 (${e.message})，已停止本机发帖`);
      throw e;
    });
    await ops.tapHomeTab0(1500);
    const { xml, png } = await ops.capture();
    if (findTextInputNode(xml)) return true;
    const cands = filterClickableNodes(
      xml,
      (n) =>
        n.bounds.y1 >= 110 &&
        n.bounds.y2 <= 620 &&
        n.bounds.w >= 260 &&
        n.bounds.h >= 38 &&
        n.bounds.h <= 135,
    );
    const hit = await matchNodeXmlOrOcr(
      ops,
      png,
      cands,
      /分享新鲜事|分享新鮮事|写点什么|寫點什麼|说点什么|說點什麼|what'?sonyourmind|createpost|发布帖子|發佈貼文|တစ်ခုခုရေး|bạnđangnghĩgì/i,
    );
    for (const [x, y] of [
      ...(hit ? [[hit.bounds.cx, hit.bounds.cy] as [number, number]] : []),
      [420, 218] as [number, number],
      [420, 272] as [number, number],
      [420, 310] as [number, number],
    ]) {
      await ops.tap(x, y, 1800);
      if (await ops.waitForComposerReady(14000)) return true;
      if (detectHomeTabBar(await ops.xml()) === null) break;
    }
    if (detectHomeTabBar(await ops.xml()) === null) await ops.back(600);
    return false;
  }
  private async attachNewestGalleryMedia(
    ops: ScreenOps,
    mediaKind: PosterMaterial['mediaKind'],
    signal: AbortSignal,
  ): Promise<boolean> {
    let gridTiles: LiteXmlNode[] = [];
    let pickerPng: Buffer | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await ops.wait(900);
      const { xml: pickerXml, png } = await ops.capture();
      pickerPng = png;
      gridTiles = extractGalleryGridTiles(pickerXml);
      if (gridTiles.length > 0) break;
    }
    if (gridTiles.length === 0 || !pickerPng) return ops.attachMedia(true);
    let firstNonCamera: LiteXmlNode | null = null;
    let videoTile: LiteXmlNode | null = null;
    for (let i = 0; i < Math.min(8, gridTiles.length); i++) {
      const tile = gridTiles[i];
      if (!tile) continue;
      const tileTxt = await ops.ocr(pickerPng, tile.bounds).catch(() => '');
      const nodeText = `${tile.text} ${tile.contentDesc}`.replace(/\s+/g, '');
      if (CAMERA_TILE_RE.test(tileTxt) || CAMERA_TILE_RE.test(nodeText)) continue;
      if (i === 0 && (await isGalleryCameraTile(pickerPng, tile.bounds))) continue;
      firstNonCamera ??= tile;
      if (mediaKind === 'video' && /\d+:\d{2}/.test(tileTxt + nodeText)) {
        videoTile = tile;
        break;
      }
      if (mediaKind !== 'video') break;
    }
    const chosenTile = videoTile ?? firstNonCamera;
    if (!chosenTile) return ops.attachMedia(true);
    await ops.tap(chosenTile.bounds.cx, chosenTile.bounds.cy, 1600);
    const { xml: galXml, png: galPng } = await ops.capture();
    if (findTextInputNode(galXml) !== null) return true;
    const nextBtns = filterClickableNodes(
      galXml,
      (n) =>
        (n.bounds.x1 >= 560 && n.bounds.y1 <= 200 && n.bounds.h >= 34 && n.bounds.h <= 125) ||
        (n.bounds.y1 >= 1340 &&
          n.bounds.y2 <= 1600 &&
          (n.bounds.x1 >= 540 || n.bounds.w >= 260) &&
          n.bounds.h >= 38 &&
          n.bounds.h <= 135),
      (a, b) => b.bounds.y1 - a.bounds.y1 || b.bounds.x2 - a.bounds.x2,
    );
    let nextBtn =
      nextBtns.find((n) => /multipicker_next/i.test(n.resourceId)) ??
      (await matchNodeXmlOrOcr(ops, galPng, nextBtns, GALLERY_NEXT_RE));
    if (!nextBtn) {
      for (const cand of nextBtns) {
        if (await isSolidBlueButton(galPng, cand.bounds)) {
          nextBtn = cand;
          break;
        }
      }
    }
    if (nextBtn) {
      await ops.tap(nextBtn.bounds.cx, nextBtn.bounds.cy, 2200);
      if (findTextInputNode(await ops.xml()) !== null) return true;
      await ops.wait(900);
      return findTextInputNode(await ops.xml()) !== null || !signal.aborted;
    }
    return await ops.attachMedia(true);
  }
  private async extractPostUrlFromScreen(
    xml: LiteXmlNode | null,
    targetInfo: { isTimeline: boolean; groupId: string },
    ops: ScreenOps,
    signal: AbortSignal,
  ) {
    if (!xml) return null;
    const mode = targetInfo.isTimeline ? 'page' : 'group',
      tryResolve = (raw: string) =>
        resolveSharePostUrl(raw, targetInfo.groupId, mode).catch(() => null);
    for (const n of flattenLiteNodes(xml)) {
      const m = URL_IN_NODE_RE.exec(`${n.text} ${n.contentDesc}`);
      if (m?.[0]) {
        const res = await tryResolve(m[0]);
        if (res?.postUrl) return res;
      }
    }
    const topMore = extractPostCards(xml)[0]?.header.moreMenuBounds;
    const rawClip =
      topMore && typeof this.devices.copyLinkFromMoreMenu === 'function'
        ? await this.devices
            .copyLinkFromMoreMenu(ops.serial, topMore, ops.sw, ops.sh, signal)
            .catch(() => null)
        : null;
    const res = rawClip ? await tryResolve(rawClip) : null;
    return res?.postUrl ? res : null;
  }
  private async fillAndSubmitComposer(
    ops: ScreenOps,
    material: PosterMaterial,
    targetInfo: { isTimeline: boolean; groupId: string },
    signal: AbortSignal,
    onStatus: (text: string) => void,
  ): Promise<{
    submitted: boolean;
    pendingApproval?: boolean;
    postId?: string;
    postUrl?: string;
    note?: string;
  }> {
    const pushedRemote: string[] = [];
    const abortComposer = async (note: string) => (
      await ops.dismissDiscard(),
      { submitted: false as const, note }
    );
    try {
      const expectsMedia = material.mediaSource.trim().length > 0,
        candidateMediaPath =
          material.localFilePath?.trim() ||
          (expectsMedia && !/^https?:\/\//i.test(material.mediaSource.trim())
            ? material.mediaSource.trim()
            : ''),
        hasLocalMedia = Boolean(candidateMediaPath && existsSync(candidateMediaPath));
      if (expectsMedia && !hasLocalMedia)
        return await abortComposer('媒体文件缺失或下载缓存失败，已中止发布防发出纯文字/空帖');
      if (hasLocalMedia && candidateMediaPath) {
        onStatus('正在将发帖素材推送至模拟器相册…');
        pushedRemote.push(
          await this.devices.pushMediaToGallery(ops.serial, candidateMediaPath, signal),
        );
      }
      let { xml: compXml, png: compPng } = await ops.capture();
      const inputNode = findTextInputNode(compXml);
      if (!inputNode) return { submitted: false, note: '未检测到发帖输入框' };
      if (
        !hasLocalMedia &&
        canPosterMaterialUseColorBackground({
          caption: material.caption,
          mediaSource: material.mediaSource,
          background: material.background,
        })
      ) {
        const swatches = filterClickableNodes(
            compXml,
            (n) =>
              n.bounds.w >= 40 &&
              n.bounds.w <= 95 &&
              n.bounds.h >= 40 &&
              n.bounds.h <= 95 &&
              n.bounds.y1 >= 500 &&
              n.bounds.y2 <= 1040,
            (a, b) => a.bounds.x1 - b.bounds.x1,
          ),
          pickedSwatch =
            swatches[1 + Math.floor(Math.random() * Math.max(1, Math.min(4, swatches.length - 1)))];
        if (pickedSwatch) await ops.tap(pickedSwatch.bounds.cx, pickedSwatch.bounds.cy, 700);
      }
      if (material.caption.trim()) {
        onStatus('正在填入发帖文案…');
        const sigOf = (p: Buffer) => getRegionSignature(p, inputNode.bounds).catch(() => null);
        const beforePasteSig = await sigOf(compPng);
        let captionVerified = false;
        for (let pasteAttempt = 0; pasteAttempt < 2; pasteAttempt++) {
          await ops.paste(inputNode.bounds.cx, inputNode.bounds.cy, material.caption.trim());
          await ops.wait(900);
          const afterPasteSig = beforePasteSig ? await sigOf(await ops.png()) : null;
          if (
            !beforePasteSig ||
            !afterPasteSig ||
            signatureSimilarity(beforePasteSig, afterPasteSig) < 0.992
          ) {
            captionVerified = true;
            break;
          }
        }
        if (!captionVerified && !hasLocalMedia)
          return await abortComposer('未能确认发帖文案已粘贴进输入框，已取消防发空帖');
      }
      if (pushedRemote.length > 0) {
        onStatus('正在从相册附加图片/视频…');
        const MEDIA_RE =
          /照片|视频|相片|影片|图库|相册|photo|video|gallery|media|image|ဓာတ်ပုံ|ဗီဒီယို|ảnh/i;
        const findMediaBtn = async () => {
          ({ xml: compXml, png: compPng } = await ops.capture());
          const cands = filterClickableNodes(
            compXml,
            (n) =>
              n.bounds.y1 >= 420 &&
              n.bounds.y2 <= 1560 &&
              n.bounds.w >= 40 &&
              n.bounds.h >= 36 &&
              n.bounds.h <= 130,
            (a, b) => b.bounds.w - a.bounds.w || a.bounds.y1 - b.bounds.y1,
          );
          return matchNodeXmlOrOcr(ops, compPng, cands, MEDIA_RE, true);
        };
        const mediaBtn = (await findMediaBtn()) ?? (await ops.back(700), await findMediaBtn());
        const mediaAttached = mediaBtn
          ? (await ops.tap(mediaBtn.bounds.cx, mediaBtn.bounds.cy, 2500),
            await this.attachNewestGalleryMedia(ops, material.mediaKind, signal))
          : false;
        if (!mediaAttached)
          return await abortComposer('未能从模拟器相册附加图片/视频，已取消发布防发空帖');
      }
      ({ xml: compXml, png: compPng } = await ops.capture());
      if (findTextInputNode(compXml) === null)
        return await abortComposer('未回到发帖编辑框，已取消发布');
      const postBtns = filterClickableNodes(
        compXml,
        ({ bounds: b }) =>
          (b.x2 >= 800 && b.x1 >= 440 && b.y1 <= 155 && b.h >= 34 && b.h <= 115) ||
          (b.w >= 450 && b.y1 >= 880 && b.y2 <= 1585 && b.h >= 40 && b.h <= 135),
        (a, b) => b.bounds.y1 - a.bounds.y1,
      );
      let submitBtn: LiteXmlNode | null = null;
      for (const pb of postBtns) {
        const pt = await ops.ocr(compPng, pb.bounds);
        if (
          /发布|發佈|post|တင်|đăng|โพสต์/i.test(pt) ||
          (((pb.bounds.y1 <= 155 && pb.bounds.x2 >= 800) ||
            (pb.bounds.w >= 450 && pb.bounds.y1 >= 880)) &&
            (await isSolidBlueButton(compPng, pb.bounds)))
        ) {
          submitBtn = pb;
          break;
        }
      }
      if (!submitBtn) return await abortComposer('未找到有效的发布按钮');
      onStatus('正在提交发布并验证结果…');
      const submitTapX =
        submitBtn.bounds.y1 <= 155 && submitBtn.bounds.w > 180
          ? Math.min(868, Math.max(submitBtn.bounds.cx, submitBtn.bounds.x2 - 52))
          : submitBtn.bounds.cx;
      await ops.tap(submitTapX, submitBtn.bounds.cy, hasLocalMedia ? 4500 : 3200);
      const captionNorm = material.caption.replace(/\s+/g, '').slice(0, 14);
      const ok = (note?: string, pending = false, postId?: string, postUrl?: string) => ({
        submitted: true,
        pendingApproval: pending,
        ...(postId ? { postId } : {}),
        ...(postUrl ? { postUrl } : {}),
        ...(note ? { note } : {}),
      });
      const hasReadbackEvidence = (xml: LiteXmlNode | null, compactText: string): boolean => {
        if (!xml || findTextInputNode(xml) !== null) return false;
        const xmlCompact = flattenLiteNodes(xml)
          .map((n) => `${n.text}${n.contentDesc}`)
          .join('')
          .replace(/\s+/g, '');
        if (
          captionNorm.length >= 4 &&
          (compactText.includes(captionNorm) || xmlCompact.includes(captionNorm))
        )
          return true;
        return (
          (RECENT_POST_RE.test(compactText) || RECENT_POST_RE.test(xmlCompact)) &&
          (extractPostCards(xml).length > 0 || extractActionBars(xml).length > 0)
        );
      };
      const verifyDeadline =
        Date.now() +
        (hasLocalMedia && material.mediaKind === 'video'
          ? 30_000
          : hasLocalMedia
            ? 22_000
            : 10_000);
      let sawNullXml = false,
        sawInputPresent = false,
        didScrollTimeline = false;
      for (;;) {
        ops.guard();
        const { xml: afterXml, png: afterPng } = await ops.capture(),
          postAbnormal = await ops.abnormal(afterXml, afterPng);
        if (postAbnormal) throw new Error(`账号异常 (${postAbnormal})，已中止发帖`);
        const afterCompact = (
          await ops.ocr(afterPng, makeCanonicalRect(0, 120, 900, 1480))
        ).replace(/\s+/g, '');
        if (POST_ERROR_OCR_RE.test(afterCompact))
          return await abortComposer('该小组发帖受限或发布失败');
        if (PENDING_APPROVAL_RE.test(afterCompact)) return ok('已提交（等待小组管理员审核）', true);
        sawNullXml ||= afterXml === null;
        sawInputPresent = afterXml !== null && findTextInputNode(afterXml) !== null;
        let hasToast = POST_CONFIRM_TOAST_RE.test(afterCompact),
          readbackXml = afterXml,
          hasFeedReadback = hasReadbackEvidence(afterXml, afterCompact);
        const onFeedScreen =
          afterXml !== null &&
          !sawInputPresent &&
          (detectHomeTabBar(afterXml) !== null ||
            extractPostCards(afterXml).length > 0 ||
            extractActionBars(afterXml).length > 0);
        if (
          targetInfo.isTimeline &&
          onFeedScreen &&
          !hasToast &&
          !hasFeedReadback &&
          !didScrollTimeline &&
          !/正在发布|正在發佈|正在上传|正在上傳|posting|uploading/i.test(afterCompact) &&
          Date.now() + 2500 < verifyDeadline
        ) {
          didScrollTimeline = true;
          await ops.swipe(450, 980, 450, 440, 420, 1400);
          continue;
        }
        if (!hasFeedReadback && (onFeedScreen || hasToast) && Date.now() + 1200 < verifyDeadline) {
          await ops.wait(1200);
          const { xml: feedXml, png: feedPng } = await ops.capture(),
            feedAbnormal = await ops.abnormal(feedXml, feedPng);
          if (feedAbnormal) throw new Error(`账号异常 (${feedAbnormal})，已中止发帖核验`);
          const feedCompact = (
            await ops.ocr(feedPng, makeCanonicalRect(0, 120, 900, 1480))
          ).replace(/\s+/g, '');
          if (POST_ERROR_OCR_RE.test(feedCompact))
            return await abortComposer('该小组发帖受限或发布失败');
          if (PENDING_APPROVAL_RE.test(feedCompact))
            return ok('已提交（等待小组管理员审核）', true);
          hasToast ||= POST_CONFIRM_TOAST_RE.test(feedCompact);
          readbackXml = feedXml ?? readbackXml;
          hasFeedReadback = hasReadbackEvidence(feedXml, feedCompact);
        }
        if (hasToast || hasFeedReadback) {
          const extracted = await this.extractPostUrlFromScreen(
            readbackXml,
            targetInfo,
            ops,
            signal,
          );
          return extracted?.postUrl
            ? ok(undefined, false, extracted.postId, extracted.postUrl)
            : ok('已提交发布，未提取到帖子链接（待审核/待核验）', true);
        }
        if (Date.now() >= verifyDeadline) break;
        await ops.wait(2200);
      }
      if (sawInputPresent) return await abortComposer('发帖框未关闭，未能确认发布成功');
      return {
        submitted: false,
        note: sawNullXml
          ? 'UNKNOWN: 未获取到界面节点树，未能确认发布结果'
          : 'UNKNOWN: 未检测到发布成功提示或帖子回读证据',
      };
    } finally {
      if (pushedRemote.length > 0)
        await this.devices.cleanupPushedMedia?.(ops.serial, pushedRemote)?.catch(() => {});
    }
  }
  run: BluestacksPosterRunnerPort['run'] = async (
    instanceId,
    materials,
    groups,
    options,
    signal,
    callbacks,
  ) => {
    const outcome = { posted: 0, skipped: 0, notes: [] as string[] };
    if (materials.length === 0) return outcome;
    callbacks.status('正在校验蓝蝶连接与 FB Lite 账号…');
    const inst: BluestacksInstance = await this.devices.ensureReadyAndLoggedIn(instanceId, signal),
      ops = createScreenOps(this.devices, this.ocr, inst, signal),
      identityType: 'page' | 'personal' = inst.identityType === 'page' ? 'page' : 'personal';
    const executeOneTarget = async (
      target: { kind: 'timeline' } | { kind: 'group'; group: BumperTarget },
      material: PosterMaterial,
    ): Promise<boolean> => {
      if (
        target.kind === 'group' &&
        options.hasGroupPostedMaterial &&
        (await Promise.resolve(options.hasGroupPostedMaterial(target.group.id, material.id)))
      ) {
        outcome.skipped++;
        outcome.notes.push(`${target.group.name}: 已发过该素材，已自动跳过防重`);
        return false;
      }
      const isTimeline = target.kind === 'timeline',
        label = isTimeline ? '个人/专页时间线' : target.group.name,
        failTarget = async (reason: string) => {
          outcome.skipped++;
          outcome.notes.push(`${label}: ${reason}`);
          await callbacks.onTargetFailed?.({
            groupId: isTimeline ? '' : target.group.id,
            groupName: label,
            isTimeline,
            material,
            reason,
          });
          return false;
        };
      const opened = isTimeline
        ? await this.openOwnTimelineComposer(ops, callbacks.status)
        : await this.openGroupAndEnterComposer(ops, target.group, callbacks.status);
      if (!opened)
        return failTarget(isTimeline ? '未能打开时间线发帖入口' : '未能打开小组发帖入口');
      const groupId = isTimeline ? '__page_timeline__' : target.group.id;
      const res = await this.fillAndSubmitComposer(
        ops,
        material,
        { isTimeline, groupId },
        signal,
        callbacks.status,
      );
      if (!res.submitted) return failTarget(res.note ?? '发布未确认');
      outcome.posted++;
      if (res.note) outcome.notes.push(`${label}: ${res.note}`);
      const posterLog: PosterLog = {
        id: randomUUID(),
        profileId: inst.id,
        accountId: resolveEffectiveBsAccountId(inst),
        accountName: inst.accountName || inst.displayName,
        accountAvatar: inst.avatarUrl,
        identityType,
        groupId,
        groupName: label,
        groupAvatar: isTimeline ? null : target.group.avatarUrl,
        materialId: material.id,
        captionPreview: formatPosterCaptionPreview(
          material.caption,
          material.mediaSource,
          material.mediaKind,
        ),
        postId: res.pendingApproval ? 'pending_approval' : res.postId || 'pending_approval',
        postUrl: res.postUrl ?? '',
        postedAt: Date.now(),
      };
      if (this.logSink)
        await Promise.resolve(this.logSink.recordPost(posterLog)).catch(() => false);
      callbacks.posted();
      await callbacks.onPostLog?.(posterLog, isTimeline);
      return true;
    };
    const gapWait = () => ops.wait(2500 + Math.floor(Math.random() * 2000));
    if (options.claimNextGroupJob) {
      let executed = 0;
      if (options.postToTimeline && materials[0]) {
        ops.guard();
        await executeOneTarget({ kind: 'timeline' }, materials[0]);
        executed++;
      }
      for (let count = 0; count < Math.max(0, options.maxGroupsPerInstance); count++) {
        ops.guard();
        const job = await Promise.resolve(options.claimNextGroupJob());
        if (!job) break;
        if (executed > 0) await gapWait();
        let ok = false;
        try {
          ok = await executeOneTarget({ kind: 'group', group: job.group }, job.material);
        } finally {
          options.releaseGroupJob?.(job.group.id, job.material.id, ok);
        }
        executed++;
      }
      return outcome;
    }
    const targets: Array<{ kind: 'timeline' } | { kind: 'group'; group: BumperTarget }> = [
        ...(options.postToTimeline ? [{ kind: 'timeline' as const }] : []),
        ...groups
          .slice(0, Math.max(0, options.maxGroupsPerInstance))
          .map((group) => ({ kind: 'group' as const, group })),
      ],
      matsPerGroup = Math.min(
        materials.length,
        Math.max(1, Math.floor(options.materialsPerGroup ?? 1)),
      ),
      jobs = targets.flatMap((target, idx) =>
        Array.from({ length: target.kind === 'timeline' ? 1 : matsPerGroup }, (_, mOff) => ({
          target,
          material: materials[(idx + mOff) % materials.length],
        })).filter((j): j is { target: (typeof targets)[number]; material: PosterMaterial } =>
          Boolean(j.material),
        ),
      );
    for (let idx = 0; idx < jobs.length; idx++) {
      ops.guard();
      const job = jobs[idx];
      if (job) await executeOneTarget(job.target, job.material);
      if (idx + 1 < jobs.length) await gapWait();
    }
    return outcome;
  };
}
