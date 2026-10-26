import { copyTextToClipboard } from './clipboard.js';
import { useEffect, useRef, useState } from 'react';
import type { GroupInviterState, InviterGroupRow } from '../shared/group-inviter.js';
import { selectionState, toggleSet } from './selection.js';
import { IconClose, IconPlay, IconPlus, IconSearch, IconStop } from './icons.js';

type GridColumn = 0 | 1;
type GridRange = { r1: number; c1: GridColumn; r2: number; c2: GridColumn };
type GridEdit = { r: number; c: GridColumn; value: string };

function GroupDraftGrid({
  rows,
  onChange,
  disabled,
  onError,
}: {
  rows: DraftGroupEntry[];
  onChange: (rows: DraftGroupEntry[]) => void;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [range, setRange] = useState<GridRange>({ r1: 0, c1: 0, r2: 0, c2: 0 });
  const rangeRef = useRef(range),
    rowsRef = useRef(rows),
    gridRef = useRef<HTMLDivElement>(null);
  const [undo, setUndo] = useState<DraftGroupEntry[][]>([]);
  const [editing, setEditing] = useState<GridEdit | null>(null);
  const editingRef = useRef<GridEdit | null>(null),
    dragging = useRef<'cells' | 'rows' | null>(null);
  const bounds = {
    minRow: Math.min(range.r1, range.r2),
    maxRow: Math.max(range.r1, range.r2),
    minCol: Math.min(range.c1, range.c2) as GridColumn,
    maxCol: Math.max(range.c1, range.c2) as GridColumn,
  };
  const focusGrid = () => requestAnimationFrame(() => gridRef.current?.focus());
  function select(next: GridRange) {
    rangeRef.current = next;
    setRange(next);
  }
  function editRows(next: DraftGroupEntry[], remember = true) {
    if (JSON.stringify(next) === JSON.stringify(rowsRef.current)) return;
    const previous = rowsRef.current.map((row) => ({ ...row }));
    if (remember) setUndo((prev) => [...prev, previous].slice(-10));
    rowsRef.current = next;
    onChange(next);
  }
  function finishEdit(advance = false) {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    setEditing(null);
    let next = rowsRef.current.map((row, r) =>
      r === current.r
        ? {
            ...row,
            [current.c === 0 ? 'groupId' : 'groupName']:
              current.c === 0 ? extractGroupId(current.value) : current.value,
          }
        : row,
    );
    if (advance && current.r === next.length - 1) next = [...next, makeDraftRow()];
    editRows(next);
    if (advance) select({ r1: current.r + 1, c1: current.c, r2: current.r + 1, c2: current.c });
  }
  function startEdit(r: number, c: GridColumn, value?: string) {
    if (disabled) return;
    finishEdit();
    const row = rowsRef.current[r];
    if (!row) return;
    select({ r1: r, c1: c, r2: r, c2: c });
    const next = { r, c, value: value ?? (c === 0 ? row.groupId : row.groupName) };
    editingRef.current = next;
    setEditing(next);
  }
  function beginRange(r: number, c: GridColumn, shift: boolean, mode: 'cells' | 'rows') {
    if (disabled) return;
    finishEdit();
    dragging.current = mode;
    const old = rangeRef.current;
    select({
      r1: shift ? old.r1 : r,
      c1: mode === 'rows' ? 0 : shift ? old.c1 : c,
      r2: r,
      c2: mode === 'rows' ? 1 : c,
    });
    focusGrid();
  }
  function extendRange(r: number, c: GridColumn) {
    if (!dragging.current) return;
    select({ ...rangeRef.current, r2: r, c2: dragging.current === 'rows' ? 1 : c });
  }
  useEffect(() => {
    const end = () => {
      dragging.current = null;
    };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);
  function clearSelection() {
    finishEdit();
    editRows(
      clearGroupGridRange(
        rowsRef.current,
        bounds.minRow,
        bounds.maxRow,
        bounds.minCol,
        bounds.maxCol,
      ),
    );
    focusGrid();
  }
  function deleteRows(minRow = bounds.minRow, maxRow = bounds.maxRow) {
    finishEdit();
    const next = deleteGroupGridRows(rowsRef.current, minRow, maxRow, makeDraftRow);
    editRows(next);
    const r = Math.min(minRow, next.length - 1);
    select({ r1: r, c1: 0, r2: r, c2: 1 });
    focusGrid();
  }
  function undoEdit() {
    const previous = undo.at(-1);
    if (!previous) return;
    editingRef.current = null;
    setEditing(null);
    editRows(previous, false);
    setUndo(undo.slice(0, -1));
    const r = Math.min(rangeRef.current.r1, previous.length - 1);
    select({ r1: r, c1: rangeRef.current.c1, r2: r, c2: rangeRef.current.c1 });
    focusGrid();
  }
  function pasteGrid(text: string) {
    editingRef.current = null;
    setEditing(null);
    editRows(
      applyGroupGridPaste(
        rowsRef.current,
        bounds.minRow,
        bounds.minCol,
        text,
        makeDraftRow,
        bounds.maxRow,
        bounds.maxCol,
      ),
    );
    focusGrid();
  }
  function gridKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled || editingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoEdit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copyTextToClipboard(
        formatGroupGridRangeForClipboard(
          rowsRef.current,
          bounds.minRow,
          bounds.maxRow,
          bounds.minCol,
          bounds.maxCol,
        ),
      ).catch((error) => onError(error instanceof Error ? error.message : '复制失败'));
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      startEdit(range.r1, range.c1);
      return;
    }
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      const old = rangeRef.current,
        r = Math.max(
          0,
          Math.min(rowsRef.current.length - 1, (event.shiftKey ? old.r2 : old.r1) + delta[0]),
        ),
        c = Math.max(0, Math.min(1, (event.shiftKey ? old.c2 : old.c1) + delta[1])) as GridColumn;
      select(event.shiftKey ? { ...old, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c });
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      startEdit(range.r1, range.c1, event.key);
    }
  }
  return (
    <>
      <div className="group-inviter-selection-toolbar">
        <div>
          <span>
            当前选区：{bounds.minCol === 0 ? 'A' : 'B'}
            {bounds.minRow + 1}:{bounds.maxCol === 0 ? 'A' : 'B'}
            {bounds.maxRow + 1}（{bounds.maxRow - bounds.minRow + 1}行×
            {bounds.maxCol - bounds.minCol + 1}列）
          </span>
          <span>
            已填有效小组 {rows.filter((row) => row.groupId.trim() && row.groupName.trim()).length}{' '}
            个
          </span>
        </div>
        <div>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={clearSelection}>
            清空选区 (Del)
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => deleteRows()}
          >
            删除所涉整行
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || !undo.length}
            onClick={undoEdit}
          >
            撤销 (Ctrl+Z)
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => {
              finishEdit();
              editRows([...rowsRef.current, makeDraftRow()]);
            }}
          >
            ＋ 新增一行
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => {
              editingRef.current = null;
              setEditing(null);
              editRows(Array.from({ length: 5 }, () => makeDraftRow()));
              select({ r1: 0, c1: 0, r2: 0, c2: 0 });
            }}
          >
            清空表格
          </button>
        </div>
      </div>
      <div
        ref={gridRef}
        className="group-inviter-grid-scroll"
        tabIndex={0}
        aria-label="小组表格选区"
        onKeyDown={gridKey}
        onPaste={(event) => {
          if (disabled || editingRef.current) return;
          event.preventDefault();
          pasteGrid(event.clipboardData.getData('text/plain'));
        }}
        onCopy={(event) => {
          if (editingRef.current) return;
          event.preventDefault();
          event.clipboardData.setData(
            'text/plain',
            formatGroupGridRangeForClipboard(
              rowsRef.current,
              bounds.minRow,
              bounds.maxRow,
              bounds.minCol,
              bounds.maxCol,
            ),
          );
        }}
      >
        <table className="group-inviter-matrix" role="table" aria-label="添加小组两列表格">
          <colgroup>
            <col style={{ width: 40 }} />
            <col style={{ width: '38%' }} />
            <col style={{ width: 'calc(62% - 76px)' }} />
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  aria-label="选择全部单元格"
                  onClick={() => {
                    finishEdit();
                    select({ r1: 0, c1: 0, r2: rows.length - 1, c2: 1 });
                    focusGrid();
                  }}
                >
                  #
                </button>
              </th>
              {([0, 1] as const).map((c) => (
                <th key={c}>
                  <button
                    type="button"
                    onClick={() => {
                      finishEdit();
                      select({ r1: 0, c1: c, r2: rows.length - 1, c2: c });
                      focusGrid();
                    }}
                  >
                    {c === 0 ? 'A · 小组 ID' : 'B · 小组名字'}
                  </button>
                </th>
              ))}
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.key}>
                <th
                  className="group-row-number"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    beginRange(r, 0, event.shiftKey, 'rows');
                  }}
                  onPointerEnter={() => extendRange(r, 1)}
                >
                  {r + 1}
                </th>
                {([0, 1] as const).map((c) => {
                  const isEditing = editing?.r === r && editing.c === c,
                    inRange =
                      r >= bounds.minRow &&
                      r <= bounds.maxRow &&
                      c >= bounds.minCol &&
                      c <= bounds.maxCol;
                  return (
                    <td
                      key={c}
                      role="gridcell"
                      data-group-row={r}
                      data-group-col={c}
                      aria-selected={inRange}
                      className={
                        (inRange ? 'in-range ' : '') +
                        (range.r1 === r && range.c1 === c ? 'active-anchor' : '')
                      }
                      onPointerDown={(event) => {
                        if (event.button !== 0 || isEditing) return;
                        event.preventDefault();
                        beginRange(r, c, event.shiftKey, 'cells');
                      }}
                      onPointerEnter={() => extendRange(r, c)}
                      onDoubleClick={() => startEdit(r, c)}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          disabled={disabled}
                          aria-label={`第 ${r + 1} 行小组${c === 0 ? ' ID' : '名字'}`}
                          value={editing.value}
                          onChange={(event) => {
                            const next = { r, c, value: event.target.value };
                            editingRef.current = next;
                            setEditing(next);
                          }}
                          onBlur={() => finishEdit()}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData('text/plain');
                            if (!isGroupGridPaste(text, c)) return;
                            event.preventDefault();
                            event.stopPropagation();
                            pasteGrid(text);
                          }}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              finishEdit(true);
                              focusGrid();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              editingRef.current = null;
                              setEditing(null);
                              focusGrid();
                            }
                          }}
                        />
                      ) : (
                        <div className="group-cell-value">
                          {(c === 0 ? row.groupId : row.groupName) || ' '}
                        </div>
                      )}
                    </td>
                  );
                })}
                <td>
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost"
                    aria-label={`删除第 ${r + 1} 行`}
                    disabled={disabled}
                    onClick={() => deleteRows(r, r)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

import {
  applyGroupGridPaste,
  extractGroupId,
  isGroupGridPaste,
  clearGroupGridRange,
  deleteGroupGridRows,
  formatGroupGridRangeForClipboard,
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
