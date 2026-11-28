import { useMemo, useState } from 'react';
import { isUserSavedCombination, type QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { BluestacksQuickActiveStepType, BluestacksState } from '../shared/bluestacks.js';
import {
  profileDisplayName,
  type Combination,
  type SavedCombination,
  type Workspace,
} from '../shared/contracts.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import { taskReasonDescription } from '../shared/task-issues.js';
import {
  BLUESTACKS_QUICK_ACTIONS,
  BROWSER_INSTANT_MODULES,
  BluestacksQuickStepDialog,
  TaskTestDialog,
  type BrowseModule,
} from './active-quick-step-dialogs.js';
import { api } from './api.js';
import type { useCardColors } from './card-colors.js';
import { copyTextToClipboard } from './clipboard.js';
import { CombinationList, formatCombinationForClipboard } from './combination-list.js';
import {
  ACTIVE_CLOSE_BROWSER_STORAGE_KEY,
  newCombination,
  readStoredCloseBrowserOnFinish,
  type SelectionControlSummary,
} from './modules/module-contracts.js';
import { Btn, errMsg } from './modules/shared/module-ui.js';
import { CarrierScopeBar } from './modules/shared/target-scope-bar.js';
import type { useTasks } from './use-tasks.js';
import { UI_ROW } from './ui/primitives.js';
const BS_CLOSE_STORAGE_KEY = 'wb.bluestacksActive.closeWindowOnFinish';
function readStoredCloseBs(): boolean {
  try {
    return window.localStorage.getItem(BS_CLOSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
export function ActiveAccountsPage(p: {
  carrier?: 'browser' | 'bluestacks' | undefined;
  workspace: Workspace;
  selected: ReadonlySet<string>;
  tasks: ReturnType<typeof useTasks>;
  cardColors: ReturnType<typeof useCardColors>;
  busy: boolean;
  resourceSummaries: ResourceUsageSummaryValue[] | null;
  selectionControls: SelectionControlSummary;
  bluestacksState?: BluestacksState | null | undefined;
  onBluestacksState?: ((next: BluestacksState) => void) | undefined;
  selectedBluestacks?: ReadonlySet<string> | undefined;
  onSelectBluestacks?: ((next: Set<string>) => void) | undefined;
  onSetResourceSummaries: (next: ResourceUsageSummaryValue[] | null) => void;
  onOpenResources: (row: SavedCombination) => void;
  onEditCombination: (row: SavedCombination) => void;
  onNewCombination: (initialValue?: Combination) => void;
  onQuickSchedule?: ((seed: QuickScheduleSeed) => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  onRefreshWorkspace: () => Promise<void>;
  onRefreshResources: () => Promise<void>;
  onMutate: (work: () => Promise<unknown>) => Promise<void>;
  onNotify: (msg: string) => void;
  onSelectProfiles?: ((next: Set<string>) => void) | undefined;
}) {
  const {
    carrier = 'browser',
    workspace: ws,
    selected,
    tasks,
    cardColors,
    busy,
    selectionControls: sc,
    bluestacksState = null,
    onBluestacksState,
    selectedBluestacks,
    onSelectBluestacks,
  } = p;
  const isBs = carrier === 'bluestacks';
  const [closeBrowserOnFinish, setCloseBrowserOnFinish] = useState(readStoredCloseBrowserOnFinish);
  const [closeBsOnFinish, setCloseBsOnFinish] = useState(readStoredCloseBs);
  const updateCloseBrowser = (next: boolean) => {
    setCloseBrowserOnFinish(next);
    try {
      window.localStorage.setItem(ACTIVE_CLOSE_BROWSER_STORAGE_KEY, next ? '1' : '0');
    } catch {}
  };
  const updateCloseBs = (next: boolean) => {
    setCloseBsOnFinish(next);
    try {
      window.localStorage.setItem(BS_CLOSE_STORAGE_KEY, next ? '1' : '0');
    } catch {}
  };
  const activePlans = useMemo(
    () =>
      (tasks.runtime?.plans ?? []).filter(
        (r) => !['COMPLETED', 'FAILED', 'STOPPED'].includes(r.state),
      ),
    [tasks.runtime?.plans],
  );
  const profileById = useMemo(() => new Map(ws.profiles.map((r) => [r.id, r])), [ws.profiles]);
  const bsSelectedSet = selectedBluestacks ?? new Set<string>();
  const isBsProfileBusy = (id: string) =>
    Boolean(
      bluestacksState?.activeProfileCounts?.[id]?.running ||
      bluestacksState?.posterProfileCounts?.[id]?.running ||
      bluestacksState?.inviterProfileCounts?.[id]?.running ||
      bluestacksState?.profileCounts?.[id]?.running ||
      bluestacksState?.pageBumperProfileCounts?.[id]?.running,
    );
  const bsRunningCount = useMemo(
    () => Object.values(bluestacksState?.activeProfileCounts ?? {}).filter((s) => s.running).length,
    [bluestacksState?.activeProfileCounts],
  );
  const runningCount = isBs
    ? bsRunningCount || (bluestacksState?.activeRunning ? 1 : 0)
    : activePlans.length;
  function stopAllActive() {
    if (isBs) {
      void p.onMutate(async () => {
        onBluestacksState?.(await api.bluestacksAction('active/stop', {}));
        return '已发送停止蓝蝶活跃指令';
      });
      return;
    }
    if (!activePlans.length) return;
    void p.onMutate(async () => {
      const { results } = await tasks.command({
        command: 'stop',
        plans: activePlans.map((r) => ({
          profileId: r.profileId,
          planId: r.id,
          expectedState: r.state,
          expectedUpdatedAt: r.updatedAt,
        })),
      });
      const ok = results.filter((r) => r.accepted).length,
        fail = results.length - ok;
      return fail ? `已停止 ${ok} 份，${fail} 份未完成` : `已停止 ${ok} 份活跃任务`;
    });
  }
  const [testMod, setTestMod] = useState<{ id: BrowseModule; ids: string[] } | null>(null);
  const [bsTestMod, setBsTestMod] = useState<{
    type: BluestacksQuickActiveStepType;
    ids: string[];
  } | null>(null);
  const delOne = async (row: SavedCombination) => {
    await api.deleteCombination(row.id);
    await p.onRefreshResources();
    return `已删除「${row.saved?.name || '未命名组合'}」`;
  };
  const quickButtons = isBs
    ? BLUESTACKS_QUICK_ACTIONS.map((item) => ({
        key: item.type,
        name: item.name,
        dot: item.dot,
        ready: true,
        title: item.detail,
        onClick: () => {
          if (!bsSelectedSet.size) return p.onNotify('请先勾选至少一台蓝蝶模拟器');
          const ids = [...bsSelectedSet].filter((id) => !isBsProfileBusy(id)).sort();
          if (!ids.length) return p.onNotify('所选蓝蝶均正在运行任务');
          setBsTestMod({ type: item.type, ids });
        },
      }))
    : BROWSER_INSTANT_MODULES.map((item) => {
        const ready = !!tasks.capabilities?.types.includes(item.type);
        return {
          key: item.id,
          name: item.name,
          dot:
            item.type === 'feed'
              ? 'bg-emerald-500'
              : item.type === 'video'
                ? 'bg-violet-500'
                : item.type === 'marketplace'
                  ? 'bg-amber-500'
                  : 'bg-sky-500',
          ready,
          title: ready ? item.detail : `${item.name}尚未就绪`,
          onClick: () => {
            if (!ready) return p.onNotify(`${item.name}尚未就绪`);
            if (!selected.size) return p.onNotify('请先在左侧勾选浏览器');
            const ids = [...selected].filter((id) => !sc.isProfileBusy(id)).sort();
            if (!ids.length) return p.onNotify('所选浏览器已有任务运行中');
            setTestMod({ id: item.id, ids });
          },
        };
      });
  return (
    <>
      <CarrierScopeBar
        isBs={isBs}
        bluestacksState={bluestacksState}
        profiles={ws.profiles}
        profileGroups={ws.groups}
        selected={isBs ? bsSelectedSet : selected}
        onSelect={isBs ? onSelectBluestacks : p.onSelectProfiles}
      />
      <section
        className="sticky top-0 z-[4] -mx-6 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[#eef0f3]/90 px-6 py-3 backdrop-blur-sm max-[1080px]:-mx-3.5 max-[1080px]:px-3.5"
        aria-label={isBs ? '蓝蝶快速单任务' : '快速单任务'}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="text-xs font-bold tracking-wide whitespace-nowrap text-[var(--text-3)] max-[1100px]:hidden">
            快速单任务
          </span>
          <div className={UI_ROW}>
            {quickButtons.map((btn) => (
              <button
                key={btn.key}
                type="button"
                className={`inline-flex h-[30px] items-center gap-1.5 rounded-full border border-[var(--line)] bg-white px-3 text-xs font-semibold text-[var(--text)] shadow-2xs transition-all hover:not-disabled:border-slate-300 hover:not-disabled:shadow-xs disabled:opacity-45 ${btn.ready ? '' : 'opacity-60'}`}
                disabled={busy}
                title={btn.title}
                onClick={btn.onClick}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${btn.dot}`} aria-hidden="true" />
                {btn.name}
              </button>
            ))}
          </div>
        </div>
        {runningCount > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-full border border-blue-200 bg-[var(--brand-soft)] px-2.5 text-xs font-semibold whitespace-nowrap text-[var(--brand)] transition-colors hover:bg-blue-100"
              title="点击在右侧任务队列查看详细执行步骤"
              onClick={p.onOpenLiveRuns}
            >
              <span>运行中 {runningCount}</span>
              {p.onOpenLiveRuns && <span className="opacity-75">· 查看队列</span>}
            </button>
            <Btn v="danger" disabled={busy} onClick={stopAllActive}>
              停止全部
            </Btn>
          </div>
        )}
        {!isBs && testMod && (
          <TaskTestDialog
            key={testMod.id}
            module={testMod.id}
            count={testMod.ids.length}
            defaultCloseBrowser={closeBrowserOnFinish}
            onClose={() => setTestMod(null)}
            onSubmit={async (options) => {
              const result = await api.testTask({ ...options, profileIds: testMod.ids });
              const rejected = result.rejected
                .map(
                  (r) =>
                    `${profileDisplayName(profileById.get(r.profileId), '浏览器')}：${taskReasonDescription(r.reason)?.summary ?? r.reason}`,
                )
                .join('；');
              p.onNotify(
                `已启动 ${result.plans.length} 份` +
                  (result.rejected.length
                    ? `，${result.rejected.length} 份跳过（${rejected}）`
                    : ''),
              );
              tasks.refresh();
              void p.onRefreshWorkspace();
            }}
          />
        )}
        {isBs && bsTestMod && (
          <BluestacksQuickStepDialog
            key={bsTestMod.type}
            stepType={bsTestMod.type}
            instanceIds={bsTestMod.ids}
            defaultCloseWindow={closeBsOnFinish}
            onClose={() => setBsTestMod(null)}
            onSubmit={async (payload) => {
              const next = await api.bluestacksAction('active/start', payload);
              onBluestacksState?.(next);
              const def = BLUESTACKS_QUICK_ACTIONS.find((a) => a.type === bsTestMod.type);
              p.onNotify(
                `已启动「${def?.name ?? bsTestMod.type}」（${bsTestMod.ids.length} 台蓝蝶）`,
              );
            }}
          />
        )}
      </section>
      <CombinationList
        carrier={carrier}
        capabilities={tasks.capabilities}
        runtime={tasks.runtime}
        bluestacksState={bluestacksState}
        profiles={isBs ? undefined : ws.profiles}
        isProfileBusy={isBs ? isBsProfileBusy : sc.isProfileBusy}
        closeBrowserOnFinish={isBs ? closeBsOnFinish : closeBrowserOnFinish}
        onCloseBrowserOnFinishChange={isBs ? updateCloseBs : updateCloseBrowser}
        busy={busy}
        colorOf={cardColors.colorOf}
        colorSupported={cardColors.supported}
        onColor={(row, color) =>
          void p.onMutate(() => cardColors.setColor(row.id, color).then(() => '颜色已保存'))
        }
        onStart={(row) => {
          if (isBs) {
            void p.onMutate(async () => {
              const ids = [...bsSelectedSet].filter((id) => !isBsProfileBusy(id)).sort();
              if (!ids.length)
                throw Error(
                  bsSelectedSet.size ? '所选蓝蝶均正在运行任务' : '请先勾选至少一台蓝蝶模拟器',
                );
              const next = await api.bluestacksAction('active/start', {
                instanceIds: ids,
                combinationId: row.id,
                ...(closeBsOnFinish ? { closeWindowOnFinish: true } : {}),
              });
              onBluestacksState?.(next);
              return `已启动「${row.saved?.name || '未命名组合'}」（${ids.length} 台蓝蝶${closeBsOnFinish ? ' · 完毕关窗' : ''}）`;
            });
            return;
          }
          void p.onMutate(async () => {
            const usesTable = row.saved?.steps.some(
              (s) => s.type === 'post' && s.resourceMode === 'table',
            );
            const sums = usesTable ? await api.resourceSummaries() : p.resourceSummaries;
            if (usesTable) p.onSetResourceSummaries(sums);
            const rev = sums?.find((v) => v.combinationId === row.id)?.revision;
            if (usesTable && !rev) throw Error('请先配置发帖资源');
            const sel = [...selected],
              busyIds = new Set(sel.filter((id) => sc.isProfileBusy(id))),
              offIds = new Set(
                sel.filter((id) => !busyIds.has(id) && !profileById.get(id)?.online),
              ),
              ids = sel.filter((id) => !busyIds.has(id)).sort();
            if (!ids.length) throw Error('所选浏览器已有任务运行中');
            const res = await tasks.start({
              combinationId: row.id,
              version: row.version,
              profileIds: ids,
              ...(usesTable ? { expectedResourceRevision: rev } : {}),
              ...(closeBrowserOnFinish ? { closeBrowserOnFinish: true } : {}),
            });
            const tags = [
              res.plans.some((x) => offIds.has(x.profileId))
                ? `唤醒 ${res.plans.filter((x) => offIds.has(x.profileId)).length}`
                : '',
              busyIds.size ? `跳过忙碌 ${busyIds.size}` : '',
              closeBrowserOnFinish ? '完毕关窗' : '',
            ].filter(Boolean);
            return `已启动 ${res.plans.length} 份${tags.length ? `（${tags.join(' · ')}）` : ''}`;
          });
        }}
        rows={ws.combinations.filter(
          (c) => isUserSavedCombination(c) && !c.id.startsWith('__wb_quick_test'),
        )}
        selectedCount={isBs ? bsSelectedSet.size : selected.size}
        selectedIds={isBs ? bsSelectedSet : selected}
        resourceSummaries={p.resourceSummaries}
        onResources={p.onOpenResources}
        onQuickSchedule={
          p.onQuickSchedule
            ? (row) =>
                p.onQuickSchedule?.(
                  isBs
                    ? {
                        carrier: 'bluestacks',
                        name: `${row.saved?.name?.trim() || '定时养号'}（蓝蝶）`,
                        targetIds: [...bsSelectedSet],
                        steps: [
                          {
                            id: crypto.randomUUID(),
                            type: 'bluestacks-active-combination',
                            combinationId: row.id,
                          },
                        ],
                      }
                    : {
                        carrier: 'browser',
                        name: row.saved?.name?.trim() || '定时养号',
                        targetIds: [...selected],
                        steps: [
                          {
                            id: crypto.randomUUID(),
                            type: 'active-combination',
                            combinationId: row.id,
                          },
                        ],
                      },
                )
            : undefined
        }
        onNew={() =>
          p.onNewCombination(
            isBs
              ? {
                  name: '新蓝蝶任务组合',
                  note: '',
                  steps: [
                    {
                      id: crypto.randomUUID(),
                      type: 'video',
                      durationMinutes: 15,
                      maxLikes: 2,
                      minLikeCount: 0,
                    },
                  ],
                  randomOrder: false,
                  loop: { mode: 'finite', rounds: 1 },
                }
              : newCombination(),
          )
        }
        onEdit={p.onEditCombination}
        onCopy={(row) =>
          void copyTextToClipboard(formatCombinationForClipboard(row))
            .then(() => p.onNotify(`已复制「${row.saved?.name || '未命名组合'}」`))
            .catch((e) => p.onNotify(errMsg(e, '复制失败')))
        }
        onImport={async (parsed) => {
          await api.create(parsed.value);
          await Promise.all([p.onRefreshWorkspace(), p.onRefreshResources()]);
          p.onNotify(`已导入「${parsed.value.name || '未命名组合'}」`);
        }}
        onDeleteMany={async (rows) => {
          const deleted: string[] = [];
          await p.onMutate(async () => {
            const fails: string[] = [];
            for (const r of rows) {
              try {
                await api.deleteCombination(r.id);
                deleted.push(r.id);
              } catch (e) {
                fails.push(`${r.saved?.name || '未命名组合'}：${errMsg(e, '删除失败')}`);
              }
            }
            await p.onRefreshResources();
            return (
              `已删除 ${deleted.length} 个组合` +
              (fails.length ? `（${fails.length} 个失败：${fails.slice(0, 2).join('；')}）` : '')
            );
          });
          return deleted;
        }}
        onDelete={(row) => void p.onMutate(() => delOne(row))}
      />
    </>
  );
}
