import { ProductError } from '../../domain/workspace.js';
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
import {
  recordLinkPollFailure,
  releaseProfile,
  requireLink,
  safeAppendSheetLog,
  updateActiveProfileStatus,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';
import {
  appendPostToRecordsSheet,
  buildScheduleTargets,
  collectDueScheduleRows,
  findBluestacksInstanceForPage,
  findOrWakeProfileForPage,
  resolvePageDisplayName,
  updateScheduleRowByKey,
  type DueScheduleRow,
} from './gs-schedule-helpers.js';

const saveScheduleProgress = (
  ctx: GoogleSheetsContext,
  linkId: string,
  task: DueScheduleRow,
  resourceCode: string,
  thumbnailUrl: string | null,
  status: 'running' | 'completed' | 'partial' | 'failed',
  timelinePosted: boolean,
  postedGroupIds: string[],
  targetGroupCount: number,
  errorMessage: string | null,
) =>
  ctx.repo.upsertScheduleItem({
    linkId,
    resourceCode,
    pageId: task.pageId,
    scheduledAt: task.scheduledAt,
    caption: task.caption,
    mediaSource: task.mediaSource,
    aiLabel: task.aiLabel,
    postTimeline: task.postTimeline,
    groupsSpec: task.groupsSpecRaw,
    thumbnailUrl,
    status,
    timelinePosted,
    postedGroupIds,
    targetGroupCount,
    postedGroupCount: postedGroupIds.length,
    errorMessage,
    updatedAt: ctx.nowFn(),
  });

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
    await safeAppendSheetLog(
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
): Promise<{ summary: string }> {
  if (ctx.runningScheduleLinks.has(linkId)) return { summary: '正在执行中' };
  ctx.runningScheduleLinks.add(linkId);
  ctx.cancelledLinks.delete(linkId);
  let link: GoogleSheetLink | null = null;
  let intervalMs = 120_000;

  try {
    link = await requireLink(ctx, linkId);
    const activeLink = link;
    intervalMs = Math.max(1, activeLink.scheduleConfig?.pollIntervalMinutes ?? 2) * 60_000;
    await ctx.repo.updateLinkRuntime(activeLink.id, {
      activeJobText: '正在读取排贴表…',
      lastError: null,
    });
    const grid = await ctx.readGrid(activeLink.id, { force: true });
    const cols = resolveScheduleColumns(grid.headers);
    if (cols.pageId < 0 || cols.date < 0)
      throw new ProductError(
        'SHEET_HEADER_MISSING',
        '排贴表缺少必填表头「发帖专页」或「发帖日期」',
        400,
      );

    const dueRows = await collectDueScheduleRows(ctx, link, grid, cols, manualTrigger);
    if (!dueRows.length) {
      const summary = `检查完成，暂无到期可发的排贴任务（共 ${grid.rows.filter((r) => !r.isHintRow).length} 行）`;
      await ctx.repo.updateLinkRuntime(link.id, {
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
      if (ctx.cancelledLinks.has(link.id)) break;
      const resourceCode = task.existingResourceCode || generateResourceCode(task.scheduledAt);
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
      const resolvedPageName = await resolvePageDisplayName(ctx, task.pageId, null);

      let matchedCarrier: 'browser' | 'bluestacks' | null = null;
      let executorId = '';
      let executorAccountName = resolvedPageName;
      let wokeChromeFromOffline = false;
      let busyLabel: string | null = null;
      if ((carrier === 'browser' || carrier === 'auto') && ctx.deps.automation) {
        const res = await findOrWakeProfileForPage(
          ctx,
          task.pageId,
          activeLink.id,
          activeLink.title,
        );
        if (res.status === 'found') {
          matchedCarrier = 'browser';
          executorId = res.profile.id;
          executorAccountName = res.profile.account.name || resolvedPageName;
          wokeChromeFromOffline = res.wokeFromOffline;
        } else if (res.status === 'busy') busyLabel = res.label;
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
          await safeAppendSheetLog(
            ctx,
            link.id,
            'info',
            'schedule_executor_busy_defer',
            `[${resourceCode}] 专页 ${task.pageId} 对应执行端（${busyLabel}）正忙，顺延下一轮自动尝试`,
          );
        } else {
          const msg =
            carrier === 'bluestacks'
              ? `未找到匹配专页 ${task.pageId} 的可用蓝蝶模拟器`
              : carrier === 'auto'
                ? `未找到专页 ${task.pageId} 对应的浏览器或蓝蝶模拟器`
                : `未找到当前专页为 ${task.pageId} 的在线/可唤醒浏览器`;
          await writeRow({ resourceCode, status: `失败：${msg}` }, !task.existingResourceCode);
          await safeAppendSheetLog(
            ctx,
            link.id,
            'warn',
            'schedule_no_browser',
            `[${resourceCode}] ${msg}`,
          );
        }
        continue;
      }

      let downloadedTempMediaPath: string | null = null;
      try {
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
          continue;
        }

        const pcTag = ((await ctx.repo.getImageHostConfig()).defaultMachineName || '本机')
          .trim()
          .slice(0, 16);
        const runningClaimText = `${matchedCarrier === 'bluestacks' ? '蓝蝶发布中' : '发布中'}(${pcTag}#${randomCodeSegment(4)})…`;
        if (!(await verifyScheduleClaim(ctx, link, task, resourceCode, runningClaimText, cols)))
          continue;

        let localFilePath: string | null = null;
        let mediaKind: 'none' | 'image' | 'video' = 'none';
        let permanentThumbnailUrl = task.existingThumbnailUrl;
        await ctx.repo.updateLinkRuntime(link.id, { activeJobText: `准备素材 · ${resourceCode}` });
        try {
          if (task.mediaSource && ctx.deps.automation) {
            const prep = await ctx.deps.automation.prepareMaterialMedia(task.mediaSource);
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
          await writeRow({ resourceCode, status: `素材准备失败：${m.slice(0, 60)}` });
          await safeAppendSheetLog(
            ctx,
            link.id,
            'error',
            'schedule_media_error',
            `[${resourceCode}] 素材准备失败：${m}`,
          );
          continue;
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
        await saveScheduleProgress(
          ctx,
          link.id,
          task,
          resourceCode,
          permanentThumbnailUrl,
          'running',
          task.prevTimelinePosted,
          [...task.prevPostedGroupIds],
          groupTargetCount,
          null,
        );

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
        const recordCarrier = matchedCarrier === 'bluestacks' ? 'bluestacks' : 'browser';

        const handleStatus = (text: string) => {
          updateActiveProfileStatus(ctx, executorId, activeLink.id, text);
          void ignoreError(
            ctx.repo.updateLinkRuntime(activeLink.id, {
              activeJobText: `[${resourceCode}] ${text}`,
            }),
          );
        };

        const handlePosted = async (log: PosterLog, isTimeline: boolean) => {
          totalPublishedPosts++;
          if (isTimeline) timelinePosted = true;
          else postedGroupIds.push(log.groupId);
          const postCode = generatePostCode(resourceCode);
          await saveScheduleProgress(
            ctx,
            activeLink.id,
            task,
            resourceCode,
            permanentThumbnailUrl,
            'running',
            timelinePosted,
            postedGroupIds,
            groupTargetCount,
            null,
          );
          const safeUrl = isDirectFacebookPostUrl(log.postUrl) ? log.postUrl.trim() : '';
          const safeId = safeUrl ? log.postId || extractFacebookPostIdFromUrl(safeUrl) : '';
          void ignoreError(
            ctx.deps.postBumpRecords?.insert({
              recordType: 'post',
              carrier: recordCarrier,
              status: 'success',
              profileId: executorId,
              accountId: log.accountId ?? '',
              accountName: executorAccountName,
              groupId: isTimeline ? '' : log.groupId,
              groupName: isTimeline ? '专页时间线' : log.groupName,
              pageId: task.pageId,
              pageName,
              postId: safeId ?? log.postId ?? '',
              postUrl: safeUrl,
              captionPreview: formatPosterCaptionPreview(task.caption),
              createdAt: log.postedAt,
            }),
          );
          const recLinkId = activeLink.scheduleConfig?.targetRecordLinkId ?? null;
          if (recLinkId) {
            await appendPostToRecordsSheet(
              ctx,
              recLinkId,
              {
                postedAtMs: log.postedAt,
                groupId: isTimeline ? '-' : log.groupId,
                groupName: isTimeline ? '专页时间线' : log.groupName,
                pageId: task.pageId,
                pageName,
                postUrl: safeUrl,
                postId: safeUrl ? log.postId || extractFacebookPostIdFromUrl(safeUrl) : null,
                postCode,
                resourceCode,
                thumbnailUrl: permanentThumbnailUrl,
              },
              recordHeadersCache,
            ).catch(
              (err) =>
                void safeAppendSheetLog(
                  ctx,
                  activeLink.id,
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
        if (matchedCarrier === 'bluestacks' && ctx.deps.bluestacks) {
          const bsAbort = new AbortController();
          ctx.activeBluestacksAborts.set(executorId, bsAbort);
          try {
            result = await ctx.deps.bluestacks.runDirectPosterForSheet({
              instanceId: executorId,
              targetPageId: task.pageId,
              targetPageName: pageName,
              material,
              targets: targetList,
              closeOnFinish: activeLink.scheduleConfig?.closeBluestacksOnFinish !== false,
              signal: bsAbort.signal,
              onStatus: handleStatus,
              onPosted: handlePosted,
            });
          } finally {
            ctx.activeBluestacksAborts.delete(executorId);
          }
        } else if (ctx.deps.automation) {
          result = await ctx.deps.automation.publishScheduledMaterial({
            profileId: executorId,
            material,
            targets: targetList,
            cancelled: () =>
              ctx.cancelledLinks.has(activeLink.id) || ctx.cancelledProfiles.has(executorId),
            onStatus: handleStatus,
            onPosted: handlePosted,
          });
        } else result = { postedCount: 0, timelinePosted: false, error: '发帖执行器未就绪' };

        executedCount++;
        const allOk =
          (!task.postTimeline || timelinePosted) &&
          postedGroupIds.length >= groupTargetCount &&
          !result.error;
        const finalStatus = allOk
          ? 'completed'
          : timelinePosted || postedGroupIds.length > 0
            ? 'partial'
            : 'failed';
        const finalLabel =
          finalStatus === 'completed'
            ? '已完成'
            : finalStatus === 'partial'
              ? `部分完成(${task.postTimeline ? (timelinePosted ? '时间线已发·' : '时间线未发·') : ''}小组${postedGroupIds.length}/${groupTargetCount}${result.error ? `·${result.error.slice(0, 26)}` : ''})`
              : `失败：${(result.error ?? '未发布成功').slice(0, 48)}`;
        if (finalStatus === 'failed') {
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
              errorReason: (result.error ?? '未发布成功').slice(0, 120),
            }),
          );
        }
        await saveScheduleProgress(
          ctx,
          link.id,
          task,
          resourceCode,
          permanentThumbnailUrl,
          finalStatus,
          timelinePosted,
          postedGroupIds,
          groupTargetCount,
          result.error ?? null,
        );
        await writeRow({
          resourceCode,
          status: finalLabel,
          postedGroupsCount: `${postedGroupIds.length}/${groupTargetCount}`,
        });
        await safeAppendSheetLog(
          ctx,
          link.id,
          finalStatus === 'failed' ? 'error' : 'info',
          'schedule_publish_done',
          `${matchedCarrier === 'bluestacks' ? '[蓝蝶] ' : ''}[${resourceCode}] ${finalLabel}（时间线：${timelinePosted ? '已发' : '未发'}，小组：${postedGroupIds.length}/${groupTargetCount}）`,
        );
      } finally {
        if (downloadedTempMediaPath && ctx.deps.automation?.cleanupPreparedMedia)
          await ctx.deps.automation.cleanupPreparedMedia(downloadedTempMediaPath).catch(() => {});
        releaseProfile(ctx, executorId, link.id);
        if (wokeChromeFromOffline && matchedCarrier === 'browser' && ctx.deps.profileLifecycle)
          await ctx.deps.profileLifecycle.closeProfile(executorId).catch(() => {});
      }
    }

    const summary = `本轮处理 ${executedCount} 条排贴任务，成功发布 ${totalPublishedPosts} 篇贴文`;
    await ctx.repo.updateLinkRuntime(link.id, {
      lastSyncedAt: ctx.nowFn(),
      lastSyncSummary: summary,
      activeJobText: '',
      lastError: null,
      nextPollAt: ctx.nowFn() + intervalMs,
    });
    return { summary };
  } catch (err) {
    await recordLinkPollFailure(
      ctx,
      link,
      ctx.nowFn() + intervalMs,
      'schedule_poll_error',
      '排贴表轮询异常',
      err,
    );
    throw err;
  } finally {
    ctx.runningScheduleLinks.delete(linkId);
    ctx.cancelledLinks.delete(linkId);
  }
}
