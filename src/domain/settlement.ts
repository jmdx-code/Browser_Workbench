import type { Awaitable } from './persistence.js';
import type { Notice, NoticeReceipt, Resolution } from '../shared/settlement.js';
import type { Binding } from '../shared/task-execution.js';
export interface SettlementRepository {
  list(profileId?: string): Awaitable<Notice[]>;
  claim(profileId: string): Awaitable<Notice | null>;
  delivered(operationId: string, claimToken: string, receipt: NoticeReceipt): Awaitable<void>;
  retry(operationId: string, claimToken: string, reason: string): Awaitable<void>;
  recoverOnStartup(): Awaitable<void>;
}
// This port has no input, script, navigation, upload, or tab-management methods.
export interface SettlementPort {
  profileId: string;
  notify(binding: Binding, resolution: Resolution): Promise<NoticeReceipt>;
}
