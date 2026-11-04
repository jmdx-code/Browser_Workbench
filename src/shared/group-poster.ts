import { z } from 'zod';
import { Id } from './contracts.js';
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
  materialId?: string | undefined;
  postId?: string | undefined;
  postUrl?: string | undefined;
  logId?: string | undefined;
  resolution?: PosterOperationResolution | undefined;
  status: PosterOperationStatus;
  kernelSettled: boolean;
  reviewReason?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export const PosterSettings = z
  .object({
    maxConcurrentProfiles: z.number().int().min(1).max(50).default(4),
    maxPostsPerAccount: z.number().int().min(1).max(200).default(10),
    materialsPerGroup: z.number().int().min(1).max(50).default(1),
  })
  .strict();
export type PosterSettings = z.infer<typeof PosterSettings>;

export const PosterMediaKind = z.enum(['none', 'image', 'video']);
export type PosterMediaKind = z.infer<typeof PosterMediaKind>;

export const PosterCacheStatus = z.enum(['ready', 'downloading', 'expired', 'error']);
export type PosterCacheStatus = z.infer<typeof PosterCacheStatus>;

export const PosterMaterialBackground = z.enum(['color', 'plain']);
export type PosterMaterialBackground = z.infer<typeof PosterMaterialBackground>;

export const POSTER_COLOR_BACKGROUND_MAX_CHARS = 120;

export function hasPosterMaterialContent(input: { caption: string; mediaSource: string }): boolean {
  return Boolean(input.caption.trim() || input.mediaSource.trim());
}

export function canPosterMaterialUseColorBackground(input: {
  caption: string;
  mediaSource: string;
  background?: PosterMaterialBackground | undefined;
}): boolean {
  if ((input.background ?? 'plain') !== 'color') return false;
  if (input.mediaSource.trim().length > 0) return false;
  const trimmed = input.caption.trim();
  if (!trimmed) return false;
  return (
    [...trimmed].length <= POSTER_COLOR_BACKGROUND_MAX_CHARS && trimmed.split(/\r?\n/).length <= 4
  );
}

export const PosterMaterialInput = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    caption: z.string().trim().max(20000, '贴文内容过长').optional().default(''),
    mediaSource: z.string().trim().max(2000).optional().default(''),
    background: PosterMaterialBackground.optional().default('plain'),
    selected: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.caption.trim() && !val.mediaSource.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: '请至少填写贴文文案或媒体链接/本地路径',
      });
    }
  });
export type PosterMaterialInput = z.infer<typeof PosterMaterialInput>;

export const PosterMaterialsInput = z
  .object({
    items: z.array(PosterMaterialInput).max(500),
    replaceAll: z.boolean().optional(),
  })
  .strict();
export type PosterMaterialsInput = z.infer<typeof PosterMaterialsInput>;

export const PosterMaterialIdsInput = z
  .object({
    ids: z.array(z.string().trim().min(1).max(120)).min(1).max(500),
  })
  .strict();

export const PosterToggleMaterialsInput = z
  .object({
    ids: z.array(z.string().trim().min(1).max(120)).min(1).max(500),
    selected: z.boolean(),
  })
  .strict();

export interface PosterMaterial {
  id: string;
  caption: string;
  mediaSource: string;
  background: PosterMaterialBackground;
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

export const StartPosterInput = z
  .object({
    profileIds: z.array(Id).min(1).max(500),
    groupIds: z.array(GroupIdString).min(1).max(500),
    materialIds: z.array(z.string().trim().min(1).max(120)).min(1).max(500),
  })
  .strict();
export type StartPosterInput = z.infer<typeof StartPosterInput>;

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
}

export const DEFAULT_POSTER_TEST_MATERIAL = {
  caption:
    'ဒီစာကို မြင်တွေ့ရသူဟာ တကယ် မင်္ဂလာရှိပါတယ်။\n"အာမင်" လို့ ရေးခဲ့သူတိုင်း၊ ဘဝကို ပြောင်းလဲစေမယ့် အံ့ဩဝမ်းသာစရာကို ရရှိပါလိမ့်မယ်။\nသခင်ယေရှုကို ယုံကြည်ကိုးစားတာ လက်မလျှော့ခဲ့တဲ့အတွက်၊ သင့်ရဲ့ ဝန်ထုပ်ဝန်ပိုးအားလုံးကို ကိုယ်တော် ယူဆောင်သွားပါလိမ့်မယ်။\nဒီကောင်းချီးကို လက်ခံချင်တယ်ဆိုရင်၊ လူတစ်ယောက်ဆီ ဝေမျှပေးပြီး သခင်ဘုရားကို ကျေးဇူးတင်လိုက်ပါ။',
  mediaSource:
    'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view?usp=drive_link',
} as const;
