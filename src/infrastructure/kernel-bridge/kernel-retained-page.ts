import type { Page } from 'playwright-core';
import { ZodError } from 'zod';
import { ProductError } from '../../domain/workspace.js';
import type { Awaitable } from '../../domain/persistence.js';
import { sameTabProof } from '../../domain/task-tabs.js';
import type { Peer } from '../../bridge/core.js';
import { FacebookBrowseURL } from '../../shared/browser-actions.js';
import { KernelJsonObject } from '../../shared/kernel-protocol.js';
import {
  KernelOperationRecord,
  KernelPersistentState,
  OwnedTabProof,
  OwnedTabRecord,
  kernelOperationPending,
  type KernelState,
  type TabProof,
} from '../../shared/kernel-state.js';
import { profileForegroundGranted } from '../../shared/profile-foreground.js';
import { SettlementReceipt, sameNotice } from '../../shared/settlement.js';
import { ExecutionContext } from '../../shared/task-execution.js';
import { readCurrentFacebookBrowseIdentity } from '../facebook-browse-identity.js';
import type {
  InspectOwnedFacebookPageFn,
  KernelInspectionDeps,
} from './kernel-facebook-inspection.js';
import {
  archivedNotice,
  isPeerPaused,
  isStuckDocumentRecoveryError,
  maintainJournal,
  openKernelRpcSession,
  type FacebookOwnedOptions,
  type KernelSessionHost,
  type KernelSummaryPort,
} from './kernel-rpc-session.js';
export function isRetainedSafeFacebookUrl(url: string): boolean {
  if (!url || !/^https:\/\/www\.facebook\.com\//.test(url)) return false;
  try {
    return !/^\/(?:login|recover|checkpoint|disabled|suspended|account_status|restriction|messages)(?:\.php|\/|$)/.test(
      new URL(url).pathname.toLowerCase(),
    );
  } catch {
    return false;
  }
}
export async function discardFacebookDraftIfPresent(
  page: Page,
  guard: () => Awaitable<void>,
): Promise<void> {
  if (typeof page?.evaluate !== 'function') return;
  await guard();
  const clickedInitial = await page
    .evaluate(() => {
      try {
        window.onbeforeunload = null;
        if (typeof BeforeUnloadEvent !== 'undefined') {
          BeforeUnloadEvent.prototype.preventDefault = () => {};
          Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', {
            configurable: true,
            get: () => '',
            set: () => {},
          });
        }
      } catch {}
      const visible = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          Number(s.opacity) > 0
        );
      };
      if (/^\/stories\/create\/?$/i.test(location.pathname)) {
        if (
          !document.querySelector(
            '[data-wb-story-preview="1"],[role="main"][aria-label="Stories Creation Preview"],textarea,[contenteditable="true"]',
          )
        )
          return false;
        const btn = Array.from(document.querySelectorAll<HTMLElement>('[role="button"],button'))
          .filter(visible)
          .find((el) =>
            /^(?:舍弃|捨棄|放弃|放棄|Discard|Discard\s*story|取消|Cancel)$/i.test(
              (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
            ),
          );
        if (btn) {
          btn.click();
          return true;
        }
      }
      if (location.pathname === '/') {
        for (const d of Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"]'),
        ).filter(visible)) {
          const closeBtn = Array.from(
            d.querySelectorAll<HTMLElement>(
              '[role="button"][aria-label="关闭"],[role="button"][aria-label="關閉"],[role="button"][aria-label="Close"],button[aria-label="关闭"],button[aria-label="關閉"],button[aria-label="Close"]',
            ),
          ).find(visible);
          if (closeBtn) {
            closeBtn.click();
            return true;
          }
        }
      }
      return false;
    })
    .catch(() => false);
  if (!clickedInitial) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
  await guard();
  const clickedConfirm = await page
    .evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          Number(s.opacity) > 0
        );
      };
      const confirmRx =
        /^(?:舍弃|捨棄|放弃|放棄|不保存|确定|確定|Discard|Discard\s*story|Discard\s*post|Leave|Leave\s*Page)$/i;
      for (const d of Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
        ),
      ).filter(visible)) {
        const btn = Array.from(d.querySelectorAll<HTMLElement>('[role="button"],button')).find(
          (el) =>
            visible(el) &&
            confirmRx.test(
              (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
            ),
        );
        if (btn) {
          btn.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  if (clickedConfirm) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await guard();
  }
}
export async function navigateRetainedPageHomeImpl(
  page: Page,
  guard: () => Awaitable<void>,
): Promise<boolean> {
  const url = typeof page.url === 'function' ? page.url() : '';
  if (!isRetainedSafeFacebookUrl(url)) return false;
  await discardFacebookDraftIfPresent(page, guard);
  await guard();
  const onDialog = (dialog: { type(): string; accept(): Promise<void> }) => {
    if (dialog.type() === 'beforeunload') void dialog.accept().catch(() => {});
  };
  if (typeof page.on === 'function') page.on('dialog', onDialog);
  try {
    const isFatal = (err: unknown): boolean =>
      err instanceof Error &&
      /Target page, context or browser has been closed|Session closed|Inspector\.detached|KERNEL_DEBUGGER_|KERNEL_CONNECTION_LOST/i.test(
        err.message,
      );
    const beforeNav = await page
      .evaluate(() => ({
        path: location.pathname,
        origin: typeof performance !== 'undefined' ? performance.timeOrigin : 0,
      }))
      .catch(() => null);
    await page
      .evaluate(() => {
        try {
          window.onbeforeunload = null;
        } catch {}
        location.assign('https://www.facebook.com/');
      })
      .catch((err: unknown) => {
        if (isFatal(err)) throw err;
      });
    const started = performance.now();
    while (performance.now() - started < 15_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      await guard();
      const state = await page
        .evaluate(() => ({
          url: location.href,
          path: location.pathname,
          ready: document.readyState,
          origin: typeof performance !== 'undefined' ? performance.timeOrigin : 0,
        }))
        .catch((err: unknown) => {
          if (isFatal(err)) throw err;
          return null;
        });
      const onHomePath = state?.path === '/' || state?.path === '';
      const moved =
        !beforeNav ||
        beforeNav.path === '/' ||
        beforeNav.path === '' ||
        state?.origin !== beforeNav.origin ||
        state?.path !== beforeNav.path;
      if (
        state &&
        onHomePath &&
        moved &&
        FacebookBrowseURL.safeParse(state.url).success &&
        (state.ready === 'interactive' || state.ready === 'complete')
      )
        return true;
    }
    return false;
  } finally {
    if (typeof page.off === 'function') page.off('dialog', onDialog);
  }
}
export async function prepareInvitationHomeImpl(page: Page, guard: () => Awaitable<void>) {
  if (page.url() === 'https://www.facebook.com/') return false;
  if (!(await navigateRetainedPageHomeImpl(page, guard)))
    throw new ProductError(
      'GROUP_INVITER_HOME_REQUIRED',
      '无法打开 Facebook 首页，请检查登录或验证页面',
      409,
    );
  return true;
}
export async function waitInvitationHomeIdentityImpl(page: Page, guard: () => Awaitable<void>) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    await guard();
    if (
      /^https:\/\/www\.facebook\.com\/(?:login|checkpoint|recover|disabled|suspended)(?:[/.?]|$)/.test(
        page.url(),
      )
    )
      throw new ProductError(
        'GROUP_INVITER_LOGIN_REQUIRED',
        'Facebook 尚未登录或需要完成账号验证',
        409,
      );
    try {
      const current = await readCurrentFacebookBrowseIdentity(page, guard);
      if (current.document.url === 'https://www.facebook.com/') return current;
    } catch (error) {
      await guard();
      if (
        !(error instanceof ZodError) &&
        !(
          error instanceof Error &&
          /IDENTITY_UNCONFIRMED|IDENTITY_DOCUMENT_CHANGED|NAVIGATION_READ/.test(error.message)
        )
      )
        throw error;
    }
    if (Date.now() >= deadline)
      throw new ProductError(
        'GROUP_INVITER_IDENTITY_TIMEOUT',
        '首页已打开，但未能读取当前登录账号，请检查页面是否正常加载',
        409,
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}
export async function ensureRetainedBrowsePageImpl(
  page: Page,
  guard: () => Awaitable<void>,
  storyAdmission = false,
): Promise<boolean> {
  const url = typeof page.url === 'function' ? page.url() : '';
  if (!url) return false;
  if (
    url === 'https://www.facebook.com/' ||
    /^https:\/\/www\.facebook\.com\/stories\/create\/?$/.test(url)
  )
    await discardFacebookDraftIfPresent(page, guard);
  if (storyAdmission && /^https:\/\/www\.facebook\.com\/stories\/create\/?$/.test(url))
    return false;
  if (FacebookBrowseURL.safeParse(url).success) return false;
  return navigateRetainedPageHomeImpl(page, guard);
}
export async function connectFacebookImpl(
  deps: Pick<
    KernelInspectionDeps,
    'idlePages' | 'prepareWorkspace' | 'connectOwned' | 'recoverStuckWorkspaceTab'
  >,
  peer: Peer,
  accountId: string,
  assertIdentity: () => Awaitable<void>,
  retainedTab?: TabProof,
  storyAdmission = false,
  files: readonly string[] = [],
) {
  ExecutionContext.shape.accountId.parse(accountId);
  if (!accountId.trim()) throw Error('FACEBOOK_ACTING_IDENTITY_REQUIRED');
  await assertIdentity();
  if (
    !peer.capabilities?.includes('facebook-task-kernel-v1') ||
    !peer.capabilities.includes('facebook-task-main-frame-v1') ||
    !peer.capabilities.includes('kernel-journal-v1') ||
    !peer.capabilities.includes('kernel-operation-files-v1')
  )
    throw Error('FACEBOOK_TASK_EXTENSION_UPDATE_REQUIRED');
  if (!retainedTab) {
    const prepared = await deps.prepareWorkspace(peer, retainedTab, assertIdentity);
    retainedTab = prepared.proof;
    const inventory = prepared.inventory;
    await assertIdentity();
    if (
      inventory.operations.some(kernelOperationPending) ||
      inventory.tabs.some(
        (row) =>
          !['CLOSED', 'LOST'].includes(row.state) &&
          !(
            retainedTab &&
            row.state === 'READY' &&
            row.proof &&
            sameTabProof(row.proof, retainedTab)
          ),
      )
    )
      throw Error(
        'FACEBOOK_TASK_NATIVE_REVIEW_REQUIRED:' +
          JSON.stringify({
            pendingOperations: inventory.operations
              .filter(kernelOperationPending)
              .map((row) => ({ id: row.binding.operationId, state: row.state })),
            activeTabs: inventory.tabs
              .filter((row) => !['CLOSED', 'LOST'].includes(row.state))
              .map((row) => ({
                ownershipId: row.ownershipId,
                state: row.state,
                retained: !!(retainedTab && row.proof && sameTabProof(row.proof, retainedTab)),
              })),
          }),
      );
  }
  const idle = deps.idlePages.get(peer.profileId),
    dropIdle = async () => {
      if (!idle) return;
      await idle.connection.close().catch(() => {});
      deps.idlePages.delete(peer.profileId);
    };
  if (idle && files.length > 0) await dropIdle();
  else if (idle) {
    if (
      idle.peer !== peer ||
      idle.connection.failureReason ||
      !retainedTab ||
      !idle.connection.proof ||
      !sameTabProof(idle.connection.proof, retainedTab)
    )
      await dropIdle();
    else {
      const inventory = await idle.connection.inventory();
      await assertIdentity();
      const tab = inventory.tabs.find((row) => row.ownershipId === retainedTab.ownershipId);
      if (
        inventory.operations.some(kernelOperationPending) ||
        tab?.state !== 'READY' ||
        !tab.proof ||
        !sameTabProof(tab.proof, retainedTab)
      )
        await dropIdle();
      else {
        await idle.connection.rebind(accountId, assertIdentity);
        deps.idlePages.delete(peer.profileId);
        return idle.connection;
      }
    }
  }
  await assertIdentity();
  const allowStuckTabRecovery = retainedTab !== undefined && !storyAdmission && files.length === 0;
  const connectOpts = (allowRecovery: boolean): FacebookOwnedOptions => ({
    accountId,
    assertIdentity,
    ...(storyAdmission && retainedTab
      ? { initialUrl: 'https://www.facebook.com/stories/create/' }
      : {}),
    preservePage: () => peer.capabilities?.includes('kernel-page-quiesce-v1') === true,
    foreground:
      peer.capabilities?.includes('kernel-create-foreground-v1') === true &&
      profileForegroundGranted(peer),
    allowStuckTabRecovery: allowRecovery,
  });
  try {
    return await deps.connectOwned(peer, files, retainedTab, connectOpts(allowStuckTabRecovery));
  } catch (error) {
    if (allowStuckTabRecovery && retainedTab && isStuckDocumentRecoveryError(error)) {
      const recovered = await deps
        .recoverStuckWorkspaceTab(peer, retainedTab, assertIdentity)
        .catch(() => null);
      if (recovered && !recovered.targetChanged && sameTabProof(recovered.proof, retainedTab)) {
        await assertIdentity();
        return await deps.connectOwned(peer, files, recovered.proof, connectOpts(false));
      }
    }
    throw error;
  }
}
const eqTabProof = (a: TabProof, b: TabProof): boolean =>
  a.profileId === b.profileId &&
  a.browserSessionEpoch === b.browserSessionEpoch &&
  a.ownershipId === b.ownershipId &&
  a.tabId === b.tabId &&
  a.targetId === b.targetId;
export async function withSummaryImpl<T>(
  host: KernelSessionHost,
  retiredPeers: WeakSet<Peer>,
  retireClosedSession:
    ((peer: Peer, port: KernelSummaryPort, state: KernelState) => Promise<void>) | undefined,
  peer: Peer,
  work: (port: KernelSummaryPort) => Promise<T>,
): Promise<T> {
  if (!peer.capabilities?.includes('kernel-journal-v1')) throw Error('KERNEL_SUMMARY_UNAVAILABLE');
  const rawIdle = host.idlePages.get(peer.profileId);
  if (rawIdle && (rawIdle.peer !== peer || rawIdle.connection.failureReason))
    host.idlePages.delete(peer.profileId);
  const idle = host.idlePages.get(peer.profileId);
  if (idle) {
    if (idle.peer !== peer || !peer.online || !peer.synced || peer.phase !== 'PAUSED')
      throw Error('KERNEL_RETAINED_PAGE_CONNECTION_CHANGED');
    return work({
      profileId: peer.profileId,
      inventory: () => idle.connection.inventory(),
      notify: async (binding, resolution) => {
        if (resolution.outcome === 'ENDED_UNKNOWN') {
          await idle.connection.close();
          return withSummaryImpl(host, retiredPeers, retireClosedSession, peer, (port) =>
            port.notify(binding, resolution),
          );
        }
        return idle.connection.reconcile(
          binding,
          KernelOperationRecord.shape.resolution.unwrap().parse(resolution),
        );
      },
      stopCurrent: async (requestId, proofs = [], incompleteTabs = []) => {
        const alive = () => isPeerPaused(host, peer);
        if (host.idlePages.get(peer.profileId) !== idle || !alive())
          throw Error('KERNEL_RETAINED_PAGE_CONNECTION_CHANGED');
        await idle.connection.close();
        if (host.idlePages.has(peer.profileId) || !alive())
          throw Error('KERNEL_RETAINED_PAGE_CONNECTION_CHANGED');
        return withSummaryImpl(host, retiredPeers, retireClosedSession, peer, (port) =>
          port.stopCurrent(requestId, proofs, incompleteTabs),
        );
      },
    });
  }
  const { owner, session } = await openKernelRpcSession(host, peer);
  const assertCurrent = () => {
    if (host.sessions.get(peer.profileId) !== session || !isPeerPaused(host, peer))
      throw Error('SUMMARY_SESSION_CHANGED');
    session.lease.check();
  };
  let opened = false,
    closed = false;
  try {
    await session.request({
      kind: 'open',
      stamp: { ...session.stamp },
      files: [],
      ...(peer.capabilities?.includes('kernel-unknown-end-v1') ? { summaryOnly: true } : {}),
    });
    opened = true;
    assertCurrent();
    const inventory = async () => {
      if (closed) throw Error('SUMMARY_SESSION_CLOSED');
      assertCurrent();
      const result = await maintainJournal(host.core, peer, session);
      assertCurrent();
      if (result.profileId !== peer.profileId) throw Error('SUMMARY_PROFILE_MISMATCH');
      return result;
    };
    const port: KernelSummaryPort = {
      profileId: peer.profileId,
      inventory,
      stopCurrent: async (requestId, proofs = [], incompleteTabs = []) => {
        assertCurrent();
        session.closing = true;
        const stop = await session.request({ kind: 'stop' }, requestId);
        assertCurrent();
        if (stop.state !== 'stopped' || stop.requestId !== requestId)
          throw Error('SUMMARY_STOP_UNCONFIRMED');
        for (const proof of proofs) {
          if (proof.profileId !== peer.profileId) throw Error('SUMMARY_TAB_PROFILE_REJECTED');
          const reply = await session.request({ kind: 'withdrawTaskTab', proof });
          assertCurrent();
          if (reply.withdrawn !== true || !eqTabProof(OwnedTabProof.parse(reply.proof), proof))
            throw Error('SUMMARY_TAB_WITHDRAW_UNCONFIRMED');
        }
        for (const record of incompleteTabs) {
          if (record.proof || !peer.capabilities?.includes('kernel-idle-tab-end-v1'))
            throw Error('SUMMARY_INCOMPLETE_TAB_UPDATE_REQUIRED');
          const reply = await session.request({ kind: 'withdrawIdleTaskTab', record });
          assertCurrent();
          const retained = OwnedTabRecord.parse(reply.record);
          if (
            reply.withdrawn !== true ||
            retained.ownershipId !== record.ownershipId ||
            retained.url !== record.url ||
            retained.proof !== null ||
            !['LOST', 'CLOSED'].includes(retained.state)
          )
            throw Error('SUMMARY_TAB_WITHDRAW_UNCONFIRMED');
        }
        return {
          profileId: peer.profileId,
          connectionEpoch: peer.epoch,
          requestId,
          state: 'stopped',
        };
      },
      notify: async (binding, resolution) => {
        if (closed || binding.profileId !== peer.profileId)
          throw Error('SUMMARY_NOTIFICATION_PROFILE_REJECTED');
        const expected = SettlementReceipt.parse({ binding, resolution });
        if (await archivedNotice(host.core, binding, resolution)) return expected;
        if (
          peer.capabilities?.includes('kernel-journal-collection-v1') &&
          (binding.connectionEpoch !== peer.epoch || binding.leaseId !== session.stamp.leaseId)
        ) {
          session.closing = true;
          const reply = await session.request(
            { kind: 'retireOperation', binding, resolution },
            resolution.id,
          );
          const stop = KernelJsonObject.parse(reply.stop),
            receipt = SettlementReceipt.parse({
              binding: reply.binding,
              resolution: reply.resolution,
            }),
            remote = KernelPersistentState.parse(reply.inventory).operations.find(
              (row) => row.binding.operationId === binding.operationId,
            );
          if (
            reply.retired !== true ||
            stop.state !== 'stopped' ||
            stop.requestId !== resolution.id ||
            !sameNotice(expected, receipt) ||
            !remote ||
            ![remote.resolution, remote.disposition].some(
              (v) => v && sameNotice(expected, { binding: remote.binding, resolution: v }),
            )
          )
            throw Error('KERNEL_RETIREMENT_RECEIPT_MISMATCH');
          return receipt;
        }
        if (resolution.outcome === 'ENDED_UNKNOWN') {
          if (!peer.capabilities?.includes('kernel-unknown-end-v1'))
            throw Error('KERNEL_END_EXTENSION_UPDATE_REQUIRED');
          assertCurrent();
          session.closing = true;
          const reply = await session.request(
            { kind: 'endUnknownOperation', binding, disposition: resolution },
            resolution.id,
          );
          assertCurrent();
          const receipt = SettlementReceipt.parse({
              binding: reply.binding,
              resolution: reply.resolution,
            }),
            stop = KernelJsonObject.parse(reply.stop),
            snapshot = KernelPersistentState.parse(reply.inventory),
            remote = snapshot.operations.find(
              (op) => op.binding.operationId === binding.operationId,
            );
          if (
            reply.ended !== true ||
            stop.state !== 'stopped' ||
            stop.requestId !== resolution.id ||
            snapshot.profileId !== peer.profileId ||
            !sameNotice(expected, receipt) ||
            !remote?.disposition ||
            !sameNotice(receipt, { binding: remote.binding, resolution: remote.disposition })
          )
            throw Error('SUMMARY_END_RECEIPT_MISMATCH');
          return receipt;
        }
        const reply = await session.request({ kind: 'reconcileOperation', binding, resolution }),
          receipt = SettlementReceipt.parse({
            binding: reply.binding,
            resolution: reply.resolution,
          });
        if (reply.reconciled !== true || !sameNotice(expected, receipt))
          throw Error('SUMMARY_NOTICE_RECEIPT_MISMATCH');
        const remote = (await inventory()).operations.find(
          (op) => op.binding.operationId === binding.operationId,
        );
        if (
          remote?.state !== 'RECONCILED' ||
          !remote.resolution ||
          !sameNotice(receipt, { binding: remote.binding, resolution: remote.resolution })
        )
          throw Error('SUMMARY_NOTICE_INVENTORY_MISMATCH');
        return receipt;
      },
    };
    if (
      retireClosedSession &&
      !retiredPeers.has(peer) &&
      peer.capabilities?.includes('kernel-journal-collection-v1')
    ) {
      const before = await inventory();
      await retireClosedSession(peer, port, before);
      if (before.previousBrowserSessionEpoch)
        await session.request({
          kind: 'acknowledgeSessionEnd',
          browserSessionEpoch: before.browserSessionEpoch,
        });
      retiredPeers.add(peer);
    }
    const value = await work(port);
    assertCurrent();
    closed = true;
    session.closing = true;
    const stop = await session.request({ kind: 'stop' });
    if (stop.state !== 'stopped') throw Error('SUMMARY_STOP_UNCONFIRMED');
    if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
    session.fail('SUMMARY_CLOSED');
    host.core.releaseFixtureKernel(peer, owner);
    return value;
  } catch (error) {
    closed = true;
    session.closing = true;
    const errMessage = error instanceof Error ? error.message : '';
    const deterministicOpenRejected =
      !opened &&
      /^(?:KERNEL_LEASE_REJECTED(?::[a-z0-9_]+)?|KERNEL_SUMMARY_SCOPE_REJECTED|KERNEL_READONLY_FILES_REJECTED|KERNEL_CONTEXT_REJECTED|KERNEL_RPC_BUDGET_EXCEEDED)$/.test(
        errMessage,
      );
    if (deterministicOpenRejected) {
      if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
      host.core.releaseFixtureKernel(peer, owner);
    } else if (opened) {
      try {
        const stopped = await session.request({ kind: 'stop' });
        if (stopped.state !== 'stopped') throw Error('SUMMARY_STOP_UNCONFIRMED');
        if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
        host.core.releaseFixtureKernel(peer, owner);
      } catch {
        await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
      }
    } else await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
    session.fail('SUMMARY_FAILED');
    throw error;
  }
}
export async function readFacebookMetadataPageImpl<T>(
  deps: {
    withSummary: <R>(peer: Peer, work: (port: KernelSummaryPort) => Promise<R>) => Promise<R>;
    inspectOwnedFacebookPage: InspectOwnedFacebookPageFn;
  },
  peer: Peer,
  guard: () => Awaitable<void>,
  read: (page: Page) => Promise<T>,
  existingTab?: TabProof,
  timeoutMs = 10_000,
  options?: {
    initialUrl?: string;
    forceNewTemporaryTab?: boolean;
    backgroundMetadataRead?: boolean;
    disableOuterTimeout?: boolean;
  },
) {
  const inventory = await deps.withSummary(peer, (port) => port.inventory());
  await guard();
  const ready = inventory.tabs.filter((row) => row.state === 'READY' && row.proof);
  if (
    inventory.operations.some(kernelOperationPending) ||
    ready.length > 1 ||
    inventory.tabs.some((row) => !['READY', 'CLOSED', 'LOST'].includes(row.state))
  )
    throw Error('FACEBOOK_METADATA_BROWSER_BUSY');
  void existingTab;
  return deps.inspectOwnedFacebookPage(
    peer,
    guard,
    options?.initialUrl ?? 'https://www.facebook.com/',
    async (page) => {
      await guard();
      return read(page);
    },
    false,
    false,
    undefined,
    {
      noWorkspaceCleanup: true,
      timeoutMs,
      forceNewTemporaryTab: options?.forceNewTemporaryTab ?? true,
      backgroundMetadataRead: options?.backgroundMetadataRead ?? true,
      disableOuterTimeout: options?.disableOuterTimeout ?? true,
    },
  );
}
