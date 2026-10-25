import type { PresentationRecoveryDecision } from '../src/shared/presentation-recovery.js';
import {
  KernelJsonObject,
  KernelTargetInfo,
  type KernelBackend,
  type KernelTarget,
} from '../src/shared/kernel-protocol.js';
import {
  assertKernelSessionCommand,
  kernelAccessURL,
  kernelRequiresOperation,
  type KernelAccess,
} from '../src/shared/kernel-policy.js';
import {
  PageReadRequest,
  validateProjection,
  type PageProjectionRequest,
} from '../src/shared/page-read.js';
import { pageProjectionExpression } from './page-projection.js';
import { OwnedTabProof, type TabProof } from '../src/shared/kernel-state.js';
import type { KernelJournal } from '../src/application/kernel-journal.js';
import { kernelJournal } from './kernel-storage.js';
import { readNativeFacebookIdentity } from './facebook-identity-reader.js';
import type { Binding } from '../src/shared/task-execution.js';
import { digestAction } from './journal.js';
import { WorkspacePageGroup } from './workspace-page-group.js';
import { TaskRendering } from './task-rendering.js';
import { sameTabProof } from '../src/domain/task-tabs.js';

export interface KernelNativeBackend extends KernelBackend {
  owns(tabId: number): boolean;
  detached(tabId: number): void;
  expectedDetach(tabId: number): boolean;
  isExpectedDetach?(tabId: number): boolean;
  expectedRemoval?(tabId: number): boolean;
  inventory?(): Promise<unknown>;
  closingDialog?(source: KernelTarget, method: string, value: unknown): Promise<void>;
  consumeRendering?(source: KernelTarget, method: string, value: unknown): boolean;
  releaseRendering?(): Promise<void>;
  maintainPresentation?(): void;
  setPresentationRecoveryGate?(
    gate: (proof: TabProof, positionOnly?: boolean) => Promise<PresentationRecoveryDecision>,
  ): void;
  setPresentationObserver?(observer: (proof: TabProof, state: KernelJsonObject) => void): void;
  armTaskPresentation?(proof: TabProof): Promise<void>;
  setWindowExposure?(proof: TabProof, exposed: boolean): Promise<void>;
  adopt?(proof: TabProof): Promise<void>;
  revealOwnedPage?(proof: TabProof): Promise<{ tabId: number; focused: true }>;
  consolidateWorkspace?(preferActiveTab?: boolean): Promise<{
    proof: TabProof;
    url: string;
    closedTabIds: number[];
    remainingTabCount: number;
  }>;
  tabRemoved?(tabId: number): void;
}
export class ChromeKernelBackend implements KernelNativeBackend {
  private exposedWindow?: TabProof;
  private isExposed(proof: TabProof) {
    return !!this.exposedWindow && sameTabProof(this.exposedWindow, proof);
  }
  async setWindowExposure(proof: TabProof, exposed: boolean) {
    this.exposedWindow = exposed ? proof : undefined;
    if (exposed) await this.rendering.release();
  }
  private readonly rendering = new TaskRendering((target, method, params) =>
    chrome.debugger.sendCommand(target, method, params),
  );
  consumeRendering(source: KernelTarget, method: string, value: unknown) {
    return this.rendering.consume(
      source,
      method,
      value,
      () =>
        this.allowRead() &&
        this.journal.writable &&
        this.owned.has(source.tabId) &&
        this.attached.has(source.tabId),
    );
  }
  async releaseRendering() {
    this.exposedWindow = undefined;
    this.presentation = undefined; // Revoke recovery synchronously, including an in-flight check.
    const stopped = this.rendering.release();
    await Promise.all([stopped, this.presenting?.catch(() => {})]);
  }
  private presentation?: {
    proof: TabProof;
    checkedAt: number;
    inactiveSince?: number;
    visibility?: string;
    visibilityAt?: number;
    probe?: Promise<void>;
    diagnostic?: string;
    reportedAt?: number;
  };
  private recoverPresentation?: (
    proof: TabProof,
    positionOnly?: boolean,
  ) => Promise<PresentationRecoveryDecision>;
  private presentationObserver?: (proof: TabProof, state: KernelJsonObject) => void;
  setPresentationObserver(observer: (proof: TabProof, state: KernelJsonObject) => void) {
    this.presentationObserver = observer;
  }
  private reportPresentation(proof: TabProof, state: KernelJsonObject) {
    try {
      this.presentationObserver?.(proof, state);
    } catch {}
  }
  setPresentationRecoveryGate(
    gate: (proof: TabProof, positionOnly?: boolean) => Promise<PresentationRecoveryDecision>,
  ) {
    this.recoverPresentation = gate;
  }
  async armTaskPresentation(proof: TabProof) {
    const owned = this.owned.get(proof.tabId);
    if (!owned) throw Error('TASK_PRESENTATION_SCOPE_REJECTED');
    const guard = () => {
      if (
        this.access !== 'facebook-task' ||
        !this.allowRead() ||
        !this.journal.writable ||
        !owned ||
        this.owned.get(proof.tabId) !== owned ||
        !sameTabProof(owned, proof) ||
        this.attached.get(proof.tabId) !== proof.targetId
      )
        throw Error('TASK_PRESENTATION_SCOPE_REJECTED');
    };
    guard();
    await this.scope(proof.tabId);
    guard();
    this.presentation = { proof: owned, checkedAt: -Infinity };
    this.reportPresentation(owned, { phase: 'ARMED' });
  }
  private presenting?: Promise<void>;
  maintainPresentation() {
    const presentation = this.presentation;
    if (this.access !== 'facebook-task' || !presentation || this.presenting) return;
    const { proof } = presentation;
    const tabId = proof.tabId;
    const pending = (async () => {
      const guard = () => {
        if (
          this.presentation !== presentation ||
          this.owned.get(tabId) !== proof ||
          this.attached.get(tabId) !== proof.targetId ||
          !this.allowRead() ||
          !this.journal.writable
        )
          throw Error('KERNEL_PRESENTATION_REVOKED');
      };
      guard();
      const tab = await chrome.tabs.get(tabId);
      guard();
      if (!kernelAccessURL(tab.url ?? '', 'facebook-task'))
        throw Error('KERNEL_PRESENTATION_URL_CHANGED');
      const window = await chrome.windows.get(tab.windowId);
      guard();
      if (window.state === 'minimized') {
        await chrome.windows.update(tab.windowId, { state: 'normal', focused: false });
        guard();
      }
      if (!tab.active) {
        await chrome.tabs.update(tabId, { active: true });
        guard();
      }
      const at = this.presentationNow();
      if (at - presentation.checkedAt < 2000) return;
      presentation.checkedAt = at;
      // Renderer/CDP can itself be suspended by occlusion. Its probe must never
      // block browser-process window recovery or the next watchdog tick.
      if (!presentation.probe) {
        const probe = (async () => {
          if (!this.isExposed(proof)) await this.rendering.ensure(tabId, proof.targetId, guard);
          guard();
          const value = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: 'document.visibilityState',
            returnByValue: true,
          });
          guard();
          const result = KernelJsonObject.parse(value ?? {});
          const visibility =
            result.result && typeof result.result === 'object' && !Array.isArray(result.result)
              ? result.result.value
              : undefined;
          if (visibility !== 'hidden' && visibility !== 'visible')
            throw Error('TASK_PRESENTATION_VISIBILITY_UNAVAILABLE');
          presentation.visibility = visibility;
          presentation.visibilityAt = Date.now();
          if (visibility === 'hidden') {
            if (!this.isExposed(proof)) await this.rendering.refresh(tabId, proof.targetId, guard);
            guard();
          }
        })();
        presentation.probe = probe;
        void probe
          .catch((error: unknown) => {
            if (this.presentation === presentation && this.allowRead())
              this.reportPresentation(proof, {
                phase: 'PROBE_ERROR',
                reason: String(error).slice(0, 200),
              });
          })
          .finally(() => {
            if (presentation.probe === probe) presentation.probe = undefined;
          });
      }
      if (window.focused === false) presentation.inactiveSince ??= at;
      else presentation.inactiveSince = undefined;
      const state = {
        phase: 'CHECK',
        windowFocused: window.focused ?? null,
        visibility: presentation.visibility ?? null,
        ...(presentation.visibilityAt !== undefined
          ? { visibilityAt: presentation.visibilityAt }
          : {}),
        probePending: !!presentation.probe,
      };
      const diagnostic = JSON.stringify(state);
      if (
        presentation.diagnostic !== diagnostic ||
        at - (presentation.reportedAt ?? -Infinity) >= 15000
      ) {
        presentation.diagnostic = diagnostic;
        presentation.reportedAt = at;
        this.reportPresentation(proof, state);
      }
      const hidden =
        presentation.visibility === 'hidden' &&
        presentation.visibilityAt !== undefined &&
        Date.now() - presentation.visibilityAt <= 5000;
      const inactive =
        presentation.inactiveSince !== undefined && at - presentation.inactiveSince >= 4000;
      const exposed = this.isExposed(proof);
      if ((hidden || (!exposed && inactive)) && this.recoverPresentation) {
        this.reportPresentation(proof, {
          phase: 'REQUEST',
          reason: hidden ? 'HIDDEN' : 'WINDOW_UNFOCUSED',
        });
        const granted = await this.recoverPresentation(proof, exposed);
        guard();
        if (granted) {
          if (exposed) {
            // The controller has moved the exact window. This is only a native
            // movement result; a later real visibility probe decides recovery.
            this.reportPresentation(proof, { phase: 'LAYOUT_RESULT' });
            return;
          }
          // User-authorized recovery of this exact live task, not an arbitrary
          // window or a replay of the business action currently being verified.
          const current = await chrome.tabs.get(tabId);
          guard();
          if (!kernelAccessURL(current.url ?? '', 'facebook-task'))
            throw Error('KERNEL_PRESENTATION_URL_CHANGED');
          await chrome.tabs.update(tabId, { active: true });
          guard();
          await chrome.windows.update(current.windowId, { focused: true });
          guard();
          const focused = await chrome.windows.get(current.windowId);
          guard();
          this.reportPresentation(proof, {
            phase: 'FOCUS_RESULT',
            windowFocused: focused.focused ?? null,
          });
          if (focused.focused === true) presentation.inactiveSince = undefined;
        } else this.reportPresentation(proof, { phase: 'DEFERRED' });
      }
      guard();
    })();
    this.presenting = pending;
    void pending
      .catch((error: unknown) => {
        if (this.presentation === presentation && this.allowRead())
          this.reportPresentation(proof, {
            phase: 'MONITOR_ERROR',
            reason: String(error).slice(0, 200),
          });
      })
      .finally(() => {
        if (this.presenting === pending) this.presenting = undefined;
      });
  }
  private readonly workspaceGroup = new WorkspacePageGroup();
  private readonly owned = new Map<number, TabProof>();
  private readonly attached = new Map<number, string>();
  private readonly expectedDetaches = new Set<number>();
  private readonly expectedRemovals = new Set<number>();
  private readonly identityReadTabs = new Set<number>();
  private readonly removingUntil = new Map<number, number>();
  private readonly removalDialogs = new Set<number>();
  private identityReadPending = false;
  private async sameProfileForeground(): Promise<boolean> {
    if (!this.allowRead() || typeof chrome.windows.getAll !== 'function') return false;
    const startedAt = Date.now();
    const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
    return (
      this.allowRead() && Date.now() - startedAt <= 1500 && windows.some((window) => window.focused)
    );
  }
  constructor(
    private readonly journal: KernelJournal = kernelJournal,
    private readonly allowInput: () => boolean = () => false,
    private readonly access: KernelAccess = 'fixture',
    private readonly allowRead: () => boolean = () => false,
    private readonly currentOperation: () => Binding | undefined = () => undefined,
    private readonly presentationNow: () => number = performance.now.bind(performance),
  ) {}
  async inventory(): Promise<unknown> {
    const before = await this.journal.snapshot();
    if (
      this.allowRead() &&
      !before.operations.some((row) => row.state !== 'RECONCILED' && !row.disposition)
    ) {
      const withdrawn = before.tabs.filter(
        (row) =>
          row.state === 'LOST' &&
          ['TASK_ENDED_OWNERSHIP_WITHDRAWN', 'BROWSER_SESSION_CHANGED'].includes(row.reason),
      );
      if (withdrawn.length && chrome.storage?.local) {
        const main = await this.workspaceGroup.read(() => {
          if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
        });
        const original = withdrawn.find(
          (row) => main && JSON.stringify(main.proof) === JSON.stringify(row.proof),
        );
        if (main && original?.proof) {
          const target = (await chrome.debugger.getTargets()).find(
            (row) => row.tabId === original.proof?.tabId && row.id === original.proof?.targetId,
          );
          if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
          if (target?.type === 'page' && kernelAccessURL(target.url, 'facebook-task')) {
            if (
              original.reason === 'TASK_ENDED_OWNERSHIP_WITHDRAWN' &&
              original.proof.browserSessionEpoch === before.browserSessionEpoch
            )
              await this.journal.restoreWithdrawnTab(original.proof);
            else if (
              original.reason === 'BROWSER_SESSION_CHANGED' &&
              original.proof.profileId === before.profileId
            ) {
              const known = before.tabs.find(
                (row) =>
                  row.state === 'READY' &&
                  row.proof?.tabId === original.proof?.tabId &&
                  row.proof?.targetId === original.proof?.targetId,
              )?.proof;
              const proof =
                known ??
                OwnedTabProof.parse({
                  ...original.proof,
                  ownershipId: crypto.randomUUID(),
                  browserSessionEpoch: before.browserSessionEpoch,
                });
              if (!known) await this.journal.reobserveMain(original.proof, proof, target.url);
              await this.workspaceGroup.rebind(original.proof, proof, () => {
                if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
              });
            }
          }
        }
      }
    }
    const observed = await this.journal.snapshot();
    const retained = observed.tabs.filter(
      (row) =>
        row.state === 'READY' &&
        row.proof &&
        row.proof.browserSessionEpoch === before.browserSessionEpoch &&
        !this.owned.has(row.proof.tabId),
    );
    if (!retained.length) return this.workspaceSnapshot();
    if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    // Worker reload can miss onRemoved. Observe retained pages without adopting, attaching
    // or closing them. Absence in both tab and target inventories confirms page lifecycle
    // only; it never settles UNKNOWN input, confirms an old STOP or releases an account.
    const [tabs, targets] = await Promise.all([
      chrome.tabs.query({}),
      chrome.debugger.getTargets(),
    ]);
    if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    const absent = retained.filter(
      (row) =>
        row.proof &&
        !tabs.some((tab) => tab.id === row.proof?.tabId) &&
        !targets.some(
          (target) => target.tabId === row.proof?.tabId || target.id === row.proof?.targetId,
        ),
    );
    if (!absent.length) return this.workspaceSnapshot();
    const confirmedTabs = await chrome.tabs.query({});
    if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    for (const row of absent) {
      if (!confirmedTabs.some((tab) => tab.id === row.proof?.tabId))
        await this.journal.tabState(row.ownershipId, 'CLOSED', 'RETAINED_TARGET_ABSENT');
      if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    }
    return this.workspaceSnapshot();
  }
  private async workspaceSnapshot() {
    const state = await this.journal.snapshot();
    if (!chrome.storage?.local) return state;
    const main = await this.workspaceGroup.read(() => {
      if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    });
    if (
      !main ||
      !state.tabs.some(
        (row) => row.state === 'READY' && JSON.stringify(row.proof) === JSON.stringify(main.proof),
      )
    )
      return state;
    const target = (await chrome.debugger.getTargets()).find(
      (row) => row.tabId === main.proof.tabId && row.id === main.proof.targetId,
    );
    if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    return target?.type === 'page' && kernelAccessURL(target.url, 'facebook-task')
      ? { ...state, workspaceMain: main.proof }
      : state;
  }
  async adopt(input: TabProof): Promise<void> {
    const proof = OwnedTabProof.parse(input);
    const state = await this.journal.snapshot();
    const record = state.tabs.find((row) => row.ownershipId === proof.ownershipId);
    if (
      record?.state !== 'READY' ||
      !record.proof ||
      JSON.stringify(record.proof) !== JSON.stringify(proof) ||
      proof.browserSessionEpoch !== state.browserSessionEpoch
    )
      throw Error('KERNEL_TAB_ADOPTION_REJECTED');
    const target = (await chrome.debugger.getTargets()).find((row) => row.tabId === proof.tabId);
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
    // A new native target may temporarily report its initial blank document
    // during navigation. It still grants no command scope. Only the software's
    // fixed initial-document reader may wait on this explicit pending result.
    if (this.access === 'facebook-task' && ['about:blank', ''].includes(target.url))
      throw Error('KERNEL_INITIAL_DOCUMENT_PENDING');
    if (!kernelAccessURL(target.url, this.access)) throw Error('KERNEL_SCOPE_CHANGED');
  }
  async revealOwnedPage(proof: TabProof): Promise<{ tabId: number; focused: true }> {
    proof = OwnedTabProof.parse(proof);
    const check = () => {
      if (
        !this.allowRead() ||
        JSON.stringify(this.owned.get(proof.tabId)) !== JSON.stringify(proof)
      )
        throw Error('WORKSPACE_REVEAL_REVOKED');
    };
    check();
    await this.scope(proof.tabId);
    check();
    const tab = await chrome.tabs.get(proof.tabId);
    check();
    const window = await chrome.windows.get(tab.windowId);
    check();
    if (window.state === 'minimized') {
      await chrome.windows.update(tab.windowId, { state: 'normal' });
      check();
    }
    await chrome.tabs.update(proof.tabId, { active: true });
    check();
    // Explicit display command, not the automatic business foreground policy.
    await chrome.windows.update(tab.windowId, { focused: true });
    check();
    const deadline = Date.now() + 1000;
    while (true) {
      const current = await chrome.tabs.get(proof.tabId);
      check();
      const observed = await chrome.windows.get(tab.windowId);
      check();
      if (current.windowId !== tab.windowId || !current.active)
        throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
      if (observed.focused) break;
      if (Date.now() >= deadline) throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
      // Native focus acknowledgement can precede the OS focus event. Only read;
      // another window choice or stop never causes a second focus request.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      check();
    }
    await this.scope(proof.tabId);
    check();
    return { tabId: proof.tabId, focused: true };
  }
  async consolidateWorkspace(preferActiveTab = true): Promise<{
    proof: TabProof;
    url: string;
    closedTabIds: number[];
    remainingTabCount: number;
  }> {
    const check = () => {
      if (this.access !== 'facebook-task' || !this.allowRead())
        throw Error('WORKSPACE_CLEANUP_REVOKED');
    };
    check();
    const state = await this.journal.snapshot();
    check();
    if (state.operations.some((row) => row.state !== 'RECONCILED' && !row.disposition))
      throw Error('WORKSPACE_CLEANUP_OPERATION_PENDING');
    const [windows, allTabs, initialTargets] = await Promise.all([
      typeof chrome.windows?.getAll === 'function'
        ? chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
        : Promise.resolve([]),
      chrome.tabs.query({}),
      chrome.debugger.getTargets(),
    ]);
    check();
    const isFbPage = (tabId: number | undefined, targets = initialTargets) => {
      if (tabId === undefined) return undefined;
      const target = targets.find((row) => row.tabId === tabId && row.type === 'page');
      return target && kernelAccessURL(target.url, 'facebook-task') ? target : undefined;
    };
    const activeWindow = windows.find((w) => w.focused) ?? windows[0];
    const activeTab =
      activeWindow?.tabs?.find((t) => t.active && t.id !== undefined) ??
      allTabs.find((t) => t.active && t.id !== undefined) ??
      allTabs.find((t) => t.id !== undefined);
    const registeredMain = chrome.storage?.local ? await this.workspaceGroup.read(check) : null;
    check();
    let chosenTabId: number | undefined;
    let chosenTarget =
      preferActiveTab && activeTab?.id !== undefined ? isFbPage(activeTab.id) : undefined;
    if (chosenTarget && activeTab?.id !== undefined) {
      chosenTabId = activeTab.id;
    } else if (registeredMain && isFbPage(registeredMain.proof.tabId)) {
      chosenTabId = registeredMain.proof.tabId;
      chosenTarget = isFbPage(registeredMain.proof.tabId);
    } else if (activeTab?.id !== undefined && isFbPage(activeTab.id)) {
      chosenTabId = activeTab.id;
      chosenTarget = isFbPage(activeTab.id);
    } else {
      const anyFb = allTabs.find((t) => isFbPage(t.id));
      if (anyFb?.id !== undefined) {
        chosenTabId = anyFb.id;
        chosenTarget = isFbPage(anyFb.id);
      }
    }
    if (chosenTabId === undefined || !chosenTarget) {
      if (activeTab?.id !== undefined) {
        chosenTabId = activeTab.id;
        await chrome.tabs.update(chosenTabId, { url: 'https://www.facebook.com/', active: true });
      } else {
        const created = await chrome.tabs.create({
          url: 'https://www.facebook.com/',
          active: true,
        });
        if (created.id === undefined) throw Error('WORKSPACE_CLEANUP_CREATE_FAILED');
        chosenTabId = created.id;
      }
      check();
      for (let attempt = 0; attempt < 50 && !chosenTarget; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        check();
        const targets = await chrome.debugger.getTargets();
        chosenTarget = isFbPage(chosenTabId, targets);
      }
      if (!chosenTarget) throw Error('WORKSPACE_CLEANUP_TARGET_UNCONFIRMED');
    }
    const candidateProof = OwnedTabProof.parse({
      ownershipId: crypto.randomUUID(),
      profileId: state.profileId,
      browserSessionEpoch: state.browserSessionEpoch,
      tabId: chosenTabId,
      targetId: chosenTarget.id,
    });
    const boundProof = await this.journal.bindWorkspaceMainTab(candidateProof, chosenTarget.url);
    check();
    this.owned.set(chosenTabId, boundProof);
    if (chrome.storage?.local) {
      await this.workspaceGroup.forceBindMain(boundProof, check);
      check();
    }
    const currentTabs = await chrome.tabs.query({});
    check();
    const closedTabIds: number[] = [];
    for (const tab of currentTabs) {
      if (tab.id === undefined || tab.id === chosenTabId) continue;
      const otherId = tab.id;
      this.expectedDetaches.add(otherId);
      this.expectedRemovals.add(otherId);
      try {
        if (this.attached.has(otherId)) {
          await chrome.debugger.detach({ tabId: otherId }).catch(() => {});
        }
        await chrome.tabs.remove(otherId);
        closedTabIds.push(otherId);
      } catch {
      } finally {
        this.identityReadTabs.delete(otherId);
        this.owned.delete(otherId);
        this.attached.delete(otherId);
        this.expectedRemovals.delete(otherId);
      }
    }
    check();
    await chrome.tabs.update(chosenTabId, { active: true });
    check();
    const remainingTabs = await chrome.tabs.query({});
    check();
    return {
      proof: boundProof,
      url: chosenTarget.url,
      closedTabIds,
      remainingTabCount: remainingTabs.length,
    };
  }
  async scopeForClose(tabId: number): Promise<void> {
    await this.ownedTarget(tabId);
    if (this.access !== 'fixture' && !this.allowRead())
      throw Error('KERNEL_READONLY_LEASE_REJECTED');
  }
  private async ownedTarget(tabId: number) {
    if (!this.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    const proof = this.owned.get(tabId);
    const target = (await chrome.debugger.getTargets()).find((row) => row.tabId === tabId);
    if (!proof || !target || target.type !== 'page' || target.id !== proof.targetId) {
      this.owned.delete(tabId);
      if (proof) await this.journal.tabState(proof.ownershipId, 'LOST', 'TARGET_IDENTITY_CHANGED');
      throw Error('KERNEL_TAB_IDENTITY_CHANGED');
    }
    return target;
  }
  async attach(tabId: number) {
    if (!this.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    await this.scope(tabId);
    if (!this.attached.has(tabId)) {
      this.expectedDetaches.delete(tabId);
      await chrome.debugger.attach({ tabId }, '1.3');
      this.attached.set(tabId, '');
    }
    const result = KernelJsonObject.parse(
      await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'),
    );
    const info = KernelTargetInfo.parse(result.targetInfo);
    if (
      !kernelAccessURL(info.url, this.access) ||
      info.type !== 'page' ||
      info.targetId !== this.owned.get(tabId)?.targetId
    )
      throw Error('KERNEL_SCOPE_CHANGED');
    this.attached.set(tabId, info.targetId);
    return info;
  }
  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    if (!this.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    if (this.presentation?.proof.tabId === tabId) this.presentation = undefined;
    await this.rendering.release(tabId).catch(() => {}); // Detach also destroys the native stream.
    this.expectedDetaches.add(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (error) {
      // A user cancellation may already have detached. Only an observed absence confirms release.
      const target = (await chrome.debugger.getTargets()).find((item) => item.tabId === tabId);
      if (target?.attached) throw error;
    }
    this.attached.delete(tabId);
  }
  async create(
    url: string,
    ownershipId = crypto.randomUUID(),
    foreground = false,
  ): Promise<{ tabId: number }> {
    if (!kernelAccessURL(url, this.access)) throw Error('KERNEL_URL_REJECTED');
    await this.journal.prepareTab(ownershipId, url);
    try {
      if (this.access !== 'fixture' && !this.allowRead()) throw Error('KERNEL_READ_FENCED');
      if (this.access === 'facebook-task')
        foreground = foreground && (await this.sameProfileForeground());
      if (this.access !== 'fixture' && !this.allowRead()) throw Error('KERNEL_READ_FENCED');
      const tab = await chrome.tabs.create({ url, active: foreground });
      if (tab.id === undefined) throw Error('KERNEL_CREATE_FAILED');
      if (foreground && this.access === 'facebook-task') {
        if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
        if (await this.sameProfileForeground()) {
          if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
      }
      let target = (await chrome.debugger.getTargets()).find((row) => row.tabId === tab.id);
      if (this.access !== 'fixture') {
        for (
          let attempt = 0;
          attempt < 50 && (!target || target.url === 'about:blank' || target.url === '');
          attempt++
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          target = (await chrome.debugger.getTargets()).find((row) => row.tabId === tab.id);
        }
        if (!target || !kernelAccessURL(target.url, this.access))
          throw Error('KERNEL_SCOPE_CHANGED');
      }
      if (!target || target.type !== 'page') throw Error('KERNEL_TARGET_IDENTITY_MISSING');
      const state = await this.journal.snapshot();
      const proof = OwnedTabProof.parse({
        ownershipId,
        profileId: state.profileId,
        browserSessionEpoch: state.browserSessionEpoch,
        tabId: tab.id,
        targetId: target.id,
      });
      await this.journal.confirmTab(proof);
      this.owned.set(tab.id, proof);
      if (this.access === 'facebook-task')
        await this.workspaceGroup.registerCreated(proof, () => {
          if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
        });
      if (this.access === 'facebook-readonly' && url === 'https://www.facebook.com/')
        this.identityReadTabs.add(tab.id);
      return { tabId: tab.id };
    } catch (error) {
      await this.journal.tabState(ownershipId, 'UNKNOWN', 'CREATE_RESULT_UNKNOWN').catch(() => {});
      throw error;
    }
  }
  async remove(tabId: number): Promise<void> {
    if (!this.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    await this.scopeForClose(tabId);
    // STOP can arrive while the native target lookup is awaiting. Recheck immediately before close.
    if (this.access !== 'fixture' && !this.allowRead())
      throw Error('KERNEL_READONLY_LEASE_REJECTED');
    const proof = this.owned.get(tabId);
    this.expectedDetaches.add(tabId);
    this.expectedRemovals.add(tabId);
    this.removingUntil.set(tabId, Date.now() + 10_000);
    this.removalDialogs.delete(tabId);
    try {
      await chrome.tabs.remove(tabId);
      this.identityReadTabs.delete(tabId);
      this.owned.delete(tabId);
      this.attached.delete(tabId);
      if (proof) await this.journal.tabState(proof.ownershipId, 'CLOSED', 'CLOSED_BY_EXECUTOR');
    } finally {
      this.expectedRemovals.delete(tabId);
      this.removingUntil.delete(tabId);
      this.removalDialogs.delete(tabId);
    }
  }
  async closingDialog(source: KernelTarget, method: string, value: unknown): Promise<void> {
    // A lifecycle-only completion of an already requested, owned-page close. The SDK's
    // general dialog method still requires an original operation. Never accept confirm,
    // prompt, alert, child-frame or unsolicited dialogs, and never change page content.
    if (
      this.access !== 'facebook-task' ||
      method !== 'Page.javascriptDialogOpening' ||
      source.sessionId
    )
      return;
    const params = KernelJsonObject.parse(value ?? {});
    const proof = this.owned.get(source.tabId),
      until = this.removingUntil.get(source.tabId);
    if (
      params.type !== 'beforeunload' ||
      !proof ||
      !until ||
      Date.now() > until ||
      !this.expectedRemovals.has(source.tabId) ||
      !this.attached.has(source.tabId) ||
      this.removalDialogs.has(source.tabId) ||
      typeof params.url !== 'string' ||
      !kernelAccessURL(params.url, this.access) ||
      !this.allowRead()
    )
      return;
    this.removalDialogs.add(source.tabId);
    await this.scope(source.tabId);
    if (
      this.owned.get(source.tabId) !== proof ||
      this.removingUntil.get(source.tabId) !== until ||
      Date.now() > until ||
      !this.allowRead()
    )
      throw Error('OWNED_CLOSE_DIALOG_REVOKED');
    await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', {
      accept: true,
    });
  }
  async send(
    target: KernelTarget,
    method: string,
    params: KernelJsonObject,
  ): Promise<KernelJsonObject> {
    // Scope and lease were checked by KernelExecutor immediately before this call.
    // An extra await here would create a gap in which STOP could be followed by a new input.
    if (!this.owned.has(target.tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    if (!this.attached.has(target.tabId)) throw Error('KERNEL_NOT_ATTACHED');
    if (this.access === 'facebook-readonly')
      assertKernelSessionCommand(method, params, new Set(), this.access);
    if (this.access === 'facebook-task' && method !== 'DOM.setFileInputFiles')
      assertKernelSessionCommand(method, params, new Set(), this.access);
    if (
      kernelRequiresOperation(method, this.access) &&
      (!this.journal.writable || !this.allowInput())
    )
      throw Error('KERNEL_OPERATION_REQUIRED');
    if (
      method === 'Target.getTargetInfo' &&
      params.targetId !== undefined &&
      params.targetId !== this.attached.get(target.tabId)
    )
      throw Error('KERNEL_TARGET_NOT_OWNED');
    if (this.access === 'facebook-task' && method === 'Page.bringToFront') {
      if (target.sessionId) throw Error('KERNEL_MAIN_TAB_REQUIRED');
      const proof = this.owned.get(target.tabId);
      const operation = this.currentOperation();
      const guard = () => {
        if (
          !proof ||
          this.owned.get(target.tabId) !== proof ||
          !this.attached.has(target.tabId) ||
          !this.journal.writable ||
          !this.allowInput() ||
          this.currentOperation() !== operation
        )
          throw Error('KERNEL_ACTIVATION_REVOKED');
      };
      guard();
      const focusWindow =
        operation !== undefined &&
        operation.actionDigest ===
          (await digestAction({ kind: 'activateTab', tabId: target.tabId }));
      guard();
      const tab = await chrome.tabs.get(target.tabId);
      guard();
      const window = await chrome.windows.get(tab.windowId);
      guard();
      const mayFocus = focusWindow && (await this.sameProfileForeground());
      guard();
      // Selecting a tab and restoring its containing window are different operations.
      // CDP bringToFront alone can acknowledge a page in a minimized window as still hidden.
      // Preserve normal/maximized geometry; restore only the original tab's minimized window.
      if (window.state === 'minimized' && operation) {
        await chrome.windows.update(tab.windowId, { state: 'normal', focused: false });
        guard();
      }
      await chrome.tabs.update(target.tabId, { active: true });
      guard();
      if (operation) {
        // Preparation only: the following actual Input still passes its original fresh
        // target/identity guard. No new await is inserted immediately before an Input.
        if (!this.isExposed(proof!))
          await this.rendering.ensure(target.tabId, proof!.targetId, guard);
        guard();
        if (this.presentation?.proof !== proof)
          this.presentation = { proof: proof!, checkedAt: -Infinity };
      }
      // Only the original explicit activation grants window focus. Routine wheel/click
      // preparation keeps the selected task tab without repeatedly taking OS focus.
      if (mayFocus && !this.isExposed(proof!) && (await this.sameProfileForeground())) {
        guard();
        await chrome.windows.update(tab.windowId, { focused: true });
        guard();
      }
      return {};
    }
    return KernelJsonObject.parse(
      (await chrome.debugger.sendCommand(target, method, params)) ?? {},
    );
  }
  async project(tabId: number, input: PageProjectionRequest) {
    if (this.access !== 'facebook-readonly') throw Error('KERNEL_PROJECTION_UNAVAILABLE');
    const request = PageReadRequest.parse(input);
    await this.scope(tabId);
    if (!this.allowRead() || !this.attached.has(tabId)) throw Error('KERNEL_READ_FENCED');
    const reply = KernelJsonObject.parse(
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: pageProjectionExpression(request),
        returnByValue: true,
      }),
    );
    if (!this.allowRead()) throw Error('KERNEL_READ_FENCED');
    if (reply.exceptionDetails) throw Error('KERNEL_PROJECTION_FAILED');
    const value = KernelJsonObject.parse(reply.result).value;
    const result = validateProjection(request, value);
    if (!kernelAccessURL(result.url, this.access)) throw Error('KERNEL_SCOPE_CHANGED');
    return result;
  }
  async observeIdentity(tabId: number, assertCurrent: () => void) {
    if (
      this.access !== 'facebook-readonly' ||
      !this.identityReadTabs.has(tabId) ||
      this.identityReadPending ||
      !this.attached.has(tabId)
    )
      throw Error('KERNEL_IDENTITY_TAB_REJECTED');
    this.identityReadPending = true;
    // Single-use read on the new inspection page; retry creates no reload on a retained tab.
    this.identityReadTabs.delete(tabId);
    const guard = async () => {
      assertCurrent();
      if (!this.allowRead()) throw Error('KERNEL_IDENTITY_READ_REVOKED');
      await this.scope(tabId);
      assertCurrent();
      if (!this.allowRead()) throw Error('KERNEL_IDENTITY_READ_REVOKED');
      // tabs.Tab.url is absent without tabs/FB host permission. The existing debugger
      // permission exposes the attached target instead; keep the same exact proof and route.
      const target = KernelTargetInfo.parse(
        KernelJsonObject.parse(await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'))
          .targetInfo,
      );
      assertCurrent();
      if (
        !this.allowRead() ||
        target.type !== 'page' ||
        target.targetId !== this.owned.get(tabId)?.targetId ||
        target.url !== 'https://www.facebook.com/'
      )
        throw Error('KERNEL_IDENTITY_HOME_REQUIRED');
    };
    try {
      return await readNativeFacebookIdentity(tabId, guard);
    } finally {
      this.identityReadPending = false;
    }
  }
  owns(tabId: number): boolean {
    return this.owned.has(tabId);
  }
  detached(tabId: number): void {
    if (this.presentation?.proof.tabId === tabId) this.presentation = undefined;
    this.rendering.forget(tabId);
    this.attached.delete(tabId);
  }
  expectedDetach(tabId: number): boolean {
    return this.expectedDetaches.delete(tabId);
  }
  isExpectedDetach(tabId: number): boolean {
    return this.expectedDetaches.has(tabId) || this.expectedRemovals.has(tabId);
  }
  expectedRemoval(tabId: number): boolean {
    return this.expectedRemovals.has(tabId);
  }
  tabRemoved(tabId: number): void {
    this.identityReadTabs.delete(tabId);
    const proof = this.owned.get(tabId);
    this.owned.delete(tabId);
    this.attached.delete(tabId);
    if (proof)
      void this.journal.tabState(proof.ownershipId, 'CLOSED', 'TAB_REMOVED').catch(() => {});
  }
}
