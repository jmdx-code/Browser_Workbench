import { useState } from 'react';
import type { SavedCombination, Workspace } from '../shared/contracts.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import { TEST_COMBINATION_NOTE } from '../shared/task-tests.js';
import { api } from './api.js';
import { BrowserRunMonitor } from './browser-run-monitor.js';
import type { useCardColors } from './card-colors.js';
import { copyTextToClipboard } from './clipboard.js';
import { CombinationList, formatCombinationForClipboard } from './combination-list.js';
import { newCombination } from './editor.js';
import type { SelectionControlSummary } from './modules/module-contracts.js';
import { TaskScheduleDialog } from './task-schedule-dialog.js';
import { TaskTestsPanel } from './task-tests-panel.js';
import type { useTasks } from './use-tasks.js';

export function ActiveAccountsPage({
  workspace,
  selected,
  tasks,
  cardColors,
  busy,
  resourceSummaries,
  selectionControls,
  onSetResourceSummaries,
  onOpenResources,
  onEditCombination,
  onRefreshWorkspace,
  onRefreshResources,
  onMutate,
  onNotify,
}: {
  workspace: Workspace;
  selected: ReadonlySet<string>;
  tasks: ReturnType<typeof useTasks>;
  cardColors: ReturnType<typeof useCardColors>;
  busy: boolean;
  resourceSummaries: ResourceUsageSummaryValue[] | null;
  selectionControls: SelectionControlSummary;
  onSetResourceSummaries: (next: ResourceUsageSummaryValue[] | null) => void;
  onOpenResources: (row: SavedCombination) => void;
  onEditCombination: (row: SavedCombination) => void;
  onRefreshWorkspace: () => Promise<void>;
  onRefreshResources: () => Promise<void>;
  onMutate: (work: () => Promise<unknown>) => Promise<void>;
  onNotify: (msg: string) => void;
}) {
  const [schedule, setSchedule] = useState<{ row: SavedCombination; profileIds: string[] } | null>(
    null,
  );

  return (
    <>
      <TaskTestsPanel
        profiles={workspace.profiles}
        selected={selected}
        runtime={tasks.runtime}
        capabilities={tasks.capabilities}
        onConfigure={(destination) =>
          void onMutate(async () => {
            const row = await api.createDraft(newCombination(destination));
            onEditCombination(row);
          })
        }
        busy={busy}
        notify={onNotify}
        onRefresh={() => {
          tasks.refresh();
          void onRefreshWorkspace();
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
        isProfileBusy={selectionControls.isProfileBusy}
        busy={busy}
        colorOf={cardColors.colorOf}
        colorSupported={cardColors.supported}
        onColor={(row, color) =>
          void onMutate(async () => {
            await cardColors.setColor(row.id, color);
            return '卡片颜色已保存';
          })
        }
        onStart={(row) =>
          void onMutate(async () => {
            const usesTable = row.saved?.steps.some(
              (step) => step.type === 'post' && step.resourceMode === 'table',
            );
            const latestSummaries = usesTable ? await api.resourceSummaries() : resourceSummaries;
            if (usesTable) onSetResourceSummaries(latestSummaries);
            const revision = latestSummaries?.find(
              (value) => value.combinationId === row.id,
            )?.revision;
            if (usesTable && !revision) throw Error('请先保存并读取发帖资源');
            const busyIds = new Set<string>(
              [...selected].filter((id) => selectionControls.isProfileBusy(id)),
            );
            const offlineIds = new Set<string>(
              [...selected].filter(
                (id) => !busyIds.has(id) && !workspace.profiles.find((p) => p.id === id)?.online,
              ),
            );
            const eligibleIds = [...selected]
              .filter((id) => !busyIds.has(id) && !offlineIds.has(id))
              .sort();
            if (!eligibleIds.length) throw Error('所选浏览器当前不可启动，请检查连接或任务状态');
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
        onResources={onOpenResources}
        onSchedule={(row) => {
          const busyIds = new Set<string>(
            [...selected].filter((id) => selectionControls.isProfileBusy(id)),
          );
          const eligibleScheduleIds = [...selected].filter((id) => !busyIds.has(id)).sort();
          if (eligibleScheduleIds.length) {
            setSchedule({ row, profileIds: eligibleScheduleIds });
          }
        }}
        onNew={() =>
          void onMutate(async () => {
            const row = await api.createDraft(newCombination());
            onEditCombination(row);
          })
        }
        onEdit={onEditCombination}
        onCopy={(row) => {
          void (async () => {
            try {
              const text = formatCombinationForClipboard(row);
              await copyTextToClipboard(text);
              const name = (row.saved ?? row.draft)?.name || '未命名组合';
              onNotify(`已将任务组合「${name}」复制到剪贴板，可发给他人或点击“导入组合”创建副本`);
            } catch (err) {
              onNotify(err instanceof Error ? err.message : '复制组合失败');
            }
          })();
        }}
        onImport={async (parsed) => {
          await onMutate(async () => {
            if (parsed.mode === 'published') {
              await api.create(parsed.value);
            } else {
              await api.createDraft(parsed.value);
            }
            await onRefreshResources();
            return `已导入任务组合「${parsed.value.name || '未命名组合'}」`;
          });
        }}
        onDeleteMany={async (rows) => {
          const deleted: string[] = [];
          await onMutate(async () => {
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
            await onRefreshResources();
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
          void onMutate(async () => {
            await api.deleteCombination(row.id);
            await onRefreshResources();
            return `已删除任务组合「${(row.saved ?? row.draft)?.name || '未命名组合'}」`;
          })
        }
      />
      {schedule && (
        <TaskScheduleDialog
          name={schedule.row.saved?.name ?? '已保存组合'}
          version={schedule.row.version}
          count={schedule.profileIds.length}
          onClose={() => setSchedule(null)}
          onSubmit={async (timing) => {
            const usesTable = schedule.row.saved?.steps.some(
              (step) => step.type === 'post' && step.resourceMode === 'table',
            );
            const latestSummaries = usesTable ? await api.resourceSummaries() : resourceSummaries;
            if (usesTable) onSetResourceSummaries(latestSummaries);
            const revision = latestSummaries?.find(
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
            onNotify(`已安排 ${result.plans.length} 份任务，已固定当前保存版本`);
          }}
        />
      )}
    </>
  );
}
