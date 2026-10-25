import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import {
  FacebookBackground,
  nativeSolidBackgrounds,
  FACEBOOK_BACKGROUND_OPTIONS,
  FACEBOOK_NO_BACKGROUND,
  facebookBackgroundScope,
} from '../shared/facebook-background.js';

export function projectFacebookBackground(input: {
  scope: string;
  openCSS: string;
  clearCSS: string;
  solids: readonly { id: 'red' | 'purple' | 'black'; label: string; color: string }[];
}) {
  type DOMRecord = Record<string, unknown>;
  const record = (v: unknown): v is DOMRecord => !!v && typeof v === 'object';
  let rootNodes: Map<Element, DOMRecord> | undefined;
  const fiberNode = (el: Element) => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (key) return Reflect.get(el, key) as unknown;
    if (!rootNodes) {
      rootNodes = new Map();
      const stack: unknown[] = [],
        seen = new Set<unknown>();
      for (const host of Array.from(document.querySelectorAll('*')))
        for (const k of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const r: unknown = Reflect.get(host, k);
          stack.push(record(r) && record(r.stateNode) ? (r.stateNode.current ?? r) : r);
        }
      while (stack.length && seen.size < 100000) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootNodes.set(f.stateNode, f);
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return rootNodes.get(el);
  };
  const frames = (el: Element, limit = 40) => {
    const out: { name: string; props: DOMRecord }[] = [];
    let f: unknown = fiberNode(el);
    for (let i = 0; record(f) && i < limit; i++, f = f.return) {
      const t = f.type ?? f.elementType;
      const name =
        typeof t === 'function'
          ? String(Reflect.get(t, 'displayName') ?? t.name)
          : record(t)
            ? String(t.displayName ?? '')
            : typeof t === 'string'
              ? t
              : '';
      out.push({ name, props: record(f.memoizedProps) ? f.memoizedProps : {} });
    }
    return out;
  };
  const visible = (node: Element) => {
    const r = node.getBoundingClientRect(),
      s = getComputedStyle(node);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth &&
      s.display !== 'none' &&
      s.visibility !== 'hidden'
    );
  };
  const base = {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState !== 'loading',
    visible: document.visibilityState === 'visible',
    draftEmpty: false,
    openCSS: null as string | null,
    clearCSS: null as string | null,
    selectedCSS: null as string | null,
    options: [] as { id: 'red' | 'purple' | 'black'; css: string }[],
  };
  if (location.origin !== 'https://www.facebook.com') return { ...base, phase: 'absent' as const };
  const roots = Array.from(document.querySelectorAll(input.scope)).filter(visible);
  if (roots.length !== 1 || !roots[0])
    return { ...base, phase: roots.length ? ('ambiguous' as const) : ('absent' as const) };
  const root = roots[0],
    edits = Array.from(root.querySelectorAll('[role="textbox"][contenteditable="true"]')).filter(
      visible,
    );
  if (edits.length !== 1 || !edits[0] || !base.ready)
    return { ...base, phase: 'ambiguous' as const };
  base.draftEmpty = (edits[0].textContent ?? '') === '' && !edits[0].querySelector('img,video,a');
  const control = (css: string) => {
    const matches = Array.from(root.querySelectorAll(css)).filter(
      (node) => visible(node) && !node.matches('[aria-disabled="true"],:disabled'),
    );
    return matches.length === 1;
  };
  for (const el of Array.from(
    root.querySelectorAll(
      '[data-wb-background-open],[data-wb-background-clear],[data-wb-background]',
    ),
  )) {
    el.removeAttribute('data-wb-background-open');
    el.removeAttribute('data-wb-background-clear');
    el.removeAttribute('data-wb-background');
  }
  const buttons = Array.from(root.querySelectorAll('[role="button"],button')).filter(visible);
  const native = (el: Element) =>
    frames(el, 50).some((f) =>
      f.name.includes('FeedComposerCometStatusAreaClickHandlerForLexical.react'),
    );
  const opening = buttons.filter(
    (el) =>
      native(el) &&
      ['Show background options', '显示背景选项', '顯示背景選項'].includes(
        el.getAttribute('aria-label') ?? '',
      ),
  );
  const clear = buttons.filter(
    (el) =>
      native(el) &&
      ['No background', '无背景', '無背景'].includes(el.getAttribute('aria-label') ?? ''),
  );
  if (opening.length === 1) opening[0]?.setAttribute('data-wb-background-open', '1');
  if (clear.length === 1) clear[0]?.setAttribute('data-wb-background-clear', '1');
  base.openCSS = control(input.openCSS) ? input.openCSS : null;
  base.clearCSS = control(input.clearCSS) ? input.clearCSS : null;
  for (const solid of input.solids) {
    const candidates = buttons.filter(
      (el) =>
        native(el) &&
        [el, ...Array.from(el.children)].some((node) => {
          const style = getComputedStyle(node);
          return style.backgroundColor === solid.color && style.backgroundImage === 'none';
        }),
    );
    if (candidates.length === 1) candidates[0]?.setAttribute('data-wb-background', solid.id);
    const css = '[data-wb-background="' + solid.id + '"]';
    if (control(css)) base.options.push({ id: solid.id, css });
  }
  let node: Element | null = edits[0],
    phase: 'plain' | 'solid' | 'unsupported' = 'plain';
  for (let level = 0; node && node !== root && level < 12; level++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const style = getComputedStyle(node),
      solid = input.solids.find((value) => value.color === style.backgroundColor);
    if (solid && style.backgroundImage === 'none') {
      phase = 'solid';
      base.selectedCSS = '[data-wb-background="' + solid.id + '"]';
      break;
    }
    if (
      style.backgroundImage !== 'none' ||
      !['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(style.backgroundColor)
    )
      phase = 'unsupported';
  }
  return { ...base, phase };
}

export async function readFacebookBackground(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const result = FacebookBackground.parse(
    await page.evaluate(projectFacebookBackground, {
      scope: facebookBackgroundScope,
      openCSS: FACEBOOK_BACKGROUND_OPTIONS,
      clearCSS: FACEBOOK_NO_BACKGROUND,
      solids: nativeSolidBackgrounds,
    }),
  );
  await guard();
  return result;
}
