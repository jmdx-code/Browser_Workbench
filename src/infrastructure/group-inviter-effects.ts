import { z } from 'zod';
import type { Awaitable } from '../domain/persistence.js';
import { readFacebookAcrossNavigation } from './facebook-navigation-read.js';
import type { Page } from 'playwright-core';

export const inviteDialogSelector = '[role="dialog"]';
export interface InvitationRecipient {
  id: string | null;
  invited: boolean;
  member: boolean;
  checked: boolean;
  name?: string;
  disabled?: boolean;
}
export interface InvitationButton {
  index: number;
  disabled: boolean;
}
export interface InvitationMenuItem {
  index: number;
  fingerprint: string;
}
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

// This entire projection runs synchronously in the current page. It never writes to DOM or Relay.
export function projectGroupInvitationState(selector = inviteDialogSelector): GroupInvitationState {
  type RecordValue = Record<string, unknown>;
  const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object';
  const uid = (v: unknown): v is string => typeof v === 'string' && /^\d{5,25}$/.test(v);
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  let rootFibers: Map<Element, RecordValue> | undefined;
  const rootFiber = (el: Element) => {
    // Some current React builds expose only __reactContainer$, not per-node Fiber keys.
    if (!rootFibers) {
      rootFibers = new Map();
      const seen = new Set<unknown>(),
        stack: unknown[] = [];
      for (const host of Array.from(document.querySelectorAll('*')))
        for (const key of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const root = Reflect.get(host, key);
          stack.push(
            record(root) && record(root.stateNode) ? (root.stateNode.current ?? root) : root,
          );
        }
      while (stack.length && seen.size < 100000) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootFibers.set(f.stateNode, f);
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return rootFibers.get(el);
  };
  const chain = (el: Element, limit = 48) => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    let node: unknown = key ? Reflect.get(el, key) : rootFiber(el);
    const result: { name: string; props: RecordValue }[] = [];
    for (let n = 0; n < limit && record(node); n++, node = node.return) {
      const type = node.elementType ?? node.type;
      const name =
        typeof type === 'function'
          ? String(Reflect.get(type, 'displayName') ?? type.name)
          : record(type)
            ? String(type.displayName ?? '')
            : typeof type === 'string'
              ? type
              : '';
      const props = node.memoizedProps ?? node.pendingProps;
      result.push({ name, props: record(props) ? props : {} });
    }
    return result;
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
    let id: string | null = null,
      name: string | undefined,
      invited = false,
      member = false;
    for (const f of chain(el, 12)) {
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
    }
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
            chain(el, 12).some((f) =>
              f.name.includes('GroupsCometInviteFriendsSearchFriendItem'),
            ) || readRecipient(el).id !== null,
        )),
  );
  const dialog = candidates.length === 1 ? candidates[0] : undefined;
  const items = Array.from(dialog?.querySelectorAll('[role="checkbox"]') ?? []).map(readRecipient);
  const recipients = new Map<string, InvitationRecipient>();
  for (const el of Array.from(
    dialog?.querySelectorAll(
      '[role="listitem"],[role="row"],[role="button"][aria-disabled="true"]',
    ) ?? [],
  )) {
    const row = readRecipient(el);
    if (row.id && (row.invited || row.member)) recipients.set(row.id, row);
  }
  const groupId = location.pathname.match(/^\/groups\/(\d+)/)?.[1] ?? null;
  const relay = { available: false, edgeCount: 0, groupId };
  if (dialog && groupId) {
    try {
      const ref = reference(dialog),
        env = ref?.environment;
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
          const get = (id: string): RecordValue | null => {
            const r = Reflect.apply(source.get as Function, source, [id]);
            return record(r) ? r : null;
          };
          const group = get(groupId),
            queue: string[] = [],
            visited = new Set<string>();
          const links = (value: unknown) => {
            if (record(value)) {
              if (typeof value.__ref === 'string') queue.push(value.__ref);
              if (Array.isArray(value.__refs))
                for (const id of value.__refs) if (typeof id === 'string') queue.push(id);
            }
          };
          // Follow this group's invite connections, never edges belonging to another group.
          if (group)
            for (const [key, value] of Object.entries(group))
              if (/invite_member_search|suggested_members/.test(key)) links(value);
          while (queue.length) {
            const id = queue.shift();
            if (id === undefined) break;
            if (visited.has(id)) continue;
            visited.add(id);
            const edge = get(id);
            if (!edge) continue;
            if (edge.__typename === 'User') continue;
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
    } catch {
      /* DOM evidence remains usable when the local store is unavailable. */
    }
  }
  const buttons = Array.from(dialog?.querySelectorAll('[role="button"],button') ?? []);
  const semantic = (el: Element) => chain(el, 12).find((f) => f.name.includes('FDSButton.react'));
  const primary = buttons
    .map((el, index) => ({ el, index, props: semantic(el)?.props }))
    .filter((b) => b.props?.type === 'primary');
  const close =
    buttons
      .map((el, index) => ({ el, index, frames: chain(el, 12) }))
      .find((b) => b.frames.some((f) => f.name.includes('FDSCircleButton'))) ??
    buttons
      .map((el, index) => ({ el, index, frames: chain(el, 12) }))
      .find((b) =>
        b.frames.some((f) => f.name.includes('FDSButton.react') && f.props.type === 'secondary'),
      );
  const verificationRequired = dialogs
    .filter(visible)
    .some(
      (d) =>
        chain(d).some(
          (f) =>
            f.name.includes('GroupsCometFeatureInterventionDialog') ||
            f.props.testid === 'feature-intervention-ok-button' ||
            (record(f.props.footer) &&
              record(f.props.footer.props) &&
              record(f.props.footer.props.primary) &&
              f.props.footer.props.primary.testid === 'feature-intervention-ok-button'),
        ) ||
        Array.from(d.querySelectorAll('button,[role="button"],h1,h2,[role="heading"]')).some((el) =>
          chain(el, 32).some(
            (f) =>
              f.props.testid === 'feature-intervention-ok-button' ||
              (record(f.props.footer) &&
                record(f.props.footer.props) &&
                record(f.props.footer.props.primary) &&
                f.props.footer.props.primary.testid === 'feature-intervention-ok-button'),
          ),
        ),
    );
  const pageButtons = Array.from(document.querySelectorAll('[role="button"],button'));
  const invite = pageButtons.findIndex(
    (el) =>
      visible(el) &&
      chain(el, 24).some((f) => f.name.includes('GroupsCometHeaderInviteMemberAddButton')),
  );
  const menus = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(visible);
  const menuItems = menus.map((el, index) => ({
    index,
    fingerprint: JSON.stringify(
      chain(el, 20)
        .filter((f) => !/^(div|span|a)$/.test(f.name) && f.name)
        .map((f) => ({
          component: f.name,
          action: typeof f.props.actionType === 'string' ? f.props.actionType : null,
          icon: record(f.props.icon) ? f.props.icon.src : null,
        })),
    ),
  }));
  const primaryButton = primary.length === 1 ? primary[0] : undefined;
  const cookie = document.cookie.match(/(?:^|;\s*)c_user=(\d{5,25})/);
  const scriptId = Array.from(document.scripts)
    .map((s) => s.textContent ?? '')
    .join('\n')
    .match(/"USER_ID":"(\d{5,25})"/);
  return {
    url: location.href,
    accountId: cookie?.[1] ?? scriptId?.[1] ?? null,
    visible: document.visibilityState === 'visible',
    ready: document.readyState !== 'loading',
    dialog: !!dialog,
    dialogIndex: dialog ? dialogs.indexOf(dialog) : undefined,
    dialogLabel: dialog?.getAttribute('aria-label') ?? undefined,
    menu: menus.length > 0,
    menuItems,
    dialogCount: dialogs.filter(visible).length,
    joined: invite >= 0,
    items,
    recipients: [...recipients.values()],
    timeOrigin: performance.timeOrigin,
    verificationRequired,
    sendButton: primaryButton
      ? {
          index: primaryButton.index,
          disabled:
            primaryButton.props?.disabled === true ||
            primaryButton.el.getAttribute('aria-disabled') === 'true',
        }
      : undefined,
    closeButton: close
      ? { index: close.index, disabled: close.el.getAttribute('aria-disabled') === 'true' }
      : undefined,
    inviteButtonIndex: invite >= 0 ? invite : undefined,
    relay,
  };
}
export async function readGroupInvitationState(
  page: Page,
  guard: () => Awaitable<void> = () => {},
): Promise<GroupInvitationState> {
  return readFacebookAcrossNavigation(
    () => page.evaluate(projectGroupInvitationState, inviteDialogSelector),
    guard,
  );
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
) {
  if (!state.ready || !state.visible || state.verificationRequired || state.accountId !== accountId)
    return false;
  const url = new URL(state.url);
  if (url.origin !== 'https://www.facebook.com') return false;
  const atGroup = url.pathname.split('/')[1] === 'groups' && url.pathname.split('/')[2] === groupId;
  if (!atGroup) return false;
  if (label === 'enter-group') return true;
  if (label === 'join-group') return state.joined;
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
