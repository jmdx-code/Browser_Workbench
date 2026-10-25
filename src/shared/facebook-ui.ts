// Software-owned copy observed in real Chrome pages, not machine-translated guesses.
// Labels may be mixed-language (the Burmese composer currently uses English Post/Preview).
// This registry selects UI adapters; it never grants acting identity or publishing permission.
export const FACEBOOK_UI_COPY = [
  {
    locale: 'zh_CN',
    profile: ['你的个人主页', '您的个人主页'],
    region: '创建帖子',
    timeline: ['', '的时间线'],
    prompt: ['', '，分享你的新鲜事吧！'],
    shortPromptName: false,
    post: '发布',
    preview: '预览',
    close: '关闭',
  },
  {
    locale: 'zh_TW',
    profile: ['你的個人檔案'],
    region: '建立貼文',
    timeline: ['', '的動態時報'],
    prompt: ['', '，在想些什麼？'],
    shortPromptName: false,
    post: '發佈',
    preview: '預覽',
    close: '關閉',
  },
  {
    locale: 'en_US',
    profile: ['Your profile'],
    region: 'Create a post',
    timeline: ['', "'s Timeline"],
    prompt: ["What's on your mind, ", '?'],
    shortPromptName: true,
    post: 'Post',
    preview: 'Preview',
    close: 'Close',
  },
  {
    locale: 'my_MM',
    profile: ['သင့်ပရိုဖိုင်'],
    region: 'ပို့စ် ဖန်တီးရန်',
    timeline: ['', ' ရဲ့ တိုင်းမ်လိုင်း'],
    prompt: ['ဘာတွေ တွေးနေလဲ ... ', ' ရေ'],
    shortPromptName: true,
    post: 'Post',
    preview: 'Preview',
    close: 'ပိတ်ရန်',
  },
  {
    locale: 'ar_AR',
    profile: ['ملفك الشخصي'],
    region: 'إنشاء منشور',
    timeline: ['يوميات ', ''],
    prompt: ['بم تفكر يا ', '؟'],
    shortPromptName: true,
    post: 'نشر',
    preview: 'معاينة',
    close: 'إغلاق',
  },
] as const;
export type FacebookUILocale =
  (typeof FACEBOOK_UI_COPY)[number]['locale'] | 'zh-Hans' | 'zh-Hant' | 'zh-CN' | 'zh-TW' | 'en';
export function normalizeFacebookUILocale(locale?: FacebookUILocale) {
  const aliases = {
    'zh-Hans': 'zh_CN',
    'zh-CN': 'zh_CN',
    'zh-Hant': 'zh_TW',
    'zh-TW': 'zh_TW',
    en: 'en_US',
  } as const;
  return locale && locale in aliases ? aliases[locale as keyof typeof aliases] : locale;
}

// Maw Htwe's current zh_CN home composer uses 发帖; the earlier observed composer uses 发布.
// Keep actual label variants in one software registry, never assume a translation is observed.
export function facebookComposerPostLabels(locale?: FacebookUILocale): string[] {
  locale = normalizeFacebookUILocale(locale);
  const labels: string[] = FACEBOOK_UI_COPY.filter((copy) => !locale || copy.locale === locale).map(
    (copy) => copy.post,
  );
  if (!locale || locale === 'zh_CN') labels.push('发帖');
  if (!locale || locale === 'zh_TW') labels.push('發文');
  return [...new Set(labels)];
}

export function facebookUILabelSelector(labels: readonly string[]) {
  return (
    ':is(' +
    [...new Set(labels)].map((label) => '[aria-label=' + JSON.stringify(label) + ']').join(', ') +
    ')'
  );
}
export const FACEBOOK_COMPOSER_SCOPE =
  '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])';
export const FACEBOOK_COMPOSER_TEXT = 'form [role="textbox"][contenteditable="true"]';
export const FACEBOOK_COMPOSER_FILES =
  'form input[type="file"][multiple][accept*="image/"][accept*="video/"]';
// Locale labels are fallbacks for the observed native stages; Next is never Submit.
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
export function facebookComposerAdvanceLabels(locale?: FacebookUILocale): string[] {
  const canonical = normalizeFacebookUILocale(locale);
  return [
    ...new Set(
      FACEBOOK_COMPOSER_ADVANCE_COPY.filter((copy) => !canonical || copy.locale === canonical).map(
        (copy) => copy.label,
      ),
    ),
  ];
}
export function facebookComposerAdvanceSelector(locale: FacebookUILocale) {
  const labels = facebookComposerAdvanceLabels(locale);
  return labels.length ? '[role="button"]' + facebookUILabelSelector(labels) : null;
}
export function facebookComposerPostSelector(locale: FacebookUILocale) {
  const canonical = normalizeFacebookUILocale(locale);
  if (!FACEBOOK_UI_COPY.some((copy) => copy.locale === canonical))
    throw Error('FACEBOOK_UI_LOCALE_UNSUPPORTED');
  return '[role="button"]' + facebookUILabelSelector(facebookComposerPostLabels(canonical));
}

function unwrap(value: string, template: readonly [string, string]) {
  const [prefix, suffix] = template;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const name = value.slice(prefix.length, suffix ? -suffix.length : undefined);
  return name && name === name.trim() && name.length <= 150 && !/[\u0000-\u001f\u007f]/.test(name)
    ? name
    : null;
}

// Short prompts are an observed display convention, never an account-name/ID match for authority.
export function matchFacebookHomeCopy(region: string, timeline: string, prompt: string) {
  const copy = FACEBOOK_UI_COPY.find((item) => item.region === region);
  if (!copy) return null;
  const name = unwrap(timeline, copy.timeline),
    promptName = unwrap(prompt, copy.prompt);
  if (
    !name ||
    !promptName ||
    !(name === promptName || (copy.shortPromptName && name.startsWith(promptName + ' ')))
  )
    return null;
  return { locale: copy.locale, name };
}
