import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { Combination, Profile, SavedCombination, Workspace } from '../shared/contracts.js';
import type { GoogleSheetKind } from '../shared/google-sheets.js';
import type { PostBumpStatusValue } from '../shared/post-bump-records.js';
import type { Inspection } from '../shared/profile-inspection.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import { readStoredCloseBrowserOnFinish } from './modules/module-contracts.js';
import { api } from './api.js';
import type { useCardColors } from './card-colors.js';
import type { SheetsModuleId } from './modules/module-contracts.js';
import type { RecordsTabId } from './modules/post-bump-records-page.js';
import type { buildWorkbenchProjection } from './modules/profile-activity-projector.js';
import { Btn } from './modules/shared/module-ui.js';
import {
  mapBluestacksToScopeOptions,
  mapProfilesToScopeOptions,
} from './modules/shared/target-scope-bar.js';
import type { useFeatureModulesPolling } from './modules/shared/use-feature-module-polling.js';
import type { useTasks } from './use-tasks.js';
import type { useWorkbenchActions } from './use-workbench-actions.js';
const lz = <P,>(fn: () => Promise<ComponentType<P>>) => lazy(async () => ({ default: await fn() }));
const ActiveAccountsPage = lz(() =>
  import('./active-accounts-page.js').then((m) => m.ActiveAccountsPage),
);
const WindowLayoutPage = lz(() =>
  import('./modules/window-layout-page.js').then((m) => m.WindowLayoutPage),
);
const AutoSchedulerPage = lz(() =>
  import('./auto-scheduler-page.js').then((m) => m.AutoSchedulerPage),
);
import { Editor } from './editor.js';
const GroupBumperPage = lz(() => import('./group-bumper-page.js').then((m) => m.GroupBumperPage));
const InviterWorkspacePage = lz(() =>
  import('./inviter-workspace-page.js').then((m) => m.InviterWorkspacePage),
);
const GroupPosterPage = lz(() => import('./group-poster-page.js').then((m) => m.GroupPosterPage));
const GoogleSheetsPage = lz(() =>
  import('./modules/sheets/google-sheets-page.js').then((m) => m.GoogleSheetsPage),
);
const PostBumpRecordsPage = lz(() =>
  import('./modules/post-bump-records-page.js').then((m) => m.PostBumpRecordsPage),
);
const Sidebar = lz(() => import('./sidebar.js').then((m) => m.Sidebar));
const BluestacksSidebar = lz(() =>
  import('./modules/bluestacks-sidebar.js').then((m) => m.BluestacksSidebar),
);
const SHEET_KIND_BY_VIEW: Record<string, GoogleSheetKind> = {
  'sheets-groups': 'group_library',
  'sheets-pages': 'page_library',
  'sheets-schedule': 'post_schedule',
  'sheets-records': 'post_records',
};
const VIEW_BY_SHEET_KIND: Record<GoogleSheetKind, SheetsModuleId> = {
  group_library: 'sheets-groups',
  page_library: 'sheets-pages',
  post_schedule: 'sheets-schedule',
  post_records: 'sheets-records',
};
export class WorkbenchErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="flex flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-slate-200 bg-white/80 p-8 text-center text-[var(--text-2)]"
        role="alert"
      >
        <strong className="text-sm font-semibold text-slate-800">
          {this.props.label || '页面加载出现异常'}
        </strong>
        <p className="max-w-[480px] text-xs break-words text-[var(--text-3)]">
          {this.state.error.message || '请尝试重新加载页面'}
        </p>
        <div className="flex gap-2">
          <Btn onClick={() => this.setState({ error: null })}>重试渲染</Btn>
          <Btn v="primary" onClick={() => window.location.reload()}>
            重新加载页面
          </Btn>
        </div>
      </div>
    );
  }
}
export type View =
  | { kind: 'home' }
  | {
      kind: 'edit';
      carrier?: 'browser' | 'bluestacks';
      row: SavedCombination | null;
      initialValue?: Combination;
      editorKey: string;
    }
  | { kind: 'auto-scheduler' }
  | { kind: 'records' }
  | { kind: 'window-layout' }
  | { kind: 'group-inviter' }
  | { kind: 'group-bumper' }
  | { kind: 'page-bumper' }
  | { kind: 'group-poster' }
  | { kind: 'sheets-groups' }
  | { kind: 'sheets-pages' }
  | { kind: 'sheets-schedule' }
  | { kind: 'sheets-records' }
  | { kind: 'bluestacks-active' }
  | { kind: 'bluestacks-group-poster' }
  | { kind: 'bluestacks-group-bumper' }
  | { kind: 'bluestacks-page-bumper' }
  | { kind: 'bluestacks-group-inviter' };
export interface LedgerFilterState {
  tab: RecordsTabId;
  status: 'all' | PostBumpStatusValue;
  nonce: number;
}
export interface ShellCtx {
  workspace: Workspace;
  mergedProfiles: Profile[];
  inspections: {
    rows: Inspection[];
    available: boolean;
    error: string;
    refresh: (force?: boolean) => Promise<unknown>;
  };
  tasks: ReturnType<typeof useTasks>;
  mods: ReturnType<typeof useFeatureModulesPolling>;
  busy: boolean;
  selected: Set<string>;
  setSelected: (ids: Set<string>) => void;
  selectedBluestacks: Set<string>;
  setSelectedBluestacks: (ids: Set<string>) => void;
  projection: ReturnType<typeof buildWorkbenchProjection>;
  actions: ReturnType<typeof useWorkbenchActions>;
  mutate: (work: () => Promise<unknown>) => Promise<void>;
  forceRefreshWorkspace: () => Promise<void>;
  setMessage: (msg: string) => void;
}
interface RouterCtx {
  view: View;
  setView: (updater: View | ((prev: View) => View)) => void;
  carrier: 'browser' | 'bluestacks';
  cardColors: ReturnType<typeof useCardColors>;
  resourceSummaries: ResourceUsageSummaryValue[] | null;
  setResourceSummaries: (v: ResourceUsageSummaryValue[] | null) => void;
  onOpenResources: (row: SavedCombination) => void;
  refreshResources: () => Promise<void>;
  openQuickSchedule: (seed: QuickScheduleSeed) => void;
  onOpenLiveRuns: () => void;
  openLedgerRecords: (opts: { tab?: RecordsTabId; status?: 'all' | PostBumpStatusValue }) => void;
  ledger: LedgerFilterState;
  onOpenMenuSection: (section: 'logs' | 'google-sheets') => void;
  onCarrierChange?: (carrier: 'browser' | 'bluestacks') => void;
  navigate: (next: View) => Promise<void>;
}
export function WorkbenchViewRouter({
  shell: s,
  router: r,
}: {
  shell: ShellCtx;
  router: RouterCtx;
}) {
  const m = s.mods,
    v = r.view;
  const syncShared = (bumper = true, poster = true, inviter = true) =>
    void Promise.allSettled([
      ...(bumper ? [api.bumperState().then(m.setGroupBumper)] : []),
      ...(poster ? [api.posterState().then(m.setGroupPoster)] : []),
      ...(inviter ? [api.groupInviterState().then(m.setGroupInviter)] : []),
    ]);
  const bsCommon = {
    bluestacksState: m.bluestacks,
    onBluestacksState: m.setBluestacks,
    onQuickSchedule: r.openQuickSchedule,
    onOpenLiveRuns: r.onOpenLiveRuns,
    onSelectBluestacks: s.setSelectedBluestacks,
    onMessage: s.setMessage,
  };
  const startSavedCombo = async (
    savedRow: SavedCombination,
    editCarrier: 'browser' | 'bluestacks',
  ) =>
    s.mutate(async () => {
      if (editCarrier === 'bluestacks') {
        const bs = m.bluestacks;
        const isBusy = (id: string) =>
          Boolean(
            bs?.activeProfileCounts?.[id]?.running ||
            bs?.posterProfileCounts?.[id]?.running ||
            bs?.inviterProfileCounts?.[id]?.running ||
            bs?.profileCounts?.[id]?.running ||
            bs?.pageBumperProfileCounts?.[id]?.running,
          );
        const eligibleIds = [...s.selectedBluestacks].filter((id) => !isBusy(id)).sort();
        if (!eligibleIds.length) throw Error('组合已保存，但没有可用的空闲已选蓝蝶模拟器');
        let closeWin = false;
        try {
          closeWin = window.localStorage.getItem('wb.bluestacksActive.closeWindowOnFinish') === '1';
        } catch {}
        m.setBluestacks(
          await api.bluestacksAction('active/start', {
            instanceIds: eligibleIds,
            combinationId: savedRow.id,
            ...(closeWin ? { closeWindowOnFinish: true } : {}),
          }),
        );
        return `组合已保存并启动：${eligibleIds.length} 台蓝蝶`;
      }
      const usesTable = savedRow.saved?.steps.some(
        (st) => st.type === 'post' && st.resourceMode === 'table',
      );
      const latest = usesTable ? await api.resourceSummaries() : r.resourceSummaries;
      if (usesTable) r.setResourceSummaries(latest);
      const revision = latest?.find((x) => x.combinationId === savedRow.id)?.revision;
      if (usesTable && !revision)
        throw Error('组合已保存，但尚未读取发帖资源，请先在「发帖资源」中导入');
      const busyIds = new Set(
        [...s.selected].filter((id) => s.projection.projectedControls.isProfileBusy(id)),
      );
      const eligibleIds = [...s.selected].filter((id) => !busyIds.has(id)).sort();
      if (!eligibleIds.length) throw Error('组合已保存，但所选浏览器均在运行任务中');
      const result = await s.tasks.start({
        combinationId: savedRow.id,
        version: savedRow.version,
        profileIds: eligibleIds,
        ...(usesTable ? { expectedResourceRevision: revision } : {}),
        ...(readStoredCloseBrowserOnFinish() ? { closeBrowserOnFinish: true } : {}),
      });
      return `组合已保存并启动：已分配 ${result.plans.length} 份任务${busyIds.size ? `（跳过 ${busyIds.size} 个运行中资料）` : ''}`;
    });
  const sheetKind = SHEET_KIND_BY_VIEW[v.kind];
  const activeCarrier = v.kind === 'bluestacks-active' ? 'bluestacks' : 'browser';
  const editCarrier = v.kind === 'edit' ? (v.carrier ?? r.carrier) : r.carrier;
  const openEditView = (row: SavedCombination | null, initialValue?: Combination) =>
    r.setView({
      kind: 'edit',
      carrier: activeCarrier,
      row,
      ...(initialValue ? { initialValue } : {}),
      editorKey: row?.id ?? crypto.randomUUID(),
    });
  return (
    <WorkbenchErrorBoundary resetKey={v.kind} label="当前功能页面加载异常">
      <Suspense
        fallback={
          <div
            className="flex items-center justify-center p-10 text-xs font-medium text-[var(--text-3)]"
            role="status"
          >
            <strong>正在加载页面…</strong>
          </div>
        }
      >
        {(v.kind === 'home' || v.kind === 'bluestacks-active') && (
          <ActiveAccountsPage
            carrier={activeCarrier}
            workspace={s.workspace}
            selected={s.selected}
            tasks={s.tasks}
            cardColors={r.cardColors}
            busy={s.busy}
            resourceSummaries={r.resourceSummaries}
            selectionControls={s.projection.projectedControls}
            bluestacksState={m.bluestacks}
            onBluestacksState={m.setBluestacks}
            selectedBluestacks={s.selectedBluestacks}
            onSelectBluestacks={s.setSelectedBluestacks}
            onSelectProfiles={s.setSelected}
            onSetResourceSummaries={r.setResourceSummaries}
            onOpenResources={r.onOpenResources}
            onEditCombination={(row) => openEditView(row)}
            onNewCombination={(initialValue) => openEditView(null, initialValue)}
            onQuickSchedule={r.openQuickSchedule}
            onOpenLiveRuns={r.onOpenLiveRuns}
            onRefreshWorkspace={s.forceRefreshWorkspace}
            onRefreshResources={r.refreshResources}
            onMutate={s.mutate}
            onNotify={s.setMessage}
          />
        )}
        {v.kind === 'window-layout' && (
          <WindowLayoutPage
            profiles={s.workspace.profiles}
            profileGroups={s.workspace.groups}
            selectedProfileIds={s.selected}
            onSelectProfiles={s.setSelected}
            bluestacks={m.bluestacks}
            selectedBluestacksIds={s.selectedBluestacks}
            onSelectBluestacks={s.setSelectedBluestacks}
            onRefreshBluestacks={async () => m.setBluestacks(await api.bluestacksState(false))}
            onBluestacksState={m.setBluestacks}
            initialCarrier={r.carrier}
            onCarrierChange={r.onCarrierChange}
            onNotify={s.setMessage}
          />
        )}
        {v.kind === 'auto-scheduler' && (
          <AutoSchedulerPage
            state={m.autoScheduler}
            onState={m.setAutoScheduler}
            profiles={s.workspace.profiles}
            profileGroups={s.workspace.groups}
            selectedProfileIds={s.selected}
            combinations={s.workspace.combinations}
            bumperState={m.groupBumper}
            posterState={m.groupPoster}
            inviterState={m.groupInviter}
            bluestacksState={m.bluestacks}
            defaultCarrier={r.carrier}
            onOpenLiveRuns={r.onOpenLiveRuns}
            onMessage={s.setMessage}
          />
        )}
        {v.kind === 'records' && (
          <PostBumpRecordsPage
            initialTab={r.ledger.tab}
            initialStatus={r.ledger.status}
            filterNonce={r.ledger.nonce}
            onNotify={s.setMessage}
          />
        )}
        {(v.kind === 'group-poster' || v.kind === 'bluestacks-group-poster') && (
          <GroupPosterPage
            carrier={v.kind === 'bluestacks-group-poster' ? 'bluestacks' : 'browser'}
            state={m.groupPoster}
            selected={s.selected}
            profiles={s.workspace.profiles}
            logProfiles={s.mergedProfiles}
            profileGroups={s.workspace.groups}
            selectedBluestacks={s.selectedBluestacks}
            onSelectProfiles={s.setSelected}
            onState={(next) => {
              m.setGroupPoster(next);
              void m.refreshGroupInviter();
            }}
            onOpenRecords={() => r.openLedgerRecords({ tab: 'posts' })}
            {...bsCommon}
          />
        )}
        {v.kind === 'bluestacks-group-inviter' && (
          <InviterWorkspacePage
            carrier="bluestacks"
            state={m.groupInviter ?? null}
            selectedTargetIds={s.selectedBluestacks}
            fallbackGroups={m.groupBumper?.groups ?? []}
            scopeItems={mapBluestacksToScopeOptions(m.bluestacks)}
            scopeGroups={(m.bluestacks?.folders ?? []).map((f) => ({ id: f.id, name: f.name }))}
            onSelectTargets={s.setSelectedBluestacks}
            onRefresh={async () => syncShared()}
            {...bsCommon}
          />
        )}
        {(v.kind === 'group-bumper' ||
          v.kind === 'page-bumper' ||
          v.kind === 'bluestacks-group-bumper' ||
          v.kind === 'bluestacks-page-bumper') && (
          <GroupBumperPage
            key={v.kind}
            mode={v.kind}
            state={m.groupBumper}
            selected={v.kind.startsWith('bluestacks-') ? s.selectedBluestacks : s.selected}
            profiles={s.mergedProfiles}
            profileGroups={s.workspace.groups}
            onSelectProfiles={s.setSelected}
            onState={(next) => {
              m.setGroupBumper(next);
              void m.refreshGroupInviter();
              m.refreshPoster();
            }}
            onOpenRecords={() => r.openLedgerRecords({ tab: 'bumps' })}
            {...bsCommon}
          />
        )}
        {sheetKind && (
          <GoogleSheetsPage
            key={v.kind}
            kind={sheetKind}
            overview={m.googleSheets}
            onOverview={m.setGoogleSheets}
            profileGroups={s.workspace.groups}
            profiles={s.workspace.profiles}
            bluestacksState={m.bluestacks}
            onSelectKind={(nextKind) => void r.navigate({ kind: VIEW_BY_SHEET_KIND[nextKind] })}
            onOpenAuthMenu={() => r.onOpenMenuSection('google-sheets')}
            onAfterLibrarySync={() => {
              m.refreshBumper();
              m.refreshPoster();
              void m.refreshGroupInviter();
            }}
            onNotify={s.setMessage}
          />
        )}
        {v.kind === 'group-inviter' && (
          <InviterWorkspacePage
            carrier="browser"
            state={m.groupInviter}
            loaded={m.groupInviterLoaded}
            selectedTargetIds={s.selected}
            externalBusy={s.busy}
            scopeItems={mapProfilesToScopeOptions(s.workspace.profiles)}
            scopeGroups={s.workspace.groups}
            onSelectTargets={s.setSelected}
            onRefresh={async () => m.setGroupInviter(await api.groupInviterState())}
            onAddGroups={async (items) => {
              m.setGroupInviter(await api.addInviterGroups({ items }));
              syncShared(true, true, false);
              s.setMessage(`已保存 ${items.length} 个小组，正在后台获取小组头像`);
            }}
            onDeleteGroups={(groupIds) =>
              s.mutate(async () => {
                m.setGroupInviter(await api.deleteInviterGroups({ groupIds }));
                syncShared(true, true, false);
                return `已删除 ${groupIds.length} 个小组`;
              })
            }
            onSaveInvitesPerGroup={async (invitesPerGroup) =>
              m.setGroupInviter(await api.saveGroupInviterSettings({ invitesPerGroup }))
            }
            onStartBrowser={(groupIds, invitesPerGroup) =>
              s.mutate(async () => {
                const targetIds = (
                  m.groupInviter?.running
                    ? [...s.selected].filter((id) => !m.groupInviter?.profileCounts[id]?.running)
                    : [...s.selected]
                ).sort();
                const next = await api.startGroupInviter({
                  profileIds: targetIds,
                  groupIds,
                  invitesPerGroup,
                  closeBrowserOnFinish: Boolean(m.groupInviter?.closeBrowserOnFinish),
                });
                m.setGroupInviter(next);
                const skipped = targetIds.filter((id) =>
                  next.profileCounts[id]?.status?.startsWith('跳过'),
                ).length;
                return `已启动小组邀请人：${Math.max(0, targetIds.length - skipped)} 个账号 × ${groupIds.length} 个小组${skipped > 0 ? `（已自动跳过 ${skipped} 个不可用或运行中账号）` : ''}`;
              })
            }
            onStopBrowser={() =>
              s.mutate(async () => {
                m.setGroupInviter(await api.stopGroupInviter());
                return '已发送停止小组邀请人指令';
              })
            }
            onQuickSchedule={r.openQuickSchedule}
            onOpenLiveRuns={r.onOpenLiveRuns}
            onMessage={s.setMessage}
          />
        )}
        {v.kind === 'edit' && (
          <Editor
            key={v.editorKey}
            carrier={editCarrier}
            initial={v.row}
            initialValue={v.initialValue}
            selectedProfiles={s.workspace.profiles.filter((p) => s.selected.has(p.id))}
            selectedTargetCount={
              editCarrier === 'bluestacks'
                ? s.selectedBluestacks.size
                : s.workspace.profiles.filter((p) => s.selected.has(p.id)).length
            }
            onCreated={(created) =>
              r.setView((prev) =>
                prev.kind === 'edit' && prev.editorKey === v.editorKey
                  ? { ...prev, row: created }
                  : prev,
              )
            }
            onResources={r.onOpenResources}
            resourceUsage={
              v.row
                ? (r.resourceSummaries?.find((i) => i.combinationId === v.row?.id) ?? null)
                : null
            }
            resourceUsageLoaded={v.row ? r.resourceSummaries !== null : true}
            onSaved={s.forceRefreshWorkspace}
            onSavedAndStart={(savedRow) => startSavedCombo(savedRow, editCarrier)}
            onClose={() =>
              void r.navigate({ kind: editCarrier === 'bluestacks' ? 'bluestacks-active' : 'home' })
            }
            notify={s.setMessage}
          />
        )}
      </Suspense>
    </WorkbenchErrorBoundary>
  );
}
const SIDEBAR_KEY = 'workbench.sidebar-width.v1';
const clampW = (v: number) => Math.min(420, Math.max(240, v));
function SidebarResizer() {
  const [width, setWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem(SIDEBAR_KEY));
      return Number.isFinite(n) && n >= 240 && n <= 420 ? n : 290;
    } catch {
      return 290;
    }
  });
  const handle = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    handle.current?.parentElement?.style.setProperty('--sidebar-width', `${width}px`);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(width));
    } catch {}
  }, [width]);
  return (
    <div
      ref={handle}
      className="sidebar-resizer relative z-[2] -ml-0.5 w-1 shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none"
      role="separator"
      tabIndex={0}
      aria-label="调整浏览器侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={240}
      aria-valuemax={420}
      aria-valuenow={width}
      onPointerDown={(e) => {
        if (e.button === 0) {
          drag.current = { x: e.clientX, width };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      }}
      onPointerMove={(e) =>
        drag.current && setWidth(clampW(drag.current.width + e.clientX - drag.current.x))
      }
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => setWidth(290)}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
        e.preventDefault();
        setWidth(e.key === 'Home' ? 290 : clampW(width + (e.key === 'ArrowRight' ? 10 : -10)));
      }}
    />
  );
}
export function WorkbenchSidebarPane({
  shell,
  carrier,
  viewKind,
  onRename,
  onInspect,
  onHideSidebar,
}: {
  shell: ShellCtx;
  carrier: 'browser' | 'bluestacks';
  viewKind: View['kind'];
  onRename: (profile: Profile) => void;
  onInspect: () => void;
  onHideSidebar: () => void;
}) {
  const {
    workspace,
    mods,
    selectedBluestacks,
    setSelectedBluestacks,
    selected,
    setSelected,
    tasks,
    actions,
    mutate,
    inspections,
    busy,
    projection,
    forceRefreshWorkspace,
    setMessage,
  } = shell;
  const { bluestacks, setBluestacks, groupBumper, groupInviter } = mods;
  const bsMode =
    viewKind === 'bluestacks-active' ||
    viewKind === 'bluestacks-group-poster' ||
    viewKind === 'bluestacks-group-bumper' ||
    viewKind === 'bluestacks-page-bumper' ||
    viewKind === 'bluestacks-group-inviter'
      ? viewKind
      : 'bluestacks-active';
  return (
    <>
      <Suspense
        fallback={
          <aside
            className="sidebar flex min-h-0 w-[var(--sidebar-width,290px)] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--sidebar-bg)]"
            aria-busy="true"
          />
        }
      >
        {carrier === 'bluestacks' ? (
          <BluestacksSidebar
            mode={bsMode}
            state={bluestacks}
            onChange={setBluestacks}
            selected={selectedBluestacks}
            onSelect={setSelectedBluestacks}
            onError={setMessage}
            onHideSidebar={onHideSidebar}
          />
        ) : (
          <Sidebar
            tasks={tasks.runtime}
            onTaskCommand={actions.commandPlans}
            workspace={workspace}
            selected={selected}
            onSelect={setSelected}
            nameAction="select"
            filteredId={null}
            onInspect={onInspect}
            mutate={mutate}
            inspections={inspections.rows}
            inspectionAvailable={inspections.available}
            inspectionError={inspections.error}
            busy={busy}
            onCheck={actions.checkProfiles}
            onRename={onRename}
            onShow={(id) =>
              void mutate(() => api.showBrowser(id).then(() => '已显示对应浏览器页面'))
            }
            activities={projection.projectedActivities}
            selectionControls={projection.projectedControls}
            bumperCounts={
              viewKind === 'group-bumper'
                ? groupBumper?.profileCounts
                : viewKind === 'page-bumper'
                  ? (groupBumper?.pageBumperProfileCounts ?? {})
                  : undefined
            }
            bumperRunningIds={projection.bumperRunningIds}
            groupInviterCounts={
              viewKind === 'group-inviter' ? (groupInviter?.profileCounts ?? {}) : null
            }
            groupInviterRunningIds={projection.inviterRunningIds}
            onStopModules={(ids) => actions.stopProfilesUnified([], ids)}
            onStopProfiles={actions.stopProfilesUnified}
            onRefreshWorkspace={forceRefreshWorkspace}
            onNotify={setMessage}
            onHideSidebar={onHideSidebar}
          />
        )}
      </Suspense>
      <SidebarResizer />
    </>
  );
}
