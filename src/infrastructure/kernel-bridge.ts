import type { Page } from 'playwright-core';
import type { Awaitable } from '../domain/persistence.js';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridgeHooks } from '../bridge/server.js';
import type { KernelState, TabProof } from '../shared/kernel-state.js';
import type { ProfilePresentationStatus } from '../shared/presentation-recovery.js';
import type { Rect, TaskWindow } from '../shared/window-layout.js';
import { PresentationFocusGate, PositionRecoveryGate } from '../application/kernel-gates.js';
import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import { connectAgentBrowserImpl, connectOwnedImpl } from './kernel-bridge/kernel-connections.js';
import {
  inspectFacebookAccountSilentlyImpl,
  inspectFacebookDisplayImpl,
  inspectFacebookIdentityImpl,
  inspectIdleFacebookPageImpl,
  inspectOwnedFacebookPageImpl,
  inspectRetainedFacebookDisplayImpl,
  type KernelInspectionDeps,
} from './kernel-bridge/kernel-facebook-inspection.js';
import {
  closeKernelSessions,
  discardAdmissionTabImpl,
  handleKernelControlStopped,
  handleKernelDisconnected,
  handleKernelMessage,
  revokeKernelInputs,
  tickKernelSessions,
  type KernelLifecycleHost,
} from './kernel-bridge/kernel-lifecycle.js';
import {
  consolidateFacebookWorkspaceImpl,
  observeExternalPageAccountImpl,
  observeProjectedAccountImpl,
  readFacebookPageImpl,
  recoverStuckWorkspaceTabImpl,
  resolveTaskWindow,
  revealOwnedFacebookPageImpl,
} from './kernel-bridge/kernel-page-readers.js';
import {
  connectFacebookImpl,
  navigateRetainedPageHomeImpl,
  readFacebookMetadataPageImpl,
  waitInvitationHomeIdentityImpl,
  withSummaryImpl,
} from './kernel-bridge/kernel-retained-page.js';
import {
  archivedOperations as archivedOperationsQuery,
  KernelRpcSession,
  stopOwnedSessionOnCloseFailure as stopOwnedSessionOnCloseFailureImpl,
  type AccountObserver,
  type FacebookOwnedOptions,
  type IdlePageEntry,
  type KernelSessionHost,
  type KernelSummaryPort,
} from './kernel-bridge/kernel-rpc-session.js';
export type { KernelSummaryPort };
type Tail1<F> = F extends (a: never, ...r: infer R) => unknown ? R : never;
type Tail2<F> = F extends (a: never, b: never, ...r: infer R) => unknown ? R : never;
export class KernelBridge implements KernelBridgeHooks {
  recoverBumperWorkspace?: (
    peer: Peer,
    guard: () => Awaitable<void>,
  ) => Promise<ReadonlySet<string>>;
  recoverPosterWorkspace?: (
    peer: Peer,
    guard: () => Awaitable<void>,
  ) => Promise<ReadonlySet<string>>;
  retireClosedSession?: (peer: Peer, port: KernelSummaryPort, state: KernelState) => Promise<void>;
  private arrangeWindow?: (profileId: string, guard: () => void) => Promise<void>;
  private exposedLayoutEnabled?: () => boolean;
  private recoverWindow?: (profileId: string, guard: () => void, deadline: number) => Promise<void>;
  private windowVisible?: (profileId: string, observedAt: number) => void;
  private readonly presentationFocusGate = new PresentationFocusGate();
  private readonly positionRecoveryGate = new PositionRecoveryGate();
  private readonly sessions = new Map<string, KernelRpcSession>();
  private readonly sessionsByPeer = new WeakMap<Peer, KernelRpcSession>();
  private readonly idlePages = new Map<string, IdlePageEntry>();
  private readonly renewing = new Set<KernelRpcSession>();
  private readonly sequences = new WeakMap<Peer, number>();
  private readonly traces = new Map<string, { at: number; event: string }[]>();
  private readonly lastFailureReasons = new Map<
    string,
    { reason: string; epoch: string; at: number }
  >();
  private readonly retiredPeers = new WeakSet<Peer>();
  private accountObserver?: AccountObserver;
  private readonly hostRef: KernelSessionHost;
  constructor(private readonly core: Core) {
    this.hostRef = {
      core: this.core,
      sessions: this.sessions,
      sessionsByPeer: this.sessionsByPeer,
      idlePages: this.idlePages,
      renewing: this.renewing,
      sequences: this.sequences,
      traces: this.traces,
      registerSession: (peer, session) => {
        this.sessions.set(peer.profileId, session);
        this.sessionsByPeer.set(peer, session);
      },
      nextSequence: (peer) => {
        const seq = (this.sequences.get(peer) ?? 0) + 1;
        this.sequences.set(peer, seq);
        return seq;
      },
      stopOwnedSessionOnCloseFailure: (peer, session, owner, claimedOwnership = true) =>
        stopOwnedSessionOnCloseFailureImpl(
          this.core,
          this.sessions,
          peer,
          session,
          owner,
          claimedOwnership,
        ),
    };
  }
  private get inspectionDeps(): KernelInspectionDeps {
    return {
      core: this.core,
      idlePages: this.idlePages,
      usesExposedWindowLayout: () => this.usesExposedWindowLayout(),
      releaseIdleForExtension: (p) => this.releaseIdleForExtension(p),
      prepareWorkspace: (p, tab, guard) =>
        prepareFacebookWorkspace(this, p, tab, guard, undefined, true),
      connectOwned: (p, f, tab, fb) => this.connectOwned(p, f, tab, fb),
      recoverStuckWorkspaceTab: (p, tab, guard) => this.recoverStuckWorkspaceTab(p, tab, guard),
      revealOwnedFacebookPage: (p, proof, focus) => this.revealOwnedFacebookPage(p, proof, focus),
      withSummary: (p, work) => this.withSummary(p, work),
      waitInvitationHomeIdentity: waitInvitationHomeIdentityImpl,
      observeExternalPageAccount: (pid, page, actor) =>
        this.observeExternalPageAccount(pid, page, actor),
      readFacebookMetadataPage: (p, g, r, tab, t, opts) =>
        this.readFacebookMetadataPage(p, g, r, tab, t, opts),
      inspectOwnedFacebookPage: (p, a, u, r, fg, rt, tab, opts) =>
        this.inspectOwnedFacebookPage(p, a, u, r, fg, rt, tab, opts),
      navigateRetainedPageHome: navigateRetainedPageHomeImpl,
    };
  }
  private lifecycleHost(): KernelLifecycleHost {
    return {
      ...this.hostRef,
      presentationFocusGate: this.presentationFocusGate,
      positionRecoveryGate: this.positionRecoveryGate,
      lastFailureReasons: this.lastFailureReasons,
      usesExposedWindowLayout: () => this.usesExposedWindowLayout(),
      recoverWindow: this.recoverWindow,
      windowVisible: this.windowVisible,
    };
  }
  usesExposedWindowLayout() {
    return this.exposedLayoutEnabled?.() === true;
  }
  setWindowLayoutHook(
    hook: (profileId: string, guard: () => void) => Promise<void>,
    enabled?: () => boolean,
    recover?: (profileId: string, guard: () => void, deadline: number) => Promise<void>,
    visible?: (profileId: string, observedAt: number) => void,
  ) {
    this.arrangeWindow = hook;
    this.exposedLayoutEnabled = enabled;
    this.recoverWindow = recover;
    this.windowVisible = visible;
  }
  taskWindow(
    profileId: string,
    expected?: TaskWindow,
    rect?: Rect,
    _exposed = false,
    _deadline?: number,
    focus = true,
  ): Promise<TaskWindow> {
    return resolveTaskWindow(this.hostRef, profileId, expected, rect, _exposed, _deadline, focus);
  }
  async releaseIdleForExtension(peer: Peer) {
    const idle = this.idlePages.get(peer.profileId);
    if (idle?.peer === peer) await idle.connection.close();
  }
  consolidateFacebookWorkspace(peer: Peer, preferActiveTab = true) {
    return consolidateFacebookWorkspaceImpl(this, this.hostRef, peer, preferActiveTab);
  }
  recoverStuckWorkspaceTab(peer: Peer, proof: TabProof, assertAllowed: () => Awaitable<void>) {
    return recoverStuckWorkspaceTabImpl(this.hostRef, peer, proof, assertAllowed);
  }
  revealRegisteredFacebookPage(peer: Peer) {
    return this.core.revealBrowserWindow(peer.profileId);
  }
  revealOwnedFacebookPage(
    peer: Peer,
    proof: TabProof,
    focus?: true,
  ): Promise<{ profileId: string; tabId: number; focused: true }>;
  revealOwnedFacebookPage(
    peer: Peer,
    proof: TabProof,
    focus: boolean,
  ): Promise<{ profileId: string; tabId: number; focused: boolean }>;
  revealOwnedFacebookPage(peer: Peer, proof: TabProof, focus = true) {
    return revealOwnedFacebookPageImpl(this.hostRef, peer, proof, focus);
  }
  lastSessionFailureReason(profileId: string, expectedEpoch?: string): string | null {
    const entry = this.lastFailureReasons.get(profileId);
    if (
      !entry ||
      (expectedEpoch !== undefined && entry.epoch !== expectedEpoch) ||
      Date.now() - entry.at > 60_000
    )
      return null;
    return entry.reason;
  }
  setAccountObserver(observer: AccountObserver) {
    this.accountObserver = observer;
  }
  observeExternalPageAccount(...a: Tail1<typeof observeExternalPageAccountImpl>) {
    return observeExternalPageAccountImpl(this.accountObserver, ...a);
  }
  observeProjectedAccount(...a: Tail1<typeof observeProjectedAccountImpl>) {
    return observeProjectedAccountImpl(this.accountObserver, ...a);
  }
  diagnostics(profileId: string) {
    return [...(this.traces.get(profileId) ?? [])];
  }
  presentationStatus(profileId: string): ProfilePresentationStatus | null {
    const session = this.sessions.get(profileId);
    if (
      !session?.presentationStatus ||
      this.core.peers.get(profileId) !== session.peer ||
      !session.peer.online
    )
      return null;
    return {
      ...session.presentationStatus,
      active: !session.closing && !session.inputRevoked && !session.parked && !session.parking,
    };
  }
  archivedOperations(profileId: string, operationIds: readonly string[]) {
    return archivedOperationsQuery(this.core, profileId, operationIds);
  }
  readFacebookPage(...a: Tail1<typeof readFacebookPageImpl>) {
    return readFacebookPageImpl(this.hostRef, ...a);
  }
  withSummary<T>(peer: Peer, work: (port: KernelSummaryPort) => Promise<T>): Promise<T> {
    return withSummaryImpl(this.hostRef, this.retiredPeers, this.retireClosedSession, peer, work);
  }
  connectAgentBrowser(...a: Tail2<typeof connectAgentBrowserImpl>) {
    return connectAgentBrowserImpl(this.hostRef, (p) => this.releaseIdleForExtension(p), ...a);
  }
  connectFacebook(...a: Tail1<typeof connectFacebookImpl>) {
    return connectFacebookImpl(this.inspectionDeps, ...a);
  }
  waitInvitationHomeIdentity(page: Page, guard: () => Awaitable<void>) {
    return waitInvitationHomeIdentityImpl(page, guard);
  }
  navigateRetainedPageHome(page: Page, guard: () => Awaitable<void>) {
    return navigateRetainedPageHomeImpl(page, guard);
  }
  inspectIdleFacebookPage(...a: Tail1<typeof inspectIdleFacebookPageImpl>) {
    return inspectIdleFacebookPageImpl(this.inspectionDeps, ...a);
  }
  discardAdmissionTab(peer: Peer, proof: TabProof) {
    return discardAdmissionTabImpl(this.inspectionDeps, peer, proof);
  }
  inspectFacebookIdentity(...a: Tail1<typeof inspectFacebookIdentityImpl>) {
    return inspectFacebookIdentityImpl(this.inspectionDeps, ...a);
  }
  inspectRetainedFacebookDisplay(peer: Peer, proof: TabProof, guard: () => Awaitable<void>) {
    return inspectRetainedFacebookDisplayImpl(this.inspectionDeps, peer, proof, guard);
  }
  inspectFacebookDisplay(peer: Peer, assertAllowed: () => Awaitable<void>) {
    return inspectFacebookDisplayImpl(this.inspectionDeps, peer, assertAllowed);
  }
  inspectFacebookAccountSilently(peer: Peer, guard: () => Awaitable<void>, timeoutMs = 20_000) {
    return inspectFacebookAccountSilentlyImpl(this.inspectionDeps, peer, guard, timeoutMs);
  }
  readFacebookMetadataPage<T>(
    ...a: Parameters<typeof readFacebookMetadataPageImpl<T>> extends [unknown, ...infer R]
      ? R
      : never
  ) {
    return readFacebookMetadataPageImpl<T>(this.inspectionDeps, ...a);
  }
  private inspectOwnedFacebookPage<T>(
    ...a: Parameters<typeof inspectOwnedFacebookPageImpl<T>> extends [unknown, ...infer R]
      ? R
      : never
  ) {
    return inspectOwnedFacebookPageImpl<T>(
      this.inspectionDeps ?? (this as unknown as KernelInspectionDeps),
      ...a,
    );
  }
  private connectOwned(
    peer: Peer,
    files: readonly string[],
    existingTab?: TabProof,
    facebook?: FacebookOwnedOptions,
  ) {
    return connectOwnedImpl(
      this.hostRef,
      this.accountObserver,
      this.arrangeWindow,
      peer,
      files,
      existingTab,
      facebook,
    );
  }
  message(peer: Peer, value: unknown): Promise<boolean> {
    return handleKernelMessage(this.lifecycleHost(), peer, value);
  }
  disconnected(peer: Peer): void {
    handleKernelDisconnected(this.lifecycleHost(), peer);
  }
  controlStopped(peer: Peer, requestId?: string): void {
    handleKernelControlStopped(this.hostRef, peer, requestId);
  }
  tick(): void {
    tickKernelSessions(this.core, this.sessions, this.renewing);
  }
  revokeInputs(reason: string): void {
    revokeKernelInputs(this.idlePages, this.sessions, reason);
  }
  close(): Promise<void> {
    return closeKernelSessions(this.idlePages, this.sessions);
  }
}
