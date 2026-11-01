import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGroupInvitationState } from '../src/infrastructure/group-inviter-effects.js';

interface FakeFiber {
  elementType?: { displayName?: string; name?: string } | string;
  type?: { displayName?: string; name?: string } | string;
  memoizedProps?: Record<string, unknown>;
  pendingProps?: Record<string, unknown>;
  return?: FakeFiber;
}

function buildFiberChain(
  hops: Array<{ name: string; props?: Record<string, unknown> }>,
): FakeFiber | undefined {
  let head: FakeFiber | undefined;
  for (let i = hops.length - 1; i >= 0; i--) {
    const entry = hops[i];
    if (!entry) continue;
    head = {
      type: { displayName: entry.name },
      memoizedProps: entry.props ?? {},
      return: head,
    };
  }
  return head;
}

class FakeElement {
  private readonly attrs = new Map<string, string>();
  public readonly children: FakeElement[] = [];
  public textContent = '';
  constructor(
    public readonly tagName = 'DIV',
    initialAttrs: Record<string, string> = {},
    fiberChain?: FakeFiber,
  ) {
    for (const [k, v] of Object.entries(initialAttrs)) {
      this.attrs.set(k, v);
    }
    if (fiberChain) {
      Reflect.set(this, '__reactFiber$test', fiberChain);
    }
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getBoundingClientRect() {
    return { width: 200, height: 48, top: 0, left: 0, right: 200, bottom: 48 };
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  private matchesSingle(sel: string): boolean {
    const s = sel.trim();
    if (!s) return false;
    if (s === '*') return true;
    if (/^[a-z0-9]+$/i.test(s)) return this.tagName.toLowerCase() === s.toLowerCase();
    const attrRegex = /\[([^\]=]+)(?:="([^"]*)")?\]/g;
    let m: RegExpExecArray | null;
    let matchedAny = false;
    while ((m = attrRegex.exec(s)) !== null) {
      matchedAny = true;
      const attrName = m[1] ?? '';
      const attrVal = m[2];
      const actual = this.attrs.get(attrName);
      if (attrVal === undefined) {
        if (actual === undefined) return false;
      } else if (actual !== attrVal) {
        return false;
      }
    }
    return matchedAny;
  }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesSingle(part));
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

test('WO57: projectGroupInvitationState extracts id and name for both legacy 10-layer CometListCellStrict_DEPRECATED and new 17-layer (hop 16) FDSListCellPressable without role=listitem, while preserving button hop=12 uniqueness', () => {
  const root = new FakeElement('BODY');
  const dialog = root.appendChild(
    new FakeElement('DIV', { role: 'dialog', 'aria-label': '邀请好友加入小组' }),
  );

  // 1. Legacy 10-layer checkbox (hop 8: CometListCellStrict_DEPRECATED, hop 9: GroupsCometInviteFriendsSearchFriendItem.react)
  const legacyHops = Array.from({ length: 10 }, (_, idx) => {
    if (idx === 8) {
      return { name: 'CometListCellStrict_DEPRECATED', props: { headline: 'Legacy Friend Alice' } };
    }
    if (idx === 9) {
      return {
        name: 'GroupsCometInviteFriendsSearchFriendItem.react',
        props: { user$key: { id: '100000111222333' }, isInvited: false, isMember: false },
      };
    }
    return { name: 'div', props: {} };
  });
  dialog.appendChild(
    new FakeElement(
      'DIV',
      { role: 'checkbox', 'aria-checked': 'false' },
      buildFiberChain(legacyHops),
    ),
  );

  // 2. New 17-layer checkbox (hop 15: FDSListCellPressable.react, hop 16: GroupsCometInviteFriendsSearchFriendItem.react), NO role="listitem"
  const newHops = Array.from({ length: 18 }, (_, idx) => {
    if (idx === 15) {
      return {
        name: 'FDSListCellPressable.react',
        props: { 'aria-label': 'New Friend Bob' },
      };
    }
    if (idx === 16) {
      return {
        name: 'GroupsCometInviteFriendsSearchFriendItem.react',
        props: { user$key: { id: '61550099988877' }, isInvited: false, isMember: false },
      };
    }
    return { name: 'div', props: {} };
  });
  dialog.appendChild(
    new FakeElement('DIV', { role: 'checkbox', 'aria-checked': 'false' }, buildFiberChain(newHops)),
  );

  // 3. New 17-layer disabled invited element (no role="listitem" or role="row", only aria-disabled="true")
  const invitedHops = Array.from({ length: 18 }, (_, idx) => {
    if (idx === 15) {
      return {
        name: 'FDSListCellPressable.react',
        props: { 'aria-label': 'Already Invited Carol' },
      };
    }
    if (idx === 16) {
      return {
        name: 'GroupsCometInviteFriendsSearchFriendItem.react',
        props: { user$key: { id: '61550011122299' }, isInvited: true, isMember: false },
      };
    }
    return { name: 'div', props: {} };
  });
  dialog.appendChild(
    new FakeElement(
      'DIV',
      { role: 'checkbox', 'aria-checked': 'true', 'aria-disabled': 'true' },
      buildFiberChain(invitedHops),
    ),
  );

  // 4. Primary Send button at hop 4 + Close button at hop 3
  const sendBtnHops = Array.from({ length: 6 }, (_, idx) =>
    idx === 4
      ? { name: 'FDSButton.react', props: { type: 'primary', disabled: false } }
      : { name: 'div', props: {} },
  );
  dialog.appendChild(new FakeElement('DIV', { role: 'button' }, buildFiberChain(sendBtnHops)));

  // Inner button whose FDSButton.react is at hop 15 (> 12) must NOT match semantic(el) with chain(el, 12)
  const deepInnerButtonHops = Array.from({ length: 17 }, (_, idx) =>
    idx === 15
      ? { name: 'FDSButton.react', props: { type: 'primary', disabled: false } }
      : { name: 'span', props: {} },
  );
  dialog.appendChild(
    new FakeElement('DIV', { role: 'button' }, buildFiberChain(deepInnerButtonHops)),
  );

  const closeBtnHops = Array.from({ length: 5 }, (_, idx) =>
    idx === 3 ? { name: 'FDSCircleButton.react', props: {} } : { name: 'div', props: {} },
  );
  dialog.appendChild(new FakeElement('DIV', { role: 'button' }, buildFiberChain(closeBtnHops)));

  const prevDoc = Reflect.get(globalThis, 'document');
  const prevWin = Reflect.get(globalThis, 'window');
  const prevLoc = Reflect.get(globalThis, 'location');
  const prevComp = Reflect.get(globalThis, 'getComputedStyle');

  Reflect.set(globalThis, 'document', {
    cookie: 'c_user=100088889999000',
    visibilityState: 'visible',
    readyState: 'complete',
    scripts: [],
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
  });
  Reflect.set(globalThis, 'window', {});
  Reflect.set(globalThis, 'location', {
    href: 'https://www.facebook.com/groups/3017439278594998/',
    pathname: '/groups/3017439278594998/',
  });
  Reflect.set(globalThis, 'getComputedStyle', () => ({
    visibility: 'visible',
    display: 'block',
  }));

  try {
    const state = projectGroupInvitationState();
    assert.equal(state.dialog, true);
    assert.equal(state.items.length, 3);
    assert.deepEqual(
      state.items.map((item) => ({
        id: item.id,
        name: item.name,
        invited: item.invited,
        disabled: item.disabled,
      })),
      [
        {
          id: '100000111222333',
          name: 'Legacy Friend Alice',
          invited: false,
          disabled: false,
        },
        {
          id: '61550099988877',
          name: 'New Friend Bob',
          invited: false,
          disabled: false,
        },
        {
          id: '61550011122299',
          name: 'Already Invited Carol',
          invited: true,
          disabled: true,
        },
      ],
    );
    assert.equal(state.recipients?.length, 1);
    assert.equal(state.recipients?.[0]?.id, '61550011122299');
    assert.equal(state.recipients?.[0]?.invited, true);
    assert.deepEqual(state.sendButton, { index: 0, disabled: false });
    assert.deepEqual(state.closeButton, { index: 2, disabled: false });
  } finally {
    Reflect.set(globalThis, 'document', prevDoc);
    Reflect.set(globalThis, 'window', prevWin);
    Reflect.set(globalThis, 'location', prevLoc);
    Reflect.set(globalThis, 'getComputedStyle', prevComp);
  }
});
