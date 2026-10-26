import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Profile, SavedCombination } from '../shared/contracts.js';
import { useWorkspace } from './use-workspace.js';
import { Sidebar } from './sidebar.js';
import { SidebarResizer } from './sidebar-resizer.js';
import { Editor, newCombination, type EditorHandle } from './editor.js';
import { CombinationList, formatCombinationForClipboard } from './combination-list.js';
import { api } from './api.js';
import { NameDialog } from './name-dialog.js';
import type { DesktopBridge } from '../shared/desktop.js';
import { useInspections } from './use-inspections.js';
import { useTasks } from './use-tasks.js';
import { ResourceTableEditor, type ResourceEditorHandle } from './resource-table-editor.js';
import { TaskScheduleDialog } from './task-schedule-dialog.js';
import { TaskTestsPanel } from './task-tests-panel.js';
import { BrowserRunMonitor } from './browser-run-monitor.js';
import { TEST_COMBINATION_NOTE } from '../shared/task-tests.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import type { TaskCommand } from '../shared/task-contracts.js';
import { isErroredPausedPlan } from '../shared/task-issues.js';
import { attentionPlans } from './task-alerts.js';
import { TaskRecordsPage } from './task-records.js';
import { GroupInviterPage } from './group-inviter-page.js';
import type { GroupInviterState } from '../shared/group-inviter.js';
import { RecordDetailDrawer } from './record-detail.js';
import { AppMenu } from './app-menu.js';
import { useSoftwareUpdate } from './software-update-panel.js';
import { useCardColors } from './card-colors.js';
import { IconBrand, IconClose, IconMenu } from './icons.js';
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
  | { kind: 'group-inviter' };
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
  const updates = useSoftwareUpdate();
  const [updateMenu, setUpdateMenu] = useState(false),
    [ignoredUpdate, setIgnoredUpdate] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const [aliasing, setAliasing] = useState<Profile | null>(null);
  const editor = useRef<EditorHandle>(null);
  const resourceEditor = useRef<ResourceEditorHandle>(null);
  const [resourceRow, setResourceRow] = useState<SavedCombination | null>(null);
  const [schedule, setSchedule] = useState<{ row: SavedCombination; profileIds: string[] } | null>(
    null,
  );
  const [resourceSummaries, setResourceSummaries] = useState<ResourceUsageSummaryValue[] | null>(
    null,
  );
  const [groupInviter, setGroupInviter] = useState<GroupInviterState | null>(null);
  const [groupInviterLoaded, setGroupInviterLoaded] = useState(false);
  const resourceGeneration = useRef(0);
  async function applyUpdate() {
    if (resourceEditor.current && !(await resourceEditor.current.persist())) return;
    if (editor.current && !(await editor.current.persist())) return;
    await updates.apply();
  }
  const refreshGroupInviter = useCallback(async () => {
    try {
      const next = await api.groupInviterState();
      setGroupInviter(next);
      setGroupInviterLoaded(true);
    } catch {
      setGroupInviterLoaded(true);
    }
  }, []);
  useEffect(() => {
    void refreshGroupInviter();
    const intervalMs = view.kind === 'group-inviter' || groupInviter?.running ? 2000 : 6000;
    const timer = setInterval(() => void refreshGroupInviter(), intervalMs);
    return () => clearInterval(timer);
  }, [refreshGroupInviter, view.kind, groupInviter?.running]);
  const refreshResources = useCallback(async () => {
    const generation = ++resourceGeneration.current;
    try {
      const values = await api.resourceSummaries();
      if (generation === resourceGeneration.current) setResourceSummaries(values);
    } catch {
      if (generation === resourceGeneration.current) setResourceSummaries(null);
    }
  }, []);
  useEffect(() => {
    void refreshResources();
    const timer = setInterval(() => void refreshResources(), 5000);
    return () => {
      clearInterval(timer);
      resourceGeneration.current++;
    };
  }, [refreshResources]);
  useEffect(
    () =>
      window.workbenchDesktop?.onBeforeClose(async () => {
        if (resourceEditor.current && !(await resourceEditor.current.persist())) return false;
        return editor.current ? editor.current.persist() : true;
      }),
    [],
  );
  // Toast: auto-hide after a while; the close button stays available.
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
  const detailProfile = detail
    ? workspace?.profiles.find((row) => row.id === detail.profileId)
    : undefined;
  const failedMessage = /失败|错误|未完成|不能|无法|请先|未确认/.test(message);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <IconBrand size={18} />
          </span>
          <strong>浏览器工作台</strong>
          <span className="build-label">v{__WORKBENCH_VERSION__}</span>
        </div>
        <nav className="tabs" aria-label="主页面">
          <button
            className={view.kind === 'home' || view.kind === 'edit' ? 'active' : ''}
            aria-current={view.kind === 'home' || view.kind === 'edit' ? 'page' : undefined}
            onClick={() => void navigate({ kind: 'home' })}
          >
            首页
          </button>
          <button
            className={view.kind === 'records' ? 'active' : ''}
            aria-current={view.kind === 'records' ? 'page' : undefined}
            onClick={() => void navigate({ kind: 'records' })}
          >
            任务记录
            {attentionCount > 0 && (
              <span className="tab-badge" title={attentionCount + ' 个任务需要处理'}>
                {attentionCount}
              </span>
            )}
          </button>
          <button
            className={view.kind === 'group-inviter' ? 'active' : ''}
            aria-current={view.kind === 'group-inviter' ? 'page' : undefined}
            onClick={() => void navigate({ kind: 'group-inviter' })}
          >
            小组邀请人
            {groupInviter?.running && (
              <span className="tab-badge" title="小组邀请人正在运行">
                运行中
              </span>
            )}
          </button>
        </nav>
        <div className="topbar-right">
          {busy && <span className="spinner" role="status" aria-label="正在处理" />}
          <button
            className="btn btn-sm"
            title="一键将当前所有浏览器、任务进度、操作记录与内核追踪写入开发诊断黑匣子日志 (dev-diagnostics.jsonl)"
            onClick={() => {
              void api
                .recordDiagnosticSnapshot(
                  `视图:${view.kind}, 已选:${selected.size}个浏览器, 提示:${message || '无'}`,
                )
                .then((res) => {
                  setMessage(`已记录问题现场 (#${res.entryId})，可直接通知助手读取诊断日志`);
                })
                .catch((err) => {
                  setMessage(err instanceof Error ? err.message : '记录问题现场失败');
                });
            }}
          >
            记录问题现场
          </button>
          <span
            className={'connection-status' + (error ? ' is-error' : onlineCount ? ' is-on' : '')}
            title={error ? '控制服务连接待刷新' : '已连接的浏览器 / 全部浏览器'}
          >
            <i />
            {error ? '连接待刷新' : `${onlineCount}/${workspace?.profiles.length ?? 0} 已连接`}
          </span>
          <button
            className="btn btn-icon menu-button"
            aria-label="打开菜单"
            title="菜单：备份恢复、连接诊断、日志、重启等"
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu size={18} />
          </button>
        </div>
      </header>
      {updates.status?.availableUpdate &&
        ignoredUpdate !==
          updates.status.availableUpdate.softwareVersion +
            ':' +
            updates.status.availableUpdate.extensionVersion && (
          <div className="update-banner" role="status">
            <span>
              发现新版本 v{updates.status.availableUpdate.softwareVersion}
              {updates.status.availableUpdate.extensionVersion
                ? ' · 插件 v' + updates.status.availableUpdate.extensionVersion
                : ''}
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={updates.status.applying || updates.status.availableUpdate.requiresInstaller}
              onClick={() => void applyUpdate()}
            >
              {updates.status.applying
                ? '正在下载并更新软件与插件…'
                : updates.status.availableUpdate.requiresInstaller
                  ? '需要完整安装包'
                  : '一键更新'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setUpdateMenu(true);
                setMenuOpen(true);
              }}
            >
              查看详情
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                setIgnoredUpdate(
                  updates.status?.availableUpdate?.softwareVersion +
                    ':' +
                    updates.status?.availableUpdate?.extensionVersion,
                )
              }
            >
              稍后
            </button>
            {updates.error && <span>{updates.error}</span>}
          </div>
        )}
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
              void mutate(async () => {
                await api.showBrowser(id);
                return '已显示对应浏览器页面';
              })
            }
            groupInviterCounts={
              view.kind === 'group-inviter' ? (groupInviter?.profileCounts ?? {}) : null
            }
            groupInviterRunningIds={
              groupInviter?.running
                ? Object.entries(groupInviter.profileCounts)
                    .filter(([, stat]) =>
                      Boolean(
                        stat.status &&
                        !['已完成', '已停止'].includes(stat.status) &&
                        !stat.status.startsWith('失败') &&
                        !stat.status.startsWith('跳过'),
                      ),
                    )
                    .map(([id]) => id)
                : undefined
            }
            onStopGroupInviterProfiles={(ids) =>
              void mutate(async () => {
                const next = await api.stopGroupInviterProfiles({ profileIds: ids });
                setGroupInviter(next);
                return `已发送停止 ${ids.length} 个浏览器的小组邀请人指令`;
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
              <>
                <TaskTestsPanel
                  profiles={workspace.profiles}
                  selected={selected}
                  runtime={tasks.runtime}
                  capabilities={tasks.capabilities}
                  onConfigure={(destination) =>
                    void mutate(async () => {
                      const row = await api.createDraft(newCombination(destination));
                      setView({ kind: 'edit', row });
                    })
                  }
                  busy={busy}
                  notify={setMessage}
                  onRefresh={() => {
                    tasks.refresh();
                    void refresh();
                  }}
                />
                <BrowserRunMonitor
                  profiles={workspace.profiles}
                  selected={selected}
                  runtime={tasks.runtime}
                />
                <CombinationList
                  capabilities={tasks.capabilities}
                  runtime={tasks.runtime}
                  profiles={workspace.profiles}
                  groupInviterRunningIds={
                    groupInviter?.running
                      ? Object.entries(groupInviter.profileCounts)
                          .filter(([, stat]) =>
                            Boolean(
                              stat.status &&
                              !['已完成', '已停止'].includes(stat.status) &&
                              !stat.status.startsWith('失败') &&
                              !stat.status.startsWith('跳过'),
                            ),
                          )
                          .map(([id]) => id)
                      : undefined
                  }
                  busy={busy}
                  colorOf={cardColors.colorOf}
                  colorSupported={cardColors.supported}
                  onColor={(row, color) =>
                    void mutate(async () => {
                      await cardColors.setColor(row.id, color);
                      return '卡片颜色已保存';
                    })
                  }
                  onStart={(row) =>
                    void mutate(async () => {
                      const usesTable = row.saved?.steps.some(
                        (step) => step.type === 'post' && step.resourceMode === 'table',
                      );
                      const revision = resourceSummaries?.find(
                        (value) => value.combinationId === row.id,
                      )?.revision;
                      if (usesTable && !revision) throw Error('请先保存并读取发帖资源');
                      const inviterRunningIds = groupInviter?.running
                        ? Object.entries(groupInviter.profileCounts)
                            .filter(([, stat]) =>
                              Boolean(
                                stat.status &&
                                !['已完成', '已停止'].includes(stat.status) &&
                                !stat.status.startsWith('失败') &&
                                !stat.status.startsWith('跳过'),
                              ),
                            )
                            .map(([id]) => id)
                        : [];
                      const busyIds = new Set<string>([
                        ...(tasks.runtime?.plans
                          .filter(
                            (plan) =>
                              selected.has(plan.profileId) &&
                              !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) &&
                              !isErroredPausedPlan(plan),
                          )
                          .map((plan) => plan.profileId) ?? []),
                        ...inviterRunningIds.filter((id) => selected.has(id)),
                      ]);
                      const offlineIds = new Set<string>(
                        [...selected].filter(
                          (id) =>
                            !busyIds.has(id) &&
                            !workspace.profiles.find((p) => p.id === id)?.online,
                        ),
                      );
                      const eligibleIds = [...selected]
                        .filter((id) => !busyIds.has(id) && !offlineIds.has(id))
                        .sort();
                      if (!eligibleIds.length)
                        throw Error('所选浏览器当前不可启动，请检查连接或任务状态');
                      const result = await tasks.start({
                        combinationId: row.id,
                        version: row.version,
                        profileIds: eligibleIds,
                        ...(usesTable ? { expectedResourceRevision: revision } : {}),
                      });
                      const skipParts = [
                        busyIds.size ? `${busyIds.size} 个任务运行中` : '',
                        offlineIds.size ? `${offlineIds.size} 个未连接` : '',
                      ].filter(Boolean);
                      return `已分配 ${result.plans.length} 份任务${skipParts.length ? `（已自动跳过 ${skipParts.join('、')}）` : ''}；将按并发设置执行`;
                    })
                  }
                  rows={workspace.combinations.filter(
                    (row) => !row.saved?.note.startsWith(TEST_COMBINATION_NOTE),
                  )}
                  selectedCount={selected.size}
                  selectedIds={selected}
                  resourceSummaries={resourceSummaries}
                  onResources={setResourceRow}
                  onSchedule={(row) => {
                    const inviterRunningIds = groupInviter?.running
                      ? Object.entries(groupInviter.profileCounts)
                          .filter(([, stat]) =>
                            Boolean(
                              stat.status &&
                              !['已完成', '已停止'].includes(stat.status) &&
                              !stat.status.startsWith('失败') &&
                              !stat.status.startsWith('跳过'),
                            ),
                          )
                          .map(([id]) => id)
                      : [];
                    const busyIds = new Set<string>([
                      ...(tasks.runtime?.plans
                        .filter(
                          (plan) =>
                            selected.has(plan.profileId) &&
                            !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) &&
                            !isErroredPausedPlan(plan),
                        )
                        .map((plan) => plan.profileId) ?? []),
                      ...inviterRunningIds.filter((id) => selected.has(id)),
                    ]);
                    const eligibleScheduleIds = [...selected]
                      .filter((id) => !busyIds.has(id))
                      .sort();
                    if (eligibleScheduleIds.length) {
                      setSchedule({ row, profileIds: eligibleScheduleIds });
                    }
                  }}
                  onNew={() =>
                    void mutate(async () => {
                      const row = await api.createDraft(newCombination());
                      setView({ kind: 'edit', row });
                    })
                  }
                  onEdit={(row) => setView({ kind: 'edit', row })}
                  onCopy={(row) => {
                    void (async () => {
                      try {
                        const text = formatCombinationForClipboard(row);
                        try {
                          await navigator.clipboard.writeText(text);
                        } catch {
                          const area = document.createElement('textarea');
                          area.value = text;
                          area.style.position = 'fixed';
                          area.style.opacity = '0';
                          document.body.appendChild(area);
                          area.select();
                          document.execCommand('copy');
                          document.body.removeChild(area);
                        }
                        const name = (row.saved ?? row.draft)?.name || '未命名组合';
                        setMessage(
                          `已将任务组合「${name}」复制到剪贴板，可发给他人或点击“导入组合”创建副本`,
                        );
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : '复制组合失败');
                      }
                    })();
                  }}
                  onImport={async (parsed) => {
                    await mutate(async () => {
                      if (parsed.mode === 'published') {
                        await api.create(parsed.value);
                      } else {
                        await api.createDraft(parsed.value);
                      }
                      await refreshResources();
                      return `已导入任务组合「${parsed.value.name || '未命名组合'}」`;
                    });
                  }}
                  onDeleteMany={async (rows) => {
                    const deleted: string[] = [];
                    await mutate(async () => {
                      const failures: string[] = [];
                      for (const row of rows) {
                        try {
                          await api.deleteCombination(row.id);
                          deleted.push(row.id);
                        } catch (error) {
                          failures.push(
                            `${(row.saved ?? row.draft)?.name || '未命名组合'}：${error instanceof Error ? error.message : '删除失败'}`,
                          );
                        }
                      }
                      await refreshResources();
                      return (
                        `已删除 ${deleted.length} 个任务组合` +
                        (failures.length
                          ? `；${failures.length} 个未删除：${failures.slice(0, 3).join('；')}${failures.length > 3 ? '；其余未删除组合仍保持选中' : ''}`
                          : '')
                      );
                    });
                    return deleted;
                  }}
                  onDelete={(row) =>
                    void mutate(async () => {
                      await api.deleteCombination(row.id);
                      await refreshResources();
                      return `已删除任务组合「${(row.saved ?? row.draft)?.name || '未命名组合'}」`;
                    })
                  }
                />
              </>
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
              />
            )}
            {view.kind === 'group-inviter' && (
              <GroupInviterPage
                state={groupInviter}
                loaded={groupInviterLoaded}
                selectedProfileIds={selected}
                busy={busy}
                onAddGroups={async (items) => {
                  const next = await api.addInviterGroups({ items });
                  setGroupInviter(next);
                  setMessage(`已保存 ${items.length} 个小组，正在后台获取小组头像`);
                }}
                onDeleteGroups={async (groupIds) => {
                  await mutate(async () => {
                    const next = await api.deleteInviterGroups({ groupIds });
                    setGroupInviter(next);
                    return `已删除 ${groupIds.length} 个小组`;
                  });
                }}
                onSaveInvitesPerGroup={async (invitesPerGroup) => {
                  const next = await api.saveGroupInviterSettings({ invitesPerGroup });
                  setGroupInviter(next);
                }}
                onStart={async (groupIds, invitesPerGroup) => {
                  await mutate(async () => {
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
                  });
                }}
                onStop={async () => {
                  await mutate(async () => {
                    const next = await api.stopGroupInviter();
                    setGroupInviter(next);
                    return '已发送停止小组邀请人指令';
                  });
                }}
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
      {schedule && (
        <TaskScheduleDialog
          name={schedule.row.saved?.name ?? '已保存组合'}
          version={schedule.row.version}
          count={schedule.profileIds.length}
          onClose={() => setSchedule(null)}
          onSubmit={async (timing) => {
            const usesTable = schedule.row.saved?.steps.some(
                (step) => step.type === 'post' && step.resourceMode === 'table',
              ),
              revision = resourceSummaries?.find(
                (value) => value.combinationId === schedule.row.id,
              )?.revision;
            if (usesTable && !revision) throw Error('请先保存并读取发帖资源');
            const result = await tasks.start({
              combinationId: schedule.row.id,
              version: schedule.row.version,
              profileIds: schedule.profileIds,
              timing,
              ...(usesTable ? { expectedResourceRevision: revision } : {}),
            });
            setMessage(`已安排 ${result.plans.length} 份任务，已固定当前保存版本`);
          }}
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
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw Error('ROOT_ELEMENT_MISSING');
createRoot(root).render(<App />);
