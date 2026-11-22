export interface FeatureExecutionParticipant {
  readonly id: string;
  readonly label: string;
  isProfileRunning(profileId: string): boolean | Promise<boolean>;
  hasActiveExecution(): boolean | Promise<boolean>;
  stopProfiles?(profileIds: readonly string[]): Promise<void>;
}

export class FeatureExecutionRegistry {
  private readonly items = new Map<string, FeatureExecutionParticipant>();
  private readonly delegatedSubmodules = new Map<string, string>();
  private readonly reservations = new Map<string, string>();
  private readonly reserveLocks = new Map<string, Promise<unknown>>();

  setDelegatedSubmodule(profileId: string, submoduleId: string | null): void {
    if (submoduleId) {
      this.delegatedSubmodules.set(profileId, submoduleId);
    } else {
      this.delegatedSubmodules.delete(profileId);
    }
  }

  private normalizeExcludes(
    excludeModuleId?: string | readonly string[],
  ): ReadonlySet<string> | null {
    if (!excludeModuleId) return null;
    if (typeof excludeModuleId === 'string') return new Set([excludeModuleId]);
    return excludeModuleId.length > 0 ? new Set(excludeModuleId) : null;
  }

  private isDelegatedBypass(
    participantId: string,
    profileId: string,
    excludes: ReadonlySet<string> | null,
  ): boolean {
    if (!excludes) return false;
    const delegated = this.delegatedSubmodules.get(profileId);
    if (!delegated) return false;
    if (participantId === 'auto-scheduler' && excludes.has(delegated)) return true;
    if (excludes.has('auto-scheduler') && delegated === participantId) return true;
    return false;
  }

  private withProfileReserveLock<T>(profileId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.reserveLocks.get(profileId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.reserveLocks.set(profileId, next);
    void next
      .finally(() => {
        if (this.reserveLocks.get(profileId) === next) {
          this.reserveLocks.delete(profileId);
        }
      })
      .catch(() => {});
    return next;
  }

  async tryReserve(
    moduleId: string,
    profileIds: readonly string[],
  ): Promise<{ reservedIds: string[]; busyIds: string[] }> {
    const unique = [...new Set(profileIds)];
    const reservedIds: string[] = [];
    const busyIds: string[] = [];
    const excludes = new Set([moduleId]);
    for (const profileId of unique) {
      const ok = await this.withProfileReserveLock(profileId, async () => {
        const busy = await this.isProfileBusy(profileId, moduleId);
        if (busy) return false;
        // Same synchronous tick re-check + atomic reservation write (no intervening await).
        const holder = this.reservations.get(profileId);
        if (holder && holder !== moduleId && !this.isDelegatedBypass(holder, profileId, excludes)) {
          return false;
        }
        this.reservations.set(profileId, moduleId);
        return true;
      });
      if (ok) reservedIds.push(profileId);
      else busyIds.push(profileId);
    }
    return { reservedIds, busyIds };
  }

  releaseReservation(moduleId: string, profileIds: readonly string[]): void {
    for (const profileId of profileIds) {
      if (this.reservations.get(profileId) === moduleId) {
        this.reservations.delete(profileId);
      }
    }
  }

  register(participant: FeatureExecutionParticipant): void {
    this.items.set(participant.id, participant);
  }

  hasParticipant(id: string): boolean {
    return this.items.has(id);
  }

  participants(): readonly FeatureExecutionParticipant[] {
    return [...this.items.values()];
  }

  async isProfileBusy(
    profileId: string,
    excludeModuleId?: string | readonly string[],
  ): Promise<boolean> {
    const excludes = this.normalizeExcludes(excludeModuleId);
    const reservedBy = this.reservations.get(profileId);
    if (
      reservedBy &&
      !excludes?.has(reservedBy) &&
      !this.isDelegatedBypass(reservedBy, profileId, excludes)
    ) {
      return true;
    }
    for (const item of this.items.values()) {
      if (excludes?.has(item.id)) continue;
      if (this.isDelegatedBypass(item.id, profileId, excludes)) continue;
      if (await item.isProfileRunning(profileId)) return true;
    }
    return false;
  }

  async busyModuleLabels(
    profileIds: readonly string[],
    excludeModuleId?: string | readonly string[],
  ): Promise<string[]> {
    const excludes = this.normalizeExcludes(excludeModuleId);
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const pid of profileIds) {
      const reservedBy = this.reservations.get(pid);
      if (
        reservedBy &&
        !excludes?.has(reservedBy) &&
        !this.isDelegatedBypass(reservedBy, pid, excludes)
      ) {
        const label = this.items.get(reservedBy)?.label ?? reservedBy;
        if (!seen.has(label)) {
          seen.add(label);
          labels.push(label);
        }
      }
    }
    for (const item of this.items.values()) {
      if (excludes?.has(item.id)) continue;
      for (const pid of profileIds) {
        if (this.isDelegatedBypass(item.id, pid, excludes)) continue;
        if (await item.isProfileRunning(pid)) {
          if (!seen.has(item.label)) {
            seen.add(item.label);
            labels.push(item.label);
          }
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
    isProfileRunning(profileId: string, mode?: 'group' | 'page'): boolean;
    hasActiveExecution(mode?: 'group' | 'page'): boolean;
    stopBumper(profileIds?: readonly string[], mode?: 'group' | 'page'): Promise<unknown>;
    isProfileRunningExtra?(profileId: string, kind: 'active' | 'poster' | 'inviter'): boolean;
    hasExtraExecution?(kind: 'active' | 'poster' | 'inviter'): boolean;
    stopExtra?(
      kind: 'active' | 'poster' | 'inviter',
      profileIds?: readonly string[],
    ): Promise<unknown>;
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

  if (bluestacks) {
    for (const [id, label, mode] of [
      ['bluestacks-group-bumper', '蓝蝶小组顶贴', 'group'],
      ['bluestacks-page-bumper', '蓝蝶专页顶贴', 'page'],
    ] as const) {
      if (!registry.hasParticipant(id)) {
        registry.register({
          id,
          label,
          isProfileRunning: (profileId) => bluestacks.isProfileRunning(profileId, mode),
          hasActiveExecution: () => bluestacks.hasActiveExecution(mode),
          stopProfiles: async (profileIds) => {
            await bluestacks.stopBumper(profileIds, mode);
          },
        });
      }
    }
    if (bluestacks.isProfileRunningExtra && bluestacks.hasExtraExecution && bluestacks.stopExtra) {
      const isExtra = bluestacks.isProfileRunningExtra.bind(bluestacks);
      const hasExtra = bluestacks.hasExtraExecution.bind(bluestacks);
      const stopExtra = bluestacks.stopExtra.bind(bluestacks);
      for (const [id, label, kind] of [
        ['bluestacks-active', '蓝蝶活跃账号', 'active'],
        ['bluestacks-group-poster', '蓝蝶小组发帖', 'poster'],
        ['bluestacks-group-inviter', '蓝蝶小组邀请人', 'inviter'],
      ] as const) {
        if (!registry.hasParticipant(id)) {
          registry.register({
            id,
            label,
            isProfileRunning: (profileId) => isExtra(profileId, kind),
            hasActiveExecution: () => hasExtra(kind),
            stopProfiles: async (profileIds) => {
              await stopExtra(kind, profileIds);
            },
          });
        }
      }
    }
  }

  return registry;
}
