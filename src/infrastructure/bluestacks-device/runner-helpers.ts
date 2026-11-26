import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import type { BluestacksInstance } from '../../shared/bluestacks.js';
import type { BluestacksDeviceManager } from '../bluestacks-device-manager.js';
import {
  detectHomeTabBar,
  findTextInputNode,
  flattenLiteNodes,
  isReactionButtonActive,
  isSolidBlueButton,
  type LiteXmlNode,
  type OcrRecognizer,
  type RectBounds,
} from '../bluestacks-vision.js';
export function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('TASK_STOPPED'));
  return new Promise<void>((resolveWait, rejectWait) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(new Error('TASK_STOPPED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
export function runProcess(
  executable: string,
  args: string[],
  options: {
    input?: Buffer | string;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  if (options.signal?.aborted) return Promise.reject(new Error('TASK_STOPPED'));
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
        windowsHide: true,
        stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }),
      out: Buffer[] = [],
      err: Buffer[] = [];
    let bytes = 0,
      reason: string | undefined,
      settled = false,
      exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanupStreams = () => {
      for (const s of [child.stdin, child.stdout, child.stderr]) {
        try {
          s?.destroy();
        } catch {}
      }
    };
    const settle = (errObj: Error | null, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
      if (errObj || reason) {
        cleanupStreams();
        reject(errObj ?? new Error(reason));
      } else if (code !== 0)
        reject(new Error(`EXIT_${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
      else resolveResult(Buffer.concat(out));
    };
    const killAndSettle = (r: string) => {
      reason ??= r;
      try {
        child.kill();
      } catch {}
      settle(new Error(reason));
    };
    const onAbort = () => killAndSettle('TASK_STOPPED');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => killAndSettle('TIMEOUT'), options.timeoutMs ?? 15000);
    const collect = (chunks: Buffer[], buffer: Buffer) => {
      if (settled) return;
      bytes += buffer.length;
      if (bytes > (options.maxBytes ?? 32 * 1024 * 1024)) killAndSettle('OUTPUT_LIMIT');
      else chunks.push(buffer);
    };
    child.stdout?.on('data', (b: Buffer) => collect(out, b));
    child.stderr?.on('data', (b: Buffer) => collect(err, b));
    child.stdin?.on('error', () => {});
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.once('error', (error) => settle(error));
    // `adb start-server` / `connect` may leave inherited pipe handles open after exit.
    child.once('exit', (code) => {
      if (settled) return;
      exitGraceTimer = setTimeout(() => {
        cleanupStreams();
        settle(null, code);
      }, 250);
    });
    child.once('close', (code) => settle(null, code));
  });
}
export function isTcpPortOpen(port: number, timeoutMs = 160): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}
export interface ParsedBluestacksConfEntry {
  instanceKey: string;
  displayName: string;
  configuredPort: number;
  statusPort: number | null;
  fbWidth: number;
  fbHeight: number;
}
export function parseBluestacksConfContent(content: string): ParsedBluestacksConfEntry[] {
  const map = new Map<
    string,
    {
      displayName?: string;
      adbPort?: number;
      statusPort?: number;
      fbWidth?: number;
      fbHeight?: number;
    }
  >();
  for (const line of content.split(/\r?\n/)) {
    const m =
      /^bst\.instance\.([^.]+)\.(display_name|adb_port|status\.adb_port|fb_width|fb_height)="([^"]*)"/.exec(
        line.trim(),
      );
    if (!m?.[1] || !m[2]) continue;
    const [, key, field, val = ''] = m,
      entry = map.get(key) ?? {};
    if (field === 'display_name') entry.displayName = val;
    else if (field === 'adb_port') entry.adbPort = Number(val);
    else if (field === 'status.adb_port') entry.statusPort = Number(val);
    else if (field === 'fb_width') entry.fbWidth = Number(val);
    else if (field === 'fb_height') entry.fbHeight = Number(val);
    map.set(key, entry);
  }
  return [...map].map(([instanceKey, v]) => ({
    instanceKey,
    displayName: v.displayName?.trim() || instanceKey,
    configuredPort: v.adbPort && v.adbPort > 0 ? v.adbPort : 5555,
    statusPort: v.statusPort && v.statusPort > 0 ? v.statusPort : null,
    fbWidth: v.fbWidth && v.fbWidth >= 100 ? v.fbWidth : 900,
    fbHeight: v.fbHeight && v.fbHeight >= 100 ? v.fbHeight : 1600,
  }));
}
let clipboardQueue: Promise<unknown> = Promise.resolve();
export function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = clipboardQueue.then(fn, fn);
  clipboardQueue = next.catch(() => {});
  return next;
}
export async function withPreservedClipboard<T>(
  onBefore: (() => Promise<void>) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withClipboardLock(async () => {
    const prev = await getHostClipboard().catch(() => null);
    try {
      if (onBefore) await onBefore();
      return await fn();
    } finally {
      if (prev !== null) await setHostClipboard(prev).catch(() => null);
    }
  });
}
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data?: unknown }) => void): void;
  start?(): void;
}
const pendingIpcClipboard = new Map<
  string,
  { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }
>();
let ipcClipboardBoundPort: ParentPortLike | null = null;
function ensureIpcClipboardPort(): ParentPortLike | null {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort ?? null;
  if (!port) return null;
  if (ipcClipboardBoundPort !== port) {
    ipcClipboardBoundPort = port;
    port.on('message', (event: { data?: unknown }) => {
      const msg = event && typeof event === 'object' && 'data' in event ? event.data : event;
      if (
        msg &&
        typeof msg === 'object' &&
        'type' in msg &&
        msg.type === 'CLIPBOARD_RESULT' &&
        'reqId' in msg &&
        typeof msg.reqId === 'string'
      ) {
        const pending = pendingIpcClipboard.get(msg.reqId);
        if (!pending) return;
        pendingIpcClipboard.delete(msg.reqId);
        clearTimeout(pending.timer);
        const ok = !('ok' in msg) || msg.ok !== false,
          text = 'text' in msg && typeof msg.text === 'string' ? msg.text : '';
        pending.resolve(ok ? text : null);
      }
    });
    port.start?.();
  }
  return port;
}
async function ipcClipboardRequest(
  payload:
    | { type: 'CLIPBOARD_GET'; reqId: string }
    | { type: 'CLIPBOARD_SET'; reqId: string; text: string },
): Promise<string | null> {
  const port = ensureIpcClipboardPort();
  if (!port) return null;
  return new Promise<string | null>((resolveReq) => {
    const timer = setTimeout(() => {
      pendingIpcClipboard.delete(payload.reqId);
      resolveReq(null);
    }, 1500);
    pendingIpcClipboard.set(payload.reqId, { resolve: resolveReq, timer });
    try {
      port.postMessage(payload);
    } catch {
      clearTimeout(timer);
      pendingIpcClipboard.delete(payload.reqId);
      resolveReq(null);
    }
  });
}
export async function getHostClipboard(): Promise<string> {
  const ipcRes = await ipcClipboardRequest({ type: 'CLIPBOARD_GET', reqId: randomUUID() });
  if (ipcRes !== null) return ipcRes.trim();
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'for ($i = 0; $i -lt 10; $i++) { try { Get-Clipboard -Raw -ErrorAction Stop; exit 0 } catch { if ($i -eq 9) { throw }; Start-Sleep -Milliseconds 60 } }';
  return (
    await runProcess('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], {
      timeoutMs: 8000,
    })
  )
    .toString('utf8')
    .trim();
}
export async function setHostClipboard(text: string): Promise<void> {
  const ipcRes = await ipcClipboardRequest({ type: 'CLIPBOARD_SET', reqId: randomUUID(), text });
  if (ipcRes !== null) return;
  if (!text) {
    await runProcess(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-Command', 'Set-Clipboard -Value $null'],
      { timeoutMs: 8000 },
    ).catch(() => null);
    return;
  }
  const script =
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $val = [Console]::In.ReadToEnd(); ' +
    'for ($i = 0; $i -lt 10; $i++) { try { Set-Clipboard -Value $val -ErrorAction Stop; exit 0 } catch { if ($i -eq 9) { throw }; Start-Sleep -Milliseconds 60 } }';
  await runProcess('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], {
    input: Buffer.from(text, 'utf8'),
    timeoutMs: 8000,
  });
}
export const COMMON_INSTALL_DIRS = [
  'C:\\Program Files\\BlueStacks_nxt',
  'D:\\Program Files\\BlueStacks_nxt',
  'E:\\Program Files\\BlueStacks_nxt',
  'C:\\Program Files\\BlueStacks_bgp64',
];
export const COMMON_CONF_PATHS = [
  'D:\\BlueStacks_nxt\\bluestacks.conf',
  'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf',
  'E:\\BlueStacks_nxt\\bluestacks.conf',
  'F:\\BlueStacks_nxt\\bluestacks.conf',
];
export type RunnerDevicePort = Pick<
  BluestacksDeviceManager,
  'dumpXml' | 'screencap' | 'tap900' | 'swipe900' | 'keyevent' | 'openDeepLink'
> &
  Partial<
    Pick<
      BluestacksDeviceManager,
      'pasteIntoFocused' | 'detectAbnormalScreen' | 'isLoginOrLoggedOutXml'
    >
  >;
export function isTaskStoppedError(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || (err instanceof Error && err.message === 'TASK_STOPPED'));
}
export function sha256NumericId(seed: string): string {
  return BigInt('0x' + createHash('sha256').update(seed).digest('hex').slice(0, 14)).toString(10);
}
export async function captureScreenAndXml(
  devices: Pick<RunnerDevicePort, 'dumpXml' | 'screencap'>,
  serial: string,
  sw: number,
  sh: number,
  signal?: AbortSignal,
): Promise<{ xml: LiteXmlNode | null; png: Buffer }> {
  const [xml, png] = await Promise.all([
    devices.dumpXml(serial, sw, sh, signal),
    devices.screencap(serial, signal),
  ]);
  return { xml, png };
}
export async function detectAbnormalScreenCompat(
  devices: Pick<RunnerDevicePort, 'detectAbnormalScreen' | 'isLoginOrLoggedOutXml'>,
  serial: string,
  xml: LiteXmlNode | null,
  png: Buffer | undefined,
  signal: AbortSignal,
): Promise<'logged-out' | 'restricted' | 'verification' | null> {
  if (typeof devices.detectAbnormalScreen === 'function')
    return await devices.detectAbnormalScreen(serial, xml, png, signal);
  if (typeof devices.isLoginOrLoggedOutXml === 'function' && devices.isLoginOrLoggedOutXml(xml))
    return 'logged-out';
  return null;
}
export function abnormalAccountErrorMessage(
  abnormal: 'logged-out' | 'restricted' | 'verification',
): string {
  return abnormal === 'logged-out'
    ? 'FB Lite 账号已退出登录'
    : abnormal === 'verification'
      ? 'FB Lite 账号触发安全验证 (Checkpoint)'
      : 'FB Lite 账号已被封禁或停用';
}
export async function assertHealthyScreen(
  devices: Pick<RunnerDevicePort, 'detectAbnormalScreen' | 'isLoginOrLoggedOutXml'>,
  serial: string,
  xml: LiteXmlNode | null,
  png: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const abnormal = await detectAbnormalScreenCompat(devices, serial, xml, png, signal);
  if (abnormal) throw new Error(abnormalAccountErrorMessage(abnormal));
}
export async function openDeepLinkAndInspect(
  devices: RunnerDevicePort,
  inst: Pick<BluestacksInstance, 'serial' | 'fbWidth' | 'fbHeight'>,
  url: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ xml: LiteXmlNode | null; png: Buffer }> {
  const { serial, fbWidth: sw, fbHeight: sh } = inst;
  await devices.openDeepLink(serial, url, sw, sh, signal);
  await abortableWait(waitMs, signal);
  const { xml, png } = await captureScreenAndXml(devices, serial, sw, sh, signal);
  await assertHealthyScreen(devices, serial, xml, png, signal);
  return { xml, png };
}
export async function ocrCompact(
  ocr: OcrRecognizer,
  png: Buffer,
  rect: RectBounds,
): Promise<string> {
  return (await ocr.recognizeBounds(png, rect)).replace(/\s+/g, '');
}
export function filterClickableNodes(
  root: LiteXmlNode | null,
  pred: (n: LiteXmlNode) => boolean,
  sortBy: (a: LiteXmlNode, b: LiteXmlNode) => number = (a, b) => a.bounds.y1 - b.bounds.y1,
): LiteXmlNode[] {
  return flattenLiteNodes(root)
    .filter((n) => n.clickable && pred(n))
    .sort(sortBy);
}
const waitAfter = (op: Promise<unknown>, waitMs: number, signal: AbortSignal) =>
  op.then(() => (waitMs > 0 ? abortableWait(waitMs, signal) : undefined));
export const tapAndWait = (
  devices: Pick<RunnerDevicePort, 'tap900'>,
  serial: string,
  x: number,
  y: number,
  sw: number,
  sh: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> => waitAfter(devices.tap900(serial, x, y, sw, sh, signal), waitMs, signal);
export const swipeAndWait = (
  devices: Pick<RunnerDevicePort, 'swipe900'>,
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
  sw: number,
  sh: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> =>
  waitAfter(devices.swipe900(serial, x1, y1, x2, y2, durationMs, sw, sh, signal), waitMs, signal);
export const backAndWait = (
  devices: Pick<RunnerDevicePort, 'keyevent'>,
  serial: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> =>
  waitAfter(
    devices.keyevent(serial, 4, signal).catch(() => null),
    waitMs,
    signal,
  );
export async function findOcrNode(
  ocr: OcrRecognizer,
  png: Buffer,
  nodes: readonly LiteXmlNode[],
  pattern: RegExp,
  requireBlue = false,
): Promise<{ node: LiteXmlNode; text: string } | null> {
  for (const node of nodes) {
    if (requireBlue && !(await isSolidBlueButton(png, node.bounds))) continue;
    const text = await ocrCompact(ocr, png, node.bounds);
    if (pattern.test(text)) return { node, text };
  }
  return null;
}
export async function tapLikeAndVerify(
  devices: Pick<RunnerDevicePort, 'tap900' | 'screencap'>,
  serial: string,
  bounds: RectBounds,
  sw: number,
  sh: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; afterPng: Buffer }> {
  await devices.tap900(serial, bounds.cx, bounds.cy, sw, sh, signal);
  await abortableWait(waitMs, signal);
  const afterPng = await devices.screencap(serial, signal);
  return { ok: await isReactionButtonActive(afterPng, bounds), afterPng };
}
export async function dismissComposerWithDiscard(
  devices: Pick<RunnerDevicePort, 'keyevent' | 'screencap' | 'dumpXml' | 'tap900'>,
  ocr: OcrRecognizer,
  serial: string,
  sw: number,
  sh: number,
  signal: AbortSignal,
): Promise<void> {
  await devices.keyevent(serial, 4, signal).catch(() => null);
  await abortableWait(700, signal).catch(() => null);
  const [dlgPng, dlgXml] = await Promise.all([
    devices.screencap(serial, signal).catch(() => null),
    devices.dumpXml(serial, sw, sh, signal).catch(() => null),
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
  const match = await findOcrNode(ocr, dlgPng, btns, /放弃|舍弃|不保存|discard/i);
  if (match) {
    await devices
      .tap900(serial, match.node.bounds.cx, match.node.bounds.cy, sw, sh, signal)
      .catch(() => null);
    await abortableWait(500, signal).catch(() => null);
  }
}
export async function attachGalleryMedia(
  devices: Pick<RunnerDevicePort, 'screencap' | 'dumpXml' | 'tap900'>,
  ocr: OcrRecognizer,
  serial: string,
  sw: number,
  sh: number,
  signal: AbortSignal,
  scanGrid: boolean,
): Promise<boolean> {
  if (scanGrid) {
    const { xml: pickerXml, png: pickerPng } = await captureScreenAndXml(
      devices,
      serial,
      sw,
      sh,
      signal,
    );
    const gridTiles = flattenLiteNodes(pickerXml)
      .filter(
        (n) =>
          n.clickable &&
          n.bounds.y1 >= 160 &&
          n.bounds.y2 <= 1250 &&
          n.bounds.w >= 120 &&
          n.bounds.w <= 430 &&
          n.bounds.h >= 120 &&
          n.bounds.h <= 460,
      )
      .sort(
        (a, b) =>
          Math.round(a.bounds.y1 / 80) - Math.round(b.bounds.y1 / 80) || a.bounds.x1 - b.bounds.x1,
      );
    let pickedTile: LiteXmlNode | null = null;
    for (const tile of gridTiles.slice(0, 6)) {
      const tileTxt = (await ocr.recognizeBounds(pickerPng, tile.bounds)).replace(/\s+/g, '');
      if (!/相机|相機|camera|拍照|录像|錄影/i.test(tileTxt)) {
        pickedTile = tile;
        break;
      }
    }
    await devices.tap900(
      serial,
      pickedTile ? pickedTile.bounds.cx : 150,
      pickedTile ? pickedTile.bounds.cy : 340,
      sw,
      sh,
      signal,
    );
  } else {
    await devices.tap900(serial, 150, 340, sw, sh, signal);
  }
  await abortableWait(1800, signal);
  const { xml: galXml, png: galPng } = await captureScreenAndXml(devices, serial, sw, sh, signal);
  const nextBtns = flattenLiteNodes(galXml).filter(
    (n) => n.clickable && n.bounds.x1 >= 650 && n.bounds.y1 <= 160 && n.bounds.h >= 34,
  );
  const nextMatch = await findOcrNode(
    ocr,
    galPng,
    nextBtns,
    /下一步|完成|确定|確定|next|done|ရှေ့ဆက်|tiếp/i,
  );
  if (nextMatch) {
    await devices.tap900(
      serial,
      nextMatch.node.bounds.cx,
      nextMatch.node.bounds.cy,
      sw,
      sh,
      signal,
    );
    await abortableWait(scanGrid ? 2400 : 2200, signal);
    return true;
  }
  if (!scanGrid) return true;
  return findTextInputNode(await devices.dumpXml(serial, sw, sh, signal)) !== null;
}
export async function tapHomeTab0(
  devices: Pick<RunnerDevicePort, 'dumpXml' | 'tap900'>,
  serial: string,
  sw: number,
  sh: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<LiteXmlNode | null> {
  const xml = await devices.dumpXml(serial, sw, sh, signal);
  const tabBar = detectHomeTabBar(xml);
  if (tabBar?.tabs[0]) {
    await devices.tap900(serial, tabBar.tabs[0].cx, tabBar.tabs[0].cy, sw, sh, signal);
    await abortableWait(waitMs, signal);
  }
  return xml;
}
export function createScreenOps(
  devices: RunnerDevicePort,
  ocr: OcrRecognizer,
  inst: Pick<BluestacksInstance, 'serial' | 'fbWidth' | 'fbHeight'>,
  signal: AbortSignal,
) {
  const { serial, fbWidth: sw, fbHeight: sh } = inst;
  return {
    serial,
    sw,
    sh,
    guard: () => {
      if (signal.aborted) throw new Error('TASK_STOPPED');
    },
    wait: (ms: number) => abortableWait(ms, signal),
    xml: () => devices.dumpXml(serial, sw, sh, signal),
    png: () => devices.screencap(serial, signal),
    capture: () => captureScreenAndXml(devices, serial, sw, sh, signal),
    tap: (x: number, y: number, waitMs = 0) =>
      tapAndWait(devices, serial, x, y, sw, sh, waitMs, signal),
    swipe: (x1: number, y1: number, x2: number, y2: number, durationMs = 500, waitMs = 0) =>
      swipeAndWait(devices, serial, x1, y1, x2, y2, durationMs, sw, sh, waitMs, signal),
    back: (waitMs = 0) => backAndWait(devices, serial, waitMs, signal),
    open: (url: string, waitMs = 0) =>
      waitAfter(devices.openDeepLink(serial, url, sw, sh, signal), waitMs, signal),
    openInspect: (url: string, waitMs: number) =>
      openDeepLinkAndInspect(devices, inst, url, waitMs, signal),
    healthy: (xml: LiteXmlNode | null, png: Buffer) =>
      assertHealthyScreen(devices, serial, xml, png, signal),
    abnormal: (xml: LiteXmlNode | null, png?: Buffer) =>
      detectAbnormalScreenCompat(devices, serial, xml, png, signal),
    paste: (x: number, y: number, text: string) =>
      devices.pasteIntoFocused?.(serial, x, y, text, sw, sh, signal) ?? Promise.resolve(),
    tapLike: (bounds: RectBounds, waitMs: number) =>
      tapLikeAndVerify(devices, serial, bounds, sw, sh, waitMs, signal),
    ocr: (png: Buffer, rect: RectBounds) => ocrCompact(ocr, png, rect),
    findOcr: (png: Buffer, nodes: readonly LiteXmlNode[], pat: RegExp, requireBlue = false) =>
      findOcrNode(ocr, png, nodes, pat, requireBlue),
    attachMedia: (scanGrid: boolean) =>
      attachGalleryMedia(devices, ocr, serial, sw, sh, signal, scanGrid),
    dismissDiscard: () => dismissComposerWithDiscard(devices, ocr, serial, sw, sh, signal),
    tapHomeTab0: (waitMs: number) => tapHomeTab0(devices, serial, sw, sh, waitMs, signal),
  };
}
export type ScreenOps = ReturnType<typeof createScreenOps>;
