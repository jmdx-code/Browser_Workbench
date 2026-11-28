import type { Locator } from 'playwright-core';
import type { GroupInviterRepository } from '../../application/group-inviter-service.js';
import { ProductError, failError } from '../../domain/workspace.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { dismissUnexpectedFacebookOverlays } from '../facebook-overlay-dismisser.js';
import { invitationDigest } from '../facebook-workspace-preparation.js';
import {
  dismissFeatureInterventionDialogIfPresent,
  inviteDialogSelector,
  readGroupInvitationState,
  type GroupInvitationState,
  type InvitationMenuItem,
} from '../group-inviter-effects.js';
import type {
  InviterConnection,
  InviterFlowCtx,
  InviterScope,
  InvitationSubmission,
} from './inviter-ops.js';
import {
  checkGroupPendingOrQuestions,
  collectInvitationConfirmations,
  invitationResultStatus,
  inviterVerificationError,
  markNonInvitePopupCloseButton,
  mountedInvitationSelectionMatches,
  observeInvitationGraphQL,
  readGroupReadyDebugControls,
  revealInvitationControl,
  scrollInvitationList,
  settleInvitationConfirmation,
} from './inviter-ops.js';
const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function ensureGroupReadyAndJoin(ctx: InviterFlowCtx): Promise<void> {
  const {
    profileId,
    group,
    page,
    conn,
    boundAccountId,
    guard,
    atGroup,
    inviteButton,
    clickControl,
    execBoundOp,
    callbacks,
  } = ctx;
  const joinBtnLoc = page.locator('[data-wb-group-join-btn="1"]').first();
  const dismissNonInvitePopupIfNeeded = async () => {
    if (!(await markNonInvitePopupCloseButton(page))) return;
    await execBoundOp(conn, boundAccountId, 'close-join-popup', async () => {
      if (!(await markNonInvitePopupCloseButton(page))) return;
      const closeBtn = page.locator('[data-wb-non-invite-close-btn="1"]').first();
      await clickControl(closeBtn, async () => await markNonInvitePopupCloseButton(page));
    });
  };
  const revealIfAttached = async (loc: Locator | null): Promise<boolean> => {
    if (!loc) return false;
    if ((await loc.count().catch(() => 0)) === 0) return false;
    await revealInvitationControl(loc, 0).catch(() => {});
    return loc.isVisible().catch(() => false);
  };
  const hasEntry = async () =>
    (await revealIfAttached(await inviteButton())) || (await revealIfAttached(joinBtnLoc));
  // The URL can arrive before React mounts the group's actions, or narrow windows can push them below fold.
  const groupReadyDeadline = Date.now() + 15000;
  let scrollSweepStep = 0;
  let lastScrollAt = Date.now();
  while (!(await hasEntry())) {
    guard();
    if (!atGroup())
      throw new ProductError('GROUP_INVITER_GROUP_CHANGED', '小组页面已跳转，未继续邀请', 409);
    if (await checkGroupPendingOrQuestions(page))
      failError(
        'GROUP_INVITER_GROUP_UNINVITABLE',
        `跳过：该群需管理员审核或回答入群问题 · ${group.groupName.slice(0, 10)}`,
        409,
      );
    await dismissNonInvitePopupIfNeeded();
    await dismissUnexpectedFacebookOverlays(page, { keepSelector: '[role="checkbox"]' });
    if (await hasEntry()) break;
    if (Date.now() - lastScrollAt >= 2000) {
      await page
        .evaluate(
          (down) => (down ? window.scrollBy(0, 300) : window.scrollTo(0, 0)),
          scrollSweepStep < 3,
        )
        .catch(() => {});
      scrollSweepStep = (scrollSweepStep + 1) % 4;
      lastScrollAt = Date.now();
      if (await hasEntry()) break;
    }
    if (Date.now() >= groupReadyDeadline) {
      devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_GROUP_CONTROLS_MISSING', {
        profileId,
        data: await readGroupReadyDebugControls(page),
      });
      failError(
        'GROUP_INVITER_GROUP_NOT_READY',
        '小组页面未出现加入或邀请入口，请检查加载状态和访问权限',
        409,
      );
    }
    await sleep(250);
  }
  guard();
  if (!(await inviteButton()) && (await joinBtnLoc.count()) > 0) {
    await callbacks.setProfileStatus(profileId, `加入小组 · ${group.groupName.slice(0, 12)}`);
    const joinRes = await execBoundOp(conn, boundAccountId, 'join-group', async () => {
      let joinInterventionDismissed = false;
      try {
        await clickControl(
          joinBtnLoc,
          async () => !(await inviteButton()) && (await joinBtnLoc.isVisible()),
        );
      } catch (clickErr) {
        if (clickErr instanceof Error && clickErr.message === 'GROUP_INVITER_CURRENT_GROUP_CHANGED')
          return { unjoinableIntervention: true };
        throw clickErr;
      }
      const joinClickAt = Date.now();
      const deadline = joinClickAt + 4000;
      do {
        guard();
        const state = await readGroupInvitationState(page, guard);
        if (state.verificationRequired) {
          await dismissFeatureInterventionDialogIfPresent(page, guard);
          joinInterventionDismissed = true;
          return { unjoinableIntervention: true };
        }
        if (!atGroup()) return { unjoinableIntervention: true };
        if (
          Boolean(await inviteButton()) ||
          state.dialogCount > 0 ||
          (Date.now() - joinClickAt >= 1500 && !(await joinBtnLoc.isVisible()))
        )
          break;
        await sleep(250);
      } while (Date.now() < deadline);
      return joinInterventionDismissed
        ? { unjoinableIntervention: true }
        : { joinedOrRequested: true };
    });
    if (
      joinRes &&
      typeof joinRes === 'object' &&
      'unjoinableIntervention' in joinRes &&
      (joinRes as { unjoinableIntervention?: boolean }).unjoinableIntervention
    ) {
      failError(
        'GROUP_INVITER_GROUP_UNINVITABLE',
        `跳过：当前身份暂不支持直接加入该群 · ${group.groupName.slice(0, 10)}`,
        409,
      );
    }
    await dismissNonInvitePopupIfNeeded();
  }
  if (!(await inviteButton())) {
    failError(
      'GROUP_INVITER_GROUP_UNINVITABLE',
      `小组待审核或不可邀请 · ${group.groupName.slice(0, 10)}`,
      409,
    );
  }
}
export async function runInviteBatchAndSubmit(
  ctx: InviterFlowCtx,
  extra: {
    effectiveGroupId: string;
    invitesPerGroup: number;
    scopeRef: InviterScope;
    scopes: WeakMap<InviterConnection, InviterScope>;
    selectedInMemory: Set<string>;
    selectingByGroup: Map<string, Set<string>>;
    repo: GroupInviterRepository;
    selectRecipient: (
      groupId: string,
      friendId: string,
      owned: Set<string>,
      click: () => Promise<boolean>,
    ) => Promise<boolean>;
    releaseSelections: (groupId: string, owned: Set<string>) => void;
  },
): Promise<void> {
  const {
    profileId,
    group,
    page,
    conn,
    boundAccountId,
    guard,
    atGroup,
    inviteButton,
    clickControl,
    execBoundOp,
    callbacks,
  } = ctx;
  const {
    effectiveGroupId,
    invitesPerGroup,
    scopeRef,
    scopes,
    selectedInMemory,
    selectingByGroup,
    repo,
    selectRecipient,
    releaseSelections,
  } = extra;
  const effectiveAccountId = boundAccountId;
  let menuEntry: InvitationMenuItem | undefined;
  const dialogLocator = (state: GroupInvitationState) => {
    if (!state.dialog || state.dialogIndex === undefined)
      throw Error('GROUP_INVITER_DIALOG_REQUIRED');
    return state.dialogLabel
      ? page.getByRole('dialog', { name: state.dialogLabel, exact: true })
      : page.locator(inviteDialogSelector).nth(state.dialogIndex);
  };
  const openDialog = async (bound: boolean) => {
    let state = await readGroupInvitationState(page, guard);
    if (state.dialog && state.sendButton && state.items.length) return state;
    const click = async () => {
      const button = await inviteButton();
      if (!button) throw Error('GROUP_INVITER_INVITE_ENTRY_REQUIRED');
      await clickControl(button, async () => !(await readGroupInvitationState(page, guard)).dialog);
    };
    if (!state.dialog) {
      if (bound) await execBoundOp(conn, boundAccountId, 'open-invite-modal', click);
      else await click();
    }
    const deadline = Date.now() + 15000;
    do {
      guard();
      state = await readGroupInvitationState(page, guard);
      if (state.verificationRequired) throw inviterVerificationError();
      if (state.dialog && state.sendButton && state.items.length) return state;
      if (state.menu) {
        const entries = state.menuItems ?? [];
        const prev = menuEntry;
        const matches = prev ? entries.filter((e) => e.fingerprint === prev.fingerprint) : [];
        const entry = prev
          ? matches.length === 1
            ? matches[0]
            : entries.find((e) => e.index === prev.index && e.fingerprint === prev.fingerprint)
          : (entries.find((e) => e.preferred) ?? entries[0]);
        if (!entry) throw Error('GROUP_INVITER_INVITE_MENU_CHANGED');
        menuEntry = entry;
        const choose = async () => {
          const marked = page
            .locator('[role="menuitem"][data-wb-group-invite-menuitem="1"]')
            .first();
          const button =
            entry.preferred && (await marked.count())
              ? marked
              : page.locator('[role="menuitem"]').filter({ visible: true }).nth(entry.index);
          await clickControl(button, async () => {
            const current = await readGroupInvitationState(page, guard);
            if (current.dialog) return false;
            if (current.menuItems?.[entry.index]?.fingerprint !== entry.fingerprint)
              throw Error('GROUP_INVITER_INVITE_MENU_CHANGED');
            return true;
          });
        };
        if (bound) await execBoundOp(conn, boundAccountId, 'click-invite-menuitem', choose);
        else await choose();
      }
      await sleep(250);
    } while (Date.now() < deadline);
    if (state.dialog && state.sendButton) return state;
    if (bound)
      failError('GROUP_INVITER_INVITE_MODAL_UNAVAILABLE', '跳过：邀请列表未能打开，未发送', 409);
    failError(
      'GROUP_INVITER_RESULT_DIALOG_REQUIRED',
      '邀请列表未能打开，已保留待核对记录，未重发',
      409,
    );
  };
  await callbacks.setProfileStatus(profileId, `打开邀请弹窗 · ${group.groupName.slice(0, 10)}`);
  await openDialog(true);
  const alreadyInvitedIds = await repo.getInvitedFriendIdsForGroup(effectiveGroupId);
  const seenInModal = new Set<string>();
  const selectedBatch: Array<{ friendId: string; friendName: string }> = [];
  const alreadyInvitedSkippedSet = new Set<string>();
  const memberOrInvitedSkippedSet = new Set<string>();
  let stagnantScrolls = 0;
  let unscrolledStreak = 0;
  let lastCheckboxTotal = 0;
  let lastSignature = '';
  let lastItemsCount = 0;
  let lastValidIdCount = 0;
  while (selectedBatch.length < invitesPerGroup && !callbacks.isCancelled(profileId)) {
    const reading = await readGroupInvitationState(page, guard);
    guard();
    if (!reading.dialog) break;
    lastItemsCount = reading.items.length;
    lastValidIdCount = 0;
    for (const row of reading.items) {
      if (row.id && row.name) lastValidIdCount++;
      if (row.id) {
        if (row.invited || row.member || row.disabled) memberOrInvitedSkippedSet.add(row.id);
        else if (alreadyInvitedIds.has(row.id)) alreadyInvitedSkippedSet.add(row.id);
      }
    }
    const currentSignature = reading.items
      .map((i) => `${i.id ?? ''}:${i.checked ? 1 : 0}`)
      .join('|');
    const index = reading.items.findIndex(
      (item) =>
        item.id &&
        item.name &&
        !item.checked &&
        !item.invited &&
        !item.member &&
        !item.disabled &&
        !alreadyInvitedIds.has(item.id) &&
        !selectingByGroup.get(effectiveGroupId)?.has(item.id) &&
        !seenInModal.has(item.id),
    );
    const item = reading.items[index];
    const candidate = {
      index,
      friendId: item?.id ?? '',
      friendName: item?.name ?? '',
      totalCheckboxes: reading.items.length,
    };
    if (candidate.index >= 0) {
      stagnantScrolls = 0;
      unscrolledStreak = 0;
      seenInModal.add(candidate.friendId);
      const checkedNow = await selectRecipient(
        effectiveGroupId,
        candidate.friendId,
        selectedInMemory,
        async () =>
          Boolean(
            await execBoundOp(
              conn,
              boundAccountId,
              `check-friend-${selectedBatch.length + 1}`,
              async () => {
                const state = await readGroupInvitationState(page, guard);
                if (
                  !state.items.some((r) => r.id === candidate.friendId) ||
                  state.items.find((r) => r.id === candidate.friendId)?.checked
                )
                  throw Error('GROUP_INVITER_RECIPIENT_CHANGED');
                const marked = dialogLocator(state)
                  .locator(`[role="checkbox"][data-wb-recipient-id="${candidate.friendId}"]`)
                  .first();
                const cbLoc = (await marked.count())
                  ? marked
                  : dialogLocator(state).locator('[role="checkbox"]').nth(candidate.index);
                await clickControl(cbLoc, async () => {
                  const current = await readGroupInvitationState(page, guard);
                  if (!current.items.some((r) => r.id === candidate.friendId))
                    throw Error('GROUP_INVITER_RECIPIENT_CHANGED');
                  return !current.items.find((r) => r.id === candidate.friendId)?.checked;
                });
                if (await cbLoc.evaluate((el) => el.getAttribute('aria-checked') === 'true'))
                  return candidate.friendId;
                await sleep(150);
                return (await cbLoc.evaluate((el) => el.getAttribute('aria-checked') === 'true'))
                  ? candidate.friendId
                  : '';
              },
            ),
          ),
      );
      if (checkedNow) {
        selectedBatch.push({ friendId: candidate.friendId, friendName: candidate.friendName });
        alreadyInvitedIds.add(candidate.friendId);
        await callbacks.setProfileStatus(
          profileId,
          `已选 ${selectedBatch.length}/${invitesPerGroup} 人 · ${group.groupName.slice(0, 10)}`,
        );
      }
      await sleep(randInt(250, 500));
    } else {
      if (
        lastSignature !== '' &&
        (currentSignature !== lastSignature || candidate.totalCheckboxes > lastCheckboxTotal)
      ) {
        stagnantScrolls = 0;
        unscrolledStreak = 0;
      } else stagnantScrolls++;
      lastSignature = currentSignature;
      lastCheckboxTotal = Math.max(lastCheckboxTotal, candidate.totalCheckboxes);
      if (stagnantScrolls >= 8) break;
      guard();
      if (!(await scrollInvitationList(page, reading))) {
        unscrolledStreak++;
        if (unscrolledStreak >= 2) break;
      } else unscrolledStreak = 0;
      await sleep(700);
    }
  }
  if (selectedBatch.length === 0 && !callbacks.isCancelled(profileId)) {
    devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_NO_CANDIDATE_BREAKDOWN', {
      profileId,
      reason: `groupId=${group.groupId}`,
      data: {
        groupId: group.groupId,
        itemsCount: lastItemsCount,
        validIdCount: lastValidIdCount,
        alreadyInvitedSkipped: alreadyInvitedSkippedSet.size,
        memberOrInvitedSkipped: memberOrInvitedSkippedSet.size,
        stagnantScrolls,
      },
    });
  }
  let submission: InvitationSubmission | undefined;
  if (selectedBatch.length > 0 && !callbacks.isCancelled(profileId)) {
    const selectedIds = selectedBatch.map((f) => f.friendId);
    const confirmed = new Set<string>();
    const awaitSendButtonReady = async (
      operationId: string,
      waitMs: number,
      verifySelection: boolean,
    ) => {
      let state = await readGroupInvitationState(page, guard);
      if (verifySelection && !mountedInvitationSelectionMatches(state, selectedIds))
        throw Error('GROUP_INVITER_SELECTION_CHANGED');
      const deadline = Date.now() + waitMs;
      while ((!state.sendButton || state.sendButton.disabled) && Date.now() < deadline) {
        await sleep(250);
        guard();
        state = await readGroupInvitationState(page, guard);
        if (verifySelection && !mountedInvitationSelectionMatches(state, selectedIds))
          throw Error('GROUP_INVITER_SELECTION_CHANGED');
      }
      if (!state.sendButton || state.sendButton.disabled) {
        devDiag.emit('WARN', 'GROUP_INVITER', 'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE', {
          profileId,
          operationId,
          data: {
            groupId: effectiveGroupId,
            hasDialog: state.dialog,
            hasSendButton: Boolean(state.sendButton),
            sendDisabled: state.sendButton?.disabled ?? null,
            selectedCount: selectedIds.length,
            checkedItemsCount: state.items.filter((i) => i.checked).length,
          },
        });
        failError('GROUP_INVITER_SEND_BUTTON_UNAVAILABLE', '跳过：邀请发送按钮不可用，未发送', 409);
      }
      return state;
    };
    await awaitSendButtonReady('pre-send-check', 3500, false);
    let reservedOpId: string | null = null;
    let dispatchAttempted = false;
    let graphqlDispatched = false;
    let sent: Awaited<ReturnType<typeof execBoundOp<InvitationSubmission>>>;
    try {
      sent = await execBoundOp(
        conn,
        boundAccountId,
        'send-group-invites',
        async (operationId) => {
          const before = await awaitSendButtonReady(operationId, 1500, true);
          if (!before.sendButton) throw Error('GROUP_INVITER_SEND_BUTTON_UNAVAILABLE');
          const observation = observeInvitationGraphQL(
            page,
            profileId,
            operationId,
            effectiveGroupId,
            selectedIds,
            boundAccountId,
          );
          try {
            try {
              const ctx = await conn.context(boundAccountId);
              const scope = scopes.get(conn);
              if (!scope) throw Error('GROUP_INVITER_SCOPE_REQUIRED');
              if (ctx)
                await conn.enablePostNetworkObservation(
                  {
                    ...ctx,
                    operationId,
                    jobId: scope.jobId,
                    stepId: scope.stepId,
                    actionDigest: invitationDigest(
                      'send-group-invites',
                      boundAccountId,
                      operationId,
                    ),
                  },
                  guard,
                );
            } catch (e) {
              devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_NETWORK_OBSERVER_UNAVAILABLE', {
                profileId,
                operationId,
                reason: e instanceof Error ? e.message.slice(0, 160) : 'UNAVAILABLE',
              });
            }
            await callbacks.setProfileStatus(profileId, `发送 ${selectedBatch.length} 份邀请`);
            const markedSend = dialogLocator(before)
              .locator('[data-wb-group-send-btn="1"]')
              .first();
            const sendButton = (await markedSend.count())
              ? markedSend
              : dialogLocator(before)
                  .locator('[role="button"],button')
                  .nth(before.sendButton.index);
            await revealInvitationControl(sendButton, 0).catch(() => {});
            await sleep(120);
            const clickBlockedRe = /timeout|intercept|outside.*viewport|obscures|not visible/i;
            try {
              await sendButton.click({ timeout: 5000 });
              dispatchAttempted = true;
            } catch (clickErr) {
              if (!(clickErr instanceof Error) || !clickBlockedRe.test(clickErr.message))
                throw clickErr;
              const latest = await readGroupInvitationState(page, guard);
              if (!mountedInvitationSelectionMatches(latest, selectedIds))
                throw Error('GROUP_INVITER_SELECTION_CHANGED');
              await revealInvitationControl(sendButton, 140).catch(() => {});
              await sleep(150);
              try {
                await sendButton.click({ timeout: 4000 });
                dispatchAttempted = true;
              } catch (retryErr) {
                if (!(retryErr instanceof Error) || !clickBlockedRe.test(retryErr.message))
                  throw retryErr;
                failError(
                  'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE',
                  '跳过：邀请发送按钮无法点击，未发送',
                  409,
                );
              }
            }
            const sentAt = Date.now();
            const closedDeadline = sentAt + 6000;
            let closed = false;
            while (Date.now() < closedDeadline) {
              guard();
              const s = await readGroupInvitationState(page, guard);
              if (s.verificationRequired) throw inviterVerificationError();
              if (!s.dialog) {
                closed = true;
                break;
              }
              if (observation.hasSettled() && Date.now() - sentAt >= 800) break;
              await sleep(250);
            }
            observation.endSubmission();
            const persist = async (ids: string[]) => {
              const inserted = await repo.recordInvites(
                selectedBatch
                  .filter((f) => ids.includes(f.friendId))
                  .map((f) => ({
                    profileId,
                    accountId: effectiveAccountId,
                    friendId: f.friendId,
                    friendName: f.friendName,
                    groupId: effectiveGroupId,
                    invitedAt: Date.now(),
                  })),
                operationId,
              );
              await callbacks.addSessionInvited(profileId, inserted);
              const addedCount = ids.filter((id) => !confirmed.has(id)).length;
              await callbacks.setProfileStatus(
                profileId,
                invitationResultStatus(
                  confirmed.size + addedCount,
                  selectedIds.length - confirmed.size - addedCount,
                ),
              );
            };
            const collect = () =>
              collectInvitationConfirmations({
                selectedIds,
                accountId: boundAccountId,
                groupId: effectiveGroupId,
                read: () => readGroupInvitationState(page, guard),
                scroll: (s) => scrollInvitationList(page, s),
                persist,
                confirmed,
                guard,
                budgetMs: 6000,
                allowHidden: scopeRef.backgroundAllowed === true,
              });
            let fallbackReopens = 0;
            const graphqlConfirmed = await settleInvitationConfirmation({
              selectedIds,
              confirmed,
              persist,
              graphql:
                closed || observation.hasSettled() ? observation.confirmations : async () => [],
              assertCurrent: async () => {
                guard();
                const current = await readGroupInvitationState(page, guard);
                if (current.verificationRequired) throw inviterVerificationError();
                if (current.accountId !== boundAccountId || !atGroup())
                  failError(
                    'GROUP_INVITER_RESULT_CONTEXT_CHANGED',
                    '邀请核对页面发生变化，结果仍待确认，未重发',
                    409,
                  );
              },
              fallback: async () => {
                if (observation.hasSettled() && confirmed.size > 0) return;
                if (confirmed.size === 0) {
                  try {
                    fallbackReopens++;
                    await openDialog(false);
                    await collect();
                  } catch (e) {
                    if (
                      e instanceof ProductError &&
                      e.code === 'GROUP_INVITER_VERIFICATION_REQUIRED'
                    )
                      throw e;
                    devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_RESULT_READ_INCOMPLETE', {
                      profileId,
                      operationId,
                      reason: e instanceof Error ? e.message.slice(0, 200) : 'READ_FAILED',
                      data: {
                        confirmed: confirmed.size,
                        pending: selectedIds.length - confirmed.size,
                      },
                    });
                  }
                }
              },
            });
            return {
              submitted: true as const,
              total: selectedIds.length,
              confirmedIds: [...confirmed],
              pending: selectedIds.length - confirmed.size,
              graphqlConfirmed,
              fallbackReopens,
              reloads: 0,
            };
          } finally {
            graphqlDispatched ||= observation.hasDispatched();
            await observation.close();
          }
        },
        undefined,
        async (operationId) => {
          if (!repo.reserveInvites) throw Error('GROUP_INVITER_RESERVATION_REQUIRED');
          reservedOpId = operationId;
          await repo.reserveInvites(
            operationId,
            selectedBatch.map((f) => ({
              ...f,
              profileId,
              accountId: effectiveAccountId,
              groupId: effectiveGroupId,
            })),
          );
          releaseSelections(effectiveGroupId, selectedInMemory);
        },
      );
    } catch (sendErr) {
      if (reservedOpId && !dispatchAttempted && !graphqlDispatched)
        await Promise.resolve(repo.releasePendingInvites?.(reservedOpId)).catch(() => {});
      throw sendErr;
    }
    submission = sent;
    await callbacks.reportBatchResult?.(profileId, sent.confirmedIds.length, sent.pending);
    await callbacks.setProfileStatus(
      profileId,
      invitationResultStatus(sent.confirmedIds.length, sent.pending),
    );
    devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_BATCH_RESULT', {
      profileId,
      data: {
        selected: sent.total,
        confirmed: sent.confirmedIds.length,
        pending: sent.pending,
        submitted: true,
        graphqlConfirmed: sent.graphqlConfirmed ?? 0,
        fallbackReopens: sent.fallbackReopens ?? 0,
        reloads: sent.reloads ?? 0,
      },
    });
  } else if (!callbacks.isCancelled(profileId))
    await callbacks.setProfileStatus(profileId, '无可邀请对象');
  if (!callbacks.isCancelled(profileId) && (!submission || submission.pending === 0)) {
    const state = await readGroupInvitationState(page, guard);
    if (state.dialog && state.closeButton) {
      await execBoundOp(conn, boundAccountId, 'close-invite-modal', async () => {
        const latest = await readGroupInvitationState(page, guard);
        if (!latest.dialog || !latest.closeButton) return;
        const marked = dialogLocator(latest).locator('[data-wb-group-close-btn="1"]').first();
        const button = (await marked.count())
          ? marked
          : dialogLocator(latest).locator('[role="button"],button').nth(latest.closeButton.index);
        await clickControl(
          button,
          async () => (await readGroupInvitationState(page, guard)).dialog,
        );
      });
    }
  }
}
