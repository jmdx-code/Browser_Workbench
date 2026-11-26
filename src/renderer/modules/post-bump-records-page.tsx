import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatPostBumpRecordsAsTsv, formatTimestampLocal } from '../../shared/log-table-copy.js';
import {
  formatPostBumpRecordSummary,
  isPendingApprovalPostId,
  type PostBumpCarrierValue,
  type PostBumpDailyStat,
  type PostBumpRecord,
  type PostBumpRecordQueryTypeValue,
  type PostBumpStatusCounts,
  type PostBumpStatusValue,
} from '../../shared/post-bump-records.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { IconCheckCircle, IconExternalLink } from '../icons.js';
import { toggleSet } from '../selection.js';
import {
  EmptyState,
  PageHeader,
  UI_CARD,
  UI_CHECKBOX,
  UI_INPUT_SM,
  UI_SELECT_SM,
} from '../ui/primitives.js';
import { Btn, errMsg, NoticeBanner, SegTabs } from './shared/module-ui.js';

export type PostBumpRecordTypeFilter = PostBumpRecordQueryTypeValue;
const TYPE_TABS: ReadonlyArray<readonly [PostBumpRecordTypeFilter, string]> = [
  ['all', '全部记录'],
  ['post', '小组发帖'],
  ['bump_all', '全部顶贴'],
  ['group_bump', '小组顶贴'],
  ['page_bump', '专页顶贴'],
];
const CARRIER_FILTERS: ReadonlyArray<readonly ['all' | PostBumpCarrierValue, string]> = [
  ['all', '全部载体'],
  ['browser', 'Chrome 浏览器'],
  ['bluestacks', '蓝蝶模拟器'],
];
const STATUS_FILTERS: ReadonlyArray<readonly ['all' | PostBumpStatusValue, string]> = [
  ['all', '全部状态'],
  ['success', '仅成功'],
  ['failed', '仅失败'],
];
const BADGE_STYLE: Record<string, [string, string]> = {
  post: ['发帖', 'border-sky-200 bg-sky-50 text-sky-700'],
  page_bump: ['专页顶贴', 'border-violet-200 bg-violet-50 text-violet-700'],
  group_bump: ['小组顶贴', 'border-emerald-200 bg-emerald-50 text-emerald-700'],
};

function FilterEntityCell(p: {
  name: string;
  id: string;
  title: string;
  emptyText: string;
  strongName?: boolean;
  onFilter: (val: string) => void;
}) {
  if (!p.name && !p.id) return <span className="text-slate-300">{p.emptyText}</span>;
  const display = p.name || p.id;
  return (
    <button
      type="button"
      className="block w-full text-left hover:underline"
      title={p.title}
      onClick={() => p.onFilter(p.id || p.name)}
    >
      <div
        className={p.strongName ? 'truncate font-medium text-slate-900' : 'truncate text-slate-800'}
        title={display}
      >
        {display}
      </div>
      {p.id && <div className="truncate font-mono text-[10px] text-slate-400">{p.id}</div>}
    </button>
  );
}

function parseLocalDateBounds(dateFrom: string, dateTo: string): { from?: number; to?: number } {
  const parse = (raw: string, end: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
    const [y = 0, m = 0, d = 0] = raw.split('-').map(Number);
    const ts = new Date(
      y,
      m - 1,
      d,
      end ? 23 : 0,
      end ? 59 : 0,
      end ? 59 : 0,
      end ? 999 : 0,
    ).getTime();
    return Number.isFinite(ts) ? ts : undefined;
  };
  const from = parse(dateFrom, false);
  const to = parse(dateTo, true);
  return from !== undefined && to !== undefined && from > to ? {} : { from, to };
}

export function PostBumpRecordsPage(p: {
  initialType?: PostBumpRecordTypeFilter;
  initialTypeFilter?: PostBumpRecordTypeFilter;
  initialStatus?: 'all' | PostBumpStatusValue;
  initialStatusFilter?: 'all' | PostBumpStatusValue;
  initialSubView?: 'ledger' | 'active';
  filterNonce?: number;
  filterKey?: number;
  profiles?: readonly unknown[];
  onNotify: (message: string) => void;
  renderLegacyActiveRecords?: () => ReactNode;
}) {
  const effType = p.initialType ?? p.initialTypeFilter ?? 'all';
  const effStatus = p.initialStatus ?? p.initialStatusFilter ?? 'all';
  const effFilterKey = p.filterNonce ?? p.filterKey ?? 0;
  const [subView, setSubView] = useState<'ledger' | 'active'>(p.initialSubView ?? 'ledger');
  const [recordType, setRecordType] = useState<PostBumpRecordTypeFilter>(effType);
  const [carrier, setCarrier] = useState<'all' | PostBumpCarrierValue>('all');
  const [status, setStatus] = useState<'all' | PostBumpStatusValue>(effStatus);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [records, setRecords] = useState<PostBumpRecord[]>([]);
  const [dailyStats, setDailyStats] = useState<PostBumpDailyStat[]>([]);
  const [statusCounts, setStatusCounts] = useState<PostBumpStatusCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmMode, setConfirmMode] = useState<'selected' | 'clear' | null>(null);

  useEffect(() => {
    setRecordType(effType);
    setStatus(effStatus);
    setSubView(p.initialSubView ?? 'ledger');
  }, [effType, effStatus, p.initialSubView, effFilterKey]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 220);
    return () => clearTimeout(t);
  }, [search]);

  const dateBounds = useMemo(() => parseLocalDateBounds(dateFrom, dateTo), [dateFrom, dateTo]);
  const hasActiveFilters = Boolean(
    recordType !== 'all' ||
    carrier !== 'all' ||
    status !== 'all' ||
    dateFrom ||
    dateTo ||
    search.trim(),
  );

  const loadRecords = useCallback(
    async (appendOffset = 0) => {
      if (appendOffset === 0) setLoading(true);
      else setBusy(true);
      setError('');
      try {
        const res = await api.postBumpRecords({
          recordType,
          carrier,
          status,
          search: debouncedSearch,
          from: dateBounds.from,
          to: dateBounds.to,
          limit: 200,
          offset: appendOffset,
        });
        if (appendOffset === 0) {
          setRecords(res.records);
          setSelectedIds(new Set());
        } else {
          setRecords((prev) => {
            const seen = new Set(prev.map((i) => i.id));
            return [...prev, ...res.records.filter((i) => !seen.has(i.id))];
          });
        }
        setTotal(res.total);
        setHasMore(res.hasMore);
        if (res.dailyStats) setDailyStats(res.dailyStats);
        setStatusCounts(res.statusCounts ?? null);
      } catch (err) {
        setError(errMsg(err, String(err)));
      } finally {
        setLoading(false);
        setBusy(false);
      }
    },
    [recordType, carrier, status, debouncedSearch, dateBounds.from, dateBounds.to],
  );

  useEffect(() => {
    if (subView === 'ledger') void loadRecords(0);
  }, [loadRecords, subView]);
  const allSelected = useMemo(
    () => records.length > 0 && records.every((r) => selectedIds.has(r.id)),
    [records, selectedIds],
  );

  async function handleCopyTsv() {
    setBusy(true);
    try {
      let targetRows: PostBumpRecord[] =
        selectedIds.size > 0 ? records.filter((r) => selectedIds.has(r.id)) : [...records];
      if (selectedIds.size === 0 && hasMore) {
        const collected: PostBumpRecord[] = [];
        const seen = new Set<string>();
        let offset = 0;
        while (collected.length < 5000) {
          const page = await api.postBumpRecords({
            recordType,
            carrier,
            status,
            search: debouncedSearch,
            from: dateBounds.from,
            to: dateBounds.to,
            limit: 1000,
            offset,
          });
          for (const item of page.records)
            if (!seen.has(item.id)) {
              seen.add(item.id);
              collected.push(item);
            }
          if (!page.hasMore || page.records.length === 0) break;
          offset += page.records.length;
        }
        targetRows = collected;
      }
      if (targetRows.length === 0) return p.onNotify('当前没有可复制的记录');
      const { tsv, count } = formatPostBumpRecordsAsTsv(targetRows);
      await copyTextToClipboard(tsv);
      p.onNotify(`已复制 ${count} 条记录（11 列标准表格，可直接粘贴到 Excel / Google 表格）`);
    } catch {
      p.onNotify('复制失败，请检查剪贴板权限');
    } finally {
      setBusy(false);
    }
  }

  async function executeDelete(mode: 'selected' | 'clear') {
    const ids = [...selectedIds];
    if (mode === 'selected' && ids.length === 0) return;
    setBusy(true);
    try {
      const res =
        mode === 'selected'
          ? await api.deletePostBumpRecords({ ids })
          : await api.deletePostBumpRecords({ clearAll: true, recordType });
      setConfirmMode(null);
      p.onNotify(`${mode === 'selected' ? '已删除' : '已清空'} ${res.deleted} 条记录`);
      await loadRecords(0);
    } catch (err) {
      p.onNotify(errMsg(err, String(err)));
    } finally {
      setBusy(false);
    }
  }

  const clearTargetLabel = TYPE_TABS.find((t) => t[0] === recordType)?.[1] ?? '当前类型';

  return (
    <div className="mx-auto flex w-full max-w-[1440px] min-w-0 flex-col gap-3">
      <PageHeader
        title="发帖与顶贴记录"
        subtitle={`统一收录 Chrome 浏览器与蓝蝶模拟器的发帖、小组顶贴与专页顶贴账本（共 ${total} 条）`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {p.renderLegacyActiveRecords && (
              <SegTabs
                value={subView}
                options={[
                  ['ledger', '发帖顶贴账本'],
                  ['active', '近期活跃简要'],
                ]}
                onChange={setSubView}
              />
            )}
            {subView === 'ledger' && (
              <>
                <Btn
                  v="primary"
                  sm={false}
                  disabled={records.length === 0 || busy}
                  onClick={() => void handleCopyTsv()}
                >
                  复制表格 (11列{selectedIds.size > 0 ? ` · ${selectedIds.size}` : ''})
                </Btn>
                <Btn
                  sm={false}
                  disabled={selectedIds.size === 0 || busy}
                  onClick={() => setConfirmMode('selected')}
                >
                  删除选中 ({selectedIds.size})
                </Btn>
                <Btn
                  sm={false}
                  disabled={total === 0 || busy}
                  onClick={() => setConfirmMode('clear')}
                >
                  清空
                </Btn>
                <Btn
                  v="ghost"
                  sm={false}
                  disabled={loading || busy}
                  onClick={() => void loadRecords(0)}
                >
                  刷新
                </Btn>
              </>
            )}
          </div>
        }
      />
      {subView === 'active' && p.renderLegacyActiveRecords ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-3.5 py-2 text-xs text-slate-600">
            <strong className="font-semibold text-slate-800">近期活跃简要</strong>
            ：此处仅保留近期养号与邀人执行概要用于排班核对，核心长周期留痕统一归档在「发帖/顶贴明细」。
          </div>
          {p.renderLegacyActiveRecords()}
        </div>
      ) : (
        <>
          <section
            className={`${UI_CARD} flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <SegTabs value={recordType} options={TYPE_TABS} onChange={setRecordType} />
              <select
                aria-label="执行载体筛选"
                className={`${UI_SELECT_SM} px-2.5`}
                value={carrier}
                onChange={(e) =>
                  setCarrier(
                    e.target.value === 'browser' || e.target.value === 'bluestacks'
                      ? e.target.value
                      : 'all',
                  )
                }
              >
                {CARRIER_FILTERS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                aria-label="执行状态筛选"
                className={`${UI_SELECT_SM} px-2.5`}
                value={status}
                onChange={(e) =>
                  setStatus(
                    e.target.value === 'success' || e.target.value === 'failed'
                      ? e.target.value
                      : 'all',
                  )
                }
              >
                {STATUS_FILTERS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-1 text-[11px] text-slate-600">
                <input
                  type="date"
                  aria-label="起始日期"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="bg-transparent text-xs text-slate-700 focus:outline-none"
                />
                <span className="text-slate-400">至</span>
                <input
                  type="date"
                  aria-label="结束日期"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="bg-transparent text-xs text-slate-700 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索账号 / 小组 / 专页 / 链接 / 摘要…"
                className={`${UI_INPUT_SM} w-60 max-w-full bg-slate-50 px-3`}
              />
              {hasActiveFilters && (
                <Btn
                  onClick={() => {
                    setRecordType('all');
                    setCarrier('all');
                    setStatus('all');
                    setDateFrom('');
                    setDateTo('');
                    setSearch('');
                  }}
                >
                  重置筛选
                </Btn>
              )}
            </div>
          </section>
          {dailyStats.length > 0 && (
            <section
              aria-label="近 7 天发帖与顶贴统计"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-[11px] shadow-2xs"
            >
              <span className="font-semibold text-slate-700">近 7 天趋势</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {dailyStats.map((day) => {
                  const active = dateFrom === day.dateKey && dateTo === day.dateKey;
                  return (
                    <button
                      key={day.dateKey}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setDateFrom(active ? '' : day.dateKey);
                        setDateTo(active ? '' : day.dateKey);
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 tabular-nums ${active ? 'border-slate-900 bg-slate-900 text-white shadow-2xs' : 'border-slate-200 bg-slate-50/70 text-slate-600 hover:border-slate-300 hover:bg-slate-100'}`}
                    >
                      <span
                        className={active ? 'font-mono text-slate-200' : 'font-mono text-slate-500'}
                      >
                        {day.dateKey.slice(5)}
                      </span>
                      <span className={active ? 'text-sky-200' : 'text-sky-700'}>
                        发 {day.posts}
                      </span>
                      <span className={active ? 'text-emerald-200' : 'text-emerald-700'}>
                        顶 {day.bumps}
                      </span>
                      {day.failures > 0 && (
                        <span className={active ? 'text-rose-200' : 'text-rose-600'}>
                          败 {day.failures}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {statusCounts && (
            <section
              aria-label="当前筛选结果汇总"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2 text-xs text-slate-600"
            >
              <div className="flex flex-wrap items-center gap-3 tabular-nums">
                {(
                  [
                    ['匹配', statusCounts.total, 'text-slate-900', ' 条'],
                    ['已确认', statusCounts.confirmed, 'text-emerald-700', ''],
                    ['待审核', statusCounts.pending, 'text-amber-700', ''],
                    ['失败', statusCounts.failed, 'text-rose-700', ''],
                  ] as const
                ).map(([label, val, cls, suffix]) => (
                  <span key={label} className={cls === 'text-slate-900' ? '' : cls}>
                    {label}{' '}
                    <strong className={`font-semibold ${cls === 'text-slate-900' ? cls : ''}`}>
                      {val}
                    </strong>
                    {suffix}
                  </span>
                ))}
                <span>
                  成功率{' '}
                  <strong className="font-semibold text-slate-900">
                    {statusCounts.total > 0
                      ? `${Math.round(((statusCounts.confirmed + statusCounts.pending) / statusCounts.total) * 100)}%`
                      : '—'}
                  </strong>
                </span>
              </div>
              {search.trim() !== '' && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                  title="点击清除搜索词"
                >
                  <span>筛选词: {search.trim()}</span>
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </section>
          )}
          {error && <NoticeBanner tone="err">{error}</NoticeBanner>}
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
            {loading ? (
              <div className="p-8 text-center text-xs text-slate-500" role="status">
                正在加载统一发帖与顶贴记录…
              </div>
            ) : records.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={<IconCheckCircle size={22} />}
                  title="暂无符合条件的记录"
                  description="Chrome 与蓝蝶模拟器的发帖、小组顶贴和专页顶贴结果都会自动写入此账本。"
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table
                  data-testid="post-bump-records-table"
                  className="w-full table-fixed border-collapse text-left text-xs"
                >
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <th className="w-8 px-2 py-2.5 text-center">
                        <input
                          type="checkbox"
                          className={UI_CHECKBOX}
                          aria-label="全选当前记录"
                          checked={allSelected}
                          onChange={() =>
                            setSelectedIds(
                              allSelected ? new Set() : new Set(records.map((r) => r.id)),
                            )
                          }
                        />
                      </th>
                      {(
                        [
                          ['w-[88px]', '时间'],
                          ['w-[78px]', '类型'],
                          ['w-[16%]', '执行账号'],
                          ['w-[16%]', '所属小组'],
                          ['w-[15%]', '目标专页'],
                          ['w-[86px]', '贴文链接'],
                          ['', '动作与状态'],
                        ] as const
                      ).map(([w, title]) => (
                        <th key={title} className={`${w} px-2 py-2.5`.trim()}>
                          {title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {records.map((row) => {
                      const [bLabel, bCls] = BADGE_STYLE[row.recordType] ??
                        BADGE_STYLE.group_bump ?? [
                          '小组顶贴',
                          'border-emerald-200 bg-emerald-50 text-emerald-700',
                        ];
                      const checked = selectedIds.has(row.id);
                      const [datePart, clockPart] = formatTimestampLocal(row.createdAt).split(' ');
                      return (
                        <tr
                          key={row.id}
                          className={
                            checked
                              ? 'bg-sky-50/60'
                              : row.status === 'failed'
                                ? 'bg-rose-50/35 hover:bg-rose-50/60'
                                : 'hover:bg-slate-50/80'
                          }
                        >
                          <td className="px-2 py-2 text-center align-top">
                            <input
                              type="checkbox"
                              className={UI_CHECKBOX}
                              checked={checked}
                              onChange={() => setSelectedIds((s) => toggleSet(s, row.id))}
                            />
                          </td>
                          <td className="px-2 py-2 align-top font-mono text-[11px] leading-tight text-slate-500">
                            <div>{datePart ?? ''}</div>
                            <div className="text-[10px] text-slate-400">{clockPart ?? ''}</div>
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="flex flex-col items-start gap-0.5">
                              <span
                                className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${bCls}`}
                              >
                                {bLabel}
                              </span>
                              <span className="text-[10px] text-slate-400">
                                {row.carrier === 'bluestacks' ? '蓝蝶' : '浏览器'}
                              </span>
                            </div>
                          </td>
                          {(
                            [
                              [row.accountName, row.accountId, '点击按该账号筛选', '-', true],
                              [row.groupName, row.groupId, '点击按该小组筛选', '—', false],
                              [row.pageName, row.pageId, '点击按该专页筛选', '—', false],
                            ] as const
                          ).map(([name, id, title, emptyText, strongName], idx) => (
                            <td key={idx} className="px-2 py-2 align-top">
                              <FilterEntityCell
                                name={name}
                                id={id}
                                title={title}
                                emptyText={emptyText}
                                strongName={strongName}
                                onFilter={setSearch}
                              />
                            </td>
                          ))}
                          <td className="px-2 py-2 align-top">
                            {row.postUrl ? (
                              <a
                                href={row.postUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex max-w-full items-center gap-1 text-sky-700 hover:underline"
                                title={row.postUrl}
                              >
                                <span className="truncate font-mono text-[11px]">
                                  {row.postId && !isPendingApprovalPostId(row.postId)
                                    ? `#${row.postId}`
                                    : '打开贴文'}
                                </span>
                                <IconExternalLink size={11} className="shrink-0" />
                              </a>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top break-words">
                            <span
                              className={
                                row.status === 'failed'
                                  ? 'inline-block rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-700'
                                  : 'text-slate-700'
                              }
                            >
                              {formatPostBumpRecordSummary(row)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {hasMore && !loading && (
              <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 text-center">
                <Btn v="ghost" disabled={busy} onClick={() => void loadRecords(records.length)}>
                  {busy ? '正在加载…' : `加载更多（已显示 ${records.length} / ${total}）`}
                </Btn>
              </div>
            )}
          </section>
        </>
      )}
      {confirmMode && (
        <ConfirmDialog
          title={confirmMode === 'selected' ? '删除选中记录' : `清空「${clearTargetLabel}」`}
          description={
            confirmMode === 'selected'
              ? `确定删除已选中的 ${selectedIds.size} 条发帖/顶贴记录吗？对应的历史日志将一并移除，防重次数统计保持安全不变。`
              : `确定清空「${clearTargetLabel}」下的全部记录吗？清空后对应历史日志也会同步清理，防重统计不受影响。`
          }
          confirmText={confirmMode === 'selected' ? '确认删除' : '确认清空'}
          danger
          busy={busy}
          onConfirm={() => void executeDelete(confirmMode)}
          onCancel={() => setConfirmMode(null)}
        />
      )}
    </div>
  );
}
