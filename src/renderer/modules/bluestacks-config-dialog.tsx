import { useEffect, useRef, useState } from 'react';
import type {
  BluestacksInstance,
  BluestacksRuntimeConfig,
  BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { NameDialog } from '../name-dialog.js';
import { SelectByIdsDialog, type SelectByIdsCandidate } from '../select-by-ids-dialog.js';
import { toggleSet } from '../selection.js';

export function buildBluestacksSelectCandidates(
  instances: readonly BluestacksInstance[],
): SelectByIdsCandidate[] {
  return instances.map((inst) => {
    const keys = new Set<string>();
    const addKey = (val: string | null | undefined) => {
      const cleaned = val?.trim().toLowerCase();
      if (cleaned) keys.add(cleaned);
    };
    addKey(inst.id);
    addKey(inst.instanceKey);
    addKey(inst.displayName);
    addKey(inst.alias);
    addKey(inst.accountName);
    addKey(inst.accountId);
    addKey(String(inst.adbPort));
    addKey(inst.serial);
    return {
      id: inst.id,
      keys: [...keys],
    };
  });
}

export function BluestacksConfigDialog({
  config,
  onSave,
  onClose,
}: {
  config: BluestacksRuntimeConfig;
  onSave: (input: {
    installDir: string | null;
    confPath: string | null;
    apkPath: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [installDir, setInstallDir] = useState(config.installDir ?? '');
  const [confPath, setConfPath] = useState(config.confPath ?? '');
  const [apkPath, setApkPath] = useState(config.apkPath ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave({
        installDir: installDir.trim() || null,
        confPath: confPath.trim() || null,
        apkPath: apkPath.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存路径失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="name-dialog"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>蓝蝶多开路径与 APK 设置</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          留空将自动从系统注册表探测。当前探测状态：HD-Adb {config.adbReady ? '已就绪' : '未找到'}
          {' · '}HD-Player {config.playerReady ? '已就绪' : '未找到'}
        </p>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>BlueStacks 安装目录（含 HD-Adb.exe / HD-Player.exe）</span>
          <input
            value={installDir}
            placeholder={config.detectedInstallDir ?? 'C:\\Program Files\\BlueStacks_nxt'}
            onChange={(e) => setInstallDir(e.target.value)}
            maxLength={500}
          />
        </label>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>bluestacks.conf 配置文件路径</span>
          <input
            value={confPath}
            placeholder={config.detectedConfPath ?? 'D:\\BlueStacks_nxt\\bluestacks.conf'}
            onChange={(e) => setConfPath(e.target.value)}
            maxLength={500}
          />
        </label>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>FB Lite 安装包（.apk）路径（留空自动探测本机 APK）</span>
          <input
            value={apkPath}
            placeholder={config.detectedApkPath ?? '例如：D:\\...\\com.facebook.lite_x86_64.apk'}
            onChange={(e) => setApkPath(e.target.value)}
            maxLength={600}
          />
        </label>
        {error && <p className="text-danger">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存并刷新'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function BluestacksLoginDialog({
  instance,
  onSubmit,
  onClose,
}: {
  instance: BluestacksInstance;
  onSubmit: (payload: {
    instanceId: string;
    account: string;
    password: string;
    totpSecret?: string;
    saveLoginInfo: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [saveLoginInfo, setSaveLoginInfo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function submit() {
    if (busy) return;
    if (!account.trim() || !password) {
      setError('请填写账号和密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        instanceId: instance.id,
        account: account.trim(),
        password,
        ...(totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}),
        saveLoginInfo,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起自动登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="name-dialog"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>自动登录 FB Lite · {instance.alias || instance.displayName}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          凭证仅一次性用于本次 ADB 登录与 TOTP 计算，绝不落盘或写入日志。如遇 Facebook
          安全验证将自动停下并标为「需验证」。
        </p>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>邮箱 / 手机号 / ID</span>
          <input
            required
            autoComplete="off"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            maxLength={200}
            placeholder="example@domain.com"
          />
        </label>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>登录密码</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            placeholder="输入密码（支持特殊符号）"
          />
        </label>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>2FA 密钥（Base32，可选，支持自动计算 6 位动态验证码）</span>
          <input
            autoComplete="off"
            value={totpSecret}
            onChange={(e) => setTotpSecret(e.target.value)}
            maxLength={200}
            placeholder="例如：XXXX XXXX XXXX XXXX（无 2FA 可留空）"
          />
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={saveLoginInfo}
            onChange={(e) => setSaveLoginInfo(e.target.checked)}
          />
          <span>登录成功后自动点击「保存登录信息」</span>
        </label>
        {error && <p className="text-danger">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '启动登录…' : '开始自动登录'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function BluestacksSwitchIdentityDialog({
  instance,
  onSwitch,
  onClose,
}: {
  instance: BluestacksInstance;
  onSwitch: (payload: {
    instanceId: string;
    targetName?: string;
    targetType?: 'personal' | 'page';
  }) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [customName, setCustomName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function doSwitch(payload: { targetName?: string; targetType?: 'personal' | 'page' }) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSwitch({ instanceId: instance.id, ...payload });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换身份失败');
    } finally {
      setBusy(false);
    }
  }

  const known = instance.managedIdentities ?? [];
  const currentRole =
    instance.identityType === 'page'
      ? '专页身份'
      : instance.identityType === 'personal'
        ? '个人号身份'
        : '未知身份';

  return (
    <dialog
      ref={dialogRef}
      className="name-dialog"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (customName.trim()) void doSwitch({ targetName: customName.trim() });
        }}
      >
        <h3>切换个人 / 专页身份 · {instance.alias || instance.displayName}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          当前身份：<strong>{currentRole}</strong>
          {instance.accountName ? `（${instance.accountName}）` : ''}
          {instance.numericAccountId ? ` · ID: ${instance.numericAccountId}` : ''}
        </p>
        {known.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--muted)' }}>
              已识别名下身份（点击一键切换）：
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {known.map((item) => (
                <button
                  key={`${item.identityType}:${item.name}`}
                  type="button"
                  className={item.active ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                  disabled={busy}
                  onClick={() =>
                    void doSwitch({
                      targetName: item.name,
                      targetType: item.identityType,
                    })
                  }
                >
                  {item.identityType === 'page' ? '[专页] ' : '[个人] '}
                  {item.name}
                  {item.active ? ' (当前)' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void doSwitch({ targetType: 'personal' })}
          >
            切回个人主号
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void doSwitch({ targetType: 'page' })}
          >
            切换到名下专页
          </button>
        </div>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          <span>或输入指定身份名称精确切换</span>
          <input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            maxLength={120}
            placeholder="输入专页名称或个人号姓名"
          />
        </label>
        {error && <p className="text-danger">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy || !customName.trim()}>
            {busy ? '切换中…' : '按名称切换'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function BluestacksSidebarDialogs({
  state,
  onChange,
  selected,
  onSelect,
  selectByIdsOpen,
  onCloseSelectByIds,
  configOpen,
  onCloseConfig,
  renamingFolder,
  onCloseRenamingFolder,
  renamingInst,
  onCloseRenamingInst,
  deletingFolder,
  onCloseDeletingFolder,
  deletingInsts,
  onCloseDeletingInsts,
  loginInst,
  onCloseLoginInst,
  switchIdentityInst,
  onCloseSwitchIdentityInst,
}: {
  state: BluestacksState | null;
  onChange: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  selectByIdsOpen: boolean;
  onCloseSelectByIds: () => void;
  configOpen: boolean;
  onCloseConfig: () => void;
  renamingFolder: { id: string; name: string } | null;
  onCloseRenamingFolder: () => void;
  renamingInst: { id: string; alias: string } | null;
  onCloseRenamingInst: () => void;
  deletingFolder: { id: string; name: string } | null;
  onCloseDeletingFolder: () => void;
  deletingInsts: { ids: string[]; label: string } | null;
  onCloseDeletingInsts: () => void;
  loginInst: BluestacksInstance | null;
  onCloseLoginInst: () => void;
  switchIdentityInst: BluestacksInstance | null;
  onCloseSwitchIdentityInst: () => void;
}) {
  const instances = state?.instances ?? [];
  return (
    <>
      {selectByIdsOpen && (
        <SelectByIdsDialog
          title="按名称 / 端口批量选中蓝蝶窗口"
          kind="profiles"
          candidates={buildBluestacksSelectCandidates(instances)}
          placeholder="每行或空格分隔输入窗口名（如 p023、kf7）、实例名（Pie64_1）或端口号（5565）"
          onClose={onCloseSelectByIds}
          onApply={(ids, mode) => {
            onSelect(mode === 'replace' ? new Set(ids) : new Set([...selected, ...ids]));
            onCloseSelectByIds();
          }}
        />
      )}
      {configOpen && state && (
        <BluestacksConfigDialog
          config={state.config}
          onClose={onCloseConfig}
          onSave={async (payload) => {
            onChange(await api.bluestacksAction('paths', payload));
          }}
        />
      )}
      {renamingFolder && (
        <NameDialog
          title="重命名分组"
          initial={renamingFolder.name}
          onClose={onCloseRenamingFolder}
          onSubmit={async (name) => {
            onChange(await api.bluestacksAction('folders/rename', { id: renamingFolder.id, name }));
          }}
        />
      )}
      {renamingInst && (
        <NameDialog
          title="修改窗口备注别名"
          initial={renamingInst.alias}
          onClose={onCloseRenamingInst}
          onSubmit={async (name) => {
            onChange(
              await api.bluestacksAction('instances/rename', {
                id: renamingInst.id,
                alias: name,
              }),
            );
          }}
        />
      )}
      {deletingFolder && (
        <ConfirmDialog
          title="删除分组"
          description={`确定删除分组「${deletingFolder.name}」吗？组内蓝蝶窗口将自动回到未分组。`}
          label="删除分组"
          onClose={onCloseDeletingFolder}
          onConfirm={async () => {
            onChange(await api.bluestacksAction('folders/delete', { id: deletingFolder.id }));
          }}
        />
      )}
      {deletingInsts && (
        <ConfirmDialog
          title="移除窗口记录"
          description={`确定移除「${deletingInsts.label}」的本地记录吗？（如果仍在多开器中，下次刷新会重新探测显示）`}
          label="移除"
          onClose={onCloseDeletingInsts}
          onConfirm={async () => {
            onChange(
              await api.bluestacksAction('instances/delete', { instanceIds: deletingInsts.ids }),
            );
            onSelect(toggleSet(selected, deletingInsts.ids, false));
          }}
        />
      )}
      {loginInst && (
        <BluestacksLoginDialog
          instance={loginInst}
          onClose={onCloseLoginInst}
          onSubmit={async (payload) => {
            onChange(await api.bluestacksAction('instances/login', payload));
          }}
        />
      )}
      {switchIdentityInst && (
        <BluestacksSwitchIdentityDialog
          instance={switchIdentityInst}
          onClose={onCloseSwitchIdentityInst}
          onSwitch={async (payload) => {
            onChange(await api.bluestacksAction('instances/switch-identity', payload));
          }}
        />
      )}
    </>
  );
}
