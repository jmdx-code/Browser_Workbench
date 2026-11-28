import { useEffect, useState } from 'react';
import type { BumperPendingOperation, BumperSettings } from '../shared/group-bumper.js';
import { ConfirmDialog } from './confirm-dialog.js';
import type { DraftGroupEntry } from './group-inviter-grid.js';
import { IconSliders } from './icons.js';
import type { PendingReviewDisplayItem } from './modules/poster-material-detail-modal.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import {
  BackdropModal,
  Btn,
  Chk,
  ErrText,
  ModalHeading,
  readStoredFlag,
} from './modules/shared/module-ui.js';
import { REACTION_OPTIONS } from './modules/shared/step-settings-fields.js';
import { PopoverMenu } from './popover-menu.js';
import { UI_INPUT_SM, UI_SELECT_SM, UiSwitch } from './ui/primitives.js';
export type BumperSettingsWithClose = BumperSettings & { closeBrowserOnFinish?: boolean };
export const bumperCloseKey = (pageMode: boolean) =>
  pageMode ? 'wb.pageBumper.closeBrowserOnFinish' : 'wb.groupBumper.closeBrowserOnFinish';
export const readStoredBumperClose = (pageMode: boolean, s: BumperSettings | null): boolean => {
  const fromServer = (s as BumperSettingsWithClose | null)?.closeBrowserOnFinish;
  return typeof fromServer === 'boolean' ? fromServer : readStoredFlag(bumperCloseKey(pageMode));
};
export function mapBumperPendingItems(
  ops: readonly BumperPendingOperation[],
  profiles?: ReadonlyArray<{
    id: string;
    name?: string | null;
    browserName?: string | null;
    alias?: string | null;
  }>,
): PendingReviewDisplayItem[] {
  return ops.map((op) => {
    const prof = profiles?.find((pr) => pr.id === op.profileId);
    const acct =
      prof?.alias?.trim() ||
      prof?.browserName?.trim() ||
      prof?.name?.trim() ||
      op.accountId ||
      op.profileId;
    const actionLabel =
      op.actionKind === 'comment' ? '留言' : op.actionKind === 'story_share' ? '分享快拍' : '点赞';
    const targetParts = [
      op.groupId && op.groupId !== '-' ? op.groupName || op.groupId : '',
      op.pageName || op.pageId,
    ].filter(Boolean);
    return {
      id: op.id,
      actionLabel,
      targetLabel: targetParts.join(' · ') || op.postId,
      accountLabel: acct,
      updatedAt: op.updatedAt,
      reviewReason: op.reason ?? '',
    };
  });
}
export type NumberSettingKey =
  | 'maxPostAgeHours'
  | 'maxPostsPerGroupPage'
  | 'maxPostsPerPage'
  | 'dailyMaxLikesPerAccount'
  | 'maxLikesPerPost'
  | 'likeProbability'
  | 'commentProbability'
  | 'shareToStoryProbability'
  | 'maxConcurrentProfiles';
export const blankBumperRow = (): DraftGroupEntry => ({
  key: crypto.randomUUID(),
  groupId: '',
  groupName: '',
});
export const IDLE_BUMPER_STATUS = new Set([
  '请选择账号、小组和目标主页',
  '请选择模拟器窗口、小组和目标主页',
  '请选择蓝蝶窗口、目标小组和目标主页',
  '请选择账号和目标专页',
  '请选择蓝蝶窗口和目标专页',
  '本轮已结束',
  '正在读取…',
]);
export function BumperSettingInput(p: {
  settingKey: NumberSettingKey;
  label: string;
  unit?: string;
  settings: BumperSettings;
  onUpdate: (key: NumberSettingKey, clamped: number, commit: boolean) => void;
}) {
  const k = p.settingKey;
  const min = k.includes('Probability') ? 0 : 1;
  const max = k.includes('Probability')
    ? 100
    : k === 'maxPostsPerGroupPage' || k === 'maxPostsPerPage' || k === 'maxConcurrentProfiles'
      ? 50
      : k === 'maxPostAgeHours'
        ? 720
        : 500;
  const val =
    p.settings[k] ?? (k === 'shareToStoryProbability' ? 0 : k === 'maxPostsPerPage' ? 3 : 8);
  const input = (
    <ControlledNumberInput
      ariaLabel={k}
      value={val}
      min={min}
      max={max}
      defaultValue={val}
      className={
        p.unit
          ? 'h-full w-16 min-w-0 border-0 bg-transparent px-1.5 text-xs text-[var(--text)] tabular-nums focus:outline-none'
          : `${UI_INPUT_SM} w-16 text-center tabular-nums`
      }
      onChange={(c) => p.onUpdate(k, c, false)}
      onCommit={(c) => p.onUpdate(k, c, true)}
    />
  );
  return (
    <label
      key={k}
      className="bumper-policy-field inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap text-[var(--text-2)]"
    >
      <span>{p.label}</span>
      {p.unit ? (
        <div className="bumper-advanced-input flex h-7 items-center overflow-hidden rounded-md border border-[var(--line-strong)] bg-white focus-within:border-[var(--brand)] focus-within:shadow-[var(--focus)]">
          {input}
          <span className="bumper-advanced-unit border-l border-[var(--line)] bg-[var(--surface-2)] px-2 text-[11px] leading-[26px] text-[var(--text-3)]">
            {p.unit}
          </span>
        </div>
      ) : (
        input
      )}
    </label>
  );
}
export function BumperCommentsModal(p: {
  busy: boolean;
  error: string;
  pageMode: boolean;
  commentText: string;
  consume: boolean;
  onCommentTextChange: (next: string) => void;
  onConsumeChange: (next: boolean) => void;
  onClear: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const validLines = p.commentText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !p.busy &&
        !confirmClearOpen &&
        !document.querySelector('dialog[open]')
      ) {
        e.stopPropagation();
        p.onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [p.busy, confirmClearOpen, p.onClose]);
  return (
    <>
      <BackdropModal
        label={p.pageMode ? '专页留言列表' : '小组留言列表'}
        modalClass="bumper-modal w-[min(560px,calc(100vw-32px))] gap-3"
        busy={p.busy}
        blockEscape
        onClose={() => {
          if (!confirmClearOpen && !document.querySelector('dialog[open]')) p.onClose();
        }}
      >
        <ModalHeading
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{p.pageMode ? '专页顶贴留言列表' : '小组顶贴留言列表'}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                {p.pageMode ? '专页作用域' : '小组作用域'}
              </span>
              <span
                className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 tabular-nums"
                data-testid="bumper-comment-line-count"
              >
                {validLines.length} 条
              </span>
            </span>
          }
          className="bumper-modal-heading px-0 pt-0"
          closeText="×"
          disabled={p.busy}
          onClose={p.onClose}
        />
        <p className="m-0 text-xs leading-relaxed text-[var(--text-2)]">
          每行一条留言（按当前行顺序保存，与{p.pageMode ? '小组顶贴' : '专页顶贴'}
          话术完全隔离）；会优先选择同一帖子尚未使用的话术。
        </p>
        <textarea
          className="h-[280px] w-full resize-y rounded-lg border border-[var(--line-strong)] bg-white p-2.5 text-xs leading-relaxed text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
          aria-label="留言话术"
          value={p.commentText}
          onChange={(e) => p.onCommentTextChange(e.target.value)}
        />
        <Chk label="留言使用后自动从列表移除" checked={p.consume} onChange={p.onConsumeChange} />
        <div className="bumper-modal-footer mt-1 flex items-center justify-end gap-2">
          <Btn
            sm={false}
            disabled={p.busy || validLines.length === 0}
            onClick={() => setConfirmClearOpen(true)}
          >
            清空列表
          </Btn>
          <Btn v="primary" sm={false} disabled={p.busy} onClick={p.onSave}>
            保存
          </Btn>
        </div>
        <ErrText msg={p.error} />
      </BackdropModal>
      {confirmClearOpen && (
        <ConfirmDialog
          title="清空留言列表"
          description={`确定要清空当前「${p.pageMode ? '专页顶贴' : '小组顶贴'}」的全部 ${validLines.length} 条留言话术吗？\n点击确认清空后仍需点击「保存」才会正式写入。`}
          confirmText="确认清空"
          danger
          onConfirm={() => {
            p.onClear();
          }}
          onClose={() => setConfirmClearOpen(false)}
        />
      )}
    </>
  );
}
export function BumperAdvancedPopover(p: {
  settings: BumperSettings;
  bsMode: boolean;
  pageMode: boolean;
  onUpdate: (key: NumberSettingKey, clamped: number, commit: boolean) => void;
}) {
  const advFields: ReadonlyArray<[NumberSettingKey, string, string]> = [
    ['dailyMaxLikesPerAccount', '单号每日上限', '次/天'],
    ['maxLikesPerPost', '单帖最高上限', '次/帖'],
    ['likeProbability', '点赞概率', '%'],
    ['commentProbability', '留言概率', '%'],
    ...(p.bsMode
      ? []
      : [['shareToStoryProbability', '分享快拍概率', '%'] as [NumberSettingKey, string, string]]),
  ];
  return (
    <PopoverMenu
      className="bumper-advanced-popover"
      label="高级参数"
      triggerClassName="btn btn-sm inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-white px-2.5 text-xs font-medium whitespace-nowrap text-[var(--text)] transition-colors hover:not-disabled:border-slate-300 hover:not-disabled:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
      trigger={
        <>
          <IconSliders size={13} /> 高级参数
        </>
      }
    >
      {() => (
        <div className="bumper-advanced-panel flex w-[284px] flex-col gap-2.5 p-2">
          <div className="bumper-advanced-head flex items-center justify-between border-b border-[var(--line)] pb-1.5 text-xs font-semibold text-[var(--text)]">
            <strong>高级顶贴参数</strong>
            <span className="topbar-concurrency-tag rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-3)]">
              自动保存
            </span>
          </div>
          <div className="bumper-advanced-group flex flex-col gap-2 [&_.bumper-policy-field]:justify-between">
            {advFields.map(([key, label, unit]) => (
              <BumperSettingInput
                key={key}
                settingKey={key}
                label={label}
                unit={unit}
                settings={p.settings}
                onUpdate={p.onUpdate}
              />
            ))}
          </div>
          {!p.pageMode && (
            <div className="bumper-advanced-group flex flex-col gap-2 border-t border-[var(--line)] pt-2 [&_.bumper-policy-field]:justify-between">
              <BumperSettingInput
                settingKey="maxPostsPerGroupPage"
                label="每组每主页扫帖"
                unit="条"
                settings={p.settings}
                onUpdate={p.onUpdate}
              />
            </div>
          )}
        </div>
      )}
    </PopoverMenu>
  );
}
export function BumperPolicyBar(p: {
  settings: BumperSettings;
  latestSettings: BumperSettings;
  pageMode: boolean;
  bsMode: boolean;
  closeBrowserOnFinish: boolean;
  onUpdate: (key: NumberSettingKey, clamped: number, commit: boolean) => void;
  onPatchImmediate: (patch: Partial<BumperSettings>) => void;
  onToggleCloseOnFinish: (next: boolean) => void;
}) {
  const { settings, latestSettings, pageMode, bsMode } = p;
  const activeReactions = settings.reactionTypes ?? ['care', 'love', 'like'];
  return (
    <div className="bumper-search-highlight bumper-policy flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-b-xl border-t border-slate-100 bg-slate-50/75 px-3 py-1.5">
      {pageMode ? (
        <BumperSettingInput
          settingKey="maxPostsPerPage"
          label="最大扫描贴文数量"
          settings={settings}
          onUpdate={p.onUpdate}
        />
      ) : (
        <>
          <label className="bumper-policy-field inline-flex min-w-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-[var(--text-2)]">
            <span>查找方式</span>
            <select
              className={`${UI_SELECT_SM} max-w-[180px] min-w-0`}
              aria-label="查找方式"
              value={settings.searchMode ?? 'time_sort'}
              onChange={(e) => {
                const searchMode = e.target.value as BumperSettings['searchMode'];
                const oldDef = latestSettings.searchMode === 'page_group_feed' ? 5 : 15;
                const nextDef = searchMode === 'page_group_feed' ? 5 : 15;
                p.onPatchImmediate({
                  searchMode,
                  maxPostsPerGroupPage:
                    latestSettings.maxPostsPerGroupPage === oldDef
                      ? nextDef
                      : latestSettings.maxPostsPerGroupPage,
                });
              }}
            >
              <option value="time_sort">1. 时间排序查找</option>
              <option value="page_group_feed">2. 直接打开专页的小组贴</option>
              <option value="random_browse">3. 随机浏览</option>
            </select>
          </label>
          {(settings.searchMode ?? 'time_sort') !== 'random_browse' && (
            <BumperSettingInput
              settingKey="maxPostAgeHours"
              label="最近几小时内"
              settings={settings}
              onUpdate={p.onUpdate}
            />
          )}
        </>
      )}
      <span aria-hidden="true" className="hidden h-3.5 w-px bg-slate-200 sm:block" />
      <UiSwitch
        className="bumper-policy-field bumper-sound-toggle whitespace-nowrap"
        checked={Boolean(settings.enableSound)}
        ariaLabel="开启声音"
        label="开启声音"
        onCheckedChange={(enableSound) => p.onPatchImmediate({ enableSound })}
      />
      {!bsMode && (
        <>
          <UiSwitch
            className="bumper-policy-field whitespace-nowrap"
            checked={p.closeBrowserOnFinish}
            ariaLabel="顶贴完毕关闭浏览器"
            label="完后关窗"
            onCheckedChange={p.onToggleCloseOnFinish}
          />
          <UiSwitch
            className="bumper-policy-field bumper-sound-toggle whitespace-nowrap"
            checked={Boolean(settings.useLongPressReaction)}
            ariaLabel="使用表情"
            label="使用表情"
            onCheckedChange={(useLongPressReaction) => p.onPatchImmediate({ useLongPressReaction })}
          />
        </>
      )}
      {!bsMode && Boolean(settings.useLongPressReaction) && (
        <div
          className="bumper-reaction-picks flex flex-wrap items-center gap-1"
          role="group"
          aria-label="表情池"
        >
          {REACTION_OPTIONS.map((opt) => {
            const on = activeReactions.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={on}
                className={
                  'bumper-reaction-chip inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ' +
                  (on
                    ? 'active border-[var(--brand)] bg-[var(--brand-soft)] font-semibold text-[var(--brand)]'
                    : 'border-[var(--line-strong)] bg-white text-[var(--text-2)] hover:border-slate-400 hover:bg-slate-50')
                }
                onClick={() => {
                  const next = on
                    ? activeReactions.filter((r) => r !== opt.id)
                    : [...activeReactions, opt.id];
                  p.onPatchImmediate({ reactionTypes: next.length ? next : ['like'] });
                }}
              >
                {opt.emoji} {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
