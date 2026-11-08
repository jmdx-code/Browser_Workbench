import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { ComposerAudienceReading } from '../shared/facebook-audience.js';

// Only observed editor/menu structures. This cannot read cookies or change default privacy.
export function projectFacebookComposerAudience() {
  type DOMRecord = Record<string, unknown>;
  const record = (v: unknown): v is DOMRecord => !!v && typeof v === 'object';
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbReactRootNodesV1?: WeakMap<Element, DOMRecord>;
  };
  const rootNodes = (cacheHost.__wbReactRootNodesV1 ??= new WeakMap<Element, DOMRecord>());
  let rootScanned = false;
  const currentRootNode = (node: DOMRecord | undefined): DOMRecord | undefined => {
    for (const candidate of [node, record(node?.alternate) ? node.alternate : undefined]) {
      let root: unknown = candidate;
      for (let depth = 0; record(root) && depth < 256; depth++) {
        if (!root.return) {
          if (record(root.stateNode) && root.stateNode.current === root) return candidate;
          break;
        }
        root = root.return;
      }
    }
    return undefined;
  };
  const fiberNode = (el: Element, fresh = false) => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (key && !fresh) return Reflect.get(el, key) as unknown;
    const cached = currentRootNode(rootNodes.get(el));
    if (cached && !fresh) {
      rootNodes.set(el, cached);
      return cached;
    }
    if (!rootScanned) {
      rootScanned = true;
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
    return rootNodes.get(el) ?? (key ? Reflect.get(el, key) : undefined);
  };
  const frames = (el: Element, limit = 128, fresh = false) => {
    const out: { name: string; props: DOMRecord }[] = [];
    let f: unknown = fiberNode(el, fresh);
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
      '[data-wb-audience-open],[data-wb-audience-menu],[data-wb-audience-group],[data-wb-audience-self],[data-wb-audience-done],[data-wb-audience-default],[data-wb-audience-composer]',
    ),
  ))
    for (const attr of Array.from(el.attributes).filter((a) =>
      a.name.startsWith('data-wb-audience-'),
    ))
      el.removeAttribute(attr.name);
  const allEditors = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  );
  const editors = allEditors.filter(visible);
  const fullEditors = /^\/post\/create\/?$/.test(location.pathname)
    ? Array.from(
        document.querySelectorAll(
          '[role="main"]:has(form [role="textbox"][contenteditable="true"])',
        ),
      ).filter(visible)
    : [];
  const editorRoots = editors.length
    ? editors
    : fullEditors.filter((el) => !fullEditors.some((child) => child !== el && el.contains(child)));
  let root = editorRoots.length === 1 ? editorRoots[0] : undefined;
  root?.setAttribute('data-wb-audience-composer', '1');
  let boxes = Array.from(
    root?.querySelectorAll('form [role="textbox"][contenteditable="true"]') || [],
  );
  let draftEmpty =
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
      menu.setAttribute('data-wb-audience-menu', '1');
      group.setAttribute('data-wb-audience-group', '1');
      (selfControl.labels?.[0] ?? selfControl).setAttribute('data-wb-audience-self', '1');
      (defaultControl.labels?.[0] ?? defaultControl).setAttribute('data-wb-audience-default', '1');
      doneControl.setAttribute('data-wb-audience-done', '1');
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
      frames(el).some((f) =>
        /CometComposerPrivacySelectorButton\.react|CometCreatorComposerPrivacySelectorEntryPointButton\.react/.test(
          f.name,
        ),
      ),
  );
  const optionFrames = (el: Element) => frames(el);
  const selfOption = (el: Element) => {
    const chain = optionFrames(el);
    return (
      chain.some((f) => f.name.includes('CometPrivacySelectorOptionBasic.react')) &&
      chain.some(
        (f) =>
          f.name.includes('CometPrivacySelectorOption.react') &&
          record(f.props.option) &&
          f.props.option.post_param === '286958161406148' &&
          (f.props.option.info_type === undefined || f.props.option.info_type === 'BASIC'),
      )
    );
  };
  const nativeMenus = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
    (el) =>
      visible(el) &&
      Array.from(el.querySelectorAll('input[type="radio"]')).some(
        (radio) =>
          visible((radio as HTMLInputElement).labels?.[0] ?? radio) &&
          optionFrames(radio).some((f) => f.name.includes('CometPrivacySelectorOption.react')),
      ),
  );
  const leafMenus = nativeMenus.filter(
    (el) => !nativeMenus.some((child) => child !== el && el.contains(child)),
  );
  // Native modal privacy can aria-hide the unchanged composer behind it. Read that
  // sole draft, but only the visible native privacy dialog supplies action targets.
  if (!root && leafMenus.length === 1 && allEditors.length === 1) {
    root = allEditors[0];
    root?.setAttribute('data-wb-audience-composer', '1');
    boxes = Array.from(
      root?.querySelectorAll('form [role="textbox"][contenteditable="true"]') ?? [],
    );
    draftEmpty =
      boxes.length === 1 && boxes[0]?.textContent === '' && !boxes[0]?.querySelector('img,video,a');
  }
  let selfAvailable: boolean | undefined;
  if (root && draftEmpty && leafMenus.length === 1 && leafMenus[0]) {
    const menu = leafMenus[0];
    const selfRows = Array.from(
      menu.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ).filter((el) => visible(el.labels?.[0] ?? el) && selfOption(el));
    const self = selfRows.length === 1 ? selfRows[0] : undefined;
    const group = self?.closest('[role="radiogroup"]') ?? menu;
    const defaults = Array.from(
      menu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter(
      (el) =>
        el.value === 'default_privacy_checkbox' ||
        frames(el).some((f) => f.name.includes('CometDefaultPrivacySelectorPickerFooter.react')),
    );
    const done = Array.from(menu.querySelectorAll('[role="button"],button')).filter(
      (el) =>
        visible(el) &&
        frames(el, 32).some(
          (f) =>
            f.name.includes('FDSButton.react') &&
            f.props.type !== 'secondary' &&
            f.props.variant !== 'secondary',
        ),
    );
    const footer =
      done.length === 1 && done[0]
        ? frames(done[0]).find((f) => f.name.includes('CometPrivacySelectorPickerFooter.react'))
            ?.props
        : undefined;
    menu.setAttribute('data-wb-audience-menu', '1');
    group.setAttribute('data-wb-audience-group', '1');
    (self?.labels?.[0] ?? self)?.setAttribute('data-wb-audience-self', '1');
    if (defaults.length === 1 && defaults[0])
      (defaults[0].labels?.[0] ?? defaults[0]).setAttribute('data-wb-audience-default', '1');
    if (done.length === 1) done[0]?.setAttribute('data-wb-audience-done', '1');
    phase = 'MENU';
    selfAvailable = selfRows.length === 1;
    selfSelected = self?.checked === true;
    selfEnabled = !!self && enabled(self);
    defaultChecked =
      defaults.length === 1 && defaults[0]
        ? defaults[0].checked
        : footer?.showsDefaultAudienceCheckbox === false
          ? false
          : null;
    confirmEnabled = done.length === 1 && !!done[0] && enabled(done[0]);
    openEnabled = false;
    audience = null;
  } else if (root && nativeOpen.length === 1 && nativeOpen[0] && leafMenus.length === 0) {
    const control = nativeOpen[0],
      chain = frames(control, 128, true);
    control.setAttribute('data-wb-audience-open', '1');
    // Read the current draft privacy, never an initial-state value from an outer composer.
    const isPrivacy = (v: unknown) => record(v) && typeof v.base_state === 'string';
    const draft = chain
      .map((f) => {
        const value = f.props.value;
        return f.name.includes('CometComposerViewStateContext') &&
          record(value) &&
          record(value.audience)
          ? value.audience.privacy
          : undefined;
      })
      .find(isPrivacy);
    // Entry-point privacyRowInput can intentionally remain EVERYONE while the
    // current draft and localPrivacyRow have already been saved as SELF.
    const privacy =
      draft ??
      chain.map((f) => f.props.localPrivacyRow).find(isPrivacy) ??
      chain.map((f) => f.props.privacyRowInput).find(isPrivacy);
    phase = 'COMPOSER';
    openEnabled = draftEmpty && enabled(control);
    audience =
      enabled(control) &&
      record(privacy) &&
      privacy.base_state === 'SELF' &&
      Array.isArray(privacy.allow) &&
      privacy.allow.length === 0 &&
      Array.isArray(privacy.deny) &&
      privacy.deny.length === 0
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
    ...(selfAvailable === undefined ? {} : { selfAvailable }),
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
