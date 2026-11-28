import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { CacheOverview } from '../shared/material-cache-management.js';
import type { MaterialUsage, MaterialUsageClearRequest } from '../shared/material-usage.js';
import { MaintenanceOverview } from '../shared/runtime-log.js';
import {
  WorkspaceBackupStatus,
  type BackupResult,
  type RestoreInspection,
  type RestoreStatus,
} from '../shared/workspace-backup.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DataCleanupPanel, isIntInRange, StatusAlerts } from './data-cleanup-panel.js';
import { Btn, Chk, useAbortQuery, useBusyTask } from './modules/shared/module-ui.js';
import {
  downloadJsonFile,
  FileLocationButton,
  UI_INPUT,
  UI_INPUT_SM,
  UI_MUTED,
} from './ui/primitives.js';
const LOG_LABELS: Record<string, string> = {
  ready: '可用',
  busy: '写入中',
  unavailable: '不可用',
  'capacity-reached': '已达当日容量',
};
const DIR_CLS =
  '[&_[role=status]]:mt-3 [&_[role=status]]:grid [&_[role=status]]:gap-2 [&_[role=status]]:justify-items-start';
const HR = <hr className="my-3.5 border-0 border-t border-[var(--line)]" />;
function FolderActionRow(p: {
  ariaLabel: string;
  value: string;
  placeholder: string;
  inputDisabled: boolean;
  onChange: (v: string) => void;
  pickerLabel?: string | false;
  pickerDisabled?: boolean;
  onPick?: () => void;
  actionLabel: string;
  actionPrimary?: boolean;
  actionDisabled: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <input
        className={`${UI_INPUT} min-w-[200px] flex-1`}
        aria-label={p.ariaLabel}
        value={p.value}
        disabled={p.inputDisabled}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {p.pickerLabel && p.onPick && (
        <Btn disabled={p.pickerDisabled} onClick={p.onPick}>
          {p.pickerLabel}
        </Btn>
      )}
      <Btn
        v={p.actionPrimary ? 'primary' : 'default'}
        disabled={p.actionDisabled}
        onClick={p.onAction}
      >
        {p.actionLabel}
      </Btn>
    </div>
  );
}
export function WorkspaceBackupPanel(p?: { onOpenMaintenance?: () => void }) {
  const { data: status, error: loadErr } = useAbortQuery<z.infer<typeof WorkspaceBackupStatus>>(
    api.backupStatus,
    0,
    '备份状态读取失败，请重新打开设置',
  );
  const [directory, setDirectory] = useState(
      () => localStorage.getItem('workspace-backup-directory') ?? '',
    ),
    [redactSecrets, setRedactSecrets] = useState(false),
    [result, setResult] = useState<BackupResult | null>(null);
  const { busy, error: err, run } = useBusyTask();
  useEffect(() => {
    if (status?.defaultDirectory) setDirectory((p) => p || status.defaultDirectory || '');
  }, [status?.defaultDirectory]);
  return (
    <div className={DIR_CLS}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="!m-0">数据备份</h3>
        {p?.onOpenMaintenance && <Btn onClick={p.onOpenMaintenance}>前往数据清理与重置</Btn>}
      </div>
      <p>
        保存分组、浏览器资料、组合、资源表、任务及使用记录。原素材和媒体缓存保持原位，不复制到备份中。
      </p>
      <FolderActionRow
        ariaLabel="数据备份保存位置"
        value={directory}
        inputDisabled={busy}
        placeholder={status?.defaultDirectory ?? '选择本机文件夹，或填写完整路径'}
        onChange={setDirectory}
        pickerLabel={
          typeof window.workbenchDesktop?.chooseBackupDirectory === 'function' && '选择文件夹…'
        }
        pickerDisabled={busy}
        onPick={() => {
          const prev = directory;
          void run(async () => {
            try {
              const v = await window.workbenchDesktop?.chooseBackupDirectory();
              if (v) setDirectory(v);
            } catch {
              setDirectory(prev);
              throw Error('文件夹选择失败');
            }
          }, '文件夹选择失败');
        }}
        actionLabel={busy ? '正在备份…' : '创建数据备份'}
        actionPrimary
        actionDisabled={busy || !status?.available || !directory.trim()}
        onAction={() => {
          if (!directory.trim()) return;
          setResult(null);
          void run(async () => {
            const value = await api.createBackup(directory.trim(), redactSecrets);
            localStorage.setItem('workspace-backup-directory', directory.trim());
            setResult(value);
          }, '备份未完成，请检查保存位置');
        }}
      />
      <Chk
        className="mt-2 text-xs"
        label="导出时移除 Google 授权与图床密钥"
        checked={redactSecrets}
        disabled={busy}
        onChange={setRedactSecrets}
      />
      {status?.reason && <p>{status.reason}</p>}
      <StatusAlerts err={err || loadErr} />
      {result && (
        <div role="status">
          <p>备份已保存：{result.directory}</p>
          <FileLocationButton source={`${result.directory}/backup.json`} label="打开备份位置" />
        </div>
      )}
      <p className={UI_MUTED}>备份时请先暂停或停止任务。每次生成独立文件夹，保留旧备份。</p>
      <WorkspaceRestorePanel />
    </div>
  );
}
function WorkspaceRestorePanel() {
  const {
    data: status,
    setData: setStatus,
    error: loadErr,
  } = useAbortQuery<RestoreStatus>(api.restoreStatus, 0, '恢复状态读取失败');
  const [directory, setDirectory] = useState(''),
    [inspection, setInspection] = useState<RestoreInspection | null>(null),
    [confirmRestore, setConfirmRestore] = useState(false);
  const { busy, error: err, setError, run } = useBusyTask();
  const locked = busy || status?.state === 'READY';
  return (
    <div className={`mt-4 ${DIR_CLS}`}>
      <h3>恢复数据</h3>
      <p>
        选择备份文件夹中的
        backup.json，先核对内容，再重启恢复。素材路径保持原样；原文件需要仍在原位置。
      </p>
      <FolderActionRow
        ariaLabel="待恢复备份文件夹"
        value={directory}
        inputDisabled={locked}
        placeholder={
          status?.defaultDirectory
            ? `默认从 ${status.defaultDirectory} 选择具体备份文件夹`
            : '完整备份文件夹路径'
        }
        onChange={(v) => {
          setDirectory(v);
          setInspection(null);
        }}
        pickerLabel={
          typeof window.workbenchDesktop?.chooseRestoreBackup === 'function' && '选择备份…'
        }
        pickerDisabled={locked}
        onPick={() =>
          void run(async () => {
            const v = await window.workbenchDesktop?.chooseRestoreBackup();
            if (v) {
              setDirectory(v);
              setInspection(null);
            }
          }, '备份选择失败')
        }
        actionLabel={busy ? '正在处理…' : '检查备份'}
        actionDisabled={locked || !status?.available || !directory.trim()}
        onAction={() =>
          void run(async () => {
            setInspection(null);
            setInspection(await api.inspectRestore(directory.trim()));
          }, '备份检查失败')
        }
      />
      {inspection && (
        <div role="status">
          <p>
            {new Date(inspection.createdAt).toLocaleString()} · 软件 {inspection.softwareVersion} ·{' '}
            {inspection.groups} 个分组、{inspection.combinations} 个组合、{inspection.profiles}{' '}
            份资料、{inspection.tasks} 条任务
          </p>
          <Btn v="primary" disabled={busy} onClick={() => setConfirmRestore(true)}>
            使用这份备份恢复…
          </Btn>
        </div>
      )}
      {confirmRestore && inspection && (
        <ConfirmDialog
          title="确认恢复备份"
          label="确认恢复"
          onClose={() => setConfirmRestore(false)}
          description="恢复这份备份将替换当前软件数据。重启前会自动保留当前数据备份；原素材不会移动。恢复后的旧任务不会自动发布。是否继续？"
          onConfirm={() =>
            run(async () => {
              setStatus(await api.prepareRestore(inspection.directory));
              setInspection(null);
            }, '恢复准备失败')
          }
        />
      )}
      {status && status.state !== 'NONE' && (
        <div role="status">
          <p>{status.reason}</p>
          {status.state === 'READY' && (
            <Btn
              v="primary"
              disabled={busy}
              onClick={() =>
                window.workbenchDesktop?.restartSoftware
                  ? void window.workbenchDesktop
                      .restartSoftware()
                      .catch(() => setError('自动重启失败，请关闭并重新打开软件'))
                  : setError('请关闭并重新启动桌面软件完成恢复')
              }
            >
              重启并恢复
            </Btn>
          )}
          {status.safetyDirectory && (
            <FileLocationButton
              source={`${status.safetyDirectory}/backup.json`}
              label="查看恢复前的备份"
            />
          )}
        </div>
      )}
      <StatusAlerts err={err || loadErr} />
    </div>
  );
}
function MaterialCachePanel() {
  const [rev, setRev] = useState(0),
    [confirm, setConfirm] = useState<string[] | null>(null),
    [notice, setNotice] = useState('');
  const { data: status, error: loadErr } = useAbortQuery<CacheOverview>(
    api.materialCache,
    rev,
    '上传缓存读取失败，请重新读取。',
  );
  const { busy, error: err, run } = useBusyTask();
  const eligible = status?.entries.filter((e) => e.eligible) ?? [],
    bytes = status?.entries.reduce((sum, e) => sum + e.bytes, 0) ?? 0;
  return (
    <section aria-label="上传缓存">
      <h3>上传缓存</h3>
      {status && (
        <p>
          缓存预留 {(bytes / 1024 / 1024).toFixed(1)} MB · 可清理 {eligible.length} 项 · 受保护{' '}
          {status.entries.length - eligible.length} 项{status.truncated ? ' · 显示前200项' : ''}
        </p>
      )}
      {!!status?.entries.some((e) => !e.eligible) && (
        <p className={UI_MUTED}>停止、结果或文件归属未确认的缓存保留。</p>
      )}
      <StatusAlerts err={err || loadErr} notice={notice} />
      <Btn
        disabled={busy || !eligible.length}
        onClick={() => setConfirm(eligible.slice(0, 50).map((e) => e.stageId))}
      >
        清理已结束缓存
      </Btn>
      {confirm && (
        <ConfirmDialog
          title="清理上传缓存"
          label="清理缓存"
          onClose={() => setConfirm(null)}
          description={`将检查并清理${confirm.length}项已结束的上传缓存。原素材和任务历史保留；执行中、未确认结果以及不匹配的缓存不会删除。`}
          onConfirm={async () => {
            setNotice('');
            await run(async () => {
              const res = await api.cleanMaterialCache(confirm),
                cleaned = res.results.filter((e) => e.cleaned).length;
              setNotice(`已清理 ${cleaned} 项，${res.results.length - cleaned} 项未清理。`);
              setRev((v) => v + 1);
            }, '清理结果未确认，请重新读取缓存状态；不会自动重试。');
          }}
        />
      )}
    </section>
  );
}
function MaterialUsagePanel() {
  const [rev, setRev] = useState(0),
    [notice, setNotice] = useState(''),
    [clear, setClear] = useState<MaterialUsageClearRequest | null>(null);
  const { data: usage, error } = useAbortQuery<MaterialUsage>(
    api.materialUsage,
    rev,
    '使用记录读取失败，请重新读取或更新软件',
  );
  return (
    <section aria-label="活跃账号素材使用记录">
      <h3>活跃账号素材使用记录</h3>
      <p>
        仅针对「活跃账号」模块的发帖/快拍素材防重（不影响小组发帖与云表协同）。原素材位置保持不变；清空后可再次取用。
      </p>
      {usage && (
        <p>
          当前已用：{usage.contents} 条资源 · {usage.published} 次已确认发布
          {usage.lastClearedAt
            ? ` · 最近清空：${new Date(usage.lastClearedAt).toLocaleString()}`
            : ''}
        </p>
      )}
      {usage?.activePublishing && (
        <p className={UI_MUTED}>有活跃账号发帖任务尚未结束，先停止后再清空。</p>
      )}
      <StatusAlerts err={error} notice={notice} />
      <Btn
        disabled={!usage || usage.activePublishing || !usage.published}
        onClick={() =>
          usage &&
          setClear({
            requestId: crypto.randomUUID(),
            expectedGeneration: usage.generation,
            expectedPublished: usage.published,
          })
        }
      >
        清空活跃账号素材记录
      </Btn>
      {clear && (
        <ConfirmDialog
          title="清空素材使用记录"
          label="清空使用记录"
          onClose={() => setClear(null)}
          description="将清空所有组合的已使用标记，让重复素材可被新的任务再次取用。原文件和任务历史保留；待核对的未确认发布内容不会解除保护。"
          onConfirm={async () => {
            await api.clearMaterialUsage(clear);
            setNotice('已清空使用记录，重复素材可用于新任务；原任务历史保留。');
            setRev((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}
export function WorkspaceMaintenancePanel(p?: { onOpenBackup?: () => void }) {
  const {
    data: saved,
    setData: setSaved,
    error: loadErr,
  } = useAbortQuery<z.infer<typeof MaintenanceOverview>>(api.maintenance, 0, '维护设置读取失败。');
  const [days, setDays] = useState('14'),
    [notice, setNotice] = useState(''),
    [settingsRev, setSettingsRev] = useState(0);
  const { busy, error: err, setError: setErr, run } = useBusyTask();
  useEffect(() => {
    if (saved) setDays(String(saved.settings.logRetentionDays));
  }, [saved]);
  const valid = isIntInRange(days, 1, 90);
  function execute(kind: 'save' | 'export') {
    if (!saved || (kind === 'save' && !valid)) return;
    setNotice('');
    setErr('');
    void run(
      async () => {
        const signal = AbortSignal.timeout(10_000);
        if (kind === 'save') {
          setSaved(
            await api.saveMaintenance(
              { expectedRevision: saved.settings.revision, logRetentionDays: Number(days) },
              signal,
            ),
          );
          setSettingsRev((v) => v + 1);
          setNotice('日志保留设置已保存。');
        } else {
          const value = await api.runtimeLogs(signal);
          downloadJsonFile(`browser-workbench-log-${value.generatedAt.slice(0, 10)}.json`, value);
          setNotice(
            `已导出${value.records.length}条日志${value.truncated ? '（仅最近记录）' : ''}。`,
          );
        }
      },
      kind === 'save' ? '保存未确认，请重新读取；不会自动重试。' : '日志导出失败。',
    );
  }
  return (
    <section aria-label="日志与位置">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="!m-0">日志与位置</h3>
        {p?.onOpenBackup && <Btn onClick={p.onOpenBackup}>前往数据备份与恢复</Btn>}
      </div>
      <dl>
        <dt>上传缓存位置</dt>
        <dd className="break-all">{saved?.locations.cacheDirectory ?? '未读取'}</dd>
        <dt>运行日志位置</dt>
        <dd className="break-all">{saved?.locations.logDirectory ?? '未读取'}</dd>
        <dt>日志状态</dt>
        <dd>{saved ? (LOG_LABELS[saved.logStatus] ?? saved.logStatus) : '未读取'}</dd>
      </dl>
      <form
        className="mt-2.5 flex flex-wrap items-center gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          execute('save');
        }}
      >
        <label className="inline-flex items-center gap-1.5">
          运行与诊断日志保留天数{' '}
          <input
            type="number"
            className={`${UI_INPUT_SM} w-[76px]`}
            min="1"
            max="90"
            step="1"
            value={days}
            disabled={!saved || busy}
            onChange={(e) => setDays(e.target.value)}
            aria-invalid={!valid}
          />
        </label>
        <Btn
          type="submit"
          v="primary"
          disabled={!saved || busy || !valid || Number(days) === saved.settings.logRetentionDays}
        >
          保存日志设置
        </Btn>
        <Btn disabled={!saved || busy} onClick={() => execute('export')}>
          导出运行日志
        </Btn>
      </form>
      <StatusAlerts
        err={!valid ? '日志保留天数请输入1至90的整数。' : err || loadErr}
        notice={notice}
      />
      {HR}
      <MaterialCachePanel />
      {HR}
      <MaterialUsagePanel />
      {HR}
      <DataCleanupPanel
        logRetentionDays={saved?.settings.logRetentionDays}
        settingsRevision={settingsRev}
      />
    </section>
  );
}
