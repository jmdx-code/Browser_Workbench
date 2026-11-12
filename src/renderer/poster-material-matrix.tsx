import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  createEmptyMaterialDraft,
  fillPosterMaterialFiles,
  formatPosterCellsForClipboard,
  pastePosterMaterialCells,
  posterCellValue,
  toMaterialDraft,
  type MaterialDraft,
} from '../domain/poster-material-table.js';
import { hasPosterMaterialContent } from '../shared/group-poster.js';
import { mediaReference } from '../domain/resource-table.js';
import { copyTextToClipboard } from './clipboard.js';
import {
  PosterMaterialContextMenu,
  PosterMediaPreviewModal,
  type PosterContextMenuState,
} from './modules/poster-material-modals.js';
import {
  DEFAULT_POSTER_COL_WIDTHS,
  loadPosterColWidths,
  PosterMaterialThumbnailCell,
  posterRowBadge,
  savePosterColWidths,
  useSerialVideoThumbnailGenerator,
  type PosterResizableColKey,
} from './modules/poster-material-thumbnail-cell.js';

export {
  createEmptyMaterialDraft,
  fillPosterMaterialFiles,
  formatPosterCellsForClipboard,
  pastePosterMaterialCells,
  posterCellValue,
  toMaterialDraft,
  type MaterialDraft,
};

export interface PosterMaterialMatrixHandle {
  commitPendingEdit(): MaterialDraft[];
  isEditing(): boolean;
}

export function PosterMaterialMatrix({
  rows,
  onChange,
  onSave,
  onDeleteSelected,
  dirty,
  busy,
  isFullscreen = false,
  onToggleFullscreen,
  onError,
  onThumbnailSaved,
  persistedIds,
  pauseThumbnailGeneration,
  ref,
}: {
  rows: MaterialDraft[];
  onChange: (next: MaterialDraft[]) => void;
  onSave: (itemsToSave: MaterialDraft[]) => Promise<unknown>;
  onDeleteSelected?: ((ids: string[]) => void) | undefined;
  dirty: boolean;
  busy: boolean;
  isFullscreen?: boolean | undefined;
  onToggleFullscreen?: (() => void) | undefined;
  onError?: ((msg: string) => void) | undefined;
  onThumbnailSaved?: ((id: string) => void) | undefined;
  persistedIds?: ReadonlySet<string> | undefined;
  pauseThumbnailGeneration?: boolean | undefined;
  ref?: Ref<PosterMaterialMatrixHandle> | undefined;
}) {
  const [undo, setUndo] = useState<MaterialDraft[][]>([]);
  const [redo, setRedo] = useState<MaterialDraft[][]>([]);
  const [range, setRange] = useState({ r1: 0, c1: 0, r2: 0, c2: 0 });
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const editingRef = useRef<typeof editing>(null);
  const [query, setQuery] = useState('');
  const [localError, setLocalError] = useState('');
  const [colWidths, setColWidths] = useState<Record<PosterResizableColKey, number>>(() =>
    loadPosterColWidths(),
  );
  const [contextMenu, setContextMenu] = useState<PosterContextMenuState | null>(null);
  const [previewRow, setPreviewRow] = useState<MaterialDraft | null>(null);

  const grid = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const drag = useRef<'cells' | 'rows' | 'fill' | null>(null);
  const anchor = useRef({ r: 0, c: 0 });
  const fillTarget = useRef(0);
  const finishDrag = useRef(() => {});
  const resizingRef = useRef<{
    col: PosterResizableColKey;
    startX: number;
    startWidth: number;
  } | null>(null);

  const effectiveRows = rows.length > 0 ? rows : [createEmptyMaterialDraft()];
  const bounds = {
    minRow: Math.min(range.r1, range.r2, Math.max(0, effectiveRows.length - 1)),
    maxRow: Math.min(
      range.r1 === range.r2 ? range.r1 : Math.max(range.r1, range.r2),
      Math.max(0, effectiveRows.length - 1),
    ),
    minCol: Math.min(range.c1, range.c2),
    maxCol: Math.min(3, Math.max(range.c1, range.c2)),
  };
  const selectedRangeIds = new Set(
    effectiveRows.slice(bounds.minRow, bounds.maxRow + 1).map((r) => r.id),
  );
  const activeCheckedIds = new Set(
    effectiveRows.filter((r) => checkedIds.has(r.id)).map((r) => r.id),
  );
  const targetBatchIds = activeCheckedIds.size > 0 ? activeCheckedIds : selectedRangeIds;

  const handleVideoThumbSaved = useCallback(
    (id: string) => {
      onThumbnailSaved?.(id);
    },
    [onThumbnailSaved],
  );
  useSerialVideoThumbnailGenerator(effectiveRows, handleVideoThumbSaved, {
    persistedIds,
    paused: pauseThumbnailGeneration,
  });

  useEffect(() => {
    const up = () => {
      finishDrag.current();
      resizingRef.current = null;
    };
    const move = (e: PointerEvent) => {
      const activeResize = resizingRef.current;
      if (!activeResize) return;
      const nextW = Math.max(
        72,
        Math.min(900, Math.round(activeResize.startWidth + (e.clientX - activeResize.startX))),
      );
      setColWidths((prev) => {
        const updated = { ...prev, [activeResize.col]: nextW };
        savePosterColWidths(updated);
        window.dispatchEvent(new CustomEvent('wb:poster-col-widths'));
        return updated;
      });
    };
    const syncColWidths = () => setColWidths(loadPosterColWidths());
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('wb:poster-col-widths', syncColWidths);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('wb:poster-col-widths', syncColWidths);
    };
  }, []);

  const createId = () => globalThis.crypto.randomUUID();
  const quoteCell = (value: string) => '"' + value.replace(/"/g, '""') + '"';

  function reportError(msg: string) {
    setLocalError(msg);
    onError?.(msg);
  }

  function applyEdit(next: MaterialDraft[], remember = true) {
    if (remember) {
      setUndo((history) => [...history.slice(-19), effectiveRows]);
      setRedo([]);
    }
    setLocalError('');
    onChange(next.length > 0 ? next : [createEmptyMaterialDraft(createId())]);
  }

  function preparedRows(): MaterialDraft[] {
    const e = editingRef.current;
    if (!e) return effectiveRows;
    return pastePosterMaterialCells(
      effectiveRows,
      e.r,
      e.c,
      quoteCell(e.value),
      createId,
      e.r,
      e.c,
    );
  }

  function commitPendingEdit(): MaterialDraft[] {
    const e = editingRef.current;
    if (!e) return effectiveRows;
    try {
      const next = preparedRows();
      editingRef.current = null;
      setEditing(null);
      applyEdit(next);
      return next;
    } catch (failure) {
      reportError(failure instanceof Error ? failure.message : '单元格格式不正确');
      return effectiveRows;
    }
  }

  useImperativeHandle(ref, () => ({
    commitPendingEdit,
    isEditing: () => editingRef.current !== null,
  }));

  function attempt(work: () => MaterialDraft[]) {
    try {
      const next = work();
      editingRef.current = null;
      setEditing(null);
      applyEdit(next);
    } catch (failure) {
      reportError(failure instanceof Error ? failure.message : '本次修改未生效');
    }
  }

  function undoEdit() {
    const previous = undo.at(-1);
    if (previous) {
      setUndo((h) => h.slice(0, -1));
      setRedo((r) => [...r.slice(-19), effectiveRows]);
      editingRef.current = null;
      setEditing(null);
      applyEdit(previous, false);
    }
  }

  function redoEdit() {
    const nextState = redo.at(-1);
    if (nextState) {
      setRedo((r) => r.slice(0, -1));
      setUndo((h) => [...h.slice(-19), effectiveRows]);
      editingRef.current = null;
      setEditing(null);
      applyEdit(nextState, false);
    }
  }

  function startEdit(r: number, c: number, initialValue?: string) {
    if (busy) return;
    const row = effectiveRows[r];
    if (!row) return;
    if (c === 2 && row.mediaSource.trim().length > 0) return;
    const next = { r, c, value: initialValue ?? posterCellValue(row, c) };
    editingRef.current = next;
    setEditing(next);
  }

  function commitEditAndAdvance(dr = 0, dc = 0) {
    const currentEdit = editingRef.current;
    const baseRow = currentEdit ? currentEdit.r : range.r1;
    const baseCol = currentEdit ? currentEdit.c : range.c1;
    let nextRows = commitPendingEdit();
    let targetRow = baseRow + dr;
    let targetCol = baseCol + dc;
    if (dc !== 0) {
      if (targetCol > 3) {
        targetCol = 0;
        targetRow += 1;
      } else if (targetCol < 0) {
        targetCol = 3;
        targetRow = Math.max(0, targetRow - 1);
      }
    }
    if (targetRow >= nextRows.length && nextRows.length < 500) {
      nextRows = [...nextRows, createEmptyMaterialDraft(createId())];
      applyEdit(nextRows);
    }
    const clampedRow = Math.max(0, Math.min(nextRows.length - 1, targetRow));
    const clampedCol = Math.max(0, Math.min(3, targetCol));
    setRange({ r1: clampedRow, c1: clampedCol, r2: clampedRow, c2: clampedCol });
    requestAnimationFrame(() => {
      grid.current?.focus();
      grid.current
        ?.querySelector(`[data-r="${clampedRow}"][data-c="${clampedCol}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function pasteText(text: string) {
    if (!text) return;
    attempt(() =>
      pastePosterMaterialCells(
        preparedRows(),
        bounds.minRow,
        bounds.minCol,
        text,
        createId,
        bounds.maxRow,
        bounds.maxCol,
      ),
    );
  }

  function pasteAppendAtEnd(text: string) {
    if (!text) return;
    attempt(() => {
      const current = preparedRows();
      let startIdx = current.length;
      while (
        startIdx > 0 &&
        !hasPosterMaterialContent(current[startIdx - 1] ?? { caption: '', mediaSource: '' })
      ) {
        startIdx--;
      }
      const next = pastePosterMaterialCells(current, startIdx, 0, text, createId, startIdx, 0);
      setRange({ r1: startIdx, c1: 0, r2: Math.max(startIdx, next.length - 1), c2: 0 });
      requestAnimationFrame(() => {
        grid.current?.focus();
        grid.current
          ?.querySelector(`[data-r="${startIdx}"][data-c="0"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      return next;
    });
  }

  function paste(event: React.ClipboardEvent) {
    if (editingRef.current || busy) return;
    event.preventDefault();
    pasteText(event.clipboardData.getData('text/plain'));
  }

  function copy(event: React.ClipboardEvent) {
    if (editingRef.current) return;
    if (!effectiveRows.length) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.clipboardData.setData(
      'text/plain',
      formatPosterCellsForClipboard(
        preparedRows(),
        bounds.minRow,
        bounds.maxRow,
        bounds.minCol,
        bounds.maxCol,
      ),
    );
  }

  function copySelectionToClipboard() {
    const current = commitPendingEdit();
    void copyTextToClipboard(
      formatPosterCellsForClipboard(
        current,
        bounds.minRow,
        bounds.maxRow,
        bounds.minCol,
        bounds.maxCol,
      ),
    ).catch(() => reportError('复制失败，请框选后按 Ctrl/Cmd+C'));
  }

  function clearRange() {
    attempt(() => {
      const next = structuredClone(preparedRows());
      for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
        const target = next[r];
        if (!target) continue;
        for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
          if (c === 0) {
            target.caption = '';
          } else if (c === 1) {
            target.mediaSource = '';
            target.localFilePath = null;
            target.mediaKind = 'none';
            target.cacheStatus = 'ready';
            target.cacheError = null;
            target.hasThumbnail = false;
          } else if (c === 2) {
            target.background = 'plain';
          } else if (c === 3) {
            target.aiLabel = 'default';
          }
        }
        if (target.mediaSource.trim().length > 0) {
          target.background = 'plain';
        }
      }
      return next;
    });
  }

  function deleteTargetRows(idsToRemove = targetBatchIds) {
    const current = commitPendingEdit();
    const removedIds = current.filter((r) => idsToRemove.has(r.id)).map((r) => r.id);
    const remaining = current.filter((r) => !idsToRemove.has(r.id));
    applyEdit(remaining.length > 0 ? remaining : [createEmptyMaterialDraft(createId())]);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const id of removedIds) next.delete(id);
      return next;
    });
    const nextRow = Math.max(0, Math.min(bounds.minRow, remaining.length - 1));
    setRange({ r1: nextRow, c1: 0, r2: nextRow, c2: 0 });
    if (removedIds.length > 0) {
      onDeleteSelected?.(removedIds);
    }
  }

  function insertRowAt(index: number) {
    if (busy || effectiveRows.length >= 500) return;
    const current = commitPendingEdit();
    const clamped = Math.max(0, Math.min(current.length, index));
    const next = [
      ...current.slice(0, clamped),
      createEmptyMaterialDraft(createId()),
      ...current.slice(clamped),
    ];
    applyEdit(next);
    setRange({ r1: clamped, c1: 0, r2: clamped, c2: 0 });
  }

  function appendRowsAtEnd(count = 1) {
    if (busy || effectiveRows.length >= 500) return;
    const current = commitPendingEdit();
    const allowed = Math.max(1, Math.min(count, 500 - current.length));
    const added = Array.from({ length: allowed }, () => createEmptyMaterialDraft(createId()));
    const firstNewIdx = current.length;
    const next = [...current, ...added];
    applyEdit(next);
    setRange({ r1: firstNewIdx, c1: 0, r2: firstNewIdx, c2: 0 });
    requestAnimationFrame(() => {
      grid.current?.focus();
      grid.current
        ?.querySelector(`[data-r="${firstNewIdx}"][data-c="0"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function toggleRangeSelection(checked?: boolean) {
    const current = preparedRows();
    const rangeIds = [...selectedRangeIds];
    const targetChecked = checked ?? !rangeIds.every((id) => checkedIds.has(id));
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const id of rangeIds) {
        if (targetChecked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    void current;
  }

  function beginRange(r: number, c: number, shift: boolean, kind: 'cells' | 'rows' = 'cells') {
    if (busy) return;
    if (editingRef.current) commitPendingEdit();
    grid.current?.focus();
    drag.current = kind;
    if (!shift) anchor.current = { r, c };
    const from = shift ? { r: range.r1, c: range.c1 } : anchor.current;
    anchor.current = from;
    setRange({
      r1: from.r,
      c1: kind === 'rows' ? 0 : from.c,
      r2: r,
      c2: kind === 'rows' ? 3 : c,
    });
  }

  function extendRange(r: number, c: number) {
    if (drag.current === 'fill') {
      fillTarget.current = r;
      setRange({ ...range, r2: Math.max(r, bounds.maxRow) });
    } else if (drag.current) {
      setRange({
        r1: anchor.current.r,
        c1: drag.current === 'rows' ? 0 : anchor.current.c,
        r2: r,
        c2: drag.current === 'rows' ? 3 : c,
      });
    }
  }

  finishDrag.current = () => {
    if (busy) {
      drag.current = null;
      return;
    }
    if (drag.current === 'fill') {
      const end = fillTarget.current;
      const first = effectiveRows[bounds.minRow];
      if (first && end > bounds.minRow) {
        attempt(() => {
          const next = structuredClone(preparedRows());
          for (let r = bounds.minRow + 1; r <= end; r++) {
            const target = next[r];
            if (!target) continue;
            for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
              if (c === 0) {
                target.caption = first.caption;
              } else if (c === 1) {
                if (target.mediaSource !== first.mediaSource) {
                  target.mediaSource = first.mediaSource;
                  target.localFilePath = first.localFilePath;
                  target.mediaKind = first.mediaKind;
                  target.cacheStatus = first.cacheStatus;
                  target.cacheError = first.cacheError;
                  target.hasThumbnail = first.hasThumbnail;
                }
              } else if (c === 2) {
                target.background = first.background;
              } else if (c === 3) {
                target.aiLabel = first.aiLabel;
              }
            }
            if (target.mediaSource.trim().length > 0) {
              target.background = 'plain';
            }
          }
          return next;
        });
      }
    }
    drag.current = null;
  };

  function gridKeys(event: React.KeyboardEvent) {
    if (editingRef.current || busy || !effectiveRows.length) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey;
    const keyLower = event.key.toLowerCase();
    if (mod && keyLower === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoEdit();
      else undoEdit();
      return;
    }
    if (mod && keyLower === 'y') {
      event.preventDefault();
      redoEdit();
      return;
    }
    if (mod && keyLower === 'x') {
      event.preventDefault();
      copySelectionToClipboard();
      clearRange();
      return;
    }
    if (['Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault();
      clearRange();
      return;
    }
    if (event.key === 'F2') {
      event.preventDefault();
      startEdit(range.r1, range.c1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        startEdit(range.r1, range.c1);
      } else {
        commitEditAndAdvance(1, 0);
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      commitEditAndAdvance(0, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      toggleRangeSelection();
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const movement = delta[event.key];
    if (movement) {
      event.preventDefault();
      const [dr, dc] = movement;
      const r = Math.max(
        0,
        Math.min(effectiveRows.length - 1, (event.shiftKey ? range.r2 : range.r1) + dr),
      );
      const c = Math.max(0, Math.min(3, (event.shiftKey ? range.c2 : range.c1) + dc));
      setRange(event.shiftKey ? { ...range, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c });
      grid.current
        ?.querySelector(`[data-r="${r}"][data-c="${c}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (event.key.length === 1 && !mod && !event.altKey) {
      event.preventDefault();
      startEdit(range.r1, range.c1, event.key);
    }
  }

  function addFiles(list: FileList | null, targetRow?: number) {
    if (!list?.length) return;
    attempt(() => {
      const desktop = window.workbenchDesktop;
      const sources = Array.from(list).map((file) => {
        const source =
          desktop?.materialFilePath(file) || ((file as File & { path?: string }).path ?? '').trim();
        if (!source) {
          throw Error(
            '完整本机文件路径仅桌面端可用；或在 B 列粘贴本机绝对路径 / Google Drive 链接',
          );
        }
        return mediaReference(source).source;
      });
      const current = preparedRows();
      if (targetRow !== undefined) {
        return pastePosterMaterialCells(
          current,
          targetRow,
          1,
          sources.map((s) => quoteCell(s)).join('\n'),
          createId,
        );
      }
      const firstEmpty = current.findIndex((r) => !r.mediaSource.trim());
      return fillPosterMaterialFiles(
        current,
        firstEmpty < 0 ? current.length : firstEmpty,
        sources,
        createId,
      );
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const entries = effectiveRows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => {
      if (!normalizedQuery) return true;
      return (
        String(index + 1).includes(normalizedQuery) ||
        row.caption.toLowerCase().includes(normalizedQuery) ||
        row.mediaSource.toLowerCase().includes(normalizedQuery)
      );
    });

  function renderResizeHandle(colKey: PosterResizableColKey) {
    return (
      <span
        className="poster-col-resizer"
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整列宽，双击恢复默认宽度"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resizingRef.current = {
            col: colKey,
            startX: e.clientX,
            startWidth: colWidths[colKey],
          };
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setColWidths((prev) => {
            const reset = { ...prev, [colKey]: DEFAULT_POSTER_COL_WIDTHS[colKey] };
            savePosterColWidths(reset);
            return reset;
          });
        }}
      />
    );
  }

  return (
    <div
      className={'poster-material-matrix-wrap' + (isFullscreen ? ' is-fullscreen' : '')}
      style={{ position: 'relative' }}
    >
      <div className="resource-toolbar resource-main-toolbar poster-matrix-toolbar poster-compact-toolbar">
        <div className="resource-toolbar-actions">
          <button
            type="button"
            disabled={busy || effectiveRows.length >= 500}
            onClick={() => appendRowsAtEnd(1)}
            title="在表格末尾新增 1 行空行"
          >
            ＋ 新增一行
          </button>
          <button
            type="button"
            disabled={busy || effectiveRows.length >= 500}
            onClick={() => appendRowsAtEnd(10)}
            title="在表格末尾批量新增 10 行空行，方便批量粘贴或填写"
          >
            ＋ 批量新增 10 行
          </button>
          <button
            type="button"
            disabled={busy || effectiveRows.length >= 500}
            onClick={() => {
              void navigator.clipboard
                ?.readText()
                .then((text) => {
                  if (!text.trim()) {
                    reportError('剪贴板为空，请先复制文案或 Excel 表格内容');
                    return;
                  }
                  pasteAppendAtEnd(text);
                })
                .catch(() => reportError('请点击目标单元格后按 Ctrl/Cmd+V 粘贴'));
            }}
            title="读取剪贴板中的多行文案或 Excel 内容，自动追加到表格末尾新行"
          >
            📋 粘贴追加新行
          </button>
          <button type="button" disabled={busy} onClick={() => filesInput.current?.click()}>
            ＋ 添加本机图片/视频
          </button>
          <button type="button" disabled={busy || !undo.length} onClick={undoEdit}>
            撤销 (Ctrl+Z)
          </button>
          <input
            ref={filesInput}
            type="file"
            accept=".mp4,.mov,.png,.jpg,.jpeg,.webp"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        <div className="resource-toolbar-actions resource-search">
          <input
            aria-label="搜索发帖素材"
            placeholder="搜索文案、媒体或行号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="一键填充选区选项"
            value=""
            disabled={busy}
            onChange={(e) => {
              const [column, value] = e.target.value.split(':');
              if (!column || !value) return;
              const colNum = Number(column);
              attempt(() => {
                const current = structuredClone(preparedRows());
                for (const row of current) {
                  if (!targetBatchIds.has(row.id)) continue;
                  if (colNum === 2) {
                    row.background = row.mediaSource.trim()
                      ? 'plain'
                      : value === 'color'
                        ? 'color'
                        : 'plain';
                  } else if (colNum === 3) {
                    row.aiLabel = value === 'on' ? 'on' : value === 'off' ? 'off' : 'default';
                  }
                }
                return current;
              });
            }}
          >
            <option value="">
              批量设置（
              {activeCheckedIds.size > 0
                ? `已勾选 ${activeCheckedIds.size} 行`
                : `选区 ${selectedRangeIds.size} 行`}
              ）…
            </option>
            <optgroup label="C列 · 文字背景">
              <option value="2:color">设为：彩贴</option>
              <option value="2:plain">设为：普通文字</option>
            </optgroup>
            <optgroup label="D列 · AI 声明标签">
              <option value="3:default">AI 声明：默认</option>
              <option value="3:on">AI 声明：开启</option>
              <option value="3:off">AI 声明：关闭</option>
            </optgroup>
          </select>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || targetBatchIds.size === 0}
            onClick={() => deleteTargetRows(targetBatchIds)}
            title="删除勾选的行或当前框选的行"
          >
            删除
            {activeCheckedIds.size > 0
              ? `已勾选 (${activeCheckedIds.size})`
              : `所选行 (${selectedRangeIds.size})`}
          </button>
          {onToggleFullscreen && (
            <button type="button" onClick={onToggleFullscreen}>
              {isFullscreen ? '退出全屏' : '全屏编辑'}
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => {
              const latest = commitPendingEdit();
              void onSave(latest);
            }}
          >
            {busy ? '保存中…' : dirty ? '保存素材 *' : '保存素材'}
          </button>
        </div>
      </div>

      {localError && (
        <p className="resource-error" role="alert">
          {localError}
        </p>
      )}

      <div
        className="resource-grid-scroll poster-grid-scroll"
        ref={grid}
        tabIndex={0}
        onKeyDown={gridKeys}
        onPaste={paste}
        onCopy={copy}
        aria-label="小组发帖素材矩阵"
      >
        <table
          className="resource-grid resource-matrix poster-material-matrix"
          role="grid"
          aria-rowcount={effectiveRows.length + 1}
          aria-colcount={8}
          style={{ tableLayout: 'fixed' }}
        >
          <colgroup>
            <col style={{ width: 40 }} />
            <col style={{ width: 44 }} />
            <col style={{ width: colWidths.thumb }} />
            <col style={{ width: colWidths.caption }} />
            <col style={{ width: colWidths.media }} />
            <col style={{ width: colWidths.background }} />
            <col style={{ width: colWidths.aiLabel }} />
            <col style={{ width: colWidths.status }} />
          </colgroup>
          <thead>
            <tr>
              <th className="poster-check-col">
                <input
                  type="checkbox"
                  aria-label="全选发帖素材"
                  checked={entries.length > 0 && entries.every(({ row }) => checkedIds.has(row.id))}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setCheckedIds((prev) => {
                      const next = new Set(prev);
                      for (const { row } of entries) {
                        if (checked) next.add(row.id);
                        else next.delete(row.id);
                      }
                      return next;
                    });
                  }}
                />
              </th>
              <th className="poster-num-col">
                <button
                  type="button"
                  aria-label="选择整表"
                  onClick={() =>
                    setRange({
                      r1: 0,
                      c1: 0,
                      r2: Math.max(0, effectiveRows.length - 1),
                      c2: 3,
                    })
                  }
                >
                  #
                </button>
              </th>
              <th className="poster-thumb-col" style={{ position: 'relative' }}>
                <span>缩略图</span>
                {renderResizeHandle('thumb')}
              </th>
              {(
                [
                  ['A · 发帖文案', 'caption', 0],
                  ['B · 本机媒体 / 网盘链接', 'media', 1],
                  ['C · 文字背景', 'background', 2],
                  ['D · AI 声明', 'aiLabel', 3],
                ] as const
              ).map(([title, colKey, c]) => (
                <th key={title} style={{ position: 'relative' }}>
                  <button
                    type="button"
                    onClick={() =>
                      setRange({
                        r1: 0,
                        c1: c,
                        r2: Math.max(0, effectiveRows.length - 1),
                        c2: c,
                      })
                    }
                  >
                    {title}
                  </button>
                  {renderResizeHandle(colKey)}
                </th>
              ))}
              <th style={{ position: 'relative' }}>
                <span>状态 / 统计</span>
                {renderResizeHandle('status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ row, index: r }) => {
              const badge = posterRowBadge(row);
              const isRowChecked = checkedIds.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={isRowChecked ? 'is-selected-row' : ''}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (r < bounds.minRow || r > bounds.maxRow) {
                      setRange({ r1: r, c1: 0, r2: r, c2: 3 });
                    }
                    setContextMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  <td className="poster-check-col">
                    <input
                      type="checkbox"
                      aria-label={`勾选素材#${r + 1}`}
                      checked={isRowChecked}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setCheckedIds((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <th
                    className="resource-row-number"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      beginRange(r, 0, e.shiftKey, 'rows');
                    }}
                    onPointerEnter={() => extendRange(r, 3)}
                  >
                    {r + 1}
                  </th>
                  <td className="poster-thumb-cell" style={{ textAlign: 'center' }}>
                    <PosterMaterialThumbnailCell row={row} onPreview={setPreviewRow} />
                  </td>
                  {[0, 1, 2, 3].map((c) => {
                    const inRange =
                      r >= bounds.minRow &&
                      r <= bounds.maxRow &&
                      c >= bounds.minCol &&
                      c <= bounds.maxCol;
                    const active = r === range.r1 && c === range.c1;
                    const isEditing = editing?.r === r && editing.c === c;
                    const hasMedia = row.mediaSource.trim().length > 0;
                    return (
                      <td
                        key={c}
                        data-r={r}
                        data-c={c}
                        role="gridcell"
                        aria-selected={inRange}
                        className={`${inRange ? 'in-range ' : ''}${active ? 'active-anchor ' : ''}${isEditing ? 'editing-cell' : ''}`}
                        onPointerDown={(e) => {
                          if (isEditing || e.button !== 0) return;
                          e.preventDefault();
                          beginRange(r, c, e.shiftKey);
                        }}
                        onPointerEnter={() => extendRange(r, c)}
                        onDoubleClick={() => startEdit(r, c)}
                        onDragOver={(e) => {
                          if (c === 1) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          if (c === 1) {
                            e.preventDefault();
                            addFiles(e.dataTransfer.files, r);
                          }
                        }}
                      >
                        {isEditing ? (
                          c < 2 ? (
                            <textarea
                              autoFocus
                              aria-label={
                                c === 0 ? `素材#${r + 1}文案` : `素材#${r + 1}媒体链接或路径`
                              }
                              value={editing.value}
                              onChange={(e) => {
                                const next = { ...editing, value: e.target.value };
                                editingRef.current = next;
                                setEditing(next);
                              }}
                              onPaste={(e) => {
                                const text = e.clipboardData.getData('text/plain');
                                const html = e.clipboardData.getData('text/html');
                                if (
                                  text.includes('\t') ||
                                  html.includes('<table') ||
                                  (c === 1 && text.includes('\n'))
                                ) {
                                  e.preventDefault();
                                  editingRef.current = null;
                                  setEditing(null);
                                  attempt(() =>
                                    pastePosterMaterialCells(
                                      effectiveRows,
                                      r,
                                      c,
                                      text,
                                      createId,
                                      r,
                                      c,
                                    ),
                                  );
                                }
                              }}
                              onBlur={() => commitPendingEdit()}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  commitEditAndAdvance(1, 0);
                                } else if (e.key === 'Tab') {
                                  e.preventDefault();
                                  commitEditAndAdvance(0, e.shiftKey ? -1 : 1);
                                } else if (e.key === 'Escape') {
                                  editingRef.current = null;
                                  setEditing(null);
                                  grid.current?.focus();
                                }
                              }}
                            />
                          ) : (
                            <select
                              autoFocus
                              aria-label={c === 2 ? `素材#${r + 1}文字背景` : `素材#${r + 1}AI声明`}
                              value={editing.value}
                              onChange={(e) => {
                                editingRef.current = { ...editing, value: e.target.value };
                                commitPendingEdit();
                                grid.current?.focus();
                              }}
                              onBlur={() => commitPendingEdit()}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Escape') {
                                  editingRef.current = null;
                                  setEditing(null);
                                } else if (e.key === 'Enter') {
                                  e.preventDefault();
                                  commitEditAndAdvance(1, 0);
                                } else if (e.key === 'Tab') {
                                  e.preventDefault();
                                  commitEditAndAdvance(0, e.shiftKey ? -1 : 1);
                                }
                              }}
                            >
                              {(c === 2 ? ['彩贴', '普通文字'] : ['默认', '开启', '关闭']).map(
                                (v) => (
                                  <option key={v} value={v}>
                                    {v}
                                  </option>
                                ),
                              )}
                            </select>
                          )
                        ) : (
                          <>
                            <span
                              className={`resource-cell-value${c === 2 && hasMedia ? ' media-background-readonly' : ''}`}
                              title={posterCellValue(row, c)}
                            >
                              {posterCellValue(row, c) || '\u00a0'}
                            </span>
                            {(c === 3 || (c === 2 && !hasMedia)) && (
                              <button
                                type="button"
                                className="cell-arrow"
                                aria-label={`编辑${String.fromCharCode(65 + c)}${r + 1}`}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRange({ r1: r, c1: c, r2: r, c2: c });
                                  startEdit(r, c);
                                }}
                              >
                                ▾
                              </button>
                            )}
                          </>
                        )}
                        {!editing && r === bounds.maxRow && c === bounds.maxCol && (
                          <span
                            className="fill-handle"
                            aria-label="向下填充选区"
                            onPointerDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              drag.current = 'fill';
                              fillTarget.current = bounds.maxRow;
                            }}
                          />
                        )}
                      </td>
                    );
                  })}
                  <td className="resource-status poster-row-status">
                    <span className={'poster-cache-badge ' + badge.cls} title={badge.title}>
                      {badge.text}
                    </span>
                    <small className="poster-used-count">已发 {row.usedCount} 次</small>
                    {row.cacheError && (
                      <small className="poster-cell-error" title={row.cacheError}>
                        {row.cacheError}
                      </small>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        className="poster-floating-add-row-btn"
        aria-label="新增一行"
        title="在表格末尾新增一行"
        disabled={busy || effectiveRows.length >= 500}
        onClick={() => appendRowsAtEnd(1)}
      >
        ＋
      </button>

      <PosterMaterialContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onInsertAbove={() => insertRowAt(bounds.minRow)}
        onInsertBelow={() => insertRowAt(bounds.maxRow + 1)}
        onToggleSelected={(checked) => toggleRangeSelection(checked)}
        onCopy={copySelectionToClipboard}
        onPaste={() => {
          void navigator.clipboard
            ?.readText()
            .then((text) => pasteText(text))
            .catch(() => reportError('请直接按 Ctrl/Cmd+V 粘贴'));
        }}
        onClearRange={clearRange}
        onDeleteRows={() => deleteTargetRows(selectedRangeIds)}
      />

      <PosterMediaPreviewModal row={previewRow} onClose={() => setPreviewRow(null)} />
    </div>
  );
}
