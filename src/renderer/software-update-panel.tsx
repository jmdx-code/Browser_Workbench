import { copyTextToClipboard } from './clipboard.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../shared/software-update.js';
import { api } from './api.js';

export function useSoftwareUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null),
    [error, setError] = useState('');
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recheckTimerRef.current) clearTimeout(recheckTimerRef.current);
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await api.softwareUpdateStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setError('');
      if (next.checking) {
        if (recheckTimerRef.current) clearTimeout(recheckTimerRef.current);
        recheckTimerRef.current = setTimeout(
          () =>
            void api
              .softwareUpdateStatus()
              .then((res) => {
                if (mountedRef.current) setStatus(res);
              })
              .catch(() => {}),
          16000,
        );
      }
    } catch (error) {
      if (mountedRef.current) setError(error instanceof Error ? error.message : '更新状态读取失败');
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
          type="button"
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
          type="button"
          className="btn btn-sm btn-primary"
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
        首次加载插件请点击顶栏「复制插件路径」加载上方目录；此后软件更新会自动同步并热刷新空闲浏览器。
      </p>
      {status?.aiWorkspaceDirectory && (
        <>
          <strong style={{ marginTop: 12, display: 'block' }}>
            AI 专属工作夹（支持 Antigravity / Codex）
          </strong>
          <p className="update-path">{status.aiWorkspaceDirectory}</p>
          <div className="update-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await copyTextToClipboard(status.aiWorkspaceDirectory ?? '');
                  return '已复制 AI 专属工作夹路径';
                })
              }
            >
              复制工作夹路径
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const res = await api.openAiWorkspaceDirectory();
                  return `已打开 AI 专属工作夹：${res.directory}`;
                })
              }
            >
              打开 AI 专属工作夹
            </button>
          </div>
          <p className="muted">
            在 Antigravity 或 Codex
            中打开该文件夹，即可仅在该窗口启用工作台控制能力，与其他项目隔离。
          </p>
        </>
      )}
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
