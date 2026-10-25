import { useEffect, useState } from 'react';
import type { RestoreInspection, RestoreStatus } from '../shared/workspace-backup.js';
import { api } from './api.js';
import { FileLocationButton } from './file-location-button.js';
export function WorkspaceRestorePanel() {
  const [directory, setDirectory] = useState(''),
    [inspection, setInspection] = useState<RestoreInspection | null>(null),
    [status, setStatus] = useState<RestoreStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void api.restoreStatus(AbortSignal.any([c.signal, AbortSignal.timeout(10_000)])).then(
      (v) => {
        if (!c.signal.aborted) setStatus(v);
      },
      () => {
        if (!c.signal.aborted) setError('恢复状态读取失败');
      },
    );
    return () => c.abort();
  }, []);
  async function check() {
    setBusy(true);
    setError('');
    setInspection(null);
    try {
      setInspection(await api.inspectRestore(directory.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : '备份检查失败');
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (
      !inspection ||
      !window.confirm(
        '恢复这份备份将替换当前软件数据。重启前会自动保留当前数据备份；原素材不会移动。恢复后的旧任务不会自动发布。是否继续？',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      setStatus(await api.prepareRestore(inspection.directory));
      setInspection(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复准备失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-backup-panel">
      <h3>恢复数据</h3>
      <p>
        选择备份文件夹中的
        backup.json，先核对内容，再重启恢复。素材路径保持原样；原文件需要仍在原位置。
      </p>
      <div className="settings-form">
        <input
          aria-label="待恢复备份文件夹"
          placeholder={
            status?.defaultDirectory
              ? `默认从 ${status.defaultDirectory} 选择具体备份文件夹`
              : '完整备份文件夹路径'
          }
          value={directory}
          disabled={busy || status?.state === 'READY'}
          onChange={(e) => {
            setDirectory(e.target.value);
            setInspection(null);
          }}
        />
        {typeof window.workbenchDesktop?.chooseRestoreBackup === 'function' && (
          <button
            disabled={busy || status?.state === 'READY'}
            onClick={() =>
              void window.workbenchDesktop
                ?.chooseRestoreBackup()
                .then((value) => {
                  if (value) {
                    setDirectory(value);
                    setInspection(null);
                  }
                })
                .catch(() => setError('备份选择失败'))
            }
          >
            选择备份…
          </button>
        )}
        <button
          disabled={busy || !status?.available || !directory.trim() || status.state === 'READY'}
          onClick={() => void check()}
        >
          {busy ? '正在处理…' : '检查备份'}
        </button>
      </div>
      {inspection && (
        <div role="status">
          <p>
            {new Date(inspection.createdAt).toLocaleString()} · 软件 {inspection.softwareVersion} ·{' '}
            {inspection.groups} 个分组、{inspection.combinations} 个组合、{inspection.profiles}{' '}
            份资料、{inspection.tasks} 条任务
          </p>
          <button disabled={busy} onClick={() => void restore()}>
            使用这份备份恢复…
          </button>
        </div>
      )}
      {status && status.state !== 'NONE' && (
        <div role="status">
          <p>{status.reason}</p>
          {status.state === 'READY' && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                if (window.workbenchDesktop?.restartSoftware)
                  void window.workbenchDesktop
                    .restartSoftware()
                    .catch(() => setError('自动重启失败，请关闭并重新打开软件'));
                else setError('请关闭并重新启动桌面软件完成恢复');
              }}
            >
              重启并恢复
            </button>
          )}
          {status.safetyDirectory && (
            <FileLocationButton
              source={status.safetyDirectory + '/backup.json'}
              label="查看恢复前的备份"
            />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
