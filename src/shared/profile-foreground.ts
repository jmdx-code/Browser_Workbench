export function profileForegroundGranted(
  peer: {
    online: boolean;
    synced: boolean;
    capabilities?: readonly string[];
    profileWindowFocused?: boolean;
    focusedWindowAt?: number;
  },
  now = Date.now(),
): boolean {
  const at = peer.focusedWindowAt;
  return (
    peer.online &&
    peer.synced &&
    peer.capabilities?.includes('profile-foreground-v1') === true &&
    peer.profileWindowFocused === true &&
    at !== undefined &&
    Number.isFinite(at) &&
    now >= at &&
    now - at <= 3000
  );
}
