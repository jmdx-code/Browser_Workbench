import { MediaComponentPanel } from './media-component-panel.js';
import { SoftwareUpdatePanel } from './software-update-panel.js';
import type { UpdateStatus } from '../shared/software-update.js';
import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskRuntimeOverview } from '../shared/task-contracts.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { WorkspaceBackupPanel } from './workspace-backup-panel.js';
import { BridgeConnectionPanel } from './bridge-connection-panel.js';
import { WorkspacePreferencesPanel } from './workspace-preferences-panel.js';
import { WorkspaceMaintenancePanel } from './workspace-maintenance-panel.js';
import { ExtensionVersionsPanel } from './settings-panel.js';
import { ReleaseIdlePanel } from './task-tests-panel.js';
import { WindowLayoutPanel } from './window-layout-panel.js';
import { GoogleSheetsAuthPanel } from './modules/sheets/google-sheets-auth-panel.js';
import {
  IconBack,
  IconChevron,
  IconClose,
  IconDatabase,
  IconFile,
  IconFolder,
  IconInfo,
  IconLayers,
  IconLink,
  IconRefresh,
  IconShield,
} from './icons.js';

declare const __WORKBENCH_VERSION__: string;

type Section = 'google-sheets' | 'preferences' | 'backup' | 'logs' | 'update' | 'about';

const sections: {
  group: string;
  items: { id: Section; label: string; hint: string; icon: ReactNode }[];
}[] = [
  {
    group: '云表与偏好',
    items: [
      {
        id: 'google-sheets',
        label: 'Google 云表与图床',
        hint: 'OAuth 授权、Gyazo / 网盘图床与本机名',
        icon: <IconLink />,
      },
      {
        id: 'preferences',
        label: '偏好与窗口设置',
        hint: '主副屏自动露边布局、默认时区与桌面通知',
        icon: <IconLayers />,
      },
    ],
  },
  {
    group: '数据与维护',
    items: [
      {
        id: 'backup',
        label: '数据备份与恢复',
        hint: '保存或恢复全部工作台配置与记录',
        icon: <IconDatabase />,
      },
      {
        id: 'logs',
        label: '数据清理与重置',
        hint: '日志、上传缓存、素材记录、自动保留与空间整理',
        icon: <IconFile />,
      },
    ],
  },
];

export function AppMenu({
  profiles,
  selected,
  runtime,
  busy,
  restartDisabled,
  onRestart,
  onRefresh,
  onClose,
  initialSection,
  onGoogleSheetsChanged,
  onNotify,
  updateStatus,
  onUpdateStatus,
  onApplyUpdate,
  updateError = '',
}: {
  profiles: Profile[];
  selected: ReadonlySet<string>;
  runtime: z.infer<typeof TaskRuntimeOverview> | null;
  busy: boolean;
  restartDisabled: boolean;
  onRestart: () => void;
  onRefresh: () => void;
  onClose: () => void;
  initialSection?: 'update' | 'google-sheets' | 'logs';
  onGoogleSheetsChanged?: () => void;
  onNotify?: (msg: string) => void;
  updateStatus?: UpdateStatus | null;
  onUpdateStatus?: (status: UpdateStatus) => void;
  onApplyUpdate?: () => Promise<void>;
  updateError?: string;
}) {
  const [section, setSection] = useState<Section | null>(initialSection ?? null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector(
          'dialog[open], .modal-backdrop, .popover-panel, .topbar-concurrency-popover',
        )
      )
        return;
      if (section) setSection(null);
      else onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [section, onClose]);

  const current = sections.flatMap((group) => group.items).find((item) => item.id === section);
  const title =
    section === 'update'
      ? '插件连接与更新'
      : section === 'about'
        ? '关于工作台'
        : (current?.label ?? '菜单');

  return (
    <div
      className="drawer-layer"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className={'drawer' + (section ? ' drawer-wide' : '')} aria-label="软件菜单">
        <header className="drawer-head">
          {section && (
            <button
              type="button"
              className="btn btn-icon btn-ghost"
              aria-label="返回菜单"
              onClick={() => setSection(null)}
            >
              <IconBack />
            </button>
          )}
          <div>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label="关闭菜单"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </header>
        <div className="drawer-body">
          {!section && (
            <nav className="menu-list">
              {sections.map((group) => (
                <div className="menu-group" key={group.group}>
                  <span className="menu-group-label">{group.group}</span>
                  {group.items.map((item) => (
                    <button
                      type="button"
                      className="menu-item"
                      key={item.id}
                      onClick={() => setSection(item.id)}
                    >
                      <span className="menu-icon">{item.icon}</span>
                      <span className="menu-text">
                        <strong>{item.label}</strong>
                        <small>{item.hint}</small>
                      </span>
                      <IconChevron size={14} />
                    </button>
                  ))}
                </div>
              ))}
              <div className="menu-group">
                <span className="menu-group-label">系统与扩展</span>
                <button type="button" className="menu-item" onClick={() => setSection('update')}>
                  <span className="menu-icon">
                    <IconRefresh />
                  </span>
                  <span className="menu-text">
                    <strong>
                      插件连接与更新{' '}
                      {updateStatus?.availableUpdate && (
                        <span className="pill pill-warn">有更新</span>
                      )}
                    </strong>
                    <small>
                      v{updateStatus?.currentSoftwareVersion ?? __WORKBENCH_VERSION__} · 插件热刷新
                      · 可选组件
                    </small>
                  </span>
                  <IconChevron size={14} />
                </button>
                <button type="button" className="menu-item" onClick={() => setSection('about')}>
                  <span className="menu-icon">
                    <IconInfo />
                  </span>
                  <span className="menu-text">
                    <strong>关于工作台</strong>
                    <small>版本 v{__WORKBENCH_VERSION__} 与使用说明</small>
                  </span>
                  <IconChevron size={14} />
                </button>
              </div>
              <div className="menu-group">
                <span className="menu-group-label">快捷操作</span>
                <button
                  type="button"
                  className="menu-item"
                  title={
                    updateStatus?.aiWorkspaceDirectory
                      ? `打开固定的 AI 专属工作夹（支持 Antigravity / Codex）：${updateStatus.aiWorkspaceDirectory}`
                      : '打开固定的 AI 专属工作夹（支持 Antigravity / Codex）'
                  }
                  onClick={() => {
                    void (async () => {
                      try {
                        const { directory } = await api.openAiWorkspaceDirectory();
                        await copyTextToClipboard(directory).catch(() => {});
                        onNotify?.(`已打开 AI 专属工作夹并复制路径：${directory}`);
                      } catch (err) {
                        onNotify?.(err instanceof Error ? err.message : '打开 AI 专属工作夹失败');
                      }
                    })();
                  }}
                >
                  <span className="menu-icon">
                    <IconFolder />
                  </span>
                  <span className="menu-text">
                    <strong>打开 AI 专属工作夹</strong>
                    <small>一键打开文件夹并复制路径（支持 Antigravity / Codex）</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="menu-item"
                  disabled={busy || restartDisabled}
                  title={restartDisabled ? '有任务正在执行或排队，请先暂停或停止' : ''}
                  onClick={onRestart}
                >
                  <span className="menu-icon">
                    <IconRefresh />
                  </span>
                  <span className="menu-text">
                    <strong>重启软件</strong>
                    <small>
                      {restartDisabled ? '有任务执行中，暂不可重启' : '重新载入本地控制服务'}
                    </small>
                  </span>
                </button>
              </div>
            </nav>
          )}
          {section && (
            <div className="settings-panel menu-section">
              {section === 'google-sheets' && (
                <GoogleSheetsAuthPanel onChanged={onGoogleSheetsChanged} />
              )}
              {section === 'preferences' && (
                <>
                  <WindowLayoutPanel profiles={profiles} />
                  <hr className="menu-divider" />
                  <WorkspacePreferencesPanel />
                </>
              )}
              {section === 'backup' && <WorkspaceBackupPanel />}
              {section === 'logs' && <WorkspaceMaintenancePanel />}
              {section === 'update' && (
                <>
                  <SoftwareUpdatePanel
                    status={updateStatus ?? null}
                    onStatus={onUpdateStatus ?? (() => {})}
                    onApply={onApplyUpdate ?? (async () => {})}
                    error={updateError}
                  />
                  <hr className="menu-divider" />
                  <BridgeConnectionPanel profiles={profiles} />
                  <h3>已登记浏览器插件版本</h3>
                  <ExtensionVersionsPanel profiles={profiles} />
                  <hr className="menu-divider" />
                  <MediaComponentPanel />
                  <details className="menu-troubleshoot-fold">
                    <summary>高级排障：解除已选浏览器遗留占用</summary>
                    <ReleaseIdlePanel
                      profiles={profiles}
                      selected={selected}
                      runtime={runtime}
                      busy={busy}
                      onRefresh={onRefresh}
                    />
                  </details>
                </>
              )}
              {section === 'about' && <AboutPanel />}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function AboutPanel() {
  return (
    <div className="menu-panel about">
      <div className="about-brand">
        <IconShield size={22} />
        <div>
          <strong>浏览器工作台</strong>
          <small>版本 v{__WORKBENCH_VERSION__}</small>
        </div>
      </div>
      <ol className="quick-steps">
        <li>
          <strong>连接浏览器</strong>
          点击顶栏「复制插件路径」，在 Chrome / Brave 扩展页加载即可自动连入左侧浏览器列表。
        </li>
        <li>
          <strong>统一并发管理</strong>
          顶栏「并发」按钮统一控制 Chrome 与蓝蝶最大同时运行窗口数，全模块共用，超限自动排队。
        </li>
        <li>
          <strong>全流程自动化</strong>
          支持定时排班、活跃账号、小组发帖、小组/专页顶贴、小组邀请人、蓝蝶模拟器和 Google
          云表协同。
        </li>
        <li>
          <strong>全局执行记录</strong>
          在左侧顶部「执行记录」统一查看、搜索、导出或清理各模块任务回执；点击左侧账号名可按单号筛选。
        </li>
      </ol>
      <p className="muted">
        状态圆点：灰=离线，绿=已连接，蓝=运行中，黄=需留意，红=账号登出或受限。账号“未知”仅表示尚未检测，不代表异常。
      </p>
    </div>
  );
}
