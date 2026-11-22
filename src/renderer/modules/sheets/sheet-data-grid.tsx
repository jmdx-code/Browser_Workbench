import { useEffect, useMemo, useRef, useState } from 'react';
import { flexRender } from '@tanstack/react-table';
import {
  useLegacyTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type LegacyColumnDef,
} from '@tanstack/react-table/legacy';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  extractImageUrlFromCell,
  type SheetGridRow,
  type SheetGridSnapshot,
} from '../../../shared/google-sheets.js';
import { copyTextToClipboard } from '../../clipboard.js';
import { IconRefresh } from '../../icons.js';

interface GridDataRow {
  rowNumber: number;
  isHintRow: boolean;
  values: string[];
  displayValues: string[];
}

function estimateColumnWidth(header: string): number {
  const h = header.trim();
  if (/头像|缩略图|点赞|留言|AI|时间线|电脑/i.test(h)) return 108;
  if (/日期|时间|状态|类别|数量/i.test(h)) return 132;
  if (/文案|链接|素材/i.test(h)) return 240;
  if (/编号|名字|名称|专页|小组/i.test(h)) return 164;
  return 136;
}

function renderStatusPill(text: string) {
  const t = text.trim();
  if (!t) return null;
  let cls = 'gs-cell-pill';
  if (/部分完成|已过期|跳过|等待|待/i.test(t)) cls += ' tone-warn';
  else if (/失败|受限|错误/i.test(t)) cls += ' tone-err';
  else if (/发布中|进行中|运行中/i.test(t)) cls += ' tone-run';
  else if (/已完成|完成|已发布/i.test(t)) cls += ' tone-ok';
  return <span className={cls}>{t}</span>;
}

export function SheetDataGrid({
  snapshot,
  loading,
  emptyTitle,
  emptyHint,
  showToolbar = true,
  onRefresh,
  refreshing = false,
  onNotify,
}: {
  snapshot: SheetGridSnapshot | null;
  loading: boolean;
  emptyTitle: string;
  emptyHint: string;
  showToolbar?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  onNotify?: (msg: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [hideHintRows, setHideHintRows] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  useEffect(() => {
    if (!previewImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewImage(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [previewImage]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filteredData = useMemo<GridDataRow[]>(() => {
    if (!snapshot) return [];
    const q = search.trim().toLowerCase();
    return snapshot.rows.filter((row: SheetGridRow) => {
      if (hideHintRows && row.isHintRow) return false;
      if (!q) return true;
      return (
        row.displayValues.some((cell) => cell.toLowerCase().includes(q)) ||
        row.values.some((cell) => cell.toLowerCase().includes(q))
      );
    });
  }, [snapshot, search, hideHintRows]);

  const columns = useMemo<LegacyColumnDef<GridDataRow>[]>(() => {
    const headers = snapshot?.headers ?? [];
    const baseCols: LegacyColumnDef<GridDataRow>[] = [
      {
        id: '__rowNumber',
        header: '#',
        size: 64,
        enableSorting: false,
        accessorFn: (row) => row.rowNumber,
        cell: (info) =>
          info.row.original.isHintRow ? (
            <span className="gs-cell-pill" title="模板说明行，同步/发帖/顶贴时自动跳过">
              说明
            </span>
          ) : (
            <span className="gs-row-num">{info.row.original.rowNumber}</span>
          ),
      },
    ];

    headers.forEach((header, idx) => {
      const label = header.trim() || `列 ${idx + 1}`;
      const isStatusCol = /状态|狀態|status/i.test(label);
      const isImageCol = /头像|頭像|缩略图|縮略圖|image|thumb/i.test(label);
      baseCols.push({
        id: `col_${idx}`,
        header: label,
        size: estimateColumnWidth(label),
        accessorFn: (row) => row.displayValues[idx] ?? row.values[idx] ?? '',
        cell: (info) => {
          const row = info.row.original;
          const rawFormula = row.values[idx] ?? '';
          const display = row.displayValues[idx] ?? '';
          const effective = display || rawFormula;

          if (row.isHintRow) {
            return (
              <span className="gs-hint-cell" title={effective}>
                {effective}
              </span>
            );
          }

          const imageUrl = extractImageUrlFromCell(rawFormula) ?? extractImageUrlFromCell(display);
          if (imageUrl && (isImageCol || /^=\s*IMAGE\s*\(/i.test(rawFormula))) {
            return (
              <button
                type="button"
                className="gs-thumb-btn"
                title="点击放大查看图片"
                onClick={() => setPreviewImage(imageUrl)}
              >
                <img src={imageUrl} alt={label} loading="lazy" />
              </button>
            );
          }

          if (isStatusCol && effective.trim()) {
            return renderStatusPill(effective);
          }

          if (/^https?:\/\/\S+$/i.test(effective.trim())) {
            const url = effective.trim();
            return (
              <span className="gs-link-cell">
                <a href={url} target="_blank" rel="noreferrer" title={url}>
                  {url.replace(/^https?:\/\/(?:www\.)?/i, '').slice(0, 32)}
                  {url.length > 42 ? '…' : ''}
                </a>
                <button
                  type="button"
                  className="gs-copy-mini"
                  title="复制链接"
                  onClick={() => {
                    void copyTextToClipboard(url)
                      .then(() => onNotify?.('已复制链接'))
                      .catch(() => {});
                  }}
                >
                  复制
                </button>
              </span>
            );
          }

          return (
            <span className="gs-text-cell" title={effective}>
              {effective}
            </span>
          );
        },
      });
    });

    return baseCols;
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

  const totalWidth = useMemo(
    () => table.getVisibleLeafColumns().reduce((acc, col) => acc + col.getSize(), 0),
    [table, snapshot?.headers],
  );

  if (loading && !snapshot) {
    return (
      <div className="gs-grid-empty">
        <p>正在从 Google 表格加载实时数据…</p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="gs-grid-empty">
        {onRefresh && (
          <button
            type="button"
            className={'gs-grid-refresh-btn' + (refreshing || loading ? ' is-spinning' : '')}
            disabled={refreshing || loading}
            aria-label="刷新表格"
            title="刷新表格"
            onClick={onRefresh}
          >
            <IconRefresh size={14} />
          </button>
        )}
        <h3>{emptyTitle}</h3>
        <p className="hint">{emptyHint}</p>
      </div>
    );
  }

  const hintRowCount = snapshot.rows.filter((r) => r.isHintRow).length;
  const dataRowCount = snapshot.rows.length - hintRowCount;

  return (
    <div className="gs-grid-shell">
      {showToolbar && (
        <div className="gs-grid-toolbar">
          <div className="gs-grid-search">
            <input
              type="search"
              placeholder="搜索表格任意列（ID、名称、文案、编号、状态…）"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="gs-grid-meta">
            <span>
              共 <strong>{dataRowCount}</strong> 条有效数据
              {search.trim() ? `（匹配 ${filteredData.length} 行）` : ''}
            </span>
            {hintRowCount > 0 && (
              <label className="gs-inline-check">
                <input
                  type="checkbox"
                  checked={hideHintRows}
                  onChange={(e) => setHideHintRows(e.target.checked)}
                />
                <span>隐藏模板说明行</span>
              </label>
            )}
            <span className="hint">同步于 {new Date(snapshot.fetchedAt).toLocaleTimeString()}</span>
            {onRefresh && (
              <button
                type="button"
                className={
                  'gs-grid-refresh-btn is-inline' + (refreshing || loading ? ' is-spinning' : '')
                }
                disabled={refreshing || loading}
                aria-label="刷新表格"
                title={`刷新表格（同步于 ${new Date(snapshot.fetchedAt).toLocaleTimeString()}）`}
                onClick={onRefresh}
              >
                <IconRefresh size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="gs-grid-scroll" ref={scrollRef}>
        <div
          className="gs-grid-canvas"
          style={{
            minWidth: `${Math.max(totalWidth + (!showToolbar && onRefresh ? 42 : 0), 680)}px`,
          }}
        >
          <div className="gs-grid-header" role="rowgroup">
            {table.getHeaderGroups().map((hg) => (
              <div key={hg.id} className="gs-grid-tr gs-grid-head-row" role="row">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <div
                      key={header.id}
                      role="columnheader"
                      className={'gs-grid-th' + (canSort ? ' is-sortable' : '')}
                      style={{ width: `${header.getSize()}px`, flex: `0 0 ${header.getSize()}px` }}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    >
                      <span className="gs-th-label">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {sorted === 'asc' && <span className="gs-sort-ind">▲</span>}
                      {sorted === 'desc' && <span className="gs-sort-ind">▼</span>}
                    </div>
                  );
                })}
                {!showToolbar && onRefresh && (
                  <div className="gs-grid-th gs-grid-th-refresh" role="columnheader">
                    <button
                      type="button"
                      className={
                        'gs-grid-refresh-btn is-sticky-head' +
                        (refreshing || loading ? ' is-spinning' : '')
                      }
                      disabled={refreshing || loading}
                      aria-label="刷新表格"
                      title={`刷新表格（同步于 ${new Date(snapshot.fetchedAt).toLocaleTimeString()}）`}
                      onClick={onRefresh}
                    >
                      <IconRefresh size={14} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            className="gs-grid-body"
            role="rowgroup"
            style={{ height: `${Math.max(virtualizer.getTotalSize(), 120)}px` }}
          >
            {rows.length === 0 ? (
              <div className="gs-grid-no-rows">
                {search.trim() ? '没有匹配搜索条件的行' : '工作表当前还没有数据行'}
              </div>
            ) : (
              virtualizer.getVirtualItems().map((vRow) => {
                const row = rows[vRow.index];
                if (!row) return null;
                return (
                  <div
                    key={row.id}
                    role="row"
                    className={'gs-grid-tr' + (row.original.isHintRow ? ' is-hint-row' : '')}
                    style={{
                      transform: `translateY(${vRow.start}px)`,
                      height: `${vRow.size}px`,
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        role="cell"
                        className="gs-grid-td"
                        style={{
                          width: `${cell.column.getSize()}px`,
                          flex: `0 0 ${cell.column.getSize()}px`,
                        }}
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
        <div
          className="gs-lightbox"
          role="dialog"
          aria-label="图片预览"
          onClick={() => setPreviewImage(null)}
        >
          <div className="gs-lightbox-card" onClick={(e) => e.stopPropagation()}>
            <img src={previewImage} alt="预览图" />
            <div className="gs-lightbox-foot">
              <code title={previewImage}>{previewImage}</code>
              <button type="button" className="btn btn-sm" onClick={() => setPreviewImage(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
