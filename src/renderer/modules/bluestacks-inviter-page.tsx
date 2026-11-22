import { useEffect, useMemo, useState } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../shared/bluestacks.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import type { GroupInviterState } from '../../shared/group-inviter.js';
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

export function BluestacksInviterPage({
  bluestacksState,
  onBluestacksState,
  selected,
  groups,
  inviterState,
  onSyncSharedGroups,
  onMessage,
}: {
  bluestacksState: BluestacksState | null;
  onBluestacksState: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  groups: readonly BumperTarget[];
  inviterState?: GroupInviterState | null | undefined;
  onSyncSharedGroups?: (() => Promise<void>) | undefined;
  onMessage: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [invitesPerGroup, setInvitesPerGroup] = useState(5);
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
  const pageIdentitySelected = selectedInstances.filter((i) => i.identityType === 'page');
  const isRunning = Boolean(bluestacksState?.inviterRunning);

  // Unified shared groups list: prefer groupInviter (has exact totalInvitedCount) and merge bumper fallback
  const finderItems = useMemo(() => {
    if (inviterState?.groups && inviterState.groups.length > 0) {
      return inviterState.groups.map((g) => ({
        id: g.groupId,
        name: g.groupName,
        folderId: g.folderId,
        sortOrder: g.sortOrder,
        avatarUrl: g.avatarUrl,
        count: g.totalInvitedCount,
      }));
    }
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      folderId: g.folderId,
      sortOrder: g.sortOrder,
      avatarUrl: g.avatarUrl,
      count: g.totalBumpedCount,
    }));
  }, [inviterState?.groups, groups]);

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
      onMessage('请先在左侧蓝蝶窗口列表中勾选至少一个个人号模拟器');
      return;
    }
    if (orderedSelectedGroupIds.length === 0) {
      onMessage('请至少勾选 1 个目标小组');
      return;
    }
    setBusy(true);
    try {
      const next = await api.bluestacksAction('inviter/start', {
        instanceIds: selectedIds,
        groupIds: orderedSelectedGroupIds,
        invitesPerGroup,
      });
      onBluestacksState(next);
      onMessage(
        `已启动蓝蝶小组邀请人（${selectedIds.length} 台蓝蝶 × ${orderedSelectedGroupIds.length} 个小组）`,
      );
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '启动蓝蝶小组邀请人失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const next = await api.bluestacksAction('inviter/stop', {});
      onBluestacksState(next);
      onMessage('已发送停止蓝蝶小组邀请人指令');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '停止失败');
    } finally {
      setBusy(false);
    }
  }

  const totalInvitedAcrossGroups = finderItems.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className="records-page bumper-page group-inviter-page" aria-label="蓝蝶小组邀请人">
      <div className="bumper-sticky-header">
        <div className="bumper-heading">
          <div className="bumper-primary-controls">
            <div className="bumper-search-highlight bumper-policy">
              <label
                className="bumper-policy-field"
                title="每台蓝蝶进入每个小组单次最多邀请的好友人数（默认 5）"
              >
                <span>每组邀请</span>
                <ControlledNumberInput
                  ariaLabel="每个小组邀请人数上限"
                  min={1}
                  max={50}
                  defaultValue={5}
                  disabled={busy || isRunning}
                  value={invitesPerGroup}
                  onChange={setInvitesPerGroup}
                />
                <span>人</span>
              </label>
              <span className="bumper-policy-field muted">
                共 {finderItems.length} 个共享小组 · 累计邀请 {totalInvitedAcrossGroups} 人 ·
                仅邀实心蓝按钮并逐条变灰确认
              </span>
            </div>
          </div>

          <div className="bumper-actions">
            {(bluestacksState?.inviterStatusText || inviterState?.avatarRefreshStatusText) && (
              <span
                className={
                  'bumper-status' +
                  (isRunning || inviterState?.groupAvatarRefreshing ? ' is-running' : '')
                }
                role="status"
              >
                {inviterState?.groupAvatarRefreshing && inviterState.avatarRefreshStatusText
                  ? inviterState.avatarRefreshStatusText
                  : bluestacksState?.inviterStatusText}
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
                <IconStop size={13} /> 停止邀人
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || selectedIds.length === 0 || orderedSelectedGroupIds.length === 0}
                title={
                  selectedIds.length === 0
                    ? '请先在左侧蓝蝶窗口列表中勾选账号'
                    : orderedSelectedGroupIds.length === 0
                      ? '请先在下方列表勾选目标小组'
                      : `使用已选的 ${selectedIds.length} 台蓝蝶向 ${orderedSelectedGroupIds.length} 个小组邀人（未启动窗口会自动拉起）`
                }
                onClick={() => void handleStart()}
              >
                <IconPlay size={12} />{' '}
                {busy
                  ? '启动中…'
                  : `开始蓝蝶邀人 (${selectedIds.length}台 × ${orderedSelectedGroupIds.length}组)`}
              </button>
            )}
          </div>
        </div>
      </div>

      {pageIdentitySelected.length > 0 && (
        <div
          className="panel"
          style={{
            padding: '10px 14px',
            borderColor: 'var(--warn, #d97706)',
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          <strong>身份提示：</strong>
          已选窗口中有 {pageIdentitySelected.length} 台当前为<strong>专页身份</strong>（
          {pageIdentitySelected.map((i) => bluestacksDisplayTitle(i)).join('、')}
          ）。Facebook 仅支持个人号邀请好友进群，专页身份运行时将自动安全跳过；可在左侧栏点击「⋯ →
          切换个人 / 专页身份」先切回个人主号。
        </div>
      )}

      <FinderTargetList
        listKind="shared_groups"
        title="小组列表"
        countLabel="累计被邀请人数"
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
          refreshingAvatars || inviterState?.groupAvatarRefreshing
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
            已选蓝蝶邀人进度（{selectedInstances.length}）
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
              const stat = bluestacksState?.inviterProfileCounts?.[inst.id];
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
                    {inst.identityType === 'page' ? ' [专页]' : ''}
                  </span>
                  <span className="hint">
                    {stat?.status || (inst.online ? '在线就绪' : '未启动（运行自动拉起）')}
                    {stat && stat.session > 0 ? ` · 本轮已邀 ${stat.session} 人` : ''}
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
