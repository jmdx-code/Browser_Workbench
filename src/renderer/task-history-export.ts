import { TaskHistory, type History } from '../shared/task-contracts.js';

// Export the public history projection only: no cookies, credentials, raw
// network bodies, post text, media bytes or private filesystem paths.
export function exportTaskHistory(history: History, version: string) {
  const value = TaskHistory.parse(history);
  const payload = {
    format: 'browser-workbench-task-history',
    version: 1,
    softwareVersion: version,
    exportedAt: new Date().toISOString(),
    history: value,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download =
    '任务记录-' +
    value.profileId.slice(0, 8) +
    '-' +
    new Date().toISOString().replaceAll(':', '-') +
    '.json';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
