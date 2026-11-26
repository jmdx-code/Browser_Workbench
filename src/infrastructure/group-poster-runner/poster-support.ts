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
import {
  parseFacebookJsonChunks,
  recoverKernelModuleOperations,
  stopOwnedConnectionWithReconnect,
  type KernelInventory,
} from '../facebook-group-session.js';
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
export type PosterOpContext = {
  groupId: string;
  groupName: string;
  materialId: string;
};
export type PosterExecOp = <T>(
  label: (typeof posterSetupLabels)[number],
  work: () => Promise<T>,
) => Promise<T>;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function recoverPosterOperations(
  kernel: KernelBridge,
  peer: Parameters<typeof recoverKernelModuleOperations>[0]['peer'],
  repo: CompatibleRepository<SqliteGroupPosterRepository>,
  guard: () => Awaitable<void>,
): Promise<ReadonlySet<string>> {
  return recoverKernelModuleOperations({
    kernel,
    peer,
    guard,
    listOperations: () => repo.listOperationsByProfile(peer.profileId),
    matchLegacySetupKind: (binding) => {
      const index = posterSetupLabels.findIndex((label, idx) => {
        const actionKind = posterSetupKinds[idx] ?? 'setup_open_group';
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
      return index >= 0 ? (posterSetupKinds[index] ?? 'setup_open_group') : null;
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
    markSettled: (operationId) => repo.markOperationKernelSettled(operationId),
    setResolution: (operationId, resolution) =>
      repo.setOperationResolution(operationId, resolution),
    digest: posterDigest,
    shouldCreateResolution: (row, state) =>
      (!row.resolution || (row.resolution.outcome === 'NOT_APPLIED' && !row.kernelSettled)) &&
      ['ACKNOWLEDGED', 'UNKNOWN', 'DISPATCHING'].includes(state),
    getNotifyBinding: (row, opBinding) => ({
      ...opBinding,
      actionDigest: row.binding.actionDigest ?? opBinding.actionDigest,
    }),
    onBeforeSubmitResolution: async (row, operationId) => {
      if (row.actionKind === 'submit_post' && row.status === 'PREPARED') {
        await repo.markOperationReview(operationId, '发布中途中断，结果待核对');
      }
    },
    resolutionReason: (row) =>
      row.actionKind === 'submit_post'
        ? 'Unconfirmed poster submission ended before reuse'
        : 'Non-submit poster setup ended before reuse',
  });
}
function decodeStoryPostId(raw: string): string | null {
  if (/^\d{6,25}$/.test(raw)) return raw;
  const colonMatch = /:(\d{6,25})(?:$|:)/.exec(raw);
  if (colonMatch?.[1]) return colonMatch[1];
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const m = /:(\d{6,25})(?:$|:)/.exec(decoded) ?? /(\d{8,25})/.exec(decoded);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
const posterApprovalPattern =
  /待管理员审核|等待管理员审核|管理員審核|等待管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核|စိစစ်|ခွင့်ပြု|ဆိုင်းငံ့|စောင့်ဆိုင်း|chờ phê duyệt|đang chờ duyệt|quản trị viên phê duyệt|รออนุมัติ|รอผู้ดูแลอนุมัติ/i;
export function resolvePosterPendingApprovalState(input: {
  hasComposer: boolean;
  graphqlPendingApproval: boolean;
  preSubmitNotices: readonly string[];
  currentNotices: readonly string[];
}): boolean {
  if (input.hasComposer) return false;
  if (input.graphqlPendingApproval) return true;
  const preSet = new Set(input.preSubmitNotices.map((s) => s.trim()).filter(Boolean));
  return input.currentNotices.some((s) => {
    const trimmed = s.trim();
    return trimmed.length > 0 && posterApprovalPattern.test(trimmed) && !preSet.has(trimmed);
  });
}
export function extractCreatedGroupPostIdFromGraphQL(body: string): {
  postId: string | null;
  restricted: boolean;
  pendingApproval?: boolean;
} {
  const restricted =
    /Temporarily Blocked|暂时被禁止|限制了某些活动|restrict certain activity|checkpoint_required|1357031|1357004|368/i.test(
      body,
    );
  let pendingApproval = false;
  let sawError = false;
  const chunks =
    parseFacebookJsonChunks(body) ??
    body
      .trim()
      .replace(/^for\s*\(;;\);\s*/, '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line.replace(/^for\s*\(;;\);\s*/, '')) as unknown;
        } catch {
          return null;
        }
      });
  for (const parsed of chunks) {
    if (typeof parsed !== 'object' || parsed === null) continue;
    const errors = Reflect.get(parsed, 'errors');
    const lineHasError = Array.isArray(errors) && errors.length > 0;
    if (lineHasError) {
      sawError = true;
      if (/checkpoint|restrict|blocked|13570|368|验证|受限/i.test(JSON.stringify(errors))) {
        return { postId: null, restricted: true, pendingApproval: false };
      }
    }
    const data = Reflect.get(parsed, 'data');
    if (typeof data !== 'object' || data === null) continue;
    const storyCreate =
      Reflect.get(data, 'story_create') ??
      Reflect.get(data, 'group_composer_story_create') ??
      Reflect.get(data, 'composer_story_create');
    if (typeof storyCreate === 'object' && storyCreate !== null) {
      if (!lineHasError && posterApprovalPattern.test(JSON.stringify(storyCreate))) {
        pendingApproval = true;
      }
      const directPostId = Reflect.get(storyCreate, 'post_id');
      if (typeof directPostId === 'string' && directPostId.trim()) {
        const decoded = decodeStoryPostId(directPostId.trim());
        if (decoded) return { postId: decoded, restricted, pendingApproval };
      }
      const story = Reflect.get(storyCreate, 'story');
      if (typeof story === 'object' && story !== null) {
        for (const key of ['post_id', 'legacy_story_hideable_id', 'id']) {
          const val = Reflect.get(story, key);
          if (typeof val === 'string' && val.trim()) {
            const decoded = decodeStoryPostId(val.trim());
            if (decoded) return { postId: decoded, restricted, pendingApproval };
          }
        }
        const urlVal = Reflect.get(story, 'url') ?? Reflect.get(story, 'wwwURL');
        if (typeof urlVal === 'string') {
          const urlMatch = /\/(?:posts|permalink|videos)\/(\d{6,25})/.exec(urlVal);
          if (urlMatch?.[1]) return { postId: urlMatch[1], restricted, pendingApproval };
        }
      }
    }
  }
  const regexFallback =
    /"post_id"\s*:\s*"(\d{6,25})"/.exec(body)?.[1] ??
    /\/groups\/[^/"']+\/(?:posts|permalink)\/(\d{6,25})/.exec(body)?.[1] ??
    null;
  return { postId: regexFallback, restricted, pendingApproval: !sawError && pendingApproval };
}
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
  const { profileId, conn, stopRec, stopId, kernel, core, posterRepo, connections, closing } =
    input;
  await stopOwnedConnectionWithReconnect({
    profileId,
    connection: conn,
    stopId,
    failed: Boolean(stopRec?.failed),
    peerEpoch: stopRec?.peerEpoch ?? core?.peers.get(profileId)?.epoch ?? '',
    kernel,
    core,
    errorPrefix: 'POSTER',
    setFailed: () => {
      if (stopRec) stopRec.failed = true;
    },
    setStopId: (nextId) => {
      if (stopRec) stopRec.id = nextId;
    },
    onBeforeConfirmStop:
      posterRepo && kernel
        ? async (peer) => {
            await recoverPosterOperations(kernel, peer, posterRepo, () => {
              if (core?.peers.get(profileId) !== peer || !peer.online || !peer.synced) {
                throw Error('POSTER_RECOVERY_CHANGED');
              }
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
          ) {
            throw Error('POSTER_OLD_EXECUTION_UNCONFIRMED');
          }
        }
      : undefined,
  });
  if (connections.get(profileId) === conn) connections.delete(profileId);
  if (closing.get(profileId) === stopRec) closing.delete(profileId);
}
export async function readPosterIdentityMeta(
  page: Page,
  accountId: string,
): Promise<PosterIdentityMeta> {
  const [identityType, accountAvatar] = await Promise.all([
    page
      .evaluate(() => (/(?:^|;\s*)i_user=(\d{5,25})/.test(document.cookie) ? 'page' : 'personal'))
      .catch(() => 'personal' as const),
    page
      .evaluate(`(${extractInPageActorAvatarDom.toString()})(${JSON.stringify(accountId)}, true)`)
      .then((v) => (typeof v === 'string' ? v : null))
      .catch(() => null),
  ]);
  const identityMeta: PosterIdentityMeta = {
    identityType: identityType as 'page' | 'personal',
    accountAvatar,
  };
  if (identityMeta.accountAvatar && !isLocalAvatar(identityMeta.accountAvatar)) {
    const localized = await fetchAndLocalizeAccountAvatar(
      identityMeta.accountAvatar,
      undefined,
      `${identityMeta.identityType}:${accountId}`,
    ).catch(() => null);
    if (localized) identityMeta.accountAvatar = localized;
  }
  return identityMeta;
}
export async function dismissPosterDialogsOnError(page: Page, paceScale: number): Promise<void> {
  await page
    .evaluate(() => {
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
      const vis = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.visibility !== 'hidden' &&
          s.display !== 'none' &&
          Number(s.opacity) > 0
        );
      };
      const closeSel = ['关闭', '關閉', 'Close']
        .flatMap((l) => [`[role="button"][aria-label="${l}"]`, `button[aria-label="${l}"]`])
        .join(',');
      for (const d of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        vis,
      )) {
        Array.from(d.querySelectorAll<HTMLElement>(closeSel)).find(vis)?.click();
      }
    })
    .catch(() => {});
  await wait(Math.max(20, Math.round(300 * paceScale)));
  await page
    .evaluate(() => {
      const vis = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.visibility !== 'hidden' &&
          s.display !== 'none' &&
          Number(s.opacity) > 0
        );
      };
      const confirmRx =
        /^(?:舍弃|捨棄|放弃|放棄|不保存|确定|確定|Discard|Discard\s*post|Leave|Leave\s*Page)$/i;
      for (const d of Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
        ),
      ).filter(vis)) {
        Array.from(d.querySelectorAll<HTMLElement>('[role="button"],button'))
          .filter(vis)
          .find((el) =>
            confirmRx.test(
              (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
            ),
          )
          ?.click();
      }
    })
    .catch(() => {});
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
  page: Page;
  rawGroupId: string;
  effectiveGroupName: string;
  paceScale: number;
  guard: () => void;
  paceWait: (ms: number) => Promise<void>;
  execOp: PosterExecOp;
}): Promise<{ enteredGroup: boolean; enteredViaDirectOrId: boolean }> {
  const { page, rawGroupId, effectiveGroupName, paceScale, guard, paceWait, execOp } = input;
  let enteredGroup = false;
  let enteredViaDirectOrId = false;
  const searchUrl = `https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(effectiveGroupName)}`;
  await execOp('打开搜索结果', async () => {
    const markBannerSearch = async () =>
      page
        .evaluate(() => {
          const isVis = (el: Element | null) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          document
            .querySelectorAll('[data-wb-poster-search]')
            .forEach((e) => e.removeAttribute('data-wb-poster-search'));
          const hit = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              '[role="banner"] input[type="search"], [role="banner"] input[role="combobox"], [role="banner"] input',
            ),
          ).find(isVis);
          if (hit) {
            hit.setAttribute('data-wb-poster-search', '1');
            return 'input';
          }
          const toggle = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[role="banner"] [role="button"][aria-label*="Search" i], [role="banner"] [role="button"][aria-label*="搜索"], [role="banner"] [role="button"][aria-label*="搜尋"], [role="banner"] [role="button"][aria-label*="ရှာ"], [role="banner"] label',
            ),
          ).find(isVis);
          if (toggle) {
            toggle.click();
            return 'toggled';
          }
          return 'none';
        })
        .catch(() => 'none');
    let searchState = await markBannerSearch();
    if (searchState === 'toggled') {
      await wait(Math.max(50, Math.round(450 * paceScale)));
      searchState = await markBannerSearch();
    }
    if (searchState === 'input') {
      try {
        const box = page.locator('[data-wb-poster-search="1"]').first();
        await box.click({ timeout: 3000 });
        await box.fill(effectiveGroupName, { timeout: 3000 });
        await box.press('Enter', { timeout: 3000 });
        await page.waitForURL((u) => /^\/(?:groups\/)?search\//i.test(u.pathname), {
          timeout: 6000,
        });
        return page.url();
      } catch {}
    }
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    return page.url();
  });
  for (let screen = 0; screen < 5 && !enteredGroup; screen++) {
    guard();
    let found = await readGroupBumper(page, {
      groupId: rawGroupId,
      groupName: effectiveGroupName,
    });
    if (found.restricted && !found.restrictionReason) {
      await dismissFeatureInterventionDialogIfPresent(page, guard);
      found = await readGroupBumper(page, { groupId: rawGroupId, groupName: effectiveGroupName });
    }
    if (found.restricted) throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
    if (found.groupEntryCSS) {
      try {
        await execOp('打开搜索到的小组', async () => {
          const refreshed = await readGroupBumper(page, {
            groupId: rawGroupId,
            groupName: effectiveGroupName,
          });
          if (!refreshed.groupEntryCSS) throw Error('未找到小组链接');
          const link = page.locator(refreshed.groupEntryCSS).first();
          await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await wait(Math.max(50, Math.round(350 * paceScale)));
          await link.click({ timeout: 5000 });
          await page.waitForURL((u) => /^\/groups\/(?!search(?:\/|$))[^/]+/i.test(u.pathname), {
            timeout: 12000,
          });
          return page.url();
        });
        enteredGroup = true;
        if (found.groupEntryMatchedBy === 'id') enteredViaDirectOrId = true;
        break;
      } catch {
        break;
      }
    }
    if (screen < 4) {
      await execOp('浏览目标帖子', async () => {
        await page.mouse.wheel(0, 620);
        return true;
      });
      await paceWait(650);
    }
  }
  return { enteredGroup, enteredViaDirectOrId };
}
