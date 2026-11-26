import { useState } from 'react';
import type {
  BluestacksInstance,
  BluestacksLoginExistingPolicy,
  BluestacksRuntimeConfig,
  BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { NameDialog } from '../name-dialog.js';
import { SelectByIdsDialog, type SelectByIdsCandidate } from '../select-by-ids-dialog.js';
import { toggleSet } from '../selection.js';
import { UI_INPUT_SM, UI_SELECT_SM } from '../ui/primitives.js';
import { Btn, Chk, InFld, NativeFormDialog, SelFld, useBusyTask } from './shared/module-ui.js';

export type BluestacksRowDialog =
  | { kind: 'ids' }
  | { kind: 'config' }
  | { kind: 'rename'; id: string; alias: string }
  | { kind: 'delete'; ids: string[]; label: string }
  | { kind: 'login'; instance: BluestacksInstance }
  | { kind: 'switch'; instance: BluestacksInstance }
  | null;

const buildSelectCandidates = (instances: readonly BluestacksInstance[]): SelectByIdsCandidate[] =>
  instances.map((i) => ({
    id: i.id,
    keys: [
      ...new Set(
        [
          i.id,
          i.instanceKey,
          i.displayName,
          i.alias,
          i.accountName,
          i.accountId,
          i.numericAccountId,
          String(i.adbPort),
          i.serial,
        ]
          .map((v) => v?.trim().toLowerCase())
          .filter((v): v is string => Boolean(v)),
      ),
    ],
  }));

function BluestacksConfigDialog(p: {
  config: BluestacksRuntimeConfig;
  onSave: (input: {
    installDir: string | null;
    confPath: string | null;
    apkPath: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [installDir, setInstallDir] = useState(p.config.installDir ?? '');
  const [confPath, setConfPath] = useState(p.config.confPath ?? '');
  const [apkPath, setApkPath] = useState(p.config.apkPath ?? '');
  const { busy, error, run } = useBusyTask();
  const fields = [
    [
      'BlueStacks 安装目录（含 HD-Adb.exe / HD-Player.exe）',
      installDir,
      setInstallDir,
      p.config.detectedInstallDir ?? 'C:\\Program Files\\BlueStacks_nxt',
      500,
    ],
    [
      'bluestacks.conf 配置文件路径',
      confPath,
      setConfPath,
      p.config.detectedConfPath ?? 'D:\\BlueStacks_nxt\\bluestacks.conf',
      500,
    ],
    [
      'FB Lite 安装包（.apk）路径（留空自动探测本机 APK）',
      apkPath,
      setApkPath,
      p.config.detectedApkPath ?? '例如：D:\\...\\com.facebook.lite_x86_64.apk',
      600,
    ],
  ] as const;
  return (
    <NativeFormDialog
      title="蓝蝶多开路径与 APK 设置"
      subtitle={`留空将自动从系统注册表探测。当前探测状态：HD-Adb ${p.config.adbReady ? '已就绪' : '未找到'} · HD-Player ${p.config.playerReady ? '已就绪' : '未找到'}`}
      busy={busy}
      error={error}
      submitLabel={busy ? '保存中…' : '保存并刷新'}
      onClose={p.onClose}
      onSubmit={() =>
        void run(
          () =>
            p.onSave({
              installDir: installDir.trim() || null,
              confPath: confPath.trim() || null,
              apkPath: apkPath.trim() || null,
            }),
          '保存路径失败',
          p.onClose,
        )
      }
    >
      {fields.map(([label, val, setVal, ph, maxLength]) => (
        <InFld
          key={label}
          label={label}
          wrapClass="mb-1"
          className={`${UI_INPUT_SM} w-full`}
          value={val}
          onVal={setVal}
          placeholder={ph}
          maxLength={maxLength}
        />
      ))}
    </NativeFormDialog>
  );
}

function BluestacksLoginDialog(p: {
  instance: BluestacksInstance;
  onClose: () => void;
  onSubmit: (payload: {
    instanceId: string;
    account: string;
    password: string;
    totpSecret?: string;
    saveLoginInfo: boolean;
    ifAlreadyLoggedIn: BluestacksLoginExistingPolicy;
  }) => Promise<void>;
}) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [saveLoginInfo, setSaveLoginInfo] = useState(true);
  const [ifAlreadyLoggedIn, setIfAlreadyLoggedIn] = useState<BluestacksLoginExistingPolicy>(
    p.instance.accountState === 'logged-in' ? 'clear-and-relogin' : 'skip',
  );
  const { busy, error, setError, run } = useBusyTask();
  const inputs = [
    ['邮箱 / 手机号 / ID', account, setAccount, 'example@domain.com', true, 'text', 'off'],
    [
      '登录密码',
      password,
      setPassword,
      '输入密码（支持特殊符号）',
      true,
      'password',
      'new-password',
    ],
    [
      '2FA 密钥（Base32，可选，支持自动计算 6 位动态验证码）',
      totpSecret,
      setTotpSecret,
      '例如：XXXX XXXX XXXX XXXX（无 2FA 可留空）',
      false,
      'text',
      'off',
    ],
  ] as const;
  return (
    <NativeFormDialog
      title={`自动登录 FB Lite · ${p.instance.alias || p.instance.displayName}`}
      subtitle="凭证仅一次性用于本次 ADB 登录与 TOTP 计算，绝不落盘或写入日志。如遇 Facebook 安全验证将自动停下并标为「需验证」。"
      busy={busy}
      error={error}
      submitLabel={busy ? '启动登录…' : '开始自动登录'}
      onClose={p.onClose}
      onSubmit={() => {
        if (!account.trim() || !password) return setError('请填写账号和密码');
        void run(
          () =>
            p.onSubmit({
              instanceId: p.instance.id,
              account: account.trim(),
              password,
              ...(totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}),
              saveLoginInfo,
              ifAlreadyLoggedIn,
            }),
          '发起自动登录失败',
          p.onClose,
        );
      }}
    >
      {inputs.map(([label, val, setVal, ph, required, type, autoComplete]) => (
        <InFld
          key={label}
          label={label}
          wrapClass="mb-1"
          className={`${UI_INPUT_SM} w-full`}
          required={required}
          type={type}
          autoComplete={autoComplete}
          value={val}
          onVal={setVal}
          maxLength={200}
          placeholder={ph}
        />
      ))}
      <SelFld
        label="若该窗口已登录旧账号"
        wrapClass="mb-1"
        className={`${UI_SELECT_SM} w-full`}
        value={ifAlreadyLoggedIn}
        onVal={(v) => setIfAlreadyLoggedIn(v as BluestacksLoginExistingPolicy)}
      >
        <option value="skip">保留旧账号并跳过</option>
        <option value="clear-and-relogin">清除 FB Lite 数据后重新登录</option>
      </SelFld>
      <Chk
        className="mb-1"
        label="登录成功后自动点击「保存登录信息」"
        checked={saveLoginInfo}
        onChange={setSaveLoginInfo}
      />
    </NativeFormDialog>
  );
}

function BluestacksSwitchIdentityDialog(p: {
  instance: BluestacksInstance;
  onSwitch: (payload: {
    instanceId: string;
    targetName?: string;
    targetType?: 'personal' | 'page';
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [customName, setCustomName] = useState('');
  const { busy, error, run } = useBusyTask();
  const { instance } = p;
  const doSwitch = (payload: { targetName?: string; targetType?: 'personal' | 'page' }) =>
    void run(() => p.onSwitch({ instanceId: instance.id, ...payload }), '切换身份失败', p.onClose);
  const known = instance.managedIdentities ?? [];
  const role =
    instance.identityType === 'page'
      ? '专页身份'
      : instance.identityType === 'personal'
        ? '个人号身份'
        : '未知身份';
  return (
    <NativeFormDialog
      title={`切换个人 / 专页身份 · ${instance.alias || instance.displayName}`}
      subtitle={`当前身份：${role}${instance.accountName ? `（${instance.accountName}）` : ''}${instance.numericAccountId ? ` · ID: ${instance.numericAccountId}` : ''}`}
      busy={busy}
      error={error}
      submitLabel={busy ? '切换中…' : '按名称切换'}
      submitDisabled={!customName.trim()}
      onClose={p.onClose}
      onSubmit={() => customName.trim() && doSwitch({ targetName: customName.trim() })}
    >
      {known.length > 0 && (
        <div className="mb-1.5">
          <div className="mb-1.5 text-xs text-[var(--text-3)]">
            已识别名下身份（点击一键切换）：
          </div>
          <div className="flex flex-wrap gap-1.5">
            {known.map((item) => (
              <Btn
                key={`${item.identityType}:${item.name}`}
                v={item.active ? 'primary' : undefined}
                disabled={busy}
                onClick={() => doSwitch({ targetName: item.name, targetType: item.identityType })}
              >
                {item.identityType === 'page' ? '[专页] ' : '[个人] '}
                {item.name}
                {item.active ? ' (当前)' : ''}
              </Btn>
            ))}
          </div>
        </div>
      )}
      <div className="mb-1.5 flex gap-2">
        <Btn disabled={busy} onClick={() => doSwitch({ targetType: 'personal' })}>
          切回个人主号
        </Btn>
        <Btn disabled={busy} onClick={() => doSwitch({ targetType: 'page' })}>
          切换到名下专页
        </Btn>
      </div>
      <InFld
        label="或输入指定身份名称精确切换"
        wrapClass="mb-1"
        className={`${UI_INPUT_SM} w-full`}
        value={customName}
        onVal={setCustomName}
        maxLength={120}
        placeholder="输入专页名称或个人号姓名"
      />
    </NativeFormDialog>
  );
}

export function BluestacksSidebarDialogs(p: {
  state: BluestacksState | null;
  onChange: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  dialog: BluestacksRowDialog;
  onClose: () => void;
}) {
  const { dialog, onClose } = p;
  if (!dialog) return null;
  if (dialog.kind === 'ids') {
    return (
      <SelectByIdsDialog
        title="按名称 / 端口批量选中蓝蝶窗口"
        kind="profiles"
        description="支持粘贴多个蓝蝶窗口名（如 p023、kf7）、实例名（Pie64_1）、端口号（5565）或 FB 账号 ID，每行一个，也支持逗号、顿号或空格分隔。"
        candidates={buildSelectCandidates(p.state?.instances ?? [])}
        placeholder="每行或空格分隔输入窗口名（如 p023、kf7）、实例名（Pie64_1）或端口号（5565）"
        onClose={onClose}
        onApply={(ids, mode) =>
          p.onSelect(mode === 'replace' ? new Set(ids) : new Set([...p.selected, ...ids]))
        }
      />
    );
  }
  if (dialog.kind === 'config' && p.state) {
    return (
      <BluestacksConfigDialog
        config={p.state.config}
        onClose={onClose}
        onSave={async (payload) => p.onChange(await api.bluestacksAction('paths', payload))}
      />
    );
  }
  if (dialog.kind === 'rename') {
    return (
      <NameDialog
        title="修改窗口备注别名"
        initial={dialog.alias}
        onClose={onClose}
        onSubmit={async (name) =>
          p.onChange(await api.bluestacksAction('instances/rename', { id: dialog.id, alias: name }))
        }
      />
    );
  }
  if (dialog.kind === 'delete') {
    return (
      <ConfirmDialog
        title="移除窗口记录"
        description={`确定移除「${dialog.label}」的本地记录吗？（如果仍在多开器中，下次刷新会重新探测显示）`}
        label="移除"
        onClose={onClose}
        onConfirm={async () => {
          p.onChange(await api.bluestacksAction('instances/delete', { instanceIds: dialog.ids }));
          p.onSelect(toggleSet(p.selected, dialog.ids, false));
        }}
      />
    );
  }
  if (dialog.kind === 'login') {
    return (
      <BluestacksLoginDialog
        instance={dialog.instance}
        onClose={onClose}
        onSubmit={async (payload) =>
          p.onChange(await api.bluestacksAction('instances/login', payload))
        }
      />
    );
  }
  if (dialog.kind === 'switch') {
    return (
      <BluestacksSwitchIdentityDialog
        instance={dialog.instance}
        onClose={onClose}
        onSwitch={async (payload) =>
          p.onChange(await api.bluestacksAction('instances/switch-identity', payload))
        }
      />
    );
  }
  return null;
}
