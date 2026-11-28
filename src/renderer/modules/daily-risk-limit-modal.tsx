import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import {
  DAILY_RISK_RULE_KEYS,
  DEFAULT_DAILY_RISK_LIMIT_SETTINGS,
  ZERO_DAILY_ACTION_COUNTS,
  type BrowserRiskLimitsState,
  type DailyRiskLimitOverride,
  type DailyRiskLimitRule,
  type DailyRiskLimitSettings,
  type TargetDailyUsage,
} from '../../shared/daily-risk-limits.js';
import { api } from '../api.js';
import { UI_HINT, UI_INPUT_SM, UI_ROW_BT, UiSwitch } from '../ui/primitives.js';
import {
  BackdropModal,
  Btn,
  Chk,
  CtrlNum,
  DataTbl,
  InFld,
  ModalHeading,
  NoticeBanner,
  TonePill,
  errMsg,
  useBusyTask,
} from './shared/module-ui.js';
export type DailyRiskTargetItem = { id: string; title: string; subtitle?: string };
const RULE_SPECS: ReadonlyArray<
  readonly [string, string, string, keyof DailyRiskLimitRule, number, number]
> = [
  ['总', '每日总动作上限', '总动作上限', 'dailyMaxTotalActions', 2000, 60],
  ['顶', '每日顶贴上限', '顶贴上限', 'dailyMaxBumps', 500, 30],
  ['帖', '每日发帖上限', '发帖上限', 'dailyMaxPosts', 200, 10],
  ['邀', '每日邀人上限', '邀人上限', 'dailyMaxInvites', 300, 20],
  ['赞', '每日活跃点赞上限', '点赞上限', 'dailyMaxActiveLikes', 300, 25],
];
const emptyUsage = (targetId: string, rules: DailyRiskLimitRule): TargetDailyUsage => ({
  targetId,
  ...ZERO_DAILY_ACTION_COUNTS,
  totalActionsToday: 0,
  effectiveLimits: { ...rules },
  hasOverride: false,
  limitReached: false,
  limitReason: null,
});
export function DailyRiskLimitModal(p: {
  carrier: 'browser' | 'bluestacks';
  targets: readonly DailyRiskTargetItem[];
  bluestacksState?: BluestacksState;
  onBluestacksChange?: (next: BluestacksState) => void;
  onBrowserSaved?: (next: BrowserRiskLimitsState) => void;
  onNotify?: (msg: string) => void;
  onClose: () => void;
}) {
  const isBs = p.carrier === 'bluestacks';
  const [browserData, setBrowserData] = useState<BrowserRiskLimitsState | null>(null);
  const [loadingBrowser, setLoadingBrowser] = useState(!isBs);
  const [loadErr, setLoadErr] = useState('');
  const [search, setSearch] = useState('');
  const [showOverrides, setShowOverrides] = useState(true);
  const [onlyRisky, setOnlyRisky] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ov, setOv] = useState<DailyRiskLimitOverride>({});
  const { busy, error, notice, setNotice, run } = useBusyTask();
  const bsInit = p.bluestacksState?.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;
  const [cfg, setCfg] = useState<DailyRiskLimitSettings>(() =>
    isBs
      ? {
          enabled: bsInit.enabled,
          dailyMaxTotalActions: bsInit.dailyMaxTotalActions,
          dailyMaxBumps: bsInit.dailyMaxBumps,
          dailyMaxPosts: bsInit.dailyMaxPosts,
          dailyMaxInvites: bsInit.dailyMaxInvites,
          dailyMaxActiveLikes: bsInit.dailyMaxActiveLikes,
          perTargetOverrides: bsInit.perInstanceOverrides ?? {},
        }
      : DEFAULT_DAILY_RISK_LIMIT_SETTINGS,
  );
  useEffect(() => {
    if (isBs) return;
    const ctrl = new AbortController();
    setLoadingBrowser(true);
    setLoadErr('');
    void api.browserRiskLimits(ctrl.signal).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        setBrowserData(res);
        setCfg(res.settings);
        setLoadingBrowser(false);
      },
      (e) => {
        if (!ctrl.signal.aborted) {
          setLoadErr(errMsg(e, '加载浏览器日限额失败'));
          setLoadingBrowser(false);
        }
      },
    );
    return () => ctrl.abort();
  }, [isBs]);
  const usageById = useMemo(() => {
    const out = new Map<string, TargetDailyUsage>();
    if (isBs) {
      for (const [id, u] of Object.entries(p.bluestacksState?.dailyUsage?.perInstance ?? {})) {
        out.set(id, { ...u, targetId: id });
      }
    } else if (browserData) {
      for (const [id, u] of Object.entries(browserData.dailyUsage.perTarget)) out.set(id, u);
    }
    return out;
  }, [isBs, p.bluestacksState?.dailyUsage, browserData]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return p.targets
      .map((t) => ({ target: t, stat: usageById.get(t.id) ?? emptyUsage(t.id, cfg) }))
      .filter(({ target, stat }) => {
        if (onlyRisky && !stat.limitReached && !stat.hasOverride) return false;
        return (
          !q || `${target.title} ${target.subtitle ?? ''} ${target.id}`.toLowerCase().includes(q)
        );
      })
      .sort((a, b) =>
        a.stat.limitReached !== b.stat.limitReached
          ? a.stat.limitReached
            ? -1
            : 1
          : b.stat.totalActionsToday - a.stat.totalActionsToday ||
            a.target.title.localeCompare(b.target.title),
      );
  }, [p.targets, usageById, cfg, search, onlyRisky]);
  const persist = async (nextOverrides = cfg.perTargetOverrides) => {
    setNotice('');
    return run(async () => {
      if (isBs) {
        const { perTargetOverrides: _, ...rules } = cfg;
        const nextBs = await api.bluestacksAction('risk-limits', {
          ...rules,
          perInstanceOverrides: nextOverrides,
        });
        setCfg((prev) => ({ ...prev, perTargetOverrides: nextOverrides }));
        p.onBluestacksChange?.(nextBs);
      } else {
        const next = await api.saveBrowserRiskLimits({ ...cfg, perTargetOverrides: nextOverrides });
        setBrowserData(next);
        setCfg(next.settings);
        p.onBrowserSaved?.(next);
      }
      const okMsg = `已保存${isBs ? '蓝蝶' : '浏览器'}每日安全限额设置`;
      setNotice(okMsg);
      p.onNotify?.(okMsg);
    }, '保存日限额设置失败');
  };
  const applyOverride = async (id: string, nextVal: DailyRiskLimitOverride | null) => {
    const nextOverrides = { ...cfg.perTargetOverrides };
    if (nextVal) nextOverrides[id] = nextVal;
    else delete nextOverrides[id];
    if (await persist(nextOverrides)) setEditingId(null);
  };
  const reachedCount = [...usageById.values()].filter((u) => u.limitReached).length;
  const overrideCount = Object.keys(cfg.perTargetOverrides).length;
  return (
    <BackdropModal
      label="单号日限额设置"
      modalClass="w-[min(880px,95vw)]"
      busy={busy}
      onClose={p.onClose}
    >
      <ModalHeading
        title={`每日安全限额设置（${isBs ? '蓝蝶模拟器' : 'Chrome 浏览器'}）`}
        className="px-0 pt-0 pb-1"
        disabled={busy}
        onClose={p.onClose}
      />
      <p className="m-0 text-xs text-[var(--text-3)]">
        默认按全局日限额执行，超限账号将自动休眠跳过（不误判封号）。可在下方为单个窗口设置单独覆盖限额；填
        0 表示该单项不限制。
      </p>
      {(loadErr || error) && <NoticeBanner tone="err">{loadErr || error}</NoticeBanner>}
      {notice && <NoticeBanner tone="ok">{notice}</NoticeBanner>}
      <div className="rounded-xl border border-[var(--line)] bg-slate-50/70 p-3">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <UiSwitch
              checked={cfg.enabled}
              disabled={busy || loadingBrowser}
              label="开启日限额保护"
              onCheckedChange={(enabled) => setCfg((prev) => ({ ...prev, enabled }))}
            />
            {reachedCount > 0 && (
              <TonePill label={`今日已休眠 ${reachedCount} 个`} color="#c53030" bg="#fff5f5" />
            )}
            {overrideCount > 0 && (
              <TonePill label={`单号覆盖 ${overrideCount} 个`} color="#255fd6" bg="#e9f0fe" />
            )}
          </div>
          <Btn
            v="primary"
            disabled={busy || loadingBrowser}
            onClick={() => void persist(cfg.perTargetOverrides)}
          >
            {busy ? '保存中…' : '保存全局限额'}
          </Btn>
        </div>
        <div className="grid grid-cols-5 gap-2 max-[760px]:grid-cols-2">
          {RULE_SPECS.map(([, label, short, key, max, def]) => (
            <CtrlNum
              key={key}
              label={label}
              aria={short}
              val={cfg[key]}
              min={0}
              max={max}
              def={def}
              disabled={busy || loadingBrowser}
              onChange={(n) => setCfg((prev) => ({ ...prev, [key]: n }))}
            />
          ))}
        </div>
      </div>
      <div className={UI_ROW_BT}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs font-semibold text-slate-700 hover:text-slate-900"
            onClick={() => setShowOverrides((v) => !v)}
          >
            {showOverrides ? '▾' : '▸'} 单号单独限额与今日进度 ({rows.length})
          </button>
          <Chk checked={onlyRisky} onChange={setOnlyRisky} label="仅看已触发/已单独覆盖" />
        </div>
        {showOverrides && (
          <input
            type="search"
            className={`${UI_INPUT_SM} w-52`}
            placeholder="搜索窗口或账号名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {showOverrides && (
        <DataTbl
          headers={[
            '窗口 / 账号',
            '今日动作 (总/顶/帖/邀/赞)',
            '生效上限 (总/顶/帖/邀/赞)',
            '状态',
            '操作',
          ]}
          rows={rows}
          empty={loadingBrowser ? '加载中…' : '暂无匹配的窗口'}
          wrapClass="max-h-[300px] overflow-auto rounded-lg border border-[var(--line)] bg-white"
          renderRow={({ target, stat }) => {
            const ovRule = cfg.perTargetOverrides[target.id];
            const isEd = editingId === target.id;
            return (
              <tr key={target.id} className="hover:bg-slate-50/70">
                <td className="px-2.5 py-1.5 align-middle">
                  <div className="font-medium text-[var(--text)]">{target.title}</div>
                  {target.subtitle && <div className={UI_HINT}>{target.subtitle}</div>}
                </td>
                <td className="px-2.5 py-1.5 align-middle font-mono text-[11px] tabular-nums text-[var(--text-2)]">
                  <strong className="text-[var(--text)]">{stat.totalActionsToday}</strong> /{' '}
                  {stat.groupBumpsToday + stat.pageBumpsToday} / {stat.postsToday} /{' '}
                  {stat.invitesToday} / {stat.activeLikesToday}
                </td>
                <td
                  className="px-2.5 py-1.5 align-middle font-mono text-[11px] tabular-nums text-[var(--text-3)]"
                  title="顺序：总动作 / 顶贴 / 发帖 / 邀人 / 活跃点赞（0 表示不限）"
                >
                  {DAILY_RISK_RULE_KEYS.map((k) => ovRule?.[k] ?? cfg[k]).join(' / ')}
                  {ovRule && (
                    <span className="ml-1.5 rounded bg-blue-50 px-1 py-0.5 text-[10px] font-sans text-blue-700">
                      单独
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-1.5 align-middle">
                  {stat.limitReached ? (
                    <TonePill
                      label="已达上限"
                      color="#c53030"
                      bg="#fff5f5"
                      title={stat.limitReason ?? undefined}
                    />
                  ) : (
                    <TonePill label="正常" color="#1f9d55" bg="#e5f5ec" />
                  )}
                </td>
                <td className="px-2.5 py-1.5 align-middle whitespace-nowrap">
                  <div className="flex items-center gap-1">
                    <Btn
                      disabled={busy}
                      onClick={() =>
                        isEd
                          ? setEditingId(null)
                          : (setOv({ ...(ovRule ?? {}) }), setEditingId(target.id))
                      }
                    >
                      {isEd ? '收起' : ovRule ? '改单独限额' : '单独设置'}
                    </Btn>
                    {ovRule && (
                      <Btn
                        v="ghost"
                        disabled={busy}
                        onClick={() => void applyOverride(target.id, null)}
                      >
                        清除
                      </Btn>
                    )}
                  </div>
                </td>
              </tr>
            );
          }}
        />
      )}
      {editingId && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50/40 p-2.5">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-800">
            <span>
              编辑单号限额：{p.targets.find((t) => t.id === editingId)?.title ?? editingId}
            </span>
            <span className="font-normal text-[var(--text-3)]">留空则沿用上方全局值</span>
          </div>
          <div className="grid grid-cols-5 gap-2 max-[760px]:grid-cols-2">
            {RULE_SPECS.map(([, label, , key, max]) => (
              <InFld
                key={key}
                label={label}
                wrapClass="flex flex-col gap-1 text-[11px] text-[var(--text-2)]"
                type="number"
                min={0}
                max={max}
                className={UI_INPUT_SM}
                placeholder={`全局 ${cfg[key]}`}
                value={ov[key] ?? ''}
                onVal={(val) => {
                  const raw = val.trim();
                  setOv((prev) => {
                    const next = { ...prev };
                    if (!raw) delete next[key];
                    else next[key] = Math.max(0, Math.min(max, Math.round(Number(raw) || 0)));
                    return next;
                  });
                }}
              />
            ))}
          </div>
          <div className="flex justify-end gap-1.5">
            <Btn disabled={busy} onClick={() => setEditingId(null)}>
              取消
            </Btn>
            <Btn
              v="primary"
              disabled={busy}
              onClick={() => void applyOverride(editingId, Object.keys(ov).length > 0 ? ov : null)}
            >
              保存该单号限额
            </Btn>
          </div>
        </div>
      )}
    </BackdropModal>
  );
}
