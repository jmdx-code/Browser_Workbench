import { Filter, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UI_ROW_SM } from '../ui/primitives.js';
import { Btn, InFld, SelFld, useFixedPortalPopover } from './shared/module-ui.js';
export type RecordFilterDatePreset = 'today' | '7d' | '30d' | 'all' | 'custom';
export interface RecordsFilterState {
  datePreset: RecordFilterDatePreset;
  fromDate: string;
  toDate: string;
  carrier: 'all' | 'browser' | 'bluestacks';
  status: 'all' | 'success' | 'failed';
  confirmation: 'CONFIRMED' | 'PENDING' | 'all';
  bumpType: 'bump_all' | 'group_bump' | 'page_bump';
  accountQuery: string;
  pageQuery: string;
  groupQuery: string;
  postUrlQuery: string;
  friendQuery: string;
}
export const DEFAULT_RECORDS_FILTER: RecordsFilterState = {
  datePreset: 'all',
  fromDate: '',
  toDate: '',
  carrier: 'all',
  status: 'all',
  confirmation: 'CONFIRMED',
  bumpType: 'bump_all',
  accountQuery: '',
  pageQuery: '',
  groupQuery: '',
  postUrlQuery: '',
  friendQuery: '',
};
export function resolveDateRangeBounds(
  preset: RecordFilterDatePreset,
  fromDate: string,
  toDate: string,
): { from?: number; to?: number } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (preset === 'today') return { from: startOfToday };
  if (preset === '7d') return { from: startOfToday - 6 * 86_400_000 };
  if (preset === '30d') return { from: startOfToday - 29 * 86_400_000 };
  if (preset === 'custom') {
    const parseLocalStart = (s: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined;
    };
    const f = parseLocalStart(fromDate);
    const t = parseLocalStart(toDate);
    return {
      ...(f !== undefined ? { from: f } : {}),
      ...(t !== undefined ? { to: t + 86_400_000 - 1 } : {}),
    };
  }
  return {};
}
export function buildFilterChips(
  kind: 'posts' | 'bumps' | 'invites',
  f: RecordsFilterState,
): Array<{ key: keyof RecordsFilterState; label: string }> {
  const chips: Array<{ key: keyof RecordsFilterState; label: string }> = [];
  if (f.datePreset === 'today') chips.push({ key: 'datePreset', label: '日期: 今天' });
  else if (f.datePreset === '7d') chips.push({ key: 'datePreset', label: '日期: 近7天' });
  else if (f.datePreset === '30d') chips.push({ key: 'datePreset', label: '日期: 近30天' });
  else if (f.datePreset === 'custom' && (f.fromDate || f.toDate))
    chips.push({ key: 'datePreset', label: `日期: ${f.fromDate || '..'} ~ ${f.toDate || '..'}` });
  if (f.carrier !== 'all')
    chips.push({
      key: 'carrier',
      label: `载体: ${f.carrier === 'bluestacks' ? '蓝蝶' : '浏览器'}`,
    });
  if (kind === 'bumps' && f.bumpType !== 'bump_all')
    chips.push({
      key: 'bumpType',
      label: `类型: ${f.bumpType === 'page_bump' ? '专页顶贴' : '小组顶贴'}`,
    });
  if (kind === 'invites') {
    if (f.confirmation !== 'CONFIRMED')
      chips.push({
        key: 'confirmation',
        label: `状态: ${f.confirmation === 'all' ? '全部' : '待确认'}`,
      });
  } else if (f.status !== 'all') {
    chips.push({ key: 'status', label: `状态: ${f.status === 'success' ? '成功' : '失败'}` });
  }
  if (f.accountQuery.trim())
    chips.push({
      key: 'accountQuery',
      label: `${kind === 'posts' ? '账号/专页' : '账号'}: ${f.accountQuery.trim()}`,
    });
  if (kind === 'bumps' && f.pageQuery.trim())
    chips.push({ key: 'pageQuery', label: `专页: ${f.pageQuery.trim()}` });
  if (f.groupQuery.trim()) chips.push({ key: 'groupQuery', label: `小组: ${f.groupQuery.trim()}` });
  if (kind !== 'invites' && f.postUrlQuery.trim())
    chips.push({ key: 'postUrlQuery', label: `贴文: ${f.postUrlQuery.trim()}` });
  if (kind === 'invites' && f.friendQuery.trim())
    chips.push({ key: 'friendQuery', label: `好友: ${f.friendQuery.trim()}` });
  return chips;
}
export function RecordsFilterPopover(p: {
  kind: 'posts' | 'bumps' | 'invites';
  value: RecordsFilterState;
  onChange: (next: RecordsFilterState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RecordsFilterState>(p.value);
  const wrapRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    setDraft(p.value);
  }, [p.value, open]);
  const { coords, portalTarget } = useFixedPortalPopover(
    open,
    wrapRef,
    formRef,
    () => setOpen(false),
    460,
    340,
  );
  const chips = buildFilterChips(p.kind, p.value);
  const clearSingleChip = (key: keyof RecordsFilterState) => {
    const patches: Partial<Record<keyof RecordsFilterState, Partial<RecordsFilterState>>> = {
      datePreset: { datePreset: 'all', fromDate: '', toDate: '' },
      carrier: { carrier: 'all' },
      status: { status: 'all' },
      confirmation: { confirmation: 'CONFIRMED' },
      bumpType: { bumpType: 'bump_all' },
    };
    p.onChange({ ...p.value, ...(patches[key] ?? { [key]: '' }) });
  };
  const selectControls: ReadonlyArray<{
    lbl: string;
    val: string;
    onChg: (v: string) => void;
    opts: ReadonlyArray<readonly [string, string]>;
  }> = [
    {
      lbl: '时间范围',
      val: draft.datePreset,
      onChg: (v) => setDraft((p0) => ({ ...p0, datePreset: v as RecordFilterDatePreset })),
      opts: [
        ['all', '全部时间'],
        ['today', '今天'],
        ['7d', '近 7 天'],
        ['30d', '近 30 天'],
        ['custom', '自定义日期'],
      ],
    },
    {
      lbl: '载体',
      val: draft.carrier,
      onChg: (v) => setDraft((p0) => ({ ...p0, carrier: v as RecordsFilterState['carrier'] })),
      opts: [
        ['all', '全部载体'],
        ['browser', '浏览器'],
        ['bluestacks', '蓝蝶'],
      ],
    },
    ...(p.kind === 'bumps'
      ? [
          {
            lbl: '顶贴类型',
            val: draft.bumpType,
            onChg: (v: string) =>
              setDraft((p0) => ({ ...p0, bumpType: v as RecordsFilterState['bumpType'] })),
            opts: [
              ['bump_all', '全部顶贴'],
              ['group_bump', '小组顶贴'],
              ['page_bump', '专页顶贴'],
            ] as const,
          },
        ]
      : []),
    p.kind === 'invites'
      ? {
          lbl: '邀请状态',
          val: draft.confirmation,
          onChg: (v) =>
            setDraft((p0) => ({ ...p0, confirmation: v as RecordsFilterState['confirmation'] })),
          opts: [
            ['CONFIRMED', '仅已确认'],
            ['PENDING', '仅待确认'],
            ['all', '全部状态'],
          ],
        }
      : {
          lbl: '结果状态',
          val: draft.status,
          onChg: (v) => setDraft((p0) => ({ ...p0, status: v as RecordsFilterState['status'] })),
          opts: [
            ['all', '全部状态'],
            ['success', '仅成功'],
            ['failed', '仅失败'],
          ],
        },
  ];
  const textControls: ReadonlyArray<{
    lbl: string;
    k: 'accountQuery' | 'pageQuery' | 'groupQuery' | 'postUrlQuery' | 'friendQuery';
    ph: string;
    cls: string;
  }> = [
    {
      lbl:
        p.kind === 'posts'
          ? '发帖账号 / 专页（名字或 ID）'
          : p.kind === 'bumps'
            ? '顶贴账号（名字或 ID）'
            : '邀请账号（名字或 ID）',
      k: 'accountQuery',
      ph: '输入账号名或 ID…',
      cls: '',
    },
    ...(p.kind === 'bumps'
      ? [{ lbl: '目标专页（名字或 ID）', k: 'pageQuery' as const, ph: '输入专页名或 ID…', cls: '' }]
      : []),
    { lbl: '小组（名字或 ID）', k: 'groupQuery', ph: '输入小组名或 ID…', cls: '' },
    p.kind !== 'invites'
      ? {
          lbl: '贴文链接 / 贴文 ID',
          k: 'postUrlQuery',
          ph: '输入帖子 URL 片段或 Post ID…',
          cls: 'col-span-2',
        }
      : { lbl: '好友（名字或 ID）', k: 'friendQuery', ph: '输入好友名或 ID…', cls: '' },
  ];
  return (
    <div className={UI_ROW_SM}>
      <div className="relative" ref={wrapRef}>
        <Btn
          v={chips.length > 0 ? 'primary' : 'default'}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Filter size={13} />
          <span>筛选{chips.length > 0 ? ` (${chips.length})` : ''}</span>
        </Btn>
        {open &&
          (() => {
            const formNode = (
              <form
                ref={formRef}
                role="dialog"
                aria-label="多条件组合筛选"
                className="fixed z-[140] flex w-[min(460px,92vw)] flex-col gap-2.5 overflow-y-auto rounded-xl border border-[var(--line)] bg-white p-3.5 shadow-xl"
                style={{
                  top: `${coords.top}px`,
                  left: `${coords.left}px`,
                  maxHeight: `${coords.maxHeight}px`,
                }}
                onSubmit={(e) => {
                  e.preventDefault();
                  p.onChange(draft);
                  setOpen(false);
                }}
              >
                <div className="flex items-center justify-between border-b border-[var(--line)] pb-1.5">
                  <span className="text-xs font-semibold text-[var(--text)]">
                    多条件组合筛选 (同时满足 AND)
                  </span>
                  <Btn
                    v="ghost"
                    onClick={() => {
                      const reset = { ...DEFAULT_RECORDS_FILTER };
                      setDraft(reset);
                      p.onChange(reset);
                      setOpen(false);
                    }}
                  >
                    重置全部
                  </Btn>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  {selectControls.map(({ lbl, val, onChg, opts }) => (
                    <SelFld
                      key={lbl}
                      label={lbl}
                      wrapClass="gap-1 text-[11px]"
                      value={val}
                      onVal={onChg}
                    >
                      {opts.map(([ov, ol]) => (
                        <option key={ov} value={ov}>
                          {ol}
                        </option>
                      ))}
                    </SelFld>
                  ))}
                  {draft.datePreset === 'custom' &&
                    (
                      [
                        ['开始日期', 'fromDate'],
                        ['结束日期', 'toDate'],
                      ] as const
                    ).map(([lbl, k]) => (
                      <InFld
                        key={k}
                        label={lbl}
                        wrapClass="gap-1 text-[11px]"
                        type="date"
                        value={draft[k]}
                        onVal={(v) => setDraft((p0) => ({ ...p0, [k]: v }))}
                      />
                    ))}
                  {textControls.map(({ lbl, k, ph, cls }) => (
                    <InFld
                      key={k}
                      label={lbl}
                      wrapClass={`${cls} gap-1 text-[11px]`}
                      type="text"
                      placeholder={ph}
                      value={draft[k]}
                      onVal={(v) => setDraft((p0) => ({ ...p0, [k]: v }))}
                    />
                  ))}
                </div>
                <div className="flex justify-end gap-1.5 border-t border-[var(--line)] pt-2">
                  <Btn onClick={() => setOpen(false)}>取消</Btn>
                  <Btn v="primary" type="submit">
                    应用筛选
                  </Btn>
                </div>
              </form>
            );
            return portalTarget ? createPortal(formNode, portalTarget) : formNode;
          })()}
      </div>
      {p.kind === 'invites' && p.value.confirmation === 'CONFIRMED' && (
        <button
          type="button"
          title="当前默认仅显示已确认邀人，点击切换查看全部状态（含待确认）"
          className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-[var(--text-2)] hover:bg-slate-100"
          onClick={() => p.onChange({ ...p.value, confirmation: 'all' })}
        >
          <span>默认：仅已确认</span>
        </button>
      )}
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800"
        >
          <span>{c.label}</span>
          <button
            type="button"
            aria-label={`移除筛选 ${c.label}`}
            className="rounded-full p-0.5 hover:bg-blue-100"
            onClick={() => clearSingleChip(c.key)}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      {chips.length > 0 && (
        <Btn v="ghost" onClick={() => p.onChange({ ...DEFAULT_RECORDS_FILTER })}>
          清空筛选
        </Btn>
      )}
    </div>
  );
}
