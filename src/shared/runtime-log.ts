import { z } from 'zod';
import { NonNegInt, PosInt, intRange, sReq, strictObj } from './contracts.js';
export const MaintenanceSettings = strictObj({
  version: z.literal(1),
  revision: NonNegInt,
  logRetentionDays: intRange(1, 90),
});
export const UpdateMaintenanceSettings = strictObj({
  expectedRevision: NonNegInt,
  logRetentionDays: MaintenanceSettings.shape.logRetentionDays,
});
export const RuntimeLogRecord = strictObj({
  version: z.literal(1),
  observedAt: z.iso.datetime(),
  event: z.enum(['SOFTWARE_STARTED', 'SOFTWARE_STOPPED', 'TASK_FAILED', 'TASK_COMPLETED']),
  sequence: PosInt.optional(),
}).refine((value) => value.event.startsWith('TASK_') === (value.sequence !== undefined));
export const RuntimeLogExport = strictObj({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  records: z.array(RuntimeLogRecord).max(1000),
  truncated: z.boolean(),
});
export const MaintenanceOverview = strictObj({
  settings: MaintenanceSettings,
  locations: strictObj({ logDirectory: sReq(4096), cacheDirectory: sReq(4096) }),
  logStatus: z.enum(['ready', 'busy', 'unavailable', 'capacity-reached']),
});
export type MaintenanceConfiguration = z.infer<typeof MaintenanceSettings>;
export type MaintenanceUpdate = z.infer<typeof UpdateMaintenanceSettings>;
export type LogRecord = z.infer<typeof RuntimeLogRecord>;
export interface RuntimeLogPort {
  status(): z.infer<typeof MaintenanceOverview>['logStatus'];
  append(records: LogRecord[], retentionDays: number): Promise<void>;
  export(): Promise<z.infer<typeof RuntimeLogExport>>;
}
