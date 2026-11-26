import type { KernelJournal } from '../src/application/kernel-journal.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import { kernelAccessURL, type KernelAccess } from '../src/shared/kernel-policy.js';
import type {
  KernelBackend,
  KernelJsonObject,
  KernelTarget,
} from '../src/shared/kernel-protocol.js';
import { OwnedTabProof, type TabProof } from '../src/shared/kernel-state.js';
import type { PageProjectionRequest } from '../src/shared/page-read.js';
import type { PresentationRecoveryDecision } from '../src/shared/presentation-recovery.js';
import type { Binding } from '../src/shared/task-execution.js';
import {
  armTaskPresentationHelper,
  attachDebuggerTarget,
  detachDebuggerTarget,
  handleClosingDialog,
  isBenignDetachError,
  maintainPresentationHelper,
  revealOwnedPageHelper,
  sendCdpCommand,
  type KernelCdpContext,
  type PresentationState,
} from './kernel-cdp-client.js';
import {
  consolidateWorkspaceTabs,
  inspectWorkspaceInventory,
  isReadyTabRecord,
  observeTabIdentity,
  projectTabPage,
  recoverOwnedTabToHome,
} from './kernel-page-projection.js';
import { kernelJournal } from './kernel-storage.js';
import { TaskRendering } from './task-rendering.js';
import { sleep, withBoundedWait, WorkspacePageGroup } from './workspace-page-group.js';
export { isBenignDetachError };
export interface KernelNativeBackend extends KernelBackend {
  owns(tabId: number): boolean;
  detached(tabId: number): void;
  expectedDetach(tabId: number): boolean;
  isExpectedDetach?(tabId: number): boolean;
  expectedRemoval?(tabId: number): boolean;
  inventory?(): Promise<unknown>;
  closingDialog?(source: KernelTarget, method: string, value: unknown): Promise<void>;
  consumeRendering?(source: KernelTarget, method: string, value: unknown): boolean;
  rendering?: TaskRendering;
  releaseRendering?(tabId?: number, timeoutMs?: number): Promise<boolean>;
  forgetRendering?(tabId?: number): void;
  maintainPresentation?(): void;
  setPresentationRecoveryGate?(
    gate: (proof: TabProof, positionOnly?: boolean) => Promise<PresentationRecoveryDecision>,
  ): void;
  setPresentationObserver?(observer: (proof: TabProof, state: KernelJsonObject) => void): void;
  armTaskPresentation?(proof: TabProof): Promise<void>;
  setWindowExposure?(proof: TabProof, exposed: boolean): Promise<void>;
  adopt?(proof: TabProof): Promise<void>;
  revealOwnedPage?(proof: TabProof, focus?: boolean): Promise<{ tabId: number; focused: boolean }>;
  consolidateWorkspace?(
    preferActiveTab?: boolean,
  ): Promise<{ proof: TabProof; url: string; closedTabIds: number[]; remainingTabCount: number }>;
  recoverTabToHome?(
    proof: TabProof,
  ): Promise<{ proof: TabProof; url: string; targetChanged: boolean }>;
  tabRemoved?(tabId: number): void;
}
export class ChromeKernelBackend implements KernelNativeBackend {
  private exposedWindow?: TabProof;
  private presentation?: PresentationState;
  private recoverPresentation?: (
    proof: TabProof,
    positionOnly?: boolean,
  ) => Promise<PresentationRecoveryDecision>;
  private presentationObserver?: (proof: TabProof, state: KernelJsonObject) => void;
  private presenting?: Promise<void>;
  private readonly workspaceGroup = new WorkspacePageGroup();
  private readonly owned = new Map<number, TabProof>();
  private readonly attached = new Map<number, string>();
  private readonly expectedDetaches = new Set<number>();
  private readonly expectedRemovals = new Set<number>();
  private readonly identityReadTabs = new Set<number>();
  private readonly removingUntil = new Map<number, number>();
  private readonly removalDialogs = new Set<number>();
  private identityReadPending = false;
  readonly rendering = new TaskRendering((t, m, p) => chrome.debugger.sendCommand(t, m, p), {
    forgetTab: (tabId) => this.windows?.forgetTab?.(tabId),
  });
  constructor(
    private readonly journal: KernelJournal = kernelJournal,
    private readonly allowInput: () => boolean = () => false,
    private readonly access: KernelAccess = 'fixture',
    private readonly allowRead: () => boolean = () => false,
    private readonly currentOperation: () => Binding | undefined = () => undefined,
    private readonly presentationNow: () => number = performance.now.bind(performance),
    private readonly windows?: { forgetTab?(tabId: number): void },
  ) {}
  private isExposed = (proof: TabProof) =>
    !!this.exposedWindow && sameTabProof(this.exposedWindow, proof);
  private clearTabPresentation = (tabId: number) => {
    if (this.presentation?.proof.tabId === tabId) this.presentation = undefined;
  };
  private cdpCtx(): KernelCdpContext {
    return {
      access: this.access,
      journal: this.journal,
      owned: this.owned,
      attached: this.attached,
      rendering: this.rendering,
      expectedDetaches: this.expectedDetaches,
      expectedRemovals: this.expectedRemovals,
      allowRead: () => this.allowRead(),
      currentOperation: () => this.currentOperation(),
      clearTabPresentation: this.clearTabPresentation,
      scope: (tabId: number) => this.scope(tabId),
      workspaceGroup: this.workspaceGroup,
      identityReadTabs: this.identityReadTabs,
      isIdentityReadPending: () => this.identityReadPending,
      setIdentityReadPending: (v) => (this.identityReadPending = v),
      removingUntil: this.removingUntil,
      removalDialogs: this.removalDialogs,
      allowInput: () => this.allowInput(),
      sameProfileForeground: () => this.sameProfileForeground(),
      isExposed: this.isExposed,
      ensurePresentation: (proof) => {
        if (this.presentation?.proof !== proof) this.presentation = { proof, checkedAt: -Infinity };
      },
      clearExposedIfTab: (tabId) => {
        if (this.exposedWindow?.tabId === tabId) this.exposedWindow = undefined;
      },
      presentationNow: () => this.presentationNow(),
      reportPresentation: (proof, state) => {
        try {
          this.presentationObserver?.(proof, state);
        } catch {}
      },
      getPresentation: () => this.presentation,
      setPresentation: (v) => (this.presentation = v),
      getPresenting: () => this.presenting,
      setPresenting: (v) => (this.presenting = v),
    };
  }
  async setWindowExposure(proof: TabProof, exposed: boolean) {
    this.exposedWindow = exposed ? proof : undefined;
    if (
      exposed &&
      this.owned.has(proof.tabId) &&
      this.attached.get(proof.tabId) === proof.targetId
    ) {
      await this.rendering
        .ensure(proof.tabId, proof.targetId, () => {
          if (
            !this.allowRead() ||
            !this.journal.writable ||
            this.owned.get(proof.tabId) !== proof ||
            this.attached.get(proof.tabId) !== proof.targetId
          )
            throw Error('KERNEL_PRESENTATION_REVOKED');
        })
        .catch(() => {});
    }
  }
  consumeRendering = (source: KernelTarget, method: string, value: unknown) =>
    this.rendering.consume(
      source,
      method,
      value,
      () =>
        this.allowRead() &&
        this.journal.writable &&
        this.owned.has(source.tabId) &&
        this.attached.has(source.tabId),
    );
  forgetRendering(tabId?: number): void {
    this.exposedWindow = undefined;
    if (tabId === undefined) {
      this.presentation = undefined;
      this.rendering.forgetAll();
    } else {
      this.clearTabPresentation(tabId);
      this.rendering.forget(tabId);
    }
  }
  async releaseRendering(tabId?: number, timeoutMs = 2_500): Promise<boolean> {
    this.exposedWindow = undefined;
    this.presentation = undefined;
    const stopped = await this.rendering.release(tabId, timeoutMs);
    return !this.presenting
      ? stopped
      : (await withBoundedWait(this.presenting, timeoutMs)).completed && stopped;
  }
  setPresentationObserver(observer: (proof: TabProof, state: KernelJsonObject) => void) {
    this.presentationObserver = observer;
  }
  setPresentationRecoveryGate(
    gate: (proof: TabProof, positionOnly?: boolean) => Promise<PresentationRecoveryDecision>,
  ) {
    this.recoverPresentation = gate;
    void this.recoverPresentation;
  }
  private async sameProfileForeground(): Promise<boolean> {
    if (!this.allowRead() || typeof chrome.windows.getAll !== 'function') return false;
    const startedAt = Date.now(),
      windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
    return this.allowRead() && Date.now() - startedAt <= 1500 && windows.some((w) => w.focused);
  }
  armTaskPresentation(proof: TabProof) {
    return armTaskPresentationHelper(this.cdpCtx(), proof);
  }
  maintainPresentation() {
    return maintainPresentationHelper(this.cdpCtx());
  }
  inventory(): Promise<unknown> {
    return inspectWorkspaceInventory(this.cdpCtx());
  }
  revealOwnedPage(proof: TabProof, focus = true) {
    return revealOwnedPageHelper(this.cdpCtx(), proof, focus);
  }
  consolidateWorkspace(preferActiveTab = true) {
    return consolidateWorkspaceTabs(this.cdpCtx(), preferActiveTab);
  }
  recoverTabToHome(input: TabProof) {
    return recoverOwnedTabToHome(this.cdpCtx(), input);
  }
  attach(tabId: number) {
    return attachDebuggerTarget(this.cdpCtx(), tabId);
  }
  detach(tabId: number, timeoutMs = 3_000) {
    return detachDebuggerTarget(this.cdpCtx(), tabId, timeoutMs);
  }
  closingDialog(source: KernelTarget, method: string, value: unknown) {
    return handleClosingDialog(this.cdpCtx(), source, method, value);
  }
  send(target: KernelTarget, method: string, params: KernelJsonObject) {
    return sendCdpCommand(this.cdpCtx(), target, method, params);
  }
  project(tabId: number, input: PageProjectionRequest) {
    return projectTabPage(this.cdpCtx(), tabId, input);
  }
  observeIdentity(tabId: number, assertCurrent: () => void) {
    return observeTabIdentity(this.cdpCtx(), tabId, assertCurrent);
  }
  async adopt(input: TabProof): Promise<void> {
    const proof = OwnedTabProof.parse(input),
      state = await this.journal.snapshot(),
      record = state.tabs.find((r) => r.ownershipId === proof.ownershipId);
    if (!isReadyTabRecord(record, proof, state.browserSessionEpoch))
      throw Error('KERNEL_TAB_ADOPTION_REJECTED');
    const target = (await chrome.debugger.getTargets()).find((r) => r.tabId === proof.tabId);
    if (!target || target.type !== 'page' || target.id !== proof.targetId)
      throw Error('KERNEL_TAB_IDENTITY_CHANGED');
    if (!kernelAccessURL(target.url, this.access)) throw Error('KERNEL_SCOPE_CHANGED');
    this.owned.set(proof.tabId, proof);
    if (this.access === 'facebook-task')
      await this.workspaceGroup.ensure(proof, () => {
        if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
      });
  }
  async scope(tabId: number): Promise<void> {
    const target = await this.ownedTarget(tabId);
    if (
      (this.access === 'facebook-task' || this.access === 'facebook-readonly') &&
      ['about:blank', ''].includes(target.url)
    )
      throw Error('KERNEL_INITIAL_DOCUMENT_PENDING');
    const urlToCheck =
      this.access === 'agent-browser' && target.url === '' ? 'about:blank' : target.url;
    if (!kernelAccessURL(urlToCheck, this.access)) throw Error('KERNEL_SCOPE_CHANGED');
  }
  async scopeForClose(tabId: number): Promise<void> {
    await this.ownedTarget(tabId);
    if (this.access !== 'fixture' && !this.allowRead())
      throw Error('KERNEL_READONLY_LEASE_REJECTED');
  }
  private async markTabLost(tabId: number, proof: TabProof): Promise<void> {
    this.owned.delete(tabId);
    await this.journal.tabState(proof.ownershipId, 'LOST', 'TARGET_IDENTITY_CHANGED');
  }
  private async ownedTarget(tabId: number) {
    const proof = this.owned.get(tabId);
    if (!proof) throw Error('KERNEL_TAB_NOT_OWNED');
    const target = (await chrome.debugger.getTargets()).find((r) => r.tabId === tabId);
    if (!target || target.type !== 'page' || target.id !== proof.targetId) {
      await this.markTabLost(tabId, proof);
      throw Error('KERNEL_TAB_IDENTITY_CHANGED');
    }
    return target;
  }
  async create(
    url: string,
    ownershipId = crypto.randomUUID(),
    foreground = false,
  ): Promise<{ tabId: number }> {
    if (!kernelAccessURL(url, this.access)) throw Error('KERNEL_URL_REJECTED');
    await this.journal.prepareTab(ownershipId, url);
    let createdTabId: number | undefined,
      createAttempted = false;
    const assertTaskRead = () => {
      if (this.access !== 'fixture' && !this.allowRead()) throw Error('KERNEL_READ_FENCED');
    };
    try {
      assertTaskRead();
      if (this.access === 'facebook-task')
        foreground = foreground && (await this.sameProfileForeground());
      assertTaskRead();
      let targetWindowId: number | undefined;
      if (this.access === 'facebook-task' && chrome.storage?.local) {
        const main = await this.workspaceGroup.read(assertTaskRead).catch(() => null);
        if (main?.windowId !== undefined)
          targetWindowId =
            typeof chrome.windows?.get === 'function'
              ? (await chrome.windows.get(main.windowId).catch(() => null))?.id === main.windowId
                ? main.windowId
                : undefined
              : main.windowId;
        assertTaskRead();
      }
      createAttempted = true;
      const tab = await chrome.tabs.create(
        targetWindowId !== undefined
          ? { url, active: foreground, windowId: targetWindowId }
          : { url, active: foreground },
      );
      if (tab.id === undefined) throw Error('KERNEL_CREATE_FAILED');
      createdTabId = tab.id;
      if (foreground && (this.access === 'facebook-task' || this.access === 'agent-browser')) {
        assertTaskRead();
        if (this.access === 'agent-browser' || (await this.sameProfileForeground())) {
          assertTaskRead();
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        assertTaskRead();
      }
      let target = (await chrome.debugger.getTargets()).find((r) => r.tabId === tab.id);
      if (this.access !== 'fixture') {
        for (
          let attempt = 0;
          attempt < 50 && (!target || target.url === 'about:blank' || target.url === '');
          attempt++
        ) {
          await sleep(100);
          target = (await chrome.debugger.getTargets()).find((r) => r.tabId === tab.id);
        }
        const createdUrl =
          this.access === 'agent-browser' && target?.url === ''
            ? 'about:blank'
            : (target?.url ?? '');
        if (!target || !kernelAccessURL(createdUrl, this.access))
          throw Error('KERNEL_SCOPE_CHANGED');
      }
      if (!target || target.type !== 'page') throw Error('KERNEL_TARGET_IDENTITY_MISSING');
      const state = await this.journal.snapshot(),
        proof = OwnedTabProof.parse({
          ownershipId,
          profileId: state.profileId,
          browserSessionEpoch: state.browserSessionEpoch,
          tabId: tab.id,
          targetId: target.id,
        });
      await this.journal.confirmTab(proof);
      this.owned.set(tab.id, proof);
      if (this.access === 'facebook-task')
        await this.workspaceGroup.registerCreated(proof, assertTaskRead);
      if (this.access === 'facebook-readonly' && url === 'https://www.facebook.com/')
        this.identityReadTabs.add(tab.id);
      return { tabId: tab.id };
    } catch (error) {
      let cleanedUp = !createAttempted;
      if (createAttempted && createdTabId !== undefined) {
        this.owned.delete(createdTabId);
        this.identityReadTabs.delete(createdTabId);
        this.expectedDetaches.add(createdTabId);
        this.expectedRemovals.add(createdTabId);
        try {
          if (this.attached.has(createdTabId)) {
            await chrome.debugger.detach({ tabId: createdTabId }).catch(() => {});
            this.attached.delete(createdTabId);
          }
          await chrome.tabs.remove(createdTabId);
          cleanedUp = true;
        } catch {
          cleanedUp = false;
        } finally {
          this.expectedDetaches.delete(createdTabId);
          this.expectedRemovals.delete(createdTabId);
        }
      }
      const reason = cleanedUp
        ? createAttempted
          ? 'CREATE_ABORTED_CLEANED'
          : 'CREATE_ABORTED_BEFORE_OPEN'
        : 'CREATE_RESULT_UNKNOWN';
      await this.journal
        .tabState(ownershipId, cleanedUp ? 'CLOSED' : 'UNKNOWN', reason)
        .catch(() => {});
      throw error;
    }
  }
  async remove(tabId: number): Promise<void> {
    const assertReadable = () => {
      if (this.access !== 'fixture' && !this.allowRead())
        throw Error('KERNEL_READONLY_LEASE_REJECTED');
    };
    const assertRemovable = () => {
      if (this.currentOperation()) throw Error('KERNEL_CLOSE_DURING_OPERATION');
      assertReadable();
    };
    const cleanupClosed = async (expectedProof: TabProof) => {
      this.forgetTab(tabId, true);
      await this.journal.tabState(expectedProof.ownershipId, 'CLOSED', 'CLOSED_BY_EXECUTOR');
    };
    const confirmDisappeared = async (
      expectedProof: TabProof,
      fallbackError: unknown,
      markLostOnPresent = false,
    ): Promise<void> => {
      assertRemovable();
      const [freshTargets, freshTabs] = await Promise.all([
        chrome.debugger.getTargets(),
        chrome.tabs.query({}),
      ]);
      assertRemovable();
      if (
        !freshTargets.some((r) => r.tabId === tabId || r.id === expectedProof.targetId) &&
        !freshTabs.some((t) => t.id === tabId)
      )
        return cleanupClosed(expectedProof);
      if (markLostOnPresent) await this.markTabLost(tabId, expectedProof);
      throw fallbackError instanceof Error ? fallbackError : Error(String(fallbackError));
    };
    assertReadable();
    const proof = this.owned.get(tabId);
    if (!proof) {
      const snapshot = await this.journal.snapshot(),
        latest = [...snapshot.tabs]
          .reverse()
          .find(
            (r) =>
              r.proof?.browserSessionEpoch === snapshot.browserSessionEpoch &&
              r.proof.tabId === tabId,
          );
      if (latest?.state !== 'CLOSED' || !latest.proof) throw Error('KERNEL_TAB_NOT_OWNED');
      return confirmDisappeared(latest.proof, Error('KERNEL_TAB_NOT_OWNED'));
    }
    const target = (await chrome.debugger.getTargets()).find((r) => r.tabId === tabId);
    if (!target) return confirmDisappeared(proof, Error('KERNEL_TAB_IDENTITY_CHANGED'), true);
    if (target.type !== 'page' || target.id !== proof.targetId) {
      await this.markTabLost(tabId, proof);
      throw Error('KERNEL_TAB_IDENTITY_CHANGED');
    }
    assertReadable();
    this.expectedDetaches.add(tabId);
    this.expectedRemovals.add(tabId);
    this.removingUntil.set(tabId, Date.now() + 10_000);
    this.removalDialogs.delete(tabId);
    try {
      try {
        await chrome.tabs.remove(tabId);
      } catch (error) {
        if (error instanceof Error && /No tab with id/i.test(error.message))
          return confirmDisappeared(proof, error);
        throw error;
      }
      await cleanupClosed(proof);
    } finally {
      this.expectedRemovals.delete(tabId);
      this.removingUntil.delete(tabId);
      this.removalDialogs.delete(tabId);
    }
  }
  private forgetTab(tabId: number, full = false): void {
    this.clearTabPresentation(tabId);
    this.rendering.forget(tabId);
    this.attached.delete(tabId);
    if (full) {
      this.identityReadTabs.delete(tabId);
      this.owned.delete(tabId);
      this.expectedDetaches.delete(tabId);
    }
  }
  owns = (tabId: number) => this.owned.has(tabId);
  detached(tabId: number): void {
    this.forgetTab(tabId);
  }
  expectedDetach = (tabId: number) => this.expectedDetaches.delete(tabId);
  isExpectedDetach = (tabId: number) =>
    this.expectedDetaches.has(tabId) || this.expectedRemovals.has(tabId);
  expectedRemoval = (tabId: number) => this.expectedRemovals.has(tabId);
  tabRemoved(tabId: number): void {
    this.identityReadTabs.delete(tabId);
    const proof = this.owned.get(tabId);
    this.owned.delete(tabId);
    this.attached.delete(tabId);
    if (proof)
      void this.journal.tabState(proof.ownershipId, 'CLOSED', 'TAB_REMOVED').catch(() => {});
  }
}
