import { useEffect, useRef } from 'react';
import {
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
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
  isLaunchingOrInspecting: boolean,
): StatusTone {
  if (isRunning || isLaunchingOrInspecting) return 'run';
  if (!inst.online) return 'idle';
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) return 'err';
  if (inst.accountState === 'missing-app' || inst.accountState === 'logged-out') return 'err';
  if (inst.accountState === 'logged-in') return 'ok';
  return 'warn';
}

export function BluestacksInstanceRow({
  inst,
  stat,
  selected,
  busy,
  isLaunching,
  isClosing,
  isInspecting,
  onSelectRow,
  onExec,
  onRename,
  onDelete,
}: {
  inst: BluestacksInstance;
  stat: BumperProfileStat | undefined;
  selected: boolean;
  busy: boolean;
  isLaunching: boolean;
  isClosing: boolean;
  isInspecting: boolean;
  onSelectRow: (id: string, checked: boolean, shiftKey: boolean) => void;
  onExec: (action: string, payload?: unknown) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const isRunning = Boolean(stat?.running);
  const tone = instanceTone(inst, isRunning, isLaunching || isInspecting);
  const title = bluestacksDisplayTitle(inst);
  const subCode = inst.accountName
    ? inst.accountName
    : `${inst.fbWidth}×${inst.fbHeight} · :${inst.adbPort}`;
  const lineText = stat?.status ?? (inst.online ? '在线就绪' : '未启动');
  const lineTone = isRunning || isLaunching || isInspecting ? 'run' : tone;

  const menuItems: MenuItem[] = [
    inst.online
      ? {
          label: '关闭蓝蝶窗口',
          icon: <IconStop />,
          disabled: busy || isRunning || isClosing,
          onSelect: () => onExec('instances/close', { instanceIds: [inst.id] }),
        }
      : {
          label: '启动蓝蝶窗口',
          icon: <IconPlay />,
          disabled: busy || isLaunching,
          onSelect: () => onExec('instances/launch', { instanceIds: [inst.id] }),
        },
    {
      label: '识别 FB Lite 账号',
      disabled: busy || !inst.online || isRunning || isInspecting,
      onSelect: () => onExec('instances/inspect', { instanceIds: [inst.id] }),
    },
    ...(isRunning
      ? [
          {
            label: '停止顶贴任务',
            danger: true,
            onSelect: () => onExec('bumper/stop', { profileIds: [inst.id] }),
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
        toneLabel={inst.online ? '在线' : '未启动'}
      />
      <button
        type="button"
        className="profile-main"
        title={`${title} (${inst.instanceKey}) · 127.0.0.1:${inst.adbPort} · ${inst.fbWidth}×${inst.fbHeight}`}
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
