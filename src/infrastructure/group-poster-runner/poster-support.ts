import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import {
  inferAbnormalScopeFromUrl,
  inferAbnormalStateFromCodeOrMessage,
} from '../../application/account-abnormal-reporter.js';
import { PosterAccountRestrictedError } from '../../application/group-poster-service.js';
import type { Core } from '../../bridge/core.js';
import type { Awaitable, CompatibleRepository } from '../../domain/persistence.js';
import { classifyFacebookAbnormalUrl } from '../../shared/facebook-browse-route.js';
import { isLocalAvatar } from '../../shared/group-bumper.js';
import type { PosterActionKind } from '../../shared/group-poster.js';
import { relativePostAge } from '../../shared/relative-post-age.js';
import {
  recoverKernelModuleOperations,
  stopOwnedConnectionWithReconnect,
  type KernelInventory,
} from '../facebook-group-session.js';
import {
  extractCreatedGroupPostIdFromGraphQL,
  resolvePosterPendingApprovalState,
} from './poster-network.js';
import { fetchAndLocalizeAccountAvatar } from '../group-bumper-avatar.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupPosterRepository } from '../group-poster-store.js';
import { dismissFeatureInterventionDialogIfPresent } from '../group-inviter-effects.js';
import { extractInPageActorAvatarDom } from '../shared-dom-eval-runtime.js';
import type { KernelBridge } from '../kernel-bridge.js';
export const posterSetupLabels = [
  '打开搜索结果',
  '打开搜索到的小组',
  '打开小组页面',
  '浏览目标帖子',
  '加入小组',
  '关闭入组欢迎弹窗',
  '打开发帖弹窗',
  '填写贴文与附件',
  '等待媒体上传就绪',
] as const;
export const posterSetupKinds: readonly PosterActionKind[] = [
  'setup_search_group',
  'setup_open_group',
  'setup_open_group',
  'setup_browse_group',
  'setup_join_group',
  'setup_dismiss_welcome',
  'setup_open_composer',
  'setup_fill_composer',
  'setup_wait_media_ready',
] as const;
export const posterDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type PosterConnection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;
export type PosterClosingRecord = {
  id: string;
  failed: boolean;
  peerEpoch: string;
  leaseId: string;
  ownershipId?: string | undefined;
  connection: PosterConnection;
};
export type PosterIdentityMeta = {
  identityType: 'page' | 'personal';
  accountAvatar: string | null;
};
export type PosterOpContext = { groupId: string; groupName: string; materialId: string };
export type PosterExecOp = <T>(
  label: (typeof posterSetupLabels)[number],
  work: () => Promise<T>,
) => Promise<T>;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export { extractCreatedGroupPostIdFromGraphQL, resolvePosterPendingApprovalState };
export const recoverPosterOperations = (
  kernel: KernelBridge,
  peer: Parameters<typeof recoverKernelModuleOperations>[0]['peer'],
  repo: CompatibleRepository<SqliteGroupPosterRepository>,
  guard: () => Awaitable<void>,
): Promise<ReadonlySet<string>> =>
  recoverKernelModuleOperations({
    kernel,
    peer,
    guard,
    listOperations: () => repo.listOperationsByProfile(peer.profileId),
    matchLegacySetupKind: (binding) => {
      const idx = posterSetupLabels.findIndex((label, i) => {
        const actionKind = posterSetupKinds[i] ?? 'setup_open_group';
        return (
          binding.actionDigest ===
            posterDigest({
              purpose: 'group-poster',
              actionKind,
              label,
              accountId: binding.accountId,
            }) ||
          binding.actionDigest ===
            posterDigest({ purpose: 'group-poster', label, accountId: binding.accountId })
        );
      });
      return idx >= 0 ? (posterSetupKinds[idx] ?? 'setup_open_group') : null;
    },
    prepareLegacyRow: (binding, actionKind) =>
      repo.prepareOperation({
        binding,
        runId: binding.jobId,
        actionKind: actionKind as PosterActionKind,
        groupId: '',
        groupName: '',
      }),
    isSettled: (row) => row.kernelSettled,
    markSettled: (id) => repo.markOperationKernelSettled(id),
    setResolution: (id, res) => repo.setOperationResolution(id, res),
    digest: posterDigest,
    shouldCreateResolution: (row, state) =>
      (!row.resolution || (row.resolution.outcome === 'NOT_APPLIED' && !row.kernelSettled)) &&
      ['ACKNOWLEDGED', 'UNKNOWN', 'DISPATCHING'].includes(state),
    getNotifyBinding: (row, opBinding) => ({
      ...opBinding,
      actionDigest: row.binding.actionDigest ?? opBinding.actionDigest,
    }),
    onBeforeSubmitResolution: async (row, operationId) => {
      if (row.actionKind === 'submit_post' && row.status === 'PREPARED')
        await repo.markOperationReview(operationId, '发布中途中断，结果待核对');
    },
    resolutionReason: (row) =>
      row.actionKind === 'submit_post'
        ? 'Unconfirmed poster submission ended before reuse'
        : 'Non-submit poster setup ended before reuse',
  });
export async function stopPosterConnection(input: {
  profileId: string;
  conn: PosterConnection;
  stopRec: PosterClosingRecord | undefined;
  stopId: string;
  kernel: KernelBridge | undefined;
  core: Core | undefined;
  posterRepo: CompatibleRepository<SqliteGroupPosterRepository> | undefined;
  connections: Map<string, PosterConnection>;
  closing: Map<string, PosterClosingRecord>;
}): Promise<void> {
  const { profileId, conn, stopRec, kernel, core, posterRepo } = input;
  await stopOwnedConnectionWithReconnect({
    profileId,
    connection: conn,
    stopId: input.stopId,
    failed: Boolean(stopRec?.failed),
    peerEpoch: stopRec?.peerEpoch ?? core?.peers.get(profileId)?.epoch ?? '',
    kernel,
    core,
    errorPrefix: 'POSTER',
    setFailed: () => void (stopRec && (stopRec.failed = true)),
    setStopId: (nextId) => void (stopRec && (stopRec.id = nextId)),
    onBeforeConfirmStop:
      posterRepo && kernel
        ? async (peer) => {
            await recoverPosterOperations(kernel, peer, posterRepo, () => {
              if (core?.peers.get(profileId) !== peer || !peer.online || !peer.synced)
                throw Error('POSTER_RECOVERY_CHANGED');
            });
          }
        : undefined,
    verifyInventoryBeforeStop: stopRec
      ? (state: KernelInventory) => {
          if (
            state.tabs.some(
              (t) =>
                t.ownershipId === stopRec.ownershipId && ['CREATING', 'UNKNOWN'].includes(t.state),
            ) ||
            state.operations.some(
              (o) => o.binding.leaseId === stopRec.leaseId && o.state === 'DISPATCHING',
            )
          )
            throw Error('POSTER_OLD_EXECUTION_UNCONFIRMED');
        }
      : undefined,
  });
  if (input.connections.get(profileId) === conn) input.connections.delete(profileId);
  if (input.closing.get(profileId) === stopRec) input.closing.delete(profileId);
}
export async function readPosterIdentityMeta(
  page: Page,
  accountId: string,
): Promise<PosterIdentityMeta> {
  const [identityType, rawAvatar] = await Promise.all([
    page
      .evaluate(() => (/(?:^|;\s*)i_user=(\d{5,25})/.test(document.cookie) ? 'page' : 'personal'))
      .catch(() => 'personal' as const),
    page
      .evaluate(`(${extractInPageActorAvatarDom.toString()})(${JSON.stringify(accountId)}, true)`)
      .then((v) => (typeof v === 'string' ? v : null))
      .catch(() => null),
  ]);
  const accountAvatar =
    rawAvatar && !isLocalAvatar(rawAvatar)
      ? ((await fetchAndLocalizeAccountAvatar(
          rawAvatar,
          undefined,
          `${identityType}:${accountId}`,
        ).catch(() => null)) ?? rawAvatar)
      : rawAvatar;
  return { identityType: identityType as 'page' | 'personal', accountAvatar };
}
export async function dismissPosterDialogsOnError(page: Page, paceScale: number): Promise<void> {
  const closeFn = (confirmMode: boolean) => {
    const pickVis = (sel: string, root: ParentNode = document) =>
      Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
        (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none',
      );
    if (!confirmMode) {
      try {
        window.onbeforeunload = null;
        if (typeof BeforeUnloadEvent !== 'undefined') {
          BeforeUnloadEvent.prototype.preventDefault = () => {};
          Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', {
            configurable: true,
            get: () => '',
            set: () => {},
          });
        }
      } catch {}
      const closeSel = ['关闭', '關閉', 'Close']
        .flatMap((l) => [`[role="button"][aria-label="${l}"]`, `button[aria-label="${l}"]`])
        .join(',');
      for (const d of pickVis('[role="dialog"]')) pickVis(closeSel, d)[0]?.click();
      return;
    }
    const confirmRx =
      /^(?:舍弃|捨棄|放弃|放棄|不保存|确定|確定|Discard|Discard\s*post|Leave|Leave\s*Page)$/i;
    for (const d of pickVis('[role="dialog"],[role="alertdialog"],[aria-modal="true"]'))
      pickVis('[role="button"],button', d)
        .find((el) =>
          confirmRx.test(
            (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
          ),
        )
        ?.click();
  };
  await page.evaluate(closeFn, false).catch(() => {});
  await wait(Math.max(20, Math.round(300 * paceScale)));
  await page.evaluate(closeFn, true).catch(() => {});
}
export async function readCheckedPosterSurface(
  page: Page,
  query: { groupId: string; pageId?: string },
  guard: () => void,
): Promise<Awaited<ReturnType<typeof readGroupBumper>>> {
  let surface = await readGroupBumper(page, query);
  if (surface.restricted && !surface.restrictionReason) {
    await dismissFeatureInterventionDialogIfPresent(page, guard);
    surface = await readGroupBumper(page, query);
  }
  if (surface.restricted || /\/(?:checkpoint|login)(?:\/|$|\?)/i.test(page.url())) {
    const scope = inferAbnormalScopeFromUrl(page.url()) ?? 'feature_action';
    throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限', {
      scope,
      abnormalState:
        inferAbnormalStateFromCodeOrMessage(classifyFacebookAbnormalUrl(page.url()) ?? '受限') ??
        'restricted',
    });
  }
  return surface;
}
export async function searchAndEnterPosterGroup(input: {
  getPage: () => Page;
  rawGroupId: string;
  effectiveGroupName: string;
  paceScale: number;
  guard: () => void;
  paceWait: (ms: number) => Promise<void>;
  execOp: PosterExecOp;
}): Promise<{ enteredGroup: boolean; enteredViaDirectOrId: boolean }> {
  const { getPage, effectiveGroupName, paceScale, guard, execOp } = input;
  let enteredGroup = false;
  let enteredViaDirectOrId = false;
  const searchUrl = `https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(effectiveGroupName)}`;
  const groupUrlOk = (u: URL) => /^\/groups\/(?!search(?:\/|$))[^/]+/i.test(u.pathname);
  await execOp('打开搜索结果', async () => {
    const activePage = getPage();
    const markBannerSearch = () =>
      activePage
        .evaluate(() => {
          const pick = (sel: string) =>
            Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
              (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
            );
          document
            .querySelectorAll('[data-wb-poster-search]')
            .forEach((e) => e.removeAttribute('data-wb-poster-search'));
          const hit = pick(
            '[role="banner"] input[type="search"], [role="banner"] input[role="combobox"], [role="banner"] input',
          );
          if (hit) {
            hit.setAttribute('data-wb-poster-search', '1');
            return 'input';
          }
          const toggle = pick(
            '[role="banner"] [role="button"][aria-label*="Search" i], [role="banner"] [role="button"][aria-label*="搜索"], [role="banner"] [role="button"][aria-label*="搜尋"], [role="banner"] [role="button"][aria-label*="ရှာ"], [role="banner"] label',
          );
          toggle?.click();
          return toggle ? 'toggled' : 'none';
        })
        .catch(() => 'none');
    let searchState = await markBannerSearch();
    if (searchState === 'toggled') {
      await wait(Math.max(50, Math.round(450 * paceScale)));
      searchState = await markBannerSearch();
    }
    if (searchState === 'input') {
      try {
        const box = activePage.locator('[data-wb-poster-search="1"]').first();
        await box.click({ timeout: 3000 });
        await box.fill(effectiveGroupName, { timeout: 3000 });
        await box.press('Enter', { timeout: 3000 });
        await activePage.waitForURL((u) => /^\/(?:groups\/)?search\//i.test(u.pathname), {
          timeout: 6000,
        });
        return activePage.url();
      } catch {}
    }
    await activePage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    return activePage.url();
  });
  const searchQuery = { groupId: input.rawGroupId, groupName: effectiveGroupName };
  for (let screen = 0; screen < 5 && !enteredGroup; screen++) {
    guard();
    let found = await readGroupBumper(getPage(), searchQuery);
    if (found.restricted && !found.restrictionReason) {
      await dismissFeatureInterventionDialogIfPresent(getPage(), guard);
      found = await readGroupBumper(getPage(), searchQuery);
    }
    if (found.restricted) throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
    if (found.groupEntryCSS) {
      const navUrl = await execOp('打开搜索到的小组', async () => {
        const opPage = getPage();
        const refreshed = await readGroupBumper(opPage, searchQuery);
        if (!refreshed.groupEntryCSS) throw Error('未找到小组链接');
        const link = opPage.locator(refreshed.groupEntryCSS).first();
        await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await wait(Math.max(50, Math.round(350 * paceScale)));
        try {
          await link.click({ timeout: 5000 });
          await opPage.waitForURL(groupUrlOk, { timeout: 12000 });
          return opPage.url();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/Cannot find context with specified id|Execution context was destroyed/i.test(msg))
            throw err;
          await wait(400);
          if (groupUrlOk(new URL(getPage().url()))) return getPage().url();
          await getPage()
            .waitForURL(groupUrlOk, { timeout: 5000 })
            .catch(() => {});
          return groupUrlOk(new URL(getPage().url())) ? getPage().url() : '';
        }
      }).catch(() => '');
      if (navUrl && groupUrlOk(new URL(navUrl))) {
        enteredGroup = true;
        enteredViaDirectOrId = found.groupEntryMatchedBy === 'id';
      }
      break;
    }
    if (screen < 4) {
      await execOp('浏览目标帖子', async () => {
        await getPage().mouse.wheel(0, 620);
        return true;
      });
      await input.paceWait(650);
    }
  }
  return { enteredGroup, enteredViaDirectOrId };
}
export const readPosterApprovalNotices = (page: Page): Promise<string[]> =>
  page
    .evaluate(() => {
      const rx =
        /待管理员审核|等待管理员审核|管理員審核|等待管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核|စိစစ်|ခွင့်ပြု|ဆိုင်းငံ့|စောင့်ဆိုင်း|chờ phê duyệt|đang chờ duyệt|quản trị viên phê duyệt|รออนุมัติ|รอผู้ดูแลอนุมัติ/i;
      const alerts = Array.from(
        document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"], [aria-live]'),
      )
        .map((el) => (el.innerText || el.textContent || '').trim())
        .filter((t) => t.length > 0 && rx.test(t));
      const banners = Array.from(
        document.querySelectorAll<HTMLElement>('a[href*="/my_pending_content"]'),
      )
        .map((el) =>
          (
            (el.parentElement?.parentElement ?? el.parentElement ?? el).innerText ||
            el.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((t) => t.length > 0 && t.length <= 240);
      const rawLines = (document.body?.innerText?.slice(0, 4000) ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const bodyLines = rawLines.flatMap((line, i) =>
        !rx.test(line)
          ? []
          : rawLines[i + 1] && /\d|post|篇|ပို့စ်/i.test(rawLines[i + 1] ?? '')
            ? [line, `${line} ${rawLines[i + 1]}`]
            : [line],
      );
      return [...new Set([...alerts, ...banners, ...bodyLines])];
    })
    .catch(() => [] as string[]);
export async function readDomCreatedPostFallback(
  page: Page,
  opts: {
    accountId: string;
    effectiveGroupId: string;
    isPageTimeline: boolean;
    preSubmitPostIds: ReadonlySet<string>;
  },
): Promise<{ postId: string | null; transcoding: boolean }> {
  const probe = await page
    .evaluate(
      ({ accountId, groupId, isTimeline }) => {
        const transcodingRx =
          /video is being processed|processing your video|we['’]?ll let you know when your video is ready|正在处理.*视频|正在處理.*影片|ဗီဒီယို.*လုပ်ဆောင်နေ|video đang được xử lý|กำลังประมวลผลวิดีโอ/i;
        const statusText = Array.from(
          document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], [role="main"]'),
        )
          .slice(0, 8)
          .map((el) => (el.textContent ?? '').slice(0, 800))
          .join(' ');
        const idRx =
          /(?:(?:\/groups\/[^/]+|\/[^/]+)?\/(?:posts|videos|permalink|reel)\/|[?&]story_fbid=)(\d{6,25}|pfbid[A-Za-z0-9]{8,})/i;
        const candidates: Array<{ postId: string; authorMatched: boolean; timeTexts: string[] }> =
          [];
        const seen = new Set<string>();
        const safeAccount = accountId.toLowerCase();
        const safeGroup = groupId.toLowerCase();
        for (const unit of Array.from(
          document.querySelectorAll<HTMLElement>('[role="feed"] > *, [role="article"]'),
        ).slice(0, 14)) {
          if (unit.closest('[role="dialog"]')) continue;
          const links = Array.from(unit.querySelectorAll<HTMLAnchorElement>('a[href]'));
          const postId = links
            .map((l) => l.href || l.getAttribute('href') || '')
            .filter(
              (h) => isTimeline || !h.includes('/groups/') || h.toLowerCase().includes(safeGroup),
            )
            .map((h) => idRx.exec(h)?.[1] ?? null)
            .find(Boolean);
          if (!postId || seen.has(postId)) continue;
          seen.add(postId);
          const authorMatched = links.some((link) => {
            const h = (link.href || link.getAttribute('href') || '').toLowerCase();
            return (
              h.includes(`/user/${safeAccount}`) ||
              h.includes(`profile.php?id=${safeAccount}`) ||
              h.includes(`/${safeAccount}/`) ||
              h.endsWith(`/${safeAccount}`)
            );
          });
          const timeTexts = Array.from(
            unit.querySelectorAll<HTMLElement>('a[href], abbr, time, span[aria-label], span'),
          )
            .slice(0, 40)
            .flatMap((el) => [el.getAttribute('aria-label') ?? '', el.textContent ?? ''])
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length <= 40);
          candidates.push({ postId, authorMatched, timeTexts });
        }
        return { candidates, transcoding: transcodingRx.test(statusText) };
      },
      {
        accountId: opts.accountId,
        groupId: opts.effectiveGroupId,
        isTimeline: opts.isPageTimeline,
      },
    )
    .catch(() => ({ candidates: [], transcoding: false }));
  const matched = probe.candidates.find(
    (c) =>
      c.authorMatched &&
      !opts.preSubmitPostIds.has(c.postId) &&
      c.timeTexts.some((t) => {
        const age = relativePostAge(t);
        return age !== null && age <= 5 / 60;
      }),
  );
  return { postId: matched?.postId ?? null, transcoding: probe.transcoding };
}
