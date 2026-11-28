import { useEffect, useState, type ReactNode } from 'react';
import { profileDisplayName, type Profile } from '../shared/contracts.js';
import type { UpdateStatus } from '../shared/software-update.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { ConfirmDialog } from './confirm-dialog.js';
import {
  IconBack,
  IconChevron,
  IconCopy,
  IconDatabase,
  IconFile,
  IconFolder,
  IconInfo,
  IconLayers,
  IconLink,
  IconPower,
  IconRefresh,
  IconShield,
} from './icons.js';
import { Btn, errMsg } from './modules/shared/module-ui.js';
import { GoogleSheetsAuthPanel } from './modules/sheets/google-sheets-auth-panel.js';
import { SoftwareUpdatePanel } from './software-update-panel.js';
import { SlideDrawer, UI_MUTED } from './ui/primitives.js';
import { WorkspaceBackupPanel, WorkspaceMaintenancePanel } from './workspace-maintenance-panel.js';
import {
  BridgeConnectionPanel,
  MediaComponentPanel,
  WorkspacePreferencesPanel,
} from './workspace-settings-panels.js';
declare const __WORKBENCH_VERSION__: string;
declare const __BRIDGE_EXTENSION_VERSION__: string;
type Section = 'google-sheets' | 'preferences' | 'backup' | 'logs' | 'update' | 'about';
const SECTIONS: Array<[string, Array<[Section, string, string, ReactNode]>]> = [
  [
    '云表与偏好',
    [
      [
        'google-sheets',
        'Google 云表与图床',
        'OAuth 授权、Gyazo / 网盘图床与本机名',
        <IconLink key="l" />,
      ],
      [
        'preferences',
        '偏好与窗口设置',
        '主副屏自动露边布局、默认时区与桌面通知',
        <IconLayers key="p" />,
      ],
    ],
  ],
  [
    '数据与维护',
    [
      ['backup', '数据备份与恢复', '保存或恢复全部工作台配置与记录', <IconDatabase key="b" />],
      ['logs', '数据清理与重置', '日志、缓存、素材记录与空间清理', <IconFile key="f" />],
    ],
  ],
];
const QUICK_STEPS = [
  [
    '连接浏览器',
    '点击菜单「复制插件路径」，在 Chrome / Brave 扩展页加载即可自动连入左侧浏览器列表。',
  ],
  [
    '统一并发管理',
    '顶栏「并发」按钮统一控制 Chrome 与蓝蝶最大同时运行窗口数，全模块共用，超限自动排队。',
  ],
  [
    '全流程自动化',
    '支持定时排班、活跃账号、小组发帖、小组/专页顶贴、小组邀请人、蓝蝶模拟器和 Google 云表协同。',
  ],
  [
    '数据与记录',
    '在左侧导航「数据与记录」查看跨载体统计面板及发帖、顶贴、邀人明细，支持自定义列与组合筛选。',
  ],
] as const;
const MENU_GROUP_LBL = 'px-2.5 pb-1.5 text-[11px] font-bold tracking-wider text-[var(--text-3)]';
const MENU_PANEL = 'grid justify-items-start gap-2.5';
const MENU_DIVIDER = 'my-3.5 border-0 border-t border-[var(--line)]';
function MI(p: {
  icon: ReactNode;
  title: ReactNode;
  hint: string;
  titleAttr?: string | undefined;
  warn?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`group flex h-auto w-full items-center gap-3 rounded-xl border-0 bg-transparent p-2.5 text-left text-[var(--text-3)] transition-colors disabled:opacity-45 ${p.warn ? 'hover:not-disabled:bg-amber-50 hover:not-disabled:text-amber-700' : 'hover:not-disabled:bg-slate-50 hover:not-disabled:shadow-2xs'}`}
      title={p.titleAttr}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span
        className={`grid h-[34px] w-[34px] shrink-0 place-content-center rounded-[9px] border border-[var(--line)] bg-white text-[var(--text-2)]${p.warn ? ' group-hover:border-amber-200 group-hover:bg-amber-100 group-hover:text-amber-700' : ''}`}
      >
        {p.icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-px">
        <strong className="text-[13px] font-semibold text-[var(--text)]">{p.title}</strong>
        <small className="text-xs leading-relaxed whitespace-normal text-[var(--text-3)]">
          {p.hint}
        </small>
      </span>
      {p.trailing}
    </button>
  );
}
export function AppMenu(p: {
  profiles: Profile[];
  busy: boolean;
  restartDisabled: boolean;
  onRestart: () => void;
  onClose: () => void;
  initialSection?: 'update' | 'google-sheets' | 'logs';
  onGoogleSheetsChanged?: () => void;
  onNotify?: (msg: string) => void;
  onOpenDiagnosticModal?: () => void;
  updateStatus?: UpdateStatus | null;
  onUpdateStatus?: (status: UpdateStatus) => void;
  onApplyUpdate?: () => Promise<void>;
  updateError?: string;
  onOpenWindowLayout?: () => void;
}) {
  const { profiles, busy, restartDisabled, onClose, onNotify, updateStatus, updateError = '' } = p;
  const [section, setSection] = useState<Section | null>(p.initialSection ?? null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' ||
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
  const title =
    section === 'update'
      ? '插件连接与更新'
      : section === 'about'
        ? '关于工作台'
        : (SECTIONS.flatMap(([, items]) => items).find(([id]) => id === section)?.[1] ?? '菜单');
  return (
    <SlideDrawer
      open
      onClose={onClose}
      title={title}
      widthClass={section ? 'max-w-[640px]' : 'max-w-[400px]'}
      headerActions={
        section ? (
          <Btn v="ghost" aria-label="返回菜单" onClick={() => setSection(null)}>
            <IconBack size={14} /> 返回菜单
          </Btn>
        ) : undefined
      }
    >
      {!section ? (
        <nav className="grid gap-4 [@media(max-height:680px)]:gap-3">
          {SECTIONS.map(([group, items]) => (
            <div className="grid gap-0.5" key={group}>
              <span className={MENU_GROUP_LBL}>{group}</span>
              {items.map(([id, label, hint, icon]) => (
                <MI
                  key={id}
                  icon={icon}
                  title={label}
                  hint={hint}
                  trailing={<IconChevron size={14} />}
                  onClick={() => setSection(id)}
                />
              ))}
            </div>
          ))}
          <div className="grid gap-0.5">
            <span className={MENU_GROUP_LBL}>系统与扩展</span>
            <MI
              icon={<IconRefresh />}
              title={
                <span className="inline-flex items-center gap-1.5">
                  插件连接与更新
                  {updateStatus?.availableUpdate && (
                    <span className="inline-flex h-5 items-center rounded-full bg-[var(--warn-soft)] px-2 text-[11px] font-semibold text-[var(--warn)]">
                      有更新
                    </span>
                  )}
                </span>
              }
              hint={`v${updateStatus?.currentSoftwareVersion ?? __WORKBENCH_VERSION__} · 插件热刷新 · 可选组件`}
              trailing={<IconChevron size={14} />}
              onClick={() => setSection('update')}
            />
            <MI
              icon={<IconInfo />}
              title="关于工作台"
              hint={`版本 v${__WORKBENCH_VERSION__} 与使用说明`}
              trailing={<IconChevron size={14} />}
              onClick={() => setSection('about')}
            />
          </div>
          <div className="grid gap-0.5">
            <span className={MENU_GROUP_LBL}>快捷操作</span>
            {p.onOpenDiagnosticModal && (
              <MI
                icon={<IconFile />}
                title="记录问题现场"
                hint="导出完整状态与日志反馈压缩包"
                titleAttr="一键打包当前浏览器状态、日志与黑匣子记录为反馈包"
                onClick={() => {
                  onClose();
                  p.onOpenDiagnosticModal?.();
                }}
              />
            )}
            <MI
              icon={<IconCopy />}
              title="复制插件路径"
              hint="复制固定扩展安装目录路径"
              titleAttr={
                updateStatus?.extensionDirectory
                  ? `点击复制固定插件目录：${updateStatus.extensionDirectory}`
                  : '点击复制浏览器扩展（固定插件目录）路径'
              }
              onClick={() =>
                void (async () => {
                  try {
                    const dir =
                      updateStatus?.extensionDirectory ||
                      (await api.softwareUpdateStatus()).extensionDirectory;
                    await copyTextToClipboard(dir);
                    onNotify?.(`已复制固定插件路径：${dir}`);
                  } catch (err) {
                    onNotify?.(errMsg(err, '复制插件路径失败'));
                  }
                })()
              }
            />
            <MI
              icon={<IconFolder />}
              title="打开 AI 专属工作夹"
              hint="打开目录并复制路径（Antigravity / Codex）"
              titleAttr={
                updateStatus?.aiWorkspaceDirectory
                  ? `打开固定的 AI 专属工作夹（支持 Antigravity / Codex）：${updateStatus.aiWorkspaceDirectory}`
                  : '打开固定的 AI 专属工作夹（支持 Antigravity / Codex）'
              }
              onClick={() =>
                void api
                  .openAiWorkspaceDirectory()
                  .then(async ({ directory }) => {
                    await copyTextToClipboard(directory).catch(() => {});
                    onNotify?.(`已打开 AI 专属工作夹并复制路径：${directory}`);
                  })
                  .catch((err) => onNotify?.(errMsg(err, '打开 AI 专属工作夹失败')))
              }
            />
            <MI
              icon={<IconPower />}
              warn
              title="重启软件"
              hint={restartDisabled ? '有任务执行中，暂不可重启' : '重新载入本地控制服务'}
              titleAttr={restartDisabled ? '有任务正在执行或排队，请先暂停或停止' : ''}
              disabled={busy || restartDisabled}
              onClick={() => setConfirmRestart(true)}
            />
          </div>
        </nav>
      ) : (
        <div className="rounded-xl border border-[var(--line)] bg-white p-4 shadow-2xs empty:hidden [&_dd]:m-0 [&_dl]:grid [&_dl]:grid-cols-[100px_1fr] [&_dl]:gap-3 [&_dl]:text-xs [&_dt]:text-[#8b949d] [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3:first-child]:mt-0 [&_p]:mt-2 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-[var(--text-2)]">
          {section === 'google-sheets' && (
            <GoogleSheetsAuthPanel onChanged={p.onGoogleSheetsChanged} />
          )}
          {section === 'preferences' && (
            <>
              <div className={MENU_PANEL}>
                <h3>窗口排版（统一入口）</h3>
                <p>
                  多屏平铺、斜向堆叠、起始槽位与常用预设方案已统一整合至独立的「窗口排版」工作区。
                </p>
                <Btn
                  v="primary"
                  onClick={() => {
                    onClose();
                    p.onOpenWindowLayout?.();
                  }}
                >
                  前往窗口排版
                </Btn>
              </div>
              <hr className={MENU_DIVIDER} />
              <WorkspacePreferencesPanel />
            </>
          )}
          {section === 'backup' && (
            <WorkspaceBackupPanel onOpenMaintenance={() => setSection('logs')} />
          )}
          {section === 'logs' && (
            <WorkspaceMaintenancePanel onOpenBackup={() => setSection('backup')} />
          )}
          {section === 'update' && (
            <>
              <SoftwareUpdatePanel
                status={updateStatus ?? null}
                onStatus={p.onUpdateStatus ?? (() => {})}
                onApply={p.onApplyUpdate ?? (async () => {})}
                error={updateError}
              />
              <hr className={MENU_DIVIDER} />
              <BridgeConnectionPanel profiles={profiles} />
              <h3>已登记浏览器插件版本</h3>
              <div className={MENU_PANEL}>
                <div className="max-h-[300px] w-full overflow-auto rounded-md border border-[var(--line)] bg-white">
                  {!profiles.length && (
                    <p className="p-3 text-xs text-[var(--text-3)]">
                      尚未登记浏览器，打开已有 Chrome / Brave 并加载桥接插件后会自动连接。
                    </p>
                  )}
                  {profiles.map((r) => {
                    const match = r.extensionVersion === __BRIDGE_EXTENSION_VERSION__;
                    return (
                      <div
                        className="grid grid-cols-[minmax(90px,1fr)_52px_90px_96px] items-center gap-2.5 border-b border-[var(--line)] px-3 py-2 text-xs last:border-b-0"
                        key={r.id}
                      >
                        <strong className="truncate font-semibold">{profileDisplayName(r)}</strong>
                        <span>{r.online ? '已连接' : '离线'}</span>
                        <code className="font-mono">{r.extensionVersion ?? '版本未读取'}</code>
                        <span
                          className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-semibold whitespace-nowrap ${
                            r.online && !match
                              ? 'bg-[var(--warn-soft)] text-[var(--warn)]'
                              : 'bg-[var(--idle-soft)] text-[#6f7782]'
                          }`}
                        >
                          <i className="h-1.5 w-1.5 rounded-full bg-current" />
                          {!r.online
                            ? '连接后核对'
                            : !r.extensionVersion
                              ? '版本待确认'
                              : match
                                ? '版本一致'
                                : '版本不一致'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <hr className={MENU_DIVIDER} />
              <MediaComponentPanel />
            </>
          )}
          {section === 'about' && (
            <div className={MENU_PANEL}>
              <div className="flex items-center gap-3 text-[var(--brand)]">
                <IconShield size={22} />
                <div className="grid">
                  <strong className="text-base font-semibold text-[var(--text)]">
                    浏览器工作台
                  </strong>
                  <small className={UI_MUTED}>版本 v{__WORKBENCH_VERSION__}</small>
                </div>
              </div>
              <ol className="my-1.5 grid list-none gap-2.5 p-0 text-xs">
                {QUICK_STEPS.map(([h, body], idx) => (
                  <li className="flex gap-3 leading-relaxed text-[var(--text-2)]" key={h}>
                    <span className="mt-px grid h-[22px] w-[22px] shrink-0 place-content-center rounded-full bg-[var(--brand-soft)] text-xs font-bold text-[var(--brand)]">
                      {idx + 1}
                    </span>
                    <div>
                      <strong className="block text-[var(--text)]">{h}</strong>
                      {body}
                    </div>
                  </li>
                ))}
              </ol>
              <p className={UI_MUTED}>
                状态圆点：灰=离线，绿=已连接，蓝=运行中，黄=需留意，红=账号登出或受限。账号“未知”仅表示尚未检测，不代表异常。
              </p>
            </div>
          )}
        </div>
      )}
      {confirmRestart && (
        <ConfirmDialog
          title="确认重启软件"
          description="将重新载入本地控制服务与工作台界面，请确认当前无需保留未保存的编辑内容。"
          label="确认重启"
          danger={false}
          busy={busy}
          onClose={() => setConfirmRestart(false)}
          onConfirm={() => p.onRestart()}
        />
      )}
    </SlideDrawer>
  );
}
