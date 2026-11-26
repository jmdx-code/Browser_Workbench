import { createHash } from 'node:crypto';
import type { BumperTarget } from '../shared/group-bumper.js';
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
}
export interface BluestacksInviterOutcome {
  invited: number;
  skippedGroups: number;
  notes: string[];
}
export class BluestacksGroupInviterRunner {
  constructor(
    public readonly devices: BluestacksDeviceManager,
    private readonly ocr: OcrRecognizer,
    private readonly logSink?: BluestacksInviteLogSink,
  ) {}
  async run(
    instanceId: string,
    groups: readonly BumperTarget[],
    invitesPerGroup: number,
    signal: AbortSignal,
    callbacks: { status(text: string): void; invited(delta: number): void },
  ): Promise<BluestacksInviterOutcome> {
    const outcome: BluestacksInviterOutcome = { invited: 0, skippedGroups: 0, notes: [] };
    if (groups.length === 0) return outcome;
    callbacks.status('正在校验蓝蝶账号身份…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);
    if (inst.identityType === 'page')
      throw new Error('跳过：当前为专页身份，请先切换为个人账号再执行小组邀请人');
    const ops = createScreenOps(this.devices, this.ocr, inst, signal),
      effectiveAccountId = inst.numericAccountId || inst.accountId || inst.id,
      perGroupCap = Math.max(1, Math.min(50, Math.round(invitesPerGroup))),
      invitePat = /^邀请$|^邀請$|^invite$/i;
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
        ),
        inviteCta = await ops.findOcr(groupPng, headerBtns, invitePat, true);
      if (!inviteCta) {
        outcome.skippedGroups++;
        outcome.notes.push(`${group.name}: 未找到蓝底「邀请」按钮（可能未加入该群或该群关闭邀请）`);
        continue;
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
              n.bounds.w >= 100 &&
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
          if (
            !(await isSolidBlueButton(currentPng, btn.bounds)) ||
            !invitePat.test(await ops.ocr(currentPng, btn.bounds))
          )
            continue;
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
          if (seenNames.has(friendName.toLowerCase())) continue;
          callbacks.status(
            `正在邀请 ${friendName} 加入 ${group.name} (${groupInvited + 1}/${perGroupCap})`,
          );
          await ops.tap(btn.bounds.cx, btn.bounds.cy, 1200);
          const afterPng = await ops.png();
          if (!(await isSolidBlueButton(afterPng, btn.bounds))) {
            seenNames.add(friendName.toLowerCase());
            groupInvited++;
            invitedThisScroll++;
            outcome.invited++;
            currentPng = afterPng;
            if (this.logSink) {
              const friendId =
                'bs_' +
                createHash('sha256')
                  .update(`${effectiveAccountId}:${friendName.toLowerCase()}`)
                  .digest('hex')
                  .slice(0, 16);
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
  }
}
