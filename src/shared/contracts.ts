import { z } from 'zod';
export const MAX_CONCURRENT_PROFILES = 100;
export const DEFAULT_CONCURRENT_PROFILES = MAX_CONCURRENT_PROFILES;
export const MAX_CONCURRENT_STARTUPS = 6;
export const MAX_CONCURRENT_UPLOAD_PREPARATIONS = MAX_CONCURRENT_PROFILES;
export const TASK_CAPACITY_HEADER = 'x-workbench-task-capacity';
export const TASK_CAPACITY_VERSION = '2';
export const Id = z.uuid();
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
export const FbDigits = z.string().regex(/^\d{1,30}$/);
export const NonNegInt = z.number().int().nonnegative();
export const PosInt = z.number().int().positive();
export const NonNegFinite = z.number().finite().nonnegative();
export const optBool = z.boolean().optional();
export const boolT = z.boolean().default(true);
export const boolF = z.boolean().default(false);
export const StrNull = z.string().nullable();
export const NumNull = z.number().nullable();
export const intRange = (min: number, max: number) => z.number().int().min(min).max(max);
export const sMax = (max: number) => z.string().max(max);
export const sReq = (max: number, min = 1) => z.string().min(min).max(max);
export const trimMax = (max: number) => z.string().trim().max(max);
export const trimReq = (max: number, min = 1) => z.string().trim().min(min).max(max);
export const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
export const strictObj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const addIssue = (ctx: z.RefinementCtx, message: string, path?: PropertyKey[]) => {
  const cleanPath = path?.filter((p): p is string | number => typeof p !== 'symbol');
  return ctx.addIssue(
    cleanPath ? { code: 'custom', message, path: cleanPath } : { code: 'custom', message },
  );
};
export const PostAILabelSetting = z.enum(['preserve-current', 'on', 'off']);
export type AILabelSetting = z.infer<typeof PostAILabelSetting>;
const optNonNegF = NonNegFinite.nullable();
export const ProfilePresentationStatus = strictObj({
  active: z.boolean(),
  checkedAt: NonNegFinite,
  visibility: z.enum(['hidden', 'visible']).nullable(),
  visibilityAt: optNonNegF,
  windowFocused: z.boolean().nullable(),
  lastRecoveryAt: optNonNegF,
  reportedFocused: z.boolean().nullable(),
  error: sMax(200).nullable(),
  recoveryAction: z.enum(['FOCUS', 'LAYOUT_MOVE']).nullable().optional(),
});
export type ProfilePresentationStatus = z.infer<typeof ProfilePresentationStatus>;
export const OperationDisposition = strictObj({
  id: Id,
  outcome: z.literal('ENDED_UNKNOWN'),
  evidenceDigest: Sha256Hex,
});
export const CurrentStopReceipt = strictObj({
  profileId: Id,
  connectionEpoch: Id,
  requestId: Id,
  state: z.literal('stopped'),
});
export type Disposition = z.infer<typeof OperationDisposition>;
export type CurrentStop = z.infer<typeof CurrentStopReceipt>;
const title = trimReq(80),
  zeroCap = { maxLikes: z.literal(0), minLikeCount: z.literal(0) };
export const browseFields = {
  durationMinutes: intRange(1, 240),
  maxLikes: intRange(0, 100),
  minLikeCount: intRange(0, 1_000_000_000),
  likeProbability: intRange(1, 100).optional(),
  includeKeywords: trimMax(300).optional(),
  excludeKeywords: trimMax(300).optional(),
  skipSponsored: optBool,
};
const FeedTargetPageSchema = strictObj({ id: trimMax(120).optional(), name: trimReq(200) });
export type FeedTargetPage = z.infer<typeof FeedTargetPageSchema>;
export const feedDetourFields = {
  feedMode: z.enum(['home', 'random_profile', 'random_page', 'search_pages']).optional(),
  randomProfileVisitChance: intRange(0, 100).optional(),
  randomPageVisitChance: intRange(0, 100).optional(),
  detourDwellSeconds: intRange(10, 120).optional(),
  targetPages: z.array(FeedTargetPageSchema).max(100).optional(),
};
export const priceField = z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01).optional();
const marketplaceFields = {
  durationMinutes: browseFields.durationMinutes,
  keyword: trimMax(120),
  categoryId: FbDigits.optional(),
  minPrice: priceField,
  maxPrice: priceField,
  ...zeroCap,
};
const friendsFields = {
  durationMinutes: intRange(1, 240).default(15),
  friendAction: z.enum(['accept', 'add_suggested']).optional(),
  acceptMode: z.enum(['count', 'all']),
  maxAccepts: intRange(1, 500),
  ...zeroCap,
};
export const StepSchema = z.discriminatedUnion('type', [
  strictObj({ id: Id, type: z.literal('video'), ...browseFields }),
  strictObj({ id: Id, type: z.literal('feed'), ...browseFields, ...feedDetourFields }).superRefine(
    (s, ctx) => {
      if (s.feedMode === 'search_pages' && !s.targetPages?.length)
        addIssue(ctx, '指定专页搜索模式至少需要选择或填写 1 个专页', ['targetPages']);
    },
  ),
  strictObj({ id: Id, type: z.literal('marketplace'), ...marketplaceFields }).superRefine(
    (s, ctx) => {
      if (s.minPrice !== undefined && s.maxPrice !== undefined && s.minPrice > s.maxPrice)
        addIssue(ctx, '最低价不能大于最高价', ['minPrice']);
      if ((s.minPrice !== undefined || s.maxPrice !== undefined) && !s.keyword && !s.categoryId)
        addIssue(ctx, '设置价格时请选择分类或填写关键词', ['keyword']);
    },
  ),
  strictObj({ id: Id, type: z.literal('friends'), ...friendsFields }).superRefine((s, ctx) => {
    if (s.friendAction === 'add_suggested') {
      if (s.acceptMode !== 'count')
        addIssue(ctx, '加推荐好友必须按指定人数上限执行', ['acceptMode']);
      if (s.maxAccepts > 100) addIssue(ctx, '单次加推荐好友人数上限不能超过 100', ['maxAccepts']);
    }
  }),
  strictObj({
    id: Id,
    type: z.literal('post'),
    destination: z.enum(['post', 'story']).optional(),
    audience: z.enum(['preserve-current', 'self', 'friends']).optional(),
    aiLabel: PostAILabelSetting.optional(),
    resourceDirectory: trimMax(2048),
    resourceMode: z.enum(['directory', 'table']).optional(),
    allowRepeat: z.boolean(),
    forbidSameAccountRepeat: z.literal(true),
    archivePublished: z.boolean(),
    count: intRange(1, 20),
  }).superRefine((s, ctx) => {
    if (s.audience === 'friends' && s.destination !== 'story')
      addIssue(ctx, '好友范围目前仅用于快拍', ['audience']);
    if (s.resourceMode !== 'table' && !s.resourceDirectory)
      addIssue(ctx, '请选择资源目录或使用组合资源表', ['resourceDirectory']);
    if (s.resourceMode === 'table' && s.resourceDirectory)
      addIssue(ctx, '资源表模式不能同时指定目录', ['resourceDirectory']);
  }),
]);
export const CombinationSchema = strictObj({
  name: title,
  note: trimMax(300),
  steps: z.array(StepSchema).min(1).max(100),
  randomOrder: z.boolean(),
  loop: z.discriminatedUnion('mode', [
    strictObj({ mode: z.literal('finite'), rounds: intRange(1, 10_000) }),
    strictObj({ mode: z.literal('until-stopped') }),
  ]),
}).superRefine((v, ctx) => {
  if (new Set(v.steps.map((s) => s.id)).size !== v.steps.length)
    addIssue(ctx, '子任务ID不能重复', ['steps']);
});
export type Combination = z.infer<typeof CombinationSchema>;
export type Step = z.infer<typeof StepSchema>;
export const GroupSchema = strictObj({
  id: Id,
  name: title,
  color: z.enum(['blue', 'green', 'orange', 'gray']),
  order: z.number().int(),
});
export type Group = z.infer<typeof GroupSchema>;
export const SavedCombinationSchema = strictObj({
  id: Id,
  version: NonNegInt,
  revision: NonNegInt,
  saved: CombinationSchema.nullable(),
  draft: z.null(),
  updatedAt: z.number(),
});
export type SavedCombination = z.infer<typeof SavedCombinationSchema>;
export const ProfileSchema = strictObj({
  id: Id,
  alias: z.string(),
  browserName: z.string().optional(),
  groupId: Id.nullable(),
  order: z.number().int().default(0),
  online: z.boolean(),
  phase: z.string(),
  synced: z.boolean(),
  unresolved: z.number(),
  extensionVersion: z.string().nullable(),
  capabilities: z.array(z.string()),
  presentation: ProfilePresentationStatus.nullable().optional(),
  account: strictObj({
    state: z.enum(['unknown', 'logged-in', 'logged-out', 'restricted', 'verification']),
    id: z.string().nullable(),
    name: z.string().nullable(),
    avatar: z.string().nullable(),
  }),
});
export type Profile = z.infer<typeof ProfileSchema>;
export interface ProfileNameLike {
  id?: string | null | undefined;
  browserName?: string | null | undefined;
  alias?: string | null | undefined;
  name?: string | null | undefined;
}
export function profileDisplayName(
  profile: ProfileNameLike | null | undefined,
  fallback?: string,
): string {
  const browserName = profile?.browserName?.trim();
  if (browserName) return browserName;
  const alias = profile?.alias?.trim();
  if (alias) return alias;
  const name = profile?.name?.trim();
  if (name) return name;
  if (fallback !== undefined) return fallback;
  const id = profile?.id?.trim();
  return id ? id.slice(0, 8) : '浏览器';
}
export const WorkspaceSchema = strictObj({
  schemaVersion: z.literal(1),
  groups: z.array(GroupSchema),
  profiles: z.array(ProfileSchema),
  combinations: z.array(SavedCombinationSchema),
  records: z.array(
    strictObj({
      id: z.string(),
      profileId: Id,
      kind: z.enum(['watch', 'operation']),
      status: z.string(),
      updatedAt: z.number(),
      summary: z.string(),
    }),
  ),
  support: strictObj({
    comboExecution: z.literal(false),
    accountIdentity: z.literal(false),
    reason: z.string(),
  }),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
const profileIdList = z.array(Id).min(1).max(1000);
export const CreateGroup = strictObj({ name: title, color: GroupSchema.shape.color });
export const RenameGroup = strictObj({ groupId: Id, name: title });
export const DeleteGroup = strictObj({ groupId: Id });
export const RenameProfile = strictObj({ profileId: Id, alias: title });
export const DeleteProfiles = strictObj({ profileIds: profileIdList });
export const CreateCombination = strictObj({ value: CombinationSchema });
export const SaveCombination = strictObj({
  id: Id,
  expectedRevision: NonNegInt,
  value: CombinationSchema,
});
export const DeleteCombination = strictObj({ id: Id });
export const StopProfiles = strictObj({ profileIds: profileIdList });
export const RuntimeSummarySchema = strictObj({
  activeModules: z.array(z.string()),
  timestamp: z.number().int(),
});
