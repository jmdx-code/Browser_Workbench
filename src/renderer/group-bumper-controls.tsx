import type { BumperSettings } from '../shared/group-bumper.js';
import type { DraftGroupEntry } from './group-inviter-grid.js';
import { IconSliders } from './icons.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { BackdropModal, Btn, Chk, ModalHeading } from './modules/shared/module-ui.js';
import { PopoverMenu } from './popover-menu.js';
import { UI_INPUT_SM } from './ui/primitives.js';

export type NumberSettingKey =
  | 'maxPostAgeHours'
  | 'maxPostsPerGroupPage'
  | 'maxPostsPerPage'
  | 'maxConcurrentProfiles'
  | 'dailyMaxLikesPerAccount'
  | 'maxLikesPerPost'
  | 'likeProbability'
  | 'commentProbability'
  | 'shareToStoryProbability';

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
          ? 'h-full w-14 min-w-0 border-0 bg-transparent px-2 text-xs text-[var(--text)] tabular-nums focus:outline-none'
          : `${UI_INPUT_SM} w-14 text-center tabular-nums`
      }
      onChange={(c) => p.onUpdate(k, c, false)}
      onCommit={(c) => p.onUpdate(k, c, true)}
    />
  );
  return (
    <label
      key={k}
      className="bumper-policy-field inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]"
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
  commentText: string;
  consume: boolean;
  onCommentTextChange: (next: string) => void;
  onConsumeChange: (next: boolean) => void;
  onClear: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <BackdropModal
      label="留言列表"
      modalClass="bumper-modal w-[min(560px,calc(100vw-32px))] gap-3"
      busy={p.busy}
      onClose={p.onClose}
    >
      <ModalHeading
        title="留言列表"
        className="bumper-modal-heading px-0 pt-0"
        closeText="×"
        disabled={p.busy}
        onClose={p.onClose}
      />
      <p className="m-0 text-xs leading-relaxed text-[var(--text-2)]">
        每行一条留言；会优先选择同一帖子尚未使用的话术。
      </p>
      <textarea
        className="h-[280px] w-full resize-y rounded-lg border border-[var(--line-strong)] bg-white p-2.5 text-xs leading-relaxed text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
        aria-label="留言话术"
        value={p.commentText}
        onChange={(e) => p.onCommentTextChange(e.target.value)}
      />
      <Chk label="留言使用后自动从列表移除" checked={p.consume} onChange={p.onConsumeChange} />
      <div className="bumper-modal-footer mt-1 flex items-center justify-end gap-2">
        <Btn sm={false} onClick={p.onClear}>
          清空列表
        </Btn>
        <Btn v="primary" sm={false} disabled={p.busy} onClick={p.onSave}>
          保存
        </Btn>
      </div>
      {p.error && (
        <p className="m-0 text-xs font-medium text-rose-600" role="alert">
          {p.error}
        </p>
      )}
    </BackdropModal>
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
