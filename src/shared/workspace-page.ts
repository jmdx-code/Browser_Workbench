import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';

// Presentation metadata, never an authority to read or control other group members.
export const WorkspaceMainPage = z
  .object({
    version: z.literal(1),
    proof: OwnedTabProof,
    windowId: z.number().int().positive(),
    groupId: z.number().int().nonnegative(),
  })
  .strict();
export type MainPage = z.infer<typeof WorkspaceMainPage>;
