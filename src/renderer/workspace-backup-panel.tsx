import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { WorkspaceBackupStatus, type BackupResult } from '../shared/workspace-backup.js';
import { api } from './api.js';
import { FileLocationButton } from './file-location-button.js';
import { WorkspaceRestorePanel } from './workspace-restore-panel.js';
export function WorkspaceBackupPanel() {
  const [status, setStatus] = useState<z.infer<typeof WorkspaceBackupStatus> | null>(null);
  const [directory, setDirectory] = useState(
    () => localStorage.getItem('workspace-backup-directory') ?? '',
  );
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<BackupResult | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api.backupStatus(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(
      (value) => {
        if (!controller.signal.aborted) {
          setStatus(value);
          if (value.defaultDirectory) setDirectory((prev) => prev || value.defaultDirectory || '');
        }
      },
      () => {
        if (!controller.signal.aborted) setError('备份状态读取失败，请重新打开设置');
      },
    );
    return () => controller.abort();
  }, []);
  async function create() {
    if (busy || !directory.trim()) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const value = await api.createBackup(directory.trim());
      localStorage.setItem('workspace-backup-directory', directory.trim());
      setResult(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '备份未完成，请检查保存位置');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-backup-panel">
      <h3>数据备份</h3>
      <p>
        保存分组、浏览器资料、组合、资源表、任务及使用记录。原素材和媒体缓存保持原位，不复制到备份中。
      </p>
      <div className="settings-form">
        <input
          aria-label="数据备份保存位置"
          value={directory}
          disabled={busy}
          placeholder={status?.defaultDirectory ?? '选择本机文件夹，或填写完整路径'}
          onChange={(event) => setDirectory(event.target.value)}
        />
        {typeof window.workbenchDesktop?.chooseBackupDirectory === 'function' && (
          <button
            disabled={busy}
            onClick={() => {
              const previous = directory;
              setDirectory('');
              setBusy(true);
              void window.workbenchDesktop
                ?.chooseBackupDirectory()
                .then((value) => {
                  setDirectory(value || previous);
                })
                .catch(() => {
                  setDirectory(previous);
                  setError('文件夹选择失败');
                })
                .finally(() => setBusy(false));
            }}
          >
            选择文件夹…
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !status?.available || !directory.trim()}
          onClick={() => void create()}
        >
          {busy ? '正在备份…' : '创建数据备份'}
        </button>
      </div>
      {status?.reason && <p>{status.reason}</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p>备份已保存：{result.directory}</p>
          <FileLocationButton source={result.directory + '/backup.json'} label="打开备份位置" />
        </div>
      )}
      <p className="field-hint">备份时请先暂停或停止任务。每次生成独立文件夹，保留旧备份。</p>
      <WorkspaceRestorePanel />
    </div>
  );
}
