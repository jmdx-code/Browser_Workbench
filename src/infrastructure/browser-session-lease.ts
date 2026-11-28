import { createHash, randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Core, Peer } from '../bridge/core.js';
import type { GlobalAccountAbnormalReporter } from '../application/account-abnormal-reporter.js';
import {
  inferAbnormalScopeFromUrl,
  inferAbnormalStateFromCodeOrMessage,
} from '../application/account-abnormal-reporter.js';
import { sleepAbortable, throwIfAborted, type Workboard } from '../application/workboard.js';
import type { Awaitable } from '../domain/persistence.js';
import { classifyFacebookAbnormalUrl } from '../shared/facebook-browse-route.js';
import type { TabProof } from '../shared/kernel-state.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { Binding } from '../shared/task-execution.js';
import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import type { KernelBridge } from './kernel-bridge.js';
export type FacebookSessionConnection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;
export interface BrowserSessionLease {
  readonly profileId: string;
  readonly accountId: string;
  readonly peer: Peer;
  readonly connection: FacebookSessionConnection;
  readonly page: Page;
  readonly proof: TabProof;
  readonly signal: AbortSignal;
  guard(): void;
  setStepId(stepId: string): void;
  execOp<T>(label: string, work: () => Promise<T>): Promise<T>;
  reconnectWithFiles(
    files: readonly string[],
  ): Promise<{ connection: FacebookSessionConnection; page: Page; proof: TabProof }>;
}
export interface BrowserSessionLeaseDeps {
  readonly core: Core;
  readonly kernel: KernelBridge;
  readonly workboard: Workboard;
  readonly profileLifecycle?: ProfileLifecyclePort | undefined;
  readonly accountAbnormalReporter?: GlobalAccountAbnormalReporter | undefined;
  readonly ensureExtensionReady?: ((peer: Peer) => Promise<void>) | undefined;
  readonly otherModuleBusy?: ((profileId: string) => Awaitable<boolean>) | undefined;
}
export interface BrowserSessionLeaseOptions {
  readonly profileId: string;
  readonly jobId: string;
  readonly stepId?: string;
  readonly purpose?: string;
  readonly expectedAccountId?: string | null;
  readonly files?: readonly string[];
  readonly storyMode?: boolean;
  readonly allowAutoLaunch?: boolean;
  readonly launchTimeoutMs?: number;
  readonly closeBrowserOnFinish?: boolean;
  readonly signal: AbortSignal;
}
function isPeerWindowOnline(peer: Peer | undefined): peer is Peer {
  return Boolean(peer && peer.online && peer.browserWindowCount !== 0);
}
function digestOp(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function isAccountAbnormalError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return (
    /FACEBOOK_ACCOUNT_(?:LOGGED_OUT|RESTRICTED|VERIFICATION_REQUIRED)|LOGIN_REQUIRED|CHECKPOINT|ACCOUNT_CHANGED/.test(
      msg,
    ) || /受限|未登录|登录已失效|安全验证|身份验证|需要验证|停用/.test(msg)
  );
}
async function closeConnectionReliably(connection: FacebookSessionConnection): Promise<void> {
  const requestId = connection.stopRequestId;
  try {
    await connection.close(requestId);
    return;
  } catch {
    // Fallback to stopOnCloseFailure + retryClose or local disconnect
  }
  try {
    await connection.stopOnCloseFailure();
    const retryId = connection.stopRequestId;
    await connection.retryClose(retryId);
  } catch {
    await connection.closeLocalAfterDisconnect().catch(() => {});
  }
}
export async function withBrowserSession<T>(
  deps: BrowserSessionLeaseDeps,
  options: BrowserSessionLeaseOptions,
  fn: (lease: BrowserSessionLease) => Promise<T>,
): Promise<T> {
  const { core, kernel, workboard, profileLifecycle, accountAbnormalReporter } = deps;
  const { profileId, signal } = options;
  let currentConnection: FacebookSessionConnection | null = null;
  let abortListener: (() => void) | null = null;
  try {
    throwIfAborted(signal);
    let peer = core.peers.get(profileId);
    if (!isPeerWindowOnline(peer) || !peer.synced) {
      if (options.allowAutoLaunch === false || !profileLifecycle) {
        throw Error('BROWSER_OFFLINE');
      }
      const launched = await workboard.runStaggeredLaunch(signal, async () => {
        throwIfAborted(signal);
        const current = core.peers.get(profileId);
        if (isPeerWindowOnline(current) && current.synced && current.phase === 'PAUSED') {
          return { ok: true as const };
        }
        return await profileLifecycle.launchProfile(profileId, {
          timeoutMs: options.launchTimeoutMs ?? 25_000,
        });
      });
      if (!launched.ok) {
        throw Error(launched.reason || launched.errorCode || 'BROWSER_LAUNCH_FAILED');
      }
    }
    throwIfAborted(signal);
    const idleDeadline = Date.now() + 10_000;
    for (;;) {
      throwIfAborted(signal);
      peer = core.peers.get(profileId);
      if (isPeerWindowOnline(peer) && peer.synced && peer.phase === 'PAUSED') {
        const inspection = await core.inspectKernelProfileIdle(profileId);
        if (inspection.idle) break;
      }
      if (Date.now() >= idleDeadline) throw Error('BROWSER_SESSION_NOT_IDLE');
      await sleepAbortable(150, signal);
    }
    if (deps.ensureExtensionReady && peer) {
      await deps.ensureExtensionReady(peer);
      throwIfAborted(signal);
      const reloadedPeer = core.peers.get(profileId);
      if (!isPeerWindowOnline(reloadedPeer) || !reloadedPeer.synced) {
        const reloadWaitDeadline = Date.now() + 10_000;
        while (Date.now() < reloadWaitDeadline) {
          throwIfAborted(signal);
          const cand = core.peers.get(profileId);
          if (isPeerWindowOnline(cand) && cand.synced && cand.phase === 'PAUSED') {
            peer = cand;
            break;
          }
          await sleepAbortable(150, signal);
        }
      } else peer = reloadedPeer;
    }
    const activePeer = core.peers.get(profileId);
    if (!isPeerWindowOnline(activePeer) || !activePeer.synced || activePeer.phase !== 'PAUSED') {
      throw Error('BROWSER_OFFLINE');
    }
    let currentPeer = activePeer;
    const guard = () => {
      throwIfAborted(signal);
      if (
        core.peers.get(profileId) !== currentPeer ||
        !isPeerWindowOnline(currentPeer) ||
        !currentPeer.synced ||
        currentPeer.phase !== 'PAUSED'
      ) {
        throw Error('BROWSER_CONNECTION_LOST');
      }
    };
    guard();
    const prepared = await prepareFacebookWorkspace(
      kernel,
      currentPeer,
      undefined,
      guard,
      undefined,
      true,
    );
    guard();
    const retryTransientContextRejection = async <R>(work: () => Promise<R>): Promise<R> => {
      try {
        return await work();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'KERNEL_CONTEXT_REJECTED' ||
          signal.aborted
        )
          throw error;
        await sleepAbortable(800, signal);
        const refreshed = core.peers.get(profileId);
        if (
          !refreshed ||
          !isPeerWindowOnline(refreshed) ||
          !refreshed.synced ||
          refreshed.phase !== 'PAUSED'
        )
          throw error;
        currentPeer = refreshed;
        guard();
        return await work();
      }
    };
    let identity:
      | NonNullable<Awaited<ReturnType<KernelBridge['inspectIdleFacebookPage']>>>
      | Awaited<ReturnType<KernelBridge['inspectFacebookIdentity']>>;
    try {
      identity = await retryTransientContextRejection(async () => {
        const idleIdentity = await kernel
          .inspectIdleFacebookPage(currentPeer, guard, Boolean(options.storyMode), false)
          .catch(() => null);
        if (idleIdentity) return idleIdentity;
        return await kernel.inspectFacebookIdentity(
          currentPeer,
          guard,
          true,
          prepared.proof,
          true,
          Boolean(options.storyMode),
          false,
        );
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error ?? '');
      if (accountAbnormalReporter && isAccountAbnormalError(error)) {
        const state = inferAbnormalStateFromCodeOrMessage(msg);
        await accountAbnormalReporter({
          profileId,
          scope: 'global_route',
          state,
          reason: msg,
        }).catch(() => {});
      }
      throw error;
    }
    guard();
    const accountId = identity.actor.accountId;
    if (options.expectedAccountId && options.expectedAccountId !== accountId) {
      throw Error('ACCOUNT_CHANGED');
    }
    const connected = await retryTransientContextRejection(() =>
      kernel.connectFacebook(
        currentPeer,
        accountId,
        guard,
        identity.proof,
        Boolean(options.storyMode),
        options.files ? [...options.files] : [],
      ),
    );
    currentConnection = connected;
    const initialProof = connected.proof;
    const initialPage = connected.browser.contexts()[0]?.pages()[0];
    if (!initialPage || !initialProof) throw Error('FACEBOOK_PAGE_MISSING');
    let currentProof: TabProof = initialProof;
    let currentPage: Page = initialPage;
    let activeFiles: string[] = options.files ? [...options.files] : [];
    let activeStepId = options.stepId ?? options.jobId;
    const purpose = options.purpose ?? 'workbench';
    abortListener = () => {
      const reason =
        typeof signal.reason === 'string' && signal.reason ? signal.reason : 'USER_STOP';
      currentConnection?.revokeInput(reason);
    };
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
      throwIfAborted(signal);
    }
    const reconnectWithFiles = async (files: readonly string[]) => {
      activeFiles = [...files];
      guard();
      const activeConn = currentConnection;
      if (!activeConn) throw Error('FACEBOOK_PAGE_MISSING');
      const keepProof = activeConn.proof ?? identity.proof;
      await closeConnectionReliably(activeConn);
      currentConnection = null;
      guard();
      const readyAfterClose = await prepareFacebookWorkspace(
        kernel,
        currentPeer,
        keepProof,
        guard,
        undefined,
        true,
      );
      guard();
      const reconnected = await kernel.connectFacebook(
        currentPeer,
        accountId,
        guard,
        readyAfterClose.proof,
        Boolean(options.storyMode),
        [...files],
      );
      currentConnection = reconnected;
      const nextProof = reconnected.proof;
      const nextPage = reconnected.browser.contexts()[0]?.pages()[0];
      if (!nextPage || !nextProof) throw Error('FACEBOOK_PAGE_MISSING');
      currentProof = nextProof;
      currentPage = nextPage;
      return { connection: reconnected, page: currentPage, proof: currentProof };
    };
    const execOp = async <R>(label: string, work: () => Promise<R>): Promise<R> => {
      guard();
      const conn = () => {
        if (!currentConnection) throw Error('FACEBOOK_EXECUTION_CONTEXT_LOST');
        return currentConnection;
      };
      let ctx = await conn().context(accountId);
      if (!ctx && !signal.aborted && conn().failureReason !== 'KERNEL_DEBUGGER_CANCELED_BY_USER') {
        const livePeer = core.peers.get(profileId);
        if (isPeerWindowOnline(livePeer) && livePeer.synced) {
          await reconnectWithFiles(activeFiles).catch(() => {});
          ctx = currentConnection
            ? await currentConnection.context(accountId).catch(() => null)
            : null;
        }
      }
      if (!ctx) throw Error('FACEBOOK_EXECUTION_CONTEXT_LOST');
      const binding: Binding = {
        ...ctx,
        operationId: randomUUID(),
        jobId: options.jobId,
        stepId: activeStepId,
        actionDigest: digestOp({ purpose, label, accountId }),
      };
      type Attempt = { ok: true; value: R } | { ok: false; error: unknown };
      let result: { value: Attempt; binding: Binding; targetUnavailableBeforeInput: boolean };
      try {
        result = await conn().execute<Attempt>(
          binding,
          async () => {
            try {
              return { ok: true, value: await work() };
            } catch (error) {
              return { ok: false, error };
            }
          },
          guard,
          async () => {
            currentConnection?.revokeInput('OP_FAILED');
          },
        );
      } catch (execError) {
        if (currentConnection?.failureReason && !signal.aborted) {
          await reconnectWithFiles(activeFiles).catch(() => {});
        }
        throw execError;
      }
      const id = randomUUID();
      if (result.value.ok) {
        await conn()
          .reconcile(binding, {
            id,
            outcome: 'VERIFIED',
            evidenceDigest: digestOp({ binding, label, ok: true }),
          })
          .catch(() => {});
        return result.value.value;
      }
      const reconciled = await conn()
        .reconcile(binding, {
          id,
          outcome: 'NOT_APPLIED',
          evidenceDigest: digestOp({ binding, label, ok: false }),
        })
        .then(
          () => true,
          () => false,
        );
      const err = result.value.error;
      const currentUrl = currentPage ? currentPage.url() : '';
      const abnormalUrl = classifyFacebookAbnormalUrl(currentUrl);
      if (abnormalUrl && accountAbnormalReporter) {
        const state = inferAbnormalStateFromCodeOrMessage(abnormalUrl);
        const scope = inferAbnormalScopeFromUrl(currentUrl, true);
        await accountAbnormalReporter({
          profileId,
          scope,
          state,
          reason: abnormalUrl,
          accountId,
        }).catch(() => {});
      }
      if ((!reconciled || currentConnection?.failureReason) && !signal.aborted) {
        await reconnectWithFiles(activeFiles).catch(() => {});
      }
      throw err instanceof Error ? err : Error(String(err ?? 'OP_FAILED'));
    };
    const lease: BrowserSessionLease = {
      profileId,
      accountId,
      peer,
      get connection() {
        if (!currentConnection) throw Error('FACEBOOK_EXECUTION_CONTEXT_LOST');
        return currentConnection;
      },
      get page() {
        return currentPage;
      },
      get proof() {
        return currentProof;
      },
      signal,
      guard,
      setStepId: (stepId: string) => {
        activeStepId = stepId;
      },
      execOp,
      reconnectWithFiles,
    };
    return await fn(lease);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (currentConnection) await closeConnectionReliably(currentConnection).catch(() => {});
    if (options.closeBrowserOnFinish && profileLifecycle) {
      const busyElsewhere = deps.otherModuleBusy
        ? await Promise.resolve(deps.otherModuleBusy(profileId)).catch(() => true)
        : false;
      if (!busyElsewhere) {
        await profileLifecycle.closeProfile(profileId, { stopTasksFirst: false }).catch(() => {});
      }
    }
  }
}
