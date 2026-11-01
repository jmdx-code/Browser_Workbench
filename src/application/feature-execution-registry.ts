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

  async hasAnyActiveExecution(): Promise<boolean> {
    for (const item of this.items.values()) {
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
