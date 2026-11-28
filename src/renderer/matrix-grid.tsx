import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { copyTextToClipboard } from './clipboard.js';
export type GridRange = { startRow: number; startCol: number; endRow: number; endCol: number };
export type GridBounds = { minRow: number; maxRow: number; minCol: number; maxCol: number };
export type EditingCell = { row: number; col: number; value: string };
export type GridDragMode = 'cells' | 'rows' | 'fill' | null;
export const computeGridBounds = (r: GridRange | null): GridBounds | null =>
  r
    ? {
        minRow: Math.min(r.startRow, r.endRow),
        maxRow: Math.max(r.startRow, r.endRow),
        minCol: Math.min(r.startCol, r.endCol),
        maxCol: Math.max(r.startCol, r.endCol),
      }
    : null;
export const isCellInGridBounds = (b: GridBounds | null, r: number, c: number) =>
  Boolean(b && r >= b.minRow && r <= b.maxRow && c >= b.minCol && c <= b.maxCol);
export const isRowInGridBounds = (b: GridBounds | null, r: number, cols: number) =>
  Boolean(b && r >= b.minRow && r <= b.maxRow && b.minCol === 0 && b.maxCol >= cols - 1);
export function getSelectedRowIndices(b: GridBounds | null, rowCount: number): number[] {
  if (!b) return [];
  const out: number[] = [];
  for (let r = Math.max(0, b.minRow); r <= Math.min(rowCount - 1, b.maxRow); r += 1) out.push(r);
  return out;
}
function isFillPreviewCell(endRow: number | null, b: GridBounds | null, r: number, c: number) {
  if (endRow === null || !b || c < b.minCol || c > b.maxCol) return false;
  return endRow > b.maxRow
    ? r > b.maxRow && r <= endRow
    : endRow < b.minRow && r < b.minRow && r >= endRow;
}
const quoteGridCell = (v: string) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function expandFillDownTsv<TRow>(
  rows: readonly TRow[],
  b: GridBounds,
  fillEndRow: number,
  getCellValue: (row: TRow, col: number) => string,
): string {
  const tpl = rows
    .slice(b.minRow, b.maxRow + 1)
    .map((r) =>
      Array.from({ length: b.maxCol - b.minCol + 1 }, (_, i) => getCellValue(r, b.minCol + i)),
    );
  return Array.from({ length: fillEndRow - b.maxRow }, (_, i) =>
    (tpl[i % tpl.length] ?? []).map(quoteGridCell).join('\t'),
  ).join('\n');
}
type DesktopWinMaybe = Window & {
  workbenchDesktop?: { materialFilePath?: (file: File) => string };
};
export function resolveElectronFilePath(file: File): string {
  const fromBridge =
    typeof window !== 'undefined'
      ? (window as DesktopWinMaybe).workbenchDesktop?.materialFilePath?.(file)?.trim()
      : '';
  if (fromBridge) return fromBridge;
  return (file as File & { path?: string }).path?.trim() ?? '';
}
export const parseElectronFilePaths = (files: FileList | null): string[] =>
  files ? Array.from(files).map(resolveElectronFilePath).filter(Boolean) : [];
function syncTextareaHeight(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(el.scrollHeight, 24)}px`;
}
export function useSpreadsheetGrid<TRow>(opts: {
  rows: TRow[];
  colCount: number;
  disabled?: boolean;
  undoLimit?: number;
  onRowsChange: (rows: TRow[]) => void;
  getCellValue: (row: TRow, col: number) => string;
  setCellValue?: (row: TRow, col: number, value: string) => TRow;
  applyCellEdit?: (rows: TRow[], row: number, col: number, value: string) => TRow[];
  clearCell?: (row: TRow, col: number) => TRow;
  isSelectCol?: (col: number) => boolean;
  isEditableCell?: (row: number, col: number) => boolean;
  onFillApply?: (bounds: GridBounds, fillEndRow: number) => void;
  fillDown?: (rows: TRow[], bounds: GridBounds, fillEndRow: number) => TRow[];
  onCopyRange?: (bounds: GridBounds, isCut: boolean) => void | Promise<void>;
  copyRangeText?: (rows: TRow[], bounds: GridBounds) => string;
  pasteTsv?: (rows: TRow[], bounds: GridBounds, text: string) => TRow[];
  onError?: (msg: string) => void;
  onSpaceKey?: (row: number, col: number) => boolean;
  onSelectCommittedCell?: (row: number, col: number) => void;
  createEmptyRow?: () => TRow;
}) {
  const { rows, colCount, onRowsChange, getCellValue, isSelectCol, isEditableCell, onError } = opts;
  const disabled = opts.disabled ?? false;
  const undoLimit = opts.undoLimit ?? 50;
  const [selection, setSelection] = useState<GridRange | null>({
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
  });
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [fillEndRow, setFillEndRow] = useState<number | null>(null);
  const [histCounts, setHistCounts] = useState<[number, number]>([0, 0]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editSelectRef = useRef<HTMLSelectElement | null>(null);
  const dragModeRef = useRef<GridDragMode>(null);
  const historyRef = useRef<{ undo: TRow[][]; redo: TRow[][] }>({ undo: [], redo: [] });
  const rowsRef = useRef(rows);
  const editingRef = useRef(editing);
  const selectionRef = useRef(selection);
  const fillEndRowRef = useRef(fillEndRow);
  const optsRef = useRef(opts);
  rowsRef.current = rows;
  editingRef.current = editing;
  selectionRef.current = selection;
  fillEndRowRef.current = fillEndRow;
  optsRef.current = opts;
  const bounds = computeGridBounds(selection);
  const syncCounts = useCallback(
    () => setHistCounts([historyRef.current.undo.length, historyRef.current.redo.length]),
    [],
  );
  const commitRows = useCallback(
    (nextRows: TRow[], recordHistory = true) => {
      if (recordHistory) {
        historyRef.current.undo = [
          ...historyRef.current.undo.slice(-(undoLimit - 1)),
          rowsRef.current,
        ];
        historyRef.current.redo = [];
        syncCounts();
      }
      rowsRef.current = nextRows;
      onRowsChange(nextRows);
    },
    [onRowsChange, syncCounts, undoLimit],
  );
  const stepHistory = useCallback(
    (dir: 'undo' | 'redo') => {
      const src = historyRef.current[dir];
      const snap = !disabled ? src[src.length - 1] : undefined;
      if (!snap) return;
      historyRef.current[dir] = src.slice(0, -1);
      const other = dir === 'undo' ? 'redo' : 'undo';
      historyRef.current[other] = [
        ...historyRef.current[other].slice(-(undoLimit - 1)),
        rowsRef.current,
      ];
      syncCounts();
      setEditing(null);
      onRowsChange(snap);
    },
    [disabled, onRowsChange, syncCounts, undoLimit],
  );
  const canEditCell = useCallback(
    (r: number, c: number) =>
      !disabled &&
      r >= 0 &&
      r < rowsRef.current.length &&
      c >= 0 &&
      c < colCount &&
      (!isEditableCell || isEditableCell(r, c)),
    [colCount, disabled, isEditableCell],
  );
  const startEdit = useCallback(
    (row: number, col: number, initialValue?: string) => {
      const target = canEditCell(row, col) ? rowsRef.current[row] : undefined;
      if (!target) return;
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
      setEditing({ row, col, value: initialValue ?? getCellValue(target, col) });
    },
    [canEditCell, getCellValue],
  );
  const commitEdit = useCallback((): TRow[] => {
    const active = editingRef.current;
    if (!active) return rowsRef.current;
    setEditing(null);
    const cur = rowsRef.current;
    const target = cur[active.row];
    if (!target || getCellValue(target, active.col) === active.value) return cur;
    const { applyCellEdit, setCellValue } = optsRef.current;
    const nextRows = applyCellEdit
      ? applyCellEdit(cur, active.row, active.col, active.value)
      : setCellValue
        ? cur.map((item, idx) =>
            idx === active.row ? setCellValue(item, active.col, active.value) : item,
          )
        : cur;
    if (nextRows !== cur) commitRows(nextRows, true);
    return nextRows;
  }, [commitRows, getCellValue]);
  const cancelEdit = useCallback(() => {
    setEditing(null);
    wrapRef.current?.focus();
  }, []);
  const clearBounds = useCallback(
    (target: GridBounds | null) => {
      if (disabled || !target) return;
      const { clearCell, setCellValue } = optsRef.current;
      commitRows(
        rowsRef.current.map((row, rIdx) => {
          if (rIdx < target.minRow || rIdx > target.maxRow) return row;
          let next = row;
          for (let c = target.minCol; c <= target.maxCol; c += 1) {
            if (isEditableCell && !isEditableCell(rIdx, c)) continue;
            if (clearCell) next = clearCell(next, c);
            else if (setCellValue) next = setCellValue(next, c, '');
          }
          return next;
        }),
        true,
      );
    },
    [commitRows, disabled, isEditableCell],
  );
  const moveCursor = useCallback(
    (dRow: number, dCol: number, expand = false) => {
      const total = rowsRef.current.length;
      if (!total) return;
      const cur = selectionRef.current ?? { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
      let nextRow = Math.max(0, cur.endRow + dRow);
      if (nextRow >= total && dRow > 0 && optsRef.current.createEmptyRow && !expand && !disabled) {
        const appended = [...rowsRef.current, optsRef.current.createEmptyRow()];
        commitRows(appended, false);
        nextRow = appended.length - 1;
      } else nextRow = Math.min(total - 1, nextRow);
      const nextCol = Math.max(0, Math.min(colCount - 1, cur.endCol + dCol));
      setSelection(
        expand
          ? { startRow: cur.startRow, startCol: cur.startCol, endRow: nextRow, endCol: nextCol }
          : { startRow: nextRow, startCol: nextCol, endRow: nextRow, endCol: nextCol },
      );
    },
    [colCount, commitRows, disabled],
  );
  const doCopy = useCallback(
    async (b: GridBounds, isCut: boolean) => {
      const { onCopyRange, copyRangeText } = optsRef.current;
      if (onCopyRange) return void (await onCopyRange(b, isCut));
      if (!copyRangeText || b.maxRow >= rowsRef.current.length) return;
      try {
        await copyTextToClipboard(copyRangeText(rowsRef.current, b));
      } catch (e) {
        onError?.(e instanceof Error ? e.message : '复制失败');
      }
    },
    [onError],
  );
  const applyPastedText = useCallback(
    (text: string) => {
      const { pasteTsv } = optsRef.current;
      if (disabled || editingRef.current || !pasteTsv) return;
      const b = computeGridBounds(selectionRef.current) ?? {
        minRow: 0,
        maxRow: 0,
        minCol: 0,
        maxCol: 0,
      };
      try {
        commitRows(pasteTsv(rowsRef.current, b, text), true);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : '粘贴失败');
      }
    },
    [commitRows, disabled, onError],
  );
  const handlePaste = useCallback(
    (e: ReactClipboardEvent) => {
      if (editingRef.current || disabled || !optsRef.current.pasteTsv) return;
      const text = e.clipboardData.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      applyPastedText(text);
    },
    [applyPastedText, disabled],
  );
  useEffect(() => {
    if (!editing) return;
    if (isSelectCol?.(editing.col)) editSelectRef.current?.focus();
    else if (editInputRef.current) {
      editInputRef.current.focus();
      syncTextareaHeight(editInputRef.current);
      const len = editInputRef.current.value.length;
      editInputRef.current.setSelectionRange(len, len);
    }
  }, [editing?.row, editing?.col, isSelectCol]);
  useEffect(() => {
    const onUp = () => {
      if (dragModeRef.current === 'fill') {
        const b = computeGridBounds(selectionRef.current);
        const end = fillEndRowRef.current;
        const { onFillApply, fillDown } = optsRef.current;
        if (end !== null && b) {
          if (onFillApply) onFillApply(b, end);
          else if (fillDown && !disabled && end > b.maxRow && rowsRef.current.length) {
            try {
              commitRows(fillDown(rowsRef.current, b, end), true);
            } catch (e) {
              onError?.(e instanceof Error ? e.message : '向下填充失败');
            }
          }
        }
      }
      dragModeRef.current = null;
      setFillEndRow(null);
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [commitRows, disabled, onError]);
  const beginSelMouseDown = useCallback(
    (e: ReactMouseEvent, row: number, col: number, mode: 'cells' | 'rows') => {
      if (e.button !== 0) return;
      if (
        editingRef.current &&
        (mode === 'rows' || editingRef.current.row !== row || editingRef.current.col !== col)
      )
        commitEdit();
      if (mode === 'cells' && editingRef.current?.row === row && editingRef.current.col === col)
        return;
      wrapRef.current?.focus();
      const sCol = mode === 'rows' ? 0 : col;
      const eCol = mode === 'rows' ? colCount - 1 : col;
      if (e.shiftKey && selectionRef.current) {
        setSelection({
          startRow: selectionRef.current.startRow,
          startCol: mode === 'rows' ? 0 : selectionRef.current.startCol,
          endRow: row,
          endCol: eCol,
        });
      } else {
        setSelection({ startRow: row, startCol: sCol, endRow: row, endCol: eCol });
        dragModeRef.current = mode;
      }
    },
    [colCount, commitEdit],
  );
  const beginCellMouseDown = useCallback(
    (e: ReactMouseEvent, row: number, col: number) => beginSelMouseDown(e, row, col, 'cells'),
    [beginSelMouseDown],
  );
  const beginRowMouseDown = useCallback(
    (e: ReactMouseEvent, row: number) => beginSelMouseDown(e, row, 0, 'rows'),
    [beginSelMouseDown],
  );
  const beginFillMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragModeRef.current = 'fill';
  }, []);
  const handleCellMouseEnter = useCallback(
    (row: number, col: number) => {
      const m = dragModeRef.current;
      if (m === 'cells') setSelection((p) => (p ? { ...p, endRow: row, endCol: col } : null));
      else if (m === 'rows')
        setSelection((p) => (p ? { ...p, startCol: 0, endRow: row, endCol: colCount - 1 } : null));
      else if (m === 'fill') setFillEndRow(row);
    },
    [colCount],
  );
  const handleGridKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (editingRef.current) return;
      const meta = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (meta && (k === 'z' || k === 'y')) {
        e.preventDefault();
        return stepHistory(k === 'y' || e.shiftKey ? 'redo' : 'undo');
      }
      if (meta && k === 'a') {
        e.preventDefault();
        if (rowsRef.current.length)
          setSelection({
            startRow: 0,
            startCol: 0,
            endRow: rowsRef.current.length - 1,
            endCol: colCount - 1,
          });
        return;
      }
      const curBounds = computeGridBounds(selectionRef.current);
      if (meta && (k === 'c' || k === 'x') && curBounds) {
        e.preventDefault();
        void doCopy(curBounds, k === 'x');
        if (k === 'x') clearBounds(curBounds);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        return clearBounds(curBounds);
      }
      const cur = selectionRef.current ?? { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
      if (e.key === ' ')
        return void (optsRef.current.onSpaceKey?.(cur.endRow, cur.endCol) && e.preventDefault());
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        if (
          e.key === 'Enter' &&
          optsRef.current.onSelectCommittedCell &&
          !canEditCell(cur.endRow, cur.endCol)
        )
          optsRef.current.onSelectCommittedCell(cur.endRow, cur.endCol);
        else startEdit(cur.endRow, cur.endCol);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        return moveCursor(0, e.shiftKey ? -1 : 1, false);
      }
      const delta = (
        { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<
          string,
          [number, number]
        >
      )[e.key];
      if (delta) {
        e.preventDefault();
        return moveCursor(delta[0], delta[1], e.shiftKey);
      }
      if (
        e.key.length === 1 &&
        !meta &&
        !e.altKey &&
        !isSelectCol?.(cur.endCol) &&
        canEditCell(cur.endRow, cur.endCol)
      ) {
        e.preventDefault();
        startEdit(cur.endRow, cur.endCol, e.key);
      }
    },
    [canEditCell, clearBounds, colCount, doCopy, isSelectCol, moveCursor, startEdit, stepHistory],
  );
  const handleEditKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === 'Enter' && (e.currentTarget.tagName !== 'TEXTAREA' || !e.shiftKey)) {
        e.preventDefault();
        commitEdit();
        moveCursor(1, 0, false);
        wrapRef.current?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit();
        moveCursor(0, e.shiftKey ? -1 : 1, false);
        wrapRef.current?.focus();
      }
    },
    [cancelEdit, commitEdit, moveCursor],
  );
  const getCellProps = (rIdx: number, col: number) => {
    const isEditing = editing?.row === rIdx && editing.col === col;
    return {
      isActive: selection?.endRow === rIdx && selection.endCol === col,
      isSelected: isCellInGridBounds(bounds, rIdx, col),
      isFillPreview: isFillPreviewCell(fillEndRow, bounds, rIdx, col),
      isEditing,
      showFillHandle:
        Boolean(bounds) && rIdx === bounds?.maxRow && col === bounds?.maxCol && !disabled,
      editValue: isEditing ? editing?.value : undefined,
      editInputRef,
      editSelectRef,
      onMouseDown: (e: ReactMouseEvent<HTMLTableCellElement>) => beginCellMouseDown(e, rIdx, col),
      onMouseEnter: () => handleCellMouseEnter(rIdx, col),
      onDoubleClick: () => startEdit(rIdx, col),
      onFillMouseDown: beginFillMouseDown,
      onEditChange: (v: string) => setEditing((p) => (p ? { ...p, value: v } : null)),
      onEditBlur: commitEdit,
      onEditKeyDown: handleEditKeyDown,
    };
  };
  return {
    selection,
    setSelection,
    bounds,
    editing,
    setEditing,
    fillEndRow,
    canUndo: histCounts[0] > 0,
    canRedo: histCounts[1] > 0,
    wrapRef,
    editInputRef,
    editSelectRef,
    commitRows,
    handleUndo: useCallback(() => stepHistory('undo'), [stepHistory]),
    handleRedo: useCallback(() => stepHistory('redo'), [stepHistory]),
    startEdit,
    commitEdit,
    cancelEdit,
    clearBounds,
    moveCursor,
    beginCellMouseDown,
    beginRowMouseDown,
    beginFillMouseDown,
    handleCellMouseEnter,
    handleGridKeyDown,
    handlePaste,
    applyPastedText,
    doCopy,
    getCellProps,
  };
}
export type GridSelectOption = { value: string; label: string };
export function MatrixDataCell(props: {
  className?: string;
  displayClassName?: string;
  editorKind?: 'textarea' | 'input' | 'select';
  role?: string;
  title?: string;
  isActive: boolean;
  isSelected: boolean;
  isFillPreview?: boolean;
  isEditing: boolean;
  showFillHandle?: boolean;
  valueText: string;
  placeholder?: string;
  showArrow?: boolean;
  editValue?: string;
  selectOptions?: readonly GridSelectOption[];
  editInputRef?: RefObject<HTMLTextAreaElement | null>;
  editSelectRef?: RefObject<HTMLSelectElement | null>;
  onMouseDown: (e: ReactMouseEvent<HTMLTableCellElement>) => void;
  onMouseEnter: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLTableCellElement>) => void;
  onFillMouseDown?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onEditChange?: (value: string) => void;
  onEditBlur?: () => void;
  onEditKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
  children?: ReactNode;
}) {
  const cls = [
    'relative min-h-8 border border-[#e0e5ec] px-2 py-1.5 align-middle text-xs text-[var(--text)] transition-colors select-none',
    props.className ?? '',
    props.isSelected ? 'in-range bg-[#e8f1ff]' : '',
    props.isActive ? 'active-anchor relative z-[1] shadow-[inset_0_0_0_2px_#2f6fed]' : '',
    props.isFillPreview
      ? 'fill-preview bg-[#eef4ff] outline-1 outline-dashed outline-[#2f6fed]'
      : '',
    props.isEditing ? 'cell-editing bg-white p-0' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const editorCls =
    'h-full min-h-[28px] w-full rounded-none border-2 border-[#2f6fed] bg-white px-2 py-1 text-xs text-[var(--text)] outline-none';
  const sharedEdit = {
    value: props.editValue ?? '',
    onBlur: props.onEditBlur,
    onKeyDown: props.onEditKeyDown,
  };
  return (
    <td
      className={cls || undefined}
      data-grid-cell-editing={props.isEditing ? '1' : undefined}
      role={props.role}
      title={props.title}
      onMouseDown={props.onMouseDown}
      onMouseEnter={props.onMouseEnter}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
    >
      {props.isEditing ? (
        props.editorKind === 'select' || props.selectOptions ? (
          <select
            ref={props.editSelectRef}
            className={editorCls}
            {...sharedEdit}
            onChange={(e) => props.onEditChange?.(e.target.value)}
          >
            {(props.selectOptions ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : props.editorKind === 'input' ? (
          <input
            autoFocus
            className={editorCls}
            {...sharedEdit}
            onChange={(e) => props.onEditChange?.(e.target.value)}
          />
        ) : (
          <textarea
            ref={props.editInputRef}
            className="block min-h-[28px] w-full resize-none overflow-hidden rounded-none border-2 border-[#2f6fed] bg-white px-2 py-1 text-xs leading-snug text-[var(--text)] outline-none"
            rows={1}
            {...sharedEdit}
            onChange={(e) => {
              syncTextareaHeight(e.currentTarget);
              props.onEditChange?.(e.target.value);
            }}
          />
        )
      ) : props.children !== undefined ? (
        props.children
      ) : (
        <div
          className={
            props.displayClassName ??
            'resource-cell-value flex min-h-[20px] items-center justify-between gap-1.5 whitespace-pre-wrap break-words'
          }
        >
          <span className={props.valueText ? undefined : 'text-[var(--text-3)]'}>
            {props.valueText || props.placeholder || ''}
          </span>
          {props.showArrow ? (
            <span className="cell-arrow shrink-0 text-[10px] text-[var(--text-3)]">▾</span>
          ) : null}
        </div>
      )}
      {props.showFillHandle && props.onFillMouseDown ? (
        <div
          className="fill-handle absolute -right-1 -bottom-1 z-[3] h-2 w-2 cursor-crosshair border border-white bg-[#2f6fed] shadow-2xs"
          title="向下拖拽填充"
          onMouseDown={props.onFillMouseDown}
        />
      ) : null}
    </td>
  );
}
