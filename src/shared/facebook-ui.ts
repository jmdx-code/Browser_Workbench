// Software-owned copy observed in real Chrome pages, not machine-translated guesses.
export type FacebookUILocale =
  | 'zh_CN'
  | 'zh_TW'
  | 'en_US'
  | 'my_MM'
  | 'ar_AR'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'zh-CN'
  | 'zh-TW'
  | 'en';
type CopyTuple = readonly [
  locale: FacebookUILocale,
  profile: readonly string[],
  region: string,
  timeline: readonly [string, string],
  prompt: readonly [string, string],
  shortPromptName: boolean,
  post: string,
  preview: string,
  close: string,
];
const ROWS: readonly CopyTuple[] = [
  [
    'zh_CN',
    ['你的个人主页', '您的个人主页'],
    '创建帖子',
    ['', '的时间线'],
    ['', '，分享你的新鲜事吧！'],
    false,
    '发布',
    '预览',
    '关闭',
  ],
  [
    'zh_TW',
    ['你的個人檔案'],
    '建立貼文',
    ['', '的動態時報'],
    ['', '，在想些什麼？'],
    false,
    '發佈',
    '預覽',
    '關閉',
  ],
  [
    'en_US',
    ['Your profile'],
    'Create a post',
    ['', "'s Timeline"],
    ["What's on your mind, ", '?'],
    true,
    'Post',
    'Preview',
    'Close',
  ],
  [
    'my_MM',
    ['သင့်ပရိုဖိုင်'],
    'ပို့စ် ဖန်တီးရန်',
    ['', ' ရဲ့ တိုင်းမ်လိုင်း'],
    ['ဘာတွေ တွေးနေလဲ ... ', ' ရေ'],
    true,
    'Post',
    'Preview',
    'ပိတ်ရန်',
  ],
  [
    'ar_AR',
    ['ملفك الشخصي'],
    'إنشاء منشور',
    ['يوميات ', ''],
    ['بم تفكر يا ', '؟'],
    true,
    'نشر',
    'معاينة',
    'إغلاق',
  ],
] as const;
export const FACEBOOK_UI_COPY = ROWS.map(
  ([locale, profile, region, timeline, prompt, shortPromptName, post, preview, close]) => ({
    locale,
    profile,
    region,
    timeline,
    prompt,
    shortPromptName,
    post,
    preview,
    close,
  }),
);
const localeAliases: Record<string, FacebookUILocale> = {
  'zh-Hans': 'zh_CN',
  'zh-CN': 'zh_CN',
  'zh-Hant': 'zh_TW',
  'zh-TW': 'zh_TW',
  en: 'en_US',
};
const normalizeFacebookUILocale = (locale?: string) =>
  locale && locale in localeAliases ? localeAliases[locale] : locale;
export function facebookComposerPostLabels(locale?: string): string[] {
  locale = normalizeFacebookUILocale(locale);
  const labels: string[] = FACEBOOK_UI_COPY.filter((c) => !locale || c.locale === locale).map(
    (c) => c.post,
  );
  if (!locale || locale === 'zh_CN') labels.push('发帖');
  if (!locale || locale === 'zh_TW') labels.push('發文');
  return [...new Set(labels)];
}
export const facebookUILabelSelector = (labels: readonly string[]) =>
  ':is(' +
  [...new Set(labels)].map((l) => '[aria-label=' + JSON.stringify(l) + ']').join(', ') +
  ')';
export const FACEBOOK_COMPOSER_SCOPE =
  '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])';
export const FACEBOOK_COMPOSER_TEXT = 'form [role="textbox"][contenteditable="true"]';
export const FACEBOOK_COMPOSER_FILES =
  'form input[type="file"][multiple][accept*="image/"][accept*="video/"]';
export const FACEBOOK_POST_SETTINGS_LABELS = ['帖子设置', '貼文設定', 'Post settings'] as const;
export const FACEBOOK_REEL_EDIT_LABELS = [
  '编辑 Reels',
  '編輯 Reels',
  'Edit reel',
  'Edit Reels',
] as const;
export const FACEBOOK_REEL_SETTINGS_LABELS = [
  'Reels 设置',
  'Reels 設定',
  'Reel settings',
  'Reels settings',
] as const;
export const FACEBOOK_COMPOSER_REVIEW_SCOPE =
  FACEBOOK_COMPOSER_SCOPE +
  ' [role="dialog"]' +
  facebookUILabelSelector(FACEBOOK_POST_SETTINGS_LABELS);
export const FACEBOOK_COMPOSER_REVIEW_SUBMIT =
  '[role="button"]' + facebookUILabelSelector(facebookComposerPostLabels());
export const FACEBOOK_REEL_SCOPE =
  '[role="dialog"]:has([role="form"][aria-label]):not(:has([role="dialog"] [role="form"][aria-label]))';
export const FACEBOOK_REEL_MAIN =
  FACEBOOK_REEL_SCOPE +
  ' [role="main"]:has([role="form"]):not([aria-hidden="true"], [aria-hidden="true"] *)';
export const FACEBOOK_REEL_TEXT = '[role="form"] [role="textbox"][contenteditable="true"]';
export const FACEBOOK_COMPOSER_ADVANCE_COPY = [
  { locale: 'zh_CN', label: '下一页' },
  { locale: 'zh_CN', label: '下一步' },
  { locale: 'zh_TW', label: '下一頁' },
  { locale: 'zh_TW', label: '下一步' },
  { locale: 'en_US', label: 'Next' },
] as const;
export function facebookComposerAdvanceLabels(locale?: string): string[] {
  const canonical = normalizeFacebookUILocale(locale);
  return [
    ...new Set(
      FACEBOOK_COMPOSER_ADVANCE_COPY.filter((c) => !canonical || c.locale === canonical).map(
        (c) => c.label,
      ),
    ),
  ];
}
function unwrap(value: string, template: readonly [string, string]) {
  const [prefix, suffix] = template;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const name = value.slice(prefix.length, suffix ? -suffix.length : undefined);
  return name && name === name.trim() && name.length <= 150 && !/[\u0000-\u001f\u007f]/.test(name)
    ? name
    : null;
}
export function matchFacebookHomeCopy(region: string, timeline: string, prompt: string) {
  const copy = FACEBOOK_UI_COPY.find((item) => item.region === region);
  if (!copy) return null;
  const name = unwrap(timeline, copy.timeline),
    promptName = unwrap(prompt, copy.prompt);
  return !name ||
    !promptName ||
    !(name === promptName || (copy.shortPromptName && name.startsWith(promptName + ' ')))
    ? null
    : { locale: copy.locale, name };
}
