import { MediaComponentPanel } from './media-component-panel.js';
import { SoftwareUpdatePanel } from './software-update-panel.js';
import type { UpdateStatus } from '../shared/software-update.js';
import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskRuntimeOverview } from '../shared/task-contracts.js';
import { MaterialUsagePanel } from './material-usage-panel.js';
import { WorkspaceBackupPanel } from './workspace-backup-panel.js';
import { BridgeConnectionPanel } from './bridge-connection-panel.js';
import { MaterialCachePanel } from './material-cache-panel.js';
import { WorkspacePreferencesPanel } from './workspace-preferences-panel.js';
import { WorkspaceMaintenancePanel } from './workspace-maintenance-panel.js';
import { ExtensionVersionsPanel, FeatureStatusPanel } from './settings-panel.js';
import { ReleaseIdlePanel } from './task-tests-panel.js';
import { WindowLayoutPanel } from './window-layout-panel.js';
import {
  IconBack,
  IconBell,
  IconCheckList,
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
  IconUnlock,
} from './icons.js';

declare const __WORKBENCH_VERSION__: string;

type Section =
  | 'update'
  | 'media'
  | 'window-layout'
  | 'backup'
  | 'usage'
  | 'cache'
  | 'connection'
  | 'features'
  | 'preferences'
  | 'logs'
  | 'release'
  | 'about';
const sections: {
  group: string;
  items: { id: Section; label: string; hint: string; icon: ReactNode }[];
}[] = [
  {
    group: '数据',
    items: [
      { id: 'backup', label: '备份与恢复', hint: '保存或恢复全部软件数据', icon: <IconDatabase /> },
      { id: 'usage', label: '素材使用记录', hint: '查看或清空已使用标记', icon: <IconLayers /> },
      { id: 'media', label: '可选组件', hint: '按需安装视频文字处理', icon: <IconLayers /> },
      { id: 'cache', label: '上传缓存', hint: '清理媒体上传缓存', icon: <IconFolder /> },
    ],
  },
  {
    group: '连接',
    items: [
      { id: 'connection', label: '连接诊断', hint: '桥接连接与插件版本', icon: <IconLink /> },
      { id: 'features', label: '功能状态', hint: '各子任务的开放与验收', icon: <IconCheckList /> },
    ],
  },
  {
    group: '偏好与维护',
    items: [
      { id: 'preferences', label: '日程与通知', hint: '默认时区、桌面通知', icon: <IconBell /> },
      {
        id: 'window-layout',
        label: '任务窗口布局',
        hint: '主屏／副屏自动露边',
        icon: <IconLayers />,
      },
      { id: 'logs', label: '日志与数据清理', hint: '运行日志、数据目录', icon: <IconFile /> },
      {
        id: 'release',
        label: '结束遗留占用',
        hint: '解除已选浏览器的历史占用',
        icon: <IconUnlock />,
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
  initialSection?: 'update';
  updateStatus?: UpdateStatus | null;
  onUpdateStatus?: (status: UpdateStatus) => void;
  onApplyUpdate?: () => Promise<void>;
  updateError?: string;
}) {
  const [section, setSection] = useState<Section | null>(initialSection ?? null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (section) setSection(null);
      else onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [section, onClose]);
  const current = sections.flatMap((group) => group.items).find((item) => item.id === section);
  return (
    <div
      className="drawer-layer"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className={'drawer' + (section ? ' drawer-wide' : '')} aria-label="软件菜单">
        <header className="drawer-head">
          {section && (
            <button
              className="btn btn-icon btn-ghost"
              aria-label="返回菜单"
              onClick={() => setSection(null)}
            >
              <IconBack />
            </button>
          )}
          <div>
            <h2>
              {section === 'update'
                ? '软件与插件更新'
                : section === 'about'
                  ? '关于'
                  : (current?.label ?? '菜单')}
            </h2>
          </div>
          <button className="btn btn-icon btn-ghost" aria-label="关闭菜单" onClick={onClose}>
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
                    <button className="menu-item" key={item.id} onClick={() => setSection(item.id)}>
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
                <span className="menu-group-label">软件</span>
                <button className="menu-item" onClick={() => setSection('update')}>
                  <span className="menu-icon">
                    <IconRefresh />
                  </span>
                  <span className="menu-text">
                    <strong>
                      软件与插件更新{' '}
                      {updateStatus?.availableUpdate && (
                        <span className="pill pill-warn">有更新</span>
                      )}
                    </strong>
                    <small>
                      当前 v{updateStatus?.currentSoftwareVersion ?? __WORKBENCH_VERSION__}
                    </small>
                  </span>
                  <IconChevron size={14} />
                </button>
                <button
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
                      {restartDisabled ? '有任务执行中，暂不可重启' : '重新载入控制服务'}
                    </small>
                  </span>
                </button>
                <button className="menu-item" onClick={() => setSection('about')}>
                  <span className="menu-icon">
                    <IconInfo />
                  </span>
                  <span className="menu-text">
                    <strong>关于与帮助</strong>
                    <small>版本 {__WORKBENCH_VERSION__}</small>
                  </span>
                  <IconChevron size={14} />
                </button>
              </div>
            </nav>
          )}
          <div className="settings-panel menu-section">
            {section === 'update' && (
              <SoftwareUpdatePanel
                status={updateStatus ?? null}
                onStatus={onUpdateStatus ?? (() => {})}
                onApply={onApplyUpdate ?? (async () => {})}
                error={updateError}
              />
            )}
            {section === 'backup' && <WorkspaceBackupPanel />}
            {section === 'usage' && <MaterialUsagePanel />}
            {section === 'cache' && <MaterialCachePanel />}
            {section === 'connection' && (
              <>
                <BridgeConnectionPanel profiles={profiles} />
                <h3>插件版本</h3>
                <ExtensionVersionsPanel profiles={profiles} />
              </>
            )}
            {section === 'features' && <FeatureStatusPanel />}
            {section === 'media' && <MediaComponentPanel />}
            {section === 'preferences' && <WorkspacePreferencesPanel />}
            {section === 'window-layout' && (
              <WindowLayoutPanel selected={selected} profiles={profiles} />
            )}
            {section === 'logs' && <WorkspaceMaintenancePanel />}
            {section === 'release' && (
              <ReleaseIdlePanel
                profiles={profiles}
                selected={selected}
                runtime={runtime}
                busy={busy}
                onRefresh={onRefresh}
              />
            )}
            {section === 'about' && <AboutPanel />}
          </div>
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
          <small>版本 {__WORKBENCH_VERSION__}</small>
        </div>
      </div>
      <ol className="quick-steps">
        <li>
          <strong>连接浏览器</strong>
          打开已安装桥接插件的 Chrome 或 Brave，会自动出现在左侧列表。
        </li>
        <li>
          <strong>勾选浏览器</strong>
          勾选单个、整组，或按住 Shift 连选。
        </li>
        <li>
          <strong>启动组合</strong>
          在首页卡片上点「启动」；同时运行数量在首页顶部调整。
        </li>
        <li>
          <strong>查看结果</strong>
          在「任务记录」查看每次执行；点左侧浏览器名称可只看它的记录，再点一次取消。
        </li>
      </ol>
      <p className="muted">
        状态圆点：灰=离线，绿=已连接，蓝=运行中，黄=需要留意，红=账号读取为登出或受限。账号“未知”不代表异常。
      </p>
      <p className="muted">
        遇到“需要核对”：在任务记录中打开该任务并停止结束。可能已提交的内容不会自动重发，历史记录保留。
      </p>
    </div>
  );
}
