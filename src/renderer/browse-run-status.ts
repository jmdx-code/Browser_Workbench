import type { ProfilePresentationStatus } from '../shared/presentation-recovery.js';
import { windowLayoutMessage } from '../shared/window-layout.js';

export function browseRunStatus(input: {
  now: number;
  running: boolean;
  online: boolean;
  supported: boolean;
  monitor?: ProfilePresentationStatus | null;
  progressSince: number;
  lastAdvancedAt: number | null;
}) {
  const { now, monitor } = input;
  if (!input.online) return { tone: 'warn', text: '浏览器未连接' };
  if (!input.running) return { tone: 'muted', text: '没有正在执行的浏览步骤' };
  if (!input.supported) return { tone: 'warn', text: '请刷新扩展以启用监测' };
  if (!monitor?.active) return { tone: 'warn', text: '等待任务窗口监测' };
  if (!monitor.checkedAt || now - monitor.checkedAt > 8000)
    return { tone: 'warn', text: '窗口监测读数已过期' };
  if (monitor.error)
    return {
      tone: 'warn',
      text: monitor.error.startsWith('WINDOW_LAYOUT_')
        ? windowLayoutMessage(monitor.error)
        : '监测异常：' + monitor.error,
    };
  if (!monitor.visibilityAt || now - monitor.visibilityAt > 8000)
    return { tone: 'warn', text: '页面可见性读数缺失或已过期' };
  if (monitor.visibility === 'hidden') return { tone: 'warn', text: '页面隐藏 · 有效浏览计时暂停' };
  const since = input.lastAdvancedAt ?? input.progressSince;
  if (now - since >= 10000)
    return { tone: 'warn', text: `近${Math.floor((now - since) / 1000)}秒有效浏览未增长` };
  if (input.lastAdvancedAt === null) return { tone: 'muted', text: '正在采样浏览进度' };
  return { tone: 'ok', text: '有效浏览正在推进' };
}
