import type { TabProof } from '../src/shared/kernel-state.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import { TaskWindowSnapshot, type TaskWindow, type Rect } from '../src/shared/window-layout.js';
import { WorkspacePageGroup } from './workspace-page-group.js';
import { kernelAccessURL } from '../src/shared/kernel-policy.js';
import { markProgrammaticWindowMove } from './reveal-browser-window.js';

// Native frame rounding is harmless. Always return the actual bounds.
const confirmedMove = (actual: Rect, requested: Rect) =>
  (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(actual[key] - requested[key]) <= 4,
  );

export type WindowBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type WindowDisplayBounds = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type LightweightMovedWindow = {
  windowId: number;
  focused: boolean;
  state: TaskWindow['state'];
  bounds: WindowBounds;
};

export class TaskWindowController {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly moving = new Set<number>();
  private readonly tabTokens = new Map<number, { tabId: number; disposed: boolean }>();
  private ensureTabToken(tabId: number): { tabId: number; disposed: boolean } {
    const existing = this.tabTokens.get(tabId);
    if (existing && !existing.disposed) return existing;
    const token = { tabId, disposed: false };
    this.tabTokens.set(tabId, token);
    return token;
  }
  isTabActive(tabId: number, token: { tabId: number; disposed: boolean }): boolean {
    return !token.disposed && this.tabTokens.get(tabId) === token;
  }
  forgetTab(tabId: number): void {
    const token = this.tabTokens.get(tabId);
    if (token) {
      token.disposed = true;
      this.tabTokens.delete(tabId);
    }
  }
  screens(win?: chrome.windows.Window): WindowDisplayBounds[] {
    return [
      {
        id: 'default',
        left: win?.left ?? 0,
        top: win?.top ?? 0,
        width: Math.max(win?.width ?? 1280, 1280),
        height: Math.max(win?.height ?? 900, 900),
      },
    ];
  }
  async inspect(proof: TabProof, guard: () => void): Promise<TaskWindow> {
    const token = this.ensureTabToken(proof.tabId);
    const check = () => {
      guard();
      if (!this.isTabActive(proof.tabId, token)) throw Error('WINDOW_LAYOUT_REVOKED');
    };
    check();
    const main = await new WorkspacePageGroup().read(check);
    if (!main || !sameTabProof(main.proof, proof)) throw Error('WINDOW_LAYOUT_MAIN_CHANGED');
    const deadline = Date.now() + 5000;
    let tab: chrome.tabs.Tab;
    for (;;) {
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
      // The debugger target is the same native authority used by attach/adopt.
      // tabs.get().url is optional, particularly during initial navigation.
      if (kernelAccessURL(target.url, 'facebook-task')) {
        if (tab.url && tab.url !== 'about:blank' && !kernelAccessURL(tab.url, 'facebook-task'))
          throw Error('WINDOW_LAYOUT_DOCUMENT_SCOPE_CHANGED');
        break;
      }
      if (target.url && target.url !== 'about:blank')
        throw Error('WINDOW_LAYOUT_DOCUMENT_SCOPE_CHANGED');
      if (Date.now() >= deadline) throw Error('WINDOW_LAYOUT_DOCUMENT_TIMEOUT');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      check();
    }
    let win = await chrome.windows.get(tab.windowId);
    check();
    if (win.state === 'locked-fullscreen') throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
    if (win.state !== 'normal') {
      await chrome.windows.update(tab.windowId, { state: 'normal', focused: false });
      check();
      win = await chrome.windows.get(tab.windowId);
      check();
      tab = await chrome.tabs.get(proof.tabId);
      check();
    }
    // Native tabs dimensions are read without executing a suspended renderer.
    // Use an interior subset: the height difference includes browser chrome;
    // add padding on every side rather than treating a frame sliver as content.
    if (
      !Number.isFinite(tab.width) ||
      !Number.isFinite(tab.height) ||
      !win.width ||
      !win.height ||
      !tab.width ||
      !tab.height ||
      tab.width > win.width ||
      tab.height > win.height
    )
      throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
    const side = Math.ceil((win.width - tab.width) / 2) + 8;
    const contentInsets = {
      left: side,
      right: side,
      bottom: side,
      top: Math.max(80, win.height - tab.height) + 8,
    };
    if (win.width - side * 2 < 2 || win.height - contentInsets.top - side < 2)
      throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
    return TaskWindowSnapshot.parse({
      proof,
      windowId: tab.windowId,
      state: win.state,
      rect: { x: win.left, y: win.top, width: win.width, height: win.height },
      contentInsets,
    });
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
    if (typeof expectedOrWindowId === 'number') {
      const windowId = expectedOrWindowId;
      const bounds = rectOrBounds as WindowBounds;
      const opts =
        typeof guardOrOptions === 'object' && guardOrOptions !== null ? guardOrOptions : {};
      const shouldFocus = Boolean(opts.focus);
      const tabToken = opts.tabId && opts.tabId > 0 ? this.ensureTabToken(opts.tabId) : undefined;
      const checkTab = () => {
        if (opts.tabId && opts.tabId > 0 && tabToken && !this.isTabActive(opts.tabId, tabToken))
          throw Error('WINDOW_LAYOUT_REVOKED');
      };
      const operation = (async (): Promise<LightweightMovedWindow> => {
        checkTab();
        let win = await chrome.windows.get(windowId);
        checkTab();
        if (win.state === 'locked-fullscreen') throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
        if (win.state && win.state !== 'normal') {
          await chrome.windows.update(windowId, {
            state: 'normal',
            ...(shouldFocus ? {} : { focused: false }),
          });
          checkTab();
          win = await chrome.windows.get(windowId);
          checkTab();
        }
        if (opts.tabId && opts.tabId > 0) {
          const tab = await chrome.tabs.get(opts.tabId).catch(() => null);
          checkTab();
          if (tab && !tab.active) {
            await chrome.tabs.update(opts.tabId, { active: true }).catch(() => {});
            checkTab();
          }
        }
        const currentRect: Rect = {
          x: win.left ?? bounds.left,
          y: win.top ?? bounds.top,
          width: win.width ?? bounds.width,
          height: win.height ?? bounds.height,
        };
        const targetRect: Rect = {
          x: bounds.left,
          y: bounds.top,
          width: bounds.width,
          height: bounds.height,
        };
        if (!shouldFocus && confirmedMove(currentRect, targetRect)) {
          return {
            windowId,
            focused: Boolean(win.focused),
            state: (win.state ?? 'normal') as TaskWindow['state'],
            bounds: {
              left: currentRect.x,
              top: currentRect.y,
              width: currentRect.width,
              height: currentRect.height,
            },
          };
        }
        await chrome.windows.update(windowId, {
          left: bounds.left,
          top: bounds.top,
          ...(bounds.width !== currentRect.width ? { width: bounds.width } : {}),
          ...(bounds.height !== currentRect.height ? { height: bounds.height } : {}),
          ...(shouldFocus ? { focused: true } : {}),
        });
        checkTab();
        let observed = await chrome.windows.get(windowId);
        checkTab();
        const deadline = Date.now() + 350;
        while (
          !confirmedMove(
            {
              x: observed.left ?? bounds.left,
              y: observed.top ?? bounds.top,
              width: observed.width ?? bounds.width,
              height: observed.height ?? bounds.height,
            },
            targetRect,
          ) &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          checkTab();
          observed = await chrome.windows.get(windowId);
          checkTab();
        }
        return {
          windowId: observed.id ?? windowId,
          focused: Boolean(observed.focused),
          state: (observed.state ?? 'normal') as TaskWindow['state'],
          bounds: {
            left: observed.left ?? bounds.left,
            top: observed.top ?? bounds.top,
            width: observed.width ?? bounds.width,
            height: observed.height ?? bounds.height,
          },
        };
      })();
      this.pending.add(operation);
      void operation.finally(() => this.pending.delete(operation)).catch(() => {});
      return operation;
    }
    const expected = expectedOrWindowId;
    const rect = rectOrBounds as Rect;
    const rawGuard = typeof guardOrOptions === 'function' ? guardOrOptions : () => {};
    const token = this.ensureTabToken(expected.proof.tabId);
    const guard = () => {
      rawGuard();
      if (!this.isTabActive(expected.proof.tabId, token)) throw Error('WINDOW_LAYOUT_REVOKED');
    };
    if (this.moving.has(expected.windowId))
      return Promise.reject(Error('WINDOW_LAYOUT_MOVE_PENDING'));
    this.moving.add(expected.windowId);
    const operation = (async () => {
      const current = await this.inspect(expected.proof, guard);
      if (current.windowId !== expected.windowId) throw Error('WINDOW_LAYOUT_WINDOW_CHANGED');
      guard();
      const tab = await chrome.tabs.get(expected.proof.tabId);
      guard();
      if (!tab.active) await chrome.tabs.update(expected.proof.tabId, { active: true });
      guard();
      if (!focus && confirmedMove(current.rect, rect)) return current;
      await chrome.windows.update(current.windowId, {
        left: rect.x,
        top: rect.y,
        ...(rect.width !== current.rect.width ? { width: rect.width } : {}),
        ...(rect.height !== current.rect.height ? { height: rect.height } : {}),
        ...(focus ? { focused: true } : {}),
      });
      guard();
      let observed = await this.inspect(expected.proof, guard);
      // The native update acknowledgement can precede the completed Windows move.
      // Observe only; never re-dispatch movement while waiting for confirmation.
      const deadline = Date.now() + 350;
      while (
        observed.windowId === current.windowId &&
        !confirmedMove(observed.rect, rect) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        observed = await this.inspect(expected.proof, guard);
      }
      if (
        observed.windowId !== current.windowId ||
        (!confirmedMove(observed.rect, rect) && observed.state !== 'normal')
      )
        throw Error(
          'WINDOW_LAYOUT_MOVE_UNCONFIRMED:' +
            JSON.stringify({ expected: rect, observed: observed.rect }),
        );
      return observed;
    })();
    this.pending.add(operation);
    void operation
      .finally(() => {
        this.pending.delete(operation);
        this.moving.delete(expected.windowId);
      })
      .catch(() => {});
    return operation;
  }
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
}
