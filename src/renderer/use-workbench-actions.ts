import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '../shared/contracts.js';
import type { TaskCommand } from '../shared/task-contracts.js';
import {
  WorkspaceInvalidationEvent,
  type WorkspaceEventTopic,
} from '../shared/workspace-events.js';
import { api } from './api.js';
import { InspectionReader, type InspectionReadState } from './inspection-reader.js';
import type { LiveRunCard } from './modules/live-runs-drawer.js';
import type { buildWorkbenchProjection } from './modules/profile-activity-projector.js';
import { errMsg } from './modules/shared/module-ui.js';
import type { useFeatureModulesPolling } from './modules/shared/use-feature-module-polling.js';
import type { useTasks } from './use-tasks.js';
import { WorkspaceReader } from './workspace-reader.js';
export type WorkspaceEventListener = (topics: ReadonlySet<WorkspaceEventTopic>) => void;
function usePollingReader<
  R extends { refresh: (force?: boolean) => Promise<void>; dispose: () => void },
>(enabled: boolean, sseConnected: boolean, pollMs: number, create: () => R) {
  const reader = useRef<R | null>(null),
    createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    if (!enabled) return;
    const cur = createRef.current();
    reader.current = cur;
    void cur.refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const schedule = () => {
      if (timer) clearInterval(timer);
      const hidden = typeof document !== 'undefined' && document.hidden;
      timer = setInterval(
        () => void cur.refresh(),
        hidden ? (sseConnected ? 30_000 : 10_000) : sseConnected ? 25_000 : pollMs,
      );
    };
    const onVis = () => {
      schedule();
      if (typeof document !== 'undefined' && !document.hidden) void cur.refresh();
    };
    schedule();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      cur.dispose();
      if (reader.current === cur) reader.current = null;
    };
  }, [enabled, sseConnected, pollMs]);
  return reader;
}
export function useWorkspace(sseConnected = false) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [error, setError] = useState('');
  const reader = usePollingReader(
    true,
    sseConnected,
    1800,
    () =>
      new WorkspaceReader(api.snapshot, (next, fail) => {
        if (next) setWorkspace(next);
        setError(fail);
      }),
  );
  return {
    workspace,
    error,
    refresh: useCallback(
      (force = false) => reader.current?.refresh(force) ?? Promise.resolve(),
      [],
    ),
  };
}
export function useInspections(enabled = true, sseConnected = false) {
  const [state, setState] = useState<InspectionReadState>({
    rows: [],
    available: false,
    error: '',
  });
  const reader = usePollingReader(
    enabled,
    sseConnected,
    2000,
    () =>
      new InspectionReader(
        { read: api.profileInspections, request: api.inspectProfiles },
        setState,
      ),
  );
  const refresh = useCallback(
    (force = false) => reader.current?.refresh(force) ?? Promise.resolve(),
    [],
  );
  const request = useCallback(async (ids: string[]) => {
    if (!reader.current) throw Error('检查服务尚未连接，请稍候。');
    return reader.current.request(ids);
  }, []);
  return { ...state, refresh, request };
}
export function useWorkspaceEvents(onInvalidate: WorkspaceEventListener): { connected: boolean } {
  const [connected, setConnected] = useState(false),
    listenerRef = useRef(onInvalidate);
  listenerRef.current = onInvalidate;
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource !== 'function') return;
    let closed = false,
      source: EventSource | null = null,
      reconnectTimer: ReturnType<typeof setTimeout> | null = null,
      backoffMs = 1000;
    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = backoffMs;
      backoffMs = Math.min(10_000, backoffMs * 2);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
    const connect = () => {
      if (closed) return;
      try {
        source = new EventSource('/api/workspace/events');
      } catch {
        setConnected(false);
        return scheduleReconnect();
      }
      source.addEventListener('ready', () => {
        if (!closed) {
          backoffMs = 1000;
          setConnected(true);
        }
      });
      source.addEventListener('invalidate', (ev) => {
        if (closed || !(ev instanceof MessageEvent) || typeof ev.data !== 'string') return;
        try {
          const p = WorkspaceInvalidationEvent.safeParse(JSON.parse(ev.data) as unknown);
          if (p.success) listenerRef.current(new Set(p.data.topics));
        } catch {}
      });
      source.onerror = () => {
        if (closed) return;
        setConnected(false);
        source?.close();
        source = null;
        scheduleReconnect();
      };
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);
  return { connected };
}
export function useWorkbenchActions(p: {
  mutate: (work: () => Promise<unknown>) => Promise<void>;
  refresh: (force?: boolean) => Promise<void>;
  tasks: ReturnType<typeof useTasks>;
  inspections: {
    request: (ids: string[]) => Promise<Array<{ state: string }>>;
    refresh: (force?: boolean) => Promise<unknown>;
  };
  projection: ReturnType<typeof buildWorkbenchProjection>;
  mods: ReturnType<typeof useFeatureModulesPolling>;
  setMessage: (msg: string) => void;
  liveRunCards: readonly LiveRunCard[];
}) {
  const { mutate, refresh, tasks, inspections, projection, mods, setMessage, liveRunCards } = p;
  const {
    autoScheduler,
    setAutoScheduler,
    setGroupBumper,
    setGroupPoster,
    setGroupInviter,
    setGoogleSheets,
    setBluestacks,
  } = mods;
  const checkProfiles = useCallback(
    (ids: string[]) =>
      void mutate(async () => {
        const queued = (await inspections.request(ids)).filter((r) =>
          ['QUEUED', 'READING'].includes(r.state),
        ).length;
        if (!queued)
          return '暂无可识别的空闲在线浏览器（请确认浏览器已打开 Facebook 且未在执行任务）';
        for (const delay of [1800, 4200])
          setTimeout(() => {
            void inspections.refresh(true);
            void refresh(true);
          }, delay);
        return `已触发识别 ${queued} 个在线浏览器的 FB 账号与头像（自动读取已打开的 Facebook 页面）`;
      }),
    [inspections, mutate, refresh],
  );
  const commandPlans = useCallback(
    (command: TaskCommand['command'], plans: TaskCommand['plans']) =>
      void mutate(async () => {
        const { results } = await tasks.command({ command, plans }),
          bad = results.filter((r) => !r.accepted),
          reasons = [...new Set(bad.map((r) => r.reason))];
        return `${command === 'stop' ? '停止' : command}请求已处理 ${results.length - bad.length} 份；${bad.length} 份未完成${reasons.length ? `（${reasons.join('、')}）` : ''}。实际状态见任务记录。`;
      }),
    [mutate, tasks],
  );
  const stopModules = useCallback(
    async (ids: string[]) => {
      const uniqueIds = [...new Set(ids)];
      const specs: Array<[string, readonly string[], (hit: string[]) => Promise<unknown>]> = [
        [
          '定时排班',
          projection.schedulerRunningIds,
          async (hit) =>
            setAutoScheduler(
              await api.autoSchedulerAction('stop', { targetIds: hit, keepWindowsOpen: true }),
            ),
        ],
        [
          '顶贴',
          projection.bumperRunningIds,
          async (hit) => setGroupBumper(await api.bumperAction('stop', { profileIds: hit })),
        ],
        [
          '小组发帖',
          projection.posterRunningIds,
          async (hit) => setGroupPoster(await api.posterAction('stop', { profileIds: hit })),
        ],
        [
          '小组邀请人',
          projection.inviterRunningIds,
          async (hit) => setGroupInviter(await api.stopGroupInviterProfiles({ profileIds: hit })),
        ],
        [
          '云表任务',
          projection.sheetsRunningIds,
          async (hit) => setGoogleSheets(await api.googleSheetsStopProfiles(hit)),
        ],
      ];
      const jobs = specs
        .map(([label, running, stop]) => ({
          label,
          hit: uniqueIds.filter((id) => running.includes(id)),
          stop,
        }))
        .filter((j) => j.hit.length > 0);
      const settled = await Promise.allSettled(jobs.map((j) => j.stop(j.hit)));
      return {
        uniqueCount: uniqueIds.length,
        failures: settled.flatMap((res, i) =>
          res.status === 'rejected'
            ? [`${jobs[i]?.label ?? '模块'}：${errMsg(res.reason, '失败')}`]
            : [],
        ),
      };
    },
    [
      projection.schedulerRunningIds,
      projection.bumperRunningIds,
      projection.posterRunningIds,
      projection.inviterRunningIds,
      projection.sheetsRunningIds,
      setAutoScheduler,
      setGroupBumper,
      setGroupPoster,
      setGroupInviter,
      setGoogleSheets,
    ],
  );
  const stopProfilesUnified = useCallback(
    (planTargets: TaskCommand['plans'], moduleProfileIds: string[]) =>
      void mutate(async () => {
        const parts: string[] = [],
          failures: string[] = [];
        await Promise.all([
          ...(planTargets.length
            ? [
                tasks
                  .command({ command: 'stop', plans: planTargets })
                  .then(({ results }) => {
                    const bad = results.filter((r) => !r.accepted),
                      reasons = [...new Set(bad.map((r) => r.reason))];
                    parts.push(
                      `活跃任务已处理 ${results.length - bad.length} 份${bad.length ? `（${bad.length} 份未完成：${reasons.join('、')}）` : ''}`,
                    );
                  })
                  .catch((err) => void failures.push(`活跃任务：${errMsg(err, '失败')}`)),
              ]
            : []),
          ...(moduleProfileIds.length
            ? [
                stopModules(moduleProfileIds).then((res) => {
                  if (res.uniqueCount > 0) parts.push(`模块任务 ${res.uniqueCount} 个浏览器`);
                  failures.push(...res.failures);
                }),
              ]
            : []),
        ]);
        const summary = parts.length ? `已发送停止指令（${parts.join('；')}）` : '无需要停止的任务';
        return failures.length ? `${summary}；部分失败：${failures.join('；')}` : summary;
      }),
    [mutate, tasks, stopModules],
  );
  const handleSaveGlobalConcurrency = useCallback(
    async (patch: { browserConcurrency?: number; bluestacksConcurrency?: number }) => {
      try {
        let base = autoScheduler?.settings;
        if (!base) {
          const latest = await api.autoSchedulerState().catch(() => null);
          if (latest) {
            setAutoScheduler(latest);
            base = latest.settings;
          }
        }
        if (!base) return (setMessage('全局并发设置尚未加载完成，请稍后再试'), false);
        const next = await api.autoSchedulerAction('settings', { ...base, ...patch });
        setAutoScheduler(next);
        tasks.refresh();
        mods.refreshBumper();
        mods.refreshPoster();
        void mods.refreshGroupInviter();
        mods.refreshBluestacks(false);
        setMessage(
          `已更新全局并发：浏览器 ${next.settings.browserConcurrency} 窗 · 蓝蝶 ${next.settings.bluestacksConcurrency} 窗`,
        );
        return true;
      } catch (err) {
        return (setMessage(errMsg(err, '保存全局并发失败')), false);
      }
    },
    [autoScheduler?.settings, setAutoScheduler, setMessage, tasks, mods],
  );
  const handleStopCard = useCallback(
    (c: LiveRunCard) => {
      if (c.stopKind === 'plan' && c.planTarget) return stopProfilesUnified([c.planTarget], []);
      if (c.stopKind === 'scheduler')
        return void mutate(async () => {
          setAutoScheduler(
            await api.autoSchedulerAction('stop', {
              targetIds: [c.targetId],
              keepWindowsOpen: true,
            }),
          );
          return `已停止 ${c.targetName} 的排班执行`;
        });
      if (c.stopKind === 'bluestacks-module' && c.bsModuleAction) {
        const act = c.bsModuleAction;
        return void mutate(async () => {
          setBluestacks(await api.bluestacksAction(act, { profileIds: [c.targetId] }));
          return `已停止蓝蝶窗口 ${c.targetName}`;
        });
      }
      stopProfilesUnified([], [c.targetId]);
    },
    [mutate, setAutoScheduler, setBluestacks, stopProfilesUnified],
  );
  const handleStopAllCards = useCallback(
    () =>
      void mutate(async () => {
        const plans = liveRunCards.flatMap((c) =>
          c.stopKind === 'plan' && c.planTarget ? [c.planTarget] : [],
        );
        const modIds = liveRunCards.filter((c) => c.stopKind === 'module').map((c) => c.targetId);
        if (plans.length) await tasks.command({ command: 'stop', plans });
        if (modIds.length) await stopModules(modIds);
        for (const runId of new Set(
          liveRunCards.flatMap((c) =>
            c.stopKind === 'scheduler' && c.schedulerRunId ? [c.schedulerRunId] : [],
          ),
        ))
          setAutoScheduler(await api.autoSchedulerAction('stop', { runId, keepWindowsOpen: true }));
        for (const act of new Set(
          liveRunCards.flatMap((c) =>
            c.stopKind === 'bluestacks-module' && c.bsModuleAction ? [c.bsModuleAction] : [],
          ),
        ))
          setBluestacks(await api.bluestacksAction(act, {}));
        return '已发送全部停止指令';
      }),
    [liveRunCards, mutate, setAutoScheduler, setBluestacks, stopModules, tasks],
  );
  return {
    checkProfiles,
    commandPlans,
    stopProfilesUnified,
    handleSaveGlobalConcurrency,
    handleStopCard,
    handleStopAllCards,
  };
}
