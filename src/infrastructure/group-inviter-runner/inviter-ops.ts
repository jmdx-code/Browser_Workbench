import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page, Request, Response } from 'playwright-core';
import type { Core } from '../../bridge/core.js';
import { ProductError, failError } from '../../domain/workspace.js';
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
        devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_GRAPHQL_OBSERVATION', {
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
        devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_GRAPHQL_OBSERVATION_FAILED', {
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
    hasDispatched: () => requests.size > 0 || mutationSettled,
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
export async function revealInvitationControl(button: Locator, extraNudgePx = 0): Promise<void> {
  const probe = (el: Element, nudge: number) => {
    if (!(el instanceof HTMLElement)) return undefined;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const dialog = el.closest('[role="dialog"]');
    const isScrollableY = (node: HTMLElement) => {
      const s = getComputedStyle(node);
      return (
        (/(?:auto|scroll|overlay)/.test(s.overflowY) ||
          node === document.scrollingElement ||
          node === document.documentElement) &&
        node.scrollHeight > node.clientHeight + 4 &&
        node.clientHeight > 0
      );
    };
    const winH = window.innerHeight || 720;
    const winW = window.innerWidth || 1280;
    let stickyTop = 16;
    const scanSticky = (nodes: Iterable<HTMLElement>, topCap: number, maxH: number, minW = 0) => {
      for (const h of nodes) {
        if (
          h === el ||
          h.contains(el) ||
          el.contains(h) ||
          (!dialog && h.closest('[role="dialog"]'))
        )
          continue;
        const pos = getComputedStyle(h).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const hr = h.getBoundingClientRect();
        if (
          hr.height > 0 &&
          hr.height <= maxH &&
          hr.top <= topCap &&
          hr.bottom > stickyTop &&
          hr.bottom <= winH * 0.5 &&
          hr.width >= minW
        )
          stickyTop = Math.min(Math.round(winH * 0.45), Math.round(hr.bottom));
      }
    };
    if (!dialog) {
      const br = document.querySelector<HTMLElement>('[role="banner"]')?.getBoundingClientRect();
      if (br && br.width > 0 && br.height > 0 && br.bottom > 0 && br.bottom <= winH * 0.5)
        stickyTop = Math.max(stickyTop, Math.round(br.bottom));
      scanSticky(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="banner"], header, [data-pagelet*="Header"], div',
          ),
        ).slice(0, 120),
        64,
        winH * 0.45,
        winW * 0.35,
      );
    } else {
      scanSticky(
        Array.from(dialog.querySelectorAll<HTMLElement>('div, header')).slice(0, 60),
        dialog.getBoundingClientRect().top + 80,
        120,
      );
    }
    const scrollContainers: HTMLElement[] = [];
    let insideFixed = false;
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      if (isScrollableY(cur)) scrollContainers.push(cur);
      if (getComputedStyle(cur).position === 'fixed') {
        insideFixed = true;
        break;
      }
    }
    const scrollByDelta = (dy: number) => {
      let rem = dy;
      for (const scroller of scrollContainers) {
        if (Math.abs(rem) < 1) break;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const before = scroller.scrollTop;
        const next = Math.max(0, Math.min(maxTop, before + rem));
        if (next !== before) {
          scroller.scrollTop = next;
          rem -= scroller.scrollTop - before;
        }
      }
      if (!insideFixed && Math.abs(rem) >= 1) window.scrollBy(0, rem);
    };
    for (const scroller of scrollContainers) {
      const sr = scroller.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const minTop = Math.max(sr.top + 16, stickyTop + 16);
      const maxBot = Math.min(sr.bottom - 16, winH - 16);
      if (er.top < minTop)
        scroller.scrollTop = Math.max(0, scroller.scrollTop + er.top - minTop - 20);
      else if (er.bottom > maxBot)
        scroller.scrollTop = Math.min(
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          scroller.scrollTop + er.bottom - maxBot + 20,
        );
    }
    if (!insideFixed) {
      const er = el.getBoundingClientRect();
      if (er.top < stickyTop + 16) window.scrollBy(0, er.top - (stickyTop + 20));
      else if (er.bottom > winH - 16) window.scrollBy(0, er.bottom - (winH - 24));
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const inViewport = cx >= 0 && cx < winW && cy >= stickyTop + 4 && cy < winH - 4;
      const hit = inViewport ? document.elementFromPoint(cx, cy) : null;
      const canHitCenter = Boolean(
        inViewport && hit && (hit === el || el.contains(hit) || hit.contains(el)),
      );
      return { rect, cx, cy, inViewport, canHitCenter };
    };
    let m = measure();
    if (!m.inViewport || !m.canHitCenter || nudge !== 0) {
      const dy =
        m.cy < stickyTop + 12
          ? Math.round(m.rect.top - (stickyTop + 24))
          : m.cy >= winH - 12
            ? Math.round(m.rect.bottom - (winH - 28))
            : (m.rect.top < winH * 0.45 ? -1 : 1) * (nudge || 140);
      scrollByDelta(dy);
      m = measure();
    }
    return {
      cx: m.cx,
      cy: m.cy,
      stickyTop,
      windowHeight: winH,
      windowWidth: winW,
      rectTop: Math.round(m.rect.top),
      rectBottom: Math.round(m.rect.bottom),
      inViewport: m.inViewport,
      canHitCenter: m.canHitCenter,
    };
  };
  let cur = await button.evaluate(probe, extraNudgePx);
  if (!cur || (cur.inViewport && cur.canHitCenter && cur.cy < cur.windowHeight)) return;
  const maybePage = (button as { page?: () => Page }).page;
  const page = typeof maybePage === 'function' ? maybePage.call(button) : undefined;
  if (!page?.mouse?.wheel) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    const deltaY =
      cur.cy >= cur.windowHeight - 8
        ? Math.max(140, cur.rectBottom - cur.windowHeight + 48)
        : cur.cy < cur.stickyTop + 8
          ? Math.min(-140, cur.rectTop - cur.stickyTop - 48)
          : (cur.rectTop < cur.windowHeight * 0.45 ? -1 : 1) * (extraNudgePx || 160);
    await page.mouse
      .move(
        Math.max(12, Math.min(cur.windowWidth - 12, cur.cx)),
        Math.max(cur.stickyTop + 12, Math.min(cur.windowHeight - 12, cur.cy)),
      )
      .catch(() => {});
    await page.mouse.wheel(0, deltaY).catch(() => {});
    await sleep(120);
    cur = await button.evaluate(probe, 0);
    if (!cur || (cur.inViewport && cur.canHitCenter && cur.cy < cur.windowHeight)) break;
  }
}
export async function clickInvitationControl(
  button: Locator,
  validateFallback: () => Promise<boolean>,
) {
  await revealInvitationControl(button, 0).catch(() => {});
  await sleep(150);
  const retryableRe = /timeout|intercept|outside.*viewport|obscures|not visible/i;
  try {
    await button.click({ timeout: 4000 });
  } catch (firstErr) {
    if (!(firstErr instanceof Error) || !retryableRe.test(firstErr.message)) throw firstErr;
    await revealInvitationControl(button, 160).catch(() => {});
    await sleep(180);
    try {
      await button.click({ timeout: 4000 });
    } catch (retryErr) {
      if (!(retryErr instanceof Error) || !retryableRe.test(retryErr.message)) throw retryErr;
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
      failError(
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
export async function markNonInvitePopupCloseButton(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      for (const old of Array.from(document.querySelectorAll('[data-wb-non-invite-close-btn]')))
        old.removeAttribute('data-wb-non-invite-close-btn');
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
          targetBtn.setAttribute('data-wb-non-invite-close-btn', '1');
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
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
const notifyScopePending = (
  port: KernelSummaryPort,
  scope:
    | { pendingSetup: Iterable<Binding> | Map<string, Binding>; pendingSubmission?: Binding }
    | undefined,
  boundAccountId: string,
  failed: boolean,
) =>
  notifyPendingInviterOperations(
    port,
    scope
      ? scope.pendingSetup instanceof Map
        ? [...scope.pendingSetup.values()]
        : [...scope.pendingSetup]
      : [],
    scope?.pendingSubmission,
    boundAccountId,
    failed,
  );
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
    onAfterConfirmStop: (port) => notifyScopePending(port, pending, pending.boundAccountId, true),
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
      if (typeof conn.stopOnCloseFailure !== 'function') throw closeErr;
      await conn.stopOnCloseFailure();
      requestId = conn.stopRequestId ?? requestId;
      await conn.retryClose(requestId);
    }
    closeConfirmed = true;
    await kernel.withSummary(peer, (port) =>
      notifyScopePending(port, scopes.get(conn), boundAccountId, false),
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
