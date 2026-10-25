import { WorkspaceMainPage, type MainPage } from '../src/shared/workspace-page.js';
import { type TabProof } from '../src/shared/kernel-state.js';

const key = 'workbenchWorkspaceMainPageV1';
const sameProof = (a: TabProof, b: TabProof) =>
  a.ownershipId === b.ownershipId &&
  a.profileId === b.profileId &&
  a.browserSessionEpoch === b.browserSessionEpoch &&
  a.tabId === b.tabId &&
  a.targetId === b.targetId;

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
      !targets.some(
        (target) =>
          target.type === 'page' && target.tabId === proof.tabId && target.id === proof.targetId,
      )
    )
      throw Error('WORKSPACE_MAIN_TARGET_CHANGED');
    return tab;
  }
  async read(check: () => void): Promise<MainPage | null> {
    check();
    const raw = (await chrome.storage.local.get(key))[key];
    check();
    if (raw === undefined) return null;
    return WorkspaceMainPage.parse(raw);
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
    if (
      !targets.some(
        (target) => target.tabId === old.proof.tabId && target.id === old.proof.targetId,
      )
    )
      return this.ensure(proof, check);
    const main = await this.ensure(old.proof, check);
    const child = await this.current(proof, check);
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
  ensure(proof: TabProof, check: () => void): Promise<MainPage> {
    const run = this.tail
      .catch(() => {})
      .then(async () => {
        const old = await this.read(check);
        if (old && !sameProof(old.proof, proof)) {
          // A second owned page is not silently promoted while the original main exists.
          const targets = await chrome.debugger.getTargets();
          check();
          if (
            old.proof.profileId === proof.profileId &&
            targets.some(
              (target) => target.tabId === old.proof.tabId && target.id === old.proof.targetId,
            )
          )
            throw Error('WORKSPACE_MAIN_ALREADY_EXISTS');
        }
        const tab = await this.current(proof, check);
        let groupId =
          old &&
          sameProof(old.proof, proof) &&
          old.windowId === tab.windowId &&
          old.groupId === tab.groupId
            ? old.groupId
            : undefined;
        if (groupId === undefined) {
          // Group only the exactly registered main, never matching names or arbitrary tabs.
          groupId = await chrome.tabs.group({ tabIds: [proof.tabId] });
          check();
          await chrome.tabGroups.update(groupId, { title: 'Browser Workbench', color: 'grey' });
          check();
        }
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
  forceBindMain(proof: TabProof, check: () => void): Promise<MainPage> {
    const run = this.tail
      .catch(() => {})
      .then(async () => {
        const old = await this.read(check);
        const tab = await this.current(proof, check);
        let groupId =
          old && old.windowId === tab.windowId && old.groupId === tab.groupId && tab.groupId >= 0
            ? old.groupId
            : undefined;
        if (groupId === undefined) {
          groupId = await chrome.tabs.group({ tabIds: [proof.tabId] });
          check();
          await chrome.tabGroups.update(groupId, { title: 'Browser Workbench', color: 'grey' });
          check();
        }
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
}
