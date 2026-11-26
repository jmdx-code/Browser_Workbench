import type { TabProof } from '../src/shared/kernel-state.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import { TaskWindowSnapshot, type TaskWindow, type Rect } from '../src/shared/window-layout.js';
import { sleep, WorkspacePageGroup } from './workspace-page-group.js';
import { kernelAccessURL } from '../src/shared/kernel-policy.js';
let lastUserFocusedAt = 0;
let programmaticMoveSuppressUntil = 0;
export function markProgrammaticWindowMove(durationMs = 1500): void {
  programmaticMoveSuppressUntil = Math.max(programmaticMoveSuppressUntil, Date.now() + durationMs);
}
export const isProgrammaticWindowMoveActive = (): boolean =>
  Date.now() < programmaticMoveSuppressUntil;
export function recordUserWindowFocus(ts = Date.now()): void {
  if (!isProgrammaticWindowMoveActive() && ts > lastUserFocusedAt) lastUserFocusedAt = ts;
}
export function setLastUserFocusedAt(ts = Date.now()): void {
  lastUserFocusedAt = ts;
}
export const getLastUserFocusedAt = (): number => lastUserFocusedAt;
const confirmedMove = (actual: Rect, requested: Rect) =>
  (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(actual[key] - requested[key]) <= 4,
  );
export type WindowBounds = { left: number; top: number; width: number; height: number };
export type WindowDisplayBounds = WindowBounds & { id: string };
type LightweightMovedWindow = {
  windowId: number;
  focused: boolean;
  state: TaskWindow['state'];
  bounds: WindowBounds;
};
export function measureWindowContentInsets(
  win: { width?: number; height?: number },
  tab?: { width?: number; height?: number },
  strict = false,
): { left: number; top: number; right: number; bottom: number } {
  if (
    tab &&
    Number.isFinite(tab.width) &&
    Number.isFinite(tab.height) &&
    win.width &&
    win.height &&
    tab.width &&
    tab.height &&
    tab.width <= win.width &&
    tab.height <= win.height
  ) {
    const side = Math.ceil((win.width - tab.width) / 2) + 8,
      top = Math.max(80, win.height - tab.height) + 8;
    if (win.width - side * 2 >= 2 && win.height - top - side >= 2)
      return { left: side, right: side, bottom: side, top };
  }
  if (strict) throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
  return { left: 16, top: 104, right: 16, bottom: 16 };
}
export class TaskWindowController {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly moving = new Set<number>();
  private readonly tabTokens = new Map<number, { tabId: number; disposed: boolean }>();
  private ensureTabToken(tabId: number) {
    const existing = this.tabTokens.get(tabId);
    if (existing && !existing.disposed) return existing;
    const token = { tabId, disposed: false };
    this.tabTokens.set(tabId, token);
    return token;
  }
  isTabActive = (tabId: number, token: { tabId: number; disposed: boolean }) =>
    !token.disposed && this.tabTokens.get(tabId) === token;
  forgetTab(tabId: number): void {
    const token = this.tabTokens.get(tabId);
    if (token) {
      token.disposed = true;
      this.tabTokens.delete(tabId);
    }
  }
  screens = (win?: chrome.windows.Window): WindowDisplayBounds[] => [
    {
      id: 'default',
      left: win?.left ?? 0,
      top: win?.top ?? 0,
      width: Math.max(win?.width ?? 1280, 1280),
      height: Math.max(win?.height ?? 900, 900),
    },
  ];
  private checkToken(
    tabId: number | undefined,
    token: { tabId: number; disposed: boolean } | undefined,
    guard?: () => void,
  ) {
    guard?.();
    if (tabId && tabId > 0 && token && !this.isTabActive(tabId, token))
      throw Error('WINDOW_LAYOUT_REVOKED');
  }
  private async ensureNormalWindow(windowId: number, check: () => void, focus = false) {
    let win = await chrome.windows.get(windowId);
    check();
    if (win.state === 'locked-fullscreen') throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
    if (win.state && win.state !== 'normal') {
      await chrome.windows.update(windowId, {
        state: 'normal',
        ...(focus ? {} : { focused: false }),
      });
      check();
      win = await chrome.windows.get(windowId);
      check();
    }
    return win;
  }
  private async activateTabIfNeeded(tabId: number, check: () => void, swAllowMissing = false) {
    const tab = await chrome.tabs
      .get(tabId)
      .catch((e) => (swAllowMissing ? null : Promise.reject(e)));
    check();
    if (tab && !tab.active) {
      await chrome.tabs
        .update(tabId, { active: true })
        .catch((e) => (swAllowMissing ? undefined : Promise.reject(e)));
      check();
    }
    return tab;
  }
  private async waitBounds<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    let val = await read();
    for (const deadline = Date.now() + 350; !done(val) && Date.now() < deadline;) {
      await sleep(25);
      val = await read();
    }
    return val;
  }
  async inspect(proof: TabProof, guard: () => void): Promise<TaskWindow> {
    const token = this.ensureTabToken(proof.tabId),
      check = () => this.checkToken(proof.tabId, token, guard);
    check();
    const main = await new WorkspacePageGroup().read(check);
    if (!main || !sameTabProof(main.proof, proof)) throw Error('WINDOW_LAYOUT_MAIN_CHANGED');
    let tab: chrome.tabs.Tab;
    for (const deadline = Date.now() + 5000; ;) {
      const [currentTab, targets] = await Promise.all([
        chrome.tabs.get(proof.tabId),
        chrome.debugger.getTargets(),
      ]);
      check();
      tab = currentTab;
      const target = targets.find(
        (t) => t.type === 'page' && t.id === proof.targetId && t.tabId === proof.tabId,
      );
      if (!target) throw Error('WINDOW_LAYOUT_TARGET_CHANGED');
      if (kernelAccessURL(target.url, 'facebook-task')) {
        if (tab.url && tab.url !== 'about:blank' && !kernelAccessURL(tab.url, 'facebook-task'))
          throw Error('WINDOW_LAYOUT_DOCUMENT_SCOPE_CHANGED');
        break;
      }
      if (target.url && target.url !== 'about:blank')
        throw Error('WINDOW_LAYOUT_DOCUMENT_SCOPE_CHANGED');
      if (Date.now() >= deadline) throw Error('WINDOW_LAYOUT_DOCUMENT_TIMEOUT');
      await sleep(100);
      check();
    }
    const prevState = (await chrome.windows.get(tab.windowId)).state,
      win = await this.ensureNormalWindow(tab.windowId, check);
    if (prevState !== 'normal') {
      tab = await chrome.tabs.get(proof.tabId);
      check();
    }
    return TaskWindowSnapshot.parse({
      proof,
      windowId: tab.windowId,
      state: win.state,
      rect: { x: win.left, y: win.top, width: win.width, height: win.height },
      contentInsets: measureWindowContentInsets(win, tab, true),
    });
  }
  private trackPending<T>(op: Promise<T>, onFinally?: () => void): Promise<T> {
    this.pending.add(op);
    void op
      .finally(() => {
        this.pending.delete(op);
        onFinally?.();
      })
      .catch(() => {});
    return op;
  }
  private async applyWindowBounds(windowId: number, cur: Rect, target: Rect, focus: boolean) {
    await chrome.windows.update(windowId, {
      left: target.x,
      top: target.y,
      ...(target.width !== cur.width ? { width: target.width } : {}),
      ...(target.height !== cur.height ? { height: target.height } : {}),
      ...(focus ? { focused: true } : {}),
    });
  }
  private async finishWindowMove(
    windowId: number,
    cur: Rect,
    target: Rect,
    focus: boolean,
    check: () => void,
    readCurrent: () => Promise<{ cur: Rect; obs: unknown }>,
  ): Promise<unknown> {
    await this.applyWindowBounds(windowId, cur, target, focus);
    check();
    const res = await this.waitBounds(
      () => readCurrent(),
      (v) => confirmedMove(v.cur, target),
    );
    return res.obs;
  }
  private moveLightweight(
    windowId: number,
    bounds: WindowBounds,
    opts: { focus?: boolean; tabId?: number },
  ): Promise<LightweightMovedWindow> {
    const shouldFocus = Boolean(opts.focus),
      tabToken = opts.tabId && opts.tabId > 0 ? this.ensureTabToken(opts.tabId) : undefined,
      check = () => this.checkToken(opts.tabId, tabToken),
      toRect = (w: chrome.windows.Window): Rect => ({
        x: w.left ?? bounds.left,
        y: w.top ?? bounds.top,
        width: w.width ?? bounds.width,
        height: w.height ?? bounds.height,
      }),
      toMoved = (w: chrome.windows.Window, r: Rect): LightweightMovedWindow => ({
        windowId: w.id ?? windowId,
        focused: Boolean(w.focused),
        state: (w.state ?? 'normal') as TaskWindow['state'],
        bounds: { left: r.x, top: r.y, width: r.width, height: r.height },
      });
    return this.trackPending(
      (async () => {
        check();
        const win = await this.ensureNormalWindow(windowId, check, shouldFocus);
        if (opts.tabId && opts.tabId > 0) await this.activateTabIfNeeded(opts.tabId, check, true);
        const cur = toRect(win),
          target: Rect = {
            x: bounds.left,
            y: bounds.top,
            width: bounds.width,
            height: bounds.height,
          };
        if (!shouldFocus && confirmedMove(cur, target)) return toMoved(win, cur);
        const obs = (await this.finishWindowMove(windowId, cur, target, shouldFocus, check, () =>
          chrome.windows.get(windowId).then((w) => (check(), { cur: toRect(w), obs: w })),
        )) as chrome.windows.Window;
        return toMoved(obs, toRect(obs));
      })(),
    );
  }
  move(
    windowId: number,
    bounds: WindowBounds,
    options?: { focus?: boolean; tabId?: number },
  ): Promise<LightweightMovedWindow>;
  move(expected: TaskWindow, rect: Rect, guard: () => void, focus?: boolean): Promise<TaskWindow>;
  move(
    expectedOrWindowId: TaskWindow | number,
    rectOrBounds: Rect | WindowBounds,
    guardOrOptions?: (() => void) | { focus?: boolean; tabId?: number },
    focus = true,
  ): Promise<TaskWindow | LightweightMovedWindow> {
    markProgrammaticWindowMove(1500);
    if (typeof expectedOrWindowId === 'number')
      return this.moveLightweight(
        expectedOrWindowId,
        rectOrBounds as WindowBounds,
        typeof guardOrOptions === 'object' && guardOrOptions !== null ? guardOrOptions : {},
      );
    const expected = expectedOrWindowId,
      rect = rectOrBounds as Rect,
      rawGuard = typeof guardOrOptions === 'function' ? guardOrOptions : () => {},
      token = this.ensureTabToken(expected.proof.tabId),
      guard = () => this.checkToken(expected.proof.tabId, token, rawGuard);
    if (this.moving.has(expected.windowId))
      return Promise.reject(Error('WINDOW_LAYOUT_MOVE_PENDING'));
    this.moving.add(expected.windowId);
    return this.trackPending(
      (async () => {
        const current = await this.inspect(expected.proof, guard);
        if (current.windowId !== expected.windowId) throw Error('WINDOW_LAYOUT_WINDOW_CHANGED');
        await this.activateTabIfNeeded(expected.proof.tabId, guard);
        if (!focus && confirmedMove(current.rect, rect)) return current;
        await this.applyWindowBounds(current.windowId, current.rect, rect, focus);
        guard();
        const obs = await this.waitBounds(
          () => this.inspect(expected.proof, guard),
          (v) => v.windowId !== current.windowId || confirmedMove(v.rect, rect),
        );
        if (
          obs.windowId !== current.windowId ||
          (!confirmedMove(obs.rect, rect) && obs.state !== 'normal')
        )
          throw Error(
            `WINDOW_LAYOUT_MOVE_UNCONFIRMED:${JSON.stringify({ expected: rect, observed: obs.rect })}`,
          );
        return obs;
      })(),
      () => this.moving.delete(expected.windowId),
    );
  }
  drain = async () => {
    await Promise.allSettled([...this.pending]);
  };
}
