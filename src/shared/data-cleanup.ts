import { z } from 'zod';
export const RecordCleanupScope = z
  .object({
    stepIds: z.array(z.uuid()).min(1).max(1000).optional(),
    before: z.number().int().nonnegative().safe().optional(),
    profileId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => (v.stepIds !== undefined) !== (v.before !== undefined), '请选择记录或截止日期');
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
    automaticLogs: z.boolean(),
    logRetentionDays: z.number().int().min(1).max(90),
  })
  .strict();
export const SaveCleanupSettings = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    historyRetentionDays: CleanupSettings.shape.historyRetentionDays,
    automaticLogs: z.boolean().default(false),
  })
  .strict();
export const ResetWorkspace = z
  .object({ confirmation: z.literal('确认重置'), acknowledgeUnknownResults: z.literal(true) })
  .strict();
export type RecordCleanup = z.infer<typeof RecordCleanupScope>;
export type CleanupConfiguration = z.infer<typeof CleanupSettings>;
