import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import type { BluestacksInstance } from '../shared/bluestacks.js';
import {
  classifyAbnormalScreenText,
  detectHomeTabBar,
  findAllTextInputNodes,
  flattenLiteNodes,
  isSolidBlueButton,
  makeCanonicalRect,
  type LiteXmlNode,
  type OcrRecognizer,
} from './bluestacks-vision.js';
import { generateTotpCode } from './bluestacks-win32.js';
import * as idInspect from './bluestacks-device/device-identity-and-inspect.js';
import * as lifecycle from './bluestacks-device/device-instance-lifecycle.js';
import {
  type BluestacksDeviceRepo,
  type DeviceRuntimeContext,
  adb,
  createDeviceRuntimeContext,
  hasFbLiteInstalled,
  lockPortraitOrientation,
  probeFbLiteInstalled,
  readLiveScreenSize,
  resolveRuntimeConfig,
} from './bluestacks-device/device-runtime-and-adb.js';
import * as uiMedia from './bluestacks-device/device-ui-and-media.js';
import { abortableWait, findOcrNode } from './bluestacks-device/runner-helpers.js';
export type { BluestacksDeviceRepo };
export * from './bluestacks-device/runner-helpers.js';
async function loginAccountDetailed(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  credentials: {
    account: string;
    password: string;
    totpSecret?: string;
    saveLoginInfo?: boolean;
    ifAlreadyLoggedIn?: 'skip' | 'clear-and-relogin';
  },
  signal?: AbortSignal,
  onProgress?: (status: string) => void,
): Promise<{ instance: BluestacksInstance; skippedAlreadyLoggedIn: boolean }> {
  const { inst, liveSize } = await idInspect.resolveOnlinePortraitInstance(
    ctx,
    instanceId,
    true,
    false,
    signal,
  );
  if ((await probeFbLiteInstalled(ctx, inst.serial, true, signal)) !== true)
    throw new ProductError('BLUESTACKS_MISSING_APP', '未安装 FB Lite，请先一键安装 APK', 400);
  const { serial } = inst,
    { width: sw, height: sh } = liveSize,
    existingPolicy = credentials.ifAlreadyLoggedIn ?? 'skip',
    snapAndDump = () =>
      Promise.all([
        uiMedia.screencap(ctx, serial, signal),
        uiMedia.dumpXml(ctx, serial, sw, sh, signal),
      ]),
    tapWait = async (x: number, y: number, waitMs: number) => {
      await uiMedia.tap900(ctx, serial, x, y, sw, sh, signal);
      await abortableWait(waitMs, signal);
    },
    finishLogin = async () => {
      onProgress?.('登录成功，正在读取账号身份与头像…');
      await abortableWait(1200, signal);
      return {
        instance: await idInspect.inspectAccount(ctx, instanceId, signal),
        skippedAlreadyLoggedIn: false,
      };
    },
    saveState = (state: 'logged-out' | 'verification' | 'restricted') =>
      idInspect.saveInstanceAccountState(ctx, inst.id, liveSize, state),
    tapFirstBlue = async (pngBuf: Buffer, nodes: LiteXmlNode[], waitMs: number) => {
      for (const n of nodes)
        if (await isSolidBlueButton(pngBuf, n.bounds)) {
          await tapWait(n.bounds.cx, n.bounds.cy, waitMs);
          return true;
        }
      return false;
    },
    throwAbnormal = (kind: 'verification' | 'restricted', suffix = ''): never => {
      throw new ProductError(
        kind === 'restricted' ? 'BLUESTACKS_ACCOUNT_RESTRICTED' : 'BLUESTACKS_ACCOUNT_CHECKPOINT',
        (kind === 'restricted'
          ? '账号已被 Facebook 停用或封禁'
          : '账号触发 Facebook 安全验证 (Checkpoint)') + suffix,
        409,
      );
    },
    launchFbLiteFresh = async (clearData: boolean) => {
      await adb(
        ctx,
        serial,
        ['shell', 'am', 'force-stop', 'com.facebook.lite'],
        6000,
        signal,
      ).catch(() => null);
      if (clearData) {
        onProgress?.('正在清除旧 FB Lite 会话准备换号登录…');
        await adb(ctx, serial, ['shell', 'pm', 'clear', 'com.facebook.lite'], 8000, signal).catch(
          () => null,
        );
        await uiMedia.grantFbLiteMediaPerms(ctx, serial, signal);
      }
      await abortableWait(500, signal);
      await uiMedia.launchFbLitePackage(ctx, serial, signal);
      await abortableWait(4500, signal);
    };
  onProgress?.('正在启动 FB Lite 进入登录界面…');
  await launchFbLiteFresh(false);
  let credSubmitted = false,
    clearedExisting = false,
    totpAttempts = 0,
    saveInfoAttempts = 0,
    postLoginIdleSteps = 0;
  for (let step = 0; step < 26; step++) {
    if (signal?.aborted) throw new Error('TASK_STOPPED');
    const [png, tree] = await snapAndDump();
    if (detectHomeTabBar(tree)) {
      if (!credSubmitted) {
        if (existingPolicy === 'clear-and-relogin' && !clearedExisting) {
          clearedExisting = true;
          await launchFbLiteFresh(true);
          continue;
        }
        const preAbnormal = classifyAbnormalScreenText(
          await ctx.ocr.recognizeBounds(png, makeCanonicalRect(0, 0, 900, 1600)),
        );
        if (preAbnormal === 'verification' || preAbnormal === 'restricted') {
          await saveState(preAbnormal);
          throwAbnormal(preAbnormal, '（如需换号请选择“覆盖重登”）');
        }
        onProgress?.('检测到该实例已登录账号，按策略跳过并同步身份…');
        const existingInst = await idInspect.inspectAccount(ctx, instanceId, signal);
        if (existingInst.accountState === 'logged-in')
          return { instance: existingInst, skippedAlreadyLoggedIn: true };
        if (
          existingInst.accountState === 'verification' ||
          existingInst.accountState === 'restricted'
        )
          throwAbnormal(existingInst.accountState, '（如需换号请选择“覆盖重登”）');
      } else return finishLogin();
    }
    const inputs = findAllTextInputNodes(tree);
    if (inputs.length >= 2 && !credSubmitted) {
      onProgress?.('正在输入账号与密码…');
      const [emailInput, passInput] = inputs;
      if (emailInput && passInput) {
        for (const [node, val] of [
          [emailInput, credentials.account],
          [passInput, credentials.password],
        ] as const)
          await uiMedia.pasteIntoFocused(
            ctx,
            serial,
            node.bounds.cx,
            node.bounds.cy,
            val,
            sw,
            sh,
            signal,
          );
        credSubmitted = true;
        const [filledPng, filledTree] = await snapAndDump(),
          btnCands = flattenLiteNodes(filledTree)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 420 &&
                n.bounds.y1 > passInput.bounds.y2 &&
                n.bounds.h >= 38 &&
                n.bounds.h <= 125,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1);
        onProgress?.('正在提交登录请求…');
        if (!(await tapFirstBlue(filledPng, btnCands, 7000)))
          await tapWait(450, passInput.bounds.y2 + 68, 7000);
        continue;
      }
    }
    const rawFullText = await ctx.ocr.recognizeBounds(png, makeCanonicalRect(0, 0, 900, 1600)),
      compact = rawFullText.replace(/\s+/g, '');
    if (
      credSubmitted &&
      inputs.length === 0 &&
      /what'?sonyourmind|分享新鲜事|createstory|创建快拍/i.test(compact)
    )
      return finishLogin();
    if (!credSubmitted && inputs.length < 2) {
      const preBtns = flattenLiteNodes(tree)
          .filter((n) => n.clickable && n.bounds.w >= 90 && n.bounds.h >= 28 && n.bounds.h <= 150)
          .sort((a, b) => b.bounds.y1 - a.bounds.y1),
        preFlows: Array<[RegExp, RegExp, string, number]> = [
          [
            /登录其他账|使用其他账|logintoanotheraccount|useanotheraccount/i,
            /登录其他账|使用其他账|logintoanotheraccount|useanotheraccount/i,
            '正在切换至账密登录表单…',
            2600,
          ],
          [
            /允许facebooklite|allowfacebooklite|拨打和管理电话|访问您的通讯录/i,
            /^拒绝$|^不允许$|^deny$|^don'tallow$|^允许$|^allow$/i,
            '正在处理系统权限弹窗…',
            2200,
          ],
          [
            /选择语言|chooseyourlanguage|试用中文|接受所有cookie|acceptallcookies/i,
            /中文\(简体\)|中文（简体）|继续|continue|接受|accept/i,
            '正在确认启动引导页…',
            2600,
          ],
        ];
      let handledPre = false;
      for (const [screenRe, btnRe, msg, waitMs] of preFlows) {
        if (!screenRe.test(compact)) continue;
        const m = await findOcrNode(ctx.ocr, png, preBtns, btnRe);
        if (m) {
          onProgress?.(msg);
          await tapWait(m.node.bounds.cx, m.node.bounds.cy, waitMs);
          handledPre = true;
        }
        break;
      }
      if (handledPre) continue;
    }
    if (
      /密码有误|密码不正确|incorrectpassword|wrongpassword|找不到你的账户|couldn'tfindyouraccount|invalidusernameorpassword/i.test(
        compact,
      )
    ) {
      await saveState('logged-out');
      throw new ProductError('BLUESTACKS_LOGIN_WRONG_CREDENTIALS', '账号或密码有误，登录失败', 400);
    }
    const abnormal = classifyAbnormalScreenText(rawFullText);
    if (abnormal === 'verification' || abnormal === 'restricted') {
      if (!credSubmitted && existingPolicy === 'clear-and-relogin' && !clearedExisting) {
        clearedExisting = true;
        await launchFbLiteFresh(true);
        continue;
      }
      await saveState(abnormal);
      throwAbnormal(abnormal, abnormal === 'verification' ? '，需人工核验' : '');
    }
    if (
      inputs.length === 0 &&
      /试试其他方式|尝试其他方式|tryanotherway|使用其他方式|选择身份验证方式|选择验证方式|查看通知|检查通知|待批准|身份验证应用|身份验证器|authenticationapp/i.test(
        compact,
      )
    ) {
      const btns = flattenLiteNodes(tree)
          .filter(
            (n) =>
              n.clickable &&
              n.bounds.w >= 220 &&
              n.bounds.y1 >= 200 &&
              n.bounds.h >= 40 &&
              n.bounds.h <= 260,
          )
          .sort((a, b) => a.bounds.y1 - b.bounds.y1),
        authApp = await findOcrNode(
          ctx.ocr,
          png,
          btns,
          /身份验证器|身份验证应用|authenticationapp|验证码生成器|验证码应用/i,
        );
      if (authApp) {
        onProgress?.('正在选择身份验证器 (2FA)…');
        await tapWait(authApp.node.bounds.cx, authApp.node.bounds.cy, 1600);
        const [selPng, selTree] = await snapAndDump();
        await tapFirstBlue(
          selPng,
          flattenLiteNodes(selTree).filter(
            (n) => n.clickable && n.bounds.w >= 360 && n.bounds.h >= 42 && n.bounds.h <= 125,
          ),
          5000,
        );
        continue;
      }
      const otherWay = await findOcrNode(
        ctx.ocr,
        png,
        btns,
        /试试其他方式|尝试其他方式|tryanotherway|使用其他方式/i,
      );
      if (otherWay) {
        onProgress?.('正在切换为验证器验证码方式…');
        await tapWait(otherWay.node.bounds.cx, otherWay.node.bounds.cy, 4200);
        continue;
      }
    }
    if (
      inputs.length === 1 &&
      /验证|code|authenticator|双重|two-factor|安全码|6位数|验证码|身份验证/i.test(compact)
    ) {
      if (!credentials.totpSecret?.trim())
        throw new ProductError(
          'BLUESTACKS_2FA_SECRET_REQUIRED',
          '该账号已开启双重验证 (2FA)，请提供 2FA Base32 密钥',
          400,
        );
      if (totpAttempts >= 2)
        throw new ProductError(
          'BLUESTACKS_2FA_FAILED',
          '2FA 动态验证码校验未通过，请确认 2FA 密钥正确且系统时间准确',
          400,
        );
      const codeInput = inputs[0];
      if (codeInput) {
        const secRem = 30 - (Math.floor(Date.now() / 1000) % 30);
        if (secRem <= 5) await abortableWait((secRem + 1) * 1000, signal);
        totpAttempts++;
        onProgress?.(`正在填入 2FA 动态验证码 (第 ${totpAttempts} 次)…`);
        await uiMedia.typeAsciiAt900(
          ctx,
          serial,
          codeInput.bounds.cx,
          codeInput.bounds.cy,
          generateTotpCode(credentials.totpSecret),
          sw,
          sh,
          signal,
        );
        const [afterPng, afterTree] = await snapAndDump(),
          blueCands = flattenLiteNodes(afterTree)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 360 &&
                n.bounds.h >= 42 &&
                n.bounds.h <= 125 &&
                n.bounds.y1 > codeInput.bounds.y2,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1);
        if (!(await tapFirstBlue(afterPng, blueCands, 6500))) {
          await uiMedia.keyevent(ctx, serial, 66, signal);
          await abortableWait(6500, signal);
        }
        continue;
      }
    }
    if (credSubmitted) {
      if (/设置语言|试用中文|try中文/i.test(compact)) {
        const blueBtns = flattenLiteNodes(tree).filter(
          (n) => n.clickable && n.bounds.w >= 360 && n.bounds.y1 >= 1100 && n.bounds.h >= 42,
        );
        onProgress?.('正在确认语言设置…');
        if (await tapFirstBlue(png, blueBtns, 4000)) continue;
      }
      if (/保存登录信息|savelogininfo|saveyourlogininfo/i.test(compact)) {
        saveInfoAttempts++;
        onProgress?.('正在处理「保存登录信息」提示…');
        if (saveInfoAttempts >= 3) {
          await uiMedia.keyevent(ctx, serial, 4, signal).catch(() => null);
          await abortableWait(1200, signal);
          await uiMedia
            .openDeepLink(ctx, serial, 'https://www.facebook.com/', sw, sh, signal)
            .catch(() => null);
          await abortableWait(2500, signal);
          continue;
        }
        const saveCands = flattenLiteNodes(tree)
            .filter(
              (n) =>
                n.clickable &&
                n.bounds.w >= 120 &&
                n.bounds.y1 >= 800 &&
                n.bounds.h >= 34 &&
                n.bounds.h <= 140,
            )
            .sort((a, b) => a.bounds.y1 - b.bounds.y1),
          wantSave = credentials.saveLoginInfo !== false,
          saveMatch = await findOcrNode(
            ctx.ocr,
            png,
            saveCands,
            wantSave ? /^保存$|^save$|^确定$|^ok$/i : /^以后再说$|^notnow$|^跳过$|^skip$|^暂不$/i,
          );
        if (saveMatch) {
          await tapWait(saveMatch.node.bounds.cx, saveMatch.node.bounds.cy, 3500);
        } else {
          let blueBandY: number | null = null;
          for (let y = 960; y <= 1480; y += 28)
            if (await isSolidBlueButton(png, makeCanonicalRect(80, y, 820, y + 48))) {
              blueBandY = y + 24;
              break;
            }
          await tapWait(
            blueBandY !== null ? 450 : wantSave ? 670 : 230,
            blueBandY !== null ? (wantSave ? blueBandY : Math.min(1560, blueBandY + 100)) : 1565,
            3500,
          );
        }
        continue;
      }
      if (/添加好友.*可能认识|addfriends.*peopleyoumayknow/i.test(compact)) {
        onProgress?.('正在跳过「添加好友」引导…');
        await tapWait(450, 1585, 2500);
        const [fPng, fTree] = await snapAndDump();
        if (detectHomeTabBar(fTree)) continue;
        const skipBtns = flattenLiteNodes(fTree).filter(
            (n) => n.clickable && n.bounds.y1 >= 1350 && n.bounds.h >= 20 && n.bounds.h <= 120,
          ),
          sb = await findOcrNode(ctx.ocr, fPng, skipBtns, /跳过|skip|下一步|next/i);
        if (sb) await tapWait(sb.node.bounds.cx, sb.node.bounds.cy, 3000);
        continue;
      }
      const allBtns = flattenLiteNodes(tree).filter(
          (n) => n.clickable && n.bounds.w >= 55 && n.bounds.h >= 22 && n.bounds.h <= 150,
        ),
        scored: Array<{ prio: number; y: number; node: LiteXmlNode; label: string }> = [];
      for (const b of allBtns) {
        const t = (await ctx.ocr.recognizeBounds(png, b.bounds)).replace(/\s+/g, '');
        if (/^跳过$|^skip$|^以后再说$|^notnow$|^不用了$|^拒绝$|^不允许$|^don'tallow$/i.test(t))
          scored.push({ prio: 1, y: b.bounds.y1, node: b, label: t });
        else if (/^保存$|^save$|^确定$|^ok$|^允许$|^allow$|^完成$|^done$/i.test(t))
          scored.push({ prio: 2, y: b.bounds.y1, node: b, label: t });
      }
      scored.sort((a, b) => a.prio - b.prio || b.y - a.y);
      if (scored[0]) {
        postLoginIdleSteps = 0;
        onProgress?.(`正在跳过引导提示 (${scored[0].label})…`);
        await tapWait(scored[0].node.bounds.cx, scored[0].node.bounds.cy, 3500);
        continue;
      }
      postLoginIdleSteps++;
      if (postLoginIdleSteps === 3 || postLoginIdleSteps === 6) {
        onProgress?.('正在跳转进入 FB Lite 首页…');
        await uiMedia
          .openDeepLink(ctx, serial, 'https://www.facebook.com/', sw, sh, signal)
          .catch(() => null);
        await abortableWait(2500, signal);
        continue;
      }
    }
    await abortableWait(3000, signal);
  }
  throw new ProductError(
    'BLUESTACKS_LOGIN_TIMEOUT',
    '自动登录流程超时，未能进入 FB Lite 首页（请点击“显示窗口”查看模拟器当前界面）',
    504,
  );
}
async function ensureReadyAndLoggedIn(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  signal?: AbortSignal,
): Promise<BluestacksInstance> {
  const { inst, liveSize } = await idInspect.resolveOnlinePortraitInstance(
      ctx,
      instanceId,
      false,
      true,
      signal,
    ),
    fbProbe = await probeFbLiteInstalled(ctx, inst.serial, true, signal);
  if (fbProbe === false) {
    await idInspect.saveInstanceAccountState(ctx, inst.id, liveSize, 'missing-app', false);
    throw new Error('跳过：未安装 FB Lite');
  }
  if (fbProbe === null) throw new Error('跳过：模拟器 ADB 暂未就绪');
  const assertState = (state: string) => {
    if (state === 'restricted') throw new Error('跳过：账号已受限/停用');
    if (state === 'verification') throw new Error('跳过：账号需安全验证 (Checkpoint)');
  };
  assertState(inst.accountState);
  if (
    inst.accountState !== 'logged-in' ||
    !inst.accountName ||
    inst.accountName === inst.displayName
  ) {
    const inspected = await idInspect.inspectAccount(ctx, inst.id, signal);
    assertState(inspected.accountState);
    if (inspected.accountState !== 'logged-in') throw new Error('跳过：FB Lite 未登录账号');
    return inspected;
  }
  return { ...inst, fbWidth: liveSize.width, fbHeight: liveSize.height };
}
export class BluestacksDeviceManager {
  private readonly ctx: DeviceRuntimeContext;
  constructor(repo: CompatibleRepository<BluestacksDeviceRepo>, ocr: OcrRecognizer) {
    this.ctx = createDeviceRuntimeContext(repo, ocr);
  }
  private bind =
    <A extends unknown[], R>(fn: (ctx: DeviceRuntimeContext, ...args: A) => R) =>
    (...args: A): R =>
      fn(this.ctx, ...args);
  getOnlineKeys = (): ReadonlySet<string> => this.ctx.onlineInstanceKeys;
  resolveRuntimeConfig = () => resolveRuntimeConfig(this.ctx);
  adb = this.bind(adb);
  probeFbLiteInstalled = this.bind(probeFbLiteInstalled);
  hasFbLiteInstalled = this.bind(hasFbLiteInstalled);
  readLiveScreenSize = this.bind(readLiveScreenSize);
  lockPortraitOrientation = this.bind(lockPortraitOrientation);
  discoverInstances = () => lifecycle.discoverInstances(this.ctx);
  launchInstance = this.bind(lifecycle.launchInstance);
  closeInstance = this.bind(lifecycle.closeInstance);
  showInstance = this.bind(lifecycle.showInstance);
  arrangeWindows = this.bind(lifecycle.arrangeWindows);
  installFbLiteApk = this.bind(lifecycle.installFbLiteApk);
  screencap = this.bind(uiMedia.screencap);
  dumpXml = this.bind(uiMedia.dumpXml);
  tap900 = this.bind(uiMedia.tap900);
  swipe900 = this.bind(uiMedia.swipe900);
  keyevent = this.bind(uiMedia.keyevent);
  setMediaSoundEnabled = this.bind(uiMedia.setMediaSoundEnabled);
  setInstanceSoundEnabled = this.bind(uiMedia.setInstanceSoundEnabled);
  openDeepLink = this.bind(uiMedia.openDeepLink);
  typeAsciiAt900 = this.bind(uiMedia.typeAsciiAt900);
  pasteIntoFocused = this.bind(uiMedia.pasteIntoFocused);
  pruneOldPushedMedia = this.bind(uiMedia.pruneOldPushedMedia);
  pushMediaToGallery = this.bind(uiMedia.pushMediaToGallery);
  cleanupPushedMedia = this.bind(uiMedia.cleanupPushedMedia);
  copyLinkFromMoreMenu = this.bind(uiMedia.copyLinkFromMoreMenu);
  isLoginOrLoggedOutXml = (root: LiteXmlNode | null) => uiMedia.isLoginOrLoggedOutXml(root);
  detectAbnormalScreen = this.bind(uiMedia.detectAbnormalScreen);
  inspectAccount = this.bind(idInspect.inspectAccount);
  switchIdentity = this.bind(idInspect.switchIdentity);
  loginAccountDetailed = this.bind(loginAccountDetailed);
  ensureReadyAndLoggedIn = this.bind(ensureReadyAndLoggedIn);
}
