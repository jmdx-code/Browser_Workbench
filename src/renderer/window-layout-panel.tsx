import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import { api } from './api.js';
import {
  defaultWindowLayout,
  WindowLayoutOverview,
  windowLayoutMessage,
} from '../shared/window-layout.js';

export function WindowLayoutPanel({
  selected,
  profiles,
}: {
  selected: ReadonlySet<string>;
  profiles: Profile[];
}) {
  const [overview, setOverview] = useState<z.infer<typeof WindowLayoutOverview> | null>(null);
  const [settings, setSettings] = useState(
    defaultWindowLayout as z.infer<typeof WindowLayoutOverview>['settings'],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load() {
    setBusy(true);
    try {
      const value = await api.windowLayout();
      setOverview(value);
      setSettings({
        ...value.settings,
        displayId: value.settings.displayId ?? value.displays.find((d) => d.primary)?.id ?? null,
      });
      setError(value.error ? windowLayoutMessage(value.error) : '');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (busy) return;
    let live = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void api
        .windowLayout()
        .then((value) => {
          if (live) setOverview(value);
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    }, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [busy]);
  async function run(action: 'configure' | 'apply' | 'restore') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action !== 'restore') await api.windowLayout({ action: 'configure', settings });
      const value =
        action === 'configure'
          ? await api.windowLayout()
          : await api.windowLayout({
              action,
              ...(action === 'apply' ? { profileIds: [...selected] } : {}),
            });
      setOverview(value);
      setSettings(value.settings);
      setNotice(
        action === 'restore'
          ? '已关闭自动恢复，窗口保留当前位置。'
          : action === 'apply'
            ? '已整理窗口，过大的窗口已适当缩小。请保持部分网页露出。'
            : '设置已保存。更换区域后，请选择浏览器并点击“整理已选”应用到现有窗口；新任务会按设置整理。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const display = overview?.displays.find((d) => d.id === settings.displayId);
  const area = settings.reservedArea ?? display?.workArea;
  return (
    <div className="menu-panel window-layout-panel">
      <h3>任务窗口露边布局</h3>
      <p className="muted">
        主屏、副屏均可。检测到任务页不可见时，激活并就近移动露边；过大的窗口适当缩小。请尽量保留一部分网页不被其他软件盖住。
      </p>
      <label>
        目标屏幕
        <select
          disabled={busy}
          value={settings.displayId ?? ''}
          onChange={(e) =>
            setSettings({ ...settings, displayId: e.target.value || null, reservedArea: undefined })
          }
        >
          <option value="">请选择屏幕</option>
          {overview?.displays.map((d, i) => (
            <option key={d.id} value={d.id}>
              {d.primary ? '主屏' : `副屏 ${i + 1}`} · {d.workArea.width} × {d.workArea.height} ·{' '}
              {Math.round(d.scaleFactor * 100)}%
            </option>
          ))}
        </select>
      </label>
      {display && area && (
        <fieldset disabled={busy}>
          <legend>浏览器保留区域</legend>
          <label>
            <input
              type="checkbox"
              checked={!!settings.reservedArea}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  reservedArea: e.target.checked ? { ...display.workArea } : undefined,
                })
              }
            />
            自定义区域（关闭时使用整个可用屏幕）
          </label>
          {settings.reservedArea && (
            <>
              {(['x', 'y', 'width', 'height'] as const).map((key) => (
                <label key={key}>
                  {{ x: '距屏幕左侧', y: '距屏幕顶部', width: '宽度', height: '高度' }[key]}
                  （逻辑像素）
                  <input
                    type="number"
                    min={key === 'width' || key === 'height' ? 100 : 0}
                    step={1}
                    value={
                      key === 'x' || key === 'y' ? area[key] - display.workArea[key] : area[key]
                    }
                    onChange={(e) => {
                      const value = e.target.valueAsNumber;
                      if (Number.isFinite(value))
                        setSettings({
                          ...settings,
                          reservedArea: {
                            ...area,
                            [key]: value + (key === 'x' || key === 'y' ? display.workArea[key] : 0),
                          },
                        });
                    }}
                  />
                </label>
              ))}
              <button
                className="btn"
                type="button"
                onClick={() => setSettings({ ...settings, reservedArea: { ...display.workArea } })}
              >
                填入整个可用屏幕
              </button>
            </>
          )}
          <svg
            role="img"
            aria-label="保留区域预览"
            viewBox={`0 0 ${display.workArea.width} ${display.workArea.height}`}
            style={{ width: '100%', maxHeight: 160 }}
          >
            <rect width={display.workArea.width} height={display.workArea.height} fill="#30343b" />
            <rect
              x={area.x - display.workArea.x}
              y={area.y - display.workArea.y}
              width={area.width}
              height={area.height}
              fill="#26766c"
              stroke="#80d6b8"
              strokeWidth={4}
            />
          </svg>
          <p className="muted">
            绿色为窗口活动区域，过大的窗口会适当缩小以容纳。切换屏幕会清除自定义区域。
          </p>
        </fieldset>
      )}
      <label>
        露边间距
        <select
          disabled={busy}
          value={settings.step}
          onChange={(e) => setSettings({ ...settings, step: Number(e.target.value) })}
        >
          {[4, 8, 16, 32].map((n) => (
            <option key={n} value={n}>
              {n} 像素{n === 8 ? '（默认）' : n === 4 ? '（紧凑）' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          disabled={busy}
          checked={settings.enabled}
          onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
        />
        自动整理与遮挡恢复
      </label>
      <p className="muted">
        使用窗口当前位置和大小，过大的窗口会适当缩小。允许窗口重叠；手动移动、调整大小不再阻止新任务启动。锁屏仍可能影响运行。
      </p>
      <p className="muted">
        检测到任务页不可见后，激活任务页并就近移动露边，最多尝试3个位置。系统可能限制窗口置前，恢复以真实页面可见为准；仍被遮挡时请露出部分网页。暂停、停止后不再移动。
      </p>
      {display && (
        <p>
          已管理 {overview?.managed.length ?? 0}{' '}
          个窗口。布局会为边框和工具栏额外预留空间；实际容量取决于窗口大小和保留区域，不以外框露出代替网页可见。
        </p>
      )}
      <div className="button-row">
        <button
          className="btn"
          disabled={busy || !overview || !settings.displayId}
          onClick={() => void run('configure')}
        >
          保存设置
        </button>
        <button
          className="btn btn-primary"
          disabled={
            busy || !overview || !settings.displayId || selected.size === 0 || selected.size > 100
          }
          onClick={() => void run('apply')}
        >
          整理已选（{selected.size}）
        </button>
        <button className="btn" disabled={busy || !overview} onClick={() => void run('restore')}>
          关闭自动恢复
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void load()}>
          重新读取
        </button>
      </div>
      <p className="muted">停止任务或关闭自动恢复后，窗口留在当前位置，不再自动还原。</p>
      {notice && <p role="status">{notice}</p>}
      {overview?.recovery?.map((item) => (
        <p key={item.profileId} role={item.state === 'NEEDS_ATTENTION' ? 'alert' : 'status'}>
          {profiles.find((p) => p.id === item.profileId)?.alias ||
            profiles.find((p) => p.id === item.profileId)?.browserName ||
            '离线浏览器'}
          ：
          {item.state === 'NEEDS_ATTENTION'
            ? windowLayoutMessage(item.reason)
            : `已尝试${item.moves}个位置，等待真实可见性核验。`}
        </p>
      ))}
      {!error && overview?.error && (
        <p className="error" role="alert">
          {windowLayoutMessage(overview.error)}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
