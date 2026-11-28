import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutoSchedulerState } from '../../../shared/auto-scheduler.js';
import type { BluestacksState } from '../../../shared/bluestacks.js';
import type { GoogleSheetsOverview } from '../../../shared/google-sheets.js';
import type { BumperState } from '../../../shared/group-bumper.js';
import type { GroupInviterState } from '../../../shared/group-inviter.js';
import type { PosterState } from '../../../shared/group-poster.js';
import { api } from '../../api.js';
function playInviterCompletionChime(): void {
  try {
    if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
    const ctx = new window.AudioContext(),
      now = ctx.currentTime,
      osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.setValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
    osc.onended = () => void ctx.close().catch(() => {});
  } catch {}
}
function useChimeOnComplete(running: boolean, enabled: boolean) {
  const prev = useRef(false);
  useEffect(() => {
    if (prev.current && !running && enabled) playInviterCompletionChime();
    prev.current = running;
  }, [running, enabled]);
}
function usePollInterval(fetchNow: boolean, poll: boolean, ms: number, refresh: () => void) {
  useEffect(() => {
    if (fetchNow) refresh();
    if (!poll) return;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [fetchNow, poll, ms, refresh]);
}
function usePolledModule<T>(fetcher: (s: AbortSignal) => Promise<T>, onFinally?: () => void) {
  const [state, setState] = useState<T | null>(null);
  const ctrlRef = useRef<AbortController | null>(null),
    epochRef = useRef(0),
    sigRef = useRef<string | null>(null),
    mountedRef = useRef(true),
    finallyRef = useRef(onFinally);
  finallyRef.current = onFinally;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ctrlRef.current?.abort();
      ctrlRef.current = null;
    };
  }, []);
  const commit = useCallback((next: T | null) => {
    epochRef.current += 1;
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    sigRef.current = JSON.stringify(next);
    setState(next);
  }, []);
  const refresh = useCallback(
    (force = false): Promise<void> => {
      if (!force && ctrlRef.current) return Promise.resolve();
      if (force && ctrlRef.current) {
        ctrlRef.current.abort();
        ctrlRef.current = null;
      }
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const epoch = force ? ++epochRef.current : epochRef.current;
      return fetcher(ctrl.signal)
        .then((next) => {
          if (!mountedRef.current || ctrl.signal.aborted || epochRef.current !== epoch) return;
          const sig = JSON.stringify(next);
          if (force || sig !== sigRef.current) {
            sigRef.current = sig;
            setState(next);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (ctrlRef.current === ctrl) ctrlRef.current = null;
          if (mountedRef.current) finallyRef.current?.();
        });
    },
    [fetcher],
  );
  const trigger = useCallback(() => void refresh(false), [refresh]);
  return [state, commit, trigger, refresh] as const;
}
export function useFeatureModulesPolling(viewKind: string, sseConnected = false) {
  const [groupInviterLoaded, setGroupInviterLoaded] = useState(false),
    [serverActiveModules, setServerActiveModules] = useState<readonly string[]>([]),
    [windowVisible, setWindowVisible] = useState(() =>
      typeof document !== 'undefined' ? !document.hidden : true,
    );
  const [groupBumper, setGroupBumper, refreshBumper] = usePolledModule<BumperState>(
    api.bumperState,
  );
  const [groupInviter, setGroupInviter, refreshInviterSync, fetchInviter] =
    usePolledModule<GroupInviterState>(api.groupInviterState, () => setGroupInviterLoaded(true));
  const [groupPoster, setGroupPoster, refreshPoster] = usePolledModule<PosterState>(
    api.posterState,
  );
  const bsFetcher = useCallback((s: AbortSignal) => api.bluestacksState(false, s), []);
  const [bluestacks, setBluestacks, refreshBsIdle, fetchBs] =
    usePolledModule<BluestacksState>(bsFetcher);
  const [autoScheduler, setAutoScheduler, refreshAutoScheduler] =
    usePolledModule<AutoSchedulerState>(api.autoSchedulerState);
  const [googleSheets, setGoogleSheets, refreshGoogleSheets] =
    usePolledModule<GoogleSheetsOverview>(api.googleSheetsOverview);
  const refreshGroupInviter = useCallback(() => fetchInviter(false), [fetchInviter]);
  const refreshBluestacks = useCallback(
    (force = false) =>
      void (force
        ? api
            .bluestacksState(true, new AbortController().signal)
            .then(setBluestacks)
            .catch(() => {})
        : fetchBs(false)),
    [setBluestacks, fetchBs],
  );
  useChimeOnComplete(
    Boolean(groupInviter?.running),
    groupInviter !== null && groupInviter.playSoundOnComplete !== false,
  );
  useChimeOnComplete(
    Boolean(bluestacks?.running),
    Boolean(bluestacks?.bumperSettings?.enableSound),
  );
  useChimeOnComplete(
    Boolean(bluestacks?.pageBumperRunning),
    Boolean(bluestacks?.pageBumperSettings?.enableSound),
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setWindowVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    for (const fn of [
      refreshBumper,
      refreshPoster,
      refreshBsIdle,
      refreshAutoScheduler,
      refreshGoogleSheets,
    ])
      fn();
    void refreshGroupInviter();
  }, [
    refreshBumper,
    refreshGroupInviter,
    refreshPoster,
    refreshBsIdle,
    refreshAutoScheduler,
    refreshGoogleSheets,
  ]);
  const prevActiveSigRef = useRef(''),
    mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const pollSummary = useCallback((signal?: AbortSignal) => {
    if (typeof api.runtimeSummary !== 'function') return Promise.resolve();
    return api
      .runtimeSummary(signal)
      .then((res) => {
        if (!mountedRef.current || signal?.aborted) return;
        const sorted = [...res.activeModules].sort(),
          sig = sorted.join(',');
        if (sig !== prevActiveSigRef.current) {
          prevActiveSigRef.current = sig;
          setServerActiveModules(sorted);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (typeof api.runtimeSummary !== 'function') return;
    let inFlight: AbortController | null = null;
    const run = () => {
      if (inFlight) return;
      const ctrl = new AbortController();
      inFlight = ctrl;
      void pollSummary(ctrl.signal).finally(() => {
        if (inFlight === ctrl) inFlight = null;
      });
    };
    run();
    const timer = setInterval(
      run,
      sseConnected ? (windowVisible ? 25_000 : 35_000) : windowVisible ? 3500 : 10_000,
    );
    return () => {
      inFlight?.abort();
      clearInterval(timer);
    };
  }, [windowVisible, sseConnected, pollSummary]);
  const hasMod = (id: string) => serverActiveModules.includes(id);
  const sBumper = hasMod('group-bumper') || hasMod('page-bumper'),
    sInviter = hasMod('group-inviter'),
    sPoster = hasMod('group-poster'),
    sBs = serverActiveModules.some((id) => id.startsWith('bluestacks-')),
    sSched = hasMod('auto-scheduler'),
    sSheets = hasMod('google-sheets');
  const isBsView = viewKind.startsWith('bluestacks-'),
    isLayoutView = viewKind === 'window-layout',
    isSheetsView = viewKind.startsWith('sheets-') || viewKind === 'records',
    isSchedView = viewKind === 'auto-scheduler',
    fastMs = (fast: boolean, activeMs = 2000, idleMs = 6000) =>
      sseConnected ? 15_000 : windowVisible ? (fast ? activeMs : idleMs) : 10_000;
  const bumperBusy = Boolean(
    groupBumper?.running ||
    groupBumper?.pageBumperRunning ||
    groupBumper?.groupAvatarRefreshing ||
    groupBumper?.pageAvatarRefreshing ||
    sBumper,
  );
  const bumperView = viewKind === 'group-bumper' || viewKind === 'page-bumper' || isBsView;
  const inviterBusy = Boolean(
    groupInviter?.running || groupInviter?.groupAvatarRefreshing || sInviter,
  );
  const inviterView = viewKind === 'group-inviter' || viewKind === 'bluestacks-group-inviter';
  const posterBusy = Boolean(groupPoster?.running || groupPoster?.groupAvatarRefreshing || sPoster);
  const posterView = viewKind === 'group-poster' || viewKind === 'bluestacks-group-poster';
  const bsBusy = Boolean(
    bluestacks?.running ||
    bluestacks?.pageBumperRunning ||
    bluestacks?.activeRunning ||
    bluestacks?.posterRunning ||
    bluestacks?.inviterRunning ||
    bluestacks?.batchLogin?.running ||
    bluestacks?.healthCheck?.running ||
    [
      bluestacks?.launchingIds,
      bluestacks?.closingIds,
      bluestacks?.inspectingIds,
      bluestacks?.installingIds,
      bluestacks?.loggingInIds,
      bluestacks?.switchingIds,
    ].some((a) => (a?.length ?? 0) > 0) ||
    sBs,
  );
  const schedBusy = Boolean(autoScheduler?.running || sSched),
    schedEnabled = Boolean(autoScheduler?.schedules.some((s) => s.enabled));
  const sheetsBusy = Boolean(
    (googleSheets?.runningScheduleCount ?? 0) > 0 ||
    (googleSheets?.runningRecordsCount ?? 0) > 0 ||
    (googleSheets?.activeProfiles?.length ?? 0) > 0 ||
    sSheets,
  );
  const sheetsEnabled = Boolean(
    googleSheets?.links.some(
      (l) =>
        l.enabled &&
        ((l.kind === 'post_schedule' && l.scheduleConfig?.enabled) ||
          (l.kind === 'post_records' && l.recordsConfig?.enabled)),
    ),
  );
  for (const [fetchNow, poll, ms, fn] of [
    [
      bumperView || isSchedView || viewKind === 'records' || sBumper,
      bumperView || viewKind === 'records' || bumperBusy,
      fastMs(bumperView || bumperBusy),
      refreshBumper,
    ],
    [
      inviterView || viewKind === 'records' || sInviter,
      inviterView || viewKind === 'records' || inviterBusy,
      fastMs(inviterView || inviterBusy),
      refreshInviterSync,
    ],
    [
      posterView || isSchedView || viewKind === 'records' || sPoster,
      posterView || viewKind === 'records' || posterBusy,
      fastMs(posterView || posterBusy),
      refreshPoster,
    ],
    [
      isBsView || isLayoutView || isSchedView || viewKind === 'records' || sBs,
      isBsView || isLayoutView || viewKind === 'records' || bsBusy,
      fastMs(isBsView || isLayoutView || bsBusy, 1800),
      refreshBsIdle,
    ],
    [
      isSchedView || sSched,
      isSchedView || schedEnabled || schedBusy,
      sseConnected ? 20_000 : windowVisible ? (isSchedView || schedBusy ? 2500 : 12_000) : 15_000,
      refreshAutoScheduler,
    ],
    [
      isSheetsView || sSheets,
      isSheetsView || sheetsBusy || sheetsEnabled,
      sseConnected ? 20_000 : windowVisible ? (isSheetsView || sheetsBusy ? 3000 : 12_000) : 15_000,
      refreshGoogleSheets,
    ],
  ] as const)
    usePollInterval(fetchNow, poll, ms, fn);
  return {
    groupBumper,
    setGroupBumper,
    refreshBumper,
    groupInviter,
    setGroupInviter,
    groupInviterLoaded,
    refreshGroupInviter,
    groupPoster,
    setGroupPoster,
    refreshPoster,
    bluestacks,
    setBluestacks,
    refreshBluestacks,
    autoScheduler,
    setAutoScheduler,
    refreshAutoScheduler,
    googleSheets,
    setGoogleSheets,
    refreshGoogleSheets,
    refreshRuntimeSummaryNow: useCallback(() => void pollSummary(), [pollSummary]),
  };
}
