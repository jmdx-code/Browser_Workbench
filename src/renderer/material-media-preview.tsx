import { useEffect, useState } from 'react';
import { materialMediaPreviewLimits, type PackagePreview } from '../shared/materials.js';
import { api, ApiError } from './api.js';

export function MaterialMediaPreview({ preview }: { preview: PackagePreview }) {
  const media = preview.files
    .map((file, fileIndex) => ({ ...file, fileIndex }))
    .filter((file) => file.role !== 'text');
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ index: number; url: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const file = media[index];
  useEffect(() => {
    setLoaded(null);
    setError('');
    const controller = new AbortController();
    let disposed = false,
      url: string | null = null;
    if (!file || file.role === 'text') return;
    if (file.bytes > materialMediaPreviewLimits[file.role]) {
      setBusy(false);
      setError('这份媒体超过预览上限（图片20 MiB、视频128 MiB）。原文件保留，未作压缩或截断。');
      return;
    }
    setBusy(true);
    void api
      .materialMedia(preview, file.fileIndex, controller.signal)
      .then((blob) => {
        if (disposed) return;
        url = URL.createObjectURL(blob);
        setLoaded({ index, url });
      })
      .catch((failure: unknown) => {
        if (disposed) return;
        setError(
          failure instanceof ApiError && failure.code === 'MATERIAL_PREVIEW_EXPIRED'
            ? '本次媒体预览已失效，请重新检查素材。'
            : failure instanceof ApiError && failure.code === 'MATERIAL_PREVIEW_MEDIA_BUSY'
              ? '另一份媒体仍在读取，请稍后重试。'
              : '媒体读取或校验未完成，请重新检查素材；原文件未改动。',
        );
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview, file?.fileIndex, index, attempt]);
  if (!file) return null;
  const decodeError = () =>
    setError('浏览器无法显示这份媒体，可能是格式或编码不支持；这不表示上传或发布成功。');
  return (
    <section className="material-media-preview" aria-label="图片视频预览">
      <div className="material-media-toolbar">
        <strong>
          {file.role === 'video' ? '视频预览' : '图片预览'} · {index + 1}/{media.length}
        </strong>
        {media.length > 1 && (
          <div>
            <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
              上一张
            </button>
            <button
              type="button"
              disabled={index === media.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              下一张
            </button>
          </div>
        )}
      </div>
      <small className="material-media-filename">{file.relativePath}</small>
      {busy && <p role="status">正在读取并核对媒体…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            重试预览
          </button>
        </div>
      )}
      {!error &&
        loaded?.index === index &&
        (file.role === 'video' ? (
          <video
            key={loaded.url}
            aria-label="素材视频播放器"
            src={loaded.url}
            controls
            preload="metadata"
            playsInline
            onError={decodeError}
          />
        ) : (
          <img
            key={loaded.url}
            src={loaded.url}
            alt={'素材图片 ' + (index + 1) + '：' + file.relativePath}
            onError={decodeError}
          />
        ))}
      <small className="field-hint">
        只读取当前一份媒体，视频需手动播放。正文是扫描快照；媒体经过本次文件校验，也可能随后变化。预览不代表可发布。
      </small>
    </section>
  );
}
