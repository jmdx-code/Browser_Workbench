import type { Page } from 'playwright-core';

export interface DismissOverlaysOptions {
  /** 保留不关的当前业务工作弹窗选择器（如发帖框 '[data-wb-poster-dialog="1"]' 或邀请成员窗 '[role="checkbox"]'） */
  keepSelector?: string;
}

export interface DismissOverlaysResult {
  dismissed: number;
  labels: string[];
}

function inPageDismiss(keepSelector: string | void): DismissOverlaysResult {
  if (
    typeof location !== 'undefined' &&
    /^\/(?:login|checkpoint|recover|two_step_verification|security)/i.test(location.pathname ?? '')
  ) {
    return { dismissed: 0, labels: [] };
  }
  const isVis = (el: Element, minSize = 12): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= minSize || r.height <= minSize) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const hasCircleButtonFiber = (el: Element): boolean => {
    const key = Object.keys(el).find(
      (k) =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$') ||
        k.startsWith('__reactProps$'),
    );
    if (!key) return false;
    let cur: unknown = Reflect.get(el, key);
    for (let depth = 0; cur && depth < 14; depth++) {
      if (typeof cur !== 'object' || cur === null) break;
      const t = Reflect.get(cur, 'type') ?? Reflect.get(cur, 'elementType');
      const name =
        typeof t === 'function' || (typeof t === 'object' && t !== null)
          ? String(Reflect.get(t, 'displayName') ?? Reflect.get(t, 'name') ?? '').trim()
          : '';
      if (/FDSCircleButton/i.test(name)) return true;
      cur = Reflect.get(cur, 'return');
    }
    return false;
  };

  const keep = typeof keepSelector === 'string' ? keepSelector.trim() : '';
  const allDialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ),
  ).reverse();

  const closeAriaRx =
    /^(?:Close|关闭|關閉|ပိတ်ရန်|ပိတ်မည်|ပိတ်ပါ|Đóng|ปิด|Tutup|Dismiss|Not\s*now|以后再说|稍后再说|暫時不要)$/i;
  const closeTextRx =
    /^(?:关闭|關閉|Close|知道了|Got\s*it|以后再说|稍后再说|Not\s*now|ပိတ်ရန်|ပိတ်ပါ|Đóng|ปิด|Tutup)$/i;
  const securityTextRx =
    /账号已被锁定|帳號已被鎖定|Account locked|Confirm your identity|确认你的身份|確認你的身分|输入安全码|輸入安全碼/i;
  const menuExcludeRx = /Actions|操作|更多|More|Menu|菜单|選單/i;

  let dismissed = 0;
  const labels: string[] = [];

  for (const d of allDialogs) {
    if (dismissed >= 4 || !isVis(d, 24)) continue;
    if (
      d.matches('[role="banner"], [role="navigation"]') ||
      Boolean(d.closest('[role="banner"], [role="navigation"]'))
    ) {
      continue;
    }
    const dialogAria = (d.getAttribute('aria-label') ?? '').trim();
    if (
      /^(?:Notifications|通知|Messenger|聊天)$/i.test(dialogAria) &&
      d.getAttribute('aria-modal') !== 'true'
    ) {
      continue;
    }
    if (
      d.querySelector(
        'input[type="password"], input[name="approvals_code"], input[autocomplete="one-time-code"]',
      ) ||
      securityTextRx.test((d.textContent ?? '').slice(0, 800))
    ) {
      continue;
    }
    if (keep) {
      try {
        if (d.matches(keep) || Boolean(d.querySelector(keep))) continue;
      } catch {
        // ignore invalid selector
      }
    }

    const dRect = d.getBoundingClientRect();
    const buttons = Array.from(d.querySelectorAll<HTMLElement>('[role="button"], button')).filter(
      (b) => isVis(b, 12) && b.getAttribute('aria-disabled') !== 'true',
    );

    let targetBtn = buttons.find((b) =>
      closeAriaRx.test((b.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim()),
    );
    if (
      !targetBtn &&
      !d.querySelector('[role="textbox"], textarea, input[type="file"], [role="checkbox"]')
    ) {
      targetBtn = buttons.find(
        (b) =>
          !b.closest('a[href]') &&
          closeTextRx.test((b.textContent ?? '').replace(/\s+/g, ' ').trim()),
      );
    }
    if (!targetBtn) {
      targetBtn = buttons.find((b) => {
        const aria = (b.getAttribute('aria-label') ?? '').trim();
        if (menuExcludeRx.test(aria)) return false;
        const r = b.getBoundingClientRect();
        if (r.width < 28 || r.width > 48 || r.height < 28 || r.height > 48) return false;
        if (r.top - dRect.top > 72 || dRect.right - r.right > 72) return false;
        return hasCircleButtonFiber(b);
      });
    }

    targetBtn?.click();
    const escInit: KeyboardEventInit = {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    };
    d.dispatchEvent(new KeyboardEvent('keydown', escInit));
    (document.activeElement ?? document.body)?.dispatchEvent(new KeyboardEvent('keydown', escInit));
    dismissed += 1;
    const rawLabel =
      dialogAria ||
      (targetBtn?.getAttribute('aria-label') ?? '') ||
      (targetBtn?.textContent ?? '') ||
      'dialog';
    labels.push(rawLabel.replace(/\s+/g, ' ').trim().slice(0, 60));
  }

  return { dismissed, labels };
}

export async function dismissUnexpectedFacebookOverlays(
  page: Page | null | undefined,
  options?: DismissOverlaysOptions,
): Promise<DismissOverlaysResult> {
  if (!page || typeof page.evaluate !== 'function') {
    return { dismissed: 0, labels: [] };
  }
  try {
    const raw: unknown = options?.keepSelector
      ? await page.evaluate(inPageDismiss, options.keepSelector)
      : await page.evaluate(inPageDismiss);
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof Reflect.get(raw, 'dismissed') === 'number' &&
      Array.isArray(Reflect.get(raw, 'labels'))
    ) {
      return {
        dismissed: Number(Reflect.get(raw, 'dismissed')),
        labels: (Reflect.get(raw, 'labels') as unknown[]).map((x) => String(x)),
      };
    }
  } catch {
    // ignore evaluate errors
  }
  return { dismissed: 0, labels: [] };
}
