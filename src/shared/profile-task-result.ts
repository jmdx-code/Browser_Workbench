import type { ProfileTaskResultValue } from './task-contracts.js';

export function profileTaskResultLabel(result: ProfileTaskResultValue): {
  tone: 'warn' | 'err' | 'pause' | 'ok';
  text: string;
} {
  const defaultName =
    result.source === 'group-bumper'
      ? '小组顶贴'
      : result.source === 'page-bumper'
        ? '专页顶贴'
        : result.source === 'group-poster'
          ? '小组发帖'
          : result.name;
  const name = (result.name.trim() || defaultName).replace(/^单项测试\s*·\s*/, '');
  if (
    result.source === 'group-inviter' &&
    result.state === 'FAILED' &&
    result.reason.startsWith('受限 ·')
  )
    return { tone: 'warn', text: '上次受限 · 需要手机验证或操作受限 · ' + name };
  if (
    (result.source === 'group-bumper' ||
      result.source === 'page-bumper' ||
      result.source === 'group-poster') &&
    result.state === 'FAILED' &&
    result.reason.startsWith('受限 ·')
  )
    return { tone: 'warn', text: '上次' + result.reason + ' · ' + name };
  if (
    (result.source === 'group-inviter' ||
      result.source === 'group-bumper' ||
      result.source === 'page-bumper' ||
      result.source === 'group-poster') &&
    result.reason.includes('待核对')
  )
    return { tone: 'warn', text: result.reason + ' · ' + name };
  if (result.state === 'FAILED') return { tone: 'err', text: '上次失败 · ' + name };
  if (result.state === 'STOPPED') return { tone: 'pause', text: '上次已停止 · ' + name };
  if (result.failedSteps > 0) return { tone: 'warn', text: '上次部分失败 · ' + name };
  if (result.skippedSteps > 0)
    return { tone: 'warn', text: `上次完成（跳过${result.skippedSteps}项）· ${name}` };
  return { tone: 'ok', text: '上次成功 · ' + name };
}
