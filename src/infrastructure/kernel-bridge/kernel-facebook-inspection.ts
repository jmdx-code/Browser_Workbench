import { z } from 'zod';
import type { Page } from 'playwright-core';
import type { Awaitable } from '../../domain/persistence.js';
import { sameTabProof } from '../../domain/task-tabs.js';
import type { Core, Peer } from '../../bridge/core.js';
import { classifyFacebookAbnormalUrl } from '../../shared/facebook-browse-route.js';
import { projectFacebookDocumentIdentity } from '../../shared/facebook-document-identity.js';
import { FacebookNativeActor } from '../../shared/facebook-native-identity.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { kernelOperationPending, type TabProof } from '../../shared/kernel-state.js';
import { PageReadRequest, validateProjection } from '../../shared/page-read.js';
import { projectPage } from '../../shared/page-projection.js';
import { profileForegroundGranted } from '../../shared/profile-foreground.js';
import { readCurrentFacebookBrowseIdentity } from '../facebook-browse-identity.js';
import { facebookDisplayInspectionProjection } from '../facebook-read-adapter.js';
import { readCurrentFacebookStoryIdentity } from '../facebook-story-identity.js';
import type { prepareFacebookWorkspace } from '../facebook-workspace-preparation.js';
import { detectAbnormalFacebookDom } from '../shared-dom-eval-runtime.js';
import {
  ensureRetainedBrowsePageImpl,
  navigateRetainedPageHomeImpl,
  prepareInvitationHomeImpl,
  type waitInvitationHomeIdentityImpl,
} from './kernel-retained-page.js';
import {
  isStuckDocumentRecoveryError,
  type FacebookOwnedOptions,
  type IdlePageEntry,
  type KernelSummaryPort,
} from './kernel-rpc-session.js';
import type { OwnedConnection } from './kernel-owned-execution.js';
export interface InspectReadOptions {
  noWorkspaceCleanup?: boolean;
  timeoutMs?: number;
  forceNewTemporaryTab?: boolean;
  backgroundMetadataRead?: boolean;
  disableOuterTimeout?: boolean;
  allowStuckTabRecovery?: boolean;
}
type ObserveAccountFn = (
  profileId: string,
  page: Page,
  actor: { accountId: string; name: string | null } | null,
) => Promise<void>;
export type InspectOwnedFacebookPageFn = <T>(
  peer: Peer,
  assertAllowed: () => Awaitable<void>,
  initialUrl: string,
  read: (page: Page, reusedTab?: TabProof) => Promise<T>,
  foreground?: boolean,
  retainForTask?: boolean,
  existingTab?: TabProof,
  readOptions?: InspectReadOptions,
) => Promise<{
  reading: T;
  connection: { profileId: string; connectionEpoch: string };
  proof: TabProof;
  closedRecord: NonNullable<OwnedConnection['closedInventory']>['tabs'][number];
  stop: { requestId: string; state: 'stopped' };
}>;
export interface KernelInspectionDeps {
  core: Core;
  idlePages: Map<string, IdlePageEntry>;
  usesExposedWindowLayout: () => boolean;
  releaseIdleForExtension: (peer: Peer) => Promise<void>;
  prepareWorkspace: (
    peer: Peer,
    existingTab: TabProof | undefined,
    assertAllowed: () => Awaitable<void>,
  ) => ReturnType<typeof prepareFacebookWorkspace>;
  connectOwned: (
    peer: Peer,
    files: readonly string[],
    existingTab?: TabProof,
    facebook?: FacebookOwnedOptions,
  ) => Promise<OwnedConnection>;
  recoverStuckWorkspaceTab: (
    peer: Peer,
    proof: TabProof,
    assertAllowed: () => Awaitable<void>,
  ) => Promise<{ proof: TabProof; url: string; targetChanged: boolean } | null>;
  revealOwnedFacebookPage: (peer: Peer, proof: TabProof, focus: boolean) => Promise<unknown>;
  withSummary: <R>(peer: Peer, work: (port: KernelSummaryPort) => Promise<R>) => Promise<R>;
  waitInvitationHomeIdentity: typeof waitInvitationHomeIdentityImpl;
  observeExternalPageAccount: ObserveAccountFn;
  readFacebookMetadataPage: <T>(
    peer: Peer,
    guard: () => Awaitable<void>,
    read: (page: Page) => Promise<T>,
    existingTab?: TabProof,
    timeoutMs?: number,
    options?: InspectReadOptions & { initialUrl?: string },
  ) => Promise<{ reading: T }>;
  inspectOwnedFacebookPage: InspectOwnedFacebookPageFn;
  navigateRetainedPageHome: typeof navigateRetainedPageHomeImpl;
}
const DocUrl = z.enum(['https://www.facebook.com/', 'https://www.facebook.com/post/create']),
  DocReady = z.enum(['interactive', 'complete']),
  DocumentFence = z
    .object({ url: DocUrl, timeOrigin: z.number().finite().nonnegative(), ready: DocReady })
    .strict(),
  CurrentActor = z
    .object({ url: DocUrl, ready: DocReady, actor: FacebookNativeActor.nullable() })
    .strict(),
  creatorProjection = PageReadRequest.parse({
    queries: facebookDisplayInspectionProjection.queries.filter((q) =>
      ['homeComposers', 'composerProfileLinks'].includes(q.key),
    ),
  }),
  ObsSchema = z
    .object({
      before: z.unknown(),
      selected: z.unknown(),
      creator: z.unknown(),
      after: z.unknown(),
      abnormal: z
        .enum([
          'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED',
          'FACEBOOK_ACCOUNT_RESTRICTED',
          'FACEBOOK_ACCOUNT_LOGGED_OUT',
        ])
        .nullable()
        .optional(),
    })
    .strict();
async function readCurrentFacebookIdentity(page: Page, assertCurrent: () => Awaitable<void>) {
  await assertCurrent();
  const parseFence = (input: unknown) => {
    if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') {
      const abnormalUrl = classifyFacebookAbnormalUrl(input.url);
      if (abnormalUrl) throw Error(abnormalUrl);
    }
    const r = DocumentFence.safeParse(input);
    if (!r.success)
      throw Error(
        r.error.issues.some((i) => i.path[0] === 'url')
          ? 'FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED'
          : 'FACEBOOK_TASK_DOCUMENT_READ_FAILED',
      );
    return r.data;
  };
  const obs = ObsSchema.parse(
    await page.evaluate(
      `(() => {const f=()=>({url:location.href,timeOrigin:performance.timeOrigin,ready:document.readyState});const before=f(),selected=(${projectFacebookDocumentIdentity.toString()})("post-current"),creator=(${projectPage.toString()})(${JSON.stringify(creatorProjection)}),abnormal=!selected.actor?(${detectAbnormalFacebookDom.toString()})():null;return abnormal?{before,selected,creator,after:f(),abnormal}:{before,selected,creator,after:f()};})()`,
    ),
  );
  await assertCurrent();
  const before = parseFence(obs.before),
    after = parseFence(obs.after),
    selected = CurrentActor.parse(obs.selected),
    creator = validateProjection(creatorProjection, obs.creator);
  if (!selected.actor && obs.abnormal) throw Error(obs.abnormal);
  if (
    !selected.actor ||
    before.url !== after.url ||
    selected.url !== after.url ||
    before.timeOrigin !== after.timeOrigin ||
    creator.url !== after.url ||
    creator.timeOrigin !== after.timeOrigin
  )
    throw Error('FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED');
  const regions = creator.rows.find((r) => r.key === 'homeComposers')?.nodes ?? [],
    links = creator.rows.find((r) => r.key === 'composerProfileLinks')?.nodes ?? [],
    href = links[0]?.attributes.href;
  if (regions.length !== 1 || links.length !== 1 || !href)
    throw Error('FACEBOOK_CURRENT_CREATOR_UNCONFIRMED');
  const url = new URL(href, after.url);
  if (
    url.origin !== 'https://www.facebook.com' ||
    url.pathname !== '/profile.php' ||
    url.searchParams.get('id') !== selected.actor.accountId ||
    (after.url === 'https://www.facebook.com/' && (!regions[0]?.visible || !links[0]?.visible))
  )
    throw Error('FACEBOOK_CURRENT_CREATOR_UNCONFIRMED');
  return {
    actor: selected.actor,
    document: after,
    transport: 'document-preload' as const,
    creator,
  };
}
async function readBrowseOrHomeIdentity(
  page: Page,
  guard: () => Awaitable<void>,
  deps: {
    waitInvitationHomeIdentity: typeof waitInvitationHomeIdentityImpl;
    navigateHome: (page: Page, guard: () => Awaitable<void>) => Promise<boolean>;
  },
  opts: {
    checkEnsure: boolean;
    storyAdmission: boolean;
    homeAdmission: boolean;
    allowHomeFallback: boolean;
  },
) {
  const navigated = opts.homeAdmission
    ? await prepareInvitationHomeImpl(page, guard)
    : opts.checkEnsure
      ? await ensureRetainedBrowsePageImpl(page, guard, opts.storyAdmission)
      : false;
  const readIdentity = () =>
    (opts.storyAdmission && /^https:\/\/www\.facebook\.com\/stories\/create\/?$/.test(page.url())
      ? readCurrentFacebookStoryIdentity
      : readCurrentFacebookBrowseIdentity)(page, guard);
  try {
    return opts.homeAdmission
      ? await deps.waitInvitationHomeIdentity(page, guard)
      : await readIdentity();
  } catch (err) {
    await guard();
    const isAbnormal =
      err instanceof Error &&
      /^FACEBOOK_ACCOUNT_(?:VERIFICATION_REQUIRED|RESTRICTED|LOGGED_OUT)$/.test(err.message);
    if (
      opts.allowHomeFallback &&
      !opts.homeAdmission &&
      !navigated &&
      !opts.storyAdmission &&
      !isAbnormal &&
      (await deps.navigateHome(page, guard))
    )
      return await readIdentity();
    throw err;
  }
}
async function getReadyIdleRow(
  deps: KernelInspectionDeps,
  peer: Peer,
  guard: () => Awaitable<void>,
  expectedProof?: TabProof,
) {
  const idle = deps.idlePages.get(peer.profileId);
  if (!idle) return null;
  await guard();
  if (
    idle.peer !== peer ||
    (!expectedProof && deps.core.peers.get(peer.profileId) !== peer) ||
    idle.connection.failureReason ||
    !idle.connection.proof ||
    (expectedProof && !sameTabProof(idle.connection.proof, expectedProof))
  ) {
    if (expectedProof) throw Error('FACEBOOK_WORKSPACE_CONNECTION_CHANGED');
    await idle.connection.close().catch(() => {});
    deps.idlePages.delete(peer.profileId);
    return null;
  }
  const proof = idle.connection.proof,
    inventory = await idle.connection.inventory();
  await guard();
  const row = inventory.tabs.find((t) => t.ownershipId === proof.ownershipId);
  if (
    inventory.operations.some(kernelOperationPending) ||
    row?.state !== 'READY' ||
    !row.proof ||
    !sameTabProof(row.proof, proof)
  ) {
    await idle.connection.close().catch(() => {});
    return null;
  }
  const page = idle.connection.browser.contexts()[0]?.pages()[0];
  if (!page) throw Error('FACEBOOK_WORKSPACE_PAGE_REQUIRED');
  return { idle, proof, row, page };
}
export async function inspectIdleFacebookPageImpl(
  deps: KernelInspectionDeps,
  peer: Peer,
  guard: () => Awaitable<void>,
  storyAdmission = false,
  homeAdmission = false,
) {
  const ready = await getReadyIdleRow(deps, peer, guard);
  if (!ready) return null;
  const { idle, proof, row, page } = ready;
  if (
    !deps.usesExposedWindowLayout() &&
    peer.capabilities?.includes('kernel-owned-page-reveal-v1')
  ) {
    await deps.revealOwnedFacebookPage(peer, proof, false).catch(() => {});
    await guard();
  }
  let current;
  try {
    current = await readBrowseOrHomeIdentity(
      page,
      guard,
      {
        waitInvitationHomeIdentity: deps.waitInvitationHomeIdentity,
        navigateHome: navigateRetainedPageHomeImpl,
      },
      { checkEnsure: true, storyAdmission, homeAdmission, allowHomeFallback: true },
    );
  } catch (error) {
    await deps.observeExternalPageAccount(peer.profileId, page, null);
    throw error;
  }
  await deps.observeExternalPageAccount(peer.profileId, page, current.actor);
  await guard();
  const visibility = await page.evaluate(() => document.visibilityState);
  await guard();
  return {
    actor: current.actor,
    transport: 'document-preload' as const,
    connection: { profileId: peer.profileId, connectionEpoch: peer.epoch },
    proof,
    closedRecord: row,
    stop: idle.stop,
    retained: true as const,
    workspaceRetained: true as const,
    page: { ...current.document, visibility, rows: [] },
  };
}
export async function inspectFacebookIdentityImpl(
  deps: KernelInspectionDeps,
  peer: Peer,
  assertAllowed: () => Awaitable<void>,
  retainForTask = false,
  existingTab?: TabProof,
  browseAdmission = false,
  storyAdmission = false,
  homeAdmission = false,
) {
  const observed = await deps.inspectOwnedFacebookPage(
    peer,
    assertAllowed,
    storyAdmission && existingTab
      ? 'https://www.facebook.com/stories/create/'
      : 'https://www.facebook.com/',
    async (page, reusedTab) => {
      existingTab = reusedTab;
      try {
        if (!browseAdmission) {
          if (
            existingTab !== undefined &&
            !['https://www.facebook.com/', 'https://www.facebook.com/post/create'].includes(
              page.url(),
            )
          )
            await deps.navigateRetainedPageHome(page, assertAllowed);
          const res = await readCurrentFacebookIdentity(page, assertAllowed);
          await deps.observeExternalPageAccount(peer.profileId, page, res.actor);
          return res;
        }
        const current = await readBrowseOrHomeIdentity(
          page,
          assertAllowed,
          {
            waitInvitationHomeIdentity: deps.waitInvitationHomeIdentity,
            navigateHome: deps.navigateRetainedPageHome,
          },
          {
            checkEnsure: existingTab !== undefined,
            storyAdmission,
            homeAdmission,
            allowHomeFallback: existingTab !== undefined,
          },
        );
        await deps.observeExternalPageAccount(peer.profileId, page, current.actor);
        const visibility = await page.evaluate(() => document.visibilityState);
        await assertAllowed();
        return {
          actor: current.actor,
          transport: 'document-preload' as const,
          creator: { ...current.document, visibility, rows: [] },
        };
      } catch (error) {
        await deps.observeExternalPageAccount(peer.profileId, page, null);
        throw error;
      }
    },
    retainForTask &&
      peer.capabilities?.includes('kernel-create-foreground-v1') === true &&
      profileForegroundGranted(peer),
    retainForTask,
    existingTab,
    browseAdmission && !storyAdmission && !homeAdmission
      ? { allowStuckTabRecovery: true }
      : undefined,
  );
  return {
    actor: observed.reading.actor,
    transport: observed.reading.transport,
    connection: observed.connection,
    proof: observed.proof,
    closedRecord: observed.closedRecord,
    stop: observed.stop,
    page: observed.reading.creator,
    retained: retainForTask || existingTab !== undefined,
    workspaceRetained: existingTab !== undefined,
  };
}
async function readFacebookDisplayDocumentImpl(
  observeExternalPageAccount: ObserveAccountFn,
  page: Page,
  guard: () => Awaitable<void>,
  currentRoute = false,
  profileId?: string,
) {
  await guard();
  const projection = validateProjection(
    facebookDisplayInspectionProjection,
    await page.evaluate(projectPage, facebookDisplayInspectionProjection),
  );
  await guard();
  const identity = await page.evaluate(
    projectFacebookDocumentIdentity,
    currentRoute && projection.url !== 'https://www.facebook.com/post/create'
      ? ('browse' as const)
      : ('task' as const),
  );
  await guard();
  const after = await page.evaluate(() => ({
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    restricted:
      /account has been disabled|your account is disabled|we suspended your account|账号已被停用|账户已被停用|已停用你的账户/i.test(
        (document.body?.innerText || '').slice(0, 4000),
      ),
  }));
  await guard();
  if (
    projection.url !== after.url ||
    projection.timeOrigin !== after.timeOrigin ||
    projection.ready !== 'complete' ||
    after.ready !== 'complete' ||
    identity.url !== after.url
  )
    throw Error('FACEBOOK_DISPLAY_DOCUMENT_CHANGED');
  const actor = FacebookNativeActor.nullable().parse(identity.actor);
  if (profileId) await observeExternalPageAccount(profileId, page, actor);
  if (!actor) {
    const abnormalUrl = classifyFacebookAbnormalUrl(after.url);
    if (abnormalUrl) throw Error(abnormalUrl);
    if (after.restricted) throw Error('FACEBOOK_ACCOUNT_RESTRICTED');
  }
  return { page: projection, actor };
}
const readDisplay = (
  deps: KernelInspectionDeps,
  page: Page,
  guard: () => Awaitable<void>,
  currentRoute: boolean,
  profileId: string,
) =>
  readFacebookDisplayDocumentImpl(
    deps.observeExternalPageAccount,
    page,
    guard,
    currentRoute,
    profileId,
  );
async function inspectDisplayDoc(
  deps: KernelInspectionDeps,
  peer: Peer,
  guard: () => Awaitable<void>,
  currentRoute: boolean,
  existingTab?: TabProof,
) {
  return (
    await deps.inspectOwnedFacebookPage(
      peer,
      guard,
      'https://www.facebook.com/',
      (page) => readDisplay(deps, page, guard, currentRoute, peer.profileId),
      false,
      false,
      existingTab,
    )
  ).reading;
}
export async function inspectRetainedFacebookDisplayImpl(
  deps: KernelInspectionDeps,
  peer: Peer,
  proof: TabProof,
  guard: () => Awaitable<void>,
) {
  await guard();
  const ready = await getReadyIdleRow(deps, peer, guard, proof);
  return ready
    ? readDisplay(deps, ready.page, guard, true, peer.profileId)
    : inspectDisplayDoc(deps, peer, guard, true, proof);
}
export const inspectFacebookDisplayImpl = (
  deps: KernelInspectionDeps,
  peer: Peer,
  assertAllowed: () => Awaitable<void>,
) => inspectDisplayDoc(deps, peer, assertAllowed, false);
export async function inspectFacebookAccountSilentlyImpl(
  deps: KernelInspectionDeps,
  peer: Peer,
  guard: () => Awaitable<void>,
  timeoutMs = 20_000,
) {
  const observed = await deps.readFacebookMetadataPage(
    peer,
    guard,
    async (page) => {
      for (const end = Date.now() + Math.max(4_000, timeoutMs - 4_000); Date.now() < end;) {
        await guard();
        const probe = await page
            .evaluate(projectFacebookDocumentIdentity, 'browse' as const)
            .catch(() => null),
          docReady = await page
            .evaluate(() => ({
              ready: document.readyState,
              href: location.href,
              hasLoginInputs: Boolean(
                document.querySelector('input[name="email"]') &&
                document.querySelector('input[name="pass"]'),
              ),
            }))
            .catch(() => null);
        if (
          docReady?.ready === 'complete' &&
          (probe?.actor !== null ||
            Boolean(classifyFacebookAbnormalUrl(docReady.href)) ||
            docReady.hasLoginInputs)
        )
          break;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      for (let attempt = 0; ; attempt++) {
        await guard();
        try {
          return await readDisplay(deps, page, guard, true, peer.profileId);
        } catch (error) {
          if (
            attempt < 4 &&
            error instanceof Error &&
            error.message === 'FACEBOOK_DISPLAY_DOCUMENT_CHANGED'
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 400));
            continue;
          }
          throw error;
        }
      }
    },
    undefined,
    timeoutMs,
    {
      initialUrl: 'https://www.facebook.com/',
      forceNewTemporaryTab: true,
      backgroundMetadataRead: true,
      disableOuterTimeout: false,
    },
  );
  return observed.reading;
}
export async function inspectOwnedFacebookPageImpl<T>(
  deps: KernelInspectionDeps,
  peer: Peer,
  assertAllowed: () => Awaitable<void>,
  initialUrl: string,
  read: (page: Page, reusedTab?: TabProof) => Promise<T>,
  foreground = false,
  retainForTask = false,
  existingTab?: TabProof,
  readOptions?: InspectReadOptions,
) {
  await assertAllowed();
  if (
    !peer.capabilities?.includes('facebook-task-kernel-v1') ||
    !peer.capabilities.includes('facebook-task-main-frame-v1')
  )
    throw Error('FACEBOOK_TASK_EXTENSION_UPDATE_REQUIRED');
  if (readOptions?.forceNewTemporaryTab === true) {
    existingTab = undefined;
    if (deps.idlePages.has(peer.profileId)) {
      await deps.releaseIdleForExtension(peer);
      await assertAllowed();
    }
  }
  if (!existingTab && !readOptions?.noWorkspaceCleanup) {
    const { proof, inventory } = await deps.prepareWorkspace(peer, existingTab, assertAllowed);
    existingTab = proof;
    await assertAllowed();
    if (
      inventory.operations.some(kernelOperationPending) ||
      inventory.tabs.some(
        (r) =>
          !['CLOSED', 'LOST'].includes(r.state) &&
          !(existingTab && r.state === 'READY' && r.proof && sameTabProof(r.proof, existingTab)),
      )
    )
      throw Error('FACEBOOK_IDENTITY_NATIVE_REVIEW_REQUIRED');
  }
  let keepPage = existingTab !== undefined;
  const parked =
    readOptions?.noWorkspaceCleanup && !readOptions.forceNewTemporaryTab
      ? deps.idlePages.get(peer.profileId)
      : undefined;
  if (
    parked &&
    (parked.peer !== peer ||
      !existingTab ||
      !parked.connection.proof ||
      !sameTabProof(parked.connection.proof, existingTab) ||
      !peer.capabilities?.includes('kernel-page-quiesce-v1'))
  )
    throw Error('FACEBOOK_METADATA_BROWSER_BUSY');
  const openInspect = (tab: TabProof | undefined, allowRecovery: boolean) =>
    deps.connectOwned(peer, [], tab, {
      accountId: null,
      assertIdentity: assertAllowed,
      readonlyIdentity: true,
      initialUrl,
      foreground: readOptions?.backgroundMetadataRead ? false : foreground,
      preservePage: () => keepPage,
      forceNewTemporaryTab: readOptions?.forceNewTemporaryTab === true,
      backgroundMetadataRead: readOptions?.backgroundMetadataRead === true,
      allowStuckTabRecovery: allowRecovery,
    });
  const allowInspectRecovery =
    readOptions?.allowStuckTabRecovery === true &&
    !readOptions.backgroundMetadataRead &&
    !readOptions.forceNewTemporaryTab;
  let connection = parked?.connection;
  if (!connection) {
    try {
      connection = await openInspect(existingTab, allowInspectRecovery);
    } catch (error) {
      const recovered =
        allowInspectRecovery && existingTab && isStuckDocumentRecoveryError(error)
          ? await deps.recoverStuckWorkspaceTab(peer, existingTab, assertAllowed).catch(() => null)
          : null;
      if (!recovered) throw error;
      existingTab = recovered.proof;
      await assertAllowed();
      connection = await openInspect(existingTab, false);
    }
  }
  let current: T | undefined,
    readError: unknown,
    hasReadError = false,
    stop: Awaited<ReturnType<typeof connection.close>> | undefined;
  try {
    await assertAllowed();
    const contexts = connection.browser.contexts(),
      pages = contexts[0]?.pages();
    if (contexts.length !== 1 || pages?.length !== 1 || !pages[0] || !connection.proof)
      throw Error('FACEBOOK_IDENTITY_OWNED_PAGE_REQUIRED');
    if (
      retainForTask &&
      !deps.usesExposedWindowLayout() &&
      peer.capabilities?.includes('kernel-owned-page-reveal-v1')
    ) {
      await deps.revealOwnedFacebookPage(peer, connection.proof, false).catch(() => {});
      await assertAllowed();
    }
    if (readOptions?.disableOuterTimeout === true) current = await read(pages[0], existingTab);
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        current = await Promise.race([
          read(pages[0], existingTab),
          new Promise<never>((_, rej) => {
            timer = setTimeout(
              () => rej(Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT')),
              readOptions?.timeoutMs ?? 40_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await assertAllowed();
    keepPage = retainForTask || existingTab !== undefined;
  } catch (error) {
    readError = error;
    hasReadError = true;
  } finally {
    let closeRequestId = connection.stopRequestId;
    try {
      stop = await connection.close(closeRequestId);
    } catch (closeError) {
      try {
        await connection.stopOnCloseFailure();
        closeRequestId = connection.stopRequestId;
        const needFresh =
          closeError instanceof Error &&
          (closeError.message === 'KERNEL_CONTROL_ID_CONFLICT' ||
            /^KERNEL_DEBUGGER_(?:DETACHED|CANCELED_BY_USER)/.test(closeError.message));
        stop = needFresh
          ? await connection.close(closeRequestId)
          : await connection.retryClose(closeRequestId);
      } catch (retryError) {
        if (!hasReadError) throw retryError;
        const msg =
          retryError instanceof Error
            ? retryError.message
            : closeError instanceof Error
              ? closeError.message
              : 'CLOSE_FAILED';
        devDiag.emit('WARN', 'BRIDGE_WS', 'INSPECT_OWNED_PAGE_CLOSE_FAILED_AFTER_READ_ERROR', {
          profileId: peer.profileId,
          reason: msg,
        });
      }
    }
  }
  if (hasReadError) throw readError;
  await assertAllowed();
  const proof = connection.proof,
    closedRecord = connection.closedInventory?.tabs.find(
      (r) => proof && r.proof && sameTabProof(proof, r.proof),
    ),
    closedStateAllowed = keepPage
      ? closedRecord?.state === 'READY'
      : closedRecord?.state === 'CLOSED' || closedRecord?.state === 'LOST';
  if (!proof || !closedRecord || !closedStateAllowed || !stop || stop.state !== 'stopped')
    throw Error('FACEBOOK_IDENTITY_READ_RELEASE_UNCONFIRMED');
  return {
    reading: current as T,
    connection: { profileId: peer.profileId, connectionEpoch: peer.epoch },
    proof,
    closedRecord,
    stop,
  };
}
