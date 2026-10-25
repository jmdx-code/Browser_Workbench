import type { Awaitable } from './persistence.js';
import type { StepExecution } from './browse-execution.js';
import type { PostStepExecutor } from './post-execution.js';
import type { ExecutionSession } from '../shared/task-execution.js';
import type { TabProof } from '../shared/kernel-state.js';
import type { Spec } from '../shared/browser-actions.js';
import type { z } from 'zod';
import type { FacebookUILocale } from '../shared/facebook-ui.js';
import type { observeFacebookComposerSurface } from './facebook-composer-analysis.js';
import type { PostExecutionVerdict } from '../shared/post-execution.js';
import type { ComposerAudience } from '../shared/facebook-audience.js';
import type { BackgroundReading } from '../shared/facebook-background.js';
import type { StoryPage } from '../shared/facebook-story.js';
import type { AILabelReading } from '../shared/facebook-ai-label.js';

export interface FacebookPostPageReading {
  context: ExecutionSession;
  proof: TabProof;
  observedAccountId: string;
  documentEpoch: number;
  routeEpoch: number;
  timeOrigin: number;
  url: string;
  locale: FacebookUILocale | undefined;
  opener: z.infer<typeof Spec> | null;
  surface: ReturnType<typeof observeFacebookComposerSurface>;
  text: string | null;
  audience?: ComposerAudience;
  background?: BackgroundReading;
  homePreparation?: {
    safe: boolean;
    reason?: 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' | 'POST_HOME_PREPARATION_BLOCKED';
  };
  story?: StoryPage;
  aiLabel?: AILabelReading;
}

// Private source backed by the same managed SDK owner. Display inspection is not this source.
// Media and publication adapters must independently read effects on the original bound attempt.
export interface FacebookPostPageSource {
  ready(): Awaitable<boolean>;
  catalogId(execution: StepExecution): Awaitable<string>;
  read(
    execution: StepExecution,
    assertCurrent: () => Awaitable<void>,
  ): Awaitable<Promise<FacebookPostPageReading>>;
  verifyBusiness(
    execution: StepExecution,
    operation: Parameters<PostStepExecutor['verify']>[1],
    original: Parameters<PostStepExecutor['verify']>[2],
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict>;
}

export type FacebookPostBoundOperation = Parameters<PostStepExecutor['verify']>[1];
export type FacebookPostOriginal = Parameters<PostStepExecutor['verify']>[2];
