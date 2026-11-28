import { ProductError } from '../../domain/workspace.js';
import { bluestacksDisplayTitle } from '../../shared/bluestacks.js';
import {
  isDirectFacebookPostUrl,
  nextTieredPollingState,
  resolveEffectiveInstanceIds,
  resolveRecordColumns,
  type GoogleSheetLink,
} from '../../shared/google-sheets.js';
import type { DirectPostBumpItem, SheetRecordPostPortRecord } from '../google-sheets-ports.js';
import { errMsg, recordPostBumpFailure, sortTargetsOnlineFirst } from '../module-worker-pool.js';
import { Workboard, isWorkAbortError } from '../workboard.js';
import {
  closeOfflineBrowserIfNeeded,
  ensureBrowserProfileOnline,
  isCarrierExecutionCancelled,
  logSheetEvent,
  reportCarrierJobStatus,
  runWithCarrierPermit,
  runWithLinkedBluestacksAbort,
  withSheetLinkPollRun,
} from './gs-carrier-helper.js';
import {
  releaseProfile,
  resolveBoundBluestacksInstances,
  resolveBoundBumperProfiles,
  runSerializedRecordWrite,
  tryClaimProfile,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';
import {
  buildRecordFromRow,
  collectDueMetricsForLink,
  ensureMachineColumnAndWriteCells,
  resolveRecordRowIdentity,
  writeBatchRecordCellsByKey,
  type SheetCellUpdateEntry,
} from './gs-metrics-collector.js';
type PendingBumpEntry = {
  item: DirectPostBumpItem;
  rowNumber: number;
  record: SheetRecordPostPortRecord;
};
function createBumpWritebackManager(
  ctx: GoogleSheetsContext,
  activeLink: GoogleSheetLink,
  machineColIndex: number,
  cols: ReturnType<typeof resolveRecordColumns>,
  initialCells: readonly SheetCellUpdateEntry[],
) {
  const pending = new Map<string, SheetCellUpdateEntry>(initialCells.map((c) => [c.postCode, c]));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<void> = Promise.resolve();
  const flushNow = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return (tail = tail.then(async () => {
      if (!pending.size) return;
      const batch = [...pending.values()];
      pending.clear();
      try {
        await writeBatchRecordCellsByKey(ctx, activeLink, machineColIndex, batch, cols);
      } catch (err) {
        for (const item of batch) if (!pending.has(item.postCode)) pending.set(item.postCode, item);
        await logSheetEvent(
          ctx,
          activeLink.id,
          'warn',
          'records_bump_writeback_retry',
          `批量回写顶贴计数暂时失败（${batch.length} 条），将在本轮结束时重试：${errMsg(err)}`,
        );
      }
    }));
  };
  const schedule = (entry: SheetCellUpdateEntry) => {
    pending.set(entry.postCode, entry);
    if (pending.size >= 25) return void flushNow();
    if (!timer) {
      timer = setTimeout(() => ((timer = null), void flushNow()), 2500);
      timer.unref?.();
    }
  };
  return { flushNow, schedule };
}
export async function runRecordsPoll(
  ctx: GoogleSheetsContext,
  linkId: string,
  workboard = new Workboard({ browserConcurrency: 100, bluestacksConcurrency: 50 }),
): Promise<{ summary: string }> {
  let semiActiveFallbackMin = 10;
  return withSheetLinkPollRun(
    ctx,
    ctx.runningRecordLinks,
    linkId,
    '正在检查中',
    '正在扫描发帖记录表…',
    'records_poll_error',
    '发帖记录监听异常',
    () => ctx.nowFn() + semiActiveFallbackMin * 60_000,
    async (activeLink) => {
      const cfg = activeLink.recordsConfig;
      if (!cfg) throw new ProductError('SHEET_CONFIG_MISSING', '发帖记录表缺少配置', 400);
      semiActiveFallbackMin = Math.max(2, cfg.semiActivePollMinutes);
      const grid = await ctx.readGrid(activeLink.id, { force: true });
      const cols = resolveRecordColumns(grid.headers, cfg.machineName);
      if (cols.postUrl < 0)
        throw new ProductError('SHEET_HEADER_MISSING', '发帖记录表第一行未找到「贴文链接」列', 400);
      const knownByCode = new Map(
        (await ctx.repo.listRecordPosts(activeLink.id)).map((r) => [r.postCode, r]),
      );
      let newlyDiscoveredCount = 0;
      const pendingBumpPosts: PendingBumpEntry[] = [];
      const reconcileBumpCells: SheetCellUpdateEntry[] = [];
      const log = (level: 'info' | 'warn' | 'error', action: string, summary: string) =>
        logSheetEvent(ctx, activeLink.id, level, action, summary);
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
      const effectiveBsIds = resolveEffectiveInstanceIds(
        cfg.bumperBluestacksIds,
        cfg.selectedInstanceIds,
      );
      const [bumperProfiles, bumperBluestacks] = await Promise.all([
        resolveBoundBumperProfiles(
          ctx,
          cfg.bumperProfileGroupIds,
          cfg.bumperProfileIds,
          Boolean(ctx.deps.profileLifecycle),
          Boolean(cfg.includeUngrouped),
        ),
        resolveBoundBluestacksInstances(ctx, cfg.bumperBluestacksFolderIds, effectiveBsIds),
      ]);
      let totalBumpsThisRound = 0;
      const hasChromeWorkers = bumperProfiles.length > 0 && Boolean(ctx.deps.automation);
      const hasBsWorkers = bumperBluestacks.length > 0 && Boolean(ctx.deps.bluestacks);
      if (pendingBumpPosts.length && !hasChromeWorkers && !hasBsWorkers) {
        const hasAnyBound =
          Boolean(cfg.includeUngrouped) ||
          cfg.bumperProfileGroupIds.length > 0 ||
          cfg.bumperProfileIds.length > 0 ||
          cfg.bumperBluestacksFolderIds.length > 0 ||
          effectiveBsIds.length > 0;
        await log(
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
              liveCommentPool = [
                ...liveCommentPool.slice(0, idx),
                ...liveCommentPool.slice(idx + 1),
              ];
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
        const poolPromises: Promise<void>[] = [];
        const enqueueCarrierPool = <T extends { id: string }>(
          items: readonly T[],
          carrierKind: 'browser' | 'bluestacks',
          concurrency: number,
          prepStatus: string,
          execute: (
            item: T,
            todo: PendingBumpEntry[],
            bumped: Set<string>,
            signal: AbortSignal,
          ) => Promise<void>,
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
                await runWithCarrierPermit(
                  workboard,
                  {
                    carrierKind,
                    executorId: item.id,
                    moduleId:
                      carrierKind === 'bluestacks'
                        ? 'sheets-bluestacks-bumper'
                        : 'sheets-chrome-bumper',
                  },
                  (signal) => execute(item, todo, bumped, signal),
                );
              } catch (err) {
                if (!isWorkAbortError(err)) await onError(item, todo, err);
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
          const orderedChrome = await sortTargetsOnlineFirst(bumperProfiles, (p) => p.online);
          const wokeOfflineProfiles = new Set<string>();
          enqueueCarrierPool(
            orderedChrome,
            'browser',
            Math.max(1, workboard.browserPermits.max),
            '准备顶贴…',
            async (profile, todo, bumped, signal) => {
              if (ctx.deps.checkDailyRiskLimit) {
                const limitRes = await Promise.resolve(
                  ctx.deps.checkDailyRiskLimit(profile.id, 'bump'),
                );
                if (!limitRes.allowed) {
                  await log(
                    'warn',
                    'records_bump_risk_limit',
                    `顶贴浏览器 ${profile.browserName || profile.alias} 已达日限额：${limitRes.reason ?? '自动休眠保护'}`,
                  );
                  return;
                }
              }
              const liveSnap = await ctx.deps.workspace.snapshot().catch(() => null);
              const liveProfile = liveSnap?.profiles.find((p) => p.id === profile.id);
              const liveOnline = liveProfile ? liveProfile.online : profile.online;
              if (!liveOnline && ctx.deps.profileLifecycle) {
                wokeOfflineProfiles.add(profile.id);
                await ensureBrowserProfileOnline(
                  ctx,
                  workboard,
                  activeLink.id,
                  profile.id,
                  false,
                  signal,
                );
              }
              await ctx.deps.automation?.bumpDirectPosts({
                profileId: profile.id,
                posts: todo.map((t) => t.item),
                settings: cfg.bumperSettings,
                commentPool: [...liveCommentPool],
                cancelled: () =>
                  isCarrierExecutionCancelled(ctx, activeLink.id, profile.id, signal),
                onStatus: (text) =>
                  reportCarrierJobStatus(
                    ctx,
                    activeLink.id,
                    profile.id,
                    `${profile.browserName || profile.alias} · ${text}`,
                    text,
                  ),
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
              if (!isCarrierExecutionCancelled(ctx, activeLink.id, profile.id)) {
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
              await log(
                'warn',
                'records_bump_worker_error',
                `顶贴浏览器 ${profile.browserName || profile.alias} 中止：${errReason}`,
              );
            },
            async (profile) => {
              const shouldClose = wokeOfflineProfiles.has(profile.id);
              wokeOfflineProfiles.delete(profile.id);
              await closeOfflineBrowserIfNeeded(ctx, profile.id, shouldClose);
            },
          );
        }
        if (hasBsWorkers && ctx.deps.bluestacks) {
          const bluestacksSvc = ctx.deps.bluestacks;
          const orderedBs = await sortTargetsOnlineFirst(bumperBluestacks, (i) => i.online);
          const wokeOfflineBs = new Set<string>();
          enqueueCarrierPool(
            orderedBs,
            'bluestacks',
            Math.max(1, workboard.bluestacksPermits.max),
            '准备蓝蝶顶贴…',
            async (inst, todo, bumped, signal) => {
              const liveBs = await bluestacksSvc.state(false).catch(() => null);
              const liveInst = liveBs?.instances.find((i) => i.id === inst.id);
              if (!(liveInst ? liveInst.online : inst.online)) wokeOfflineBs.add(inst.id);
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
              await runWithLinkedBluestacksAbort(ctx, inst.id, signal, (bsSignal) =>
                bluestacksSvc.runDirectPostsForSheet({
                  instanceId: inst.id,
                  posts: postsInput,
                  settings: cfg.bumperSettings,
                  commentPool: [...liveCommentPool],
                  signal: bsSignal,
                  onProgress: (text) =>
                    reportCarrierJobStatus(
                      ctx,
                      activeLink.id,
                      inst.id,
                      `[蓝蝶] ${bluestacksDisplayTitle(inst)} · ${text}`,
                      text,
                    ),
                  onPostDone: async (res) => {
                    const meta = postCodeById.get(res.postId);
                    if (!meta) return;
                    bumped.add(meta.postCode);
                    if (res.commentText) await consumeCommentFromPool(res.commentText);
                    await recordPostBumpOutcome(inst.id, meta.postCode, meta.postUrl);
                  },
                }),
              );
            },
            async (inst, _todo, workerErr) =>
              log(
                'warn',
                'records_bump_bluestacks_error',
                `蓝蝶实例 ${bluestacksDisplayTitle(inst)} 顶贴中止：${errMsg(workerErr)}`,
              ),
            async (inst) => {
              const shouldClose = wokeOfflineBs.has(inst.id);
              wokeOfflineBs.delete(inst.id);
              if (shouldClose) await bluestacksSvc.closeInstanceForce(inst.id).catch(() => {});
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
          await log('warn', 'metrics_scrape_error', `赞/评采集异常：${errMsg(mErr)}`);
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
      if (hasNewActivity || metricsSummary) await log('info', 'records_poll', summary);
      return { summary };
    },
  );
}
