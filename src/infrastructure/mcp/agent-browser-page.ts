import type { KernelBridge } from '../kernel-bridge.js';

export type AgentBrowserConnection = Awaited<ReturnType<KernelBridge['connectAgentBrowser']>>;
export type AgentBrowserPage = AgentBrowserConnection['page'];
export type AgentBrowserActionKind =
  | 'click'
  | 'double_click'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'upload_files'
  | 'wait_for_text'
  | 'bring_to_front';

export interface AgentBrowserActParams {
  profileId: string;
  action: AgentBrowserActionKind;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  clearFirst?: boolean;
  scrollDeltaY?: number;
  waitMs?: number;
  files?: readonly string[];
  timeoutMs?: number;
}
export interface HumanGateStatus {
  required: boolean;
  kind: 'captcha' | 'checkpoint' | 'login' | null;
  reason: string | null;
}
export interface ObservedInteractiveElement {
  ref: string;
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  placeholder: string | null;
  value: string | null;
  href: string | null;
  checked: boolean | null;
  disabled: boolean;
  editable: boolean;
}
export interface PageObservation {
  url: string;
  title: string;
  readyState: string;
  scrollY: number;
  viewportHeight: number;
  documentHeight: number;
  humanGate: HumanGateStatus;
  dialogs: string[];
  headings: string[];
  elementsCount: number;
  elements: ObservedInteractiveElement[];
  tablePreview: string[][];
  visibleText: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isTransientNav = (e: unknown) =>
  ['Execution context was destroyed', 'Cannot find context', 'Inspected target navigated'].some(
    (s) => (e instanceof Error ? e.message : String(e)).includes(s),
  );

async function evalHiddenDom(
  page: AgentBrowserPage,
  selector: string,
  timeoutMs: number,
  op: 'focus' | 'click' | 'double_click' | 'hover' | 'fill' | 'select',
  val = '',
) {
  for (const deadline = Date.now() + timeoutMs; ;) {
    const res = await page
      .evaluate(
        ({ s, opName, v }: { s: string; opName: string; v: string }) => {
          const el = document.querySelector(s);
          if (!(el instanceof HTMLElement)) return 'missing';
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
            return 'hidden';
          if (r.width <= 0 || r.height <= 0) return 'zero_size';
          if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')
            return 'disabled';
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          if (opName === 'focus') return (el.focus(), 'ready');
          if (opName === 'click' || opName === 'double_click' || opName === 'hover') {
            const evs =
              opName === 'click'
                ? 'pointerdown mousedown pointerup mouseup'
                : opName === 'double_click'
                  ? 'dblclick'
                  : 'pointerover mouseover pointerenter mouseenter';
            for (const t of evs.split(' ')) {
              const Ctor = t[0] === 'p' ? PointerEvent : MouseEvent;
              el.dispatchEvent(
                new Ctor(t, {
                  bubbles: !t.endsWith('enter'),
                  cancelable: true,
                  clientX: r.left + r.width / 2,
                  clientY: r.top + r.height / 2,
                  view: window,
                  detail: t === 'dblclick' ? 2 : 0,
                }),
              );
            }
            if (opName === 'click') el.click();
            return 'ready';
          }
          if (opName === 'select') {
            if (!(el instanceof HTMLSelectElement)) throw new Error('TARGET_NOT_SELECT');
            const m = Array.from(el.options).find((o) =>
              [o.value, o.label.trim(), (o.textContent || '').trim()].includes(
                o.value === v ? v : v.trim(),
              ),
            );
            if (!m) throw new Error(`SELECT_OPTION_NOT_FOUND: "${v}"`);
            el.value = m.value;
          } else {
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
              throw new Error('TARGET_NOT_TEXT_INPUT');
            el.focus();
            const proto =
              el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d?.set) d.set.call(el, v);
            else el.value = v;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ready';
        },
        { s: selector, opName: op, v: val },
      )
      .catch((err) => {
        if (isTransientNav(err) && op === 'click') return 'ready';
        if (err instanceof Error && /(?:TARGET_NOT_|SELECT_OPTION_NOT_FOUND)/.test(err.message))
          throw err;
        return 'navigating';
      });
    if (res === 'ready') return;
    if (Date.now() >= deadline)
      throw new Error(`TARGET_NOT_READY: 等待 "${selector}" 超时 (${timeoutMs}ms): ${res}`);
    await sleep(120);
  }
}

export async function scrollPageOrContainer(page: AgentBrowserPage, deltaY: number) {
  return page.evaluate((dy: number) => {
    const docEl = document.scrollingElement || document.documentElement || document.body;
    if (docEl && docEl.scrollHeight > innerHeight + 4) {
      const before = scrollY;
      scrollBy({ top: dy, left: 0, behavior: 'instant' });
      if (Math.abs(scrollY - before) > 0 || dy === 0)
        return { scrolledTarget: 'window' as const, scrollY: Math.round(scrollY) };
    }
    let best: HTMLElement | null = null;
    let bestArea = 0;
    const nodes = document.querySelectorAll('main,[role="main"],[role="dialog"],div,section');
    for (const el of Array.from(nodes).slice(0, 250)) {
      if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 16) continue;
      if (!['auto', 'scroll', 'overlay'].includes(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > bestArea && r.width > 160 && r.height > 120)
        [best, bestArea] = [el, r.width * r.height];
    }
    if (best)
      return { scrolledTarget: 'container' as const, scrollY: Math.round((best.scrollTop += dy)) };
    scrollBy(0, dy);
    return { scrolledTarget: 'none' as const, scrollY: Math.round(scrollY || 0) };
  }, deltaY);
}

const GATE_REASONS: Record<'captcha' | 'checkpoint' | 'login', [boolean, string]> = {
  captcha: [true, '检测到 CAPTCHA 挑战，请调用 bring_to_front 让用户手动完成'],
  checkpoint: [true, '检测到账号双重验证 / Checkpoint 页面，请用户手动验证'],
  login: [false, '当前处于登录页面，建议交由用户在浏览器窗口自行登录'],
};

export async function detectHumanGate(page: AgentBrowserPage): Promise<HumanGateStatus> {
  const kind = await page
    .evaluate(() => {
      const href = (location.href || '').toLowerCase();
      const title = (document.title || '').trim().toLowerCase();
      const body = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
      const has = (s: string, ks: string) => ks.split('|').some((k) => s.includes(k));
      const hasIfr = Array.from(document.querySelectorAll('iframe'))
        .slice(0, 30)
        .some((f) => {
          const r = f.getBoundingClientRect();
          const t = `${f.getAttribute('src') || ''} ${f.getAttribute('title') || ''}`.toLowerCase();
          return (
            r.width >= 10 &&
            r.height >= 10 &&
            has(t, 'recaptcha|hcaptcha|challenges.cloudflare.com|turnstile|arkoselabs|funcaptcha')
          );
        });
      const capSel =
        '.g-recaptcha,.h-captcha,.cf-turnstile,altcha-widget,[data-sitekey],#cf-challenge-running,#challenge-form';
      if (
        document.querySelector(capSel) ||
        hasIfr ||
        has(title, 'just a moment|attention required') ||
        has(
          body,
          'verify you are human|checking if the site connection is secure|确认您是真人|请完成安全验证',
        )
      )
        return 'captcha' as const;
      if (
        has(href, '/checkpoint|/two_step_verification|accounts.google.com/v3/signin/challenge') ||
        has(body, 'two-factor authentication|双重验证|输入验证码')
      )
        return 'checkpoint' as const;
      if (
        /\/login(\/|\?|$)/.test(href) ||
        has(href, 'accounts.google.com/v3/signin/identifier|auth.openai.com/u/login')
      )
        return 'login' as const;
      return null;
    })
    .catch(() => null);
  const hit = kind ? GATE_REASONS[kind] : null;
  return hit
    ? { required: hit[0], kind, reason: hit[1] }
    : { required: false, kind: null, reason: null };
}

function domObserveScript(p: {
  maxElements: number;
  includeTextChars: number;
  selectorScope: string;
}) {
  document
    .querySelectorAll('[data-wb-agent-ref]')
    .forEach((n) => n.removeAttribute('data-wb-agent-ref'));
  const scope: ParentNode =
    (p.selectorScope && document.querySelector(p.selectorScope)) || document;
  const norm = (s: string | null | undefined, max?: number) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return max && t.length > max ? `${t.slice(0, max)}…` : t;
  };
  const elements: ObservedInteractiveElement[] = [];
  const q =
    'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[role="radio"],[role="combobox"],[role="textbox"],[contenteditable="true"]';
  for (const el of Array.from(scope.querySelectorAll(q))) {
    if (elements.length >= p.maxElements) break;
    if (!(el instanceof HTMLElement)) continue;
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (
      st.display === 'none' ||
      st.visibility === 'hidden' ||
      st.opacity === '0' ||
      r.width < 3 ||
      r.height < 3 ||
      r.bottom < -200 ||
      r.top > innerHeight + 600
    )
      continue;
    const attr = (n: string) => (el.getAttribute(n) || '').trim();
    const inp = el instanceof HTMLInputElement ? el : null;
    const txtEl = el instanceof HTMLTextAreaElement ? el : null;
    const sel = el instanceof HTMLSelectElement ? el : null;
    const btn = el instanceof HTMLButtonElement ? el : null;
    const [tag, it] = [el.tagName.toLowerCase(), inp ? inp.type.toLowerCase() : ''];
    const ph = ((inp ?? txtEl)?.placeholder ?? attr('placeholder')).trim() || null;
    const txt = norm(el.innerText || el.textContent);
    const forLbl = el.id
      ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent
      : '';
    const ref = `e${elements.length + 1}`;
    el.setAttribute('data-wb-agent-ref', ref);
    const ac = attr('aria-checked');
    const val = inp
      ? it === 'password'
        ? inp.value
          ? '[REDACTED]'
          : ''
        : inp.value.slice(0, 200)
      : txtEl || sel
        ? ((txtEl ?? sel)?.value.slice(0, 200) ?? '')
        : el.isContentEditable
          ? txt.slice(0, 200)
          : null;
    const checked =
      inp && (it === 'checkbox' || it === 'radio')
        ? inp.checked
        : ac === 'true'
          ? true
          : ac === 'false'
            ? false
            : null;
    elements.push({
      ref,
      tag,
      role: attr('role') || null,
      type: it || attr('type') || null,
      label: norm(
        attr('aria-label') || forLbl || txt || ph || attr('title') || attr('name') || tag,
        120,
      ),
      placeholder: ph,
      href: el instanceof HTMLAnchorElement && el.href ? el.href.slice(0, 300) : null,
      value: val,
      checked,
      disabled:
        Boolean(btn?.disabled || inp?.disabled || sel?.disabled || txtEl?.disabled) ||
        attr('aria-disabled') === 'true',
      editable: Boolean(inp || txtEl || sel || el.isContentEditable),
    });
  }
  const collect = (root: ParentNode, sel: string, max: number, len: number, minRect = false) =>
    Array.from(root.querySelectorAll(sel))
      .filter((n): n is HTMLElement => {
        if (!(n instanceof HTMLElement)) return false;
        const rc = n.getBoundingClientRect();
        return !minRect || (rc.width >= 10 && rc.height >= 10);
      })
      .map((n) => norm(n.innerText).slice(0, len))
      .filter(Boolean)
      .slice(0, max);
  const rawText = (scope instanceof HTMLElement ? scope.innerText : document.body?.innerText || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    url: location.href || 'about:blank',
    title: document.title || '',
    readyState: document.readyState || 'unknown',
    scrollY: Math.round(scrollY || 0),
    viewportHeight: Math.round(innerHeight || 0),
    documentHeight: Math.round(
      Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
    ),
    dialogs: collect(document, 'dialog[open],[role="dialog"],[role="alertdialog"]', 6, 300, true),
    headings: collect(scope, 'h1,h2,h3', 15, 140),
    elements,
    tablePreview: Array.from(scope.querySelectorAll('table tr,[role="row"]'))
      .slice(0, 15)
      .map((tr) =>
        Array.from(
          tr.querySelectorAll('th,td,[role="columnheader"],[role="gridcell"],[role="cell"]'),
        )
          .slice(0, 12)
          .map((c) => norm(c.textContent).slice(0, 100)),
      )
      .filter((c) => c.some(Boolean)),
    visibleText:
      rawText.length > p.includeTextChars ? `${rawText.slice(0, p.includeTextChars)}…` : rawText,
  };
}

export async function observePageDom(
  page: AgentBrowserPage,
  opts?: { maxElements?: number; includeTextChars?: number; selectorScope?: string },
): Promise<PageObservation> {
  const clamp = (v: number | undefined, def: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.floor(v ?? def)));
  const [humanGate, dom] = await Promise.all([
    detectHumanGate(page),
    page.evaluate(domObserveScript, {
      maxElements: clamp(opts?.maxElements, 80, 5, 200),
      includeTextChars: clamp(opts?.includeTextChars, 3500, 200, 16_000),
      selectorScope: opts?.selectorScope?.trim() || '',
    }),
  ]);
  return { ...dom, humanGate, elementsCount: dom.elements.length };
}

export async function observeWithNavRetry(
  page: AgentBrowserPage,
  opts?: { maxElements?: number; includeTextChars?: number; selectorScope?: string },
): Promise<PageObservation> {
  try {
    return await observePageDom(page, opts);
  } catch (err) {
    if (!isTransientNav(err)) throw err;
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await sleep(250);
    return observePageDom(page, opts);
  }
}

export async function executeAgentBrowserAction(
  page: AgentBrowserPage,
  input: AgentBrowserActParams,
  timeout: number,
) {
  const gate = await detectHumanGate(page);
  if (gate.kind === 'captcha')
    throw new Error(`CAPTCHA_HUMAN_REQUIRED: ${gate.reason ?? '禁止自动交互'}`);
  const sel = input.ref?.trim()
    ? `[data-wb-agent-ref="${input.ref.trim().replace(/"/g, '')}"]`
    : input.selector?.trim() || '';
  const reqTarget = () => {
    if (!sel) throw new Error(`TARGET_REQUIRED: 动作 "${input.action}" 需要 ref 或 selector`);
    return page.locator(sel).first();
  };
  const reqVal = (v: string | undefined, code: string, msg: string) => {
    if (!v?.trim()) throw new Error(`${code}: ${msg}`);
    return v.trim();
  };
  const capTarget = sel
    ? await page
        .evaluate((s: string) => {
          const el = document.querySelector(s);
          if (!el) return false;
          if (el.closest('.g-recaptcha,.h-captcha,.cf-turnstile,altcha-widget,[data-sitekey]'))
            return true;
          const src = el instanceof HTMLIFrameElement ? el.src.toLowerCase() : '';
          return 'recaptcha|hcaptcha|turnstile|challenges.cloudflare.com'
            .split('|')
            .some((k) => src.includes(k));
        }, sel)
        .catch(() => false)
    : false;
  if (capTarget) throw new Error('CAPTCHA_HUMAN_REQUIRED: 目标属于人机验证组件，禁止自动点击');

  const isHidden = await page
    .evaluate(() => document.visibilityState === 'hidden')
    .catch(() => false);
  const act = input.action;
  if (act === 'click' || act === 'double_click' || act === 'hover')
    return isHidden
      ? (reqTarget(), evalHiddenDom(page, sel, timeout, act))
      : reqTarget()[act === 'double_click' ? 'dblclick' : act]({ timeout });
  if (act === 'fill' || act === 'type' || act === 'select') {
    const loc = reqTarget();
    const val = input.text ?? '';
    if (act === 'select')
      return isHidden
        ? evalHiddenDom(page, sel, timeout, 'select', val)
        : void (await loc
            .selectOption({ label: val }, { timeout })
            .catch(() => loc.selectOption(val, { timeout })));
    const isCE = await loc
      .evaluate((el: Element) => el instanceof HTMLElement && el.isContentEditable)
      .catch(() => false);
    if (act === 'type' || isCE) {
      await (isHidden ? evalHiddenDom(page, sel, timeout, 'focus') : loc.click({ timeout }));
      if (act === 'fill' ? input.clearFirst !== false : Boolean(input.clearFirst)) {
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
      }
      if (val)
        await (act === 'fill'
          ? page.keyboard.insertText(val)
          : page.keyboard.type(val, { delay: 35 }));
      return;
    }
    return isHidden ? evalHiddenDom(page, sel, timeout, 'fill', val) : loc.fill(val, { timeout });
  }
  if (act === 'press') {
    const key = reqVal(input.key, 'KEY_REQUIRED', 'press 需要提供 key');
    if (sel)
      await (isHidden
        ? evalHiddenDom(page, sel, timeout, 'focus')
        : reqTarget().press(key, { timeout }));
    if (!sel || isHidden) await page.keyboard.press(key);
    return;
  }
  if (act === 'scroll')
    return sel
      ? isHidden
        ? evalHiddenDom(page, sel, timeout, 'focus')
        : reqTarget().scrollIntoViewIfNeeded({ timeout })
      : void (await scrollPageOrContainer(
          page,
          Math.max(-4000, Math.min(4000, Math.round(input.scrollDeltaY ?? 650))),
        ));
  if (act === 'upload_files') {
    const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) throw new Error('FILES_REQUIRED: upload_files 需要提供 files');
    return reqTarget().setInputFiles(files, { timeout });
  }
  if (act === 'wait_for_text') {
    const wanted = reqVal(input.text, 'TEXT_REQUIRED', 'wait_for_text 需要提供 text');
    if (!isHidden) return page.getByText(wanted).first().waitFor({ state: 'visible', timeout });
    for (const deadline = Date.now() + timeout; ;) {
      if (
        await page
          .evaluate((w: string) => (document.body?.innerText || '').includes(w), wanted)
          .catch(() => false)
      )
        return;
      if (Date.now() >= deadline)
        throw new Error(`WAIT_FOR_TEXT_TIMEOUT: 等待 "${wanted}" 超时 (${timeout}ms)`);
      await sleep(150);
    }
  }
}
