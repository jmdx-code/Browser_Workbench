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
  const admittedProfileIds: string[] = [];
  const alreadyRunningIds: string[] = [];
  const skippedBusy: Array<{ profileId: string; reason: string; labels: string[] }> = [];
  const skippedOffline: Array<{ profileId: string; reason: string }> = [];

  for (const profileId of new Set(input.requestedProfileIds)) {
    if (await input.isAlreadyRunningInCurrentModule?.(profileId)) {
      alreadyRunningIds.push(profileId);
      continue;
    }
    const labels = (await input.busyModuleLabelsForProfile?.(profileId)) ?? [];
    if (labels.length > 0 || (await input.isProfileBusyInOtherModule?.(profileId))) {
      skippedBusy.push({
        profileId,
        labels,
        reason:
          labels.length > 0 ? `跳过：正在运行「${labels.join(' / ')}」` : '跳过：正在执行其他任务',
      });
      continue;
    }
    if (!(await input.isProfileReady(profileId))) {
      skippedOffline.push({ profileId, reason: '跳过：浏览器未连接' });
      continue;
    }
    admittedProfileIds.push(profileId);
  }
  return { admittedProfileIds, alreadyRunningIds, skippedBusy, skippedOffline };
}
