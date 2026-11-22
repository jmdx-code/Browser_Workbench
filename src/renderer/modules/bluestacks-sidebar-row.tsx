import { useEffect, useRef } from 'react';
import {
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
  type BluestacksDailyInstanceStats,
  type BluestacksInstance,
} from '../../shared/bluestacks.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import { IconClose, IconEdit, IconMore, IconPlay, IconStop } from '../icons.js';
import { PopoverMenu, type MenuItem } from '../popover-menu.js';
import { ProfileAvatar, type StatusTone } from '../profile-avatar.js';

export function BluestacksGroupCheck({
  checked,
  mixed,
  onChange,
  label,
}: {
  checked: boolean;
  mixed: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={input}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={label}
      title={label}
    />
  );
}

function instanceTone(
  inst: BluestacksInstance,
  isRunning: boolean,
  isBusyAction: boolean,
): StatusTone {
  if (isRunning || isBusyAction) return 'run';
  if (!inst.online) return 'idle';
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) return 'err';
  if (
    inst.accountState === 'missing-app' ||
    inst.accountState === 'logged-out' ||
    inst.accountState === 'restricted' ||
    inst.accountState === 'verification'
  ) {
    return 'err';
  }
  if (inst.accountState === 'logged-in') return 'ok';
  return 'warn';
}

export function BluestacksInstanceRow({
  inst,
  stat,
  dailyStat,
  selected,
  busy,
  isLaunching,
  isClosing,
  isInspecting,
  isInstalling = false,
  isLoggingIn = false,
  isSwitching = false,
  onSelectRow,
  onExec,
  onRename,
  onDelete,
  onLogin,
  onSwitchIdentity,
}: {
  inst: BluestacksInstance;
  stat: BumperProfileStat | undefined;
  dailyStat?: BluestacksDailyInstanceStats | undefined;
  selected: boolean;
  busy: boolean;
  isLaunching: boolean;
  isClosing: boolean;
  isInspecting: boolean;
  isInstalling?: boolean;
  isLoggingIn?: boolean;
  isSwitching?: boolean;
  onSelectRow: (id: string, checked: boolean, shiftKey: boolean) => void;
  onExec: (action: string, payload?: unknown) => void;
  onRename: () => void;
  onDelete: () => void;
  onLogin: () => void;
  onSwitchIdentity: () => void;
}) {
  const isRunning = Boolean(stat?.running);
  const isActionBusy = isLaunching || isInspecting || isInstalling || isLoggingIn || isSwitching;
  const tone = instanceTone(inst, isRunning, isActionBusy);
  const title = bluestacksDisplayTitle(inst);
  const roleTag =
    inst.accountState === 'logged-in'
      ? inst.identityType === 'page'
        ? '专页'
        : inst.identityType === 'personal'
          ? '个人'
          : ''
      : '';
  const isPortrait = isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight);
  const subCode = inst.accountName
    ? roleTag
      ? `[${roleTag}] ${inst.accountName}`
      : inst.accountName
    : isPortrait
      ? `:${inst.adbPort}`
      : `横屏 :${inst.adbPort}`;
  const isRiskSleeping = Boolean(dailyStat?.limitReached && !isRunning && !isActionBusy);
  const lineText = isInstalling
    ? '正在安装 FB Lite…'
    : isLoggingIn
      ? '正在自动登录…'
      : isSwitching
        ? '正在切换身份…'
        : isRiskSleeping
          ? `风控休眠 · 今日 ${dailyStat?.totalActionsToday ?? 0}/${dailyStat?.effectiveLimits.dailyMaxTotalActions || '∞'}`
          : (stat?.status ?? (inst.online ? '在线就绪' : '未启动'));
  const lineTone = isRunning || isActionBusy ? 'run' : isRiskSleeping ? 'warn' : tone;

  const menuItems: MenuItem[] = [
    ...(inst.online
      ? [
          {
            label: '显示蓝蝶窗口',
            disabled: busy || isClosing,
            onSelect: () => onExec('instances/show', { instanceId: inst.id }),
          },
          {
            label: '关闭蓝蝶窗口',
            icon: <IconStop />,
            disabled: busy || isRunning || isClosing,
            onSelect: () => onExec('instances/close', { instanceIds: [inst.id] }),
          },
        ]
      : [
          {
            label: '启动蓝蝶窗口',
            icon: <IconPlay />,
            disabled: busy || isLaunching,
            onSelect: () => onExec('instances/launch', { instanceIds: [inst.id] }),
          },
        ]),
    {
      label: '识别账号与身份',
      disabled: busy || isRunning || isActionBusy,
      onSelect: () => onExec('instances/inspect', { instanceIds: [inst.id] }),
    },
    {
      label: '切换个人 / 专页身份',
      disabled: busy || isRunning || isActionBusy || inst.accountState !== 'logged-in',
      onSelect: onSwitchIdentity,
    },
    {
      label: '自动登录 FB Lite (支持 2FA)',
      disabled: busy || isRunning || isActionBusy,
      onSelect: onLogin,
    },
    {
      label: inst.fbLiteInstalled ? '升级 / 重装 FB Lite APK' : '安装 FB Lite APK',
      disabled: busy || isRunning || isActionBusy,
      onSelect: () => onExec('instances/install-apk', { instanceIds: [inst.id] }),
    },
    ...(isRunning
      ? [
          {
            label: '停止当前任务',
            danger: true,
            onSelect: () => onExec('stop-all', { profileIds: [inst.id] }),
          },
        ]
      : []),
    {
      label: '修改备注别名',
      icon: <IconEdit />,
      onSelect: onRename,
    },
    {
      label: '移除列表记录',
      icon: <IconClose />,
      danger: true,
      disabled: busy || isRunning,
      onSelect: onDelete,
    },
  ];

  const tooltipLines = [
    `${title} (${inst.instanceKey}) · 127.0.0.1:${inst.adbPort} · ${inst.fbWidth}×${inst.fbHeight}`,
    ...(inst.androidSdk || inst.fbLiteVersion
      ? [`Android SDK ${inst.androidSdk ?? '?'} · FB Lite ${inst.fbLiteVersion ?? '未知'}`]
      : []),
    ...(inst.numericAccountId ? [`FB 数字 ID：${inst.numericAccountId}`] : []),
    ...(inst.managedIdentities && inst.managedIdentities.length > 0
      ? [`名下身份：${inst.managedIdentities.map((m) => m.name).join(' / ')}`]
      : []),
    ...(dailyStat
      ? [
          `今日动作：总 ${dailyStat.totalActionsToday}/${dailyStat.effectiveLimits.dailyMaxTotalActions || '不限'}（顶贴 ${dailyStat.groupBumpsToday + dailyStat.pageBumpsToday} / 发帖 ${dailyStat.postsToday} / 邀人 ${dailyStat.invitesToday} / 活跃赞 ${dailyStat.activeLikesToday}）`,
        ]
      : []),
    ...(dailyStat?.limitReason ? [`风控状态：${dailyStat.limitReason}`] : []),
    ...(tone === 'err' && lineText ? [`状态：${lineText}`] : []),
  ];

  return (
    <div
      className={'profile-row' + (selected ? ' selected' : '')}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest('button,input')) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          onSelectRow(inst.id, !selected, e.shiftKey);
        }
      }}
    >
      <input
        type="checkbox"
        aria-label={'选择 ' + title}
        checked={selected}
        onChange={(e) =>
          onSelectRow(
            inst.id,
            e.target.checked,
            e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey,
          )
        }
      />
      <ProfileAvatar
        url={inst.avatarUrl}
        online={inst.online}
        refreshKey={inst.updatedAt}
        tone={tone}
        toneLabel={tone === 'err' ? '异常' : inst.online ? '在线' : '未启动'}
      />
      <button
        type="button"
        className="profile-main"
        title={tooltipLines.join('\n')}
        onClick={(e) => onSelectRow(inst.id, !selected, e.shiftKey)}
      >
        <span className="profile-line">
          <strong>{title}</strong>
          <code className="fb-id">{subCode}</code>
        </span>
        <span className={'task-line tone-' + lineTone}>
          <span className="task-line-text">{lineText}</span>
        </span>
      </button>
      <PopoverMenu
        className="row-menu"
        label={'更多 · ' + title}
        trigger={<IconMore size={15} />}
        items={menuItems}
      />
    </div>
  );
}
