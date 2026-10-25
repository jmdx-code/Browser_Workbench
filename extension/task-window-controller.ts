import type { TabProof } from '../src/shared/kernel-state.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import { TaskWindowSnapshot, type TaskWindow, type Rect } from '../src/shared/window-layout.js';
import { WorkspacePageGroup } from './workspace-page-group.js';
import { kernelAccessURL } from '../src/shared/kernel-policy.js';

// Native frame rounding is harmless. Always return the actual bounds.
const confirmedMove = (actual: Rect, requested: Rect) =>
  (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(actual[key] - requested[key]) <= 4,
  );

export class TaskWindowController {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly moving = new Set<number>();
  async inspect(proof: TabProof, guard: () => void): Promise<TaskWindow> {
    guard();
    const main = await new WorkspacePageGroup().read(guard);
    if (!main || !sameTabProof(main.proof, proof)) throw Error('WINDOW_LAYOUT_MAIN_CHANGED');
    const deadline = Date.now() + 5000;
    let tab: chrome.tabs.Tab;
    for (;;) {
      const [currentTab, targets] = await Promise.all([
        chrome.tabs.get(proof.tabId),
        chrome.debugger.getTargets(),
      ]);
      guard();
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
    }
    let win = await chrome.windows.get(tab.windowId);
    guard();
    if (win.state === 'locked-fullscreen') throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
    if (win.state !== 'normal') {
      await chrome.windows.update(tab.windowId, { state: 'normal' });
      guard();
      win = await chrome.windows.get(tab.windowId);
      guard();
      tab = await chrome.tabs.get(proof.tabId);
      guard();
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
  move(expected: TaskWindow, rect: Rect, guard: () => void, focus = true): Promise<TaskWindow> {
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
      const deadline = Date.now() + 1000;
      while (
        observed.windowId === current.windowId &&
        !confirmedMove(observed.rect, rect) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        observed = await this.inspect(expected.proof, guard);
      }
      if (observed.windowId !== current.windowId || !confirmedMove(observed.rect, rect))
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
