import { useEffect, useRef, useState } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../../shared/bluestacks.js';
import type { Group, Profile } from '../../../shared/contracts.js';
import type { GoogleSheetLink } from '../../../shared/google-sheets.js';
import { ControlledNumberInput } from '../shared/controlled-number-input.js';

/**
 * 发帖记录「顶贴配置」弹窗：严格只放顶贴相关的 3 个框（点赞概率、评论概率、评论词库），绝不堆叠无关设置。
 */
export function RecordsBumpConfigModal({
  link,
  onClose,
  onSave,
}: {
  link: GoogleSheetLink;
  onClose: () => void;
  onSave: (patch: {
    likeProbability: number;
    commentProbability: number;
    commentPool: string[];
  }) => Promise<void>;
}) {
  const [likeProb, setLikeProb] = useState(
    link.recordsConfig?.bumperSettings.likeProbability ?? 100,
  );
  const [commentProb, setCommentProb] = useState(
    link.recordsConfig?.bumperSettings.commentProbability ?? 30,
  );
  const [commentsText, setCommentsText] = useState(
    (link.recordsConfig?.commentPool ?? []).join('\n'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function handleSubmit() {
    setBusy(true);
    setError('');
    try {
      await onSave({
        likeProbability: Math.max(0, Math.min(100, Math.round(likeProb))),
        commentProbability: Math.max(0, Math.min(100, Math.round(commentProb))),
        commentPool: commentsText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="gs-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="gs-modal gs-modal-compact" role="dialog" aria-label="顶贴配置">
        <header className="gs-modal-head">
          <h3>顶贴配置</h3>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="gs-modal-body">
          {error && <div className="gs-banner is-err">{error}</div>}
          <div className="gs-form-grid">
            <label className="gs-field">
              <span>点赞概率（%）</span>
              <ControlledNumberInput
                ariaLabel="点赞概率"
                min={0}
                max={100}
                defaultValue={100}
                value={likeProb}
                onChange={setLikeProb}
              />
            </label>
            <label className="gs-field">
              <span>评论概率（%）</span>
              <ControlledNumberInput
                ariaLabel="评论概率"
                min={0}
                max={100}
                defaultValue={30}
                value={commentProb}
                onChange={setCommentProb}
              />
            </label>
          </div>
          <label className="gs-field">
            <span>评论词库（每行一条，留空则只点赞不评论）</span>
            <textarea
              rows={5}
              placeholder="Amen!&#10;God bless you!&#10;Thank you for sharing!"
              value={commentsText}
              onChange={(e) => setCommentsText(e.target.value)}
            />
          </label>
        </div>

        <footer className="gs-modal-foot">
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * 发帖记录「频率限制」独立配置页：严格只放监听节奏与数量上限，绝不重复顶栏或顶贴配置项。
 */
export function RecordsFrequencyModal({
  link,
  onClose,
  onSave,
}: {
  link: GoogleSheetLink;
  onClose: () => void;
  onSave: (patch: {
    activePollMinutes: number;
    semiActiveAfterIdlePolls: number;
    semiActivePollMinutes: number;
    maxLikesPerPost: number;
    dailyMaxLikesPerAccount: number;
    maxPostAgeHours: number;
  }) => Promise<void>;
}) {
  const [activePollMin, setActivePollMin] = useState(link.recordsConfig?.activePollMinutes ?? 2);
  const [idleThreshold, setIdleThreshold] = useState(
    link.recordsConfig?.semiActiveAfterIdlePolls ?? 5,
  );
  const [semiActivePollMin, setSemiActivePollMin] = useState(
    link.recordsConfig?.semiActivePollMinutes ?? 10,
  );
  const [maxPerPost, setMaxPerPost] = useState(
    link.recordsConfig?.bumperSettings.maxLikesPerPost ?? 50,
  );
  const [dailyMax, setDailyMax] = useState(
    link.recordsConfig?.bumperSettings.dailyMaxLikesPerAccount ?? 20,
  );
  const [maxAgeHours, setMaxAgeHours] = useState(
    link.recordsConfig?.bumperSettings.maxPostAgeHours ?? 24,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function handleSubmit() {
    setBusy(true);
    setError('');
    try {
      await onSave({
        activePollMinutes: Math.max(1, Math.min(30, Math.round(activePollMin))),
        semiActiveAfterIdlePolls: Math.max(1, Math.min(30, Math.round(idleThreshold))),
        semiActivePollMinutes: Math.max(2, Math.min(120, Math.round(semiActivePollMin))),
        maxLikesPerPost: Math.max(1, Math.min(500, Math.round(maxPerPost))),
        dailyMaxLikesPerAccount: Math.max(1, Math.min(500, Math.round(dailyMax))),
        maxPostAgeHours: Math.max(1, Math.min(720, Math.round(maxAgeHours))),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="gs-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="gs-modal gs-modal-compact" role="dialog" aria-label="频率限制">
        <header className="gs-modal-head">
          <h3>频率限制</h3>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="gs-modal-body">
          {error && <div className="gs-banner is-err">{error}</div>}
          <div className="gs-form-grid">
            <label className="gs-field">
              <span>积极监听间隔（分钟）</span>
              <ControlledNumberInput
                ariaLabel="积极监听间隔"
                min={1}
                max={30}
                defaultValue={2}
                value={activePollMin}
                onChange={setActivePollMin}
              />
            </label>
            <label className="gs-field">
              <span>空闲几次后降频</span>
              <ControlledNumberInput
                ariaLabel="连续无更新次数后降频"
                min={1}
                max={30}
                defaultValue={5}
                value={idleThreshold}
                onChange={setIdleThreshold}
              />
            </label>
            <label className="gs-field">
              <span>半积极监听间隔（分钟）</span>
              <ControlledNumberInput
                ariaLabel="半积极监听间隔"
                min={2}
                max={120}
                defaultValue={10}
                value={semiActivePollMin}
                onChange={setSemiActivePollMin}
              />
            </label>
            <label className="gs-field">
              <span>贴文顶贴时效（小时）</span>
              <ControlledNumberInput
                ariaLabel="贴文顶贴时效"
                min={1}
                max={720}
                defaultValue={24}
                value={maxAgeHours}
                onChange={setMaxAgeHours}
              />
            </label>
            <label className="gs-field">
              <span>单帖本机上限</span>
              <ControlledNumberInput
                ariaLabel="单帖本机上限"
                min={1}
                max={500}
                defaultValue={50}
                value={maxPerPost}
                onChange={setMaxPerPost}
              />
            </label>
            <label className="gs-field">
              <span>每号每日上限</span>
              <ControlledNumberInput
                ariaLabel="每号每日上限"
                min={1}
                max={500}
                defaultValue={20}
                value={dailyMax}
                onChange={setDailyMax}
              />
            </label>
          </div>
        </div>

        <footer className="gs-modal-foot">
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * 发帖记录顶栏「下拉选择顶贴账号组」控件：点击展开勾选 Chrome 分组 / 蓝蝶分组，勾选即刻自动保存。
 */
export function RecordsAccountGroupDropdown({
  link,
  profileGroups,
  profiles,
  bluestacksState,
  disabled,
  onChange,
}: {
  link: GoogleSheetLink;
  profileGroups: readonly Group[];
  profiles: readonly Profile[];
  bluestacksState?: BluestacksState | null;
  disabled?: boolean;
  onChange: (patch: {
    bumperProfileGroupIds: string[];
    bumperBluestacksFolderIds: string[];
    bumperBluestacksIds: string[];
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showSingleBs, setShowSingleBs] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const propGroups = link.recordsConfig?.bumperProfileGroupIds ?? [];
  const propBsFolders = link.recordsConfig?.bumperBluestacksFolderIds ?? [];
  const propBsIds = link.recordsConfig?.bumperBluestacksIds ?? [];
  const [selectedGroups, setSelectedGroups] = useState<string[]>(propGroups);
  const [selectedBsFolders, setSelectedBsFolders] = useState<string[]>(propBsFolders);
  const [selectedBsIds, setSelectedBsIds] = useState<string[]>(propBsIds);
  const latestRef = useRef({
    groups: propGroups,
    bsFolders: propBsFolders,
    bsIds: propBsIds,
  });

  const propSyncKey = JSON.stringify([link.id, propGroups, propBsFolders, propBsIds]);
  useEffect(() => {
    latestRef.current = { groups: propGroups, bsFolders: propBsFolders, bsIds: propBsIds };
    setSelectedGroups(propGroups);
    setSelectedBsFolders(propBsFolders);
    setSelectedBsIds(propBsIds);
  }, [propSyncKey]);

  const bsFolders = bluestacksState?.folders ?? [];
  const bsInstances = bluestacksState?.instances ?? [];
  const browserCount = profiles.filter(
    (p) => p.groupId !== null && selectedGroups.includes(p.groupId),
  ).length;
  const bsCount = bsInstances.filter(
    (inst) =>
      (inst.folderId !== null && selectedBsFolders.includes(inst.folderId)) ||
      selectedBsIds.includes(inst.id),
  ).length;
  const totalSelected = browserCount + bsCount;

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggleGroup(id: string) {
    const cur = latestRef.current;
    const next = cur.groups.includes(id) ? cur.groups.filter((x) => x !== id) : [...cur.groups, id];
    latestRef.current = { ...cur, groups: next };
    setSelectedGroups(next);
    onChange({
      bumperProfileGroupIds: next,
      bumperBluestacksFolderIds: cur.bsFolders,
      bumperBluestacksIds: cur.bsIds,
    });
  }

  function toggleBsFolder(id: string) {
    const cur = latestRef.current;
    const next = cur.bsFolders.includes(id)
      ? cur.bsFolders.filter((x) => x !== id)
      : [...cur.bsFolders, id];
    latestRef.current = { ...cur, bsFolders: next };
    setSelectedBsFolders(next);
    onChange({
      bumperProfileGroupIds: cur.groups,
      bumperBluestacksFolderIds: next,
      bumperBluestacksIds: cur.bsIds,
    });
  }

  function toggleBsInst(id: string) {
    const cur = latestRef.current;
    const next = cur.bsIds.includes(id) ? cur.bsIds.filter((x) => x !== id) : [...cur.bsIds, id];
    latestRef.current = { ...cur, bsIds: next };
    setSelectedBsIds(next);
    onChange({
      bumperProfileGroupIds: cur.groups,
      bumperBluestacksFolderIds: cur.bsFolders,
      bumperBluestacksIds: next,
    });
  }

  const label =
    totalSelected === 0
      ? '选择顶贴账号组'
      : [browserCount > 0 ? `${browserCount} 浏览器` : '', bsCount > 0 ? `${bsCount} 蓝蝶` : '']
          .filter(Boolean)
          .join(' + ');

  return (
    <div className="gs-dropdown-wrap" ref={wrapRef}>
      <button
        type="button"
        className={'btn btn-sm gs-dropdown-trigger' + (totalSelected === 0 ? ' is-warn' : '')}
        disabled={disabled}
        aria-expanded={open}
        aria-label="下拉选择顶贴账号组"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <span className="gs-caret">▾</span>
      </button>

      {open && (
        <div className="gs-dropdown-menu" role="menu">
          <div className="gs-dropdown-section">
            <div className="gs-dropdown-title">Chrome 浏览器分组</div>
            {profileGroups.length === 0 ? (
              <div className="gs-dropdown-empty">暂无分组（可在左侧栏新建分组）</div>
            ) : (
              profileGroups.map((g) => {
                const count = profiles.filter((p) => p.groupId === g.id).length;
                return (
                  <label key={g.id} className="gs-dropdown-option">
                    <input
                      type="checkbox"
                      checked={selectedGroups.includes(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    />
                    <span>{g.name}</span>
                    <em className="gs-dropdown-count">{count}</em>
                  </label>
                );
              })
            )}
          </div>

          {bsInstances.length > 0 && (
            <div className="gs-dropdown-section">
              <div className="gs-dropdown-title-row">
                <span className="gs-dropdown-title">蓝蝶模拟器</span>
                <button
                  type="button"
                  className="gs-dropdown-link"
                  onClick={() => setShowSingleBs((v) => !v)}
                >
                  {showSingleBs
                    ? '收起单台'
                    : `按单台 (${selectedBsIds.length}/${bsInstances.length})`}
                </button>
              </div>
              {bsFolders.map((f) => {
                const count = bsInstances.filter((i) => i.folderId === f.id).length;
                return (
                  <label key={f.id} className="gs-dropdown-option">
                    <input
                      type="checkbox"
                      checked={selectedBsFolders.includes(f.id)}
                      onChange={() => toggleBsFolder(f.id)}
                    />
                    <span>[分组] {f.name}</span>
                    <em className="gs-dropdown-count">{count}</em>
                  </label>
                );
              })}
              {showSingleBs && (
                <div className="gs-dropdown-subscroll">
                  {bsInstances.slice(0, 60).map((inst) => (
                    <label key={inst.id} className="gs-dropdown-option">
                      <input
                        type="checkbox"
                        checked={selectedBsIds.includes(inst.id)}
                        onChange={() => toggleBsInst(inst.id)}
                      />
                      <span>
                        {bluestacksDisplayTitle(inst)}
                        {inst.accountName ? ` · ${inst.accountName}` : ''}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 排贴表在选中蓝蝶/双引擎时才显示的轻量化蓝蝶范围下拉（仅浏览器模式不占任何位置）。
 */
export function ScheduleBluestacksDropdown({
  link,
  bluestacksState,
  disabled,
  onChange,
}: {
  link: GoogleSheetLink;
  bluestacksState?: BluestacksState | null;
  disabled?: boolean;
  onChange: (patch: {
    bluestacksFolderIds: string[];
    bluestacksInstanceIds: string[];
    closeBluestacksOnFinish: boolean;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bsFolders = bluestacksState?.folders ?? [];
  const bsInstances = bluestacksState?.instances ?? [];
  const propFolders = link.scheduleConfig?.bluestacksFolderIds ?? [];
  const propIds = link.scheduleConfig?.bluestacksInstanceIds ?? [];
  const propClose = link.scheduleConfig?.closeBluestacksOnFinish ?? true;
  const [selectedFolders, setSelectedFolders] = useState<string[]>(propFolders);
  const [selectedIds, setSelectedIds] = useState<string[]>(propIds);
  const [closeOnFinish, setCloseOnFinish] = useState<boolean>(propClose);
  const latestRef = useRef({
    folders: propFolders,
    ids: propIds,
    closeOnFinish: propClose,
  });
  const propSyncKey = JSON.stringify([link.id, propFolders, propIds, propClose]);
  useEffect(() => {
    latestRef.current = { folders: propFolders, ids: propIds, closeOnFinish: propClose };
    setSelectedFolders(propFolders);
    setSelectedIds(propIds);
    setCloseOnFinish(propClose);
  }, [propSyncKey]);

  const matched = bsInstances.filter(
    (i) =>
      (i.folderId !== null && selectedFolders.includes(i.folderId)) || selectedIds.includes(i.id),
  ).length;

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="gs-dropdown-wrap" ref={wrapRef}>
      <button
        type="button"
        className="btn btn-sm gs-dropdown-trigger"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{matched > 0 ? `蓝蝶范围 (${matched})` : '蓝蝶范围：全部'}</span>
        <span className="gs-caret">▾</span>
      </button>
      {open && (
        <div className="gs-dropdown-menu" role="menu">
          <div className="gs-dropdown-section">
            <label className="gs-dropdown-option">
              <input
                type="checkbox"
                checked={closeOnFinish}
                onChange={(e) => {
                  const nextClose = e.target.checked;
                  const cur = latestRef.current;
                  latestRef.current = { ...cur, closeOnFinish: nextClose };
                  setCloseOnFinish(nextClose);
                  onChange({
                    bluestacksFolderIds: cur.folders,
                    bluestacksInstanceIds: cur.ids,
                    closeBluestacksOnFinish: nextClose,
                  });
                }}
              />
              <span>发帖完成后自动关窗</span>
            </label>
          </div>
          {bsFolders.length > 0 && (
            <div className="gs-dropdown-section">
              <div className="gs-dropdown-title">限定蓝蝶分组（不选则自动匹配全部）</div>
              {bsFolders.map((f) => (
                <label key={f.id} className="gs-dropdown-option">
                  <input
                    type="checkbox"
                    checked={selectedFolders.includes(f.id)}
                    onChange={() => {
                      const cur = latestRef.current;
                      const next = cur.folders.includes(f.id)
                        ? cur.folders.filter((x) => x !== f.id)
                        : [...cur.folders, f.id];
                      latestRef.current = { ...cur, folders: next };
                      setSelectedFolders(next);
                      onChange({
                        bluestacksFolderIds: next,
                        bluestacksInstanceIds: cur.ids,
                        closeBluestacksOnFinish: cur.closeOnFinish,
                      });
                    }}
                  />
                  <span>{f.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
