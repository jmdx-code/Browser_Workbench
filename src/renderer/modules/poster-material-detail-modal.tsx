import { useEffect, useState } from 'react';
import type { Profile } from '../../shared/contracts.js';
import type {
  PosterActiveGroupItem,
  PosterLog,
  PosterState,
  PosterTask,
} from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { collectAllPaginatedLogs, formatPosterLogsAsTsv } from '../../shared/log-table-copy.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import {
  formatCreatedDate,
  PosterMaterialCardPreview,
  taskStatusBadge,
} from './poster-material-cards.js';
import { posterRowBadge } from './poster-material-thumbnail-cell.js';

export function PosterMaterialDetailModal({
  material,
  state,
  profiles,
  busy,
  onClose,
  onCancelTask,
  onDeleteTask,
  onMessage,
}: {
  material: MaterialDraft;
  state: PosterState | null;
  profiles: readonly Profile[];
  busy: boolean;
  onClose: () => void;
  onCancelTask: (taskId: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onMessage: (text: string) => void;
}) {
  const [logs, setLogs] = useState<PosterLog[]>([]);
  const [search, setSearch] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [copyingLogs, setCopyingLogs] = useState(false);

  const activeGroups: PosterActiveGroupItem[] = state?.activeGroupsByMaterial?.[material.id] ?? [];
  const materialTasks: PosterTask[] = (state?.tasks ?? []).filter(
    (t) => t.materialId === material.id,
  );
  const postedGroupIds = state?.postedGroupIdsByMaterial?.[material.id] ?? [];

  const loadMaterialLogs = async (q = search, before?: number, beforeId?: string) => {
    if (!before) setLoadingLogs(true);
    try {
      const rows = await api.posterLogs(q, before, beforeId, material.id);
      setLogs((prev) => (before ? [...prev, ...rows] : rows));
      if (!before) setSelectedLogIds(new Set());
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (!before) setLoadingLogs(false);
    }
  };

  const copyMaterialLogs = async () => {
    if (copyingLogs) return;
    setCopyingLogs(true);
    try {
      const targetRows =
        selectedLogIds.size > 0
          ? logs.filter((r) => selectedLogIds.has(r.id))
          : await collectAllPaginatedLogs({
              initialRows:
                logs.length > 0
                  ? logs
                  : await api.posterLogs(search, undefined, undefined, material.id),
              getTimestamp: (r) => r.postedAt,
              fetchPage: (before, beforeId) =>
                api.posterLogs(search, before, beforeId, material.id),
            });
      if (!targetRows.length) {
        onMessage('当前没有可复制的发帖记录');
        return;
      }
      await copyTextToClipboard(formatPosterLogsAsTsv(targetRows, profiles));
      onMessage(
        selectedLogIds.size > 0
          ? `已批量复制已选 ${targetRows.length} 条发帖记录，可直接粘贴到表格`
          : `已批量复制该贴文全部 ${targetRows.length} 条发帖记录，可直接粘贴到表格`,
      );
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setCopyingLogs(false);
    }
  };

  useEffect(() => {
    void loadMaterialLogs('');
  }, [material.id, state?.total]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="贴文发帖详情与记录">
      <div className="modal bumper-modal poster-detail-modal">
        <div className="bumper-modal-heading">
          <h2>贴文发帖详情（正在发小组 · 已发小组 · 发帖链接 · 定时任务）</h2>
          <button className="btn" aria-label="关闭弹窗" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="poster-dispatch-post-summary">
          <div className="poster-dispatch-post-thumb">
            <PosterMaterialCardPreview row={material} onPreview={() => {}} />
          </div>
          <div className="poster-dispatch-post-info">
            <div className="poster-dispatch-post-badges">
              <span className={'poster-cache-badge ' + posterRowBadge(material).cls}>
                {posterRowBadge(material).text}
              </span>
              <span className="poster-dispatch-meta-item">
                已发小组数：<strong>{postedGroupIds.length}</strong> 个
              </span>
              <span className="poster-dispatch-meta-item">
                正在发/排队：<strong>{activeGroups.length}</strong> 个
              </span>
              <span className="poster-dispatch-meta-item">
                创建日期：{formatCreatedDate(material.createdAt)}
              </span>
            </div>
            <div className="poster-dispatch-post-caption">
              {material.caption.trim() || '（无文字文案，仅发送图片/视频媒体）'}
            </div>
          </div>
        </div>

        <div className="poster-detail-scroll">
          <div className="poster-detail-block">
            <div className="poster-detail-block-header">
              <strong>正在发 / 排队中的小组 ({activeGroups.length})</strong>
            </div>
            {activeGroups.length === 0 ? (
              <div className="poster-detail-empty">当前没有正在发送或排队中的小组</div>
            ) : (
              <div className="poster-active-groups-grid">
                {activeGroups.map((item) => {
                  const p = profiles.find((prof) => prof.id === item.profileId);
                  const accountLabel = p
                    ? p.browserName || p.alias || p.account.name || p.id
                    : (item.profileId ?? '等待空闲账号领取');
                  return (
                    <div
                      key={item.groupId}
                      className={
                        'poster-active-group-chip ' +
                        (item.state === 'posting' ? 'is-posting' : 'is-queued')
                      }
                    >
                      <div className="poster-active-group-top">
                        <span className="poster-group-state-tag">
                          {item.state === 'posting' ? '▶ 正在发帖' : '⏳ 排队待发'}
                        </span>
                        <strong>{item.groupName}</strong>
                        <small>({item.groupId})</small>
                      </div>
                      <div className="poster-active-group-sub">
                        <span>执行账号：{accountLabel}</span>
                        {item.statusText && <span> · {item.statusText}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="poster-detail-block">
            <div className="poster-detail-block-header">
              <strong>该贴文的任务与定时记录 ({materialTasks.length})</strong>
            </div>
            {materialTasks.length === 0 ? (
              <div className="poster-detail-empty">暂无该贴文的任务记录</div>
            ) : (
              <table className="bumper-table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>执行时间</th>
                    <th>账号模式</th>
                    <th>完成进度</th>
                    <th>状态说明</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {materialTasks.map((t) => {
                    const badge = taskStatusBadge(t.status);
                    return (
                      <tr key={t.id}>
                        <td>
                          <span className={'poster-task-badge ' + badge.cls}>{badge.label}</span>
                        </td>
                        <td>
                          {t.scheduledAt
                            ? `定时：${new Date(t.scheduledAt).toLocaleString()}`
                            : `立即：${new Date(t.createdAt).toLocaleString()}`}
                        </td>
                        <td>
                          {t.accountMode === 'all_online'
                            ? '🌐 全部在线账号'
                            : `👤 指定 ${t.profileIds.length} 个账号`}
                        </td>
                        <td>
                          已发 <strong>{t.postedCount}</strong> / {t.totalGroups} 组
                          {t.skippedCount > 0 ? `（跳过 ${t.skippedCount} 组）` : ''}
                        </td>
                        <td>{t.statusReason}</td>
                        <td>
                          {t.status === 'scheduled' || t.status === 'running' ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              disabled={busy}
                              onClick={() => void onCancelTask(t.id)}
                            >
                              {t.status === 'scheduled' ? '取消定时' : '停止任务'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => void onDeleteTask(t.id)}
                            >
                              删除记录
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="poster-detail-block">
            <div className="poster-detail-block-header">
              <strong>已发小组明细 · 发帖账号 · 发帖链接 ({logs.length} 条记录)</strong>
              <div className="poster-detail-search">
                <input
                  type="search"
                  placeholder="搜索已发小组、发帖账号或链接…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void loadMaterialLogs(search);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void loadMaterialLogs(search)}
                >
                  搜索
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={copyingLogs || loadingLogs || logs.length === 0}
                  onClick={() => void copyMaterialLogs()}
                >
                  {copyingLogs
                    ? '正在复制…'
                    : selectedLogIds.size > 0
                      ? `批量复制已选 (${selectedLogIds.size})`
                      : `批量复制全部 (${logs.length})`}
                </button>
              </div>
            </div>

            {loadingLogs ? (
              <div className="poster-detail-empty">正在读取已发记录…</div>
            ) : logs.length === 0 ? (
              <div className="poster-detail-empty">该贴文暂无已发小组记录</div>
            ) : (
              <div className="bumper-table-scroll">
                <table className="bumper-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label="全选该贴文已发记录"
                          checked={logs.length > 0 && logs.every((l) => selectedLogIds.has(l.id))}
                          onChange={(e) =>
                            setSelectedLogIds(
                              e.target.checked ? new Set(logs.map((l) => l.id)) : new Set(),
                            )
                          }
                        />
                      </th>
                      <th>发帖时间</th>
                      <th>目标小组</th>
                      <th>发帖账号 / 专页</th>
                      <th>发帖链接</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((row) => {
                      const p = profiles.find((item) => item.id === row.profileId);
                      const profileTitle = p
                        ? p.browserName || p.alias || p.account.name || row.profileId
                        : row.profileId;
                      const effectiveAccountAvatar =
                        (p?.account.id === row.accountId && p?.account.avatar
                          ? p.account.avatar
                          : null) ?? row.accountAvatar;
                      return (
                        <tr key={row.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedLogIds.has(row.id)}
                              onChange={() =>
                                setSelectedLogIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(row.id)) next.delete(row.id);
                                  else next.add(row.id);
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td>{new Date(row.postedAt).toLocaleString()}</td>
                          <td>
                            <div className="poster-log-entity">
                              {row.groupAvatar && (
                                <img
                                  src={row.groupAvatar}
                                  alt=""
                                  className="poster-log-avatar"
                                  referrerPolicy="no-referrer"
                                />
                              )}
                              <div>
                                <strong>{row.groupName}</strong>
                                <small>{row.groupId}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="poster-log-entity">
                              {effectiveAccountAvatar && (
                                <img
                                  src={effectiveAccountAvatar}
                                  alt=""
                                  className="poster-log-avatar"
                                  referrerPolicy="no-referrer"
                                />
                              )}
                              <div>
                                <strong>{row.accountName || profileTitle}</strong>
                                <span className={'poster-identity-badge is-' + row.identityType}>
                                  {row.identityType === 'page' ? '专页' : '个人'}
                                </span>
                                <small>{row.accountId}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            {row.postId === 'pending_approval' && (
                              <span className="poster-identity-badge is-page">
                                已提交待群管审核
                              </span>
                            )}{' '}
                            <button
                              type="button"
                              className="btn btn-sm"
                              title={row.postUrl}
                              onClick={() =>
                                void copyTextToClipboard(row.postUrl)
                                  .then(() => onMessage('已复制发帖链接'))
                                  .catch((e) => onMessage(String(e)))
                              }
                            >
                              复制链接
                            </button>{' '}
                            <a
                              href={row.postUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-sm"
                            >
                              打开链接
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {logs.length >= 200 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void loadMaterialLogs(search, logs.at(-1)?.postedAt, logs.at(-1)?.id)
                    }
                  >
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
