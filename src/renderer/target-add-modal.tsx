import type { FormEvent } from 'react';
import { useCallback } from 'react';
import type { TargetFolder } from '../shared/target-list.js';
import {
  applyGroupGridPaste,
  extractGroupId,
  formatGroupGridRangeForClipboard,
  type DraftGroupEntry,
} from './group-inviter-grid.js';
import {
  computeGridBounds,
  getSelectedRowIndices,
  MatrixDataCell,
  useSpreadsheetGrid,
} from './matrix-grid.js';
import { BackdropModal, Btn, ModalHeading } from './modules/shared/module-ui.js';
import { UI_SELECT_SM } from './ui/primitives.js';

export { mapProfilesToScopeOptions } from './modules/shared/target-scope-bar.js';

export function makeDraftRow(groupId = '', groupName = ''): DraftGroupEntry {
  return {
    key: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    groupId,
    groupName,
  };
}
const getDraftCell = (row: DraftGroupEntry, col: number) =>
  col === 0 ? row.groupId : row.groupName;

export function GroupDraftGrid({
  rows,
  onChange,
  disabled,
  onError,
  entityLabel = '小组',
  normalizeId = extractGroupId,
}: {
  rows: DraftGroupEntry[];
  onChange: (rows: DraftGroupEntry[]) => void;
  disabled?: boolean;
  onError: (message: string) => void;
  entityLabel?: string;
  normalizeId?: (raw: string) => string;
}) {
  const applyCell = useCallback(
    (current: DraftGroupEntry[], rowIdx: number, col: number, value: string): DraftGroupEntry[] => {
      const next = current.map((row, idx) =>
        idx !== rowIdx
          ? row
          : col === 0
            ? { ...row, groupId: normalizeId(value) }
            : { ...row, groupName: value.trim() },
      );
      const last = next[next.length - 1];
      if (last && (last.groupId.trim() || last.groupName.trim())) next.push(makeDraftRow());
      return next;
    },
    [normalizeId],
  );

  const grid = useSpreadsheetGrid<DraftGroupEntry>({
    rows,
    colCount: 2,
    disabled,
    onRowsChange: onChange,
    getCellValue: getDraftCell,
    applyCellEdit: applyCell,
    clearCell: (row, col) => (col === 0 ? { ...row, groupId: '' } : { ...row, groupName: '' }),
    copyRangeText: (cur, b) =>
      formatGroupGridRangeForClipboard(
        cur,
        b.minRow,
        b.maxRow,
        b.minCol === 1 ? 1 : 0,
        b.maxCol === 1 ? 1 : 0,
      ),
    pasteTsv: (cur, b, text) =>
      applyGroupGridPaste(
        cur,
        b.minRow,
        b.minCol === 0 ? 0 : 1,
        text,
        () => makeDraftRow(),
        b.maxRow,
        b.maxCol === 0 ? 0 : 1,
        normalizeId,
      ),
    onError,
    createEmptyRow: () => makeDraftRow(),
  });
  const b = computeGridBounds(grid.selection) ?? { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 };

  return (
    <>
      <div className="group-inviter-selection-toolbar flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs text-[var(--text-2)]">
        <div className="flex flex-wrap items-center gap-3 tabular-nums">
          <span>
            当前选区：{b.minCol === 0 ? 'A' : 'B'}
            {b.minRow + 1}:{b.maxCol === 0 ? 'A' : 'B'}
            {b.maxRow + 1}（{b.maxRow - b.minRow + 1}行×{b.maxCol - b.minCol + 1}列）
          </span>
          <span className="font-medium text-[var(--text)]">
            已填有效{entityLabel} {rows.filter((row) => row.groupId.trim()).length} 个
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['清空选区 (Del)', false, () => grid.clearBounds(grid.bounds)],
              [
                '删除所涉整行',
                false,
                () => {
                  const del = new Set(getSelectedRowIndices(grid.bounds, rows.length));
                  if (!del.size) return;
                  const next = rows.filter((_, i) => !del.has(i));
                  grid.commitRows(next.length ? next : [makeDraftRow()], true);
                },
              ],
              ['撤销 (Ctrl+Z)', !grid.canUndo, grid.handleUndo],
              ['+1 行', false, () => grid.commitRows([...rows, makeDraftRow()], true)],
            ] as const
          ).map(([label, extraDisabled, fn]) => (
            <Btn key={label} disabled={disabled || extraDisabled} onClick={fn}>
              {label}
            </Btn>
          ))}
        </div>
      </div>
      <div
        ref={grid.wrapRef}
        className="group-inviter-grid-scroll min-h-[240px] max-h-[380px] flex-1 overflow-auto rounded-lg border border-[var(--line)] bg-white outline-none focus-visible:shadow-[var(--focus)]"
        tabIndex={0}
        onKeyDown={grid.handleGridKeyDown}
        onPaste={grid.handlePaste}
      >
        <table className="group-inviter-matrix w-full table-fixed border-collapse text-xs [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:border-r [&_thead_th]:border-b [&_thead_th]:border-[var(--line)] [&_thead_th]:bg-[var(--surface-2)] [&_thead_th]:px-2.5 [&_thead_th]:py-1.5 [&_thead_th]:text-left [&_thead_th]:text-[11px] [&_thead_th]:font-semibold [&_thead_th]:text-[var(--text-3)] [&_thead_th:last-child]:border-r-0 [&_tbody_td]:h-8 [&_tbody_td]:border-r [&_tbody_td]:border-b [&_tbody_td]:border-slate-100 [&_tbody_td]:p-0 [&_tbody_td]:align-middle [&_tbody_td:last-child]:border-r-0 [&_td.in-range]:bg-blue-50/75 [&_td.active-anchor]:shadow-[inset_0_0_0_2px_#2f6fed] [&_td.cell-editing]:bg-white [&_td_input]:h-8 [&_td_input]:w-full [&_td_input]:border-0 [&_td_input]:bg-transparent [&_td_input]:px-2.5 [&_td_input]:text-xs [&_td_input]:text-[var(--text)] [&_td_input]:outline-none [&_.resource-cell-value]:flex [&_.resource-cell-value]:h-8 [&_.resource-cell-value]:items-center [&_.resource-cell-value]:truncate [&_.resource-cell-value]:px-2.5 [&_.resource-cell-value]:text-xs [&_.resource-cell-value]:text-[var(--text)]">
          <thead>
            <tr>
              <th className="w-10 text-center">#</th>
              <th className="w-[52%]">{entityLabel} ID / 链接</th>
              <th className="w-[40%]">{entityLabel}名称（可选）</th>
              <th className="w-10" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => (
              <tr key={row.key}>
                <td
                  className="cursor-cell bg-[var(--surface-2)] text-center font-normal tabular-nums text-[var(--text-3)]"
                  onMouseDown={(e) => grid.beginRowMouseDown(e, rIdx)}
                  onMouseEnter={() => grid.handleCellMouseEnter(rIdx, 0)}
                >
                  {rIdx + 1}
                </td>
                {([0, 1] as const).map((col) => (
                  <MatrixDataCell
                    key={col}
                    {...grid.getCellProps(rIdx, col)}
                    role="gridcell"
                    editorKind="input"
                    showFillHandle={false}
                    valueText={getDraftCell(row, col)}
                    placeholder={col === 0 ? `粘贴${entityLabel} ID 或链接` : '可选名称'}
                  />
                ))}
                <td className="text-center">
                  <button
                    type="button"
                    className="btn btn-xs inline-flex h-6 w-6 items-center justify-center rounded border border-transparent bg-transparent p-0 text-sm leading-none text-[var(--text-3)] transition-colors hover:not-disabled:bg-rose-50 hover:not-disabled:text-rose-600 disabled:cursor-not-allowed disabled:opacity-35"
                    disabled={disabled || rows.length <= 1}
                    title="删除这一行"
                    onClick={() => {
                      const next = rows.filter((_, i) => i !== rIdx);
                      grid.commitRows(next.length ? next : [makeDraftRow()], true);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TargetFolderSelect({
  folders,
  value,
  onChange,
  ariaLabel,
}: {
  folders: readonly TargetFolder[];
  value: string | null;
  onChange: (next: string | null) => void;
  ariaLabel: string;
}) {
  if (!folders.length) return null;
  return (
    <label className="mt-1 mb-1 flex items-center gap-2 text-xs font-medium text-[var(--text-2)]">
      <span>归入分组</span>
      <select
        className={`${UI_SELECT_SM} min-w-[150px]`}
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">未分组</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TargetAddModal({
  open,
  title = '添加小组',
  description = '支持只填「小组 ID 或链接」（名字选填，留空将自动解析真实小组名与头像），也支持从 Excel 或文本直接多行粘贴。',
  folders,
  addFolder,
  onFolderChange,
  folderAriaLabel = '添加小组归入分组',
  rows,
  onRowsChange,
  busy,
  error,
  onError,
  entityLabel = '小组',
  normalizeId,
  footerClassName = 'mt-1 flex shrink-0 justify-end gap-2',
  onClose,
  onSubmit,
}: {
  open: boolean;
  title?: string;
  description?: string;
  folders: readonly TargetFolder[];
  addFolder: string | null;
  onFolderChange: (next: string | null) => void;
  folderAriaLabel?: string;
  rows: DraftGroupEntry[];
  onRowsChange: (rows: DraftGroupEntry[]) => void;
  busy: boolean;
  error: string;
  onError: (msg: string) => void;
  entityLabel?: string;
  normalizeId: (raw: string) => string;
  footerClassName?: string;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  if (!open) return null;
  return (
    <BackdropModal
      label={title}
      modalClass="contents"
      busy={busy}
      onClose={() => !document.querySelector('[data-grid-cell-editing="1"]') && onClose()}
    >
      <form
        className="modal group-inviter-add-modal flex max-h-[calc(100vh-40px)] w-[min(760px,calc(100vw-32px))] flex-col gap-2.5 overflow-hidden rounded-2xl border border-[var(--line)] bg-white px-5 py-4 text-[var(--text)] shadow-2xl"
        onSubmit={onSubmit}
      >
        <ModalHeading
          title={title}
          closeText="×"
          disabled={busy}
          onClose={onClose}
          className="px-0 pt-0"
        />
        {description && (
          <p className="muted m-0 text-xs leading-relaxed text-[var(--text-3)]">{description}</p>
        )}
        <TargetFolderSelect
          folders={folders}
          value={addFolder}
          onChange={onFolderChange}
          ariaLabel={folderAriaLabel}
        />
        <GroupDraftGrid
          rows={rows}
          onChange={onRowsChange}
          disabled={busy}
          onError={onError}
          entityLabel={entityLabel}
          normalizeId={normalizeId}
        />
        <div className={footerClassName}>
          <Btn sm={false} disabled={busy} onClick={onClose}>
            取消
          </Btn>
          <Btn v="primary" sm={false} type="submit" disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </Btn>
        </div>
        {error && (
          <p className="error-note m-0 text-xs font-medium text-rose-600" role="alert">
            {error}
          </p>
        )}
      </form>
    </BackdropModal>
  );
}
