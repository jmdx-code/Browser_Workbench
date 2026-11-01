import { WorkspacePageGroup } from './workspace-page-group.js';
import {
  TaskWindowController,
  type WindowBounds,
  type WindowDisplayBounds,
} from './task-window-controller.js';

let lastUserFocusedAt = 0;
let programmaticMoveSuppressUntil = 0;

export function markProgrammaticWindowMove(durationMs = 1500): void {
  programmaticMoveSuppressUntil = Math.max(programmaticMoveSuppressUntil, Date.now() + durationMs);
}

export function isProgrammaticWindowMoveActive(): boolean {
  return Date.now() < programmaticMoveSuppressUntil;
}

export function recordUserWindowFocus(ts = Date.now()): void {
  if (isProgrammaticWindowMoveActive()) return;
  if (ts > lastUserFocusedAt) lastUserFocusedAt = ts;
}

export function getLastUserFocusedAt(): number {
  return lastUserFocusedAt;
}

function isFacebookTab(tab: chrome.tabs.Tab): boolean {
  try {
    const url = new URL(tab.url ?? '');
    return url.protocol === 'https:' && /(^|\.)facebook\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export async function resolveTargetWindow(): Promise<{
  win: chrome.windows.Window & { id: number };
  tab?: chrome.tabs.Tab;
  registeredTabId?: number;
}> {
  const registered = await new WorkspacePageGroup().read(() => {}).catch(() => null);
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  const main = tabs.find((t) => t.id === registered?.proof.tabId);
  const facebook = tabs.find(isFacebookTab);
  const tab = main ?? facebook ?? tabs.find((t) => t.active) ?? tabs[0];
  let win: chrome.windows.Window | undefined;
  if (tab?.windowId !== undefined) {
    win = await chrome.windows.get(tab.windowId).catch(() => undefined);
  }
  if (!win || win.id === undefined || (win.type && win.type !== 'normal')) {
    const allNormal =
      typeof chrome.windows.getAll === 'function'
        ? await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])
        : [];
    win = allNormal.find((w) => w.focused) ?? allNormal[0] ?? win;
  }
  if (!win || win.id === undefined) throw Error('WINDOW_LAYOUT_NO_WINDOW');
  return {
    win: win as chrome.windows.Window & { id: number },
    tab,
    registeredTabId: registered?.proof.tabId,
  };
}

function measureContentInsets(
  win: chrome.windows.Window,
  tab?: chrome.tabs.Tab,
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
    const side = Math.ceil((win.width - tab.width) / 2) + 8;
    const top = Math.max(80, win.height - tab.height) + 8;
    if (win.width - side * 2 >= 2 && win.height - top - side >= 2) {
      return { left: side, right: side, bottom: side, top };
    }
  }
  return { left: 16, top: 104, right: 16, bottom: 16 };
}

export async function inspectBrowserWindow(): Promise<{
  windowId: number;
  tabId: number;
  focused: boolean;
  lastFocusedAt: number;
  state: string;
  bounds: WindowBounds;
  contentInsets: { left: number; top: number; right: number; bottom: number };
  displays: WindowDisplayBounds[];
}> {
  let { win, tab, registeredTabId } = await resolveTargetWindow();
  if (win.state === 'locked-fullscreen') throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
  if (win.state && win.state !== 'normal') {
    await chrome.windows.update(win.id, { state: 'normal' });
    const updated = await chrome.windows.get(win.id);
    win = { ...updated, id: updated.id ?? win.id };
    if (tab?.id !== undefined) {
      tab = await chrome.tabs.get(tab.id).catch(() => tab);
    }
  }
  const focused = Boolean(win.focused);
  if (focused && !isProgrammaticWindowMoveActive()) {
    recordUserWindowFocus(Date.now());
  }
  const bounds: WindowBounds = {
    left: win.left ?? 0,
    top: win.top ?? 0,
    width: win.width ?? 1000,
    height: win.height ?? 800,
  };
  const controller = new TaskWindowController();
  const displays = controller.screens(win);
  return {
    windowId: win.id,
    tabId: tab?.id ?? registeredTabId ?? 1,
    focused,
    lastFocusedAt: getLastUserFocusedAt(),
    state: win.state ?? 'normal',
    bounds,
    contentInsets: measureContentInsets(win, tab),
    displays,
  };
}

export async function positionBrowserWindow(
  bounds: WindowBounds,
  focus = false,
): Promise<{
  windowId: number;
  tabId: number;
  focused: boolean;
  state: string;
  bounds: WindowBounds;
  contentInsets: { left: number; top: number; right: number; bottom: number };
}> {
  markProgrammaticWindowMove(1500);
  const { win, tab, registeredTabId } = await resolveTargetWindow();
  const tabId = tab?.id ?? registeredTabId ?? 1;
  const controller = new TaskWindowController();
  const moved = await controller.move(win.id, bounds, { focus, tabId });
  const latestTab =
    tab?.id !== undefined ? await chrome.tabs.get(tab.id).catch(() => tab) : undefined;
  return {
    windowId: moved.windowId,
    tabId,
    focused: Boolean(moved.focused),
    state: moved.state ?? 'normal',
    bounds: moved.bounds,
    contentInsets: measureContentInsets(
      {
        id: moved.windowId,
        left: moved.bounds.left,
        top: moved.bounds.top,
        width: moved.bounds.width,
        height: moved.bounds.height,
        focused: moved.focused,
        incognito: false,
        alwaysOnTop: false,
      },
      latestTab,
    ),
  };
}

// Window presentation only: no navigation, task inputs, journal mutation or ownership claim.
export async function revealBrowserWindow(): Promise<{ tabId: number; focused: true }> {
  const registered = await new WorkspacePageGroup().read(() => {}).catch(() => null);
  const tabs = await chrome.tabs.query({});
  const main = tabs.find((tab) => tab.id === registered?.proof.tabId);
  const facebook = tabs.find((tab) => {
    try {
      const url = new URL(tab.url ?? '');
      return url.protocol === 'https:' && /(^|\.)facebook\.com$/.test(url.hostname);
    } catch {
      return false;
    }
  });
  const tab = main ?? facebook ?? tabs.find((tab) => tab.active) ?? tabs[0];
  if (tab?.id === undefined) throw Error('WORKSPACE_REVEAL_NO_WINDOW');
  const window = await chrome.windows.get(tab.windowId);
  if (window.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const deadline = Date.now() + 1000;
  do {
    const current = await chrome.tabs.get(tab.id);
    const observed = await chrome.windows.get(tab.windowId);
    if (current.active && current.windowId === tab.windowId && observed.focused) {
      lastUserFocusedAt = Date.now();
      return { tabId: tab.id, focused: true };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
}

export async function cleanupExtraTabs(
  preferActiveTab = true,
  legacyOwnedTabIds: ReadonlySet<number> = new Set(),
): Promise<{
  keptTabId: number;
  closedTabIds: number[];
  remainingTabCount: number;
}> {
  const registered = await new WorkspacePageGroup().read(() => {}).catch(() => null);
  const [tabs, targets] = await Promise.all([
    chrome.tabs.query({}),
    typeof chrome.debugger?.getTargets === 'function'
      ? chrome.debugger.getTargets().catch(() => [])
      : Promise.resolve([]),
  ]);
  const attachedTabIds = new Set<number>();
  for (const t of targets) {
    if (t.attached && typeof t.tabId === 'number') attachedTabIds.add(t.tabId);
  }
  const isFbTab = (tab: chrome.tabs.Tab) => {
    try {
      const url = new URL(tab.url ?? '');
      return url.protocol === 'https:' && /(^|\.)facebook\.com$/i.test(url.hostname);
    } catch {
      return false;
    }
  };
  let keepTab: chrome.tabs.Tab | undefined;
  if (preferActiveTab) {
    keepTab = tabs.find((tab) => tab.active && tab.id !== undefined && isFbTab(tab));
  }
  if (!keepTab && attachedTabIds.size > 0) {
    keepTab = tabs.find((tab) => tab.id !== undefined && attachedTabIds.has(tab.id));
  }
  if (!keepTab && registered?.proof.tabId !== undefined) {
    keepTab = tabs.find((tab) => tab.id === registered.proof.tabId);
  }
  if (!keepTab && legacyOwnedTabIds.size > 0) {
    keepTab = tabs.find((tab) => tab.id !== undefined && legacyOwnedTabIds.has(tab.id));
  }
  if (!keepTab) {
    keepTab =
      tabs.find((tab) => tab.active && tab.id !== undefined && isFbTab(tab)) ??
      tabs.find((tab) => tab.id !== undefined && isFbTab(tab));
  }
  let keepTabId = keepTab?.id;
  if (keepTabId === undefined) {
    const fallback =
      tabs.find((tab) => tab.active && tab.id !== undefined) ??
      tabs.find((tab) => tab.id !== undefined);
    if (fallback?.id !== undefined) {
      keepTabId = fallback.id;
      await chrome.tabs.update(keepTabId, { url: 'https://www.facebook.com/', active: true });
    } else {
      const created = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true });
      if (created.id === undefined) throw Error('WORKSPACE_CLEANUP_CREATE_FAILED');
      keepTabId = created.id;
    }
  }
  const closedTabIds: number[] = [];
  for (const tab of tabs) {
    if (
      tab.id !== undefined &&
      tab.id !== keepTabId &&
      !attachedTabIds.has(tab.id) &&
      !legacyOwnedTabIds.has(tab.id)
    ) {
      try {
        await chrome.tabs.remove(tab.id);
        closedTabIds.push(tab.id);
      } catch {
        // Ignore already-closed tab
      }
    }
  }
  const remaining = await chrome.tabs.query({}).catch(() => []);
  return {
    keptTabId: keepTabId,
    closedTabIds,
    remainingTabCount: Math.max(1, remaining.length),
  };
}
