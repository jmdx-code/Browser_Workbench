import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  bluestacksDisplayTitle,
  type BluestacksDailyInstanceStats,
  type BluestacksRiskLimitOverride,
  type BluestacksRiskLimitSettings,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { ControlledNumberInput } from './shared/controlled-number-input.js';

interface BluestacksRiskDashboardModalProps {
  state: BluestacksState;
  onChange: (next: BluestacksState) => void;
  onClose: () => void;
}

function emptyStats(
  instanceId: string,
  settings: BluestacksRiskLimitSettings,
): BluestacksDailyInstanceStats {
  return {
    instanceId,
    groupBumpsToday: 0,
    pageBumpsToday: 0,
    postsToday: 0,
    invitesToday: 0,
    activeLikesToday: 0,
    activeActionsToday: 0,
    totalActionsToday: 0,
    effectiveLimits: {
      dailyMaxTotalActions: settings.dailyMaxTotalActions,
      dailyMaxBumps: settings.dailyMaxBumps,
      dailyMaxPosts: settings.dailyMaxPosts,
      dailyMaxInvites: settings.dailyMaxInvites,
      dailyMaxActiveLikes: settings.dailyMaxActiveLikes,
    },
    hasOverride: false,
    limitReached: false,
    limitReason: null,
  };
}

export function BluestacksRiskDashboardModal({
  state,
  onChange,
  onClose,
}: BluestacksRiskDashboardModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialSettings = state.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;
  const usage = state.dailyUsage;

  const [enabled, setEnabled] = useState(initialSettings.enabled);
  const [maxTotal, setMaxTotal] = useState(initialSettings.dailyMaxTotalActions);
  const [maxBumps, setMaxBumps] = useState(initialSettings.dailyMaxBumps);
  const [maxPosts, setMaxPosts] = useState(initialSettings.dailyMaxPosts);
  const [maxInvites, setMaxInvites] = useState(initialSettings.dailyMaxInvites);
  const [maxActiveLikes, setMaxActiveLikes] = useState(initialSettings.dailyMaxActiveLikes);
  const [overrides, setOverrides] = useState<Record<string, BluestacksRiskLimitOverride>>(
    initialSettings.perInstanceOverrides ?? {},
  );
  const [editingInstId, setEditingInstId] = useState<string | null>(null);
  const [ovTotal, setOvTotal] = useState(20);
  const [ovBumps, setOvBumps] = useState(10);
  const [ovPosts, setOvPosts] = useState(3);
  const [ovInvites, setOvInvites] = useState(5);
  const [ovLikes, setOvLikes] = useState(10);

  const [search, setSearch] = useState('');
  const [onlyRisky, setOnlyRisky] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.instances
      .map((inst) => ({
        inst,
        title: bluestacksDisplayTitle(inst),
        stat: usage?.perInstance[inst.id] ?? emptyStats(inst.id, initialSettings),
      }))
      .filter(({ inst, title, stat }) => {
        if (onlyRisky) {
          const cap = stat.effectiveLimits.dailyMaxTotalActions;
          const near = cap > 0 && stat.totalActionsToday >= Math.ceil(cap * 0.8);
          if (!stat.limitReached && !near && !stat.hasOverride) return false;
        }
        if (!q) return true;
        return `${title} ${inst.accountName} ${inst.instanceKey}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (a.stat.limitReached !== b.stat.limitReached) return a.stat.limitReached ? -1 : 1;
        if (b.stat.totalActionsToday !== a.stat.totalActionsToday) {
          return b.stat.totalActionsToday - a.stat.totalActionsToday;
        }
        return a.title.localeCompare(b.title);
      });
  }, [state.instances, usage, initialSettings, search, onlyRisky]);

  async function persistLimits(
    nextOverrides: Record<string, BluestacksRiskLimitOverride>,
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.bluestacksAction('risk-limits', {
        enabled,
        dailyMaxTotalActions: maxTotal,
        dailyMaxBumps: maxBumps,
        dailyMaxPosts: maxPosts,
        dailyMaxInvites: maxInvites,
        dailyMaxActiveLikes: maxActiveLikes,
        perInstanceOverrides: nextOverrides,
      });
      onChange(next);
      setNotice('已保存蓝蝶每日风控限额设置，立即生效');
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存风控限额失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startEditOverride(instId: string, currentStat: BluestacksDailyInstanceStats) {
    setEditingInstId(instId);
    setOvTotal(currentStat.effectiveLimits.dailyMaxTotalActions);
    setOvBumps(currentStat.effectiveLimits.dailyMaxBumps);
    setOvPosts(currentStat.effectiveLimits.dailyMaxPosts);
    setOvInvites(currentStat.effectiveLimits.dailyMaxInvites);
    setOvLikes(currentStat.effectiveLimits.dailyMaxActiveLikes);
  }

  async function saveInstanceOverride(instId: string) {
    const nextOverrides: Record<string, BluestacksRiskLimitOverride> = {
      ...overrides,
      [instId]: {
        dailyMaxTotalActions: ovTotal,
        dailyMaxBumps: ovBumps,
        dailyMaxPosts: ovPosts,
        dailyMaxInvites: ovInvites,
        dailyMaxActiveLikes: ovLikes,
      },
    };
    const ok = await persistLimits(nextOverrides);
    if (ok) {
      setOverrides(nextOverrides);
      setEditingInstId(null);
    }
  }

  async function clearInstanceOverride(instId: string) {
    const nextOverrides = { ...overrides };
    delete nextOverrides[instId];
    const ok = await persistLimits(nextOverrides);
    if (ok) {
      setOverrides(nextOverrides);
      setEditingInstId(null);
    }
  }

  const totalBumps = (usage?.totalGroupBumps ?? 0) + (usage?.totalPageBumps ?? 0);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      style={{ width: 'min(900px, 95vw)', maxWidth: '95vw', padding: 0 }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '88vh' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <strong style={{ fontSize: 15 }}>蓝蝶每日风控限额与运行统计</strong>
            <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
              统计日期：{usage?.dateYmd ?? '今日'} · 跨重启持久化计数
            </span>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflowY: 'auto',
          }}
        >
          {/* KPI Strip */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
              gap: 8,
            }}
          >
            {[
              { label: '今日总动作', value: usage?.totalActions ?? 0, tone: '#0f172a' },
              {
                label: '顶贴 (群+页)',
                value: totalBumps,
                sub: `${usage?.totalGroupBumps ?? 0}+${usage?.totalPageBumps ?? 0}`,
                tone: '#1d4ed8',
              },
              { label: '发帖成功', value: usage?.totalPosts ?? 0, tone: '#15803d' },
              { label: '小组邀人', value: usage?.totalInvites ?? 0, tone: '#7c3aed' },
              { label: '活跃点赞', value: usage?.totalActiveLikes ?? 0, tone: '#0369a1' },
              {
                label: '风控休眠台数',
                value: usage?.reachedLimitInstances ?? 0,
                tone: (usage?.reachedLimitInstances ?? 0) > 0 ? '#b91c1c' : '#64748b',
              },
            ].map((kpi) => (
              <div
                key={kpi.label}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '9px 10px',
                  background: 'var(--bg-subtle, rgba(15,23,42,0.025))',
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>{kpi.label}</div>
                <div
                  style={{
                    fontSize: 19,
                    fontWeight: 700,
                    color: kpi.tone,
                    marginTop: 2,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 4,
                  }}
                >
                  <span>{kpi.value}</span>
                  {kpi.sub && (
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--ink-2)' }}>
                      ({kpi.sub})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Global Risk Limit Settings */}
          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '12px 14px',
              background: 'var(--bg-subtle, rgba(15,23,42,0.025))',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <strong>启用单号每日风控安全上限（触达后仅休眠该模拟器，绝不误判封号）</strong>
              </label>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => void persistLimits(overrides)}
              >
                {busy ? '保存中…' : '保存全局风控限额'}
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                gap: 10,
                opacity: enabled ? 1 : 0.55,
              }}
            >
              {[
                { label: '单号日总动作', val: maxTotal, max: 2000, set: setMaxTotal },
                { label: '单号日顶贴上限', val: maxBumps, max: 500, set: setMaxBumps },
                { label: '单号日发帖上限', val: maxPosts, max: 200, set: setMaxPosts },
                { label: '单号日邀人上限', val: maxInvites, max: 300, set: setMaxInvites },
                {
                  label: '单号日活跃赞上限',
                  val: maxActiveLikes,
                  max: 300,
                  set: setMaxActiveLikes,
                },
              ].map((f) => (
                <label
                  key={f.label}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}
                >
                  <span style={{ color: 'var(--ink-2)' }}>{f.label}</span>
                  <ControlledNumberInput
                    value={f.val}
                    min={0}
                    max={f.max}
                    defaultValue={f.val}
                    disabled={!enabled}
                    ariaLabel={f.label}
                    onChange={f.set}
                  />
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>
              提示：任意单项填 <code>0</code>{' '}
              表示该项不单独设限；新号/养号期可点击下方表格右侧「单号限额」设置更保守的专属限额。
            </div>
          </div>

          {error && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(239,68,68,0.1)',
                color: '#b91c1c',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
          {notice && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(34,197,94,0.12)',
                color: '#15803d',
                fontSize: 12,
              }}
            >
              {notice}
            </div>
          )}

          {/* Filter Row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <input
              type="search"
              placeholder="搜索蓝蝶窗口名或账号名…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 240, padding: '5px 9px', fontSize: 12 }}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={onlyRisky}
                onChange={(e) => setOnlyRisky(e.target.checked)}
              />
              <span>仅显示接近上限 / 休眠 / 专属限额实例</span>
            </label>
          </div>

          {/* Per-Instance Table */}
          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 10,
              overflow: 'hidden',
              maxHeight: '42vh',
              overflowY: 'auto',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr
                  style={{
                    background: 'var(--bg-subtle, rgba(15,23,42,0.04))',
                    textAlign: 'left',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <th style={{ padding: '8px 10px' }}>蓝蝶窗口 / 账号</th>
                  <th style={{ padding: '8px 8px', textAlign: 'right' }}>群顶</th>
                  <th style={{ padding: '8px 8px', textAlign: 'right' }}>页顶</th>
                  <th style={{ padding: '8px 8px', textAlign: 'right' }}>发帖</th>
                  <th style={{ padding: '8px 8px', textAlign: 'right' }}>邀人</th>
                  <th style={{ padding: '8px 8px', textAlign: 'right' }}>活跃赞</th>
                  <th style={{ padding: '8px 10px' }}>总计 / 限额</th>
                  <th style={{ padding: '8px 10px' }}>风控状态</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>专属限额</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      style={{ padding: 20, textAlign: 'center', color: 'var(--ink-2)' }}
                    >
                      暂无匹配的蓝蝶实例
                    </td>
                  </tr>
                ) : (
                  rows.map(({ inst, title, stat }) => {
                    const cap = stat.effectiveLimits.dailyMaxTotalActions;
                    const ratio = cap > 0 ? Math.min(1, stat.totalActionsToday / cap) : 0;
                    const near = cap > 0 && ratio >= 0.8 && !stat.limitReached;
                    const isEditing = editingInstId === inst.id;
                    return (
                      <tr
                        key={inst.id}
                        style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'middle' }}
                      >
                        <td style={{ padding: '8px 10px' }}>
                          <div style={{ fontWeight: 600 }}>
                            {title}
                            {stat.hasOverride && (
                              <span
                                style={{
                                  marginLeft: 5,
                                  fontSize: 10,
                                  padding: '1px 5px',
                                  borderRadius: 999,
                                  background: 'rgba(14,165,233,0.14)',
                                  color: '#0369a1',
                                }}
                              >
                                专属
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>
                            {inst.accountName || inst.instanceKey}
                          </div>
                          {isEditing && (
                            <div
                              style={{
                                marginTop: 6,
                                padding: 8,
                                borderRadius: 8,
                                background: 'var(--bg-subtle, rgba(15,23,42,0.04))',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                flexWrap: 'wrap',
                              }}
                            >
                              <span>总</span>
                              <ControlledNumberInput
                                value={ovTotal}
                                min={0}
                                max={2000}
                                defaultValue={ovTotal}
                                ariaLabel="单号总动作上限"
                                style={{ width: 52 }}
                                onChange={setOvTotal}
                              />
                              <span>顶</span>
                              <ControlledNumberInput
                                value={ovBumps}
                                min={0}
                                max={500}
                                defaultValue={ovBumps}
                                ariaLabel="单号顶贴上限"
                                style={{ width: 48 }}
                                onChange={setOvBumps}
                              />
                              <span>帖</span>
                              <ControlledNumberInput
                                value={ovPosts}
                                min={0}
                                max={200}
                                defaultValue={ovPosts}
                                ariaLabel="单号发帖上限"
                                style={{ width: 48 }}
                                onChange={setOvPosts}
                              />
                              <span>邀</span>
                              <ControlledNumberInput
                                value={ovInvites}
                                min={0}
                                max={300}
                                defaultValue={ovInvites}
                                ariaLabel="单号邀人上限"
                                style={{ width: 48 }}
                                onChange={setOvInvites}
                              />
                              <span>赞</span>
                              <ControlledNumberInput
                                value={ovLikes}
                                min={0}
                                max={300}
                                defaultValue={ovLikes}
                                ariaLabel="单号点赞上限"
                                style={{ width: 48 }}
                                onChange={setOvLikes}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={busy}
                                onClick={() => void saveInstanceOverride(inst.id)}
                              >
                                应用
                              </button>
                              {stat.hasOverride && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={busy}
                                  onClick={() => void clearInstanceOverride(inst.id)}
                                >
                                  恢复全局
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => setEditingInstId(null)}
                              >
                                取消
                              </button>
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                          {stat.groupBumpsToday}
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                          {stat.pageBumpsToday}
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                          {stat.postsToday}
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                          {stat.invitesToday}
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                          {stat.activeLikesToday}
                        </td>
                        <td style={{ padding: '8px 10px', minWidth: 110 }}>
                          <div style={{ fontWeight: 600 }}>
                            {stat.totalActionsToday} / {cap > 0 ? cap : '不限'}
                          </div>
                          {cap > 0 && (
                            <div
                              style={{
                                height: 4,
                                marginTop: 3,
                                borderRadius: 999,
                                background: 'var(--line)',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  height: '100%',
                                  width: `${Math.round(ratio * 100)}%`,
                                  background: stat.limitReached
                                    ? '#dc2626'
                                    : near
                                      ? '#d97706'
                                      : '#16a34a',
                                }}
                              />
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          {stat.limitReached ? (
                            <span
                              title={stat.limitReason ?? undefined}
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: '2px 7px',
                                borderRadius: 999,
                                color: '#b91c1c',
                                background: 'rgba(239,68,68,0.14)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              风控休眠
                            </span>
                          ) : near ? (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: '2px 7px',
                                borderRadius: 999,
                                color: '#b45309',
                                background: 'rgba(245,158,11,0.16)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              接近上限
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: '2px 7px',
                                borderRadius: 999,
                                color: '#15803d',
                                background: 'rgba(34,197,94,0.14)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              安全
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ fontSize: 11, padding: '1px 7px' }}
                            onClick={() =>
                              isEditing ? setEditingInstId(null) : startEditOverride(inst.id, stat)
                            }
                          >
                            {isEditing ? '收起' : stat.hasOverride ? '调整' : '单号限额'}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </dialog>
  );
}
