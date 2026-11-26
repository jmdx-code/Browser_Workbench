import { z } from 'zod';
import {
  FbDigits,
  Id,
  StepSchema,
  addIssue,
  browseFields,
  feedDetourFields,
  intRange,
  optBool,
  priceField,
  sMax,
  strictObj,
  trimMax,
} from './contracts.js';
import { TaskPlan } from './task-contracts.js';
const TEST_MODULE_ROWS = [
  [
    'feed',
    '浏览首页',
    '进入首页、滚动内容，可顺路点开他人时间线或专页，按有效浏览时间结束。',
    'feed',
  ],
  [
    'explore_pages',
    '逛时间线 / 专页',
    '随机点开别人时间线/专页浏览，或按指定专页列表搜索并浏览其时间线。',
    'feed',
  ],
  ['video', '浏览 Reels', '播放和切换 Reels，缓冲及暂停不计时。', 'video'],
  ['marketplace', '浏览商城', '浏览商品列表、打开详情并返回；可选关键词和价格。', 'marketplace'],
  ['friends', '接受好友请求', '进入好友请求页面，按指定数量或全部确认通过好友请求。', 'friends'],
  ['add_friends', '加推荐好友', '进入推荐好友页面，按指定数量发送加好友请求。', 'friends'],
  ['post', '发布帖子', '文字、单图、多图、视频；在组合中配置资源后运行。', 'post'],
  ['story', '发布快拍', '好友范围的文字、单图或视频快拍；在组合中配置资源后运行。', null],
] as const;
export const taskTestModules = TEST_MODULE_ROWS.map(([id, name, detail, type]) => ({
  id,
  name,
  detail,
  type,
}));
export const TEST_COMBINATION_NOTE = '单项测试工作台：';
export const TaskTestRequest = strictObj({
  requestId: Id,
  profileIds: z.array(Id).min(1).max(1000),
  module: z.enum(['feed', 'explore_pages', 'video', 'marketplace', 'friends', 'add_friends']),
  ...browseFields,
  ...feedDetourFields,
  durationMinutes: browseFields.durationMinutes.default(15),
  maxLikes: browseFields.maxLikes.default(0),
  minLikeCount: browseFields.minLikeCount.default(0),
  acceptMode: z.enum(['count', 'all']).default('count'),
  maxAccepts: intRange(1, 500).default(2),
  keyword: trimMax(120).default(''),
  categoryId: FbDigits.optional(),
  minPrice: priceField,
  maxPrice: priceField,
  closeBrowserOnFinish: optBool,
}).superRefine((value, ctx) => {
  if (
    value.module !== 'marketplace' &&
    (value.keyword ||
      value.categoryId !== undefined ||
      value.minPrice !== undefined ||
      value.maxPrice !== undefined)
  )
    addIssue(ctx, '商城筛选不能用于其他任务');
  const parsed = StepSchema.safeParse(taskTestStep(value, '00000000-0000-4000-8000-000000000001'));
  if (!parsed.success)
    for (const issue of parsed.error.issues) addIssue(ctx, issue.message, issue.path);
});
export type TestRequest = z.infer<typeof TaskTestRequest>;
const pickDefined = <T extends Record<string, unknown>>(obj: T, keys: readonly (keyof T)[]) =>
  Object.fromEntries(keys.flatMap((k) => (obj[k] !== undefined ? [[k, obj[k]]] : [])));
export function taskTestStep(value: Omit<TestRequest, 'requestId' | 'profileIds'>, id: string) {
  const isFeedLike = value.module === 'feed' || value.module === 'explore_pages',
    zero = 0 as const,
    keepLikes = isFeedLike || value.module === 'video',
    common = {
      id,
      durationMinutes: value.durationMinutes,
      maxLikes: keepLikes ? (value.maxLikes ?? 0) : zero,
      minLikeCount: keepLikes ? (value.minLikeCount ?? 0) : zero,
    };
  if (value.module === 'friends' || value.module === 'add_friends') {
    const isAdd = value.module === 'add_friends';
    return {
      ...common,
      type: 'friends' as const,
      ...(isAdd ? { friendAction: 'add_suggested' as const } : {}),
      acceptMode: isAdd ? ('count' as const) : (value.acceptMode ?? ('count' as const)),
      maxAccepts: value.maxAccepts ?? (isAdd ? 3 : 2),
    };
  }
  if (value.module === 'marketplace')
    return {
      ...common,
      type: 'marketplace' as const,
      keyword: value.keyword,
      ...(value.categoryId ? { categoryId: value.categoryId } : {}),
      ...pickDefined(value, ['minPrice', 'maxPrice']),
    };
  const sharedBrowse = {
    ...pickDefined(value, ['likeProbability', 'skipSponsored']),
    ...(value.includeKeywords ? { includeKeywords: value.includeKeywords } : {}),
    ...(value.excludeKeywords ? { excludeKeywords: value.excludeKeywords } : {}),
  };
  if (value.module === 'explore_pages')
    return {
      ...common,
      type: 'feed' as const,
      feedMode:
        value.feedMode && value.feedMode !== 'home' ? value.feedMode : ('random_profile' as const),
      ...pickDefined(value, ['detourDwellSeconds']),
      ...(value.targetPages?.length ? { targetPages: value.targetPages } : {}),
      ...sharedBrowse,
    };
  const pChance = value.randomProfileVisitChance ?? 0,
    gChance = value.randomPageVisitChance ?? 0;
  return {
    ...common,
    type: value.module,
    ...(value.module === 'feed'
      ? {
          ...(value.feedMode && value.feedMode !== 'home' ? { feedMode: value.feedMode } : {}),
          ...(pChance > 0 ? { randomProfileVisitChance: pChance } : {}),
          ...(gChance > 0 ? { randomPageVisitChance: gChance } : {}),
          ...(value.detourDwellSeconds !== undefined && (pChance > 0 || gChance > 0)
            ? { detourDwellSeconds: value.detourDwellSeconds }
            : {}),
        }
      : {}),
    ...sharedBrowse,
  };
}
export const TaskTestResult = strictObj({
  plans: z.array(TaskPlan),
  rejected: z.array(strictObj({ profileId: Id, reason: sMax(300) })),
});
