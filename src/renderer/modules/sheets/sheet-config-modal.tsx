import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../../shared/bluestacks.js';
import { profileDisplayName, type Group, type Profile } from '../../../shared/contracts.js';
import {
  includesUngroupedBucket,
  resolveEffectiveInstanceIds,
  UNGROUPED_BUCKET_ID,
  type GoogleSheetLink,
} from '../../../shared/google-sheets.js';
import type { BumperReactionType } from '../../../shared/group-bumper.js';
import { UI_CHECKBOX, UI_TEXTAREA, UiSwitch } from '../../ui/primitives.js';
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
import { REACTION_OPTIONS } from '../shared/step-settings-fields.js';
const optCls =
  'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-slate-50';
const DEFAULT_REACTIONS: BumperReactionType[] = ['care', 'love', 'like'];
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
function ScopeHeader(p: {
  heading: string;
  total: number;
  selectedCount: number;
  showItems: boolean;
  singleLabel: string;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-1.5 py-0.5">
      <span className="text-[11px] font-semibold text-[var(--muted)]">{p.heading}</span>
      {p.total > 0 && (
        <button
          type="button"
          className="text-[11px] text-sky-700 hover:underline"
          onClick={p.onToggle}
        >
          {p.showItems
            ? `收起${p.singleLabel}`
            : `按${p.singleLabel} (${p.selectedCount}/${p.total})`}
        </button>
      )}
    </div>
  );
}
function BsScopePicker(p: {
  heading: string;
  folders: BluestacksState['folders'];
  instances: BluestacksState['instances'];
  selectedFolderIds: readonly string[];
  selectedInstanceIds: readonly string[];
  showInstances: boolean;
  onToggleShowInstances: () => void;
  onToggleFolder: (id: string) => void;
  onToggleInstance: (id: string) => void;
}) {
  const showSingle = !p.folders.length || p.showInstances || p.selectedInstanceIds.length > 0;
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-[var(--line)] pt-1.5">
      <ScopeHeader
        heading={p.heading}
        total={p.folders.length ? p.instances.length : 0}
        selectedCount={p.selectedInstanceIds.length}
        showItems={p.showInstances}
        singleLabel="单台"
        onToggle={p.onToggleShowInstances}
      />
      {p.folders.map((f) => (
        <CountCheckbox
          key={f.id}
          checked={p.selectedFolderIds.includes(f.id)}
          label={`[分组] ${f.name}`}
          count={p.instances.filter((i) => i.folderId === f.id).length}
          onChange={() => p.onToggleFolder(f.id)}
        />
      ))}
      {showSingle && (
        <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto border-t border-slate-100 pt-1">
          {p.instances.map((inst) => (
            <Chk
              key={inst.id}
              className={optCls}
              checked={p.selectedInstanceIds.includes(inst.id)}
              onChange={() => p.onToggleInstance(inst.id)}
              label={`${bluestacksDisplayTitle(inst)}${inst.accountName ? ` · ${inst.accountName}` : ''}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
export function RecordsBumpConfigModal(p: {
  link: GoogleSheetLink;
  onClose: () => void;
  onSave: (patch: {
    likeProbability: number;
    commentProbability: number;
    commentPool: string[];
    consumeCommentOnUse: boolean;
    enableSound: boolean;
    useLongPressReaction: boolean;
    reactionTypes: BumperReactionType[];
  }) => Promise<void>;
}) {
  const bs = p.link.recordsConfig?.bumperSettings;
  const [s, setS] = useState(() => ({
    likeProbability: bs?.likeProbability ?? 100,
    commentProbability: bs?.commentProbability ?? 30,
    commentsText: (p.link.recordsConfig?.commentPool ?? []).join('\n'),
    consumeCommentOnUse: Boolean(bs?.consumeCommentOnUse),
    enableSound: Boolean(bs?.enableSound),
    useLongPressReaction: Boolean(bs?.useLongPressReaction),
    reactionTypes: bs?.reactionTypes?.length ? [...bs.reactionTypes] : [...DEFAULT_REACTIONS],
  }));
  const { busy, error, run } = useBusyTask();
  const patch = (next: Partial<typeof s>) => setS((prev) => ({ ...prev, ...next }));
  const onSubmit = () =>
    void run(
      () =>
        p.onSave({
          likeProbability: clamp(s.likeProbability, 0, 100),
          commentProbability: clamp(s.commentProbability, 0, 100),
          commentPool: s.commentsText
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter(Boolean),
          consumeCommentOnUse: s.consumeCommentOnUse,
          enableSound: s.enableSound,
          useLongPressReaction: s.useLongPressReaction,
          reactionTypes: s.reactionTypes.length ? s.reactionTypes : [...DEFAULT_REACTIONS],
        }),
      '保存失败',
      p.onClose,
    );
  return (
    <GsCompactModal
      label="顶贴配置"
      busy={busy}
      error={error}
      onClose={p.onClose}
      onSubmit={onSubmit}
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <CtrlNum
          label="点赞概率（%）"
          aria="点赞概率"
          min={0}
          max={100}
          def={100}
          val={s.likeProbability}
          onChange={(likeProbability) => patch({ likeProbability })}
        />
        <CtrlNum
          label="评论概率（%）"
          aria="评论概率"
          min={0}
          max={100}
          def={30}
          val={s.commentProbability}
          onChange={(commentProbability) => patch({ commentProbability })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <UiSwitch
          checked={s.consumeCommentOnUse}
          onCheckedChange={(consumeCommentOnUse) => patch({ consumeCommentOnUse })}
          label="留言后移除"
          ariaLabel="留言后移除"
        />
        <UiSwitch
          checked={s.enableSound}
          onCheckedChange={(enableSound) => patch({ enableSound })}
          label="开启声音"
          ariaLabel="开启声音"
        />
        <UiSwitch
          checked={s.useLongPressReaction}
          onCheckedChange={(useLongPressReaction) => patch({ useLongPressReaction })}
          label="长按选表情"
          ariaLabel="长按选表情"
        />
      </div>
      {s.useLongPressReaction && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="表情类型选择">
          {REACTION_OPTIONS.map((opt) => {
            const checked = s.reactionTypes.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={checked}
                className={
                  'h-6 cursor-pointer rounded-full border px-2 text-[11px] font-semibold transition-colors ' +
                  (checked
                    ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]'
                    : 'border-[var(--line)] bg-slate-50 text-[var(--text-2)] hover:border-slate-300')
                }
                onClick={() =>
                  patch({
                    reactionTypes: checked
                      ? s.reactionTypes.length > 1
                        ? s.reactionTypes.filter((t) => t !== opt.id)
                        : s.reactionTypes
                      : [...s.reactionTypes, opt.id],
                  })
                }
              >
                {opt.emoji} {opt.label}
              </button>
            );
          })}
        </div>
      )}
      <Fld label="评论词库（每行一条，留空则只点赞不评论）">
        <textarea
          rows={5}
          className={`${UI_TEXTAREA} min-h-[110px]`}
          placeholder="Amen!&#10;God bless you!&#10;Thank you for sharing!"
          value={s.commentsText}
          onChange={(e) => patch({ commentsText: e.target.value })}
        />
      </Fld>
    </GsCompactModal>
  );
}
export function RecordsFrequencyModal(p: {
  link: GoogleSheetLink;
  globalMaxConcurrency?: number | null;
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
  const [s, setS] = useState({
    activePollMinutes: cfg?.activePollMinutes ?? 2,
    semiActiveAfterIdlePolls: cfg?.semiActiveAfterIdlePolls ?? 5,
    semiActivePollMinutes: cfg?.semiActivePollMinutes ?? 10,
    maxLikesPerPost: cfg?.bumperSettings.maxLikesPerPost ?? 50,
    dailyMaxLikesPerAccount: cfg?.bumperSettings.dailyMaxLikesPerAccount ?? 20,
    maxPostAgeHours: cfg?.bumperSettings.maxPostAgeHours ?? 24,
  });
  const { busy, error, run } = useBusyTask();
  const inheritedConcurrency =
    p.globalMaxConcurrency ?? cfg?.bumperSettings.maxConcurrentProfiles ?? 8;
  const fields = [
    ['activePollMinutes', '积极监听间隔（分钟）', '积极监听间隔', 1, 30, 2],
    ['semiActiveAfterIdlePolls', '空闲几次后降频', '连续无更新次数后降频', 1, 30, 5],
    ['semiActivePollMinutes', '半积极监听间隔（分钟）', '半积极监听间隔', 2, 120, 10],
    ['maxPostAgeHours', '贴文顶贴时效（小时）', '贴文顶贴时效', 1, 720, 24],
    ['maxLikesPerPost', '单帖本机上限', '单帖本机上限', 1, 500, 50],
    ['dailyMaxLikesPerAccount', '每号每日上限', '每号每日上限', 1, 500, 20],
  ] as const;
  const onSubmit = () =>
    void run(
      () =>
        p.onSave({
          activePollMinutes: clamp(s.activePollMinutes, 1, 30),
          semiActiveAfterIdlePolls: clamp(s.semiActiveAfterIdlePolls, 1, 30),
          semiActivePollMinutes: clamp(s.semiActivePollMinutes, 2, 120),
          maxLikesPerPost: clamp(s.maxLikesPerPost, 1, 500),
          dailyMaxLikesPerAccount: clamp(s.dailyMaxLikesPerAccount, 1, 500),
          maxPostAgeHours: clamp(s.maxPostAgeHours, 1, 720),
        }),
      '保存失败',
      p.onClose,
    );
  return (
    <GsCompactModal
      label="频率限制"
      busy={busy}
      error={error}
      onClose={p.onClose}
      onSubmit={onSubmit}
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {fields.map(([k, label, aria, min, max, def]) => (
          <CtrlNum
            key={k}
            label={label}
            aria={aria}
            min={min}
            max={max}
            def={def}
            val={s[k]}
            onChange={(v) => setS((prev) => ({ ...prev, [k]: v }))}
          />
        ))}
      </div>
      <div
        className="flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-slate-50 px-3 py-2 text-xs"
        data-testid="gs-inherited-concurrency"
      >
        <span className="text-[var(--text-2)]">全局并发上限（自动继承）</span>
        <strong className="font-semibold text-slate-900 tabular-nums">
          {inheritedConcurrency} 并发
        </strong>
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
    bumperProfileIds?: string[];
    includeUngrouped?: boolean;
    bumperBluestacksFolderIds: string[];
    bumperBluestacksIds: string[];
    selectedInstanceIds?: string[];
  }) => void;
}) {
  const [showSingleChrome, setShowSingleChrome] = useState(false);
  const [showSingleBs, setShowSingleBs] = useState(false);
  const rc = p.link.recordsConfig;
  const init = {
    groups: rc?.bumperProfileGroupIds ?? [],
    profileIds: rc?.bumperProfileIds ?? [],
    includeUngrouped: includesUngroupedBucket(
      rc?.bumperProfileGroupIds ?? [],
      rc?.includeUngrouped,
    ),
    bsFolders: rc?.bumperBluestacksFolderIds ?? [],
    bsIds: resolveEffectiveInstanceIds(rc?.bumperBluestacksIds, rc?.selectedInstanceIds),
  };
  const { sel, latestRef, update } = useLinkedDraft(JSON.stringify([p.link.id, init]), init);
  const bsFolders = p.bluestacksState?.folders ?? [],
    bsInstances = p.bluestacksState?.instances ?? [];
  const ungroupedSelected = includesUngroupedBucket(sel.groups, sel.includeUngrouped);
  const browserCount = p.profiles.filter(
    (pr) =>
      (pr.groupId === null ? ungroupedSelected : sel.groups.includes(pr.groupId)) ||
      sel.profileIds.includes(pr.id),
  ).length;
  const bsCount = bsInstances.filter(
    (i) => (i.folderId !== null && sel.bsFolders.includes(i.folderId)) || sel.bsIds.includes(i.id),
  ).length;
  const totalSelected = browserCount + bsCount;
  const commit = (
    patch: Partial<typeof init>,
    flags?: { profileIds?: boolean; includeUngrouped?: boolean; bsIds?: boolean },
  ) => {
    const n = update(patch);
    p.onChange({
      bumperProfileGroupIds: n.groups,
      bumperBluestacksFolderIds: n.bsFolders,
      bumperBluestacksIds: n.bsIds,
      ...(flags?.profileIds || n.profileIds.length > 0 || (rc?.bumperProfileIds?.length ?? 0) > 0
        ? { bumperProfileIds: n.profileIds }
        : {}),
      ...(flags?.includeUngrouped || n.includeUngrouped || rc?.includeUngrouped !== undefined
        ? { includeUngrouped: n.includeUngrouped }
        : {}),
      ...(flags?.bsIds || n.bsIds.length > 0 || (rc?.selectedInstanceIds?.length ?? 0) > 0
        ? { selectedInstanceIds: n.bsIds }
        : {}),
    });
  };
  const label = !totalSelected
    ? '选择顶贴账号组'
    : [browserCount > 0 ? `${browserCount} 浏览器` : '', bsCount > 0 ? `${bsCount} 蓝蝶` : '']
        .filter(Boolean)
        .join(' + ');
  return (
    <DropdownPopover
      label={label}
      ariaLabel="下拉选择顶贴账号组"
      warn={!totalSelected}
      disabled={p.disabled}
    >
      <div className="flex flex-col gap-1">
        <ScopeHeader
          heading="Chrome 浏览器分组"
          total={p.profiles.length}
          selectedCount={sel.profileIds.length}
          showItems={showSingleChrome}
          singleLabel="单号"
          onToggle={() => setShowSingleChrome((v) => !v)}
        />
        {p.profileGroups.map((g) => (
          <CountCheckbox
            key={g.id}
            checked={sel.groups.includes(g.id)}
            label={g.name}
            count={p.profiles.filter((pr) => pr.groupId === g.id).length}
            onChange={() => commit({ groups: toggleId(latestRef.current.groups, g.id) })}
          />
        ))}
        <CountCheckbox
          key={UNGROUPED_BUCKET_ID}
          checked={ungroupedSelected}
          label="未分组"
          count={p.profiles.filter((pr) => pr.groupId === null).length}
          onChange={() => {
            const nextInclude = !includesUngroupedBucket(
              latestRef.current.groups,
              latestRef.current.includeUngrouped,
            );
            const baseGroups = latestRef.current.groups.filter((id) => id !== UNGROUPED_BUCKET_ID);
            commit(
              {
                groups: nextInclude ? [...baseGroups, UNGROUPED_BUCKET_ID] : baseGroups,
                includeUngrouped: nextInclude,
              },
              { includeUngrouped: true },
            );
          }}
        />
        {(showSingleChrome || sel.profileIds.length > 0) && p.profiles.length > 0 && (
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto border-t border-slate-100 pt-1">
            {p.profiles.map((pr) => (
              <Chk
                key={pr.id}
                className={optCls}
                checked={sel.profileIds.includes(pr.id)}
                onChange={() =>
                  commit(
                    { profileIds: toggleId(latestRef.current.profileIds, pr.id) },
                    { profileIds: true },
                  )
                }
                label={`${profileDisplayName(pr)}${pr.account.name ? ` · ${pr.account.name}` : ''}`}
              />
            ))}
          </div>
        )}
      </div>
      {bsInstances.length > 0 && (
        <BsScopePicker
          heading="蓝蝶模拟器"
          folders={bsFolders}
          instances={bsInstances}
          selectedFolderIds={sel.bsFolders}
          selectedInstanceIds={sel.bsIds}
          showInstances={showSingleBs}
          onToggleShowInstances={() => setShowSingleBs((v) => !v)}
          onToggleFolder={(id) => commit({ bsFolders: toggleId(latestRef.current.bsFolders, id) })}
          onToggleInstance={(id) =>
            commit({ bsIds: toggleId(latestRef.current.bsIds, id) }, { bsIds: true })
          }
        />
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
    selectedInstanceIds: string[];
    closeBluestacksOnFinish: boolean;
  }) => void;
}) {
  const [showSingleBs, setShowSingleBs] = useState(false);
  const bsFolders = p.bluestacksState?.folders ?? [],
    bsInstances = p.bluestacksState?.instances ?? [],
    sc = p.link.scheduleConfig;
  const init = {
    folders: sc?.bluestacksFolderIds ?? [],
    ids: resolveEffectiveInstanceIds(sc?.bluestacksInstanceIds, sc?.selectedInstanceIds),
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
      selectedInstanceIds: n.ids,
      closeBluestacksOnFinish: n.closeOnFinish,
    });
  };
  return (
    <DropdownPopover
      label={matched > 0 ? `蓝蝶范围 (${matched})` : '蓝蝶范围：全部'}
      ariaLabel="蓝蝶执行范围"
      disabled={p.disabled}
    >
      <Chk
        className={optCls}
        label="发帖完成后自动关窗"
        checked={sel.closeOnFinish}
        onChange={(c) => commit({ closeOnFinish: c })}
      />
      {!bsInstances.length ? (
        <div className="mt-1.5 border-t border-[var(--line)] px-1.5 pt-1.5 text-xs text-[var(--muted)]">
          暂无可用蓝蝶实例
        </div>
      ) : (
        <BsScopePicker
          heading={
            bsFolders.length > 0
              ? '限定蓝蝶范围（不选则自动匹配全部）'
              : '按单台蓝蝶选择（不选则自动匹配全部）'
          }
          folders={bsFolders}
          instances={bsInstances}
          selectedFolderIds={sel.folders}
          selectedInstanceIds={sel.ids}
          showInstances={showSingleBs}
          onToggleShowInstances={() => setShowSingleBs((v) => !v)}
          onToggleFolder={(id) => commit({ folders: toggleId(latestRef.current.folders, id) })}
          onToggleInstance={(id) => commit({ ids: toggleId(latestRef.current.ids, id) })}
        />
      )}
    </DropdownPopover>
  );
}
export function SchedulePolicyDropdown(p: {
  link: GoogleSheetLink;
  disabled?: boolean;
  onChange: (patch: { pollIntervalMinutes?: number; autoWakeBumper?: boolean }) => void;
}) {
  const sc = p.link.scheduleConfig,
    pollMin = sc?.pollIntervalMinutes ?? 2,
    autoWake = sc?.autoWakeBumper ?? true;
  return (
    <DropdownPopover
      label={`每${pollMin}分${autoWake ? ' · 自动唤醒' : ''}`}
      ariaLabel="排贴轮询与唤醒设置"
      disabled={p.disabled}
    >
      <div className="flex flex-col gap-2.5 p-1">
        <CtrlNum
          label="轮询间隔（分钟）"
          aria="排贴轮询间隔"
          min={1}
          max={60}
          def={2}
          val={pollMin}
          debounceMs={0}
          disabled={p.disabled}
          onChange={(v) => p.onChange({ pollIntervalMinutes: clamp(v, 1, 60) })}
        />
        <UiSwitch
          checked={autoWake}
          disabled={p.disabled}
          label="发帖后自动唤醒顶贴"
          ariaLabel="发帖后自动唤醒顶贴"
          onCheckedChange={(autoWakeBumper) => p.onChange({ autoWakeBumper })}
        />
      </div>
    </DropdownPopover>
  );
}
