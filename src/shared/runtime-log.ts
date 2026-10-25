import { z } from 'zod';

export const MaintenanceSettings = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    logRetentionDays: z.number().int().min(1).max(90),
  })
  .strict();
export const UpdateMaintenanceSettings = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe(),
    logRetentionDays: MaintenanceSettings.shape.logRetentionDays,
  })
  .strict();
export const RuntimeLogRecord = z
  .object({
    version: z.literal(1),
    observedAt: z.iso.datetime(),
    event: z.enum(['SOFTWARE_STARTED', 'SOFTWARE_STOPPED', 'TASK_FAILED', 'TASK_COMPLETED']),
    sequence: z.number().int().positive().safe().optional(),
  })
  .strict()
  .refine((value) => value.event.startsWith('TASK_') === (value.sequence !== undefined));
export const RuntimeLogExport = z
  .object({
    version: z.literal(1),
    generatedAt: z.iso.datetime(),
    records: z.array(RuntimeLogRecord).max(1000),
    truncated: z.boolean(),
  })
  .strict();
export const MaintenanceOverview = z
  .object({
    settings: MaintenanceSettings,
    locations: z
      .object({
        logDirectory: z.string().min(1).max(4096),
        cacheDirectory: z.string().min(1).max(4096),
      })
      .strict(),
    logStatus: z.enum(['ready', 'busy', 'unavailable', 'capacity-reached']),
  })
  .strict();
export type MaintenanceConfiguration = z.infer<typeof MaintenanceSettings>;
export type MaintenanceUpdate = z.infer<typeof UpdateMaintenanceSettings>;
export type LogRecord = z.infer<typeof RuntimeLogRecord>;
export interface RuntimeLogPort {
  status(): z.infer<typeof MaintenanceOverview>['logStatus'];
  append(records: LogRecord[], retentionDays: number): Promise<void>;
  export(): Promise<z.infer<typeof RuntimeLogExport>>;
}
