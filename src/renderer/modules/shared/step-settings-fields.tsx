import type { BumperReactionType, BumperSettings } from '../../../shared/group-bumper.js';
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
const NUM_RULES = {
  maxPostAgeHours: [1, 720, 24],
  maxPostsPerGroupPage: [1, 50, 5],
  maxPostsPerPage: [1, 50, 3],
  maxConcurrentProfiles: [1, 50, 8],
  dailyMaxLikesPerAccount: [1, 500, 20],
  maxLikesPerPost: [1, 500, 50],
  likeProbability: [0, 100, 100],
  commentProbability: [0, 100, 30],
  shareToStoryProbability: [0, 100, 0],
} as const;
export function normalizeBumperSettings(
  draft: BumperSettings,
  fb: BumperSettings = DEFAULT_BUMPER_SETTINGS,
): Required<BumperSettings> {
  const valid = (draft.reactionTypes ?? fb.reactionTypes ?? ['care', 'love', 'like']).filter(
    (r): r is BumperReactionType => REACTION_OPTIONS.some((o) => o.id === r),
  );
  const n = <K extends keyof typeof NUM_RULES>(k: K) => {
    const [min, max, def] = NUM_RULES[k];
    return clampInt(draft[k], min, max, fb[k] ?? def);
  };
  return {
    searchMode: draft.searchMode ?? fb.searchMode ?? 'time_sort',
    maxPostAgeHours: n('maxPostAgeHours'),
    maxPostsPerGroupPage: n('maxPostsPerGroupPage'),
    maxPostsPerPage: n('maxPostsPerPage'),
    maxConcurrentProfiles: n('maxConcurrentProfiles'),
    dailyMaxLikesPerAccount: n('dailyMaxLikesPerAccount'),
    maxLikesPerPost: n('maxLikesPerPost'),
    likeProbability: n('likeProbability'),
    commentProbability: n('commentProbability'),
    shareToStoryProbability: n('shareToStoryProbability'),
    consumeCommentOnUse: Boolean(draft.consumeCommentOnUse ?? fb.consumeCommentOnUse),
    enableSound: Boolean(draft.enableSound ?? fb.enableSound),
    useLongPressReaction: Boolean(draft.useLongPressReaction ?? fb.useLongPressReaction),
    reactionTypes: valid.length > 0 ? valid : ['care', 'love', 'like'],
  };
}
