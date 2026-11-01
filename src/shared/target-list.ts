import { z } from 'zod';
export const TargetListKind = z.enum(['inviter_groups', 'bumper_groups', 'bumper_pages']);
export type TargetListKind = z.infer<typeof TargetListKind>;
export interface TargetFolder {
  id: string;
  listKind: TargetListKind;
  name: string;
  sortOrder: number;
  createdAt: number;
}
export const TargetListCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    listKind: TargetListKind,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ action: z.literal('rename'), id: z.uuid(), name: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal('delete'), id: z.uuid() }),
  z.object({
    action: z.literal('reorder-folders'),
    listKind: TargetListKind,
    orderedFolderIds: z.array(z.uuid()).max(500),
  }),
  z.object({
    action: z.literal('reorder-items'),
    listKind: TargetListKind,
    folderId: z.uuid().nullable(),
    orderedItemIds: z.array(z.string().min(1).max(120)).max(10000),
  }),
]);
export type TargetListCommand = z.infer<typeof TargetListCommand>;
