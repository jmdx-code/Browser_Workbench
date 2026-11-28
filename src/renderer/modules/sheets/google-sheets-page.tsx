import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BluestacksState } from '../../../shared/bluestacks.js';
import type { Group, Profile } from '../../../shared/contracts.js';
import type {
  GoogleSheetKind,
  GoogleSheetLink,
  GoogleSheetsOverview,
  PostRecordsSheetConfig,
  PostScheduleSheetConfig,
  SheetGridSnapshot,
} from '../../../shared/google-sheets.js';
import { api } from '../../api.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { UI_BETWEEN, UI_ROW, UiSegmented } from '../../ui/primitives.js';
import { BackdropModal, Btn, errMsg, ModalHeading } from '../shared/module-ui.js';
import { GoogleSheetsTopbar } from './google-sheets-topbar.js';
import { SheetBottomTabs } from './sheet-bottom-tabs.js';
import { RecordsBumpConfigModal, RecordsFrequencyModal } from './sheet-config-modal.js';
import { SheetConnectModal } from './sheet-connect-modal.js';
import { SheetDataGrid } from './sheet-data-grid.js';
const KIND_ORDER: readonly GoogleSheetKind[] = [
  'post_schedule',
  'post_records',
  'group_library',
  'page_library',
];
const KIND_META: Record<GoogleSheetKind, [string, boolean, string, string]> = {
  group_library: [
    '小组表',
    false,
    '连接小组表',
    '连接 Google 表格中的「小组表」工作表后，可一键导入或同步小组库。',
  ],
  page_library: [
    '专页表',
    false,
    '连接专页表',
    '连接 Google 表格中的「专页表」工作表后，可双向同步专页 ID、分类、名称与头像。',
  ],
  post_schedule: [
    '排贴表',
    true,
    '连接排贴表',
    '连接排贴表后，可在顶部直接选择发帖记录表与执行方式并开启自动发帖。',
  ],
  post_records: [
    '发帖记录',
    true,
    '连接发帖记录表',
    '连接发帖记录表后，可在顶部选择顶贴账号组、编辑本机名并开启自动顶贴。',
  ],
};
const clientGridCache = new Map<string, { snapshot: SheetGridSnapshot; cachedAt: number }>();
export function clearGoogleSheetsGridCache(linkId?: string): void {
  if (linkId) clientGridCache.delete(linkId);
  else clientGridCache.clear();
}
export function GoogleSheetsPage(p: {
  kind: GoogleSheetKind;
  overview: GoogleSheetsOverview | null;
  onOverview: (next: GoogleSheetsOverview) => void;
  profileGroups: readonly Group[];
  profiles: readonly Profile[];
  bluestacksState?: BluestacksState | null;
  globalMaxConcurrency?: number | null;
  onSelectKind?: (kind: GoogleSheetKind) => void;
  onOpenAuthMenu: () => void;
  onAfterLibrarySync: () => void;
  onNotify: (msg: string) => void;
}) {
  const { kind, overview, onOverview, onOpenAuthMenu, onAfterLibrarySync, onNotify } = p;
  const [title, multi, addLabel, emptyHint] = KIND_META[kind];
  const linksOfKind = useMemo(
    () => (overview?.links ?? []).filter((l) => l.kind === kind),
    [overview?.links, kind],
  );
  const allRecordLinks = useMemo(
    () => (overview?.links ?? []).filter((l) => l.kind === 'post_records'),
    [overview?.links],
  );
  const [activeLinkId, setActiveLinkId] = useState<string | null>(null),
    [gridByLink, setGridByLink] = useState<Record<string, SheetGridSnapshot>>(() =>
      Object.fromEntries([...clientGridCache.entries()].map(([id, e]) => [id, e.snapshot])),
    ),
    [gridLoading, setGridLoading] = useState(false),
    [busyAction, setBusyAction] = useState<string | null>(null),
    [stoppingLink, setStoppingLink] = useState(false),
    [connectTarget, setConnectTarget] = useState<{
      kind: GoogleSheetKind;
      bindScheduleId?: string;
    } | null>(null),
    [modal, setModal] = useState<'bump' | 'freq' | 'import' | null>(null),
    [logsExpanded, setLogsExpanded] = useState(false),
    [confirmDlg, setConfirmDlg] = useState<{
      kind: 'disconnect' | 'overwrite';
      link: GoogleSheetLink;
    } | null>(null),
    [patchingConfig, setPatchingConfig] = useState(false);
  const activeLink = useMemo(
    () =>
      (activeLinkId && linksOfKind.find((l) => l.id === activeLinkId)) || linksOfKind[0] || null,
    [linksOfKind, activeLinkId],
  );
  useEffect(() => {
    if (activeLink && activeLink.id !== activeLinkId) setActiveLinkId(activeLink.id);
    else if (!activeLink && activeLinkId !== null) setActiveLinkId(null);
  }, [activeLink, activeLinkId]);
  const refreshOverview = useCallback(async () => {
    const next = await api.googleSheetsOverview();
    onOverview(next);
    return next;
  }, [onOverview]);
  const [machineNameDraft, setMachineNameDraft] = useState('');
  const machineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    machineSavedRef = useRef<{ linkId: string; value: string } | null>(null),
    machineLatestRef = useRef<{ linkId: string; value: string } | null>(null);
  const flushMachineName = useCallback(
    async (override?: { linkId: string; value: string }) => {
      if (machineTimerRef.current) clearTimeout(machineTimerRef.current);
      machineTimerRef.current = null;
      const target = override ?? machineLatestRef.current;
      if (!target) return;
      const norm = target.value.trim() || '电脑1号';
      if (
        machineSavedRef.current?.linkId === target.linkId &&
        machineSavedRef.current.value === norm
      )
        return;
      try {
        await api.googleSheetsUpdateLink({
          id: target.linkId,
          recordsConfig: { machineName: norm },
        });
        machineSavedRef.current = { linkId: target.linkId, value: norm };
        await refreshOverview();
      } catch (err) {
        onNotify(errMsg(err, '保存本机名称失败'));
      }
    },
    [onNotify, refreshOverview],
  );
  const activeRecMachine =
    activeLink?.kind === 'post_records' ? (activeLink.recordsConfig?.machineName ?? '电脑1号') : '';
  const activeRecId = activeLink?.kind === 'post_records' ? activeLink.id : null;
  useEffect(() => {
    if (
      machineLatestRef.current &&
      machineLatestRef.current.linkId !== activeRecId &&
      machineTimerRef.current
    )
      void flushMachineName(machineLatestRef.current);
    if (!activeRecId) {
      machineSavedRef.current = null;
      machineLatestRef.current = null;
      setMachineNameDraft('');
      return;
    }
    if (
      machineSavedRef.current?.linkId !== activeRecId ||
      (machineTimerRef.current === null && machineSavedRef.current.value !== activeRecMachine)
    ) {
      machineSavedRef.current = { linkId: activeRecId, value: activeRecMachine };
      machineLatestRef.current = { linkId: activeRecId, value: activeRecMachine };
      setMachineNameDraft(activeRecMachine);
    }
  }, [activeRecId, activeRecMachine, flushMachineName]);
  useEffect(
    () => () => {
      if (!machineTimerRef.current || !machineLatestRef.current) return;
      clearTimeout(machineTimerRef.current);
      const pending = machineLatestRef.current,
        norm = pending.value.trim() || '电脑1号';
      if (
        machineSavedRef.current?.linkId !== pending.linkId ||
        machineSavedRef.current.value !== norm
      )
        void api
          .googleSheetsUpdateLink({ id: pending.linkId, recordsConfig: { machineName: norm } })
          .catch(() => {});
    },
    [],
  );
  const configPatchChainRef = useRef<Promise<void>>(Promise.resolve()),
    failedGridLinksRef = useRef<Set<string>>(new Set()),
    activeGridReqSeqRef = useRef(0),
    activeLinkIdRef = useRef<string | null>(activeLink?.id ?? null);
  activeLinkIdRef.current = activeLink?.id ?? null;
  const isAuthorized = Boolean(overview?.auth.authorized);
  const prevAuthorizedRef = useRef<boolean>(isAuthorized);
  useEffect(() => {
    const wasAuthorized = prevAuthorizedRef.current;
    prevAuthorizedRef.current = isAuthorized;
    if (!wasAuthorized && isAuthorized) failedGridLinksRef.current.clear();
  }, [isAuthorized]);
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
        if (!silent && activeLinkIdRef.current === linkId && activeGridReqSeqRef.current === reqSeq)
          onNotify(errMsg(err, '读取 Google 表格内容失败'));
      } finally {
        if (!silent && activeGridReqSeqRef.current === reqSeq) setGridLoading(false);
      }
    },
    [overview?.auth.authorized, onNotify],
  );
  const activeLinkIdResolved = activeLink?.id ?? null;
  useEffect(() => {
    if (
      !activeLinkIdResolved ||
      !overview?.auth.authorized ||
      failedGridLinksRef.current.has(activeLinkIdResolved)
    )
      return;
    const cached = clientGridCache.get(activeLinkIdResolved);
    if (!cached) return void loadGrid(activeLinkIdResolved, false, false);
    setGridByLink((prev) =>
      prev[activeLinkIdResolved] === cached.snapshot
        ? prev
        : { ...prev, [activeLinkIdResolved]: cached.snapshot },
    );
    if (Date.now() - cached.cachedAt > 60_000) void loadGrid(activeLinkIdResolved, false, true);
  }, [activeLinkIdResolved, overview?.auth.authorized, loadGrid]);
  const activeGrid = activeLink ? (gridByLink[activeLink.id] ?? null) : null;
  const activeLogs = useMemo(() => {
    const logs = overview?.logs ?? [];
    return activeLink
      ? logs.filter((i) => i.linkId === activeLink.id || i.linkId === null).slice(0, 30)
      : logs.slice(0, 20);
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
      if (!options?.skipReloadGrid && activeLink) await loadGrid(activeLink.id, true);
      if (msg) onNotify(msg);
    } catch (err) {
      onNotify(errMsg(err, `${label}失败`));
    } finally {
      setBusyAction(null);
    }
  }
  async function stopActiveLink(linkId: string) {
    if (stoppingLink) return;
    setStoppingLink(true);
    try {
      await api.googleSheetsStopLink(linkId);
      await refreshOverview();
      onNotify('已发送停止指令');
    } catch (err) {
      onNotify(errMsg(err, '发送停止指令失败'));
    } finally {
      setStoppingLink(false);
    }
  }
  function enqueueConfigPatch(work: () => Promise<void>) {
    setPatchingConfig(true);
    const next = configPatchChainRef.current.then(work, work).finally(() => {
      if (configPatchChainRef.current === next) setPatchingConfig(false);
    });
    configPatchChainRef.current = next;
    return next;
  }
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  function patchLinkCfg<K extends 'scheduleConfig' | 'recordsConfig'>(
    key: K,
    linkId: string,
    patch: K extends 'scheduleConfig'
      ? Partial<PostScheduleSheetConfig>
      : Partial<PostRecordsSheetConfig>,
    toast?: string,
  ) {
    const cur = overviewRef.current;
    if (cur)
      onOverview({
        ...cur,
        links: cur.links.map((l) =>
          l.id === linkId && l[key] ? { ...l, [key]: { ...l[key], ...patch } } : l,
        ),
      });
    return enqueueConfigPatch(async () => {
      try {
        const updated = await api.googleSheetsUpdateLink({ id: linkId, [key]: patch });
        const latest = overviewRef.current;
        if (latest)
          onOverview({
            ...latest,
            links: latest.links.map((l) => (l.id === updated.id ? updated : l)),
          });
        else await refreshOverview();
        if (toast) onNotify(toast);
      } catch (err) {
        await refreshOverview();
        onNotify(errMsg(err, '保存设置失败'));
      }
    });
  }
  const saveModalRecordsPatch = (recordsConfig: Record<string, unknown>, msg: string) =>
    enqueueConfigPatch(async () => {
      if (!activeLink) return;
      await api.googleSheetsUpdateLink({ id: activeLink.id, recordsConfig });
      await refreshOverview();
      onNotify(msg);
    });
  const isRunning = Boolean(activeLink && activeLink.runtime.activeRunningCount > 0);
  const overviewGlobalConcurrency =
    (overview as { globalMaxConcurrency?: number | null } | null)?.globalMaxConcurrency ?? null;
  const effectiveGlobalConcurrency = p.globalMaxConcurrency ?? overviewGlobalConcurrency;
  const isAutoEnabled =
    activeLink?.kind === 'post_schedule'
      ? Boolean(activeLink.scheduleConfig?.enabled)
      : activeLink?.kind === 'post_records'
        ? Boolean(activeLink.recordsConfig?.enabled)
        : false;
  const kindOptions = useMemo(() => {
    const links = overview?.links ?? [];
    return KIND_ORDER.map((value) => {
      const c = links.filter((l) => l.kind === value).length;
      return { value, label: KIND_META[value][0], ...(c > 0 ? { count: c } : {}) };
    });
  }, [overview?.links]);
  const importOptions = activeLink
    ? ([
        {
          cls: 'border-emerald-300 bg-emerald-50/50 hover:bg-emerald-50',
          title: '增量导入（推荐）',
          badgeCls: 'bg-emerald-100 text-emerald-800',
          badge: '安全不删旧数据',
          desc: '新增表格里的新 ID，并按表格「类别」更新对应分组；软件里原有但表格里没有的条目会继续保留。',
          onClick: () => {
            setModal(null);
            void runAction('增量导入', async () => {
              const res = await api.googleSheetsImportLibrary(activeLink.id, 'incremental');
              onAfterLibrarySync();
              return res.summary;
            });
          },
        },
        {
          cls: 'border-amber-300 bg-amber-50/40 hover:bg-amber-50',
          title: '覆盖导入（与表格完全对齐）',
          badgeCls: 'bg-amber-100 text-amber-800',
          badge: '会删除多余条目',
          desc: '以当前 Google 表格为准：新增新 ID、更新分类，并移除软件里多余的不在表格中的条目。',
          onClick: () => setConfirmDlg({ kind: 'overwrite', link: activeLink }),
        },
      ] as const)
    : [];
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-hidden bg-[var(--bg)] p-3">
      {p.onSelectKind && (
        <div className="flex shrink-0 items-center pt-0.5">
          <UiSegmented<GoogleSheetKind>
            ariaLabel="切换云表类型"
            value={kind}
            options={kindOptions}
            onChange={p.onSelectKind}
          />
        </div>
      )}
      {!isAuthorized && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <div className={UI_ROW}>
            <strong>
              {overview?.auth.lastError ? 'Google 表格授权已失效' : '尚未完成 Google 表格授权'}
            </strong>
            <span className="text-xs text-amber-800">
              {overview?.auth.lastError || '请先前往授权与图床设置完成 Google 授权。'}
            </span>
          </div>
          <Btn v="primary" onClick={onOpenAuthMenu}>
            前往授权设置
          </Btn>
        </div>
      )}
      <GoogleSheetsTopbar
        kind={kind}
        title={title}
        addLabel={addLabel}
        activeLink={activeLink}
        allRecordLinks={allRecordLinks}
        profileGroups={p.profileGroups}
        profiles={p.profiles}
        bluestacksState={p.bluestacksState}
        isAuthorized={isAuthorized}
        isRunning={isRunning}
        isAutoEnabled={isAutoEnabled}
        busyAction={busyAction}
        stoppingLink={stoppingLink}
        patchingConfig={patchingConfig}
        machineNameDraft={machineNameDraft}
        onOpenConnect={() => setConnectTarget({ kind })}
        onOpenConnectRecordForSchedule={(id) =>
          setConnectTarget({ kind: 'post_records', bindScheduleId: id })
        }
        onOpenImportModal={() => setModal('import')}
        onOpenBumpModal={() => setModal('bump')}
        onOpenFreqModal={() => setModal('freq')}
        onConfirmDisconnect={(link) => setConfirmDlg({ kind: 'disconnect', link })}
        onRunAction={(l, w) => void runAction(l, w)}
        onStopActiveLink={(id) => void stopActiveLink(id)}
        onPatchScheduleConfig={(id, patch, toast) =>
          void patchLinkCfg('scheduleConfig', id, patch, toast)
        }
        onPatchRecordsConfig={(id, patch, toast) =>
          void patchLinkCfg('recordsConfig', id, patch, toast)
        }
        onMachineNameChange={(linkId, val) => {
          setMachineNameDraft(val);
          const payload = { linkId, value: val };
          machineLatestRef.current = payload;
          if (machineTimerRef.current) clearTimeout(machineTimerRef.current);
          machineTimerRef.current = setTimeout(() => {
            machineTimerRef.current = null;
            void flushMachineName(payload);
          }, 450);
        }}
        onMachineNameBlur={() => void flushMachineName()}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SheetDataGrid
          key={activeLink?.id ?? kind}
          snapshot={activeGrid}
          loading={gridLoading}
          emptyTitle={activeLink ? '表格暂无数据' : `尚未连接${title}`}
          emptyHint={emptyHint}
          showToolbar={true}
          enableStatusFilter={kind === 'post_schedule' || kind === 'post_records'}
          onResetStuckRows={
            kind === 'post_schedule' && activeLink && isAuthorized
              ? () =>
                  void runAction('重置卡死行', async () => {
                    const res = await api.googleSheetsResetStuckRows(activeLink.id);
                    return (
                      res.summary ||
                      (res.resetCount > 0
                        ? `已重置 ${res.resetCount} 条卡死行`
                        : '当前没有卡死行需要重置')
                    );
                  })
              : undefined
          }
          resettingStuck={busyAction === '重置卡死行'}
          refreshing={gridLoading}
          onNotify={onNotify}
          onRefresh={
            activeLink && isAuthorized ? () => void loadGrid(activeLink.id, true) : undefined
          }
        />
      </div>
      {activeLogs.length > 0 && (
        <div className="shrink-0 overflow-hidden rounded-lg border border-[var(--line)] bg-white">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 bg-slate-50 px-2.5 py-1.5 text-left text-xs hover:bg-slate-100"
            onClick={() => setLogsExpanded((v) => !v)}
          >
            <span className="min-w-0 truncate">
              <strong>动态日志</strong> ·{' '}
              {new Date(activeLogs[0]?.createdAt ?? Date.now()).toLocaleTimeString()} ·{' '}
              {activeLogs[0]?.summary}
            </span>
            <span className="shrink-0 text-xs text-[var(--text-3)]">
              {logsExpanded ? '收起 ▲' : `展开最近 ${activeLogs.length} 条 ▼`}
            </span>
          </button>
          {logsExpanded && (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-[var(--line)] px-2.5 py-1.5 text-xs">
              {activeLogs.map((log) => (
                <div
                  key={log.id}
                  className={`flex items-baseline gap-2 ${log.level === 'error' ? 'text-rose-700' : log.level === 'warn' ? 'text-amber-700' : ''}`}
                >
                  <span className="shrink-0 font-mono text-[11px] text-[var(--text-3)]">
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </span>
                  <span>{log.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {multi && linksOfKind.length > 0 && (
        <SheetBottomTabs
          links={linksOfKind}
          activeLinkId={activeLink?.id ?? null}
          addLabel={addLabel}
          onSelect={setActiveLinkId}
          onAdd={() => (!isAuthorized ? onOpenAuthMenu() : setConnectTarget({ kind }))}
          onDelete={(link) => setConfirmDlg({ kind: 'disconnect', link })}
          onRename={async (id, nextTitle) => {
            try {
              await api.googleSheetsUpdateLink({ id, title: nextTitle });
              await refreshOverview();
              onNotify(`已重命名为「${nextTitle}」`);
            } catch (err) {
              onNotify(errMsg(err, '重命名失败'));
            }
          }}
        />
      )}
      {connectTarget && (
        <SheetConnectModal
          kind={connectTarget.kind}
          sameDocSuggestionUrl={activeLink?.spreadsheetUrl}
          sameDocSuggestionLabel={
            connectTarget.bindScheduleId ? '填入当前排贴表所属文档并读取' : undefined
          }
          existingLinks={overview?.links ?? []}
          onClose={() => setConnectTarget(null)}
          onConnected={(id) => {
            const bindId = connectTarget.bindScheduleId;
            setConnectTarget(null);
            if (bindId)
              void patchLinkCfg(
                'scheduleConfig',
                bindId,
                { targetRecordLinkId: id },
                '已连接发帖记录表并自动绑定',
              );
            else {
              setActiveLinkId(id);
              void refreshOverview().then(() => loadGrid(id, true));
              onNotify(`已连接${title}`);
            }
          }}
        />
      )}
      {modal === 'bump' && activeLink?.kind === 'post_records' && (
        <RecordsBumpConfigModal
          link={activeLink}
          onClose={() => setModal(null)}
          onSave={(patch) =>
            saveModalRecordsPatch(
              {
                commentPool: patch.commentPool,
                bumperSettings: {
                  ...(activeLink.recordsConfig?.bumperSettings ?? {}),
                  likeProbability: patch.likeProbability,
                  commentProbability: patch.commentProbability,
                  consumeCommentOnUse: patch.consumeCommentOnUse,
                  enableSound: patch.enableSound,
                  useLongPressReaction: patch.useLongPressReaction,
                  reactionTypes: patch.reactionTypes,
                },
              },
              '顶贴配置已保存',
            )
          }
        />
      )}
      {modal === 'freq' && activeLink?.kind === 'post_records' && (
        <RecordsFrequencyModal
          link={activeLink}
          globalMaxConcurrency={effectiveGlobalConcurrency}
          onClose={() => setModal(null)}
          onSave={(patch) =>
            saveModalRecordsPatch(
              {
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
              '频率限制已保存',
            )
          }
        />
      )}
      {modal === 'import' && activeLink && (
        <BackdropModal
          label="选择导入方式"
          modalClass="contents"
          blockEscape={confirmDlg?.kind === 'overwrite'}
          onClose={() => setModal(null)}
        >
          <div className="modal flex w-[min(540px,92vw)] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white text-[var(--text)] shadow-2xl">
            <ModalHeading
              title={`从${title}导入软件库`}
              subtitle="请选择如何将表格中的 ID 与类别同步到本机软件库："
              onClose={() => setModal(null)}
            />
            <div className="flex flex-col gap-2.5 p-4">
              {importOptions.map((opt) => (
                <button
                  key={opt.title}
                  type="button"
                  className={`flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${opt.cls}`}
                  disabled={Boolean(busyAction)}
                  onClick={opt.onClick}
                >
                  <div className={UI_BETWEEN}>
                    <strong className="text-sm font-semibold text-slate-900">{opt.title}</strong>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${opt.badgeCls}`}
                    >
                      {opt.badge}
                    </span>
                  </div>
                  <p className="m-0 text-xs leading-relaxed text-[var(--text-2)]">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </BackdropModal>
      )}
      {confirmDlg && (
        <ConfirmDialog
          title={
            confirmDlg.kind === 'disconnect'
              ? `确认移除「${confirmDlg.link.title}」`
              : '确认覆盖导入软件库'
          }
          description={
            confirmDlg.kind === 'disconnect'
              ? '移除连接后工作台将停止读写此工作表（不会删除或修改 Google 云端表格文件）。'
              : `确定要执行「覆盖导入」吗？软件内存在但云端${title}里没有的条目将被从软件库删除（已有本地头像不会被清空）。`
          }
          label={confirmDlg.kind === 'disconnect' ? '确认移除' : '确认覆盖导入'}
          onClose={() => setConfirmDlg(null)}
          onConfirm={async () => {
            const { kind: dlgKind, link } = confirmDlg;
            setConfirmDlg(null);
            if (dlgKind === 'overwrite') {
              setModal(null);
              return void (await runAction('覆盖导入', async () => {
                const res = await api.googleSheetsImportLibrary(link.id, 'overwrite');
                onAfterLibrarySync();
                return res.summary;
              }));
            }
            const idx = linksOfKind.findIndex((i) => i.id === link.id),
              fallback = linksOfKind[idx + 1]?.id ?? linksOfKind[idx - 1]?.id ?? null;
            await runAction(
              '移除表格连接',
              async () => {
                await api.googleSheetsDeleteLink(link.id);
                failedGridLinksRef.current.delete(link.id);
                clientGridCache.delete(link.id);
                setGridByLink((prev) => {
                  const n = { ...prev };
                  delete n[link.id];
                  return n;
                });
                if (activeLinkId === link.id) setActiveLinkId(fallback);
                return `已移除「${link.title}」`;
              },
              { skipReloadGrid: true },
            );
          }}
        />
      )}
    </div>
  );
}
