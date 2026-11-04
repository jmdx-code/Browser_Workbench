import type { Page } from 'playwright-core';
import type { Peer } from '../bridge/core.js';
import type { Awaitable } from '../domain/persistence.js';
import { extractFacebookGroupId } from '../shared/facebook-target-id.js';
import {
  isCompleteNumericId,
  isPlaceholderTargetName,
  type BumperScope,
} from '../shared/group-bumper.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GroupJoinEvaluationResult {
  joined: boolean;
  hasJoinButton: boolean;
  pendingApproval: boolean;
  requiresQuestions: boolean;
  welcomeDismissed: boolean;
}

export interface GroupRedirectResolution {
  effectiveGroupId: string;
  canonicalGroupId: string | null;
  redirectedToCanonical: boolean;
}

/**
 * Shared helper for Facebook group session primitives across
 * GroupInviterRunner, GroupBumperRunner, and GroupPosterRunner.
 */
export class FacebookGroupSessionHelper {
  /**
   * Wait until the peer is PAUSED and synced (up to timeoutMs, default 10_000ms).
   */
  static async waitPeerPaused(
    peer: Partial<Pick<Peer, 'phase' | 'synced'>>,
    guard: () => Awaitable<void>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let elapsed = 0;
    while (
      ((peer.phase !== undefined && peer.phase !== 'PAUSED') || peer.synced === false) &&
      elapsed < timeoutMs &&
      Date.now() < deadline
    ) {
      await sleep(50);
      elapsed += 50;
      await guard();
    }
  }

  /**
   * Check whether an error message represents a transient kernel/connection state
   * that should be retried after self-healing recovery.
   */
  static isTransientPrepareError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /PREPARE_TIMEOUT|KERNEL_SCOPE_CHANGED|KERNEL_INITIAL_DOCUMENT_PENDING|BROWSER_OFFLINE|KERNEL_PROFILE_NOT_IDLE|KERNEL_PEER_NOT_IDLE/i.test(
      msg,
    );
  }

  /**
   * Extract a canonical numeric group ID from a Facebook group URL if present.
   */
  static extractCanonicalGroupIdFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (!/(?:^|\.)(?:facebook\.com|fb\.com)$/i.test(parsed.hostname)) return null;
      if (!parsed.pathname.toLowerCase().startsWith('/groups/')) return null;
      const extracted = extractFacebookGroupId(url);
      return isCompleteNumericId(extracted) ? extracted : null;
    } catch {
      return null;
    }
  }

  /**
   * Extract the current group ID from a Facebook URL and resolve alias -> canonical numeric ID
   * redirects, persisting resolved metadata back to the unified target library.
   */
  static async syncCanonicalGroupRedirect(input: {
    currentUrl: string;
    rawGroupId: string;
    groupName?: string | null;
    avatarUrl?: string | null;
    surfaceGroupIds?: readonly string[];
    applyResolvedMetadata?: (
      rawId: string,
      resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
    ) => Awaitable<unknown>;
  }): Promise<GroupRedirectResolution> {
    const rawId = input.rawGroupId.trim();
    let extracted = '';
    try {
      const parsed = new URL(input.currentUrl);
      if (parsed.origin === 'https://www.facebook.com' && parsed.pathname.startsWith('/groups/')) {
        extracted = extractFacebookGroupId(input.currentUrl);
      }
    } catch {
      extracted = '';
    }
    const surfaceNumeric = (input.surfaceGroupIds ?? []).find((gid) => isCompleteNumericId(gid));
    const candidateCanonical = isCompleteNumericId(extracted) ? extracted : (surfaceNumeric ?? '');

    const redirectedToCanonical = Boolean(
      candidateCanonical &&
      candidateCanonical.toLowerCase() !== rawId.toLowerCase() &&
      isCompleteNumericId(candidateCanonical),
    );
    const effectiveGroupId = redirectedToCanonical ? candidateCanonical : rawId;
    const canonicalGroupId = isCompleteNumericId(effectiveGroupId) ? effectiveGroupId : null;

    if (
      input.applyResolvedMetadata &&
      (redirectedToCanonical ||
        Boolean(input.groupName && !isPlaceholderTargetName(input.groupName, effectiveGroupId)) ||
        Boolean(input.avatarUrl))
    ) {
      await input.applyResolvedMetadata(rawId, {
        canonicalId: canonicalGroupId,
        name: input.groupName ?? null,
        avatarUrl: input.avatarUrl ?? null,
      });
    }

    return {
      effectiveGroupId,
      canonicalGroupId,
      redirectedToCanonical,
    };
  }

  /**
   * Detect and optionally click the multilingual / React Fiber `GroupsCometJoinButton`
   * join group control, and detect membership questions / pending admin approval.
   */
  static async ensureJoinedGroup(
    page: Page,
    guard: () => Awaitable<void>,
    options?: {
      autoClickJoin?: boolean;
      dismissWelcome?: boolean;
    },
  ): Promise<GroupJoinEvaluationResult> {
    await guard();
    const autoClick = options?.autoClickJoin ?? true;
    const dismissWelcome = options?.dismissWelcome ?? true;

    const evaluated = await page
      .evaluate(
        (opts) => {
          const isVis = (el: Element | null): el is HTMLElement => {
            if (!(el instanceof HTMLElement)) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 4 || r.height <= 4) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
          };

          const hasFiberJoinButton = (el: Element): boolean => {
            const key = Object.keys(el).find(
              (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
            );
            let cur: unknown = key ? Reflect.get(el, key) : null;
            for (let depth = 0; cur && typeof cur === 'object' && depth < 24; depth++) {
              const typeObj = Reflect.get(cur, 'elementType') ?? Reflect.get(cur, 'type');
              const name =
                typeof typeObj === 'function'
                  ? String(Reflect.get(typeObj, 'displayName') ?? typeObj.name ?? '')
                  : typeof typeObj === 'object' && typeObj !== null
                    ? String(Reflect.get(typeObj, 'displayName') ?? '')
                    : '';
              if (/GroupsCometJoinButton|GroupJoinButton/i.test(name)) return true;
              cur = Reflect.get(cur, 'return');
            }
            return false;
          };

          const joinRegex =
            /^(?:Join\s*group|Join|加入小组|加入小組|加入社團|加入社团|加入群组|加入群組|加入|Tham\s*gia\s*nhóm|Tham\s*gia|เข้าร่วมกลุ่ม|เข้าร่วม|အဖွဲ့သို့\s*ဝင်ရောက်ရန်|အဖွဲ့ဝင်ရန်|Gabung\s*ke\s*grup|Gabung)$/i;
          const pendingRegex =
            /^(?:Cancel\s*request|Pending|Requested|待审核|待審核|等待审核|等待審核|等待批准|已申请|已申請|取消申请|取消申請|取消请求|Đang\s*chờ|รออนุมัติ|ခွင့်ပြုချက်\s*စောင့်ဆိုင်းနေသည်)$/i;
          const questionModalRegex =
            /Answer\s*questions|Membership\s*questions|回答问题|回答問題|入社问题|入群问题|Trả\s*lời\s*câu\s*hỏi|ตอบคำถาม/i;

          let welcomeDismissed = false;
          if (opts.dismissWelcome) {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVis);
            for (const d of dialogs) {
              if (d.querySelector('[role="checkbox"], [role="textbox"], textarea')) continue;
              const text = (d.textContent ?? '').slice(0, 600);
              if (questionModalRegex.test(text)) {
                return {
                  joined: false,
                  hasJoinButton: false,
                  pendingApproval: true,
                  requiresQuestions: true,
                  welcomeDismissed: false,
                };
              }
              const btn = Array.from(d.querySelectorAll('[role="button"], button')).find((el) => {
                if (!isVis(el)) return false;
                const label = (el.getAttribute('aria-label') || el.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim();
                return /^(?:Close|关闭|關閉|继续|繼續|Continue|知道了|Got\s*it)$/i.test(label);
              });
              if (btn instanceof HTMLElement) {
                btn.click();
                welcomeDismissed = true;
              }
            }
          }

          const buttons = Array.from(document.querySelectorAll('[role="button"], button')).filter(
            isVis,
          );
          let pendingApproval = false;
          let joinTarget: HTMLElement | null = null;

          for (const btn of buttons) {
            if (btn.closest('[role="dialog"]')) continue;
            const label = (btn.getAttribute('aria-label') || btn.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (pendingRegex.test(label)) {
              pendingApproval = true;
            }
            if (!joinTarget && (joinRegex.test(label) || hasFiberJoinButton(btn))) {
              if (!pendingRegex.test(label)) {
                joinTarget = btn;
              }
            }
          }

          if (joinTarget && opts.autoClick) {
            joinTarget.click();
          }

          return {
            joined: !joinTarget && !pendingApproval,
            hasJoinButton: Boolean(joinTarget),
            pendingApproval,
            requiresQuestions: false,
            welcomeDismissed,
          };
        },
        { autoClick, dismissWelcome },
      )
      .catch(() => ({
        joined: true,
        hasJoinButton: false,
        pendingApproval: false,
        requiresQuestions: false,
        welcomeDismissed: false,
      }));

    if (evaluated.hasJoinButton && autoClick) {
      await sleep(900);
      await guard();
      const afterClick = await page
        .evaluate(() => {
          const questionModalRegex =
            /Answer\s*questions|Membership\s*questions|回答问题|回答問題|入社问题|入群问题|Trả\s*lời\s*câu\s*hỏi|ตอบคำถาม/i;
          const pendingRegex =
            /^(?:Cancel\s*request|Pending|Requested|待审核|待審核|等待审核|等待審核|等待批准|已申请|已申請|取消申请|取消申請|取消请求|Đang\s*chờ|รออนุมัติ|ခွင့်ပြုချက်\s*စောင့်ဆိုင်းနေသည်)$/i;
          for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
            const r = d.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            if (questionModalRegex.test((d.textContent ?? '').slice(0, 600))) {
              const closeBtn = d.querySelector<HTMLElement>(
                '[aria-label="Close"], [aria-label="关闭"], [aria-label="關閉"]',
              );
              closeBtn?.click();
              return { requiresQuestions: true, pendingApproval: true };
            }
          }
          for (const b of Array.from(document.querySelectorAll('[role="button"], button'))) {
            const label = (b.getAttribute('aria-label') || b.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (pendingRegex.test(label)) {
              return { requiresQuestions: false, pendingApproval: true };
            }
          }
          return { requiresQuestions: false, pendingApproval: false };
        })
        .catch(() => ({ requiresQuestions: false, pendingApproval: false }));

      return {
        joined: !afterClick.pendingApproval && !afterClick.requiresQuestions,
        hasJoinButton: true,
        pendingApproval: afterClick.pendingApproval,
        requiresQuestions: afterClick.requiresQuestions,
        welcomeDismissed: evaluated.welcomeDismissed,
      };
    }

    return evaluated;
  }
}

/**
 * In-flight coordinator for multi-browser same-Page-identity concurrency (`WO-U3` 7.1.2).
 * - Prevents two browsers switched to the same Page (`actingAccountId`) from liking/commenting
 *   the same `postId` simultaneously.
 * - Atomically reserves in-flight quota against `dailyMaxLikesPerAccount` (`dbTodayCount + inFlight < dailyMax`)
 *   and releases the reservation when an interaction is skipped or fails.
 */
export class InFlightBumperCoordinator {
  private readonly activeAccountPosts = new Set<string>();
  private readonly inFlightQuotaByAccountScope = new Map<string, number>();

  private postKey(actingAccountId: string, postId: string): string {
    return `${actingAccountId.trim()}::${postId.trim()}`;
  }

  private quotaKey(actingAccountId: string, sourceMode: BumperScope = 'group'): string {
    return `${actingAccountId.trim()}::${sourceMode}`;
  }

  tryAcquirePost(actingAccountId: string, postId: string): boolean {
    const key = this.postKey(actingAccountId, postId);
    if (this.activeAccountPosts.has(key)) return false;
    this.activeAccountPosts.add(key);
    return true;
  }

  releasePost(actingAccountId: string, postId: string): void {
    this.activeAccountPosts.delete(this.postKey(actingAccountId, postId));
  }

  inFlightCount(actingAccountId: string, sourceMode: BumperScope = 'group'): number {
    return this.inFlightQuotaByAccountScope.get(this.quotaKey(actingAccountId, sourceMode)) ?? 0;
  }

  tryReserveDailyQuota(
    actingAccountId: string,
    sourceMode: BumperScope,
    dbTodayCount: number,
    dailyMaxLikesPerAccount: number,
  ): boolean {
    const key = this.quotaKey(actingAccountId, sourceMode);
    const currentInFlight = this.inFlightQuotaByAccountScope.get(key) ?? 0;
    if (dbTodayCount + currentInFlight >= dailyMaxLikesPerAccount) {
      return false;
    }
    this.inFlightQuotaByAccountScope.set(key, currentInFlight + 1);
    return true;
  }

  releaseDailyQuota(actingAccountId: string, sourceMode: BumperScope = 'group'): void {
    const key = this.quotaKey(actingAccountId, sourceMode);
    const current = this.inFlightQuotaByAccountScope.get(key) ?? 0;
    if (current <= 1) {
      this.inFlightQuotaByAccountScope.delete(key);
    } else {
      this.inFlightQuotaByAccountScope.set(key, current - 1);
    }
  }
}
