import type { Core } from '../bridge/core.js';
import type { TaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
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

  async show(profileId: string, _alias: string) {
    const peer = this.core.peers.get(profileId);
    if (!peer?.online)
      throw new ProductError('BROWSER_OFFLINE', '这份浏览器未连接，请先手动打开', 409);
    if (this.revealMain) {
      const result = await this.revealMain(profileId);
      if (result) return result;
    }
    return this.core.revealBrowserWindow(profileId);
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
}
