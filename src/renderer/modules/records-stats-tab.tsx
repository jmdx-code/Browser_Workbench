import { Copy, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountActivityRow, ActivityStatsResponse } from '../../shared/activity-stats.js';
import { formatDynamicTableAsTsv } from '../../shared/log-table-copy.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { UI_INPUT_SM, UI_MUTED, UI_ROW, UI_SELECT_SM } from '../ui/primitives.js';
import { ConfigurableDataTable, type TableColumnDef } from './configurable-data-table.js';
import { buildStatsColumns, formatDurationHuman } from './records-columns.js';
import { resolveDateRangeBounds, type RecordFilterDatePreset } from './records-filter-popover.js';
import { Btn, Chk, SegTabs, errMsg } from './shared/module-ui.js';
type SortKey =
  | 'totalActions'
  | 'posts'
  | 'pendingPosts'
  | 'groupBumps'
  | 'pageBumps'
  | 'bumps'
  | 'invites'
  | 'activeDurationMs'
  | 'activeLikes'
  | 'activeFriends'
  | 'failures'
  | 'lastActiveAt'
  | 'windowName';
export function RecordsStatsTab(p: {
  refreshToken: number;
  onNotify: (msg: string) => void;
  onDrillDown?: (req: {
    tab: 'posts' | 'bumps' | 'invites';
    accountQuery: string;
    datePreset: RecordFilterDatePreset;
    fromDate: string;
    toDate: string;
  }) => void;
}) {
  const [datePreset, setDatePreset] = useState<RecordFilterDatePreset>('today');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [carrier, setCarrier] = useState<'all' | 'browser' | 'bluestacks'>('all');
  const [groupBy, setGroupBy] = useState<'profile' | 'account'>('profile');
  const [search, setSearch] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('totalActions');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [data, setData] = useState<ActivityStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);
  const handleDrillDown = useCallback(
    ({ tab, row }: { tab: 'posts' | 'bumps' | 'invites'; row: AccountActivityRow }) => {
      p.onDrillDown?.({
        tab,
        accountQuery: row.accountId || row.accountName || row.windowName,
        datePreset,
        fromDate,
        toDate,
      });
    },
    [p.onDrillDown, datePreset, fromDate, toDate],
  );
  const columns = useMemo(
    () => buildStatsColumns(p.onDrillDown ? handleDrillDown : undefined),
    [p.onDrillDown, handleDrillDown],
  );
  const visibleColsRef = useRef<ReadonlyArray<TableColumnDef<AccountActivityRow>>>(columns);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError('');
    const { from, to } = resolveDateRangeBounds(datePreset, fromDate, toDate);
    void api
      .activityStats(
        {
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          carrier,
          groupBy,
          search,
          onlyActive,
        },
        ctrl.signal,
      )
      .then(
        (res) => {
          if (ctrl.signal.aborted) return;
          setData(res);
          setLoading(false);
        },
        (e) => {
          if (!ctrl.signal.aborted) {
            setError(errMsg(e, '加载活动统计失败'));
            setLoading(false);
          }
        },
      );
    return () => ctrl.abort();
  }, [
    datePreset,
    fromDate,
    toDate,
    carrier,
    groupBy,
    search,
    onlyActive,
    localRefresh,
    p.refreshToken,
  ]);
  const sortedRows = useMemo(() => {
    const rows = [...(data?.rows ?? [])];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'windowName') cmp = a.windowName.localeCompare(b.windowName);
      else if (sortKey === 'lastActiveAt') cmp = (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0);
      else cmp = a[sortKey] - b[sortKey];
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [data?.rows, sortKey, sortDir]);
  const handleSortChange = useCallback(
    (key: string) => {
      const next = key as SortKey;
      if (sortKey === next) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
      else {
        setSortKey(next);
        setSortDir('desc');
      }
    },
    [sortKey],
  );
  const handleCopy = async () => {
    if (!sortedRows.length) return p.onNotify('当前没有可复制的统计数据');
    const cols = visibleColsRef.current.map((c) => ({ header: c.label, value: c.exportValue }));
    const { tsv, count } = formatDynamicTableAsTsv(cols, sortedRows);
    await copyTextToClipboard(tsv);
    p.onNotify(`已复制 ${count} 条统计数据到剪贴板`);
  };
  const t = data?.totals;
  const kpiCards: Array<[string, string | number, string?]> = [
    ['发帖成功', t?.posts ?? 0, t && t.pendingPosts > 0 ? `含待审 ${t.pendingPosts}` : undefined],
    ['顶贴合计', t?.bumps ?? 0, t ? `群${t.groupBumps} / 专页${t.pageBumps}` : undefined],
    ['邀人确认', t?.invites ?? 0],
    ['活跃时长', formatDurationHuman(t?.activeDurationMs ?? 0)],
    ['活跃点赞', t?.activeLikes ?? 0],
    ['接受好友', t?.activeFriends ?? 0],
    ['失败异常', t?.failures ?? 0],
    ['总动作量', t?.totalActions ?? 0],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-white px-3 py-2">
        <div className={UI_ROW}>
          <SegTabs
            value={datePreset}
            onChange={setDatePreset}
            options={[
              ['today', '今天'],
              ['7d', '近 7 天'],
              ['30d', '近 30 天'],
              ['all', '全部'],
              ['custom', '自定义'],
            ]}
          />
          {datePreset === 'custom' && (
            <div className="flex items-center gap-1">
              <label className="inline-flex items-center">
                <span className="sr-only">开始日期</span>
                <input
                  type="date"
                  aria-label="开始日期"
                  className={UI_INPUT_SM}
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </label>
              <span className="text-[var(--text-3)]">~</span>
              <label className="inline-flex items-center">
                <span className="sr-only">结束日期</span>
                <input
                  type="date"
                  aria-label="结束日期"
                  className={UI_INPUT_SM}
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </label>
            </div>
          )}
          <select
            className={UI_SELECT_SM}
            aria-label="载体筛选"
            value={carrier}
            onChange={(e) => setCarrier(e.target.value as 'all' | 'browser' | 'bluestacks')}
          >
            <option value="all">全部载体</option>
            <option value="browser">仅浏览器</option>
            <option value="bluestacks">仅蓝蝶</option>
          </select>
          <SegTabs
            value={groupBy}
            onChange={setGroupBy}
            options={[
              ['profile', '按窗口'],
              ['account', '按 FB 账号'],
            ]}
          />
        </div>
        <div className={UI_ROW}>
          <input
            type="search"
            className={`${UI_INPUT_SM} w-44`}
            placeholder="搜索窗口 / 账号名 / ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Chk checked={onlyActive} onChange={setOnlyActive} label="仅看有活动" />
          <Btn onClick={() => void handleCopy()} disabled={!sortedRows.length}>
            <Copy size={13} />
            <span>复制表格</span>
          </Btn>
          <Btn onClick={() => setLocalRefresh((n) => n + 1)} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>刷新</span>
          </Btn>
        </div>
      </div>
      <div className="grid grid-cols-8 gap-2 max-[1180px]:grid-cols-4 max-[680px]:grid-cols-2">
        {kpiCards.map(([label, val, sub]) => (
          <div
            key={label}
            className="flex min-h-[68px] flex-col justify-between rounded-xl border border-[var(--line)] bg-white px-3 py-2"
          >
            <span className="text-[11px] font-medium text-[var(--text-3)]">{label}</span>
            <strong className="mt-0.5 text-base leading-tight font-bold tabular-nums text-[var(--text)]">
              {val}
            </strong>
            <span className="mt-0.5 min-h-[15px] truncate text-[10.5px] text-[var(--text-3)]">
              {sub ?? ''}
            </span>
          </div>
        ))}
      </div>
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}
      <ConfigurableDataTable
        testId="activity-stats-table"
        storageKey="records-stats"
        columns={columns}
        rows={sortedRows}
        getRowKey={(r) => r.rowKey}
        loading={loading}
        emptyText="当前时间范围内暂无窗口或账号活动统计"
        sortKey={sortKey}
        sortDir={sortDir}
        onSortChange={handleSortChange}
        onVisibleColumnsChange={(cols) => {
          visibleColsRef.current = cols;
        }}
        toolbarExtra={
          <span className={UI_MUTED}>
            共 {sortedRows.length} 个{groupBy === 'account' ? '账号分组' : '窗口'}
          </span>
        }
      />
    </div>
  );
}
