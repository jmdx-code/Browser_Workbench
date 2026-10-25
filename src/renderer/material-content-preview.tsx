import { useEffect, useRef, useState } from 'react';
import type { PackagePreview, PreviewScan } from '../shared/materials.js';
import { api, ApiError } from './api.js';
import { MaterialMediaPreview } from './material-media-preview.js';

const formatNames = {
  text: '文字',
  'single-image': '单图',
  'multi-image': '多图',
  video: '视频',
} as const;
function bytes(value: number) {
  return value < 1024
    ? value + ' B'
    : value < 1024 ** 2
      ? (value / 1024).toFixed(1) + ' KB'
      : (value / 1024 ** 2).toFixed(1) + ' MB';
}
export function MaterialContentPreview({
  scan,
  requestedPreview,
}: {
  scan: PreviewScan;
  requestedPreview: { source: string; revision: number };
}) {
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        generation.current++;
        setExpired(true);
        setPreview(null);
        setBusy(false);
      },
      Math.max(0, Date.parse(scan.report.scannedAt) + 600_000 - Date.now()),
    );
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [scan.scanId, scan.report.scannedAt]);
  async function choose(next: string) {
    const current = ++generation.current;
    setSource(next);
    setPreview(null);
    setError('');
    setBusy(!!next);
    if (!next) return;
    try {
      const result = await api.materialPreview(scan.scanId, next);
      const expected = scan.report.packages.find((item) => item.source === next);
      if (
        !expected ||
        result.scanId !== scan.scanId ||
        result.source !== next ||
        result.directory !== scan.report.directory ||
        result.scannedAt !== scan.report.scannedAt ||
        result.fingerprint !== expected.fingerprint ||
        result.format !== expected.format ||
        result.files.reduce((sum, file) => sum + file.bytes, 0) !== expected.bytes ||
        result.files.filter((file) => file.role !== 'text').length !== expected.mediaCount
      )
        throw Error('MATERIAL_PREVIEW_MISMATCH');
      if (generation.current === current) setPreview(result);
    } catch (failure) {
      if (generation.current === current)
        setError(
          failure instanceof ApiError && failure.code === 'MATERIAL_PREVIEW_EXPIRED'
            ? '本次预览已失效，请重新检查素材。'
            : '未取得匹配的内容预览，请重新检查素材。',
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  useEffect(() => {
    if (
      requestedPreview.source &&
      scan.report.packages.some((item) => item.source === requestedPreview.source)
    )
      void choose(requestedPreview.source);
  }, [requestedPreview.revision]);
  return (
    <section className="material-content-preview" aria-label="素材内容预览">
      <label>
        预览一条素材
        <select
          aria-label="选择预览素材"
          value={source}
          disabled={expired || !scan.report.packages.length}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="">选择素材查看正文和文件清单</option>
          {scan.report.packages.map((item) => (
            <option key={item.source} value={item.source}>
              {item.source} · {formatNames[item.format]}
              {item.duplicateOf ? ' · 内容重复' : ''}
            </option>
          ))}
        </select>
      </label>
      <small className="field-hint">
        扫描时间：{new Date(scan.report.scannedAt).toLocaleString()}
        。仅保留最近一次扫描，10分钟后失效；文件可能已变化，发布前需重新核对。
      </small>
      {expired && <p role="status">本次预览已过期，请重新检查素材。</p>}
      {busy && <p role="status">正在读取本次扫描快照…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div className="material-content-body" aria-live="polite">
          <div className="material-preview-heading">
            <strong>{formatNames[preview.format]}</strong>
            <span>
              {preview.files.filter((file) => file.role !== 'text').length} 个媒体 · 仅预览
            </span>
          </div>
          <h4>正文</h4>
          <pre>{preview.text || '（无配文）'}</pre>
          <MaterialMediaPreview key={preview.scanId + ':' + preview.source} preview={preview} />
          <h4>文件清单</h4>
          <ol>
            {preview.files.map((file, index) => (
              <li key={file.relativePath}>
                <span>{index + 1}.</span>
                <span className="material-file-role">
                  {file.role === 'text' ? '正文' : file.role === 'image' ? '图片' : '视频'}
                </span>
                <span className="material-file-name">{file.relativePath}</span>
                <span>{bytes(file.bytes)}</span>
              </li>
            ))}
          </ol>
          <small className="field-hint">
            媒体按清单顺序排列。预览不会上传、发布、预占或移动素材。
          </small>
          <p className="hint">素材将在任务执行时读取；请通过任务组合启动发布。</p>
        </div>
      )}
    </section>
  );
}
