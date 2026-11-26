import { useMemo, useState } from 'react';
import {
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  bluestacksDisplayTitle,
  type BluestacksDailyInstanceStats,
  type BluestacksRiskLimitOverride,
  type BluestacksRiskLimitSettings,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { UI_CARD, UI_INPUT_SM } from '../ui/primitives.js';
import {
  Btn,
  Chk,
  CtrlNum,
  DataTbl,
  NativeModalShell,
  TonePill,
  useBusyTask,
} from './shared/module-ui.js';

const emptyStats = (
  instanceId: string,
  s: BluestacksRiskLimitSettings,
): BluestacksDailyInstanceStats => ({
  instanceId,
  groupBumpsToday: 0,
  pageBumpsToday: 0,
  postsToday: 0,
  invitesToday: 0,
  activeLikesToday: 0,
  activeActionsToday: 0,
  totalActionsToday: 0,
  effectiveLimits: {
    dailyMaxTotalActions: s.dailyMaxTotalActions,
    dailyMaxBumps: s.dailyMaxBumps,
    dailyMaxPosts: s.dailyMaxPosts,
    dailyMaxInvites: s.dailyMaxInvites,
    dailyMaxActiveLikes: s.dailyMaxActiveLikes,
  },
  hasOverride: false,
  limitReached: false,
  limitReason: null,
});

const LIMIT_SPECS: ReadonlyArray<
  readonly [string, string, string, keyof BluestacksRiskLimitOverride, number, number]
> = [
  ['总', '单号日总动作', '单号总动作上限', 'dailyMaxTotalActions', 2000, 52],
  ['顶', '单号日顶贴上限', '单号顶贴上限', 'dailyMaxBumps', 500, 48],
  ['帖', '单号日发帖上限', '单号发帖上限', 'dailyMaxPosts', 200, 48],
  ['邀', '单号日邀人上限', '单号邀人上限', 'dailyMaxInvites', 300, 48],
  ['赞', '单号日活跃赞上限', '单号点赞上限', 'dailyMaxActiveLikes', 300, 48],
];

export function BluestacksRiskDashboardModal({
  state,
  onChange,
  onClose,
}: {
  state: BluestacksState;
  onChange: (next: BluestacksState) => void;
  onClose: () => void;
}) {
  const init = state.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;
  const usage = state.dailyUsage;
  const [cfg, setCfg] = useState<BluestacksRiskLimitSettings>(init);
  const [editingInstId, setEditingInstId] = useState<string | null>(null);
  const [ov, setOv] = useState<BluestacksRiskLimitOverride>({
    dailyMaxTotalActions: 20,
    dailyMaxBumps: 10,
    dailyMaxPosts: 3,
    dailyMaxInvites: 5,
    dailyMaxActiveLikes: 10,
  });
  const [search, setSearch] = useState('');
  const [onlyRisky, setOnlyRisky] = useState(false);
  const { busy, error, notice, setNotice, run } = useBusyTask();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.instances
      .map((inst) => ({
        inst,
        title: bluestacksDisplayTitle(inst),
        stat: usage?.perInstance[inst.id] ?? emptyStats(inst.id, init),
      }))
      .filter(({ inst, title, stat }) => {
        const cap = stat.effectiveLimits.dailyMaxTotalActions;
        if (
          onlyRisky &&
          !stat.limitReached &&
          !(cap > 0 && stat.totalActionsToday >= Math.ceil(cap * 0.8)) &&
          !stat.hasOverride
        )
          return false;
        return !q || `${title} ${inst.accountName} ${inst.instanceKey}`.toLowerCase().includes(q);
      })
      .sort((a, b) =>
        a.stat.limitReached !== b.stat.limitReached
          ? a.stat.limitReached
            ? -1
            : 1
          : b.stat.totalActionsToday - a.stat.totalActionsToday || a.title.localeCompare(b.title),
      );
  }, [state.instances, usage, init, search, onlyRisky]);

  const persistLimits = (perInstanceOverrides = cfg.perInstanceOverrides ?? {}) => {
    setNotice('');
    return run(async () => {
      onChange(await api.bluestacksAction('risk-limits', { ...cfg, perInstanceOverrides }));
      setNotice('已保存蓝蝶每日风控限额设置，立即生效');
    }, '保存风控限额失败');
  };

  async function updateOverride(instId: string, nextVal: BluestacksRiskLimitOverride | null) {
    const nextOverrides = { ...(cfg.perInstanceOverrides ?? {}) };
    if (nextVal) nextOverrides[instId] = nextVal;
    else delete nextOverrides[instId];
    if (await persistLimits(nextOverrides)) {
      setCfg((p) => ({ ...p, perInstanceOverrides: nextOverrides }));
      setEditingInstId(null);
    }
  }

  const kpis: Array<[string, number, string, string?]> = [
    ['今日总动作', usage?.totalActions ?? 0, '#0f172a'],
    [
      '顶贴 (群+页)',
      (usage?.totalGroupBumps ?? 0) + (usage?.totalPageBumps ?? 0),
      '#1d4ed8',
      `${usage?.totalGroupBumps ?? 0}+${usage?.totalPageBumps ?? 0}`,
    ],
    ['发帖成功', usage?.totalPosts ?? 0, '#15803d'],
    ['小组邀人', usage?.totalInvites ?? 0, '#7c3aed'],
    ['活跃点赞', usage?.totalActiveLikes ?? 0, '#0369a1'],
    [
      '风控休眠台数',
      usage?.reachedLimitInstances ?? 0,
      (usage?.reachedLimitInstances ?? 0) > 0 ? '#b91c1c' : '#64748b',
    ],
  ];

  return (
    <NativeModalShell
      width="min(900px, 95vw)"
      error={error}
      notice={notice}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <span>蓝蝶每日风控限额与运行统计</span>
          <span className="text-xs font-normal text-[var(--text-2)]">
            统计日期：{usage?.dateYmd ?? '今日'} · 跨重启持久化计数
          </span>
        </span>
      }
    >
      <div className="grid grid-cols-6 gap-2 max-[720px]:grid-cols-3">
        {kpis.map(([label, value, color, sub]) => (
          <div
            key={label}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-2"
          >
            <div className="text-[11px] text-[var(--text-2)]">{label}</div>
            <div
              className="mt-0.5 flex items-baseline gap-1 text-[19px] font-bold tabular-nums"
              style={{ color }}
            >
              <span>{value}</span>
              {sub && <span className="text-[11px] font-normal text-[var(--text-2)]">({sub})</span>}
            </div>
          </div>
        ))}
      </div>
      <div className={`${UI_CARD} flex flex-col gap-2.5 bg-[var(--surface-2)] px-3.5 py-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Chk
            className="text-[13px] font-semibold text-slate-900"
            label="启用单号每日风控安全上限（触达后仅休眠该模拟器，绝不误判封号）"
            checked={cfg.enabled}
            onChange={(enabled) => setCfg((p) => ({ ...p, enabled }))}
          />
          <Btn v="primary" disabled={busy} onClick={() => void persistLimits()}>
            {busy ? '保存中…' : '保存全局风控限额'}
          </Btn>
        </div>
        <div
          className="grid grid-cols-5 gap-2.5 max-[680px]:grid-cols-2"
          style={{ opacity: cfg.enabled ? 1 : 0.55 }}
        >
          {LIMIT_SPECS.map(([, label, , key, max]) => (
            <label key={key} className="flex flex-col gap-1 text-xs">
              <span className="text-[var(--text-2)]">{label}</span>
              <CtrlNum
                val={cfg[key] ?? 0}
                min={0}
                max={max}
                disabled={!cfg.enabled}
                aria={label}
                onChange={(v) => setCfg((p) => ({ ...p, [key]: v }))}
              />
            </label>
          ))}
        </div>
        <div className="text-[11px] text-[var(--text-2)]">
          提示：任意单项填 <code>0</code>{' '}
          表示该项不单独设限；新号/养号期可点击下方表格右侧「单号限额」设置更保守的专属限额。
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <input
          type="search"
          placeholder="搜索蓝蝶窗口名或账号名…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${UI_INPUT_SM} w-[240px]`}
        />
        <Chk
          label="仅显示接近上限 / 休眠 / 专属限额实例"
          checked={onlyRisky}
          onChange={setOnlyRisky}
        />
      </div>
      <DataTbl
        headers={[
          '蓝蝶窗口 / 账号',
          '群顶',
          '页顶',
          '发帖',
          '邀人',
          '活跃赞',
          '总计 / 限额',
          '风控状态',
          '专属限额',
        ]}
        rows={rows}
        empty="暂无匹配的蓝蝶实例"
        renderRow={({ inst, title, stat }) => {
          const cap = stat.effectiveLimits.dailyMaxTotalActions;
          const ratio = cap > 0 ? Math.min(1, stat.totalActionsToday / cap) : 0;
          const near = cap > 0 && ratio >= 0.8 && !stat.limitReached;
          const isEditing = editingInstId === inst.id;
          return (
            <tr key={inst.id} className="align-middle">
              <td className="px-2.5 py-2">
                <div className="font-semibold">
                  {title}
                  {stat.hasOverride && (
                    <span className="ml-1.5">
                      <TonePill label="专属" color="#0369a1" bg="rgba(14,165,233,0.14)" />
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--text-2)]">
                  {inst.accountName || inst.instanceKey}
                </div>
                {isEditing && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg bg-[var(--surface-2)] p-2">
                    {LIMIT_SPECS.map(([short, , aria, key, max, w]) => (
                      <span key={short} className="inline-flex items-center gap-1">
                        <span>{short}</span>
                        <CtrlNum
                          val={ov[key] ?? 0}
                          min={0}
                          max={max}
                          aria={aria}
                          style={{ width: w }}
                          onChange={(v) => setOv((prev) => ({ ...prev, [key]: v }))}
                        />
                      </span>
                    ))}
                    <Btn
                      v="primary"
                      disabled={busy}
                      onClick={() => void updateOverride(inst.id, ov)}
                    >
                      应用
                    </Btn>
                    {stat.hasOverride && (
                      <Btn disabled={busy} onClick={() => void updateOverride(inst.id, null)}>
                        恢复全局
                      </Btn>
                    )}
                    <Btn v="ghost" onClick={() => setEditingInstId(null)}>
                      取消
                    </Btn>
                  </div>
                )}
              </td>
              {[
                stat.groupBumpsToday,
                stat.pageBumpsToday,
                stat.postsToday,
                stat.invitesToday,
                stat.activeLikesToday,
              ].map((n, i) => (
                <td key={i} className="px-2.5 py-2 tabular-nums">
                  {n}
                </td>
              ))}
              <td className="min-w-[110px] px-2.5 py-2 tabular-nums">
                <div className="font-semibold">
                  {stat.totalActionsToday} / {cap > 0 ? cap : '不限'}
                </div>
                {cap > 0 && (
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full transition-all"
                      style={{
                        width: `${Math.round(ratio * 100)}%`,
                        background: stat.limitReached ? '#dc2626' : near ? '#d97706' : '#16a34a',
                      }}
                    />
                  </div>
                )}
              </td>
              <td className="px-2.5 py-2">
                {stat.limitReached ? (
                  <TonePill
                    title={stat.limitReason ?? undefined}
                    label="风控休眠"
                    color="#b91c1c"
                    bg="rgba(239,68,68,0.14)"
                  />
                ) : near ? (
                  <TonePill label="接近上限" color="#b45309" bg="rgba(245,158,11,0.16)" />
                ) : (
                  <TonePill label="安全" color="#15803d" bg="rgba(34,197,94,0.14)" />
                )}
              </td>
              <td className="px-2.5 py-2">
                <Btn
                  className="px-2 py-0.5 text-[11px]"
                  onClick={() => {
                    if (isEditing) return setEditingInstId(null);
                    setEditingInstId(inst.id);
                    setOv({ ...stat.effectiveLimits });
                  }}
                >
                  {isEditing ? '收起' : stat.hasOverride ? '调整' : '单号限额'}
                </Btn>
              </td>
            </tr>
          );
        }}
      />
    </NativeModalShell>
  );
}
