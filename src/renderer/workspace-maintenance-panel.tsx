import { DataCleanupPanel } from './data-cleanup-panel.js';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { MaintenanceOverview } from '../shared/runtime-log.js';
import { api } from './api.js';

export function WorkspaceMaintenancePanel() {
  const [saved, setSaved] = useState<z.infer<typeof MaintenanceOverview> | null>(null);
  const [days, setDays] = useState('14');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const owner = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    void api.maintenance(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])).then(
      (value) => {
        if (controller.signal.aborted) return;
        setSaved(value);
        setDays(String(value.settings.logRetentionDays));
        setError('');
      },
      () => {
        if (!controller.signal.aborted) {
          setSaved(null);
          setError('维护设置读取失败。');
        }
      },
    );
    return () => controller.abort();
  }, [revision]);
  const valid = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 90;
  async function execute(kind: 'save' | 'export') {
    const current = owner.current;
    if (!saved || busy || !current || current.signal.aborted || (kind === 'save' && !valid)) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(10000)]);
    try {
      if (kind === 'save') {
        const value = await api.saveMaintenance(
          { expectedRevision: saved.settings.revision, logRetentionDays: Number(days) },
          signal,
        );
        if (current.signal.aborted) return;
        setSaved(value);
        setNotice('日志保留设置已保存。');
      } else {
        const value = await api.runtimeLogs(signal);
        if (current.signal.aborted) return;
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
        );
        try {
          const link = document.createElement('a');
          link.href = url;
          link.download = 'browser-workbench-log-' + value.generatedAt.slice(0, 10) + '.json';
          document.body.appendChild(link);
          link.click();
          link.remove();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        setNotice(
          `已导出${value.records.length}条日志${value.truncated ? '（仅最近记录）' : ''}。`,
        );
      }
    } catch {
      if (!current.signal.aborted)
        setError(kind === 'save' ? '保存未确认，请重新读取；不会自动重试。' : '日志导出失败。');
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  const status = saved
    ? { ready: '可用', busy: '写入中', unavailable: '不可用', 'capacity-reached': '已达当日容量' }[
        saved.logStatus
      ]
    : '未读取';
  return (
    <section aria-label="日志与位置">
      <h3>日志与位置</h3>
      <dl>
        <dt>上传缓存位置</dt>
        <dd style={{ overflowWrap: 'anywhere' }}>{saved?.locations.cacheDirectory ?? '未读取'}</dd>
        <dt>运行日志位置</dt>
        <dd style={{ overflowWrap: 'anywhere' }}>{saved?.locations.logDirectory ?? '未读取'}</dd>
        <dt>日志状态</dt>
        <dd>{status}</dd>
      </dl>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void execute('save');
        }}
      >
        <label>
          日志保留天数
          <input
            type="number"
            min="1"
            max="90"
            step="1"
            value={days}
            disabled={!saved || busy}
            onChange={(event) => setDays(event.target.value)}
            aria-invalid={!valid}
          />
        </label>
        <button
          disabled={!saved || busy || !valid || Number(days) === saved.settings.logRetentionDays}
        >
          保存日志设置
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setNotice('');
            setRevision((value) => value + 1);
          }}
        >
          重新读取
        </button>
        <button type="button" disabled={!saved || busy} onClick={() => void execute('export')}>
          导出运行日志
        </button>
      </form>
      {!valid && (
        <p className="text-danger" role="alert">
          日志保留天数请输入1至90的整数。
        </p>
      )}
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <DataCleanupPanel />
    </section>
  );
}
