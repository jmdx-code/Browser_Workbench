import type { Page } from 'playwright-core';
import {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
} from '../../application/group-poster-service.js';
import type { CompatibleRepository } from '../../domain/persistence.js';
import {
  facebookAILabelScope,
  facebookAILabelSwitch,
  nativeSolidBackgrounds,
} from '../../shared/facebook-post-options.js';
import { isLocalAvatar, isPlaceholderTargetName } from '../../shared/group-bumper.js';
import {
  canPosterMaterialUseColorBackground,
  type PosterMaterial,
} from '../../shared/group-poster.js';
import { readFacebookAILabel } from '../facebook-ai-label-reader.js';
import {
  checkGroupPendingOrQuestions,
  FacebookGroupSessionHelper,
} from '../facebook-group-session.js';
import { dismissUnexpectedFacebookOverlays } from '../facebook-overlay-dismisser.js';
import { fetchAndLocalizeAvatar, fetchAndLocalizeAccountAvatar } from '../group-bumper-avatar.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupBumperRepository } from '../group-bumper-store.js';
import { dismissFeatureInterventionDialogIfPresent } from '../group-inviter-effects.js';
import {
  readCheckedPosterSurface,
  searchAndEnterPosterGroup,
  type PosterExecOp,
  type PosterIdentityMeta,
  type PosterOpContext,
} from './poster-support.js';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function preparePosterTargetSurface(input: {
  page: Page;
  accountId: string;
  rawGroupId: string;
  initialEffectiveGroupId: string;
  initialEffectiveGroupName: string;
  groupAvatarUrl: string | null;
  isPageTimeline: boolean;
  identityMeta: PosterIdentityMeta;
  paceScale: number;
  bumperRepo: CompatibleRepository<SqliteGroupBumperRepository>;
  callbacks: GroupPosterBrowserCallbacks;
  guard: () => void;
  paceWait: (ms: number) => Promise<void>;
  execOp: PosterExecOp;
  updateContext: (patch: Partial<PosterOpContext>) => void;
}): Promise<
  | { status: 'skipped' }
  | {
      status: 'ready';
      effectiveGroupId: string;
      effectiveGroupName: string;
      resolvedGroupAvatar: string | null;
      surface: Awaited<ReturnType<typeof readGroupBumper>>;
    }
> {
  const {
    page,
    accountId,
    rawGroupId,
    groupAvatarUrl,
    isPageTimeline,
    identityMeta,
    paceScale,
    bumperRepo,
    callbacks,
    guard,
    paceWait,
    execOp,
    updateContext,
  } = input;
  let effectiveGroupId = input.initialEffectiveGroupId;
  let effectiveGroupName = input.initialEffectiveGroupName;
  let surface: Awaited<ReturnType<typeof readGroupBumper>>;
  let resolvedGroupAvatar: string | null = null;
  if (isPageTimeline) {
    callbacks.status(`正在打开专页时间线 · ${effectiveGroupName}`);
    await execOp('打开小组页面', async () => {
      await page.goto('https://www.facebook.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      return page.url();
    });
    await paceWait(1200);
    surface = await readCheckedPosterSurface(page, { groupId: '-', pageId: accountId }, guard);
    return {
      status: 'ready',
      effectiveGroupId,
      effectiveGroupName,
      resolvedGroupAvatar: identityMeta.accountAvatar,
      surface,
    };
  }
  callbacks.status(`正在搜索小组 · ${effectiveGroupName}`);
  const directUrl = `https://www.facebook.com/groups/${encodeURIComponent(rawGroupId)}/`;
  let enteredGroup = false;
  let enteredViaDirectOrId = false;
  if (!isPlaceholderTargetName(effectiveGroupName, rawGroupId)) {
    const searched = await searchAndEnterPosterGroup({
      page,
      rawGroupId,
      effectiveGroupName,
      paceScale,
      guard,
      paceWait,
      execOp,
    });
    enteredGroup = searched.enteredGroup;
    enteredViaDirectOrId = searched.enteredViaDirectOrId;
  }
  if (!enteredGroup || !page.url().includes('/groups/')) {
    await execOp('打开小组页面', async () => {
      await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return page.url();
    });
    enteredViaDirectOrId = true;
  }
  await paceWait(1200);
  surface = await readCheckedPosterSurface(page, { groupId: effectiveGroupId }, guard);
  const localizeGroupAvatar = async (rawAvatar: string | null | undefined) => {
    if (isLocalAvatar(groupAvatarUrl)) return groupAvatarUrl;
    if (!rawAvatar || isLocalAvatar(rawAvatar)) return rawAvatar ?? null;
    return (await fetchAndLocalizeAvatar(rawAvatar).catch(() => null)) ?? rawAvatar;
  };
  const syncRedirectStep = async (allowAliasRedirect: boolean): Promise<boolean> => {
    resolvedGroupAvatar = (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
    const redirectRes = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
      currentUrl: page.url(),
      rawGroupId,
      groupName: surface.groupTitle || effectiveGroupName,
      avatarUrl: resolvedGroupAvatar,
      surfaceGroupIds: surface.groupIds,
      allowAliasRedirect,
      applyResolvedMetadata: allowAliasRedirect
        ? (rawId, resolved) => bumperRepo.applyResolvedTargetMetadata?.('groups', rawId, resolved)
        : undefined,
    });
    effectiveGroupId = redirectRes.effectiveGroupId;
    if (effectiveGroupId !== rawGroupId) {
      updateContext({ groupId: effectiveGroupId });
      const resolved = await callbacks.onGroupIdResolved?.(rawGroupId, effectiveGroupId);
      if (resolved?.alreadyPosted) {
        callbacks.status(`已发过该贴文，跳过重复小组 · ${effectiveGroupName}`);
        return false;
      }
      surface = await readGroupBumper(page, { groupId: effectiveGroupId });
      resolvedGroupAvatar = (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
    }
    return true;
  };
  if (!(await syncRedirectStep(enteredViaDirectOrId))) return { status: 'skipped' };
  if (!surface.groupIds.includes(effectiveGroupId.toLowerCase())) {
    await execOp('打开小组页面', async () => {
      await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return page.url();
    });
    await paceWait(1000);
    surface = await readGroupBumper(page, { groupId: effectiveGroupId });
    if (!(await syncRedirectStep(true))) return { status: 'skipped' };
  }
  surface = await readCheckedPosterSurface(page, { groupId: effectiveGroupId }, guard);
  if (resolvedGroupAvatar) {
    await bumperRepo.updateAvatar?.('groups', effectiveGroupId, resolvedGroupAvatar);
  }
  if (surface.groupTitle && isPlaceholderTargetName(effectiveGroupName, effectiveGroupId)) {
    await bumperRepo.applyResolvedTargetMetadata?.('groups', effectiveGroupId, {
      name: surface.groupTitle,
      avatarUrl: resolvedGroupAvatar,
    });
    effectiveGroupName = surface.groupTitle;
    updateContext({ groupName: surface.groupTitle });
  }
  callbacks.status(`正在浏览小组贴文 · ${effectiveGroupName}`);
  await execOp('浏览目标帖子', async () => {
    await page.evaluate(() => window.scrollBy({ top: 520, behavior: 'smooth' }));
    await wait(Math.max(40, Math.round((1200 + Math.random() * 600) * paceScale)));
    await page.evaluate(() => window.scrollBy({ top: 540, behavior: 'smooth' }));
    await wait(Math.max(40, Math.round((1300 + Math.random() * 600) * paceScale)));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await wait(Math.max(40, Math.round(900 * paceScale)));
    await page.evaluate(() => {
      if (window.scrollY > 40) window.scrollTo(0, 0);
    });
    return true;
  });
  surface = await readGroupBumper(page, { groupId: effectiveGroupId });
  const dismissWelcomeIfPresent = async (css: string | null | undefined) => {
    if (!css) return false;
    await execOp('关闭入组欢迎弹窗', async () => {
      await page
        .locator(css)
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      return true;
    });
    return true;
  };
  if (await dismissWelcomeIfPresent(surface.welcomeDismissCSS)) {
    surface = await readGroupBumper(page, { groupId: effectiveGroupId });
  }
  if (surface.joinGroupCSS) {
    const joinSel = surface.joinGroupCSS;
    callbacks.status(`正在加入小组 · ${effectiveGroupName}`);
    const joinOutcome = await execOp('加入小组', async () => {
      await page
        .locator(joinSel)
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      await wait(Math.max(50, Math.round(2000 * paceScale)));
      const afterJoin = await readGroupBumper(page, { groupId: effectiveGroupId });
      if (afterJoin.restricted && !afterJoin.restrictionReason) {
        await dismissFeatureInterventionDialogIfPresent(page, guard);
        return { unjoinableIntervention: true };
      }
      return { unjoinableIntervention: false };
    });
    if (joinOutcome.unjoinableIntervention) throw Error('跳过：当前身份暂不支持直接加入该群');
    surface = await readGroupBumper(page, { groupId: effectiveGroupId });
    if (surface.restricted && !surface.restrictionReason) {
      await dismissFeatureInterventionDialogIfPresent(page, guard);
      throw Error('跳过：当前身份暂不支持直接加入该群');
    }
    await dismissWelcomeIfPresent(surface.welcomeDismissCSS);
  }
  if (await checkGroupPendingOrQuestions(page)) {
    throw Error('跳过：该群需管理员审核或回答入群问题');
  }
  return {
    status: 'ready',
    effectiveGroupId,
    effectiveGroupName,
    resolvedGroupAvatar,
    surface,
  };
}
export async function openAndFillPosterComposer(input: {
  page: Page;
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
  const {
    page,
    accountId,
    groupDisplayName,
    effectiveGroupName,
    isPageTimeline,
    material,
    identityMeta,
    paceScale,
    callbacks,
    guard,
    execOp,
  } = input;
  callbacks.status(`正在打开发帖框 · ${effectiveGroupName}`);
  await execOp('打开发帖弹窗', async () => {
    await dismissUnexpectedFacebookOverlays(page);
    const triggerResult = await page.evaluate((timelineMode: boolean) => {
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
          return {
            ok: false as const,
            restricted: true as const,
            diag: 'group-posting-restricted-banner',
          };
      }
      const excludeRx =
        /^(?:Manage|Promote|Advertise|Professional dashboard|Edit|Edit profile|Add to story|Create story|Boost|Insights|Live video|Photo\/video|Feeling\/activity|Reel|Reels|专业仪表板|管理|推广|广告|编辑|编辑主页|添加快拍|创建快拍|速推|数据洞察|直播视频|直播|照片\/视频|感受\/活动|打卡)$/i;
      const rx =
        /Write something|What['’]?s on your mind|留個言吧|留个言吧|写点什么|寫點什麼|写些什么|寫些什麼|分享你的|有什么新鲜事|有什麼新鮮事|在想些什么|在想些什麼|Create a public post|Create post|Create a post|建立公開貼文|建立貼文|创建帖子|Start a discussion|发起讨论|發起討論|တစ်ခုခု\s*ရေးပါ|ဘာတွေ\s*တွေးနေလဲ|သင့်စိတ်ထဲ|ဘာတွေရှိ|ပို့စ်\s*ဖန်တီး|ပို့စ်\s*တင်ပါ|ပို့စ်\s*ရေးပါ|အများမြင်သာအောင်|ဆွေးနွေးမှု|Viết gì đó|Bạn đang nghĩ gì|بم تفكر/i;
      const regionSel = ['Create a post', '创建帖子', '建立貼文', 'ပို့စ် ဖန်တီးရန်', 'إنشاء منشور']
        .map((l) => `[role="region"][aria-label="${l}"]`)
        .join(',');
      const labelOf = (b: Element) =>
        `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.trim();
      const regionBtns = Array.from(
        document.querySelectorAll<HTMLElement>(`${regionSel} [role="button"], ${regionSel} button`),
      ).filter((b) => {
        if (!isVis(b)) return false;
        const r = b.getBoundingClientRect();
        return r.width >= 120 && r.height <= 90 && !excludeRx.test(labelOf(b));
      });
      const regionPrompt =
        regionBtns.find((b) => rx.test(labelOf(b))) ??
        regionBtns.find((b) => !b.getAttribute('aria-label'));
      const allButtons = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"], button, [role="textbox"]'),
      ).filter(
        (el) =>
          isVis(el) &&
          !el.closest('[role="banner"], [role="tablist"], [role="feed"]') &&
          !excludeRx.test((el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
      );
      const matched =
        regionPrompt ??
        allButtons.find((b) => rx.test(`${labelOf(b)} ${b.getAttribute('placeholder') ?? ''}`)) ??
        (!timelineMode
          ? Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-pagelet*="GroupInlineComposer"] [role="button"]',
              ),
            ).find(
              (b) =>
                isVis(b) &&
                !b.closest('[role="banner"]') &&
                b.getBoundingClientRect().left >= 220 &&
                b.getBoundingClientRect().width >= 160,
            )
          : undefined) ??
        allButtons.find((b) => {
          const r = b.getBoundingClientRect();
          if (
            r.left < 220 ||
            r.width < 200 ||
            r.height < 28 ||
            r.height > 84 ||
            r.top < 70 ||
            r.top > 780
          )
            return false;
          for (
            let anc: HTMLElement | null = b.parentElement, d = 0;
            d < 5 && anc;
            d++, anc = anc.parentElement
          ) {
            if (
              anc.querySelector('a[href*="/user/"], a[href*="/profile.php"], svg image, image, img')
            )
              return true;
          }
          return false;
        });
      if (matched) {
        matched.setAttribute('data-wb-poster-trigger', '1');
        return { ok: true as const, restricted: false as const, diag: '' };
      }
      const wideSample = allButtons
        .filter((b) => b.getBoundingClientRect().width >= 140)
        .slice(0, 6)
        .map((b) => {
          const r = b.getBoundingClientRect();
          return `${Math.round(r.left)},${Math.round(r.top)}:${Math.round(r.width)}x${Math.round(r.height)}`;
        })
        .join('|');
      return {
        ok: false as const,
        restricted: false as const,
        diag: `all=${allButtons.length}[${wideSample}] url=${location.pathname}`,
      };
    }, isPageTimeline);
    if (!triggerResult.ok) {
      if (triggerResult.restricted)
        throw new PosterAccountRestrictedError('发小组受限 · 该账号当前无法在小组发帖', {
          scope: 'feature_action',
        });
      throw Error(
        isPageTimeline
          ? `专页时间线未找到发帖框 (${triggerResult.diag})`
          : `小组未开放发帖框 (${triggerResult.diag})`,
      );
    }
    const trigger = page.locator('[data-wb-poster-trigger="1"]').first();
    await trigger.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await trigger.click({ timeout: 5000 });
    const dialogDeadline = Date.now() + Math.max(500, Math.round(8000 * paceScale));
    let composerOpened = false;
    let restrictedPopupText: string | null = null;
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
            ).some((el) => {
              const er = el.getBoundingClientRect();
              return er.width > 50 && er.height > 14;
            })
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
        restrictedPopupText = dialogProbe.restrictionText;
        break;
      }
      await wait(200);
    }
    if (restrictedPopupText) {
      await dismissFeatureInterventionDialogIfPresent(page, guard).catch(() => {});
      throw new PosterAccountRestrictedError(
        isPageTimeline
          ? `专页发帖受限：${restrictedPopupText.slice(0, 48)}`
          : '发小组受限 · 该账号当前无法在小组发帖',
        { scope: 'feature_action' },
      );
    }
    if (!composerOpened) {
      throw Error(
        isPageTimeline
          ? '专页时间线发帖弹窗未打开'
          : '小组发帖弹窗未打开（可能发小组受限或无发帖权限）',
      );
    }
    return true;
  });
  callbacks.status(`正在填写贴文并上传媒体 · ${groupDisplayName}`);
  await execOp('填写贴文与附件', async () => {
    const markedEditor = await page.evaluate(() => {
      document.querySelectorAll('[data-wb-poster-editor], [data-wb-poster-dialog]').forEach((e) => {
        e.removeAttribute('data-wb-poster-editor');
        e.removeAttribute('data-wb-poster-dialog');
      });
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        (d) => {
          const r = d.getBoundingClientRect();
          return r.width > 200 && r.height > 150;
        },
      );
      for (let i = dialogs.length - 1; i >= 0; i--) {
        const d = dialogs[i];
        if (!d) continue;
        const editor = Array.from(
          d.querySelectorAll<HTMLElement>(
            '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"]',
          ),
        ).find((el) => {
          const er = el.getBoundingClientRect();
          return er.width > 50 && er.height > 14;
        });
        if (editor) {
          d.setAttribute('data-wb-poster-dialog', '1');
          editor.setAttribute('data-wb-poster-editor', '1');
          editor.focus();
          return true;
        }
      }
      return false;
    });
    if (!markedEditor) throw Error('发帖弹窗中未找到文字输入框');
    if (!identityMeta.accountAvatar) {
      const dialogAvatar = await page
        .evaluate(() => {
          const dialog = document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]');
          if (!dialog) return null;
          const dr = dialog.getBoundingClientRect();
          for (const node of Array.from(dialog.querySelectorAll('svg image, img'))) {
            const r = node.getBoundingClientRect();
            if (
              r.width >= 28 &&
              r.width <= 60 &&
              r.top - dr.top <= 160 &&
              r.left - dr.left <= 120
            ) {
              const src =
                node.getAttribute('xlink:href') ||
                node.getAttribute('href') ||
                node.getAttribute('src') ||
                '';
              if (
                src.startsWith('https://') &&
                /fbcdn\.net|fbsbx\.com/i.test(src) &&
                !/\/rsrc\.php\//i.test(src)
              )
                return src;
            }
          }
          return null;
        })
        .catch(() => null);
      if (dialogAvatar) {
        const localized = await fetchAndLocalizeAccountAvatar(
          dialogAvatar,
          undefined,
          `${identityMeta.identityType}:${accountId}`,
        ).catch(() => null);
        identityMeta.accountAvatar = localized ?? dialogAvatar;
      }
    }
    if (!material.localFilePath && canPosterMaterialUseColorBackground(material)) {
      const solidColors = nativeSolidBackgrounds.map((s) => s.color);
      const markSwatchOrOpen = async () =>
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
              if (r.width <= 0 || r.height <= 0) return false;
              const s = getComputedStyle(el);
              return s.display !== 'none' && s.visibility !== 'hidden';
            });
            const swatch =
              buttons.find((el) =>
                [el, ...Array.from(el.children)].some((node) => {
                  const st = getComputedStyle(node);
                  return colors.includes(st.backgroundColor) && st.backgroundImage === 'none';
                }),
              ) ??
              buttons.find((el) => {
                const label = el.getAttribute('aria-label') ?? '';
                return (
                  /Solid |纯色|純色|, background/i.test(label) &&
                  !/No background|无背景|無背景|Show background|Hide background|显示背景|顯示背景/i.test(
                    label,
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
            if (openBtn) {
              openBtn.setAttribute('data-wb-poster-bg-open', '1');
              return 'open';
            }
            return 'none';
          }, solidColors)
          .catch(() => 'none');
      let bgState = await markSwatchOrOpen();
      if (bgState === 'open') {
        await page
          .locator('[data-wb-poster-bg-open="1"]')
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
        await wait(Math.max(50, Math.round(450 * paceScale)));
        bgState = await markSwatchOrOpen();
      }
      if (bgState === 'swatch') {
        await page
          .locator('[data-wb-poster-bg-swatch="1"]')
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
        await wait(Math.max(50, Math.round(350 * paceScale)));
      }
    }
    await page.locator('[data-wb-poster-editor="1"]').first().click({ timeout: 4000 });
    if (material.caption) {
      await page.keyboard.insertText(material.caption);
      await wait(Math.max(50, Math.round(500 * paceScale)));
    }
    if (material.localFilePath) {
      const dialogFileSelector =
        '[data-wb-poster-dialog="1"] input[type="file"], [role="dialog"]:has([data-wb-poster-editor="1"]) input[type="file"]';
      let hasInput = (await page.locator(dialogFileSelector).count()) > 0;
      if (!hasInput) {
        await page.evaluate(() => {
          const dialog =
            document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]') ??
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) =>
              Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
            );
          if (!dialog) return;
          Array.from(dialog.querySelectorAll<HTMLElement>('[role="button"], button'))
            .find((b) =>
              /Photo\/video|Photo|Video|照片\/视频|相片\/影片|图片|视频|圖片|影片|ဓာတ်ပုံ|ဗီဒီယို|Ảnh\/video/i.test(
                `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
              ),
            )
            ?.click();
        });
        await wait(Math.max(50, Math.round(600 * paceScale)));
        hasInput = (await page.locator(dialogFileSelector).count()) > 0;
      }
      if (!hasInput) throw Error('发帖弹窗中未找到媒体上传控件');
      const dialogFileInputs = page.locator(dialogFileSelector);
      const totalInputs = await dialogFileInputs.count();
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
    }
    if (material.aiLabel === 'on' || material.aiLabel === 'off') {
      const wantedAi = material.aiLabel === 'on';
      const clickAi = (sel: string, waitMs: number) =>
        page
          .locator(`${facebookAILabelScope} ${sel}`)
          .first()
          .click({ timeout: 3000 })
          .catch(() => {})
          .then(() => wait(Math.max(40, Math.round(waitMs * paceScale))));
      try {
        let reading = await readFacebookAILabel(page, guard);
        if (reading.phase === 'composer' && reading.value !== wantedAi) {
          if (reading.mode === 'inline' && reading.switchEnabled) {
            await clickAi(facebookAILabelSwitch, 450);
          } else if (reading.mode === 'dialog' && reading.openCSS) {
            await clickAi(reading.openCSS, 0);
            const settingsDeadline = Date.now() + Math.max(400, Math.round(4000 * paceScale));
            while (Date.now() < settingsDeadline) {
              await wait(Math.max(40, Math.round(250 * paceScale)));
              reading = await readFacebookAILabel(page, guard);
              if (reading.phase === 'settings') break;
            }
            if (reading.phase === 'settings') {
              if (reading.value !== wantedAi && reading.switchEnabled) {
                await clickAi(facebookAILabelSwitch, 400);
                reading = await readFacebookAILabel(page, guard);
              }
              if (reading.phase === 'settings' && reading.confirmEnabled) {
                await clickAi('[data-wb-ai-label-confirm="1"]', 450);
              }
            }
          }
        }
      } catch {}
    }
    return true;
  });
}
