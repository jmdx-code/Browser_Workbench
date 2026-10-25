import { useEffect, useState } from 'react';
import type { CacheOverview } from '../shared/material-cache-management.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';

export function MaterialCachePanel() {
  const [status, setStatus] = useState<CacheOverview | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api.materialCache(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(
      (value) => {
        if (!controller.signal.aborted) {
          setStatus(value);
          setError('');
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setStatus(null);
          setError('上传缓存读取失败，请重新读取。');
        }
      },
    );
    return () => controller.abort();
  }, [revision]);
  const eligible = status?.entries.filter((entry) => entry.eligible) ?? [];
  const bytes = status?.entries.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;
  return (
    <section aria-label="上传缓存">
      <h3>上传缓存</h3>
      {status && (
        <p>
          缓存预留 {(bytes / 1024 / 1024).toFixed(1)} MB · 可清理 {eligible.length} 项 · 受保护{' '}
          {status.entries.length - eligible.length} 项{status.truncated ? ' · 显示前200项' : ''}
        </p>
      )}
      {!!status?.entries.some((entry) => !entry.eligible) && (
        <p className="field-hint">停止、结果或文件归属未确认的缓存保留。</p>
      )}
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
        重新读取缓存
      </button>{' '}
      <button
        disabled={busy || !eligible.length}
        onClick={() => setConfirm(eligible.slice(0, 50).map((entry) => entry.stageId))}
      >
        清理已结束缓存
      </button>
      {confirm && (
        <ConfirmDialog
          title="清理上传缓存"
          description={`将检查并清理${confirm.length}项已结束的上传缓存。原素材和任务历史保留；执行中、未确认结果以及不匹配的缓存不会删除。`}
          label="清理缓存"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            setBusy(true);
            setNotice('');
            setError('');
            try {
              const result = await api.cleanMaterialCache(confirm);
              const cleaned = result.results.filter((entry) => entry.cleaned).length;
              setNotice(`已清理 ${cleaned} 项，${result.results.length - cleaned} 项未清理。`);
              setRevision((value) => value + 1);
            } catch {
              setError('清理结果未确认，请重新读取缓存状态；不会自动重试。');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </section>
  );
}
