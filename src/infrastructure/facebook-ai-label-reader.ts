import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import {
  facebookAILabelReading,
  facebookAILabelScope,
  facebookAILabelSwitch,
} from '../shared/facebook-ai-label.js';

// Native editor state, not translated labels or the position of a switch.
export function projectFacebookAILabel(_input: { scope: string; switchCSS: string }) {
  type RecordValue = Record<string, unknown>;
  const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object';
  const base = {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState !== 'loading',
    visible: document.visibilityState === 'visible',
    value: null as boolean | null,
    openCSS: null as string | null,
    switchEnabled: false,
    confirmEnabled: false,
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      !el.closest('[aria-hidden="true"]')
    );
  };
  const enabled = (el: Element) => !el.matches('[aria-disabled="true"],:disabled');
  const attrs = [
    'data-wb-ai-label-scope',
    'data-wb-ai-label-open',
    'data-wb-ai-label-switch',
    'data-wb-ai-label-confirm',
  ];
  for (const el of Array.from(document.querySelectorAll(attrs.map((a) => '[' + a + ']').join(','))))
    for (const attr of attrs) el.removeAttribute(attr);
  if (location.origin !== 'https://www.facebook.com') return { ...base, phase: 'absent' as const };

  const cacheHost = window as unknown as { __wbReactRootNodesV1?: WeakMap<Element, RecordValue> };
  const rootNodes = (cacheHost.__wbReactRootNodesV1 ??= new WeakMap<Element, RecordValue>());
  let scanned = false;
  const current = (node: RecordValue | undefined) => {
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
  const fiber = (el: Element, fresh = false) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (key && !fresh) {
      const node: unknown = Reflect.get(el, key);
      if (record(node)) return current(node) ?? node;
    }
    const cached = current(rootNodes.get(el));
    if (cached && !fresh) return cached;
    if (!scanned) {
      scanned = true;
      const stack: unknown[] = [],
        seen = new Set<unknown>();
      for (const host of Array.from(document.querySelectorAll('*')))
        for (const key of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const r: unknown = Reflect.get(host, key);
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
    const node = current(rootNodes.get(el)) ?? rootNodes.get(el);
    if (node) return node;
    const direct: unknown = key ? Reflect.get(el, key) : undefined;
    return record(direct) ? direct : undefined;
  };
  const cachedFrames = new WeakMap<Element, { name: string; props: RecordValue }[]>();
  const frames = (el: Element, fresh = false) => {
    const cached = cachedFrames.get(el);
    if (cached && !fresh) return cached;
    const out: { name: string; props: RecordValue }[] = [];
    let f: unknown = fiber(el, fresh);
    for (let i = 0; record(f) && i < 140; i++, f = f.return) {
      const t = f.type ?? f.elementType;
      const name =
        typeof t === 'function'
          ? String(Reflect.get(t, 'displayName') ?? t.name)
          : record(t)
            ? String(t.displayName ?? (record(t.render) ? t.render.displayName : '') ?? '')
            : typeof t === 'string'
              ? t
              : '';
      out.push({ name, props: record(f.memoizedProps) ? f.memoizedProps : {} });
    }
    cachedFrames.set(el, out);
    return out;
  };
  const fragment = (value: unknown, name: string) =>
    record(value) && record(value.__fragments) && Object.hasOwn(value.__fragments, name);
  const inSettings = (el: Element) =>
    frames(el).some((f) => f.name.includes('CometComposerGenAILabelSelector.react'));
  const isCreator = (el: Element) =>
    frames(el).some((f) => fragment(f.props.option, 'CometCreatorComposerGenAILabelOption_option'));
  const isStory = (el: Element) =>
    frames(el).some((f) => fragment(f.props.viewer, 'StoriesCometGenAILabelSelector_viewer'));
  const scope = (elements: Element[]) => {
    let root: Element | null = elements[0] ?? null;
    while (root) {
      const candidate = root;
      if (elements.every((el) => candidate.contains(el))) break;
      root = root.parentElement;
    }
    if (root) root.setAttribute('data-wb-ai-label-scope', '1');
    return root;
  };
  const switches = Array.from(document.querySelectorAll('[role="switch"]')).filter(visible);
  const buttons = Array.from(document.querySelectorAll('[role="button"],button')).filter(visible);
  const settingsSwitches = switches.filter(inSettings);
  const confirms = buttons.filter(
    (el) =>
      frames(el).some((f) => f.props.testid === 'gen-ai-label-push-page-footer') && inSettings(el),
  );
  const valueOf = (toggle: Element) => {
    const checked = toggle.getAttribute('aria-checked');
    if (checked !== 'true' && checked !== 'false') return null;
    // React may keep old child props after committing the new native switch attribute.
    // The identified live AI control is the source for its current displayed state.
    return checked === 'true';
  };
  if (settingsSwitches.length || confirms.length) {
    const toggle = settingsSwitches[0],
      confirm = confirms[0];
    if (settingsSwitches.length !== 1 || confirms.length !== 1 || !toggle || !confirm)
      return { ...base, phase: 'ambiguous' as const };
    const value = valueOf(toggle);
    if (value === null || !scope([toggle, confirm]))
      return { ...base, phase: 'ambiguous' as const };
    toggle.setAttribute('data-wb-ai-label-switch', '1');
    confirm.setAttribute('data-wb-ai-label-confirm', '1');
    return {
      ...base,
      phase: 'settings' as const,
      mode: 'dialog' as const,
      value,
      switchEnabled: enabled(toggle),
      confirmEnabled: enabled(confirm),
    };
  }
  // The current editor context outranks old props retained in a child component.
  const draftValue = (el: Element, story: boolean) => {
    const field = story ? 'genAISelfDisclosureData' : 'genAISelfDisclosureMetadata';
    for (const f of frames(el, true)) {
      const context = f.props.value;
      if (!record(context) || !Object.hasOwn(context, field)) continue;
      const metadata = context[field];
      if (record(metadata) && typeof metadata.isSelfDisclosedAsGenAI === 'boolean')
        return metadata.isSelfDisclosedAsGenAI;
    }
    return null;
  };
  const inline = switches.filter((el) => isCreator(el) || isStory(el));
  if (inline.length) {
    const toggle = inline[0];
    if (inline.length !== 1 || !toggle) return { ...base, phase: 'ambiguous' as const };
    const value = valueOf(toggle);
    if (value === null) return { ...base, phase: 'ambiguous' as const };
    scope([toggle.parentElement ?? toggle]);
    toggle.setAttribute('data-wb-ai-label-switch', '1');
    return {
      ...base,
      phase: 'composer' as const,
      mode: 'inline' as const,
      value,
      switchEnabled: enabled(toggle),
    };
  }
  const openers = buttons.filter((el) =>
    frames(el).some((f) => Object.hasOwn(f.props, 'cometComposerGenAILabelSelector_viewer$key')),
  );
  if (openers.length) {
    const opener = openers[0];
    if (openers.length !== 1 || !opener) return { ...base, phase: 'ambiguous' as const };
    let value = draftValue(opener, false);
    if (value === null) {
      const owner = frames(opener).find(
        (f) =>
          Object.hasOwn(f.props, 'cometComposerGenAILabelSelector_viewer$key') &&
          Object.hasOwn(f.props, 'genAISelfDisclosureMetadata'),
      );
      const metadata = owner?.props.genAISelfDisclosureMetadata;
      if (
        owner &&
        (metadata == null ||
          (record(metadata) && typeof metadata.isSelfDisclosedAsGenAI === 'boolean'))
      )
        value = record(metadata) ? (metadata.isSelfDisclosedAsGenAI as boolean) : false;
    }
    if (value === null) return { ...base, phase: 'ambiguous' as const };
    scope([opener.parentElement ?? opener]);
    opener.setAttribute('data-wb-ai-label-open', '1');
    return {
      ...base,
      phase: 'composer' as const,
      mode: 'dialog' as const,
      value,
      openCSS: enabled(opener) ? '[role="button"][data-wb-ai-label-open="1"]' : null,
    };
  }
  // A later native review stage may retain the explicit draft setting without a control.
  const drafts = Array.from(document.querySelectorAll('[role="dialog"],[role="main"]'))
    .filter(visible)
    .filter((el) => frames(el).some((f) => f.name.includes('CometComposer')))
    .map((el) => ({ el, value: draftValue(el, false) }))
    .filter((row) => row.value !== null);
  const first = drafts[0];
  if (first && new Set(drafts.map((row) => row.value)).size === 1) {
    scope([first.el]);
    return { ...base, phase: 'composer' as const, value: first.value };
  }
  return { ...base, phase: drafts.length ? ('ambiguous' as const) : ('absent' as const) };
}
export async function readFacebookAILabel(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const result = facebookAILabelReading.parse(
    await page.evaluate(projectFacebookAILabel, {
      scope: facebookAILabelScope,
      switchCSS: facebookAILabelSwitch,
    }),
  );
  await guard();
  return result;
}
