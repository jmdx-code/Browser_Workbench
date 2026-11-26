import type { BumperReactionType, BumperSettings } from '../../../shared/group-bumper.js';
import { UI_SELECT_SM, UiSwitch } from '../../ui/primitives.js';
import { CtrlNum, Fld } from './module-ui.js';

export const REACTION_OPTIONS: ReadonlyArray<{
  id: BumperReactionType;
  emoji: string;
  label: string;
}> = [
  { id: 'like', emoji: '👍', label: '赞' },
  { id: 'love', emoji: '❤️', label: '大心' },
  { id: 'care', emoji: '🤗', label: '抱抱' },
  { id: 'haha', emoji: '😆', label: '哈' },
  { id: 'wow', emoji: '😮', label: '哇' },
  { id: 'sad', emoji: '😢', label: '呜' },
  { id: 'angry', emoji: '😡', label: '怒' },
];

const DEFAULT_BUMPER_SETTINGS: Required<BumperSettings> = {
  searchMode: 'time_sort',
  maxPostAgeHours: 24,
  maxPostsPerGroupPage: 5,
  maxPostsPerPage: 3,
  maxConcurrentProfiles: 8,
  dailyMaxLikesPerAccount: 20,
  maxLikesPerPost: 50,
  likeProbability: 100,
  commentProbability: 30,
  shareToStoryProbability: 0,
  consumeCommentOnUse: false,
  enableSound: false,
  useLongPressReaction: false,
  reactionTypes: ['care', 'love', 'like'],
};

const clampInt = (raw: number | undefined, min: number, max: number, fb: number) =>
  Math.min(
    max,
    Math.max(min, Math.round(typeof raw === 'number' && Number.isFinite(raw) ? raw : fb)),
  );

export function normalizeBumperSettings(
  draft: BumperSettings,
  fb: BumperSettings = DEFAULT_BUMPER_SETTINGS,
): Required<BumperSettings> {
  const valid = (draft.reactionTypes ?? fb.reactionTypes ?? ['care', 'love', 'like']).filter(
    (r): r is BumperReactionType => REACTION_OPTIONS.some((o) => o.id === r),
  );
  return {
    searchMode: draft.searchMode ?? fb.searchMode ?? 'time_sort',
    maxPostAgeHours: clampInt(draft.maxPostAgeHours, 1, 720, fb.maxPostAgeHours ?? 24),
    maxPostsPerGroupPage: clampInt(draft.maxPostsPerGroupPage, 1, 50, fb.maxPostsPerGroupPage ?? 5),
    maxPostsPerPage: clampInt(draft.maxPostsPerPage, 1, 50, fb.maxPostsPerPage ?? 3),
    maxConcurrentProfiles: clampInt(
      draft.maxConcurrentProfiles,
      1,
      50,
      fb.maxConcurrentProfiles ?? 8,
    ),
    dailyMaxLikesPerAccount: clampInt(
      draft.dailyMaxLikesPerAccount,
      1,
      500,
      fb.dailyMaxLikesPerAccount ?? 20,
    ),
    maxLikesPerPost: clampInt(draft.maxLikesPerPost, 1, 500, fb.maxLikesPerPost ?? 50),
    likeProbability: clampInt(draft.likeProbability, 0, 100, fb.likeProbability ?? 100),
    commentProbability: clampInt(draft.commentProbability, 0, 100, fb.commentProbability ?? 30),
    shareToStoryProbability: clampInt(
      draft.shareToStoryProbability,
      0,
      100,
      fb.shareToStoryProbability ?? 0,
    ),
    consumeCommentOnUse: Boolean(draft.consumeCommentOnUse ?? fb.consumeCommentOnUse),
    enableSound: Boolean(draft.enableSound ?? fb.enableSound),
    useLongPressReaction: Boolean(draft.useLongPressReaction ?? fb.useLongPressReaction),
    reactionTypes: valid.length > 0 ? valid : ['care', 'love', 'like'],
  };
}

export function summarizeBumperSettings(
  override: Partial<BumperSettings> | undefined,
  opts: { pageMode: boolean; bluestacks?: boolean | undefined },
): string {
  if (!override || Object.keys(override).length === 0) return '全局默认参数';
  const r = normalizeBumperSettings({ ...DEFAULT_BUMPER_SETTINGS, ...override });
  const parts = [`赞${r.likeProbability}%`, `评${r.commentProbability}%`];
  if (!opts.bluestacks && r.shareToStoryProbability > 0)
    parts.push(`快拍${r.shareToStoryProbability}%`);
  parts.push(
    opts.pageMode
      ? `扫${r.maxPostsPerPage}贴`
      : r.searchMode === 'page_group_feed'
        ? '专页小组贴'
        : r.searchMode === 'random_browse'
          ? '随机逛'
          : `${r.maxPostAgeHours}h内`,
  );
  if (r.enableSound) parts.push('有声');
  return parts.join(' · ');
}

type NumKey =
  | 'maxPostAgeHours'
  | 'maxPostsPerGroupPage'
  | 'maxPostsPerPage'
  | 'dailyMaxLikesPerAccount'
  | 'maxLikesPerPost'
  | 'likeProbability'
  | 'commentProbability'
  | 'shareToStoryProbability';

export function BumperSettingsFields(p: {
  value: Partial<BumperSettings> | undefined;
  onChange: (next: BumperSettings) => void;
  pageMode: boolean;
  bluestacks?: boolean;
  disabled?: boolean;
}) {
  const { pageMode, bluestacks = false, disabled = false } = p;
  const resolved = normalizeBumperSettings({ ...DEFAULT_BUMPER_SETTINGS, ...(p.value ?? {}) });
  const patch = (nextPatch: Partial<BumperSettings>) =>
    p.onChange(normalizeBumperSettings({ ...resolved, ...nextPatch }));

  const numSpecs: ReadonlyArray<[NumKey, string, string, number, number, boolean]> = [
    [
      'maxPostAgeHours',
      '最近几小时内',
      '步骤最近几小时内',
      1,
      720,
      !pageMode && resolved.searchMode !== 'random_browse',
    ],
    ['maxPostsPerGroupPage', '每组每主页最多扫帖', '步骤每组每主页最多扫帖', 1, 50, !pageMode],
    ['maxPostsPerPage', '最大扫描贴文数量', '步骤最大扫描贴文数量', 1, 50, pageMode],
    ['dailyMaxLikesPerAccount', '单号每日上限', '步骤单号每日上限', 1, 500, true],
    ['maxLikesPerPost', '单帖最高上限', '步骤单帖最高上限', 1, 500, true],
    ['likeProbability', '点赞概率 %', '步骤点赞概率', 0, 100, true],
    ['commentProbability', '留言概率 %', '步骤留言概率', 0, 100, true],
    ['shareToStoryProbability', '分享快拍概率 %', '步骤分享快拍概率', 0, 100, !bluestacks],
  ];
  const switches: ReadonlyArray<[boolean, string, string, (v: boolean) => void, boolean]> = [
    [
      resolved.enableSound,
      '开启声音',
      '步骤开启声音',
      (enableSound) => patch({ enableSound }),
      true,
    ],
    [
      resolved.consumeCommentOnUse,
      '留言后移除',
      '步骤留言后移除',
      (consumeCommentOnUse) => patch({ consumeCommentOnUse }),
      true,
    ],
    [
      resolved.useLongPressReaction,
      '长按选表情',
      '步骤长按选表情',
      (useLongPressReaction) => patch({ useLongPressReaction }),
      !bluestacks,
    ],
  ];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-2.5 gap-y-2">
        {!pageMode && (
          <Fld label="查找方式">
            <select
              aria-label="步骤查找方式"
              className={`${UI_SELECT_SM} w-full`}
              disabled={disabled}
              value={resolved.searchMode}
              onChange={(e) => {
                const searchMode = e.target.value as BumperSettings['searchMode'];
                const oldDef = resolved.searchMode === 'page_group_feed' ? 5 : 15,
                  nextDef = searchMode === 'page_group_feed' ? 5 : 15;
                patch({
                  searchMode,
                  maxPostsPerGroupPage:
                    resolved.maxPostsPerGroupPage === oldDef
                      ? nextDef
                      : resolved.maxPostsPerGroupPage,
                });
              }}
            >
              <option value="time_sort">1. 时间排序查找</option>
              <option value="page_group_feed">2. 直接打开专页的小组贴</option>
              <option value="random_browse">3. 随机浏览</option>
            </select>
          </Fld>
        )}
        {numSpecs
          .filter(([, , , , , v]) => v)
          .map(([key, label, aria, min, max]) => (
            <CtrlNum
              key={key}
              label={label}
              aria={aria}
              debounceMs={0}
              disabled={disabled}
              val={resolved[key]}
              def={resolved[key]}
              min={min}
              max={max}
              onChange={(val) => patch({ [key]: val })}
            />
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-3.5">
        {switches
          .filter(([, , , , v]) => v)
          .map(([checked, label, ariaLabel, onCheckedChange]) => (
            <UiSwitch
              key={ariaLabel}
              checked={checked}
              disabled={disabled}
              label={label}
              ariaLabel={ariaLabel}
              onCheckedChange={onCheckedChange}
            />
          ))}
      </div>
      {!bluestacks && resolved.useLongPressReaction && (
        <div
          className="inline-flex flex-wrap items-center gap-1"
          role="group"
          aria-label="步骤表情类型选择"
        >
          {REACTION_OPTIONS.map((opt) => {
            const checked = resolved.reactionTypes.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                disabled={disabled}
                className={
                  'h-6 cursor-pointer rounded-full border px-[7px] text-[11px] font-semibold transition-colors ' +
                  (checked
                    ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]'
                    : 'border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-slate-300')
                }
                aria-pressed={checked}
                onClick={() =>
                  patch({
                    reactionTypes: checked
                      ? resolved.reactionTypes.length > 1
                        ? resolved.reactionTypes.filter((t) => t !== opt.id)
                        : resolved.reactionTypes
                      : [...resolved.reactionTypes, opt.id],
                  })
                }
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
