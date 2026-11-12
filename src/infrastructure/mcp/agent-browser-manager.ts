import type { Core } from '../../bridge/core.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { KernelBridge } from '../kernel-bridge.js';
import { kernelAgentBrowserURL } from '../../shared/kernel-policy.js';
import { devDiag } from '../../shared/dev-diagnostics.js';

type AgentBrowserConnection = Awaited<ReturnType<KernelBridge['connectAgentBrowser']>>;

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

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

export interface AgentBrowserSessionSummary {
  profileId: string;
  url: string;
  openedAt: number;
  lastActiveAt: number;
  idleMs: number;
  browsing: boolean;
  approvedFilesCount: number;
}

interface ManagedAgentSession {
  profileId: string;
  epoch: string;
  connection: AgentBrowserConnection;
  approvedFilesKey: string;
  approvedFilesCount: number;
  openedAt: number;
  lastActiveAt: number;
  browsingAbort: AbortController | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function randBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export class AgentBrowserManager {
  private readonly sessions = new Map<string, ManagedAgentSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly getCore: () => Core,
    private readonly getKernel: () => KernelBridge | undefined,
    private readonly registry: FeatureExecutionRegistry,
    options?: { idleTimeoutMs?: number },
  ) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.registry.register({
      id: 'agent-browser',
      label: 'AI 浏览器操作',
      isProfileRunning: (profileId) => this.sessions.has(profileId),
      hasActiveExecution: () => this.sessions.size > 0,
      stopProfiles: async (profileIds) => {
        await Promise.allSettled(profileIds.map((id) => this.close(id)));
      },
    });
  }

  listSessions(): AgentBrowserSessionSummary[] {
    const now = Date.now();
    const out: AgentBrowserSessionSummary[] = [];
    for (const s of this.sessions.values()) {
      let currentUrl = 'about:blank';
      try {
        currentUrl = s.connection.page.url() || 'about:blank';
      } catch {}
      out.push({
        profileId: s.profileId,
        url: currentUrl,
        openedAt: s.openedAt,
        lastActiveAt: s.lastActiveAt,
        idleMs: Math.max(0, now - s.lastActiveAt),
        browsing: s.browsingAbort !== null,
        approvedFilesCount: s.approvedFilesCount,
      });
    }
    return out;
  }

  private touchIdleTimer(session: ManagedAgentSession): void {
    session.lastActiveAt = Date.now();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      if (session.browsingAbort) {
        this.touchIdleTimer(session);
        return;
      }
      devDiag.record({
        level: 'INFO',
        category: 'BROWSER_ACTION',
        event: 'AGENT_BROWSER_IDLE_TIMEOUT_CLOSE',
        profileId: session.profileId,
      });
      void this.close(session.profileId).catch(() => {});
    }, this.idleTimeoutMs);
    session.idleTimer.unref?.();
  }

  private async withProfileLock<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(profileId) ?? Promise.resolve();
    let releaseLock: () => void = () => {};
    const currentGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const chained = previous.then(() => currentGate);
    this.locks.set(profileId, chained);

    await previous;
    try {
      return await fn();
    } finally {
      releaseLock();
      if (this.locks.get(profileId) === chained) {
        this.locks.delete(profileId);
      }
    }
  }

  private async closeSessionUnlocked(profileId: string): Promise<boolean> {
    const existing = this.sessions.get(profileId);
    if (!existing) return false;
    this.sessions.delete(profileId);
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    if (existing.browsingAbort) {
      existing.browsingAbort.abort();
      existing.browsingAbort = null;
    }
    await existing.connection.close().catch(async (err) => {
      await existing.connection.stopOnCloseFailure().catch(() => {});
      throw err;
    });
    return true;
  }

  private attachSessionLifecycleWatchers(session: ManagedAgentSession): void {
    const evictOnClose = (reason: string) => {
      if (this.sessions.get(session.profileId) !== session) return;
      devDiag.record({
        level: 'INFO',
        category: 'BROWSER_ACTION',
        event: 'AGENT_BROWSER_EXTERNAL_CLOSE',
        profileId: session.profileId,
        reason,
      });
      void this.close(session.profileId).catch(() => {});
    };
    try {
      session.connection.page.once('close', () => evictOnClose('PAGE_CLOSED'));
      session.connection.browser.once('disconnected', () => evictOnClose('BROWSER_DISCONNECTED'));
    } catch {
      // Ignore listener registration errors on mock/disposed objects
    }
  }

  private async ensureLiveSessionUnlocked(profileId: string): Promise<ManagedAgentSession> {
    const session = this.sessions.get(profileId);
    if (!session) {
      throw new Error(
        `SESSION_NOT_OPEN: 浏览器 ${profileId} 当前没有打开的 AI 标签页，请先调用 wb_browser_open`,
      );
    }
    const peer = this.getCore().peers.get(profileId);
    const pageClosed = (() => {
      try {
        return session.connection.page.isClosed();
      } catch {
        return true;
      }
    })();
    if (
      !peer ||
      !peer.online ||
      peer.epoch !== session.epoch ||
      pageClosed ||
      Boolean(session.connection.failureReason)
    ) {
      await this.closeSessionUnlocked(profileId).catch(() => {});
      throw new Error(
        `SESSION_CLOSED_OR_DISCONNECTED: 浏览器 ${profileId} 的 AI 标签页已关闭或连接已重置，请重新调用 wb_browser_open`,
      );
    }
    return session;
  }

  async close(profileId: string): Promise<{ closed: boolean; profileId: string }> {
    const existing = this.sessions.get(profileId);
    if (existing?.browsingAbort) {
      existing.browsingAbort.abort();
    }
    const closed = await this.withProfileLock(profileId, () =>
      this.closeSessionUnlocked(profileId),
    );
    return { closed, profileId };
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      const s = this.sessions.get(id);
      s?.browsingAbort?.abort();
    }
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }

  private async waitForHiddenTabTarget(
    page: AgentBrowserConnection['page'],
    selector: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const state = await page
        .evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (!(el instanceof HTMLElement)) return 'missing';
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return 'hidden';
          }
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return 'zero_size';
          const disabled =
            (el as HTMLButtonElement | HTMLInputElement).disabled === true ||
            el.getAttribute('aria-disabled') === 'true';
          if (disabled) return 'disabled';
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          return 'ready';
        }, selector)
        .catch(() => 'navigating');

      if (state === 'ready') return;
      if (Date.now() >= deadline) {
        throw new Error(
          `TARGET_NOT_READY: 后台标签页等待元素 "${selector}" 超时 (${timeoutMs}ms)，当前状态: ${state}`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, 120));
    }
  }

  private async observeWithNavRetry(
    page: AgentBrowserConnection['page'],
    options?: {
      maxElements?: number | undefined;
      includeTextChars?: number | undefined;
      selectorScope?: string | undefined;
    },
  ): Promise<PageObservation> {
    try {
      return await this.observeInternal(page, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Cannot find context') ||
        msg.includes('Inspected target navigated')
      ) {
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await new Promise<void>((r) => setTimeout(r, 250));
        return await this.observeInternal(page, options);
      }
      throw err;
    }
  }

  private async scrollPageOrContainer(
    page: AgentBrowserConnection['page'],
    deltaY: number,
  ): Promise<{ scrolledTarget: 'window' | 'container' | 'none'; scrollY: number }> {
    return await page.evaluate((dy: number) => {
      const docEl = document.scrollingElement || document.documentElement || document.body;
      if (docEl && docEl.scrollHeight > window.innerHeight + 4) {
        const before = window.scrollY;
        window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
        if (Math.abs(window.scrollY - before) > 0 || dy === 0) {
          return { scrolledTarget: 'window' as const, scrollY: Math.round(window.scrollY) };
        }
      }
      // Fallback for SPA inner scroll containers (e.g. Google Drive list, web app panes, dialogs)
      let best: HTMLElement | null = null;
      let bestArea = 0;
      const candidates = document.querySelectorAll(
        'main, [role="main"], [role="dialog"], div, section',
      );
      for (let i = 0; i < candidates.length && i < 250; i++) {
        const el = candidates[i];
        if (!(el instanceof HTMLElement)) continue;
        if (el.scrollHeight <= el.clientHeight + 16) continue;
        const style = window.getComputedStyle(el);
        if (
          style.overflowY !== 'auto' &&
          style.overflowY !== 'scroll' &&
          style.overflowY !== 'overlay'
        ) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 160 && rect.height > 120) {
          bestArea = area;
          best = el;
        }
      }
      if (best) {
        best.scrollTop += dy;
        return { scrolledTarget: 'container' as const, scrollY: Math.round(best.scrollTop) };
      }
      window.scrollBy(0, dy);
      return { scrolledTarget: 'none' as const, scrollY: Math.round(window.scrollY || 0) };
    }, deltaY);
  }

  private async detectHumanGate(page: AgentBrowserConnection['page']): Promise<HumanGateStatus> {
    const raw = await page
      .evaluate(() => {
        const href = location.href || '';
        const lowerHref = href.toLowerCase();
        const title = (document.title || '').trim();
        const lowerTitle = title.toLowerCase();

        const iframeSrcs: string[] = [];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length && i < 30; i++) {
          const frame = iframes[i];
          if (!frame) continue;
          const rect = frame.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          const src = (frame.getAttribute('src') || '').toLowerCase();
          const fTitle = (frame.getAttribute('title') || '').toLowerCase();
          if (src || fTitle) iframeSrcs.push(`${src} ${fTitle}`);
        }

        const hasCaptchaWidget =
          Boolean(
            document.querySelector(
              '.g-recaptcha, .h-captcha, .cf-turnstile, altcha-widget, [data-sitekey], #cf-challenge-running, #challenge-form',
            ),
          ) ||
          iframeSrcs.some(
            (s) =>
              s.includes('recaptcha') ||
              s.includes('hcaptcha') ||
              s.includes('challenges.cloudflare.com') ||
              s.includes('turnstile') ||
              s.includes('arkoselabs') ||
              s.includes('funcaptcha'),
          );

        const bodySample = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
        const hasAntiBotChallenge =
          lowerTitle.includes('just a moment') ||
          lowerTitle.includes('attention required') ||
          bodySample.includes('verify you are human') ||
          bodySample.includes('checking if the site connection is secure') ||
          bodySample.includes('确认您是真人') ||
          bodySample.includes('请完成安全验证');

        const isCheckpoint =
          lowerHref.includes('/checkpoint') ||
          lowerHref.includes('/two_step_verification') ||
          lowerHref.includes('accounts.google.com/v3/signin/challenge') ||
          bodySample.includes('two-factor authentication') ||
          bodySample.includes('双重验证') ||
          bodySample.includes('输入验证码');

        const isLoginPage =
          /\/login(\/|\?|$)/.test(lowerHref) ||
          lowerHref.includes('accounts.google.com/v3/signin/identifier') ||
          lowerHref.includes('auth.openai.com/u/login');

        return {
          hasCaptchaWidget,
          hasAntiBotChallenge,
          isCheckpoint,
          isLoginPage,
          href,
          title,
        };
      })
      .catch(() => null);

    if (!raw) {
      return { required: false, kind: null, reason: null };
    }
    if (raw.hasCaptchaWidget || raw.hasAntiBotChallenge) {
      return {
        required: true,
        kind: 'captcha',
        reason:
          '检测到人机验证 / CAPTCHA 挑战（禁止 AI 自动点击或绕过，请调用 bring_to_front 让用户在真实浏览器窗口手动完成验证）',
      };
    }
    if (raw.isCheckpoint) {
      return {
        required: true,
        kind: 'checkpoint',
        reason:
          '检测到账号双重验证 / Checkpoint 页面（请提示用户在真实浏览器窗口完成验证后再继续）',
      };
    }
    if (raw.isLoginPage) {
      return {
        required: false,
        kind: 'login',
        reason: '当前处于登录页面（如涉及密码或验证码，建议交由用户在浏览器窗口自行登录）',
      };
    }
    return { required: false, kind: null, reason: null };
  }

  private async observeInternal(
    page: AgentBrowserConnection['page'],
    options?: {
      maxElements?: number | undefined;
      includeTextChars?: number | undefined;
      selectorScope?: string | undefined;
    },
  ): Promise<PageObservation> {
    const maxElements = Math.max(5, Math.min(200, Math.floor(options?.maxElements ?? 80)));
    const includeTextChars = Math.max(
      200,
      Math.min(16_000, Math.floor(options?.includeTextChars ?? 3500)),
    );
    const selectorScope = options?.selectorScope?.trim() || '';

    const humanGate = await this.detectHumanGate(page);

    const domSnapshot = await page.evaluate(
      (params: { maxElements: number; includeTextChars: number; selectorScope: string }) => {
        const oldMarked = document.querySelectorAll('[data-wb-agent-ref]');
        for (let i = 0; i < oldMarked.length; i++) {
          oldMarked[i]?.removeAttribute('data-wb-agent-ref');
        }

        const scopeRoot: ParentNode =
          params.selectorScope && document.querySelector(params.selectorScope)
            ? (document.querySelector(params.selectorScope) as ParentNode)
            : document;

        const selector = [
          'a[href]',
          'button',
          'input:not([type="hidden"])',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="option"]',
          '[role="checkbox"]',
          '[role="switch"]',
          '[role="radio"]',
          '[role="combobox"]',
          '[role="textbox"]',
          '[contenteditable="true"]',
        ].join(',');

        const candidates = scopeRoot.querySelectorAll(selector);
        const elements: Array<{
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
        }> = [];

        let refSeq = 0;
        for (let i = 0; i < candidates.length && elements.length < params.maxElements; i++) {
          const el = candidates[i];
          if (!(el instanceof HTMLElement)) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width < 3 || rect.height < 3) continue;
          if (rect.bottom < -200 || rect.top > window.innerHeight + 600) continue;

          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const typeAttr =
            el instanceof HTMLInputElement ? el.type.toLowerCase() : el.getAttribute('type');
          const ariaLabel = (el.getAttribute('aria-label') || '').trim();
          const titleAttr = (el.getAttribute('title') || '').trim();
          const nameAttr = (el.getAttribute('name') || '').trim();
          const placeholder =
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.placeholder.trim() || null
              : (el.getAttribute('placeholder') || '').trim() || null;

          let associatedLabel = '';
          if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) associatedLabel = (lbl.textContent || '').trim();
          }
          const innerTxt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          const rawLabel =
            ariaLabel || associatedLabel || innerTxt || placeholder || titleAttr || nameAttr || tag;
          const label = rawLabel.length > 120 ? `${rawLabel.slice(0, 120)}…` : rawLabel;

          let value: string | null = null;
          if (el instanceof HTMLInputElement) {
            if (el.type.toLowerCase() === 'password') {
              value = el.value ? '[REDACTED]' : '';
            } else {
              value = el.value.slice(0, 200);
            }
          } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            value = el.value.slice(0, 200);
          } else if (el.isContentEditable) {
            value = innerTxt.slice(0, 200);
          }

          const checked =
            el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
              ? el.checked
              : el.getAttribute('aria-checked') === 'true'
                ? true
                : el.getAttribute('aria-checked') === 'false'
                  ? false
                  : null;

          const disabled =
            (el instanceof HTMLButtonElement ||
              el instanceof HTMLInputElement ||
              el instanceof HTMLSelectElement ||
              el instanceof HTMLTextAreaElement) &&
            el.disabled
              ? true
              : el.getAttribute('aria-disabled') === 'true';

          const editable =
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement ||
            el.isContentEditable;

          const href = el instanceof HTMLAnchorElement && el.href ? el.href.slice(0, 300) : null;

          refSeq++;
          const ref = `e${refSeq}`;
          el.setAttribute('data-wb-agent-ref', ref);
          elements.push({
            ref,
            tag,
            role: role || null,
            type: typeAttr || null,
            label,
            placeholder,
            value,
            href,
            checked,
            disabled,
            editable,
          });
        }

        const dialogs: string[] = [];
        const dialogNodes = document.querySelectorAll(
          'dialog[open], [role="dialog"], [role="alertdialog"]',
        );
        for (let i = 0; i < dialogNodes.length && dialogs.length < 6; i++) {
          const d = dialogNodes[i];
          if (!(d instanceof HTMLElement)) continue;
          const rect = d.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          const txt = (d.innerText || '').replace(/\s+/g, ' ').trim();
          if (txt) dialogs.push(txt.slice(0, 300));
        }

        const headings: string[] = [];
        const headingNodes = scopeRoot.querySelectorAll('h1, h2, h3');
        for (let i = 0; i < headingNodes.length && headings.length < 15; i++) {
          const h = headingNodes[i];
          if (!(h instanceof HTMLElement)) continue;
          const txt = (h.innerText || '').replace(/\s+/g, ' ').trim();
          if (txt) headings.push(txt.slice(0, 140));
        }

        const tablePreview: string[][] = [];
        const trNodes = scopeRoot.querySelectorAll('table tr, [role="row"]');
        for (let i = 0; i < trNodes.length && tablePreview.length < 15; i++) {
          const tr = trNodes[i];
          if (!(tr instanceof HTMLElement)) continue;
          const cellNodes = tr.querySelectorAll(
            'th, td, [role="columnheader"], [role="gridcell"], [role="cell"]',
          );
          const cells: string[] = [];
          for (let c = 0; c < cellNodes.length && cells.length < 12; c++) {
            const cellText = (cellNodes[c]?.textContent || '').replace(/\s+/g, ' ').trim();
            cells.push(cellText.slice(0, 100));
          }
          if (cells.some((c) => c.length > 0)) {
            tablePreview.push(cells);
          }
        }

        const rawVisibleText = (
          scopeRoot instanceof HTMLElement ? scopeRoot.innerText : document.body?.innerText || ''
        )
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        return {
          url: location.href || 'about:blank',
          title: document.title || '',
          readyState: document.readyState || 'unknown',
          scrollY: Math.round(window.scrollY || 0),
          viewportHeight: Math.round(window.innerHeight || 0),
          documentHeight: Math.round(
            Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
          ),
          dialogs,
          headings,
          elements,
          tablePreview,
          visibleText:
            rawVisibleText.length > params.includeTextChars
              ? `${rawVisibleText.slice(0, params.includeTextChars)}…`
              : rawVisibleText,
        };
      },
      { maxElements, includeTextChars, selectorScope },
    );

    return {
      url: domSnapshot.url,
      title: domSnapshot.title,
      readyState: domSnapshot.readyState,
      scrollY: domSnapshot.scrollY,
      viewportHeight: domSnapshot.viewportHeight,
      documentHeight: domSnapshot.documentHeight,
      humanGate,
      dialogs: domSnapshot.dialogs,
      headings: domSnapshot.headings,
      elementsCount: domSnapshot.elements.length,
      elements: domSnapshot.elements,
      tablePreview: domSnapshot.tablePreview,
      visibleText: domSnapshot.visibleText,
    };
  }

  async open(input: {
    profileId: string;
    url: string;
    foreground?: boolean | undefined;
    reuseSession?: boolean | undefined;
    approvedFiles?: readonly string[] | undefined;
    browseSeconds?: number | undefined;
    timeoutMs?: number | undefined;
  }): Promise<{
    profileId: string;
    reusedSession: boolean;
    browseSummary: {
      requestedSeconds: number;
      elapsedMs: number;
      scrollSteps: number;
      stoppedReason: 'completed' | 'aborted' | 'human_gate';
    } | null;
    observation: PageObservation;
  }> {
    const targetUrl = input.url.trim();
    if (!kernelAgentBrowserURL(targetUrl)) {
      throw new Error(
        `AGENT_BROWSER_URL_REJECTED: 仅允许访问有效的 http/https 网页或 about:blank（严禁访问 127.0.0.1:18767 控制器端口），当前输入: "${input.url}"`,
      );
    }

    return await this.withProfileLock(input.profileId, async () => {
      const core = this.getCore();
      const kernel = this.getKernel();
      if (!kernel) {
        throw new Error('KERNEL_UNAVAILABLE: 浏览器控制内核未就绪');
      }
      const peer = core.peers.get(input.profileId);
      if (!peer || !peer.online) {
        throw new Error(`PROFILE_OFFLINE: 浏览器 ${input.profileId} 当前不在线`);
      }
      if (!peer.capabilities?.includes('agent-browser-kernel-v1')) {
        throw new Error(
          `EXTENSION_RELOAD_REQUIRED: 浏览器 ${input.profileId} 的扩展版本 (${peer.extensionVersion ?? 'unknown'}) 尚未激活 agent-browser-kernel-v1，请先调用 wb_diagnose(action="reload_extensions") 热重载插件`,
        );
      }

      const busyLabels = await this.registry.busyModuleLabels([input.profileId], 'agent-browser');
      if (busyLabels.length > 0) {
        throw new Error(
          `PROFILE_BUSY_IN_MODULE: 浏览器 ${input.profileId} 正在执行「${busyLabels.join('、')}」，请等待完成或先停止对应任务`,
        );
      }

      const normalizedFiles = [
        ...new Set((input.approvedFiles ?? []).map((f) => f.trim()).filter(Boolean)),
      ].sort();
      const filesKey = normalizedFiles.join('\n');

      let existingSession = this.sessions.get(input.profileId);
      let reusedSession = false;

      if (existingSession) {
        const pageClosed = (() => {
          try {
            return existingSession.connection.page.isClosed();
          } catch {
            return true;
          }
        })();
        const needNewFiles =
          normalizedFiles.length > 0 && existingSession.approvedFilesKey !== filesKey;
        if (
          input.reuseSession === false ||
          pageClosed ||
          existingSession.epoch !== peer.epoch ||
          needNewFiles
        ) {
          await this.closeSessionUnlocked(input.profileId);
          existingSession = undefined;
        } else {
          reusedSession = true;
        }
      }

      let activeSession: ManagedAgentSession;
      if (!existingSession) {
        const connection = await kernel.connectAgentBrowser(peer, {
          initialUrl: 'about:blank',
          foreground: Boolean(input.foreground),
          ...(normalizedFiles.length > 0 ? { files: normalizedFiles } : {}),
        });
        const now = Date.now();
        activeSession = {
          profileId: input.profileId,
          epoch: peer.epoch,
          connection,
          approvedFilesKey: filesKey,
          approvedFilesCount: normalizedFiles.length,
          openedAt: now,
          lastActiveAt: now,
          browsingAbort: null,
          idleTimer: null,
        };
        this.sessions.set(input.profileId, activeSession);
        this.attachSessionLifecycleWatchers(activeSession);
      } else {
        activeSession = existingSession;
        if (input.foreground) {
          await activeSession.connection.page.bringToFront().catch(() => {});
        }
      }

      try {
        this.touchIdleTimer(activeSession);
        const navTimeout = Math.max(3000, Math.min(60_000, Math.floor(input.timeoutMs ?? 25_000)));
        if (targetUrl !== 'about:blank' || reusedSession) {
          await activeSession.connection.page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: navTimeout,
          });
          await activeSession.connection.page.waitForTimeout(450).catch(() => {});
        }
        this.touchIdleTimer(activeSession);

        let browseSummary: {
          requestedSeconds: number;
          elapsedMs: number;
          scrollSteps: number;
          stoppedReason: 'completed' | 'aborted' | 'human_gate';
        } | null = null;

        const requestedSeconds =
          typeof input.browseSeconds === 'number' && input.browseSeconds > 0
            ? Math.min(600, Math.max(1, Math.round(input.browseSeconds)))
            : 0;

        if (requestedSeconds > 0) {
          const abortController = new AbortController();
          activeSession.browsingAbort = abortController;
          const startMs = Date.now();
          const deadlineMs = startMs + requestedSeconds * 1000;
          let scrollSteps = 0;
          let stoppedReason: 'completed' | 'aborted' | 'human_gate' = 'completed';

          try {
            while (Date.now() < deadlineMs) {
              if (abortController.signal.aborted) {
                stoppedReason = 'aborted';
                break;
              }
              const gate = await this.detectHumanGate(activeSession.connection.page);
              if (gate.required) {
                stoppedReason = 'human_gate';
                break;
              }
              this.touchIdleTimer(activeSession);
              const direction = scrollSteps > 2 && Math.random() < 0.16 ? -1 : 1;
              const deltaY = direction * randBetween(240, 620);
              await this.scrollPageOrContainer(activeSession.connection.page, deltaY).catch(
                () => {},
              );
              scrollSteps++;
              const remainingMs = deadlineMs - Date.now();
              if (remainingMs <= 0) break;
              const pauseMs = Math.min(remainingMs, randBetween(1800, 4200));
              await sleepAbortable(pauseMs, abortController.signal);
            }
          } finally {
            if (activeSession.browsingAbort === abortController) {
              activeSession.browsingAbort = null;
            }
            this.touchIdleTimer(activeSession);
          }

          browseSummary = {
            requestedSeconds,
            elapsedMs: Date.now() - startMs,
            scrollSteps,
            stoppedReason,
          };
        }

        const observation = await this.observeWithNavRetry(activeSession.connection.page);
        devDiag.record({
          level: 'INFO',
          category: 'BROWSER_ACTION',
          event: 'AGENT_BROWSER_OPENED',
          profileId: input.profileId,
          url: observation.url,
          data: {
            reusedSession,
            elementsCount: observation.elementsCount,
            humanGate: observation.humanGate.kind,
            ...(browseSummary ? { browseSummary } : {}),
          },
        });

        return {
          profileId: input.profileId,
          reusedSession,
          browseSummary,
          observation,
        };
      } catch (err) {
        if (!reusedSession) {
          await this.closeSessionUnlocked(input.profileId).catch(() => {});
        }
        throw err;
      }
    });
  }

  async observe(input: {
    profileId: string;
    maxElements?: number | undefined;
    includeTextChars?: number | undefined;
    selectorScope?: string | undefined;
  }): Promise<PageObservation> {
    return await this.withProfileLock(input.profileId, async () => {
      const session = await this.ensureLiveSessionUnlocked(input.profileId);
      this.touchIdleTimer(session);
      return await this.observeWithNavRetry(session.connection.page, input);
    });
  }

  async act(input: {
    profileId: string;
    action:
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
    ref?: string | undefined;
    selector?: string | undefined;
    text?: string | undefined;
    key?: string | undefined;
    clearFirst?: boolean | undefined;
    scrollDeltaY?: number | undefined;
    waitMs?: number | undefined;
    files?: readonly string[] | undefined;
    timeoutMs?: number | undefined;
  }): Promise<{
    profileId: string;
    action: string;
    observation: PageObservation;
  }> {
    return await this.withProfileLock(input.profileId, async () => {
      const session = await this.ensureLiveSessionUnlocked(input.profileId);
      this.touchIdleTimer(session);
      const page = session.connection.page;
      const timeout = Math.max(1000, Math.min(30_000, Math.floor(input.timeoutMs ?? 10_000)));

      if (input.action === 'bring_to_front') {
        await page.bringToFront();
        const observation = await this.observeInternal(page);
        return { profileId: input.profileId, action: input.action, observation };
      }

      const gate = await this.detectHumanGate(page);
      if (gate.kind === 'captcha') {
        throw new Error(
          `CAPTCHA_HUMAN_REQUIRED: ${gate.reason ?? '页面存在人机验证，禁止自动交互'}`,
        );
      }

      const targetSelector = input.ref?.trim()
        ? `[data-wb-agent-ref="${input.ref.trim().replace(/"/g, '')}"]`
        : input.selector?.trim() || '';

      const requireTarget = () => {
        if (!targetSelector) {
          throw new Error(
            `TARGET_REQUIRED: 动作 "${input.action}" 需要传入 ref（例如 "e1"，来自 wb_browser_observe）或 CSS selector`,
          );
        }
        return page.locator(targetSelector).first();
      };

      // Refuse clicking/typing into any element inside or representing a CAPTCHA widget
      if (targetSelector) {
        const isCaptchaTarget = await page
          .evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const hit = el.closest(
              '.g-recaptcha, .h-captcha, .cf-turnstile, altcha-widget, [data-sitekey]',
            );
            if (hit) return true;
            if (el instanceof HTMLIFrameElement) {
              const src = (el.src || '').toLowerCase();
              return (
                src.includes('recaptcha') ||
                src.includes('hcaptcha') ||
                src.includes('turnstile') ||
                src.includes('challenges.cloudflare.com')
              );
            }
            return false;
          }, targetSelector)
          .catch(() => false);
        if (isCaptchaTarget) {
          throw new Error(
            'CAPTCHA_HUMAN_REQUIRED: 目标元素属于人机验证组件，系统严禁自动点击或绕过验证，请让用户手动完成',
          );
        }
      }

      const isHiddenTab = await page
        .evaluate(() => document.visibilityState === 'hidden')
        .catch(() => false);

      const isTransientNavError = (err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        return (
          m.includes('Execution context was destroyed') ||
          m.includes('Cannot find context') ||
          m.includes('Inspected target navigated')
        );
      };

      switch (input.action) {
        case 'click': {
          if (isHiddenTab) {
            const locator = requireTarget();
            void locator;
            await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            await page
              .evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (!(el instanceof HTMLElement)) throw new Error('TARGET_MISSING');
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const opts = {
                  bubbles: true,
                  cancelable: true,
                  clientX: cx,
                  clientY: cy,
                  view: window,
                };
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.click();
              }, targetSelector)
              .catch((err) => {
                if (!isTransientNavError(err)) throw err;
              });
          } else {
            await requireTarget().click({ timeout });
          }
          break;
        }
        case 'double_click': {
          if (isHiddenTab) {
            requireTarget();
            await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            await page
              .evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (!(el instanceof HTMLElement)) throw new Error('TARGET_MISSING');
                const rect = el.getBoundingClientRect();
                const opts = {
                  bubbles: true,
                  cancelable: true,
                  detail: 2,
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top + rect.height / 2,
                  view: window,
                };
                el.dispatchEvent(new MouseEvent('dblclick', opts));
              }, targetSelector)
              .catch((err) => {
                if (!isTransientNavError(err)) throw err;
              });
          } else {
            await requireTarget().dblclick({ timeout });
          }
          break;
        }
        case 'hover': {
          if (isHiddenTab) {
            requireTarget();
            await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            await page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (!(el instanceof HTMLElement)) throw new Error('TARGET_MISSING');
              const opts = { bubbles: true, cancelable: true, view: window };
              el.dispatchEvent(new PointerEvent('pointerover', opts));
              el.dispatchEvent(new MouseEvent('mouseover', opts));
              el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
              el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
            }, targetSelector);
          } else {
            await requireTarget().hover({ timeout });
          }
          break;
        }
        case 'fill': {
          const locator = requireTarget();
          const value = input.text ?? '';
          const isContentEditable = await locator
            .evaluate((el: Element) => el instanceof HTMLElement && el.isContentEditable)
            .catch(() => false);
          if (isContentEditable) {
            if (isHiddenTab) {
              await this.waitForHiddenTabTarget(page, targetSelector, timeout);
              await page.evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (el instanceof HTMLElement) el.focus();
              }, targetSelector);
            } else {
              await locator.click({ timeout });
            }
            if (input.clearFirst !== false) {
              await page.keyboard.press('Control+A');
              await page.keyboard.press('Backspace');
            }
            if (value) {
              await page.keyboard.insertText(value);
            }
          } else if (isHiddenTab) {
            await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            await page.evaluate(
              (params: { sel: string; val: string }) => {
                const el = document.querySelector(params.sel);
                if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
                  throw new Error('TARGET_NOT_TEXT_INPUT');
                }
                el.focus();
                const proto =
                  el instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc?.set) desc.set.call(el, params.val);
                else el.value = params.val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              },
              { sel: targetSelector, val: value },
            );
          } else {
            await locator.fill(value, { timeout });
          }
          break;
        }
        case 'type': {
          const locator = requireTarget();
          if (isHiddenTab) {
            await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            await page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (el instanceof HTMLElement) el.focus();
            }, targetSelector);
          } else {
            await locator.click({ timeout });
          }
          if (input.clearFirst) {
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
          }
          if (input.text) {
            await page.keyboard.type(input.text, { delay: 35 });
          }
          break;
        }
        case 'press': {
          const key = input.key?.trim();
          if (!key) {
            throw new Error(
              'KEY_REQUIRED: press 动作必须提供 key（例如 "Enter"、"Tab"、"Escape"）',
            );
          }
          if (targetSelector) {
            if (isHiddenTab) {
              await this.waitForHiddenTabTarget(page, targetSelector, timeout);
              await page.evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (el instanceof HTMLElement) el.focus();
              }, targetSelector);
              await page.keyboard.press(key);
            } else {
              await requireTarget().press(key, { timeout });
            }
          } else {
            await page.keyboard.press(key);
          }
          break;
        }
        case 'select': {
          const locator = requireTarget();
          const val = input.text ?? '';
          if (isHiddenTab) {
            await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            await page.evaluate(
              (params: { sel: string; wanted: string }) => {
                const el = document.querySelector(params.sel);
                if (!(el instanceof HTMLSelectElement)) {
                  throw new Error('TARGET_NOT_SELECT');
                }
                const match =
                  Array.from(el.options).find(
                    (o) =>
                      o.value === params.wanted ||
                      o.label.trim() === params.wanted.trim() ||
                      (o.textContent || '').trim() === params.wanted.trim(),
                  ) ?? null;
                if (!match) {
                  throw new Error(`SELECT_OPTION_NOT_FOUND: "${params.wanted}"`);
                }
                el.value = match.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              },
              { sel: targetSelector, wanted: val },
            );
          } else {
            await locator
              .selectOption({ label: val }, { timeout })
              .catch(() => locator.selectOption(val, { timeout }));
          }
          break;
        }
        case 'scroll': {
          const deltaY = Math.max(-4000, Math.min(4000, Math.round(input.scrollDeltaY ?? 650)));
          if (targetSelector) {
            if (isHiddenTab) {
              await this.waitForHiddenTabTarget(page, targetSelector, timeout);
            } else {
              await requireTarget().scrollIntoViewIfNeeded({ timeout });
            }
          } else {
            await this.scrollPageOrContainer(page, deltaY);
          }
          break;
        }
        case 'upload_files': {
          const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
          if (files.length === 0) {
            throw new Error('FILES_REQUIRED: upload_files 动作必须提供本地文件路径数组 files');
          }
          await requireTarget().setInputFiles(files, { timeout });
          break;
        }
        case 'wait_for_text': {
          const wanted = input.text?.trim();
          if (!wanted) {
            throw new Error('TEXT_REQUIRED: wait_for_text 动作必须提供要等待出现的文本 text');
          }
          if (isHiddenTab) {
            const textDeadline = Date.now() + timeout;
            while (true) {
              const found = await page
                .evaluate((w: string) => (document.body?.innerText || '').includes(w), wanted)
                .catch(() => false);
              if (found) break;
              if (Date.now() >= textDeadline) {
                throw new Error(
                  `WAIT_FOR_TEXT_TIMEOUT: 等待文本 "${wanted}" 出现超时 (${timeout}ms)`,
                );
              }
              await new Promise<void>((r) => setTimeout(r, 150));
            }
          } else {
            await page.getByText(wanted).first().waitFor({ state: 'visible', timeout });
          }
          break;
        }
      }

      const settleMs = Math.max(0, Math.min(10_000, Math.floor(input.waitMs ?? 350)));
      if (settleMs > 0) {
        await new Promise<void>((r) => setTimeout(r, settleMs));
      }
      this.touchIdleTimer(session);
      const observation = await this.observeWithNavRetry(page);

      devDiag.record({
        level: 'INFO',
        category: 'BROWSER_ACTION',
        event: 'AGENT_BROWSER_ACT',
        profileId: input.profileId,
        actionKind: input.action,
        url: observation.url,
        data: {
          ref: input.ref ?? null,
          selector: input.selector ?? null,
          elementsCount: observation.elementsCount,
        },
      });

      return {
        profileId: input.profileId,
        action: input.action,
        observation,
      };
    });
  }

  async screenshot(input: {
    profileId: string;
    fullPage?: boolean | undefined;
    quality?: number | undefined;
  }): Promise<{
    profileId: string;
    url: string;
    title: string;
    mimeType: 'image/jpeg';
    base64: string;
    byteLength: number;
  }> {
    return await this.withProfileLock(input.profileId, async () => {
      const session = await this.ensureLiveSessionUnlocked(input.profileId);
      this.touchIdleTimer(session);
      const quality = Math.max(30, Math.min(90, Math.floor(input.quality ?? 65)));
      const buf = await session.connection.captureScreenshot({
        quality,
        fullPage: Boolean(input.fullPage),
      });
      const url = session.connection.page.url() || 'about:blank';
      const title = await session.connection.page.title().catch(() => '');
      return {
        profileId: input.profileId,
        url,
        title,
        mimeType: 'image/jpeg',
        base64: buf.toString('base64'),
        byteLength: buf.byteLength,
      };
    });
  }
}
