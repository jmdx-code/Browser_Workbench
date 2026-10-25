import { z } from 'zod';
import { ResourceTable } from './resource-table.js';
export const TaskResourceBinding = z
  .object({
    jobId: z.uuid(),
    combinationId: z.uuid(),
    resourceRevision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export const TaskResourceSnapshot = z
  .object({ binding: TaskResourceBinding, table: ResourceTable })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.binding.combinationId !== value.table.combinationId ||
      value.binding.resourceRevision !== value.table.revision
    )
      ctx.addIssue({ code: 'custom', message: '任务资源版本不一致' });
  });
export type ResourceBinding = z.infer<typeof TaskResourceBinding>;
export type FixedResourceSnapshot = z.infer<typeof TaskResourceSnapshot>;
