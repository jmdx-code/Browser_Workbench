import type { Page } from 'playwright-core';
import {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
} from '../../application/group-poster-service.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  facebookAILabelScope,
  facebookAILabelSwitch,
  nativeSolidBackgrounds,
} from '../../shared/facebook-post-options.js';
import {
  canPosterMaterialUseColorBackground,
  stripAnsi,
  type PosterMaterial,
} from '../../shared/group-poster.js';
import { readFacebookAILabel } from '../facebook-ai-label-reader.js';
import { dismissUnexpectedFacebookOverlays } from '../facebook-overlay-dismisser.js';
import { fetchAndLocalizeAccountAvatar } from '../group-bumper-avatar.js';
import { dismissFeatureInterventionDialogIfPresent } from '../group-inviter-effects.js';
import type { PosterExecOp, PosterIdentityMeta } from './poster-support.js';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const scaled = (ms: number, paceScale: number) => Math.max(40, Math.round(ms * paceScale));
export const markLivePosterDialogAndEditor = (
  page: Page,
): Promise<{ hasDialog: boolean; hasEditor: boolean }> =>
  page.evaluate(() => {
    document.querySelectorAll('[data-wb-poster-editor], [data-wb-poster-dialog]').forEach((e) => {
      e.removeAttribute('data-wb-poster-editor');
      e.removeAttribute('data-wb-poster-dialog');
    });
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
      (d) => d.getBoundingClientRect().width > 200 && d.getBoundingClientRect().height > 150,
    );
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const d = dialogs[i];
      const editor = d
        ? Array.from(
            d.querySelectorAll<HTMLElement>(
              '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"]',
            ),
          ).find(
            (el) => el.getBoundingClientRect().width > 50 && el.getBoundingClientRect().height > 14,
          )
        : undefined;
      if (d && editor) {
        d.setAttribute('data-wb-poster-dialog', '1');
        editor.setAttribute('data-wb-poster-editor', '1');
        editor.focus();
        return { hasDialog: true, hasEditor: true };
      }
    }
    const topDialog = dialogs.at(-1);
    topDialog?.setAttribute('data-wb-poster-dialog', '1');
    return { hasDialog: Boolean(topDialog), hasEditor: false };
  });
async function scanTriggerButton(page: Page, timelineMode: boolean, allowMedia: boolean) {
  return page.evaluate(
    ({ timelineMode, allowMedia }: { timelineMode: boolean; allowMedia: boolean }) => {
      document
        .querySelectorAll('[data-wb-poster-trigger]')
        .forEach((e) => e.removeAttribute('data-wb-poster-trigger'));
      const isVis = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 40 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      if (!timelineMode) {
        const mainText = (
          document.querySelector('[role="main"]')?.textContent ??
          document.body?.innerText ??
          ''
        ).slice(0, 6000);
        if (
          /You can['’]?t post in groups|temporarily blocked from posting|restricted from posting in groups|can['’]?t participate in groups|你目前无法在小组发帖|暂时无法在小组|无法在小组发帖|暂时被禁止发帖|限制了某些活动|restrict certain activity|အဖွဲ့တွင်\s*ပို့စ်တင်၍မရ/i.test(
            mainText,
          )
        )
          return { ok: false as const, restricted: true as const, diag: 'restricted-banner' };
      }
      const excludeRx =
        /^(?:Manage|Promote|Advertise|Professional dashboard|Edit|Edit profile|Add to story|Create story|Boost|Insights|Live video|Feeling\/activity|Anonymous|Poll|Sort|Search|专业仪表板|管理|推广|广告|编辑|编辑主页|添加快拍|创建快拍|速推|数据洞察|直播视频|直播|感受\/活动|打卡|匿名|投票|选择小组身份|選擇小組身份|排序|搜索)/i;
      const mediaRx = /Photo\/video|照片\/视频|相片\/影片/i;
      const rx =
        /Write something|What['’]?s on your mind|留個言吧|留个言吧|写点什么|寫點什麼|写些什么|寫些什麼|分享你的|有什么新鲜事|有什麼新鮮事|在想些什么|在想些什麼|Create a public post|Create post|Create a post|建立公開貼文|建立貼文|创建帖子|Start a discussion|发起讨论|發起討論|တစ်ခုခု\s*ရေးပါ|ဘာတွေ\s*တွေးနေလဲ|သင့်စိတ်ထဲ|ဘာတွေရှိ|ပို့စ်\s*ဖန်တီး|ပို့စ်\s*တင်ပါ|ပို့စ်\s*ရေးပါ|အများမြင်သာအောင်|ဆွေးနွေးမှု|Viết gì đó|Bạn đang nghĩ gì|بم تفكر/i;
      const regionSel = ['Create a post', '创建帖子', '建立貼文', 'ပို့စ် ဖန်တီးရန်', 'إنشاء منشور']
        .map((l) => `[role="region"][aria-label="${l}"]`)
        .join(',');
      const labelOf = (b: Element) =>
        `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.replace(/\s+/g, ' ').trim();
      const canUseBtn = (b: Element, minW = 0, maxH = 999) => {
        const r = b.getBoundingClientRect();
        const lbl = labelOf(b);
        return (
          isVis(b) &&
          r.width >= minW &&
          r.height <= maxH &&
          !excludeRx.test(lbl) &&
          (allowMedia || !mediaRx.test(lbl))
        );
      };
      const regionBtns = Array.from(
        document.querySelectorAll<HTMLElement>(`${regionSel} [role="button"], ${regionSel} button`),
      ).filter((b) => canUseBtn(b, 120, 90));
      const inlineRoot = !timelineMode
        ? document.querySelector<HTMLElement>('[data-pagelet*="GroupInlineComposer"]')
        : null;
      const regionPrompt =
        regionBtns.find((b) => rx.test(labelOf(b))) ??
        regionBtns.find(
          (b) =>
            !b.getAttribute('aria-label') &&
            b.getBoundingClientRect().width >= 200 &&
            (!inlineRoot || inlineRoot.contains(b)),
        );
      const allButtons = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"], button, [role="textbox"]'),
      ).filter(
        (el) =>
          !el.closest('[role="banner"], [role="tablist"], [role="feed"], [role="article"]') &&
          canUseBtn(el),
      );
      const matched =
        regionPrompt ??
        allButtons.find((b) => rx.test(`${labelOf(b)} ${b.getAttribute('placeholder') ?? ''}`)) ??
        (inlineRoot
          ? Array.from(inlineRoot.querySelectorAll<HTMLElement>('[role="button"]')).find(
              (b) => !b.closest('[role="banner"]') && canUseBtn(b, 160),
            )
          : undefined) ??
        allButtons.find((b) => {
          const r = b.getBoundingClientRect();
          if (r.left < 120 || r.width < 180 || r.height < 28 || r.height > 90) return false;
          for (
            let anc: HTMLElement | null = b.parentElement, d = 0;
            d < 5 && anc;
            d++, anc = anc.parentElement
          )
            if (
              anc.querySelector('a[href*="/user/"], a[href*="/profile.php"], svg image, image, img')
            )
              return true;
          return false;
        });
      if (matched) matched.setAttribute('data-wb-poster-trigger', '1');
      return {
        ok: Boolean(matched),
        restricted: false as const,
        diag: matched ? '' : `all=${allButtons.length} url=${location.pathname}`,
      };
    },
    { timelineMode, allowMedia },
  );
}
export async function openAndFillPosterComposer(input: {
  getPage: () => Page;
  accountId: string;
  groupDisplayName: string;
  effectiveGroupName: string;
  isPageTimeline: boolean;
  material: PosterMaterial;
  identityMeta: PosterIdentityMeta;
  paceScale: number;
  callbacks: GroupPosterBrowserCallbacks;
  guard: () => void;
  execOp: PosterExecOp;
}): Promise<void> {
  const { getPage, isPageTimeline, material, paceScale } = input;
  const diag = (
    level: 'INFO' | 'WARN',
    event: string,
    reason?: string,
    data?: Record<string, unknown>,
  ) => devDiag.record({ level, category: 'post-step', event, reason, data });
  input.callbacks.status(`正在打开发帖框 · ${input.effectiveGroupName}`);
  await input.execOp('打开发帖弹窗', async () => {
    const page = getPage();
    let restrictedPopupText: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await dismissUnexpectedFacebookOverlays(page);
      const allowMedia = attempt > 0 && Boolean(material.localFilePath);
      let triggerResult = await scanTriggerButton(page, isPageTimeline, allowMedia);
      for (let step = 0; step < 2 && !triggerResult.ok && !triggerResult.restricted; step++) {
        await page.evaluate(() => window.scrollBy(0, 320)).catch(() => {});
        await wait(250);
        triggerResult = await scanTriggerButton(page, isPageTimeline, allowMedia);
      }
      if (!triggerResult.ok) {
        const cleanDiag = stripAnsi(triggerResult.diag);
        diag(
          'WARN',
          triggerResult.restricted ? 'POSTER_TRIGGER_RESTRICTED' : 'POSTER_TRIGGER_MISSING',
          cleanDiag,
          { isPageTimeline, attempt },
        );
        if (triggerResult.restricted)
          throw new PosterAccountRestrictedError('发小组受限 · 该账号当前无法在小组发帖', {
            scope: 'feature_action',
          });
        throw Error(
          `${isPageTimeline ? '专页时间线未找到发帖框' : '小组未开放发帖框'} (${cleanDiag})`,
        );
      }
      const trigger = page.locator('[data-wb-poster-trigger="1"]').first();
      await trigger
        .evaluate((el) => {
          if (!(el instanceof HTMLElement)) return;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const banner = document.querySelector<HTMLElement>('[role="banner"]');
          const topMin = banner
            ? Math.max(60, Math.round(banner.getBoundingClientRect().bottom) + 12)
            : 72;
          const r = el.getBoundingClientRect();
          if (r.top < topMin) window.scrollBy(0, r.top - topMin - 16);
          else if (r.bottom > window.innerHeight - 16)
            window.scrollBy(0, r.bottom - window.innerHeight + 24);
        })
        .catch(() => {});
      await wait(120);
      await trigger.click({ timeout: 5000 }).catch(() =>
        trigger.evaluate((el) => {
          if (el instanceof HTMLElement) HTMLElement.prototype.click.call(el);
        }),
      );
      const dialogDeadline = Date.now() + Math.max(500, Math.round(8000 * paceScale));
      let composerOpened = false;
      while (Date.now() < dialogDeadline) {
        const dialogProbe = await page.evaluate(() => {
          const restrictionRx =
            /You can['’]?t post|temporarily blocked|restricted from posting|can['’]?t participate|feature is temporarily unavailable|暂时无法在小组|无法在小组发帖|你目前无法|暂时被禁止|限制了某些活动|restrict certain activity|Account restricted|账号受限|操作受限|违反社区|Community Standards|အဖွဲ့တွင်\s*ပို့စ်တင်၍မရ|ကန့်သတ်/i;
          let hasEditor = false;
          let restrictionText: string | null = null;
          for (const d of Array.from(
            document.querySelectorAll<HTMLElement>(
              '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
            ),
          )) {
            const r = d.getBoundingClientRect();
            if (r.width <= 180 || r.height <= 100) continue;
            if (
              Array.from(
                d.querySelectorAll<HTMLElement>(
                  '[role="textbox"][contenteditable="true"], div[contenteditable="true"]',
                ),
              ).some(
                (el) =>
                  el.getBoundingClientRect().width > 50 && el.getBoundingClientRect().height > 14,
              )
            ) {
              hasEditor = true;
              break;
            }
            const txt = (d.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (txt && restrictionRx.test(txt)) restrictionText = txt.slice(0, 120);
          }
          return { hasEditor, restrictionText };
        });
        if (dialogProbe.hasEditor) {
          composerOpened = true;
          break;
        }
        if (dialogProbe.restrictionText) {
          restrictedPopupText = stripAnsi(dialogProbe.restrictionText);
          break;
        }
        await wait(200);
      }
      if (composerOpened) {
        diag('INFO', 'POSTER_COMPOSER_OPENED', undefined, { isPageTimeline, attempt });
        return true;
      }
      if (restrictedPopupText) break;
    }
    if (restrictedPopupText) {
      await dismissFeatureInterventionDialogIfPresent(page, input.guard).catch(() => {});
      diag('WARN', 'POSTER_COMPOSER_RESTRICTED', restrictedPopupText.slice(0, 80), {
        isPageTimeline,
      });
      throw new PosterAccountRestrictedError(
        isPageTimeline
          ? `专页发帖受限：${restrictedPopupText.slice(0, 48)}`
          : '发小组受限 · 该账号当前无法在小组发帖',
        { scope: 'feature_action' },
      );
    }
    diag('WARN', 'POSTER_COMPOSER_OPEN_TIMEOUT', undefined, { isPageTimeline });
    throw Error(
      isPageTimeline
        ? '专页时间线发帖弹窗未打开'
        : '小组发帖弹窗未打开（可能发小组受限或无发帖权限）',
    );
  });
  input.callbacks.status(`正在填写贴文并上传媒体 · ${input.groupDisplayName}`);
  await input.execOp('填写贴文与附件', async () => {
    const page = getPage();
    const clickSel = (sel: string, waitMs: number) =>
      page
        .locator(sel)
        .first()
        .click({ timeout: 3000 })
        .catch(() => {})
        .then(() => wait(scaled(waitMs, paceScale)));
    const initialMarks = await markLivePosterDialogAndEditor(page);
    if (!initialMarks.hasDialog || (!initialMarks.hasEditor && !material.localFilePath))
      throw Error('发帖弹窗中未找到文字输入框');
    if (!input.identityMeta.accountAvatar) {
      const dialogAvatar = await page
        .evaluate(() => {
          const dialog = document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]');
          if (!dialog) return null;
          const dr = dialog.getBoundingClientRect();
          return (
            Array.from(dialog.querySelectorAll('svg image, img'))
              .filter((node) => {
                const r = node.getBoundingClientRect();
                return (
                  r.width >= 28 && r.width <= 60 && r.top - dr.top <= 160 && r.left - dr.left <= 120
                );
              })
              .map(
                (n) =>
                  n.getAttribute('xlink:href') ||
                  n.getAttribute('href') ||
                  n.getAttribute('src') ||
                  '',
              )
              .find(
                (src) =>
                  src.startsWith('https://') &&
                  /fbcdn\.net|fbsbx\.com/i.test(src) &&
                  !/\/rsrc\.php\//i.test(src),
              ) ?? null
          );
        })
        .catch(() => null);
      if (dialogAvatar) {
        input.identityMeta.accountAvatar =
          (await fetchAndLocalizeAccountAvatar(
            dialogAvatar,
            undefined,
            `${input.identityMeta.identityType}:${input.accountId}`,
          ).catch(() => null)) ?? dialogAvatar;
      }
    }
    if (!material.localFilePath && canPosterMaterialUseColorBackground(material)) {
      const solidColors = nativeSolidBackgrounds.map((s) => s.color);
      const markSwatchOrOpen = () =>
        page
          .evaluate((colors: string[]) => {
            const dialog = document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]');
            if (!dialog) return 'none';
            dialog
              .querySelectorAll('[data-wb-poster-bg-open], [data-wb-poster-bg-swatch]')
              .forEach((e) => {
                e.removeAttribute('data-wb-poster-bg-open');
                e.removeAttribute('data-wb-poster-bg-swatch');
              });
            const buttons = Array.from(
              dialog.querySelectorAll<HTMLElement>('[role="button"], button'),
            ).filter((el) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return (
                r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
              );
            });
            const swatch =
              buttons.find((el) =>
                [el, ...Array.from(el.children)].some(
                  (n) =>
                    colors.includes(getComputedStyle(n).backgroundColor) &&
                    getComputedStyle(n).backgroundImage === 'none',
                ),
              ) ??
              buttons.find((el) => {
                const lbl = el.getAttribute('aria-label') ?? '';
                return (
                  /Solid |纯色|純色|, background/i.test(lbl) &&
                  !/No background|无背景|無背景|Show background|Hide background|显示背景|顯示背景/i.test(
                    lbl,
                  )
                );
              });
            if (swatch) {
              swatch.setAttribute('data-wb-poster-bg-swatch', '1');
              return 'swatch';
            }
            const openBtn = buttons.find((el) =>
              /Show background options|显示背景选项|顯示背景選項|နောက်ခံ|Hiển thị tùy chọn phông nền|^Aa$/i.test(
                `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim(),
              ),
            );
            openBtn?.setAttribute('data-wb-poster-bg-open', '1');
            return openBtn ? 'open' : 'none';
          }, solidColors)
          .catch(() => 'none');
      let bgState = await markSwatchOrOpen();
      if (bgState === 'open') {
        await clickSel('[data-wb-poster-bg-open="1"]', 450);
        bgState = await markSwatchOrOpen();
      }
      if (bgState === 'swatch') await clickSel('[data-wb-poster-bg-swatch="1"]', 350);
    }
    await markLivePosterDialogAndEditor(page);
    const captionText = material.caption ?? '';
    if (captionText.length > 0) {
      const editorLoc = page.locator('[data-wb-poster-editor="1"]').first();
      await editorLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await editorLoc.click({ timeout: 4000 }).catch(async () => {
        await markLivePosterDialogAndEditor(page);
        await page.evaluate(() => {
          const ed = document.querySelector<HTMLElement>('[data-wb-poster-editor="1"]');
          if (!ed) throw Error('发帖弹窗中未找到文字输入框');
          ed.focus();
          ed.click();
        });
      });
      await page.keyboard.insertText(captionText);
      await wait(scaled(500, paceScale));
    }
    if (material.localFilePath) {
      await markLivePosterDialogAndEditor(page);
      const dialogFileSelector =
        '[data-wb-poster-dialog="1"] input[type="file"], [role="dialog"]:has([data-wb-poster-editor="1"]) input[type="file"], [role="dialog"] input[type="file"]';
      const dialogFileInputs = page.locator(dialogFileSelector);
      if ((await dialogFileInputs.count()) === 0) {
        await page.evaluate(() => {
          const dialog =
            document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]') ??
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) =>
              Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
            );
          Array.from(dialog?.querySelectorAll<HTMLElement>('[role="button"], button') ?? [])
            .find((b) =>
              /Photo\/video|Photo|Video|照片\/视频|相片\/影片|图片|视频|圖片|影片|ဓာတ်ပုံ|ဗီဒီယို|Ảnh\/video/i.test(
                `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
              ),
            )
            ?.click();
        });
        await wait(scaled(600, paceScale));
      }
      const totalInputs = await dialogFileInputs.count();
      if (totalInputs === 0) throw Error('发帖弹窗中未找到媒体上传控件');
      let pickedIndex = 0;
      if (totalInputs > 1) {
        const wantKind = material.mediaKind === 'video' ? 'video' : 'image';
        for (let idx = 0; idx < totalInputs; idx++) {
          const accept = (
            (await dialogFileInputs.nth(idx).getAttribute('accept')) ?? ''
          ).toLowerCase();
          if (accept.includes(wantKind) || (wantKind === 'video' && accept.includes('mp4'))) {
            pickedIndex = idx;
            break;
          }
        }
      }
      await dialogFileInputs.nth(pickedIndex).setInputFiles(material.localFilePath);
      await wait(Math.max(80, Math.round(1200 * paceScale)));
      diag('INFO', 'POSTER_MEDIA_ATTACHED', undefined, {
        mediaKind: material.mediaKind,
        materialId: material.id,
      });
    }
    if (material.aiLabel === 'on' || material.aiLabel === 'off') {
      const wantedAi = material.aiLabel === 'on';
      const clickAi = (sel: string, waitMs: number) =>
        clickSel(`${facebookAILabelScope} ${sel}`, waitMs);
      try {
        let reading = await readFacebookAILabel(page, input.guard);
        if (reading.phase === 'composer' && reading.value !== wantedAi) {
          if (reading.mode === 'inline' && reading.switchEnabled)
            await clickAi(facebookAILabelSwitch, 450);
          else if (reading.mode === 'dialog' && reading.openCSS) {
            await clickAi(reading.openCSS, 0);
            const settingsDeadline = Date.now() + Math.max(400, Math.round(4000 * paceScale));
            while (Date.now() < settingsDeadline && reading.phase !== 'settings') {
              await wait(scaled(250, paceScale));
              reading = await readFacebookAILabel(page, input.guard);
            }
            if (reading.phase === 'settings') {
              if (reading.value !== wantedAi && reading.switchEnabled) {
                await clickAi(facebookAILabelSwitch, 400);
                reading = await readFacebookAILabel(page, input.guard);
              }
              if (reading.phase === 'settings' && reading.confirmEnabled)
                await clickAi('[data-wb-ai-label-confirm="1"]', 450);
            }
          }
        }
      } catch {}
    }
    return true;
  });
}
