import type { KernelJournal } from '../src/application/kernel-journal.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import { kernelAccessURL, type KernelAccess } from '../src/shared/kernel-policy.js';
import { KernelJsonObject, KernelTargetInfo } from '../src/shared/kernel-protocol.js';
import {
  OwnedTabProof,
  kernelOperationPending,
  type KernelState,
  type TabProof,
} from '../src/shared/kernel-state.js';
import {
  PageReadRequest,
  validateProjection,
  type PageProjectionRequest,
} from '../src/shared/page-read.js';
import type { Binding } from '../src/shared/task-execution.js';
import { readNativeFacebookIdentity } from './facebook-identity-reader.js';
import { pageProjectionExpression } from './page-projection.js';
import type { TaskRendering } from './task-rendering.js';
import { sha256Hex, sleep, type WorkspacePageGroup } from './workspace-page-group.js';
export interface KernelProjectionContext {
  readonly access: KernelAccess;
  readonly journal: KernelJournal;
  readonly workspaceGroup: WorkspacePageGroup;
  readonly owned: Map<number, TabProof>;
  readonly attached: Map<number, string>;
  readonly expectedDetaches: Set<number>;
  readonly expectedRemovals: Set<number>;
  readonly identityReadTabs: Set<number>;
  readonly rendering: TaskRendering;
  allowRead(): boolean;
  currentOperation(): Binding | undefined;
  scope(tabId: number): Promise<void>;
  clearTabPresentation(tabId: number): void;
  isIdentityReadPending(): boolean;
  setIdentityReadPending(value: boolean): void;
}
const hasReadyProof = (state: KernelState, proof: TabProof) =>
  state.tabs.some((r) => r.state === 'READY' && r.proof && sameTabProof(r.proof, proof));
export const isReadyTabRecord = (
  record: KernelState['tabs'][number] | undefined,
  proof: TabProof,
  browserSessionEpoch: string,
) =>
  record?.state === 'READY' &&
  !!record.proof &&
  sameTabProof(record.proof, proof) &&
  proof.browserSessionEpoch === browserSessionEpoch;
const newOwnedProof = (
  profileId: string,
  browserSessionEpoch: string,
  tabId: number,
  targetId: string,
) =>
  OwnedTabProof.parse({
    ownershipId: crypto.randomUUID(),
    profileId,
    browserSessionEpoch,
    tabId,
    targetId,
  });
const findTarget = async (pred: (r: chrome.debugger.TargetInfo) => boolean) =>
  (await chrome.debugger.getTargets()).find(pred);
async function detachOwnedTabIfAttached(ctx: KernelProjectionContext, tabId: number) {
  if (!ctx.attached.has(tabId)) return;
  ctx.expectedDetaches.add(tabId);
  try {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  } finally {
    ctx.attached.delete(tabId);
  }
}
async function pollFacebookPageTarget(tabId: number, check: () => void) {
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    check();
    const target = await findTarget(
      (r) => r.tabId === tabId && r.type === 'page' && kernelAccessURL(r.url, 'facebook-task'),
    );
    check();
    if (target) return target;
  }
  return undefined;
}
async function buildWorkspaceSnapshot(
  ctx: KernelProjectionContext,
  cachedState?: KernelState,
  cachedRevision?: number,
) {
  const stale = (rev: number) => !ctx.journal.writable || ctx.journal.currentRevision !== rev;
  let state =
      cachedState !== undefined && cachedRevision !== undefined && !stale(cachedRevision)
        ? cachedState
        : await ctx.journal.snapshot(),
    stateRev = ctx.journal.currentRevision;
  if (!chrome.storage?.local) return stale(stateRev) ? await ctx.journal.snapshot() : state;
  const main = await ctx.workspaceGroup.read(() => {
    if (!ctx.allowRead()) throw Error('KERNEL_READ_FENCED');
  });
  if (stale(stateRev)) {
    state = await ctx.journal.snapshot();
    stateRev = ctx.journal.currentRevision;
  }
  if (!main || !hasReadyProof(state, main.proof)) return state;
  const target = await findTarget(
    (r) => r.tabId === main.proof.tabId && r.id === main.proof.targetId,
  );
  if (!ctx.allowRead()) throw Error('KERNEL_READ_FENCED');
  if (stale(stateRev)) {
    state = await ctx.journal.snapshot();
    if (!hasReadyProof(state, main.proof)) return state;
  }
  return target?.type === 'page' && kernelAccessURL(target.url, 'facebook-task')
    ? { ...state, workspaceMain: main.proof }
    : state;
}
export async function inspectWorkspaceInventory(ctx: KernelProjectionContext): Promise<unknown> {
  const before = await ctx.journal.snapshot();
  let currentRev = ctx.journal.currentRevision,
    mutated = false;
  const assertRead = () => {
    if (!ctx.allowRead()) throw Error('KERNEL_READ_FENCED');
  };
  if (
    ctx.allowRead() &&
    !before.operations.some((r) => r.state !== 'RECONCILED' && !r.disposition)
  ) {
    const withdrawn = before.tabs.filter(
      (r) =>
        r.state === 'LOST' &&
        ['TASK_ENDED_OWNERSHIP_WITHDRAWN', 'BROWSER_SESSION_CHANGED'].includes(r.reason),
    );
    if (withdrawn.length && chrome.storage?.local) {
      const main = await ctx.workspaceGroup.read(assertRead),
        orig = withdrawn.find((r) => main && r.proof && sameTabProof(main.proof, r.proof));
      if (main && orig?.proof) {
        const target = await findTarget(
          (r) => r.tabId === orig.proof?.tabId && r.id === orig.proof?.targetId,
        );
        assertRead();
        if (target?.type === 'page' && kernelAccessURL(target.url, 'facebook-task')) {
          if (
            orig.reason === 'TASK_ENDED_OWNERSHIP_WITHDRAWN' &&
            orig.proof.browserSessionEpoch === before.browserSessionEpoch
          ) {
            await ctx.journal.restoreWithdrawnTab(orig.proof);
            mutated = true;
          } else if (
            orig.reason === 'BROWSER_SESSION_CHANGED' &&
            orig.proof.profileId === before.profileId
          ) {
            const known = before.tabs.find(
                (r) =>
                  r.state === 'READY' &&
                  r.proof?.tabId === orig.proof?.tabId &&
                  r.proof?.targetId === orig.proof?.targetId,
              )?.proof,
              proof =
                known ??
                newOwnedProof(
                  orig.proof.profileId,
                  before.browserSessionEpoch,
                  orig.proof.tabId,
                  orig.proof.targetId,
                );
            if (!known) {
              await ctx.journal.reobserveMain(orig.proof, proof, target.url);
              mutated = true;
            }
            await ctx.workspaceGroup.rebind(orig.proof, proof, assertRead);
          }
        }
      }
    }
  }
  const observed =
    mutated || !ctx.journal.writable || ctx.journal.currentRevision !== currentRev
      ? await ctx.journal.snapshot()
      : before;
  currentRev = ctx.journal.currentRevision;
  const retained = observed.tabs.filter(
    (r) =>
      r.state === 'READY' &&
      r.proof?.browserSessionEpoch === observed.browserSessionEpoch &&
      !ctx.owned.has(r.proof.tabId),
  );
  if (!retained.length) return buildWorkspaceSnapshot(ctx, observed, currentRev);
  assertRead();
  const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
  assertRead();
  const absent = retained.filter(
    (r) =>
      r.proof &&
      !tabs.some((t) => t.id === r.proof?.tabId) &&
      !targets.some((t) => t.tabId === r.proof?.tabId || t.id === r.proof?.targetId),
  );
  if (!absent.length) return buildWorkspaceSnapshot(ctx, observed, currentRev);
  const confirmedTabs = await chrome.tabs.query({});
  assertRead();
  for (const row of absent) {
    if (!confirmedTabs.some((t) => t.id === row.proof?.tabId))
      await ctx.journal.tabState(row.ownershipId, 'CLOSED', 'RETAINED_TARGET_ABSENT');
    assertRead();
  }
  return buildWorkspaceSnapshot(ctx, observed, currentRev);
}
export async function consolidateWorkspaceTabs(
  ctx: KernelProjectionContext,
  preferActiveTab = true,
): Promise<{ proof: TabProof; url: string; closedTabIds: number[]; remainingTabCount: number }> {
  const check = () => {
    if (ctx.access !== 'facebook-task' || !ctx.allowRead())
      throw Error('WORKSPACE_CLEANUP_REVOKED');
  };
  check();
  const state = await ctx.journal.snapshot();
  check();
  if (ctx.currentOperation()) throw Error('WORKSPACE_CLEANUP_OPERATION_ACTIVE');
  for (const row of state.operations.filter((r) => r.state !== 'RECONCILED' && !r.disposition)) {
    check();
    if (row.state === 'DISPATCHING')
      await ctx.journal.finish(row.binding, 'UNKNOWN', 'IDLE_WORKSPACE_CLEANUP');
    await ctx.journal.endUnknown(row.binding, {
      id: crypto.randomUUID(),
      outcome: 'ENDED_UNKNOWN',
      evidenceDigest: await sha256Hex(
        JSON.stringify({ reason: 'Idle workspace cleanup', binding: row.binding }),
      ),
    });
  }
  const [windows, allTabs, initialTargets] = await Promise.all([
    typeof chrome.windows?.getAll === 'function'
      ? chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
      : Promise.resolve([]),
    chrome.tabs.query({}),
    chrome.debugger.getTargets(),
  ]);
  check();
  const isFbPage = (tabId: number | undefined) => {
    if (tabId === undefined) return undefined;
    const t = initialTargets.find((r) => r.tabId === tabId && r.type === 'page');
    return t && kernelAccessURL(t.url, 'facebook-task') ? t : undefined;
  };
  const activeWin = windows.find((w) => w.focused) ?? windows[0];
  const activeTab =
    activeWin?.tabs?.find((t) => t.active && t.id !== undefined) ??
    allTabs.find((t) => t.active && t.id !== undefined) ??
    allTabs.find((t) => t.id !== undefined);
  const registeredMain = chrome.storage?.local ? await ctx.workspaceGroup.read(check) : null;
  check();
  let chosenTarget =
    (preferActiveTab ? isFbPage(activeTab?.id) : undefined) ??
    isFbPage(registeredMain?.proof.tabId) ??
    isFbPage(activeTab?.id) ??
    allTabs.map((t) => isFbPage(t.id)).find(Boolean);
  let chosenTabId = chosenTarget?.tabId;
  if (chosenTabId === undefined || !chosenTarget) {
    if (activeTab?.id !== undefined) {
      chosenTabId = activeTab.id;
      await chrome.tabs.update(chosenTabId, { url: 'https://www.facebook.com/', active: true });
    } else {
      const created = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true });
      if (created.id === undefined) throw Error('WORKSPACE_CLEANUP_CREATE_FAILED');
      chosenTabId = created.id;
    }
    check();
    chosenTarget = await pollFacebookPageTarget(chosenTabId, check);
    if (!chosenTarget) throw Error('WORKSPACE_CLEANUP_TARGET_UNCONFIRMED');
  }
  const boundProof = await ctx.journal.bindWorkspaceMainTab(
    newOwnedProof(state.profileId, state.browserSessionEpoch, chosenTabId, chosenTarget.id),
    chosenTarget.url,
  );
  check();
  ctx.owned.set(chosenTabId, boundProof);
  if (chrome.storage?.local) {
    await ctx.workspaceGroup.forceBindMain(boundProof, check);
    check();
  }
  const closedTabIds: number[] = [];
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || tab.id === chosenTabId) continue;
    const otherId = tab.id;
    ctx.expectedRemovals.add(otherId);
    try {
      await detachOwnedTabIfAttached(ctx, otherId);
      await chrome.tabs.remove(otherId);
      closedTabIds.push(otherId);
    } catch {
    } finally {
      ctx.identityReadTabs.delete(otherId);
      ctx.owned.delete(otherId);
      ctx.expectedRemovals.delete(otherId);
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
export async function recoverOwnedTabToHome(
  ctx: KernelProjectionContext,
  input: TabProof,
): Promise<{ proof: TabProof; url: string; targetChanged: boolean }> {
  if (ctx.access !== 'facebook-task') throw Error('TAB_RESET_SCOPE_REJECTED');
  const check = () => {
    if (!ctx.allowRead() || !ctx.journal.writable) throw Error('KERNEL_READ_FENCED');
    if (ctx.currentOperation()) throw Error('TAB_RESET_OPERATION_ACTIVE');
  };
  check();
  const proof = OwnedTabProof.parse(input),
    state = await ctx.journal.snapshot();
  check();
  if (state.operations.some(kernelOperationPending)) throw Error('TAB_RESET_OPERATION_PENDING');
  const record = state.tabs.find((r) => r.ownershipId === proof.ownershipId);
  if (!isReadyTabRecord(record, proof, state.browserSessionEpoch))
    throw Error('TAB_RESET_PROOF_REJECTED');
  const initialTarget = await findTarget((r) => r.tabId === proof.tabId);
  check();
  if (!initialTarget || initialTarget.type !== 'page' || initialTarget.id !== proof.targetId)
    throw Error('KERNEL_TAB_IDENTITY_CHANGED');
  await detachOwnedTabIfAttached(ctx, proof.tabId);
  ctx.rendering.forget(proof.tabId);
  check();
  ctx.clearTabPresentation(proof.tabId);
  await chrome.tabs.update(proof.tabId, { url: 'https://www.facebook.com/' });
  check();
  const freshTarget = await pollFacebookPageTarget(proof.tabId, check);
  if (!freshTarget) throw Error('TAB_RESET_TARGET_UNCONFIRMED');
  if (freshTarget.id === proof.targetId)
    return (
      ctx.owned.set(proof.tabId, proof),
      { proof, url: freshTarget.url, targetChanged: false }
    );
  const boundProof = await ctx.journal.rebindRecoveredTab(
    proof,
    newOwnedProof(state.profileId, state.browserSessionEpoch, proof.tabId, freshTarget.id),
    freshTarget.url,
  );
  check();
  ctx.owned.set(proof.tabId, boundProof);
  if (chrome.storage?.local) {
    const currentMain = await ctx.workspaceGroup.read(check).catch(() => null);
    if (currentMain && sameTabProof(currentMain.proof, proof)) {
      await ctx.workspaceGroup.forceBindMain(boundProof, check);
      check();
    }
  }
  return { proof: boundProof, url: freshTarget.url, targetChanged: true };
}
export async function projectTabPage(
  ctx: KernelProjectionContext,
  tabId: number,
  input: PageProjectionRequest,
) {
  if (ctx.access !== 'facebook-readonly') throw Error('KERNEL_PROJECTION_UNAVAILABLE');
  const request = PageReadRequest.parse(input);
  await ctx.scope(tabId);
  if (!ctx.allowRead() || !ctx.attached.has(tabId)) throw Error('KERNEL_READ_FENCED');
  const reply = KernelJsonObject.parse(
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: pageProjectionExpression(request),
      returnByValue: true,
    }),
  );
  if (!ctx.allowRead()) throw Error('KERNEL_READ_FENCED');
  if (reply.exceptionDetails) throw Error('KERNEL_PROJECTION_FAILED');
  const result = validateProjection(request, KernelJsonObject.parse(reply.result).value);
  if (!kernelAccessURL(result.url, ctx.access)) throw Error('KERNEL_SCOPE_CHANGED');
  return result;
}
export async function observeTabIdentity(
  ctx: KernelProjectionContext,
  tabId: number,
  assertCurrent: () => void,
) {
  if (
    ctx.access !== 'facebook-readonly' ||
    !ctx.identityReadTabs.has(tabId) ||
    ctx.isIdentityReadPending() ||
    !ctx.attached.has(tabId)
  )
    throw Error('KERNEL_IDENTITY_TAB_REJECTED');
  ctx.setIdentityReadPending(true);
  ctx.identityReadTabs.delete(tabId);
  const guard = async () => {
    assertCurrent();
    if (!ctx.allowRead()) throw Error('KERNEL_IDENTITY_READ_REVOKED');
    await ctx.scope(tabId);
    assertCurrent();
    if (!ctx.allowRead()) throw Error('KERNEL_IDENTITY_READ_REVOKED');
    const target = KernelTargetInfo.parse(
      KernelJsonObject.parse(await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'))
        .targetInfo,
    );
    assertCurrent();
    if (
      !ctx.allowRead() ||
      target.type !== 'page' ||
      target.targetId !== ctx.owned.get(tabId)?.targetId ||
      target.url !== 'https://www.facebook.com/'
    )
      throw Error('KERNEL_IDENTITY_HOME_REQUIRED');
  };
  try {
    return await readNativeFacebookIdentity(tabId, guard);
  } finally {
    ctx.setIdentityReadPending(false);
  }
}
