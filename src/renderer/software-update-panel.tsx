import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../shared/software-update.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { Btn, Chk, errMsg, useBusyTask } from './modules/shared/module-ui.js';
import { UI_BTN_PRIMARY, UI_INPUT, UI_MUTED } from './ui/primitives.js';

export function useSoftwareUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null),
    [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.softwareUpdateStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setError('');
      if (next.checking) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(
          () =>
            void api
              .softwareUpdateStatus()
              .then((res) => mountedRef.current && setStatus(res))
              .catch(() => {}),
          16_000,
        );
      }
    } catch (err) {
      if (mountedRef.current) setError(errMsg(err, '更新状态读取失败'));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1_800_000);
    return () => clearInterval(t);
  }, [refresh]);

  const apply = async () => {
    setError('');
    setStatus((s) => (s ? { ...s, applying: true } : s));
    try {
      await api.applySoftwareUpdate();
    } catch (err) {
      setStatus((s) => (s ? { ...s, applying: false } : s));
      setError(errMsg(err, '更新失败'));
    }
  };

  return { status, setStatus, error, refresh, apply };
}

const PATH_BOX =
  'm-0 break-all rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-2 font-mono text-[11.5px]';

function ExtensionUpdateControls({ status: provided }: { status?: UpdateStatus | null }) {
  const [loaded, setLoaded] = useState<UpdateStatus | null>(null),
    [message, setMessage] = useState('');
  const { busy, run } = useBusyTask();

  useEffect(() => {
    if (provided) return;
    let live = true;
    void api.softwareUpdateStatus().then(
      (v) => live && setLoaded(v),
      (err) => live && setMessage(String(err)),
    );
    return () => {
      live = false;
    };
  }, [provided]);

  const status = provided ?? loaded;
  const act = (fn: () => Promise<string>) =>
    void run(async () => setMessage(await fn()), '操作失败').catch((e) =>
      setMessage(errMsg(e, '操作失败')),
    );

  return (
    <div className="grid justify-items-start gap-[10px]">
      <strong>固定插件目录</strong>
      <p className={PATH_BOX}>{status?.extensionDirectory ?? '正在读取…'}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <Btn
          disabled={busy || !status}
          onClick={() =>
            act(async () => {
              await api.openExtensionDirectory();
              return '已请求打开插件文件夹';
            })
          }
        >
          打开插件文件夹
        </Btn>
        <Btn
          v="primary"
          disabled={busy || !!status?.applying}
          onClick={() =>
            act(async () => {
              const r = await api.reloadExtensions();
              return `已请求热刷新 ${r.reloaded} 个插件；跳过 ${r.skippedBusy} 个忙碌、${r.skippedOffline} 个离线`;
            })
          }
        >
          一键热刷新全部插件
        </Btn>
      </div>
      <p className={UI_MUTED}>
        首次加载插件请点击顶栏「复制插件路径」加载上方目录；此后软件更新会自动同步并热刷新空闲浏览器。
      </p>
      {status?.aiWorkspaceDirectory && (
        <>
          <strong className="mt-3 block">AI 专属工作夹（支持 Antigravity / Codex）</strong>
          <p className={PATH_BOX}>{status.aiWorkspaceDirectory}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Btn
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await copyTextToClipboard(status.aiWorkspaceDirectory ?? '');
                  return '已复制 AI 专属工作夹路径';
                })
              }
            >
              复制工作夹路径
            </Btn>
            <Btn
              disabled={busy}
              onClick={() =>
                act(
                  async () =>
                    `已打开 AI 专属工作夹：${(await api.openAiWorkspaceDirectory()).directory}`,
                )
              }
            >
              打开 AI 专属工作夹
            </Btn>
          </div>
          <p className={UI_MUTED}>
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
    [autoCheck, setAutoCheck] = useState(status?.autoCheck ?? true);
  const { busy, error: message, run } = useBusyTask();

  useEffect(() => {
    if (!status) return;
    setRepo(status.githubRepo);
    setAutoCheck(status.autoCheck);
  }, [status?.githubRepo, status?.autoCheck]);

  const work = (fn: () => Promise<UpdateStatus>) =>
    void run(async () => onStatus(await fn()), '更新操作失败');

  return (
    <div className="grid justify-items-start gap-[10px]">
      <p>
        软件版本 <strong>{status?.currentSoftwareVersion ?? '—'}</strong> · 附带插件{' '}
        <strong>{status?.currentExtensionVersion ?? '—'}</strong>
      </p>
      <p className={UI_MUTED}>
        最近检查：
        {status?.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : '尚未检查'}
      </p>
      <ExtensionUpdateControls status={status} />
      <h3>GitHub 自动更新源</h3>
      <label className="inline-flex items-center gap-2 text-xs whitespace-nowrap">
        公开仓库 owner/repo
        <input
          className={`${UI_INPUT} min-w-[230px]`}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="username/browser-workbench"
          disabled={busy || status?.applying}
        />
      </label>
      <Chk
        label="自动检查更新"
        checked={autoCheck}
        disabled={busy || status?.applying}
        onChange={setAutoCheck}
      />
      <div className="mt-1 flex flex-wrap gap-2">
        <Btn
          v="primary"
          sm={false}
          disabled={busy || status?.applying}
          onClick={() =>
            work(() => api.configureSoftwareUpdate({ githubRepo: repo.trim(), autoCheck }))
          }
        >
          保存并检查更新
        </Btn>
        <Btn
          sm={false}
          disabled={busy || status?.checking || status?.applying || !status?.githubRepo}
          onClick={() => work(() => api.checkSoftwareUpdate())}
        >
          {status?.checking ? '正在检查…' : '检查更新'}
        </Btn>
      </div>
      {!status?.githubRepo && <p className={UI_MUTED}>尚未配置更新源，自动检查保持关闭。</p>}
      {status?.availableUpdate && (
        <div className="grid w-full justify-items-start gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-2)] p-3">
          <h3>发现新版本 v{status.availableUpdate.softwareVersion}</h3>
          {status.availableUpdate.extensionVersion && (
            <p>插件 v{status.availableUpdate.extensionVersion}</p>
          )}
          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
            {status.availableUpdate.notes}
          </pre>
          {status.availableUpdate.requiresInstaller ? (
            <>
              <p>底层引擎、依赖或热更新清单不兼容，请下载完整安装包更新。</p>
              <a
                className={UI_BTN_PRIMARY}
                href={status.availableUpdate.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                前往发布页下载安装包
              </a>
            </>
          ) : (
            <Btn
              v="primary"
              sm={false}
              disabled={busy || status.applying}
              onClick={() => void onApply()}
            >
              {status.applying ? '正在下载并更新软件与插件…' : '一键更新软件与所有空闲插件'}
            </Btn>
          )}
        </div>
      )}
      {(error || message) && <p role="alert">{error || message}</p>}
    </div>
  );
}
