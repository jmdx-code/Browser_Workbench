import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import {
  FacebookBackground,
  nativeSolidBackgrounds,
  FACEBOOK_BACKGROUND_OPTIONS,
  FACEBOOK_NO_BACKGROUND,
  facebookBackgroundScope,
} from '../shared/facebook-post-options.js';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
interface BackgroundInput {
  scope: string;
  openCSS: string;
  clearCSS: string;
  solids: readonly { id: 'red' | 'purple' | 'black'; label: string; color: string }[];
}
function projectBackgroundEntry(createRt: typeof createDomEvalRuntime, input: BackgroundInput) {
  const { visible, enabled, chain, clearDataAttrs } = createRt();
  const vis = (node: Element) => visible(node, { viewport: true });
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
  const roots = Array.from(document.querySelectorAll(input.scope)).filter(vis);
  if (roots.length !== 1 || !roots[0])
    return { ...base, phase: roots.length ? ('ambiguous' as const) : ('absent' as const) };
  const root = roots[0];
  const edits = Array.from(
    root.querySelectorAll('[role="textbox"][contenteditable="true"]'),
  ).filter((el) =>
    // Creator scrolls the editor above the viewport when opening lower options.
    visible(el, { noAriaHidden: true }),
  );
  if (edits.length !== 1 || !edits[0] || !base.ready)
    return { ...base, phase: 'ambiguous' as const };
  base.draftEmpty = (edits[0].textContent ?? '') === '' && !edits[0].querySelector('img,video,a');
  const control = (css: string) =>
    Array.from(root.querySelectorAll(css)).filter((node) => vis(node) && enabled(node)).length ===
    1;
  clearDataAttrs(
    ['data-wb-background-open', 'data-wb-background-clear', 'data-wb-background'],
    root,
  );
  const buttons = Array.from(root.querySelectorAll('[role="button"],button')).filter(vis);
  const native = (el: Element) =>
    chain(el, 50).some((f) =>
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
  let node: Element | null = edits[0];
  let phase: 'plain' | 'solid' | 'unsupported' = 'plain';
  for (let level = 0; node && node !== root && level < 12; level++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const style = getComputedStyle(node);
    const solid = input.solids.find((value) => value.color === style.backgroundColor);
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
export const projectFacebookBackground = serializeDomEval<
  (input: BackgroundInput) => ReturnType<typeof projectBackgroundEntry>
>('projectFacebookBackground', projectBackgroundEntry);
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
