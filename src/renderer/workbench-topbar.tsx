import { useEffect, useRef, useState } from 'react';
import type { AutoSchedulerGlobalSettings } from '../shared/auto-scheduler.js';
import type { UpdateStatus } from '../shared/software-update.js';
import {
  IconActivity,
  IconBrand,
  IconGlobe,
  IconLayoutGrid,
  IconMenu,
  IconMinus,
  IconPlus,
  IconSmartphone,
} from './icons.js';
import { Btn, useDropdownDismiss } from './modules/shared/module-ui.js';
const CONCURRENCY_SPECS = [
  [
    'browser',
    'Chrome 浏览器',
    '活跃 / 顶贴 / 发帖 / 邀请 / 排班 / 表格',
    '窗',
    '减少浏览器并发',
    '浏览器最大并发数',
    '增加浏览器并发',
    50,
    [5, 10, 15, 20, 30],
  ],
  [
    'bluestacks',
    '蓝蝶模拟器',
    '蓝蝶全部自动化模块 / 定时排班',
    '台',
    '减少蓝蝶并发',
    '蓝蝶最大并发数',
    '增加蓝蝶并发',
    30,
    [2, 4, 5, 8, 10],
  ],
] as const;
const TOPBAR_BTN =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.06] px-2.5 text-xs font-medium whitespace-nowrap text-[#dfe5ee] transition-colors hover:border-white/30 hover:bg-white/15 hover:text-white';
function GlobalConcurrencyPopover(p: {
  settings: AutoSchedulerGlobalSettings | null;
  onSave: (v: {
    browserConcurrency: number;
    bluestacksConcurrency: number;
  }) => Promise<boolean | void>;
}) {
  const [open, setOpen] = useState(false),
    [saving, setSaving] = useState(false),
    savingRef = useRef(false),
    wrapRef = useRef<HTMLDivElement>(null);
  const browserVal = Math.max(1, Math.min(50, Math.round(p.settings?.browserConcurrency ?? 15))),
    bsVal = Math.max(1, Math.min(30, Math.round(p.settings?.bluestacksConcurrency ?? 5)));
  const [drafts, setDrafts] = useState({ browser: String(browserVal), bluestacks: String(bsVal) });
  useEffect(
    () => setDrafts({ browser: String(browserVal), bluestacks: String(bsVal) }),
    [browserVal, bsVal],
  );
  useDropdownDismiss(open, wrapRef, () => setOpen(false));
  async function applyConcurrency(nextBrowser: number, nextBs: number) {
    if (savingRef.current) return;
    const b = Math.max(1, Math.min(50, Math.round(nextBrowser))),
      s = Math.max(1, Math.min(30, Math.round(nextBs)));
    setDrafts({ browser: String(b), bluestacks: String(s) });
    if (b === browserVal && s === bsVal) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if ((await p.onSave({ browserConcurrency: b, bluestacksConcurrency: s })) === false)
        setDrafts({ browser: String(browserVal), bluestacks: String(bsVal) });
    } catch {
      setDrafts({ browser: String(browserVal), bluestacks: String(bsVal) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="relative inline-flex items-center" ref={wrapRef}>
      <button
        type="button"
        className={`${TOPBAR_BTN} rounded-[7px] gap-1.5 pl-2 pr-2.5 text-[#e6ebf2] tabular-nums${open ? ' border-white/30 bg-white/15 text-white' : ''}`}
        aria-expanded={open}
        aria-label="全局并发设置"
        title="点击统一设置全软件的浏览器与蓝蝶模拟器最大并发窗口数（所有功能共用）"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rounded bg-white/10 px-1.5 py-px text-[11px] font-semibold text-slate-300 max-[1120px]:hidden">
          并发
        </span>
        <span>
          浏览器 <strong className="ml-0.5 font-bold text-[#69a7ff]">{browserVal}</strong>
        </span>
        <span className="text-white/25">·</span>
        <span>
          蓝蝶 <strong className="ml-0.5 font-bold text-[#69a7ff]">{bsVal}</strong>
        </span>
        <span className="ml-px text-[11px] text-[#9ba6b5]" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="topbar-concurrency-popover absolute top-[calc(100%+8px)] right-0 z-50 flex w-[356px] flex-col gap-3 rounded-xl border border-[#d9e0ea] bg-white px-4 py-3.5 text-[#1c222b] shadow-2xl"
          role="dialog"
          aria-label="全局并发设置面板"
        >
          <div className="flex items-center justify-between">
            <strong className="text-[13.5px] font-semibold text-[#141921]">全局最大并发</strong>
            <span className="rounded-full bg-[#edf4ff] px-2 py-0.5 text-[11px] font-semibold text-[#2563eb]">
              {saving ? '同步中…' : '全模块共用'}
            </span>
          </div>
          {CONCURRENCY_SPECS.map(
            ([key, title, desc, unit, minLbl, inLbl, maxLbl, max, presets]) => {
              const val = key === 'browser' ? browserVal : bsVal,
                draft = drafts[key],
                setVal = (n: number) =>
                  void (key === 'browser'
                    ? applyConcurrency(n, bsVal)
                    : applyConcurrency(browserVal, n));
              return (
                <div
                  key={key}
                  className="flex flex-col gap-2 rounded-[10px] border border-[#e6ebf2] bg-[#f7f9fc] px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2.5">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] font-semibold text-[#1e2530]">{title}</span>
                      <small className="whitespace-nowrap text-[11px] text-[#6b7688]">{desc}</small>
                    </div>
                    <div className="inline-flex h-[30px] shrink-0 items-center overflow-hidden rounded-lg border border-[#cfd8e3] bg-white">
                      <button
                        type="button"
                        className="grid h-7 w-7 place-content-center border-0 bg-transparent p-0 text-slate-700 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                        aria-label={minLbl}
                        disabled={saving || val <= 1}
                        onClick={() => setVal(val - 1)}
                      >
                        <IconMinus size={13} />
                      </button>
                      <input
                        type="number"
                        className="h-7 w-[42px] border-x border-[#e2e8f0] bg-white p-0 text-center text-[13px] font-bold tabular-nums text-slate-900 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        aria-label={inLbl}
                        min={1}
                        max={max}
                        value={draft}
                        disabled={saving}
                        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                        onBlur={() => {
                          const t = draft.trim(),
                            n = Number(t);
                          if (!t || !Number.isFinite(n) || n < 1)
                            setDrafts((d) => ({ ...d, [key]: String(val) }));
                          else setVal(n);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.currentTarget.blur();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="grid h-7 w-7 place-content-center border-0 bg-transparent p-0 text-slate-700 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                        aria-label={maxLbl}
                        disabled={saving || val >= max}
                        onClick={() => setVal(val + 1)}
                      >
                        <IconPlus size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {presets.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`h-6 flex-1 rounded-md border p-0 text-[11.5px] tabular-nums transition-colors ${val === n ? 'border-[#2563eb] bg-[#2563eb] font-semibold text-white' : 'border-[#dde3ec] bg-white font-medium text-slate-600 hover:border-[#93c5fd] hover:bg-[#f0f7ff] hover:text-[#1d4ed8]'}`}
                        disabled={saving}
                        onClick={() => setVal(n)}
                      >
                        {n} {unit}
                      </button>
                    ))}
                  </div>
                </div>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}
export function WorkbenchTopbar(p: {
  version: string;
  breadcrumbText: string;
  busy: boolean;
  error: string | null;
  carrier?: 'browser' | 'bluestacks' | undefined;
  onlineCount: number;
  totalProfilesCount: number;
  bluestacksOnlineCount?: number | undefined;
  bluestacksTotalCount?: number | undefined;
  onSwitchCarrier?: ((next: 'browser' | 'bluestacks') => void) | undefined;
  runningCount?: number | undefined;
  onOpenWindowLayout?: (() => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  updateStatus: UpdateStatus | null;
  updateError: string;
  schedulerSettings: AutoSchedulerGlobalSettings | null;
  onSaveGlobalConcurrency: (v: {
    browserConcurrency: number;
    bluestacksConcurrency: number;
  }) => Promise<boolean | void>;
  onOpenMenu: () => void;
  onOpenUpdateMenu: () => void;
  onApplyUpdate: () => Promise<void>;
}) {
  const {
    carrier = 'browser',
    bluestacksOnlineCount = 0,
    bluestacksTotalCount = 0,
    runningCount = 0,
  } = p;
  const [ignoredUpdate, setIgnoredUpdate] = useState('');
  const avail = p.updateStatus?.availableUpdate;
  const availKey = avail ? `${avail.softwareVersion}:${avail.extensionVersion}` : '';
  const connOn =
    !p.error && Boolean(carrier === 'bluestacks' ? bluestacksOnlineCount : p.onlineCount);
  return (
    <>
      <header className="relative z-10 flex h-[52px] shrink-0 items-center gap-4 border-b border-white/5 bg-[var(--graphite)] px-4 text-[#eef1f5] max-[1120px]:gap-2.5 max-[1120px]:px-3 [@media(max-height:680px)]:h-[46px]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-content-center rounded-lg text-white shadow-[0_2px_8px_rgba(47,111,237,0.45)] [background:linear-gradient(135deg,#3b7bff,#2353c4)]">
            <IconBrand size={18} />
          </span>
          <strong className="text-[15px] font-semibold tracking-wide whitespace-nowrap max-[960px]:hidden">
            浏览器工作台
          </strong>
          <span className="shrink-0 text-[11px] tabular-nums text-[#9aa3b0]">v{p.version}</span>
          <span
            className="inline-block h-6 max-w-[360px] truncate rounded-md border border-white/10 bg-white/[0.08] px-2.5 leading-[22px] text-xs font-semibold text-[#e6ebf2] max-[1200px]:max-w-[240px] max-[960px]:max-w-[140px]"
            aria-label="当前模块"
          >
            {p.breadcrumbText}
          </span>
        </div>
        {p.onSwitchCarrier && (
          <div
            className="inline-flex shrink-0 items-center gap-0.5 rounded-[7px] border border-white/15 bg-white/[0.06] p-0.5"
            role="tablist"
            aria-label="切换操作载体"
          >
            {[
              {
                id: 'browser' as const,
                label: '浏览器',
                icon: <IconGlobe size={13} />,
                on: p.onlineCount,
                tot: p.totalProfilesCount,
                tit: `切换到 Chrome 浏览器工作台（在线 ${p.onlineCount}/${p.totalProfilesCount}）`,
              },
              {
                id: 'bluestacks' as const,
                label: '蓝蝶',
                icon: <IconSmartphone size={13} />,
                on: bluestacksOnlineCount,
                tot: bluestacksTotalCount,
                tit: `切换到蓝蝶模拟器工作台（在线 ${bluestacksOnlineCount}/${bluestacksTotalCount}）`,
              },
            ].map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={carrier === c.id}
                className={`inline-flex h-6 items-center gap-1 rounded-[5px] border-0 px-2 text-xs whitespace-nowrap transition-colors ${carrier === c.id ? 'bg-[var(--brand)] font-semibold text-white' : 'bg-transparent font-medium text-[#b7c0ce] hover:bg-white/[0.08] hover:text-[#eef1f5]'}`}
                title={c.tit}
                onClick={() => p.onSwitchCarrier?.(c.id)}
              >
                {c.icon}
                <span className="max-[960px]:hidden">{c.label}</span>
                <span className="text-[11px] tabular-nums opacity-85">
                  {c.on}/{c.tot}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 max-[1120px]:gap-1.5">
          {p.busy && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white"
              role="status"
              aria-label="正在处理"
            />
          )}
          <GlobalConcurrencyPopover
            settings={p.schedulerSettings}
            onSave={p.onSaveGlobalConcurrency}
          />
          {p.onOpenWindowLayout && (
            <button
              type="button"
              className={`${TOPBAR_BTN} max-[960px]:px-2`}
              title="打开窗口排版中心（平铺 / 堆叠 / 副屏 / 全部置顶）"
              onClick={p.onOpenWindowLayout}
            >
              <IconLayoutGrid size={13} />
              <span className="max-[960px]:hidden">窗口排版</span>
            </button>
          )}
          {p.onOpenLiveRuns && (
            <button
              type="button"
              className={`${TOPBAR_BTN}${runningCount > 0 ? ' border-blue-500/55 bg-blue-600/25 text-blue-100' : ''}`}
              title="查看当前所有运行中账号的完整步骤待办队列"
              onClick={p.onOpenLiveRuns}
            >
              <IconActivity size={13} />
              <span>{runningCount > 0 ? `运行中 (${runningCount})` : '任务队列'}</span>
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-transparent bg-white/[0.06] px-2.5 text-xs whitespace-nowrap text-[#c8d0da] tabular-nums transition-colors hover:border-white/20 hover:bg-white/[0.13] hover:text-white"
            title={
              p.error
                ? '控制服务连接待刷新，点击查看插件连接与更新'
                : carrier === 'bluestacks'
                  ? '已在线的蓝蝶模拟器 / 全部蓝蝶实例（点击查看连接与更新）'
                  : '已连接的浏览器 / 全部浏览器（点击查看插件连接与更新）'
            }
            onClick={p.onOpenUpdateMenu}
          >
            <i
              className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                p.error
                  ? 'bg-[var(--warn-dot)]'
                  : connOn
                    ? 'bg-[#3ccf7f] shadow-[0_0_0_3px_rgba(60,207,127,0.18)]'
                    : 'bg-[#9aa1aa]'
              }`}
            />
            <span className="max-[960px]:hidden">{p.error ? '连接待刷新' : '服务正常'}</span>
          </button>
          <button
            type="button"
            className="btn btn-icon inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/15 bg-transparent p-0 text-[#e6eaf0] transition-colors hover:border-white/25 hover:bg-white/10"
            aria-label="打开菜单"
            title="菜单：表格与图床、偏好设置、数据清理、插件更新、AI 工作夹、重启等"
            onClick={p.onOpenMenu}
          >
            <IconMenu size={18} />
          </button>
        </div>
      </header>
      {avail && ignoredUpdate !== availKey && (
        <div
          className="flex flex-wrap items-center gap-2.5 border-b border-[#f0d9a3] bg-[var(--warn-soft)] px-4 py-2 text-xs text-slate-800"
          role="status"
        >
          <span>
            发现新版本 v{avail.softwareVersion}
            {avail.extensionVersion ? ' · 插件 v' + avail.extensionVersion : ''}
          </span>
          <Btn
            v="primary"
            disabled={p.updateStatus?.applying || avail.requiresInstaller}
            onClick={() => void p.onApplyUpdate()}
          >
            {p.updateStatus?.applying
              ? '正在下载并更新软件与插件…'
              : avail.requiresInstaller
                ? '需要完整安装包'
                : '一键更新'}
          </Btn>
          <Btn onClick={p.onOpenUpdateMenu}>查看详情</Btn>
          <Btn onClick={() => setIgnoredUpdate(availKey)}>稍后</Btn>
          {p.updateError && <span className="text-rose-700">{p.updateError}</span>}
        </div>
      )}
    </>
  );
}
