import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Core, Peer } from '../bridge/core.js';
import type { RecordRow } from '../bridge/store.js';
import type { TaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import { ORIGIN } from '../shared/browser-actions.js';
import type { BrowserWindowPort } from '../shared/browser-window.js';
import type { TabProof } from '../shared/kernel-state.js';

// Local window management reuses the original bridge journal. It never executes a FB task.
export class BridgeBrowserWindow implements BrowserWindowPort {
  private readonly active = new Set<string>();
  constructor(
    private readonly core: Core,
    private readonly tasks: Pick<TaskRepository, 'list'> &
      Partial<Pick<TaskRepository, 'hasProfilePlanInStates'>>,
    private readonly revealMain?: (
      profileId: string,
    ) => Promise<{ profileId: string; tabId: number; focused: true } | null>,
    private readonly consolidateTabs?: (
      profileId: string,
      preferActiveTab?: boolean,
    ) => Promise<{
      profileId: string;
      proof: TabProof;
      url: string;
      closedTabIds: number[];
      remainingTabCount: number;
    }>,
    private readonly inviterBusy: (profileId: string) => boolean = () => false,
  ) {}

  async consolidate(profileId: string, preferActiveTab = true) {
    if (this.active.has(profileId))
      throw new ProductError('BROWSER_CLEANUP_PENDING', '正在整理这份浏览器标签，请稍候', 409);
    const peer = this.core.peers.get(profileId);
    if (!peer?.online)
      throw new ProductError('BROWSER_OFFLINE', '这份浏览器未连接，请先手动打开', 409);
    if (peer.phase !== 'PAUSED' || !peer.synced)
      throw new ProductError('BROWSER_BUSY', '浏览器正在执行或对账，请稍后再整理标签', 409);
    if (this.inviterBusy(profileId))
      throw new ProductError('BROWSER_TASK_ACTIVE', '小组邀请正在执行，请稍后再清理标签', 409);
    if (!this.consolidateTabs)
      throw new ProductError('WORKSPACE_CLEANUP_UNAVAILABLE', '当前服务未启用非主标签清理', 409);
    this.active.add(profileId);
    try {
      await this.assertIdle(profileId, true);
      if (this.inviterBusy(profileId))
        throw new ProductError('BROWSER_TASK_ACTIVE', '小组邀请正在执行，请稍后再清理标签', 409);
      return await this.consolidateTabs(profileId, preferActiveTab);
    } finally {
      this.active.delete(profileId);
    }
  }

  async cleanupTabs(profileIds: string[], preferActiveTab = false) {
    const result = { cleanedProfiles: 0, closedTabs: 0, skippedBusy: 0, skippedOffline: 0 };
    for (const id of new Set(profileIds)) {
      if (!this.core.peers.get(id)?.online) {
        result.skippedOffline++;
        continue;
      }
      try {
        const cleaned = await this.consolidate(id, preferActiveTab);
        if (cleaned.remainingTabCount !== 1) throw Error('WORKSPACE_CLEANUP_TABS_UNCONFIRMED');
        result.cleanedProfiles++;
        result.closedTabs += cleaned.closedTabIds.length;
      } catch (error) {
        const code =
          error instanceof ProductError ? error.code : error instanceof Error ? error.message : '';
        if (
          [
            'BROWSER_BUSY',
            'BROWSER_TASK_ACTIVE',
            'BROWSER_CLEANUP_PENDING',
            'WORKSPACE_CLEANUP_CHANNEL_BUSY',
            'WORKSPACE_CLEANUP_OPERATION_PENDING',
            'KERNEL_PROFILE_NOT_IDLE',
          ].includes(code)
        )
          result.skippedBusy++;
        else if (code === 'BROWSER_OFFLINE') result.skippedOffline++;
        else throw error;
      }
    }
    return result;
  }

  async show(profileId: string, alias: string) {
    if (this.active.has(profileId))
      throw new ProductError('BROWSER_SHOW_PENDING', '正在显示这份浏览器，请稍候', 409);
    const peer = this.core.peers.get(profileId);
    if (!peer?.online)
      throw new ProductError('BROWSER_OFFLINE', '这份浏览器未连接，请先手动打开', 409);
    if (peer.phase !== 'PAUSED' || !peer.synced)
      throw new ProductError('BROWSER_BUSY', '浏览器正在执行或对账，请稍后再显示', 409);
    if (
      this.tasks.hasProfilePlanInStates
        ? await this.tasks.hasProfilePlanInStates(profileId, ['PAUSING', 'STOPPING'])
        : (await this.tasks.list()).some(
            (plan) => plan.profileId === profileId && ['PAUSING', 'STOPPING'].includes(plan.state),
          )
    )
      throw new ProductError('BROWSER_BUSY', '正在停止控制，请稍后再显示', 409);
    if (this.revealMain) {
      this.active.add(profileId);
      try {
        const main = await this.revealMain(profileId);
        if (main) return main;
      } finally {
        this.active.delete(profileId);
      }
    }
    await this.assertIdle(profileId);
    this.active.add(profileId);
    let resumed = false;
    let failure: unknown;
    let tabId: number | undefined;
    try {
      await this.core.resume(profileId);
      resumed = true;
      await this.wait(peer, 'RUNNING');
      await this.assertIdle(profileId);
      const url = new URL('/fixture', ORIGIN);
      url.searchParams.set('identify', '1');
      url.searchParams.set('alias', alias);
      url.searchParams.set('profileId', profileId);
      const created = await this.core.run({
        profileId,
        operationId: randomUUID(),
        action: { kind: 'createTaskTab', url: url.href },
      });
      const evidence = this.evidence(
        created,
        z.object({ tabId: z.number().int().positive(), url: z.string() }),
      );
      tabId = evidence.tabId;
      const windowOnly = peer.capabilities?.includes('local-window-status-v1') === true;
      const loadedDeadline = Date.now() + 10000;
      while (true) {
        await this.assertIdle(profileId);
        const observed = await this.core.run({
          profileId,
          operationId: randomUUID(),
          action: { kind: windowOnly ? 'readTabState' : 'observe', tabId },
        });
        if (observed.status === 'VERIFIED') {
          if (
            windowOnly &&
            this.evidence(observed, z.object({ status: z.enum(['loading', 'complete']) }))
              .status === 'loading'
          ) {
            if (Date.now() >= loadedDeadline) throw Error('BROWSER_PAGE_UNCONFIRMED');
            await delay(150);
            continue;
          }
          this.evidence(observed, z.object({ url: z.literal(evidence.url) }));
          break;
        }
        const rejected = observed.result
          ? z.object({ error: z.string() }).safeParse(JSON.parse(observed.result))
          : undefined;
        if (
          rejected?.success !== true ||
          rejected.data.error !== 'TAB_SCOPE_CHANGED' ||
          Date.now() >= loadedDeadline
        )
          throw Error('BROWSER_PAGE_UNCONFIRMED');
        // Only repeat the read while the newly created local page loads; never repeat creation.
        await delay(150);
      }
      await this.assertIdle(profileId);
      // This action existed before 0.3.21, unlike activateTab. Creation already requests focus.
      const window = await this.core.run({
        profileId,
        operationId: randomUUID(),
        action: { kind: 'windowState', tabId, state: 'normal' },
      });
      this.evidence(
        window,
        z.object({ state: z.literal('normal'), focused: z.literal(true), active: z.literal(true) }),
      );
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (resumed && this.core.peers.get(profileId) === peer && peer.online) {
          await this.core.stop(profileId);
          await this.wait(peer, 'PAUSED');
        }
      } catch (error) {
        failure ??= error;
      }
      this.active.delete(profileId);
    }
    if (failure || !tabId) {
      if (failure instanceof ProductError) throw failure;
      throw new ProductError(
        'BROWSER_SHOW_UNCONFIRMED',
        '未能确认浏览器已显示；请查看浏览器窗口和任务记录。没有自动重复打开。',
        409,
      );
    }
    return { profileId, tabId, focused: true as const };
  }
  private async assertIdle(profileId: string, allowPaused = false) {
    if (
      this.tasks.hasProfilePlanInStates
        ? await this.tasks.hasProfilePlanInStates(profileId, [
            'QUEUED',
            'RUNNING',
            'PAUSING',
            ...(allowPaused ? [] : ['PAUSED' as const]),
            'STOPPING',
            'REVIEW',
          ])
        : (await this.tasks.list()).some(
            (plan) =>
              plan.profileId === profileId &&
              !['COMPLETED', 'FAILED', 'STOPPED', ...(allowPaused ? ['PAUSED'] : [])].includes(
                plan.state,
              ),
          )
    )
      throw new ProductError(
        'BROWSER_TASK_ACTIVE',
        '请先停止这份浏览器的任务，再显示识别窗口',
        409,
      );
  }
  private async wait(peer: Peer, phase: Peer['phase']) {
    const deadline = Date.now() + 13000;
    while (
      this.core.peers.get(peer.profileId) === peer &&
      peer.online &&
      !peer.error &&
      Date.now() < deadline
    ) {
      if (peer.phase === phase) return;
      if (peer.phase === 'RECOVERING') break;
      await delay(25);
    }
    throw Error('BROWSER_CONTROL_UNCONFIRMED');
  }
  private evidence<T>(row: RecordRow, schema: z.ZodType<T>): T {
    if (row.status !== 'VERIFIED' || !row.result) throw Error('BROWSER_WINDOW_UNCONFIRMED');
    return z.object({ evidence: schema }).parse(JSON.parse(row.result)).evidence;
  }
}
