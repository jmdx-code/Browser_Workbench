import { z } from 'zod';
import { Id, NonNegInt, PosInt, Sha256Hex, optBool, sMax, sReq, strictObj } from './contracts.js';
const dirStr = sReq(4096);
export const CreateWorkspaceBackup = strictObj({ directory: dirStr, redactSecrets: optBool });
export const WorkspaceBackupManifest = strictObj({
  version: z.literal(1),
  id: Id,
  createdAt: z.string().datetime(),
  softwareVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z
    .array(
      strictObj({
        name: z.enum(['workspace.sqlite', 'journal.sqlite']),
        bytes: PosInt,
        sha256: Sha256Hex,
      }),
    )
    .length(2)
    .refine((files) => new Set(files.map((f) => f.name)).size === 2, '备份需要两份不同的数据库'),
  includesSourceMedia: z.literal(false),
  includesMediaCache: z.literal(false),
});
export const WorkspaceBackupResult = WorkspaceBackupManifest.extend({ directory: dirStr }).strict();
export type BackupResult = z.infer<typeof WorkspaceBackupResult>;
export const WorkspaceBackupStatus = strictObj({
  available: z.boolean(),
  busy: z.boolean(),
  canCreate: z.boolean(),
  reason: sMax(300),
  defaultDirectory: sMax(4096).optional(),
});
export const RestoreWorkspaceBackup = strictObj({ directory: dirStr });
export const WorkspaceRestoreInspection = strictObj({
  directory: dirStr,
  id: Id,
  createdAt: z.string().datetime(),
  softwareVersion: z.string(),
  groups: NonNegInt,
  combinations: NonNegInt,
  profiles: NonNegInt,
  tasks: NonNegInt,
});
export type RestoreInspection = z.infer<typeof WorkspaceRestoreInspection>;
export const WorkspaceRestoreStatus = strictObj({
  available: z.boolean(),
  state: z.enum(['NONE', 'READY', 'APPLIED', 'ROLLED_BACK', 'FAILED']),
  reason: sMax(500),
  safetyDirectory: sMax(4096),
  defaultDirectory: sMax(4096).optional(),
});
export type RestoreStatus = z.infer<typeof WorkspaceRestoreStatus>;
