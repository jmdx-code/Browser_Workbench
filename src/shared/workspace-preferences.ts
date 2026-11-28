import { z } from 'zod';
import { Id, NonNegInt, PosInt, TaskTimeZone, intRange, strictObj } from './contracts.js';
import { WindowLayoutSettings } from './window-layout.js';
export const WorkspacePreferenceValues = strictObj({
  defaultTimeZone: TaskTimeZone.nullable(),
  desktopNotifications: z.enum(['off', 'failures', 'all']),
  combinationColors: z
    .record(Id, z.enum(['graphite', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'violet']))
    .optional(),
  windowLayout: WindowLayoutSettings.optional(),
});
export const WorkspacePreferences = WorkspacePreferenceValues.extend({
  version: z.literal(1),
  revision: NonNegInt.safe(),
}).strict();
export const UpdateWorkspacePreferences = strictObj({
  expectedRevision: NonNegInt.safe(),
  values: WorkspacePreferenceValues,
});
export type Preferences = z.infer<typeof WorkspacePreferences>;
export type PreferenceUpdate = z.infer<typeof UpdateWorkspacePreferences>;
const pct = intRange(0, 100);
export const DesktopTaskNotification = strictObj({
  type: z.literal('TASK_NOTIFICATION'),
  failed: pct,
  completed: pct,
}).refine((v) => v.failed + v.completed > 0 && v.failed + v.completed <= 100);
export const TaskNotificationEvent = strictObj({
  sequence: PosInt.safe(),
  type: z.enum(['FAILED', 'COMPLETED']),
});
export type NotificationEvent = z.infer<typeof TaskNotificationEvent>;
