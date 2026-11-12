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
  onSave: (input: { installDir: string | null; confPath: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [installDir, setInstallDir] = useState(config.installDir ?? '');
  const [confPath, setConfPath] = useState(config.confPath ?? '');
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
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存路径失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="name-dialog" onCancel={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>蓝蝶多开路径设置</h3>
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
    </>
  );
}
