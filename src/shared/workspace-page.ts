import { z } from 'zod';
import { NonNegInt, PosInt, strictObj } from './contracts.js';
import { OwnedTabProof } from './kernel-state.js';
export const WORKBENCH_TAB_GROUP_TITLE = '浏览器工作台';
export const WORKBENCH_TAB_GROUP_COLOR = 'grey' as const;
export const isWorkbenchTabGroupTitle = (title: string | null | undefined): boolean =>
  typeof title === 'string' &&
  (title.trim() === WORKBENCH_TAB_GROUP_TITLE || title.trim() === 'Browser Workbench');
// Presentation metadata, never an authority to read or control other group members.
export const WorkspaceMainPage = strictObj({
  version: z.literal(1),
  proof: OwnedTabProof,
  windowId: PosInt,
  groupId: NonNegInt,
});
export type MainPage = z.infer<typeof WorkspaceMainPage>;
