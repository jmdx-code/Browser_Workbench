import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { ComposerAudienceReading } from '../shared/facebook-audience.js';

// Only observed editor/menu structures. This cannot read cookies or change default privacy.
export function projectFacebookComposerAudience() {
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

  const visible = (e: Element) => {
    const r = e.getBoundingClientRect(),
      s = getComputedStyle(e);
    return (
      r.width > 0 &&
      r.height > 0 &&
      !e.closest('[aria-hidden="true"]') &&
      s.visibility !== 'hidden' &&
      s.display !== 'none'
    );
  };
  const enabled = (e: Element) =>
    e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('disabled');
  for (const el of Array.from(
    document.querySelectorAll(
      '[data-wb-audience-open],[data-wb-audience-menu],[data-wb-audience-group],[data-wb-audience-self],[data-wb-audience-done]',
    ),
  ))
    for (const attr of Array.from(el.attributes).filter((a) =>
      a.name.startsWith('data-wb-audience-'),
    ))
      el.removeAttribute(attr.name);
  const editors = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  ).filter(visible);
  const root = editors.length === 1 ? editors[0] : undefined;
  const boxes = Array.from(
    root?.querySelectorAll('form [role="textbox"][contenteditable="true"]') || [],
  );
  const draftEmpty =
    boxes.length === 1 && boxes[0]?.textContent === '' && !boxes[0]?.querySelector('img,video,a');
  const box = boxes[0];
  const groups = Array.from(
    document.querySelectorAll('[role="radiogroup"][aria-label="Select audience"]'),
  ).filter(visible);
  const group = groups.length === 1 ? groups[0] : undefined;
  const menu = group?.closest('[role="dialog"]');
  const menus = Array.from(
    document.querySelectorAll(
      '[role="dialog"]:has([role="radiogroup"][aria-label="Select audience"])',
    ),
  ).filter(visible);
  let phase: 'COMPOSER' | 'MENU' | 'UNAVAILABLE' = 'UNAVAILABLE';
  let audience: 'SELF' | null = null,
    openEnabled = false,
    selfSelected = false,
    selfEnabled = false,
    defaultChecked: boolean | null = null,
    confirmEnabled = false;
  if (root && group && menu === root && menus.length === 1 && draftEmpty) {
    const headings = Array.from(menu.querySelectorAll('h2')).filter(
      (e) => visible(e) && e.textContent === 'Post audience',
    );
    const self = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
      (e) =>
        e.labels?.length === 1 &&
        e.labels[0]?.textContent?.trim() === 'Only me' &&
        visible(e.labels[0]),
    );
    const defaults = Array.from(
      menu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter(
      (e) =>
        e.labels?.length === 1 &&
        e.labels[0]?.textContent?.trim() === 'Set as default audience.' &&
        visible(e.labels[0]),
    );
    const done = Array.from(
      menu.querySelectorAll(
        '[role="button"]:is([aria-label="Done with privacy audience selection and close dialog"],[aria-label="Done"])',
      ),
    ).filter(visible);
    const selfControl = self[0],
      defaultControl = defaults[0],
      doneControl = done[0];
    if (
      headings.length === 1 &&
      self.length === 1 &&
      defaults.length === 1 &&
      done.length === 1 &&
      selfControl &&
      defaultControl &&
      doneControl
    ) {
      phase = 'MENU';
      selfSelected = selfControl.checked;
      selfEnabled = enabled(selfControl);
      defaultChecked = defaultControl.checked;
      confirmEnabled = enabled(doneControl);
    }
  } else if (root && boxes.length === 1 && box && visible(box) && groups.length === 0) {
    const controls = Array.from(
      root.querySelectorAll(
        '[role="button"][aria-label^="Edit privacy. Sharing with "],[role="button"][aria-label^="编辑隐私设置。分享对象："]',
      ),
    ).filter(visible);
    const control = controls[0];
    if (controls.length === 1 && control) {
      const label = control.getAttribute('aria-label')?.trim(),
        text = control.textContent?.trim();
      phase = 'COMPOSER';
      if (
        enabled(control) &&
        ((label === 'Edit privacy. Sharing with Only me.' && text === 'Only me') ||
          (label === '编辑隐私设置。分享对象：仅限自己。' && text === '仅限自己'))
      )
        audience = 'SELF';
      openEnabled =
        draftEmpty &&
        enabled(control) &&
        !!text &&
        label === 'Edit privacy. Sharing with ' + text + '.';
    }
  }
  const nativeOpen = Array.from(root?.querySelectorAll('[role="button"],button') ?? []).filter(
    (el) =>
      visible(el) &&
      frames(el, 30).some((f) => f.name.includes('CometComposerPrivacySelectorButton.react')),
  );
  const selfOption = (el: Element) => {
    const chain = frames(el, 50);
    return (
      chain.some((f) => f.name.includes('CometPrivacySelectorOptionBasic.react')) &&
      chain.some((f) => {
        const option = f.props.option;
        return (
          f.name.includes('CometPrivacySelectorOption.react') &&
          record(option) &&
          option.post_param === '286958161406148'
        );
      })
    );
  };
  const nativeMenus = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
    (el) =>
      visible(el) &&
      Array.from(el.querySelectorAll('input[type="radio"]')).filter(selfOption).length === 1,
  );
  const leafMenus = nativeMenus.filter(
    (el) => !nativeMenus.some((child) => child !== el && el.contains(child)),
  );
  if (root && draftEmpty && leafMenus.length === 1 && leafMenus[0]) {
    const menu = leafMenus[0],
      self = Array.from(menu.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find(
        selfOption,
      );
    const group = self?.closest('[role="radiogroup"]') ?? menu;
    const defaults = Array.from(
      menu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((el) => el.value === 'default_privacy_checkbox');
    const done = Array.from(menu.querySelectorAll('[role="button"],button')).filter(
      (el) =>
        visible(el) &&
        frames(el, 20).some(
          (f) =>
            f.name.includes('FDSButton.react') &&
            f.props.type !== 'secondary' &&
            f.props.variant !== 'secondary',
        ),
    );
    if (self && defaults.length === 1 && defaults[0] && done.length === 1 && done[0]) {
      menu.setAttribute('data-wb-audience-menu', '1');
      group.setAttribute('data-wb-audience-group', '1');
      (self.labels?.[0] ?? self).setAttribute('data-wb-audience-self', '1');
      done[0].setAttribute('data-wb-audience-done', '1');
      phase = 'MENU';
      selfSelected = self.checked;
      selfEnabled = enabled(self);
      defaultChecked = defaults[0].checked;
      confirmEnabled = enabled(done[0]);
      openEnabled = false;
      audience = null;
    }
  } else if (root && nativeOpen.length === 1 && nativeOpen[0] && leafMenus.length === 0) {
    const control = nativeOpen[0];
    control.setAttribute('data-wb-audience-open', '1');
    const scope = frames(control, 30).find((f) =>
      f.name.includes('CometComposerPrivacySelectorButton.react'),
    )?.props.scope;
    phase = 'COMPOSER';
    openEnabled = draftEmpty && enabled(control);
    audience =
      record(scope) &&
      record(scope.selected_option) &&
      scope.selected_option.post_param === '286958161406148'
        ? 'SELF'
        : null;
  }
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    phase,
    audience,
    draftEmpty,
    openEnabled,
    selfSelected,
    selfEnabled,
    defaultChecked,
    confirmEnabled,
  };
}
export async function readFacebookComposerAudience(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const reading = ComposerAudienceReading.parse(
    await page.evaluate(projectFacebookComposerAudience),
  );
  await guard();
  if (new URL(reading.url).origin !== 'https://www.facebook.com')
    throw Error('POST_AUDIENCE_ORIGIN_REJECTED');
  return reading;
}
