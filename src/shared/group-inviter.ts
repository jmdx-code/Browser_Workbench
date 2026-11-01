import { z } from 'zod';
import { Id } from './contracts.js';

export const GroupIdString = z
  .string()
  .trim()
  .min(1, '请输入小组ID')
  .max(120, '小组ID过长')
  .regex(/^[A-Za-z0-9._-]+$/, '小组ID仅支持数字、字母、点、下划线或连字符');

export const GroupNameString = z.string().trim().min(1, '请输入小组名字').max(200, '小组名字过长');

export const AVATAR_URL_MAX_LENGTH = 131_072; // 128KB

export const InviterGroupRow = z
  .object({
    groupId: GroupIdString,
    groupName: GroupNameString,
    avatarUrl: z.string().max(AVATAR_URL_MAX_LENGTH).nullable(),
    folderId: z.string().nullable().default(null),
    sortOrder: z.number().int().default(0),
    totalInvitedCount: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type InviterGroupRow = z.infer<typeof InviterGroupRow>;

export const GroupInviteLogRow = z
  .object({
    id: Id,
    profileId: Id,
    accountId: z.string().trim().min(1).max(120),
    friendId: z.string().trim().min(1).max(200),
    friendName: z.string().trim().max(200),
    groupId: GroupIdString,
    invitedAt: z.number().int().nonnegative(),
  })
  .strict();
export type GroupInviteLogRow = z.infer<typeof GroupInviteLogRow>;

export const GroupInviterProfileStat = z
  .object({
    sessionInvited: z.number().int().nonnegative(),
    totalInvited: z.number().int().nonnegative(),
    status: z.string().max(120).optional(),
  })
  .strict();
export type GroupInviterProfileStat = z.infer<typeof GroupInviterProfileStat>;

export const GroupInviterState = z
  .object({
    groups: z.array(InviterGroupRow),
    invitesPerGroup: z.number().int().min(1).max(200),
    running: z.boolean(),
    runId: z.string().nullable(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
    statusText: z.string().max(500),
    profileCounts: z.record(z.string(), GroupInviterProfileStat),
  })
  .strict();
export type GroupInviterState = z.infer<typeof GroupInviterState>;

export const AddInviterGroupsRequest = z
  .object({
    items: z
      .array(
        z
          .object({
            groupId: GroupIdString,
            groupName: z.string().trim().max(200, '小组名字过长').optional().default(''),
            folderId: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1, '请至少填写一行小组数据')
      .max(500, '单次最多添加 500 个小组'),
  })
  .strict();
export type AddInviterGroupsRequest = z.infer<typeof AddInviterGroupsRequest>;

export const DeleteInviterGroupsRequest = z
  .object({
    groupIds: z.array(GroupIdString).min(1, '请先勾选要删除的小组').max(500),
  })
  .strict();
export type DeleteInviterGroupsRequest = z.infer<typeof DeleteInviterGroupsRequest>;

export const UpdateGroupInviterSettingsRequest = z
  .object({
    invitesPerGroup: z.number().int().min(1).max(200),
  })
  .strict();
export type UpdateGroupInviterSettingsRequest = z.infer<typeof UpdateGroupInviterSettingsRequest>;

export const StartGroupInviterRequest = z
  .object({
    profileIds: z.array(Id).min(1, '请在左侧勾选至少一个账号').max(200),
    groupIds: z.array(GroupIdString).min(1, '请在表格中勾选至少一个小组').max(500),
    invitesPerGroup: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type StartGroupInviterRequest = z.infer<typeof StartGroupInviterRequest>;

export const StopGroupInviterProfilesRequest = z
  .object({
    profileIds: z.array(Id).min(1, '请选择要停止的浏览器').max(200),
  })
  .strict();
export type StopGroupInviterProfilesRequest = z.infer<typeof StopGroupInviterProfilesRequest>;

export function extractGroupId(raw: string): string {
  const value = raw.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    if (/(^|\.)facebook\.com$/i.test(url.hostname)) {
      const match = /^\/groups\/([^/?#]+)/i.exec(url.pathname);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
  } catch {
    /* Plain IDs stay unchanged. */
  }
  return value;
}
