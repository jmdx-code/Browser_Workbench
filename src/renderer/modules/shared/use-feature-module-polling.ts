import { useCallback, useEffect, useRef, useState } from 'react';
import type { BumperState } from '../../../shared/group-bumper.js';
import type { BluestacksState } from '../../../shared/bluestacks.js';
import type { AutoSchedulerState } from '../../../shared/auto-scheduler.js';
import type { GoogleSheetsOverview } from '../../../shared/google-sheets.js';
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
  const [bluestacks, setBluestacks] = useState<BluestacksState | null>(null);
  const [autoScheduler, setAutoScheduler] = useState<AutoSchedulerState | null>(null);
  const [googleSheets, setGoogleSheets] = useState<GoogleSheetsOverview | null>(null);
  const [windowVisible, setWindowVisible] = useState<boolean>(() =>
    typeof document !== 'undefined' ? !document.hidden : true,
  );
  const prevInviterRunningRef = useRef<boolean>(false);
  const prevBluestacksRunningRef = useRef<boolean>(false);
  const prevBluestacksPageRunningRef = useRef<boolean>(false);

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
    const runningNow = Boolean(bluestacks?.running);
    if (
      prevBluestacksRunningRef.current &&
      !runningNow &&
      bluestacks?.bumperSettings?.enableSound
    ) {
      playInviterCompletionChime();
    }
    prevBluestacksRunningRef.current = runningNow;
  }, [bluestacks]);

  useEffect(() => {
    const runningNow = Boolean(bluestacks?.pageBumperRunning);
    if (
      prevBluestacksPageRunningRef.current &&
      !runningNow &&
      bluestacks?.pageBumperSettings?.enableSound
    ) {
      playInviterCompletionChime();
    }
    prevBluestacksPageRunningRef.current = runningNow;
  }, [bluestacks]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => setWindowVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const mountedRef = useRef(true);
  const controllersRef = useRef<{
    bumper: AbortController | null;
    inviter: AbortController | null;
    poster: AbortController | null;
    bluestacks: AbortController | null;
    autoScheduler: AbortController | null;
    googleSheets: AbortController | null;
  }>({
    bumper: null,
    inviter: null,
    poster: null,
    bluestacks: null,
    autoScheduler: null,
    googleSheets: null,
  });
  const epochsRef = useRef({
    bumper: 0,
    inviter: 0,
    poster: 0,
    bluestacks: 0,
    autoScheduler: 0,
    googleSheets: 0,
  });
  const lastSigRef = useRef<Record<keyof typeof epochsRef.current, string | null>>({
    bumper: null,
    inviter: null,
    poster: null,
    bluestacks: null,
    autoScheduler: null,
    googleSheets: null,
  });

  useEffect(() => {
    mountedRef.current = true;
    const ctrls = controllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const key of Object.keys(ctrls) as Array<keyof typeof ctrls>) {
        ctrls[key]?.abort();
        ctrls[key] = null;
      }
    };
  }, []);

  const commitAuthoritative = useCallback(
    <K extends keyof typeof epochsRef.current, T>(key: K, setter: (next: T) => void, next: T) => {
      epochsRef.current[key] += 1;
      controllersRef.current[key]?.abort();
      controllersRef.current[key] = null;
      lastSigRef.current[key] = JSON.stringify(next);
      setter(next);
    },
    [],
  );

  const setGroupBumperAuth = useCallback(
    (next: BumperState | null) => commitAuthoritative('bumper', setGroupBumper, next),
    [commitAuthoritative],
  );
  const setGroupInviterAuth = useCallback(
    (next: GroupInviterState | null) => commitAuthoritative('inviter', setGroupInviter, next),
    [commitAuthoritative],
  );
  const setGroupPosterAuth = useCallback(
    (next: PosterState | null) => commitAuthoritative('poster', setGroupPoster, next),
    [commitAuthoritative],
  );
  const setBluestacksAuth = useCallback(
    (next: BluestacksState | null) => commitAuthoritative('bluestacks', setBluestacks, next),
    [commitAuthoritative],
  );
  const setAutoSchedulerAuth = useCallback(
    (next: AutoSchedulerState | null) =>
      commitAuthoritative('autoScheduler', setAutoScheduler, next),
    [commitAuthoritative],
  );
  const setGoogleSheetsAuth = useCallback(
    (next: GoogleSheetsOverview | null) =>
      commitAuthoritative('googleSheets', setGoogleSheets, next),
    [commitAuthoritative],
  );

  const refreshBumper = useCallback(() => {
    if (controllersRef.current.bumper) return;
    const ctrl = new AbortController();
    controllersRef.current.bumper = ctrl;
    const epoch = epochsRef.current.bumper;
    void api
      .bumperState(ctrl.signal)
      .then((next) => {
        if (!mountedRef.current || ctrl.signal.aborted || epochsRef.current.bumper !== epoch)
          return;
        const sig = JSON.stringify(next);
        if (sig !== lastSigRef.current.bumper) {
          lastSigRef.current.bumper = sig;
          setGroupBumper(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (controllersRef.current.bumper === ctrl) controllersRef.current.bumper = null;
      });
  }, []);

  const refreshGroupInviter = useCallback(async () => {
    if (controllersRef.current.inviter) return;
    const ctrl = new AbortController();
    controllersRef.current.inviter = ctrl;
    const epoch = epochsRef.current.inviter;
    await api
      .groupInviterState(ctrl.signal)
      .then((next) => {
        if (!mountedRef.current || ctrl.signal.aborted || epochsRef.current.inviter !== epoch)
          return;
        const sig = JSON.stringify(next);
        if (sig !== lastSigRef.current.inviter) {
          lastSigRef.current.inviter = sig;
          setGroupInviter(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (controllersRef.current.inviter === ctrl) controllersRef.current.inviter = null;
        if (mountedRef.current) setGroupInviterLoaded(true);
      });
  }, []);

  const refreshPoster = useCallback(() => {
    if (controllersRef.current.poster) return;
    const ctrl = new AbortController();
    controllersRef.current.poster = ctrl;
    const epoch = epochsRef.current.poster;
    void api
      .posterState(ctrl.signal)
      .then((next) => {
        if (!mountedRef.current || ctrl.signal.aborted || epochsRef.current.poster !== epoch)
          return;
        const sig = JSON.stringify(next);
        if (sig !== lastSigRef.current.poster) {
          lastSigRef.current.poster = sig;
          setGroupPoster(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (controllersRef.current.poster === ctrl) controllersRef.current.poster = null;
      });
  }, []);

  const refreshBluestacks = useCallback((force = false) => {
    if (!force && controllersRef.current.bluestacks) return;
    if (force && controllersRef.current.bluestacks) {
      controllersRef.current.bluestacks.abort();
      controllersRef.current.bluestacks = null;
    }
    const ctrl = new AbortController();
    controllersRef.current.bluestacks = ctrl;
    const epoch = ++epochsRef.current.bluestacks;
    void api
      .bluestacksState(force, ctrl.signal)
      .then((next) => {
        if (!mountedRef.current || ctrl.signal.aborted || epochsRef.current.bluestacks !== epoch)
          return;
        const sig = JSON.stringify(next);
        if (force || sig !== lastSigRef.current.bluestacks) {
          lastSigRef.current.bluestacks = sig;
          setBluestacks(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (controllersRef.current.bluestacks === ctrl) controllersRef.current.bluestacks = null;
      });
  }, []);

  const refreshAutoScheduler = useCallback(() => {
    if (controllersRef.current.autoScheduler) return;
    const ctrl = new AbortController();
    controllersRef.current.autoScheduler = ctrl;
    const epoch = epochsRef.current.autoScheduler;
    void api
      .autoSchedulerState(ctrl.signal)
      .then((next) => {
        if (!mountedRef.current || ctrl.signal.aborted || epochsRef.current.autoScheduler !== epoch)
          return;
        const sig = JSON.stringify(next);
        if (sig !== lastSigRef.current.autoScheduler) {
          lastSigRef.current.autoScheduler = sig;
          setAutoScheduler(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (controllersRef.current.autoScheduler === ctrl)
          controllersRef.current.autoScheduler = null;
      });
  }, []);

  const refreshGoogleSheets = useCallback(() => {
    if (controllersRef.current.googleSheets) return;
    const ctrl = new AbortController();
    controllersRef.current.googleSheets = ctrl;
    const epoch = epochsRef.current.googleSheets;
    void api
      .googleSheetsOverview(ctrl.signal)
      .then((next) => {
        if (!mountedRef.current || ctrl.signal.aborted || epochsRef.current.googleSheets !== epoch)
          return;
        const sig = JSON.stringify(next);
        if (sig !== lastSigRef.current.googleSheets) {
          lastSigRef.current.googleSheets = sig;
          setGoogleSheets(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (controllersRef.current.googleSheets === ctrl)
          controllersRef.current.googleSheets = null;
      });
  }, []);

  // Initial bootstrap load once on mount
  useEffect(() => {
    refreshBumper();
    void refreshGroupInviter();
    refreshPoster();
    refreshBluestacks(false);
    refreshAutoScheduler();
    refreshGoogleSheets();
  }, [
    refreshBumper,
    refreshGroupInviter,
    refreshPoster,
    refreshBluestacks,
    refreshAutoScheduler,
    refreshGoogleSheets,
  ]);

  const isBluestacksView = viewKind.startsWith('bluestacks-');

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
    isBluestacksView ||
    viewKind === 'records' ||
    bumperBusy;

  useEffect(() => {
    if (
      viewKind === 'group-bumper' ||
      viewKind === 'page-bumper' ||
      isBluestacksView ||
      viewKind === 'auto-scheduler' ||
      viewKind === 'records'
    ) {
      refreshBumper();
    }
    if (!bumperActive) return;
    const intervalMs = windowVisible
      ? viewKind === 'group-bumper' || viewKind === 'page-bumper' || isBluestacksView || bumperBusy
        ? 2000
        : 6000
      : 10000;
    const timer = setInterval(refreshBumper, intervalMs);
    return () => clearInterval(timer);
  }, [viewKind, isBluestacksView, bumperActive, windowVisible, bumperBusy, refreshBumper]);

  // Inviter polling
  const inviterBusy = Boolean(groupInviter?.running || groupInviter?.groupAvatarRefreshing);
  const inviterActive =
    viewKind === 'group-inviter' ||
    viewKind === 'bluestacks-group-inviter' ||
    viewKind === 'records' ||
    inviterBusy;

  useEffect(() => {
    if (
      viewKind === 'group-inviter' ||
      viewKind === 'bluestacks-group-inviter' ||
      viewKind === 'records'
    ) {
      void refreshGroupInviter();
    }
    if (!inviterActive) return;
    const intervalMs = windowVisible
      ? viewKind === 'group-inviter' || viewKind === 'bluestacks-group-inviter' || inviterBusy
        ? 2000
        : 6000
      : 10000;
    const timer = setInterval(() => void refreshGroupInviter(), intervalMs);
    return () => clearInterval(timer);
  }, [viewKind, inviterActive, windowVisible, inviterBusy, refreshGroupInviter]);

  // Poster polling
  const posterBusy = Boolean(groupPoster?.running || groupPoster?.groupAvatarRefreshing);
  const posterActive =
    viewKind === 'group-poster' ||
    viewKind === 'bluestacks-group-poster' ||
    viewKind === 'records' ||
    posterBusy;

  useEffect(() => {
    if (
      viewKind === 'group-poster' ||
      viewKind === 'bluestacks-group-poster' ||
      viewKind === 'auto-scheduler' ||
      viewKind === 'records'
    ) {
      refreshPoster();
    }
    if (!posterActive) return;
    const intervalMs = windowVisible
      ? viewKind === 'group-poster' || viewKind === 'bluestacks-group-poster' || posterBusy
        ? 2000
        : 6000
      : 10000;
    const timer = setInterval(refreshPoster, intervalMs);
    return () => clearInterval(timer);
  }, [viewKind, posterActive, windowVisible, posterBusy, refreshPoster]);

  // BlueStacks polling
  const bluestacksBusy = Boolean(
    bluestacks?.running ||
    bluestacks?.pageBumperRunning ||
    bluestacks?.activeRunning ||
    bluestacks?.posterRunning ||
    bluestacks?.inviterRunning ||
    bluestacks?.batchLogin?.running ||
    bluestacks?.healthCheck?.running ||
    (bluestacks?.launchingIds.length ?? 0) > 0 ||
    (bluestacks?.closingIds.length ?? 0) > 0 ||
    (bluestacks?.inspectingIds.length ?? 0) > 0 ||
    (bluestacks?.installingIds?.length ?? 0) > 0 ||
    (bluestacks?.loggingInIds?.length ?? 0) > 0 ||
    (bluestacks?.switchingIds?.length ?? 0) > 0,
  );
  const bluestacksActive = isBluestacksView || viewKind === 'records' || bluestacksBusy;

  useEffect(() => {
    if (isBluestacksView || viewKind === 'records') {
      refreshBluestacks(false);
    }
    if (!bluestacksActive) return;
    const intervalMs = windowVisible ? (isBluestacksView || bluestacksBusy ? 1800 : 6000) : 10000;
    const timer = setInterval(() => refreshBluestacks(false), intervalMs);
    return () => clearInterval(timer);
  }, [
    viewKind,
    isBluestacksView,
    bluestacksActive,
    windowVisible,
    bluestacksBusy,
    refreshBluestacks,
  ]);

  // Auto-scheduler polling (use primitive boolean dep so schedule array identity never triggers infinite loop!)
  const schedulerBusy = Boolean(autoScheduler?.running);
  const schedulerHasEnabled = Boolean(autoScheduler?.schedules.some((s) => s.enabled));
  useEffect(() => {
    if (viewKind === 'auto-scheduler') {
      refreshAutoScheduler();
      refreshBumper();
      refreshPoster();
      refreshBluestacks(false);
    }
    const hasEnabled = schedulerHasEnabled || schedulerBusy;
    if (viewKind !== 'auto-scheduler' && !hasEnabled) return;
    const intervalMs = windowVisible
      ? viewKind === 'auto-scheduler' || schedulerBusy
        ? 2500
        : 12000
      : 15000;
    const timer = setInterval(refreshAutoScheduler, intervalMs);
    return () => clearInterval(timer);
  }, [
    viewKind,
    windowVisible,
    schedulerBusy,
    schedulerHasEnabled,
    refreshAutoScheduler,
    refreshBumper,
    refreshPoster,
    refreshBluestacks,
  ]);

  // Google Sheets polling
  const isSheetsView = viewKind.startsWith('sheets-');
  const sheetsBusy = Boolean(
    (googleSheets?.runningScheduleCount ?? 0) > 0 ||
    (googleSheets?.runningRecordsCount ?? 0) > 0 ||
    (googleSheets?.activeProfiles?.length ?? 0) > 0,
  );
  const sheetsHasEnabled = Boolean(
    googleSheets?.links.some(
      (l) =>
        l.enabled &&
        ((l.kind === 'post_schedule' && l.scheduleConfig?.enabled) ||
          (l.kind === 'post_records' && l.recordsConfig?.enabled)),
    ),
  );
  useEffect(() => {
    if (isSheetsView) {
      refreshGoogleSheets();
    }
    if (!isSheetsView && !sheetsBusy && !sheetsHasEnabled) return;
    const intervalMs = windowVisible ? (isSheetsView || sheetsBusy ? 3000 : 12000) : 15000;
    const timer = setInterval(refreshGoogleSheets, intervalMs);
    return () => clearInterval(timer);
  }, [isSheetsView, windowVisible, sheetsBusy, sheetsHasEnabled, refreshGoogleSheets]);

  return {
    groupBumper,
    setGroupBumper: setGroupBumperAuth,
    refreshBumper,
    groupInviter,
    setGroupInviter: setGroupInviterAuth,
    groupInviterLoaded,
    refreshGroupInviter,
    groupPoster,
    setGroupPoster: setGroupPosterAuth,
    refreshPoster,
    bluestacks,
    setBluestacks: setBluestacksAuth,
    refreshBluestacks,
    autoScheduler,
    setAutoScheduler: setAutoSchedulerAuth,
    refreshAutoScheduler,
    googleSheets,
    setGoogleSheets: setGoogleSheetsAuth,
    refreshGoogleSheets,
  };
}
