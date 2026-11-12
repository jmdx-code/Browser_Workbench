import { z } from 'zod';
import { Id } from './contracts.js';

export const BrowserBrand = z.enum(['chrome', 'brave', 'edge']);
export type BrowserBrand = z.infer<typeof BrowserBrand>;

export const ProfileLaunchBinding = z.strictObject({
  profileId: Id,
  browserKind: BrowserBrand,
  executablePath: z.string().min(1).max(1024),
  userDataDir: z.string().min(1).max(1024),
  profileDirectory: z.string().regex(/^(Default|Profile \d+)$/),
  browserName: z.string().min(1).max(200),
  windowName: z.string().min(1).max(1400),
  verifiedAt: z.number().int().nonnegative(),
});
export type ProfileLaunchBinding = z.infer<typeof ProfileLaunchBinding>;

export function formatBrowserWindowName(
  browserKind: BrowserBrand,
  profileDirectory: string,
  userDataDir: string,
): string {
  const brandLabel = browserKind === 'brave' ? 'Brave' : browserKind === 'edge' ? 'Edge' : 'Chrome';
  return `${brandLabel}_${profileDirectory}_${userDataDir.replace(/\\/g, '|')}`;
}

export function buildNormalBrowserLaunchArgs(binding: {
  browserKind: BrowserBrand;
  profileDirectory: string;
  userDataDir: string;
  windowName?: string | undefined;
}): string[] {
  const windowName =
    binding.windowName && binding.windowName.trim()
      ? binding.windowName.trim()
      : formatBrowserWindowName(binding.browserKind, binding.profileDirectory, binding.userDataDir);
  return [
    `--profile-directory=${binding.profileDirectory}`,
    `--user-data-dir=${binding.userDataDir}`,
    `--window-name=${windowName}`,
  ];
}

export interface ProfileLifecycleItemResult {
  profileId: string;
  browserName: string | null;
  action: 'open' | 'close' | 'restart' | 'status';
  ok: boolean;
  alreadyInTargetState?: boolean | undefined;
  online: boolean;
  phase: string;
  synced: boolean;
  launchable: boolean;
  browserKind?: BrowserBrand | null | undefined;
  profileDirectory?: string | null | undefined;
  elapsedMs: number;
  errorCode?: string | undefined;
  reason?: string | undefined;
}

export interface EnsureProfilesOnlineResult {
  requestedIds: string[];
  readyIds: string[];
  launchedIds: string[];
  failed: Array<{
    profileId: string;
    errorCode: string;
    reason: string;
  }>;
  items: ProfileLifecycleItemResult[];
}

export interface ProfileLifecyclePort {
  isLaunching(profileId: string): boolean;
  getStatus(profileIds: readonly string[]): Promise<ProfileLifecycleItemResult[]>;
  launchProfile(
    profileId: string,
    options?: { timeoutMs?: number | undefined },
  ): Promise<ProfileLifecycleItemResult>;
  closeProfile(
    profileId: string,
    options?: { timeoutMs?: number | undefined; stopTasksFirst?: boolean | undefined },
  ): Promise<ProfileLifecycleItemResult>;
  restartProfile(
    profileId: string,
    options?: {
      closeTimeoutMs?: number | undefined;
      openTimeoutMs?: number | undefined;
    },
  ): Promise<ProfileLifecycleItemResult>;
  ensureProfilesOnline(
    profileIds: readonly string[],
    options?: { timeoutMs?: number | undefined; maxParallelLaunches?: number | undefined },
  ): Promise<EnsureProfilesOnlineResult>;
}
