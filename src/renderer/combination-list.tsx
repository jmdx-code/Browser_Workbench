import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { Combination, Profile, SavedCombination } from '../shared/contracts.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import type { TaskCapabilities, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { isErroredPausedPlan } from '../shared/task-issues.js';
import type { CardColor } from './card-colors.js';
import {
  COMBINATION_CLIPBOARD_FORMAT,
  CombinationCard,
  LIVE_COMBINATION_STATES,
  parseImportedCombination,
} from './combination-card.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { IconLayers, IconPlus, IconSearch } from './icons.js';
import { Btn, Chk, NativeFormDialog, useBusyTask } from './modules/shared/module-ui.js';
import { toggleSet } from './selection.js';
import {
  EmptyState,
  UI_CARD,
  UI_COUNT_CHIP,
  UI_INPUT,
  UI_MUTED,
  UI_TEXTAREA,
  UiSwitch,
} from './ui/primitives.js';

export {
  COMBINATION_CLIPBOARD_FORMAT,
  formatCombinationForClipboard,
  parseImportedCombination,
  stepSummary,
} from './combination-card.js';

function ImportCombinationDialog(p: {
  existingNames: ReadonlySet<string>;
  onClose: () => void;
  onSubmit: (parsed: { value: Combination }) => Promise<void>;
}) {
  const [rawText, setRawText] = useState('');
  const [customName, setCustomName] = useState('');
  const { busy, error, setError, run } = useBusyTask();

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRawText(text);
        setError('');
      } else setError('剪贴板为空，请先点击任务组合上的“复制组合”');
    } catch {
      setError('无法直接读取剪贴板，请在下方输入框中使用 Ctrl+V 粘贴');
    }
  }

  return (
    <NativeFormDialog
      title="导入任务组合"
      subtitle={
        <>
          粘贴通过「复制组合」获取的固定格式数据（<code>{COMBINATION_CLIPBOARD_FORMAT}</code>
          ），既可导入他人分享的组合，也可在本地二次导入作为副本。
        </>
      }
      busy={busy}
      error={error}
      submitLabel={busy ? '正在导入…' : '确认导入'}
      onClose={p.onClose}
      onSubmit={() => {
        let parsed: { value: Combination };
        try {
          parsed = parseImportedCombination(rawText, p.existingNames, customName);
        } catch (err) {
          return setError(err instanceof Error ? err.message : '数据解析失败');
        }
        void run(() => p.onSubmit(parsed), '导入失败，请重试');
      }}
    >
      <label className="mb-1 flex flex-col gap-1 text-xs font-medium text-[var(--text-2)]">
        <span>新组合名称（可选，留空则沿用原名并自动区分副本）</span>
        <input
          maxLength={80}
          className={`${UI_INPUT} w-full`}
          value={customName}
          disabled={busy}
          placeholder="留空自动命名"
          onChange={(e) => setCustomName(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-2)]">
        <span className="flex items-center justify-between gap-2">
          <span>组合配置数据</span>
          <Btn disabled={busy} onClick={() => void pasteFromClipboard()}>
            从剪贴板粘贴
          </Btn>
        </span>
        <textarea
          rows={9}
          className={`${UI_TEXTAREA} font-mono`}
          value={rawText}
          disabled={busy}
          placeholder="请在此处粘贴复制的任务组合 JSON 数据 (Ctrl+V)…"
          onChange={(e) => {
            setRawText(e.target.value);
            if (error) setError('');
          }}
        />
      </label>
    </NativeFormDialog>
  );
}

export function CombinationList(p: {
  carrier?: 'browser' | 'bluestacks' | undefined;
  rows: SavedCombination[];
  selectedCount: number;
  selectedIds?: ReadonlySet<string>;
  profiles?: readonly Profile[];
  isProfileBusy?: ((profileId: string) => boolean) | undefined;
  closeBrowserOnFinish?: boolean;
  onCloseBrowserOnFinishChange?: (next: boolean) => void;
  onEdit: (row: SavedCombination) => void;
  onNew: () => void;
  onCopy: (row: SavedCombination) => void;
  onImport?: (parsed: { value: Combination }) => Promise<void>;
  onDelete?: (row: SavedCombination) => void;
  onDeleteMany?: (rows: SavedCombination[]) => Promise<string[]>;
  onResources: (row: SavedCombination) => void;
  onQuickSchedule?: ((row: SavedCombination) => void) | undefined;
  resourceSummaries: ResourceUsageSummaryValue[] | null;
  capabilities?: z.infer<typeof TaskCapabilities> | null;
  runtime?: z.infer<typeof TaskRuntimeOverview> | null;
  busy?: boolean;
  onStart?: (row: SavedCombination) => void;
  colorOf?: (id: string) => CardColor;
  colorSupported?: boolean;
  onColor?: (row: SavedCombination, color: CardColor) => void;
}) {
  const {
    carrier = 'browser',
    rows,
    selectedCount,
    selectedIds,
    profiles,
    runtime,
    busy,
    onImport,
    onDeleteMany,
  } = p;
  const isBs = carrier === 'bluestacks';
  const [search, setSearch] = useState('');
  const [managing, setManaging] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [deletingRow, setDeletingRow] = useState<SavedCombination | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    const existing = new Set(rows.map((row) => row.id));
    setChecked((prev) => {
      const rem = new Set([...prev].filter((id) => existing.has(id)));
      return rem.size === prev.size ? prev : rem;
    });
  }, [rows]);

  const inUse = new Set(
    runtime?.plans
      .filter((x) => LIVE_COMBINATION_STATES.includes(x.state))
      .map((x) => x.combinationId),
  );
  const selectedRows = rows.filter((row) => checked.has(row.id) && !inUse.has(row.id));
  const toggleRow = (id: string) => {
    if (!busy && !inUse.has(id)) setChecked((prev) => toggleSet(prev, id));
  };

  const query = search.trim().toLocaleLowerCase();
  const matching = rows.filter(
    (row) =>
      row.saved &&
      (!query || (row.saved.name + '\n' + row.saved.note).toLocaleLowerCase().includes(query)),
  );
  const busyProfileSet = p.isProfileBusy
    ? new Set([...(selectedIds ?? [])].filter((id) => p.isProfileBusy?.(id)))
    : new Set(
        runtime?.plans
          .filter(
            (x) =>
              selectedIds?.has(x.profileId) &&
              !['STOPPED', 'COMPLETED', 'FAILED'].includes(x.state) &&
              !isErroredPausedPlan(x),
          )
          .map((x) => x.profileId) ?? [],
      );
  const busySelected = busyProfileSet.size;
  const offlineSelected =
    selectedIds && profiles
      ? [...selectedIds].filter(
          (id) => !busyProfileSet.has(id) && !profiles.find((r) => r.id === id)?.online,
        ).length
      : 0;
  const eligibleImmediateCount = Math.max(0, selectedCount - busySelected);
  const selectableMatching = matching.filter((row) => !inUse.has(row.id));

  return (
    <section aria-label="任务组合">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-slate-900">
          <span>任务组合</span>
          <span className={UI_COUNT_CHIP}>{rows.length}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {p.onCloseBrowserOnFinishChange && !managing && (
            <span
              className="toolbar-toggle inline-flex items-center"
              title={
                isBs
                  ? '活跃完毕自动关闭对应蓝蝶窗口（手动停止或有其他任务占用时不关闭）'
                  : '活跃完毕自动关闭对应浏览器（手动停止或有其他任务占用时不关闭）'
              }
            >
              <UiSwitch
                ariaLabel={isBs ? '活跃完毕关闭蓝蝶窗口' : '活跃完毕关闭浏览器'}
                label="完毕关窗"
                checked={Boolean(p.closeBrowserOnFinish)}
                disabled={busy}
                onCheckedChange={p.onCloseBrowserOnFinishChange}
              />
            </span>
          )}
          <label className="relative flex items-center">
            <IconSearch
              size={14}
              className="pointer-events-none absolute left-2.5 text-[var(--text-3)]"
            />
            <input
              type="search"
              aria-label="搜索任务组合"
              placeholder="搜索组合"
              className={`${UI_INPUT} w-44 pl-8`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {onDeleteMany && rows.length > 0 && (
            <Btn
              sm={false}
              disabled={busy}
              onClick={() => {
                if (!managing) return setManaging(true);
                setManaging(false);
                setChecked(new Set());
              }}
            >
              {managing ? '完成' : '批量管理'}
            </Btn>
          )}
          {!managing && onImport && (
            <Btn sm={false} disabled={busy} onClick={() => setImportOpen(true)}>
              导入
            </Btn>
          )}
          {!managing && (
            <Btn v="primary" sm={false} onClick={p.onNew}>
              <IconPlus /> 新建组合
            </Btn>
          )}
        </div>
      </div>

      {managing && (
        <div
          className={`${UI_CARD} mb-4 flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-xs`}
          aria-label="批量管理任务组合"
        >
          <Chk
            aria-label="全选当前搜索结果"
            label="全选当前搜索结果"
            disabled={busy || !selectableMatching.length}
            checked={
              selectableMatching.length > 0 &&
              selectableMatching.every((row) => checked.has(row.id))
            }
            onChange={(sel) =>
              setChecked((prev) =>
                toggleSet(
                  prev,
                  selectableMatching.map((r) => r.id),
                  sel,
                ),
              )
            }
          />
          <span className="font-medium text-[var(--text)]">已选 {selectedRows.length} 项</span>
          <span className={UI_MUTED}>使用中的组合需先停止任务</span>
          <div className="ml-auto flex items-center gap-2">
            <Btn
              v="danger"
              sm={false}
              disabled={busy || !selectedRows.length}
              onClick={() => setConfirmBatchDelete(true)}
            >
              删除所选
            </Btn>
            <Btn sm={false} disabled={busy} onClick={() => setChecked(new Set())}>
              取消选择
            </Btn>
          </div>
        </div>
      )}

      {rows.length > 0 && !matching.length && (
        <p className={`${UI_MUTED} py-4`}>没有匹配的任务组合。</p>
      )}
      <div className="flex flex-wrap gap-3.5">
        {matching.map((row) => (
          <CombinationCard
            key={row.id}
            carrier={carrier}
            row={row}
            managing={managing}
            isChecked={checked.has(row.id)}
            busy={busy}
            selectedCount={selectedCount}
            busySelected={busySelected}
            offlineSelected={offlineSelected}
            eligibleImmediateCount={eligibleImmediateCount}
            resourceSummaries={p.resourceSummaries}
            capabilities={p.capabilities}
            runtime={runtime}
            color={p.colorOf?.(row.id) ?? 'graphite'}
            colorSupported={p.colorSupported}
            onToggleRow={toggleRow}
            onEdit={p.onEdit}
            onCopy={p.onCopy}
            onDelete={p.onDelete}
            onRequestDelete={setDeletingRow}
            onResources={p.onResources}
            onQuickSchedule={p.onQuickSchedule}
            onStart={p.onStart}
            onColor={p.onColor}
          />
        ))}
      </div>

      {rows.length === 0 && (
        <div className="mx-auto my-10 max-w-[440px]">
          <EmptyState
            icon={<IconLayers size={26} />}
            title="还没有任务组合"
            action={
              <div className="flex justify-center gap-2">
                {onImport && (
                  <Btn sm={false} onClick={() => setImportOpen(true)}>
                    导入
                  </Btn>
                )}
                <Btn v="primary" sm={false} onClick={p.onNew}>
                  <IconPlus /> 新建组合
                </Btn>
              </div>
            }
          />
        </div>
      )}

      {importOpen && onImport && (
        <ImportCombinationDialog
          existingNames={
            new Set(rows.map((r) => r.saved?.name?.trim()).filter((n): n is string => Boolean(n)))
          }
          onClose={() => setImportOpen(false)}
          onSubmit={async (parsed) => {
            await onImport(parsed);
            setImportOpen(false);
          }}
        />
      )}
      {confirmBatchDelete && onDeleteMany && (
        <ConfirmDialog
          title="批量删除任务组合"
          label={`确认删除 ${selectedRows.length} 项`}
          description={`确定删除以下 ${selectedRows.length} 个任务组合？历史运行记录、原素材和素材使用状态保留。\n\n${selectedRows.map((row) => '· ' + (row.saved?.name || '未命名组合')).join('\n')}`}
          onClose={() => setConfirmBatchDelete(false)}
          onConfirm={async () => {
            const deleted = new Set(await onDeleteMany(selectedRows));
            setChecked((prev) => new Set([...prev].filter((id) => !deleted.has(id))));
            if (selectedRows.every((row) => deleted.has(row.id))) setManaging(false);
          }}
        />
      )}
      {deletingRow && p.onDelete && (
        <ConfirmDialog
          title="删除任务组合"
          description={`确定删除任务组合「${deletingRow.saved?.name || '未命名组合'}」吗？该组合将从列表中移除，历史任务运行记录仍会保留。`}
          label="确认删除"
          onClose={() => setDeletingRow(null)}
          onConfirm={async () => p.onDelete?.(deletingRow)}
        />
      )}
    </section>
  );
}
