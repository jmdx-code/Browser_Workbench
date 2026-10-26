import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import {
  facebookAILabelReading,
  facebookAILabelScope,
  facebookAILabelSwitch,
} from '../shared/facebook-ai-label.js';

export function projectFacebookAILabel(input: { scope: string; switchCSS: string }) {
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
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect(),
      s = getComputedStyle(element);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.left < innerWidth &&
      r.top < innerHeight &&
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      !element.closest('[aria-hidden="true"]')
    );
  };
  const enabled = (element: Element) => !element.matches('[aria-disabled="true"],:disabled');
  if (location.origin !== 'https://www.facebook.com') return { ...base, phase: 'absent' as const };
  const roots = Array.from(document.querySelectorAll(input.scope)).filter(visible);
  if (roots.length !== 1 || !roots[0])
    return { ...base, phase: roots.length ? ('ambiguous' as const) : ('absent' as const) };
  const root = roots[0];
  const switches = Array.from(
    new Set([
      ...Array.from(root.querySelectorAll(input.switchCSS)),
      ...Array.from(root.querySelectorAll('[role="switch"][aria-label*="AI"]')),
    ]),
  ).filter(visible);
  const headings = Array.from(
    root.querySelectorAll('[role="dialog"][aria-label="Labeling your content"]'),
  ).filter(visible);
  if (headings.length || switches.length) {
    const toggle = switches[0];
    const confirms = Array.from(root.querySelectorAll('[role="button"]')).filter(
      (el) =>
        visible(el) &&
        /^(Got it|知道了|我知道了|明白了|了解|瞭解)$/i.test(el.textContent?.trim() ?? ''),
    );
    const checked = toggle?.getAttribute('aria-checked');
    if (
      headings.length > 1 ||
      switches.length !== 1 ||
      !toggle ||
      !['true', 'false'].includes(checked ?? '') ||
      confirms.length !== 1 ||
      !confirms[0]
    )
      return { ...base, phase: 'ambiguous' as const };
    toggle.setAttribute('data-wb-ai-label-switch', '1');
    confirms[0].setAttribute('data-wb-ai-label-confirm', '1');
    return {
      ...base,
      phase: 'settings' as const,
      value: checked === 'true',
      switchEnabled: enabled(toggle),
      confirmEnabled: enabled(confirms[0]),
    };
  }
  const labels = Array.from(root.querySelectorAll('[role="button"]')).filter(
    (el) =>
      visible(el) &&
      /AI\s*(label|标签|標籤|標示|声明|聲明)/i.test(el.getAttribute('aria-label') ?? ''),
  );
  if (!switches.length && !labels.length)
    return { ...base, phase: 'composer' as const, value: false };
  if (switches.length || labels.length !== 1 || !labels[0])
    return { ...base, phase: 'ambiguous' as const };
  const label = labels[0].getAttribute('aria-label');
  const pressed = labels[0].getAttribute('aria-pressed');
  const on = /(?:\bon\b|开启|開啟|已開|啟用|启用)/i.test(label ?? '');
  const off = /(?:\boff\b|关闭|關閉|停用|未開)/i.test(label ?? '');
  if (!on && !off && !['true', 'false'].includes(pressed ?? ''))
    return { ...base, phase: 'ambiguous' as const };
  labels[0].setAttribute('data-wb-ai-label-open', '1');
  return {
    ...base,
    phase: 'composer' as const,
    value: pressed === 'true' || (pressed !== 'false' && on),
    openCSS: enabled(labels[0]) ? '[role="button"][data-wb-ai-label-open="1"]' : null,
  };
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
