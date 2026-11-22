import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BluestacksInstance } from '../shared/bluestacks.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import {
  canPosterMaterialUseColorBackground,
  type PosterLog,
  type PosterMaterial,
} from '../shared/group-poster.js';
import { abortableWait, type BluestacksDeviceManager } from './bluestacks-device-manager.js';
import {
  detectHomeTabBar,
  findJoinGroupButtonNode,
  findTextInputNode,
  flattenLiteNodes,
  isLikeButtonBlue,
  isSolidBlueButton,
  makeCanonicalRect,
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
    inst: BluestacksInstance,
    group: BumperTarget,
    signal: AbortSignal,
    onStatus: (text: string) => void,
  ): Promise<boolean> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const groupUrl = `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`;
    onStatus(`正在进入小组 · ${group.name}`);
    await this.devices.openDeepLink(serial, groupUrl, sw, sh, signal);
    await abortableWait(2600, signal);

    let [xml, png] = await Promise.all([
      this.devices.dumpXml(serial, sw, sh, signal),
      this.devices.screencap(serial, signal),
    ]);
    const abnormal = await this.devices.detectAbnormalScreen(serial, xml, png, signal);
    if (abnormal) {
      throw new Error(
        abnormal === 'logged-out'
          ? 'FB Lite 账号已退出登录'
          : abnormal === 'verification'
            ? 'FB Lite 账号触发安全验证 (Checkpoint)'
            : 'FB Lite 账号已被封禁或停用',
      );
    }

    // Auto-join public group if blue "加入小组" button is visible
    const joinBtn = findJoinGroupButtonNode(xml);
    if (joinBtn && (await isLikeButtonBlue(png, joinBtn.bounds))) {
      onStatus(`正在自动加入小组 · ${group.name}`);
      await this.devices.tap900(serial, joinBtn.bounds.cx, joinBtn.bounds.cy, sw, sh, signal);
      await abortableWait(2600, signal);
      [xml, png] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);
      // If membership questionnaire appeared, exit gracefully (cannot post before approval)
      if (findTextInputNode(xml)) {
        await this.devices.keyevent(serial, 4, signal).catch(() => null);
        return false;
      }
    }

    // Locate the "分享新鲜事..." / "写点什么..." composer bar in the group header/top feed
    for (let attempt = 0; attempt < 2; attempt++) {
      const composerBars = flattenLiteNodes(xml)
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.w >= 360 &&
            n.bounds.h >= 46 &&
            n.bounds.h <= 115 &&
            n.bounds.y1 >= 340 &&
            n.bounds.y2 <= 1280,
        )
        .sort((a, b) => a.bounds.y1 - b.bounds.y1);
      for (const bar of composerBars) {
        const txt = (await this.ocr.recognizeBounds(png, bar.bounds)).replace(/\s+/g, '');
        if (/写点什么|分享新鲜事|发帖|说点什么|writesomething|createapublicpost/i.test(txt)) {
          await this.devices.tap900(serial, bar.bounds.cx, bar.bounds.cy, sw, sh, signal);
          await abortableWait(2200, signal);
          const compXml = await this.devices.dumpXml(serial, sw, sh, signal);
          if (findTextInputNode(compXml)) return true;
        }
      }
      await this.devices.swipe900(serial, 450, 960, 450, 560, 420, sw, sh, signal);
      await abortableWait(1200, signal);
      [xml, png] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);
    }
    return false;
  }

  private async openOwnTimelineComposer(
    inst: BluestacksInstance,
    signal: AbortSignal,
    onStatus: (text: string) => void,
  ): Promise<boolean> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    onStatus('正在打开个人/专页时间线发帖框…');
    await this.devices.openDeepLink(serial, 'https://www.facebook.com/', sw, sh, signal);
    await abortableWait(2200, signal);
    const [xml, png] = await Promise.all([
      this.devices.dumpXml(serial, sw, sh, signal),
      this.devices.screencap(serial, signal),
    ]);
    const abnormal = await this.devices.detectAbnormalScreen(serial, xml, png, signal);
    if (abnormal) {
      throw new Error(`账号异常 (${abnormal})，已停止本机发帖`);
    }
    const tabBar = detectHomeTabBar(xml);
    if (tabBar?.tabs[0]) {
      await this.devices.tap900(serial, tabBar.tabs[0].cx, tabBar.tabs[0].cy, sw, sh, signal);
      await abortableWait(1500, signal);
    }
    await this.devices.tap900(serial, 420, 240, sw, sh, signal);
    await abortableWait(2200, signal);
    const compXml = await this.devices.dumpXml(serial, sw, sh, signal);
    return findTextInputNode(compXml) !== null;
  }

  private async dismissComposerCleanly(
    serial: string,
    sw: number,
    sh: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.devices.keyevent(serial, 4, signal).catch(() => null);
    await abortableWait(700, signal).catch(() => null);
    const [dlgPng, dlgXml] = await Promise.all([
      this.devices.screencap(serial, signal).catch(() => null),
      this.devices.dumpXml(serial, sw, sh, signal).catch(() => null),
    ]);
    if (!dlgPng || !dlgXml) return;
    const btns = flattenLiteNodes(dlgXml).filter(
      (n) =>
        n.clickable &&
        n.bounds.w >= 120 &&
        n.bounds.y1 >= 400 &&
        n.bounds.h >= 36 &&
        n.bounds.h <= 120,
    );
    for (const b of btns) {
      const txt = (await this.ocr.recognizeBounds(dlgPng, b.bounds)).replace(/\s+/g, '');
      if (/放弃|舍弃|不保存|discard/i.test(txt)) {
        await this.devices
          .tap900(serial, b.bounds.cx, b.bounds.cy, sw, sh, signal)
          .catch(() => null);
        await abortableWait(500, signal).catch(() => null);
        return;
      }
    }
  }

  private async fillAndSubmitComposer(
    inst: BluestacksInstance,
    material: PosterMaterial,
    signal: AbortSignal,
    onStatus: (text: string) => void,
  ): Promise<{ submitted: boolean; note?: string }> {
    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const pushedRemote: string[] = [];
    let submittedSuccessfully = false;

    try {
      const candidateMediaPath =
        material.localFilePath?.trim() ||
        (material.mediaSource && !/^https?:\/\//i.test(material.mediaSource.trim())
          ? material.mediaSource.trim()
          : '');
      const hasLocalMedia = Boolean(candidateMediaPath && existsSync(candidateMediaPath));
      if (hasLocalMedia && candidateMediaPath) {
        onStatus('正在将发帖素材推送至模拟器相册…');
        pushedRemote.push(
          await this.devices.pushMediaToGallery(serial, candidateMediaPath, signal),
        );
      }

      let [compPng, compXml] = await Promise.all([
        this.devices.screencap(serial, signal),
        this.devices.dumpXml(serial, sw, sh, signal),
      ]);
      const inputNode = findTextInputNode(compXml);
      if (!inputNode) {
        return { submitted: false, note: '未检测到发帖输入框' };
      }

      // Colored background swatch for short plain-text materials (verified in Wave 5!)
      const useColorBg =
        !hasLocalMedia &&
        canPosterMaterialUseColorBackground({
          caption: material.caption,
          mediaSource: material.mediaSource,
          background: material.background,
        });
      if (useColorBg) {
        const swatches = flattenLiteNodes(compXml)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.w >= 40 &&
              n.bounds.w <= 95 &&
              n.bounds.h >= 40 &&
              n.bounds.h <= 95 &&
              n.bounds.y1 >= 560 &&
              n.bounds.y2 <= 1020,
          )
          .sort((a, b) => a.bounds.x1 - b.bounds.x1);
        const pickedSwatch =
          swatches[1 + Math.floor(Math.random() * Math.max(1, Math.min(4, swatches.length - 1)))];
        if (pickedSwatch) {
          await this.devices.tap900(
            serial,
            pickedSwatch.bounds.cx,
            pickedSwatch.bounds.cy,
            sw,
            sh,
            signal,
          );
          await abortableWait(700, signal);
        }
      }

      if (material.caption.trim()) {
        onStatus('正在填入发帖文案…');
        await this.devices.pasteIntoFocused(
          serial,
          inputNode.bounds.cx,
          inputNode.bounds.cy,
          material.caption.trim(),
          sw,
          sh,
          signal,
        );
        await abortableWait(900, signal);
      }

      if (pushedRemote.length > 0) {
        onStatus('正在从相册附加图片/视频…');
        const readBottomRows = async () => {
          [compPng, compXml] = await Promise.all([
            this.devices.screencap(serial, signal),
            this.devices.dumpXml(serial, sw, sh, signal),
          ]);
          return flattenLiteNodes(compXml)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 620 &&
                n.bounds.y1 >= 620 &&
                n.bounds.h >= 44 &&
                n.bounds.h <= 115,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1);
        };
        let bottomRows = await readBottomRows();
        if (bottomRows.length === 0) {
          // Soft keyboard after pasting caption often covers bottom photo/video row; dismiss keyboard once
          await this.devices.keyevent(serial, 4, signal);
          await abortableWait(700, signal);
          bottomRows = await readBottomRows();
        }
        let mediaAttached = false;
        for (const r of bottomRows) {
          const rt = (await this.ocr.recognizeBounds(compPng, r.bounds)).replace(/\s+/g, '');
          if (/照片|视频|photo|video/i.test(rt)) {
            await this.devices.tap900(serial, r.bounds.cx, r.bounds.cy, sw, sh, signal);
            await abortableWait(2500, signal);
            // Select #1 newest pushed tile in gallery grid
            await this.devices.tap900(serial, 150, 340, sw, sh, signal);
            await abortableWait(1800, signal);
            const [galPng, galXml] = await Promise.all([
              this.devices.screencap(serial, signal),
              this.devices.dumpXml(serial, sw, sh, signal),
            ]);
            const nextBtns = flattenLiteNodes(galXml).filter(
              (n) => n.clickable && n.bounds.x1 >= 650 && n.bounds.y1 <= 160 && n.bounds.h >= 34,
            );
            for (const nb of nextBtns) {
              const nt = (await this.ocr.recognizeBounds(galPng, nb.bounds)).replace(/\s+/g, '');
              if (/下一步|完成|确定|next|done/i.test(nt)) {
                await this.devices.tap900(serial, nb.bounds.cx, nb.bounds.cy, sw, sh, signal);
                await abortableWait(2400, signal);
                mediaAttached = true;
                break;
              }
            }
            if (!mediaAttached) {
              const [postTapXml] = await Promise.all([
                this.devices.dumpXml(serial, sw, sh, signal),
              ]);
              if (findTextInputNode(postTapXml) !== null) {
                mediaAttached = true;
              }
            }
            break;
          }
        }
        if (!mediaAttached) {
          await this.dismissComposerCleanly(serial, sw, sh, signal);
          return { submitted: false, note: '未能从模拟器相册附加图片/视频，已取消发布防发空帖' };
        }
      }

      [compPng, compXml] = await Promise.all([
        this.devices.screencap(serial, signal),
        this.devices.dumpXml(serial, sw, sh, signal),
      ]);
      if (findTextInputNode(compXml) === null) {
        await this.dismissComposerCleanly(serial, sw, sh, signal);
        return { submitted: false, note: '未回到发帖编辑框，已取消发布' };
      }
      const postBtns = flattenLiteNodes(compXml)
        .filter(
          (n) =>
            n.clickable &&
            ((n.bounds.x2 >= 800 &&
              n.bounds.x1 >= 440 &&
              n.bounds.y1 <= 155 &&
              n.bounds.h >= 34 &&
              n.bounds.h <= 115) ||
              (n.bounds.w >= 450 &&
                n.bounds.y1 >= 980 &&
                n.bounds.y2 <= 1580 &&
                n.bounds.h >= 42 &&
                n.bounds.h <= 130)),
        )
        .sort((a, b) => b.bounds.y1 - a.bounds.y1);

      let submitBtn: LiteXmlNode | null = null;
      for (const pb of postBtns) {
        const pt = (await this.ocr.recognizeBounds(compPng, pb.bounds)).replace(/\s+/g, '');
        if (/发布|發佈|post/i.test(pt) || (await isSolidBlueButton(compPng, pb.bounds))) {
          submitBtn = pb;
          break;
        }
      }
      if (!submitBtn) {
        await this.dismissComposerCleanly(serial, sw, sh, signal);
        return { submitted: false, note: '未找到有效的发布按钮' };
      }

      onStatus('正在提交发布并验证结果…');
      // On 720x1280 v524, the top-right "Post" bar spans x=[525..885] with text right-aligned near x=835
      const submitTapX =
        submitBtn.bounds.y1 <= 155 && submitBtn.bounds.w > 180
          ? Math.min(868, Math.max(submitBtn.bounds.cx, submitBtn.bounds.x2 - 52))
          : submitBtn.bounds.cx;
      await this.devices.tap900(serial, submitTapX, submitBtn.bounds.cy, sw, sh, signal);
      await abortableWait(hasLocalMedia ? 6500 : 4200, signal);

      const [afterPng, afterXml] = await Promise.all([
        this.devices.screencap(serial, signal),
        this.devices.dumpXml(serial, sw, sh, signal),
      ]);
      const postAbnormal = await this.devices.detectAbnormalScreen(
        serial,
        afterXml,
        afterPng,
        signal,
      );
      if (postAbnormal) {
        throw new Error(`账号异常 (${postAbnormal})，已中止发帖`);
      }
      const afterText = (
        await this.ocr.recognizeBounds(afterPng, makeCanonicalRect(0, 120, 900, 1480))
      ).replace(/\s+/g, '');
      if (
        /无法发布|发帖受限|暂时受限|无法执行此操作|重试|couldn'tpost|youcan'tpost|somethingwentwrong|tryagain/i.test(
          afterText,
        )
      ) {
        await this.dismissComposerCleanly(serial, sw, sh, signal);
        return { submitted: false, note: '该小组发帖受限或发布失败' };
      }

      const leftComposer = findTextInputNode(afterXml) === null;
      const pendingNotice = /待审核|等待管理员审核|submittedforapproval|pending/i.test(afterText);
      if (leftComposer || pendingNotice) {
        submittedSuccessfully = true;
        return {
          submitted: true,
          note: pendingNotice ? '已提交（等待小组管理员审核）' : undefined,
        };
      }

      await this.dismissComposerCleanly(serial, sw, sh, signal);
      return { submitted: false, note: '发帖框未关闭，未能确认发布成功' };
    } finally {
      // Only remove immediately if submission did NOT succeed. For successful posts (especially videos),
      // FB Lite uploads asynchronously in the background after composer closes; deleting at +6.5s would
      // abort the background upload! Old wb_* files (>30m) are reaped automatically on next push.
      if (pushedRemote.length > 0 && !submittedSuccessfully) {
        await this.devices.cleanupPushedMedia(serial, pushedRemote);
      }
    }
  }

  async run(
    instanceId: string,
    materials: readonly PosterMaterial[],
    groups: readonly BumperTarget[],
    options: { maxGroupsPerInstance: number; postToTimeline: boolean },
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      posted(): void;
      onPostLog?(log: PosterLog, isTimeline: boolean): Promise<void> | void;
    },
  ): Promise<BluestacksPosterOutcome> {
    const outcome: BluestacksPosterOutcome = { posted: 0, skipped: 0, notes: [] };
    if (materials.length === 0) return outcome;

    callbacks.status('正在校验蓝蝶连接与 FB Lite 账号…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);
    const identityType: 'page' | 'personal' = inst.identityType === 'page' ? 'page' : 'personal';

    const targets: Array<{ kind: 'timeline' } | { kind: 'group'; group: BumperTarget }> = [];
    if (options.postToTimeline) {
      targets.push({ kind: 'timeline' });
    }
    for (const g of groups.slice(0, Math.max(0, options.maxGroupsPerInstance))) {
      targets.push({ kind: 'group', group: g });
    }

    for (let idx = 0; idx < targets.length; idx++) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      const target = targets[idx];
      const material = materials[idx % materials.length];
      if (!target || !material) continue;

      const label = target.kind === 'timeline' ? '个人/专页时间线' : target.group.name;
      const opened =
        target.kind === 'timeline'
          ? await this.openOwnTimelineComposer(inst, signal, callbacks.status)
          : await this.openGroupAndEnterComposer(inst, target.group, signal, callbacks.status);

      if (!opened) {
        outcome.skipped++;
        outcome.notes.push(`${label}: 未能打开小组发帖入口`);
        continue;
      }

      const res = await this.fillAndSubmitComposer(inst, material, signal, callbacks.status);
      if (!res.submitted) {
        outcome.skipped++;
        outcome.notes.push(`${label}: ${res.note ?? '发布未确认'}`);
        continue;
      }

      outcome.posted++;
      callbacks.posted();
      if (res.note) outcome.notes.push(`${label}: ${res.note}`);

      const groupId = target.kind === 'timeline' ? '__page_timeline__' : target.group.id;
      const syntheticPostId = BigInt(
        '0x' +
          createHash('sha256')
            .update(`bs-post:${inst.id}:${groupId}:${material.id}:${Date.now()}`)
            .digest('hex')
            .slice(0, 14),
      ).toString(10);
      // FB Lite does not expose a direct post permalink on submit; leave postUrl empty instead of
      // fabricating a group/page homepage URL that could trigger wrong-post bumping!
      const postUrl = '';
      const posterLog: PosterLog = {
        id: randomUUID(),
        profileId: inst.id,
        accountId: inst.numericAccountId || inst.accountId || inst.id,
        accountName: inst.accountName || inst.displayName,
        accountAvatar: inst.avatarUrl,
        identityType,
        groupId,
        groupName: label,
        groupAvatar: target.kind === 'group' ? target.group.avatarUrl : null,
        materialId: material.id,
        captionPreview: material.caption.trim().slice(0, 120) || '[媒体贴文]',
        postId: syntheticPostId,
        postUrl,
        postedAt: Date.now(),
      };

      if (this.logSink) {
        await Promise.resolve(this.logSink.recordPost(posterLog)).catch(() => false);
      }
      if (callbacks.onPostLog) {
        await callbacks.onPostLog(posterLog, target.kind === 'timeline');
      }

      if (idx + 1 < targets.length) {
        await abortableWait(2500 + Math.floor(Math.random() * 2000), signal);
      }
    }

    return outcome;
  }
}
