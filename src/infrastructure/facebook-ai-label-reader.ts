import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import {
  facebookAILabelReading,
  facebookAILabelScope,
  facebookAILabelSwitch,
} from '../shared/facebook-post-options.js';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
function projectAILabelEntry(
  createRt: typeof createDomEvalRuntime,
  _input: { scope: string; switchCSS: string },
) {
  const { record, visible, enabled, chain, clearDataAttrs } = createRt();
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
  clearDataAttrs([
    'data-wb-ai-label-scope',
    'data-wb-ai-label-open',
    'data-wb-ai-label-switch',
    'data-wb-ai-label-confirm',
  ]);
  if (location.origin !== 'https://www.facebook.com') return { ...base, phase: 'absent' as const };
  const vis = (el: Element) => visible(el, { noAriaHidden: true });
  const cachedFrames = new WeakMap<Element, ReturnType<typeof chain>>();
  const frames = (el: Element, fresh = false) => {
    const cached = cachedFrames.get(el);
    if (cached && !fresh) return cached;
    const out = chain(el, 140, { fresh, includeRenderDisplayName: true });
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
    while (root && !elements.every((el) => root?.contains(el))) root = root.parentElement;
    if (root) root.setAttribute('data-wb-ai-label-scope', '1');
    return root;
  };
  const switches = Array.from(document.querySelectorAll('[role="switch"]')).filter(vis);
  const buttons = Array.from(document.querySelectorAll('[role="button"],button')).filter(vis);
  const settingsSwitches = switches.filter(inSettings);
  const confirms = buttons.filter(
    (el) =>
      frames(el).some((f) => f.props.testid === 'gen-ai-label-push-page-footer') && inSettings(el),
  );
  const valueOf = (toggle: Element) => {
    const checked = toggle.getAttribute('aria-checked');
    return checked === 'true' || checked === 'false' ? checked === 'true' : null;
  };
  if (settingsSwitches.length || confirms.length) {
    const toggle = settingsSwitches[0];
    const confirm = confirms[0];
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
  const drafts = Array.from(document.querySelectorAll('[role="dialog"],[role="main"]'))
    .filter(vis)
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
// Native editor state, not translated labels or the position of a switch.
export const projectFacebookAILabel = serializeDomEval<
  (input: { scope: string; switchCSS: string }) => ReturnType<typeof projectAILabelEntry>
>('projectFacebookAILabel', projectAILabelEntry);
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
