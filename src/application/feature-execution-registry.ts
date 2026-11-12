export interface FeatureExecutionParticipant {
  readonly id: string;
  readonly label: string;
  isProfileRunning(profileId: string): boolean | Promise<boolean>;
  hasActiveExecution(): boolean | Promise<boolean>;
  stopProfiles?(profileIds: readonly string[]): Promise<void>;
}

export class FeatureExecutionRegistry {
  private readonly items = new Map<string, FeatureExecutionParticipant>();

  register(participant: FeatureExecutionParticipant): void {
    this.items.set(participant.id, participant);
  }

  hasParticipant(id: string): boolean {
    return this.items.has(id);
  }

  participants(): readonly FeatureExecutionParticipant[] {
    return [...this.items.values()];
  }

  async isProfileBusy(profileId: string, excludeModuleId?: string): Promise<boolean> {
    for (const item of this.items.values()) {
      if (excludeModuleId && item.id === excludeModuleId) continue;
      if (await item.isProfileRunning(profileId)) return true;
    }
    return false;
  }

  async busyModuleLabels(
    profileIds: readonly string[],
    excludeModuleId?: string,
  ): Promise<string[]> {
    const labels: string[] = [];
    for (const item of this.items.values()) {
      if (excludeModuleId && item.id === excludeModuleId) continue;
      for (const pid of profileIds) {
        if (await item.isProfileRunning(pid)) {
          labels.push(item.label);
          break;
        }
      }
    }
    return labels;
  }

  async activeModuleLabels(excludeModuleId?: string): Promise<string[]> {
    const labels: string[] = [];
    for (const item of this.items.values()) {
      if (excludeModuleId && item.id === excludeModuleId) continue;
      if (await item.hasActiveExecution()) {
        labels.push(item.label);
      }
    }
    return labels;
  }

  async hasAnyActiveExecution(excludeModuleId?: string): Promise<boolean> {
    for (const item of this.items.values()) {
      if (excludeModuleId && item.id === excludeModuleId) continue;
      if (await item.hasActiveExecution()) return true;
    }
    return false;
  }

  async stopProfilesAcrossModules(profileIds: readonly string[]): Promise<boolean> {
    const uniqueIds = [...new Set(profileIds)];
    if (uniqueIds.length === 0) return false;
    let stoppedAny = false;
    for (const item of this.items.values()) {
      if (!item.stopProfiles) continue;
      const runningForModule: string[] = [];
      for (const pid of uniqueIds) {
        if (await item.isProfileRunning(pid)) {
          runningForModule.push(pid);
        }
      }
      if (runningForModule.length > 0) {
        await item.stopProfiles(runningForModule);
        stoppedAny = true;
      }
    }
    return stoppedAny;
  }
}

export interface FeatureExecutionFallbackServices {
  tasks?: {
    hasProfilePlanInStates(
      profileId: string,
      states: readonly ('QUEUED' | 'RUNNING' | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'REVIEW')[],
    ): boolean | Promise<boolean>;
    hasActiveExecution?(): boolean | Promise<boolean>;
    stopActiveProfile?(profileId: string): boolean | Promise<boolean>;
  };
  groupInviter?: {
    isProfileRunning(profileId: string): boolean;
    hasActiveExecution(): boolean;
    stopProfiles(input: { profileIds: string[] }): Promise<unknown>;
  };
  groupBumper?: {
    isProfileRunning(profileId: string): boolean;
    hasActiveExecution(): boolean;
    isProfileRunningInMode?(profileId: string, mode: 'group-bumper' | 'page-bumper'): boolean;
    hasActiveExecutionInMode?(mode: 'group-bumper' | 'page-bumper'): boolean;
    stop(ids?: string[], mode?: 'group-bumper' | 'page-bumper'): Promise<unknown>;
  };
  groupPoster?: {
    isProfileRunning(profileId: string): boolean;
    hasActiveExecution(): boolean;
    stopProfiles(profileIds: readonly string[]): Promise<unknown>;
  };
  bluestacks?: {
    isProfileRunning(profileId: string): boolean;
    hasActiveExecution(): boolean;
    stopBumper(profileIds?: readonly string[]): Promise<unknown>;
  };
}

const ACTIVE_PLAN_STATES = [
  'QUEUED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'REVIEW',
] as const;

export function ensureFeatureExecutionRegistry(
  existing: FeatureExecutionRegistry | undefined,
  services: FeatureExecutionFallbackServices,
): FeatureExecutionRegistry {
  const registry = existing ?? new FeatureExecutionRegistry();
  const { tasks, groupInviter, groupBumper, groupPoster, bluestacks } = services;

  if (tasks && !registry.hasParticipant('active-accounts')) {
    registry.register({
      id: 'active-accounts',
      label: '活跃账号',
      isProfileRunning: (profileId) => tasks.hasProfilePlanInStates(profileId, ACTIVE_PLAN_STATES),
      hasActiveExecution: () => tasks.hasActiveExecution?.() ?? false,
      stopProfiles: tasks.stopActiveProfile
        ? async (profileIds) => {
            await Promise.all(profileIds.map((id) => tasks.stopActiveProfile?.(id)));
          }
        : undefined,
    });
  }

  if (groupInviter && !registry.hasParticipant('group-inviter')) {
    registry.register({
      id: 'group-inviter',
      label: '小组邀请人',
      isProfileRunning: (profileId) => groupInviter.isProfileRunning(profileId),
      hasActiveExecution: () => groupInviter.hasActiveExecution(),
      stopProfiles: async (profileIds) => {
        await groupInviter.stopProfiles({ profileIds: [...profileIds] });
      },
    });
  }

  if (groupBumper) {
    for (const [id, label] of [
      ['group-bumper', '小组顶贴'],
      ['page-bumper', '专页顶贴'],
    ] as const) {
      if (!registry.hasParticipant(id)) {
        registry.register({
          id,
          label,
          isProfileRunning: (profileId) =>
            groupBumper.isProfileRunningInMode
              ? groupBumper.isProfileRunningInMode(profileId, id) ||
                (id === 'group-bumper' &&
                  groupBumper.isProfileRunning(profileId) &&
                  !groupBumper.isProfileRunningInMode(profileId, 'page-bumper'))
              : id === 'group-bumper' && groupBumper.isProfileRunning(profileId),
          hasActiveExecution: () =>
            groupBumper.hasActiveExecutionInMode
              ? groupBumper.hasActiveExecutionInMode(id) ||
                (id === 'group-bumper' &&
                  groupBumper.hasActiveExecution() &&
                  !groupBumper.hasActiveExecutionInMode('page-bumper'))
              : id === 'group-bumper' && groupBumper.hasActiveExecution(),
          stopProfiles: async (profileIds) => {
            await groupBumper.stop([...profileIds], id);
          },
        });
      }
    }
  }

  if (groupPoster && !registry.hasParticipant('group-poster')) {
    registry.register({
      id: 'group-poster',
      label: '小组发帖',
      isProfileRunning: (profileId) => groupPoster.isProfileRunning(profileId),
      hasActiveExecution: () => groupPoster.hasActiveExecution(),
      stopProfiles: async (profileIds) => {
        await groupPoster.stopProfiles(profileIds);
      },
    });
  }

  if (bluestacks && !registry.hasParticipant('bluestacks-group-bumper')) {
    registry.register({
      id: 'bluestacks-group-bumper',
      label: '蓝蝶小组顶贴',
      isProfileRunning: (profileId) => bluestacks.isProfileRunning(profileId),
      hasActiveExecution: () => bluestacks.hasActiveExecution(),
      stopProfiles: async (profileIds) => {
        await bluestacks.stopBumper(profileIds);
      },
    });
  }

  return registry;
}
