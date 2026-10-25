import { invitationDigest, prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { Awaitable } from '../domain/persistence.js';
import { randomUUID, createHash } from 'node:crypto';
import type { Core } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type {
  GroupInviterBrowserRunner,
  GroupInviterRepository,
  GroupInviterRunCallbacks,
} from '../application/group-inviter-service.js';
import type { InviterGroupRow } from '../shared/group-inviter.js';
import { ProductError } from '../domain/workspace.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import {
  groupInvitationEffect,
  readGroupInvitationState,
  inviteDialogSelector,
} from './group-inviter-effects.js';
import type { Page, Request, Response } from 'playwright-core';
import type { Binding } from '../shared/task-execution.js';
import type { GroupInvitationState, InvitationMenuItem } from './group-inviter-effects.js';

type Connection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;

const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
export interface InvitationSubmission {
  submitted: true;
  total: number;
  confirmedIds: string[];
  pending: number;
  graphqlConfirmed?: number;
  fallbackReopens?: number;
  reloads?: number;
}

function invitationJSONChunks(body: string): unknown[] | null {
  const text = body.trim().replace(/^for\s*\(;;\);\s*/, '');
  try {
    return [JSON.parse(text) as unknown];
  } catch {
    try {
      return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line.trim().replace(/^for\s*\(;;\);\s*/, '')) as unknown);
    } catch {
      return null;
    }
  }
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
  const chunks = invitationJSONChunks(input.body);
  if (!chunks?.length) return [];
  const selected = new Set(input.selectedIds),
    confirmed = new Set<string>();
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
      for (const user of users)
        if (
          record(user) &&
          typeof user.id === 'string' &&
          /^\d{5,25}$/.test(user.id) &&
          selected.has(user.id)
        )
          confirmed.add(user.id);
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
    // A response body may finish reading while the page fallback is running.
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
}) {
  const confirmed = input.confirmed ?? new Set<string>(),
    selected = new Set(input.selectedIds),
    now = input.now ?? Date.now,
    wait = input.wait ?? (() => sleep(500)),
    deadline = now() + (input.budgetMs ?? 20000);
  let origin: number | undefined,
    stagnant = 0;
  do {
    input.guard();
    const state = await input.read();
    if (state.verificationRequired)
      throw new ProductError(
        'GROUP_INVITER_VERIFICATION_REQUIRED',
        '受限 · 需要手机验证或操作受限',
        409,
      );
    const url = new URL(state.url);
    origin ??= state.timeOrigin;
    if (
      !state.ready ||
      !state.visible ||
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
    if (stagnant >= 4) break;
    await wait();
  } while (now() < deadline);
  return confirmed;
}

async function scrollInvitationList(page: Page, state: GroupInvitationState) {
  if (!state.dialog || state.dialogIndex === undefined) return false;
  return page.evaluate((index) => {
    const d = document.querySelectorAll('[role="dialog"]')[index];
    if (!d) return false;
    const candidates = [d, ...Array.from(d.querySelectorAll('div'))];
    const scroller = candidates.find((el) => {
      const s = getComputedStyle(el);
      return (
        /auto|scroll/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight &&
        !!el.querySelector('[role="checkbox"]')
      );
    });
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.75);
    return scroller.scrollTop !== before;
  }, state.dialogIndex);
}

export function observeInvitationGraphQL(
  page: Page,
  profileId: string,
  operationId: string,
  groupId: string,
  selectedIds: readonly string[],
  accountId: string,
) {
  const requests = new Map<Request, { name: string; variables: unknown; rawVariables: unknown }>(),
    pending = new Set<Promise<void>>();
  const confirmed = new Set<string>();
  let mutationSettled = false,
    confirmationWaited = false;
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
        const chunks = (invitationJSONChunks(body) ?? []).map((chunk) => describe(chunk));
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
    confirmations: async () => {
      if (!confirmationWaited) {
        confirmationWaited = true;
        const deadline = Date.now() + 15000;
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

export class GroupInviterBrowserAdapter implements GroupInviterBrowserRunner {
  private readonly selectingByGroup = new Map<string, Set<string>>();

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
      // Hold the memory claim across the fresh read: another account may have
      // just committed PENDING and released its claim after our old snapshot.
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
  private readonly scopes = new WeakMap<
    Connection,
    {
      guard: () => void;
      activate?: () => Promise<unknown>;
      page: Page;
      groupId: string;
      jobId: string;
      stepId: string;
      stopId: string;
      pendingSubmission?: Binding;
    }
  >();
  private readonly stopping = new Map<string, { connection: Connection; requestId: string }>();
  async retryStop(profileId: string) {
    const pending = this.stopping.get(profileId);
    if (!pending) throw Error('GROUP_INVITER_STOP_NOT_PENDING');
    await pending.connection.retryClose(pending.requestId);
    this.stopping.delete(profileId);
  }
  constructor(
    private readonly repo: GroupInviterRepository,
    private readonly getKernel: () => KernelBridge | undefined,
    private readonly getCore: () => Core | undefined,
    private readonly getProfileAccountId: (profileId: string) => Awaitable<string | null>,
    private readonly checkProfileBusy?: (profileId: string) => Awaitable<boolean>,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.getKernel() && this.getCore());
  }

  isProfileReady(profileId: string): boolean {
    const core = this.getCore();
    const peer = core?.peers.get(profileId);
    return Boolean(peer && peer.online && peer.synced);
  }

  async isProfileBusy(profileId: string): Promise<boolean> {
    return (await this.checkProfileBusy?.(profileId)) === true;
  }

  async fetchGroupAvatar(
    group: InviterGroupRow,
    allowIdleBrowser: boolean,
  ): Promise<string | null> {
    const crawled = await this.crawlGroupAvatarViaHttp(group.groupId);
    if (crawled) return crawled;
    if (allowIdleBrowser) {
      return this.fetchGroupAvatarViaIdleBrowser(group);
    }
    return null;
  }

  private async crawlGroupAvatarViaHttp(groupId: string): Promise<string | null> {
    const urls = [
      `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/`,
      `https://mbasic.facebook.com/groups/${encodeURIComponent(groupId)}/`,
    ];
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent':
                'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
              Accept: 'text/html,application/xhtml+xml',
            },
            signal: controller.signal,
          });
          if (!res.ok) continue;
          const html = await res.text();
          const ogMatch =
            html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
            html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
          if (ogMatch && ogMatch.startsWith('https://')) {
            return ogMatch.replace(/&amp;/g, '&');
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Try next URL
      }
    }
    return null;
  }

  private async fetchGroupAvatarViaIdleBrowser(group: InviterGroupRow): Promise<string | null> {
    const kernel = this.getKernel();
    const core = this.getCore();
    if (!kernel || !core) return null;

    const peer = [...core.peers.values()].find((p) => p.online && p.synced && p.phase === 'PAUSED');
    if (!peer) return null;

    try {
      const inv = await kernel.withSummary(peer, (port) => port.inventory());
      const readyTabs = inv.tabs.filter((t) => t.state === 'READY' && t.proof);
      const mainProof =
        (inv.workspaceMain &&
          readyTabs.find((t) => t.proof?.ownershipId === inv.workspaceMain?.ownershipId)?.proof) ||
        readyTabs[0]?.proof;
      if (!mainProof) return null;

      const accountId = await this.getProfileAccountId(peer.profileId);
      if (!accountId || !/^\d{5,25}$/.test(accountId) || (await this.isProfileBusy(peer.profileId)))
        return null;
      const conn = await kernel.connectFacebook(
        peer,
        accountId,
        () => {
          if (core.peers.get(peer.profileId) !== peer || !peer.online || !peer.synced)
            throw Error('GROUP_INVITER_CONNECTION_CHANGED');
        },
        mainProof,
      );
      const activeProof = conn.proof || mainProof;
      try {
        const page = conn.browser.contexts()[0]?.pages()[0];
        if (!page) return null;
        const existingImg = await page.evaluate((gid) => {
          const cover = document.querySelector(
            'a[aria-label="Cover photo"] img, a[aria-label="封面照片"] img',
          );
          if (location.href.includes(`/groups/${gid}`) && cover) {
            return cover.getAttribute('src');
          }
          const link = document.querySelector(`a[href*="/groups/${gid}"]`);
          const img = link?.querySelector('img, svg image');
          return (
            img?.getAttribute('src') ||
            img?.getAttribute('xlink:href') ||
            img?.getAttribute('href') ||
            null
          );
        }, group.groupId);
        return existingImg;
      } finally {
        await conn.close();
        if (activeProof) {
          await kernel.revealOwnedFacebookPage(peer, activeProof).catch(() => {});
        }
      }
    } catch {
      return null;
    }
  }

  private async execBoundOp<T>(
    conn: Awaited<ReturnType<KernelBridge['connectFacebook']>>,
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
    const assertPage = async () => {
      scope.guard();
      let state = await readGroupInvitationState(scope.page, scope.guard);
      if (state.verificationRequired)
        throw new ProductError(
          'GROUP_INVITER_VERIFICATION_REQUIRED',
          '受限 · 需要手机验证或操作受限',
          409,
        );
      const deadline = Date.now() + 15000;
      let activated = false;
      while (!state.ready || !state.visible) {
        scope.guard();
        if (!state.visible && !activated) {
          activated = true;
          await scope.activate?.();
        }
        if (Date.now() >= deadline)
          throw new ProductError(
            'GROUP_INVITER_PAGE_NOT_READY',
            state.visible
              ? 'Facebook 页面加载超时，未继续邀请'
              : 'Facebook 任务页仍不可见，请让浏览器露出页面区域后重试',
            409,
          );
        await sleep(250);
        state = await readGroupInvitationState(scope.page, scope.guard);
        if (state.verificationRequired)
          throw new ProductError(
            'GROUP_INVITER_VERIFICATION_REQUIRED',
            '受限 · 需要手机验证或操作受限',
            409,
          );
      }
      scope.guard();
      if (state.accountId !== accountId)
        throw new ProductError(
          'GROUP_INVITER_ACCOUNT_CHANGED',
          '当前登录账号已变化，已停止本次邀请；请检查浏览器中的实际账号',
          409,
        );
      if (label !== 'enter-group') {
        const route = new URL(state.url);
        if (
          route.origin !== 'https://www.facebook.com' ||
          route.pathname.split('/')[1] !== 'groups' ||
          route.pathname.split('/')[2] !== scope.groupId
        )
          throw Error('GROUP_INVITER_CURRENT_GROUP_CHANGED');
      }
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
    const res = await conn.execute(
      binding,
      async () => {
        try {
          return await fn(binding.operationId);
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
      const state = await readGroupInvitationState(scope.page, scope.guard);
      if (state.verificationRequired)
        throw new ProductError(
          'GROUP_INVITER_VERIFICATION_REQUIRED',
          '受限 · 需要手机验证或操作受限',
          409,
        );
      if (sending) {
        // Never combine observations across another account, group or document.
        const route = new URL(state.url);
        resultTimeOrigin ??= state.timeOrigin;
        if (
          (resultTimeOrigin !== undefined && state.timeOrigin !== resultTimeOrigin) ||
          !state.ready ||
          !state.visible ||
          state.accountId !== accountId ||
          route.origin !== 'https://www.facebook.com' ||
          route.pathname.split('/')[1] !== 'groups' ||
          route.pathname.split('/')[2] !== scope.groupId
        )
          throw new ProductError(
            'GROUP_INVITER_RESULT_CONTEXT_CHANGED',
            '邀请结果核对时账号、小组或可见状态发生变化，未自动重发',
            409,
          );
        for (const item of [...state.items, ...(state.recipients ?? [])])
          if (item.id && item.invited) confirmed.set(item.id, item);
      }
      const evidence = sending ? { ...state, items: [...confirmed.values()] } : state;
      if (groupInvitationEffect(label, evidence, scope.groupId, accountId, res.value)) {
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
      const dialogs = await scope.page.evaluate(() =>
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
      devDiag.record({
        category: 'GROUP_INVITER',
        event: 'GROUP_INVITER_EFFECT_MISSING',
        profileId: binding.profileId,
        operationId: binding.operationId,
        data: { label, dialogs },
      });
      throw new ProductError(
        'GROUP_INVITER_EFFECT_UNCONFIRMED',
        `${label === 'send-group-invites' ? '邀请结果' : '页面操作结果'}未确认，已停止；不会自动重复发送`,
        409,
      );
    }
    // Durable confirmed recipients before acknowledging the native operation.
    // A crash between these commits leaves the original native record pending.
    await persist?.(res.value, binding.operationId);
    await conn.reconcile(binding, {
      id: randomUUID(),
      outcome: 'VERIFIED',
      evidenceDigest: createHash('sha256')
        .update(JSON.stringify({ binding, label, observed, value: res.value }))
        .digest('hex'),
    });
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

    const prepared = await prepareFacebookWorkspace(kernel, peer, undefined, guard);
    guard();
    if (prepared.inventory.operations.some(kernelOperationPending))
      throw new ProductError(
        'GROUP_INVITER_PRIOR_RESULT_UNCONFIRMED',
        '该浏览器有待核对操作，请先处理原记录；未改写原结果、未发送新邀请',
        409,
      );
    const mainProof = prepared.proof;

    await callbacks.setProfileStatus(profileId, '打开首页 · 读取当前登录账号');
    const identity =
      (await kernel.inspectIdleFacebookPage(peer, guard, false, true)) ??
      (await kernel.inspectFacebookIdentity(
        peer,
        guard,
        true,
        mainProof ?? undefined,
        true,
        false,
        true,
      ));
    guard();
    const boundAccountId = identity.actor.accountId;
    const proof = identity.proof;
    if (!proof) throw Error('GROUP_INVITER_TASK_TAB_REQUIRED');
    const conn = await kernel.connectFacebook(peer, boundAccountId, guard, proof);
    const stopRequestId = randomUUID();
    const selectedInMemory = new Set<string>();

    try {
      const page = conn.browser.contexts()[0]?.pages()[0];
      if (!page) throw Error('BROWSER_PAGE_MISSING');
      this.scopes.set(conn, {
        guard,
        activate: async () => {
          guard();
          const result = await kernel.revealOwnedFacebookPage(peer, proof);
          guard();
          return result;
        },
        page,
        groupId: group.groupId,
        jobId: randomUUID(),
        stepId: randomUUID(),
        stopId: stopRequestId,
      });

      const effectiveAccountId = boundAccountId;
      const atGroup = () => {
        const route = new URL(page.url());
        return (
          route.origin === 'https://www.facebook.com' &&
          route.pathname.split('/')[1] === 'groups' &&
          route.pathname.split('/')[2] === group.groupId
        );
      };

      if (callbacks.isCancelled(profileId)) return;

      // The saved group ID is already the destination; no name search is needed.
      if (!atGroup()) {
        await callbacks.setProfileStatus(profileId, `打开小组 · ${group.groupName.slice(0, 12)}`);
        await this.execBoundOp(conn, boundAccountId, 'enter-group', async () => {
          await page.goto(`https://www.facebook.com/groups/${encodeURIComponent(group.groupId)}/`, {
            waitUntil: 'commit',
            timeout: 30000,
          });
        });
      }

      // Step 2: Capture cover / avatar on the group page if still missing
      const coverSrc = await page
        .evaluate(() => {
          const img = document.querySelector(
            'a[aria-label="Cover photo"] img, a[aria-label="封面照片"] img, [role="main"] img[data-imgperflogname="profileCoverPhoto"]',
          );
          return img?.getAttribute('src') || null;
        })
        .catch(() => null);
      if (coverSrc && coverSrc.startsWith('https://')) {
        await this.repo.updateGroupAvatar(group.groupId, coverSrc);
      }

      if (callbacks.isCancelled(profileId)) return;

      // Step 3: Check if already in group; if not, click Join group / 加入小组 and close any modal
      const joinBtnLoc = page
        .getByRole('button', { name: /^(?:Join group|Join|加入小组|加入社團|加入)$/i })
        .first();
      const inviteButton = async () => {
        const state = await readGroupInvitationState(page, guard);
        if (state.verificationRequired)
          throw new ProductError(
            'GROUP_INVITER_VERIFICATION_REQUIRED',
            '受限 · 需要手机验证或操作受限',
            409,
          );
        return state.inviteButtonIndex === undefined
          ? null
          : page.locator('[role="button"],button').nth(state.inviteButtonIndex);
      };

      // The URL can arrive before React mounts the group's actions.
      const groupReadyDeadline = Date.now() + 15000;
      while (!(await (await inviteButton())?.isVisible()) && !(await joinBtnLoc.isVisible())) {
        guard();
        if (!atGroup())
          throw new ProductError('GROUP_INVITER_GROUP_CHANGED', '小组页面已跳转，未继续邀请', 409);
        if (Date.now() >= groupReadyDeadline) {
          const controls = await page.evaluate(() => ({
            url: location.href,
            ready: document.readyState,
            visibility: document.visibilityState,
            buttons: Array.from(document.querySelectorAll('[role="button"],button'))
              .filter((el) => {
                const r = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  style.visibility !== 'hidden' &&
                  style.display !== 'none'
                );
              })
              .slice(0, 20)
              .map((el) =>
                (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 80),
              ),
          }));
          devDiag.record({
            category: 'GROUP_INVITER',
            event: 'GROUP_INVITER_GROUP_CONTROLS_MISSING',
            profileId,
            data: controls,
          });
          throw new ProductError(
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
        await this.execBoundOp(conn, boundAccountId, 'join-group', async () => {
          await joinBtnLoc.scrollIntoViewIfNeeded();
          await sleep(300);
          await joinBtnLoc.click({ timeout: 5000 });
        });
        await sleep(3500);

        const popupCloseCoords = await page.evaluate(() => {
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
              !/notifications|通知|messenger|聊天/i.test(d.getAttribute('aria-label') || ''),
          );
          for (const d of dialogs) {
            const closeBtn = Array.from(
              d.querySelectorAll(
                '[role="button"][aria-label="Close"], [role="button"][aria-label="关闭"], [role="button"][aria-label="關閉"]',
              ),
            ).find(isVis);
            if (closeBtn) {
              const r = closeBtn.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        });

        if (popupCloseCoords) {
          await this.execBoundOp(conn, boundAccountId, 'close-join-popup', async () => {
            await page.mouse.click(popupCloseCoords.x, popupCloseCoords.y);
          });
          await sleep(1500);
        }
      }

      if (!(await inviteButton())) {
        throw Error(`小组待审核或不可邀请 · ${group.groupName.slice(0, 10)}`);
      }

      // Open the same native invitation entry on subsequent result reads.
      let menuEntry: InvitationMenuItem | undefined;
      const dialogLocator = (state: GroupInvitationState) => {
        if (!state.dialog || state.dialogIndex === undefined)
          throw Error('GROUP_INVITER_DIALOG_REQUIRED');
        if (state.dialogLabel)
          return page.getByRole('dialog', { name: state.dialogLabel, exact: true });
        return page.locator(inviteDialogSelector).nth(state.dialogIndex);
      };
      const openDialog = async (bound: boolean) => {
        let state = await readGroupInvitationState(page, guard);
        if (state.dialog && state.sendButton && state.items.length) return state;
        const click = async () => {
          const button = await inviteButton();
          if (!button) throw Error('GROUP_INVITER_INVITE_ENTRY_REQUIRED');
          await button.click({ timeout: 15000 });
        };
        if (!state.dialog) {
          if (bound) await this.execBoundOp(conn, boundAccountId, 'open-invite-modal', click);
          else await click();
        }
        const deadline = Date.now() + 15000;
        do {
          guard();
          state = await readGroupInvitationState(page, guard);
          if (state.verificationRequired)
            throw new ProductError(
              'GROUP_INVITER_VERIFICATION_REQUIRED',
              '受限 · 需要手机验证或操作受限',
              409,
            );
          if (state.dialog && state.sendButton && state.items.length) return state;
          if (state.menu) {
            const entries = state.menuItems ?? [];
            const previousEntry = menuEntry;
            const matches = previousEntry
              ? entries.filter((e) => e.fingerprint === previousEntry.fingerprint)
              : [];
            const entry = previousEntry
              ? matches.length === 1
                ? matches[0]
                : entries.find(
                    (e) =>
                      e.index === previousEntry.index &&
                      e.fingerprint === previousEntry.fingerprint,
                  )
              : entries[0];
            if (!entry) throw Error('GROUP_INVITER_INVITE_MENU_CHANGED');
            menuEntry = entry;
            const choose = async () => {
              await page
                .locator('[role="menuitem"]')
                .filter({ visible: true })
                .nth(entry.index)
                .click({ timeout: 5000 });
            };
            if (bound)
              await this.execBoundOp(conn, boundAccountId, 'click-invite-menuitem', choose);
            else await choose();
          }
          await sleep(250);
        } while (Date.now() < deadline);
        if (state.dialog && state.sendButton) return state;
        throw new ProductError(
          'GROUP_INVITER_RESULT_DIALOG_REQUIRED',
          '邀请列表未能打开，已保留待核对记录，未重发',
          409,
        );
      };
      await callbacks.setProfileStatus(profileId, `打开邀请弹窗 · ${group.groupName.slice(0, 10)}`);
      await openDialog(true);

      // Step 5: Select up to invitesPerGroup deduplicated friends
      const alreadyInvitedIds = await this.repo.getInvitedFriendIdsForGroup(group.groupId);
      const seenInModal = new Set<string>();
      const selectedBatch: Array<{ friendId: string; friendName: string }> = [];
      let stagnantScrolls = 0;
      let lastCheckboxTotal = 0;

      while (selectedBatch.length < invitesPerGroup && !callbacks.isCancelled(profileId)) {
        const reading = await readGroupInvitationState(page, guard);
        guard();
        if (!reading.dialog) break;
        const index = reading.items.findIndex(
          (item) =>
            item.id &&
            item.name &&
            !item.checked &&
            !item.invited &&
            !item.member &&
            !item.disabled &&
            !alreadyInvitedIds.has(item.id) &&
            !this.selectingByGroup.get(group.groupId)?.has(item.id) &&
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
          seenInModal.add(candidate.friendId);

          const checkedNow = await this.selectRecipient(
            group.groupId,
            candidate.friendId,
            selectedInMemory,
            async () =>
              Boolean(
                await this.execBoundOp(
                  conn,
                  boundAccountId,
                  `check-friend-${selectedBatch.length + 1}`,
                  async () => {
                    const state = await readGroupInvitationState(page, guard);
                    if (
                      state.items[candidate.index]?.id !== candidate.friendId ||
                      state.items[candidate.index]?.checked
                    )
                      throw Error('GROUP_INVITER_RECIPIENT_CHANGED');
                    const cbLoc = dialogLocator(state)
                      .locator('[role="checkbox"]')
                      .nth(candidate.index);
                    await cbLoc.scrollIntoViewIfNeeded();
                    await sleep(200);
                    await cbLoc.click({ timeout: 5000 });
                    await sleep(300);
                    return (await cbLoc.evaluate(
                      (el) => el.getAttribute('aria-checked') === 'true',
                    ))
                      ? candidate.friendId
                      : '';
                  },
                ),
              ),
          );

          if (checkedNow) {
            selectedBatch.push({
              friendId: candidate.friendId,
              friendName: candidate.friendName,
            });
            alreadyInvitedIds.add(candidate.friendId);
            await callbacks.setProfileStatus(
              profileId,
              `已选 ${selectedBatch.length}/${invitesPerGroup} 人 · ${group.groupName.slice(0, 10)}`,
            );
          }

          await sleep(randInt(550, 1150));
        } else {
          if (candidate.totalCheckboxes <= lastCheckboxTotal) {
            stagnantScrolls++;
          } else {
            stagnantScrolls = 0;
          }
          lastCheckboxTotal = candidate.totalCheckboxes;
          if (stagnantScrolls >= 3) break;

          guard();
          const scrolled = await scrollInvitationList(page, reading);

          if (!scrolled) break;
          await sleep(1000);
        }
      }

      // One native submit; confirmed recipients are committed as soon as observed.
      let submission: InvitationSubmission | undefined;
      if (selectedBatch.length > 0 && !callbacks.isCancelled(profileId)) {
        const selectedIds = selectedBatch.map((f) => f.friendId),
          confirmed = new Set<string>();
        const sent = await this.execBoundOp(
          conn,
          boundAccountId,
          'send-group-invites',
          async (operationId) => {
            const before = await readGroupInvitationState(page, guard);
            if (!mountedInvitationSelectionMatches(before, selectedIds))
              throw Error('GROUP_INVITER_SELECTION_CHANGED');
            if (!before.sendButton || before.sendButton.disabled)
              throw Error('邀请发送按钮不可用，未发送');
            const observation = observeInvitationGraphQL(
              page,
              profileId,
              operationId,
              group.groupId,
              selectedIds,
              boundAccountId,
            );
            try {
              try {
                const ctx = await conn.context(boundAccountId);
                const scope = this.scopes.get(conn);
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
                devDiag.record({
                  category: 'GROUP_INVITER',
                  event: 'GROUP_INVITER_NETWORK_OBSERVER_UNAVAILABLE',
                  profileId,
                  operationId,
                  reason: e instanceof Error ? e.message.slice(0, 160) : 'UNAVAILABLE',
                });
              }
              await callbacks.setProfileStatus(profileId, `发送 ${selectedBatch.length} 份邀请`);
              await dialogLocator(before)
                .locator('[role="button"],button')
                .nth(before.sendButton.index)
                .click({ timeout: 5000 });
              const closedDeadline = Date.now() + 15000;
              let closed = false;
              while (Date.now() < closedDeadline) {
                guard();
                const s = await readGroupInvitationState(page, guard);
                if (s.verificationRequired)
                  throw new ProductError(
                    'GROUP_INVITER_VERIFICATION_REQUIRED',
                    '受限 · 需要手机验证或操作受限',
                    409,
                  );
                if (!s.dialog) {
                  closed = true;
                  break;
                }
                await sleep(250);
              }
              observation.endSubmission();
              const persist = async (ids: string[]) => {
                const inserted = await this.repo.recordInvites(
                  selectedBatch
                    .filter((f) => ids.includes(f.friendId))
                    .map((f) => ({
                      profileId,
                      accountId: effectiveAccountId,
                      friendId: f.friendId,
                      friendName: f.friendName,
                      groupId: group.groupId,
                      invitedAt: Date.now(),
                    })),
                  operationId,
                );
                await callbacks.addSessionInvited(profileId, inserted);
                await callbacks.setProfileStatus(
                  profileId,
                  invitationResultStatus(
                    confirmed.size + ids.filter((id) => !confirmed.has(id)).length,
                    selectedIds.length -
                      confirmed.size -
                      ids.filter((id) => !confirmed.has(id)).length,
                  ),
                );
              };
              const collect = () =>
                collectInvitationConfirmations({
                  selectedIds,
                  accountId: boundAccountId,
                  groupId: group.groupId,
                  read: () => readGroupInvitationState(page, guard),
                  scroll: (s) => scrollInvitationList(page, s),
                  persist,
                  confirmed,
                  guard,
                });
              let fallbackReopens = 0,
                reloads = 0;
              const graphqlConfirmed = await settleInvitationConfirmation({
                selectedIds,
                confirmed,
                persist,
                graphql: closed ? observation.confirmations : async () => [],
                assertCurrent: async () => {
                  guard();
                  const current = await readGroupInvitationState(page, guard);
                  if (current.verificationRequired)
                    throw new ProductError(
                      'GROUP_INVITER_VERIFICATION_REQUIRED',
                      '受限 · 需要手机验证或操作受限',
                      409,
                    );
                  if (current.accountId !== boundAccountId || !atGroup())
                    throw new ProductError(
                      'GROUP_INVITER_RESULT_CONTEXT_CHANGED',
                      '邀请核对页面发生变化，结果仍待确认，未重发',
                      409,
                    );
                },
                fallback: async () => {
                  if (closed) {
                    try {
                      fallbackReopens++;
                      await openDialog(false);
                      await collect();
                      if (confirmed.size === 0) {
                        reloads++;
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                        fallbackReopens++;
                        await openDialog(false);
                        await collect();
                      }
                    } catch (e) {
                      if (
                        e instanceof ProductError &&
                        e.code === 'GROUP_INVITER_VERIFICATION_REQUIRED'
                      )
                        throw e;
                      devDiag.record({
                        category: 'GROUP_INVITER',
                        event: 'GROUP_INVITER_RESULT_READ_INCOMPLETE',
                        profileId,
                        operationId,
                        reason: e instanceof Error ? e.message.slice(0, 200) : 'READ_FAILED',
                        data: {
                          confirmed: confirmed.size,
                          pending: selectedIds.length - confirmed.size,
                        },
                      });
                    }
                  } else await collect();
                },
              });
              return {
                submitted: true as const,
                total: selectedIds.length,
                confirmedIds: [...confirmed],
                pending: selectedIds.length - confirmed.size,
                graphqlConfirmed,
                fallbackReopens,
                reloads,
              };
            } finally {
              await observation.close();
            }
          },
          undefined,
          async (operationId) => {
            if (!this.repo.reserveInvites) throw Error('GROUP_INVITER_RESERVATION_REQUIRED');
            await this.repo.reserveInvites(
              operationId,
              selectedBatch.map((f) => ({
                ...f,
                profileId,
                accountId: effectiveAccountId,
                groupId: group.groupId,
              })),
            );
            // The durable PENDING rows now own deduplication, including after
            // cancellation or an unknown submit. No memory claim is needed.
            this.releaseSelections(group.groupId, selectedInMemory);
          },
        );
        submission = sent;
        await callbacks.reportBatchResult?.(profileId, sent.confirmedIds.length, sent.pending);
        await callbacks.setProfileStatus(
          profileId,
          invitationResultStatus(sent.confirmedIds.length, sent.pending),
        );
        devDiag.record({
          category: 'GROUP_INVITER',
          event: 'GROUP_INVITER_BATCH_RESULT',
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
          await this.execBoundOp(conn, boundAccountId, 'close-invite-modal', async () => {
            const latest = await readGroupInvitationState(page, guard);
            if (!latest.dialog || !latest.closeButton) return;
            await dialogLocator(latest)
              .locator('[role="button"],button')
              .nth(latest.closeButton.index)
              .click({ timeout: 5000 });
          });
        }
      }
    } finally {
      this.releaseSelections(group.groupId, selectedInMemory);
      conn.revokeInput('GROUP_INVITER_FINISH');
      const requestId = stopRequestId;
      try {
        await conn.close(requestId);
        const pending = this.scopes.get(conn)?.pendingSubmission;
        if (pending)
          await kernel.withSummary(peer, (port) =>
            port.notify(pending, {
              id: randomUUID(),
              outcome: 'ENDED_UNKNOWN',
              evidenceDigest: createHash('sha256')
                .update(
                  JSON.stringify({
                    pending,
                    reason:
                      'Invitation batch ended; unconfirmed recipients remain PENDING and will not be resent',
                  }),
                )
                .digest('hex'),
            }),
          );
      } catch (cause) {
        this.stopping.set(profileId, { connection: conn, requestId });
        throw new Error('GROUP_INVITER_STOP_UNCONFIRMED', { cause });
      } finally {
        this.scopes.delete(conn);
      }
    }
  }
}
