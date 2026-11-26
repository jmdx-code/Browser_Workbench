import { sameTabProof } from '../src/domain/task-tabs.js';
import {
  isWorkbenchTabGroupTitle,
  WORKBENCH_TAB_GROUP_COLOR,
  WORKBENCH_TAB_GROUP_TITLE,
  WorkspaceMainPage,
  type MainPage,
} from '../src/shared/workspace-page.js';
import { type TabProof } from '../src/shared/kernel-state.js';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function sha256Hex(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}
export async function withBoundedWait<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function isFacebookTab(tab: chrome.tabs.Tab): boolean {
  try {
    const url = new URL(tab.url ?? '');
    return url.protocol === 'https:' && /(^|\.)facebook\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}
export async function unminimizeWindow(
  windowId: number,
  guard?: () => void,
  focusWindow = false,
): Promise<chrome.windows.Window | null> {
  const win = await chrome.windows.get(windowId).catch(() => null);
  guard?.();
  if (win?.state === 'minimized') {
    await chrome.windows
      .update(windowId, focusWindow ? { state: 'normal' } : { state: 'normal', focused: false })
      .catch(() => {});
    guard?.();
  }
  return win;
}
export async function waitTabRevealed(
  tabId: number,
  windowId: number,
  focus: boolean,
  check?: () => void,
  timeoutMs = 1000,
): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    const [tab, win] = await Promise.all([chrome.tabs.get(tabId), chrome.windows.get(windowId)]);
    check?.();
    const focused = Boolean(win.focused);
    if (!focus && tab.windowId === windowId && tab.active) return focused;
    if (focus) {
      if (tab.windowId !== windowId || !tab.active) throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
      if (focused) return true;
    }
    if (Date.now() >= deadline) throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
    await sleep(50);
    check?.();
  }
}
const key = 'workbenchWorkspaceMainPageV1';
const sameProof = (a: TabProof | null | undefined, b: TabProof | null | undefined) =>
  Boolean(a && b && sameTabProof(a, b));
function pickCanonicalGroup(
  groups: readonly chrome.tabGroups.TabGroup[],
  preferredGroupId?: number,
) {
  return (
    (preferredGroupId !== undefined ? groups.find((g) => g.id === preferredGroupId) : undefined) ??
    groups.find((g) => g.title?.trim() === WORKBENCH_TAB_GROUP_TITLE) ??
    groups[0]
  );
}
async function normalizeGroupPresentation(
  group: { id: number; title?: string; color?: string },
  check?: () => void,
): Promise<void> {
  if (group.title !== WORKBENCH_TAB_GROUP_TITLE || group.color !== WORKBENCH_TAB_GROUP_COLOR) {
    await chrome.tabGroups.update(group.id, {
      title: WORKBENCH_TAB_GROUP_TITLE,
      color: WORKBENCH_TAB_GROUP_COLOR,
    });
    check?.();
  }
}
export async function consolidateOpenWorkbenchGroups(
  preferred?: { windowId: number; groupId?: number },
  check?: () => void,
): Promise<number | undefined> {
  if (typeof chrome === 'undefined' || typeof chrome.tabGroups?.query !== 'function')
    return preferred?.groupId;
  check?.();
  const workbenchGroups = (await chrome.tabGroups.query({})).filter((g) =>
    isWorkbenchTabGroupTitle(g.title),
  );
  check?.();
  if (!workbenchGroups.length) return undefined;
  let storedGroupId: number | undefined;
  if (!preferred && typeof chrome.storage?.local?.get === 'function') {
    try {
      const raw = (await chrome.storage.local.get(key))[key];
      check?.();
      if (raw !== undefined) storedGroupId = WorkspaceMainPage.parse(raw).groupId;
    } catch {
      storedGroupId = undefined;
    }
  }
  const canonical = preferred
    ? pickCanonicalGroup(
        workbenchGroups.filter((g) => g.windowId === preferred.windowId),
        preferred.groupId,
      )
    : pickCanonicalGroup(workbenchGroups, storedGroupId);
  if (!canonical) return undefined;
  await normalizeGroupPresentation(canonical, check);
  if (typeof chrome.tabs?.query !== 'function') return canonical.id;
  for (const dup of workbenchGroups) {
    if (dup.id === canonical.id) continue;
    check?.();
    const dupTabs = await chrome.tabs.query({ groupId: dup.id }).catch(() => null);
    check?.();
    const tabIds = (dupTabs ?? [])
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number' && id >= 0);
    if (!tabIds.length) continue;
    try {
      if (dup.windowId === canonical.windowId)
        await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId: canonical.id });
      else if (typeof chrome.tabs.ungroup === 'function')
        await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
      else continue;
      check?.();
    } catch {}
  }
  return canonical.id;
}
export class WorkspacePageGroup {
  private tail: Promise<unknown> = Promise.resolve();
  private async current(proof: TabProof, check: () => void) {
    check();
    const [tab, targets] = await Promise.all([
      chrome.tabs.get(proof.tabId),
      chrome.debugger.getTargets(),
    ]);
    check();
    if (
      tab.id !== proof.tabId ||
      !targets.some((t) => t.type === 'page' && t.tabId === proof.tabId && t.id === proof.targetId)
    )
      throw Error('WORKSPACE_MAIN_TARGET_CHANGED');
    return tab;
  }
  private async reuseOrCreateGroup(
    tab: chrome.tabs.Tab,
    tabId: number,
    preferredGroupId: number | undefined,
    check: () => void,
  ): Promise<number> {
    let groupId: number | undefined;
    if (typeof chrome.tabGroups?.query === 'function') {
      const sameWindow = (await chrome.tabGroups.query({})).filter(
        (g) => g.windowId === tab.windowId && isWorkbenchTabGroupTitle(g.title),
      );
      check();
      const has = (id?: number) => id !== undefined && sameWindow.some((g) => g.id === id),
        existing = pickCanonicalGroup(
          sameWindow,
          has(preferredGroupId) ? preferredGroupId : has(tab.groupId) ? tab.groupId : undefined,
        );
      if (existing) {
        if (tab.groupId !== existing.id) {
          await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id });
          check();
        }
        await normalizeGroupPresentation(existing, check);
        groupId = existing.id;
      }
    }
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      check();
      await normalizeGroupPresentation({ id: groupId }, check);
    }
    await consolidateOpenWorkbenchGroups({ windowId: tab.windowId, groupId }, check);
    return groupId;
  }
  async read(check: () => void): Promise<MainPage | null> {
    check();
    const raw = (await chrome.storage.local.get(key))[key];
    check();
    return raw === undefined ? null : WorkspaceMainPage.parse(raw);
  }
  async rebind(previous: TabProof, proof: TabProof, check: () => void): Promise<void> {
    const old = await this.read(check);
    if (
      !old ||
      !sameProof(old.proof, previous) ||
      previous.profileId !== proof.profileId ||
      previous.tabId !== proof.tabId ||
      previous.targetId !== proof.targetId
    )
      throw Error('WORKSPACE_MAIN_REBIND_REJECTED');
    const group = await this.ensure(previous, check);
    await this.current(proof, check);
    await chrome.storage.local.set({ [key]: WorkspaceMainPage.parse({ ...group, proof }) });
    check();
  }
  async registerCreated(proof: TabProof, check: () => void): Promise<MainPage> {
    const old = await this.read(check);
    if (!old || sameProof(old.proof, proof)) return this.ensure(proof, check);
    const targets = await chrome.debugger.getTargets();
    check();
    if (!targets.some((t) => t.tabId === old.proof.tabId && t.id === old.proof.targetId))
      return this.ensure(proof, check);
    const main = await this.ensure(old.proof, check),
      child = await this.current(proof, check);
    if (
      proof.profileId !== main.proof.profileId ||
      proof.browserSessionEpoch !== main.proof.browserSessionEpoch ||
      child.windowId !== main.windowId
    )
      throw Error('WORKSPACE_CHILD_WINDOW_CHANGED');
    await chrome.tabs.group({ tabIds: [proof.tabId], groupId: main.groupId });
    check();
    const observed = await this.current(proof, check);
    if (observed.groupId !== main.groupId || observed.windowId !== main.windowId)
      throw Error('WORKSPACE_CHILD_GROUP_CHANGED');
    return main;
  }
  private bindMainGroup(
    proof: TabProof,
    check: () => void,
    rejectExisting: boolean,
  ): Promise<MainPage> {
    const run = this.tail
      .catch(() => {})
      .then(async () => {
        const old = await this.read(check);
        if (rejectExisting && old && !sameProof(old.proof, proof)) {
          const targets = await chrome.debugger.getTargets();
          check();
          if (
            old.proof.profileId === proof.profileId &&
            targets.some((t) => t.tabId === old.proof.tabId && t.id === old.proof.targetId)
          )
            throw Error('WORKSPACE_MAIN_ALREADY_EXISTS');
        }
        const tab = await this.current(proof, check),
          keep =
            old &&
            old.windowId === tab.windowId &&
            old.groupId === tab.groupId &&
            (rejectExisting ? sameProof(old.proof, proof) : tab.groupId >= 0),
          groupId = keep
            ? (await consolidateOpenWorkbenchGroups(
                { windowId: tab.windowId, groupId: old.groupId },
                check,
              ),
              old.groupId)
            : await this.reuseOrCreateGroup(
                tab,
                proof.tabId,
                old && old.windowId === tab.windowId ? old.groupId : undefined,
                check,
              );
        const observed = await this.current(proof, check);
        if (observed.groupId !== groupId || observed.windowId !== tab.windowId)
          throw Error('WORKSPACE_MAIN_GROUP_CHANGED');
        const next = WorkspaceMainPage.parse({
          version: 1,
          proof,
          windowId: tab.windowId,
          groupId,
        });
        await chrome.storage.local.set({ [key]: next });
        check();
        return next;
      });
    this.tail = run;
    return run;
  }
  ensure = (proof: TabProof, check: () => void) => this.bindMainGroup(proof, check, true);
  forceBindMain = (proof: TabProof, check: () => void) => this.bindMainGroup(proof, check, false);
}
