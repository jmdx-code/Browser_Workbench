import { useEffect, useRef, useState } from 'react';
import type { ResourceRowValue } from '../shared/resource-table.js';
import { resourceType } from '../domain/resource-table.js';
import { api } from './api.js';
import { FileLocationButton } from './file-location-button.js';

export function ResourceRowPreview({
  combinationId,
  revision,
  row,
  rowNumber,
  onClose,
}: {
  combinationId: string;
  revision: number;
  row: ResourceRowValue;
  rowNumber: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ index: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = row.media[index];
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false,
      url: string | null = null;
    setLoaded(null);
    setError('');
    setBusy(false);
    if (!file || file.kind !== 'local') return;
    setBusy(true);
    void api
      .resourceMedia(combinationId, revision, row.id, index, controller.signal)
      .then((blob) => {
        if (disposed) return;
        url = URL.createObjectURL(blob);
        setLoaded({ index, url });
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(failure instanceof Error ? failure.message : '媒体预览未完成');
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [combinationId, revision, row, index, file, attempt]);
  return (
    <dialog
      ref={dialog}
      className="resource-preview-dialog"
      aria-label={'预览资源第' + rowNumber + '行'}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header>
        <div>
          <strong>
            第 {rowNumber} 行 · {resourceType(row)}
          </strong>
          <small>已保存资源预览</small>
        </div>
        <button onClick={onClose} aria-label="关闭资源预览">
          关闭
        </button>
      </header>
      <div className="resource-preview-body">
        <div className="resource-preview-text">{row.text || <span>无文案 · 纯媒体发布</span>}</div>
        {file && (
          <section className="material-media-preview" aria-label="资源媒体预览">
            <div className="material-media-toolbar">
              <strong>
                媒体 {index + 1} / {row.media.length}
              </strong>
              <div>
                <button disabled={index === 0} onClick={() => setIndex(index - 1)}>
                  上一份
                </button>
                <button
                  disabled={index + 1 >= row.media.length}
                  onClick={() => setIndex(index + 1)}
                >
                  下一份
                </button>
              </div>
            </div>
            <small className="material-media-filename">{file.name}</small>
            {file.kind === 'local' && (
              <FileLocationButton source={file.source} label="查看原文件位置" />
            )}
            {file.kind === 'drive' && (
              <p role="status">这是公开网盘引用，需先下载才能预览；本次未自动下载。</p>
            )}
            {busy && <p role="status">正在读取媒体…</p>}
            {error && (
              <div role="alert">
                <p>{error}</p>
                <button onClick={() => setAttempt(attempt + 1)}>重试预览</button>
              </div>
            )}
            {!error &&
              loaded?.index === index &&
              (file.mediaType === 'video' ? (
                <video
                  src={loaded.url}
                  controls
                  preload="metadata"
                  playsInline
                  aria-label="资源视频播放器"
                  onError={() => setError('浏览器无法解码这份视频，请检查视频编码；原文件保留')}
                />
              ) : (
                <img
                  src={loaded.url}
                  alt={'资源图片 ' + (index + 1)}
                  onError={() => setError('浏览器无法显示这份图片，请检查文件；原文件保留')}
                />
              ))}
          </section>
        )}
        {!row.media.length && row.background === 'color' && (
          <p className="field-hint">彩贴背景需在实际发布窗口核对；这里显示文案，未模拟平台背景。</p>
        )}
      </div>
    </dialog>
  );
}
