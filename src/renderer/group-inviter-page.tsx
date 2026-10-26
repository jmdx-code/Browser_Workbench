import { useEffect, useRef, useState } from 'react';
import type { GroupInviterState, InviterGroupRow } from '../shared/group-inviter.js';
import { selectionState, toggleSet } from './selection.js';
import { IconClose, IconPlay, IconPlus, IconSearch, IconStop } from './icons.js';

import {
  applyGroupGridPaste,
  extractGroupId,
  isGroupGridPaste,
  type DraftGroupEntry,
} from './group-inviter-grid.js';
export { applyGroupGridPaste, extractGroupId } from './group-inviter-grid.js';
function makeDraftRow(groupId = '', groupName = ''): DraftGroupEntry {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    groupId,
    groupName,
  };
}

function HeaderCheck({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function GroupAvatarCell({ row }: { row: InviterGroupRow }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [row.avatarUrl]);

  const fallbackChar = Array.from(row.groupName.trim())[0] ?? 'G';
  if (!row.avatarUrl || broken) {
    return (
      <span className="group-inviter-avatar is-fallback" title={row.groupName}>
        {fallbackChar}
      </span>
    );
  }
  return (
    <span className="group-inviter-avatar">
      <img
        src={row.avatarUrl}
        alt={row.groupName}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    </span>
  );
}

export function GroupInviterPage({
  state,
  loaded,
  selectedProfileIds,
  busy,
  onAddGroups,
  onDeleteGroups,
  onSaveInvitesPerGroup,
  onStart,
  onStop,
}: {
  state: GroupInviterState | null;
  loaded: boolean;
  selectedProfileIds: ReadonlySet<string>;
  busy: boolean;
  onAddGroups: (items: Array<{ groupId: string; groupName: string }>) => Promise<void>;
  onDeleteGroups: (groupIds: string[]) => Promise<void>;
  onSaveInvitesPerGroup: (invitesPerGroup: number) => Promise<void>;
  onStart: (groupIds: string[], invitesPerGroup: number) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [invitesInput, setInvitesInput] = useState<number>(state?.invitesPerGroup ?? 30);
  const [addingModalOpen, setAddingModalOpen] = useState(false);
  const [draftRows, setDraftRows] = useState<DraftGroupEntry[]>(() =>
    Array.from({ length: 5 }, () => makeDraftRow()),
  );
  const [formError, setFormError] = useState('');
  const [submittingAdd, setSubmittingAdd] = useState(false);

  useEffect(() => {
    if (state?.invitesPerGroup !== undefined) {
      setInvitesInput(state.invitesPerGroup);
    }
  }, [state?.invitesPerGroup]);

  // Keep selectedGroups pruned to existing groups
  useEffect(() => {
    if (!state) return;
    const validIds = new Set(state.groups.map((item) => item.groupId));
    setSelectedGroups((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [state]);

  const groups = state?.groups ?? [];
  const filteredGroups = groups.filter((row) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return row.groupId.toLowerCase().includes(q) || row.groupName.toLowerCase().includes(q);
  });

  const filteredIds = filteredGroups.map((row) => row.groupId);
  const allSelectionState = selectionState(selectedGroups, filteredIds);
  const isRunning = Boolean(state?.running);
  const totalInvitedAcrossGroups = groups.reduce((sum, item) => sum + item.totalInvitedCount, 0);

  function openAddModal() {
    setDraftRows(Array.from({ length: 5 }, () => makeDraftRow()));
    setFormError('');
    setAddingModalOpen(true);
  }

  function handlePasteIntoTable(
    index: number,
    column: 0 | 1,
    event: React.ClipboardEvent<HTMLInputElement>,
  ) {
    const text = event.clipboardData.getData('text/plain');
    if (!isGroupGridPaste(text, column)) return;
    event.preventDefault();
    setDraftRows((prev) => applyGroupGridPaste(prev, index, column, text, makeDraftRow));
  }
  function moveCell(index: number, column: 0 | 1, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const delta =
      event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' || event.key === 'Enter' ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    const target = index + delta;
    if (target < 0) return;
    if (target >= draftRows.length) {
      if (event.key !== 'Enter') return;
      setDraftRows((prev) => [...prev, makeDraftRow()]);
    }
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLInputElement>(`[data-group-row="${target}"][data-group-col="${column}"]`)
        ?.focus(),
    );
  }
  async function submitAddGroups(event: React.FormEvent) {
    event.preventDefault();
    const collected: Array<{ groupId: string; groupName: string }> = [];
    for (const row of draftRows) {
      const groupId = extractGroupId(row.groupId);
      const groupName = row.groupName.trim();
      if (!groupId && !groupName) continue;
      if (!groupId || !groupName) {
        setFormError('请同时填写每行的「小组ID」和「小组名字」');
        return;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(groupId)) {
        setFormError(`小组ID「${groupId}」格式不正确，仅支持数字、字母、点、下划线或连字符`);
        return;
      }
      collected.push({ groupId, groupName });
    }
    if (!collected.length) {
      setFormError('请至少输入一行小组数据');
      return;
    }
    setFormError('');
    setSubmittingAdd(true);
    try {
      await onAddGroups(collected);
      setAddingModalOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '添加小组失败');
    } finally {
      setSubmittingAdd(false);
    }
  }

  function normalizeInvitesCount(value: number): number {
    if (!Number.isFinite(value)) return 30;
    return Math.max(1, Math.min(200, Math.round(value)));
  }

  return (
    <section className="records-page group-inviter-page" aria-label="小组邀请人">
      <div className="section-head">
        <div>
          <h2>
            小组邀请人
            <span className="count-chip" title="小组库总数">
              {groups.length} 个小组
            </span>
            <span className="count-chip" title="所有小组累计被邀请总人数">
              累计邀请 {totalInvitedAcrossGroups} 人
            </span>
          </h2>
        </div>
        <div className="section-tools group-inviter-toolbar">
          <label className="search-field">
            <IconSearch />
            <input
              type="search"
              aria-label="搜索小组"
              placeholder="搜索小组名字或 ID"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <label
            className="group-inviter-limit-field"
            title="每个账号进入每个小组单次最多邀请的好友人数（默认 30）"
          >
            <span>每组邀请</span>
            <input
              type="number"
              min={1}
              max={200}
              disabled={busy || isRunning}
              value={invitesInput}
              onChange={(event) => setInvitesInput(Number(event.target.value))}
              onBlur={() => {
                const normalized = normalizeInvitesCount(invitesInput);
                setInvitesInput(normalized);
                if (state && normalized !== state.invitesPerGroup) {
                  void onSaveInvitesPerGroup(normalized);
                }
              }}
            />
            <span>人</span>
          </label>
          <button className="btn" type="button" disabled={busy} onClick={openAddModal}>
            <IconPlus size={14} /> 添加小组
          </button>
          <button
            className="btn btn-danger"
            type="button"
            disabled={busy || isRunning || selectedGroups.size === 0}
            onClick={() => void onDeleteGroups([...selectedGroups])}
            title={
              selectedGroups.size
                ? `删除已选中的 ${selectedGroups.size} 个小组`
                : '请先在表格中勾选要删除的小组'
            }
          >
            删除{selectedGroups.size > 0 ? ` (${selectedGroups.size})` : ''}
          </button>
          {isRunning ? (
            <button
              className="btn btn-danger"
              type="button"
              disabled={busy}
              onClick={() => void onStop()}
            >
              <IconStop size={13} /> 停止运行
            </button>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || selectedProfileIds.size === 0 || selectedGroups.size === 0}
              title={
                selectedProfileIds.size === 0
                  ? '请先在左侧列表勾选账号'
                  : selectedGroups.size === 0
                    ? '请先在右侧表格勾选小组'
                    : `使用已选的 ${selectedProfileIds.size} 个账号向 ${selectedGroups.size} 个小组随机错峰邀请好友`
              }
              onClick={() => void onStart([...selectedGroups], normalizeInvitesCount(invitesInput))}
            >
              <IconPlay size={12} /> 开始运行
              {selectedProfileIds.size > 0 && selectedGroups.size > 0
                ? ` (${selectedProfileIds.size}号 × ${selectedGroups.size}组)`
                : ''}
            </button>
          )}
        </div>
      </div>

      {state?.statusText && (
        <div className={'group-inviter-banner' + (isRunning ? ' is-running' : '')} role="status">
          <span className="banner-dot" />
          <span>{state.statusText}</span>
          <span className="banner-hint">
            已选账号 {selectedProfileIds.size} 个 · 已选小组 {selectedGroups.size} 个
          </span>
        </div>
      )}

      {!loaded ? (
        <p className="muted records-empty">正在读取小组库…</p>
      ) : groups.length === 0 ? (
        <div className="records-empty">
          <p>小组库还是空的。点击右上角「添加小组」录入小组 ID 和小组名字即可开始使用。</p>
          <button className="btn btn-primary" type="button" onClick={openAddModal}>
            <IconPlus size={14} /> 添加小组
          </button>
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="records-empty">
          <p>没有匹配「{searchQuery}」的小组。</p>
        </div>
      ) : (
        <div className="records-table group-inviter-table" role="table" aria-label="小组库列表">
          <div className="records-row records-header group-inviter-row" role="row">
            <span role="columnheader" className="cell-check">
              <HeaderCheck
                {...allSelectionState}
                disabled={isRunning}
                label="全选当前显示的小组"
                onChange={(checked) =>
                  setSelectedGroups(toggleSet(selectedGroups, filteredIds, checked))
                }
              />
            </span>
            <span role="columnheader">小组头像</span>
            <span role="columnheader">小组名字</span>
            <span role="columnheader">小组 ID</span>
            <span role="columnheader">累计被邀请人数</span>
          </div>
          {filteredGroups.map((row) => {
            const isChecked = selectedGroups.has(row.groupId);
            return (
              <div
                key={row.groupId}
                role="row"
                className={'records-row group-inviter-row' + (isChecked ? ' is-selected' : '')}
                onClick={() => {
                  if (!isRunning) {
                    setSelectedGroups(toggleSet(selectedGroups, [row.groupId], !isChecked));
                  }
                }}
              >
                <span
                  role="cell"
                  className="cell-check"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isRunning}
                    aria-label={'选择小组 ' + row.groupName}
                    onChange={(event) =>
                      setSelectedGroups(
                        toggleSet(selectedGroups, [row.groupId], event.target.checked),
                      )
                    }
                  />
                </span>
                <span role="cell" className="cell-avatar">
                  <GroupAvatarCell row={row} />
                </span>
                <span role="cell" className="cell-group-name">
                  <strong>{row.groupName}</strong>
                </span>
                <span role="cell" className="cell-group-id">
                  <code className="fb-id">{row.groupId}</code>
                </span>
                <span role="cell" className="cell-invited-count">
                  <span className="pill pill-ok">累计 {row.totalInvitedCount} 人</span>
                </span>
              </div>
            );
          })}
          <div className="records-foot">
            <span>
              共 {filteredGroups.length} 个小组 · 已勾选 {selectedGroups.size} 个小组
            </span>
          </div>
        </div>
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
              支持逐行输入「小组 ID」和「小组名字」两列数据，也支持从 Excel
              或文本直接多行粘贴。保存后会自动拉取小组头像。
            </p>
            <div className="group-inviter-grid-scroll">
              <table className="group-inviter-matrix" role="table" aria-label="添加小组两列表格">
                <colgroup>
                  <col style={{ width: 40 }} />
                  <col style={{ width: '38%' }} />
                  <col style={{ width: 'calc(62% - 76px)' }} />
                  <col style={{ width: 36 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>A · 小组 ID</th>
                    <th>B · 小组名字</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {draftRows.map((row, idx) => (
                    <tr key={row.key}>
                      <td>{idx + 1}</td>
                      {([0, 1] as const).map((column) => (
                        <td key={column}>
                          <input
                            disabled={submittingAdd}
                            data-group-row={idx}
                            data-group-col={column}
                            aria-label={`第 ${idx + 1} 行小组${column === 0 ? ' ID' : '名字'}`}
                            placeholder={column === 0 ? '小组 ID 或链接' : '小组名字'}
                            value={column === 0 ? row.groupId : row.groupName}
                            onPaste={(event) => handlePasteIntoTable(idx, column, event)}
                            onKeyDown={(event) => moveCell(idx, column, event)}
                            onBlur={() => {
                              if (column === 0)
                                setDraftRows((prev) =>
                                  prev.map((r, i) =>
                                    i === idx ? { ...r, groupId: extractGroupId(r.groupId) } : r,
                                  ),
                                );
                            }}
                            onChange={(event) => {
                              const text = event.target.value;
                              setDraftRows((prev) =>
                                prev.map((r, i) =>
                                  i === idx
                                    ? { ...r, [column === 0 ? 'groupId' : 'groupName']: text }
                                    : r,
                                ),
                              );
                            }}
                          />
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className="btn btn-icon btn-ghost"
                          aria-label={`删除第 ${idx + 1} 行`}
                          disabled={submittingAdd}
                          onClick={() =>
                            setDraftRows((prev) =>
                              prev.length === 1 && prev[0]
                                ? [{ ...prev[0], groupId: '', groupName: '' }]
                                : prev.filter((_, i) => i !== idx),
                            )
                          }
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="group-inviter-modal-tools">
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={submittingAdd}
                  onClick={() => setDraftRows((prev) => [...prev, makeDraftRow()])}
                >
                  ＋ 新增一行
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={submittingAdd}
                  onClick={() => setDraftRows(Array.from({ length: 5 }, () => makeDraftRow()))}
                >
                  清空表格
                </button>
              </div>
              <span>
                已填有效小组{' '}
                {draftRows.filter((row) => row.groupId.trim() && row.groupName.trim()).length} 个
              </span>
            </div>
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
