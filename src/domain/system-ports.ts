import { DateTime } from 'luxon';
import type { Awaitable } from './persistence.js';
import type { BackupResult, RestoreInspection, RestoreStatus } from '../shared/workspace-backup.js';
import type { Plan } from '../shared/task-contracts.js';
import type {
  UpdateConfiguration,
  UpdateRelease,
  ReloadResult,
} from '../shared/software-update.js';
import type { Timing } from '../shared/task-timing.js';
import type { Profile } from '../shared/contracts.js';
import type { PageProjection } from '../shared/page-read.js';
import type { NativeFacebookActor } from '../shared/facebook-native-identity.js';
export type NativeStopReceipt = { requestId: string; state: 'stopped' };
export interface SessionClosePort {
  closeLocal(): Promise<void>;
  retryCloseLocal?(): Promise<void>;
  assertTransport(): Awaitable<void>;
  stopRemote(requestId: string): Promise<NativeStopReceipt>;
  release(): Awaitable<void>;
}
export interface WorkspaceBackupWriter {
  defaultDirectory?(): string;
  write(
    directory: string,
    guard: () => Awaitable<void>,
    options?: { redactSecrets?: boolean | undefined },
  ): Promise<BackupResult>;
}
export interface WorkspaceRestorePort {
  inspect(directory: string): Promise<RestoreInspection>;
  prepare(directory: string, guard: () => Awaitable<void>): Promise<RestoreStatus>;
  status(): Promise<RestoreStatus>;
}
export const taskBlocksSoftwareUpdate = (
  state: Plan['state'],
  _online: boolean,
  _hasOwner: boolean,
) => state === 'RUNNING';
export interface SoftwareUpdatePort {
  readConfig(): Promise<UpdateConfiguration>;
  saveConfig(config: UpdateConfiguration): Promise<void>;
  check(repo: string): Promise<UpdateRelease | null>;
  install(release: UpdateRelease, guard: () => Promise<void>): Promise<void>;
  assertCanApply(): Promise<void>;
  restart(): void;
  reloadExtensions(ids?: string[]): Promise<ReloadResult>;
  openExtensionDirectory(): Awaitable<void>;
  openAiWorkspaceDirectory?(): Awaitable<{ directory: string }>;
}
export function taskTimingEligibility(
  timing: Timing | undefined,
  now: number,
  alreadyStarted = false,
): 'OPEN' | 'WAIT' | 'MISSED' {
  if (!timing) return 'OPEN';
  if (timing.mode === 'at') {
    if (now < timing.startAt) return 'WAIT';
    return !alreadyStarted && now - timing.startAt > 60_000 ? 'MISSED' : 'OPEN';
  }
  const local = DateTime.fromMillis(now, { zone: timing.timeZone });
  if (!local.isValid) throw Error('SCHEDULE_TIME_ZONE_INVALID');
  const [startHour = 0, startMinute = 0] = timing.startTime.split(':').map(Number),
    [endHour = 0, endMinute = 0] = timing.endTime.split(':').map(Number);
  let day = local.startOf('day');
  const overnight = timing.startTime > timing.endTime;
  if (overnight && local.hour * 60 + local.minute < endHour * 60 + endMinute)
    day = day.minus({ days: 1 });
  if (!timing.weekdays.includes(day.weekday)) return 'WAIT';
  const start = day.set({ hour: startHour, minute: startMinute }),
    end = (overnight ? day.plus({ days: 1 }) : day).set({ hour: endHour, minute: endMinute });
  return now >= start.toMillis() && now < end.toMillis() ? 'OPEN' : 'WAIT';
}
export interface InspectionConnection {
  profileId: string;
  connectionEpoch: string;
}
export interface ProfileInspectionPort {
  connection(profileId: string): InspectionConnection | null;
  assertIdle(connection: InspectionConnection): Promise<void>;
  read(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
  ): Promise<PageProjection>;
  readDisplay?(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
  ): Promise<{ page: PageProjection; actor: NativeFacebookActor | null }>;
}
export type InspectedAccount = Profile['account'];
