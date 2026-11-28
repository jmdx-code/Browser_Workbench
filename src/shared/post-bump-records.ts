import { z } from 'zod';
import { NonNegInt, intRange, sMax, strictObj } from './contracts.js';
import { isPendingApprovalPostId } from './group-poster.js';
export { isPendingApprovalPostId };
const PostBumpRecordType = z.enum(['post', 'group_bump', 'page_bump']);
export const PostBumpRecordQueryType = z.enum([
  'all',
  'post',
  'bump_all',
  'group_bump',
  'page_bump',
]);
const PostBumpCarrier = z.enum(['browser', 'bluestacks']);
const PostBumpStatus = z.enum(['success', 'failed']);
export type PostBumpRecordQueryTypeValue = z.infer<typeof PostBumpRecordQueryType>;
export type PostBumpCarrierValue = z.infer<typeof PostBumpCarrier>;
export type PostBumpStatusValue = z.infer<typeof PostBumpStatus>;
const reqStr = z.string().min(1),
  str = z.string(),
  intNum = z.number().int(),
  strFields = [
    'accountId',
    'accountName',
    'groupId',
    'groupName',
    'pageId',
    'pageName',
    'postId',
    'postUrl',
    'captionPreview',
    'errorReason',
  ] as const;
const makeStrShape = <V extends z.ZodTypeAny>(v: V) =>
  Object.fromEntries(strFields.map((k) => [k, v])) as Record<(typeof strFields)[number], V>;
export const PostBumpRecordSchema = strictObj({
  id: reqStr,
  recordType: PostBumpRecordType,
  carrier: PostBumpCarrier,
  status: PostBumpStatus,
  profileId: reqStr,
  ...makeStrShape(str),
  windowName: str.default(''),
  accountAvatarUrl: str.default(''),
  pageAvatarUrl: str.default(''),
  groupAvatarUrl: str.default(''),
  liked: z.boolean(),
  commentText: str.nullable(),
  storyShared: z.boolean(),
  sourceLogId: str.nullable(),
  createdAt: intNum,
});
export type PostBumpRecord = z.infer<typeof PostBumpRecordSchema>;
export const InsertPostBumpRecordInputSchema = strictObj({
  id: reqStr.optional(),
  recordType: PostBumpRecordType,
  carrier: PostBumpCarrier,
  status: PostBumpStatus.default('success'),
  profileId: reqStr,
  ...makeStrShape(str.default('')),
  liked: z.boolean().default(false),
  commentText: str.nullable().default(null),
  storyShared: z.boolean().default(false),
  sourceLogId: str.nullable().default(null),
  createdAt: intNum.optional(),
});
export type InsertPostBumpRecordInput = z.input<typeof InsertPostBumpRecordInputSchema>;
export const PostBumpRecordQuerySchema = strictObj({
  recordType: PostBumpRecordQueryType.default('all'),
  carrier: z.enum(['all', 'browser', 'bluestacks']).default('all'),
  status: z.enum(['all', 'success', 'failed']).default('all'),
  search: sMax(200).default(''),
  accountQuery: sMax(200).default(''),
  groupQuery: sMax(200).default(''),
  pageQuery: sMax(200).default(''),
  postUrlQuery: sMax(200).default(''),
  from: intNum.optional(),
  to: intNum.optional(),
  limit: intRange(1, 1000).default(200),
  offset: NonNegInt.default(0),
});
export type PostBumpRecordQuery = z.input<typeof PostBumpRecordQuerySchema>;
const PostBumpStatusCountsSchema = strictObj({
  total: NonNegInt,
  confirmed: NonNegInt,
  pending: NonNegInt,
  failed: NonNegInt,
});
export const PostBumpRecordsResponseSchema = strictObj({
  records: z.array(PostBumpRecordSchema),
  total: NonNegInt,
  hasMore: z.boolean(),
  statusCounts: PostBumpStatusCountsSchema.optional(),
});
export type PostBumpRecordsResponse = z.infer<typeof PostBumpRecordsResponseSchema>;
export interface TodayStatsSummary {
  dateKey: string;
  posts: number;
  groupBumps: number;
  pageBumps: number;
  bumps: number;
  invites: number;
  failures: number;
}
export interface PostBumpRecordsPort {
  insert(input: InsertPostBumpRecordInput): Promise<PostBumpRecord> | PostBumpRecord;
  list(query?: PostBumpRecordQuery): Promise<PostBumpRecordsResponse> | PostBumpRecordsResponse;
  deleteByIds(ids: readonly string[]): Promise<{ deleted: number }> | { deleted: number };
  clear(
    recordType?: PostBumpRecordQueryTypeValue,
  ): Promise<{ deleted: number }> | { deleted: number };
  todayStats(nowMs?: number): Promise<TodayStatsSummary> | TodayStatsSummary;
}
export function formatPostBumpRecordSummary(record: PostBumpRecord): string {
  if (record.status === 'failed') {
    const base = record.errorReason.trim() || '执行失败';
    return record.captionPreview.trim()
      ? `失败：${base}（${record.captionPreview.trim()}）`
      : `失败：${base}`;
  }
  if (record.recordType === 'post') {
    const caption = record.captionPreview.trim();
    const tag = isPendingApprovalPostId(record.postId) ? '已发帖（待审核）' : '发帖成功';
    return caption ? `${tag} · ${caption}` : tag;
  }
  const actions: string[] = [];
  if (record.liked) actions.push('点赞');
  if (record.commentText?.trim()) actions.push(`评论: ${record.commentText.trim()}`);
  if (record.storyShared) actions.push('分享快拍');
  return actions.length > 0 ? actions.join(' + ') : '顶贴完成';
}
