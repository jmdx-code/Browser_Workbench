import { useMemo, useRef, useState } from 'react';
import { flexRender } from '@tanstack/react-table';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useLegacyTable,
  type LegacyColumnDef,
} from '@tanstack/react-table/legacy';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  extractImageUrlFromCell,
  isScientificNotationCell,
  type SheetGridRow,
  type SheetGridSnapshot,
} from '../../../shared/google-sheets.js';
import { copyTextToClipboard } from '../../clipboard.js';
import { IconRefresh } from '../../icons.js';
import { UI_CARD, UI_INPUT_SM, UI_MUTED, UI_ROW } from '../../ui/primitives.js';
import { BackdropModal, Btn, Chk, FilterChip } from '../shared/module-ui.js';
export type SheetRowStatusFilter = 'all' | 'pending' | 'running' | 'failed' | 'completed';
type RowStatusBucket = Exclude<SheetRowStatusFilter, 'all'>;
interface GridDataRow {
  rowNumber: number;
  isHintRow: boolean;
  values: string[];
  displayValues: string[];
}
const STATUS_FILTER_CHIPS: ReadonlyArray<{ id: SheetRowStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待发' },
  { id: 'running', label: '发布中' },
  { id: 'failed', label: '失败' },
  { id: 'completed', label: '已完成' },
];
const estimateWidth = (h: string) =>
  /头像|缩略图|点赞|留言|AI|时间线|电脑/i.test(h)
    ? 108
    : /日期|时间|状态|类别|数量/i.test(h)
      ? 132
      : /文案|链接|素材/i.test(h)
        ? 240
        : /编号|名字|名称|专页|小组/i.test(h)
          ? 164
          : 136;
const STATUS_PILLS: ReadonlyArray<[RegExp, string]> = [
  [/部分完成|已过期|跳过|等待|待/i, 'bg-amber-50 text-amber-700'],
  [/失败|受限|错误/i, 'bg-rose-50 text-rose-700'],
  [/发布中|进行中|运行中/i, 'bg-[var(--brand-soft)] text-[var(--brand)]'],
  [/已完成|完成|已发布/i, 'bg-emerald-50 text-emerald-700'],
];
function classifyRowStatus(row: SheetGridRow, statusColIdx: number): RowStatusBucket | null {
  if (statusColIdx < 0) return null;
  const t = (row.displayValues[statusColIdx] ?? row.values[statusColIdx] ?? '').trim();
  if (/发布中|發佈中|进行中|進行中|运行中|運行中|running/i.test(t)) return 'running';
  if (/部分完成|失败|失敗|受限|错误|錯誤|异常|異常|已过期|已過期|跳过|跳過|failed|partial/i.test(t))
    return 'failed';
  if (/已完成|完成|已发布|已發佈|completed/i.test(t)) return 'completed';
  if (!t || /待|等待|重试|重試|pending|retry/i.test(t)) return 'pending';
  return null;
}
function renderStatusPill(text: string) {
  const t = text.trim();
  if (!t) return null;
  const cls = STATUS_PILLS.find(([re]) => re.test(t))?.[1] ?? 'bg-slate-100 text-slate-600';
  return (
    <span
      className={`inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {t}
    </span>
  );
}
export function SheetDataGrid(p: {
  snapshot: SheetGridSnapshot | null;
  loading: boolean;
  emptyTitle: string;
  emptyHint: string;
  showToolbar?: boolean;
  enableStatusFilter?: boolean;
  onResetStuckRows?: () => void;
  resettingStuck?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  onNotify?: (msg: string) => void;
}) {
  const {
    snapshot,
    loading,
    showToolbar = true,
    enableStatusFilter = false,
    onResetStuckRows,
    resettingStuck = false,
    onRefresh,
    refreshing = false,
    onNotify,
  } = p;
  const [search, setSearch] = useState(''),
    [statusFilter, setStatusFilter] = useState<SheetRowStatusFilter>('all'),
    [hideHintRows, setHideHintRows] = useState(false),
    [previewImage, setPreviewImage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const statusColIdx = useMemo(
    () =>
      (snapshot?.headers ?? []).findIndex((h) =>
        /发布状态|發布狀態|状态|狀態|status/i.test(h.trim()),
      ),
    [snapshot?.headers],
  );
  const statusCounts = useMemo(() => {
    const counts: Record<SheetRowStatusFilter, number> = {
      all: 0,
      pending: 0,
      running: 0,
      failed: 0,
      completed: 0,
    };
    if (!snapshot) return counts;
    for (const row of snapshot.rows) {
      if (row.isHintRow) continue;
      counts.all++;
      const bucket = classifyRowStatus(row, statusColIdx);
      if (bucket) counts[bucket]++;
    }
    return counts;
  }, [snapshot, statusColIdx]);
  const filteredData = useMemo<GridDataRow[]>(() => {
    if (!snapshot) return [];
    const q = search.trim().toLowerCase();
    return snapshot.rows.filter((r: SheetGridRow) => {
      if (hideHintRows && r.isHintRow) return false;
      if (enableStatusFilter && statusFilter !== 'all') {
        if (r.isHintRow) return false;
        if (classifyRowStatus(r, statusColIdx) !== statusFilter) return false;
      }
      if (
        q &&
        !r.displayValues.some((c) => c.toLowerCase().includes(q)) &&
        !r.values.some((c) => c.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [snapshot, search, hideHintRows, enableStatusFilter, statusFilter, statusColIdx]);
  const columns = useMemo<LegacyColumnDef<GridDataRow>[]>(() => {
    const headers = snapshot?.headers ?? [];
    return [
      {
        id: '__rowNumber',
        header: '#',
        size: 64,
        enableSorting: false,
        accessorFn: (r) => r.rowNumber,
        cell: (info) =>
          info.row.original.isHintRow ? (
            <span
              className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
              title="模板说明行，同步/发帖/顶贴时自动跳过"
            >
              说明
            </span>
          ) : (
            <span className="font-mono text-[11px] text-[var(--text-3)]">
              {info.row.original.rowNumber}
            </span>
          ),
      },
      ...headers.map((header, idx): LegacyColumnDef<GridDataRow> => {
        const label = header.trim() || `列 ${idx + 1}`,
          isStatusCol = /状态|狀態|status/i.test(label),
          isImageCol = /头像|頭像|缩略图|縮略圖|image|thumb/i.test(label);
        return {
          id: `col_${idx}`,
          header: label,
          size: estimateWidth(label),
          accessorFn: (row) => row.displayValues[idx] ?? row.values[idx] ?? '',
          cell: (info) => {
            const row = info.row.original,
              raw = row.values[idx] ?? '',
              display = row.displayValues[idx] ?? '',
              sci = isScientificNotationCell(display),
              effective = sci && raw && !isScientificNotationCell(raw) ? raw : display || raw;
            if (row.isHintRow)
              return (
                <span className="truncate text-[11px] text-amber-800 italic" title={effective}>
                  {effective}
                </span>
              );
            if (sci && isScientificNotationCell(effective))
              return (
                <span
                  className="truncate text-[#b45309]"
                  title={`${effective}（Google 表格内该单元格已被转为科学计数法，请改为纯文本格式以保留完整 ID）`}
                >
                  {effective}
                </span>
              );
            const imageUrl = extractImageUrlFromCell(raw) ?? extractImageUrlFromCell(display);
            if (imageUrl && (isImageCol || /^=\s*IMAGE\s*\(/i.test(raw)))
              return (
                <button
                  type="button"
                  className="h-8 w-8 overflow-hidden rounded border border-[var(--line)] p-0"
                  title="点击放大查看图片"
                  onClick={() => setPreviewImage(imageUrl)}
                >
                  <img
                    src={imageUrl}
                    alt={label}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
              );
            if (isStatusCol && effective.trim()) return renderStatusPill(effective);
            if (/^https?:\/\/\S+$/i.test(effective.trim())) {
              const url = effective.trim();
              return (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    title={url}
                    className="min-w-0 truncate text-sky-700 hover:underline"
                  >
                    {url.replace(/^https?:\/\/(?:www\.)?/i, '').slice(0, 32)}
                    {url.length > 42 ? '…' : ''}
                  </a>
                  <Btn
                    className="h-5 px-1.5 text-[10px]"
                    title="复制链接"
                    onClick={() =>
                      void copyTextToClipboard(url)
                        .then(() => onNotify?.('已复制链接'))
                        .catch(() => {})
                    }
                  >
                    复制
                  </Btn>
                </span>
              );
            }
            return (
              <span className="truncate" title={effective}>
                {effective}
              </span>
            );
          },
        };
      }),
    ];
  }, [snapshot?.headers, onNotify]);
  const table = useLegacyTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleVirtualRows =
    virtualItems.length > 0
      ? virtualItems
      : rows.slice(0, 30).map((r, index) => ({ key: r.id, index, start: index * 44, size: 44 }));
  const totalWidth = useMemo(
    () => table.getVisibleLeafColumns().reduce((acc, col) => acc + col.getSize(), 0),
    [table, snapshot?.headers],
  );
  const growColumnId = useMemo(() => {
    const dataCols = columns.filter((c) => c.id && c.id !== '__rowNumber');
    return (
      dataCols.find((c) =>
        /名字|名称|文案|标题/i.test(typeof c.header === 'string' ? c.header : ''),
      )?.id ??
      dataCols[dataCols.length - 1]?.id ??
      null
    );
  }, [columns]);
  const refreshBtn = onRefresh && (
    <Btn
      v="icon"
      disabled={refreshing || loading}
      aria-label="刷新表格"
      title={
        snapshot
          ? `刷新表格（同步于 ${new Date(snapshot.fetchedAt).toLocaleTimeString()}）`
          : '刷新表格'
      }
      onClick={onRefresh}
    >
      <IconRefresh size={14} className={refreshing || loading ? 'animate-spin' : undefined} />
    </Btn>
  );
  if (loading && !snapshot)
    return (
      <div
        className={`${UI_CARD} flex flex-1 flex-col items-center justify-center p-6 text-sm text-[var(--text-3)]`}
      >
        <p className="m-0">正在从 Google 表格加载实时数据…</p>
      </div>
    );
  if (!snapshot)
    return (
      <div
        className={`${UI_CARD} flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center`}
      >
        {refreshBtn}
        <h3 className="m-0 text-sm font-semibold">{p.emptyTitle}</h3>
        <p className="m-0 text-xs text-[var(--text-3)]">{p.emptyHint}</p>
      </div>
    );
  const hintRowCount = snapshot.rows.filter((r) => r.isHintRow).length;
  const hasFilter = Boolean(search.trim()) || (enableStatusFilter && statusFilter !== 'all');
  const colStyle = (size: number, isGrow: boolean) => ({
    minWidth: `${size}px`,
    width: isGrow ? undefined : `${size}px`,
    flex: isGrow ? `1 0 ${size}px` : `0 0 ${size}px`,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-white">
      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-slate-50 px-3 py-2 text-xs">
          <div className={UI_ROW}>
            <input
              type="search"
              className={`${UI_INPUT_SM} w-60 max-w-full`}
              placeholder="搜索表格任意列（ID、名称、文案、编号、状态…）"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {enableStatusFilter && (
              <div
                className="inline-flex flex-wrap items-center gap-1"
                role="group"
                aria-label="按状态筛选"
              >
                {STATUS_FILTER_CHIPS.map((chip) => (
                  <FilterChip
                    key={chip.id}
                    label={chip.label}
                    count={statusCounts[chip.id]}
                    active={statusFilter === chip.id}
                    countClass="text-[10px]"
                    onClick={() => setStatusFilter(chip.id)}
                  />
                ))}
              </div>
            )}
          </div>
          <div className={UI_ROW}>
            {onResetStuckRows && (
              <Btn
                disabled={resettingStuck || loading}
                title="将长时间卡在「发布中」的排贴行重置为可重试状态"
                onClick={onResetStuckRows}
              >
                {resettingStuck ? '重置中…' : '重置卡死行'}
              </Btn>
            )}
            <span>
              共 <strong>{snapshot.rows.length - hintRowCount}</strong> 条有效数据
              {hasFilter ? `（匹配 ${filteredData.length} 行）` : ''}
            </span>
            {hintRowCount > 0 && (
              <Chk label="隐藏模板说明行" checked={hideHintRows} onChange={setHideHintRows} />
            )}
            <span className={UI_MUTED}>
              同步于 {new Date(snapshot.fetchedAt).toLocaleTimeString()}
            </span>
            {refreshBtn}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        <div style={{ minWidth: `${Math.max(totalWidth, 680)}px` }}>
          <div
            className="sticky top-0 z-10 border-b border-[var(--line)] bg-slate-50"
            role="rowgroup"
          >
            {table.getHeaderGroups().map((hg) => (
              <div key={hg.id} className="flex items-stretch" role="row">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort(),
                    sorted = header.column.getIsSorted();
                  return (
                    <div
                      key={header.id}
                      role="columnheader"
                      className={`flex h-9 items-center gap-1 border-r border-slate-100 px-2.5 text-xs font-semibold text-slate-700 ${canSort ? 'cursor-pointer select-none hover:bg-slate-100' : ''}`}
                      style={colStyle(header.getSize(), header.column.id === growColumnId)}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    >
                      <span className="truncate">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {sorted === 'asc' && <span className="text-[10px]">▲</span>}
                      {sorted === 'desc' && <span className="text-[10px]">▼</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div
            className="relative"
            role="rowgroup"
            style={{ height: `${Math.max(virtualizer.getTotalSize(), 120)}px` }}
          >
            {rows.length === 0 ? (
              <div className="p-8 text-center text-xs text-[var(--muted)]">
                {hasFilter ? '没有匹配筛选条件的行' : '工作表当前还没有数据行'}
              </div>
            ) : (
              visibleVirtualRows.map((vRow) => {
                const row = rows[vRow.index];
                if (!row) return null;
                return (
                  <div
                    key={row.id}
                    role="row"
                    className={`absolute top-0 left-0 flex w-full items-stretch border-b border-slate-100 text-xs ${row.original.isHintRow ? 'bg-amber-50/40' : 'hover:bg-slate-50'}`}
                    style={{ transform: `translateY(${vRow.start}px)`, height: `${vRow.size}px` }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        role="cell"
                        className="flex min-w-0 items-center border-r border-slate-100 px-2.5"
                        style={colStyle(cell.column.getSize(), cell.column.id === growColumnId)}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
      {previewImage && (
        <BackdropModal label="图片预览" modalClass="contents" onClose={() => setPreviewImage(null)}>
          <div className="modal flex max-h-[86vh] max-w-[min(680px,92vw)] flex-col gap-2.5 rounded-2xl border border-[var(--line)] bg-white p-3 text-[var(--text)] shadow-2xl">
            <img
              src={previewImage}
              alt="预览图"
              className="max-h-[70vh] rounded-lg object-contain"
            />
            <div className="flex items-center justify-between gap-2 text-xs">
              <code className="min-w-0 flex-1 truncate text-[var(--text-3)]" title={previewImage}>
                {previewImage}
              </code>
              <Btn onClick={() => setPreviewImage(null)}>关闭</Btn>
            </div>
          </div>
        </BackdropModal>
      )}
    </div>
  );
}
