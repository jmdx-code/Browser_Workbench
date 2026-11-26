import {
  consolidateOpenWorkbenchGroups,
  isFacebookTab,
  sleep,
  unminimizeWindow,
  waitTabRevealed,
  WorkspacePageGroup,
} from './workspace-page-group.js';
import {
  getLastUserFocusedAt,
  isProgrammaticWindowMoveActive,
  markProgrammaticWindowMove,
  measureWindowContentInsets,
  recordUserWindowFocus,
  setLastUserFocusedAt,
  TaskWindowController,
  type WindowBounds,
  type WindowDisplayBounds,
} from './task-window-controller.js';
export {
  getLastUserFocusedAt,
  isProgrammaticWindowMoveActive,
  markProgrammaticWindowMove,
  recordUserWindowFocus,
};
const readRegisteredMain = () => new WorkspacePageGroup().read(() => {}).catch(() => null);
const pickPrimaryTab = (tabs: readonly chrome.tabs.Tab[], registeredTabId?: number) =>
  tabs.find((t) => t.id === registeredTabId) ??
  tabs.find(isFacebookTab) ??
  tabs.find((t) => t.active) ??
  tabs[0];
async function resolveTargetWindow(): Promise<{
  win: chrome.windows.Window & { id: number };
  tab?: chrome.tabs.Tab;
  registeredTabId?: number;
}> {
  const [registered, tabs] = await Promise.all([
      readRegisteredMain(),
      chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]),
    ]),
    tab = pickPrimaryTab(tabs, registered?.proof.tabId);
  let win =
    tab?.windowId !== undefined
      ? await chrome.windows.get(tab.windowId).catch(() => undefined)
      : undefined;
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
  const { win, tab, registeredTabId } = await resolveTargetWindow();
  if (win.state === 'locked-fullscreen') throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
  const focused = Boolean(win.focused);
  if (focused && !isProgrammaticWindowMoveActive()) recordUserWindowFocus(Date.now());
  return {
    windowId: win.id,
    tabId: tab?.id ?? registeredTabId ?? 1,
    focused,
    lastFocusedAt: getLastUserFocusedAt(),
    state: win.state ?? 'normal',
    bounds: {
      left: win.left ?? 0,
      top: win.top ?? 0,
      width: win.width ?? 1000,
      height: win.height ?? 800,
    },
    contentInsets: measureWindowContentInsets(win, tab),
    displays: new TaskWindowController().screens(win),
  };
}
export async function positionBrowserWindow(bounds: WindowBounds, focus = false) {
  markProgrammaticWindowMove(1500);
  const { win, tab, registeredTabId } = await resolveTargetWindow(),
    tabId = tab?.id ?? registeredTabId ?? 1,
    moved = await new TaskWindowController().move(win.id, bounds, { focus, tabId }),
    latestTab = tab?.id !== undefined ? await chrome.tabs.get(tab.id).catch(() => tab) : undefined;
  return {
    windowId: moved.windowId,
    tabId,
    focused: Boolean(moved.focused),
    state: moved.state ?? 'normal',
    bounds: moved.bounds,
    contentInsets: measureWindowContentInsets(
      { width: moved.bounds.width, height: moved.bounds.height },
      latestTab,
    ),
  };
}
// Window presentation only: no navigation, task inputs, journal mutation or ownership claim.
export async function revealBrowserWindow(): Promise<{ tabId: number; focused: true }> {
  const registered = await readRegisteredMain(),
    tab = pickPrimaryTab(await chrome.tabs.query({}), registered?.proof.tabId);
  if (tab?.id === undefined) throw Error('WORKSPACE_REVEAL_NO_WINDOW');
  await unminimizeWindow(tab.windowId, undefined, true);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await waitTabRevealed(tab.id, tab.windowId, true);
  setLastUserFocusedAt(Date.now());
  return { tabId: tab.id, focused: true };
}
export async function cleanupExtraTabs(
  preferActiveTab = true,
  legacyOwnedTabIds: ReadonlySet<number> = new Set(),
): Promise<{ keptTabId: number; closedTabIds: number[]; remainingTabCount: number }> {
  const [registered, tabs, targets] = await Promise.all([
      readRegisteredMain(),
      chrome.tabs.query({}),
      typeof chrome.debugger?.getTargets === 'function'
        ? chrome.debugger.getTargets().catch(() => [])
        : Promise.resolve([]),
    ]),
    attachedTabIds = new Set(
      targets
        .filter((t) => t.attached && typeof t.tabId === 'number')
        .map((t) => t.tabId as number),
    ),
    hasId = (t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number } => t.id !== undefined,
    fbActive = () => tabs.find((t) => hasId(t) && t.active && isFacebookTab(t)),
    keepTab =
      (preferActiveTab ? fbActive() : undefined) ??
      (attachedTabIds.size > 0
        ? tabs.find((t) => hasId(t) && attachedTabIds.has(t.id))
        : undefined) ??
      (registered?.proof.tabId !== undefined
        ? tabs.find((t) => t.id === registered.proof.tabId)
        : undefined) ??
      (legacyOwnedTabIds.size > 0
        ? tabs.find((t) => hasId(t) && legacyOwnedTabIds.has(t.id))
        : undefined) ??
      fbActive() ??
      tabs.find((t) => hasId(t) && isFacebookTab(t));
  let keepTabId = keepTab?.id;
  if (keepTabId === undefined) {
    const fallback = tabs.find((t) => hasId(t) && t.active) ?? tabs.find(hasId);
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
      tab.id === undefined ||
      tab.id === keepTabId ||
      attachedTabIds.has(tab.id) ||
      legacyOwnedTabIds.has(tab.id)
    )
      continue;
    try {
      await chrome.tabs.remove(tab.id);
      closedTabIds.push(tab.id);
    } catch {}
  }
  await consolidateOpenWorkbenchGroups().catch(() => {});
  const remaining = await chrome.tabs.query({}).catch(() => []);
  return { keptTabId: keepTabId, closedTabIds, remainingTabCount: Math.max(1, remaining.length) };
}
export async function closeProfileWindows(): Promise<{
  closedCount: number;
  remainingCount: number;
}> {
  const allWindows =
    typeof chrome.windows?.getAll === 'function' ? await chrome.windows.getAll({}) : [];
  let closedCount = 0;
  for (const win of allWindows) {
    if (win.id === undefined) continue;
    try {
      await chrome.windows.remove(win.id);
      closedCount++;
    } catch {}
  }
  let remainingCount = 0;
  if (typeof chrome.windows?.getAll === 'function') {
    for (const deadline = Date.now() + 900; ;) {
      remainingCount = (
        await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] }).catch(() => [])
      ).length;
      if (remainingCount === 0 || Date.now() >= deadline) break;
      await sleep(80);
    }
  }
  return { closedCount, remainingCount };
}
