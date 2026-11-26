import { z } from 'zod';
import { NonNegInt, sMax, strictObj } from './contracts.js';
export const WorkspaceEventTopic = z.enum([
  'workspace',
  'tasks',
  'inspections',
  'group-bumper',
  'group-poster',
  'group-inviter',
  'bluestacks',
  'auto-scheduler',
  'google-sheets',
  'records',
  'runtime-summary',
]);
export type WorkspaceEventTopic = z.infer<typeof WorkspaceEventTopic>;
export const WorkspaceInvalidationEvent = strictObj({
  topics: z.array(WorkspaceEventTopic).min(1),
  version: NonNegInt,
  reason: sMax(120).optional(),
  at: z.number().int(),
});
export type WorkspaceInvalidationEvent = z.infer<typeof WorkspaceInvalidationEvent>;
const READ_ONLY_POST_ROUTES = new Set(
  '/api/workspace/tasks/records /api/workspace/tasks/history /api/workspace/resource-tables/read /api/workspace/data-cleanup/preview /api/workspace/post-bump-records/list /api/workspace/diagnostics/snapshot /api/workspace/diagnostics/reveal'.split(
    ' ',
  ),
);
const ROUTE_TOPICS: ReadonlyArray<[string, WorkspaceEventTopic[]]> = [
  ['/api/workspace/tasks', ['tasks', 'runtime-summary', 'records']],
  ['/api/workspace/combinations', ['workspace']],
  ['/api/workspace/resource-tables', ['workspace']],
  ['/api/workspace/group-bumper', ['group-bumper', 'runtime-summary', 'records']],
  ['/api/workspace/group-poster', ['group-poster', 'group-inviter', 'runtime-summary', 'records']],
  [
    '/api/workspace/group-inviter',
    ['group-inviter', 'group-bumper', 'group-poster', 'runtime-summary', 'records'],
  ],
  ['/api/workspace/bluestacks', ['bluestacks', 'runtime-summary', 'records']],
  ['/api/workspace/auto-scheduler', ['auto-scheduler', 'runtime-summary', 'records']],
  [
    '/api/workspace/google-sheets',
    [
      'google-sheets',
      'group-bumper',
      'group-poster',
      'group-inviter',
      'runtime-summary',
      'records',
    ],
  ],
  ['/api/workspace/post-bump-records', ['records', 'workspace', 'tasks']],
  ['/api/workspace/cleanup', ['records', 'workspace', 'tasks']],
];
export function inferEventTopicsForRoute(route: string): WorkspaceEventTopic[] {
  if (READ_ONLY_POST_ROUTES.has(route)) return [];
  if (route.startsWith('/api/workspace/profiles') || route.startsWith('/api/workspace/groups'))
    return route.includes('inspect') ? ['inspections', 'workspace'] : ['workspace'];
  for (const [prefix, topics] of ROUTE_TOPICS) if (route.startsWith(prefix)) return topics;
  return ['workspace', 'runtime-summary'];
}
