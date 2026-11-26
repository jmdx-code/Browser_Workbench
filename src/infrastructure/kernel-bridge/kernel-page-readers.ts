import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Awaitable } from '../../domain/persistence.js';
import { sameTabProof } from '../../domain/task-tabs.js';
import type { Peer } from '../../bridge/core.js';
import { sampleFacebookPage } from '../../application/kernel-gates.js';
import type { KernelExecutor } from '../../application/kernel-executor.js';
import { FacebookNativeIdentityRead } from '../../shared/facebook-native-identity.js';
import { FacebookPostEffects } from '../../shared/facebook-post-observation.js';
import {
  facebookNativeResultUrl,
  sameFacebookNativeResultUrl,
} from '../../shared/facebook-result-route.js';
import { kernelFacebookReadURL } from '../../shared/kernel-policy.js';
import { KernelJsonObject, KernelTargetInfo } from '../../shared/kernel-protocol.js';
import {
  KernelPersistentState,
  OwnedTabProof,
  kernelOperationPending,
  type KernelState,
  type TabProof,
} from '../../shared/kernel-state.js';
import {
  PageReadRequest,
  type PageProjection,
  type PageProjectionRequest,
} from '../../shared/page-read.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { TaskChildPageLifecycle, type ChildPageLifecycle } from '../../shared/task-policies.js';
import { TaskWindowSnapshot, type Rect, type TaskWindow } from '../../shared/window-layout.js';
import { projectFacebookPostEffects } from '../facebook-post-effect-reader.js';
import { projectFacebookReelResult } from '../facebook-reel-result-reader.js';
import { missingFacebookDefaultContext } from '../facebook-task-document-ready.js';
import { endInvitationSetupOperations } from '../facebook-workspace-preparation.js';
import type { KernelBridge } from '../kernel-bridge.js';
import { extractInPageActorAvatarDom } from '../shared-dom-eval-runtime.js';
import {
  classifyAbnormalPathname,
  isPeerPaused,
  type KernelRpcSession,
  openKernelRpcSession,
  parseInventory,
  runEphemeralKernelSession,
  type AccountObserver,
  type KernelSessionHost,
} from './kernel-rpc-session.js';
export async function resolveTaskWindow(
  host: Pick<KernelSessionHost, 'core'>,
  profileId: string,
  expected?: TaskWindow,
  rect?: Rect,
  _exposed = false,
  _deadline?: number,
  focus = true,
): Promise<TaskWindow> {
  const peer = host.core.peers.get(profileId);
  if (!peer?.online) throw Error('WINDOW_LAYOUT_PROFILE_OFFLINE');
  const toSnap = (
    proof: TabProof,
    w: {
      windowId: number;
      state: string;
      bounds: { left: number; top: number; width: number; height: number };
      contentInsets?: TaskWindow['contentInsets'];
    },
    fallbackInsets?: TaskWindow['contentInsets'],
  ) =>
    TaskWindowSnapshot.parse({
      proof,
      windowId: w.windowId,
      state: w.state,
      rect: { x: w.bounds.left, y: w.bounds.top, width: w.bounds.width, height: w.bounds.height },
      contentInsets: w.contentInsets ??
        fallbackInsets ?? { left: 16, top: 104, right: 16, bottom: 16 },
    });
  if (expected && rect) {
    const moved = await host.core.positionBrowserWindow(
      profileId,
      { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
      focus,
    );
    return toSnap(expected.proof, moved, expected.contentInsets);
  }
  const inspected = await host.core.inspectBrowserWindow(profileId);
  return toSnap(
    expected?.proof ?? {
      ownershipId: peer.epoch,
      profileId,
      browserSessionEpoch: peer.epoch,
      tabId: Math.max(1, inspected.tabId || 1),
      targetId: 'window-' + inspected.windowId,
    },
    inspected,
  );
}
export async function consolidateFacebookWorkspaceImpl(
  bridge: KernelBridge,
  host: KernelSessionHost,
  peer: Peer,
  preferActiveTab = true,
) {
  if (!isPeerPaused(host, peer)) throw Error('WORKSPACE_CLEANUP_SESSION_RECHECK_REQUIRED');
  const protectedIds = new Set<string>();
  const preCleanup = await endInvitationSetupOperations(
    bridge,
    peer,
    undefined,
    true,
    undefined,
    protectedIds,
  );
  if (
    preCleanup.operations.some(
      (op) => kernelOperationPending(op) && protectedIds.has(op.binding.operationId),
    )
  )
    throw Error('WORKSPACE_CLEANUP_OPERATION_PENDING');
  const idle = host.idlePages.get(peer.profileId);
  if (idle) {
    if (idle.peer !== peer) throw Error('WORKSPACE_CLEANUP_CHANNEL_BUSY');
    await idle.connection.close();
  }
  if (
    !isPeerPaused(host, peer) ||
    !peer.capabilities?.includes('facebook-task-kernel-v1') ||
    host.sessions.has(peer.profileId)
  )
    throw Error('WORKSPACE_CLEANUP_CHANNEL_BUSY');
  if (!peer.capabilities?.includes('kernel-workspace-cleanup-v1'))
    throw Error('WORKSPACE_CLEANUP_EXTENSION_UPDATE_REQUIRED');
  return runEphemeralKernelSession(
    host,
    peer,
    {
      recheckError: 'WORKSPACE_CLEANUP_SESSION_RECHECK_REQUIRED',
      stopError: 'WORKSPACE_CLEANUP_STOP_UNCONFIRMED',
      closedReason: 'WORKSPACE_CLEANUP_CLOSED',
    },
    async (session, checkCurrent) => {
      const result = await session.request({ kind: 'consolidateWorkspace', preferActiveTab });
      await checkCurrent();
      const proof = OwnedTabProof.parse(result.proof);
      const closedTabIds = Array.isArray(result.closedTabIds)
        ? result.closedTabIds.filter((id): id is number => typeof id === 'number')
        : [];
      const remainingTabCount =
        typeof result.remainingTabCount === 'number' ? result.remainingTabCount : 1;
      if (remainingTabCount !== 1) throw Error('WORKSPACE_CLEANUP_TABS_UNCONFIRMED');
      return {
        profileId: peer.profileId,
        proof,
        url: typeof result.url === 'string' ? result.url : '',
        closedTabIds,
        remainingTabCount,
      };
    },
  );
}
export async function recoverStuckWorkspaceTabImpl(
  host: KernelSessionHost,
  peer: Peer,
  proof: TabProof,
  assertAllowed: () => Awaitable<void>,
): Promise<{ proof: TabProof; url: string; targetChanged: boolean } | null> {
  if (!peer.capabilities?.includes('kernel-tab-reset-v1')) return null;
  await assertAllowed();
  const idle = host.idlePages.get(peer.profileId);
  if (idle) {
    if (idle.peer !== peer) return null;
    await idle.connection.close().catch(() => {});
    host.idlePages.delete(peer.profileId);
  }
  if (
    !isPeerPaused(host, peer) ||
    !peer.capabilities?.includes('facebook-task-kernel-v1') ||
    host.sessions.has(peer.profileId)
  )
    return null;
  return runEphemeralKernelSession(
    host,
    peer,
    {
      recheckError: 'TAB_RESET_SESSION_RECHECK_REQUIRED',
      stopError: 'TAB_RESET_STOP_UNCONFIRMED',
      closedReason: 'TAB_RESET_CLOSED',
    },
    async (session, checkCurrent) => {
      const result = await session.request({ kind: 'recoverTabToHome', proof });
      await checkCurrent();
      const freshProof = OwnedTabProof.parse(result.proof);
      const url = typeof result.url === 'string' ? result.url : 'https://www.facebook.com/';
      const targetChanged = result.targetChanged === true;
      session.record('stuck-tab-recovered-to-home:' + (targetChanged ? 'rebound' : 'same-target'));
      devDiag.record({
        level: 'INFO',
        category: 'BRIDGE_WS',
        event: 'STUCK_WORKSPACE_TAB_RECOVERED',
        profileId: peer.profileId,
        data: { tabId: freshProof.tabId, targetChanged },
      });
      return { proof: freshProof, url, targetChanged };
    },
  );
}
export async function revealOwnedFacebookPageImpl(
  host: KernelSessionHost,
  peer: Peer,
  proof: TabProof,
  focus = true,
): Promise<{ profileId: string; tabId: number; focused: boolean }> {
  if (!peer.capabilities?.includes('kernel-owned-page-reveal-v1'))
    throw Error('WORKSPACE_REVEAL_EXTENSION_UPDATE_REQUIRED');
  if (!focus && !peer.capabilities?.includes('kernel-passive-page-reveal-v1'))
    return { profileId: peer.profileId, tabId: proof.tabId, focused: false };
  const runReveal = async (
      s: KernelRpcSession,
      checkCurrent?: () => Promise<void>,
      requireMain = false,
    ) => {
      const inventory = await parseInventory(s);
      await checkCurrent?.();
      if (
        (requireMain &&
          (inventory.profileId !== peer.profileId ||
            !inventory.workspaceMain ||
            !sameTabProof(inventory.workspaceMain, proof))) ||
        !inventory.tabs.some(
          (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, proof),
        )
      )
        throw Error('WORKSPACE_REVEAL_PROOF_REJECTED');
      if (checkCurrent) {
        await s.request({ kind: 'adopt', proof });
        await checkCurrent();
      }
      const result = await s.request({
        kind: 'revealOwnedPage',
        proof,
        ...(focus ? {} : { focus: false }),
      });
      await checkCurrent?.();
      if (
        result.tabId !== proof.tabId ||
        (focus ? result.focused !== true : typeof result.focused !== 'boolean')
      )
        throw Error('WORKSPACE_REVEAL_UNCONFIRMED');
      if (result.focused === true) {
        peer.profileWindowFocused = true;
        peer.focusedWindowAt = Date.now();
      }
      return { profileId: peer.profileId, tabId: proof.tabId, focused: Boolean(result.focused) };
    },
    session = host.sessions.get(peer.profileId);
  if (!session) {
    if (
      host.core.peers.get(peer.profileId) !== peer ||
      !peer.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED'
    )
      throw Error('WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED');
    if (!peer.capabilities?.includes('facebook-task-kernel-v1'))
      throw Error('WORKSPACE_REVEAL_CHANNEL_BUSY');
    let displayed = false;
    return runEphemeralKernelSession(
      host,
      peer,
      {
        recheckError: 'WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED',
        stopError: 'WORKSPACE_REVEAL_STOP_UNCONFIRMED',
        closedReason: 'WORKSPACE_REVEAL_CLOSED',
        rethrowStopError: () => displayed,
      },
      async (s, checkCurrent) => {
        const res = await runReveal(s, checkCurrent, true);
        displayed = true;
        return res;
      },
    );
  }
  if (session.peer !== peer || session.closing || session.failureReason)
    throw Error('WORKSPACE_REVEAL_SESSION_RECHECK_REQUIRED');
  if (!session.opened || session.access === 'fixture') throw Error('WORKSPACE_REVEAL_CHANNEL_BUSY');
  return runReveal(session);
}
export async function observeExternalPageAccountImpl(
  accountObserver: AccountObserver | undefined,
  profileId: string,
  page: Page,
  actor: { accountId: string; name: string | null } | null,
) {
  if (!accountObserver) return;
  try {
    if (actor) {
      const avatar = (await accountObserver.shouldRefreshAvatar(profileId, actor.accountId))
        ? await page.evaluate(extractInPageActorAvatarDom, actor.accountId).catch(() => null)
        : undefined;
      await accountObserver.onObserved(profileId, {
        state: 'logged-in',
        id: actor.accountId,
        name: actor.name,
        ...(avatar ? { avatar } : {}),
        liveConfirmedLoggedIn: true,
      });
      return;
    }
    const abnormal = await page
      .evaluate(() => {
        const path = location.pathname.toLowerCase();
        if (/^\/checkpoint(?:\/|$)/.test(path)) return 'verification' as const;
        if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(path))
          return 'restricted' as const;
        const hasLogin = Boolean(
          document.querySelector('input[name="email"]') &&
          document.querySelector('input[name="pass"]'),
        );
        return /^\/login(?:\.php|\/|$)/.test(path) || hasLogin ? ('logged-out' as const) : null;
      })
      .catch(() => null);
    if (abnormal)
      await accountObserver.onObserved(profileId, {
        state: abnormal,
        avatar: null,
        scope: 'global_route',
      });
  } catch {}
}
export async function observeProjectedAccountImpl(
  accountObserver: AccountObserver | undefined,
  profileId: string,
  page: PageProjection,
  actor: { accountId: string; name: string | null } | null,
) {
  if (!accountObserver) return;
  try {
    if (actor) {
      let avatar: string | undefined;
      if (await accountObserver.shouldRefreshAvatar(profileId, actor.accountId)) {
        const ownNodes = page.rows.find((r) => r.key === 'ownProfileImages')?.nodes ?? [];
        const bannerNodes = page.rows.find((r) => r.key === 'accountAvatars')?.nodes ?? [];
        for (const n of [...ownNodes, ...[...bannerNodes].reverse()]) {
          if (!n.visible) continue;
          const src = n.attributes['xlink:href'] || n.attributes.href || n.attributes.src || '';
          if (
            src.startsWith('https://') &&
            /fbcdn\.net|fbsbx\.com/i.test(src) &&
            !/\/rsrc\.php\/|\/emoji\.php\//i.test(src)
          ) {
            avatar = src;
            break;
          }
        }
      }
      await accountObserver.onObserved(profileId, {
        state: 'logged-in',
        id: actor.accountId,
        name: actor.name,
        ...(avatar ? { avatar } : {}),
      });
      return;
    }
    const pathState = classifyAbnormalPathname(page.url);
    if (pathState) {
      await accountObserver.onObserved(profileId, { state: pathState, avatar: null });
    } else {
      const loginForms = page.rows.find((row) => row.key === 'loginForm')?.nodes ?? [];
      if (loginForms.some((n) => n.visible))
        await accountObserver.onObserved(profileId, { state: 'logged-out', avatar: null });
    }
  } catch {}
}
export async function readFacebookPageImpl(
  host: KernelSessionHost,
  peer: Peer,
  input: PageProjectionRequest,
  destination: 'home' | 'self-profile' = 'home',
  assertAllowed: () => Awaitable<void> = () => {},
  withIdentity = false,
) {
  await assertAllowed();
  if (
    withIdentity &&
    (destination !== 'home' || !peer.capabilities?.includes('facebook-native-identity-v1'))
  )
    throw Error('FACEBOOK_NATIVE_IDENTITY_CAPABILITY_REQUIRED');
  if (destination !== 'home' && destination !== 'self-profile')
    throw Error('FACEBOOK_READ_DESTINATION_REJECTED');
  const projection = PageReadRequest.parse(input);
  if (
    projection.queries.some((query) => query.attributes.includes('xlink:href')) &&
    !peer.capabilities?.includes('facebook-readonly-v2')
  )
    throw Error('FACEBOOK_RICH_READ_CAPABILITY_REQUIRED');
  if (!peer.capabilities?.includes('facebook-readonly-v1'))
    throw Error('FACEBOOK_READ_CAPABILITY_REQUIRED');
  const { owner, session } = await openKernelRpcSession(host, peer);
  let proof: TabProof | undefined;
  let displayRemoveRequested = false;
  try {
    await session.request({
      kind: 'open',
      access: 'facebook-readonly',
      stamp: { ...session.stamp },
      files: [],
    });
    await assertAllowed();
    const ownershipId = randomUUID();
    const tab = await session.request({
      kind: 'create',
      ownershipId,
      url: destination === 'home' ? 'https://www.facebook.com/' : 'https://www.facebook.com/me/',
    });
    const inventory = await parseInventory(session);
    await assertAllowed();
    proof = OwnedTabProof.parse(
      inventory.tabs.find((row) => row.ownershipId === ownershipId && row.state === 'READY')?.proof,
    );
    if (inventory.profileId !== peer.profileId || proof.tabId !== tab.tabId)
      throw Error('FACEBOOK_READ_PROOF_MISMATCH');
    const attached = KernelTargetInfo.parse(
      (await session.request({ kind: 'attach', tabId: proof.tabId })).info,
    );
    await assertAllowed();
    if (
      attached.type !== 'page' ||
      attached.targetId !== proof.targetId ||
      !kernelFacebookReadURL(attached.url)
    )
      throw Error('FACEBOOK_READ_ATTACHED_TARGET_MISMATCH');
    await session.request({
      kind: 'send',
      target: { tabId: proof.tabId },
      method: 'Page.enable',
      params: {},
    });
    const nativeIdentity = withIdentity
      ? (await session.request({ kind: 'observeFacebookIdentity', tabId: proof.tabId })).identity
      : null;
    const identityRead =
      nativeIdentity === null ? null : FacebookNativeIdentityRead.parse(nativeIdentity);
    const tabId = proof.tabId;
    const assertIdentityDocument = async () => {
      if (!identityRead) return;
      await assertAllowed();
      const frameReply = await session.request({
        kind: 'send',
        target: { tabId },
        method: 'Page.getFrameTree',
        params: {},
      });
      const frame = KernelJsonObject.parse(KernelJsonObject.parse(frameReply.frameTree).frame);
      await assertAllowed();
      if (
        frame.id !== identityRead.frameId ||
        frame.loaderId !== identityRead.loaderId ||
        frame.url !== 'https://www.facebook.com/'
      )
        throw Error('FACEBOOK_IDENTITY_DOCUMENT_CHANGED');
    };
    await assertIdentityDocument();
    const page = await sampleFacebookPage(projection, {
      assertCurrent: async () => {
        await assertAllowed();
        if (
          host.sessions.get(peer.profileId) !== session ||
          host.core.peers.get(peer.profileId) !== peer ||
          session.closing ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED'
        )
          throw Error('FACEBOOK_READ_CONTEXT_CHANGED');
        session.lease.check();
      },
      read: () => session.request({ kind: 'project', tabId, projection }),
      wait: () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    });
    await assertIdentityDocument();
    await assertAllowed();
    displayRemoveRequested = true;
    await session.request({ kind: 'remove', tabId: proof.tabId });
    const closedInventory = await parseInventory(session);
    const closed = closedInventory.tabs.find((row) => row.ownershipId === ownershipId);
    if (closed?.state !== 'CLOSED' || !closed.proof || !sameTabProof(closed.proof, proof))
      throw Error('FACEBOOK_READ_TAB_CLOSE_UNCONFIRMED');
    await assertAllowed();
    session.closing = true;
    const requestId = randomUUID();
    const stop = await session.request({ kind: 'stop' }, requestId);
    if (stop.state !== 'stopped' || stop.requestId !== requestId)
      throw Error('FACEBOOK_READ_STOP_UNCONFIRMED');
    host.core.releaseFixtureKernel(peer, owner);
    if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
    session.fail('FACEBOOK_READ_CLOSED');
    return {
      profileId: peer.profileId,
      connectionEpoch: peer.epoch,
      leaseId: session.stamp.leaseId,
      proof,
      destination,
      page,
      nativeIdentity: identityRead?.actor ?? null,
      nativeIdentityTransport: identityRead?.transport ?? null,
      closed: true,
      closedRecord: closed,
      stop: { requestId, state: 'stopped' },
      inputRPCs: session.trace.filter((item) =>
        /^rpc:send:(Input\.|DOM\.setFileInputFiles)/.test(item.event),
      ).length,
      trace: [...session.trace],
    };
  } catch (error) {
    if (
      !displayRemoveRequested &&
      proof &&
      host.core.peers.get(peer.profileId) === peer &&
      peer.online
    ) {
      const failedProof = proof;
      try {
        await session.request({ kind: 'remove', tabId: failedProof.tabId });
        const cleanup = await parseInventory(session);
        const row = cleanup.tabs.find((tab) => tab.ownershipId === failedProof.ownershipId);
        if (row?.state === 'CLOSED' && row.proof && sameTabProof(row.proof, failedProof))
          session.record('display-read-failed-page:CLOSED');
      } catch {
        session.record('display-read-failed-page:REVIEW');
      }
    }
    session.closing = true;
    await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
    session.fail('FACEBOOK_READ_FAILED');
    throw error;
  }
}
export async function readOwnedFacebookNativeResult(
  executor: KernelExecutor,
  inventory: () => Promise<KernelState>,
  originalProof: ReturnType<typeof OwnedTabProof.parse>,
  accountId: string,
  nativePostId: string,
  guard: () => Awaitable<void>,
  options: {
    now?: () => number;
    wait?: () => Promise<void>;
    videoId?: string | null;
    accept?: (effects: ReturnType<typeof FacebookPostEffects.parse>) => boolean;
    lifecycle?: (value: ChildPageLifecycle) => void;
    observe?: (v: {
      elapsedMilliseconds: number;
      route: 'result' | 'blank' | 'other';
      ready: string;
      posts: number;
      actorMatches: boolean;
      mediaReady: boolean;
      matches: boolean;
    }) => void;
  } = {},
) {
  if (!/^\d{1,30}$/.test(accountId) || !/^\d{1,30}$/.test(nativePostId))
    throw Error('NATIVE_RESULT_ID_REQUIRED');
  const now = options.now ?? Date.now,
    wait = options.wait ?? (() => new Promise<void>((r) => setTimeout(r, 250))),
    readInv = async () => {
      await guard();
      const s = KernelPersistentState.parse(await inventory());
      await guard();
      return s;
    };
  const initial = await readInv(),
    primary = initial.tabs.find((r) => r.ownershipId === originalProof.ownershipId);
  if (
    initial.profileId !== originalProof.profileId ||
    primary?.state !== 'READY' ||
    !primary.proof ||
    !sameTabProof(primary.proof, originalProof) ||
    initial.tabs.some(
      (r) => r.ownershipId !== originalProof.ownershipId && !['CLOSED', 'LOST'].includes(r.state),
    )
  )
    throw Error('NATIVE_RESULT_OWNER_NOT_IDLE');
  const url = new URL(facebookNativeResultUrl(accountId, nativePostId, options.videoId)),
    ownershipId = randomUUID(),
    lifecycle = async (state: ChildPageLifecycle['state'], child: ChildPageLifecycle['child']) => {
      await guard();
      options.lifecycle?.(
        TaskChildPageLifecycle.parse({
          version: 1,
          role: 'publication-result',
          ownershipId,
          parent: originalProof,
          child,
          state,
        }),
      );
      await guard();
    };
  await lifecycle('REQUESTED', null);
  const created = await executor.create(url.href, ownershipId, Boolean(options.videoId));
  let proof: ReturnType<typeof OwnedTabProof.parse> | null = null;
  const createdProofMatches = (c: ReturnType<typeof OwnedTabProof.parse>) =>
    c.ownershipId === ownershipId &&
    c.tabId === created.tabId &&
    c.profileId === originalProof.profileId &&
    c.browserSessionEpoch === originalProof.browserSessionEpoch &&
    c.targetId !== originalProof.targetId &&
    c.tabId !== originalProof.tabId;
  let reading: null | ReturnType<typeof FacebookPostEffects.parse> = null;
  const budget = options.videoId ? 90_000 : 30_000;
  try {
    const opened = await readInv(),
      candidate = OwnedTabProof.parse(
        opened.tabs.find((r) => r.ownershipId === ownershipId && r.state === 'READY')?.proof,
      );
    if (!createdProofMatches(candidate)) throw Error('NATIVE_RESULT_PROOF_MISMATCH');
    proof = candidate;
    await lifecycle('READY', proof);
    const attached = await executor.attach(proof.tabId);
    await guard();
    if (attached.targetId !== proof.targetId) throw Error('NATIVE_RESULT_TARGET_CHANGED');
    const started = now();
    if (!Number.isSafeInteger(started) || started < 0) throw Error('NATIVE_RESULT_CLOCK_INVALID');
    let sawResultDocument = false;
    for (let reads = 0; reads < budget / 250; reads++) {
      await guard();
      const clock = now();
      if (!Number.isSafeInteger(clock) || clock < started || clock - started >= budget) break;
      let reply;
      try {
        reply = await executor.send({ tabId: proof.tabId }, 'Runtime.evaluate', {
          expression: `JSON.stringify((${(options.videoId ? projectFacebookReelResult : projectFacebookPostEffects).toString()})(${options.videoId ? '' : '"result-dialog"'}))`,
          returnByValue: true,
        });
      } catch (error) {
        await guard();
        if (
          !missingFacebookDefaultContext(error) &&
          !(error instanceof Error && error.message === 'KERNEL_INITIAL_DOCUMENT_PENDING')
        )
          throw error;
        await wait();
        await guard();
        continue;
      }
      await guard();
      if (reply.exceptionDetails) throw Error('NATIVE_RESULT_PROJECTION_FAILED');
      const text = KernelJsonObject.parse(reply.result).value;
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 96 * 1024)
        throw Error('NATIVE_RESULT_PROJECTION_BUDGET');
      const effects = FacebookPostEffects.parse(JSON.parse(text)),
        sameResult = sameFacebookNativeResultUrl(effects.url, url.href),
        matches =
          sameResult &&
          effects.ready !== 'loading' &&
          effects.posts.length > 0 &&
          (!options.accept || options.accept(effects));
      try {
        options.observe?.({
          elapsedMilliseconds: clock - started,
          route: sameResult ? 'result' : effects.url === 'about:blank' ? 'blank' : 'other',
          ready: effects.ready,
          posts: effects.posts.length,
          actorMatches: effects.posts.some((post) => post.accountId === accountId),
          mediaReady: effects.posts.some((post) => post.videoReady),
          matches,
        });
      } catch {}
      if (!sameResult && (effects.url !== 'about:blank' || sawResultDocument)) break;
      if (sameResult) sawResultDocument = true;
      if (matches) {
        reading = effects;
        break;
      }
      await wait();
      await guard();
    }
  } finally {
    const current = await readInv(),
      owned = current.tabs.find((r) => r.ownershipId === ownershipId);
    if (
      !owned?.proof ||
      !createdProofMatches(owned.proof) ||
      (proof !== null && !sameTabProof(owned.proof, proof)) ||
      !['READY', 'CLOSED'].includes(owned.state)
    )
      throw Error('NATIVE_RESULT_CLOSE_OWNER_CHANGED');
    proof ??= owned.proof;
    if (owned.state === 'READY') {
      await executor.remove(proof.tabId);
      await guard();
    }
    const ended = await readInv(),
      closed = ended.tabs.find((r) => r.ownershipId === ownershipId);
    if (closed?.state !== 'CLOSED' || !closed.proof || !sameTabProof(closed.proof, proof))
      throw Error('NATIVE_RESULT_CLOSE_UNCONFIRMED');
    await lifecycle('CLOSED', proof);
  }
  return reading;
}
