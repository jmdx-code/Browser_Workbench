import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';

export const ShowBrowserRequest = z.object({ profileId: z.uuid() }).strict();
export const ShowBrowserResult = z
  .object({ profileId: z.uuid(), tabId: z.number().int().positive(), focused: z.literal(true) })
  .strict();
export const ConsolidateBrowserRequest = z
  .object({ profileId: z.uuid(), preferActiveTab: z.boolean().optional() })
  .strict();
export const CleanupProfileTabsRequest = z
  .object({
    profileIds: z.array(z.uuid()).min(1).max(500),
    preferActiveTab: z.boolean().optional(),
  })
  .strict();
export const CleanupProfileTabsResult = z
  .object({
    cleanedProfiles: z.number().int().nonnegative(),
    closedTabs: z.number().int().nonnegative(),
    skippedBusy: z.number().int().nonnegative(),
    skippedOffline: z.number().int().nonnegative(),
  })
  .strict();
export const ConsolidateBrowserResult = z
  .object({
    profileId: z.uuid(),
    proof: OwnedTabProof,
    url: z.string(),
    closedTabIds: z.array(z.number().int().positive()),
    remainingTabCount: z.number().int().positive(),
  })
  .strict();
export interface BrowserWindowPort {
  cleanupTabs?(
    profileIds: string[],
    preferActiveTab?: boolean,
  ): Promise<z.infer<typeof CleanupProfileTabsResult>>;
  show(profileId: string, alias: string): Promise<z.infer<typeof ShowBrowserResult>>;
  consolidate?(
    profileId: string,
    preferActiveTab?: boolean,
  ): Promise<z.infer<typeof ConsolidateBrowserResult>>;
}
