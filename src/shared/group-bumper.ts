import { z } from 'zod';
import { Id } from './contracts.js';
import { extractFacebookGroupId, extractFacebookPageId } from './facebook-target-id.js';
import { GroupIdString, GroupNameString, AVATAR_URL_MAX_LENGTH } from './group-inviter.js';
export { AVATAR_URL_MAX_LENGTH };

export const BumperReactionType = z.enum(['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry']);
export type BumperReactionType = z.infer<typeof BumperReactionType>;

export const BumperSettings = z
  .object({
    searchMode: z.enum(['time_sort', 'page_group_feed', 'random_browse']).default('time_sort'),
    maxPostAgeHours: z.number().int().min(1).max(720).default(24),
    maxPostsPerGroupPage: z.number().int().min(1).max(50).default(5),
    maxPostsPerPage: z.number().int().min(1).max(50).default(3),
    maxConcurrentProfiles: z.number().int().min(1).max(50).default(8),
    dailyMaxLikesPerAccount: z.number().int().min(1).max(500).default(20),
    maxLikesPerPost: z.number().int().min(1).max(500).default(50),
    likeProbability: z.number().int().min(0).max(100).default(100),
    commentProbability: z.number().int().min(0).max(100).default(30),
    consumeCommentOnUse: z.boolean().default(false),
    enableSound: z.boolean().default(false),
    useLongPressReaction: z.boolean().default(false),
    reactionTypes: z.array(BumperReactionType).min(1).max(7).default(['care', 'love', 'like']),
  })
  .strict();
export type BumperSettings = Omit<
  z.infer<typeof BumperSettings>,
  'enableSound' | 'useLongPressReaction' | 'reactionTypes'
> & {
  enableSound?: boolean;
  useLongPressReaction?: boolean;
  reactionTypes?: BumperReactionType[];
};
export const BumperTarget = z.object({
  id: GroupIdString,
  name: GroupNameString,
  avatarUrl: z.string().nullable(),
  folderId: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
  totalBumpedCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type BumperTarget = z.infer<typeof BumperTarget>;

export const MAX_LOCAL_AVATAR_BYTES = 131_072; // 128KB

export function isCompleteNumericId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^\d+$/.test(id.trim());
}

export function isPlaceholderTargetName(
  name: string | null | undefined,
  id: string | null | undefined,
): boolean {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedId = typeof id === 'string' ? id.trim() : '';
  return (
    !trimmedName ||
    trimmedName === trimmedId ||
    trimmedName === `Group ${trimmedId}` ||
    trimmedName === `小组 ${trimmedId}`
  );
}

export function isLocalAvatar(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOCAL_AVATAR_BYTES) return false;
  return /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]{32,}$/i.test(trimmed);
}

export function isTargetIncomplete(item: {
  id: string;
  name: string;
  avatarUrl?: string | null;
}): boolean {
  return (
    !isCompleteNumericId(item.id) ||
    isPlaceholderTargetName(item.name, item.id) ||
    !isLocalAvatar(item.avatarUrl)
  );
}

export interface BumperRefreshResult {
  updated: number;
  needsBrowser: number;
  failed: number;
  error?: string;
}
export const BumperTargetsInput = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.preprocess(
              (v) =>
                typeof v === 'string' ? extractFacebookGroupId(v) || extractFacebookPageId(v) : v,
              GroupIdString,
            ),
            name: z.string().trim().max(200, '名字过长').optional().default(''),
            folderId: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const BumperGroupTargetsInput = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.preprocess(
              (v) => (typeof v === 'string' ? extractFacebookGroupId(v) : v),
              GroupIdString,
            ),
            name: z.string().trim().max(200, '名字过长').optional().default(''),
            folderId: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const BumperPageTargetsInput = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.preprocess(
              (v) => (typeof v === 'string' ? extractFacebookPageId(v) : v),
              GroupIdString,
            ),
            name: z.string().trim().max(200, '名字过长').optional().default(''),
            folderId: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const BumperIdsInput = z.object({ ids: z.array(GroupIdString).min(1).max(500) }).strict();
export const BumperScope = z.enum(['group', 'page']);
export type BumperScope = z.infer<typeof BumperScope>;

export const BumperCommentsInput = z
  .object({
    texts: z.array(z.string().trim().min(1).max(8000)).max(5000),
    consumeCommentOnUse: z.boolean(),
    scope: BumperScope.optional(),
    baseComments: z
      .array(z.object({ id: z.uuid(), text: z.string().trim().min(1).max(8000) }).strict())
      .max(5000)
      .optional(),
  })
  .strict();
export interface BumperComment {
  id: string;
  text: string;
  usedCount: number;
  createdAt: number;
  scope?: BumperScope;
}
export interface BumperLog {
  id: string;
  profileId: string;
  accountId: string;
  groupId: string;
  groupName: string;
  pageId: string;
  pageName: string;
  postId: string;
  postUrl: string;
  liked: boolean;
  commentText: string | null;
  bumpedAt: number;
  sourceMode?: BumperScope;
}
export const StartBumper = z
  .object({
    profileIds: z.array(Id).min(1).max(500),
    groupIds: z.array(GroupIdString).min(1).max(500),
    pageIds: z.array(GroupIdString).min(1).max(500),
  })
  .strict();
export const StartPageBumper = z
  .object({
    profileIds: z.array(Id).min(1).max(500),
    pageIds: z.array(GroupIdString).min(1).max(500),
  })
  .strict();

export const BumperTaskStatus = z.enum([
  'scheduled',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type BumperTaskStatus = z.infer<typeof BumperTaskStatus>;

export const BumperScheduledTask = z.strictObject({
  id: Id,
  mode: z.enum(['group-bumper', 'page-bumper']),
  profileIds: z.array(Id).min(1).max(500),
  groupIds: z.array(GroupIdString).max(500),
  pageIds: z.array(GroupIdString).min(1).max(500),
  scheduledAt: z.number().int().positive(),
  status: BumperTaskStatus,
  statusReason: z.string().max(400).default(''),
  runId: z.string().max(120).nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable().default(null),
  finishedAt: z.number().int().nonnegative().nullable().default(null),
});
export type BumperScheduledTask = z.infer<typeof BumperScheduledTask>;

export const CreateBumperTaskInput = z.strictObject({
  mode: z.enum(['group-bumper', 'page-bumper']).default('group-bumper'),
  profileIds: z.array(Id).min(1).max(500),
  groupIds: z.array(GroupIdString).max(500).default([]),
  pageIds: z.array(GroupIdString).min(1).max(500),
  scheduledAt: z.number().int().positive(),
});
export type CreateBumperTaskInput = z.infer<typeof CreateBumperTaskInput>;
export interface BumperProfileStat {
  today: number;
  session: number;
  status: string;
  running: boolean;
}
export interface BumperDailyStat {
  date: string; // yyyy-mm-dd（本地时区日期）
  count: number;
}
export interface BumperPendingOperation {
  id: string;
  profileId: string;
  accountId: string;
  groupId: string;
  groupName: string;
  pageId: string;
  pageName: string;
  postId: string;
  actionKind: 'like' | 'comment';
  reason: string;
  updatedAt: number;
}
export interface BumperState {
  groups: BumperTarget[];
  pages: BumperTarget[];
  settings: BumperSettings;
  pageSettings?: BumperSettings;
  comments: BumperComment[];
  pageComments?: BumperComment[];
  total: number;
  pageTotal?: number;
  running: boolean;
  statusText: string;
  profileCounts: Record<string, BumperProfileStat>;
  dailyStats?: BumperDailyStat[];
  pageDailyStats?: BumperDailyStat[];
  pageBumperRunning?: boolean;
  pageBumperStatusText?: string;
  pageBumperProfileCounts?: Record<string, BumperProfileStat>;
  metadataRefreshing?: boolean;
  groupAvatarRefreshing?: boolean;
  pageAvatarRefreshing?: boolean;
  pendingReviewOperations?: BumperPendingOperation[];
  scheduledTasks?: BumperScheduledTask[];
}

export function extractBumperPageId(raw: string): string {
  return extractFacebookPageId(raw);
}
