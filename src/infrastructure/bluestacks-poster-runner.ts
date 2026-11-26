import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BluestacksInstance } from '../shared/bluestacks.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import {
  canPosterMaterialUseColorBackground,
  formatPosterCaptionPreview,
  type PosterLog,
  type PosterMaterial,
} from '../shared/group-poster.js';
import {
  createScreenOps,
  filterClickableNodes,
  sha256NumericId,
  type BluestacksDeviceManager,
  type ScreenOps,
} from './bluestacks-device-manager.js';
import {
  findJoinGroupButtonNode,
  findTextInputNode,
  getRegionSignature,
  isLikeButtonBlue,
  isSolidBlueButton,
  makeCanonicalRect,
  signatureSimilarity,
  type LiteXmlNode,
  type OcrRecognizer,
} from './bluestacks-vision.js';
export interface BluestacksPosterLogSink {
  recordPost(input: PosterLog): Promise<boolean> | boolean;
}
export interface BluestacksPosterOutcome {
  posted: number;
  skipped: number;
  notes: string[];
}
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
        );
      if (hit) {
        await ops.tap(hit.node.bounds.cx, hit.node.bounds.cy, 2200);
        if (findTextInputNode(await ops.xml())) return true;
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
    await ops.tap(420, 240, 2200);
    return findTextInputNode(await ops.xml()) !== null;
  }
  private async fillAndSubmitComposer(
    ops: ScreenOps,
    material: PosterMaterial,
    signal: AbortSignal,
    onStatus: (text: string) => void,
  ): Promise<{ submitted: boolean; pendingApproval?: boolean; note?: string }> {
    const pushedRemote: string[] = [];
    let submittedSuccessfully = false;
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
              n.bounds.y1 >= 560 &&
              n.bounds.y2 <= 1020,
            (a, b) => a.bounds.x1 - b.bounds.x1,
          ),
          pickedSwatch =
            swatches[1 + Math.floor(Math.random() * Math.max(1, Math.min(4, swatches.length - 1)))];
        if (pickedSwatch) await ops.tap(pickedSwatch.bounds.cx, pickedSwatch.bounds.cy, 700);
      }
      if (material.caption.trim()) {
        onStatus('正在填入发帖文案…');
        const beforePasteSig = await getRegionSignature(compPng, inputNode.bounds).catch(
          () => null,
        );
        let captionVerified = false;
        for (let pasteAttempt = 0; pasteAttempt < 2; pasteAttempt++) {
          await ops.paste(inputNode.bounds.cx, inputNode.bounds.cy, material.caption.trim());
          await ops.wait(900);
          const afterPastePng = await ops.png();
          if (!beforePasteSig) {
            captionVerified = true;
            break;
          }
          const afterPasteSig = await getRegionSignature(afterPastePng, inputNode.bounds).catch(
            () => null,
          );
          if (!afterPasteSig || signatureSimilarity(beforePasteSig, afterPasteSig) < 0.992) {
            captionVerified = true;
            break;
          }
        }
        if (!captionVerified && !hasLocalMedia)
          return await abortComposer('未能确认发帖文案已粘贴进输入框，已取消防发空帖');
      }
      if (pushedRemote.length > 0) {
        onStatus('正在从相册附加图片/视频…');
        const readBottomRows = async () => {
          ({ xml: compXml, png: compPng } = await ops.capture());
          return filterClickableNodes(
            compXml,
            (n) => n.bounds.w >= 620 && n.bounds.y1 >= 620 && n.bounds.h >= 44 && n.bounds.h <= 115,
          );
        };
        let bottomRows = await readBottomRows();
        if (bottomRows.length === 0) {
          await ops.back(700);
          bottomRows = await readBottomRows();
        }
        const mediaRow = await ops.findOcr(
          compPng,
          bottomRows,
          /照片|视频|相片|影片|photo|video|ဓာတ်ပုံ|ဗီဒီယို|ảnh/i,
        );
        let mediaAttached = false;
        if (mediaRow) {
          await ops.tap(mediaRow.node.bounds.cx, mediaRow.node.bounds.cy, 2500);
          mediaAttached = await ops.attachMedia(true);
        }
        if (!mediaAttached)
          return await abortComposer('未能从模拟器相册附加图片/视频，已取消发布防发空帖');
      }
      ({ xml: compXml, png: compPng } = await ops.capture());
      if (findTextInputNode(compXml) === null)
        return await abortComposer('未回到发帖编辑框，已取消发布');
      const postBtns = filterClickableNodes(
        compXml,
        (n) =>
          (n.bounds.x2 >= 800 &&
            n.bounds.x1 >= 440 &&
            n.bounds.y1 <= 155 &&
            n.bounds.h >= 34 &&
            n.bounds.h <= 115) ||
          (n.bounds.w >= 450 &&
            n.bounds.y1 >= 980 &&
            n.bounds.y2 <= 1580 &&
            n.bounds.h >= 42 &&
            n.bounds.h <= 130),
        (a, b) => b.bounds.y1 - a.bounds.y1,
      );
      let submitBtn: LiteXmlNode | null = null;
      for (const pb of postBtns) {
        const pt = await ops.ocr(compPng, pb.bounds);
        if (
          /发布|發佈|post|တင်|đăng|โพสต์/i.test(pt) ||
          (pb.bounds.y1 <= 155 &&
            pb.bounds.x2 >= 800 &&
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
      const verifyDeadline =
        Date.now() +
        (hasLocalMedia && material.mediaKind === 'video'
          ? 30_000
          : hasLocalMedia
            ? 15_000
            : 10_000);
      for (;;) {
        ops.guard();
        const { xml: afterXml, png: afterPng } = await ops.capture(),
          postAbnormal = await ops.abnormal(afterXml, afterPng);
        if (postAbnormal) throw new Error(`账号异常 (${postAbnormal})，已中止发帖`);
        const afterText = await ops.ocr(afterPng, makeCanonicalRect(0, 120, 900, 1480));
        if (
          /无法发布|無法發佈|发帖受限|發帖受限|暂时受限|無法執行|无法执行此操作|重试|couldn'tpost|youcan'tpost|somethingwentwrong|tryagain/i.test(
            afterText,
          )
        )
          return await abortComposer('该小组发帖受限或发布失败');
        const pendingNotice =
          /待审核|待審核|等待管理员审核|等待管理員審核|submittedforapproval|pendingapproval|postispending|စိစစ်|ခွင့်ပြု|ဆိုင်းငံ့|chờphêduyệt|đangchờduyệt|รออนุมัติ/i.test(
            afterText,
          );
        if (findTextInputNode(afterXml) === null || pendingNotice) {
          submittedSuccessfully = true;
          return {
            submitted: true,
            pendingApproval: pendingNotice,
            note: pendingNotice ? '已提交（等待小组管理员审核）' : undefined,
          };
        }
        if (Date.now() >= verifyDeadline) break;
        await ops.wait(2200);
      }
      return await abortComposer('发帖框未关闭，未能确认发布成功');
    } finally {
      if (pushedRemote.length > 0 && !submittedSuccessfully)
        await this.devices.cleanupPushedMedia(ops.serial, pushedRemote);
    }
  }
  async run(
    instanceId: string,
    materials: readonly PosterMaterial[],
    groups: readonly BumperTarget[],
    options: {
      maxGroupsPerInstance: number;
      materialsPerGroup?: number | undefined;
      postToTimeline: boolean;
      claimNextGroupJob?: () =>
        | Promise<{ group: BumperTarget; material: PosterMaterial } | null>
        | { group: BumperTarget; material: PosterMaterial }
        | null;
      releaseGroupJob?: (groupId: string, materialId: string, posted: boolean) => void;
      hasGroupPostedMaterial?: (groupId: string, materialId: string) => Promise<boolean> | boolean;
    },
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      posted(): void;
      onPostLog?(log: PosterLog, isTimeline: boolean): Promise<void> | void;
      onTargetFailed?(info: {
        groupId: string;
        groupName: string;
        isTimeline: boolean;
        material: PosterMaterial;
        reason: string;
      }): Promise<void> | void;
    },
  ): Promise<BluestacksPosterOutcome> {
    const outcome: BluestacksPosterOutcome = { posted: 0, skipped: 0, notes: [] };
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
      if (!opened) return failTarget('未能打开小组发帖入口');
      const res = await this.fillAndSubmitComposer(ops, material, signal, callbacks.status);
      if (!res.submitted) return failTarget(res.note ?? '发布未确认');
      outcome.posted++;
      if (res.note) outcome.notes.push(`${label}: ${res.note}`);
      const groupId = isTimeline ? '__page_timeline__' : target.group.id,
        posterLog: PosterLog = {
          id: randomUUID(),
          profileId: inst.id,
          accountId: inst.numericAccountId || inst.accountId || inst.id,
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
          postId: res.pendingApproval
            ? 'pending_approval'
            : sha256NumericId(`bs-post:${inst.id}:${groupId}:${material.id}:${Date.now()}`),
          postUrl: '',
          postedAt: Date.now(),
        };
      if (this.logSink)
        await Promise.resolve(this.logSink.recordPost(posterLog)).catch(() => false);
      callbacks.posted();
      if (callbacks.onPostLog) await callbacks.onPostLog(posterLog, isTimeline);
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
      if (!job) continue;
      await executeOneTarget(job.target, job.material);
      if (idx + 1 < jobs.length) await gapWait();
    }
    return outcome;
  }
}
