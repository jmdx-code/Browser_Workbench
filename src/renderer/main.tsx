import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Profile, SavedCombination } from '../shared/contracts.js';
import type { DesktopBridge } from '../shared/desktop.js';
import type { BumperState } from '../shared/group-bumper.js';
import type { GroupInviterState } from '../shared/group-inviter.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import type { TaskCommand } from '../shared/task-contracts.js';
import { ActiveAccountsPage } from './active-accounts-page.js';
import { api } from './api.js';
import { AppMenu } from './app-menu.js';
import { useCardColors } from './card-colors.js';
import { DiagnosticFeedbackModal } from './diagnostic-feedback-modal.js';
import { Editor, type EditorHandle } from './editor.js';
import { FeatureNavRail } from './feature-nav-rail.js';
import { GroupBumperPage, PageBumperPage } from './group-bumper-page.js';
import { GroupInviterPage } from './group-inviter-page.js';
import { IconClose } from './icons.js';
import { buildWorkbenchProjection } from './modules/profile-activity-projector.js';
import { NameDialog } from './name-dialog.js';
import { RecordDetailDrawer } from './record-detail.js';
import { ResourceTableEditor, type ResourceEditorHandle } from './resource-table-editor.js';
import { SidebarResizer } from './sidebar-resizer.js';
import { Sidebar } from './sidebar.js';
import { useSoftwareUpdate } from './software-update-panel.js';
import { attentionPlans } from './task-alerts.js';
import { TaskRecordsPage } from './task-records.js';
import { useInspections } from './use-inspections.js';
import { useTasks } from './use-tasks.js';
import { useWorkspace } from './use-workspace.js';
import { WorkbenchTopbar } from './workbench-topbar.js';
import './style.css';
import './design-system.css';
declare const __WORKBENCH_VERSION__: string;
declare global {
  interface Window {
    workbenchDesktop?: DesktopBridge;
  }
}
type View =
  | { kind: 'home' }
  | { kind: 'edit'; row: SavedCombination }
  | { kind: 'records' }
  | { kind: 'group-inviter' }
  | { kind: 'group-bumper' }
  | { kind: 'page-bumper' };
function App() {
  const { workspace, error, refresh } = useWorkspace();
  const inspections = useInspections();
  const tasks = useTasks();
  const cardColors = useCardColors();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>({ kind: 'home' });
  const [recordFilter, setRecordFilter] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    profileId: string;
    planId: string;
    round?: number;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [diagModalOpen, setDiagModalOpen] = useState(false);
  const updates = useSoftwareUpdate();
  const [updateMenu, setUpdateMenu] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const [aliasing, setAliasing] = useState<Profile | null>(null);
  const editor = useRef<EditorHandle>(null);
  const resourceEditor = useRef<ResourceEditorHandle>(null);
  const [resourceRow, setResourceRow] = useState<SavedCombination | null>(null);
  const [resourceSummaries, setResourceSummaries] = useState<ResourceUsageSummaryValue[] | null>(
    null,
  );
  const [groupBumper, setGroupBumper] = useState<BumperState | null>(null);
  useEffect(() => {
    let live = true;
    const refreshBumper = () =>
      void api
        .bumperState()
        .then((next) => live && setGroupBumper(next))
        .catch(() => {});
    refreshBumper();
    const timer = setInterval(
      refreshBumper,
      view.kind === 'group-bumper' ||
        view.kind === 'page-bumper' ||
        groupBumper?.running ||
        groupBumper?.pageBumperRunning
        ? 2000
        : 6000,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [view.kind, groupBumper?.running, groupBumper?.pageBumperRunning]);
  const [groupInviter, setGroupInviter] = useState<GroupInviterState | null>(null);
  const [groupInviterLoaded, setGroupInviterLoaded] = useState(false);
  const resourceGeneration = useRef(0);
  async function applyUpdate() {
    if (resourceEditor.current && !(await resourceEditor.current.persist())) return;
    if (editor.current && !(await editor.current.persist())) return;
    await updates.apply();
  }
  const refreshGroupInviter = useCallback(async () => {
    await api
      .groupInviterState()
      .then(setGroupInviter)
      .catch(() => {})
      .finally(() => setGroupInviterLoaded(true));
  }, []);
  useEffect(() => {
    void refreshGroupInviter();
    const intervalMs = view.kind === 'group-inviter' || groupInviter?.running ? 2000 : 6000;
    const timer = setInterval(() => void refreshGroupInviter(), intervalMs);
    return () => clearInterval(timer);
  }, [refreshGroupInviter, view.kind, groupInviter?.running]);
  const refreshResources = useCallback(async () => {
    const generation = ++resourceGeneration.current;
    await api
      .resourceSummaries()
      .then((v) => generation === resourceGeneration.current && setResourceSummaries(v))
      .catch(() => generation === resourceGeneration.current && setResourceSummaries(null));
  }, []);
  useEffect(() => {
    if (view.kind !== 'home' && view.kind !== 'edit') return;
    void refreshResources();
    const timer = setInterval(() => void refreshResources(), 5000);
    return () => {
      clearInterval(timer);
      resourceGeneration.current++;
    };
  }, [refreshResources, view.kind]);
  useEffect(
    () =>
      window.workbenchDesktop?.onBeforeClose(async () => {
        if (resourceEditor.current && !(await resourceEditor.current.persist())) return false;
        return editor.current ? editor.current.persist() : true;
      }),
    [],
  );
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  async function navigate(next: View) {
    if (resourceEditor.current && !(await resourceEditor.current.persist())) return;
    if (view.kind === 'edit' && editor.current && !(await editor.current.persist())) return;
    setResourceRow(null);
    setView(next);
  }
  const mutate = useCallback(
    async (work: () => Promise<unknown>) => {
      if (mutating.current) return;
      mutating.current = true;
      setBusy(true);
      try {
        const result = await work();
        await refresh();
        setMessage(typeof result === 'string' ? result : '已保存');
      } catch (failure) {
        setMessage(failure instanceof Error ? failure.message : '操作失败');
      } finally {
        setBusy(false);
        mutating.current = false;
      }
    },
    [refresh],
  );
  function checkProfiles(ids: string[]) {
    void mutate(async () => {
      const rows = await inspections.request(ids);
      const queued = rows.filter((row) => ['QUEUED', 'READING'].includes(row.state)).length;
      return '已安排 ' + queued + ' 份只读检查；' + (rows.length - queued) + ' 份未开始。';
    });
  }
  function commandPlans(command: TaskCommand['command'], plans: TaskCommand['plans']) {
    void mutate(async () => {
      const { results } = await tasks.command({ command, plans });
      const accepted = results.filter((row) => row.accepted);
      const failed = results.filter((row) => !row.accepted);
      const labels = { pause: '暂停', resume: '继续', stop: '停止' };
      const reasons = [...new Set(failed.map((row) => row.reason))];
      return (
        `${labels[command]}请求已处理 ${accepted.length} 份；${failed.length} 份未完成` +
        (reasons.length ? `（${reasons.join('、')}）` : '') +
        (command === 'resume' ? '。原任务按并发设置重新排队。' : '。实际状态见任务记录。')
      );
    });
  }
  const plans = tasks.runtime?.plans ?? [];
  const attentionCount = workspace ? attentionPlans(plans, workspace.profiles).length : 0;
  const onlineCount = workspace?.profiles.filter((row) => row.online).length ?? 0;
  const restartDisabled = plans.some((plan) =>
    ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state),
  );
  const projection = buildWorkbenchProjection({
    viewKind: view.kind,
    profiles: workspace?.profiles,
    selected,
    tasks: tasks.runtime,
    groupBumper,
    groupInviter,
    attentionCount,
    message,
  });
  const { bumperRunningIds, inviterRunningIds, projectedActivities, projectedControls } =
    projection;
  const detailProfile = detail
    ? workspace?.profiles.find((row) => row.id === detail.profileId)
    : undefined;
  const failedMessage = /失败|错误|未完成|不能|无法|请先|未确认/.test(message);
  return (
    <div className="app">
      <WorkbenchTopbar
        version={__WORKBENCH_VERSION__}
        breadcrumbText={projection.breadcrumbText}
        busy={busy}
        error={error}
        onlineCount={onlineCount}
        totalProfilesCount={workspace?.profiles.length ?? 0}
        updateStatus={updates.status}
        updateError={updates.error}
        onOpenDiagnosticModal={() => setDiagModalOpen(true)}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenUpdateMenu={() => {
          setUpdateMenu(true);
          setMenuOpen(true);
        }}
        onApplyUpdate={applyUpdate}
        onNotify={setMessage}
      />
      {!workspace ? (
        <main className="loading">
          <h2>{error ? '控制服务连接失败' : '正在连接本机控制服务…'}</h2>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => void refresh(true)}>
            重新连接
          </button>
        </main>
      ) : (
        <div className="app-body">
          <FeatureNavRail
            activeModule={projection.activeModule}
            items={projection.navItems}
            onSelectModule={(mod) =>
              void navigate({ kind: mod === 'active-accounts' ? 'home' : mod })
            }
          />
          <Sidebar
            tasks={tasks.runtime}
            onTaskCommand={commandPlans}
            workspace={workspace}
            selected={selected}
            onSelect={setSelected}
            nameAction={view.kind === 'records' ? 'filter' : 'select'}
            filteredId={view.kind === 'records' ? recordFilter : null}
            onInspect={(id) => setRecordFilter((current) => (current === id ? null : id))}
            mutate={mutate}
            inspections={inspections.rows}
            inspectionAvailable={inspections.available}
            inspectionError={inspections.error}
            busy={busy}
            onCheck={checkProfiles}
            onShow={(id) =>
              void mutate(() => api.showBrowser(id).then(() => '已显示对应浏览器页面'))
            }
            activities={projectedActivities}
            selectionControls={projectedControls}
            bumperCounts={
              view.kind === 'group-bumper'
                ? groupBumper?.profileCounts
                : view.kind === 'page-bumper'
                  ? (groupBumper?.pageBumperProfileCounts ?? {})
                  : undefined
            }
            bumperRunningIds={bumperRunningIds}
            groupInviterCounts={
              view.kind === 'group-inviter' ? (groupInviter?.profileCounts ?? {}) : null
            }
            groupInviterRunningIds={inviterRunningIds}
            onStopModules={(ids) =>
              void mutate(async () => {
                const bIds = ids.filter((id) => bumperRunningIds.includes(id));
                if (bIds.length)
                  setGroupBumper(await api.bumperAction('stop', { profileIds: bIds }));
                const inviteIds = ids.filter((id) => !bumperRunningIds.includes(id));
                if (inviteIds.length)
                  setGroupInviter(await api.stopGroupInviterProfiles({ profileIds: inviteIds }));
                return `已发送停止 ${ids.length} 个浏览器的小组任务指令`;
              })
            }
          />
          <SidebarResizer />
          <main className={'workspace view-' + view.kind}>
            {error && (
              <div className="error-note" role="alert">
                {error}
                <button className="btn btn-sm" onClick={() => void refresh(true)}>
                  重新连接
                </button>
              </div>
            )}
            {tasks.error && (
              <p className="error-note" role="alert">
                {tasks.error}
              </p>
            )}
            {view.kind === 'home' && (
              <ActiveAccountsPage
                workspace={workspace}
                selected={selected}
                tasks={tasks}
                cardColors={cardColors}
                busy={busy}
                resourceSummaries={resourceSummaries}
                selectionControls={projectedControls}
                onSetResourceSummaries={setResourceSummaries}
                onOpenResources={setResourceRow}
                onEditCombination={(row) => setView({ kind: 'edit', row })}
                onRefreshWorkspace={() => refresh()}
                onRefreshResources={refreshResources}
                onMutate={mutate}
                onNotify={setMessage}
              />
            )}
            {view.kind === 'records' && (
              <TaskRecordsPage
                runtime={tasks.runtime}
                profiles={workspace.profiles}
                inspections={inspections.rows}
                loaded={!!tasks.runtime}
                filterId={recordFilter}
                onClearFilter={() => setRecordFilter(null)}
                onOpen={(profileId, planId, round) => setDetail({ profileId, planId, round })}
                groupInviterState={groupInviter}
                groupBumperState={groupBumper}
                onGroupBumperState={setGroupBumper}
                onNotify={setMessage}
              />
            )}
            {view.kind === 'group-bumper' && (
              <GroupBumperPage
                state={groupBumper}
                selected={selected}
                profiles={workspace.profiles}
                onState={(next) => {
                  setGroupBumper(next);
                  void refreshGroupInviter();
                }}
                onMessage={setMessage}
              />
            )}
            {view.kind === 'page-bumper' && (
              <PageBumperPage
                state={groupBumper}
                selected={selected}
                profiles={workspace.profiles}
                onState={(next) => {
                  setGroupBumper(next);
                  void refreshGroupInviter();
                }}
                onMessage={setMessage}
              />
            )}
            {view.kind === 'group-inviter' && (
              <GroupInviterPage
                state={groupInviter}
                onRefresh={async () => setGroupInviter(await api.groupInviterState())}
                loaded={groupInviterLoaded}
                selectedProfileIds={selected}
                busy={busy}
                onAddGroups={async (items) => {
                  setGroupInviter(await api.addInviterGroups({ items }));
                  void api
                    .bumperState()
                    .then(setGroupBumper)
                    .catch(() => {});
                  setMessage(`已保存 ${items.length} 个小组，正在后台获取小组头像`);
                }}
                onDeleteGroups={(groupIds) =>
                  mutate(async () => {
                    setGroupInviter(await api.deleteInviterGroups({ groupIds }));
                    void api
                      .bumperState()
                      .then(setGroupBumper)
                      .catch(() => {});
                    return `已删除 ${groupIds.length} 个小组`;
                  })
                }
                onSaveInvitesPerGroup={async (invitesPerGroup) =>
                  setGroupInviter(await api.saveGroupInviterSettings({ invitesPerGroup }))
                }
                onStart={(groupIds, invitesPerGroup) =>
                  mutate(async () => {
                    const targetIds = [...selected].sort();
                    const next = await api.startGroupInviter({
                      profileIds: targetIds,
                      groupIds,
                      invitesPerGroup,
                    });
                    setGroupInviter(next);
                    const skippedCount = targetIds.filter((id) =>
                      next.profileCounts[id]?.status?.startsWith('跳过'),
                    ).length;
                    const startedCount = Math.max(0, targetIds.length - skippedCount);
                    return `已启动小组邀请人：${startedCount} 个账号 × ${groupIds.length} 个小组${skippedCount > 0 ? `（已自动跳过 ${skippedCount} 个不可用或运行中账号）` : ''}`;
                  })
                }
                onStop={() =>
                  mutate(async () => {
                    setGroupInviter(await api.stopGroupInviter());
                    return '已发送停止小组邀请人指令';
                  })
                }
              />
            )}
            {view.kind === 'edit' && (
              <Editor
                ref={editor}
                key={view.row.id}
                initial={view.row}
                selectedProfiles={workspace.profiles.filter((profile) => selected.has(profile.id))}
                onResources={() => setResourceRow(view.row)}
                resourceUsage={
                  resourceSummaries?.find((item) => item.combinationId === view.row.id) ?? null
                }
                resourceUsageLoaded={resourceSummaries !== null}
                onSaved={refresh}
                onClose={() => void navigate({ kind: 'home' })}
                notify={setMessage}
              />
            )}
          </main>
        </div>
      )}
      {message && (
        <div className={'toast' + (failedMessage ? ' toast-warn' : '')} role="status">
          <span>{message}</span>
          <button
            className="btn btn-icon btn-ghost"
            onClick={() => setMessage('')}
            aria-label="关闭提示"
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
      {detail && workspace && (
        <RecordDetailDrawer
          profile={detailProfile}
          planId={detail.planId}
          round={detail.round}
          plan={plans.find((plan) => plan.id === detail.planId)}
          workspace={workspace}
          inspection={inspections.rows.find((row) => row.profileId === detail.profileId)}
          inspectionAvailable={inspections.available}
          inspectionError={inspections.error}
          busy={busy}
          onClose={() => setDetail(null)}
          onCommand={commandPlans}
          onRename={setAliasing}
          onReadInspections={() => void inspections.refresh()}
          onCheck={checkProfiles}
          onResources={(combinationId) => {
            const row = workspace.combinations.find((value) => value.id === combinationId);
            if (row) setResourceRow(row);
            else setMessage('原任务组合已不在当前列表，请查看原任务记录。');
          }}
        />
      )}
      {menuOpen && workspace && (
        <AppMenu
          initialSection={updateMenu ? 'update' : undefined}
          updateStatus={updates.status}
          onUpdateStatus={updates.setStatus}
          onApplyUpdate={applyUpdate}
          updateError={updates.error}
          profiles={workspace.profiles}
          selected={selected}
          runtime={tasks.runtime}
          busy={busy}
          restartDisabled={restartDisabled}
          onClose={() => {
            setMenuOpen(false);
            setUpdateMenu(false);
          }}
          onRefresh={() => {
            tasks.refresh();
            void refresh();
          }}
          onRestart={() =>
            void mutate(async () => {
              await api.restartSoftware();
              return '软件正在重启，请稍候';
            })
          }
        />
      )}
      {resourceRow && (
        <ResourceTableEditor
          ref={resourceEditor}
          key={resourceRow.id}
          combination={resourceRow}
          onClose={() => setResourceRow(null)}
          onSaved={refreshResources}
        />
      )}
      {aliasing && (
        <NameDialog
          title="浏览器别名"
          initial={aliasing.alias}
          onClose={() => setAliasing(null)}
          onSubmit={async (alias) => {
            await api.rename(aliasing.id, alias);
            await refresh();
          }}
        />
      )}
      <DiagnosticFeedbackModal
        open={diagModalOpen}
        uiContext={projection.diagUiContext}
        onClose={() => setDiagModalOpen(false)}
        onNotify={setMessage}
      />
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw Error('ROOT_ELEMENT_MISSING');
createRoot(root).render(<App />);
