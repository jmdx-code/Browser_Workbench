import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { Core } from '../../bridge/core.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { kernelAgentBrowserURL } from '../../shared/kernel-policy.js';
import type { KernelBridge } from '../kernel-bridge.js';
import * as P from './agent-browser-page.js';

export type {
  HumanGateStatus,
  ObservedInteractiveElement,
  PageObservation,
} from './agent-browser-page.js';
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
  connection: P.AgentBrowserConnection;
  approvedFilesKey: string;
  approvedFilesCount: number;
  openedAt: number;
  lastActiveAt: number;
  browsingAbort: AbortController | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const isPageClosed = (s: ManagedAgentSession) => {
  try {
    return s.connection.page.isClosed();
  } catch {
    return true;
  }
};
const randBetween = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
const clamp = (v: number | undefined, def: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(v ?? def)));

export class AgentBrowserManager {
  private readonly sessions = new Map<string, ManagedAgentSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly getCore: () => Core,
    private readonly getKernel: () => KernelBridge | undefined,
    private readonly registry: FeatureExecutionRegistry,
    opts?: { idleTimeoutMs?: number },
  ) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 5 * 60_000;
    this.registry.register({
      id: 'agent-browser',
      label: 'AI 浏览器操作',
      isProfileRunning: (id) => this.sessions.has(id),
      hasActiveExecution: () => this.sessions.size > 0,
      stopProfiles: async (ids) => void (await Promise.allSettled(ids.map((id) => this.close(id)))),
    });
  }

  private diag(
    event: string,
    profileId: string,
    extra?: { url?: string; reason?: string; actionKind?: string; data?: Record<string, unknown> },
  ) {
    devDiag.record({ level: 'INFO', category: 'BROWSER_ACTION', event, profileId, ...extra });
  }

  listSessions(): AgentBrowserSessionSummary[] {
    const now = Date.now();
    return [...this.sessions.values()].map((s) => {
      let url = 'about:blank';
      try {
        url = s.connection.page.url() || 'about:blank';
      } catch {}
      return {
        profileId: s.profileId,
        url,
        openedAt: s.openedAt,
        lastActiveAt: s.lastActiveAt,
        idleMs: Math.max(0, now - s.lastActiveAt),
        browsing: s.browsingAbort !== null,
        approvedFilesCount: s.approvedFilesCount,
      };
    });
  }

  private touchIdleTimer(s: ManagedAgentSession): void {
    s.lastActiveAt = Date.now();
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (s.browsingAbort) return this.touchIdleTimer(s);
      this.diag('AGENT_BROWSER_IDLE_TIMEOUT_CLOSE', s.profileId);
      void this.close(s.profileId).catch(() => {});
    }, this.idleTimeoutMs);
    s.idleTimer.unref?.();
  }

  private async withProfileLock<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(profileId) ?? Promise.resolve();
    let release: () => void = () => {};
    const chained = prev.then(() => new Promise<void>((r) => (release = r)));
    this.locks.set(profileId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(profileId) === chained) this.locks.delete(profileId);
    }
  }

  private withSession<T>(
    profileId: string,
    fn: (s: ManagedAgentSession) => Promise<T>,
  ): Promise<T> {
    return this.withProfileLock(profileId, async () => {
      const s = this.sessions.get(profileId);
      if (!s) throw new Error(`SESSION_NOT_OPEN: 浏览器 ${profileId} 未打开 AI 标签页`);
      const peer = this.getCore().peers.get(profileId);
      if (
        !peer?.online ||
        peer.epoch !== s.epoch ||
        isPageClosed(s) ||
        s.connection.failureReason
      ) {
        await this.closeSessionUnlocked(profileId).catch(() => {});
        throw new Error(`SESSION_CLOSED_OR_DISCONNECTED: 浏览器 ${profileId} 会话已断开`);
      }
      this.touchIdleTimer(s);
      return fn(s);
    });
  }

  private async closeSessionUnlocked(profileId: string): Promise<boolean> {
    const existing = this.sessions.get(profileId);
    if (!existing) return false;
    this.sessions.delete(profileId);
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.browsingAbort?.abort();
    existing.idleTimer = existing.browsingAbort = null;
    await existing.connection.close().catch(async (err) => {
      try {
        await existing.connection.stopOnCloseFailure();
        await existing.connection.retryClose(existing.connection.stopRequestId);
        return;
      } catch {}
      throw err;
    });
    return true;
  }

  async close(profileId: string) {
    this.sessions.get(profileId)?.browsingAbort?.abort();
    return {
      closed: await this.withProfileLock(profileId, () => this.closeSessionUnlocked(profileId)),
      profileId,
    };
  }

  async closeAll() {
    const ids = [...this.sessions.keys()];
    ids.forEach((id) => this.sessions.get(id)?.browsingAbort?.abort());
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }

  private async connectOrReuse(input: {
    profileId: string;
    foreground?: boolean;
    reuseSession?: boolean;
    approvedFiles?: readonly string[];
  }) {
    const kernel = this.getKernel();
    if (!kernel) throw new Error('KERNEL_UNAVAILABLE: 浏览器控制内核未就绪');
    const peer = this.getCore().peers.get(input.profileId);
    if (!peer?.online) throw new Error(`PROFILE_OFFLINE: 浏览器 ${input.profileId} 不在线`);
    if (!peer.capabilities?.includes('agent-browser-kernel-v1'))
      throw new Error(
        `EXTENSION_RELOAD_REQUIRED: 浏览器 ${input.profileId} (${peer.extensionVersion ?? 'unknown'}) 请先 reload_extensions`,
      );
    const busy = await this.registry.busyModuleLabels([input.profileId], 'agent-browser');
    if (busy.length > 0)
      throw new Error(
        `PROFILE_BUSY_IN_MODULE: 浏览器 ${input.profileId} 正忙于「${busy.join('、')}」`,
      );
    const files = [
      ...new Set((input.approvedFiles ?? []).map((f) => f.trim()).filter(Boolean)),
    ].sort();
    const filesKey = files.join('\n');
    let existing = this.sessions.get(input.profileId);
    if (
      existing &&
      (input.reuseSession === false ||
        isPageClosed(existing) ||
        existing.epoch !== peer.epoch ||
        (files.length > 0 && existing.approvedFilesKey !== filesKey))
    ) {
      await this.closeSessionUnlocked(input.profileId);
      existing = undefined;
    }
    if (existing) {
      if (input.foreground) await existing.connection.page.bringToFront().catch(() => {});
      return { session: existing, reusedSession: true };
    }
    const connection = await kernel.connectAgentBrowser(peer, {
      initialUrl: 'about:blank',
      foreground: Boolean(input.foreground),
      ...(files.length > 0 && { files }),
    });
    const now = Date.now();
    const session: ManagedAgentSession = {
      profileId: input.profileId,
      epoch: peer.epoch,
      connection,
      approvedFilesKey: filesKey,
      approvedFilesCount: files.length,
      openedAt: now,
      lastActiveAt: now,
      browsingAbort: null,
      idleTimer: null,
    };
    this.sessions.set(input.profileId, session);
    const evict = (reason: string) => {
      if (this.sessions.get(session.profileId) !== session) return;
      this.diag('AGENT_BROWSER_EXTERNAL_CLOSE', session.profileId, { reason });
      void this.close(session.profileId).catch(() => {});
    };
    try {
      connection.page.once('close', () => evict('PAGE_CLOSED'));
      connection.browser.once('disconnected', () => evict('BROWSER_DISCONNECTED'));
    } catch {}
    return { session, reusedSession: false };
  }

  async open(input: {
    profileId: string;
    url: string;
    foreground?: boolean;
    reuseSession?: boolean;
    approvedFiles?: readonly string[];
    browseSeconds?: number;
    timeoutMs?: number;
  }) {
    const targetUrl = input.url.trim();
    if (!kernelAgentBrowserURL(targetUrl))
      throw new Error(`AGENT_BROWSER_URL_REJECTED: 不允许访问 "${input.url}"`);
    return this.withProfileLock(input.profileId, async () => {
      const { session, reusedSession } = await this.connectOrReuse(input);
      try {
        this.touchIdleTimer(session);
        const timeout = clamp(input.timeoutMs, 25_000, 3000, 60_000);
        if (targetUrl !== 'about:blank' || reusedSession) {
          await session.connection.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout });
          await session.connection.page.waitForTimeout(450).catch(() => {});
        }
        this.touchIdleTimer(session);
        const secs =
          typeof input.browseSeconds === 'number' && input.browseSeconds > 0
            ? clamp(input.browseSeconds, 1, 1, 600)
            : 0;
        const browseSummary = secs > 0 ? await this.runHumanBrowseLoop(session, secs) : null;
        const observation = await P.observeWithNavRetry(session.connection.page);
        this.diag('AGENT_BROWSER_OPENED', input.profileId, {
          url: observation.url,
          data: {
            reusedSession,
            elementsCount: observation.elementsCount,
            humanGate: observation.humanGate.kind,
            ...(browseSummary && { browseSummary }),
          },
        });
        return { profileId: input.profileId, reusedSession, browseSummary, observation };
      } catch (err) {
        if (!reusedSession) await this.closeSessionUnlocked(input.profileId).catch(() => {});
        throw err;
      }
    });
  }

  private async runHumanBrowseLoop(session: ManagedAgentSession, requestedSeconds: number) {
    const abort = new AbortController();
    const startMs = Date.now();
    session.browsingAbort = abort;
    const deadlineMs = startMs + requestedSeconds * 1000;
    let scrollSteps = 0;
    let stoppedReason: 'completed' | 'aborted' | 'human_gate' = 'completed';
    try {
      while (Date.now() < deadlineMs) {
        if (abort.signal.aborted) {
          stoppedReason = 'aborted';
          break;
        }
        if ((await P.detectHumanGate(session.connection.page)).required) {
          stoppedReason = 'human_gate';
          break;
        }
        this.touchIdleTimer(session);
        const dy = (scrollSteps > 2 && Math.random() < 0.16 ? -1 : 1) * randBetween(240, 620);
        await P.scrollPageOrContainer(session.connection.page, dy).catch(() => {});
        scrollSteps++;
        const rem = deadlineMs - Date.now();
        if (rem <= 0) break;
        await new Promise<void>((res) => {
          const onAbort = () => (clearTimeout(t), res());
          const t = setTimeout(
            () => (abort.signal.removeEventListener('abort', onAbort), res()),
            Math.min(rem, randBetween(1800, 4200)),
          );
          abort.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally {
      if (session.browsingAbort === abort) session.browsingAbort = null;
      this.touchIdleTimer(session);
    }
    return { requestedSeconds, elapsedMs: Date.now() - startMs, scrollSteps, stoppedReason };
  }

  observe(input: {
    profileId: string;
    maxElements?: number;
    includeTextChars?: number;
    selectorScope?: string;
  }) {
    return this.withSession(input.profileId, (s) =>
      P.observeWithNavRetry(s.connection.page, input),
    );
  }

  act(input: P.AgentBrowserActParams & { action: P.AgentBrowserActionKind }) {
    return this.withSession(input.profileId, async (s) => {
      const page = s.connection.page;
      if (input.action === 'bring_to_front') {
        await page.bringToFront();
        return {
          profileId: input.profileId,
          action: input.action,
          observation: await P.observePageDom(page),
        };
      }
      await P.executeAgentBrowserAction(page, input, clamp(input.timeoutMs, 10_000, 1000, 30_000));
      const settleMs = clamp(input.waitMs, 350, 0, 10_000);
      if (settleMs > 0) await new Promise<void>((r) => setTimeout(r, settleMs));
      this.touchIdleTimer(s);
      const observation = await P.observeWithNavRetry(page);
      this.diag('AGENT_BROWSER_ACT', input.profileId, {
        actionKind: input.action,
        url: observation.url,
        data: {
          ref: input.ref ?? null,
          selector: input.selector ?? null,
          elementsCount: observation.elementsCount,
        },
      });
      return { profileId: input.profileId, action: input.action, observation };
    });
  }

  screenshot(input: { profileId: string; fullPage?: boolean; quality?: number }) {
    return this.withSession(input.profileId, async (s) => {
      const buf = await s.connection.captureScreenshot({
        quality: clamp(input.quality, 65, 30, 90),
        fullPage: Boolean(input.fullPage),
      });
      return {
        profileId: input.profileId,
        url: s.connection.page.url() || 'about:blank',
        title: await s.connection.page.title().catch(() => ''),
        mimeType: 'image/jpeg' as const,
        base64: buf.toString('base64'),
        byteLength: buf.byteLength,
      };
    });
  }
}
