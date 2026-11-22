import { createHash } from 'node:crypto';
import type { BumperTarget } from '../shared/group-bumper.js';
import { abortableWait, type BluestacksDeviceManager } from './bluestacks-device-manager.js';
import {
  flattenLiteNodes,
  isSolidBlueButton,
  makeCanonicalRect,
  type OcrRecognizer,
} from './bluestacks-vision.js';

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
    callbacks: {
      status(text: string): void;
      invited(delta: number): void;
    },
  ): Promise<BluestacksInviterOutcome> {
    const outcome: BluestacksInviterOutcome = { invited: 0, skippedGroups: 0, notes: [] };
    if (groups.length === 0) return outcome;

    callbacks.status('正在校验蓝蝶账号身份…');
    const inst = await this.devices.ensureReadyAndLoggedIn(instanceId, signal);
    if (inst.identityType === 'page') {
      throw new Error('跳过：当前为专页身份，请先切换为个人账号再执行小组邀请人');
    }

    const { serial, fbWidth: sw, fbHeight: sh } = inst;
    const effectiveAccountId = inst.numericAccountId || inst.accountId || inst.id;
    const perGroupCap = Math.max(1, Math.min(50, Math.round(invitesPerGroup)));

    for (const group of groups) {
      if (signal.aborted) throw new Error('TASK_STOPPED');
      callbacks.status(`正在进入小组 · ${group.name}`);
      await this.devices.openDeepLink(
        serial,
        `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`,
        sw,
        sh,
        signal,
      );
      await abortableWait(2600, signal);

      const [groupXml, groupPng] = await Promise.all([
        this.devices.dumpXml(serial, sw, sh, signal),
        this.devices.screencap(serial, signal),
      ]);
      const abnormal = await this.devices.detectAbnormalScreen(serial, groupXml, groupPng, signal);
      if (abnormal) {
        throw new Error(
          abnormal === 'logged-out'
            ? 'FB Lite 账号已退出登录'
            : abnormal === 'verification'
              ? 'FB Lite 账号触发安全验证 (Checkpoint)'
              : 'FB Lite 账号已被封禁或停用',
        );
      }

      // Locate the blue "邀请" / "Invite" CTA button in group hero bar (empirically verified in Wave 5: [333,681][888,741])
      const headerBtns = flattenLiteNodes(groupXml)
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.y1 >= 440 &&
            n.bounds.y2 <= 960 &&
            n.bounds.w >= 140 &&
            n.bounds.h >= 40 &&
            n.bounds.h <= 96,
        )
        .sort((a, b) => a.bounds.y1 - b.bounds.y1);

      let inviteCtaBounds = null;
      for (const btn of headerBtns) {
        if (!(await isSolidBlueButton(groupPng, btn.bounds))) continue;
        const label = (await this.ocr.recognizeBounds(groupPng, btn.bounds)).replace(/\s+/g, '');
        if (/^邀请$|^邀請$|^invite$/i.test(label)) {
          inviteCtaBounds = btn.bounds;
          break;
        }
      }

      if (!inviteCtaBounds) {
        outcome.skippedGroups++;
        outcome.notes.push(`${group.name}: 未找到蓝底「邀请」按钮（可能未加入该群或该群关闭邀请）`);
        continue;
      }

      callbacks.status(`正在打开邀请成员列表 · ${group.name}`);
      await this.devices.tap900(serial, inviteCtaBounds.cx, inviteCtaBounds.cy, sw, sh, signal);
      await abortableWait(2400, signal);

      let groupInvited = 0;
      let emptyScrolls = 0;
      const seenNames = new Set<string>();

      for (
        let scroll = 0;
        scroll < 12 && groupInvited < perGroupCap && emptyScrolls < 3;
        scroll++
      ) {
        if (signal.aborted) throw new Error('TASK_STOPPED');
        const [listXml, listPng] = await Promise.all([
          this.devices.dumpXml(serial, sw, sh, signal),
          this.devices.screencap(serial, signal),
        ]);

        // Per-friend blue "邀请" buttons sit on the right half of each member row (x1 >= 560, w = 110..280, h = 38..86)
        const rightBtns = flattenLiteNodes(listXml)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.x1 >= 560 &&
              n.bounds.x2 <= 896 &&
              n.bounds.w >= 100 &&
              n.bounds.w <= 300 &&
              n.bounds.h >= 36 &&
              n.bounds.h <= 92 &&
              n.bounds.y1 >= 200 &&
              n.bounds.y2 <= 1480,
          )
          .sort((a, b) => a.bounds.y1 - b.bounds.y1);

        let invitedThisScroll = 0;
        let currentPng = listPng;
        for (const btn of rightBtns) {
          if (groupInvited >= perGroupCap) break;
          if (signal.aborted) throw new Error('TASK_STOPPED');
          if (!(await isSolidBlueButton(currentPng, btn.bounds))) continue;

          const btnLabel = (await this.ocr.recognizeBounds(currentPng, btn.bounds)).replace(
            /\s+/g,
            '',
          );
          if (!/^邀请$|^邀請$|^invite$/i.test(btnLabel)) continue;

          // Read friend name on the left side of the same row
          const nameRect = makeCanonicalRect(
            110,
            Math.max(0, btn.bounds.y1 - 12),
            Math.max(180, btn.bounds.x1 - 12),
            Math.min(1600, btn.bounds.y2 + 12),
          );
          const friendName =
            (await this.ocr.recognizeBounds(currentPng, nameRect))
              .replace(/[|_~`]/g, '')
              .replace(/\s+/g, ' ')
              .trim() || `FB好友#${groupInvited + 1}`;
          if (seenNames.has(friendName.toLowerCase())) continue;

          callbacks.status(
            `正在邀请 ${friendName} 加入 ${group.name} (${groupInvited + 1}/${perGroupCap})`,
          );
          await this.devices.tap900(serial, btn.bounds.cx, btn.bounds.cy, sw, sh, signal);
          await abortableWait(1200, signal);

          // Real visual confirmation: button MUST transition out of solid-blue ("邀请" -> gray "已邀请")!
          const afterPng = await this.devices.screencap(serial, signal);
          if (!(await isSolidBlueButton(afterPng, btn.bounds))) {
            seenNames.add(friendName.toLowerCase());
            groupInvited++;
            invitedThisScroll++;
            outcome.invited++;
            callbacks.invited(1);
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
          }
        }

        if (groupInvited >= perGroupCap) break;
        if (invitedThisScroll === 0) emptyScrolls++;
        else emptyScrolls = 0;

        await this.devices.swipe900(serial, 450, 1320, 450, 460, 520, sw, sh, signal);
        await abortableWait(1400, signal);
      }

      // Exit invite list back to group
      await this.devices.keyevent(serial, 4, signal).catch(() => null);
      await abortableWait(900, signal);
    }

    return outcome;
  }
}
