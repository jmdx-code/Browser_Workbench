import { z } from 'zod';
import {
  Id,
  NonNegInt,
  StrNull,
  intRange,
  optBool,
  strictObj,
  trimMax,
  trimReq,
} from './contracts.js';
import { extractFacebookGroupId, extractFacebookPageId } from './facebook-target-id.js';
import { AVATAR_URL_MAX_LENGTH, GroupIdString, GroupNameString } from './group-inviter.js';
import { stripAnsi } from './relative-post-age.js';
export { AVATAR_URL_MAX_LENGTH, stripAnsi };
export const BumperReactionType = z.enum(['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry']);
export type BumperReactionType = z.infer<typeof BumperReactionType>;
const max50 = intRange(1, 50),
  max500 = intRange(1, 500),
  pct = intRange(0, 100);
export const BumperSettings = strictObj({
  searchMode: z.enum(['time_sort', 'page_group_feed', 'random_browse']).default('time_sort'),
  maxPostAgeHours: intRange(1, 720).default(24),
  maxPostsPerGroupPage: max50.default(5),
  maxPostsPerPage: max50.default(3),
  maxConcurrentProfiles: max50.default(8),
  dailyMaxLikesPerAccount: max500.default(20),
  maxLikesPerPost: max500.default(50),
  likeProbability: pct.default(100),
  commentProbability: pct.default(30),
  shareToStoryProbability: pct.default(0),
  consumeCommentOnUse: z.boolean().default(false),
  enableSound: z.boolean().default(false),
  useLongPressReaction: z.boolean().default(false),
  reactionTypes: z.array(BumperReactionType).min(1).max(7).default(['care', 'love', 'like']),
  closeBrowserOnFinish: z.boolean().default(false),
});
export type BumperSettings = Omit<
  z.infer<typeof BumperSettings>,
  | 'shareToStoryProbability'
  | 'enableSound'
  | 'useLongPressReaction'
  | 'reactionTypes'
  | 'closeBrowserOnFinish'
> & {
  shareToStoryProbability?: number;
  enableSound?: boolean;
  useLongPressReaction?: boolean;
  reactionTypes?: BumperReactionType[];
};
export const BumperTarget = z.object({
  id: GroupIdString,
  name: GroupNameString,
  avatarUrl: StrNull,
  folderId: StrNull.default(null),
  sortOrder: z.number().int().default(0),
  totalBumpedCount: NonNegInt,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type BumperTarget = z.infer<typeof BumperTarget>;
export const MAX_LOCAL_AVATAR_BYTES = AVATAR_URL_MAX_LENGTH; // 128KB
export const isCompleteNumericId = (id: string | null | undefined): boolean =>
  typeof id === 'string' && /^\d+$/.test(id.trim());
export function isPlaceholderTargetName(
  name: string | null | undefined,
  id: string | null | undefined,
): boolean {
  const tn = typeof name === 'string' ? name.trim() : '',
    ti = typeof id === 'string' ? id.trim() : '';
  return !tn || tn === ti || tn === `Group ${ti}` || tn === `小组 ${ti}`;
}
export function isLocalAvatar(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_LOCAL_AVATAR_BYTES &&
    /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]{32,}$/i.test(trimmed)
  );
}
export const isTargetIncomplete = (item: {
  id: string;
  name: string;
  avatarUrl?: string | null;
}): boolean =>
  !isCompleteNumericId(item.id) ||
  isPlaceholderTargetName(item.name, item.id) ||
  !isLocalAvatar(item.avatarUrl);
export interface BumperRefreshResult {
  updated: number;
  needsBrowser: number;
  failed: number;
  error?: string;
}
const targetsInput = (extract: (raw: string) => string) =>
  strictObj({
    items: z
      .array(
        strictObj({
          id: z.preprocess((v) => (typeof v === 'string' ? extract(v) : v), GroupIdString),
          name: z.string().trim().max(200, '名字过长').optional().default(''),
          folderId: StrNull.optional(),
        }),
      )
      .min(1)
      .max(500),
  });
export const BumperTargetsInput = targetsInput(
  (v) => extractFacebookGroupId(v) || extractFacebookPageId(v),
);
export const BumperGroupTargetsInput = targetsInput(extractFacebookGroupId);
export const BumperPageTargetsInput = targetsInput(extractFacebookPageId);
export const BumperIdsInput = strictObj({ ids: z.array(GroupIdString).min(1).max(500) });
export const BumperScope = z.enum(['group', 'page']);
export type BumperScope = z.infer<typeof BumperScope>;
const commentStr = z.string().trim().min(1).max(8000);
export const BumperCommentsInput = strictObj({
  texts: z.array(commentStr).max(5000),
  consumeCommentOnUse: optBool,
  scope: BumperScope.optional(),
  baseComments: z
    .array(strictObj({ id: Id, text: commentStr }))
    .max(5000)
    .optional(),
});
export interface BumperComment {
  id: string;
  text: string;
  usedCount: number;
  createdAt: number;
  scope?: BumperScope;
}
interface BumperRecordBase {
  id: string;
  profileId: string;
  accountId: string;
  groupId: string;
  groupName: string;
  pageId: string;
  pageName: string;
  postId: string;
}
export interface BumperLog extends BumperRecordBase {
  postUrl: string;
  liked: boolean;
  commentText: string | null;
  storyShared?: boolean;
  bumpedAt: number;
  sourceMode?: BumperScope;
}
const profileList = z.array(Id).min(1).max(500),
  targetList = z.array(GroupIdString).min(1).max(500);
export const StartBumper = strictObj({
  profileIds: profileList,
  groupIds: targetList,
  pageIds: targetList,
  closeBrowserOnFinish: z.boolean().optional().default(false),
});
export const StartPageBumper = strictObj({
  profileIds: profileList,
  pageIds: targetList,
  closeBrowserOnFinish: z.boolean().optional().default(false),
});
export const PendingOperationResolution = z.enum(['not_applied', 'confirmed']);
export type PendingOperationResolution = z.infer<typeof PendingOperationResolution>;
export const ResolvePendingOperationInput = strictObj({
  operationId: trimReq(120),
  resolution: PendingOperationResolution,
  note: trimMax(500).optional(),
  reason: trimMax(500).optional(),
});
export type ResolvePendingOperationInput = z.infer<typeof ResolvePendingOperationInput>;
export interface BumperProfileStat {
  today: number;
  session: number;
  status: string;
  running: boolean;
}
export interface BumperPendingOperation extends BumperRecordBase {
  actionKind: 'like' | 'comment' | 'story_share';
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
  pageBumperRunning?: boolean;
  pageBumperStatusText?: string;
  pageBumperProfileCounts?: Record<string, BumperProfileStat>;
  metadataRefreshing?: boolean;
  groupAvatarRefreshing?: boolean;
  pageAvatarRefreshing?: boolean;
  pendingReviewOperations?: BumperPendingOperation[];
}
export const extractBumperPageId = (raw: string): string => extractFacebookPageId(raw);
