import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page, Request, Response } from 'playwright-core';
import type { Core } from '../../bridge/core.js';
import { ProductError } from '../../domain/workspace.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { kernelOperationPending } from '../../shared/kernel-state.js';
import type { Binding } from '../../shared/task-execution.js';
import {
  checkGroupPendingOrQuestions,
  parseFacebookJsonChunks,
  stopOwnedConnectionWithReconnect,
} from '../facebook-group-session.js';
import { invitationDigest } from '../facebook-workspace-preparation.js';
import type { GroupInvitationState } from '../group-inviter-effects.js';
import type { KernelBridge, KernelSummaryPort } from '../kernel-bridge.js';
export { checkGroupPendingOrQuestions };
export type InviterConnection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;
export type InviterScope = {
  guard: () => void;
  activate?: () => Promise<unknown>;
  backgroundAllowed?: boolean;
  page: Page;
  groupId: string;
  jobId: string;
  stepId: string;
  stopId: string;
  pendingSubmission?: Binding;
  pendingSetup: Map<string, Binding>;
};
export type InviterPendingStop = {
  connection: InviterConnection;
  requestId: string;
  peerEpoch: string;
  boundAccountId: string;
  pendingSetup: Binding[];
  pendingSubmission?: Binding | undefined;
};
export type InviterFlowCtx = {
  profileId: string;
  group: import('../../shared/group-inviter.js').InviterGroupRow;
  page: Page;
  conn: InviterConnection;
  boundAccountId: string;
  guard: () => void;
  atGroup: () => boolean;
  inviteButton: () => Promise<Locator | null>;
  clickControl: (button: Locator, validate?: () => Promise<boolean>) => Promise<void>;
  execBoundOp: InviterExecBoundOp;
  callbacks: import('../../application/group-inviter-service.js').GroupInviterRunCallbacks;
};
export const inviterVerificationError = () =>
  new ProductError('GROUP_INVITER_VERIFICATION_REQUIRED', '受限 · 需要手机验证或操作受限', 409);
export type InviterExecBoundOp = <T>(
  conn: InviterConnection,
  accountId: string,
  label: string,
  fn: (operationId: string) => Promise<T>,
  persist?: (value: T, operationId: string) => Promise<void>,
  prepare?: (operationId: string) => Promise<void>,
) => Promise<T>;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface InvitationSubmission {
  submitted: true;
  total: number;
  confirmedIds: string[];
  pending: number;
  graphqlConfirmed?: number;
  fallbackReopens?: number;
  reloads?: number;
}
export function confirmedInvitationGraphQL(input: {
  name: string;
  variables: unknown;
  status: number;
  body: string;
  accountId: string;
  groupId: string;
  selectedIds: readonly string[];
}): string[] {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (
    input.name !== 'useGroupAddMembersMutation' ||
    input.status !== 200 ||
    !record(input.variables) ||
    !record(input.variables.input)
  )
    return [];
  const variables = input.variables.input;
  if (variables.actor_id !== input.accountId || variables.group_id !== input.groupId) return [];
  const chunks = parseFacebookJsonChunks(input.body);
  if (!chunks?.length) return [];
  const selected = new Set(input.selectedIds);
  const confirmed = new Set<string>();
  let matched = false;
  for (const root of chunks) {
    if (!record(root)) return [];
    if (root.errors != null && (!Array.isArray(root.errors) || root.errors.length > 0)) return [];
    const payload = record(root.data) ? root.data.group_add_member : undefined;
    if (payload === undefined) continue;
    if (
      !record(payload) ||
      !record(payload.group) ||
      payload.group.id !== input.groupId ||
      payload.user_facing_alert !== null
    )
      return [];
    matched = true;
    for (const key of ['added_users', 'already_invited_users', 'requested_users']) {
      const users = payload[key];
      if (!Array.isArray(users)) continue;
      for (const user of users) {
        if (
          record(user) &&
          typeof user.id === 'string' &&
          /^\d{5,25}$/.test(user.id) &&
          selected.has(user.id)
        ) {
          confirmed.add(user.id);
        }
      }
    }
  }
  return matched ? [...confirmed] : [];
}
export async function settleInvitationConfirmation(input: {
  selectedIds: readonly string[];
  confirmed: Set<string>;
  graphql: () => Promise<string[]>;
  persist: (ids: string[]) => Promise<void>;
  assertCurrent: () => Promise<void>;
  fallback: () => Promise<void>;
}) {
  const selected = new Set(input.selectedIds);
  const credit = async () => {
    const ids = [...new Set(await input.graphql())].filter(
      (id) => selected.has(id) && !input.confirmed.has(id),
    );
    await input.assertCurrent();
    if (ids.length) {
      await input.persist(ids);
      for (const id of ids) input.confirmed.add(id);
    }
    return ids.length;
  };
  let credited = await credit();
  if (input.confirmed.size < selected.size) {
    await input.fallback();
    credited += await credit();
  }
  return credited;
}
export function invitationResultStatus(confirmed: number, pending: number) {
  return pending > 0
    ? confirmed > 0
      ? `已确认 ${confirmed} 人 · ${pending} 人待核对`
      : `邀请已提交 · ${pending} 人待核对`
    : `已确认 ${confirmed} 人`;
}
export function observeInvitationGraphQL(
  page: Page,
  profileId: string,
  operationId: string,
  groupId: string,
  selectedIds: readonly string[],
  accountId: string,
) {
  const requests = new Map<Request, { name: string; variables: unknown; rawVariables: unknown }>();
  const pending = new Set<Promise<void>>();
  const confirmed = new Set<string>();
  let mutationSettled = false;
  let confirmationWaited = false;
  let submitting = true;
  const describe = (value: unknown, depth = 0): unknown => {
    if (value === null) return null;
    if (Array.isArray(value))
      return {
        type: 'array',
        length: value.length,
        sample: value.length ? describe(value[0], depth + 1) : null,
      };
    if (typeof value === 'object' && value) {
      if (depth >= 5) return { keys: Object.keys(value).slice(0, 40) };
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 50)
          .map(([k, v]) => [k, describe(v, depth + 1)]),
      );
    }
    return typeof value === 'boolean' || typeof value === 'number' ? value : typeof value;
  };
  const request = (r: Request) => {
    try {
      if (!submitting || new URL(r.url()).pathname !== '/api/graphql/' || r.method() !== 'POST')
        return;
      const form = new URLSearchParams(r.postData() ?? '');
      const name = form.get('fb_api_req_friendly_name') ?? '';
      const variables = JSON.parse(form.get('variables') ?? '{}');
      const json = JSON.stringify(variables);
      requests.set(r, {
        name,
        rawVariables: variables,
        variables: {
          shape: describe(variables),
          groupMatched: json.includes(groupId),
          selectedIdMatches: selectedIds.filter((id) => json.includes(id)).length,
        },
      });
    } catch {
      /* Diagnostic observation cannot block native input. */
    }
  };
  const response = (r: Response) => {
    const original = requests.get(r.request());
    if (!original) return;
    const work = (async () => {
      try {
        const body = await r.text();
        const ids = confirmedInvitationGraphQL({
          name: original.name,
          variables: original.rawVariables,
          status: r.status(),
          body,
          accountId,
          groupId,
          selectedIds,
        });
        for (const id of ids) confirmed.add(id);
        const chunks = (parseFacebookJsonChunks(body) ?? []).map((chunk) => describe(chunk));
        devDiag.record({
          category: 'GROUP_INVITER',
          event: 'GROUP_INVITER_GRAPHQL_OBSERVATION',
          profileId,
          operationId,
          data: {
            name: original.name,
            variables: original.variables,
            httpStatus: r.status(),
            responseBytes: Buffer.byteLength(body),
            responseShape: chunks.slice(0, 8),
            confirmedSelectedIds: ids.length,
          },
        });
      } catch (e) {
        devDiag.record({
          category: 'GROUP_INVITER',
          event: 'GROUP_INVITER_GRAPHQL_OBSERVATION_FAILED',
          profileId,
          operationId,
          reason: e instanceof Error ? e.message.slice(0, 160) : 'READ_FAILED',
          data: { name: original.name },
        });
      } finally {
        if (original.name === 'useGroupAddMembersMutation') mutationSettled = true;
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  page.on('request', request);
  page.on('response', response);
  return {
    endSubmission: () => {
      submitting = false;
    },
    hasSettled: () => mutationSettled,
    confirmations: async () => {
      if (!confirmationWaited) {
        confirmationWaited = true;
        const deadline = Date.now() + 6000;
        while (!mutationSettled && Date.now() < deadline) await sleep(50);
      }
      return [...confirmed];
    },
    close: async () => {
      page.off('request', request);
      page.off('response', response);
      await Promise.race([Promise.allSettled([...pending]), sleep(1500)]);
    },
  };
}
export async function clickInvitationControl(
  button: Locator,
  validateFallback: () => Promise<boolean>,
) {
  await button.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await sleep(150);
  try {
    await button.click({ timeout: 4000 });
  } catch (error) {
    if (!(error instanceof Error) || !/timeout|intercept|outside.*viewport/i.test(error.message))
      throw error;
    if (!(await validateFallback())) return;
    await button.evaluate((el) => {
      if (
        !(el instanceof HTMLElement) ||
        !el.isConnected ||
        el.getAttribute('aria-disabled') === 'true' ||
        (el instanceof HTMLButtonElement && el.disabled)
      )
        throw Error('GROUP_INVITER_CONTROL_UNAVAILABLE');
      HTMLElement.prototype.click.call(el);
    });
  }
}
export function mountedInvitationSelectionMatches(
  state: GroupInvitationState,
  selectedIds: readonly string[],
) {
  const selected = new Set(selectedIds);
  return state.items.every((item) =>
    item.checked
      ? item.id !== null && selected.has(item.id)
      : item.id === null || !selected.has(item.id),
  );
}
export async function collectInvitationConfirmations(input: {
  selectedIds: readonly string[];
  accountId: string;
  groupId: string;
  read: () => Promise<GroupInvitationState>;
  scroll: (state: GroupInvitationState) => Promise<boolean>;
  persist: (ids: string[]) => Promise<void>;
  confirmed?: Set<string>;
  guard: () => void;
  now?: () => number;
  wait?: () => Promise<void>;
  budgetMs?: number;
  allowHidden?: boolean;
}) {
  const confirmed = input.confirmed ?? new Set<string>();
  const selected = new Set(input.selectedIds);
  const now = input.now ?? Date.now;
  const wait = input.wait ?? (() => sleep(500));
  const deadline = now() + (input.budgetMs ?? 20000);
  let origin: number | undefined;
  let stagnant = 0;
  do {
    input.guard();
    const state = await input.read();
    if (state.verificationRequired) throw inviterVerificationError();
    const url = new URL(state.url);
    origin ??= state.timeOrigin;
    if (
      !state.ready ||
      (!state.visible && !input.allowHidden) ||
      state.accountId !== input.accountId ||
      state.timeOrigin !== origin ||
      url.pathname.split('/')[2] !== input.groupId ||
      url.origin !== 'https://www.facebook.com'
    )
      throw new ProductError(
        'GROUP_INVITER_RESULT_CONTEXT_CHANGED',
        '邀请核对页面发生变化，结果仍待确认，未重发',
        409,
      );
    const found = [...state.items, ...(state.recipients ?? [])]
      .filter((r) => r.id && selected.has(r.id) && !confirmed.has(r.id) && (r.invited || r.member))
      .map((r) => r.id)
      .filter((id): id is string => id !== null);
    const fresh = [...new Set(found)];
    if (fresh.length) {
      await input.persist(fresh);
      for (const id of fresh) confirmed.add(id);
      stagnant = 0;
    }
    if (confirmed.size === selected.size || now() >= deadline) break;
    const moved = await input.scroll(state);
    stagnant = moved || fresh.length ? 0 : stagnant + 1;
    if (stagnant >= 2) break;
    await wait();
  } while (now() < deadline);
  return confirmed;
}
export async function scrollInvitationList(page: Page, state: GroupInvitationState) {
  if (!state.dialog || state.dialogIndex === undefined) return false;
  return page.evaluate((index) => {
    const d = document.querySelectorAll('[role="dialog"]')[index];
    if (!d) return false;
    const scrollable = [d, ...Array.from(d.querySelectorAll('div'))].filter((el) => {
      const s = getComputedStyle(el);
      return (
        (/auto|scroll/.test(s.overflowY) || el.scrollHeight > el.clientHeight + 4) &&
        el.clientHeight > 0 &&
        el.scrollHeight > el.clientHeight
      );
    });
    const withItems = scrollable.filter((el) =>
      Boolean(el.querySelector('[role="checkbox"],[role="listitem"],[role="row"]')),
    );
    const pool = withItems.length > 0 ? withItems : scrollable;
    pool.sort((a, b) => {
      const cbDiff =
        b.querySelectorAll('[role="checkbox"]').length -
        a.querySelectorAll('[role="checkbox"]').length;
      return cbDiff !== 0
        ? cbDiff
        : b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight);
    });
    const scroller = pool[0];
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.75);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return scroller.scrollTop !== before;
  }, state.dialogIndex);
}
export async function readGroupCoverAndTitle(page: Page) {
  return page
    .evaluate(() => {
      const img = document.querySelector(
        'a[aria-label="Cover photo"] img, a[aria-label="封面照片"] img, [role="main"] img[data-imgperflogname="profileCoverPhoto"]',
      );
      const h1 = document.querySelector('main h1, [role="main"] h1')?.textContent?.trim();
      return { coverSrc: img?.getAttribute('src') || null, groupTitle: h1 || null };
    })
    .catch(() => ({ coverSrc: null, groupTitle: null }));
}
export async function findNonInvitePopupCloseCoords(page: Page) {
  return page
    .evaluate(() => {
      const isVis = (el: Element | null) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
        (d) =>
          isVis(d) &&
          !/notifications|通知|messenger|聊天/i.test(d.getAttribute('aria-label') || '') &&
          !d.querySelector('[role="checkbox"]'),
      );
      for (const d of dialogs) {
        const closeBtn = Array.from(
          d.querySelectorAll(
            '[role="button"][aria-label="Close"], [role="button"][aria-label="关闭"], [role="button"][aria-label="關閉"], [data-testid="feature-intervention-ok-button"]',
          ),
        ).find(isVis);
        const continueBtn = Array.from(d.querySelectorAll('[role="button"],button')).find(
          (el) =>
            isVis(el) &&
            /^(?:继续|繼續|Continue|知道了|Got\s*it|确定|確定|OK)$/i.test(
              (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
            ),
        );
        const targetBtn = closeBtn ?? continueBtn;
        if (targetBtn) {
          const r = targetBtn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    })
    .catch(() => null);
}
export async function readGroupReadyDebugControls(page: Page) {
  return page.evaluate(() => ({
    url: location.href,
    ready: document.readyState,
    visibility: document.visibilityState,
    buttons: Array.from(document.querySelectorAll('[role="button"],button'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        );
      })
      .slice(0, 20)
      .map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 80)),
  }));
}
export async function readInvitationDialogDebugInfo(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
      label: d.getAttribute('aria-label'),
      headings: Array.from(d.querySelectorAll('h1,h2,[role="heading"]')).map((h) =>
        h.textContent?.slice(0, 100),
      ),
      buttons: Array.from(d.querySelectorAll('[role="button"],button'))
        .slice(0, 8)
        .map((b) => b.getAttribute('aria-label') ?? b.textContent?.slice(0, 80)),
      checkboxes: d.querySelectorAll('[role="checkbox"]').length,
    })),
  );
}
async function notifyPendingInviterOperations(
  port: KernelSummaryPort,
  pendingSetup: readonly Binding[],
  pendingSubmission: Binding | undefined,
  boundAccountId: string,
  checkSubmissionInventory: boolean,
): Promise<void> {
  let inventory: Awaited<ReturnType<KernelSummaryPort['inventory']>> | undefined;
  const isPending = async (operationId: string) => {
    inventory ??= await port.inventory();
    return inventory.operations.some(
      (op) => op.binding.operationId === operationId && kernelOperationPending(op),
    );
  };
  for (const binding of pendingSetup) {
    if (!(await isPending(binding.operationId))) continue;
    await port.notify(binding, {
      id: randomUUID(),
      outcome: 'ENDED_UNKNOWN',
      evidenceDigest: invitationDigest(
        'Non-submit setup ended',
        boundAccountId,
        binding.operationId,
      ),
    });
  }
  if (
    pendingSubmission &&
    (!checkSubmissionInventory || (await isPending(pendingSubmission.operationId)))
  ) {
    await port.notify(pendingSubmission, {
      id: randomUUID(),
      outcome: 'ENDED_UNKNOWN',
      evidenceDigest: createHash('sha256')
        .update(
          JSON.stringify({
            pending: pendingSubmission,
            reason:
              'Invitation batch ended; unconfirmed recipients remain PENDING and will not be resent',
          }),
        )
        .digest('hex'),
    });
  }
}
export async function retryInviterStop(input: {
  profileId: string;
  stopping: Map<string, InviterPendingStop>;
  kernel: KernelBridge | undefined;
  core: Core | undefined;
}): Promise<void> {
  const { profileId, stopping, kernel, core } = input;
  const pending = stopping.get(profileId);
  if (!pending) throw Error('GROUP_INVITER_STOP_NOT_PENDING');
  await stopOwnedConnectionWithReconnect({
    profileId,
    connection: pending.connection,
    stopId: pending.requestId,
    failed: true,
    peerEpoch: pending.peerEpoch,
    kernel,
    core,
    errorPrefix: 'GROUP_INVITER',
    setStopId: (nextId) => {
      pending.requestId = nextId;
    },
    onAfterConfirmStop: (port) =>
      notifyPendingInviterOperations(
        port,
        pending.pendingSetup,
        pending.pendingSubmission,
        pending.boundAccountId,
        true,
      ),
  });
  stopping.delete(profileId);
}
export async function finalizeInviterConnection(input: {
  profileId: string;
  conn: InviterConnection;
  peer: NonNullable<ReturnType<Core['peers']['get']>>;
  kernel: KernelBridge;
  stopRequestId: string;
  boundAccountId: string;
  scopes: WeakMap<InviterConnection, InviterScope>;
  stopping: Map<string, InviterPendingStop>;
}): Promise<void> {
  const { profileId, conn, peer, kernel, stopRequestId, boundAccountId, scopes, stopping } = input;
  conn.revokeInput('GROUP_INVITER_FINISH');
  let requestId = conn.stopRequestId ?? stopRequestId;
  let closeConfirmed = false;
  try {
    try {
      await conn.close(requestId);
    } catch (closeErr) {
      if (typeof conn.stopOnCloseFailure === 'function') {
        await conn.stopOnCloseFailure();
        requestId = conn.stopRequestId ?? requestId;
        await conn.retryClose(requestId);
      } else {
        throw closeErr;
      }
    }
    closeConfirmed = true;
    const scope = scopes.get(conn);
    await kernel.withSummary(peer, (port) =>
      notifyPendingInviterOperations(
        port,
        [...(scope?.pendingSetup.values() ?? [])],
        scope?.pendingSubmission,
        boundAccountId,
        false,
      ),
    );
  } catch (cause) {
    if (!closeConfirmed) {
      const scopeSnap = scopes.get(conn);
      stopping.set(profileId, {
        connection: conn,
        requestId: conn.stopRequestId ?? requestId,
        peerEpoch: peer.epoch,
        boundAccountId,
        pendingSetup: [...(scopeSnap?.pendingSetup.values() ?? [])],
        pendingSubmission: scopeSnap?.pendingSubmission,
      });
      await conn.closeLocalAfterDisconnect().catch(() => {});
    }
    throw new Error('GROUP_INVITER_STOP_UNCONFIRMED', { cause });
  } finally {
    scopes.delete(conn);
  }
}
