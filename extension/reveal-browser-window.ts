import { WorkspacePageGroup } from './workspace-page-group.js';

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
    if (current.active && current.windowId === tab.windowId && observed.focused)
      return { tabId: tab.id, focused: true };
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
}
