import { z } from 'zod';
import { PostAILabelSetting } from './facebook-ai-label.js';
import { ProfilePresentationStatus } from './presentation-status.js';

export const Id = z.uuid();
const title = z.string().trim().min(1).max(80);
const browseFields = {
  durationMinutes: z.number().int().min(1).max(240),
  maxLikes: z.number().int().min(0).max(100),
  minLikeCount: z.number().int().min(0).max(1_000_000_000),
  likeProbability: z.number().int().min(1).max(100).optional(),
  includeKeywords: z.string().trim().max(300).optional(),
  excludeKeywords: z.string().trim().max(300).optional(),
  skipSponsored: z.boolean().optional(),
};
const marketplaceFields = {
  durationMinutes: browseFields.durationMinutes,
  keyword: z.string().trim().max(120),
  categoryId: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  minPrice: z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01).optional(),
  maxPrice: z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01).optional(),
  maxLikes: z.literal(0),
  minLikeCount: z.literal(0),
};
const friendsFields = {
  durationMinutes: z.number().int().min(1).max(240).default(15),
  acceptMode: z.enum(['count', 'all']),
  maxAccepts: z.number().int().min(1).max(500),
  maxLikes: z.literal(0),
  minLikeCount: z.literal(0),
};
export const StepSchema = z.discriminatedUnion('type', [
  z.object({ id: Id, type: z.literal('video'), ...browseFields }).strict(),
  z.object({ id: Id, type: z.literal('feed'), ...browseFields }).strict(),
  z
    .object({ id: Id, type: z.literal('marketplace'), ...marketplaceFields })
    .strict()
    .superRefine((step, ctx) => {
      if (
        step.minPrice !== undefined &&
        step.maxPrice !== undefined &&
        step.minPrice > step.maxPrice
      )
        ctx.addIssue({ code: 'custom', message: '最低价不能大于最高价', path: ['minPrice'] });
      if (
        (step.minPrice !== undefined || step.maxPrice !== undefined) &&
        !step.keyword &&
        !step.categoryId
      )
        ctx.addIssue({
          code: 'custom',
          message: '设置价格时请选择分类或填写关键词',
          path: ['keyword'],
        });
    }),
  z.object({ id: Id, type: z.literal('friends'), ...friendsFields }).strict(),
  z
    .object({
      id: Id,
      type: z.literal('post'),
      destination: z.enum(['post', 'story']).optional(),
      audience: z.enum(['preserve-current', 'self', 'friends']).optional(),
      aiLabel: PostAILabelSetting.optional(),
      resourceDirectory: z.string().trim().max(2048),
      resourceMode: z.enum(['directory', 'table']).optional(),
      allowRepeat: z.boolean(),
      forbidSameAccountRepeat: z.literal(true),
      archivePublished: z.boolean(),
      count: z.number().int().min(1).max(20),
    })
    .strict()
    .superRefine((step, ctx) => {
      if (step.destination === 'story' && step.aiLabel && step.aiLabel !== 'preserve-current')
        ctx.addIssue({ code: 'custom', message: '快拍 AI 声明暂不支持指定值', path: ['aiLabel'] });
      if (step.audience === 'friends' && step.destination !== 'story')
        ctx.addIssue({ code: 'custom', message: '好友范围目前仅用于快拍', path: ['audience'] });
      if (step.resourceMode !== 'table' && !step.resourceDirectory)
        ctx.addIssue({
          code: 'custom',
          message: '请选择资源目录或使用组合资源表',
          path: ['resourceDirectory'],
        });
      if (step.resourceMode === 'table' && step.resourceDirectory)
        ctx.addIssue({
          code: 'custom',
          message: '资源表模式不能同时指定目录',
          path: ['resourceDirectory'],
        });
    }),
]);
export const CombinationSchema = z
  .object({
    name: title,
    note: z.string().trim().max(300),
    steps: z.array(StepSchema).min(1).max(100),
    randomOrder: z.boolean(),
    loop: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('finite'), rounds: z.number().int().min(1).max(10_000) }).strict(),
      z.object({ mode: z.literal('until-stopped') }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.steps.map((step) => step.id)).size !== value.steps.length)
      ctx.addIssue({ code: 'custom', message: '子任务ID不能重复', path: ['steps'] });
  });
export type Combination = z.infer<typeof CombinationSchema>;
export type Step = z.infer<typeof StepSchema>;
// Incomplete edits are durable drafts; only publishing requires the full contract.
export const CombinationDraftSchema = z
  .object({
    name: z.string().trim().max(80),
    note: z.string().trim().max(300),
    steps: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              id: Id,
              type: z.literal('marketplace'),
              ...marketplaceFields,
              durationMinutes: z.number().int().min(0).max(240),
            })
            .strict(),
          z
            .object({
              id: Id,
              type: z.literal('friends'),
              ...friendsFields,
              durationMinutes: z.number().int().min(0).max(240).default(15),
              maxAccepts: z.number().int().min(0).max(500),
            })
            .strict(),
          z
            .object({
              id: Id,
              type: z.literal('video'),
              ...browseFields,
              durationMinutes: z.number().int().min(0).max(240),
            })
            .strict(),
          z
            .object({
              id: Id,
              type: z.literal('feed'),
              ...browseFields,
              durationMinutes: z.number().int().min(0).max(240),
            })
            .strict(),
          z
            .object({
              id: Id,
              type: z.literal('post'),
              destination: z.enum(['post', 'story']).optional(),
              audience: z.enum(['preserve-current', 'self', 'friends']).optional(),
              aiLabel: PostAILabelSetting.optional(),
              resourceDirectory: z.string().trim().max(2048),
              resourceMode: z.enum(['directory', 'table']).optional(),
              allowRepeat: z.boolean(),
              forbidSameAccountRepeat: z.literal(true),
              archivePublished: z.boolean(),
              count: z.number().int().min(0).max(20),
            })
            .strict(),
        ]),
      )
      .max(100),
    randomOrder: z.boolean(),
    loop: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('finite'), rounds: z.number().int().min(0).max(10_000) }).strict(),
      z.object({ mode: z.literal('until-stopped') }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.steps.map((step) => step.id)).size !== value.steps.length)
      ctx.addIssue({ code: 'custom', message: '子任务ID不能重复', path: ['steps'] });
  });
export const GroupSchema = z
  .object({
    id: Id,
    name: title,
    color: z.enum(['blue', 'green', 'orange', 'gray']),
    order: z.number().int(),
  })
  .strict();
export type Group = z.infer<typeof GroupSchema>;
export const SavedCombinationSchema = z
  .object({
    id: Id,
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    saved: CombinationSchema.nullable(),
    draft: CombinationDraftSchema.nullable(),
    updatedAt: z.number(),
  })
  .strict();
export type SavedCombination = z.infer<typeof SavedCombinationSchema>;
export const ProfileSchema = z
  .object({
    id: Id,
    alias: z.string(),
    browserName: z.string().optional(),
    groupId: Id.nullable(),
    online: z.boolean(),
    phase: z.string(),
    synced: z.boolean(),
    unresolved: z.number(),
    extensionVersion: z.string().nullable(),
    capabilities: z.array(z.string()),
    presentation: ProfilePresentationStatus.nullable().optional(),
    account: z
      .object({
        state: z.enum(['unknown', 'logged-in', 'logged-out', 'restricted', 'verification']),
        id: z.string().nullable(),
        name: z.string().nullable(),
        avatar: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;
export const RecordSchema = z
  .object({
    id: z.string(),
    profileId: Id,
    kind: z.enum(['watch', 'operation']),
    status: z.string(),
    updatedAt: z.number(),
    summary: z.string(),
  })
  .strict();
export const WorkspaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    groups: z.array(GroupSchema),
    profiles: z.array(ProfileSchema),
    combinations: z.array(SavedCombinationSchema),
    records: z.array(RecordSchema),
    support: z
      .object({
        comboExecution: z.literal(false),
        accountIdentity: z.literal(false),
        reason: z.string(),
      })
      .strict(),
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;
export const CreateGroup = z.object({ name: title, color: GroupSchema.shape.color }).strict();
export const RenameGroup = z.object({ groupId: Id, name: title }).strict();
export const DeleteGroup = z.object({ groupId: Id }).strict();
export const MoveProfiles = z
  .object({
    profileIds: z.array(Id).min(1).max(1000),
    groupId: Id.nullable(),
  })
  .strict();
export const RenameProfile = z.object({ profileId: Id, alias: title }).strict();
export const DeleteProfiles = z.object({ profileIds: z.array(Id).min(1).max(1000) }).strict();
export const CreateCombination = z.object({ value: CombinationSchema }).strict();
export const CreateCombinationDraft = z.object({ value: CombinationDraftSchema }).strict();
export const ChangeCombination = z
  .object({
    id: Id,
    expectedRevision: z.number().int().nonnegative(),
    value: CombinationDraftSchema,
  })
  .strict();
export const ExistingCombination = z
  .object({
    id: Id,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const DeleteCombination = z.object({ id: Id }).strict();
export const StopProfiles = z.object({ profileIds: z.array(Id).min(1).max(1000) }).strict();
export const StopResultsSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion('requested', [
        z.object({ profileId: Id, requested: z.literal(true) }).strict(),
        z.object({ profileId: Id, requested: z.literal(false), reason: z.string() }).strict(),
      ]),
    ),
  })
  .strict();
export const StartCombination = z
  .object({
    id: Id,
    version: z.number().int().positive(),
    profileIds: z.array(Id).min(1).max(1000),
  })
  .strict();
