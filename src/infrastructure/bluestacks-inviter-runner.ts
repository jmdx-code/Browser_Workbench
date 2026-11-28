import { createHash } from 'node:crypto';
import { resolveEffectiveBsAccountId } from '../shared/bluestacks.js';
import type { BluestacksInviterRunnerPort } from '../application/bluestacks/bs-types.js';
import {
  createScreenOps,
  filterClickableNodes,
  type BluestacksDeviceManager,
} from './bluestacks-device-manager.js';
import { isSolidBlueButton, makeCanonicalRect, type OcrRecognizer } from './bluestacks-vision.js';
export interface BluestacksInviteLogSink {
  recordInvites(
    entries: ReadonlyArray<{
      profileId: string;
      accountId: string;
      friendId: string;
      friendName: string;
      groupId: string;
      invitedAt?: number;
    }>,
  ): Promise<number> | number;
  getInvitedFriendIdsForGroup?(
    groupId: string,
  ):
    | Promise<ReadonlySet<string> | ReadonlyArray<string>>
    | ReadonlySet<string>
    | ReadonlyArray<string>;
}
const INVITE_BTN_RE =
  /^[^a-zA-Z0-9\u4e00-\u9fa5]{0,3}(?:邀请|邀請|[il1]nvite|ဖိတ်(?:ခေါ်|ကြား|မည်)?|mời|เชิญ)$/i;
const INVITE_HEADER_RE =
  /(?:邀请|邀請|[il1]nvite|ဖိတ်(?:ခေါ်|ကြား|မည်)?|mời|เชิญ)(?:成员|好友|friends|members|bạnbè|สมาชิก|သူငယ်ချင်း.*)?/i;
const ALREADY_INVITED_RE = /已邀请|已邀請|[il1]nvited|ဖိတ်ပြီး|đãmời|เชิญแล้ว/i;
const NON_INVITE_CTA_RE = /已加入|joined|加入|join|访问|訪問|visit|取消|cancel/i;
export class BluestacksGroupInviterRunner {
  constructor(
    public readonly devices: BluestacksDeviceManager,
    private readonly ocr: OcrRecognizer,
    private readonly logSink?: BluestacksInviteLogSink,
  ) {}
  run: BluestacksInviterRunnerPort['run'] = async (
    instanceId,
    groups,
    invitesPerGroup,
    signal,
    callbacks,
    options,
  ) => {
    const outcome = { invited: 0, skippedGroups: 0, notes: [] as string[] };
    if (groups.length === 0) return outcome;
    callbacks.status('正在校验蓝蝶账号身份…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);
    if (inst.identityType === 'page')
      throw new Error('跳过：当前为专页身份，请先切换为个人账号再执行小组邀请人');
    const ops = createScreenOps(this.devices, this.ocr, inst, signal),
      effectiveAccountId = resolveEffectiveBsAccountId(inst) || inst.id,
      perGroupCap = Math.max(1, Math.min(50, Math.round(invitesPerGroup)));
    for (const group of groups) {
      ops.guard();
      callbacks.status(`正在进入小组 · ${group.name}`);
      const { xml: groupXml, png: groupPng } = await ops.openInspect(
        `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`,
        2600,
      );
      const headerBtns = filterClickableNodes(
        groupXml,
        (n) =>
          n.bounds.y1 >= 440 &&
          n.bounds.y2 <= 960 &&
          n.bounds.w >= 140 &&
          n.bounds.h >= 40 &&
          n.bounds.h <= 96,
      );
      let inviteCta: { node: (typeof headerBtns)[number]; text: string } | null = null;
      for (const hb of headerBtns) {
        if (!(await isSolidBlueButton(groupPng, hb.bounds))) continue;
        const txt = await ops.ocr(groupPng, hb.bounds);
        if (
          !ALREADY_INVITED_RE.test(txt) &&
          !NON_INVITE_CTA_RE.test(txt) &&
          INVITE_HEADER_RE.test(txt)
        ) {
          inviteCta = { node: hb, text: txt };
          break;
        }
      }
      if (!inviteCta) {
        outcome.skippedGroups++;
        outcome.notes.push(`${group.name}: 未找到蓝底「邀请」按钮（可能未加入该群或该群关闭邀请）`);
        continue;
      }
      const existingInvitedIds = new Set<string>();
      for (const loader of [
        this.logSink?.getInvitedFriendIdsForGroup,
        options?.getInvitedFriendIds,
      ]) {
        if (!loader) continue;
        const loaded = await Promise.resolve(loader(group.id)).catch(() => []);
        for (const fid of loaded) existingInvitedIds.add(fid);
      }
      callbacks.status(`正在打开邀请成员列表 · ${group.name}`);
      await ops.tap(inviteCta.node.bounds.cx, inviteCta.node.bounds.cy, 2400);
      let groupInvited = 0,
        emptyScrolls = 0;
      const seenNames = new Set<string>();
      for (
        let scroll = 0;
        scroll < 12 && groupInvited < perGroupCap && emptyScrolls < 3;
        scroll++
      ) {
        ops.guard();
        const { xml: listXml, png: listPng } = await ops.capture(),
          rightBtns = filterClickableNodes(
            listXml,
            (n) =>
              n.bounds.x1 >= 560 &&
              n.bounds.x2 <= 896 &&
              n.bounds.w >= 48 &&
              n.bounds.w <= 300 &&
              n.bounds.h >= 36 &&
              n.bounds.h <= 92 &&
              n.bounds.y1 >= 200 &&
              n.bounds.y2 <= 1480,
          );
        let invitedThisScroll = 0,
          currentPng = listPng;
        for (const btn of rightBtns) {
          if (groupInvited >= perGroupCap) break;
          ops.guard();
          if (!(await isSolidBlueButton(currentPng, btn.bounds))) continue;
          const btnTxt = await ops.ocr(currentPng, btn.bounds);
          if (ALREADY_INVITED_RE.test(btnTxt) || !INVITE_BTN_RE.test(btnTxt)) continue;
          const nameRect = makeCanonicalRect(
              110,
              Math.max(0, btn.bounds.y1 - 12),
              Math.max(180, btn.bounds.x1 - 12),
              Math.min(1600, btn.bounds.y2 + 12),
            ),
            friendName =
              (await this.ocr.recognizeBounds(currentPng, nameRect))
                .replace(/[|_~`]/g, '')
                .replace(/\s+/g, ' ')
                .trim() || `FB好友#${groupInvited + 1}`;
          const friendId =
            'bs_' +
            createHash('sha256')
              .update(`${effectiveAccountId}:${friendName.toLowerCase()}`)
              .digest('hex')
              .slice(0, 16);
          if (seenNames.has(friendName.toLowerCase()) || existingInvitedIds.has(friendId)) continue;
          callbacks.status(
            `正在邀请 ${friendName} 加入 ${group.name} (${groupInvited + 1}/${perGroupCap})`,
          );
          await ops.tap(btn.bounds.cx, btn.bounds.cy, 1200);
          const afterPng = await ops.png();
          if (!(await isSolidBlueButton(afterPng, btn.bounds))) {
            seenNames.add(friendName.toLowerCase());
            existingInvitedIds.add(friendId);
            groupInvited++;
            invitedThisScroll++;
            outcome.invited++;
            currentPng = afterPng;
            if (this.logSink) {
              await Promise.resolve(
                this.logSink.recordInvites([
                  {
                    profileId: inst.id,
                    accountId: effectiveAccountId,
                    friendId,
                    friendName,
                    groupId: group.id,
                    invitedAt: Date.now(),
                  },
                ]),
              ).catch(() => 0);
            }
            callbacks.invited(1);
          }
        }
        if (groupInvited >= perGroupCap) break;
        emptyScrolls = invitedThisScroll === 0 ? emptyScrolls + 1 : 0;
        await ops.swipe(450, 1320, 450, 460, 520, 1400);
      }
      await ops.back(900);
    }
    return outcome;
  };
}
