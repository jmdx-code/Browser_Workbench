import type { Awaitable } from './persistence.js';
import type { BackupResult } from '../shared/workspace-backup.js';
export interface WorkspaceBackupWriter {
  defaultDirectory?(): string;
  write(directory: string, guard: () => Awaitable<void>): Promise<BackupResult>;
}
export interface WorkspaceRestorePort {
  inspect(directory: string): Promise<import('../shared/workspace-backup.js').RestoreInspection>;
  prepare(
    directory: string,
    guard: () => Awaitable<void>,
  ): Promise<import('../shared/workspace-backup.js').RestoreStatus>;
  status(): Promise<import('../shared/workspace-backup.js').RestoreStatus>;
}
