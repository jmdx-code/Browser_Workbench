import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BluestacksState } from '../../../shared/bluestacks.js';
import type { Group, Profile } from '../../../shared/contracts.js';
import type {
  GoogleSheetKind,
  GoogleSheetLink,
  GoogleSheetsOverview,
  PostRecordsSheetConfig,
  PostScheduleSheetConfig,
  ScheduleExecutionCarrier,
  SheetGridSnapshot,
} from '../../../shared/google-sheets.js';
import { api } from '../../api.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { SheetBottomTabs } from './sheet-bottom-tabs.js';
import {
  RecordsAccountGroupDropdown,
  RecordsBumpConfigModal,
  RecordsFrequencyModal,
  ScheduleBluestacksDropdown,
} from './sheet-config-modal.js';
import { SheetConnectModal } from './sheet-connect-modal.js';
import { SheetDataGrid } from './sheet-data-grid.js';
import './google-sheets.css';

const KIND_META: Record<
  GoogleSheetKind,
  {
    title: string;
    multi: boolean;
    addLabel: string;
    emptyHint: string;
  }
> = {
  group_library: {
    title: '小组表',
    multi: false,
    addLabel: '连接小组表',
    emptyHint: '连接 Google 表格中的「小组表」工作表后，可一键导入或同步小组库。',
  },
  page_library: {
    title: '专页表',
    multi: false,
    addLabel: '连接专页表',
    emptyHint: '连接 Google 表格中的「专页表」工作表后，可双向同步专页 ID、分类、名称与头像。',
  },
  post_schedule: {
    title: '排贴表',
    multi: true,
    addLabel: '连接排贴表',
    emptyHint: '连接排贴表后，可在顶部直接选择发帖记录表与执行方式并开启自动发帖。',
  },
  post_records: {
    title: '发帖记录',
    multi: true,
    addLabel: '连接发帖记录表',
    emptyHint: '连接发帖记录表后，可在顶部选择顶贴账号组、编辑本机名并开启自动顶贴。',
  },
};

const CLIENT_GRID_CACHE_STALE_MS = 60_000;
const clientGridCache = new Map<string, { snapshot: SheetGridSnapshot; cachedAt: number }>();

export function clearGoogleSheetsGridCache(linkId?: string): void {
  if (linkId) clientGridCache.delete(linkId);
  else clientGridCache.clear();
}

function readClientGridRecord(): Record<string, SheetGridSnapshot> {
  const out: Record<string, SheetGridSnapshot> = {};
  for (const [id, entry] of clientGridCache.entries()) {
    out[id] = entry.snapshot;
  }
  return out;
}

export function GoogleSheetsPage({
  kind,
  overview,
  onOverview,
  profileGroups,
  profiles,
  bluestacksState,
  onOpenAuthMenu,
  onAfterLibrarySync,
  onNotify,
}: {
  kind: GoogleSheetKind;
  overview: GoogleSheetsOverview | null;
  onOverview: (next: GoogleSheetsOverview) => void;
  profileGroups: readonly Group[];
  profiles: readonly Profile[];
  bluestacksState?: BluestacksState | null;
  onOpenAuthMenu: () => void;
  onAfterLibrarySync: () => void;
  onNotify: (msg: string) => void;
}) {
  const meta = KIND_META[kind];
  const linksOfKind = useMemo(
    () => (overview?.links ?? []).filter((l) => l.kind === kind),
    [overview?.links, kind],
  );
  const allRecordLinks = useMemo(
    () => (overview?.links ?? []).filter((l) => l.kind === 'post_records'),
    [overview?.links],
  );

  const [activeLinkId, setActiveLinkId] = useState<string | null>(null);
  const [gridByLink, setGridByLink] = useState<Record<string, SheetGridSnapshot>>(() =>
    readClientGridRecord(),
  );
  const [gridLoading, setGridLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectRecordForScheduleId, setConnectRecordForScheduleId] = useState<string | null>(null);
  const [bumpModalOpen, setBumpModalOpen] = useState(false);
  const [freqModalOpen, setFreqModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);

  const activeLink: GoogleSheetLink | null = useMemo(() => {
    if (linksOfKind.length === 0) return null;
    if (activeLinkId) {
      const hit = linksOfKind.find((l) => l.id === activeLinkId);
      if (hit) return hit;
    }
    return linksOfKind[0] ?? null;
  }, [linksOfKind, activeLinkId]);

  useEffect(() => {
    if (activeLink && activeLink.id !== activeLinkId) {
      setActiveLinkId(activeLink.id);
    } else if (!activeLink && activeLinkId !== null) {
      setActiveLinkId(null);
    }
  }, [activeLink, activeLinkId]);

  const refreshOverview = useCallback(async () => {
    const next = await api.googleSheetsOverview();
    onOverview(next);
    return next;
  }, [onOverview]);

  // Unified auto-saving state for inline post_records machineName input (safe across tab switches)
  const [machineNameDraft, setMachineNameDraft] = useState('');
  const machineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const machineSavedRef = useRef<{ linkId: string; value: string } | null>(null);
  const machineLatestRef = useRef<{ linkId: string; value: string } | null>(null);

  const flushMachineName = useCallback(
    async (override?: { linkId: string; value: string }) => {
      if (machineTimerRef.current) {
        clearTimeout(machineTimerRef.current);
        machineTimerRef.current = null;
      }
      const target = override ?? machineLatestRef.current;
      if (!target) return;
      const normalized = target.value.trim() || '电脑1号';
      if (
        machineSavedRef.current?.linkId === target.linkId &&
        machineSavedRef.current.value === normalized
      ) {
        return;
      }
      try {
        await api.googleSheetsUpdateLink({
          id: target.linkId,
          recordsConfig: { machineName: normalized },
        });
        machineSavedRef.current = { linkId: target.linkId, value: normalized };
        await refreshOverview();
      } catch (err) {
        onNotify(err instanceof Error ? err.message : '保存本机名称失败');
      }
    },
    [onNotify, refreshOverview],
  );

  const activeRecordsMachineName =
    activeLink?.kind === 'post_records' ? (activeLink.recordsConfig?.machineName ?? '电脑1号') : '';
  const activeRecordsId = activeLink?.kind === 'post_records' ? activeLink.id : null;

  useEffect(() => {
    if (
      machineLatestRef.current &&
      machineLatestRef.current.linkId !== activeRecordsId &&
      machineTimerRef.current
    ) {
      void flushMachineName(machineLatestRef.current);
    }
    if (!activeRecordsId) {
      machineSavedRef.current = null;
      machineLatestRef.current = null;
      setMachineNameDraft('');
      return;
    }
    if (
      machineSavedRef.current?.linkId !== activeRecordsId ||
      (machineTimerRef.current === null &&
        machineSavedRef.current.value !== activeRecordsMachineName)
    ) {
      machineSavedRef.current = { linkId: activeRecordsId, value: activeRecordsMachineName };
      machineLatestRef.current = { linkId: activeRecordsId, value: activeRecordsMachineName };
      setMachineNameDraft(activeRecordsMachineName);
    }
  }, [activeRecordsId, activeRecordsMachineName, flushMachineName]);

  useEffect(
    () => () => {
      if (machineTimerRef.current && machineLatestRef.current) {
        clearTimeout(machineTimerRef.current);
        machineTimerRef.current = null;
        const pending = machineLatestRef.current;
        const normalized = pending.value.trim() || '电脑1号';
        if (
          machineSavedRef.current?.linkId !== pending.linkId ||
          machineSavedRef.current.value !== normalized
        ) {
          void api
            .googleSheetsUpdateLink({
              id: pending.linkId,
              recordsConfig: { machineName: normalized },
            })
            .catch(() => {});
        }
      }
    },
    [],
  );

  const [confirmDisconnectLink, setConfirmDisconnectLink] = useState<GoogleSheetLink | null>(null);
  const [confirmOverwriteLink, setConfirmOverwriteLink] = useState<GoogleSheetLink | null>(null);
  const [patchingConfig, setPatchingConfig] = useState(false);
  const configPatchChainRef = useRef<Promise<void>>(Promise.resolve());
  const failedGridLinksRef = useRef<Set<string>>(new Set());
  const activeGridReqSeqRef = useRef(0);
  const activeLinkIdRef = useRef<string | null>(activeLink?.id ?? null);
  activeLinkIdRef.current = activeLink?.id ?? null;

  const loadGrid = useCallback(
    async (linkId: string, manual = false, silent = false) => {
      if (!overview?.auth.authorized) return;
      if (manual) failedGridLinksRef.current.delete(linkId);
      const reqSeq = silent ? activeGridReqSeqRef.current : ++activeGridReqSeqRef.current;
      if (!silent) setGridLoading(true);
      try {
        const snap = await api.googleSheetsReadGrid(linkId, manual);
        failedGridLinksRef.current.delete(linkId);
        clientGridCache.set(linkId, { snapshot: snap, cachedAt: Date.now() });
        setGridByLink((prev) => ({ ...prev, [linkId]: snap }));
      } catch (err) {
        failedGridLinksRef.current.add(linkId);
        if (
          !silent &&
          activeLinkIdRef.current === linkId &&
          activeGridReqSeqRef.current === reqSeq
        ) {
          onNotify(err instanceof Error ? err.message : '读取 Google 表格内容失败');
        }
      } finally {
        if (!silent && activeGridReqSeqRef.current === reqSeq) setGridLoading(false);
      }
    },
    [overview?.auth.authorized, onNotify],
  );

  const activeLinkIdResolved = activeLink?.id ?? null;
  useEffect(() => {
    if (!activeLinkIdResolved || !overview?.auth.authorized) return;
    if (failedGridLinksRef.current.has(activeLinkIdResolved)) return;
    const cached = clientGridCache.get(activeLinkIdResolved);
    if (!cached) {
      void loadGrid(activeLinkIdResolved, false, false);
      return;
    }
    setGridByLink((prev) =>
      prev[activeLinkIdResolved] === cached.snapshot
        ? prev
        : { ...prev, [activeLinkIdResolved]: cached.snapshot },
    );
    if (Date.now() - cached.cachedAt > CLIENT_GRID_CACHE_STALE_MS) {
      void loadGrid(activeLinkIdResolved, false, true);
    }
  }, [activeLinkIdResolved, overview?.auth.authorized, loadGrid]);

  useEffect(() => {
    if (!importModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmOverwriteLink) setImportModalOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [importModalOpen, confirmOverwriteLink]);

  const activeGrid = activeLink ? (gridByLink[activeLink.id] ?? null) : null;
  const activeLogs = useMemo(() => {
    const logs = overview?.logs ?? [];
    if (!activeLink) return logs.slice(0, 20);
    return logs
      .filter((item) => item.linkId === activeLink.id || item.linkId === null)
      .slice(0, 30);
  }, [overview?.logs, activeLink]);

  async function runAction(
    label: string,
    work: () => Promise<string | void>,
    options?: { skipReloadGrid?: boolean },
  ) {
    if (busyAction) return;
    setBusyAction(label);
    try {
      const msg = await work();
      await refreshOverview();
      if (!options?.skipReloadGrid && activeLink) {
        await loadGrid(activeLink.id, true);
      }
      if (msg) onNotify(msg);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : `${label}失败`);
    } finally {
      setBusyAction(null);
    }
  }

  // Unified serialized state updater for scheduleConfig & recordsConfig (prevents lost-update races)
  function enqueueConfigPatch(work: () => Promise<void>) {
    setPatchingConfig(true);
    const next = configPatchChainRef.current.then(work, work).finally(() => {
      if (configPatchChainRef.current === next) {
        setPatchingConfig(false);
      }
    });
    configPatchChainRef.current = next;
    return next;
  }

  function patchScheduleConfig(
    linkId: string,
    patch: Partial<PostScheduleSheetConfig>,
    toast?: string,
  ) {
    return enqueueConfigPatch(async () => {
      try {
        await api.googleSheetsUpdateLink({ id: linkId, scheduleConfig: patch });
        await refreshOverview();
        if (toast) onNotify(toast);
      } catch (err) {
        onNotify(err instanceof Error ? err.message : '保存设置失败');
      }
    });
  }

  function patchRecordsConfig(
    linkId: string,
    patch: Partial<PostRecordsSheetConfig>,
    toast?: string,
  ) {
    return enqueueConfigPatch(async () => {
      try {
        await api.googleSheetsUpdateLink({ id: linkId, recordsConfig: patch });
        await refreshOverview();
        if (toast) onNotify(toast);
      } catch (err) {
        onNotify(err instanceof Error ? err.message : '保存设置失败');
      }
    });
  }

  async function handleRenameTab(id: string, nextTitle: string) {
    try {
      await api.googleSheetsUpdateLink({ id, title: nextTitle });
      await refreshOverview();
      onNotify(`已重命名为「${nextTitle}」`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '重命名失败');
    }
  }

  const isAuthorized = Boolean(overview?.auth.authorized);
  const isRunning = Boolean(activeLink && activeLink.runtime.activeRunningCount > 0);
  const isAutoEnabled =
    activeLink?.kind === 'post_schedule'
      ? Boolean(activeLink.scheduleConfig?.enabled)
      : activeLink?.kind === 'post_records'
        ? Boolean(activeLink.recordsConfig?.enabled)
        : false;
  const isMinimalGridKind = kind === 'post_schedule' || kind === 'post_records';

  return (
    <div className="gs-page">
      {!isAuthorized && (
        <div className="gs-auth-prompt-bar">
          <div>
            <strong>
              {overview?.auth.lastError ? 'Google 表格授权已失效' : '尚未完成 Google 表格授权'}
            </strong>
            <span className="hint">
              {overview?.auth.lastError || '请先前往授权与图床设置完成 Google 授权。'}
            </span>
          </div>
          <button type="button" className="btn btn-sm btn-primary" onClick={onOpenAuthMenu}>
            前往授权设置
          </button>
        </div>
      )}

      <header className="gs-topbar gs-topbar-unified">
        <div className="gs-title-cluster">
          <h2>{meta.title}</h2>
          {activeLink && (
            <a
              className="gs-ext-link-icon"
              href={activeLink.spreadsheetUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="在浏览器中打开原 Google 表格"
              title={`在浏览器中打开：${activeLink.spreadsheetTitle} / ${activeLink.sheetName}`}
            >
              ↗
            </a>
          )}
          {activeLink && isRunning && (
            <span className="gs-status-pill tone-run">
              {activeLink.runtime.activeJobText || '执行中…'}
            </span>
          )}
          {activeLink?.runtime.lastError && (
            <span className="gs-status-pill tone-err" title={activeLink.runtime.lastError}>
              异常
            </span>
          )}
        </div>

        <div className="gs-topbar-controls">
          {!activeLink ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!isAuthorized}
              onClick={() => setConnectOpen(true)}
            >
              + {meta.addLabel}
            </button>
          ) : (
            <>
              {(kind === 'group_library' || kind === 'page_library') && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={Boolean(busyAction) || !isAuthorized}
                    onClick={() => setImportModalOpen(true)}
                  >
                    从表格导入
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={Boolean(busyAction) || !isAuthorized}
                    onClick={() =>
                      void runAction('同步至表格', async () => {
                        const res = await api.googleSheetsSyncLibrary(activeLink.id);
                        return res.summary;
                      })
                    }
                  >
                    {busyAction === '同步至表格' ? '同步中…' : '同步至表格'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={Boolean(busyAction) || !isAuthorized}
                    onClick={() => setConnectOpen(true)}
                  >
                    换表
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost gs-btn-danger-ghost"
                    disabled={Boolean(busyAction)}
                    onClick={() => setConfirmDisconnectLink(activeLink)}
                  >
                    断开
                  </button>
                </>
              )}

              {kind === 'post_schedule' && (
                <>
                  <select
                    className="gs-bar-select"
                    aria-label="选择要登记的发帖记录表"
                    title="选择发帖后登记的发帖记录表"
                    disabled={Boolean(busyAction)}
                    value={activeLink.scheduleConfig?.targetRecordLinkId ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '__connect_new__') {
                        setConnectRecordForScheduleId(activeLink.id);
                        return;
                      }
                      const nextId = val || null;
                      const recTitle =
                        allRecordLinks.find((r) => r.id === nextId)?.title ?? '不登记记录表';
                      void patchScheduleConfig(
                        activeLink.id,
                        { targetRecordLinkId: nextId },
                        nextId ? `已绑定记录表「${recTitle}」` : '已取消登记记录表',
                      );
                    }}
                  >
                    <option value="">不登记记录表</option>
                    {allRecordLinks.map((rec) => (
                      <option key={rec.id} value={rec.id}>
                        记录表：{rec.title}
                      </option>
                    ))}
                    {isAuthorized && <option value="__connect_new__">+ 连接新发帖记录表…</option>}
                  </select>

                  <select
                    className="gs-bar-select"
                    aria-label="选择发帖执行方式"
                    title="选择发帖执行方式"
                    disabled={Boolean(busyAction)}
                    value={activeLink.scheduleConfig?.executionCarrier ?? 'browser'}
                    onChange={(e) => {
                      const nextCarrier = e.target.value as ScheduleExecutionCarrier;
                      void patchScheduleConfig(activeLink.id, { executionCarrier: nextCarrier });
                    }}
                  >
                    <option value="browser">仅浏览器</option>
                    <option value="bluestacks">仅蓝蝶模拟器</option>
                    <option value="auto">双引擎自动</option>
                  </select>

                  {(activeLink.scheduleConfig?.executionCarrier ?? 'browser') !== 'browser' && (
                    <ScheduleBluestacksDropdown
                      link={activeLink}
                      bluestacksState={bluestacksState}
                      disabled={Boolean(busyAction)}
                      onChange={(patch) => void patchScheduleConfig(activeLink.id, patch)}
                    />
                  )}

                  <span className="gs-bar-divider" aria-hidden="true" />

                  <button
                    type="button"
                    className={'btn btn-sm gs-auto-switch ' + (isAutoEnabled ? 'is-on' : 'is-off')}
                    disabled={Boolean(busyAction) || patchingConfig || !isAuthorized}
                    onClick={() =>
                      void patchScheduleConfig(
                        activeLink.id,
                        { enabled: !isAutoEnabled },
                        !isAutoEnabled ? '已开启自动发帖' : '已关闭自动发帖',
                      )
                    }
                  >
                    <i className="gs-switch-dot" />
                    {isAutoEnabled ? '自动发帖：已开启' : '开启自动发帖'}
                  </button>

                  {isRunning ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        void runAction('停止发帖', async () => {
                          await api.googleSheetsStopLink(activeLink.id);
                          return '已发送停止指令';
                        })
                      }
                    >
                      停止发帖
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={Boolean(busyAction) || !isAuthorized}
                      title="不等定时轮询，现在立刻执行一次到期排贴"
                      onClick={() =>
                        void runAction('立即发一次', async () => {
                          const res = await api.googleSheetsPollSchedule(activeLink.id);
                          return res.summary;
                        })
                      }
                    >
                      {busyAction === '立即发一次' ? '执行中…' : '立即发一次'}
                    </button>
                  )}
                </>
              )}

              {kind === 'post_records' && (
                <>
                  <RecordsAccountGroupDropdown
                    link={activeLink}
                    profileGroups={profileGroups}
                    profiles={profiles}
                    bluestacksState={bluestacksState}
                    disabled={Boolean(busyAction)}
                    onChange={(patch) => void patchRecordsConfig(activeLink.id, patch)}
                  />

                  <input
                    type="text"
                    maxLength={60}
                    className="gs-machine-input"
                    aria-label="本机名字"
                    title="本机名字（右侧顶贴计数列名，修改后自动保存）"
                    placeholder="本机名字"
                    value={machineNameDraft}
                    onChange={(e) => {
                      const val = e.target.value;
                      setMachineNameDraft(val);
                      const payload = { linkId: activeLink.id, value: val };
                      machineLatestRef.current = payload;
                      if (machineTimerRef.current) clearTimeout(machineTimerRef.current);
                      machineTimerRef.current = setTimeout(() => {
                        machineTimerRef.current = null;
                        void flushMachineName(payload);
                      }, 450);
                    }}
                    onBlur={() => void flushMachineName()}
                  />

                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={Boolean(busyAction)}
                    onClick={() => setBumpModalOpen(true)}
                  >
                    顶贴配置
                  </button>

                  <label className="gs-bar-check" title="由本机采集满 24h / 72h 贴文的点赞与评论数">
                    <input
                      type="checkbox"
                      disabled={Boolean(busyAction)}
                      checked={Boolean(activeLink.recordsConfig?.collectMetricsOnThisPc)}
                      onChange={(e) =>
                        void patchRecordsConfig(activeLink.id, {
                          collectMetricsOnThisPc: e.target.checked,
                        })
                      }
                    />
                    <span>本机采赞评</span>
                  </label>

                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={Boolean(busyAction)}
                    onClick={() => setFreqModalOpen(true)}
                  >
                    频率限制
                  </button>

                  <span className="gs-bar-divider" aria-hidden="true" />

                  <button
                    type="button"
                    className={'btn btn-sm gs-auto-switch ' + (isAutoEnabled ? 'is-on' : 'is-off')}
                    disabled={Boolean(busyAction) || patchingConfig || !isAuthorized}
                    onClick={() =>
                      void patchRecordsConfig(
                        activeLink.id,
                        { enabled: !isAutoEnabled },
                        !isAutoEnabled ? '已开启自动顶贴' : '已关闭自动顶贴',
                      )
                    }
                  >
                    <i className="gs-switch-dot" />
                    {isAutoEnabled ? '自动顶贴：已开启' : '开启自动顶贴'}
                  </button>

                  {isRunning ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        void runAction('停止顶贴', async () => {
                          await api.googleSheetsStopLink(activeLink.id);
                          return '已发送停止指令';
                        })
                      }
                    >
                      停止顶贴
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={Boolean(busyAction) || !isAuthorized}
                      title="立刻扫描记录表并顶贴一次"
                      onClick={() =>
                        void runAction('立即顶一次', async () => {
                          const res = await api.googleSheetsPollRecords(activeLink.id);
                          return res.summary;
                        })
                      }
                    >
                      {busyAction === '立即顶一次' ? '顶贴中…' : '立即顶一次'}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </header>

      <div className="gs-main-grid-area">
        <SheetDataGrid
          snapshot={activeGrid}
          loading={gridLoading}
          emptyTitle={activeLink ? '表格暂无数据' : `尚未连接${meta.title}`}
          emptyHint={meta.emptyHint}
          showToolbar={!isMinimalGridKind}
          onRefresh={
            activeLink && isAuthorized ? () => void loadGrid(activeLink.id, true) : undefined
          }
          refreshing={gridLoading}
          onNotify={onNotify}
        />
      </div>

      {activeLogs.length > 0 && (
        <div className={'gs-log-bar' + (logsExpanded ? ' is-open' : '')}>
          <button
            type="button"
            className="gs-log-toggle"
            onClick={() => setLogsExpanded((v) => !v)}
          >
            <span className="gs-log-latest">
              <strong>动态日志</strong> ·{' '}
              {new Date(activeLogs[0]?.createdAt ?? Date.now()).toLocaleTimeString()} ·{' '}
              {activeLogs[0]?.summary}
            </span>
            <span className="hint">
              {logsExpanded ? '收起 ▲' : `展开最近 ${activeLogs.length} 条 ▼`}
            </span>
          </button>
          {logsExpanded && (
            <div className="gs-log-list">
              {activeLogs.map((log) => (
                <div key={log.id} className={'gs-log-item is-' + log.level}>
                  <span className="gs-log-time">
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="gs-log-msg">{log.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {meta.multi && linksOfKind.length > 0 && (
        <SheetBottomTabs
          links={linksOfKind}
          activeLinkId={activeLink?.id ?? null}
          addLabel={meta.addLabel}
          onSelect={(id) => {
            setActiveLinkId(id);
          }}
          onAdd={() => {
            if (!isAuthorized) {
              onOpenAuthMenu();
              return;
            }
            setConnectOpen(true);
          }}
          onRename={handleRenameTab}
          onDelete={(link) => setConfirmDisconnectLink(link)}
        />
      )}

      {connectOpen && (
        <SheetConnectModal
          kind={kind}
          sameDocSuggestionUrl={activeLink?.spreadsheetUrl}
          existingLinks={overview?.links ?? []}
          onClose={() => setConnectOpen(false)}
          onConnected={(linkId) => {
            setConnectOpen(false);
            setActiveLinkId(linkId);
            void refreshOverview().then(() => loadGrid(linkId, true));
            onNotify(`已连接${meta.title}`);
          }}
        />
      )}

      {connectRecordForScheduleId && (
        <SheetConnectModal
          kind="post_records"
          sameDocSuggestionUrl={activeLink?.spreadsheetUrl}
          sameDocSuggestionLabel="填入当前排贴表所属文档并读取"
          existingLinks={overview?.links ?? []}
          onClose={() => setConnectRecordForScheduleId(null)}
          onConnected={(recordLinkId) => {
            const schedId = connectRecordForScheduleId;
            setConnectRecordForScheduleId(null);
            void patchScheduleConfig(
              schedId,
              { targetRecordLinkId: recordLinkId },
              '已连接发帖记录表并自动绑定',
            );
          }}
        />
      )}

      {bumpModalOpen && activeLink && activeLink.kind === 'post_records' && (
        <RecordsBumpConfigModal
          link={activeLink}
          onClose={() => setBumpModalOpen(false)}
          onSave={async (patch) => {
            await api.googleSheetsUpdateLink({
              id: activeLink.id,
              recordsConfig: {
                commentPool: patch.commentPool,
                bumperSettings: {
                  ...(activeLink.recordsConfig?.bumperSettings ?? {}),
                  likeProbability: patch.likeProbability,
                  commentProbability: patch.commentProbability,
                },
              },
            });
            await refreshOverview();
            onNotify('顶贴配置已保存');
          }}
        />
      )}

      {freqModalOpen && activeLink && activeLink.kind === 'post_records' && (
        <RecordsFrequencyModal
          link={activeLink}
          onClose={() => setFreqModalOpen(false)}
          onSave={async (patch) => {
            await api.googleSheetsUpdateLink({
              id: activeLink.id,
              recordsConfig: {
                activePollMinutes: patch.activePollMinutes,
                semiActiveAfterIdlePolls: patch.semiActiveAfterIdlePolls,
                semiActivePollMinutes: patch.semiActivePollMinutes,
                bumperSettings: {
                  ...(activeLink.recordsConfig?.bumperSettings ?? {}),
                  maxLikesPerPost: patch.maxLikesPerPost,
                  dailyMaxLikesPerAccount: patch.dailyMaxLikesPerAccount,
                  maxPostAgeHours: patch.maxPostAgeHours,
                },
              },
            });
            await refreshOverview();
            onNotify('频率限制已保存');
          }}
        />
      )}

      {importModalOpen && activeLink && (
        <div
          className="gs-modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setImportModalOpen(false)}
        >
          <div className="gs-modal" role="dialog" aria-label="选择导入方式">
            <header className="gs-modal-head">
              <div>
                <h3>从{meta.title}导入软件库</h3>
                <p className="hint">请选择如何将表格中的 ID 与类别同步到本机软件库：</p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setImportModalOpen(false)}
              >
                关闭
              </button>
            </header>
            <div className="gs-modal-body gs-import-choices">
              <button
                type="button"
                className="gs-choice-card is-recommended"
                disabled={Boolean(busyAction)}
                onClick={() => {
                  setImportModalOpen(false);
                  void runAction('增量导入', async () => {
                    const res = await api.googleSheetsImportLibrary(activeLink.id, 'incremental');
                    onAfterLibrarySync();
                    return res.summary;
                  });
                }}
              >
                <div className="gs-choice-head">
                  <strong>增量导入（推荐）</strong>
                  <span className="pill pill-ok">安全不删旧数据</span>
                </div>
                <p className="hint">
                  新增表格里的新
                  ID，并按表格「类别」更新对应分组；软件里原有但表格里没有的条目会继续保留。
                </p>
              </button>

              <button
                type="button"
                className="gs-choice-card is-danger"
                disabled={Boolean(busyAction)}
                onClick={() => setConfirmOverwriteLink(activeLink)}
              >
                <div className="gs-choice-head">
                  <strong>覆盖导入（与表格完全对齐）</strong>
                  <span className="pill pill-warn">会删除多余条目</span>
                </div>
                <p className="hint">
                  以当前 Google 表格为准：新增新 ID、更新分类，并移除软件里多余的不在表格中的条目。
                </p>
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDisconnectLink && (
        <ConfirmDialog
          title={`确认移除「${confirmDisconnectLink.title}」`}
          description="移除连接后工作台将停止读写此工作表（不会删除或修改 Google 云端表格文件）。"
          label="确认移除"
          onClose={() => setConfirmDisconnectLink(null)}
          onConfirm={async () => {
            const target = confirmDisconnectLink;
            const currentIdx = linksOfKind.findIndex((item) => item.id === target.id);
            const fallbackSibling =
              linksOfKind[currentIdx + 1]?.id ?? linksOfKind[currentIdx - 1]?.id ?? null;
            setConfirmDisconnectLink(null);
            await runAction(
              '移除表格连接',
              async () => {
                await api.googleSheetsDeleteLink(target.id);
                failedGridLinksRef.current.delete(target.id);
                clientGridCache.delete(target.id);
                setGridByLink((prev) => {
                  const next = { ...prev };
                  delete next[target.id];
                  return next;
                });
                if (activeLinkId === target.id) {
                  setActiveLinkId(fallbackSibling);
                }
                return `已移除「${target.title}」`;
              },
              { skipReloadGrid: true },
            );
          }}
        />
      )}

      {confirmOverwriteLink && (
        <ConfirmDialog
          title="确认覆盖导入软件库"
          description={`确定要执行「覆盖导入」吗？软件内存在但云端${meta.title}里没有的条目将被从软件库删除（已有本地头像不会被清空）。`}
          label="确认覆盖导入"
          onClose={() => setConfirmOverwriteLink(null)}
          onConfirm={async () => {
            const target = confirmOverwriteLink;
            setConfirmOverwriteLink(null);
            setImportModalOpen(false);
            await runAction('覆盖导入', async () => {
              const res = await api.googleSheetsImportLibrary(target.id, 'overwrite');
              onAfterLibrarySync();
              return res.summary;
            });
          }}
        />
      )}
    </div>
  );
}
