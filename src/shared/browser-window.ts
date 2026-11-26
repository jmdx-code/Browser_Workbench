import { z } from 'zod';
import { Id, NonNegInt, PosInt, optBool, strictObj } from './contracts.js';
import { OwnedTabProof } from './kernel-state.js';
export const ShowBrowserRequest = strictObj({ profileId: Id });
export const ShowBrowserResult = strictObj({
  profileId: Id,
  tabId: PosInt,
  focused: z.literal(true),
});
export const CleanupProfileTabsRequest = strictObj({
  profileIds: z.array(Id).min(1).max(500),
  preferActiveTab: optBool,
});
export const CleanupProfileTabsResult = strictObj({
  cleanedProfiles: NonNegInt,
  closedTabs: NonNegInt,
  skippedBusy: NonNegInt,
  skippedOffline: NonNegInt,
});
const ConsolidateBrowserResult = strictObj({
  profileId: Id,
  proof: OwnedTabProof.optional(),
  url: z.string(),
  closedTabIds: z.array(PosInt),
  remainingTabCount: PosInt,
});
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
