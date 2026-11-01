import { useEffect, useState } from 'react';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { IconClose } from './icons.js';

const FEEDBACK_DIR_STORAGE_KEY = 'workbench.feedbackTargetDir';

export function DiagnosticFeedbackModal({
  open,
  uiContext,
  onClose,
  onNotify,
}: {
  open: boolean;
  uiContext: string;
  onClose: () => void;
  onNotify: (msg: string) => void;
}) {
  const [diagNote, setDiagNote] = useState('');
  const [targetDir, setTargetDir] = useState(() => {
    try {
      return localStorage.getItem(FEEDBACK_DIR_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [diagGenerating, setDiagGenerating] = useState(false);
  const [diagError, setDiagError] = useState('');
  const [diagResult, setDiagResult] = useState<{
    filePath: string;
    fileName: string;
    sizeBytes: number;
    entryId: number;
    at: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setDiagError('');
    }
  }, [open]);

  function updateTargetDir(dir: string) {
    setTargetDir(dir);
    try {
      if (dir) localStorage.setItem(FEEDBACK_DIR_STORAGE_KEY, dir);
      else localStorage.removeItem(FEEDBACK_DIR_STORAGE_KEY);
    } catch {}
  }

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="记录并导出问题反馈包"
      onClick={() => {
        if (!diagGenerating) onClose();
      }}
    >
      <div className="modal select-by-ids-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>记录并导出问题反馈包</h3>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label="关闭"
            disabled={diagGenerating}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <p className="muted modal-desc">
          一键打包当前所有浏览器状态、任务账本、顶贴/邀请日志与内核黑匣子记录（自动保存在本地并弹出文件夹，可直接拖入微信/TG发送排查）。
        </p>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
          问题简述（选填）
        </label>
        <textarea
          autoFocus
          className="select-by-ids-textarea"
          aria-label="问题简述（选填）"
          rows={4}
          placeholder="例如：哪个浏览器、在执行什么步骤时卡住或报错（不填也可直接生成）"
          value={diagNote}
          disabled={diagGenerating}
          onChange={(e) => setDiagNote(e.target.value)}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 'var(--r-sm, 6px)',
            background: 'var(--surface-2, #f5f6f8)',
            border: '1px solid var(--line, #dce0e6)',
            fontSize: 12,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, color: 'var(--text, #1d2127)', marginBottom: 2 }}>
              保存目录
            </div>
            <div
              className="muted"
              style={{
                wordBreak: 'break-all',
                lineHeight: 1.4,
              }}
            >
              {targetDir || '默认目录（点击右侧可自定义保存位置）'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {targetDir && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={diagGenerating}
                onClick={() => updateTargetDir('')}
              >
                恢复默认
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={diagGenerating}
              onClick={() => {
                if (typeof window.workbenchDesktop?.chooseFeedbackDirectory === 'function') {
                  void window.workbenchDesktop
                    .chooseFeedbackDirectory()
                    .then((chosen) => {
                      if (chosen) updateTargetDir(chosen);
                    })
                    .catch((err) =>
                      onNotify(err instanceof Error ? err.message : '选择保存目录失败'),
                    );
                } else {
                  onNotify('当前环境不支持选择本地文件夹，将使用默认目录保存');
                }
              }}
            >
              选择目录…
            </button>
          </div>
        </div>
        {diagError && (
          <p className="error-note" role="alert" style={{ marginTop: 8 }}>
            {diagError}
          </p>
        )}
        {diagResult && (
          <div
            className="select-by-ids-preview"
            role="status"
            style={{
              marginTop: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              alignItems: 'flex-start',
            }}
          >
            <strong>
              已生成反馈包：{diagResult.fileName}（
              {diagResult.sizeBytes >= 1024 * 1024
                ? `${(diagResult.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
                : `${Math.max(1, Math.round(diagResult.sizeBytes / 1024))} KB`}
              ）
            </strong>
            <small
              className="muted"
              style={{ wordBreak: 'break-all', userSelect: 'all', lineHeight: 1.4 }}
            >
              路径：{diagResult.filePath}
            </small>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void api
                    .revealDiagnosticPackage(diagResult.filePath, targetDir || undefined)
                    .then(() => onNotify('已在资源管理器中定位反馈包文件'))
                    .catch((err) =>
                      onNotify(err instanceof Error ? err.message : '打开所在文件夹失败'),
                    );
                }}
              >
                打开所在文件夹
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void copyTextToClipboard(diagResult.filePath)
                    .then(() => onNotify(`已复制反馈包路径：${diagResult.filePath}`))
                    .catch((err) => onNotify(err instanceof Error ? err.message : '复制路径失败'));
                }}
              >
                复制文件路径
              </button>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={diagGenerating} onClick={onClose}>
            {diagResult ? '关闭' : '取消'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={diagGenerating}
            onClick={() => {
              setDiagGenerating(true);
              setDiagError('');
              void api
                .recordDiagnosticSnapshot({
                  note: diagNote.trim() || undefined,
                  uiContext,
                  targetDir: targetDir.trim() || undefined,
                })
                .then((res) => {
                  setDiagResult(res);
                  onNotify(`已生成问题反馈包：${res.fileName}`);
                })
                .catch((err) => {
                  const errMsg = err instanceof Error ? err.message : '生成问题反馈包失败';
                  setDiagError(errMsg);
                  onNotify(errMsg);
                })
                .finally(() => {
                  setDiagGenerating(false);
                });
            }}
          >
            {diagGenerating ? '正在打包反馈包…' : '生成反馈包并打开文件夹'}
          </button>
        </div>
      </div>
    </div>
  );
}
