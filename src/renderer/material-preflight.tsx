import { useEffect, useRef, useState } from 'react';
import type { PreviewScan } from '../shared/materials.js';
import { api } from './api.js';
import { MaterialContentPreview } from './material-content-preview.js';
import type { Profile } from '../shared/contracts.js';
import { MaterialArrangementEditor } from './material-arrangement.js';

export function MaterialPreflight({
  directory,
  selectedProfiles,
  count,
  allowRepeat,
}: {
  directory: string;
  selectedProfiles: Profile[];
  count: number;
  allowRepeat: boolean;
}) {
  const [scan, setReport] = useState<PreviewScan | null>(null);
  const report = scan?.report ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const [requestedPreview, setRequestedPreview] = useState<{ source: string; revision: number }>({
    source: '',
    revision: 0,
  });
  useEffect(() => {
    generation.current++;
    setReport(null);
    setError('');
    setBusy(false);
    setRequestedPreview({ source: '', revision: 0 });
    return () => {
      generation.current++;
    };
  }, [directory]);
  async function inspect() {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setReport(null);
    setRequestedPreview({ source: '', revision: 0 });
    try {
      const next = await api.materialPreflight(directory);
      if (generation.current === current) setReport(next);
    } catch (failure) {
      if (generation.current === current) setError('目录检查未完成，请核对目录和文件后重试。');
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <div className="material-preflight">
      <button type="button" disabled={busy || !directory.trim()} onClick={() => void inspect()}>
        {busy ? '正在检查…' : '检查素材'}
      </button>
      <span className="field-hint">只读检查，不发布或移动文件</span>
      {error && <p role="alert">{error}</p>}
      {report && (
        <div className="material-report" aria-live="polite">
          <p>
            {report.complete ? '扫描完成' : '扫描未完成，请处理问题后重试'} ·{' '}
            {report.packages.length} 份结构通过 ·{' '}
            {report.packages.filter((item) => item.duplicateOf !== null).length}{' '}
            份内容相同（仅提示） · {report.issues.length} 项问题
          </p>
          <p className="field-hint">
            文字 {report.packages.filter((item) => item.format === 'text').length} · 单图{' '}
            {report.packages.filter((item) => item.format === 'single-image').length} · 多图{' '}
            {report.packages.filter((item) => item.format === 'multi-image').length} · 视频{' '}
            {report.packages.filter((item) => item.format === 'video').length} · 排除{' '}
            {report.excluded} 项
          </p>
          <p className="field-hint">
            每个子文件夹为一条帖子，配文使用“正文.txt”；独立媒体使用同名 .txt。正文需为
            UTF-8。此次预检尚未核对发布历史、素材预占或平台上传条件。
          </p>
          {report.issues.length > 0 && (
            <ul>
              {report.issues.slice(0, 10).map((issue, index) => (
                <li key={index}>
                  {issue.source}：{issue.message}
                </li>
              ))}
            </ul>
          )}
          {report.issues.length > 10 && (
            <p className="field-hint">
              另有 {report.issues.length - 10} 项问题；处理前述问题后重新检查。
            </p>
          )}
          {report.packages.some((item) => item.duplicateOf) && (
            <details>
              <summary>查看内容重复</summary>
              <ul>
                {report.packages
                  .filter((item) => item.duplicateOf)
                  .slice(0, 10)
                  .map((item) => (
                    <li key={item.source}>
                      {item.source} 与 {item.duplicateOf} 内容相同
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {scan && (
            <MaterialArrangementEditor
              key={'arrangement:' + scan.scanId}
              scan={scan}
              selectedProfiles={selectedProfiles}
              count={count}
              allowRepeat={allowRepeat}
              onPreview={(source) =>
                setRequestedPreview((previous) => ({ source, revision: previous.revision + 1 }))
              }
            />
          )}
          {scan && (
            <MaterialContentPreview
              key={'content:' + scan.scanId}
              scan={scan}
              requestedPreview={requestedPreview}
            />
          )}
        </div>
      )}
    </div>
  );
}
