import { useRef, useState } from 'react';
import type { PosterMaterialAiLabel, PosterMaterialBackground } from '../../shared/group-poster.js';
import { mediaReference } from '../../domain/resource-table.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';

export function PosterMaterialEditModal({
  initial,
  isNew,
  busy,
  onClose,
  onSaveItem,
}: {
  initial: MaterialDraft;
  isNew: boolean;
  busy: boolean;
  onClose: () => void;
  onSaveItem: (updated: MaterialDraft) => Promise<boolean>;
}) {
  const [caption, setCaption] = useState(initial.caption);
  const [mediaSource, setMediaSource] = useState(initial.mediaSource);
  const [background, setBackground] = useState<PosterMaterialBackground>(initial.background);
  const [aiLabel, setAiLabel] = useState<PosterMaterialAiLabel>(initial.aiLabel ?? 'default');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePickLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] as (File & { path?: string }) | undefined;
    e.target.value = '';
    if (!file) return;
    const localPath = (file.path ?? '').trim();
    if (!localPath) {
      setError('当前环境未能读取本地文件路径，请直接在下方粘贴文件完整路径');
      return;
    }
    setMediaSource(localPath);
    setBackground('plain');
    setError('');
  };

  const handleSubmit = async () => {
    setError('');
    const trimmedCaption = caption.trim();
    const trimmedMedia = mediaSource.trim();
    if (!trimmedCaption && !trimmedMedia) {
      setError('请至少填写发帖文案或选择图片/视频媒体');
      return;
    }
    let normalizedSource = trimmedMedia;
    if (trimmedMedia) {
      try {
        normalizedSource = mediaReference(trimmedMedia).source;
      } catch (err) {
        setError(err instanceof Error ? err.message : '媒体路径或链接格式无效');
        return;
      }
    }
    const ok = await onSaveItem({
      ...initial,
      caption: trimmedCaption,
      mediaSource: normalizedSource,
      background: normalizedSource ? 'plain' : background,
      aiLabel,
      createdAt: initial.createdAt || Date.now(),
    });
    if (ok) onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? '新建贴文素材' : '编辑贴文素材'}
    >
      <div className="modal bumper-modal poster-edit-material-modal">
        <div className="bumper-modal-heading">
          <h2>{isNew ? '新建贴文素材' : '编辑贴文素材'}</h2>
          <button className="btn" aria-label="关闭弹窗" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="poster-edit-form">
          <label className="poster-edit-field">
            <span>发帖文案</span>
            <textarea
              rows={5}
              placeholder="输入发帖文案（支持多行文本与表情）…"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>

          <div className="poster-edit-field">
            <span>画面媒体（本机图片/视频路径 或 Google Drive 分享链接，留空则为纯文字贴）</span>
            <div className="poster-edit-media-row">
              <input
                type="text"
                placeholder="例如 D:\videos\post1.mp4 或 https://drive.google.com/file/d/..."
                value={mediaSource}
                onChange={(e) => {
                  setMediaSource(e.target.value);
                  if (e.target.value.trim()) setBackground('plain');
                }}
              />
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                浏览本机图片/视频…
              </button>
              {mediaSource && (
                <button type="button" className="btn" onClick={() => setMediaSource('')}>
                  清除媒体
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,image/*,video/*"
                style={{ display: 'none' }}
                onChange={handlePickLocalFile}
              />
            </div>
          </div>

          {!mediaSource.trim() && (
            <label className="poster-edit-field">
              <span>文字背景样式（无媒体时生效）</span>
              <select
                value={background}
                onChange={(e) => setBackground(e.target.value === 'color' ? 'color' : 'plain')}
              >
                <option value="plain">普通文字</option>
                <option value="color">Facebook 彩色背景（≤120字且≤4行）</option>
              </select>
            </label>
          )}

          <label className="poster-edit-field">
            <span>AI 内容声明标签</span>
            <select
              aria-label="AI 内容声明标签"
              value={aiLabel}
              onChange={(e) =>
                setAiLabel(
                  e.target.value === 'on' ? 'on' : e.target.value === 'off' ? 'off' : 'default',
                )
              }
            >
              <option value="default">默认（保持页面原状态）</option>
              <option value="on">开启 AI 声明标签</option>
              <option value="off">关闭 AI 声明标签</option>
            </select>
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="bumper-modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? '正在保存…' : '保存贴文'}
          </button>
        </div>
      </div>
    </div>
  );
}
