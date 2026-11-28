import { ProductError, failError } from '../../domain/workspace.js';
import {
  extractFacebookPostIdFromUrl,
  generatePostCode,
  generateResourceCode,
  isDirectFacebookPostUrl,
  PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
  randomCodeSegment,
  resolveScheduleColumns,
  toSheetsImageFormula,
  type GoogleSheetLink,
} from '../../shared/google-sheets.js';
import {
  formatPosterCaptionPreview,
  type PosterLog,
  type PosterMaterial,
} from '../../shared/group-poster.js';
import { errMsg, ignoreError, sleepMs } from '../module-worker-pool.js';
import { Workboard } from '../workboard.js';
import {
  closeOfflineBrowserIfNeeded,
  isCarrierExecutionCancelled,
  logSheetEvent,
  reportCarrierJobStatus,
  runWithCarrierPermit,
  runWithLinkedBluestacksAbort,
  withSheetLinkPollRun,
} from './gs-carrier-helper.js';
import { releaseProfile, type GoogleSheetsContext } from './gs-context-and-library.js';
import {
  appendPostToRecordsSheet,
  buildScheduleTargets,
  collectDueScheduleRows,
  computeScheduleRetryState,
  findBluestacksInstanceForPage,
  findOrWakeProfileForPage,
  resetStuckRowsForLink,
  resolvePageDisplayName,
  switchChromeProfilePageIfNeeded,
  updateScheduleRowByKey,
  type DueScheduleRow,
} from './gs-schedule-helpers.js';
const saveScheduleProgress = (
  ctx: GoogleSheetsContext,
  linkId: string,
  task: DueScheduleRow,
  resourceCode: string,
  patch: {
    thumbnailUrl?: string | null;
    status: 'running' | 'pending' | 'completed' | 'partial' | 'failed';
    timelinePosted?: boolean;
    postedGroupIds?: string[];
    targetGroupCount: number;
    errorMessage?: string | null;
    attemptCount?: number;
    nextRetryAt?: number | null;
    lastError?: string | null;
  },
) => {
  const postedGroupIds = patch.postedGroupIds ?? [...task.prevPostedGroupIds];
  const errorMessage = patch.errorMessage ?? null;
  return ctx.repo.upsertScheduleItem({
    linkId,
    resourceCode,
    pageId: task.pageId,
    scheduledAt: task.scheduledAt,
    caption: task.caption,
    mediaSource: task.mediaSource,
    aiLabel: task.aiLabel,
    postTimeline: task.postTimeline,
    groupsSpec: task.groupsSpecRaw,
    thumbnailUrl: patch.thumbnailUrl ?? task.existingThumbnailUrl,
    status: patch.status,
    timelinePosted: patch.timelinePosted ?? task.prevTimelinePosted,
    postedGroupIds,
    targetGroupCount: patch.targetGroupCount,
    postedGroupCount: postedGroupIds.length,
    errorMessage,
    attemptCount: patch.attemptCount ?? task.prevAttemptCount,
    nextRetryAt: patch.nextRetryAt ?? null,
    lastError: patch.lastError ?? errorMessage,
    updatedAt: ctx.nowFn(),
  });
};
async function persistFailureWithRetry(
  ctx: GoogleSheetsContext,
  linkId: string,
  task: DueScheduleRow,
  resourceCode: string,
  thumbnailUrl: string | null,
  targetGroupCount: number,
  errorText: string,
  logAction: string,
  logSummary: string,
  writeRow?: (
    patch: { resourceCode?: string; status?: string },
    allowHint?: boolean,
  ) => Promise<void>,
  opts?: {
    allowHint?: boolean;
    logLevel?: 'error' | 'warn';
    statusText?: string;
    forceTerminal?: boolean;
  },
) {
  const retry = opts?.forceTerminal
    ? {
        status: 'failed' as const,
        attemptCount: task.prevAttemptCount + 1,
        nextRetryAt: null,
        terminal: true,
        sheetStatus: `失败：${errorText.slice(0, 48)}`,
      }
    : computeScheduleRetryState(
        task.prevAttemptCount,
        errorText,
        ctx.nowFn(),
        task.prevTimelinePosted || task.prevPostedGroupIds.length > 0,
      );
  await saveScheduleProgress(ctx, linkId, task, resourceCode, {
    thumbnailUrl,
    status: retry.status,
    targetGroupCount,
    errorMessage: errorText,
    attemptCount: retry.attemptCount,
    nextRetryAt: retry.nextRetryAt,
    lastError: errorText,
  });
  if (writeRow) {
    await writeRow(
      {
        resourceCode,
        status:
          opts?.statusText ??
          (retry.terminal ? `失败：${errorText.slice(0, 48)}` : retry.sheetStatus),
      },
      opts?.allowHint ?? false,
    ).catch((wbErr) =>
      logSheetEvent(
        ctx,
        linkId,
        'error',
        'schedule_writeback_error',
        `[${resourceCode}] 回写状态失败：${errMsg(wbErr)}`,
      ),
    );
  }
  await logSheetEvent(ctx, linkId, opts?.logLevel ?? 'error', logAction, logSummary);
}
async function verifyScheduleClaim(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  task: DueScheduleRow,
  resourceCode: string,
  runningClaimText: string,
  cols: ReturnType<typeof resolveScheduleColumns>,
): Promise<boolean> {
  if (!ctx.deps.sheetsApi.readColumnValues || cols.status < 0 || cols.resourceCode < 0) return true;
  await updateScheduleRowByKey(
    ctx,
    link,
    task.row.rowNumber,
    resourceCode,
    { resourceCode, status: runningClaimText },
    cols,
    !task.existingResourceCode,
  );
  const delay = ctx.deps.claimVerifyDelayMs ?? 1200;
  if (delay > 0) await sleepMs(delay);
  const [statusCol, codeCol] = await Promise.all([
    ctx.deps.sheetsApi
      .readColumnValues(link.spreadsheetId, link.sheetName, cols.status)
      .catch(() => null),
    ctx.deps.sheetsApi
      .readColumnValues(link.spreadsheetId, link.sheetName, cols.resourceCode)
      .catch(() => null),
  ]);
  const idx =
    statusCol && codeCol
      ? codeCol.findIndex((c, i) => i >= 1 && c.trim() === resourceCode.trim())
      : -1;
  const observed = idx >= 1 && statusCol ? (statusCol[idx] ?? '').trim() : '';
  if (!statusCol || !codeCol || idx < 1 || observed !== runningClaimText) {
    await logSheetEvent(
      ctx,
      link.id,
      'info',
      'schedule_claim_lost',
      !statusCol || !codeCol
        ? `[${resourceCode}] 抢占校验读取失败，为防多机重发本轮自动跳过`
        : `[${resourceCode}] 检测到另一台电脑已抢占该排贴（状态：${observed || '编号已被覆盖'}），本机自动跳过防重发`,
    );
    return false;
  }
  return true;
}
export async function runSchedulePoll(
  ctx: GoogleSheetsContext,
  linkId: string,
  manualTrigger = false,
  workboard = new Workboard({ browserConcurrency: 100, bluestacksConcurrency: 50 }),
): Promise<{ summary: string }> {
  let intervalMs = 120_000;
  return withSheetLinkPollRun(
    ctx,
    ctx.runningScheduleLinks,
    linkId,
    '正在执行中',
    '正在读取排贴表…',
    'schedule_poll_error',
    '排贴表轮询异常',
    () => ctx.nowFn() + intervalMs,
    async (activeLink) => {
      intervalMs = Math.max(1, activeLink.scheduleConfig?.pollIntervalMinutes ?? 2) * 60_000;
      if (!ctx.recoveredStuckLinks.has(activeLink.id)) {
        ctx.recoveredStuckLinks.add(activeLink.id);
        await ignoreError(
          resetStuckRowsForLink(ctx, activeLink.id, {
            onlyThisMachine: true,
            allowDuringPollSetup: true,
          }).then(() => undefined),
        );
      }
      const grid = await ctx.readGrid(activeLink.id, { force: true });
      const cols = resolveScheduleColumns(grid.headers);
      if (cols.pageId < 0 || cols.date < 0 || cols.status < 0 || cols.resourceCode < 0)
        failError(
          'SHEET_HEADER_MISSING',
          '排贴表缺少必填表头「发帖专页」「发帖日期」「资源编号」或「发布状态」',
          400,
        );
      const dueRows = await collectDueScheduleRows(ctx, activeLink, grid, cols, manualTrigger);
      if (!dueRows.length) {
        const summary = `检查完成，暂无到期可发的排贴任务（共 ${grid.rows.filter((r) => !r.isHintRow).length} 行）`;
        await ctx.repo.updateLinkRuntime(activeLink.id, {
          lastSyncedAt: ctx.nowFn(),
          lastSyncSummary: summary,
          activeJobText: '',
          nextPollAt: ctx.nowFn() + intervalMs,
        });
        return { summary };
      }
      const carrier = activeLink.scheduleConfig?.executionCarrier ?? 'browser';
      if (carrier === 'browser' && !ctx.deps.automation)
        throw new ProductError('SHEET_AUTOMATION_UNAVAILABLE', '发帖执行桥接未就绪', 503);
      if (carrier === 'bluestacks' && !ctx.deps.bluestacks)
        throw new ProductError('SHEET_BLUESTACKS_UNAVAILABLE', '蓝蝶模拟器发帖服务未就绪', 503);
      if (carrier === 'auto' && !ctx.deps.automation && !ctx.deps.bluestacks)
        throw new ProductError('SHEET_AUTOMATION_UNAVAILABLE', '发帖执行桥接未就绪', 503);
      let executedCount = 0;
      let totalPublishedPosts = 0;
      const recordHeadersCache = new Map<string, string[]>();
      for (const task of dueRows) {
        if (ctx.cancelledLinks.has(activeLink.id)) break;
        const resourceCode = task.existingResourceCode || generateResourceCode(task.scheduledAt);
        const log = (level: 'info' | 'warn' | 'error', action: string, summary: string) =>
          logSheetEvent(ctx, activeLink.id, level, action, summary);
        const writeRow = (patch: Parameters<typeof updateScheduleRowByKey>[4], allowHint = false) =>
          updateScheduleRowByKey(
            ctx,
            activeLink,
            task.row.rowNumber,
            resourceCode,
            patch,
            cols,
            allowHint,
          );
        const failTask = (
          errorText: string,
          logAction: string,
          opts?: Parameters<typeof persistFailureWithRetry>[10] & {
            thumbnailUrl?: string | null;
            targetGroupCount?: number;
            logSummary?: string;
            write?: typeof writeRow;
          },
        ) =>
          persistFailureWithRetry(
            ctx,
            activeLink.id,
            task,
            resourceCode,
            opts?.thumbnailUrl !== undefined ? opts.thumbnailUrl : task.existingThumbnailUrl,
            opts?.targetGroupCount ?? task.prevPostedGroupIds.length,
            errorText,
            logAction,
            opts?.logSummary ?? `[${resourceCode}] ${errorText}`,
            opts?.write,
            opts,
          );
        const resolvedPageName = await resolvePageDisplayName(ctx, task.pageId, null);
        let matchedCarrier: 'browser' | 'bluestacks' | null = null;
        let executorId = '';
        let executorAccountName = resolvedPageName;
        let wokeChromeFromOffline = false;
        let needsChromePageSwitch = false;
        let busyLabel: string | null = null;
        let riskLimitedMsg: string | null = null;
        if ((carrier === 'browser' || carrier === 'auto') && ctx.deps.automation) {
          const res = await findOrWakeProfileForPage(
            ctx,
            task.pageId,
            activeLink.id,
            activeLink.title,
            resolvedPageName,
            workboard,
          );
          if (res.status === 'found') {
            matchedCarrier = 'browser';
            executorId = res.profile.id;
            executorAccountName = res.profile.account.name || resolvedPageName;
            wokeChromeFromOffline = res.wokeFromOffline;
            needsChromePageSwitch = res.needsPageSwitch;
          } else if (res.status === 'busy') busyLabel = res.label;
          else if (res.status === 'risk_limited') riskLimitedMsg = res.reason;
        }
        if (!matchedCarrier && (carrier === 'bluestacks' || carrier === 'auto')) {
          const res = await findBluestacksInstanceForPage(
            ctx,
            task.pageId,
            resolvedPageName,
            activeLink,
          );
          if (res.status === 'found') {
            matchedCarrier = 'bluestacks';
            executorId = res.instance.id;
            executorAccountName = res.instance.accountName || resolvedPageName;
          } else if (res.status === 'busy' && !busyLabel) busyLabel = res.label;
        }
        if (!matchedCarrier || !executorId) {
          if (busyLabel) {
            await log(
              'info',
              'schedule_executor_busy_defer',
              `[${resourceCode}] 专页 ${task.pageId} 对应执行端（${busyLabel}）正忙，顺延下一轮自动尝试`,
            );
          } else {
            const msg =
              riskLimitedMsg ??
              (carrier === 'bluestacks'
                ? `未找到匹配专页 ${task.pageId} 的可用蓝蝶模拟器`
                : carrier === 'auto'
                  ? `未找到专页 ${task.pageId} 对应的浏览器或蓝蝶模拟器`
                  : `未找到当前专页为 ${task.pageId} 的在线/可唤醒浏览器`);
            await failTask(
              msg,
              riskLimitedMsg ? 'schedule_risk_limit_blocked' : 'schedule_no_browser',
              {
                write: writeRow,
                allowHint: !task.existingResourceCode,
                logLevel: 'warn',
                statusText: `失败：${msg.slice(0, 48)}`,
              },
            );
          }
          continue;
        }
        let downloadedTempMediaPath: string | null = null;
        const resolvedCarrier = matchedCarrier;
        try {
          await runWithCarrierPermit(
            workboard,
            {
              carrierKind: resolvedCarrier,
              executorId,
              moduleId:
                resolvedCarrier === 'bluestacks'
                  ? 'sheets-bluestacks-poster'
                  : 'sheets-chrome-poster',
              swallowWorkAbort: true,
            },
            async (signal) => {
              const targetList = await buildScheduleTargets(
                ctx,
                executorAccountName || task.pageId,
                task.postTimeline && !task.prevTimelinePosted,
                task.groupsSpecRaw,
                task.extraCategory,
                task.prevPostedGroupIds,
              );
              if (!targetList.length) {
                await writeRow(
                  task.prevTimelinePosted || task.prevPostedGroupIds.length > 0
                    ? {
                        resourceCode,
                        status: '已完成',
                        postedGroupsCount: `${task.prevPostedGroupIds.length}/${task.prevPostedGroupIds.length}`,
                      }
                    : {
                        resourceCode,
                        status: '失败：未匹配到可发布的目标小组（请检查小组表/类别或开启时间线）',
                      },
                  !task.existingResourceCode,
                );
                return;
              }
              if (resolvedCarrier === 'browser' && ctx.deps.checkDailyRiskLimit) {
                const limitRes = await Promise.resolve(
                  ctx.deps.checkDailyRiskLimit(executorId, 'post'),
                );
                if (!limitRes.allowed) {
                  const limitReason = limitRes.reason ?? '今日已达浏览器发帖日限额，自动休眠保护';
                  await failTask(limitReason, 'schedule_risk_limit_blocked', {
                    write: writeRow,
                    allowHint: !task.existingResourceCode,
                    logLevel: 'warn',
                    forceTerminal: true,
                  });
                  return;
                }
              }
              if (resolvedCarrier === 'browser' && needsChromePageSwitch) {
                await switchChromeProfilePageIfNeeded(ctx, {
                  profileId: executorId,
                  needsPageSwitch: true,
                  targetPageId: task.pageId,
                  targetPageName: resolvedPageName,
                });
              }
              const pcTag = ((await ctx.repo.getImageHostConfig()).defaultMachineName || '本机')
                .trim()
                .slice(0, 16);
              const runningClaimText = `${resolvedCarrier === 'bluestacks' ? '蓝蝶发布中' : '发布中'}(${pcTag}#${randomCodeSegment(4)})…`;
              try {
                if (
                  !(await verifyScheduleClaim(
                    ctx,
                    activeLink,
                    task,
                    resourceCode,
                    runningClaimText,
                    cols,
                  ))
                )
                  return;
              } catch (claimErr) {
                const m = errMsg(claimErr);
                await failTask(m, 'schedule_writeback_error', {
                  targetGroupCount: targetList.filter(
                    (t) => t.id !== PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
                  ).length,
                  logSummary: `[${resourceCode}] 排贴抢占回写失败：${m}`,
                });
                return;
              }
              let localFilePath: string | null = null;
              let mediaKind: 'none' | 'image' | 'video' = 'none';
              let permanentThumbnailUrl = task.existingThumbnailUrl;
              await ctx.repo.updateLinkRuntime(activeLink.id, {
                activeJobText: `准备素材 · ${resourceCode}`,
              });
              const mediaPreparer =
                ctx.deps.prepareMaterialMedia ?? ctx.deps.automation?.prepareMaterialMedia;
              try {
                if (task.mediaSource && mediaPreparer) {
                  const prep = await mediaPreparer(task.mediaSource);
                  localFilePath = prep.localFilePath;
                  mediaKind = prep.mediaKind;
                  if (prep.isTemporaryCache && prep.localFilePath)
                    downloadedTempMediaPath = prep.localFilePath;
                  if (!permanentThumbnailUrl && prep.thumbnailDataUrl) {
                    const up = await ctx.deps.imageHost
                      .uploadDataUrlOrUrl({
                        source: prep.thumbnailDataUrl,
                        filenameHint: `thumb-${resourceCode}`,
                      })
                      .catch(() => null);
                    if (up) permanentThumbnailUrl = up.remoteUrl;
                  }
                }
              } catch (prepErr) {
                const m = errMsg(prepErr);
                await failTask(`素材准备失败：${m}`, 'schedule_media_error', {
                  thumbnailUrl: permanentThumbnailUrl,
                  targetGroupCount: targetList.filter(
                    (t) => t.id !== PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
                  ).length,
                  write: writeRow,
                });
                return;
              }
              const groupTargetCount =
                task.prevPostedGroupIds.length +
                targetList.filter((t) => t.id !== PAGE_TIMELINE_SYNTHETIC_GROUP_ID).length;
              await writeRow({
                resourceCode,
                thumbnailFormula: permanentThumbnailUrl
                  ? toSheetsImageFormula(permanentThumbnailUrl)
                  : undefined,
                status: runningClaimText,
                postedGroupsCount: `${task.prevPostedGroupIds.length}/${groupTargetCount}`,
              });
              await saveScheduleProgress(ctx, activeLink.id, task, resourceCode, {
                thumbnailUrl: permanentThumbnailUrl,
                status: 'running',
                targetGroupCount: groupTargetCount,
              });
              const material: PosterMaterial = {
                id: resourceCode,
                caption: task.caption,
                mediaSource: task.mediaSource,
                mediaKind,
                background: 'plain',
                aiLabel: task.aiLabel,
                localFilePath,
                hasThumbnail: Boolean(permanentThumbnailUrl),
                cacheStatus: 'ready',
                cacheError: null,
                selected: true,
                sortOrder: 0,
                usedCount: 0,
                createdAt: ctx.nowFn(),
                updatedAt: ctx.nowFn(),
              };
              const postedGroupIds = [...task.prevPostedGroupIds];
              let timelinePosted = task.prevTimelinePosted;
              const pageName = await resolvePageDisplayName(ctx, task.pageId, executorAccountName);
              let wokeRecordsThisTask = false;
              const recordCarrier = resolvedCarrier === 'bluestacks' ? 'bluestacks' : 'browser';
              const handleStatus = (text: string) =>
                reportCarrierJobStatus(
                  ctx,
                  activeLink.id,
                  executorId,
                  `[${resourceCode}] ${text}`,
                  text,
                );
              const handlePosted = async (postLog: PosterLog, isTimeline: boolean) => {
                totalPublishedPosts++;
                if (isTimeline) timelinePosted = true;
                else postedGroupIds.push(postLog.groupId);
                const postCode = generatePostCode(resourceCode);
                await saveScheduleProgress(ctx, activeLink.id, task, resourceCode, {
                  thumbnailUrl: permanentThumbnailUrl,
                  status: 'running',
                  timelinePosted,
                  postedGroupIds,
                  targetGroupCount: groupTargetCount,
                });
                const safeUrl = isDirectFacebookPostUrl(postLog.postUrl)
                  ? postLog.postUrl.trim()
                  : '';
                const safeId = safeUrl
                  ? postLog.postId || extractFacebookPostIdFromUrl(safeUrl)
                  : '';
                void ignoreError(
                  ctx.deps.postBumpRecords?.insert({
                    recordType: 'post',
                    carrier: recordCarrier,
                    status: 'success',
                    profileId: executorId,
                    accountId: postLog.accountId ?? '',
                    accountName: executorAccountName,
                    groupId: isTimeline ? '' : postLog.groupId,
                    groupName: isTimeline ? '专页时间线' : postLog.groupName,
                    pageId: task.pageId,
                    pageName,
                    postId: safeId ?? postLog.postId ?? '',
                    postUrl: safeUrl,
                    captionPreview: formatPosterCaptionPreview(task.caption),
                    createdAt: postLog.postedAt,
                  }),
                );
                const recLinkId = activeLink.scheduleConfig?.targetRecordLinkId ?? null;
                if (recLinkId) {
                  await appendPostToRecordsSheet(
                    ctx,
                    recLinkId,
                    {
                      postedAtMs: postLog.postedAt,
                      groupId: isTimeline ? '-' : postLog.groupId,
                      groupName: isTimeline ? '专页时间线' : postLog.groupName,
                      pageId: task.pageId,
                      pageName,
                      postUrl: safeUrl,
                      postId: safeUrl
                        ? postLog.postId || extractFacebookPostIdFromUrl(safeUrl)
                        : null,
                      postCode,
                      resourceCode,
                      thumbnailUrl: permanentThumbnailUrl,
                    },
                    recordHeadersCache,
                  ).catch(
                    (err) =>
                      void log(
                        'error',
                        'record_writeback_error',
                        `回写发帖记录失败 (${postCode})：${errMsg(err)}`,
                      ),
                  );
                  if (activeLink.scheduleConfig?.autoWakeBumper !== false && !wokeRecordsThisTask) {
                    wokeRecordsThisTask = true;
                    void ctx
                      .wakeRecordsLinkToActive(
                        recLinkId,
                        `排贴表「${activeLink.title}」刚发布新贴 ${postCode}`,
                      )
                      .catch(() => {});
                  }
                }
                await writeRow({
                  postedGroupsCount: `${postedGroupIds.length}/${groupTargetCount}`,
                }).catch(() => {});
              };
              let result: { postedCount: number; timelinePosted: boolean; error?: string };
              try {
                if (resolvedCarrier === 'bluestacks' && ctx.deps.bluestacks) {
                  const bsSvc = ctx.deps.bluestacks;
                  result = await runWithLinkedBluestacksAbort(ctx, executorId, signal, (bsSignal) =>
                    bsSvc.runDirectPosterForSheet({
                      instanceId: executorId,
                      targetPageId: task.pageId,
                      targetPageName: pageName,
                      material,
                      targets: targetList,
                      closeOnFinish: activeLink.scheduleConfig?.closeBluestacksOnFinish !== false,
                      signal: bsSignal,
                      onStatus: handleStatus,
                      onPosted: handlePosted,
                    }),
                  );
                } else if (ctx.deps.automation) {
                  result = await ctx.deps.automation.publishScheduledMaterial({
                    profileId: executorId,
                    material,
                    targets: targetList,
                    targetPageId: task.pageId,
                    targetPageName: pageName,
                    cancelled: () =>
                      isCarrierExecutionCancelled(ctx, activeLink.id, executorId, signal),
                    onStatus: handleStatus,
                    onPosted: handlePosted,
                  });
                } else
                  result = { postedCount: 0, timelinePosted: false, error: '发帖执行器未就绪' };
              } catch (pubErr) {
                result = { postedCount: 0, timelinePosted, error: errMsg(pubErr) };
              }
              executedCount++;
              const allOk =
                (!task.postTimeline || timelinePosted) &&
                postedGroupIds.length >= groupTargetCount &&
                !result.error;
              const hasProgress = timelinePosted || postedGroupIds.length > 0;
              const errDetail = result.error ?? '未发布成功';
              const retryPlan = allOk
                ? null
                : computeScheduleRetryState(
                    task.prevAttemptCount,
                    errDetail,
                    ctx.nowFn(),
                    hasProgress,
                  );
              const finalStatus = allOk ? ('completed' as const) : (retryPlan?.status ?? 'failed');
              const finalLabel = allOk
                ? '已完成'
                : hasProgress
                  ? retryPlan && !retryPlan.terminal
                    ? `待重试(${retryPlan.attemptCount}/${3}·时间线${timelinePosted ? '已发' : '未发'}·小组${postedGroupIds.length}/${groupTargetCount})`
                    : `部分完成(${task.postTimeline ? (timelinePosted ? '时间线已发·' : '时间线未发·') : ''}小组${postedGroupIds.length}/${groupTargetCount}${result.error ? `·${result.error.slice(0, 26)}` : ''})`
                  : (retryPlan?.sheetStatus ?? `失败：${errDetail.slice(0, 48)}`);
              if (!allOk && !hasProgress && retryPlan?.terminal) {
                void ignoreError(
                  ctx.deps.postBumpRecords?.insert({
                    recordType: 'post',
                    carrier: recordCarrier,
                    status: 'failed',
                    profileId: executorId,
                    accountName: executorAccountName,
                    pageId: task.pageId,
                    pageName,
                    captionPreview: formatPosterCaptionPreview(task.caption),
                    errorReason: errDetail.slice(0, 120),
                  }),
                );
              }
              const progressBase = {
                thumbnailUrl: permanentThumbnailUrl,
                status: finalStatus,
                timelinePosted,
                postedGroupIds,
                targetGroupCount: groupTargetCount,
              };
              await saveScheduleProgress(ctx, activeLink.id, task, resourceCode, {
                ...progressBase,
                errorMessage: allOk ? null : errDetail,
                attemptCount: allOk ? 0 : (retryPlan?.attemptCount ?? task.prevAttemptCount + 1),
                nextRetryAt: allOk ? null : (retryPlan?.nextRetryAt ?? null),
                lastError: allOk ? null : errDetail,
              });
              try {
                await writeRow({
                  resourceCode,
                  status: finalLabel,
                  postedGroupsCount: `${postedGroupIds.length}/${groupTargetCount}`,
                });
              } catch (wbErr) {
                const wbMsg = errMsg(wbErr);
                await saveScheduleProgress(ctx, activeLink.id, task, resourceCode, {
                  ...progressBase,
                  errorMessage: wbMsg,
                  attemptCount: retryPlan?.attemptCount ?? task.prevAttemptCount,
                  nextRetryAt: retryPlan?.nextRetryAt ?? null,
                  lastError: `回写状态失败：${wbMsg}`,
                });
                await log(
                  'error',
                  'schedule_writeback_error',
                  `[${resourceCode}] 回写排贴状态失败：${wbMsg}`,
                );
                throw wbErr;
              }
              await log(
                finalStatus === 'failed' ? 'error' : 'info',
                'schedule_publish_done',
                `${resolvedCarrier === 'bluestacks' ? '[蓝蝶] ' : ''}[${resourceCode}] ${finalLabel}（时间线：${timelinePosted ? '已发' : '未发'}，小组：${postedGroupIds.length}/${groupTargetCount}）`,
              );
            },
          );
        } finally {
          const mediaCleaner =
            ctx.deps.cleanupPreparedMedia ?? ctx.deps.automation?.cleanupPreparedMedia;
          if (downloadedTempMediaPath && mediaCleaner)
            await mediaCleaner(downloadedTempMediaPath).catch(() => {});
          releaseProfile(ctx, executorId, activeLink.id);
          await closeOfflineBrowserIfNeeded(
            ctx,
            executorId,
            wokeChromeFromOffline && resolvedCarrier === 'browser',
          );
        }
      }
      const summary = `本轮处理 ${executedCount} 条排贴任务，成功发布 ${totalPublishedPosts} 篇贴文`;
      await ctx.repo.updateLinkRuntime(activeLink.id, {
        lastSyncedAt: ctx.nowFn(),
        lastSyncSummary: summary,
        activeJobText: '',
        lastError: null,
        nextPollAt: ctx.nowFn() + intervalMs,
      });
      return { summary };
    },
  );
}
