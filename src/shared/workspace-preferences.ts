import { z } from 'zod';
import { Id } from './contracts.js';
import { TaskTimeZone } from './task-timing.js';
import { WindowLayoutSettings } from './window-layout.js';

export const CardColorName = z.enum([
  'graphite',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'violet',
]);
export const CombinationColors = z.record(Id, CardColorName);
export const WorkspacePreferenceValues = z
  .object({
    defaultTimeZone: TaskTimeZone.nullable(),
    desktopNotifications: z.enum(['off', 'failures', 'all']),
    combinationColors: CombinationColors.optional(),
    windowLayout: WindowLayoutSettings.optional(),
  })
  .strict();
export const WorkspacePreferences = WorkspacePreferenceValues.extend({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
}).strict();
export const UpdateWorkspacePreferences = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe(),
    values: WorkspacePreferenceValues,
  })
  .strict();
export type Preferences = z.infer<typeof WorkspacePreferences>;
export type PreferenceUpdate = z.infer<typeof UpdateWorkspacePreferences>;

export const DesktopTaskNotification = z
  .object({
    type: z.literal('TASK_NOTIFICATION'),
    failed: z.number().int().min(0).max(100),
    completed: z.number().int().min(0).max(100),
  })
  .strict()
  .refine((value) => value.failed + value.completed > 0 && value.failed + value.completed <= 100);

export const TaskNotificationEvent = z
  .object({
    sequence: z.number().int().positive().safe(),
    type: z.enum(['FAILED', 'COMPLETED']),
  })
  .strict();
export type NotificationEvent = z.infer<typeof TaskNotificationEvent>;
