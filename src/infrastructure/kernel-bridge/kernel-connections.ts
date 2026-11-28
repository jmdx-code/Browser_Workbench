import { randomUUID } from 'node:crypto';
import { failError } from '../../domain/workspace.js';
import { sameTabProof } from '../../domain/task-tabs.js';
import type { Peer } from '../../bridge/core.js';
import { KernelExecutor } from '../../application/kernel-executor.js';
import type { KernelAccess } from '../../shared/kernel-policy.js';
import { KernelJsonObject } from '../../shared/kernel-protocol.js';
import {
  KernelPersistentState,
  kernelOperationPending,
  type TabProof,
} from '../../shared/kernel-state.js';
import { KernelRelayModel } from '../kernel-relay-model.js';
import { openKernelRelayEndpoint } from '../kernel-relay-endpoint.js';
import { connectFixtureKernel } from '../kernel-browser.js';
import { awaitFacebookTaskDocument } from '../facebook-task-document-ready.js';
import {
  classifyAbnormalPathname,
  isPeerPaused,
  KernelRpcSession,
  maintainJournal,
  openKernelRpcSession,
  parseInventory,
  resolveSessionStopRequestId,
  sanitizeTraceUrl,
  type AccountObserver,
  type FacebookOwnedOptions,
  type KernelSessionHost,
} from './kernel-rpc-session.js';
import { createOwnedRelayCloser } from './kernel-lifecycle.js';
import { buildOwnedConnection } from './kernel-owned-execution.js';
async function attachTabWithRetry(
  executor: KernelExecutor,
  tabId: number,
  timeoutMs: number,
  shouldRetry: (err: unknown) => boolean,
  onTick: () => Promise<void>,
) {
  const started = Date.now();
  for (;;) {
    try {
      await executor.attach(tabId);
      return;
    } catch (error) {
      if (!shouldRetry(error) || Date.now() - started > timeoutMs) throw error;
      await onTick();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
}
async function openSessionBackendTab(
  host: KernelSessionHost,
  peer: Peer,
  session: KernelRpcSession,
  access: KernelAccess,
  files: readonly string[],
  existingTab: TabProof | undefined,
  createUrl: string,
  foreground: boolean | undefined,
) {
  await session.request({ kind: 'open', stamp: { ...session.stamp }, files: [...files], access });
  const backend = session.backend();
  const persistent = peer.capabilities?.includes('kernel-journal-v1') ?? false;
  if (persistent && peer.capabilities?.includes('kernel-journal-collection-v1'))
    await maintainJournal(host.core, peer, session);
  if (existingTab && (!persistent || existingTab.profileId !== peer.profileId))
    throw Error('KERNEL_TAB_ADOPTION_UNAVAILABLE');
  const ownershipId = existingTab?.ownershipId ?? randomUUID();
  const tab = existingTab
    ? (await session.request({ kind: 'adopt', proof: existingTab }), { tabId: existingTab.tabId })
    : await backend.create(createUrl, ownershipId, foreground);
  let proof: TabProof | null = null;
  if (persistent) {
    const inventory = KernelPersistentState.parse(await session.request({ kind: 'inventory' }));
    proof =
      inventory.tabs.find((row) => row.ownershipId === ownershipId && row.state === 'READY')
        ?.proof ?? null;
    if (!proof || proof.tabId !== tab.tabId) throw Error('KERNEL_TAB_PERSISTENCE_UNCONFIRMED');
  }
  const executor = new KernelExecutor(session.lease, backend, [tab.tabId], new Set(files), access);
  executor.grant(session.stamp);
  session.executor = executor;
  return { backend, persistent, ownershipId, tab, proof, executor };
}
async function openRelayBrowserSession(
  session: KernelRpcSession,
  executor: KernelExecutor,
  tabId: number,
  userAgent: string,
  access: KernelAccess,
) {
  const major = userAgent.match(/(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/)?.[1];
  const model = new KernelRelayModel(
    executor,
    [tabId],
    { product: major ? 'Chrome/' + major : 'Chrome/Extension-Bridge', userAgent },
    (event) => session.record(event),
    access,
  );
  session.model = model;
  const endpoint = await openKernelRelayEndpoint(model);
  session.endpoint = endpoint;
  const browser = await connectFixtureKernel(endpoint.endpoint, endpoint.headers);
  return { endpoint, browser };
}
async function removeAndConfirmClosedTab(
  session: KernelRpcSession,
  ownershipId: string,
  tabId: number,
  proof: TabProof | null,
  allowRemove: boolean,
  errCode: string,
  extraCheck?: () => void,
): Promise<{
  inventory: ReturnType<typeof KernelPersistentState.parse>;
  state: 'READY' | 'CLOSED' | 'LOST';
}> {
  const before = await parseInventory(session);
  const original = before.tabs.find((row) => row.ownershipId === ownershipId);
  if (
    !proof ||
    !original?.proof ||
    !sameTabProof(original.proof, proof) ||
    !['READY', 'CLOSED', 'LOST'].includes(original.state)
  )
    throw Error(errCode);
  extraCheck?.();
  if (original.state === 'CLOSED' || original.state === 'LOST') {
    return { inventory: before, state: original.state };
  }
  if (!allowRemove) throw Error(errCode);
  await session.request({ kind: 'remove', tabId });
  const inventory = await parseInventory(session);
  const closed = inventory.tabs.find((row) => row.ownershipId === ownershipId);
  if (
    !proof ||
    !closed?.proof ||
    !sameTabProof(closed.proof, proof) ||
    (closed.state !== 'CLOSED' && closed.state !== 'LOST')
  )
    throw Error(errCode);
  return { inventory, state: closed.state };
}
async function removeAndStopFailedTab(
  host: KernelSessionHost,
  peer: Peer,
  owner: string,
  session: KernelRpcSession,
  initialProof: TabProof,
  check?: () => void,
): Promise<boolean> {
  if (check) {
    check();
    const inventory = await parseInventory(session);
    check();
    const original = inventory.tabs.find(
      (row) => row.proof && sameTabProof(row.proof, initialProof),
    );
    if (
      inventory.profileId !== peer.profileId ||
      original?.state !== 'READY' ||
      inventory.operations.some(kernelOperationPending)
    )
      throw Error('FACEBOOK_OPEN_CLEANUP_REVIEW_REQUIRED');
  }
  await session.request({ kind: 'remove', tabId: initialProof.tabId });
  check?.();
  const closed = await parseInventory(session);
  check?.();
  if (
    !closed.tabs.some(
      (row) => row.state === 'CLOSED' && row.proof && sameTabProof(row.proof, initialProof),
    )
  )
    throw Error('FACEBOOK_OPEN_CLEANUP_CLOSE_UNCONFIRMED');
  const requestId = randomUUID();
  const stop = await session.request({ kind: 'stop' }, requestId);
  if (stop.state !== 'stopped' || stop.requestId !== requestId)
    throw Error('FACEBOOK_OPEN_CLEANUP_STOP_UNCONFIRMED');
  host.core.releaseFixtureKernel(peer, owner);
  if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
  return true;
}
export async function connectOwnedImpl(
  host: KernelSessionHost,
  accountObserver: AccountObserver | undefined,
  arrangeWindow: ((profileId: string, guard: () => void) => Promise<void>) | undefined,
  peer: Peer,
  files: readonly string[],
  existingTab?: TabProof,
  facebook?: FacebookOwnedOptions,
) {
  if (facebook?.forceNewTemporaryTab === true) existingTab = undefined;
  const access: KernelAccess = facebook ? 'facebook-task' : 'fixture';
  if (!peer.capabilities?.includes(facebook ? 'facebook-task-kernel-v1' : 'fixture-kernel-v1'))
    throw Error('KERNEL_CAPABILITY_OR_PROFILE_REJECTED');
  await facebook?.assertIdentity();
  const { owner, session } = await openKernelRpcSession(host, peer, access);
  session.identityFence = facebook?.assertIdentity;
  session.boundInputRequired = !!facebook;
  let initialProof: TabProof | null = null;
  try {
    const createUrl = facebook
      ? (facebook.initialUrl ?? 'https://www.facebook.com/')
      : 'http://127.0.0.1:18767/kernel-fixture';
    const foreground = facebook?.backgroundMetadataRead ? false : facebook?.foreground;
    const { backend, persistent, ownershipId, tab, proof, executor } = await openSessionBackendTab(
      host,
      peer,
      session,
      access,
      files,
      existingTab,
      createUrl,
      foreground,
    );
    if (proof && !facebook?.backgroundMetadataRead) session.presentationProof = proof;
    if (proof && !existingTab) initialProof = proof;
    await facebook?.assertIdentity();
    await attachTabWithRetry(
      executor,
      tab.tabId,
      15_000,
      (error) =>
        !!facebook && error instanceof Error && error.message === 'KERNEL_INITIAL_DOCUMENT_PENDING',
      async () => {
        await facebook?.assertIdentity();
        session.lease.check();
      },
    );
    if (facebook && proof && !facebook.backgroundMetadataRead)
      await arrangeWindow?.(peer.profileId, () => {
        session.lease.check();
        if (
          host.sessions.get(peer.profileId) !== session ||
          session.closing ||
          session.inputRevoked
        )
          throw Error('WINDOW_LAYOUT_REVOKED');
      });
    if (
      facebook &&
      proof &&
      !facebook.backgroundMetadataRead &&
      peer.capabilities?.includes('task-presentation-recovery-v1')
    )
      await session.request({ kind: 'armTaskPresentation', proof });
    if (facebook) {
      try {
        await awaitFacebookTaskDocument(
          executor,
          tab.tabId,
          async () => {
            await facebook.assertIdentity();
            session.lease.check();
            if (
              !isPeerPaused(host, peer) ||
              host.sessions.get(peer.profileId) !== session ||
              session.closing
            )
              throw Error('FACEBOOK_TASK_DOCUMENT_CONTEXT_CHANGED');
          },
          {
            expectedUrl: facebook.initialUrl,
            retainedPage: existingTab !== undefined,
            allowTargetBrowseUrl: facebook.backgroundMetadataRead === true,
            allowStuckLoadingStop:
              facebook.allowStuckTabRecovery === true && existingTab !== undefined,
            observe: async (document) => {
              session.record(
                'initial-document:' +
                  document.scope +
                  ':' +
                  document.ready +
                  (document.scope === 'other' && document.url
                    ? ':' + sanitizeTraceUrl(document.url)
                    : ''),
              );
              if (document.scope === 'other' && document.url && accountObserver) {
                const state = classifyAbnormalPathname(document.url);
                if (state)
                  await Promise.resolve(
                    accountObserver.onObserved(peer.profileId, { state, avatar: null }),
                  ).catch(() => {});
              }
            },
          },
        );
      } catch (docError) {
        if (
          docError instanceof Error &&
          docError.message === 'FACEBOOK_TASK_DOCUMENT_ERROR_PAGE' &&
          facebook.allowStuckTabRecovery === true &&
          existingTab !== undefined &&
          !peer.capabilities?.includes('kernel-tab-reset-v1') &&
          !session.hasRequestedMutation &&
          !session.closing
        ) {
          await executor
            .send({ tabId: tab.tabId }, 'Runtime.evaluate', {
              expression: "location.replace('https://www.facebook.com/')",
              returnByValue: true,
            })
            .catch(() => {});
        }
        throw docError;
      }
    }
    const baselineReply = await executor.send({ tabId: tab.tabId }, 'Runtime.evaluate', {
        expression: facebook
          ? 'JSON.stringify({webdriver:navigator.webdriver,userAgent:navigator.userAgent,language:navigator.language,languages:navigator.languages,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,visibility:document.visibilityState,focused:document.hasFocus(),rafFired:true})'
          : '(async()=>{let rafFired=false;const raf=requestAnimationFrame(()=>{rafFired=true});await new Promise(resolve=>setTimeout(resolve,1500));cancelAnimationFrame(raf);return JSON.stringify({webdriver:navigator.webdriver,userAgent:navigator.userAgent,language:navigator.language,languages:navigator.languages,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio,visibility:document.visibilityState,focused:document.hasFocus(),rafFired})})()',
        returnByValue: true,
        awaitPromise: !facebook,
      }),
      baselineResult = KernelJsonObject.parse(baselineReply.result);
    if (typeof baselineResult.value !== 'string') throw Error('KERNEL_BASELINE_INVALID');
    const baseline = KernelJsonObject.parse(JSON.parse(baselineResult.value) as unknown);
    if (typeof baseline.userAgent !== 'string') throw Error('KERNEL_BASELINE_UA_INVALID');
    if (!facebook) await executor.send({ tabId: tab.tabId }, 'Page.bringToFront', {});
    const { endpoint, browser } = await openRelayBrowserSession(
      session,
      executor,
      tab.tabId,
      baseline.userAgent,
      access,
    );
    await facebook?.assertIdentity();
    let closedInventory: ReturnType<typeof KernelPersistentState.parse> | null = null,
      closedPageState: 'READY' | 'CLOSED' | 'LOST' | null = null;
    const reconcileFacebookClosePage = async (allowRemove: boolean) => {
      const checkTransport = () => {
        if (
          host.sessions.get(peer.profileId) !== session ||
          host.core.peers.get(peer.profileId) !== peer
        )
          throw Error('KERNEL_STOP_TRANSPORT_CHANGED');
      };
      if (facebook?.preservePage?.() === true) {
        const before = await parseInventory(session),
          orig = before.tabs.find((row) => row.ownershipId === ownershipId);
        if (
          !proof ||
          !orig?.proof ||
          !sameTabProof(orig.proof, proof) ||
          (orig.state !== 'READY' && orig.state !== 'CLOSED' && orig.state !== 'LOST')
        )
          throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
        checkTransport();
        closedInventory = before;
        closedPageState = orig.state;
        return;
      }
      const res = await removeAndConfirmClosedTab(
        session,
        ownershipId,
        tab.tabId,
        proof,
        allowRemove,
        'FACEBOOK_TASK_CLOSE_UNCONFIRMED',
        checkTransport,
      );
      closedInventory = res.inventory;
      closedPageState = res.state;
    };
    const { close, retryClose, getClosingId } = createOwnedRelayCloser({
      host,
      peer,
      owner,
      session,
      executor,
      endpoint,
      browser,
      beforeLocalClose: async () => {
        if (facebook) await reconcileFacebookClosePage(true);
      },
      beforeRetryClose: async () => {
        if (facebook) await reconcileFacebookClosePage(closedPageState === null);
      },
      onReleaseExtra: () => {
        if (host.idlePages.get(peer.profileId)?.connection === connection)
          host.idlePages.delete(peer.profileId);
      },
    });
    const connection = buildOwnedConnection({
      host,
      peer,
      owner,
      session,
      executor,
      backend,
      endpoint,
      browser,
      tab,
      proof,
      persistent,
      access,
      baseline,
      facebook,
      arrangeWindow,
      close,
      retryClose,
      getClosingId,
      getClosedInventory: () => closedInventory,
    });
    return connection;
  } catch (error) {
    const originalFailure = session.failureReason;
    session.record(
      'connect-error:' + (error instanceof Error ? error.message.slice(0, 180) : 'unknown'),
    );
    let released = false;
    if (
      facebook &&
      initialProof &&
      !existingTab &&
      error instanceof Error &&
      !error.message.includes('_UNKNOWN') &&
      !session.hasRequestedMutation
    ) {
      try {
        const check = () => {
          session.lease.check();
          if (
            host.sessions.get(peer.profileId) !== session ||
            host.core.peers.get(peer.profileId) !== peer ||
            !peer.online ||
            !peer.synced ||
            peer.phase !== 'PAUSED' ||
            session.closing
          )
            throw Error('FACEBOOK_OPEN_CLEANUP_CONTEXT_CHANGED');
        };
        released = await removeAndStopFailedTab(host, peer, owner, session, initialProof, check);
        session.record('open-failed-page:CLOSED');
      } catch {
        session.record('open-failed-page:REVIEW');
      }
    }
    if (
      facebook &&
      existingTab &&
      !released &&
      error instanceof Error &&
      !error.message.includes('_UNKNOWN') &&
      !session.hasRequestedMutation
    ) {
      try {
        const requestId = randomUUID(),
          stop = await session.request({ kind: 'stop' }, requestId);
        if (stop.state === 'stopped' && stop.requestId === requestId) {
          host.core.releaseFixtureKernel(peer, owner);
          if (host.sessions.get(peer.profileId) === session) host.sessions.delete(peer.profileId);
          session.record('open-failed-retained-page:STOPPED');
          released = true;
        }
      } catch {
        session.record('open-failed-retained-page:REVIEW');
      }
    }
    session.closing = true;
    session.fail('KERNEL_OPEN_FAILED');
    await session.endpoint?.close().catch(() => {});
    if (!released) await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
    throw originalFailure ? Error(originalFailure) : error;
  }
}
export async function connectAgentBrowserImpl(
  host: KernelSessionHost,
  releaseIdleForExtension: (peer: Peer) => Promise<void>,
  peer: Peer,
  options: { initialUrl: string; files?: readonly string[]; foreground?: boolean },
) {
  const rejectUrl = () => {
    failError(
      'AGENT_BROWSER_URL_REJECTED',
      '仅支持访问合法的 http/https 网页地址（禁止访问本机管理端口或受限协议）',
      400,
    );
  };
  if (options.initialUrl !== 'about:blank' && !/^https?:\/\//i.test(options.initialUrl))
    rejectUrl();
  const { kernelAgentBrowserURL } = await import('../../shared/kernel-policy.js');
  if (!kernelAgentBrowserURL(options.initialUrl)) rejectUrl();
  if (
    host.core.peers.get(peer.profileId) !== peer ||
    !peer.online ||
    !peer.synced ||
    peer.phase !== 'PAUSED'
  )
    failError(
      'AGENT_BROWSER_PROFILE_NOT_READY',
      `浏览器当前未就绪（online=${peer.online}, synced=${peer.synced}, phase=${peer.phase}）`,
      409,
    );
  if (!peer.capabilities?.includes('agent-browser-kernel-v1'))
    failError(
      'AGENT_BROWSER_EXTENSION_RELOAD_REQUIRED',
      '当前浏览器插件版本尚未加载 AI 浏览器内核能力，请先触发扩展热刷新后再试',
      409,
    );
  if (host.idlePages.has(peer.profileId)) await releaseIdleForExtension(peer);
  const files = options.files ?? [],
    { owner, session } = await openKernelRpcSession(host, peer);
  session.access = 'agent-browser';
  session.boundInputRequired = false;
  let initialProof: TabProof | null = null;
  try {
    const { persistent, ownershipId, tab, proof, executor } = await openSessionBackendTab(
      host,
      peer,
      session,
      'agent-browser',
      files,
      undefined,
      options.initialUrl,
      options.foreground ?? false,
    );
    if (proof) initialProof = proof;
    await attachTabWithRetry(
      executor,
      tab.tabId,
      8_000,
      (error) =>
        error instanceof Error &&
        /INITIAL_DOCUMENT_PENDING|SCOPE_CHANGED|URL_REJECTED/.test(error.message),
      async () => {
        session.lease.check();
      },
    );
    let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0';
    try {
      const uaReply = await executor.send({ tabId: tab.tabId }, 'Runtime.evaluate', {
          expression: 'navigator.userAgent',
          returnByValue: true,
        }),
        uaResult = KernelJsonObject.safeParse(uaReply.result);
      if (uaResult.success && typeof uaResult.data.value === 'string' && uaResult.data.value)
        userAgent = uaResult.data.value;
    } catch {}
    const { endpoint, browser } = await openRelayBrowserSession(
      session,
      executor,
      tab.tabId,
      userAgent,
      'agent-browser',
    );
    let closedPageState: 'CLOSED' | 'LOST' | null = null;
    const removeOwnedAgentPage = async (allowRemove: boolean) => {
      if (!persistent || !proof) return;
      const res = await removeAndConfirmClosedTab(
        session,
        ownershipId,
        tab.tabId,
        proof,
        allowRemove,
        'AGENT_BROWSER_CLOSE_UNCONFIRMED',
      );
      closedPageState = res.state === 'READY' ? null : res.state;
    };
    const { close, retryClose, getClosingId } = createOwnedRelayCloser({
      host,
      peer,
      owner,
      session,
      executor,
      endpoint,
      browser,
      beforeLocalClose: () => removeOwnedAgentPage(true),
      beforeRetryClose: () => removeOwnedAgentPage(closedPageState === null),
    });
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) {
      await close().catch(async () => {
        await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
      });
      throw Error('AGENT_BROWSER_PAGE_MISSING');
    }
    const captureScreenshot = async (shotOpts: {
      quality: number;
      fullPage: boolean;
    }): Promise<Buffer> => {
      let clip: Record<string, number> | undefined;
      if (shotOpts.fullPage) {
        const metricsReply = await executor
            .send({ tabId: tab.tabId }, 'Runtime.evaluate', {
              expression: `(() => ({ width: Math.max(320, Math.min(2560, Math.ceil(document.documentElement?.scrollWidth || window.innerWidth || 1280))), height: Math.max(240, Math.min(8000, Math.ceil(Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, window.innerHeight || 720)))) }))()`,
              returnByValue: true,
            })
            .catch(() => null),
          parsedMetrics = metricsReply ? KernelJsonObject.safeParse(metricsReply.result) : null,
          val =
            parsedMetrics?.success &&
            typeof parsedMetrics.data.value === 'object' &&
            parsedMetrics.data.value !== null &&
            !Array.isArray(parsedMetrics.data.value)
              ? (parsedMetrics.data.value as Record<string, unknown>)
              : null;
        if (val && typeof val.width === 'number' && typeof val.height === 'number')
          clip = { x: 0, y: 0, width: val.width, height: val.height, scale: 1 };
      }
      const reply = await executor.send({ tabId: tab.tabId }, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: shotOpts.quality,
        captureBeyondViewport: Boolean(clip),
        ...(clip ? { clip } : {}),
      });
      if (typeof reply.data !== 'string' || !reply.data)
        throw Error('AGENT_BROWSER_SCREENSHOT_EMPTY');
      return Buffer.from(reply.data, 'base64');
    };
    return {
      browser,
      page,
      tabId: tab.tabId,
      proof,
      captureScreenshot,
      get stopRequestId() {
        return resolveSessionStopRequestId(host, peer, owner, session, getClosingId);
      },
      get failureReason() {
        return session.failureReason;
      },
      close,
      retryClose,
      stopOnCloseFailure: () => host.stopOwnedSessionOnCloseFailure(peer, session, owner, true),
    };
  } catch (error) {
    const originalFailure = session.failureReason;
    let released = false;
    if (
      initialProof &&
      error instanceof Error &&
      !error.message.includes('_UNKNOWN') &&
      !session.hasRequestedMutation
    )
      released = await removeAndStopFailedTab(host, peer, owner, session, initialProof).catch(
        () => false,
      );
    session.closing = true;
    session.fail('AGENT_BROWSER_OPEN_FAILED');
    await session.endpoint?.close().catch(() => {});
    if (!released) await host.stopOwnedSessionOnCloseFailure(peer, session, owner, true);
    throw originalFailure ? Error(originalFailure) : error;
  }
}
