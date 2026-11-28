import { z } from 'zod';
import type { Awaitable } from '../domain/persistence.js';
import { readFacebookAcrossNavigation } from './facebook-navigation-read.js';
import type { Page } from 'playwright-core';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
export const inviteDialogSelector = '[role="dialog"]';
export interface InvitationRecipient {
  id: string | null;
  invited: boolean;
  member: boolean;
  checked: boolean;
  name?: string;
  disabled?: boolean;
}
export type InvitationButton = { index: number; disabled: boolean };
export type InvitationMenuItem = { index: number; fingerprint: string; preferred?: boolean };
export interface GroupInvitationState {
  url: string;
  accountId: string | null;
  visible: boolean;
  ready: boolean;
  dialog: boolean;
  dialogIndex?: number;
  dialogLabel?: string;
  menu: boolean;
  menuItems?: InvitationMenuItem[];
  dialogCount: number;
  joined: boolean;
  items: InvitationRecipient[];
  recipients?: InvitationRecipient[];
  timeOrigin?: number;
  verificationRequired?: boolean;
  sendButton?: InvitationButton;
  closeButton?: InvitationButton;
  inviteButtonIndex?: number;
  relay?: { available: boolean; edgeCount: number; groupId: string | null };
}
function projectGroupInvitationEntry(
  createRt: typeof createDomEvalRuntime,
  selector = '[role="dialog"]',
): GroupInvitationState {
  const { record, uid, visible, chain, clearDataAttrs } = createRt();
  clearDataAttrs([
    'data-wb-recipient-id',
    'data-wb-group-send-btn',
    'data-wb-group-close-btn',
    'data-wb-group-invite-menuitem',
    'data-wb-intervention-dismiss-btn',
    'data-wb-group-invite-btn',
    'data-wb-group-join-btn',
  ]);
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbInvitationScriptUserV1?: { timeOrigin: number; id: string | null };
  };
  const reference = (el: Element) => {
    for (const f of chain(el)) {
      const q = record(f.props.queries)
        ? f.props.queries
        : record(f.props.entryPointReference) && record(f.props.entryPointReference.queries)
          ? f.props.entryPointReference.queries
          : null;
      const ref = q?.dialogQueryReference;
      if (record(ref) && ref.name === 'GroupsCometInviteFriendsDialogQuery') return ref;
    }
    return null;
  };
  const readRecipient = (el: Element): InvitationRecipient => {
    let id: string | null = null;
    let name: string | undefined;
    let invited = false;
    let member = false;
    for (const f of chain(el, 28, { resolveCurrent: true })) {
      const user = f.props['user$key'];
      const candidate = record(user) ? (user.id ?? user.__id) : null;
      if (uid(candidate)) {
        if (id && id !== candidate) break;
        id = candidate;
        invited ||= f.props.isInvited === true;
        member ||= f.props.isMember === true;
      }
      if (f.name.includes('CometListCellStrict_DEPRECATED') && typeof f.props.headline === 'string')
        name ??= f.props.headline.trim();
      if (
        f.name.includes('FDSListCellPressable') &&
        typeof f.props['aria-label'] === 'string' &&
        f.props['aria-label'].trim()
      )
        name ??= f.props['aria-label'].trim();
    }
    if (!name) {
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) name = aria;
    }
    if (uid(id) && el.getAttribute('role') === 'checkbox')
      el.setAttribute('data-wb-recipient-id', id);
    return {
      id,
      invited,
      member,
      checked: el.getAttribute('aria-checked') === 'true',
      name,
      disabled: el.getAttribute('aria-disabled') === 'true',
    };
  };
  const dialogs = Array.from(document.querySelectorAll(selector));
  const candidates = dialogs.filter(
    (d) =>
      visible(d) &&
      (reference(d) !== null ||
        Array.from(d.querySelectorAll('[role="checkbox"]')).some(
          (el) =>
            chain(el, 28).some((f) =>
              f.name.includes('GroupsCometInviteFriendsSearchFriendItem'),
            ) || readRecipient(el).id !== null,
        )),
  );
  const dialog = candidates.length === 1 ? candidates[0] : undefined;
  const items = Array.from(dialog?.querySelectorAll('[role="checkbox"]') ?? []).map(readRecipient);
  const recipients = new Map<string, InvitationRecipient>();
  for (const el of Array.from(
    dialog?.querySelectorAll(
      '[role="listitem"],[role="row"],[role="button"][aria-disabled="true"],[role="checkbox"][aria-disabled="true"],[aria-disabled="true"]',
    ) ?? [],
  )) {
    const row = readRecipient(el);
    if (row.id && (row.invited || row.member)) recipients.set(row.id, row);
  }
  const groupId = location.pathname.match(/^\/groups\/(\d+)/)?.[1] ?? null;
  const relay = { available: false, edgeCount: 0, groupId };
  if (dialog && groupId) {
    try {
      const ref = reference(dialog);
      const env = ref?.environment;
      const vars = ref?.variables;
      if (
        record(vars) &&
        vars.groupID === groupId &&
        record(env) &&
        typeof env.getStore === 'function'
      ) {
        const store = Reflect.apply(env.getStore, env, []);
        const source =
          record(store) && typeof store.getSource === 'function'
            ? Reflect.apply(store.getSource, store, [])
            : null;
        if (record(source) && typeof source.get === 'function') {
          relay.available = true;
          const get = (id: string): Record<string, unknown> | null => {
            const r = Reflect.apply(source.get as (...args: unknown[]) => unknown, source, [id]);
            return record(r) ? r : null;
          };
          const group = get(groupId);
          const queue: string[] = [];
          const visited = new Set<string>();
          const links = (value: unknown) => {
            if (!record(value)) return;
            if (typeof value.__ref === 'string') queue.push(value.__ref);
            if (Array.isArray(value.__refs))
              for (const id of value.__refs) if (typeof id === 'string') queue.push(id);
          };
          if (group)
            for (const [key, value] of Object.entries(group))
              if (/invite_member_search|suggested_members/.test(key)) links(value);
          while (queue.length) {
            const id = queue.shift();
            if (id === undefined) break;
            if (visited.has(id)) continue;
            visited.add(id);
            const edge = get(id);
            if (!edge || edge.__typename === 'User') continue;
            if (
              edge.__typename === 'GroupInviteMemberSearchEdge' ||
              edge.__typename === 'GroupSuggestedMembersEdge'
            ) {
              relay.edgeCount++;
              const node = edge.node;
              const userId = record(node) ? node.__ref : null;
              if (uid(userId) && (edge.is_invited === true || edge.is_member === true)) {
                const user = get(userId);
                recipients.set(userId, {
                  id: userId,
                  invited: edge.is_invited === true,
                  member: edge.is_member === true,
                  checked: false,
                  name: typeof user?.name === 'string' ? user.name : undefined,
                });
              }
            }
            for (const value of Object.values(edge)) links(value);
          }
          for (const item of items)
            if (item.id && !item.name) {
              const user = get(item.id);
              if (typeof user?.name === 'string') item.name = user.name;
            }
        }
      }
    } catch {}
  }
  const buttons = Array.from(dialog?.querySelectorAll('[role="button"],button') ?? []);
  const indexedButtons = buttons.map((el, index) => ({
    el,
    index,
    frames: chain(el, 12, { resolveCurrent: true }),
  }));
  const primary = indexedButtons
    .map((b) => ({ ...b, props: b.frames.find((f) => f.name.includes('FDSButton.react'))?.props }))
    .filter((b) => b.props?.type === 'primary');
  const sendLabelRx =
    /^(?:Send\s+Invites?|Send\s+invitations?|Send|发送邀请|發送邀請|送出邀請|ဖိတ်ကြားချက်\s*ပို့(?:ရန်|ပါ)|Gửi\s+lời\s+mời|ส่งคำเชิญ)$/i;
  const cancelLabelRx = /cancel|close|取消|关闭|關閉|ပိတ်|မလုပ်တော့|Hủy|ยกเลิก/i;
  const matchesSendLabel = (el: Element) => {
    const aria = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return [aria, txt].some(
      (lbl) => lbl.length > 0 && sendLabelRx.test(lbl) && !cancelLabelRx.test(lbl),
    );
  };
  const labelMatchedSend = indexedButtons.filter((b) => matchesSendLabel(b.el));
  const close =
    indexedButtons.find((b) => b.frames.some((f) => f.name.includes('FDSCircleButton'))) ??
    indexedButtons.find((b) =>
      b.frames.some((f) => f.name.includes('FDSButton.react') && f.props.type === 'secondary'),
    );
  const isInterventionFrame = (f: { name: string; props: Record<string, unknown> }) =>
    /GroupsCometFeatureInterventionDialog|SentryBlockDialog|CometErrorDialog/.test(f.name) ||
    f.props.testid === 'feature-intervention-ok-button' ||
    (record(f.props.footer) &&
      record(f.props.footer.props) &&
      record(f.props.footer.props.primary) &&
      f.props.footer.props.primary.testid === 'feature-intervention-ok-button');
  const interventionDialogs = dialogs.filter(
    (d) =>
      visible(d) &&
      (chain(d).some(isInterventionFrame) ||
        Array.from(d.querySelectorAll('button,[role="button"],h1,h2,[role="heading"]')).some((el) =>
          chain(el, 32).some(isInterventionFrame),
        )),
  );
  const verificationRequired = interventionDialogs.length > 0;
  for (const d of interventionDialogs) {
    const btns = Array.from(d.querySelectorAll('[role="button"],button')).filter(
      (el) => visible(el) && !el.matches?.('a[href]') && !el.closest?.('a[href]'),
    );
    const dismissBtn =
      btns.find((el) => chain(el, 24).some((f) => f.name.includes('FDSCircleButton'))) ??
      btns.find((el) =>
        chain(el, 24).some(
          (f) =>
            f.props.testid === 'feature-intervention-ok-button' ||
            (f.name.includes('FDSButton.react') && f.props.type === 'primary'),
        ),
      ) ??
      btns.at(-1);
    dismissBtn?.setAttribute?.('data-wb-intervention-dismiss-btn', '1');
  }
  const pageButtons = Array.from(document.querySelectorAll('[role="button"],button'));
  const notInShell = (el: Element) =>
    !el.closest?.(
      '[role="feed"],[role="article"],[role="dialog"],[role="navigation"],nav,[role="banner"]',
    );
  const btnLabel = (el: Element) =>
    `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.replace(/\s+/g, ' ').trim();
  const isActionableHeaderBtn = (el: Element) => {
    if (
      !visible(el) ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute?.('disabled') ||
      !notInShell(el)
    )
      return false;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 24 && r.height <= 72;
  };
  let inviteCandidates = pageButtons.filter(
    (el) =>
      visible(el) &&
      notInShell(el) &&
      chain(el, 48).some((f) => f.name.includes('GroupsCometHeaderInviteMemberAddButton')),
  );
  if (inviteCandidates.length === 0) {
    const inviteLabelRx = /^(?:\+?\s*)?(?:Invite|邀请|邀請|ဖိတ်ခေါ်|Mời|เชิญ)$/i;
    inviteCandidates = pageButtons.filter(
      (el) => isActionableHeaderBtn(el) && inviteLabelRx.test(btnLabel(el)),
    );
  }
  const inviteBtn =
    inviteCandidates.find((el) => el.getBoundingClientRect().top >= 160) ?? inviteCandidates[0];
  const invite = inviteBtn ? pageButtons.indexOf(inviteBtn) : -1;
  inviteBtn?.setAttribute('data-wb-group-invite-btn', '1');
  let joinCandidates = pageButtons.filter((el) => {
    if (
      !visible(el) ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute?.('disabled') ||
      !notInShell(el)
    )
      return false;
    return chain(el, 48).some((f) => {
      if (!f.name.includes('GroupsCometJoinForumButton')) return false;
      if (!groupId) return true;
      const marker = typeof f.props.testid === 'string' ? f.props.testid : '';
      const matchedId = /^group-can-join-(\d+)$/.exec(marker)?.[1];
      const actionObj = record(f.props.action) ? f.props.action : null;
      const actionRef = typeof actionObj?.__id === 'string' ? actionObj.__id : '';
      const actionGroup = /^client:(\d+):join_action\(/.exec(actionRef)?.[1];
      return matchedId || actionGroup ? matchedId === groupId || actionGroup === groupId : true;
    });
  });
  if (joinCandidates.length === 0) {
    const joinLabelRx =
      /^(?:Join group|Join|加入小组|加入小組|加入社团|加入社團|အဖွဲ့ဝင်ရန်|အဖွဲ့သို့ဝင်ရန်|Tham gia nhóm|เข้าร่วมกลุ่ม)$/i;
    joinCandidates = pageButtons.filter(
      (el) => isActionableHeaderBtn(el) && joinLabelRx.test(btnLabel(el)),
    );
  }
  const joinBtn =
    joinCandidates.find((el) => el.getBoundingClientRect().top >= 160) ?? joinCandidates[0];
  joinBtn?.setAttribute('data-wb-group-join-btn', '1');
  const menus = Array.from(document.querySelectorAll('[role="menuitem"]')).filter((m) =>
    visible(m),
  );
  const menuItems = menus.map((el, index) => {
    const labelText = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`
      .replace(/\s+/g, ' ')
      .trim();
    const textPreferred =
      /(?:Invite.*friend|邀请.*好友|邀請.*朋友|ဖိတ်ခေါ်|Mời bạn bè|เชิญเพื่อน)/i.test(labelText) &&
      !/(?:link|链接|連結|copy|复制|複製|share|分享)/i.test(labelText);
    return {
      index,
      preferred:
        reference(el) !== null ||
        chain(el, 24).some((f) => {
          const feature =
            f.name + ' ' + (typeof f.props.actionType === 'string' ? f.props.actionType : '');
          return /InviteFriends|InviteMember/i.test(feature) && !/Link|Share|Copy/i.test(feature);
        }) ||
        textPreferred,
      fingerprint: JSON.stringify(
        chain(el, 20)
          .filter((f) => !/^(div|span|a)$/.test(f.name) && f.name)
          .map((f) => ({
            component: f.name,
            action: typeof f.props.actionType === 'string' ? f.props.actionType : null,
            icon: record(f.props.icon) ? f.props.icon.src : null,
          })),
      ),
    };
  });
  const primaryButton =
    (primary.length === 1 ? primary[0] : primary.find((b) => matchesSendLabel(b.el))) ??
    (labelMatchedSend.length === 1 ? labelMatchedSend[0] : labelMatchedSend.at(-1));
  primaryButton?.el.setAttribute('data-wb-group-send-btn', '1');
  close?.el.setAttribute('data-wb-group-close-btn', '1');
  const preferredMenu = menuItems.find((entry) => entry.preferred);
  if (preferredMenu) menus[preferredMenu.index]?.setAttribute('data-wb-group-invite-menuitem', '1');
  const cookie =
    document.cookie.match(/(?:^|;\s*)i_user=(\d{5,25})/) ??
    document.cookie.match(/(?:^|;\s*)c_user=(\d{5,25})/);
  let scriptUserId: string | null = null;
  if (!cookie?.[1]) {
    const timeOrigin = performance.timeOrigin;
    const cached = cacheHost.__wbInvitationScriptUserV1;
    if (cached?.timeOrigin === timeOrigin && cached.id) scriptUserId = cached.id;
    else {
      for (const script of Array.from(document.scripts)) {
        const txt = script.textContent ?? '';
        const match = /"ACTOR_ID":"(\d{5,25})"/.exec(txt) ?? /"USER_ID":"(\d{5,25})"/.exec(txt);
        if (match?.[1]) {
          scriptUserId = match[1];
          break;
        }
      }
      cacheHost.__wbInvitationScriptUserV1 = { timeOrigin, id: scriptUserId };
    }
  }
  return {
    url: location.href,
    accountId: cookie?.[1] ?? scriptUserId,
    visible: document.visibilityState === 'visible',
    ready: document.readyState !== 'loading',
    dialog: !!dialog,
    dialogIndex: dialog ? dialogs.indexOf(dialog) : undefined,
    dialogLabel: dialog?.getAttribute('aria-label') ?? undefined,
    menu: menus.length > 0,
    menuItems,
    dialogCount: dialogs.filter((d) => visible(d)).length,
    joined: invite >= 0,
    items,
    recipients: [...recipients.values()],
    timeOrigin: performance.timeOrigin,
    verificationRequired,
    sendButton: primaryButton
      ? {
          index: primaryButton.index,
          disabled:
            ('props' in primaryButton &&
              record(primaryButton.props) &&
              primaryButton.props.disabled === true) ||
            primaryButton.el.getAttribute('aria-disabled') === 'true' ||
            primaryButton.el.hasAttribute?.('disabled') === true,
        }
      : undefined,
    closeButton: close
      ? { index: close.index, disabled: close.el.getAttribute('aria-disabled') === 'true' }
      : undefined,
    inviteButtonIndex: invite >= 0 ? invite : undefined,
    relay,
  };
}
// Synchronous read projection; controlled DOM markers identify the observed controls. Relay is read-only.
export const projectGroupInvitationState = serializeDomEval<
  (selector?: string) => GroupInvitationState
>('projectGroupInvitationState', projectGroupInvitationEntry);
export async function readGroupInvitationState(
  page: Page,
  guard: () => Awaitable<void> = () => {},
): Promise<GroupInvitationState> {
  return readFacebookAcrossNavigation(
    () => page.evaluate(projectGroupInvitationState, inviteDialogSelector),
    guard,
  );
}
export async function dismissFeatureInterventionDialogIfPresent(
  page: Page,
  guard: () => Awaitable<void> = () => {},
): Promise<boolean> {
  if (typeof page?.evaluate !== 'function') return false;
  let state = await readGroupInvitationState(page, guard);
  if (!state.verificationRequired) return false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await guard();
    const clicked = await page
      .evaluate(() => {
        const btn = document.querySelector<HTMLElement>('[data-wb-intervention-dismiss-btn="1"]');
        if (btn) {
          btn.click();
          return true;
        }
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            bubbles: true,
          }),
        );
        return false;
      })
      .catch(() => false);
    if (!clicked) await page.keyboard?.press?.('Escape')?.catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    await guard();
    state = await readGroupInvitationState(page, guard);
    if (!state.verificationRequired) return true;
  }
  return !state.verificationRequired;
}
const InvitationProof = z
  .object({
    friendIds: z.array(z.string()).min(1),
    proof: z
      .object({
        accountId: z.string(),
        groupId: z.string(),
        timeOrigin: z.number(),
        friendIds: z.array(z.string()).min(1),
      })
      .strict(),
  })
  .strict();
export function groupInvitationEffect(
  label: string,
  state: Awaited<ReturnType<typeof readGroupInvitationState>>,
  groupId: string,
  accountId: string,
  value: unknown,
  allowHidden = false,
) {
  if (
    !state.ready ||
    (!state.visible && !allowHidden) ||
    state.verificationRequired ||
    state.accountId !== accountId
  )
    return false;
  const url = new URL(state.url);
  if (url.origin !== 'https://www.facebook.com') return false;
  if (
    label === 'join-group' &&
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { unjoinableIntervention?: boolean }).unjoinableIntervention === true
  )
    return true;
  const atGroup = url.pathname.split('/')[1] === 'groups' && url.pathname.split('/')[2] === groupId;
  if (!atGroup) return false;
  if (label === 'enter-group') return true;
  if (label === 'join-group')
    return (
      state.joined ||
      state.dialogCount > 0 ||
      (Boolean(value) &&
        typeof value === 'object' &&
        ((value as { joinedOrRequested?: boolean }).joinedOrRequested === true ||
          (value as { unjoinableIntervention?: boolean }).unjoinableIntervention === true))
    );
  if (label === 'close-join-popup') return state.dialogCount === 0;
  if (label === 'open-invite-modal') return state.dialog || state.menu;
  if (label === 'click-invite-menuitem') return state.dialog;
  if (label.startsWith('check-friend-'))
    return typeof value === 'string' && state.items.some((i) => i.id === value && i.checked);
  if (label === 'close-invite-modal') return !state.dialog;
  if (label === 'send-group-invites') {
    const confirmed = InvitationProof.safeParse(value);
    if (confirmed.success) {
      const { friendIds, proof } = confirmed.data;
      return (
        proof.accountId === accountId &&
        proof.groupId === groupId &&
        proof.timeOrigin === state.timeOrigin &&
        new Set(friendIds).size === friendIds.length &&
        proof.friendIds.length === friendIds.length &&
        friendIds.every((id) => proof.friendIds.includes(id)) &&
        state.items.some((item) => item.id === proof.friendIds.at(-1) && item.invited)
      );
    }
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (id) =>
          typeof id === 'string' &&
          [...state.items, ...(state.recipients ?? [])].some(
            (item) => item.id === id && item.invited,
          ),
      )
    );
  }
  return false;
}
