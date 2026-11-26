import type { QuickScheduleSeed } from '../../shared/auto-scheduler.js';
import { bluestacksDisplayTitle, type BluestacksState } from '../../shared/bluestacks.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import type { GroupInviterState } from '../../shared/group-inviter.js';
import { InviterWorkspacePage } from '../inviter-workspace-page.js';

export function BluestacksInviterPage({
  bluestacksState,
  onBluestacksState,
  selected,
  groups,
  inviterState,
  onSyncSharedGroups,
  onQuickSchedule,
  onOpenLiveRuns,
  onMessage,
  onSelectBluestacks,
}: {
  bluestacksState: BluestacksState | null;
  onBluestacksState: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  groups: readonly BumperTarget[];
  inviterState?: GroupInviterState | null | undefined;
  onSyncSharedGroups?: (() => Promise<void>) | undefined;
  onQuickSchedule?: ((seed: QuickScheduleSeed) => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  onMessage: (msg: string) => void;
  onSelectBluestacks?: ((next: Set<string>) => void) | undefined;
}) {
  const instances = bluestacksState?.instances ?? [];
  return (
    <InviterWorkspacePage
      carrier="bluestacks"
      state={inviterState ?? null}
      selectedTargetIds={selected}
      bluestacksState={bluestacksState}
      onBluestacksState={onBluestacksState}
      fallbackGroups={groups}
      scopeItems={
        onSelectBluestacks
          ? instances.map((inst) => ({
              id: inst.id,
              label: bluestacksDisplayTitle(inst),
              online: inst.online,
              groupId: inst.folderId,
            }))
          : undefined
      }
      scopeGroups={(bluestacksState?.folders ?? []).map((f) => ({ id: f.id, name: f.name }))}
      onSelectTargets={onSelectBluestacks}
      onRefresh={async () => {
        await onSyncSharedGroups?.();
      }}
      onQuickSchedule={onQuickSchedule}
      onOpenLiveRuns={onOpenLiveRuns}
      onMessage={onMessage}
    />
  );
}
