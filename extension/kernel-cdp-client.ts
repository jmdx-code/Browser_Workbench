import { canonicalAction } from '../src/bridge/protocol.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import {
  assertKernelSessionCommand,
  kernelAccessURL,
  kernelRequiresOperation,
} from '../src/shared/kernel-policy.js';
import {
  KernelJsonObject,
  KernelTargetInfo,
  type KernelTarget,
} from '../src/shared/kernel-protocol.js';
import { OwnedTabProof, type TabProof } from '../src/shared/kernel-state.js';
import type { KernelProjectionContext } from './kernel-page-projection.js';
import {
  sha256Hex,
  unminimizeWindow,
  waitTabRevealed,
  withBoundedWait,
} from './workspace-page-group.js';
export function isBenignDetachError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return (
    !msg.includes('DEBUGGER_DETACH_TIMEOUT') &&
    /Debugger is not attached|No tab with (?:given )?id/i.test(msg)
  );
}
export type PresentationState = {
  proof: TabProof;
  checkedAt: number;
  inactiveSince?: number;
  visibility?: string;
  visibilityAt?: number;
  probe?: Promise<void>;
  diagnostic?: string;
  reportedAt?: number;
};
export interface KernelCdpContext extends KernelProjectionContext {
  readonly removingUntil: Map<number, number>;
  readonly removalDialogs: Set<number>;
  allowInput(): boolean;
  sameProfileForeground(): Promise<boolean>;
  isExposed(proof: TabProof): boolean;
  ensurePresentation(proof: TabProof): void;
  clearExposedIfTab(tabId: number): void;
  presentationNow(): number;
  reportPresentation(proof: TabProof, state: KernelJsonObject): void;
  getPresentation(): PresentationState | undefined;
  setPresentation(value: PresentationState | undefined): void;
  getPresenting(): Promise<void> | undefined;
  setPresenting(value: Promise<void> | undefined): void;
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));
export async function attachDebuggerTarget(ctx: KernelCdpContext, tabId: number) {
  if (!ctx.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
  await ctx.scope(tabId);
  if (!ctx.attached.has(tabId)) {
    ctx.expectedDetaches.delete(tabId);
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      if (!(error instanceof Error && /Another debugger is already attached/i.test(error.message)))
        throw error;
      ctx.expectedDetaches.add(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
      ctx.expectedDetaches.delete(tabId);
      await chrome.debugger.attach({ tabId }, '1.3');
    }
    ctx.attached.set(tabId, '');
  }
  const info = KernelTargetInfo.parse(
      KernelJsonObject.parse(await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'))
        .targetInfo,
    ),
    url = ctx.access === 'agent-browser' && info.url === '' ? 'about:blank' : info.url;
  if (
    !kernelAccessURL(url, ctx.access) ||
    info.type !== 'page' ||
    info.targetId !== ctx.owned.get(tabId)?.targetId
  )
    throw Error('KERNEL_SCOPE_CHANGED');
  ctx.attached.set(tabId, info.targetId);
  return info;
}
export function clearTabDebugState(
  ctx: Pick<
    KernelCdpContext,
    'clearExposedIfTab' | 'clearTabPresentation' | 'rendering' | 'attached'
  >,
  tabId: number,
  forgetAttachment = false,
): void {
  ctx.clearExposedIfTab(tabId);
  ctx.clearTabPresentation(tabId);
  ctx.rendering.forget(tabId);
  if (forgetAttachment) ctx.attached.delete(tabId);
}
export async function detachDebuggerTarget(
  ctx: KernelCdpContext,
  tabId: number,
  timeoutMs = 3_000,
): Promise<void> {
  clearTabDebugState(ctx, tabId);
  if (!ctx.attached.has(tabId)) return;
  if (!ctx.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
  ctx.expectedDetaches.add(tabId);
  try {
    const res = await withBoundedWait(chrome.debugger.detach({ tabId }), timeoutMs);
    if (!res.completed) throw Error('DEBUGGER_DETACH_TIMEOUT');
    ctx.attached.delete(tabId);
  } catch (error) {
    if (isBenignDetachError(error)) return void ctx.attached.delete(tabId);
    throw error;
  }
}
export async function handleClosingDialog(
  ctx: KernelCdpContext,
  source: KernelTarget,
  method: string,
  value: unknown,
): Promise<void> {
  if (
    (ctx.access !== 'facebook-task' && ctx.access !== 'agent-browser') ||
    method !== 'Page.javascriptDialogOpening' ||
    source.sessionId
  )
    return;
  const params = KernelJsonObject.parse(value ?? {}),
    proof = ctx.owned.get(source.tabId),
    until = ctx.removingUntil.get(source.tabId),
    valid = () =>
      Boolean(
        proof &&
        until &&
        Date.now() <= until &&
        ctx.owned.get(source.tabId) === proof &&
        ctx.removingUntil.get(source.tabId) === until &&
        ctx.allowRead(),
      );
  if (
    params.type !== 'beforeunload' ||
    !valid() ||
    !ctx.expectedRemovals.has(source.tabId) ||
    !ctx.attached.has(source.tabId) ||
    ctx.removalDialogs.has(source.tabId) ||
    typeof params.url !== 'string' ||
    !kernelAccessURL(params.url, ctx.access)
  )
    return;
  ctx.removalDialogs.add(source.tabId);
  await ctx.scope(source.tabId);
  if (!valid()) throw Error('OWNED_CLOSE_DIALOG_REVOKED');
  await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', {
    accept: true,
  });
}
export async function sendCdpCommand(
  ctx: KernelCdpContext,
  target: KernelTarget,
  method: string,
  params: KernelJsonObject,
): Promise<KernelJsonObject> {
  if (!ctx.owned.has(target.tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
  if (!ctx.attached.has(target.tabId)) throw Error('KERNEL_NOT_ATTACHED');
  if (
    ctx.access === 'facebook-readonly' ||
    ((ctx.access === 'facebook-task' || ctx.access === 'agent-browser') &&
      method !== 'DOM.setFileInputFiles')
  )
    assertKernelSessionCommand(method, params, new Set(), ctx.access);
  const assertLive = () => {
    if (
      !ctx.allowRead() ||
      (method === 'Page.captureScreenshot' &&
        (!ctx.owned.has(target.tabId) || !ctx.attached.has(target.tabId)))
    )
      throw Error('KERNEL_READ_FENCED');
  };
  if (
    ctx.access === 'agent-browser' &&
    (method === 'Page.bringToFront' || method === 'Page.captureScreenshot')
  ) {
    if (target.sessionId) throw Error('KERNEL_MAIN_TAB_REQUIRED');
    assertLive();
    const tab = await chrome.tabs.get(target.tabId);
    assertLive();
    if (method === 'Page.bringToFront') {
      if (tab.windowId !== undefined) {
        const win = await unminimizeWindow(tab.windowId, undefined, true);
        if (win?.state !== 'minimized')
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      assertLive();
      await chrome.tabs.update(target.tabId, { active: true });
      return {};
    }
    const restoreTabId =
      !tab.active && tab.windowId !== undefined
        ? (await chrome.tabs.query({ windowId: tab.windowId, active: true }).catch(() => [])).find(
            (t) => typeof t.id === 'number' && t.id !== target.tabId,
          )?.id
        : undefined;
    try {
      if (tab.windowId !== undefined) await unminimizeWindow(tab.windowId);
      if (!tab.active) await chrome.tabs.update(target.tabId, { active: true });
      for (const [m, p] of [
        ['Emulation.setFocusEmulationEnabled', { enabled: true }],
        ['Page.setWebLifecycleState', { state: 'active' }],
      ] as const)
        await chrome.debugger.sendCommand(target, m, p).catch(() => {});
      assertLive();
      return KernelJsonObject.parse(
        (await chrome.debugger.sendCommand(target, method, params)) ?? {},
      );
    } finally {
      if (restoreTabId !== undefined)
        await chrome.tabs.update(restoreTabId, { active: true }).catch(() => {});
    }
  }
  if (kernelRequiresOperation(method, ctx.access) && (!ctx.journal.writable || !ctx.allowInput()))
    throw Error('KERNEL_OPERATION_REQUIRED');
  if (
    method === 'Target.getTargetInfo' &&
    params.targetId !== undefined &&
    params.targetId !== ctx.attached.get(target.tabId)
  )
    throw Error('KERNEL_TARGET_NOT_OWNED');
  if (ctx.access === 'facebook-task' && method === 'Page.bringToFront') {
    if (target.sessionId) throw Error('KERNEL_MAIN_TAB_REQUIRED');
    const proof = ctx.owned.get(target.tabId),
      operation = ctx.currentOperation(),
      guard = () => {
        if (
          !proof ||
          ctx.owned.get(target.tabId) !== proof ||
          !ctx.attached.has(target.tabId) ||
          !ctx.journal.writable ||
          !ctx.allowInput() ||
          ctx.currentOperation() !== operation
        )
          throw Error('KERNEL_ACTIVATION_REVOKED');
      },
      step = async <T>(work: Promise<T>): Promise<T> => {
        const res = await work;
        guard();
        return res;
      };
    guard();
    if (!proof) throw Error('KERNEL_ACTIVATION_REVOKED');
    const focusWindow =
        operation !== undefined &&
        operation.actionDigest ===
          (await sha256Hex(canonicalAction({ kind: 'activateTab', tabId: target.tabId }))),
      _checked = (guard(), undefined),
      tab = await step(chrome.tabs.get(target.tabId)),
      window = await step(chrome.windows.get(tab.windowId)),
      mayFocus = focusWindow && (await step(ctx.sameProfileForeground()));
    void _checked;
    if (window.state === 'minimized' && operation)
      await step(chrome.windows.update(tab.windowId, { state: 'normal', focused: false }));
    await step(chrome.tabs.update(target.tabId, { active: true }));
    if (operation) {
      await step(ctx.rendering.ensure(target.tabId, proof.targetId, guard));
      ctx.ensurePresentation(proof);
    }
    if (mayFocus && !ctx.isExposed(proof) && (await step(ctx.sameProfileForeground())))
      await step(chrome.windows.update(tab.windowId, { focused: true }));
    return {};
  }
  return KernelJsonObject.parse((await chrome.debugger.sendCommand(target, method, params)) ?? {});
}
export async function armTaskPresentationHelper(
  ctx: KernelCdpContext,
  proof: TabProof,
): Promise<void> {
  const owned = ctx.owned.get(proof.tabId);
  if (!owned) throw Error('TASK_PRESENTATION_SCOPE_REJECTED');
  const guard = () => {
    if (
      ctx.access !== 'facebook-task' ||
      !ctx.allowRead() ||
      !ctx.journal.writable ||
      ctx.owned.get(proof.tabId) !== owned ||
      !sameTabProof(owned, proof) ||
      ctx.attached.get(proof.tabId) !== proof.targetId
    )
      throw Error('TASK_PRESENTATION_SCOPE_REJECTED');
  };
  guard();
  await ctx.scope(proof.tabId);
  guard();
  if (
    typeof chrome !== 'undefined' &&
    typeof chrome.tabs?.get === 'function' &&
    typeof chrome.windows?.get === 'function'
  ) {
    const tab = await chrome.tabs.get(proof.tabId).catch(() => null);
    guard();
    if (tab && tab.windowId !== undefined) {
      await unminimizeWindow(tab.windowId, guard);
      if (tab.active === false) {
        await chrome.tabs.update(proof.tabId, { active: true }).catch(() => {});
        guard();
      }
    }
  }
  await ctx.rendering.ensure(proof.tabId, owned.targetId, guard).catch(() => {});
  guard();
  ctx.setPresentation({ proof: owned, checkedAt: -Infinity });
  ctx.reportPresentation(owned, { phase: 'ARMED' });
}
export function maintainPresentationHelper(ctx: KernelCdpContext): void {
  const presentation = ctx.getPresentation();
  if (ctx.access !== 'facebook-task' || !presentation || ctx.getPresenting()) return;
  const at = ctx.presentationNow();
  if (at - presentation.checkedAt < 8_000) return;
  presentation.checkedAt = at;
  const { proof } = presentation,
    tabId = proof.tabId,
    report = (phase: string, extra: KernelJsonObject) => {
      if (ctx.getPresentation() === presentation && ctx.allowRead())
        ctx.reportPresentation(proof, { phase, ...extra });
    },
    pending = (async () => {
      const guard = () => {
        if (
          ctx.getPresentation() !== presentation ||
          ctx.owned.get(tabId) !== proof ||
          ctx.attached.get(tabId) !== proof.targetId ||
          !ctx.allowRead() ||
          !ctx.journal.writable
        )
          throw Error('KERNEL_PRESENTATION_REVOKED');
      };
      guard();
      const tab = await chrome.tabs.get(tabId);
      guard();
      let observedUrl = tab.url ?? '';
      if (!observedUrl && typeof chrome.debugger?.getTargets === 'function') {
        observedUrl =
          (await chrome.debugger.getTargets().catch(() => [])).find((r) => r.tabId === tabId)
            ?.url ?? '';
        guard();
      }
      if (!observedUrl || observedUrl === 'about:blank') return;
      if (!kernelAccessURL(observedUrl, 'facebook-task'))
        throw Error('KERNEL_PRESENTATION_URL_CHANGED');
      const window = await unminimizeWindow(tab.windowId, guard);
      if (!window) throw Error('KERNEL_PRESENTATION_REVOKED');
      if (!tab.active) {
        await chrome.tabs.update(tabId, { active: true });
        guard();
      }
      const hadPendingProbe = !!presentation.probe;
      if (!presentation.probe) {
        const probe = (async () => {
          await ctx.rendering.ensure(tabId, proof.targetId, guard);
          guard();
          const value = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: 'document.visibilityState',
            returnByValue: true,
          });
          guard();
          const rv = KernelJsonObject.parse(value ?? {}).result,
            visibility = isObj(rv) ? rv.value : undefined;
          if (visibility !== 'hidden' && visibility !== 'visible')
            throw Error('TASK_PRESENTATION_VISIBILITY_UNAVAILABLE');
          presentation.visibility = visibility;
          presentation.visibilityAt = Date.now();
          if (visibility === 'hidden') {
            await ctx.rendering.refresh(tabId, proof.targetId, guard);
            guard();
          }
        })();
        presentation.probe = probe;
        void probe
          .catch((error: unknown) => report('PROBE_ERROR', { reason: String(error).slice(0, 200) }))
          .finally(() => {
            if (presentation.probe === probe) presentation.probe = undefined;
          });
      }
      presentation.inactiveSince =
        window.focused === false ? (presentation.inactiveSince ?? at) : undefined;
      const diag = {
          phase: 'CHECK',
          windowFocused: window.focused ?? null,
          visibility: presentation.visibility ?? null,
          probePending: hadPendingProbe,
        },
        diagnostic = JSON.stringify(diag);
      if (presentation.diagnostic !== diagnostic) {
        presentation.diagnostic = diagnostic;
        presentation.reportedAt = at;
        ctx.reportPresentation(proof, {
          ...diag,
          ...(presentation.visibilityAt !== undefined
            ? { visibilityAt: presentation.visibilityAt }
            : {}),
        });
      }
      if (
        presentation.visibility === 'hidden' &&
        presentation.visibilityAt !== undefined &&
        Date.now() - presentation.visibilityAt <= 5000
      ) {
        await ctx.rendering.refresh(tabId, proof.targetId, guard).catch(() => {});
        guard();
      }
    })();
  ctx.setPresenting(pending);
  void pending
    .catch((error: unknown) => report('MONITOR_ERROR', { reason: String(error).slice(0, 200) }))
    .finally(() => {
      if (ctx.getPresenting() === pending) ctx.setPresenting(undefined);
    });
}
export async function revealOwnedPageHelper(
  ctx: KernelCdpContext,
  proof: TabProof,
  focus = true,
): Promise<{ tabId: number; focused: boolean }> {
  proof = OwnedTabProof.parse(proof);
  const check = () => {
    const owned = ctx.owned.get(proof.tabId);
    if (!ctx.allowRead() || !owned || !sameTabProof(owned, proof))
      throw Error('WORKSPACE_REVEAL_REVOKED');
  };
  check();
  await ctx.scope(proof.tabId);
  check();
  const tab = await chrome.tabs.get(proof.tabId);
  check();
  await unminimizeWindow(tab.windowId, check, focus);
  await chrome.tabs.update(proof.tabId, { active: true });
  check();
  if (!focus && ctx.attached.get(proof.tabId) === proof.targetId) {
    await ctx.rendering.ensure(proof.tabId, proof.targetId, check).catch(() => {});
    check();
  }
  if (focus) {
    await chrome.windows.update(tab.windowId, { focused: true });
    check();
  }
  const observedFocused = await waitTabRevealed(proof.tabId, tab.windowId, focus, check);
  await ctx.scope(proof.tabId);
  check();
  return { tabId: proof.tabId, focused: focus ? true : observedFocused };
}
