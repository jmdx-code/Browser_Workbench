import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../../shared/bluestacks.js';
import type { Group, Profile } from '../../../shared/contracts.js';
import type { GoogleSheetLink } from '../../../shared/google-sheets.js';
import { UI_CHECKBOX, UI_TEXTAREA } from '../../ui/primitives.js';
import {
  BackdropModal,
  Chk,
  CtrlNum,
  DropdownPopover,
  Fld,
  ModalFoot,
  ModalHeading,
  NoticeBanner,
  useBusyTask,
} from '../shared/module-ui.js';

const optCls =
  'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-slate-50';
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));
const toggleId = (list: readonly string[], id: string) =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

function useLinkedDraft<T extends object>(syncKey: string, init: T) {
  const [sel, setSel] = useState(init);
  const latestRef = useRef(init);
  useEffect(() => {
    latestRef.current = init;
    setSel(init);
  }, [syncKey]);
  const update = (patch: Partial<T>): T => {
    const next = { ...latestRef.current, ...patch };
    latestRef.current = next;
    setSel(next);
    return next;
  };
  return { sel, latestRef, update };
}

function GsCompactModal(p: {
  label: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <BackdropModal label={p.label} modalClass="contents" busy={p.busy} onClose={p.onClose}>
      <div className="modal flex max-h-[calc(100vh-40px)] w-[min(460px,92vw)] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white text-[var(--text)] shadow-2xl">
        <ModalHeading title={p.label} disabled={p.busy} onClose={p.onClose} />
        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          {p.error && <NoticeBanner tone="err">{p.error}</NoticeBanner>}
          {p.children}
        </div>
        <ModalFoot
          busy={p.busy}
          okText={p.busy ? '保存中…' : '保存'}
          onCancel={p.onClose}
          onOk={p.onSubmit}
        />
      </div>
    </BackdropModal>
  );
}

const CountCheckbox = (p: {
  checked: boolean;
  onChange: () => void;
  label: string;
  count: number;
}) => (
  <label className={optCls}>
    <input type="checkbox" className={UI_CHECKBOX} checked={p.checked} onChange={p.onChange} />
    <span className="min-w-0 flex-1 truncate">{p.label}</span>
    <em className="text-[11px] text-[var(--muted)] not-italic">{p.count}</em>
  </label>
);

export function RecordsBumpConfigModal(p: {
  link: GoogleSheetLink;
  onClose: () => void;
  onSave: (patch: {
    likeProbability: number;
    commentProbability: number;
    commentPool: string[];
  }) => Promise<void>;
}) {
  const [likeProb, setLikeProb] = useState(
      p.link.recordsConfig?.bumperSettings.likeProbability ?? 100,
    ),
    [commentProb, setCommentProb] = useState(
      p.link.recordsConfig?.bumperSettings.commentProbability ?? 30,
    ),
    [commentsText, setCommentsText] = useState(
      (p.link.recordsConfig?.commentPool ?? []).join('\n'),
    );
  const { busy, error, run } = useBusyTask();
  return (
    <GsCompactModal
      label="顶贴配置"
      busy={busy}
      error={error}
      onClose={p.onClose}
      onSubmit={() =>
        void run(
          () =>
            p.onSave({
              likeProbability: clamp(likeProb, 0, 100),
              commentProbability: clamp(commentProb, 0, 100),
              commentPool: commentsText
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean),
            }),
          '保存失败',
          p.onClose,
        )
      }
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <CtrlNum
          label="点赞概率（%）"
          aria="点赞概率"
          min={0}
          max={100}
          def={100}
          val={likeProb}
          onChange={setLikeProb}
        />
        <CtrlNum
          label="评论概率（%）"
          aria="评论概率"
          min={0}
          max={100}
          def={30}
          val={commentProb}
          onChange={setCommentProb}
        />
      </div>
      <Fld label="评论词库（每行一条，留空则只点赞不评论）">
        <textarea
          rows={5}
          className={`${UI_TEXTAREA} min-h-[110px]`}
          placeholder="Amen!&#10;God bless you!&#10;Thank you for sharing!"
          value={commentsText}
          onChange={(e) => setCommentsText(e.target.value)}
        />
      </Fld>
    </GsCompactModal>
  );
}

export function RecordsFrequencyModal(p: {
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
  const cfg = p.link.recordsConfig;
  const [activePollMin, setActivePollMin] = useState(cfg?.activePollMinutes ?? 2),
    [idleThreshold, setIdleThreshold] = useState(cfg?.semiActiveAfterIdlePolls ?? 5),
    [semiActivePollMin, setSemiActivePollMin] = useState(cfg?.semiActivePollMinutes ?? 10),
    [maxPerPost, setMaxPerPost] = useState(cfg?.bumperSettings.maxLikesPerPost ?? 50),
    [dailyMax, setDailyMax] = useState(cfg?.bumperSettings.dailyMaxLikesPerAccount ?? 20),
    [maxAgeHours, setMaxAgeHours] = useState(cfg?.bumperSettings.maxPostAgeHours ?? 24);
  const { busy, error, run } = useBusyTask();
  const fields = [
    ['积极监听间隔（分钟）', '积极监听间隔', 1, 30, 2, activePollMin, setActivePollMin],
    ['空闲几次后降频', '连续无更新次数后降频', 1, 30, 5, idleThreshold, setIdleThreshold],
    [
      '半积极监听间隔（分钟）',
      '半积极监听间隔',
      2,
      120,
      10,
      semiActivePollMin,
      setSemiActivePollMin,
    ],
    ['贴文顶贴时效（小时）', '贴文顶贴时效', 1, 720, 24, maxAgeHours, setMaxAgeHours],
    ['单帖本机上限', '单帖本机上限', 1, 500, 50, maxPerPost, setMaxPerPost],
    ['每号每日上限', '每号每日上限', 1, 500, 20, dailyMax, setDailyMax],
  ] as const;
  return (
    <GsCompactModal
      label="频率限制"
      busy={busy}
      error={error}
      onClose={p.onClose}
      onSubmit={() =>
        void run(
          () =>
            p.onSave({
              activePollMinutes: clamp(activePollMin, 1, 30),
              semiActiveAfterIdlePolls: clamp(idleThreshold, 1, 30),
              semiActivePollMinutes: clamp(semiActivePollMin, 2, 120),
              maxLikesPerPost: clamp(maxPerPost, 1, 500),
              dailyMaxLikesPerAccount: clamp(dailyMax, 1, 500),
              maxPostAgeHours: clamp(maxAgeHours, 1, 720),
            }),
          '保存失败',
          p.onClose,
        )
      }
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {fields.map(([label, aria, min, max, def, val, set]) => (
          <CtrlNum
            key={aria}
            label={label}
            aria={aria}
            min={min}
            max={max}
            def={def}
            val={val}
            onChange={set}
          />
        ))}
      </div>
    </GsCompactModal>
  );
}

export function RecordsAccountGroupDropdown(p: {
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
  const [showSingleBs, setShowSingleBs] = useState(false);
  const rc = p.link.recordsConfig;
  const init = {
    groups: rc?.bumperProfileGroupIds ?? [],
    bsFolders: rc?.bumperBluestacksFolderIds ?? [],
    bsIds: rc?.bumperBluestacksIds ?? [],
  };
  const { sel, latestRef, update } = useLinkedDraft(JSON.stringify([p.link.id, init]), init);
  const bsFolders = p.bluestacksState?.folders ?? [],
    bsInstances = p.bluestacksState?.instances ?? [];
  const browserCount = p.profiles.filter(
    (pr) => pr.groupId !== null && sel.groups.includes(pr.groupId),
  ).length;
  const bsCount = bsInstances.filter(
    (i) => (i.folderId !== null && sel.bsFolders.includes(i.folderId)) || sel.bsIds.includes(i.id),
  ).length;
  const totalSelected = browserCount + bsCount;
  const commit = (patch: Partial<typeof init>) => {
    const n = update(patch);
    p.onChange({
      bumperProfileGroupIds: n.groups,
      bumperBluestacksFolderIds: n.bsFolders,
      bumperBluestacksIds: n.bsIds,
    });
  };
  const label =
    totalSelected === 0
      ? '选择顶贴账号组'
      : [browserCount > 0 ? `${browserCount} 浏览器` : '', bsCount > 0 ? `${bsCount} 蓝蝶` : '']
          .filter(Boolean)
          .join(' + ');

  return (
    <DropdownPopover
      label={label}
      ariaLabel="下拉选择顶贴账号组"
      warn={totalSelected === 0}
      disabled={p.disabled}
    >
      <div className="flex flex-col gap-1">
        <div className="px-1.5 py-0.5 text-[11px] font-semibold text-[var(--muted)]">
          Chrome 浏览器分组
        </div>
        {p.profileGroups.length === 0 ? (
          <div className="px-1.5 py-1 text-xs text-[var(--muted)]">
            暂无分组（可在左侧栏新建分组）
          </div>
        ) : (
          p.profileGroups.map((g) => (
            <CountCheckbox
              key={g.id}
              checked={sel.groups.includes(g.id)}
              label={g.name}
              count={p.profiles.filter((pr) => pr.groupId === g.id).length}
              onChange={() => commit({ groups: toggleId(latestRef.current.groups, g.id) })}
            />
          ))
        )}
      </div>
      {bsInstances.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-[var(--line)] pt-1.5">
          <div className="flex items-center justify-between px-1.5 py-0.5">
            <span className="text-[11px] font-semibold text-[var(--muted)]">蓝蝶模拟器</span>
            <button
              type="button"
              className="text-[11px] text-sky-700 hover:underline"
              onClick={() => setShowSingleBs((v) => !v)}
            >
              {showSingleBs ? '收起单台' : `按单台 (${sel.bsIds.length}/${bsInstances.length})`}
            </button>
          </div>
          {bsFolders.map((f) => (
            <CountCheckbox
              key={f.id}
              checked={sel.bsFolders.includes(f.id)}
              label={`[分组] ${f.name}`}
              count={bsInstances.filter((i) => i.folderId === f.id).length}
              onChange={() => commit({ bsFolders: toggleId(latestRef.current.bsFolders, f.id) })}
            />
          ))}
          {showSingleBs && (
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto border-t border-slate-100 pt-1">
              {bsInstances.slice(0, 60).map((inst) => (
                <Chk
                  key={inst.id}
                  className={optCls}
                  checked={sel.bsIds.includes(inst.id)}
                  onChange={() => commit({ bsIds: toggleId(latestRef.current.bsIds, inst.id) })}
                  label={`${bluestacksDisplayTitle(inst)}${inst.accountName ? ` · ${inst.accountName}` : ''}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </DropdownPopover>
  );
}

export function ScheduleBluestacksDropdown(p: {
  link: GoogleSheetLink;
  bluestacksState?: BluestacksState | null;
  disabled?: boolean;
  onChange: (patch: {
    bluestacksFolderIds: string[];
    bluestacksInstanceIds: string[];
    closeBluestacksOnFinish: boolean;
  }) => void;
}) {
  const bsFolders = p.bluestacksState?.folders ?? [],
    bsInstances = p.bluestacksState?.instances ?? [],
    sc = p.link.scheduleConfig;
  const init = {
    folders: sc?.bluestacksFolderIds ?? [],
    ids: sc?.bluestacksInstanceIds ?? [],
    closeOnFinish: sc?.closeBluestacksOnFinish ?? true,
  };
  const { sel, latestRef, update } = useLinkedDraft(JSON.stringify([p.link.id, init]), init);
  const matched = bsInstances.filter(
    (i) => (i.folderId !== null && sel.folders.includes(i.folderId)) || sel.ids.includes(i.id),
  ).length;
  const commit = (patch: Partial<typeof init>) => {
    const n = update(patch);
    p.onChange({
      bluestacksFolderIds: n.folders,
      bluestacksInstanceIds: n.ids,
      closeBluestacksOnFinish: n.closeOnFinish,
    });
  };
  return (
    <DropdownPopover
      label={matched > 0 ? `蓝蝶范围 (${matched})` : '蓝蝶范围：全部'}
      disabled={p.disabled}
    >
      <Chk
        className={optCls}
        label="发帖完成后自动关窗"
        checked={sel.closeOnFinish}
        onChange={(c) => commit({ closeOnFinish: c })}
      />
      {bsFolders.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-[var(--line)] pt-1.5">
          <div className="px-1.5 py-0.5 text-[11px] font-semibold text-[var(--muted)]">
            限定蓝蝶分组（不选则自动匹配全部）
          </div>
          {bsFolders.map((f) => (
            <Chk
              key={f.id}
              className={optCls}
              label={f.name}
              checked={sel.folders.includes(f.id)}
              onChange={() => commit({ folders: toggleId(latestRef.current.folders, f.id) })}
            />
          ))}
        </div>
      )}
    </DropdownPopover>
  );
}
