import { isFacebookAvatarURL } from './account-display.js';
import { isExpiredFbCdnUrl } from './activity-stats.js';
import type { Profile } from './contracts.js';
import { isLocalAvatar } from './group-bumper.js';
export const MAX_ACCOUNT_AVATAR_BYTES = 24_576;
export type AccountRestrictionScope = 'global_route' | 'feature_action';
type CachedAccountRecord = {
  state: Profile['account']['state'];
  id: string | null;
  name: string | null;
  avatar: string | null;
  avatarUpdatedAt: number;
};
export interface AccountCacheUpdateInput {
  state?: Profile['account']['state'];
  id?: string | null;
  name?: string | null;
  avatar?: string | null;
  avatarUpdatedAt?: number;
  scope?: AccountRestrictionScope;
  liveConfirmedLoggedIn?: boolean;
}
export const isRenderableAccountAvatar = (value: string | null | undefined): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  (isLocalAvatar(value) || (isFacebookAvatarURL(value) && !isExpiredFbCdnUrl(value)));
export function isGlobalAbnormalRouteUrl(
  rawUrl: string | null | undefined,
  hasCUserCookie = true,
): 'logged-out' | 'verification' | 'restricted' | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    if (/^\/checkpoint(?:\/|$)/.test(path)) return 'verification';
    if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(path))
      return 'restricted';
    if (/^\/login(?:\.php|\/|$)/.test(path) || (/^\/recover(?:\/|$)/.test(path) && !hasCUserCookie))
      return 'logged-out';
    return null;
  } catch {
    return null;
  }
}
export function classifyAccountRestrictionScope(input: {
  url?: string | null;
  hasCUserCookie?: boolean;
  hasLoginForm?: boolean;
}): {
  scope: AccountRestrictionScope;
  state: 'logged-out' | 'verification' | 'restricted' | null;
} {
  const routeAbnormal = isGlobalAbnormalRouteUrl(input.url, input.hasCUserCookie ?? true);
  if (routeAbnormal) return { scope: 'global_route', state: routeAbnormal };
  if (input.hasLoginForm && !(input.hasCUserCookie ?? false))
    return { scope: 'global_route', state: 'logged-out' };
  return { scope: 'feature_action', state: null };
}
export function mergeAccountCacheUpdate(input: {
  existing: CachedAccountRecord | undefined;
  incoming: AccountCacheUpdateInput;
  nowMs?: number;
}): { next: CachedAccountRecord; changed: boolean } {
  const nowMs = input.nowMs ?? Date.now(),
    { existing, incoming } = input;
  if (
    incoming.scope === 'feature_action' &&
    incoming.state &&
    ['restricted', 'verification', 'logged-out'].includes(incoming.state)
  )
    return {
      next: {
        ...(existing ?? {
          state: 'unknown',
          id: null,
          name: null,
          avatar: null,
          avatarUpdatedAt: 0,
        }),
      },
      changed: false,
    };
  const nextState: Profile['account']['state'] =
    incoming.liveConfirmedLoggedIn || incoming.state === 'logged-in'
      ? 'logged-in'
      : incoming.state && incoming.state !== 'unknown'
        ? incoming.state
        : (existing?.state ?? 'unknown');
  const normOpt = (v: string | null | undefined) =>
    v !== undefined && v !== null && String(v).trim() ? String(v).trim() : null;
  const incomingId = normOpt(incoming.id),
    existingId = existing?.id ?? null,
    identityChanged = Boolean(incomingId && existingId && incomingId !== existingId),
    nextId = incomingId ?? existingId,
    nextName = normOpt(incoming.name) ?? (identityChanged ? null : (existing?.name ?? null));
  let nextAvatar: string | null = null,
    nextAvatarUpdatedAt = existing?.avatarUpdatedAt ?? 0;
  const existingAvatar = existing?.avatar ?? null,
    incomingAvatar = incoming.avatar ?? null;
  const trimValid = (v: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : ''),
    localTrim = (v: string | null) => (typeof v === 'string' && isLocalAvatar(v) ? v.trim() : ''),
    setFreshAvatar = (t: string) => {
      if (t) {
        nextAvatar = t;
        nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
      } else nextAvatarUpdatedAt = 0;
    };
  if (nextState === 'logged-out') nextAvatarUpdatedAt = 0;
  else if (identityChanged) setFreshAvatar(trimValid(incomingAvatar));
  else if (typeof existingAvatar === 'string' && isLocalAvatar(existingAvatar)) {
    const t = localTrim(incomingAvatar);
    nextAvatar = t || existingAvatar;
    if (t && t !== existingAvatar) nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
  } else if (['restricted', 'verification'].includes(nextState))
    setFreshAvatar(localTrim(incomingAvatar));
  else if (incoming.avatar === null) {
    if (nextState === 'logged-in' && existingAvatar) nextAvatar = existingAvatar;
    else nextAvatarUpdatedAt = 0;
  } else if (trimValid(incomingAvatar)) {
    nextAvatar = trimValid(incomingAvatar);
    if (nextAvatar !== existingAvatar) nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
    else if (incoming.avatarUpdatedAt !== undefined) nextAvatarUpdatedAt = incoming.avatarUpdatedAt;
  } else nextAvatar = existingAvatar;
  const changed =
    !existing ||
    existing.state !== nextState ||
    existing.id !== nextId ||
    existing.name !== nextName ||
    existing.avatar !== nextAvatar;
  return {
    next: {
      state: nextState,
      id: nextId,
      name: nextName,
      avatar: nextAvatar,
      avatarUpdatedAt: changed ? nextAvatarUpdatedAt : (existing?.avatarUpdatedAt ?? 0),
    },
    changed,
  };
}
