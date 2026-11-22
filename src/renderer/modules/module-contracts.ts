import type { z } from 'zod';
import type { Step } from '../../shared/contracts.js';
import type { Progress, TaskCommand, TaskStepBudget } from '../../shared/task-contracts.js';

export type FeatureModuleId =
  | 'auto-scheduler'
  | 'active-accounts'
  | 'group-inviter'
  | 'group-bumper'
  | 'page-bumper'
  | 'group-poster'
  | 'sheets-groups'
  | 'sheets-pages'
  | 'sheets-schedule'
  | 'sheets-records'
  | 'bluestacks-active'
  | 'bluestacks-group-poster'
  | 'bluestacks-group-bumper'
  | 'bluestacks-page-bumper'
  | 'bluestacks-group-inviter'
  | 'records';

export type StepBudget = z.infer<typeof TaskStepBudget>;

export interface ProfileActivityDescriptor {
  moduleId: FeatureModuleId;
  moduleLabel: string;
  running: boolean;
  tone: 'run' | 'ok' | 'warn' | 'err' | 'idle' | 'queue' | 'pause';
  text: string;
  tooltipLines: string[];
  className?: string | undefined;
  progressView?:
    | {
        type: Step['type'];
        progress: Progress;
        budget?: StepBudget | undefined;
        maxLikes?: number | undefined;
      }
    | undefined;
}

export interface FeatureNavItem {
  id: FeatureModuleId;
  group: 'control' | 'automation' | 'bluestacks' | 'sheets' | 'monitor';
  title: string;
  tooltip?: string | undefined;
  icon: FeatureModuleId;
  runningCount?: number | undefined;
  badgeCount?: number | undefined;
  badgeTone?: 'run' | 'warn' | 'err' | 'ok' | undefined;
}

export interface SelectionControlSummary {
  pausableTargets: TaskCommand['plans'];
  resumableTargets: TaskCommand['plans'];
  stoppableTargets: TaskCommand['plans'];
  stoppableModuleProfileIds: string[];
  totalStoppableCount: number;
  isProfileBusy: (profileId: string) => boolean;
}
