import type { Awaitable } from './persistence.js';
import type { Plan } from '../shared/task-contracts.js';
export function taskBlocksSoftwareUpdate(state: Plan['state'], online: boolean, hasOwner: boolean) {
  return state === 'RUNNING' || (['PAUSING', 'STOPPING'].includes(state) && (online || hasOwner));
}
import type {
  UpdateConfiguration,
  UpdateRelease,
  ReloadResult,
} from '../shared/software-update.js';
export interface SoftwareUpdatePort {
  readConfig(): Promise<UpdateConfiguration>;
  saveConfig(config: UpdateConfiguration): Promise<void>;
  check(repo: string): Promise<UpdateRelease | null>;
  install(release: UpdateRelease, guard: () => Promise<void>): Promise<void>;
  assertCanApply(): Promise<void>;
  restart(): void;
  reloadExtensions(ids?: string[]): Promise<ReloadResult>;
  openExtensionDirectory(): Awaitable<void>;
}
