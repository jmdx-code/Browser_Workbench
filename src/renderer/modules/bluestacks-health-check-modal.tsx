import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBluestacksHealthReportText,
  healthCategoryLabel,
  isBluestacksPortraitResolution,
  type BluestacksHealthCategory,
  type BluestacksHealthCheckItem,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { ControlledNumberInput } from './shared/controlled-number-input.js';

interface BluestacksHealthCheckModalProps {
  state: BluestacksState;
  selected: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void;
  onChange: (next: BluestacksState) => void;
  onOpenBatchLogin: (instanceIds: string[]) => void;
  onClose: () => void;
}

type CategoryFilter =
  'all' | 'healthy' | 'logged-out' | 'verification' | 'restricted' | 'missing-app' | 'other';

const CATEGORY_STYLE: Record<BluestacksHealthCategory, { color: string; bg: string }> = {
  healthy: { color: '#15803d', bg: 'rgba(34,197,94,0.14)' },
  'logged-out': { color: '#b45309', bg: 'rgba(245,158,11,0.16)' },
  verification: { color: '#c2410c', bg: 'rgba(249,115,22,0.16)' },
  restricted: { color: '#b91c1c', bg: 'rgba(239,68,68,0.14)' },
  'missing-app': { color: '#6d28d9', bg: 'rgba(139,92,246,0.14)' },
  landscape: { color: '#475569', bg: 'rgba(100,116,139,0.15)' },
  'launch-failed': { color: '#b91c1c', bg: 'rgba(239,68,68,0.14)' },
  skipped: { color: '#64748b', bg: 'rgba(148,163,184,0.16)' },
  stopped: { color: '#64748b', bg: 'rgba(148,163,184,0.16)' },
};

function renderItemBadge(item: BluestacksHealthCheckItem) {
  if (item.status === 'queued') {
    return (
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 7px',
          borderRadius: 999,
          color: '#475569',
          background: 'rgba(100,116,139,0.12)',
          whiteSpace: 'nowrap',
        }}
      >
        排队中
      </span>
    );
  }
  if (item.status === 'running') {
    return (
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 7px',
          borderRadius: 999,
          color: '#1d4ed8',
          background: 'rgba(59,130,246,0.14)',
          whiteSpace: 'nowrap',
        }}
      >
        体检中
      </span>
    );
  }
  const cat = item.category ?? 'launch-failed';
  const sty = CATEGORY_STYLE[cat];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 7px',
        borderRadius: 999,
        color: sty.color,
        background: sty.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {healthCategoryLabel(cat)}
    </span>
  );
}

export function BluestacksHealthCheckModal({
  state,
  selected,
  onSelect,
  onChange,
  onOpenBatchLogin,
  onClose,
}: BluestacksHealthCheckModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hc = state.healthCheck ?? null;

  const portraitInstances = useMemo(
    () => state.instances.filter((i) => isBluestacksPortraitResolution(i.fbWidth, i.fbHeight)),
    [state.instances],
  );
  const [scope, setScope] = useState<'selected' | 'portrait' | 'all'>(() =>
    selected.size > 0 ? 'selected' : 'portrait',
  );
  const [maxConcurrency, setMaxConcurrency] = useState(() =>
    Math.max(1, Math.min(5, state.bumperSettings.maxConcurrentProfiles || 3)),
  );
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [autoInstallApk, setAutoInstallApk] = useState(false);
  const [closeOnFinish, setCloseOnFinish] = useState(true);
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) {
      dlg.showModal();
    }
  }, []);

  const targetIds = useMemo(() => {
    if (scope === 'selected') {
      return state.instances.filter((i) => selected.has(i.id)).map((i) => i.id);
    }
    if (scope === 'portrait') {
      return portraitInstances.map((i) => i.id);
    }
    return state.instances.map((i) => i.id);
  }, [scope, state.instances, selected, portraitInstances]);

  const filteredItems = useMemo(() => {
    if (!hc) return [];
    if (catFilter === 'all') return hc.items;
    if (catFilter === 'other') {
      return hc.items.filter(
        (it) =>
          it.category === 'landscape' ||
          it.category === 'launch-failed' ||
          it.category === 'skipped' ||
          it.category === 'stopped',
      );
    }
    return hc.items.filter((it) => it.category === catFilter);
  }, [hc, catFilter]);

  const healthyIds = useMemo(
    () => (hc ? hc.items.filter((i) => i.category === 'healthy').map((i) => i.instanceId) : []),
    [hc],
  );
  const needLoginIds = useMemo(
    () =>
      hc
        ? hc.items
            .filter((i) => i.category === 'logged-out' || i.category === 'missing-app')
            .map((i) => i.instanceId)
        : [],
    [hc],
  );

  async function handleStart() {
    if (targetIds.length === 0) {
      setError('当前范围内没有可体检的蓝蝶实例');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setCatFilter('all');
    try {
      const next = await api.bluestacksAction('health-check/start', {
        instanceIds: targetIds,
        maxConcurrency,
        autoLaunch,
        autoInstallApk,
        closeOnFinish,
      });
      onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动批量体检失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setError('');
    try {
      onChange(await api.bluestacksAction('health-check/stop', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : '停止体检失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyReport() {
    if (!hc) return;
    const text = formatBluestacksHealthReportText(hc);
    try {
      await copyTextToClipboard(text);
      setNotice('已复制体检报表到剪贴板');
    } catch {
      setNotice('复制失败，请重试');
    }
  }

  const isRunning = Boolean(hc?.running);
  const progressPct = hc && hc.total > 0 ? Math.round((hc.completed / hc.total) * 100) : 0;
  const otherCount = hc ? hc.landscape + hc.launchFailed + hc.skipped + hc.stopped : 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      style={{ width: 'min(820px, 94vw)', maxWidth: '94vw', padding: 0 }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '88vh' }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <strong style={{ fontSize: 15 }}>蓝蝶批量健康体检</strong>
            {hc && (
              <span
                style={{
                  fontSize: 12,
                  color: isRunning ? '#1d4ed8' : 'var(--ink-2)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {hc.statusText}
              </span>
            )}
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
          {/* Control Panel */}
          <div
            style={{
              background: 'var(--bg-subtle, rgba(15,23,42,0.03))',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '12px 14px',
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
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
                  体检范围
                </span>
                <div className="segmented">
                  <button
                    type="button"
                    disabled={isRunning}
                    className={scope === 'selected' ? 'active' : ''}
                    onClick={() => setScope('selected')}
                  >
                    已选 ({selected.size})
                  </button>
                  <button
                    type="button"
                    disabled={isRunning}
                    className={scope === 'portrait' ? 'active' : ''}
                    onClick={() => setScope('portrait')}
                  >
                    全部竖屏 ({portraitInstances.length})
                  </button>
                  <button
                    type="button"
                    disabled={isRunning}
                    className={scope === 'all' ? 'active' : ''}
                    onClick={() => setScope('all')}
                  >
                    全部 ({state.instances.length})
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>并发台数</span>
                <ControlledNumberInput
                  value={maxConcurrency}
                  min={1}
                  max={10}
                  defaultValue={3}
                  disabled={isRunning}
                  ariaLabel="体检并发台数"
                  style={{ width: 56 }}
                  onChange={setMaxConcurrency}
                />
                {isRunning ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => void handleStop()}
                  >
                    停止体检
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || targetIds.length === 0}
                    onClick={() => void handleStart()}
                  >
                    开始批量体检 ({targetIds.length})
                  </button>
                )}
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                flexWrap: 'wrap',
                fontSize: 12,
                color: 'var(--ink-2)',
              }}
            >
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <input
                  type="checkbox"
                  checked={autoLaunch}
                  disabled={isRunning}
                  onChange={(e) => setAutoLaunch(e.target.checked)}
                />
                <span>自动拉起离线窗口</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <input
                  type="checkbox"
                  checked={autoInstallApk}
                  disabled={isRunning}
                  onChange={(e) => setAutoInstallApk(e.target.checked)}
                />
                <span>缺 FB Lite 时自动装包修复</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <input
                  type="checkbox"
                  checked={closeOnFinish}
                  disabled={isRunning}
                  onChange={(e) => setCloseOnFinish(e.target.checked)}
                />
                <span>体检完自动关窗释放内存</span>
              </label>
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

          {/* Live Progress + Filter Chips */}
          {hc ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--line)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${progressPct}%`,
                      background: isRunning ? '#2563eb' : '#16a34a',
                      transition: 'width 200ms ease',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(
                    [
                      ['all', `全部 ${hc.total}`],
                      ['healthy', `健康 ${hc.healthy}`],
                      ['logged-out', `未登录 ${hc.loggedOut}`],
                      ['verification', `需验证 ${hc.verification}`],
                      ['restricted', `受限 ${hc.restricted}`],
                      ['missing-app', `缺App ${hc.missingApp}`],
                      ['other', `横屏/失败/跳过 ${otherCount}`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={catFilter === key ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                      style={{ fontSize: 12, padding: '2px 10px' }}
                      onClick={() => setCatFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

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
                      <th style={{ padding: '8px 10px' }}>蓝蝶窗口</th>
                      <th style={{ padding: '8px 10px' }}>体检结论</th>
                      <th style={{ padding: '8px 10px' }}>识别账号 / ID</th>
                      <th style={{ padding: '8px 10px' }}>环境</th>
                      <th style={{ padding: '8px 10px' }}>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          style={{ padding: 20, textAlign: 'center', color: 'var(--ink-2)' }}
                        >
                          当前筛选分类下暂无实例
                        </td>
                      </tr>
                    ) : (
                      filteredItems.map((item) => (
                        <tr key={item.instanceId} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td style={{ padding: '8px 10px', fontWeight: 600 }}>
                            {item.instanceName}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {renderItemBadge(item)}
                              {item.autoRepaired && (
                                <span
                                  style={{
                                    fontSize: 10,
                                    padding: '1px 5px',
                                    borderRadius: 999,
                                    background: 'rgba(14,165,233,0.14)',
                                    color: '#0369a1',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  已自装
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            {item.accountName ? (
                              <div>
                                <div>
                                  {item.accountName}
                                  {item.identityType === 'page'
                                    ? ' · 专页'
                                    : item.identityType === 'personal'
                                      ? ' · 个人'
                                      : ''}
                                </div>
                                {item.numericAccountId && (
                                  <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>
                                    ID: {item.numericAccountId}
                                    {item.managedPageCount && item.managedPageCount > 0
                                      ? ` · ${item.managedPageCount} 专页`
                                      : ''}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--ink-2)' }}>—</span>
                            )}
                          </td>
                          <td
                            style={{
                              padding: '8px 10px',
                              color: 'var(--ink-2)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <div>{item.resolution}</div>
                            <div style={{ fontSize: 11 }}>
                              {item.fbLiteVersion ? `v${item.fbLiteVersion}` : '未检出版本'}
                              {item.androidSdk ? ` · SDK ${item.androidSdk}` : ''}
                            </div>
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--ink-2)' }}>
                            {item.stepText}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div
              style={{
                padding: '28px 16px',
                textAlign: 'center',
                color: 'var(--ink-2)',
                border: '1px dashed var(--line)',
                borderRadius: 10,
                fontSize: 13,
              }}
            >
              选择体检范围并点击「开始批量体检」，系统将按并发槽位自动拉起蓝蝶、检查 FB Lite
              安装与账号健康状态（健康 / 未登录 / 需验证 / 受限 /
              横屏），并可联动定时排班无人值守巡检。
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            padding: '12px 18px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {healthyIds.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onSelect(new Set(healthyIds));
                  setNotice(`已勾选全部 ${healthyIds.length} 台健康蓝蝶窗口`);
                }}
              >
                勾选健康实例 ({healthyIds.length})
              </button>
            )}
            {needLoginIds.length > 0 && !isRunning && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onOpenBatchLogin(needLoginIds)}
              >
                未登录/缺包去批量登录 ({needLoginIds.length})
              </button>
            )}
            {hc && (
              <button type="button" className="btn btn-sm" onClick={() => void handleCopyReport()}>
                复制体检报表
              </button>
            )}
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </dialog>
  );
}
