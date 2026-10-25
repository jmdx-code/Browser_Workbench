import { z } from 'zod';
export const CreateWorkspaceBackup = z.object({ directory: z.string().min(1).max(4096) }).strict();
export const WorkspaceBackupManifest = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    createdAt: z.string().datetime(),
    softwareVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    files: z
      .array(
        z
          .object({
            name: z.enum(['workspace.sqlite', 'journal.sqlite']),
            bytes: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(2)
      .refine(
        (files) => new Set(files.map((file) => file.name)).size === 2,
        '备份需要两份不同的数据库',
      ),
    includesSourceMedia: z.literal(false),
    includesMediaCache: z.literal(false),
  })
  .strict();
export const WorkspaceBackupResult = WorkspaceBackupManifest.extend({
  directory: z.string().min(1).max(4096),
}).strict();
export type BackupResult = z.infer<typeof WorkspaceBackupResult>;
export const WorkspaceBackupStatus = z
  .object({
    available: z.boolean(),
    busy: z.boolean(),
    canCreate: z.boolean(),
    reason: z.string().max(300),
    defaultDirectory: z.string().max(4096).optional(),
  })
  .strict();
export const RestoreWorkspaceBackup = z.object({ directory: z.string().min(1).max(4096) }).strict();
export const WorkspaceRestoreInspection = z
  .object({
    directory: z.string().min(1).max(4096),
    id: z.uuid(),
    createdAt: z.string().datetime(),
    softwareVersion: z.string(),
    groups: z.number().int().nonnegative(),
    combinations: z.number().int().nonnegative(),
    profiles: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  })
  .strict();
export type RestoreInspection = z.infer<typeof WorkspaceRestoreInspection>;
export const WorkspaceRestoreStatus = z
  .object({
    available: z.boolean(),
    state: z.enum(['NONE', 'READY', 'APPLIED', 'ROLLED_BACK', 'FAILED']),
    reason: z.string().max(500),
    safetyDirectory: z.string().max(4096),
    defaultDirectory: z.string().max(4096).optional(),
  })
  .strict();
export type RestoreStatus = z.infer<typeof WorkspaceRestoreStatus>;
