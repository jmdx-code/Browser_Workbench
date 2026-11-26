import { useEffect, useRef, useState, type ReactNode } from 'react';
import { profileDisplayName, type Profile } from '../../shared/contracts.js';
import {
  isPendingApprovalPostId,
  type PosterLog,
  type PosterState,
} from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { collectAllPaginatedLogs, formatPosterLogsAsTsv } from '../../shared/log-table-copy.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { toggleSet } from '../selection.js';
import {
  PosterMaterialSummaryBox,
  PosterMediaPreviewModal,
  posterRowBadge,
  taskStatusBadge,
} from './poster-material-modals.js';
import { BackdropModal, Btn, DataTbl, errMsg, ModalHeading } from './shared/module-ui.js';
import { UI_CARD, UI_CHECKBOX, UI_INPUT_SM } from '../ui/primitives.js';

function LogAvatarCell({
  avatar,
  title,
  sub,
  tag,
}: {
  avatar: string | null | undefined;
  title: string;
  sub: string;
  tag?: { text: string; cls: string };
}) {
  return (
    <div className="flex items-center gap-2">
      {avatar && (
        <img
          src={avatar}
          alt=""
          className="h-6 w-6 rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      )}
      <div className="flex flex-col">
        <div className="flex items-center gap-1">
          <strong>{title}</strong>
          {tag && (
            <span className={`rounded px-1 text-[10px] font-semibold ${tag.cls}`}>{tag.text}</span>
          )}
        </div>
        <small className="text-[var(--text-3)]">{sub}</small>
      </div>
    </div>
  );
}

const SectionCard = ({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) => (
  <div className={`${UI_CARD} flex flex-col gap-2 p-3`}>
    {right ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-xs font-semibold text-slate-900">{title}</strong>
        {right}
      </div>
    ) : (
      <strong className="text-xs font-semibold text-slate-900">{title}</strong>
    )}
    {children}
  </div>
);

const EmptyMsg = ({ text }: { text: string }) => (
  <div className="py-3 text-center text-xs text-[var(--text-3)]">{text}</div>
);

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
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const [search, setSearch] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [copyingLogs, setCopyingLogs] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const searchRef = useRef('');
  const logsReqSeqRef = useRef(0);
  const loadedSearchRef = useRef('');
  const lastTotalRef = useRef<number | undefined>(state?.total);
  searchRef.current = search;

  const activeGroups = state?.activeGroupsByMaterial?.[material.id] ?? [];
  const materialTasks = (state?.tasks ?? []).filter((t) => t.materialId === material.id);
  const postedGroupIds = state?.postedGroupIdsByMaterial?.[material.id] ?? [];

  const loadMaterialLogs = async (q = searchRef.current, before?: number, beforeId?: string) => {
    const reqSeq = ++logsReqSeqRef.current;
    if (!before) setLoadingLogs(true);
    try {
      const rows = await api.posterLogs(q, before, beforeId, material.id);
      if (logsReqSeqRef.current !== reqSeq) return;
      loadedSearchRef.current = q;
      setHasMoreLogs(rows.length >= 200);
      setLogs((prev) => (before ? [...prev, ...rows] : rows));
      if (!before) setSelectedLogIds(new Set());
    } catch (e) {
      if (logsReqSeqRef.current === reqSeq) onMessage(errMsg(e, String(e)));
    } finally {
      if (!before && logsReqSeqRef.current === reqSeq) setLoadingLogs(false);
    }
  };

  const copyMaterialLogs = async () => {
    if (copyingLogs) return;
    setCopyingLogs(true);
    try {
      let targetRows: PosterLog[];
      if (selectedLogIds.size > 0) targetRows = logs.filter((r) => selectedLogIds.has(r.id));
      else {
        const seedRows =
          logs.length > 0 && loadedSearchRef.current === search
            ? logs
            : await api.posterLogs(search, undefined, undefined, material.id);
        if (loadedSearchRef.current !== search) {
          loadedSearchRef.current = search;
          setLogs(seedRows);
        }
        targetRows = await collectAllPaginatedLogs({
          initialRows: seedRows,
          getTimestamp: (r) => r.postedAt,
          fetchPage: (b, bid) => api.posterLogs(search, b, bid, material.id),
        });
      }
      if (!targetRows.length) return onMessage('当前没有可复制的发帖记录');
      await copyTextToClipboard(formatPosterLogsAsTsv(targetRows, profiles));
      onMessage(
        `已批量复制${selectedLogIds.size > 0 ? '已选' : '该贴文全部'} ${targetRows.length} 条发帖记录，可直接粘贴到表格`,
      );
    } catch (e) {
      onMessage(errMsg(e, String(e)));
    } finally {
      setCopyingLogs(false);
    }
  };

  useEffect(() => {
    setSearch('');
    searchRef.current = '';
    lastTotalRef.current = state?.total;
    void loadMaterialLogs('');
  }, [material.id]);
  useEffect(() => {
    if (state?.total !== undefined && state.total !== lastTotalRef.current) {
      lastTotalRef.current = state.total;
      void loadMaterialLogs(searchRef.current);
    }
  }, [state?.total]);

  return (
    <>
      <BackdropModal
        label="贴文发帖详情与记录"
        modalClass="!gap-0 !p-0 flex max-h-[88vh] w-[min(960px,95vw)] flex-col overflow-hidden"
        blockEscape={previewOpen}
        onClose={onClose}
      >
        <ModalHeading
          title="贴文发帖详情（正在发小组 · 已发小组 · 发帖链接 · 定时任务）"
          closeText="×"
          onClose={onClose}
        />
        <PosterMaterialSummaryBox
          row={material}
          badge={posterRowBadge(material)}
          onPreview={() => setPreviewOpen(true)}
          className="flex gap-3 border-b border-[var(--line)] bg-slate-50/70 px-4 py-3"
          metaRow={
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                已发小组数：<strong>{postedGroupIds.length}</strong> 个
              </span>
              <span>
                正在发/排队：<strong>{activeGroups.length}</strong> 个
              </span>
            </div>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <SectionCard title={`正在发 / 排队中的小组 (${activeGroups.length})`}>
            {!activeGroups.length ? (
              <EmptyMsg text="当前没有正在发送或排队中的小组" />
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {activeGroups.map((item) => {
                  const prof = profiles.find((pr) => pr.id === item.profileId);
                  const acct = prof
                    ? profileDisplayName(prof, prof.account.name || prof.id)
                    : (item.profileId ?? '等待空闲账号领取');
                  return (
                    <div
                      key={item.groupId}
                      className={`flex flex-col gap-1 rounded-lg border p-2 text-xs ${item.state === 'posting' ? 'border-blue-200 bg-blue-50/60' : 'border-amber-200 bg-amber-50/50'}`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold">
                          {item.state === 'posting' ? '▶ 正在发帖' : '⏳ 排队待发'}
                        </span>
                        <strong>{item.groupName}</strong>
                        <small className="text-[var(--text-3)]">({item.groupId})</small>
                      </div>
                      <div className="text-[11px] text-[var(--text-2)]">
                        执行账号：{acct}
                        {item.statusText ? ` · ${item.statusText}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
          <SectionCard title={`该贴文的任务与定时记录 (${materialTasks.length})`}>
            {!materialTasks.length ? (
              <EmptyMsg text="暂无该贴文的任务记录" />
            ) : (
              <DataTbl
                headers={['状态', '执行时间', '账号模式', '完成进度', '状态说明', '操作']}
                rows={materialTasks}
                empty="暂无任务记录"
                renderRow={(t) => {
                  const tb = taskStatusBadge(t.status);
                  return (
                    <tr key={t.id}>
                      <td className="px-2.5 py-2 align-middle">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tb.cls}`}
                        >
                          {tb.label}
                        </span>
                      </td>
                      <td className="px-2.5 py-2 align-middle">
                        {t.scheduledAt
                          ? `定时：${new Date(t.scheduledAt).toLocaleString()}`
                          : `立即：${new Date(t.createdAt).toLocaleString()}`}
                      </td>
                      <td className="px-2.5 py-2 align-middle">
                        {t.accountMode === 'all_online'
                          ? '🌐 全部在线账号'
                          : `👤 指定 ${t.profileIds.length} 个账号`}
                      </td>
                      <td className="px-2.5 py-2 align-middle">
                        已发 <strong>{t.postedCount}</strong> / {t.totalGroups} 组
                        {t.skippedCount > 0 ? `（跳过 ${t.skippedCount} 组）` : ''}
                      </td>
                      <td className="px-2.5 py-2 align-middle">{t.statusReason}</td>
                      <td className="px-2.5 py-2 align-middle">
                        {t.status === 'scheduled' || t.status === 'running' ? (
                          <Btn v="danger" disabled={busy} onClick={() => void onCancelTask(t.id)}>
                            {t.status === 'scheduled' ? '取消定时' : '停止任务'}
                          </Btn>
                        ) : (
                          <Btn disabled={busy} onClick={() => void onDeleteTask(t.id)}>
                            删除记录
                          </Btn>
                        )}
                      </td>
                    </tr>
                  );
                }}
              />
            )}
          </SectionCard>
          <SectionCard
            title={`已发小组明细 · 发帖账号 · 发帖链接 (${logs.length} 条记录)`}
            right={
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  type="search"
                  className={`${UI_INPUT_SM} w-52`}
                  placeholder="搜索已发小组、发帖账号或链接…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void loadMaterialLogs(search)}
                />
                <Btn onClick={() => void loadMaterialLogs(search)}>搜索</Btn>
                <Btn
                  v="primary"
                  disabled={copyingLogs || loadingLogs || !logs.length}
                  onClick={() => void copyMaterialLogs()}
                >
                  {copyingLogs
                    ? '正在复制…'
                    : selectedLogIds.size > 0
                      ? `批量复制已选 (${selectedLogIds.size})`
                      : `批量复制全部 (${logs.length})`}
                </Btn>
              </div>
            }
          >
            {loadingLogs ? (
              <EmptyMsg text="正在读取已发记录…" />
            ) : !logs.length ? (
              <EmptyMsg text="该贴文暂无已发小组记录" />
            ) : (
              <>
                <DataTbl
                  wrapClass="max-h-72 overflow-auto rounded-lg border border-[var(--line)] bg-white"
                  headers={[
                    <input
                      key="all"
                      type="checkbox"
                      className={UI_CHECKBOX}
                      aria-label="全选该贴文已发记录"
                      checked={logs.length > 0 && logs.every((l) => selectedLogIds.has(l.id))}
                      onChange={(e) =>
                        setSelectedLogIds(
                          e.target.checked ? new Set(logs.map((l) => l.id)) : new Set(),
                        )
                      }
                    />,
                    '发帖时间',
                    '目标小组',
                    '发帖账号 / 专页',
                    '发帖链接',
                  ]}
                  rows={logs}
                  empty="暂无记录"
                  renderRow={(row) => {
                    const prof = profiles.find((item) => item.id === row.profileId);
                    const profileTitle = prof
                      ? profileDisplayName(prof, prof.account.name || row.profileId)
                      : row.profileId;
                    const avatar =
                      (prof?.account.id === row.accountId && prof?.account.avatar
                        ? prof.account.avatar
                        : null) ?? row.accountAvatar;
                    return (
                      <tr key={row.id}>
                        <td className="px-2.5 py-2 align-middle">
                          <input
                            type="checkbox"
                            className={UI_CHECKBOX}
                            checked={selectedLogIds.has(row.id)}
                            onChange={() => setSelectedLogIds((prev) => toggleSet(prev, row.id))}
                          />
                        </td>
                        <td className="px-2.5 py-2 align-middle">
                          {new Date(row.postedAt).toLocaleString()}
                        </td>
                        <td className="px-2.5 py-2 align-middle">
                          <LogAvatarCell
                            avatar={row.groupAvatar}
                            title={row.groupName}
                            sub={row.groupId}
                          />
                        </td>
                        <td className="px-2.5 py-2 align-middle">
                          <LogAvatarCell
                            avatar={avatar}
                            title={row.accountName || profileTitle}
                            sub={row.accountId}
                            tag={{
                              text: row.identityType === 'page' ? '专页' : '个人',
                              cls:
                                row.identityType === 'page'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-slate-100 text-slate-700',
                            }}
                          />
                        </td>
                        <td className="px-2.5 py-2 align-middle">
                          {isPendingApprovalPostId(row.postId) && (
                            <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                              已提交待群管审核
                            </span>
                          )}
                          {/^https?:\/\//i.test(row.postUrl) ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Btn
                                title={row.postUrl}
                                onClick={() =>
                                  void copyTextToClipboard(row.postUrl)
                                    .then(() => onMessage('已复制发帖链接'))
                                    .catch((e) => onMessage(String(e)))
                                }
                              >
                                复制链接
                              </Btn>
                              <a
                                href={row.postUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-[var(--line-strong)] bg-white px-2.5 text-xs font-medium whitespace-nowrap text-[var(--text)] no-underline transition-colors hover:border-slate-300 hover:bg-slate-100"
                              >
                                打开链接
                              </a>
                            </span>
                          ) : (
                            <span
                              className="text-xs text-[var(--text-3)]"
                              title="移动端发帖不返回直链"
                            >
                              无直链
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  }}
                />
                {hasMoreLogs && (
                  <Btn
                    className="mt-1 self-start"
                    onClick={() =>
                      void loadMaterialLogs(search, logs.at(-1)?.postedAt, logs.at(-1)?.id)
                    }
                  >
                    加载更多
                  </Btn>
                )}
              </>
            )}
          </SectionCard>
        </div>
      </BackdropModal>
      {previewOpen && (
        <PosterMediaPreviewModal row={material} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  );
}
