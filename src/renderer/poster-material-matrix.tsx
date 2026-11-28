import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type Ref,
} from 'react';
import {
  createEmptyMaterialDraft,
  fillPosterMaterialFiles,
  formatPosterCellsForClipboard,
  pastePosterMaterialCells,
  posterCellValue,
  toMaterialDraft,
  type MaterialDraft,
} from '../domain/poster-material-table.js';
import {
  computeGridBounds,
  expandFillDownTsv,
  getSelectedRowIndices,
  isCellInGridBounds,
  isRowInGridBounds,
  MatrixDataCell,
  parseElectronFilePaths,
  useSpreadsheetGrid,
} from './matrix-grid.js';
import {
  PosterMaterialThumbnailCell,
  PosterMediaPreviewModal,
  posterRowBadge,
  useSerialVideoThumbnailGenerator,
} from './modules/poster-material-modals.js';
import { Btn, errMsg } from './modules/shared/module-ui.js';
import { startHorizontalDrag, UI_CHECKBOX } from './ui/primitives.js';
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
type ColKey = 'thumb' | 'caption' | 'media' | 'background' | 'aiLabel' | 'status';
const COL_WIDTHS_KEY = 'wb_poster_material_col_widths_v1';
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  thumb: 136,
  caption: 280,
  media: 220,
  background: 112,
  aiLabel: 100,
  status: 132,
};
const loadWidths = (): Record<ColKey, number> => {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(COL_WIDTHS_KEY) || '{}') as Partial<
      Record<ColKey, unknown>
    >;
    const next = { ...DEFAULT_WIDTHS };
    for (const k of Object.keys(DEFAULT_WIDTHS) as ColKey[]) {
      const v = Number(parsed[k]);
      if (Number.isFinite(v) && v >= 72 && v <= 900) next[k] = Math.round(v);
    }
    return next;
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
};
const saveWidths = (w: Record<ColKey, number>) => {
  try {
    globalThis.localStorage?.setItem(COL_WIDTHS_KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
};
const optList = (vals: readonly string[]) => vals.map((v) => ({ value: v, label: v }));
const BG_OPTIONS = optList(['普通文字', '彩贴']);
const AI_OPTIONS = optList(['默认', '开启', '关闭']);
const COL_HEADERS: ReadonlyArray<[ColKey, string]> = [
  ['thumb', '缩略图'],
  ['caption', 'A 文案'],
  ['media', 'B 媒体路径/链接'],
  ['background', 'C 背景'],
  ['aiLabel', 'D AI 声明'],
  ['status', '状态'],
];
const createId = () => globalThis.crypto.randomUUID();
const isSelectCol = (col: number) => col === 2 || col === 3;
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
  onChange: (rows: MaterialDraft[]) => void;
  onSave: (rowsOverride?: MaterialDraft[]) => Promise<unknown> | void;
  onDeleteSelected: (ids: string[]) => Promise<unknown> | void;
  dirty: boolean;
  busy: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onError: (msg: string) => void;
  onThumbnailSaved: (id: string) => void;
  persistedIds?: ReadonlySet<string>;
  pauseThumbnailGeneration?: boolean | undefined;
  ref?: Ref<PosterMaterialMatrixHandle>;
}) {
  const [colWidths, setColWidths] = useState<Record<ColKey, number>>(loadWidths);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [previewRow, setPreviewRow] = useState<MaterialDraft | null>(null);
  const [filePickerRow, setFilePickerRow] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useSerialVideoThumbnailGenerator(rows, onThumbnailSaved, {
    persistedIds,
    paused: pauseThumbnailGeneration || busy,
  });
  const applySingleCellEdit = useCallback(
    (current: MaterialDraft[], rowIdx: number, col: number, value: string): MaterialDraft[] => {
      try {
        return pastePosterMaterialCells(current, rowIdx, col, value, createId, rowIdx, col);
      } catch (e) {
        onError(errMsg(e, '单元格输入无效'));
        return current;
      }
    },
    [onError],
  );
  const grid = useSpreadsheetGrid<MaterialDraft>({
    rows,
    colCount: 4,
    disabled: busy,
    onRowsChange: onChange,
    getCellValue: posterCellValue,
    applyCellEdit: applySingleCellEdit,
    isSelectCol,
    isEditableCell: (r, c) => !(c === 2 && rows[r]?.mediaSource.trim().length),
    copyRangeText: (cur, b) =>
      formatPosterCellsForClipboard(cur, b.minRow, b.maxRow, b.minCol, b.maxCol),
    fillDown: (cur, b, endRow) =>
      pastePosterMaterialCells(
        cur,
        b.maxRow + 1,
        b.minCol,
        expandFillDownTsv(cur, b, endRow, posterCellValue),
        createId,
        endRow,
        b.maxCol,
      ),
    pasteTsv: (cur, b, text) =>
      pastePosterMaterialCells(cur, b.minRow, b.minCol, text, createId, b.maxRow, b.maxCol),
    onError,
    createEmptyRow: () => createEmptyMaterialDraft(createId()),
  });
  useImperativeHandle(
    ref,
    () => ({ commitPendingEdit: () => grid.commitEdit(), isEditing: () => Boolean(grid.editing) }),
    [grid],
  );
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  const appendRows = (count: number) => {
    if (busy) return;
    if (rows.length + count > 500) return onError('最多支持 500 条素材');
    grid.commitRows(
      [...rows, ...Array.from({ length: count }, () => createEmptyMaterialDraft(createId()))],
      true,
    );
  };
  const insertRowRelative = (offset: number) => {
    if (busy || rows.length >= 500) return;
    const next = [...rows];
    next.splice(
      Math.max(0, (grid.bounds?.minRow ?? rows.length - 1) + offset),
      0,
      createEmptyMaterialDraft(createId()),
    );
    grid.commitRows(next, true);
  };
  const checkedIds = useMemo(() => rows.filter((r) => r.selected).map((r) => r.id), [rows]);
  const allChecked = rows.length > 0 && checkedIds.length === rows.length;
  const fillLocalFiles = (startRow: number, files: FileList | null) => {
    if (!files?.length || busy) return;
    const paths = parseElectronFilePaths(files);
    if (!paths.length) return onError('未能获取本地文件路径，请复制文件路径粘贴或拖入文件');
    try {
      grid.commitRows(fillPosterMaterialFiles(rows, startRow, paths, createId), true);
    } catch (e) {
      onError(errMsg(e, '填充本地媒体失败'));
    }
  };
  const dragHandlers = (startRow: number) => ({
    onDragOver: (e: ReactDragEvent) => e.dataTransfer.types.includes('Files') && e.preventDefault(),
    onDrop: (e: ReactDragEvent) => {
      if (!e.defaultPrevented && e.dataTransfer.files.length) {
        e.preventDefault();
        fillLocalFiles(startRow, e.dataTransfer.files);
      }
    },
  });
  const startResize = (key: ColKey, startX: number) => {
    const initial = colWidths[key] ?? DEFAULT_WIDTHS[key];
    startHorizontalDrag(startX, (dx) =>
      setColWidths((prev) => {
        const next = { ...prev, [key]: Math.max(72, Math.min(900, Math.round(initial + dx))) };
        saveWidths(next);
        return next;
      }),
    );
  };
  const toolbarButtons: ReadonlyArray<[string, () => void, boolean?, 'danger'?]> = [
    ['+ 添加一行', () => appendRows(1)],
    ['+5 行', () => appendRows(5)],
    [
      '选择本地媒体',
      () => {
        setFilePickerRow(grid.bounds?.minRow ?? 0);
        fileInputRef.current?.click();
      },
    ],
    [
      `删除勾选 (${checkedIds.length})`,
      () => void onDeleteSelected(checkedIds),
      busy || !checkedIds.length,
      'danger',
    ],
    ['清空选区', () => grid.clearBounds(grid.bounds), busy || !grid.bounds],
    ['撤销', grid.handleUndo, busy || !grid.canUndo],
    ['重做', grid.handleRedo, busy || !grid.canRedo],
  ];
  const toggleCheckedInRange = (checked: boolean) => {
    const indices = new Set(getSelectedRowIndices(grid.bounds, rows.length));
    if (indices.size)
      grid.commitRows(
        rows.map((r, i) => (indices.has(i) ? { ...r, selected: checked } : r)),
        true,
      );
  };
  const menuItems: Array<[string, () => void, boolean?]> = [
    ['上方插入 1 行', () => insertRowRelative(0)],
    ['下方插入 1 行', () => insertRowRelative(1)],
    ['勾选所涉行', () => toggleCheckedInRange(true)],
    ['取消勾选所涉行', () => toggleCheckedInRange(false)],
    [
      '复制',
      () => {
        const b = computeGridBounds(grid.selection);
        if (b) void grid.doCopy(b, false);
      },
    ],
    [
      '粘贴',
      () =>
        void navigator.clipboard.readText().then(
          (t) => t && grid.applyPastedText(t),
          () => onError('无法读取系统剪贴板，请直接按 Ctrl+V 粘贴'),
        ),
    ],
    ['清空选区', () => grid.clearBounds(grid.bounds)],
    [
      '删除所涉整行',
      () => {
        const indices = getSelectedRowIndices(grid.bounds, rows.length);
        if (!indices.length) return;
        const set = new Set(indices);
        const ids = indices.map((i) => rows[i]?.id).filter((x): x is string => Boolean(x));
        const kept = rows.filter((_, i) => !set.has(i));
        grid.commitRows(kept.length ? kept : [createEmptyMaterialDraft(createId())], true);
        if (ids.length) void onDeleteSelected(ids);
      },
      true,
    ],
  ];
  return (
    <div className="poster-matrix-shell relative flex min-h-0 flex-1 flex-col gap-2.5 p-4">
      <div className="poster-matrix-toolbar flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
        <div className="poster-matrix-toolbar-left flex flex-wrap items-center gap-1.5">
          {toolbarButtons.map(([label, onClick, dis, v]) => (
            <Btn key={label} v={v ?? 'default'} disabled={dis ?? busy} onClick={onClick}>
              {label}
            </Btn>
          ))}
        </div>
        <div className="poster-matrix-toolbar-right flex flex-wrap items-center gap-2">
          {dirty && (
            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
              有未保存修改
            </span>
          )}
          {onToggleFullscreen && (
            <Btn onClick={onToggleFullscreen}>{isFullscreen ? '退出全屏' : '放大表格'}</Btn>
          )}
          <Btn v="primary" disabled={busy} onClick={() => void onSave(grid.commitEdit())}>
            保存素材
          </Btn>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          fillLocalFiles(filePickerRow ?? 0, e.target.files);
          e.target.value = '';
        }}
      />
      <div
        ref={grid.wrapRef}
        className="poster-matrix-scroll relative min-h-0 flex-1 overflow-auto rounded-xl border border-[#e0e5ec] bg-white focus:outline-none"
        tabIndex={0}
        onKeyDown={grid.handleGridKeyDown}
        onPaste={grid.handlePaste}
        {...dragHandlers(rows.length)}
      >
        <table className="resource-matrix poster-matrix-table w-full border-collapse table-fixed text-xs">
          <thead>
            <tr>
              <th className="sticky top-0 z-[2] w-[68px] border border-[#e0e5ec] bg-slate-50 px-2 py-2 text-center text-[11px] font-semibold text-[var(--text-2)] select-none">
                <label className="poster-row-check-all inline-flex cursor-pointer items-center justify-center gap-1.5 text-[11px] font-semibold text-[var(--text-2)]">
                  <input
                    type="checkbox"
                    className={UI_CHECKBOX}
                    checked={allChecked}
                    aria-label="全选所有素材"
                    onChange={(e) =>
                      grid.commitRows(
                        rows.map((r) => ({ ...r, selected: e.target.checked })),
                        true,
                      )
                    }
                  />
                  <span>#</span>
                </label>
              </th>
              {COL_HEADERS.map(([key, label]) => (
                <th
                  key={key}
                  style={{ width: colWidths[key] }}
                  className="sticky top-0 z-[2] border border-[#e0e5ec] bg-slate-50 px-2 py-2 text-left text-[11px] font-semibold text-[var(--text-2)] select-none"
                >
                  <div className="poster-th-inner relative flex items-center justify-between gap-1 pr-2">
                    <span className="truncate">{label}</span>
                    <span
                      className="poster-col-resizer absolute top-0 -right-2 bottom-0 z-[3] w-2.5 cursor-col-resize select-none after:absolute after:inset-y-1 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:rounded-full after:bg-transparent hover:after:bg-[var(--brand)]"
                      role="separator"
                      aria-orientation="vertical"
                      title="拖拽调整列宽，双击恢复默认宽度"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startResize(key, e.clientX);
                      }}
                      onDoubleClick={() => {
                        const next = { ...colWidths, [key]: DEFAULT_WIDTHS[key] };
                        saveWidths(next);
                        setColWidths(next);
                      }}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => {
              const badge = posterRowBadge(row);
              const cols = [
                { col: 0, placeholder: '输入贴文文案' },
                {
                  col: 1,
                  placeholder: '拖入或粘贴图片/视频/Drive链接',
                  className:
                    row.cacheStatus === 'error'
                      ? 'max-w-[180px] overflow-hidden text-ellipsis text-[11px] text-[var(--err)]'
                      : '',
                },
                { col: 2, opts: BG_OPTIONS, placeholder: '普通文字' },
                { col: 3, opts: AI_OPTIONS, placeholder: '默认' },
              ] as const;
              return (
                <tr
                  key={row.id}
                  className={
                    isRowInGridBounds(grid.bounds, rIdx, 4)
                      ? 'row-selected bg-[#f3f7ff]'
                      : 'hover:bg-slate-50/50'
                  }
                  {...dragHandlers(rIdx)}
                >
                  <td
                    className="resource-row-number w-[68px] cursor-cell border border-[#e0e5ec] bg-[var(--surface-2)] px-2 py-1.5 text-center align-middle font-mono text-[11px] text-[var(--text-3)] select-none"
                    onMouseDown={(e) => grid.beginRowMouseDown(e, rIdx)}
                    onMouseEnter={() => grid.handleCellMouseEnter(rIdx, 0)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY });
                    }}
                  >
                    <div className="inline-flex items-center justify-center gap-1.5">
                      <input
                        type="checkbox"
                        className={UI_CHECKBOX}
                        checked={row.selected}
                        aria-label={`勾选第 ${rIdx + 1} 条素材`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          grid.commitRows(
                            rows.map((item, idx) =>
                              idx === rIdx ? { ...item, selected: e.target.checked } : item,
                            ),
                            true,
                          )
                        }
                      />
                      <span>{rIdx + 1}</span>
                    </div>
                  </td>
                  <td className="h-16 border border-[#e0e5ec] px-1.5 py-1 text-center align-middle">
                    <PosterMaterialThumbnailCell row={row} onPreview={setPreviewRow} />
                  </td>
                  {cols.map((c) => {
                    const isSel = isCellInGridBounds(grid.bounds, rIdx, c.col);
                    const opts = 'opts' in c ? c.opts : undefined;
                    return (
                      <MatrixDataCell
                        key={c.col}
                        {...grid.getCellProps(rIdx, c.col)}
                        className={'className' in c ? c.className : undefined}
                        showArrow={Boolean(opts)}
                        valueText={posterCellValue(row, c.col)}
                        placeholder={c.placeholder}
                        selectOptions={opts}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!isSel)
                            grid.setSelection({
                              startRow: rIdx,
                              startCol: c.col,
                              endRow: rIdx,
                              endCol: c.col,
                            });
                          setMenu({ x: e.clientX, y: e.clientY });
                        }}
                      />
                    );
                  })}
                  <td
                    className="resource-status border border-[#e0e5ec] px-2 py-1.5 align-middle"
                    title={badge.title}
                  >
                    <span
                      className={`poster-status-badge inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${badge.cls}`}
                    >
                      {badge.text}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="poster-floating-add-row-btn absolute right-5 bottom-4 z-[5] flex h-9 w-9 items-center justify-center rounded-full bg-[var(--brand)] text-base font-bold text-white shadow-lg transition-colors hover:not-disabled:bg-[var(--brand-hover)] disabled:cursor-not-allowed disabled:opacity-45"
        aria-label="新增一行"
        title="在表格末尾新增一行"
        disabled={busy || rows.length >= 500}
        onClick={() => appendRows(1)}
      >
        ＋
      </button>
      {menu && (
        <div
          className="popover-menu flex min-w-[168px] flex-col gap-0.5 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-xl"
          role="menu"
          aria-label="素材表格右键菜单"
          style={{
            position: 'fixed',
            left: Math.min(menu.x, (globalThis.innerWidth || 1200) - 200),
            top: Math.min(menu.y, (globalThis.innerHeight || 800) - 260),
            zIndex: 1200,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menuItems.map(([label, act, danger]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={`w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                danger ? 'text-rose-600 hover:bg-rose-50' : 'text-[var(--text)] hover:bg-slate-100'
              }`}
              onClick={() => {
                act();
                setMenu(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <PosterMediaPreviewModal row={previewRow} onClose={() => setPreviewRow(null)} />
    </div>
  );
}
