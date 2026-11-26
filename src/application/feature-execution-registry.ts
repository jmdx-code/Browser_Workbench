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

  setDelegatedSubmodule = (profileId: string, submoduleId: string | null) =>
    void (submoduleId
      ? this.delegatedSubmodules.set(profileId, submoduleId)
      : this.delegatedSubmodules.delete(profileId));

  private normalizeExcludes(exclude?: string | readonly string[]): ReadonlySet<string> | null {
    if (!exclude) return null;
    if (typeof exclude === 'string') return new Set([exclude]);
    return exclude.length ? new Set(exclude) : null;
  }

  private isDelegatedBypass(
    participantId: string,
    profileId: string,
    excludes: ReadonlySet<string> | null,
  ): boolean {
    const delegated = excludes ? this.delegatedSubmodules.get(profileId) : undefined;
    return Boolean(
      delegated &&
      excludes &&
      ((participantId === 'auto-scheduler' && excludes.has(delegated)) ||
        (excludes.has('auto-scheduler') && delegated === participantId)),
    );
  }

  private withProfileReserveLock<T>(profileId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.reserveLocks.get(profileId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.reserveLocks.set(profileId, next);
    void next
      .finally(() => {
        if (this.reserveLocks.get(profileId) === next) this.reserveLocks.delete(profileId);
      })
      .catch(() => {});
    return next;
  }

  async tryReserve(
    moduleId: string,
    profileIds: readonly string[],
  ): Promise<{ reservedIds: string[]; busyIds: string[] }> {
    const reservedIds: string[] = [];
    const busyIds: string[] = [];
    const excludes = new Set([moduleId]);
    for (const profileId of new Set(profileIds)) {
      const ok = await this.withProfileReserveLock(profileId, async () => {
        if (await this.isProfileBusy(profileId, moduleId)) return false;
        const holder = this.reservations.get(profileId);
        if (holder && holder !== moduleId && !this.isDelegatedBypass(holder, profileId, excludes))
          return false;
        this.reservations.set(profileId, moduleId);
        return true;
      });
      (ok ? reservedIds : busyIds).push(profileId);
    }
    return { reservedIds, busyIds };
  }

  releaseReservation(moduleId: string, profileIds: readonly string[]): void {
    for (const pid of profileIds)
      if (this.reservations.get(pid) === moduleId) this.reservations.delete(pid);
  }

  register = (participant: FeatureExecutionParticipant) =>
    void this.items.set(participant.id, participant);
  hasParticipant = (id: string) => this.items.has(id);
  participants = (): readonly FeatureExecutionParticipant[] => [...this.items.values()];
  isProfileBusy = (profileId: string, excludeModuleId?: string | readonly string[]) =>
    this.checkProfileBusy(profileId, excludeModuleId, true);
  isProfileBusyStrict = (profileId: string, excludeModuleId?: string | readonly string[]) =>
    this.checkProfileBusy(profileId, excludeModuleId, false);

  private isReservationBlocking(
    pid: string,
    excludes: ReadonlySet<string> | null,
    allowBypass: boolean,
  ): string | null {
    const reservedBy = this.reservations.get(pid);
    return !reservedBy ||
      excludes?.has(reservedBy) ||
      (allowBypass && this.isDelegatedBypass(reservedBy, pid, excludes))
      ? null
      : reservedBy;
  }

  private async checkProfileBusy(
    profileId: string,
    excludeModuleId: string | readonly string[] | undefined,
    allowBypass: boolean,
  ): Promise<boolean> {
    const excludes = this.normalizeExcludes(excludeModuleId);
    if (this.isReservationBlocking(profileId, excludes, allowBypass)) return true;
    for (const item of this.items.values()) {
      if (
        excludes?.has(item.id) ||
        (allowBypass && this.isDelegatedBypass(item.id, profileId, excludes))
      )
        continue;
      if (await item.isProfileRunning(profileId)) return true;
    }
    return false;
  }

  async busyModuleLabels(
    profileIds: readonly string[],
    excludeModuleId?: string | readonly string[],
  ): Promise<string[]> {
    const excludes = this.normalizeExcludes(excludeModuleId);
    const labels = new Set<string>();
    for (const pid of profileIds) {
      const reservedBy = this.isReservationBlocking(pid, excludes, true);
      if (reservedBy) labels.add(this.items.get(reservedBy)?.label ?? reservedBy);
    }
    for (const item of this.items.values()) {
      if (excludes?.has(item.id)) continue;
      for (const pid of profileIds) {
        if (!this.isDelegatedBypass(item.id, pid, excludes) && (await item.isProfileRunning(pid))) {
          labels.add(item.label);
          break;
        }
      }
    }
    return [...labels];
  }

  private async collectActive(
    selector: (item: FeatureExecutionParticipant) => string,
    excludeModuleId?: string,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const item of this.items.values())
      if ((!excludeModuleId || item.id !== excludeModuleId) && (await item.hasActiveExecution()))
        out.push(selector(item));
    return out;
  }

  activeModuleLabels = (excludeModuleId?: string) =>
    this.collectActive((item) => item.label, excludeModuleId);
  activeModuleIds = (excludeModuleId?: string) =>
    this.collectActive((item) => item.id, excludeModuleId);
  hasAnyActiveExecution = async (excludeModuleId?: string) =>
    (await this.collectActive((item) => item.id, excludeModuleId)).length > 0;

  async stopProfilesAcrossModules(profileIds: readonly string[]): Promise<boolean> {
    const uniqueIds = [...new Set(profileIds)];
    if (!uniqueIds.length) return false;
    let stoppedAny = false;
    for (const item of this.items.values()) {
      if (!item.stopProfiles) continue;
      const running: string[] = [];
      for (const pid of uniqueIds) if (await item.isProfileRunning(pid)) running.push(pid);
      if (running.length) {
        await item.stopProfiles(running);
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
      states: readonly ('QUEUED' | 'RUNNING')[],
    ): boolean | Promise<boolean>;
    hasActiveExecution?(): boolean | Promise<boolean>;
    stopActiveProfile?(profileId: string): boolean | Promise<boolean>;
  };
  groupInviter?: {
    isProfileRunning(id: string): boolean;
    hasActiveExecution(): boolean;
    stopProfiles(input: { profileIds: string[] }): Promise<unknown>;
  };
  groupBumper?: {
    isProfileRunning(id: string): boolean;
    hasActiveExecution(): boolean;
    isProfileRunningInMode?(id: string, mode: 'group-bumper' | 'page-bumper'): boolean;
    hasActiveExecutionInMode?(mode: 'group-bumper' | 'page-bumper'): boolean;
    stop(ids?: string[], mode?: 'group-bumper' | 'page-bumper'): Promise<unknown>;
  };
  groupPoster?: {
    isProfileRunning(id: string): boolean;
    hasActiveExecution(): boolean;
    stopProfiles(ids: readonly string[]): Promise<unknown>;
  };
  bluestacks?: {
    isProfileRunning(id: string, mode?: 'group' | 'page'): boolean;
    hasActiveExecution(mode?: 'group' | 'page'): boolean;
    stopBumper(ids?: readonly string[], mode?: 'group' | 'page'): Promise<unknown>;
    isProfileRunningExtra?(id: string, kind: 'active' | 'poster' | 'inviter'): boolean;
    hasExtraExecution?(kind: 'active' | 'poster' | 'inviter'): boolean;
    stopExtra?(kind: 'active' | 'poster' | 'inviter', ids?: readonly string[]): Promise<unknown>;
  };
}

const ACTIVE_PLAN_STATES = ['QUEUED', 'RUNNING'] as const;

export function ensureFeatureExecutionRegistry(
  existing: FeatureExecutionRegistry | undefined,
  services: FeatureExecutionFallbackServices,
): FeatureExecutionRegistry {
  const registry = existing ?? new FeatureExecutionRegistry();
  const reg = (p: FeatureExecutionParticipant) =>
    !registry.hasParticipant(p.id) && registry.register(p);
  const { tasks, groupInviter, groupBumper, groupPoster, bluestacks } = services;
  if (tasks)
    reg({
      id: 'active-accounts',
      label: '活跃账号',
      isProfileRunning: (id) => tasks.hasProfilePlanInStates(id, ACTIVE_PLAN_STATES),
      hasActiveExecution: () => tasks.hasActiveExecution?.() ?? false,
      stopProfiles: tasks.stopActiveProfile
        ? async (ids) => void (await Promise.all(ids.map((id) => tasks.stopActiveProfile?.(id))))
        : undefined,
    });
  if (groupInviter)
    reg({
      id: 'group-inviter',
      label: '小组邀请人',
      isProfileRunning: (id) => groupInviter.isProfileRunning(id),
      hasActiveExecution: () => groupInviter.hasActiveExecution(),
      stopProfiles: async (ids) => void (await groupInviter.stopProfiles({ profileIds: [...ids] })),
    });
  if (groupBumper) {
    for (const [id, label] of [
      ['group-bumper', '小组顶贴'],
      ['page-bumper', '专页顶贴'],
    ] as const) {
      reg({
        id,
        label,
        isProfileRunning: (pid) =>
          groupBumper.isProfileRunningInMode
            ? groupBumper.isProfileRunningInMode(pid, id) ||
              (id === 'group-bumper' &&
                groupBumper.isProfileRunning(pid) &&
                !groupBumper.isProfileRunningInMode(pid, 'page-bumper'))
            : id === 'group-bumper' && groupBumper.isProfileRunning(pid),
        hasActiveExecution: () =>
          groupBumper.hasActiveExecutionInMode
            ? groupBumper.hasActiveExecutionInMode(id) ||
              (id === 'group-bumper' &&
                groupBumper.hasActiveExecution() &&
                !groupBumper.hasActiveExecutionInMode('page-bumper'))
            : id === 'group-bumper' && groupBumper.hasActiveExecution(),
        stopProfiles: async (ids) => void (await groupBumper.stop([...ids], id)),
      });
    }
  }
  if (groupPoster)
    reg({
      id: 'group-poster',
      label: '小组发帖',
      isProfileRunning: (id) => groupPoster.isProfileRunning(id),
      hasActiveExecution: () => groupPoster.hasActiveExecution(),
      stopProfiles: async (ids) => void (await groupPoster.stopProfiles(ids)),
    });
  if (bluestacks) {
    for (const [id, label, mode] of [
      ['bluestacks-group-bumper', '蓝蝶小组顶贴', 'group'],
      ['bluestacks-page-bumper', '蓝蝶专页顶贴', 'page'],
    ] as const) {
      reg({
        id,
        label,
        isProfileRunning: (pid) => bluestacks.isProfileRunning(pid, mode),
        hasActiveExecution: () => bluestacks.hasActiveExecution(mode),
        stopProfiles: async (ids) => void (await bluestacks.stopBumper(ids, mode)),
      });
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
        reg({
          id,
          label,
          isProfileRunning: (pid) => isExtra(pid, kind),
          hasActiveExecution: () => hasExtra(kind),
          stopProfiles: async (ids) => void (await stopExtra(kind, ids)),
        });
      }
    }
  }
  return registry;
}
