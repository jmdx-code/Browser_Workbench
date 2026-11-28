import type { Page } from 'playwright-core';
import { type GroupPosterBrowserCallbacks } from '../../application/group-poster-service.js';
import type { CompatibleRepository } from '../../domain/persistence.js';
import { isLocalAvatar, isPlaceholderTargetName } from '../../shared/group-bumper.js';
import {
  checkGroupPendingOrQuestions,
  FacebookGroupSessionHelper,
} from '../facebook-group-session.js';
import { fetchAndLocalizeAvatar } from '../group-bumper-avatar.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupBumperRepository } from '../group-bumper-store.js';
import { dismissFeatureInterventionDialogIfPresent } from '../group-inviter-effects.js';
import { openAndFillPosterComposer } from './poster-composer.js';
import {
  readCheckedPosterSurface,
  searchAndEnterPosterGroup,
  type PosterExecOp,
  type PosterIdentityMeta,
  type PosterOpContext,
} from './poster-support.js';
export { openAndFillPosterComposer };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function preparePosterTargetSurface(input: {
  getPage: () => Page;
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
    getPage,
    accountId,
    rawGroupId,
    isPageTimeline,
    paceScale,
    bumperRepo,
    callbacks,
    guard,
    paceWait,
    execOp,
  } = input;
  let effectiveGroupId = input.initialEffectiveGroupId;
  let effectiveGroupName = input.initialEffectiveGroupName;
  let surface: Awaited<ReturnType<typeof readGroupBumper>>;
  let resolvedGroupAvatar: string | null = null;
  if (isPageTimeline) {
    callbacks.status(`正在打开专页时间线 · ${effectiveGroupName}`);
    await execOp('打开小组页面', async () => {
      await getPage().goto('https://www.facebook.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      return getPage().url();
    });
    await paceWait(1200);
    surface = await readCheckedPosterSurface(getPage(), { groupId: '-', pageId: accountId }, guard);
    return {
      status: 'ready',
      effectiveGroupId,
      effectiveGroupName,
      resolvedGroupAvatar: input.identityMeta.accountAvatar,
      surface,
    };
  }
  callbacks.status(`正在搜索小组 · ${effectiveGroupName}`);
  const directUrl = `https://www.facebook.com/groups/${encodeURIComponent(rawGroupId)}/`;
  let enteredGroup = false;
  let enteredViaDirectOrId = false;
  if (!isPlaceholderTargetName(effectiveGroupName, rawGroupId)) {
    ({ enteredGroup, enteredViaDirectOrId } = await searchAndEnterPosterGroup({
      getPage,
      rawGroupId,
      effectiveGroupName,
      paceScale,
      guard,
      paceWait,
      execOp,
    }));
  }
  const gotoDirect = () =>
    execOp('打开小组页面', async () => {
      await getPage().goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return getPage().url();
    });
  if (!enteredGroup || !getPage().url().includes('/groups/')) {
    await gotoDirect();
    enteredViaDirectOrId = true;
  }
  await paceWait(1200);
  surface = await readCheckedPosterSurface(getPage(), { groupId: effectiveGroupId }, guard);
  const localizeGroupAvatar = async (rawAvatar: string | null | undefined) => {
    if (isLocalAvatar(input.groupAvatarUrl)) return input.groupAvatarUrl;
    if (!rawAvatar || isLocalAvatar(rawAvatar)) return rawAvatar ?? null;
    return (await fetchAndLocalizeAvatar(rawAvatar).catch(() => null)) ?? rawAvatar;
  };
  const syncRedirectStep = async (allowAliasRedirect: boolean): Promise<boolean> => {
    resolvedGroupAvatar = (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
    const redirectRes = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
      currentUrl: getPage().url(),
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
      input.updateContext({ groupId: effectiveGroupId });
      const resolved = await callbacks.onGroupIdResolved?.(rawGroupId, effectiveGroupId);
      if (resolved?.alreadyPosted) {
        callbacks.status(`已发过该贴文，跳过重复小组 · ${effectiveGroupName}`);
        return false;
      }
      surface = await readGroupBumper(getPage(), { groupId: effectiveGroupId });
      resolvedGroupAvatar = (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
    }
    return true;
  };
  if (!(await syncRedirectStep(enteredViaDirectOrId))) return { status: 'skipped' };
  if (!surface.groupIds.includes(effectiveGroupId.toLowerCase())) {
    await gotoDirect();
    await paceWait(1000);
    surface = await readGroupBumper(getPage(), { groupId: effectiveGroupId });
    if (!(await syncRedirectStep(true))) return { status: 'skipped' };
  }
  surface = await readCheckedPosterSurface(getPage(), { groupId: effectiveGroupId }, guard);
  if (resolvedGroupAvatar)
    await bumperRepo.updateAvatar?.('groups', effectiveGroupId, resolvedGroupAvatar);
  if (surface.groupTitle && isPlaceholderTargetName(effectiveGroupName, effectiveGroupId)) {
    await bumperRepo.applyResolvedTargetMetadata?.('groups', effectiveGroupId, {
      name: surface.groupTitle,
      avatarUrl: resolvedGroupAvatar,
    });
    effectiveGroupName = surface.groupTitle;
    input.updateContext({ groupName: surface.groupTitle });
  }
  callbacks.status(`正在浏览小组贴文 · ${effectiveGroupName}`);
  await execOp('浏览目标帖子', async () => {
    const p = getPage();
    const delay = (ms: number) => wait(Math.max(40, Math.round(ms * paceScale)));
    for (const top of [520, 540]) {
      await p.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), top);
      await delay(1200 + Math.random() * 600);
    }
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await delay(900);
    await p.evaluate(() => {
      if (window.scrollY > 40) window.scrollTo(0, 0);
    });
    return true;
  });
  surface = await readGroupBumper(getPage(), { groupId: effectiveGroupId });
  const dismissWelcomeIfPresent = async (surf: Awaited<ReturnType<typeof readGroupBumper>>) => {
    const sel = surf.welcomeDismissCSS ?? surf.joinRestrictionDismissCSS ?? null;
    if (!sel && !(surf.blockingDialog && !surf.restricted && surf.groupJoinState !== 'questions'))
      return false;
    await execOp('关闭入组欢迎弹窗', async () => {
      if (sel)
        await getPage()
          .locator(sel)
          .first()
          .click({ timeout: 4000 })
          .catch(() => {});
      else
        await getPage()
          .keyboard.press('Escape')
          .catch(() => {});
      return true;
    });
    return true;
  };
  if (await dismissWelcomeIfPresent(surface))
    surface = await readGroupBumper(getPage(), { groupId: effectiveGroupId });
  if (surface.joinGroupCSS) {
    const joinSel = surface.joinGroupCSS;
    callbacks.status(`正在加入小组 · ${effectiveGroupName}`);
    const joinOutcome = await execOp('加入小组', async () => {
      const p = getPage();
      const joinLoc = p.locator(joinSel).first();
      await joinLoc
        .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
        .catch(() => {});
      await joinLoc.click({ timeout: 4000 }).catch(() => {});
      await wait(Math.max(50, Math.round(2000 * paceScale)));
      const afterJoin = await readGroupBumper(p, { groupId: effectiveGroupId });
      if (afterJoin.restricted && !afterJoin.restrictionReason) {
        await dismissFeatureInterventionDialogIfPresent(p, guard);
        return true;
      }
      return false;
    });
    if (joinOutcome) throw Error('跳过：当前身份暂不支持直接加入该群');
    surface = await readGroupBumper(getPage(), { groupId: effectiveGroupId });
    if (surface.restricted && !surface.restrictionReason) {
      await dismissFeatureInterventionDialogIfPresent(getPage(), guard);
      throw Error('跳过：当前身份暂不支持直接加入该群');
    }
    await dismissWelcomeIfPresent(surface);
  }
  if (await checkGroupPendingOrQuestions(getPage()))
    throw Error('跳过：该群需管理员审核或回答入群问题');
  return { status: 'ready', effectiveGroupId, effectiveGroupName, resolvedGroupAvatar, surface };
}
