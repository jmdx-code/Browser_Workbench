import { useState } from 'react';
import type { UpdateStatus } from '../shared/software-update.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { IconBrand, IconMenu } from './icons.js';

export function WorkbenchTopbar({
  version,
  breadcrumbText,
  busy,
  error,
  onlineCount,
  totalProfilesCount,
  updateStatus,
  updateError,
  onOpenDiagnosticModal,
  onOpenMenu,
  onOpenUpdateMenu,
  onApplyUpdate,
  onNotify,
}: {
  version: string;
  breadcrumbText: string;
  busy: boolean;
  error: string | null;
  onlineCount: number;
  totalProfilesCount: number;
  updateStatus: UpdateStatus | null;
  updateError: string;
  onOpenDiagnosticModal: () => void;
  onOpenMenu: () => void;
  onOpenUpdateMenu: () => void;
  onApplyUpdate: () => Promise<void>;
  onNotify: (msg: string) => void;
}) {
  const [ignoredUpdate, setIgnoredUpdate] = useState('');

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <IconBrand size={18} />
          </span>
          <strong>浏览器工作台</strong>
          <span className="build-label">v{version}</span>
          <span className="topbar-breadcrumb" aria-label="当前模块">
            {breadcrumbText}
          </span>
        </div>
        <div className="topbar-right">
          {busy && <span className="spinner" role="status" aria-label="正在处理" />}
          <button
            className="btn btn-sm"
            title="一键打包当前所有浏览器状态、任务账本、顶贴/邀请日志与内核黑匣子记录为 .zip 反馈包并打开文件夹"
            onClick={onOpenDiagnosticModal}
          >
            记录问题现场
          </button>
          <button
            className="btn btn-sm"
            title={
              updateStatus?.aiWorkspaceDirectory
                ? `打开固定的 AI 专属工作夹（同时支持 Antigravity 与 Codex；仅在打开此文件夹的窗口生效）：${updateStatus.aiWorkspaceDirectory}`
                : '打开固定的 AI 专属工作夹（同时支持 Antigravity 与 Codex；仅在打开此文件夹的窗口生效）'
            }
            onClick={() => {
              void (async () => {
                try {
                  const { directory } = await api.openAiWorkspaceDirectory();
                  await copyTextToClipboard(directory).catch(() => {});
                  onNotify(`已打开 AI 专属工作夹并复制路径：${directory}`);
                } catch (err) {
                  onNotify(err instanceof Error ? err.message : '打开 AI 专属工作夹失败');
                }
              })();
            }}
          >
            打开 AI 专属工作夹
          </button>
          <button
            className="btn btn-sm"
            title={
              updateStatus?.extensionDirectory
                ? `点击复制固定插件目录：${updateStatus.extensionDirectory}`
                : '点击复制浏览器扩展（固定插件目录）路径'
            }
            onClick={() => {
              void (async () => {
                try {
                  const dir =
                    updateStatus?.extensionDirectory ||
                    (await api.softwareUpdateStatus()).extensionDirectory;
                  await copyTextToClipboard(dir);
                  onNotify(`已复制固定插件路径：${dir}`);
                } catch (err) {
                  onNotify(err instanceof Error ? err.message : '复制插件路径失败');
                }
              })();
            }}
          >
            复制插件路径
          </button>
          <span
            className={'connection-status' + (error ? ' is-error' : onlineCount ? ' is-on' : '')}
            title={error ? '控制服务连接待刷新' : '已连接的浏览器 / 全部浏览器'}
          >
            <i />
            {error ? '连接待刷新' : `${onlineCount}/${totalProfilesCount} 已连接`}
          </span>
          <button
            className="btn btn-icon menu-button"
            aria-label="打开菜单"
            title="菜单：备份恢复、连接诊断、日志、重启等"
            onClick={onOpenMenu}
          >
            <IconMenu size={18} />
          </button>
        </div>
      </header>
      {updateStatus?.availableUpdate &&
        ignoredUpdate !==
          updateStatus.availableUpdate.softwareVersion +
            ':' +
            updateStatus.availableUpdate.extensionVersion && (
          <div className="update-banner" role="status">
            <span>
              发现新版本 v{updateStatus.availableUpdate.softwareVersion}
              {updateStatus.availableUpdate.extensionVersion
                ? ' · 插件 v' + updateStatus.availableUpdate.extensionVersion
                : ''}
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={updateStatus.applying || updateStatus.availableUpdate.requiresInstaller}
              onClick={() => void onApplyUpdate()}
            >
              {updateStatus.applying
                ? '正在下载并更新软件与插件…'
                : updateStatus.availableUpdate.requiresInstaller
                  ? '需要完整安装包'
                  : '一键更新'}
            </button>
            <button className="btn btn-sm" onClick={onOpenUpdateMenu}>
              查看详情
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                setIgnoredUpdate(
                  updateStatus.availableUpdate?.softwareVersion +
                    ':' +
                    updateStatus.availableUpdate?.extensionVersion,
                )
              }
            >
              稍后
            </button>
            {updateError && <span>{updateError}</span>}
          </div>
        )}
    </>
  );
}
