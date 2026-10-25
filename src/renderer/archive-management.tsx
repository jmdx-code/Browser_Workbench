import { useEffect, useState } from 'react';
import { api, ApiError } from './api.js';
import type { ManagedArchiveList } from '../shared/archive-management.js';
import { FileLocationButton } from './file-location-button.js';

const states = {
  PENDING: '等待归档',
  MOVING: '正在归档',
  REVIEW: '归档待处理',
  COMPLETED: '已归档',
};
export function ArchiveManagementPanel({
  profileId,
  planId,
}: {
  profileId: string;
  planId: string;
}) {
  const [records, setRecords] = useState<ManagedArchiveList | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const value = await api.archives(profileId, planId, controller.signal);
        if (value.profileId !== profileId || value.planId !== planId)
          throw Error('ARCHIVE_SCOPE_CHANGED');
        if (!controller.signal.aborted) {
          setRecords(value);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof ApiError ? error.message : '归档记录读取失败，可重新读取。');
      } finally {
        pending = false;
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [profileId, planId, revision]);
  if (records && !records.archives.length) return null;
  return (
    <section className="archive-management" aria-label="历史归档记录">
      <div className="task-history-heading">
        <h4>历史归档记录（只读）</h4>
        <button onClick={() => setRevision((value) => value + 1)}>重新读取归档</button>
      </div>
      {error && (
        <p className="task-history-warning" role="alert">
          {error}
        </p>
      )}
      {records?.archives.map((row) => (
        <div className="archive-record" key={row.attemptId}>
          <div className="archive-record-heading">
            <span>
              {states[row.state]}
              {row.preparationState === 'REVIEW' && row.state === 'PENDING' ? ' · 检查失败' : ''}
            </span>
            <small>{row.attemptId.slice(0, 8)}</small>
          </div>
          {row.reason && <p className="task-history-reason">{row.reason}</p>}
          {row.files.length > 0 && (
            <details>
              <summary>查看{row.files.length}个文件的归档位置</summary>
              {row.files.map((file) => (
                <div className="archive-file" key={file.source}>
                  <span title={file.source}>来源：{file.source}</span>
                  <span title={file.target}>归档：{file.target}</span>
                  <div>
                    <FileLocationButton source={file.source} label="查看原文件位置" />{' '}
                    <FileLocationButton source={file.target} label="查看归档位置" />
                  </div>
                </div>
              ))}
            </details>
          )}
        </div>
      ))}
      {records?.truncated && <p className="muted">显示最近100条归档记录。</p>}
    </section>
  );
}
