import { z } from 'zod';
import {
  Id,
  NonNegInt,
  NumNull,
  StrNull,
  boolF,
  boolT,
  intRange,
  optBool,
  sMax,
  sReq,
  strictObj,
  trimMax,
  trimReq,
} from './contracts.js';
import { extractFacebookGroupId } from './facebook-target-id.js';
export const GroupIdString = trimReq(120)
  .min(1, '请输入小组ID')
  .max(120, '小组ID过长')
  .regex(/^[A-Za-z0-9._-]+$/, '小组ID仅支持数字、字母、点、下划线或连字符');
export const GroupNameString = trimReq(200).min(1, '请输入小组名字').max(200, '小组名字过长');
export const AVATAR_URL_MAX_LENGTH = 131_072; // 128KB
const inviterOptFields = {
  invitesPerGroup: intRange(1, 200).optional(),
  maxConcurrentProfiles: intRange(1, 50).optional(),
  playSoundOnComplete: optBool,
  closeBrowserOnFinish: optBool,
};
export const InviterGroupRow = strictObj({
  groupId: GroupIdString,
  groupName: GroupNameString,
  avatarUrl: sMax(AVATAR_URL_MAX_LENGTH).nullable(),
  folderId: StrNull.default(null),
  sortOrder: z.number().int().default(0),
  totalInvitedCount: NonNegInt,
  createdAt: NonNegInt,
  updatedAt: NonNegInt,
});
export type InviterGroupRow = z.infer<typeof InviterGroupRow>;
export const GroupInviteLogRow = strictObj({
  id: Id,
  profileId: Id,
  accountId: trimReq(120),
  friendId: trimReq(200),
  friendName: trimMax(200),
  groupId: GroupIdString,
  invitedAt: NonNegInt,
});
export type GroupInviteLogRow = z.infer<typeof GroupInviteLogRow>;
export const InviterRecordSchema = strictObj({
  id: Id,
  carrier: z.enum(['browser', 'bluestacks']),
  profileId: Id,
  windowName: sMax(200),
  accountId: trimMax(120),
  accountName: sMax(200),
  accountAvatarUrl: sMax(300),
  groupId: GroupIdString,
  groupName: sMax(200),
  groupAvatarUrl: sMax(300),
  friendId: trimReq(200),
  friendName: trimMax(200),
  confirmation: z.enum(['CONFIRMED', 'PENDING']),
  invitedAt: NonNegInt,
});
export type InviterRecord = z.infer<typeof InviterRecordSchema>;
export const InviterRecordsQuerySchema = strictObj({
  carrier: z.enum(['all', 'browser', 'bluestacks']).default('all'),
  confirmation: z.enum(['all', 'CONFIRMED', 'PENDING']).default('CONFIRMED'),
  accountQuery: sMax(200).default(''),
  groupQuery: sMax(200).default(''),
  friendQuery: sMax(200).default(''),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  limit: intRange(1, 1000).default(200),
  offset: NonNegInt.default(0),
});
export type InviterRecordsQuery = z.input<typeof InviterRecordsQuerySchema>;
export const InviterRecordsResponseSchema = strictObj({
  records: z.array(InviterRecordSchema),
  total: NonNegInt,
  hasMore: z.boolean(),
});
export type InviterRecordsResponse = z.infer<typeof InviterRecordsResponseSchema>;
export const DeleteInviterRecordsInputSchema = strictObj({
  ids: z.array(Id).max(1000).optional(),
  clearAll: z.boolean().optional(),
});
export const GroupInviterProfileStat = strictObj({
  sessionInvited: NonNegInt,
  totalInvited: NonNegInt,
  status: sMax(120).optional(),
  running: optBool,
});
export type GroupInviterProfileStat = z.infer<typeof GroupInviterProfileStat>;
export const InviterGroupOutcome = strictObj({
  profileId: sReq(120),
  profileName: sMax(200),
  groupId: GroupIdString,
  groupName: sMax(200),
  status: z.enum(['invited', 'skipped', 'failed']),
  invitedCount: NonNegInt,
  skippedCount: NonNegInt,
  reason: sMax(300),
});
export type InviterGroupOutcome = z.infer<typeof InviterGroupOutcome>;
export const InviterRunSummarySchema = strictObj({
  runId: sReq(120),
  invitedTotal: NonNegInt,
  pendingTotal: NonNegInt,
  failedProfiles: z.array(sReq(120)),
  finishedAt: NonNegInt,
  groupResults: z.array(InviterGroupOutcome),
});
export const GroupInviterState = strictObj({
  groups: z.array(InviterGroupRow),
  invitesPerGroup: intRange(1, 200),
  maxConcurrentProfiles: inviterOptFields.maxConcurrentProfiles,
  playSoundOnComplete: inviterOptFields.playSoundOnComplete,
  closeBrowserOnFinish: inviterOptFields.closeBrowserOnFinish,
  running: z.boolean(),
  groupAvatarRefreshing: optBool,
  avatarRefreshStatusText: sMax(500).optional(),
  runId: StrNull,
  startedAt: NumNull,
  finishedAt: NumNull,
  statusText: sMax(500),
  profileCounts: z.record(z.string(), GroupInviterProfileStat),
  lastRunSummary: InviterRunSummarySchema.optional(),
});
export type GroupInviterState = z.infer<typeof GroupInviterState>;
export const AddInviterGroupsRequest = strictObj({
  items: z
    .array(
      strictObj({
        groupId: z.preprocess(
          (v) => (typeof v === 'string' ? extractFacebookGroupId(v) : v),
          GroupIdString,
        ),
        groupName: trimMax(200).max(200, '小组名字过长').optional().default(''),
        folderId: StrNull.optional(),
      }),
    )
    .min(1, '请至少填写一行小组数据')
    .max(500, '单次最多添加 500 个小组'),
});
export type AddInviterGroupsRequest = z.infer<typeof AddInviterGroupsRequest>;
export const DeleteInviterGroupsRequest = strictObj({
  groupIds: z.array(GroupIdString).min(1, '请先勾选要删除的小组').max(500),
});
export type DeleteInviterGroupsRequest = z.infer<typeof DeleteInviterGroupsRequest>;
export const GroupInviterSettings = strictObj({
  invitesPerGroup: intRange(1, 200).default(20),
  maxConcurrentProfiles: intRange(1, 50).default(4),
  playSoundOnComplete: boolT,
  closeBrowserOnFinish: boolF,
});
export type GroupInviterSettings = Omit<
  z.infer<typeof GroupInviterSettings>,
  'closeBrowserOnFinish'
> & { closeBrowserOnFinish?: boolean };
export const UpdateGroupInviterSettingsRequest = strictObj(inviterOptFields);
export type UpdateGroupInviterSettingsRequest = z.infer<typeof UpdateGroupInviterSettingsRequest>;
export const StartGroupInviterRequest = strictObj({
  profileIds: z.array(Id).min(1, '请在左侧勾选至少一个账号').max(200),
  groupIds: z.array(GroupIdString).min(1, '请在表格中勾选至少一个小组').max(500),
  ...inviterOptFields,
});
export type StartGroupInviterRequest = z.infer<typeof StartGroupInviterRequest>;
export const StopGroupInviterProfilesRequest = strictObj({
  profileIds: z.array(Id).min(1, '请选择要停止的浏览器').max(200),
});
export type StopGroupInviterProfilesRequest = z.infer<typeof StopGroupInviterProfilesRequest>;
export function extractGroupId(raw: string): string {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) && !/(?:facebook\.com|fb\.com)/i.test(trimmed)
    ? trimmed
    : extractFacebookGroupId(raw);
}
