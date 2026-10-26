import { z } from 'zod';
export const RecordCleanupScope = z
  .object({
    stepIds: z.array(z.uuid()).min(1).max(1000).optional(),
    before: z.number().int().nonnegative().safe().optional(),
    keepLatestRuns: z.number().int().min(0).max(100000).optional(),
    profileId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (v) => (v.stepIds !== undefined) !== (v.before !== undefined || v.keepLatestRuns !== undefined),
    '请选择记录、截止日期或保留条数',
  );
export const CleanupSelection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('records'), scope: RecordCleanupScope }).strict(),
  z
    .object({ kind: z.literal('logs'), before: z.number().int().nonnegative().safe().optional() })
    .strict(),
]);
export const CleanupPreview = z
  .object({
    token: z.uuid(),
    kind: z.enum(['records', 'logs']),
    eligible: z.number().int().nonnegative(),
    protected: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    expiresAt: z.number(),
  })
  .strict();
export const ExecuteCleanup = z.object({ token: z.uuid(), confirm: z.literal(true) }).strict();
export const CleanupResult = z
  .object({
    deleted: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    protected: z.number().int().nonnegative(),
  })
  .strict();
export const CleanupSettings = z
  .object({
    revision: z.number().int().nonnegative(),
    historyRetentionDays: z.number().int().min(1).max(3650).nullable(),
    historyMaxCount: z.number().int().min(1).max(100000).nullable().optional(),
    automaticLogs: z.boolean(),
    logRetentionDays: z.number().int().min(1).max(90),
  })
  .strict();
export const SaveCleanupSettings = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    historyRetentionDays: CleanupSettings.shape.historyRetentionDays,
    historyMaxCount: CleanupSettings.shape.historyMaxCount,
    automaticLogs: z.boolean().default(false),
  })
  .strict();
export const ResetWorkspace = z
  .object({ confirmation: z.literal('确认重置'), acknowledgeUnknownResults: z.literal(true) })
  .strict();
export type RecordCleanup = z.infer<typeof RecordCleanupScope>;
export type CleanupConfiguration = z.infer<typeof CleanupSettings>;
