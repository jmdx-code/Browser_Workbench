import { randomUUID } from 'node:crypto';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  isCompleteNumericId,
  isPlaceholderTargetName,
  type BumperSettings,
} from '../../shared/group-bumper.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import {
  bumperDialogClosed,
  BumperFatalError,
  type BumperGroupFeedContext,
  BumperGroupSkipped,
  type BumperRunCallbacks,
  type BumperRunStats,
  type BumperSurface,
  wait,
} from './bumper-core.js';
import {
  centerBumperControl,
  dismissFeatureOrJoinCSS,
  navigateViaSearchEntry,
} from './bumper-post-flow.js';
import type { BumperSessionRuntime } from './bumper-session.js';
export interface BumperGroupSurfaceHelpers {
  rejectBlockedGroup: (surface: BumperSurface) => void;
  dismissWelcomeDialogIfNeeded: (s?: BumperSurface) => Promise<boolean>;
  dismissPostJoinObstructionIfNeeded: (s: BumperSurface) => Promise<BumperSurface>;
  activateJoinRestrictedFallback: (reason: string) => void;
  joinGroupIfNeeded: (s?: BumperSurface) => Promise<boolean>;
  waitForFeed: (pageId?: string) => Promise<BumperSurface>;
}
export function createGroupSurfaceHelpers(input: {
  profileId: string;
  paceScale: number;
  settings: BumperSettings;
  callbacks: BumperRunCallbacks;
  session: BumperSessionRuntime;
  groupCtx: BumperGroupFeedContext;
}): BumperGroupSurfaceHelpers {
  const { profileId, paceScale, settings, callbacks, session, groupCtx } = input;
  const { group, isPageBumperMode, pages } = groupCtx;
  const markDialogClosing = async (selector: string, token: string) => {
    const button = session.getPage().locator(selector).first();
    await button.evaluate((el, id) => {
      (el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]') ?? el).setAttribute(
        'data-wb-bumper-closing',
        id,
      );
    }, token);
    await button.click({ timeout: 4000 });
  };
  const throwRestricted = (v: BumperSurface): never => {
    throw new BumperFatalError('受限 · ' + (v.restrictionReason ?? '需要手机验证或操作受限'));
  };
  const rejectBlockedGroup = (surface: BumperSurface) => {
    if (surface.restricted) throwRestricted(surface);
    if (
      surface.groupJoinState === 'pending' &&
      (groupCtx.effectiveSearchMode === 'time_sort' || surface.posts.length === 0) &&
      !groupCtx.joinRestrictedFallback
    )
      throw new BumperGroupSkipped('入组申请待审核');
    if (
      surface.groupJoinState === 'questions' &&
      (groupCtx.effectiveSearchMode === 'time_sort' ||
        surface.posts.length === 0 ||
        surface.blockingDialog) &&
      !groupCtx.joinRestrictedFallback
    )
      throw new BumperGroupSkipped('小组需要回答入组问题');
  };
  const dismissWelcomeDialogIfNeeded = async (s?: BumperSurface) => {
    try {
      session.guard();
    } catch {
      return false;
    }
    let current =
      s ?? (await readGroupBumper(session.getPage(), { groupId: groupCtx.effectiveGroupId }));
    rejectBlockedGroup(current);
    let closed = false;
    const canTryDismiss = (surf: BumperSurface) =>
      Boolean(
        surf.welcomeDismissCSS ||
        surf.joinRestrictionDismissCSS ||
        (surf.blockingDialog && !surf.restricted && surf.groupJoinState !== 'questions'),
      );
    for (let count = 0; canTryDismiss(current) && count < 3; count++) {
      const token = randomUUID();
      await session.op(
        '关闭入组欢迎弹窗',
        async () => {
          const next = await readGroupBumper(session.getPage(), {
            groupId: groupCtx.effectiveGroupId,
          });
          rejectBlockedGroup(next);
          const dismissSel = next.welcomeDismissCSS ?? next.joinRestrictionDismissCSS ?? null;
          if (dismissSel) {
            await markDialogClosing(dismissSel, token);
            return 'button' as const;
          }
          if (next.blockingDialog && !next.restricted && next.groupJoinState !== 'questions') {
            await session.getPage().keyboard.press('Escape');
            return 'escape' as const;
          }
          return null;
        },
        async (mode) => {
          if (!mode) return true;
          const until = Date.now() + 2000;
          do {
            session.guard();
            const activePage = session.getPage();
            const next = await readGroupBumper(activePage, { groupId: groupCtx.effectiveGroupId });
            rejectBlockedGroup(next);
            if (!next.blockingDialog) return true;
            if (mode === 'button' && (await activePage.evaluate(bumperDialogClosed, token)))
              return true;
            await wait(150);
          } while (Date.now() < until);
          return true;
        },
      );
      closed = true;
      current = await readGroupBumper(session.getPage(), { groupId: groupCtx.effectiveGroupId });
      rejectBlockedGroup(current);
    }
    if (current.blockingDialog) throw new BumperGroupSkipped('页面有未处理的阻断弹窗');
    return closed;
  };
  const dismissPostJoinObstructionIfNeeded = async (s: BumperSurface) => {
    const throwIfRestricted = (v: BumperSurface) => {
      if (v.checkpointRestricted || v.restrictionReason) throwRestricted(v);
    };
    let current = s;
    for (
      let count = 0;
      (current.blockingDialog || current.joinRestrictionDismissCSS || current.welcomeDismissCSS) &&
      count < 3;
      count++
    ) {
      const token = randomUUID();
      await session.op(
        '关闭入组欢迎弹窗',
        async () => {
          const activePage = session.getPage();
          const next = await readGroupBumper(activePage, { groupId: groupCtx.effectiveGroupId });
          throwIfRestricted(next);
          const dismissSelector = next.joinRestrictionDismissCSS ?? next.welcomeDismissCSS ?? null;
          if (dismissSelector)
            return (await markDialogClosing(dismissSelector, token), 'button' as const);
          if (next.blockingDialog || next.restricted)
            return (await activePage.keyboard.press('Escape'), 'escape' as const);
          return null;
        },
        async (mode) => {
          if (!mode) return true;
          const until = Date.now() + 2500;
          do {
            session.guard();
            const activePage = session.getPage();
            const next = await readGroupBumper(activePage, { groupId: groupCtx.effectiveGroupId });
            throwIfRestricted(next);
            if (
              mode === 'button' &&
              !next.restricted &&
              (await activePage.evaluate(bumperDialogClosed, token))
            )
              return true;
            if (!next.restricted && !next.blockingDialog) return true;
            await wait(150);
          } while (Date.now() < until);
          return true;
        },
      );
      current = await readGroupBumper(session.getPage(), { groupId: groupCtx.effectiveGroupId });
    }
    return current;
  };
  const activateJoinRestrictedFallback = (reason: string) => {
    groupCtx.joinRestrictedFallback = true;
    groupCtx.unjoinableFallbackReason = reason;
    if (groupCtx.effectiveSearchMode !== 'time_sort') return;
    const fallbackMode: BumperSettings['searchMode'] =
      pages.length > 0 && pages.length <= 3 ? 'page_group_feed' : 'random_browse';
    groupCtx.effectiveSearchMode = fallbackMode;
    callbacks.status(
      `${reason}，已自动切换${fallbackMode === 'page_group_feed' ? '直接打开专页小组贴' : '随机浏览'} · ${group.name}`,
    );
    devDiag.emit('INFO', 'GROUP_BUMPER', 'BUMPER_JOIN_RESTRICTED_FALLBACK', {
      profileId,
      reason,
      data: {
        groupId: groupCtx.effectiveGroupId,
        fromMode: settings.searchMode,
        toMode: fallbackMode,
        pagesCount: pages.length,
      },
    });
  };
  const joinGroupIfNeeded = async (s?: BumperSurface) => {
    if (
      isPageBumperMode ||
      groupCtx.effectiveSearchMode === 'random_browse' ||
      groupCtx.joinRestrictedFallback
    )
      return false;
    const current =
      s ?? (await readGroupBumper(session.getPage(), { groupId: groupCtx.effectiveGroupId }));
    rejectBlockedGroup(current);
    if (
      (groupCtx.effectiveSearchMode === 'page_group_feed' && current.posts.length > 0) ||
      current.groupJoinState === 'member' ||
      !current.joinGroupCSS
    )
      return false;
    callbacks.status('正在加入小组 · ' + group.name);
    let next = current,
      unjoinableIntervention = false;
    await session.op(
      '加入小组',
      async () => {
        const activePage = session.getPage();
        const refreshed = await readGroupBumper(activePage, { groupId: groupCtx.effectiveGroupId });
        rejectBlockedGroup(refreshed);
        if (refreshed.groupJoinState === 'member') return false;
        if (!refreshed.joinGroupCSS) throw Error('入组按钮已变化');
        const btn = activePage.locator(refreshed.joinGroupCSS).first();
        await centerBumperControl(btn, paceScale);
        await btn.click({ timeout: 4000 });
        return true;
      },
      async (clicked) => {
        if (!clicked) return true;
        const end = Date.now() + 6000;
        do {
          session.guard();
          const activePage = session.getPage();
          next = await readGroupBumper(activePage, { groupId: groupCtx.effectiveGroupId });
          if (
            next.checkpointRestricted ||
            /^\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(new URL(next.url).pathname)
          )
            throwRestricted(next);
          if (next.restricted && !next.restrictionReason) {
            await dismissFeatureOrJoinCSS(
              activePage,
              next.joinRestrictionDismissCSS,
              session.guard,
            );
            next = await readGroupBumper(activePage, { groupId: groupCtx.effectiveGroupId });
            if (!next.restricted || (next.joinRestrictionDismissCSS && !next.checkpointRestricted))
              return ((unjoinableIntervention = true), true);
          }
          if (next.restricted) throwRestricted(next);
          if (['member', 'pending', 'questions'].includes(next.groupJoinState ?? '')) return true;
          if (next.blockingDialog && (next.joinRestrictionDismissCSS || next.welcomeDismissCSS))
            return true;
          if (next.groupJoinState === undefined && !next.joinGroupCSS) return true;
          await wait(250);
        } while (Date.now() < end);
        if (
          !next.restricted &&
          next.groupIds.includes(groupCtx.effectiveGroupId.toLowerCase()) &&
          next.joinGroupCSS
        )
          return ((unjoinableIntervention = true), true);
        return false;
      },
    );
    if (
      unjoinableIntervention ||
      next.groupJoinState === 'pending' ||
      next.groupJoinState === 'questions' ||
      (next.groupJoinState !== 'member' &&
        (next.blockingDialog ||
          Boolean(next.joinRestrictionDismissCSS) ||
          Boolean(next.joinGroupCSS)))
    ) {
      const reason =
        next.groupJoinState === 'pending'
          ? '入组申请待审核'
          : next.groupJoinState === 'questions'
            ? '小组需要回答入组问题'
            : '入组操作受限';
      if (
        next.restricted ||
        next.blockingDialog ||
        next.joinRestrictionDismissCSS ||
        next.welcomeDismissCSS
      )
        next = await dismissPostJoinObstructionIfNeeded(next);
      if (next.restricted) throwRestricted(next);
      if (next.blockingDialog) throw new BumperGroupSkipped('页面有未处理的阻断弹窗');
      return (activateJoinRestrictedFallback(reason), false);
    }
    rejectBlockedGroup(next);
    await dismissWelcomeDialogIfNeeded(next);
    if (next.joinGroupCSS && !next.posts.length)
      return (activateJoinRestrictedFallback('当前身份暂不支持直接加入该小组'), false);
    return true;
  };
  const waitForFeed = async (pageId?: string) => {
    const startedAt = Date.now(),
      until = startedAt + 12000,
      minWaitUntil = startedAt + Math.min(3500, Math.max(400, Math.round(3500 * paceScale))),
      opts = { groupId: groupCtx.effectiveGroupId, ...(pageId ? { pageId } : {}) };
    let wakeScrolls = 0;
    const readFeed = async () => {
      let obs = await readGroupBumper(session.getPage(), opts);
      if (obs.welcomeDismissCSS) {
        await dismissWelcomeDialogIfNeeded(obs);
        obs = await readGroupBumper(session.getPage(), opts);
      }
      return obs;
    };
    let observed = await readFeed();
    while (
      observed.posts.length === 0 &&
      !observed.restricted &&
      Date.now() < (observed.loading ? until : minWaitUntil)
    ) {
      session.guard();
      if (
        wakeScrolls < 2 &&
        Date.now() - startedAt > 1600 &&
        observed.posts.length === 0 &&
        !observed.restricted
      ) {
        wakeScrolls++;
        await session
          .getPage()
          .evaluate(() => window.scrollBy(0, 480))
          .catch(() => {});
      }
      await wait(400);
      observed = await readFeed();
    }
    if (wakeScrolls > 0 && isPageBumperMode && observed.posts.length > 0 && !observed.restricted) {
      await session
        .getPage()
        .evaluate(() => window.scrollTo(0, 0))
        .catch(() => {});
      await wait(300);
      observed = await readGroupBumper(session.getPage(), opts);
    }
    rejectBlockedGroup(observed);
    if (observed.restricted) throwRestricted(observed);
    return observed;
  };
  return {
    rejectBlockedGroup,
    dismissWelcomeDialogIfNeeded,
    dismissPostJoinObstructionIfNeeded,
    activateJoinRestrictedFallback,
    joinGroupIfNeeded,
    waitForFeed,
  };
}
export async function enterBumperGroupSurface(input: {
  paceScale: number;
  callbacks: BumperRunCallbacks;
  session: BumperSessionRuntime;
  groupCtx: BumperGroupFeedContext;
  helpers: BumperGroupSurfaceHelpers;
  stats: BumperRunStats;
}): Promise<{ surface: BumperSurface; initialFeed: BumperSurface }> {
  const { paceScale, callbacks, session, groupCtx, helpers, stats } = input,
    { group } = groupCtx,
    groupUrl = (chrono: boolean) =>
      `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/${chrono ? '?sorting_setting=CHRONOLOGICAL' : ''}`,
    fallbackGroupUrl = `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/${groupCtx.effectiveSearchMode === 'time_sort' ? '?sorting_setting=CHRONOLOGICAL' : ''}`;
  let navigatedChronological = false;
  if (!isPlaceholderTargetName(group.name, group.id)) {
    const nav = await navigateViaSearchEntry({
      session,
      paceScale,
      query: group.name,
      searchUrl:
        'https://www.facebook.com/groups/search/groups/?q=' + encodeURIComponent(group.name),
      fallbackUrl: fallbackGroupUrl,
      readSurface: () =>
        readGroupBumper(session.getPage(), { groupId: group.id, groupName: group.name }),
      missingMsg: '搜索入口未找到',
      urlOk: (u) =>
        u.origin === 'https://www.facebook.com' &&
        /^\/groups\/(?!search(?:\/|$))[^/]+/.test(u.pathname),
    });
    navigatedChronological = nav.usedFallback && groupCtx.effectiveSearchMode === 'time_sort';
  } else {
    await session.navigate(fallbackGroupUrl);
    navigatedChronological = groupCtx.effectiveSearchMode === 'time_sort';
  }
  let surface = await readGroupBumper(session.getPage(), { groupId: group.id });
  const applyRedirect = () => {
    if (
      isCompleteNumericId(group.id) ||
      surface.groupIds.includes(groupCtx.effectiveGroupId.toLowerCase())
    )
      return;
    const redirected = session.getNavigationChain().some((url) => {
      const u = new URL(url);
      return (
        u.origin === 'https://www.facebook.com' &&
        u.pathname.replace(/\/$/, '').toLowerCase() === '/groups/' + group.id.toLowerCase()
      );
    });
    const final = new URL(surface.url),
      nativeId = /^\/groups\/([^/]+)\/?$/.exec(final.pathname)?.[1];
    if (
      redirected &&
      nativeId &&
      final.origin === 'https://www.facebook.com' &&
      surface.groupIds.includes(nativeId.toLowerCase())
    )
      groupCtx.effectiveGroupId = nativeId;
  };
  applyRedirect();
  if (!surface.groupIds.includes(groupCtx.effectiveGroupId.toLowerCase())) {
    await session.navigate(fallbackGroupUrl);
    navigatedChronological = groupCtx.effectiveSearchMode === 'time_sort';
    surface = await readGroupBumper(session.getPage(), { groupId: group.id });
    applyRedirect();
  }
  if (!surface.groupIds.includes(groupCtx.effectiveGroupId.toLowerCase()))
    throw Error('小组标识与目标不一致，未执行顶贴');
  const syncTitle = async (title?: string | null, avatar?: string | null) => {
    if (!title || (group.name.trim() && group.name !== group.id)) return;
    await session.updateMetadata('groups', group.id, {
      name: title,
      avatarUrl: avatar ?? undefined,
    });
    group.name = title;
  };
  if (groupCtx.effectiveGroupId !== group.id && isCompleteNumericId(groupCtx.effectiveGroupId)) {
    const resolvedName =
      surface.groupTitle && (!group.name.trim() || group.name === group.id)
        ? surface.groupTitle
        : group.name;
    await session.updateMetadata('groups', group.id, {
      canonicalId: groupCtx.effectiveGroupId,
      name: resolvedName,
      avatarUrl: surface.avatarUrl,
    });
    group.id = groupCtx.effectiveGroupId;
    group.name = resolvedName;
    session.setOperationContext({
      ...session.getOperationContext(),
      groupId: groupCtx.effectiveGroupId,
      groupName: resolvedName,
    });
  } else {
    if (surface.avatarUrl) await session.updateAvatar('groups', group.id, surface.avatarUrl);
    await syncTitle(surface.groupTitle, surface.avatarUrl);
  }
  await helpers.dismissWelcomeDialogIfNeeded(surface);
  const joinedEarly = await helpers.joinGroupIfNeeded(surface);
  if (
    groupCtx.effectiveSearchMode === 'time_sort' &&
    (!navigatedChronological ||
      joinedEarly ||
      !surface.url.includes('sorting_setting=CHRONOLOGICAL'))
  )
    await session.navigate(groupUrl(true));
  else if (
    groupCtx.joinRestrictedFallback &&
    groupCtx.effectiveSearchMode !== 'time_sort' &&
    session.getPage().url().includes('sorting_setting=CHRONOLOGICAL')
  )
    await session.navigate(groupUrl(false));
  let initialFeed = await helpers.waitForFeed();
  if (await helpers.joinGroupIfNeeded(initialFeed)) {
    if (groupCtx.effectiveSearchMode === 'time_sort') {
      await session.navigate(groupUrl(true));
      initialFeed = await helpers.waitForFeed();
    } else
      initialFeed = await readGroupBumper(session.getPage(), {
        groupId: groupCtx.effectiveGroupId,
      });
  }
  if (
    !initialFeed.posts.length &&
    !initialFeed.restricted &&
    session.getPage().url().includes('sorting_setting=CHRONOLOGICAL')
  ) {
    await session.navigate(groupUrl(false));
    initialFeed = await helpers.waitForFeed();
  }
  await syncTitle(initialFeed.groupTitle, initialFeed.avatarUrl);
  if (!initialFeed.posts.length) {
    if (groupCtx.joinRestrictedFallback)
      throw new BumperGroupSkipped(
        groupCtx.unjoinableFallbackReason === '入组申请待审核' ||
          groupCtx.unjoinableFallbackReason === '小组需要回答入组问题'
          ? groupCtx.unjoinableFallbackReason
          : '当前身份暂不支持直接加入该小组',
      );
    throw Error(initialFeed.loading ? '小组内容加载超时' : '小组暂无可访问帖子');
  }
  callbacks.status('正在扫描 · ' + group.name);
  stats.groupsEntered++;
  return { surface, initialFeed };
}
