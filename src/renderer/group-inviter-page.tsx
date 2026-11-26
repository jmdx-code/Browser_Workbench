import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { GroupInviterState } from '../shared/group-inviter.js';
import { InviterWorkspacePage } from './inviter-workspace-page.js';
import { GroupDraftGrid, mapProfilesToScopeOptions } from './target-add-modal.js';

export { GroupDraftGrid };

export function GroupInviterPage({
  state,
  loaded,
  selectedProfileIds,
  busy,
  onAddGroups,
  onDeleteGroups,
  onRefresh,
  onSaveInvitesPerGroup,
  onStart,
  onStop,
  onQuickSchedule,
  onOpenLiveRuns,
  onMessage,
  profiles,
  profileGroups,
  onSelectProfiles,
}: {
  state: GroupInviterState | null;
  loaded: boolean;
  selectedProfileIds: ReadonlySet<string>;
  busy: boolean;
  onAddGroups: (
    items: Array<{ groupId: string; groupName: string; folderId?: string | null }>,
  ) => Promise<void>;
  onDeleteGroups: (groupIds: string[]) => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onSaveInvitesPerGroup: (invitesPerGroup: number) => Promise<void>;
  onStart: (groupIds: string[], invitesPerGroup: number) => Promise<void>;
  onStop: () => Promise<void>;
  onQuickSchedule?: ((seed: QuickScheduleSeed) => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  onMessage?: (msg: string) => void;
  profiles?:
    | ReadonlyArray<{
        id: string;
        alias?: string | null;
        browserName?: string | null;
        online: boolean;
        groupId?: string | null;
      }>
    | undefined;
  profileGroups?: ReadonlyArray<{ id: string; name: string }> | undefined;
  onSelectProfiles?: ((next: Set<string>) => void) | undefined;
}) {
  return (
    <InviterWorkspacePage
      carrier="browser"
      state={state}
      loaded={loaded}
      selectedTargetIds={selectedProfileIds}
      externalBusy={busy}
      scopeItems={profiles ? mapProfilesToScopeOptions(profiles) : undefined}
      scopeGroups={profileGroups}
      onSelectTargets={onSelectProfiles}
      onAddGroups={onAddGroups}
      onDeleteGroups={onDeleteGroups}
      onRefresh={onRefresh}
      onSaveInvitesPerGroup={onSaveInvitesPerGroup}
      onStartBrowser={onStart}
      onStopBrowser={onStop}
      onQuickSchedule={onQuickSchedule}
      onOpenLiveRuns={onOpenLiveRuns}
      onMessage={onMessage}
    />
  );
}
