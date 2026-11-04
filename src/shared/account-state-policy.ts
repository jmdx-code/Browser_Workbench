import { isFacebookAvatarURL } from './account-display.js';
import type { Profile } from './contracts.js';
import { isLocalAvatar } from './group-bumper.js';

export const MAX_ACCOUNT_AVATAR_BYTES = 24_576;

export type AccountRestrictionScope = 'global_route' | 'feature_action';

export type CachedAccountRecord = {
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

export function isRenderableAccountAvatar(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  return isLocalAvatar(value) || isFacebookAvatarURL(value);
}

export function isGlobalAbnormalRouteUrl(
  rawUrl: string | null | undefined,
  hasCUserCookie = true,
): 'logged-out' | 'verification' | 'restricted' | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();
    if (/^\/checkpoint(?:\/|$)/.test(path)) return 'verification';
    if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(path)) {
      return 'restricted';
    }
    if (/^\/login(?:\.php|\/|$)/.test(path)) return 'logged-out';
    if (/^\/recover(?:\/|$)/.test(path) && !hasCUserCookie) return 'logged-out';
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
  if (routeAbnormal) {
    return { scope: 'global_route', state: routeAbnormal };
  }
  if (input.hasLoginForm && !(input.hasCUserCookie ?? false)) {
    return { scope: 'global_route', state: 'logged-out' };
  }
  return { scope: 'feature_action', state: null };
}

export function mergeAccountCacheUpdate(input: {
  existing: CachedAccountRecord | undefined;
  incoming: AccountCacheUpdateInput;
  nowMs?: number;
}): {
  next: CachedAccountRecord;
  changed: boolean;
} {
  const nowMs = input.nowMs ?? Date.now();
  const { existing, incoming } = input;

  if (
    incoming.scope === 'feature_action' &&
    incoming.state &&
    ['restricted', 'verification', 'logged-out'].includes(incoming.state)
  ) {
    const fallback: CachedAccountRecord = existing ?? {
      state: 'unknown',
      id: null,
      name: null,
      avatar: null,
      avatarUpdatedAt: 0,
    };
    return { next: { ...fallback }, changed: false };
  }

  let nextState: Profile['account']['state'];
  if (incoming.liveConfirmedLoggedIn || incoming.state === 'logged-in') {
    nextState = 'logged-in';
  } else if (incoming.state && incoming.state !== 'unknown') {
    nextState = incoming.state;
  } else {
    nextState = existing?.state ?? 'unknown';
  }

  const incomingId =
    incoming.id !== undefined && incoming.id !== null && String(incoming.id).trim()
      ? String(incoming.id).trim()
      : null;
  const existingId = existing?.id ?? null;
  const identityChanged = Boolean(incomingId && existingId && incomingId !== existingId);
  const nextId = incomingId ?? existingId;

  const incomingName =
    incoming.name !== undefined && incoming.name !== null && String(incoming.name).trim()
      ? String(incoming.name).trim()
      : null;
  const nextName = incomingName ?? (identityChanged ? null : (existing?.name ?? null));

  let nextAvatar: string | null = null;
  let nextAvatarUpdatedAt = existing?.avatarUpdatedAt ?? 0;

  const existingAvatar = existing?.avatar ?? null;
  const incomingAvatar = incoming.avatar ?? null;

  if (nextState === 'logged-out') {
    nextAvatar = null;
    nextAvatarUpdatedAt = 0;
  } else if (identityChanged) {
    if (typeof incomingAvatar === 'string' && incomingAvatar.trim()) {
      nextAvatar = incomingAvatar.trim();
      nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
    } else {
      nextAvatar = null;
      nextAvatarUpdatedAt = 0;
    }
  } else if (typeof existingAvatar === 'string' && isLocalAvatar(existingAvatar)) {
    if (typeof incomingAvatar === 'string' && isLocalAvatar(incomingAvatar)) {
      const trimmed = incomingAvatar.trim();
      if (trimmed !== existingAvatar) {
        nextAvatar = trimmed;
        nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
      } else {
        nextAvatar = existingAvatar;
      }
    } else {
      nextAvatar = existingAvatar;
    }
  } else if (['restricted', 'verification'].includes(nextState)) {
    if (typeof incomingAvatar === 'string' && isLocalAvatar(incomingAvatar)) {
      nextAvatar = incomingAvatar.trim();
      nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
    } else {
      nextAvatar = null;
      nextAvatarUpdatedAt = 0;
    }
  } else if (incoming.avatar === null) {
    if (nextState === 'logged-in' && !identityChanged && existingAvatar) {
      nextAvatar = existingAvatar;
    } else {
      nextAvatar = null;
      nextAvatarUpdatedAt = 0;
    }
  } else if (typeof incomingAvatar === 'string' && incomingAvatar.trim()) {
    const trimmed = incomingAvatar.trim();
    nextAvatar = trimmed;
    if (trimmed !== existingAvatar) {
      nextAvatarUpdatedAt = incoming.avatarUpdatedAt ?? nowMs;
    } else if (incoming.avatarUpdatedAt !== undefined) {
      nextAvatarUpdatedAt = incoming.avatarUpdatedAt;
    }
  } else {
    nextAvatar = existingAvatar;
  }

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
