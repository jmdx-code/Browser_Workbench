import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  classifyAbnormalScreenText,
  detectHomeTabBar,
  extractActionBars,
  extractPostCards,
  flattenLiteNodes,
  isBottomSheetOpen,
  isLiteTextInputClass,
  makeCanonicalRect,
  parseDumpsysTop,
  parseLiteXml,
  scalePointFrom900,
  type LiteXmlNode,
  type RectBounds,
} from '../bluestacks-vision.js';
import {
  focusBlueStacksWindow,
  isPrintableAscii,
  queryRunningBlueStacksWindows,
  quoteForAndroidInputText,
} from '../bluestacks-win32.js';
import {
  type DeviceRuntimeContext,
  adb,
  hasFbLiteInstalled,
  lockPortraitOrientation,
} from './device-runtime-and-adb.js';
import {
  abortableWait,
  findOcrNode,
  getHostClipboard,
  isTaskStoppedError,
  isTcpPortOpen,
  setHostClipboard,
  withPreservedClipboard,
} from './runner-helpers.js';
const FB_MEDIA_PERMS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
];
async function runMediaCmd(
  ctx: DeviceRuntimeContext,
  serial: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) {
  await adb(ctx, serial, args, timeoutMs, signal).catch(() => null);
}
export async function launchFbLitePackage(
  ctx: DeviceRuntimeContext,
  serial: string,
  signal?: AbortSignal,
) {
  await adb(
    ctx,
    serial,
    ['shell', 'monkey', '-p', 'com.facebook.lite', '-c', 'android.intent.category.LAUNCHER', '1'],
    8000,
    signal,
  ).catch(() => null);
}
export async function grantFbLiteMediaPerms(
  ctx: DeviceRuntimeContext,
  serial: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const perm of FB_MEDIA_PERMS)
    await runMediaCmd(
      ctx,
      serial,
      ['shell', 'pm', 'grant', 'com.facebook.lite', perm],
      3000,
      signal,
    );
}
async function triggerMediaScan(
  ctx: DeviceRuntimeContext,
  serial: string,
  remotePath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  for (const args of [
    [
      'shell',
      'content',
      'call',
      '--uri',
      'content://media',
      '--method',
      'scan_file',
      '--arg',
      remotePath,
    ],
    [
      'shell',
      'am',
      'broadcast',
      '-a',
      'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
      '-d',
      `file://${remotePath}`,
    ],
  ])
    await runMediaCmd(ctx, serial, args, timeoutMs, signal);
}
export async function screencap(
  ctx: DeviceRuntimeContext,
  serial: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const buf = await adb(ctx, serial, ['exec-out', 'screencap', '-p'], 8000, signal);
    if (buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50) return buf;
  } catch (err) {
    if (isTaskStoppedError(err, signal)) throw new Error('TASK_STOPPED');
  }
  const remote = `/sdcard/agy_cap_${serial.replace(/[^0-9]/g, '')}.png`;
  await adb(ctx, serial, ['shell', 'screencap', '-p', remote], 8000, signal);
  const buf = await adb(ctx, serial, ['exec-out', 'cat', remote], 8000, signal);
  await adb(ctx, serial, ['shell', 'rm', '-f', remote], 4000).catch(() => null);
  return buf;
}
export async function dumpXml(
  ctx: DeviceRuntimeContext,
  serial: string,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
): Promise<LiteXmlNode | null> {
  try {
    const topBuf = await adb(ctx, serial, ['shell', 'dumpsys', 'activity', 'top'], 4500, signal);
    const parsed = parseDumpsysTop(topBuf.toString('utf8'), screenW, screenH);
    if (parsed && flattenLiteNodes(parsed).length >= 8) return parsed;
  } catch (err) {
    if (isTaskStoppedError(err, signal)) throw new Error('TASK_STOPPED');
  }
  const remote = `/sdcard/agy_dump_${serial.replace(/[^0-9]/g, '')}.xml`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await adb(ctx, serial, ['shell', 'rm', '-f', remote], 3000, signal).catch(() => null);
      await adb(ctx, serial, ['shell', 'uiautomator', 'dump', remote], 7000, signal);
      const xmlBuf = await adb(ctx, serial, ['exec-out', 'cat', remote], 5000, signal);
      await adb(ctx, serial, ['shell', 'rm', '-f', remote], 3000).catch(() => null);
      const root = parseLiteXml(xmlBuf.toString('utf8'), screenW, screenH);
      if (root) return root;
    } catch (err) {
      if (isTaskStoppedError(err, signal)) throw new Error('TASK_STOPPED');
      if (attempt === 0) {
        await swipe900(ctx, serial, 5, 500, 5, 492, 100, screenW, screenH, signal).catch(
          () => null,
        );
        await abortableWait(350, signal);
      }
    }
  }
  return null;
}
export async function tap900(
  ctx: DeviceRuntimeContext,
  serial: string,
  x900: number,
  y900: number,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
): Promise<void> {
  const pt = scalePointFrom900(x900, y900, screenW, screenH);
  await adb(ctx, serial, ['shell', 'input', 'tap', String(pt.x), String(pt.y)], 5000, signal);
}
export async function swipe900(
  ctx: DeviceRuntimeContext,
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 500,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
): Promise<void> {
  const p1 = scalePointFrom900(x1, y1, screenW, screenH),
    p2 = scalePointFrom900(x2, y2, screenW, screenH);
  await adb(
    ctx,
    serial,
    ['shell', 'input', 'swipe', ...[p1.x, p1.y, p2.x, p2.y, Math.round(durationMs)].map(String)],
    6000,
    signal,
  );
}
export async function keyevent(
  ctx: DeviceRuntimeContext,
  serial: string,
  code: number,
  signal?: AbortSignal,
): Promise<void> {
  await adb(ctx, serial, ['shell', 'input', 'keyevent', String(code)], 5000, signal);
}
function parseStreamMusicState(
  dumpsysAudio: string,
): { muted: boolean; speakerVol: number } | null {
  const idx = dumpsysAudio.indexOf('- STREAM_MUSIC:');
  if (idx < 0) return null;
  const block = dumpsysAudio.slice(idx, idx + 420);
  const mutedMatch = /\bMuted:\s*(true|false)\b/i.exec(block);
  if (!mutedMatch) return null;
  const muted = mutedMatch[1]?.toLowerCase() === 'true';
  const speakerVol = Number(
    /\bspeaker\):\s*(\d+)\b/i.exec(block)?.[1] ??
      /\bdefault\):\s*(\d+)\b/i.exec(block)?.[1] ??
      (muted ? 0 : 10),
  );
  return { muted, speakerVol: Number.isFinite(speakerVol) ? speakerVol : 0 };
}
export async function setMediaSoundEnabled(
  ctx: DeviceRuntimeContext,
  serial: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const readAudio = async () => {
      const buf = await adb(ctx, serial, ['shell', 'dumpsys', 'audio'], 4000, signal).catch(
        () => null,
      );
      return buf ? parseStreamMusicState(buf.toString('utf8')) : null;
    };
    const setVol = (vol: number) =>
      adb(
        ctx,
        serial,
        [
          'shell',
          `media volume --stream 3 --set ${vol} >/dev/null 2>&1 || cmd media_session volume --stream 3 --set ${vol} >/dev/null 2>&1 || true`,
        ],
        4000,
        signal,
      );
    if (enabled) {
      const state = await readAudio();
      if (state && !state.muted && state.speakerVol >= 3) return;
      await setVol(11);
      if ((await readAudio())?.muted) await keyevent(ctx, serial, 24, signal);
    } else await setVol(0);
  } catch (err) {
    if (isTaskStoppedError(err, signal)) throw new Error('TASK_STOPPED');
  }
}
export async function setInstanceSoundEnabled(
  ctx: DeviceRuntimeContext,
  instanceId: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await ctx.repo.getInstance(instanceId);
  if (!existing) return;
  if (!ctx.onlineInstanceKeys.has(existing.instanceKey) && !(await isTcpPortOpen(existing.adbPort)))
    return;
  await setMediaSoundEnabled(ctx, existing.serial, enabled, signal);
}
export async function focusBySerial(serial: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const port = Number(/:(\d+)$/.exec(serial)?.[1] ?? 0);
  if (!port) return;
  const matched = (await queryRunningBlueStacksWindows()).find((w) =>
    w.listeningPorts.includes(port),
  );
  if (matched) await focusBlueStacksWindow(undefined, matched.hwnd, matched.pid).catch(() => false);
}
export async function openDeepLink(
  ctx: DeviceRuntimeContext,
  serial: string,
  url: string,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
): Promise<void> {
  if (!(await hasFbLiteInstalled(ctx, serial, false, signal)))
    throw new Error('跳过：未安装 FB Lite');
  await lockPortraitOrientation(ctx, serial, signal);
  const preXml = await dumpXml(ctx, serial, screenW, screenH, signal).catch(() => null);
  if (!preXml || preXml.packageName !== 'com.facebook.lite') {
    await launchFbLitePackage(ctx, serial, signal);
    for (let warm = 0; warm < 5; warm++) {
      await abortableWait(1200, signal);
      const wXml = await dumpXml(ctx, serial, screenW, screenH, signal).catch(() => null);
      if (wXml?.packageName === 'com.facebook.lite' && flattenLiteNodes(wXml).length >= 8) break;
    }
  }
  const quotedUrl = `'${url.replace(/'/g, `'\\''`)}'`;
  await adb(
    ctx,
    serial,
    [
      'shell',
      'am',
      'start',
      '-n',
      'com.facebook.lite/.deeplinking.activities.PermalinkPossiblePatternsActivityAlias',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      quotedUrl,
    ],
    8000,
    signal,
  );
  const expectsLeaveHome = !/^https?:\/\/(?:www\.|m\.|mbasic\.)?facebook\.com\/?(?:[?#].*)?$/i.test(
    url.trim(),
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    await abortableWait(1100, signal);
    const xml = await dumpXml(ctx, serial, screenW, screenH, signal);
    if (
      xml?.packageName === 'com.facebook.lite' &&
      flattenLiteNodes(xml).length >= 10 &&
      (!expectsLeaveHome || detectHomeTabBar(xml) === null)
    )
      return;
  }
}
export function splitAndroidInputTextChunks(text: string, maxChunkLen = 16): string[] {
  if (!text) return [];
  const cap = Math.max(1, maxChunkLen);
  const chunks: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    // End chunk right after '%' so Android `input text` never sees literal `%s` as a space token.
    if (ch === '%' || current.length >= cap) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
export async function typeAsciiAt900(
  ctx: DeviceRuntimeContext,
  serial: string,
  x900: number,
  y900: number,
  text: string,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
): Promise<void> {
  if (!text) return;
  await tap900(ctx, serial, x900, y900, screenW, screenH, signal);
  await abortableWait(300, signal);
  for (const chunk of splitAndroidInputTextChunks(text, 16)) {
    await adb(
      ctx,
      serial,
      ['shell', `input text ${quoteForAndroidInputText(chunk)}`],
      8000,
      signal,
    );
    await abortableWait(100, signal);
  }
  await abortableWait(220, signal);
}
export async function pasteIntoFocused(
  ctx: DeviceRuntimeContext,
  serial: string,
  x900: number,
  y900: number,
  text: string,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
  options: { preferClipboard?: boolean } = {},
): Promise<void> {
  if (!text) return;
  if (!options.preferClipboard && text.length <= 160 && isPrintableAscii(text)) {
    await typeAsciiAt900(ctx, serial, x900, y900, text, screenW, screenH, signal);
    return;
  }
  await withPreservedClipboard(undefined, async () => {
    if (signal?.aborted) throw new Error('TASK_STOPPED');
    await setHostClipboard(text);
    await abortableWait(120, signal);
    await focusBySerial(serial);
    await abortableWait(180, signal);
    await tap900(ctx, serial, x900, y900, screenW, screenH, signal);
    await abortableWait(260, signal);
    await keyevent(ctx, serial, 279, signal);
    await abortableWait(350, signal);
  });
}
export async function pruneOldPushedMedia(
  ctx: DeviceRuntimeContext,
  serial: string,
  maxAgeMs = 30 * 60_000,
  signal?: AbortSignal,
): Promise<number> {
  const cutoffMs = Date.now() - Math.max(60_000, maxAgeMs);
  const stalePaths: string[] = [];
  for (const dir of ['/sdcard/Movies/Workbench', '/sdcard/Pictures/Workbench']) {
    const outBuf = await adb(ctx, serial, ['shell', 'ls', '-1', dir], 4000, signal).catch(
      () => null,
    );
    if (!outBuf) continue;
    for (const rawLine of outBuf.toString('utf8').split(/\r?\n/)) {
      const name = rawLine.trim();
      const match = /^wb_(\d{13})_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.exec(name);
      if (match?.[1] && Number.isFinite(Number(match[1])) && Number(match[1]) < cutoffMs) {
        stalePaths.push(`${dir}/${name}`);
      }
    }
  }
  if (stalePaths.length > 0) await cleanupPushedMedia(ctx, serial, stalePaths);
  return stalePaths.length;
}
export async function pushMediaToGallery(
  ctx: DeviceRuntimeContext,
  serial: string,
  localFilePath: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!existsSync(localFilePath)) throw new Error(`媒体文件不存在: ${localFilePath}`);
  await pruneOldPushedMedia(ctx, serial, 15 * 60_000, signal).catch(() => 0);
  const ext = path.extname(localFilePath).toLowerCase() || '.jpg';
  const isVideo = /\.(mp4|mov|m4v|webm|3gp|mkv)$/i.test(ext);
  const remoteDir = isVideo ? '/sdcard/Movies/Workbench' : '/sdcard/Pictures/Workbench';
  const remotePath = `${remoteDir}/wb_${Date.now()}_${randomUUID().slice(0, 6)}${ext}`;
  await grantFbLiteMediaPerms(ctx, serial, signal);
  await adb(ctx, serial, ['shell', 'mkdir', '-p', remoteDir], 6000, signal);
  await adb(ctx, serial, ['push', localFilePath, remotePath], 60_000, signal);
  await adb(ctx, serial, ['shell', 'touch', remotePath], 4000, signal).catch(() => null);
  await triggerMediaScan(ctx, serial, remotePath, 6000, signal);
  const escapedPath = remotePath.replace(/'/g, "''");
  const scanDeadline = Date.now() + 8000;
  let indexed = false;
  while (Date.now() < scanDeadline) {
    if (signal?.aborted) throw new Error('TASK_STOPPED');
    const queryOut = await adb(
      ctx,
      serial,
      [
        'shell',
        'content',
        'query',
        '--uri',
        'content://media/external/file',
        '--projection',
        '_id',
        '--where',
        `_data='${escapedPath}'`,
      ],
      4000,
      signal,
    ).catch(() => null);
    if (queryOut && /Row:\s*\d+/i.test(queryOut.toString('utf8'))) {
      indexed = true;
      break;
    }
    await abortableWait(700, signal);
  }
  if (!indexed) await abortableWait(1200, signal);
  return remotePath;
}
export async function cleanupPushedMedia(
  ctx: DeviceRuntimeContext,
  serial: string,
  remotePaths: readonly string[],
): Promise<void> {
  for (const remotePath of remotePaths) {
    if (!remotePath.startsWith('/sdcard/')) continue;
    await adb(ctx, serial, ['shell', 'rm', '-f', remotePath], 4000).catch(() => null);
    await triggerMediaScan(ctx, serial, remotePath, 4000);
  }
}
export async function copyLinkFromMoreMenu(
  ctx: DeviceRuntimeContext,
  serial: string,
  moreBounds: RectBounds,
  screenW = 900,
  screenH = 1600,
  signal?: AbortSignal,
): Promise<string | null> {
  let prevClip: string | null = null;
  let sheetMayBeOpen = false;
  return withPreservedClipboard(undefined, async () => {
    prevClip = await getHostClipboard().catch(() => null);
    try {
      const marker = `__AGY_EMPTY_${Date.now()}__`;
      const markerApplied = await setHostClipboard(marker)
        .then(() => true)
        .catch(() => false);
      sheetMayBeOpen = true;
      await tap900(ctx, serial, moreBounds.cx, moreBounds.cy, screenW, screenH, signal);
      await abortableWait(1350, signal);
      const [sheetPng, sheetXml] = await Promise.all([
        screencap(ctx, serial, signal),
        dumpXml(ctx, serial, screenW, screenH, signal),
      ]);
      if (!(await isBottomSheetOpen(sheetPng))) {
        sheetMayBeOpen = false;
        return null;
      }
      const sheetRows = flattenLiteNodes(sheetXml)
        .filter(
          (n) =>
            n.clickable &&
            n.bounds.x1 >= 0 &&
            n.bounds.x1 <= 80 &&
            n.bounds.x2 >= 820 &&
            n.bounds.y1 >= 740 &&
            n.bounds.h >= 50 &&
            n.bounds.h <= 115,
        )
        .sort((a, b) => b.bounds.y1 - a.bounds.y1);
      const copyMatch = await findOcrNode(
        ctx.ocr,
        sheetPng,
        sheetRows,
        /复制链接|複製連結|copylink/i,
      );
      await focusBySerial(serial);
      await tap900(ctx, serial, 450, copyMatch?.node.bounds.cy ?? 1370, screenW, screenH, signal);
      await abortableWait(900, signal);
      const afterPng = await screencap(ctx, serial, signal).catch(() => null);
      if (afterPng && (await isBottomSheetOpen(afterPng))) {
        await keyevent(ctx, serial, 4, signal).catch(() => null);
        await abortableWait(600, signal);
      }
      sheetMayBeOpen = false;
      const clip = await getHostClipboard().catch(() => '');
      if (!clip || !/^https?:\/\//i.test(clip)) return null;
      if (markerApplied && clip === marker) return null;
      if (!markerApplied && prevClip !== null && clip === prevClip) return null;
      return clip;
    } finally {
      if (sheetMayBeOpen && !signal?.aborted) {
        const remainPng = await screencap(ctx, serial).catch(() => null);
        if (remainPng && (await isBottomSheetOpen(remainPng))) {
          await keyevent(ctx, serial, 4).catch(() => null);
          await abortableWait(500).catch(() => null);
        }
      }
    }
  });
}
export function isLoginOrLoggedOutXml(root: LiteXmlNode | null): boolean {
  if (!root || root.packageName !== 'com.facebook.lite') return false;
  const all = flattenLiteNodes(root);
  if (all.length < 6) return false;
  const hasHomeTabBar = detectHomeTabBar(root) !== null;
  const hasTopMenuOrBack = all.some(
    (n) =>
      n.clickable &&
      n.bounds.y1 >= 30 &&
      n.bounds.y2 <= 112 &&
      ((n.bounds.x1 <= 15 && n.bounds.x2 <= 95) || (n.bounds.x1 >= 815 && n.bounds.x2 <= 900)),
  );
  if (
    hasHomeTabBar ||
    hasTopMenuOrBack ||
    extractPostCards(root).length > 0 ||
    extractActionBars(root).length > 0
  )
    return false;
  const inputCount = all.filter(
    (n) => isLiteTextInputClass(n.className) && n.bounds.y1 >= 140 && n.bounds.y2 <= 1180,
  ).length;
  if (inputCount >= 2) return true;
  const joinedText = all.map((n) => `${n.text} ${n.contentDesc}`.trim()).join(' ');
  if (
    /创建新账号|创建新账户|建立新帳號|create\s*new\s*account|手机号或邮箱|forgot\s*password|忘记密码/i.test(
      joinedText,
    )
  )
    return true;
  return inputCount >= 1 && /登录|登入|log\s*in|sign\s*in/i.test(joinedText);
}
export async function detectAbnormalScreen(
  ctx: DeviceRuntimeContext,
  serial: string,
  xml: LiteXmlNode | null,
  png?: Buffer,
  signal?: AbortSignal,
): Promise<'logged-out' | 'verification' | 'restricted' | null> {
  if (isLoginOrLoggedOutXml(xml)) return 'logged-out';
  const shot = png ?? (await screencap(ctx, serial, signal).catch(() => null));
  if (!shot) return null;
  return classifyAbnormalScreenText(
    await ctx.ocr.recognizeBounds(shot, makeCanonicalRect(0, 0, 900, 1600)),
  );
}
