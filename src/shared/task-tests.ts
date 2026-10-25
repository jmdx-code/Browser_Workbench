import { z } from 'zod';
import { Id, StepSchema } from './contracts.js';
import { TaskPlan } from './task-contracts.js';

// A module contributes its descriptor and builds a normal step. Execution remains in the
// existing task runner; this catalogue grants neither arbitrary scripts nor extra permissions.
export const taskTestModules = [
  {
    id: 'feed',
    name: '浏览首页',
    detail: '进入首页、滚动内容，按有效浏览时间结束。',
    type: 'feed',
  },
  {
    id: 'video',
    name: '浏览 Reels',
    detail: '播放和切换 Reels，缓冲及暂停不计时。',
    type: 'video',
  },
  {
    id: 'marketplace',
    name: '浏览商城',
    detail: '浏览商品列表、打开详情并返回；可选关键词和价格。',
    type: 'marketplace',
  },
  {
    id: 'friends',
    name: '接受好友请求',
    detail: '进入好友请求页面，按指定数量或全部确认通过好友请求。',
    type: 'friends',
  },
  {
    id: 'post',
    name: '发布帖子',
    detail: '文字、单图、多图、视频；在组合中配置资源后运行。',
    type: 'post',
  },
  {
    id: 'story',
    name: '发布快拍',
    detail: '好友范围的文字、单图或视频快拍；在组合中配置资源后运行。',
    type: null,
  },
] as const;
export const TEST_COMBINATION_NOTE = '单项测试工作台：';
export const TaskTestRequest = z
  .object({
    requestId: Id,
    profileIds: z.array(Id).min(1).max(1000),
    module: z.enum(['feed', 'video', 'marketplace', 'friends']),
    durationMinutes: z.number().int().min(1).max(240).default(15),
    maxLikes: z.number().int().min(0).max(100).default(0),
    minLikeCount: z.number().int().min(0).max(1_000_000_000).default(0),
    likeProbability: z.number().int().min(1).max(100).optional(),
    includeKeywords: z.string().trim().max(300).optional(),
    excludeKeywords: z.string().trim().max(300).optional(),
    skipSponsored: z.boolean().optional(),
    acceptMode: z.enum(['count', 'all']).default('count'),
    maxAccepts: z.number().int().min(1).max(500).default(2),
    keyword: z.string().trim().max(120).default(''),
    categoryId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
    minPrice: z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01).optional(),
    maxPrice: z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fields = ['categoryId', 'minPrice', 'maxPrice'] as const;
    if (
      value.module !== 'marketplace' &&
      (value.keyword || fields.some((key) => value[key] !== undefined))
    )
      ctx.addIssue({ code: 'custom', message: '商城筛选不能用于其他任务' });
    const parsed = StepSchema.safeParse(
      taskTestStep(value, '00000000-0000-4000-8000-000000000001'),
    );
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });
export type TestRequest = z.infer<typeof TaskTestRequest>;
export function taskTestStep(value: Omit<TestRequest, 'requestId' | 'profileIds'>, id: string) {
  const common = {
    id,
    type: value.module,
    durationMinutes: value.durationMinutes,
    maxLikes:
      value.module === 'feed' || value.module === 'video' ? (value.maxLikes ?? 0) : (0 as const),
    minLikeCount:
      value.module === 'feed' || value.module === 'video'
        ? (value.minLikeCount ?? 0)
        : (0 as const),
  };
  if (value.module === 'friends') {
    return {
      ...common,
      type: 'friends' as const,
      maxLikes: 0 as const,
      minLikeCount: 0 as const,
      acceptMode: value.acceptMode ?? ('count' as const),
      maxAccepts: value.maxAccepts ?? 2,
    };
  }
  if (value.module === 'marketplace') {
    return {
      ...common,
      type: 'marketplace' as const,
      maxLikes: 0 as const,
      minLikeCount: 0 as const,
      keyword: value.keyword,
      ...(value.categoryId ? { categoryId: value.categoryId } : {}),
      ...(value.minPrice !== undefined ? { minPrice: value.minPrice } : {}),
      ...(value.maxPrice !== undefined ? { maxPrice: value.maxPrice } : {}),
    };
  }
  return {
    ...common,
    type: value.module,
    ...(value.likeProbability !== undefined ? { likeProbability: value.likeProbability } : {}),
    ...(value.includeKeywords ? { includeKeywords: value.includeKeywords } : {}),
    ...(value.excludeKeywords ? { excludeKeywords: value.excludeKeywords } : {}),
    ...(value.skipSponsored !== undefined ? { skipSponsored: value.skipSponsored } : {}),
  };
}
export const TaskTestResult = z
  .object({
    plans: z.array(TaskPlan),
    rejected: z.array(z.object({ profileId: Id, reason: z.string().max(300) }).strict()),
  })
  .strict();
export type TestResult = z.infer<typeof TaskTestResult>;
