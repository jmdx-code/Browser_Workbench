import { useEffect, useState } from 'react';
import type { MaterialUsage, MaterialUsageClearRequest } from '../shared/material-usage.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';

export function MaterialUsagePanel() {
  const [usage, setUsage] = useState<MaterialUsage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [clear, setClear] = useState<MaterialUsageClearRequest | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api.materialUsage(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(
      (value) => {
        if (!controller.signal.aborted) {
          setUsage(value);
          setError('');
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setUsage(null);
          setError('使用记录读取失败，请重新读取或更新软件');
        }
      },
    );
    return () => controller.abort();
  }, [revision]);
  return (
    <section aria-label="素材使用记录">
      <h3>素材使用记录</h3>
      <p>
        原素材位置保持不变。确认发布后标记资源已使用，默认跳过；任务勾选“允许重复”或清空使用记录后，可再次取用。
      </p>
      {usage && (
        <p>
          本次记录：{usage.contents} 条已使用资源 · {usage.published} 次已确认发布
          {usage.lastClearedAt
            ? ' · 最近清空：' + new Date(usage.lastClearedAt).toLocaleString()
            : ''}
        </p>
      )}
      {usage?.activePublishing && (
        <p className="field-hint">有发帖任务尚未结束，先停止后再清空。</p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button onClick={() => setRevision((value) => value + 1)}>重新读取使用记录</button>{' '}
      <button
        disabled={!usage || usage.activePublishing || !usage.published}
        onClick={() => {
          if (usage)
            setClear({
              requestId: crypto.randomUUID(),
              expectedGeneration: usage.generation,
              expectedPublished: usage.published,
            });
        }}
      >
        清空素材使用记录
      </button>
      {clear && (
        <ConfirmDialog
          title="清空素材使用记录"
          description="将清空所有组合的已使用标记，让重复素材可被新的任务再次取用。原文件和任务历史保留；待核对的未确认发布内容不会解除保护。"
          label="清空使用记录"
          onClose={() => setClear(null)}
          onConfirm={async () => {
            await api.clearMaterialUsage(clear);
            setNotice('已清空使用记录，重复素材可用于新任务；原任务历史保留。');
            setRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
