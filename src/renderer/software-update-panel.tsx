import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '../shared/software-update.js';
import { api } from './api.js';

export function useSoftwareUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const next = await api.softwareUpdateStatus();
      setStatus(next);
      setError('');
      if (next.checking) {
        setTimeout(
          () =>
            void api
              .softwareUpdateStatus()
              .then(setStatus)
              .catch(() => {}),
          16000,
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '更新状态读取失败');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1_800_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const apply = async () => {
    setError('');
    setStatus((s) => (s ? { ...s, applying: true } : s));
    try {
      await api.applySoftwareUpdate();
    } catch (error) {
      setStatus((s) => (s ? { ...s, applying: false } : s));
      setError(error instanceof Error ? error.message : '更新失败');
    }
  };
  return { status, setStatus, error, refresh, apply };
}

export function ExtensionUpdateControls({ status: provided }: { status?: UpdateStatus | null }) {
  const [loaded, setLoaded] = useState<UpdateStatus | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (provided) return;
    let live = true;
    void api
      .softwareUpdateStatus()
      .then((value) => {
        if (live) setLoaded(value);
      })
      .catch((error) => {
        if (live) setMessage(String(error));
      });
    return () => {
      live = false;
    };
  }, [provided]);
  const status = provided ?? loaded;
  async function action(work: () => Promise<string>) {
    setBusy(true);
    try {
      setMessage(await work());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="menu-panel">
      <strong>固定插件目录</strong>
      <p className="update-path">{status?.extensionDirectory ?? '正在读取…'}</p>
      <div className="update-actions">
        <button
          className="btn btn-sm"
          disabled={busy || !status}
          onClick={() =>
            void action(async () => {
              await navigator.clipboard.writeText(status?.extensionDirectory ?? '');
              return '已复制固定插件路径';
            })
          }
        >
          复制固定插件路径
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || !status}
          onClick={() =>
            void action(async () => {
              await api.openExtensionDirectory();
              return '已请求打开插件文件夹';
            })
          }
        >
          打开插件文件夹
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || !!status?.applying}
          onClick={() =>
            void action(async () => {
              const result = await api.reloadExtensions();
              return `已请求热刷新 ${result.reloaded} 个插件；跳过 ${result.skippedBusy} 个忙碌、${result.skippedOffline} 个离线`;
            })
          }
        >
          一键热刷新全部插件
        </button>
      </div>
      <p className="muted">
        首次在浏览器加载插件时请选择上方固定插件目录；此后软件更新时会自动同步该目录并让所有空闲浏览器自动热刷新，软件移动位置也不受影响。仍加载旧目录的浏览器需要先手动改用此目录。
      </p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function SoftwareUpdatePanel({
  status,
  onStatus,
  onApply,
  error,
}: {
  status: UpdateStatus | null;
  onStatus: (status: UpdateStatus) => void;
  onApply: () => Promise<void>;
  error: string;
}) {
  const [repo, setRepo] = useState(status?.githubRepo ?? ''),
    [autoCheck, setAutoCheck] = useState(status?.autoCheck ?? true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (status) {
      setRepo(status.githubRepo);
      setAutoCheck(status.autoCheck);
    }
  }, [status?.githubRepo, status?.autoCheck]);
  async function work(action: () => Promise<UpdateStatus>) {
    setBusy(true);
    setMessage('');
    try {
      onStatus(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="menu-panel">
      <p>
        软件版本 <strong>{status?.currentSoftwareVersion ?? '—'}</strong> · 附带插件{' '}
        <strong>{status?.currentExtensionVersion ?? '—'}</strong>
      </p>
      <p className="muted">
        最近检查：
        {status?.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : '尚未检查'}
      </p>
      <ExtensionUpdateControls status={status} />
      <h3>GitHub 自动更新源</h3>
      <label>
        公开仓库 owner/repo
        <input
          className="input"
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="username/browser-workbench"
          disabled={busy || status?.applying}
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={autoCheck}
          onChange={(event) => setAutoCheck(event.target.checked)}
        />
        自动检查更新
      </label>
      <div className="update-actions">
        <button
          className="btn btn-primary"
          disabled={busy || status?.applying}
          onClick={() =>
            void work(() => api.configureSoftwareUpdate({ githubRepo: repo.trim(), autoCheck }))
          }
        >
          保存并检查更新
        </button>
        <button
          className="btn"
          disabled={busy || status?.checking || status?.applying || !status?.githubRepo}
          onClick={() => void work(() => api.checkSoftwareUpdate())}
        >
          {status?.checking ? '正在检查…' : '检查更新'}
        </button>
      </div>
      {!status?.githubRepo && <p className="muted">尚未配置更新源，自动检查保持关闭。</p>}
      {status?.availableUpdate && (
        <div className="update-card">
          <h3>发现新版本 v{status.availableUpdate.softwareVersion}</h3>
          {status.availableUpdate.extensionVersion && (
            <p>插件 v{status.availableUpdate.extensionVersion}</p>
          )}
          <pre className="update-notes">{status.availableUpdate.notes}</pre>
          {status.availableUpdate.requiresInstaller ? (
            <>
              <p>底层引擎、依赖或热更新清单不兼容，请下载完整安装包更新。</p>
              <a
                className="btn btn-primary"
                href={status.availableUpdate.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                前往发布页下载安装包
              </a>
            </>
          ) : (
            <button
              className="btn btn-primary"
              disabled={busy || status.applying}
              onClick={() => void onApply()}
            >
              {status.applying ? '正在下载并更新软件与插件…' : '一键更新软件与所有空闲插件'}
            </button>
          )}
        </div>
      )}
      {(message || error || status?.error) && (
        <p role="alert">{message || error || status?.error}</p>
      )}
    </div>
  );
}
