import { ProductError, failError } from '../../domain/workspace.js';
import {
  isBluestacksPortraitResolution,
  isCompositePlaceholderBsAccountId,
  type BluestacksIdentityType,
  type BluestacksInstance,
  type BluestacksManagedIdentity,
} from '../../shared/bluestacks.js';
import {
  cropToDataUrl,
  detectBottomSheetIdentityRows,
  detectHomeTabBar,
  flattenLiteNodes,
  isBottomSheetOpen,
  makeCanonicalRect,
  readPngDimensions,
  resolveProfileShareUrl,
  type LiteXmlNode,
  type RectBounds,
} from '../bluestacks-vision.js';
import { discoverInstances } from './device-instance-lifecycle.js';
import {
  type DeviceRuntimeContext,
  lockPortraitOrientation,
  probeFbLiteInstalled,
  readFbLiteVersion,
  readGuestSdkVersion,
  readLiveScreenSize,
} from './device-runtime-and-adb.js';
import {
  detectAbnormalScreen,
  dumpXml,
  focusBySerial,
  keyevent,
  openDeepLink,
  screencap,
  swipe900,
  tap900,
} from './device-ui-and-media.js';
import {
  abortableWait,
  findOcrNode,
  getHostClipboard,
  setHostClipboard,
  withPreservedClipboard,
} from './runner-helpers.js';
export async function resolveOnlinePortraitInstance(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  forceLiveSize: boolean,
  skipErrors: boolean,
  signal?: AbortSignal,
): Promise<{ inst: BluestacksInstance; liveSize: { width: number; height: number } }> {
  const { instances } = await discoverInstances(ctx);
  const inst = instances.find((p) => p.id === instanceId);
  if (!inst || !inst.online) {
    throw skipErrors
      ? new Error('跳过：蓝蝶实例未在线')
      : new ProductError('BLUESTACKS_OFFLINE', '模拟器未在线，请先启动蓝蝶窗口', 400);
  }
  await lockPortraitOrientation(ctx, inst.serial, signal);
  const liveSize = await readLiveScreenSize(
    ctx,
    inst.serial,
    inst.fbWidth,
    inst.fbHeight,
    forceLiveSize,
    signal,
  );
  if (!isBluestacksPortraitResolution(liveSize.width, liveSize.height)) {
    const msg = skipErrors
      ? `跳过：横屏分辨率 ${liveSize.width}×${liveSize.height}，请改为竖屏（如 900×1600 或 720×1280）`
      : `模拟器为横屏 (${liveSize.width}×${liveSize.height})，请在蓝蝶设置改为竖屏分辨率（如 900×1600 或 720×1280）`;
    throw skipErrors
      ? new Error(msg)
      : new ProductError('BLUESTACKS_LANDSCAPE_UNSUPPORTED', msg, 400);
  }
  return { inst, liveSize };
}
function findMenuProfileCard(root: LiteXmlNode | null): LiteXmlNode | undefined {
  return flattenLiteNodes(root).find(
    (n) =>
      n.clickable &&
      n.bounds.x1 <= 40 &&
      n.bounds.x2 >= 840 &&
      n.bounds.y1 >= 105 &&
      n.bounds.y1 <= 300 &&
      n.bounds.h >= 70 &&
      n.bounds.h <= 145,
  );
}
function hasMenuGridTiles(root: LiteXmlNode | null): boolean {
  return (
    flattenLiteNodes(root).filter(
      (n) =>
        n.clickable &&
        ((n.bounds.x1 <= 40 && n.bounds.x2 >= 420 && n.bounds.x2 <= 460) ||
          (n.bounds.x1 >= 440 && n.bounds.x1 <= 475 && n.bounds.x2 >= 855)) &&
        n.bounds.y1 >= 220 &&
        n.bounds.y2 <= 1320,
    ).length >= 2
  );
}
async function openLiteMenuProfileCard(
  ctx: DeviceRuntimeContext,
  serial: string,
  sw: number,
  sh: number,
  initialXml: LiteXmlNode | null,
  requireGridTiles: boolean,
  signal?: AbortSignal,
  onLateAbnormalCheck?: (menuXml: LiteXmlNode | null) => Promise<void>,
): Promise<{ menuXml: LiteXmlNode | null; cardNode: LiteXmlNode | undefined }> {
  const ready = (root: LiteXmlNode | null) =>
    Boolean(findMenuProfileCard(root)) && (!requireGridTiles || hasMenuGridTiles(root));
  let menuXml = initialXml;
  let cardNode = ready(menuXml) ? findMenuProfileCard(menuXml) : undefined;
  let lastTab = detectHomeTabBar(menuXml)?.tabs.at(-1) ?? null;
  for (let attempt = 0; attempt < 3 && !ready(menuXml); attempt++) {
    if (attempt === 0) await tap900(ctx, serial, 859, 72, sw, sh, signal);
    else {
      if (!detectHomeTabBar(menuXml)) {
        await keyevent(ctx, serial, 4, signal).catch(() => null);
        await abortableWait(900, signal);
        lastTab =
          detectHomeTabBar(await dumpXml(ctx, serial, sw, sh, signal))?.tabs.at(-1) ?? lastTab;
      }
      await tap900(ctx, serial, lastTab?.cx ?? 825, lastTab?.cy ?? 162, sw, sh, signal);
    }
    await abortableWait(requireGridTiles ? 2200 : 2000, signal);
    menuXml = await dumpXml(ctx, serial, sw, sh, signal);
    cardNode = findMenuProfileCard(menuXml);
    if (!ready(menuXml) && onLateAbnormalCheck) await onLateAbnormalCheck(menuXml);
  }
  return { menuXml, cardNode: ready(menuXml) ? cardNode : undefined };
}
export function isValidNumericFbId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{5,}$/.test(value.trim());
}
export function isPlaceholderAccountString(
  value: string | null | undefined,
  displayName?: string,
  serial?: string,
): boolean {
  const t = value?.trim() ?? '';
  if (!t) return true;
  const lo = t.toLowerCase(),
    dn = displayName?.trim();
  return Boolean(
    (dn && (lo === dn.toLowerCase() || (t.startsWith(`${dn} (`) && t.endsWith(')')))) ||
    (serial && lo === serial.trim().toLowerCase()) ||
    /\((?:fb\s*lite)\)$/i.test(t) ||
    /^(?:fb\s*lite|facebook|meta|menu|菜单|菜單|未知|unknown)$/i.test(t) ||
    /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(t) ||
    /^\d{1,4}$/.test(t),
  );
}
export function classifyManagedIdentityRows(
  rows: ReadonlyArray<{ name: string; active: boolean; bounds: RectBounds; rawText?: string }>,
  activeType: BluestacksIdentityType,
  knownIdentities?: ReadonlyArray<BluestacksManagedIdentity>,
): Array<{ name: string; identityType: 'personal' | 'page'; active: boolean; bounds: RectBounds }> {
  const fallbackType: 'personal' | 'page' = activeType === 'page' ? 'page' : 'personal';
  const knownByName = new Map<string, 'personal' | 'page'>();
  for (const k of knownIdentities ?? []) {
    if (k.identityType === 'personal' || k.identityType === 'page') {
      knownByName.set(k.name.trim().toLowerCase(), k.identityType);
    }
  }
  const resolved: Array<{
    name: string;
    identityType: 'personal' | 'page' | null;
    active: boolean;
    bounds: RectBounds;
  }> = rows.map((row) => {
    const raw = row.rawText ?? '';
    let identityType: 'personal' | 'page' | null = null;
    if (/个人主页|个人资料|個人主頁|personal\s*profile|main\s*profile/i.test(raw)) {
      identityType = 'personal';
    } else if (
      /公共主页|专页|專頁|粉丝专页|粉絲專頁|digital\s*creator|public\s*figure/i.test(raw)
    ) {
      identityType = 'page';
    } else identityType = knownByName.get(row.name.trim().toLowerCase()) ?? null;
    if (!identityType && row.active) identityType = fallbackType;
    return { name: row.name, identityType, active: row.active, bounds: row.bounds };
  });
  let hasPersonal = resolved.some((r) => r.identityType === 'personal');
  for (const item of resolved) {
    if (item.identityType !== null) continue;
    if (fallbackType === 'page' && !hasPersonal && !item.active) {
      item.identityType = 'personal';
      hasPersonal = true;
    } else item.identityType = 'page';
  }
  return resolved.map((r) => ({
    name: r.name,
    identityType: r.identityType ?? 'page',
    active: r.active,
    bounds: r.bounds,
  }));
}
export async function inspectOrSelectManagedIdentities(
  ctx: DeviceRuntimeContext,
  serial: string,
  cardBounds: RectBounds,
  activeName: string,
  activeType: BluestacksIdentityType,
  sw: number,
  sh: number,
  selectTarget?: {
    targetName?: string;
    targetType?: 'personal' | 'page';
    knownIdentities?: ReadonlyArray<BluestacksManagedIdentity>;
  },
  signal?: AbortSignal,
): Promise<{ identities: BluestacksManagedIdentity[]; switchedTo: string | null }> {
  const identities: BluestacksManagedIdentity[] = [];
  const fallbackType: 'personal' | 'page' = activeType === 'page' ? 'page' : 'personal';
  if (activeName) identities.push({ name: activeName, identityType: fallbackType, active: true });
  await tap900(
    ctx,
    serial,
    Math.min(865, Math.max(810, cardBounds.x2 - 36)),
    cardBounds.cy,
    sw,
    sh,
    signal,
  );
  await abortableWait(1400, signal);
  const dropPng = await screencap(ctx, serial, signal);
  if (!(await isBottomSheetOpen(dropPng))) return { identities, switchedTo: null };
  const rawRows: Array<{ name: string; active: boolean; bounds: RectBounds; rawText: string }> = [];
  for (const row of await detectBottomSheetIdentityRows(dropPng)) {
    const rawFull = (await ctx.ocr.recognizeBounds(dropPng, row.fullTextBounds))
      .replace(/[|_~`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      !rawFull ||
      /前往\s*meta|账户设置|创建新|create\s*new|新建公共主页|退出|log\s*out|查看全部/i.test(rawFull)
    ) {
      continue;
    }
    const cleanedName = rawFull
      .replace(/[·•.,]?\s*\d+\s*(?:\+?\s*)?条\s*通\s*知.*$/i, '')
      .replace(/[·•.,]?\s*\d+\s*(?:\+?\s*)?notifications?.*$/i, '')
      .replace(/[·•.,]?\s*unread.*$/i, '')
      .replace(/\s*(?:个人主页|个人资料|個人主頁|公共主页|专页|專頁)$/i, '')
      .trim();
    if (!cleanedName || cleanedName.length < 2) continue;
    const normRaw = cleanedName.toLowerCase();
    const normActive = activeName.toLowerCase();
    const isActive =
      row.isActiveBlueCheck ||
      (Boolean(normActive) && (normRaw.includes(normActive) || normActive.includes(normRaw)));
    const displayName =
      isActive && activeName && normRaw.includes(normActive) ? activeName : cleanedName;
    if (!rawRows.some((p) => p.name.toLowerCase() === displayName.toLowerCase())) {
      rawRows.push({
        name: displayName,
        active: isActive,
        bounds: row.rowBounds,
        rawText: rawFull,
      });
    }
  }
  const parsedRows = classifyManagedIdentityRows(
    rawRows,
    activeType,
    selectTarget?.knownIdentities,
  );
  if (parsedRows.length > 0) {
    identities.splice(
      0,
      identities.length,
      ...parsedRows.map(({ name, identityType, active }) => ({ name, identityType, active })),
    );
  }
  if (selectTarget && (selectTarget.targetName || selectTarget.targetType)) {
    const wantName = selectTarget.targetName?.trim().toLowerCase() ?? '';
    const chosen = wantName
      ? parsedRows.find(
          (r) =>
            r.name.toLowerCase() === wantName ||
            r.name.toLowerCase().includes(wantName) ||
            wantName.includes(r.name.toLowerCase()),
        )
      : selectTarget.targetType
        ? (parsedRows.find((r) => !r.active && r.identityType === selectTarget.targetType) ??
          parsedRows.find((r) => r.identityType === selectTarget.targetType))
        : parsedRows.find((r) => !r.active);
    if (chosen) {
      if (chosen.active) {
        await keyevent(ctx, serial, 4, signal).catch(() => null);
        await abortableWait(700, signal);
      } else {
        await tap900(ctx, serial, chosen.bounds.cx, chosen.bounds.cy, sw, sh, signal);
        await abortableWait(4000, signal);
      }
      return { identities, switchedTo: chosen.name };
    }
  }
  await keyevent(ctx, serial, 4, signal).catch(() => null);
  await abortableWait(700, signal);
  return { identities, switchedTo: null };
}
export async function extractActiveProfileNumericId(
  ctx: DeviceRuntimeContext,
  serial: string,
  cardBounds: RectBounds,
  sw: number,
  sh: number,
  signal?: AbortSignal,
): Promise<{ numericId: string | null; identityHint: BluestacksIdentityType }> {
  let identityHint: BluestacksIdentityType = 'unknown';
  try {
    await tap900(ctx, serial, 300, cardBounds.cy, sw, sh, signal);
    await abortableWait(2400, signal);
    const [profPng, profXml] = await Promise.all([
      screencap(ctx, serial, signal),
      dumpXml(ctx, serial, sw, sh, signal),
    ]);
    const allProfNodes = flattenLiteNodes(profXml),
      MORE_OCR_RE = /^(?:\.{2,3}|···|•••|…|more|更多|选项|菜單|菜单)$/i,
      inBox = (
        n: LiteXmlNode,
        x1: number,
        x2: number,
        y1: number,
        y2: number,
        w1: number,
        w2: number,
        h1: number,
        h2: number,
      ) =>
        n.bounds.x1 >= x1 &&
        n.bounds.x2 <= x2 &&
        n.bounds.y1 >= y1 &&
        n.bounds.y2 <= y2 &&
        n.bounds.w >= w1 &&
        n.bounds.w <= w2 &&
        n.bounds.h >= h1 &&
        n.bounds.h <= h2;
    let moreBtn =
      allProfNodes.find(
        (n) =>
          n.clickable &&
          inBox(n, 680, 900, 25, 1260, 36, 180, 36, 130) &&
          (MORE_OCR_RE.test(`${n.text} ${n.contentDesc}`.replace(/\s+/g, '')) ||
            /more|overflow|menu/i.test(n.resourceId)),
      ) ??
      allProfNodes
        .filter((n) => n.clickable && inBox(n, 760, 900, 25, 165, 38, 130, 38, 125))
        .sort((a, b) => b.bounds.x1 - a.bounds.x1)[0] ??
      allProfNodes
        .filter((n) => n.clickable && inBox(n, 680, 900, 360, 1260, 40, 175, 36, 120))
        .sort((a, b) => a.bounds.y1 - b.bounds.y1 || b.bounds.x2 - a.bounds.x2)[0];
    if (!moreBtn)
      moreBtn = (
        await findOcrNode(
          ctx.ocr,
          profPng,
          allProfNodes
            .filter((n) => inBox(n, 640, 900, 25, 1300, 32, 220, 32, 140))
            .sort((a, b) => Number(b.clickable) - Number(a.clickable) || b.bounds.x1 - a.bounds.x1),
          MORE_OCR_RE,
        )
      )?.node;
    if (!moreBtn) {
      const profText = (
        await ctx.ocr.recognizeBounds(profPng, makeCanonicalRect(0, 420, 900, 960))
      ).replace(/\s+/g, '');
      if (
        /专业面板|专业模式面板|推广公共主页|公共主页状态|professionaldashboard|adcenter/i.test(
          profText,
        )
      )
        identityHint = 'page';
      await keyevent(ctx, serial, 4, signal).catch(() => null);
      await abortableWait(700, signal);
      return { numericId: null, identityHint };
    }
    await tap900(ctx, serial, moreBtn.bounds.cx, moreBtn.bounds.cy, sw, sh, signal);
    await abortableWait(1800, signal);
    const scanMoreScreen = async () => {
      const [morePng, moreXml] = await Promise.all([
        screencap(ctx, serial, signal),
        dumpXml(ctx, serial, sw, sh, signal),
      ]);
      const compact = (
        await ctx.ocr.recognizeBounds(morePng, makeCanonicalRect(0, 100, 900, 1580))
      ).replace(/\s+/g, '');
      if (identityHint === 'unknown') {
        if (/复制公共主页链接|公共主页链接|copypagelink|yourpagelink/i.test(compact))
          identityHint = 'page';
        else if (/复制个人主页链接|个人主页链接|copyprofilelink|yourprofilelink/i.test(compact))
          identityHint = 'personal';
      }
      const rows = flattenLiteNodes(moreXml)
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.w >= 260 &&
            n.bounds.y1 >= 160 &&
            n.bounds.y2 <= 1600 &&
            n.bounds.h >= 40 &&
            n.bounds.h <= 140,
        )
        .sort((a, b) => b.bounds.y1 - a.bounds.y1);
      const COPY_RE = /复制链接|复制个人主页链接|复制公共主页链接|copylink|copyprofile|copypage/i;
      return (
        rows.find((n) => COPY_RE.test(`${n.text} ${n.contentDesc}`.replace(/\s+/g, ''))) ??
        (await findOcrNode(ctx.ocr, morePng, rows, COPY_RE))?.node ??
        null
      );
    };
    let copyBtn = await scanMoreScreen();
    if (!copyBtn) {
      await swipe900(ctx, serial, 450, 1280, 450, 420, 450, sw, sh, signal);
      await abortableWait(1200, signal);
      copyBtn = await scanMoreScreen();
    }
    let resolvedNumericId: string | null = null;
    if (copyBtn) {
      const rawUrl = await withPreservedClipboard(
        () => focusBySerial(serial),
        async () => {
          const marker = `__WB_PROF_${Date.now()}__`;
          await setHostClipboard(marker).catch(() => null);
          await tap900(ctx, serial, copyBtn.bounds.cx, copyBtn.bounds.cy, sw, sh, signal);
          for (let poll = 0; poll < 3; poll++) {
            await abortableWait(480, signal);
            const clip = await getHostClipboard().catch(() => '');
            if (clip && clip !== marker && /^https?:\/\//i.test(clip)) return clip;
          }
          return null;
        },
      );
      if (rawUrl) resolvedNumericId = (await resolveProfileShareUrl(rawUrl)).numericId;
    }
    await keyevent(ctx, serial, 4, signal).catch(() => null);
    await abortableWait(650, signal);
    await keyevent(ctx, serial, 4, signal).catch(() => null);
    await abortableWait(650, signal);
    return { numericId: resolvedNumericId, identityHint };
  } catch {
    return { numericId: null, identityHint };
  }
}
export async function inspectAccount(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  signal?: AbortSignal,
  options?: { expectedNameHint?: string },
): Promise<BluestacksInstance> {
  const { inst, liveSize } = await resolveOnlinePortraitInstance(
    ctx,
    instanceId,
    true,
    false,
    signal,
  );
  const [fbProbe, androidSdk] = await Promise.all([
    probeFbLiteInstalled(ctx, inst.serial, true, signal),
    readGuestSdkVersion(ctx, inst.serial, signal),
  ]);
  if (fbProbe === false) {
    await saveInstanceAccountState(ctx, inst.id, liveSize, 'missing-app', false, androidSdk);
    throw new Error('未安装 FB Lite');
  }
  if (fbProbe === null) throw new Error('模拟器 ADB 暂未就绪，请稍后重试');
  const fbLiteVersion = await readFbLiteVersion(ctx, inst.serial, signal);
  const handleAbnormal = async (state: 'logged-out' | 'verification' | 'restricted') => {
    const saved = await saveInstanceAccountState(
      ctx,
      inst.id,
      liveSize,
      state,
      true,
      androidSdk,
      fbLiteVersion,
    );
    if (state === 'verification' || state === 'restricted') return saved;
    throw new Error('FB Lite 未登录账号');
  };
  await openDeepLink(
    ctx,
    inst.serial,
    'https://www.facebook.com/',
    liveSize.width,
    liveSize.height,
    signal,
  );
  await abortableWait(2000, signal);
  const readScreen = () =>
    Promise.all([
      dumpXml(ctx, inst.serial, liveSize.width, liveSize.height, signal),
      screencap(ctx, inst.serial, signal),
    ]);
  let [homeXml, homePng] = await readScreen();
  const dims = readPngDimensions(homePng);
  if (dims && dims.width > dims.height) {
    await lockPortraitOrientation(ctx, inst.serial, signal);
    await abortableWait(900, signal);
    [homeXml, homePng] = await readScreen();
  }
  if (!homeXml || homeXml.packageName !== 'com.facebook.lite') {
    await abortableWait(1500, signal);
    [homeXml, homePng] = await readScreen();
  }
  const abnormal = await detectAbnormalScreen(ctx, inst.serial, homeXml, homePng, signal);
  if (abnormal) return await handleAbnormal(abnormal);
  if (!homeXml || homeXml.packageName !== 'com.facebook.lite')
    throw new Error('FB Lite 页面加载未就绪，请稍后重试');
  let identityType: BluestacksIdentityType = detectHomeTabBar(homeXml)?.identityHint ?? 'unknown';
  let earlyReturn: BluestacksInstance | null = null;
  const { menuXml, cardNode } = await openLiteMenuProfileCard(
    ctx,
    inst.serial,
    liveSize.width,
    liveSize.height,
    homeXml,
    true,
    signal,
    async (curXml) => {
      const lateAbnormal = await detectAbnormalScreen(ctx, inst.serial, curXml, undefined, signal);
      if (lateAbnormal) earlyReturn = await handleAbnormal(lateAbnormal);
    },
  );
  if (earlyReturn) return earlyReturn;
  if (!cardNode) {
    await abortableWait(1200, signal);
    const menuAbnormal = await detectAbnormalScreen(ctx, inst.serial, menuXml, undefined, signal);
    if (menuAbnormal) return await handleAbnormal(menuAbnormal);
    throw new Error('未能打开 FB Lite 账号菜单，请重试');
  }
  const png = await screencap(ctx, inst.serial, signal);
  const avatarBounds: RectBounds = {
    x1: 34,
    y1: cardNode.bounds.y1 + 12,
    x2: 94,
    y2: cardNode.bounds.y1 + 72,
    w: 60,
    h: 60,
    cx: 64,
    cy: cardNode.bounds.y1 + 42,
  };
  const nameX1 = liveSize.width < 800 ? 118 : 102;
  const nameY1 = cardNode.bounds.y1 + 6;
  const [avatarUrl, rawName, menuTilesText] = await Promise.all([
    cropToDataUrl(png, avatarBounds, 96),
    ctx.ocr.recognizeBounds(png, makeCanonicalRect(nameX1, nameY1, 680, nameY1 + 48)),
    ctx.ocr.recognizeBounds(png, makeCanonicalRect(0, 240, 900, 760)),
  ]);
  const compactMenu = menuTilesText.replace(/\s+/g, '');
  if (identityType === 'unknown') {
    if (/专业面板|广告中心|metabusiness|professionaldashboard|adcenter/i.test(compactMenu))
      identityType = 'page';
    else if (/好友|marketplace|friends/i.test(compactMenu)) identityType = 'personal';
  }
  const sanitizeCardName = (text: string): string =>
    text
      .replace(/[|_~`]/g, '')
      .replace(
        /(?:查\s*)?看\s*你\s*的\s*主\s*页|查\s*看\s*公\s*共\s*主\s*页|查\s*看\s*主\s*页|管\s*理\s*主\s*页|view\s*your\s*profile|view\s*page|manage\s*page/gi,
        '',
      )
      .replace(/^[:：·•.,\-_\s]+|[:：·•.,\-_\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  let cleanName = sanitizeCardName(rawName);
  if (!cleanName)
    cleanName = sanitizeCardName(
      await ctx.ocr.recognizeBounds(
        png,
        makeCanonicalRect(nameX1, cardNode.bounds.y1, 740, cardNode.bounds.y2),
      ),
    );
  if (
    cleanName &&
    /登录|登入|log\s*in|sign\s*in|密码|password|手机号|邮箱|创建新账号|create\s*new/i.test(
      cleanName,
    )
  )
    return await handleAbnormal('logged-out');
  const expectedHint = options?.expectedNameHint?.trim() || '';
  const { identities: managedIdentities } = await inspectOrSelectManagedIdentities(
    ctx,
    inst.serial,
    cardNode.bounds,
    !isPlaceholderAccountString(cleanName, inst.displayName, inst.serial)
      ? cleanName
      : expectedHint,
    identityType,
    liveSize.width,
    liveSize.height,
    inst.managedIdentities?.length ? { knownIdentities: inst.managedIdentities } : undefined,
    signal,
  ).catch(() => ({ identities: [], switchedTo: null }));
  const effectiveName =
    [cleanName, expectedHint, managedIdentities.find((m) => m.active)?.name, inst.accountName]
      .map((s) => s?.trim() ?? '')
      .find((s) => !isPlaceholderAccountString(s, inst.displayName, inst.serial)) ?? '';
  const { numericId, identityHint: profIdentityHint } = await extractActiveProfileNumericId(
    ctx,
    inst.serial,
    cardNode.bounds,
    liveSize.width,
    liveSize.height,
    signal,
  ).catch(() => ({ numericId: null, identityHint: 'unknown' as BluestacksIdentityType }));
  if (profIdentityHint !== 'unknown') {
    identityType = profIdentityHint;
    for (const m of managedIdentities) {
      if (m.active) m.identityType = profIdentityHint;
    }
  }
  const sameAccount =
    !effectiveName ||
    isPlaceholderAccountString(inst.accountName, inst.displayName, inst.serial) ||
    effectiveName.toLowerCase() === inst.accountName.trim().toLowerCase();
  const existingNumericId = sameAccount
    ? ([inst.numericAccountId, inst.accountId].find((v) => isValidNumericFbId(v))?.trim() ?? null)
    : null;
  const resolvedNumericId =
    (isValidNumericFbId(numericId) ? numericId.trim() : null) ?? existingNumericId;
  const preservedNonPlaceholderId =
    sameAccount &&
    !isPlaceholderAccountString(inst.accountId, inst.displayName, inst.serial) &&
    !isCompositePlaceholderBsAccountId(inst.accountId, inst.displayName, inst.instanceKey)
      ? inst.accountId.trim()
      : null;
  await keyevent(ctx, inst.serial, 4, signal).catch(() => null);
  return await ctx.repo.saveInspectionResult({
    id: inst.id,
    fbLiteInstalled: true,
    accountState: 'logged-in',
    accountId: resolvedNumericId ?? preservedNonPlaceholderId ?? '',
    accountName: effectiveName,
    avatarUrl: avatarUrl ?? inst.avatarUrl,
    fbWidth: liveSize.width,
    fbHeight: liveSize.height,
    identityType,
    numericAccountId: resolvedNumericId ?? undefined,
    managedIdentities,
    androidSdk,
    fbLiteVersion,
  });
}
export const saveInstanceAccountState = (
  ctx: DeviceRuntimeContext,
  id: string,
  size: { width: number; height: number },
  accountState: 'missing-app' | 'logged-out' | 'verification' | 'restricted',
  fbLiteInstalled = true,
  androidSdk?: number | null,
  fbLiteVersion?: string | null,
) =>
  ctx.repo.saveInspectionResult({
    id,
    fbLiteInstalled,
    accountState,
    fbWidth: size.width,
    fbHeight: size.height,
    ...(androidSdk !== undefined ? { androidSdk } : {}),
    ...(fbLiteVersion !== undefined ? { fbLiteVersion } : {}),
  });
export async function switchIdentity(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  target: { targetName?: string; targetType?: 'personal' | 'page' },
  signal?: AbortSignal,
): Promise<BluestacksInstance> {
  const { inst, liveSize } = await resolveOnlinePortraitInstance(
    ctx,
    instanceId,
    false,
    false,
    signal,
  );
  await openDeepLink(
    ctx,
    inst.serial,
    'https://www.facebook.com/',
    liveSize.width,
    liveSize.height,
    signal,
  );
  await abortableWait(1800, signal);
  const curXml = await dumpXml(ctx, inst.serial, liveSize.width, liveSize.height, signal);
  const { cardNode } = await openLiteMenuProfileCard(
    ctx,
    inst.serial,
    liveSize.width,
    liveSize.height,
    curXml,
    false,
    signal,
  );
  if (!cardNode)
    throw new ProductError('BLUESTACKS_MENU_NOT_FOUND', '未能打开 FB Lite 身份切换菜单', 500);
  const { switchedTo } = await inspectOrSelectManagedIdentities(
    ctx,
    inst.serial,
    cardNode.bounds,
    isPlaceholderAccountString(inst.accountName, inst.displayName, inst.serial)
      ? ''
      : inst.accountName,
    inst.identityType ?? 'unknown',
    liveSize.width,
    liveSize.height,
    {
      ...target,
      ...(inst.managedIdentities?.length ? { knownIdentities: inst.managedIdentities } : {}),
    },
    signal,
  );
  if (!switchedTo)
    failError(
      'BLUESTACKS_IDENTITY_NOT_FOUND',
      '未找到可切换的目标身份（可能该账号未管理公共主页或已处于目标身份）',
      404,
    );
  await abortableWait(2500, signal);
  return await inspectAccount(ctx, instanceId, signal, { expectedNameHint: switchedTo });
}
