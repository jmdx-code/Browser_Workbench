import type { TaskRepository } from '../domain/tasks.js';
import type { WorkspaceBackupWriter, WorkspaceRestorePort } from '../domain/workspace-backup.js';
import { ProductError } from '../domain/workspace.js';
import { taskTimingEligibility } from '../domain/task-timing.js';
import {
  CreateWorkspaceBackup,
  WorkspaceBackupResult,
  RestoreWorkspaceBackup,
} from '../shared/workspace-backup.js';
export class WorkspaceBackupService {
  private busy = false;
  private restorePrepared = false;
  constructor(
    private readonly tasks: TaskRepository,
    private readonly writer: WorkspaceBackupWriter,
    private readonly restore?: WorkspaceRestorePort,
    private readonly active?: () => boolean,
  ) {}
  assertIdle() {
    if (this.restorePrepared)
      throw new ProductError(
        'RESTORE_RESTART_REQUIRED',
        '数据恢复已准备，请先重启软件再运行任务',
        409,
      );
    if (this.busy)
      throw new ProductError('BACKUP_IN_PROGRESS', '正在保存数据备份，请稍后启动任务', 409);
  }
  private async assertStopped() {
    if (
      this.active
        ? this.active()
        : (await this.tasks.livePlans()).some(
            (plan) =>
              ['RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state) ||
              (plan.state === 'QUEUED' &&
                (!plan.timing ||
                  plan.timingReleased ||
                  taskTimingEligibility(plan.timing, Date.now()) !== 'WAIT')) ||
              (plan.state === 'REVIEW' && !plan.controlConfirmed),
          )
    )
      throw new ProductError('BACKUP_TASKS_ACTIVE', '请先暂停或停止任务，确认停止后再备份', 409);
  }
  async status() {
    const defaultDirectory = this.writer.defaultDirectory?.() ?? '';
    try {
      this.assertIdle();
      await this.assertStopped();
      return { available: true, busy: false, canCreate: true, reason: '', defaultDirectory };
    } catch (error) {
      return {
        available: true,
        busy: this.busy,
        canCreate: false,
        reason: error instanceof Error ? error.message : '备份尚不可用',
        defaultDirectory,
      };
    }
  }
  async create(input: unknown) {
    const request = CreateWorkspaceBackup.parse(input);
    this.assertIdle();
    this.busy = true;
    try {
      await this.assertStopped();
      return WorkspaceBackupResult.parse(
        await this.writer.write(request.directory, async () => await this.assertStopped()),
      );
    } finally {
      this.busy = false;
    }
  }
  async inspectRestore(input: unknown) {
    if (!this.restore)
      throw new ProductError('RESTORE_UNAVAILABLE', '请在正式桌面软件中使用恢复', 409);
    return this.restore.inspect(RestoreWorkspaceBackup.parse(input).directory);
  }
  async restoreStatus() {
    const defaultDirectory = this.writer.defaultDirectory?.() ?? '';
    const current = await this.restore?.status();
    return current
      ? { ...current, defaultDirectory: current.defaultDirectory ?? defaultDirectory }
      : {
          available: false,
          state: 'NONE' as const,
          reason: '恢复服务未加载',
          safetyDirectory: '',
          defaultDirectory,
        };
  }
  async prepareRestore(input: unknown) {
    if (!this.restore)
      throw new ProductError('RESTORE_UNAVAILABLE', '请在正式桌面软件中使用恢复', 409);
    const request = RestoreWorkspaceBackup.parse(input);
    this.assertIdle();
    this.busy = true;
    try {
      await this.assertStopped();
      const result = await this.restore.prepare(
        request.directory,
        async () => await this.assertStopped(),
      );
      this.restorePrepared = result.state === 'READY';
      return result;
    } finally {
      this.busy = false;
    }
  }
}
