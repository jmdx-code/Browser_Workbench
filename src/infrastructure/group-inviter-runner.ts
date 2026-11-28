import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import type { GlobalAccountAbnormalReporter } from '../application/account-abnormal-reporter.js';
import type {
  GroupInviterBrowserRunner,
  GroupInviterRepository,
  GroupInviterRunCallbacks,
} from '../application/group-inviter-service.js';
import type { Core } from '../bridge/core.js';
import type { Awaitable } from '../domain/persistence.js';
import { failError } from '../domain/workspace.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import { isLocalAvatar } from '../shared/group-bumper.js';
import type { InviterGroupRow } from '../shared/group-inviter.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import {
  FacebookGroupSessionHelper,
  reportGlobalRouteAbnormalIfNeeded,
} from './facebook-group-session.js';
import { invitationDigest, prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import { fetchAndLocalizeAvatar } from './group-bumper-avatar.js';
import {
  dismissFeatureInterventionDialogIfPresent,
  groupInvitationEffect,
  inviteDialogSelector,
  readGroupInvitationState,
} from './group-inviter-effects.js';
import {
  ensureGroupReadyAndJoin,
  runInviteBatchAndSubmit,
} from './group-inviter-runner/inviter-flow.js';
import {
  clickInvitationControl,
  collectInvitationConfirmations,
  confirmedInvitationGraphQL,
  finalizeInviterConnection,
  invitationResultStatus,
  inviterVerificationError,
  mountedInvitationSelectionMatches,
  observeInvitationGraphQL,
  readGroupCoverAndTitle,
  readInvitationDialogDebugInfo,
  retryInviterStop,
  settleInvitationConfirmation,
  type InvitationSubmission,
  type InviterConnection,
  type InviterFlowCtx,
  type InviterPendingStop,
  type InviterScope,
} from './group-inviter-runner/inviter-ops.js';
import type { KernelBridge } from './kernel-bridge.js';
export {
  clickInvitationControl,
  collectInvitationConfirmations,
  confirmedInvitationGraphQL,
  invitationResultStatus,
  mountedInvitationSelectionMatches,
  observeInvitationGraphQL,
  settleInvitationConfirmation,
  type InvitationSubmission,
};
const isGroupRouteUrl = (rawUrl: string, ...groupIds: string[]): boolean => {
  const route = new URL(rawUrl),
    seg = route.pathname.split('/');
  return (
    route.origin === 'https://www.facebook.com' &&
    seg[1] === 'groups' &&
    groupIds.includes(seg[2] ?? '')
  );
};
async function readVerifiedInviteState(
  page: Page,
  guard: () => void,
  allowDismiss: boolean,
  onDismissed?: () => void,
) {
  let state = await readGroupInvitationState(page, guard);
  if (state.verificationRequired && allowDismiss) {
    if (await dismissFeatureInterventionDialogIfPresent(page, guard)) onDismissed?.();
    state = await readGroupInvitationState(page, guard);
  }
  if (state.verificationRequired) throw inviterVerificationError();
  return state;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class GroupInviterBrowserAdapter implements GroupInviterBrowserRunner {
  private readonly selectingByGroup = new Map<string, Set<string>>();
  private readonly scopes = new WeakMap<InviterConnection, InviterScope>();
  private readonly stopping = new Map<string, InviterPendingStop>();
  constructor(
    private readonly repo: GroupInviterRepository,
    private readonly getKernel: () => KernelBridge | undefined,
    private readonly getCore: () => Core | undefined,
    private readonly checkProfileBusy?: (profileId: string) => Awaitable<boolean>,
    private onAccountAbnormal?: GlobalAccountAbnormalReporter,
  ) {}
  private releaseSelections(groupId: string, owned: Set<string>) {
    const selecting = this.selectingByGroup.get(groupId);
    for (const id of owned) selecting?.delete(id);
    owned.clear();
    if (selecting?.size === 0) this.selectingByGroup.delete(groupId);
  }
  private async selectRecipient(
    groupId: string,
    friendId: string,
    owned: Set<string>,
    click: () => Promise<boolean>,
  ): Promise<boolean> {
    let selecting = this.selectingByGroup.get(groupId);
    if (selecting?.has(friendId)) return false;
    if (!selecting) this.selectingByGroup.set(groupId, (selecting = new Set()));
    selecting.add(friendId);
    owned.add(friendId);
    let checked = false;
    try {
      // Hold memory claim across fresh DB read to prevent races across accounts.
      if (!(await this.repo.getInvitedFriendIdsForGroup(groupId)).has(friendId))
        checked = await click();
      return checked;
    } finally {
      if (!checked) {
        selecting.delete(friendId);
        owned.delete(friendId);
        if (selecting.size === 0) this.selectingByGroup.delete(groupId);
      }
    }
  }
  async retryStop(profileId: string) {
    await retryInviterStop({
      profileId,
      stopping: this.stopping,
      kernel: this.getKernel(),
      core: this.getCore(),
    });
  }
  isAvailable(): boolean {
    return Boolean(this.getKernel() && this.getCore());
  }
  isProfileReady(profileId: string): boolean {
    const peer = this.getCore()?.peers.get(profileId);
    return Boolean(peer && peer.online && peer.synced);
  }
  async isProfileBusy(profileId: string): Promise<boolean> {
    return (await this.checkProfileBusy?.(profileId)) === true;
  }
  private async execBoundOp<T>(
    conn: InviterConnection,
    accountId: string,
    label: string,
    fn: (operationId: string) => Promise<T>,
    persist?: (value: T, operationId: string) => Promise<void>,
    prepare?: (operationId: string) => Promise<void>,
  ): Promise<T> {
    const scope = this.scopes.get(conn);
    if (!scope) throw Error('GROUP_INVITER_SCOPE_REQUIRED');
    scope.guard();
    const ctx = await conn.context(accountId);
    if (!ctx) throw Error('KERNEL_CONTEXT_UNAVAILABLE');
    const operationId = randomUUID();
    const binding = {
      ...ctx,
      operationId,
      jobId: scope.jobId,
      stepId: scope.stepId,
      actionDigest: invitationDigest(label, accountId, operationId),
    };
    let interventionDismissedInOp = false;
    const backgroundAllowed = scope.backgroundAllowed === true || conn.taskRendering === true;
    const readVerifiedState = (allowDismiss: boolean) =>
      readVerifiedInviteState(scope.page, scope.guard, allowDismiss, () => {
        interventionDismissedInOp = true;
      });
    const assertPage = async () => {
      scope.guard();
      let state = await readVerifiedState(label !== 'send-group-invites');
      const deadline = Date.now() + 15000;
      let activated = false;
      while (!state.ready || (!state.visible && !(backgroundAllowed && activated))) {
        scope.guard();
        if (!state.visible && !activated) {
          activated = true;
          await scope.activate?.();
        }
        if (Date.now() >= deadline)
          failError(
            'GROUP_INVITER_PAGE_NOT_READY',
            state.visible
              ? 'Facebook 页面加载超时，未继续邀请'
              : 'Facebook 任务页仍不可见，请让浏览器露出页面区域后重试',
            409,
          );
        await sleep(250);
        state = await readVerifiedState(label !== 'send-group-invites');
      }
      scope.guard();
      if (state.accountId !== accountId)
        failError(
          'GROUP_INVITER_ACCOUNT_CHANGED',
          '当前登录账号已变化，已停止本次邀请；请检查浏览器中的实际账号',
          409,
        );
      if (
        label !== 'enter-group' &&
        !(label === 'join-group' && interventionDismissedInOp) &&
        !isGroupRouteUrl(state.url, scope.groupId)
      )
        throw Error('GROUP_INVITER_CURRENT_GROUP_CHANGED');
    };
    const navigationError = (error: unknown): never => {
      if (label === 'enter-group')
        throw Error(
          'GROUP_INVITER_NAVIGATION_FAILED:' +
            (error instanceof Error ? error.message : String(error)),
        );
      throw error;
    };
    const fence = async () => {
      try {
        await assertPage();
      } catch (error) {
        navigationError(error);
      }
    };
    await fence();
    await prepare?.(binding.operationId);
    if (label !== 'send-group-invites') scope.pendingSetup.set(operationId, binding);
    const res = await conn.execute(
      binding,
      async () => {
        try {
          const val = await fn(binding.operationId);
          if (
            val &&
            typeof val === 'object' &&
            'unjoinableIntervention' in val &&
            (val as { unjoinableIntervention?: boolean }).unjoinableIntervention === true
          )
            interventionDismissedInOp = true;
          return val;
        } catch (error) {
          return navigationError(error);
        }
      },
      fence,
      async () => {
        await conn.close(scope.stopId);
      },
    );
    if (
      label === 'send-group-invites' &&
      res.value &&
      typeof res.value === 'object' &&
      'submitted' in res.value &&
      res.value.submitted === true
    ) {
      const result = res.value as T & InvitationSubmission;
      if (result.pending === 0)
        await conn.reconcile(binding, {
          id: randomUUID(),
          outcome: 'VERIFIED',
          evidenceDigest: createHash('sha256')
            .update(JSON.stringify({ binding, result }))
            .digest('hex'),
        });
      else scope.pendingSubmission = binding;
      return res.value;
    }
    let observed: Awaited<ReturnType<typeof readGroupInvitationState>> | undefined;
    const sending = label === 'send-group-invites';
    let resultTimeOrigin: number | undefined;
    const confirmed = new Map<
      string,
      Awaited<ReturnType<typeof readGroupInvitationState>>['items'][number]
    >();
    const deadline = Date.now() + (sending ? 20000 : label === 'enter-group' ? 30000 : 15000);
    do {
      scope.guard();
      const state = await readVerifiedState(!sending);
      if (sending) {
        if (
          (resultTimeOrigin !== undefined && state.timeOrigin !== resultTimeOrigin) ||
          !state.ready ||
          (!state.visible && !backgroundAllowed) ||
          state.accountId !== accountId ||
          !isGroupRouteUrl(state.url, scope.groupId)
        )
          failError(
            'GROUP_INVITER_RESULT_CONTEXT_CHANGED',
            '邀请结果核对时账号、小组或可见状态发生变化，未自动重发',
            409,
          );
        resultTimeOrigin ??= state.timeOrigin;
        for (const item of [...state.items, ...(state.recipients ?? [])])
          if (item.id && item.invited) confirmed.set(item.id, item);
      }
      const evidence = sending ? { ...state, items: [...confirmed.values()] } : state;
      if (label === 'enter-group' && !/^\d+$/.test(scope.groupId)) {
        try {
          const currentUrl = new URL(evidence.url);
          const candidateId = currentUrl.pathname.split('/')[2] ?? '';
          if (
            currentUrl.origin === 'https://www.facebook.com' &&
            currentUrl.pathname.split('/')[1] === 'groups' &&
            /^\d{5,25}$/.test(candidateId)
          )
            scope.groupId = candidateId;
        } catch {}
      }
      if (
        groupInvitationEffect(
          label,
          evidence,
          scope.groupId,
          accountId,
          res.value,
          backgroundAllowed,
        )
      ) {
        observed = evidence;
        break;
      }
      if (sending && state.dialog) {
        scope.guard();
        await scope.page.evaluate((selector) => {
          const dialog = document.querySelector(selector);
          if (!dialog) return;
          const scroller = Array.from(dialog.querySelectorAll('div')).find((el) => {
            const style = getComputedStyle(el);
            return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
          });
          if (scroller) scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.75);
        }, inviteDialogSelector);
      }
      await sleep(250);
    } while (Date.now() < deadline);
    if (!observed && label === 'enter-group')
      throw Error('GROUP_INVITER_NAVIGATION_FAILED:小组页面未能在期限内完成加载');
    if (!observed) {
      devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_EFFECT_MISSING', {
        profileId: binding.profileId,
        operationId: binding.operationId,
        data: { label, dialogs: await readInvitationDialogDebugInfo(scope.page) },
      });
      failError(
        'GROUP_INVITER_EFFECT_UNCONFIRMED',
        `${sending ? '邀请结果' : '页面操作结果'}未确认，已停止；不会自动重复发送`,
        409,
      );
    }
    await persist?.(res.value, binding.operationId);
    await conn.reconcile(binding, {
      id: randomUUID(),
      outcome: 'VERIFIED',
      evidenceDigest: createHash('sha256')
        .update(JSON.stringify({ binding, label, observed, value: res.value }))
        .digest('hex'),
    });
    scope.pendingSetup.delete(operationId);
    return res.value;
  }
  async inviteForGroup(
    profileId: string,
    group: InviterGroupRow,
    invitesPerGroup: number,
    callbacks: GroupInviterRunCallbacks,
  ): Promise<void> {
    const kernel = this.getKernel();
    const core = this.getCore();
    const peer = core?.peers.get(profileId);
    if (
      !kernel ||
      !peer ||
      (await this.isProfileBusy(profileId)) ||
      callbacks.isCancelled(profileId)
    )
      return;
    const epoch = peer.epoch;
    const guard = () => {
      if (callbacks.isCancelled(profileId)) throw Error('GROUP_INVITER_CANCELLED');
      if (
        core?.peers.get(profileId) !== peer ||
        peer.epoch !== epoch ||
        !peer.online ||
        !peer.synced
      )
        throw Error('GROUP_INVITER_CONNECTION_CHANGED');
    };
    guard();
    await callbacks.setProfileStatus(profileId, `正在连接 · ${group.groupName.slice(0, 12)}`);
    let prepared: Awaited<ReturnType<typeof prepareFacebookWorkspace>>;
    try {
      prepared = await prepareFacebookWorkspace(kernel, peer, undefined, guard, undefined, true);
    } catch (prepErr) {
      if (!FacebookGroupSessionHelper.isTransientPrepareError(prepErr)) throw prepErr;
      await sleep(500);
      guard();
      prepared = await prepareFacebookWorkspace(kernel, peer, undefined, guard, undefined, true);
    }
    guard();
    if (prepared.inventory.operations.some(kernelOperationPending))
      failError(
        'GROUP_INVITER_PRIOR_RESULT_UNCONFIRMED',
        '该浏览器有待核对操作，请先处理原记录；未改写原结果、未发送新邀请',
        409,
      );
    await callbacks.setProfileStatus(profileId, '打开首页 · 读取当前登录账号');
    await FacebookGroupSessionHelper.waitPeerPaused(peer, guard, 10_000);
    const identity =
      (await kernel.inspectIdleFacebookPage(peer, guard, false, true)) ??
      (await kernel.inspectFacebookIdentity(
        peer,
        guard,
        true,
        prepared.proof ?? undefined,
        true,
        false,
        true,
      ));
    guard();
    const boundAccountId = identity.actor.accountId;
    const proof = identity.proof;
    if (!proof) throw Error('GROUP_INVITER_TASK_TAB_REQUIRED');
    const conn = await kernel.connectFacebook(peer, boundAccountId, guard, proof);
    const stopRequestId = conn.stopRequestId ?? randomUUID();
    const selectedInMemory = new Set<string>();
    let effectiveGroupId = group.groupId;
    try {
      const page = conn.browser.contexts()[0]?.pages()[0];
      if (!page) throw Error('BROWSER_PAGE_MISSING');
      await kernel.observeExternalPageAccount?.(profileId, page, identity.actor)?.catch(() => {});
      const scopeRef: InviterScope = {
        guard,
        activate: async () => {
          guard();
          const result = await kernel.revealOwnedFacebookPage(peer, proof, false);
          guard();
          return result;
        },
        backgroundAllowed:
          peer.capabilities?.includes('kernel-background-presentation-v1') === true ||
          conn.taskRendering === true,
        page,
        groupId: effectiveGroupId,
        jobId: randomUUID(),
        stepId: randomUUID(),
        stopId: stopRequestId,
        pendingSetup: new Map(),
      };
      this.scopes.set(conn, scopeRef);
      const atGroup = () => isGroupRouteUrl(page.url(), effectiveGroupId, scopeRef.groupId);
      if (callbacks.isCancelled(profileId)) return;
      if (!atGroup()) {
        await callbacks.setProfileStatus(profileId, `打开小组 · ${group.groupName.slice(0, 12)}`);
        await this.execBoundOp(conn, boundAccountId, 'enter-group', async () => {
          await page.goto(`https://www.facebook.com/groups/${encodeURIComponent(group.groupId)}/`, {
            waitUntil: 'commit',
            timeout: 30000,
          });
        });
      }
      const pageMeta = await readGroupCoverAndTitle(page);
      const coverSrc =
        typeof pageMeta === 'string'
          ? pageMeta
          : pageMeta && typeof pageMeta === 'object'
            ? pageMeta.coverSrc
            : null;
      const groupTitle = pageMeta && typeof pageMeta === 'object' ? pageMeta.groupTitle : null;
      const rawAvatarCandidate = coverSrc?.startsWith('https://') ? coverSrc : null;
      const localizedCover = rawAvatarCandidate
        ? isLocalAvatar(group.avatarUrl)
          ? group.avatarUrl
          : ((await fetchAndLocalizeAvatar(rawAvatarCandidate).catch(() => null)) ??
            rawAvatarCandidate)
        : null;
      const redirectResolution = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
        currentUrl: page.url(),
        rawGroupId: group.groupId,
        groupName: groupTitle,
        avatarUrl: localizedCover,
        applyResolvedMetadata: async (rawId, resolved) => {
          if (this.repo.applyResolvedGroupMetadata)
            await this.repo.applyResolvedGroupMetadata(rawId, resolved);
        },
      });
      effectiveGroupId = redirectResolution.effectiveGroupId;
      scopeRef.groupId = effectiveGroupId;
      if (callbacks.isCancelled(profileId)) return;
      const readVerified = () => readVerifiedInviteState(page, guard, true);
      const inviteButton = async () => {
        const state = await readVerified();
        const marked = page.locator('[data-wb-group-invite-btn="1"]').first();
        if (await marked.count()) return marked;
        return state.inviteButtonIndex === undefined
          ? null
          : page.locator('[role="button"],button').nth(state.inviteButtonIndex);
      };
      const clickControl = async (button: Locator, validate?: () => Promise<boolean>) => {
        guard();
        await clickInvitationControl(button, async () => {
          guard();
          const current = await readVerified();
          if (!atGroup() || current.accountId !== boundAccountId)
            throw Error('GROUP_INVITER_CURRENT_GROUP_CHANGED');
          if (validate && !(await validate())) return false;
          guard();
          return true;
        });
      };
      const flowCtx: InviterFlowCtx = {
        profileId,
        group,
        page,
        conn,
        boundAccountId,
        guard,
        atGroup,
        inviteButton,
        clickControl,
        execBoundOp: this.execBoundOp.bind(this),
        callbacks,
      };
      await ensureGroupReadyAndJoin(flowCtx);
      await runInviteBatchAndSubmit(flowCtx, {
        effectiveGroupId,
        invitesPerGroup,
        scopeRef,
        scopes: this.scopes,
        selectedInMemory,
        selectingByGroup: this.selectingByGroup,
        repo: this.repo,
        selectRecipient: this.selectRecipient.bind(this),
        releaseSelections: this.releaseSelections.bind(this),
      });
    } catch (runErr) {
      await reportGlobalRouteAbnormalIfNeeded({
        profileId,
        page: conn.browser.contexts()[0]?.pages()[0],
        kernel,
        onAccountAbnormal: this.onAccountAbnormal,
        error: runErr,
      });
      throw runErr;
    } finally {
      this.releaseSelections(effectiveGroupId, selectedInMemory);
      await finalizeInviterConnection({
        profileId,
        conn,
        peer,
        kernel,
        stopRequestId,
        boundAccountId,
        scopes: this.scopes,
        stopping: this.stopping,
      });
    }
  }
}
