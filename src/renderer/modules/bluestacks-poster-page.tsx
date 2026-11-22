import { useEffect, useMemo, useState } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../shared/bluestacks.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import type { PosterMaterial } from '../../shared/group-poster.js';
import type { TargetFolder } from '../../shared/target-list.js';
import { api } from '../api.js';
import { FinderTargetList, orderedFinderItems } from '../finder-target-list.js';
import { extractGroupId, type DraftGroupEntry } from '../group-inviter-grid.js';
import { GroupDraftGrid } from '../group-inviter-page.js';
import { IconClose, IconPlay, IconStop } from '../icons.js';
import { ControlledNumberInput } from './shared/controlled-number-input.js';

function makeDraftRow(): DraftGroupEntry {
  return { key: crypto.randomUUID(), groupId: '', groupName: '' };
}

function MaterialThumb({ mat }: { mat: PosterMaterial }) {
  const [broken, setBroken] = useState(false);
  const src =
    mat.mediaKind === 'image' && mat.cacheStatus === 'ready'
      ? `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(mat.id)}&v=${mat.updatedAt ?? 0}`
      : mat.hasThumbnail
        ? `/api/workspace/group-poster/materials/thumbnail?id=${encodeURIComponent(mat.id)}&v=${mat.updatedAt ?? 0}`
        : null;

  useEffect(() => setBroken(false), [src]);

  if (src && !broken) {
    return (
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          width: 42,
          height: 42,
          flexShrink: 0,
          borderRadius: 6,
          overflow: 'hidden',
          background: '#f1f5f9',
        }}
      >
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          style={{ width: 42, height: 42, objectFit: 'cover', display: 'block' }}
        />
        {mat.mediaKind === 'video' && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 2,
              bottom: 2,
              padding: '0 4px',
              fontSize: 9,
              lineHeight: 1.3,
              borderRadius: 3,
              background: 'rgba(0,0,0,0.72)',
              color: '#fff',
            }}
          >
            ▶
          </span>
        )}
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 42,
        height: 42,
        flexShrink: 0,
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        background: mat.background === 'color' ? '#fef3c7' : '#e7e9ee',
        color: mat.background === 'color' ? '#b45309' : '#64748b',
      }}
    >
      {mat.mediaKind === 'video'
        ? '视频'
        : mat.mediaKind === 'image'
          ? '图片'
          : mat.background === 'color'
            ? '彩贴'
            : '文字'}
    </span>
  );
}

export function BluestacksPosterPage({
  bluestacksState,
  onBluestacksState,
  selected,
  materials,
  groups,
  groupAvatarRefreshing = false,
  onSyncSharedGroups,
  onMessage,
}: {
  bluestacksState: BluestacksState | null;
  onBluestacksState: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  materials: readonly PosterMaterial[];
  groups: readonly BumperTarget[];
  groupAvatarRefreshing?: boolean | undefined;
  onSyncSharedGroups?: (() => Promise<void>) | undefined;
  onMessage: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [maxGroupsPerInstance, setMaxGroupsPerInstance] = useState(3);
  const [postToTimeline, setPostToTimeline] = useState(false);
  const [addingModalOpen, setAddingModalOpen] = useState(false);
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [draftRows, setDraftRows] = useState<DraftGroupEntry[]>(() =>
    Array.from({ length: 5 }, () => makeDraftRow()),
  );
  const [formError, setFormError] = useState('');
  const [submittingAdd, setSubmittingAdd] = useState(false);
  const [refreshingAvatars, setRefreshingAvatars] = useState(false);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const instances = bluestacksState?.instances ?? [];
  const selectedInstances = useMemo(
    () => instances.filter((i) => selected.has(i.id)),
    [instances, selected],
  );
  const isRunning = Boolean(bluestacksState?.posterRunning);

  const finderItems = useMemo(
    () =>
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        folderId: g.folderId,
        sortOrder: g.sortOrder,
        avatarUrl: g.avatarUrl,
        count: g.totalBumpedCount,
      })),
    [groups],
  );

  const orderedSelectedGroupIds = useMemo(
    () =>
      orderedFinderItems(finderItems, folders)
        .filter((g) => selectedGroups.has(g.id))
        .map((g) => g.id),
    [finderItems, folders, selectedGroups],
  );

  useEffect(() => {
    if (!addingModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submittingAdd) setAddingModalOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [addingModalOpen, submittingAdd]);

  async function syncTargets() {
    if (onSyncSharedGroups) {
      await onSyncSharedGroups();
    }
  }

  function toggleMaterial(id: string) {
    setSelectedMaterialIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function openAddModal() {
    setAddFolder(null);
    setDraftRows(Array.from({ length: 5 }, () => makeDraftRow()));
    setFormError('');
    setAddingModalOpen(true);
  }

  async function submitAddGroups(event: React.FormEvent) {
    event.preventDefault();
    const collected: Array<{ groupId: string; groupName: string; folderId?: string | null }> = [];
    for (const row of draftRows) {
      const groupId = extractGroupId(row.groupId);
      const groupName = row.groupName.trim();
      if (!groupId && !groupName) continue;
      if (!groupId) {
        setFormError('请填写每行的「小组ID或链接」');
        return;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(groupId)) {
        setFormError(`小组ID「${groupId}」格式不正确，仅支持数字、字母、点、下划线或连字符`);
        return;
      }
      collected.push({ groupId, groupName, folderId: addFolder });
    }
    if (!collected.length) {
      setFormError('请至少输入一行小组数据');
      return;
    }
    setFormError('');
    setSubmittingAdd(true);
    try {
      await api.addInviterGroups({ items: collected });
      await syncTargets();
      setAddingModalOpen(false);
      onMessage(`已保存 ${collected.length} 个小组，正在后台获取小组头像`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '添加小组失败');
    } finally {
      setSubmittingAdd(false);
    }
  }

  async function handleStart() {
    if (selectedIds.length === 0) {
      onMessage('请先在左侧蓝蝶窗口列表中勾选至少一个模拟器');
      return;
    }
    if (selectedMaterialIds.length === 0) {
      onMessage('请至少勾选 1 条发帖素材');
      return;
    }
    if (orderedSelectedGroupIds.length === 0 && !postToTimeline) {
      onMessage('请至少勾选 1 个目标小组，或开启「同时发布到时间线」');
      return;
    }
    setBusy(true);
    try {
      const next = await api.bluestacksAction('poster/start', {
        instanceIds: selectedIds,
        materialIds: selectedMaterialIds,
        groupIds: orderedSelectedGroupIds,
        maxGroupsPerInstance,
        postToTimeline,
      });
      onBluestacksState(next);
      onMessage(`已启动蓝蝶小组发帖（${selectedIds.length} 台蓝蝶）`);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '启动蓝蝶发帖失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const next = await api.bluestacksAction('poster/stop', {});
      onBluestacksState(next);
      onMessage('已发送停止蓝蝶发帖指令');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '停止失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="records-page bumper-page" aria-label="蓝蝶小组发帖">
      <div className="bumper-sticky-header">
        <div className="bumper-heading">
          <div className="bumper-primary-controls">
            <div className="bumper-search-highlight bumper-policy">
              <label className="bumper-policy-field">
                <span>单台最多发</span>
                <ControlledNumberInput
                  ariaLabel="单台蓝蝶最多发帖小组数"
                  min={1}
                  max={50}
                  defaultValue={3}
                  value={maxGroupsPerInstance}
                  onChange={setMaxGroupsPerInstance}
                />
                <span>个小组</span>
              </label>
              <label className="bumper-policy-field">
                <input
                  type="checkbox"
                  checked={postToTimeline}
                  onChange={(e) => setPostToTimeline(e.target.checked)}
                />
                <span>同时发布到账号 / 专页时间线</span>
              </label>
            </div>
          </div>

          <div className="bumper-actions">
            {bluestacksState?.posterStatusText && (
              <span className={'bumper-status' + (isRunning ? ' is-running' : '')} role="status">
                {bluestacksState.posterStatusText}
              </span>
            )}
            <span className="pill">已选蓝蝶 {selectedIds.length} 台</span>
            {isRunning ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void handleStop()}
              >
                <IconStop size={13} /> 停止发帖
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || selectedIds.length === 0}
                onClick={() => void handleStart()}
              >
                <IconPlay size={12} /> {busy ? '启动中…' : '开始蓝蝶发帖'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div
        className="bumper-targets"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.35fr)',
          gap: 14,
          flex: 1,
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <section
          className="panel"
          style={{
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <strong>
              1. 选择发帖素材（已选 {selectedMaterialIds.length}/{materials.length}）
            </strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setSelectedMaterialIds(materials.map((m) => m.id))}
              >
                全选
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setSelectedMaterialIds([])}
              >
                清空
              </button>
            </div>
          </div>
          {materials.length === 0 ? (
            <p className="hint" style={{ margin: 0 }}>
              素材库为空，请先在「小组发帖」模块添加并预检贴文素材。
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                flex: 1,
                overflowY: 'auto',
                minHeight: 0,
              }}
            >
              {materials.map((mat, idx) => {
                const checked = selectedMaterialIds.includes(mat.id);
                return (
                  <label
                    key={mat.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: checked ? '1px solid var(--accent)' : '1px solid var(--line)',
                      background: checked ? 'var(--accent-soft, rgba(59,130,246,0.06))' : undefined,
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMaterial(mat.id)}
                    />
                    <MaterialThumb mat={mat} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {idx + 1}. {mat.caption.trim() || '[纯媒体素材]'}
                      </div>
                      <div className="hint" style={{ fontSize: 11, marginTop: 2 }}>
                        {mat.mediaKind === 'image'
                          ? '图片'
                          : mat.mediaKind === 'video'
                            ? '视频'
                            : mat.background === 'color'
                              ? '彩底短贴'
                              : '纯文字'}
                        {' · '}
                        {mat.cacheStatus === 'ready' ? '缓存就绪' : mat.cacheStatus}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </section>

        <FinderTargetList
          listKind="shared_groups"
          title="2. 小组列表"
          countLabel="累计发帖"
          disabled={busy}
          items={finderItems}
          selected={selectedGroups}
          onSelect={setSelectedGroups}
          onDelete={async (ids) => {
            await api.deleteInviterGroups({ groupIds: ids });
            await syncTargets();
            onMessage(`已删除 ${ids.length} 个小组`);
          }}
          onChanged={syncTargets}
          onFolders={setFolders}
          tools={
            <button className="btn btn-sm" type="button" disabled={busy} onClick={openAddModal}>
              ＋ 添加小组
            </button>
          }
          moreItems={[
            refreshingAvatars || groupAvatarRefreshing
              ? {
                  label: '停止刷新头像',
                  disabled: busy,
                  onSelect: () => {
                    void api
                      .stopRefreshGroupInviterGroups()
                      .then((next) => {
                        onMessage(next.avatarRefreshStatusText || '已停止读取小组资料');
                        return syncTargets();
                      })
                      .catch((err) => {
                        onMessage(err instanceof Error ? err.message : String(err));
                      })
                      .finally(() => setRefreshingAvatars(false));
                  },
                }
              : {
                  label: '刷新头像',
                  disabled: busy || isRunning || finderItems.length === 0,
                  onSelect: () => {
                    setRefreshingAvatars(true);
                    void api
                      .refreshGroupInviterGroups(
                        selectedGroups.size ? { ids: [...selectedGroups] } : {},
                      )
                      .then((next) => {
                        const msg = next.avatarRefreshStatusText || next.statusText;
                        if (msg) onMessage(msg);
                        return syncTargets();
                      })
                      .catch((err) => {
                        onMessage(err instanceof Error ? err.message : String(err));
                      })
                      .finally(() => setRefreshingAvatars(false));
                  },
                },
          ]}
        />
      </div>

      {selectedInstances.length > 0 && (
        <section
          className="panel"
          style={{
            padding: 14,
            marginTop: 12,
            flexShrink: 0,
            maxHeight: 168,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <strong style={{ display: 'block', marginBottom: 8, fontSize: 13, flexShrink: 0 }}>
            已选蓝蝶发帖进度（{selectedInstances.length}）
          </strong>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflowY: 'auto',
              minHeight: 0,
            }}
          >
            {selectedInstances.map((inst) => {
              const stat = bluestacksState?.posterProfileCounts?.[inst.id];
              return (
                <div
                  key={inst.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                    fontSize: 13,
                  }}
                >
                  <span>
                    <strong>{bluestacksDisplayTitle(inst)}</strong>
                    {inst.accountName ? ` · ${inst.accountName}` : ''}
                  </span>
                  <span className="hint">
                    {stat?.status || (inst.online ? '在线就绪' : '未启动（运行自动拉起）')}
                    {stat && stat.session > 0 ? ` · 本轮已发 ${stat.session} 条` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {addingModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="添加小组"
          onClick={() => !submittingAdd && setAddingModalOpen(false)}
        >
          <form
            className="modal group-inviter-add-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void submitAddGroups(event)}
          >
            <div className="modal-head">
              <h3>添加小组</h3>
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                aria-label="关闭"
                disabled={submittingAdd}
                onClick={() => setAddingModalOpen(false)}
              >
                <IconClose />
              </button>
            </div>
            <p className="muted modal-desc">
              支持只填「小组 ID 或链接」（名字选填，留空将自动解析真实小组名与头像），也支持从 Excel
              或文本直接多行粘贴。
            </p>
            {folders.length > 0 && (
              <label className="target-folder-select">
                归入分组{' '}
                <select
                  aria-label="添加小组归入分组"
                  value={addFolder ?? ''}
                  onChange={(e) => setAddFolder(e.target.value || null)}
                >
                  <option value="">未分组</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <GroupDraftGrid
              rows={draftRows}
              onChange={setDraftRows}
              disabled={submittingAdd}
              onError={setFormError}
            />
            {formError && (
              <p className="error-note" role="alert">
                {formError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                disabled={submittingAdd}
                onClick={() => setAddingModalOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={submittingAdd}>
                {submittingAdd ? '正在保存…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
