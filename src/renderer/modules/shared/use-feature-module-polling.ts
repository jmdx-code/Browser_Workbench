import { useCallback, useEffect, useRef, useState } from 'react';
import type { BumperState } from '../../../shared/group-bumper.js';
import type { GroupInviterState } from '../../../shared/group-inviter.js';
import type { PosterState } from '../../../shared/group-poster.js';
import { api } from '../../api.js';

export function playInviterCompletionChime(): void {
  try {
    if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
    const ctx = new window.AudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.setValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
    osc.onended = () => {
      void ctx.close().catch(() => {});
    };
  } catch {
    // Ignore audio context restrictions in headless or muted environments
  }
}

export function useFeatureModulesPolling(viewKind: string) {
  const [groupBumper, setGroupBumper] = useState<BumperState | null>(null);
  const [groupInviter, setGroupInviter] = useState<GroupInviterState | null>(null);
  const [groupInviterLoaded, setGroupInviterLoaded] = useState(false);
  const [groupPoster, setGroupPoster] = useState<PosterState | null>(null);
  const [windowVisible, setWindowVisible] = useState<boolean>(() =>
    typeof document !== 'undefined' ? !document.hidden : true,
  );
  const prevInviterRunningRef = useRef<boolean>(false);

  useEffect(() => {
    const runningNow = Boolean(groupInviter?.running);
    if (
      prevInviterRunningRef.current &&
      !runningNow &&
      groupInviter !== null &&
      groupInviter.playSoundOnComplete !== false
    ) {
      playInviterCompletionChime();
    }
    prevInviterRunningRef.current = runningNow;
  }, [groupInviter]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => setWindowVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const refreshBumper = useCallback(() => {
    void api
      .bumperState()
      .then((next) => setGroupBumper(next))
      .catch(() => {});
  }, []);

  const refreshGroupInviter = useCallback(async () => {
    await api
      .groupInviterState()
      .then(setGroupInviter)
      .catch(() => {})
      .finally(() => setGroupInviterLoaded(true));
  }, []);

  const refreshPoster = useCallback(() => {
    void api
      .posterState()
      .then((next) => setGroupPoster(next))
      .catch(() => {});
  }, []);

  // Initial bootstrap load once on mount
  useEffect(() => {
    refreshBumper();
    void refreshGroupInviter();
    refreshPoster();
  }, [refreshBumper, refreshGroupInviter, refreshPoster]);

  // Bumper polling: 2s when active view or running/refreshing (throttled when hidden); paused when idle & not viewing
  const bumperBusy = Boolean(
    groupBumper?.running ||
    groupBumper?.pageBumperRunning ||
    groupBumper?.groupAvatarRefreshing ||
    groupBumper?.pageAvatarRefreshing,
  );
  const bumperActive =
    viewKind === 'group-bumper' ||
    viewKind === 'page-bumper' ||
    viewKind === 'records' ||
    bumperBusy;

  useEffect(() => {
    if (viewKind === 'group-bumper' || viewKind === 'page-bumper' || viewKind === 'records') {
      refreshBumper();
    }
    if (!bumperActive) return;
    const intervalMs = windowVisible
      ? viewKind === 'group-bumper' || viewKind === 'page-bumper' || bumperBusy
        ? 2000
        : 6000
      : 10000;
    const timer = setInterval(refreshBumper, intervalMs);
    return () => clearInterval(timer);
  }, [viewKind, bumperActive, windowVisible, bumperBusy, refreshBumper]);

  // Inviter polling
  const inviterBusy = Boolean(groupInviter?.running || groupInviter?.groupAvatarRefreshing);
  const inviterActive = viewKind === 'group-inviter' || viewKind === 'records' || inviterBusy;

  useEffect(() => {
    if (viewKind === 'group-inviter' || viewKind === 'records') {
      void refreshGroupInviter();
    }
    if (!inviterActive) return;
    const intervalMs = windowVisible
      ? viewKind === 'group-inviter' || inviterBusy
        ? 2000
        : 6000
      : 10000;
    const timer = setInterval(() => void refreshGroupInviter(), intervalMs);
    return () => clearInterval(timer);
  }, [viewKind, inviterActive, windowVisible, inviterBusy, refreshGroupInviter]);

  // Poster polling
  const posterBusy = Boolean(groupPoster?.running || groupPoster?.groupAvatarRefreshing);
  const posterActive = viewKind === 'group-poster' || viewKind === 'records' || posterBusy;

  useEffect(() => {
    if (viewKind === 'group-poster' || viewKind === 'records') {
      refreshPoster();
    }
    if (!posterActive) return;
    const intervalMs = windowVisible
      ? viewKind === 'group-poster' || posterBusy
        ? 2000
        : 6000
      : 10000;
    const timer = setInterval(refreshPoster, intervalMs);
    return () => clearInterval(timer);
  }, [viewKind, posterActive, windowVisible, posterBusy, refreshPoster]);

  return {
    groupBumper,
    setGroupBumper,
    groupInviter,
    setGroupInviter,
    groupInviterLoaded,
    refreshGroupInviter,
    groupPoster,
    setGroupPoster,
    refreshPoster,
  };
}
