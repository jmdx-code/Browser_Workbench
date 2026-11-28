import { Copy, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InviterRecord } from '../../shared/group-inviter.js';
import { formatDynamicTableAsTsv } from '../../shared/log-table-copy.js';
import type { PostBumpRecord, PostBumpStatusValue } from '../../shared/post-bump-records.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { UI_INPUT_SM, UI_ROW_BT, UI_ROW_SM, UI_SELECT_SM } from '../ui/primitives.js';
import { ConfigurableDataTable, type TableColumnDef } from './configurable-data-table.js';
import { buildBumpColumns, buildInviteColumns, buildPostColumns } from './records-columns.js';
import {
  DEFAULT_RECORDS_FILTER,
  RecordsFilterPopover,
  resolveDateRangeBounds,
  type RecordsFilterState,
} from './records-filter-popover.js';
import { RecordsStatsTab } from './records-stats-tab.js';
import { Btn, SegTabs, errMsg } from './shared/module-ui.js';
export type RecordsTabId = 'stats' | 'posts' | 'bumps' | 'invites';
type PageSizeOption = 50 | 100 | 200;
const PAGE_SIZE_STORAGE_KEY = 'workbench.records-page-size.v1';
function readStoredPageSize(): PageSizeOption {
  try {
    const n = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    if (n === 50 || n === 100 || n === 200) return n;
  } catch {}
  return 50;
}
export function PostBumpRecordsPage(p: {
  initialTab?: RecordsTabId | undefined;
  initialStatus?: 'all' | PostBumpStatusValue | undefined;
  filterNonce?: number | undefined;
  onNotify: (msg: string) => void;
}) {
  const [tab, setTab] = useState<RecordsTabId>(p.initialTab ?? 'stats');
  const [filter, setFilter] = useState<RecordsFilterState>(() => ({
    ...DEFAULT_RECORDS_FILTER,
    ...(p.initialStatus ? { status: p.initialStatus } : {}),
  }));
  const [pageSize, setPageSize] = useState<PageSizeOption>(() => readStoredPageSize());
  const [pageIdx, setPageIdx] = useState(0);
  const [pageJump, setPageJump] = useState('1');
  const [postBumpRows, setPostBumpRows] = useState<PostBumpRecord[]>([]);
  const [inviteRows, setInviteRows] = useState<InviterRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<'selected' | 'clear' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const postCols = useMemo(() => buildPostColumns(p.onNotify), [p.onNotify]);
  const bumpCols = useMemo(() => buildBumpColumns(p.onNotify), [p.onNotify]);
  const inviteCols = useMemo(() => buildInviteColumns(), []);
  const visiblePostBumpColsRef = useRef<ReadonlyArray<TableColumnDef<PostBumpRecord>>>(postCols);
  const visibleInviteColsRef = useRef<ReadonlyArray<TableColumnDef<InviterRecord>>>(inviteCols);
  useEffect(() => {
    if (!p.filterNonce) return;
    if (p.initialTab) setTab(p.initialTab);
    setFilter((prev) => ({ ...DEFAULT_RECORDS_FILTER, status: p.initialStatus ?? prev.status }));
    setPageIdx(0);
    setSelectedIds(new Set());
  }, [p.filterNonce, p.initialTab, p.initialStatus]);
  useEffect(() => {
    setPageIdx(0);
    setSelectedIds(new Set());
  }, [tab, filter, pageSize]);
  useEffect(() => {
    setPageJump(String(pageIdx + 1));
  }, [pageIdx]);
  useEffect(() => {
    if (tab === 'stats') return;
    const ctrl = new AbortController();
    setLoading(true);
    setError('');
    const { from, to } = resolveDateRangeBounds(filter.datePreset, filter.fromDate, filter.toDate);
    const offset = pageIdx * pageSize;
    if (tab === 'invites') {
      void api
        .inviterRecords(
          {
            carrier: filter.carrier,
            confirmation: filter.confirmation,
            accountQuery: filter.accountQuery,
            groupQuery: filter.groupQuery,
            friendQuery: filter.friendQuery,
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
            limit: pageSize,
            offset,
          },
          ctrl.signal,
        )
        .then(
          (res) => {
            if (ctrl.signal.aborted) return;
            setInviteRows(res.records);
            setTotal(res.total);
            setLoading(false);
          },
          (e) => {
            if (!ctrl.signal.aborted) {
              setError(errMsg(e, '加载邀人记录失败'));
              setLoading(false);
            }
          },
        );
    } else {
      const recordType = tab === 'posts' ? 'post' : filter.bumpType;
      void api
        .postBumpRecords(
          {
            recordType,
            carrier: filter.carrier,
            status: filter.status,
            accountQuery: filter.accountQuery,
            groupQuery: filter.groupQuery,
            pageQuery: tab === 'bumps' ? filter.pageQuery : '',
            postUrlQuery: filter.postUrlQuery,
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
            limit: pageSize,
            offset,
          },
          ctrl.signal,
        )
        .then(
          (res) => {
            if (ctrl.signal.aborted) return;
            setPostBumpRows(res.records);
            setTotal(res.total);
            setLoading(false);
          },
          (e) => {
            if (!ctrl.signal.aborted) {
              setError(errMsg(e, tab === 'posts' ? '加载发帖记录失败' : '加载顶贴记录失败'));
              setLoading(false);
            }
          },
        );
    }
    return () => ctrl.abort();
  }, [tab, filter, pageIdx, pageSize, refreshTick]);
  const currentRowsCount = tab === 'invites' ? inviteRows.length : postBumpRows.length;
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSelectAll = () => {
    const ids = (tab === 'invites' ? inviteRows : postBumpRows).map((r) => r.id);
    const allChecked = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    setSelectedIds(allChecked ? new Set() : new Set(ids));
  };
  const copyRows = async <T extends { id: string }>(
    rows: T[],
    cols: ReadonlyArray<TableColumnDef<T>>,
    emptyMsg: string,
    noun: string,
  ) => {
    const target = selectedIds.size ? rows.filter((r) => selectedIds.has(r.id)) : rows;
    if (!target.length) return p.onNotify(emptyMsg);
    const { tsv, count } = formatDynamicTableAsTsv(
      cols.map((c) => ({ header: c.label, value: c.exportValue })),
      target,
    );
    await copyTextToClipboard(tsv);
    p.onNotify(`已复制 ${count} 条${noun}（按当前显示列顺序）`);
  };
  const handleCopy = () =>
    tab === 'invites'
      ? copyRows(inviteRows, visibleInviteColsRef.current, '当前页没有可复制的邀人记录', '邀人记录')
      : copyRows(postBumpRows, visiblePostBumpColsRef.current, '当前页没有可复制的记录', '记录');
  const handleConfirmDelete = async () => {
    if (!confirmDelete || tab === 'stats') return;
    setDeleting(true);
    try {
      if (tab === 'invites') {
        const res =
          confirmDelete === 'selected'
            ? await api.deleteInviterRecords({ ids: [...selectedIds] })
            : await api.deleteInviterRecords({ clearAll: true });
        p.onNotify(`已删除 ${res.deleted} 条邀人记录及对应去重标记`);
      } else {
        const clearRecordType = tab === 'posts' ? 'post' : filter.bumpType;
        const res =
          confirmDelete === 'selected'
            ? await api.deletePostBumpRecords({ ids: [...selectedIds] })
            : await api.deletePostBumpRecords({ clearAll: true, recordType: clearRecordType });
        p.onNotify(`已删除 ${res.deleted} 条记录并同步更新防重与统计计数`);
      }
      setSelectedIds(new Set());
      setConfirmDelete(null);
      setRefreshTick((n) => n + 1);
    } catch (e) {
      p.onNotify(errMsg(e, '删除记录失败'));
    } finally {
      setDeleting(false);
    }
  };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const commitPageJump = () => {
    const n = Math.round(Number(pageJump));
    if (Number.isFinite(n) && n >= 1) {
      const clamped = Math.max(1, Math.min(totalPages, n));
      setPageIdx(clamped - 1);
      setPageJump(String(clamped));
    } else setPageJump(String(pageIdx + 1));
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5" data-testid="records-center-page">
      <div className={UI_ROW_BT}>
        <div className="flex items-center gap-3">
          <h2 className="m-0 text-base font-bold text-[var(--text)]">数据与记录</h2>
          <SegTabs
            value={tab}
            onChange={(next) => setTab(next)}
            options={[
              ['stats', '统计面板'],
              ['posts', '发帖记录'],
              ['bumps', '顶贴记录'],
              ['invites', '邀人记录'],
            ]}
          />
        </div>
        {tab !== 'stats' && (
          <div className={UI_ROW_SM}>
            <Btn onClick={() => void handleCopy()} disabled={!currentRowsCount}>
              <Copy size={13} />
              <span>{selectedIds.size > 0 ? `复制已选 (${selectedIds.size})` : '复制表格'}</span>
            </Btn>
            {selectedIds.size > 0 && (
              <Btn v="danger" onClick={() => setConfirmDelete('selected')}>
                <Trash2 size={13} />
                <span>删除勾选 ({selectedIds.size})</span>
              </Btn>
            )}
            <Btn
              onClick={() => setConfirmDelete('clear')}
              disabled={total === 0}
              title="清空当前分类的全部记录与对应底层去重账本"
            >
              清空全部
            </Btn>
            <Btn onClick={() => setRefreshTick((n) => n + 1)} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              <span>刷新</span>
            </Btn>
          </div>
        )}
      </div>
      {tab === 'stats' ? (
        <RecordsStatsTab
          refreshToken={refreshTick}
          onNotify={p.onNotify}
          onDrillDown={(req) => {
            setFilter({
              ...DEFAULT_RECORDS_FILTER,
              datePreset: req.datePreset,
              fromDate: req.fromDate,
              toDate: req.toDate,
              accountQuery: req.accountQuery,
            });
            setTab(req.tab);
          }}
        />
      ) : (
        <>
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}
          {(() => {
            const isInv = tab === 'invites';
            return (
              <ConfigurableDataTable
                testId={isInv ? 'inviter-records-table' : 'post-bump-records-table'}
                storageKey={
                  isInv ? 'records-invites' : tab === 'posts' ? 'records-posts' : 'records-bumps'
                }
                columns={
                  (isInv ? inviteCols : tab === 'posts' ? postCols : bumpCols) as typeof inviteCols
                }
                rows={(isInv ? inviteRows : postBumpRows) as typeof inviteRows}
                getRowKey={(r) => r.id}
                loading={loading}
                emptyText={
                  isInv
                    ? '暂无符合条件的邀人记录'
                    : tab === 'posts'
                      ? '暂无符合条件的发帖记录'
                      : '暂无符合条件的顶贴记录'
                }
                selectable
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onToggleSelectAll={toggleSelectAll}
                onVisibleColumnsChange={(cols) =>
                  void ((isInv ? visibleInviteColsRef : visiblePostBumpColsRef).current = cols)
                }
                toolbarExtra={
                  <RecordsFilterPopover kind={tab} value={filter} onChange={setFilter} />
                }
              />
            );
          })()}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2 text-xs text-[var(--text-3)]">
            <span>
              共 <strong className="text-[var(--text)]">{total}</strong> 条记录
              {selectedIds.size > 0 ? ` · 已勾选 ${selectedIds.size} 条` : ''}
            </span>
            <div className="flex items-center gap-2">
              <select
                className={UI_SELECT_SM}
                aria-label="每页显示条数"
                value={pageSize}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (next === 50 || next === 100 || next === 200) {
                    setPageSize(next);
                    try {
                      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
                    } catch {}
                  }
                }}
              >
                <option value={50}>50 条/页</option>
                <option value={100}>100 条/页</option>
                <option value={200}>200 条/页</option>
              </select>
              <Btn
                disabled={pageIdx <= 0 || loading}
                onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
              >
                上一页
              </Btn>
              <span className="tabular-nums">
                {pageIdx + 1} / {totalPages}
              </span>
              <Btn
                disabled={pageIdx + 1 >= totalPages || loading}
                onClick={() => setPageIdx((i) => i + 1)}
              >
                下一页
              </Btn>
              {totalPages > 1 && (
                <label className="flex items-center gap-1">
                  <span>跳至</span>
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    aria-label="跳转页码"
                    className={`${UI_INPUT_SM} w-14 text-center tabular-nums`}
                    value={pageJump}
                    onChange={(e) => setPageJump(e.target.value)}
                    onBlur={commitPageJump}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitPageJump();
                      }
                    }}
                  />
                  <span>页</span>
                </label>
              )}
            </div>
          </div>
        </>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={
            confirmDelete === 'selected'
              ? `删除已勾选的 ${selectedIds.size} 条记录？`
              : '清空当前分类全部记录？'
          }
          description="将同时清理对应的底层防重去重账本（已发帖/已顶贴/已邀请标记），并重新计算小组、专页与素材的使用计数，确定继续？"
          label={deleting ? '删除中…' : '确认删除'}
          busy={deleting}
          onClose={() => !deleting && setConfirmDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}
