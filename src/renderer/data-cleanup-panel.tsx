import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import {
  CleanupPreview,
  type CleanupConfiguration,
  type CleanupSelection,
} from '../shared/data-cleanup.js';
import { api } from './api.js';
import { cleanupDateEnd } from '../shared/cleanup-date.js';

type Selection = z.infer<typeof CleanupSelection>;
export function CleanupDialog({
  selection,
  onClose,
  onDone,
  initialPreview,
}: {
  initialPreview?: z.infer<typeof CleanupPreview>;
  selection: Selection;
  onClose(): void;
  onDone(deletedStepIds?: Iterable<string>): void;
}) {
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const selectionKey = JSON.stringify(selection);
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<z.infer<typeof CleanupPreview> | null>(
    initialPreview ?? null,
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void api
        .cleanupProgress()
        .then(setProgress)
        .catch(() => {});
    }, 500);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    if (!initialPreview)
      void api.cleanupPreview(selection, controller.signal).then(setPreview, (e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '预览失败');
      });
    return () => controller.abort();
  }, [selectionKey]);
  return (
    <dialog
      ref={dialog}
      className="name-dialog"
      aria-label="确认清理数据"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <h3>{selection.kind === 'records' ? '删除任务记录' : '清理日志'}</h3>
      {preview ? (
        <p>
          {selection.kind === 'records'
            ? `即将清理 ${preview.eligible} 条已结束的任务记录（正在运行或待核对的任务会自动保留，不受影响）。`
            : `即将清理 ${preview.eligible} 个日志文件，预计释放 ${(preview.bytes / 1024 / 1024).toFixed(2)} MB。`}
        </p>
      ) : (
        <p>
          {error ? '清理未完成。你可以重新预览后再试，或关闭此窗口。' : '正在检查可清理的记录…'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="danger"
          disabled={busy || (preview !== null ? !preview.eligible : !error)}
          onClick={() => {
            if (busy) return;
            if (!preview) {
              setBusy(true);
              void api
                .cleanupPreview(selection)
                .then(
                  (value) => {
                    setPreview(value);
                    setError('');
                  },
                  (error: unknown) =>
                    setError(
                      '无法预览：' + (error instanceof Error ? error.message : '请稍后重试'),
                    ),
                )
                .finally(() => setBusy(false));
              return;
            }
            setBusy(true);
            setError('');
            void api
              .cleanupExecute(preview.token)
              .then(
                (result) => {
                  if (result.protected > preview.protected || result.deleted < preview.eligible) {
                    setError(
                      `已清理 ${result.deleted} 条记录，其余记录状态已变化或仍在使用，已为你保留。请重新预览。`,
                    );
                    setPreview(null);
                    return;
                  }
                  if (selection.kind === 'records')
                    window.dispatchEvent(
                      new CustomEvent('task-records-deleted', {
                        detail: {
                          stepIds:
                            selection.kind === 'records' ? selection.scope.stepIds : undefined,
                        },
                      }),
                    );
                  onDone(selection.kind === 'records' ? selection.scope.stepIds : undefined);
                  onClose();
                },
                (e: unknown) => {
                  setError(
                    '清理未完成：' + (e instanceof Error ? e.message : '请稍后重新预览再试'),
                  );
                  setPreview(null);
                },
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy
            ? '清理中 ' +
              progress.current +
              ' / ' +
              (progress.total || preview?.eligible || 0) +
              '…'
            : error && !preview
              ? '重新预览'
              : '确认清理'}
        </button>
      </footer>
    </dialog>
  );
}

export function RecordCleanupActions({
  stepIds = [],
  selectedCount,
  profileId,
  onDone,
  showRetention = true,
  filters,
}: {
  showRetention?: boolean;
  filters?: ReactNode;
  stepIds?: string[];
  selectedCount?: number;
  profileId?: string;
  onDone(deletedStepIds?: Iterable<string>): void;
}) {
  const [date, setDate] = useState('');
  const [days, setDays] = useState('');
  const [count, setCount] = useState('');
  const [config, setConfig] = useState<CleanupConfiguration | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [prepared, setPrepared] = useState<z.infer<typeof CleanupPreview> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!showRetention) return;
    const controller = new AbortController();
    void api
      .cleanupSettings(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setConfig(value);
        setDays(value.historyRetentionDays === null ? '' : String(value.historyRetentionDays));
        setCount(value.historyMaxCount == null ? '' : String(value.historyMaxCount));
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice('保留规则读取失败，请重新打开页面');
      });
    return () => controller.abort();
  }, [showRetention]);
  const valid = (value: string, max: number) =>
    value.trim() === '' ||
    (Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max);
  const scopeProfile = profileId ? { profileId } : {};
  const open = (next: Selection) => {
    setPrepared(undefined);
    setSelection(next);
  };
  const save = async () => {
    if (busy || !config) return;
    setBusy(true);
    setNotice('');
    try {
      const current = await api.cleanupSettings();
      const next = await api.saveCleanupSettings({
        expectedRevision: current.revision,
        historyRetentionDays: days.trim() ? Number(days) : null,
        historyMaxCount: count.trim() ? Number(count) : null,
        automaticLogs: current.automaticLogs,
      });
      setConfig(next);
      if (next.historyRetentionDays === null && next.historyMaxCount == null) {
        setNotice('已保存保留规则，不限制天数和条数');
        return;
      }
      const selection: Selection = {
        kind: 'records',
        scope: {
          ...scopeProfile,
          ...(next.historyRetentionDays !== null
            ? { before: Math.max(0, Date.now() - next.historyRetentionDays * 86400000) }
            : {}),
          ...(next.historyMaxCount != null ? { keepLatestRuns: next.historyMaxCount } : {}),
        },
      };
      const preview = await api.cleanupPreview(selection);
      if (!preview.eligible) {
        setNotice('已保存保留规则，当前无超额记录');
        return;
      }
      setPrepared(preview);
      setSelection(selection);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="record-cleanup-toolbar">
      <div className="records-toolbar-row">
        {filters}
        <div className="settings-form record-cleanup-actions">
          {!!stepIds.length && (
            <button
              className="btn btn-sm record-selection-delete"
              onClick={() => open({ kind: 'records', scope: { stepIds, ...scopeProfile } })}
            >
              删除所选（{selectedCount ?? stepIds.length}）
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() =>
              open({ kind: 'records', scope: { before: Date.now() + 1, ...scopeProfile } })
            }
          >
            一键清理已结束
          </button>
          <input
            aria-label="任务记录清理截止日期"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            className="btn btn-sm"
            disabled={!date}
            onClick={() =>
              open({ kind: 'records', scope: { before: cleanupDateEnd(date), ...scopeProfile } })
            }
          >
            按日期清理
          </button>
        </div>
      </div>
      {showRetention && (
        <div className="record-retention-controls" aria-label="任务记录保留规则">
          <span>自动保留：</span>
          <label>
            最近{' '}
            <input
              type="number"
              min="1"
              max="3650"
              placeholder="不限"
              aria-label="保留天数"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />{' '}
            天
          </label>
          <label>
            · 最多{' '}
            <input
              type="number"
              min="1"
              max="100000"
              placeholder="不限"
              aria-label="最大条数"
              title="按已结束的任务运行次数计数"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />{' '}
            条
          </label>
          <button
            className="btn btn-sm"
            disabled={busy || !config || !valid(days, 3650) || !valid(count, 100000)}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存并清理'}
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="field-hint">
          {notice}
        </p>
      )}
      {selection && (
        <CleanupDialog
          selection={selection}
          {...(prepared ? { initialPreview: prepared } : {})}
          onClose={() => {
            setSelection(null);
            setPrepared(undefined);
          }}
          onDone={(ids) => {
            onDone(ids);
            setNotice('已清理超额或选中的已结束记录');
          }}
        />
      )}
    </div>
  );
}

export function DataCleanupPanel() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [settings, setSettings] = useState<CleanupConfiguration | null>(null);
  const [autoLogs, setAutoLogs] = useState(false);
  const [maxCount, setMaxCount] = useState('');
  const [days, setDays] = useState('30'),
    [automatic, setAutomatic] = useState(false),
    [logDate, setLogDate] = useState('');
  const [status, setStatus] = useState<{
    available: boolean;
    reason: string;
    dataDirectory: string;
  } | null>(null);
  const [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [resetOpen, setResetOpen] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.cleanupSettings(controller.signal),
      api.resetStatus(controller.signal),
    ]).then(
      ([config, reset]) => {
        if (controller.signal.aborted) return;
        setSettings(config);
        setAutoLogs(config.automaticLogs);
        setMaxCount(config.historyMaxCount == null ? '' : String(config.historyMaxCount));
        setAutomatic(config.historyRetentionDays !== null);
        setDays(String(config.historyRetentionDays ?? 30));
        setStatus(reset);
      },
      (e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '清理设置读取失败');
      },
    );
    return () => controller.abort();
  }, [reload]);
  const run = async (work: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setNotice(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未确认');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="数据清理">
      <h3>数据清理</h3>
      <p>
        日志删除会释放文件空间；普通任务全部记录删除后会清理原始历史，必要的未确认结果和素材使用数据保留。
      </p>
      <div className="settings-form">
        <button disabled={busy} onClick={() => setSelection({ kind: 'logs' })}>
          预览清空运行与诊断日志
        </button>
        <input
          type="date"
          aria-label="日志清理截止日期"
          value={logDate}
          onChange={(e) => setLogDate(e.target.value)}
        />
        <button
          disabled={!logDate || busy}
          onClick={() => setSelection({ kind: 'logs', before: cleanupDateEnd(logDate) })}
        >
          预览按日期清理日志
        </button>
      </div>
      <RecordCleanupActions
        showRetention={false}
        onDone={() => setNotice('已删除符合条件的记录，必要的未确认结果和素材使用数据保留。')}
      />
      <div className="settings-form">
        <label>
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => setAutomatic(e.target.checked)}
          />
          自动清理已结束的列表记录
        </label>
        <label>
          保留天数{' '}
          <input
            type="number"
            min="1"
            max="3650"
            value={days}
            disabled={!automatic}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
        <label>
          保留最大条数{' '}
          <input
            type="number"
            aria-label="自动保留最大条数"
            placeholder="不限"
            min="1"
            max="100000"
            value={maxCount}
            onChange={(e) => setMaxCount(e.target.value)}
          />
        </label>
        <button
          disabled={
            busy ||
            !settings ||
            (maxCount.trim() !== '' &&
              (!Number.isInteger(Number(maxCount)) ||
                Number(maxCount) < 1 ||
                Number(maxCount) > 100000)) ||
            (automatic &&
              (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 3650))
          }
          onClick={() =>
            void run(async () => {
              if (!settings) return '';
              const next = await api.saveCleanupSettings({
                expectedRevision: settings.revision,
                historyRetentionDays: automatic ? Number(days) : null,
                historyMaxCount: maxCount.trim() ? Number(maxCount) : null,
                automaticLogs: autoLogs,
              });
              setSettings(next);
              return '自动清理设置已保存';
            })
          }
        >
          保存自动清理设置
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.compactData();
              return '数据库空间已整理；必要的未确认结果和素材使用数据保留。';
            })
          }
        >
          整理数据库空间
        </button>
      </div>
      <label>
        <input type="checkbox" checked={autoLogs} onChange={(e) => setAutoLogs(e.target.checked)} />
        同时自动清理诊断日志（使用上方日志保留天数；随“保存自动清理设置”保存）
      </label>
      <h3>重置工作台</h3>
      {status?.dataDirectory && (
        <p style={{ overflowWrap: 'anywhere' }}>将清空的数据目录：{status.dataDirectory}</p>
      )}
      <p>
        清空本工作台的数据库、连接信息、组合、分组、设置、使用记录、日志和缓存，并重新打开软件。原素材、浏览器资料、浏览器登录状态及工作台数据目录以外的备份/导出文件保留。浏览器可能自动重新连接。
      </p>
      <p>
        重置会同时丢弃未保存编辑和未确认结果的防重复记录；重置后不要直接重跑可能已提交的旧内容。
      </p>
      <div className="settings-form">
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const value = await api.backupStatus(AbortSignal.timeout(10000));
              if (!value.canCreate) throw Error(value.reason);
              const directory = await window.workbenchDesktop?.chooseBackupDirectory();
              if (!directory) return '已取消备份';
              await api.createBackup(directory);
              return '数据备份已完成，备份目录在工作台数据目录之外。';
            })
          }
        >
          先备份数据…
        </button>
        <button disabled={busy} onClick={() => setReload((v) => v + 1)}>
          重新检查停止状态
        </button>
        <button
          className="danger"
          disabled={busy || !status?.available}
          onClick={() => setResetOpen(true)}
        >
          彻底重置工作台…
        </button>
      </div>
      {status && !status.available && <p className="field-hint">{status.reason}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {selection && (
        <CleanupDialog
          selection={selection}
          onClose={() => setSelection(null)}
          onDone={() => setNotice('清理操作已完成。')}
        />
      )}
      {resetOpen && <ResetDialog onClose={() => setResetOpen(false)} />}
    </section>
  );
}

function ResetDialog({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [phrase, setPhrase] = useState(''),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="name-dialog"
      aria-label="彻底重置工作台"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <h3>彻底重置工作台</h3>
      <p>
        这会删除工作台数据目录内的所有内容，无法撤销。请先自行保留所需备份；浏览器和原始素材不删除。
      </p>
      <label>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          disabled={busy}
        />
        我理解未保存编辑、历史记录和未确认结果的防重复数据也将丢失。
      </label>
      <label>
        请输入“确认重置”
        <input
          autoFocus
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          disabled={busy}
        />
      </label>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="danger"
          disabled={busy || !ack || phrase !== '确认重置'}
          onClick={() => {
            setBusy(true);
            void api
              .resetWorkspace({ confirmation: phrase, acknowledgeUnknownResults: ack })
              .catch((e: unknown) => {
                setBusy(false);
                setError(e instanceof Error ? e.message : '重置请求未确认，请重新检查状态');
              });
          }}
        >
          {busy ? '正在退出并重置…' : '删除全部工作台数据并重启'}
        </button>
      </footer>
    </dialog>
  );
}
