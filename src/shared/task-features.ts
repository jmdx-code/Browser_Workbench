import { z } from 'zod';
import type { Step } from './contracts.js';

export const MARKETPLACE_MIN_BRIDGE = '0.3.19';
export function marketplaceMinimumBridge(steps: readonly Step[]) {
  return steps.some(
    (step) =>
      step.type === 'marketplace' &&
      (step.keyword.trim() ||
        step.categoryId ||
        step.minPrice !== undefined ||
        step.maxPrice !== undefined),
  )
    ? '0.3.20'
    : MARKETPLACE_MIN_BRIDGE;
}
export function marketplaceBridgeSupported(
  version: string | null | undefined,
  minimumVersion = MARKETPLACE_MIN_BRIDGE,
) {
  if (!version || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) return false;
  const actual = version.split('.').map(Number);
  const minimum = minimumVersion.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const part = actual[index],
      required = minimum[index];
    if (part === undefined || required === undefined) return false;
    if (part !== required) return part > required;
  }
  return true;
}

// Planned product tasks do not become executable by appearing in this catalogue.
export const taskFeatureDefinitions = [
  { id: 'feed', name: '浏览首页', detail: '进入首页、滚动内容、累计有效浏览时间。' },
  { id: 'video', name: '浏览 Reels', detail: '播放、切换内容；暂停和缓冲不累计播放时间。' },
  { id: 'post', name: '发布帖子', detail: '文字、图片、视频及素材使用记录。' },
  { id: 'marketplace', name: '浏览商城', detail: '搜索、浏览列表和商品详情。' },
  { id: 'story', name: '发布快拍', detail: '预览、发布及素材使用记录。' },
] as const;
export type TaskFeatureId = (typeof taskFeatureDefinitions)[number]['id'];
export const STORY_MIN_BRIDGE = '0.3.33';

export const TaskFeatureOverview = z
  .object({
    controllerAvailable: z.boolean(),
    features: z
      .array(
        z
          .object({
            id: z.enum(['feed', 'video', 'post', 'marketplace', 'story']),
            status: z.enum(['available', 'verification-pending', 'planned']),
            reason: z.string().max(300),
          })
          .strict(),
      )
      .length(5),
  })
  .strict();
export type FeatureOverview = z.infer<typeof TaskFeatureOverview>;
export const FEATURE_CONTRACT_HEADER = 'x-workbench-features-contract';
export const FeatureEvidence = z
  .object({
    implementation: z.enum(['none', 'partial', 'complete']),
    verification: z.enum(['pending', 'limited', 'passed', 'failed']),
    reason: z.string().max(300),
  })
  .strict();
export const FeatureEvidenceMap = z
  .object({
    feed: FeatureEvidence,
    video: FeatureEvidence,
    marketplace: FeatureEvidence,
    post: FeatureEvidence,
    story: FeatureEvidence,
  })
  .strict();
export type FeatureEvidenceValue = z.infer<typeof FeatureEvidenceMap>;
export const TaskFeatureOverviewV2 = TaskFeatureOverview.extend({
  features: z
    .array(
      TaskFeatureOverview.shape.features.element
        .extend({
          implementation: FeatureEvidence.shape.implementation,
          verification: FeatureEvidence.shape.verification,
          enabled: z.boolean(),
        })
        .strict(),
    )
    .length(5),
}).strict();
export type FeatureOverviewV2 = z.infer<typeof TaskFeatureOverviewV2>;
