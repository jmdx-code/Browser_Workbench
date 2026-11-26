import { z } from 'zod';
import { Id, NonNegInt, intRange, strictObj } from './contracts.js';
const millionCount = intRange(1, 1000000),
  hundredKCount = intRange(1, 100000);
export const RecordCleanupScope = strictObj({
  stepIds: z.array(Id).min(1).max(1000).optional(),
  before: NonNegInt.safe().optional(),
  keepLatestRuns: intRange(0, 100000).optional(),
  profileId: Id.optional(),
}).refine(
  (v) => (v.stepIds !== undefined) !== (v.before !== undefined || v.keepLatestRuns !== undefined),
  '请选择记录、截止日期或保留条数',
);
export const CleanupSelection = z.discriminatedUnion('kind', [
  strictObj({ kind: z.literal('records'), scope: RecordCleanupScope }),
  strictObj({ kind: z.literal('logs'), before: NonNegInt.safe().optional() }),
]);
export const CleanupPreview = strictObj({
  token: Id,
  kind: z.enum(['records', 'logs']),
  eligible: NonNegInt,
  protected: NonNegInt,
  bytes: z.number().nonnegative(),
  expiresAt: z.number(),
});
export const ExecuteCleanup = strictObj({ token: Id, confirm: z.literal(true) });
export const CleanupResult = strictObj({
  deleted: NonNegInt,
  bytes: z.number().nonnegative(),
  protected: NonNegInt,
});
export const CleanupSettings = strictObj({
  revision: NonNegInt,
  historyRetentionDays: intRange(1, 3650).nullable(),
  historyMaxCount: hundredKCount.nullable().optional(),
  bumperMaxCount: millionCount.default(300000),
  posterMaxCount: millionCount.default(100000),
  detailMaxCount: hundredKCount.default(1000),
  automaticLogs: z.boolean(),
  logRetentionDays: intRange(1, 90),
});
export const SaveCleanupSettings = strictObj({
  expectedRevision: NonNegInt,
  historyRetentionDays: CleanupSettings.shape.historyRetentionDays,
  historyMaxCount: CleanupSettings.shape.historyMaxCount,
  bumperMaxCount: millionCount.optional(),
  posterMaxCount: millionCount.optional(),
  detailMaxCount: hundredKCount.optional(),
  automaticLogs: z.boolean().default(false),
});
export const ResetWorkspace = strictObj({
  confirmation: z.literal('确认重置'),
  acknowledgeUnknownResults: z.literal(true),
});
export type RecordCleanup = z.infer<typeof RecordCleanupScope>;
export type CleanupConfiguration = z.infer<typeof CleanupSettings>;
export const DetailBoundary = strictObj({ at: z.number().finite(), key: z.string() });
export type DetailBoundaryValue = z.infer<typeof DetailBoundary>;
/** A date input denotes the entire selected local calendar day. */
export const cleanupDateEnd = (date: string): number => new Date(date + 'T23:59:59.999').getTime();
