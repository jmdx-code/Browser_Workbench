import { ProductError } from '../../domain/workspace.js';
import { bluestacksDisplayTitle } from '../../shared/bluestacks.js';
import {
  isDirectFacebookPostUrl,
  nextTieredPollingState,
  resolveRecordColumns,
  type GoogleSheetLink,
} from '../../shared/google-sheets.js';
import type { DirectPostBumpItem, SheetRecordPostPortRecord } from '../google-sheets-ports.js';
import { errMsg, ignoreError, recordPostBumpFailure } from '../module-worker-pool.js';
import {
  recordLinkPollFailure,
  releaseProfile,
  requireLink,
  resolveBoundBluestacksInstances,
  resolveBoundBumperProfiles,
  runSerializedRecordWrite,
  safeAppendSheetLog,
  tryClaimProfile,
  updateActiveProfileStatus,
  wakeBrowserProfile,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';
import {
  buildRecordFromRow,
  collectDueMetricsForLink,
  ensureMachineColumnAndWriteCells,
  resolveRecordRowIdentity,
  writeBatchRecordCellsByKey,
} from './gs-metrics-collector.js';

type PendingBumpEntry = {
  item: DirectPostBumpItem;
  rowNumber: number;
  record: SheetRecordPostPortRecord;
};
type PendingCellEntry = {
  postCode: string;
  postUrl: string;
  value: string;
  hintRowNumber?: number;
};

function createBumpWritebackManager(
  ctx: GoogleSheetsContext,
  activeLink: GoogleSheetLink,
  machineColIndex: number,
  cols: ReturnType<typeof resolveRecordColumns>,
  initialCells: readonly PendingCellEntry[],
) {
  const pending = new Map<string, PendingCellEntry>(initialCells.map((c) => [c.postCode, c]));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<void> = Promise.resolve();

  const flushNow = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const runFlush = async () => {
      if (!pending.size) return;
      const batch = [...pending.values()];
      pending.clear();
      try {
        await writeBatchRecordCellsByKey(ctx, activeLink, machineColIndex, batch, cols);
      } catch (err) {
        for (const item of batch) if (!pending.has(item.postCode)) pending.set(item.postCode, item);
        await safeAppendSheetLog(
          ctx,
          activeLink.id,
          'warn',
          'records_bump_writeback_retry',
          `批量回写顶贴计数暂时失败（${batch.length} 条），将在本轮结束时重试：${errMsg(err)}`,
        );
      }
    };
    return (tail = tail.then(runFlush, runFlush));
  };

  const schedule = (entry: PendingCellEntry) => {
    pending.set(entry.postCode, entry);
    if (pending.size >= 25) return void flushNow();
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flushNow();
      }, 2500);
      timer.unref?.();
    }
  };
  return { flushNow, schedule };
}

export async function runRecordsPoll(
  ctx: GoogleSheetsContext,
  linkId: string,
): Promise<{ summary: string }> {
  if (ctx.runningRecordLinks.has(linkId)) return { summary: '正在检查中' };
  ctx.runningRecordLinks.add(linkId);
  ctx.cancelledLinks.delete(linkId);
  let link: GoogleSheetLink | null = null;
  let semiActiveFallbackMin = 10;

  try {
    link = await requireLink(ctx, linkId);
    const activeLink = link;
    const cfg = activeLink.recordsConfig;
    if (!cfg) throw new ProductError('SHEET_CONFIG_MISSING', '发帖记录表缺少配置', 400);
    semiActiveFallbackMin = Math.max(2, cfg.semiActivePollMinutes);

    await ctx.repo.updateLinkRuntime(activeLink.id, {
      activeJobText: '正在扫描发帖记录表…',
      lastError: null,
    });
    const grid = await ctx.readGrid(activeLink.id, { force: true });
    const cols = resolveRecordColumns(grid.headers, cfg.machineName);
    if (cols.postUrl < 0)
      throw new ProductError('SHEET_HEADER_MISSING', '发帖记录表第一行未找到「贴文链接」列', 400);

    const knownByCode = new Map(
      (await ctx.repo.listRecordPosts(activeLink.id)).map((r) => [r.postCode, r]),
    );
    let newlyDiscoveredCount = 0;
    const pendingBumpPosts: PendingBumpEntry[] = [];
    const reconcileBumpCells: PendingCellEntry[] = [];

    for (const row of grid.rows) {
      if (row.isHintRow) continue;
      const { postUrl, postId, postCode } = resolveRecordRowIdentity(row, cols);
      if (!postUrl.startsWith('http')) continue;
      const existing = knownByCode.get(postCode) ?? null;
      const rawCnt =
        cols.machineColumn >= 0 ? (row.displayValues[cols.machineColumn] ?? '').trim() : '';
      const sheetMachineCount = /^\d+$/.test(rawCnt) ? Number(rawCnt) : 0;
      const record = buildRecordFromRow(
        ctx,
        activeLink.id,
        row,
        cols,
        postCode,
        postUrl,
        postId,
        existing,
      );
      if (!existing) newlyDiscoveredCount++;
      await ctx.repo.upsertRecordPost(record);
      knownByCode.set(postCode, record);
      if (record.localBumpedCount > sheetMachineCount)
        reconcileBumpCells.push({ postCode, postUrl, value: String(record.localBumpedCount) });
      if (!isDirectFacebookPostUrl(postUrl)) continue;
      const ageHours = record.postedAtMs ? (ctx.nowFn() - record.postedAtMs) / 3_600_000 : 0;
      if (
        ageHours <= Math.max(1, cfg.bumperSettings.maxPostAgeHours) &&
        record.localBumpedCount < cfg.bumperSettings.maxLikesPerPost
      ) {
        pendingBumpPosts.push({
          rowNumber: row.rowNumber,
          record,
          item: {
            postCode,
            postUrl,
            postId,
            groupId: record.groupId,
            groupName: record.groupName,
            pageId: record.pageId,
            pageName: record.pageName,
          },
        });
      }
    }

    const [bumperProfiles, bumperBluestacks] = await Promise.all([
      resolveBoundBumperProfiles(
        ctx,
        cfg.bumperProfileGroupIds,
        cfg.bumperProfileIds,
        Boolean(ctx.deps.profileLifecycle),
      ),
      resolveBoundBluestacksInstances(ctx, cfg.bumperBluestacksFolderIds, cfg.bumperBluestacksIds),
    ]);
    let totalBumpsThisRound = 0;
    const hasChromeWorkers = bumperProfiles.length > 0 && Boolean(ctx.deps.automation);
    const hasBsWorkers = bumperBluestacks.length > 0 && Boolean(ctx.deps.bluestacks);

    if (pendingBumpPosts.length && !hasChromeWorkers && !hasBsWorkers) {
      const hasAnyBound =
        cfg.bumperProfileGroupIds.length > 0 ||
        cfg.bumperProfileIds.length > 0 ||
        cfg.bumperBluestacksFolderIds.length > 0 ||
        cfg.bumperBluestacksIds.length > 0;
      await safeAppendSheetLog(
        ctx,
        activeLink.id,
        'warn',
        'records_no_workers',
        hasAnyBound
          ? `发现 ${pendingBumpPosts.length} 条待顶贴，但所选顶贴账号组暂无在线或可唤醒的浏览器/蓝蝶`
          : `发现 ${pendingBumpPosts.length} 条待顶贴，但尚未在顶栏「选择顶贴账号组」中绑定任何浏览器或蓝蝶分组`,
      );
    }
    if (
      reconcileBumpCells.length &&
      !(pendingBumpPosts.length && (hasChromeWorkers || hasBsWorkers))
    ) {
      await ensureMachineColumnAndWriteCells(
        ctx,
        activeLink,
        grid.headers,
        cfg.machineName,
        cols,
        reconcileBumpCells,
      ).catch(() => {});
    }

    if (pendingBumpPosts.length && (hasChromeWorkers || hasBsWorkers)) {
      const machineColIndex = await ensureMachineColumnAndWriteCells(
        ctx,
        activeLink,
        grid.headers,
        cfg.machineName,
        cols,
        [],
      );
      const reservedByPostCode = new Map<string, number>();
      let liveCommentPool = [...cfg.commentPool];
      const consumeCommentFromPool = async (usedComment: string): Promise<void> => {
        if (!cfg.bumperSettings.consumeCommentOnUse || !usedComment) return;
        await runSerializedRecordWrite(ctx, `${activeLink.id}:comment-pool`, async () => {
          const idx = liveCommentPool.indexOf(usedComment);
          if (idx >= 0) {
            liveCommentPool = [...liveCommentPool.slice(0, idx), ...liveCommentPool.slice(idx + 1)];
            await ctx.repo.updateLink({
              id: activeLink.id,
              recordsConfig: { commentPool: liveCommentPool },
            });
          }
        });
      };
      const writeback = createBumpWritebackManager(
        ctx,
        activeLink,
        machineColIndex,
        cols,
        reconcileBumpCells,
      );
      const recordPostBumpOutcome = (workerId: string, postCode: string, postUrl: string) =>
        runSerializedRecordWrite(ctx, `${activeLink.id}:${postCode}`, async () => {
          totalBumpsThisRound++;
          const memEntry = pendingBumpPosts.find((t) => t.item.postCode === postCode);
          const cur = (await ctx.repo.getRecordPost(activeLink.id, postCode)) ?? memEntry?.record;
          if (!cur) return;
          const nextProfiles = [...new Set([...cur.bumpedProfileIds, workerId])];
          const nextCount = Math.max(cur.localBumpedCount + 1, nextProfiles.length);
          const updated = {
            ...cur,
            localBumpedCount: nextCount,
            bumpedProfileIds: nextProfiles,
            updatedAt: ctx.nowFn(),
          };
          await ctx.repo.upsertRecordPost(updated);
          if (memEntry) memEntry.record = updated;
          const curRes = reservedByPostCode.get(postCode) ?? 0;
          if (curRes > 0) reservedByPostCode.set(postCode, curRes - 1);
          writeback.schedule({
            postCode,
            postUrl,
            value: String(nextCount),
            hintRowNumber: memEntry?.rowNumber,
          });
        });
      const reportActiveJob = (prefix: string, text: string, workerId: string) => {
        updateActiveProfileStatus(ctx, workerId, activeLink.id, text);
        void ignoreError(
          ctx.repo.updateLinkRuntime(activeLink.id, { activeJobText: `${prefix} · ${text}` }),
        );
      };

      const poolPromises: Promise<void>[] = [];
      const enqueueCarrierPool = <T extends { id: string }>(
        items: readonly T[],
        concurrency: number,
        prepStatus: string,
        execute: (item: T, todo: PendingBumpEntry[], bumped: Set<string>) => Promise<void>,
        onError: (item: T, todo: PendingBumpEntry[], err: unknown) => Promise<void>,
        onOfflineClose: (item: T) => Promise<void>,
      ) => {
        const queue = [...items];
        const worker = async () => {
          for (;;) {
            const item = ctx.cancelledLinks.has(activeLink.id) ? undefined : queue.shift();
            if (!item) return;
            if (
              !(await tryClaimProfile(ctx, item.id, {
                linkId: activeLink.id,
                kind: 'post_records',
                title: activeLink.title,
                status: prepStatus,
              }))
            )
              continue;
            const todo = pendingBumpPosts.filter((entry) => {
              if (entry.record.bumpedProfileIds.includes(item.id)) return false;
              const inflight = reservedByPostCode.get(entry.item.postCode) ?? 0;
              if (entry.record.localBumpedCount + inflight >= cfg.bumperSettings.maxLikesPerPost)
                return false;
              reservedByPostCode.set(entry.item.postCode, inflight + 1);
              return true;
            });
            if (!todo.length) {
              releaseProfile(ctx, item.id, activeLink.id);
              continue;
            }
            const bumped = new Set<string>();
            try {
              await execute(item, todo, bumped);
            } catch (err) {
              await onError(item, todo, err);
            } finally {
              for (const e of todo) {
                if (!bumped.has(e.item.postCode)) {
                  const cur = reservedByPostCode.get(e.item.postCode) ?? 0;
                  if (cur > 0) reservedByPostCode.set(e.item.postCode, cur - 1);
                }
              }
              releaseProfile(ctx, item.id, activeLink.id);
              await onOfflineClose(item);
            }
          }
        };
        poolPromises.push(
          ...Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker),
        );
      };

      if (hasChromeWorkers) {
        enqueueCarrierPool(
          bumperProfiles,
          ctx.concurrency.maxProfiles ?? cfg.bumperSettings.maxConcurrentProfiles,
          '准备顶贴…',
          async (profile, todo, bumped) => {
            if (!profile.online && ctx.deps.profileLifecycle) {
              updateActiveProfileStatus(ctx, profile.id, activeLink.id, '正在唤醒浏览器…');
              const woke = await wakeBrowserProfile(
                ctx,
                profile.id,
                () =>
                  ctx.cancelledLinks.has(activeLink.id) || ctx.cancelledProfiles.has(profile.id),
              );
              if (!woke) throw new Error('离线浏览器未能按时唤醒上线（请检查启动路径绑定）');
            }
            await ctx.deps.automation?.bumpDirectPosts({
              profileId: profile.id,
              posts: todo.map((t) => t.item),
              settings: cfg.bumperSettings,
              commentPool: [...liveCommentPool],
              cancelled: () =>
                ctx.cancelledLinks.has(activeLink.id) || ctx.cancelledProfiles.has(profile.id),
              onStatus: (text) =>
                reportActiveJob(profile.browserName || profile.alias, text, profile.id),
              onCommentConsumed: cfg.bumperSettings.consumeCommentOnUse
                ? consumeCommentFromPool
                : undefined,
              onPostBumped: async (res) => {
                bumped.add(res.postCode);
                await recordPostBumpOutcome(profile.id, res.postCode, res.postUrl);
              },
            });
          },
          async (profile, todo, workerErr) => {
            const errReason = errMsg(workerErr);
            if (!ctx.cancelledLinks.has(activeLink.id) && !ctx.cancelledProfiles.has(profile.id)) {
              const first = todo[0]?.item;
              const isPage = todo.every((e) => !e.item.groupId || e.item.groupId === '-');
              recordPostBumpFailure(ctx.deps.postBumpRecords, {
                recordType: isPage ? 'page_bump' : 'group_bump',
                carrier: 'browser',
                status: 'failed',
                profileId: profile.id,
                groupId: isPage ? '' : (first?.groupId ?? ''),
                groupName: isPage ? '' : (first?.groupName ?? ''),
                pageId: first?.pageId ?? '',
                pageName: first?.pageName ?? '',
                errorReason: errReason.slice(0, 120),
              });
            }
            await safeAppendSheetLog(
              ctx,
              activeLink.id,
              'warn',
              'records_bump_worker_error',
              `顶贴浏览器 ${profile.browserName || profile.alias} 中止：${errReason}`,
            );
          },
          async (profile) => {
            if (!profile.online && ctx.deps.profileLifecycle)
              await ctx.deps.profileLifecycle.closeProfile(profile.id).catch(() => {});
          },
        );
      }

      if (hasBsWorkers && ctx.deps.bluestacks) {
        const bluestacksSvc = ctx.deps.bluestacks;
        enqueueCarrierPool(
          bumperBluestacks,
          Math.min(
            5,
            Math.max(1, ctx.concurrency.maxBluestacks ?? cfg.bumperSettings.maxConcurrentProfiles),
          ),
          '准备蓝蝶顶贴…',
          async (inst, todo, bumped) => {
            const ctrl = new AbortController();
            ctx.activeBluestacksAborts.set(inst.id, ctrl);
            const postCodeById = new Map<string, { postCode: string; postUrl: string }>();
            const postsInput = todo.map(({ item }) => {
              const postId = item.postId ?? item.postCode;
              postCodeById.set(postId, { postCode: item.postCode, postUrl: item.postUrl });
              return {
                postId,
                postUrl: item.postUrl,
                groupId: item.groupId,
                groupName: item.groupName,
                pageId: item.pageId,
                pageName: item.pageName,
              };
            });
            try {
              await bluestacksSvc.runDirectPostsForSheet({
                instanceId: inst.id,
                posts: postsInput,
                settings: cfg.bumperSettings,
                commentPool: [...liveCommentPool],
                signal: ctrl.signal,
                onProgress: (text) =>
                  reportActiveJob(`[蓝蝶] ${bluestacksDisplayTitle(inst)}`, text, inst.id),
                onPostDone: async (res) => {
                  const meta = postCodeById.get(res.postId);
                  if (!meta) return;
                  bumped.add(meta.postCode);
                  if (res.commentText) await consumeCommentFromPool(res.commentText);
                  await recordPostBumpOutcome(inst.id, meta.postCode, meta.postUrl);
                },
              });
            } finally {
              ctx.activeBluestacksAborts.delete(inst.id);
            }
          },
          async (inst, _todo, workerErr) =>
            safeAppendSheetLog(
              ctx,
              activeLink.id,
              'warn',
              'records_bump_bluestacks_error',
              `蓝蝶实例 ${bluestacksDisplayTitle(inst)} 顶贴中止：${errMsg(workerErr)}`,
            ),
          async (inst) => {
            if (!inst.online) await bluestacksSvc.closeInstanceForce(inst.id).catch(() => {});
          },
        );
      }

      ctx.activeBumpFlushers.set(activeLink.id, writeback.flushNow);
      try {
        await Promise.all(poolPromises);
      } finally {
        await writeback.flushNow();
        if (ctx.activeBumpFlushers.get(activeLink.id) === writeback.flushNow)
          ctx.activeBumpFlushers.delete(activeLink.id);
      }
    }

    let metricsSummary = '';
    if (cfg.collectMetricsOnThisPc && !ctx.cancelledLinks.has(activeLink.id)) {
      try {
        const mRes = await collectDueMetricsForLink(ctx, activeLink.id, false);
        if (mRes.updated > 0) metricsSummary = `；刷新赞/评 ${mRes.updated} 条`;
      } catch (mErr) {
        await safeAppendSheetLog(
          ctx,
          activeLink.id,
          'warn',
          'metrics_scrape_error',
          `赞/评采集异常：${errMsg(mErr)}`,
        );
      }
    }

    const hasNewActivity = newlyDiscoveredCount > 0 || totalBumpsThisRound > 0;
    const nextTier = nextTieredPollingState({
      currentMode: activeLink.runtime.pollingMode,
      consecutiveIdlePolls: activeLink.runtime.consecutiveIdlePolls,
      hasNewActivity,
      activePollMinutes: cfg.activePollMinutes,
      semiActivePollMinutes: cfg.semiActivePollMinutes,
      semiActiveAfterIdlePolls: cfg.semiActiveAfterIdlePolls,
      nowMs: ctx.nowFn(),
    });
    const summary = `新贴 ${newlyDiscoveredCount}，本轮顶贴 ${totalBumpsThisRound}${metricsSummary} · ${nextTier.pollingMode === 'active' ? `积极监听(${cfg.activePollMinutes}m)` : `半积极(${cfg.semiActivePollMinutes}m)`}`;
    await ctx.repo.updateLinkRuntime(activeLink.id, {
      lastSyncedAt: ctx.nowFn(),
      lastSyncSummary: summary,
      pollingMode: nextTier.pollingMode,
      consecutiveIdlePolls: nextTier.consecutiveIdlePolls,
      nextPollAt: nextTier.nextPollAt,
      activeJobText: '',
      lastError: null,
    });
    if (hasNewActivity || metricsSummary)
      await safeAppendSheetLog(ctx, activeLink.id, 'info', 'records_poll', summary);
    return { summary };
  } catch (err) {
    await recordLinkPollFailure(
      ctx,
      link,
      ctx.nowFn() + semiActiveFallbackMin * 60_000,
      'records_poll_error',
      '发帖记录监听异常',
      err,
    );
    throw err;
  } finally {
    ctx.runningRecordLinks.delete(linkId);
    ctx.cancelledLinks.delete(linkId);
  }
}
