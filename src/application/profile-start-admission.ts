export interface ProfileStartAdmissionInput {
  readonly requestedProfileIds: readonly string[];
  readonly currentModuleId: string;
  isAlreadyRunningInCurrentModule?(profileId: string): boolean | Promise<boolean>;
  isProfileReady(profileId: string): boolean | Promise<boolean>;
  busyModuleLabelsForProfile?(profileId: string): Promise<string[]>;
  isProfileBusyInOtherModule?(profileId: string): boolean | Promise<boolean>;
}

export interface ProfileStartAdmissionResult {
  readonly admittedProfileIds: string[];
  readonly alreadyRunningIds: string[];
  readonly skippedBusy: Array<{ profileId: string; reason: string; labels: string[] }>;
  readonly skippedOffline: Array<{ profileId: string; reason: string }>;
}

export async function admitProfilesForStart(
  input: ProfileStartAdmissionInput,
): Promise<ProfileStartAdmissionResult> {
  const uniqueIds = [...new Set(input.requestedProfileIds)];
  const admittedProfileIds: string[] = [];
  const alreadyRunningIds: string[] = [];
  const skippedBusy: Array<{ profileId: string; reason: string; labels: string[] }> = [];
  const skippedOffline: Array<{ profileId: string; reason: string }> = [];

  for (const profileId of uniqueIds) {
    if (
      input.isAlreadyRunningInCurrentModule &&
      (await input.isAlreadyRunningInCurrentModule(profileId))
    ) {
      alreadyRunningIds.push(profileId);
      continue;
    }

    const busyLabels = input.busyModuleLabelsForProfile
      ? await input.busyModuleLabelsForProfile(profileId)
      : [];
    const busyOther =
      busyLabels.length > 0 ||
      (input.isProfileBusyInOtherModule
        ? Boolean(await input.isProfileBusyInOtherModule(profileId))
        : false);
    if (busyOther) {
      skippedBusy.push({
        profileId,
        labels: busyLabels,
        reason:
          busyLabels.length > 0
            ? `跳过：正在运行「${busyLabels.join(' / ')}」`
            : '跳过：正在执行其他任务',
      });
      continue;
    }

    const ready = await input.isProfileReady(profileId);
    if (!ready) {
      skippedOffline.push({
        profileId,
        reason: '跳过：浏览器未连接',
      });
      continue;
    }

    admittedProfileIds.push(profileId);
  }

  return {
    admittedProfileIds,
    alreadyRunningIds,
    skippedBusy,
    skippedOffline,
  };
}
