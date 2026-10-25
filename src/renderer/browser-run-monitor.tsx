import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskRuntimeOverview } from '../shared/task-contracts.js';
import { browseRunStatus } from './browse-run-status.js';

type Runtime = z.infer<typeof TaskRuntimeOverview>;
function MonitorRow({
  profile,
  step,
  now,
}: {
  profile: Profile;
  step?: Runtime['currentSteps'][number];
  now: number;
}) {
  const sample = useRef({
    id: step?.id,
    value: step?.progress.effectiveMilliseconds ?? 0,
    since: now,
    advanced: null as number | null,
  });
  useEffect(() => {
    const value = step?.progress.effectiveMilliseconds ?? 0;
    if (sample.current.id !== step?.id || value < sample.current.value)
      sample.current = { id: step?.id, value, since: Date.now(), advanced: null };
    else if (value > sample.current.value) {
      sample.current.value = value;
      sample.current.advanced = Date.now();
    }
  }, [step?.id, step?.progress.effectiveMilliseconds]);
  const monitor = profile.presentation;
  const running = step?.status === 'ACTIVE' && ['feed', 'video', 'marketplace'].includes(step.type);
  const state = browseRunStatus({
    now,
    running,
    online: profile.online,
    supported: profile.capabilities.includes('task-presentation-recovery-v1'),
    monitor,
    progressSince: sample.current.since,
    lastAdvancedAt: sample.current.advanced,
  });
  const recent = monitor?.active && !!monitor.checkedAt && now - monitor.checkedAt <= 8000;
  const visible =
    recent && !!monitor?.visibilityAt && now - monitor.visibilityAt <= 8000
      ? monitor.visibility === 'visible'
        ? '可见'
        : '隐藏'
      : '未知 / 已过期';
  return (
    <tr>
      <td>{profile.alias || profile.browserName || profile.id.slice(0, 8)}</td>
      <td className={'run-health-' + state.tone}>{state.text}</td>
      <td>
        {running ? `${Math.floor((step?.progress.effectiveMilliseconds ?? 0) / 1000)} 秒` : '—'}
      </td>
      <td>{running ? visible : '—'}</td>
      <td>
        {recent
          ? monitor?.windowFocused === true
            ? '浏览器报告有焦点'
            : monitor?.windowFocused === false
              ? '浏览器报告无焦点'
              : '未知'
          : '—'}
      </td>
      <td>
        {monitor?.lastRecoveryAt ? (
          <>
            {new Date(monitor.lastRecoveryAt).toLocaleTimeString()}
            <br />
            {monitor.recoveryAction === 'LAYOUT_MOVE'
              ? visible === '可见'
                ? '已调整位置，页面已可见'
                : '已调整位置，等待可见核验'
              : monitor.reportedFocused === true
                ? '返回有焦点，桌面置顶未核实'
                : monitor.reportedFocused === false
                  ? '返回无焦点'
                  : '已申请，尚无焦点确认'}
          </>
        ) : (
          '尚无恢复请求'
        )}
      </td>
    </tr>
  );
}

export function BrowserRunMonitor({
  profiles,
  selected,
  runtime,
}: {
  profiles: Profile[];
  selected: ReadonlySet<string>;
  runtime: Runtime | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const steps = new Map(
    runtime?.plans
      .filter((p) => p.state === 'RUNNING')
      .map((p) => [p.profileId, runtime.currentSteps.find((s) => s.jobId === p.id)]),
  );
  const rows = profiles.filter((p) => selected.has(p.id) || steps.has(p.id));
  return (
    <details className="browser-run-monitor">
      <summary>浏览器运行监测{rows.length ? ` · ${rows.length} 份` : ''}</summary>
      <p>
        以有效浏览秒数持续增长判断是否推进；“有焦点”仅为浏览器读数，不证明窗口盖过
        ChatGPT。连续10秒未增长会提示检查，加载和导航也可能造成短暂停顿。
      </p>
      {!rows.length ? (
        <p>勾选左侧浏览器，或启动浏览测试后，这里会显示实时状态。</p>
      ) : (
        <div className="run-monitor-scroll">
          <table>
            <thead>
              <tr>
                <th>浏览器</th>
                <th>运行状态</th>
                <th>有效浏览</th>
                <th>页面可见性</th>
                <th>窗口读数</th>
                <th>最近恢复</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((p) => (
                <MonitorRow key={p.id} profile={p} step={steps.get(p.id)} now={now} />
              ))}
            </tbody>
          </table>
          {rows.length > 100 && <p>当前显示前100份，请缩小左侧选择范围。</p>}
        </div>
      )}
    </details>
  );
}
