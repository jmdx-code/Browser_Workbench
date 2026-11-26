import { z } from 'zod';
import { Id, PosInt, addIssue, intRange, strictObj, trimMax, trimReq } from './contracts.js';
import { GroupIdString } from './group-inviter.js';
import type { BumperDailyStat, BumperTarget } from './group-bumper.js';
import type { Binding } from './task-execution.js';
export const PosterActionKind = z.enum([
  'setup_search_group',
  'setup_open_group',
  'setup_browse_group',
  'setup_join_group',
  'setup_dismiss_welcome',
  'setup_open_composer',
  'setup_fill_caption',
  'setup_fill_composer',
  'setup_upload_media',
  'setup_wait_media_ready',
  'submit_post',
]);
export type PosterActionKind = z.infer<typeof PosterActionKind>;
export const PosterOperationStatus = z.enum([
  'PREPARED',
  'VERIFIED',
  'NOT_APPLIED',
  'PENDING_REVIEW',
]);
export type PosterOperationStatus = z.infer<typeof PosterOperationStatus>;
export interface PosterOperationResolution {
  id: string;
  outcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN';
  evidenceDigest: string;
}
export interface PosterOperationRecord {
  binding: Binding;
  runId: string;
  actionKind: PosterActionKind;
  groupId: string;
  groupName: string;
  materialId?: string;
  postId?: string;
  postUrl?: string;
  logId?: string;
  resolution?: PosterOperationResolution;
  status: PosterOperationStatus;
  kernelSettled: boolean;
  reviewReason?: string;
  createdAt: number;
  updatedAt: number;
}
export const PosterSettings = strictObj({
  maxConcurrentProfiles: intRange(1, 50).default(4),
  maxPostsPerAccount: intRange(1, 200).default(10),
  materialsPerGroup: intRange(1, 50).default(1),
});
export type PosterSettings = z.infer<typeof PosterSettings>;
export const PosterMediaKind = z.enum(['none', 'image', 'video']);
export type PosterMediaKind = z.infer<typeof PosterMediaKind>;
export const PosterCacheStatus = z.enum(['ready', 'downloading', 'expired', 'error']);
export type PosterCacheStatus = z.infer<typeof PosterCacheStatus>;
export const PosterMaterialBackground = z.enum(['color', 'plain']);
export type PosterMaterialBackground = z.infer<typeof PosterMaterialBackground>;
export const PosterMaterialAiLabel = z.enum(['default', 'on', 'off']);
export type PosterMaterialAiLabel = z.infer<typeof PosterMaterialAiLabel>;
const POSTER_COLOR_BACKGROUND_MAX_CHARS = 120;
export const isPendingApprovalPostId = (postId: string | null | undefined): boolean =>
  Boolean(postId && (postId === 'pending_approval' || postId.startsWith('pending-')));
export function formatPosterCaptionPreview(
  caption: string | null | undefined,
  mediaSource?: string | null | undefined,
  mediaKind?: PosterMediaKind | null | undefined,
): string {
  const trimmed = (caption ?? '').trim();
  if (trimmed) return trimmed.slice(0, 120);
  if (mediaKind === 'video') return '[视频贴文]';
  if (mediaKind === 'image') return '[图片贴文]';
  const src = (mediaSource ?? '').trim();
  if (!src) return '[媒体贴文]';
  if (/^https?:\/\//i.test(src)) return '[网盘媒体贴文]';
  const baseName = src.split(/[\\/]/).at(-1)?.trim() ?? '';
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(baseName))
    return baseName ? `[视频] ${baseName}`.slice(0, 120) : '[视频贴文]';
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(baseName))
    return baseName ? `[图片] ${baseName}`.slice(0, 120) : '[图片贴文]';
  return '[媒体贴文]';
}
export const hasPosterMaterialContent = (input: {
  caption: string;
  mediaSource: string;
}): boolean => Boolean(input.caption.trim() || input.mediaSource.trim());
export function canPosterMaterialUseColorBackground(input: {
  caption: string;
  mediaSource: string;
  background?: PosterMaterialBackground | undefined;
}): boolean {
  if ((input.background ?? 'plain') !== 'color' || input.mediaSource.trim().length > 0)
    return false;
  const trimmed = input.caption.trim();
  return (
    Boolean(trimmed) &&
    [...trimmed].length <= POSTER_COLOR_BACKGROUND_MAX_CHARS &&
    trimmed.split(/\r?\n/).length <= 4
  );
}
const posterIdStr = trimReq(120);
export const PosterMaterialInput = strictObj({
  id: posterIdStr.optional(),
  caption: z.string().trim().max(20000, '贴文内容过长').optional().default(''),
  mediaSource: trimMax(2000).optional().default(''),
  background: PosterMaterialBackground.optional().default('plain'),
  aiLabel: PosterMaterialAiLabel.optional().default('default'),
  selected: z.boolean().optional().default(true),
}).superRefine((val, ctx) => {
  if (!hasPosterMaterialContent(val)) addIssue(ctx, '请至少填写贴文文案或媒体链接/本地路径', []);
});
export type PosterMaterialInput = z.infer<typeof PosterMaterialInput>;
export const PosterMaterialsInput = strictObj({
  items: z.array(PosterMaterialInput).max(500),
  replaceAll: z.boolean().optional(),
});
export type PosterMaterialsInput = z.infer<typeof PosterMaterialsInput>;
export const PosterMaterialIdsInput = strictObj({ ids: z.array(posterIdStr).min(1).max(500) });
export interface PosterMaterial {
  id: string;
  caption: string;
  mediaSource: string;
  background: PosterMaterialBackground;
  aiLabel?: PosterMaterialAiLabel | undefined;
  localFilePath: string | null;
  mediaKind: PosterMediaKind;
  cacheStatus: PosterCacheStatus;
  cacheError: string | null;
  selected: boolean;
  usedCount: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  hasThumbnail?: boolean;
}
export interface PosterLog {
  id: string;
  profileId: string;
  accountId: string;
  accountName: string;
  accountAvatar: string | null;
  identityType: 'page' | 'personal';
  groupId: string;
  groupName: string;
  groupAvatar: string | null;
  materialId: string;
  captionPreview: string;
  postId: string;
  postUrl: string;
  postedAt: number;
}
export const PosterTaskAccountMode = z.enum(['selected', 'all_online']);
export type PosterTaskAccountMode = z.infer<typeof PosterTaskAccountMode>;
export const PosterTaskStatus = z.enum([
  'scheduled',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);
export type PosterTaskStatus = z.infer<typeof PosterTaskStatus>;
export const CreatePosterTaskInput = strictObj({
  materialId: posterIdStr,
  groupIds: z.array(GroupIdString).min(1).max(500),
  accountMode: PosterTaskAccountMode.optional().default('selected'),
  profileIds: z.array(Id).max(500).optional().default([]),
  scheduledAt: PosInt.nullable().optional().default(null),
}).superRefine((val, ctx) => {
  if (val.accountMode === 'selected' && !val.profileIds.length)
    addIssue(ctx, '请至少选择 1 个发帖账号，或选择上方“全部在线账号”', []);
});
export type CreatePosterTaskInput = z.infer<typeof CreatePosterTaskInput>;
export const PosterTaskIdInput = strictObj({ id: posterIdStr });
export type PosterTaskIdInput = z.infer<typeof PosterTaskIdInput>;
export interface PosterTask {
  id: string;
  materialId: string;
  captionPreview: string;
  groupIds: string[];
  accountMode: PosterTaskAccountMode;
  profileIds: string[];
  scheduledAt: number | null;
  status: PosterTaskStatus;
  totalGroups: number;
  postedCount: number;
  skippedCount: number;
  statusReason: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface PosterActiveGroupItem {
  groupId: string;
  groupName: string;
  state: 'posting' | 'queued';
  profileId?: string | undefined;
  statusText?: string | undefined;
}
export interface PosterProfileStat {
  today: number;
  session: number;
  status: string;
  running: boolean;
  restricted?: boolean;
}
export interface PosterPendingOperation {
  id: string;
  profileId: string;
  accountId: string;
  groupId: string;
  groupName: string;
  materialId: string | null;
  reason: string | null;
  updatedAt: number;
}
export interface PosterState {
  groups: BumperTarget[];
  materials: PosterMaterial[];
  settings: PosterSettings;
  total: number;
  running: boolean;
  groupAvatarRefreshing?: boolean;
  statusText: string;
  profileCounts: Record<string, PosterProfileStat>;
  dailyStats: BumperDailyStat[];
  pendingReviewOperations?: PosterPendingOperation[];
  postedGroupIdsByMaterial?: Record<string, string[]>;
  activeGroupsByMaterial?: Record<string, PosterActiveGroupItem[]>;
  tasks?: PosterTask[];
}
