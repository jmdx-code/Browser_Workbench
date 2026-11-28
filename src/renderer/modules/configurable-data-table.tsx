import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  startHorizontalDrag,
  UI_CHECKBOX,
  UI_HINT,
  UI_ROW_BT,
  UI_ROW_SM,
} from '../ui/primitives.js';
import { Btn, useDropdownDismiss } from './shared/module-ui.js';
export interface TableColumnDef<T> {
  key: string;
  label: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  defaultVisible?: boolean;
  locked?: boolean;
  align?: 'left' | 'right' | 'center';
  sortKey?: string;
  renderCell: (row: T) => ReactNode;
  exportValue: (row: T) => unknown;
}
interface PersistedTableConfig {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}
const STORAGE_PREFIX = 'workbench.table-config.v1.';
function buildDefaultConfig<T>(columns: readonly TableColumnDef<T>[]): PersistedTableConfig {
  return {
    order: columns.map((c) => c.key),
    hidden: columns.filter((c) => c.defaultVisible === false && !c.locked).map((c) => c.key),
    widths: {},
  };
}
function loadTableConfig<T>(
  storageKey: string,
  columns: readonly TableColumnDef<T>[],
): PersistedTableConfig {
  const def = buildDefaultConfig(columns);
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<PersistedTableConfig>;
    const validKeys = new Set(columns.map((c) => c.key));
    const seen = new Set<string>();
    const order: string[] = [];
    for (const k of Array.isArray(parsed.order) ? parsed.order : []) {
      if (typeof k === 'string' && validKeys.has(k) && !seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    for (const c of columns) {
      if (!seen.has(c.key)) order.push(c.key);
    }
    const lockedKeys = new Set(columns.filter((c) => c.locked).map((c) => c.key));
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter(
          (k): k is string => typeof k === 'string' && validKeys.has(k) && !lockedKeys.has(k),
        )
      : def.hidden;
    const widths: Record<string, number> = {};
    if (parsed.widths && typeof parsed.widths === 'object') {
      for (const [k, v] of Object.entries(parsed.widths)) {
        if (validKeys.has(k) && typeof v === 'number' && Number.isFinite(v)) {
          widths[k] = Math.max(44, Math.min(600, Math.round(v)));
        }
      }
    }
    return { order, hidden, widths };
  } catch {
    return def;
  }
}
export function resolveVisibleColumns<T>(
  columns: readonly TableColumnDef<T>[],
  cfg: PersistedTableConfig,
): Array<TableColumnDef<T> & { width: number }> {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const hiddenSet = new Set(cfg.hidden);
  const out: Array<TableColumnDef<T> & { width: number }> = [];
  for (const k of cfg.order) {
    const col = byKey.get(k);
    if (!col) continue;
    if (!col.locked && hiddenSet.has(col.key)) continue;
    const min = col.minWidth ?? 44;
    const max = col.maxWidth ?? 600;
    const width = Math.max(min, Math.min(max, cfg.widths[col.key] ?? col.defaultWidth));
    out.push({ ...col, width });
  }
  return out;
}
export function ConfigurableDataTable<T>(p: {
  storageKey: string;
  columns: readonly TableColumnDef<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string;
  emptyText?: string;
  loading?: boolean;
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: () => void;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (key: string) => void;
  toolbarExtra?: ReactNode;
  onVisibleColumnsChange?: (cols: ReadonlyArray<TableColumnDef<T>>) => void;
  testId?: string;
}) {
  const [cfg, setCfg] = useState<PersistedTableConfig>(() =>
    loadTableConfig(p.storageKey, p.columns),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setCfg(loadTableConfig(p.storageKey, p.columns));
  }, [p.storageKey, p.columns]);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + p.storageKey, JSON.stringify(cfg));
    } catch {}
  }, [p.storageKey, cfg]);
  const visibleColumns = useMemo(() => resolveVisibleColumns(p.columns, cfg), [p.columns, cfg]);
  useEffect(() => {
    p.onVisibleColumnsChange?.(visibleColumns);
  }, [visibleColumns, p.onVisibleColumnsChange]);
  useDropdownDismiss(pickerOpen, pickerRef, () => setPickerOpen(false));
  const colByKey = useMemo(() => new Map(p.columns.map((c) => [c.key, c])), [p.columns]);
  const hiddenSet = useMemo(() => new Set(cfg.hidden), [cfg.hidden]);
  const moveOrder = (key: string, delta: -1 | 1) => {
    setCfg((prev) => {
      const idx = prev.order.indexOf(key);
      const nextIdx = idx + delta;
      if (idx < 0 || nextIdx < 0 || nextIdx >= prev.order.length) return prev;
      const next = [...prev.order];
      const moved = next[idx];
      const swapped = next[nextIdx];
      if (!moved || !swapped) return prev;
      next[idx] = swapped;
      next[nextIdx] = moved;
      return { ...prev, order: next };
    });
  };
  const reorderDrop = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    setCfg((prev) => {
      const next = prev.order.filter((k) => k !== dragKey);
      const idx = next.indexOf(targetKey);
      if (idx < 0) return prev;
      next.splice(idx, 0, dragKey);
      return { ...prev, order: next };
    });
    setDragKey(null);
  };
  const toggleVisible = (key: string) => {
    const col = colByKey.get(key);
    if (!col || col.locked) return;
    setCfg((prev) => {
      const isHidden = prev.hidden.includes(key);
      if (!isHidden) {
        const visibleCount = p.columns.length - prev.hidden.length;
        if (visibleCount <= 1) return prev;
        return { ...prev, hidden: [...prev.hidden, key] };
      }
      return { ...prev, hidden: prev.hidden.filter((k) => k !== key) };
    });
  };
  const startResize = (colKey: string, initialWidth: number, startX: number) => {
    const col = colByKey.get(colKey);
    const min = col?.minWidth ?? 44,
      max = col?.maxWidth ?? 600;
    startHorizontalDrag(startX, (dx) =>
      setCfg((prev) => ({
        ...prev,
        widths: {
          ...prev.widths,
          [colKey]: Math.max(min, Math.min(max, Math.round(initialWidth + dx))),
        },
      })),
    );
  };
  const allSelected =
    Boolean(p.selectable) &&
    p.rows.length > 0 &&
    p.rows.every((r) => p.selectedIds?.has(p.getRowKey(r)));
  const totalWidth = (p.selectable ? 36 : 0) + visibleColumns.reduce((acc, c) => acc + c.width, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className={UI_ROW_BT}>
        <div className={UI_ROW_SM}>{p.toolbarExtra}</div>
        <div className="relative" ref={pickerRef}>
          <Btn
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            title="选择展示列并调整列顺序与列宽"
          >
            列设置 ({visibleColumns.length}/{p.columns.length})
          </Btn>
          {pickerOpen && (
            <div
              role="dialog"
              aria-label="列设置"
              className="absolute right-0 z-50 mt-1.5 flex w-72 flex-col gap-2 rounded-xl border border-[var(--line)] bg-white p-3 shadow-xl"
            >
              <div className="flex items-center justify-between border-b border-[var(--line)] pb-1.5">
                <span className="text-xs font-semibold text-[var(--text)]">展示列与顺序</span>
                <Btn v="ghost" onClick={() => setCfg(buildDefaultConfig(p.columns))}>
                  恢复默认
                </Btn>
              </div>
              <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-0.5">
                {cfg.order.map((key, idx) => {
                  const col = colByKey.get(key);
                  if (!col) return null;
                  const checked = col.locked || !hiddenSet.has(key);
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          className={UI_CHECKBOX}
                          checked={checked}
                          disabled={col.locked}
                          onChange={() => toggleVisible(key)}
                        />
                        <span className="truncate text-[var(--text)]">{col.label}</span>
                      </label>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--text-2)] hover:bg-slate-200 disabled:opacity-30"
                          aria-label={`上移 ${col.label}`}
                          disabled={idx === 0}
                          onClick={() => moveOrder(key, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--text-2)] hover:bg-slate-200 disabled:opacity-30"
                          aria-label={`下移 ${col.label}`}
                          disabled={idx === cfg.order.length - 1}
                          onClick={() => moveOrder(key, 1)}
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className={UI_HINT}>
                提示：表头可直接拖拽调序，拖右侧竖线调整列宽（双击恢复默认）。
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-white">
        <table
          data-testid={p.testId}
          className="border-collapse text-xs"
          style={{ tableLayout: 'fixed', width: `${totalWidth}px`, minWidth: '100%' }}
        >
          <colgroup>
            {p.selectable && <col style={{ width: '36px' }} />}
            {visibleColumns.map((col) => (
              <col key={col.key} style={{ width: `${col.width}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr className="sticky top-0 z-10 border-b border-[var(--line)] bg-slate-50 text-[11px] font-semibold text-[var(--text-2)]">
              {p.selectable && (
                <th className="w-9 px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    className={UI_CHECKBOX}
                    aria-label="全选当前页记录"
                    checked={allSelected}
                    onChange={() => p.onToggleSelectAll?.()}
                  />
                </th>
              )}
              {visibleColumns.map((col) => {
                const isSorted = Boolean(col.sortKey && p.sortKey === col.sortKey);
                const alignCls =
                  col.align === 'right'
                    ? 'text-right'
                    : col.align === 'center'
                      ? 'text-center'
                      : 'text-left';
                return (
                  <th
                    key={col.key}
                    draggable
                    onDragStart={() => setDragKey(col.key)}
                    onDragOver={(e) => {
                      if (dragKey && dragKey !== col.key) e.preventDefault();
                    }}
                    onDrop={() => reorderDrop(col.key)}
                    onDragEnd={() => setDragKey(null)}
                    className={`group relative select-none border-r border-slate-200/70 px-2.5 py-2 ${alignCls}`}
                  >
                    {col.sortKey && p.onSortChange ? (
                      <button
                        type="button"
                        className="inline-flex max-w-full items-center gap-1 truncate font-semibold text-inherit hover:text-[var(--brand)]"
                        onClick={() => col.sortKey && p.onSortChange?.(col.sortKey)}
                      >
                        <span className="truncate">{col.label}</span>
                        {isSorted && <span>{p.sortDir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    ) : (
                      <span className="block truncate">{col.label}</span>
                    )}
                    <div
                      role="separator"
                      aria-label={`调整 ${col.label} 列宽`}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--brand)]/50"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        startResize(col.key, col.width, e.clientX);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setCfg((prev) => {
                          const nextW = { ...prev.widths };
                          delete nextW[col.key];
                          return { ...prev, widths: nextW };
                        });
                      }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {p.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleColumns.length + (p.selectable ? 1 : 0)}
                  className="py-12 text-center text-xs text-[var(--text-3)]"
                >
                  {p.loading ? '正在加载数据…' : (p.emptyText ?? '暂无记录')}
                </td>
              </tr>
            ) : (
              p.rows.map((row) => {
                const rowKey = p.getRowKey(row);
                const checked = Boolean(p.selectedIds?.has(rowKey));
                return (
                  <tr
                    key={rowKey}
                    className={
                      checked ? 'bg-blue-50/40 hover:bg-blue-50/70' : 'hover:bg-slate-50/70'
                    }
                  >
                    {p.selectable && (
                      <td className="px-2 py-2 text-center align-middle">
                        <input
                          type="checkbox"
                          className={UI_CHECKBOX}
                          aria-label={`选择记录 ${rowKey}`}
                          checked={checked}
                          onChange={() => p.onToggleSelect?.(rowKey)}
                        />
                      </td>
                    )}
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className={`overflow-hidden px-2.5 py-2 align-middle ${
                          col.align === 'right'
                            ? 'text-right tabular-nums'
                            : col.align === 'center'
                              ? 'text-center'
                              : 'text-left'
                        }`}
                      >
                        {col.renderCell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
