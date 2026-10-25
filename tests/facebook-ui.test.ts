import test from 'node:test';
import assert from 'node:assert/strict';
import { FACEBOOK_UI_COPY, matchFacebookHomeCopy } from '../src/shared/facebook-ui.js';
import { observeFacebookHomeName } from '../src/domain/facebook-name-analysis.js';
import { observeFacebookHomeAvatar } from '../src/domain/facebook-avatar-analysis.js';
import { observeFacebookComposerSurface } from '../src/domain/facebook-composer-analysis.js';
import {
  facebookComposerProjection,
  facebookDisplayInspectionProjection,
} from '../src/infrastructure/facebook-read-adapter.js';
import {
  PageReadRequest,
  validateProjection,
  type PageProjection,
  type PageProjectionRequest,
} from '../src/shared/page-read.js';

const observedCopy = [
  ['zh_CN', '创建帖子', 'Nway Myint的时间线', 'Nway Myint，分享你的新鲜事吧！'],
  ['zh_TW', '建立貼文', 'Nway Myint的動態時報', 'Nway Myint，在想些什麼？'],
  ['en_US', 'Create a post', "Nway Myint's Timeline", "What's on your mind, Nway?"],
  ['my_MM', 'ပို့စ် ဖန်တီးရန်', 'Nway Myint ရဲ့ တိုင်းမ်လိုင်း', 'ဘာတွေ တွေးနေလဲ ... Nway ရေ'],
  ['ar_AR', 'إنشاء منشور', 'يوميات Nway Myint', 'بم تفكر يا Nway؟'],
] as const;
function page(request: PageProjectionRequest): PageProjection {
  return {
    url: 'https://www.facebook.com/',
    timeOrigin: 1000,
    ready: 'complete',
    visibility: 'hidden',
    rows: request.queries.map((q) => ({ key: q.key, nodes: [] })),
  };
}
function row(p: PageProjection, key: string) {
  const result = p.rows.find((r) => r.key === key);
  assert.ok(result);
  return result;
}
function element(tag: string, attributes: Record<string, string> = {}, visible = true, text = '') {
  return { tag, attributes, visible, text };
}
function composer() {
  const p = page(facebookComposerProjection);
  for (const [key, tag] of [
    ['composerDialogs', 'div'],
    ['composerForms', 'form'],
    ['composerTextboxes', 'div'],
    ['composerAllFiles', 'input'],
    ['composerMediaFiles', 'input'],
  ] as const)
    row(p, key).nodes.push(element(tag, {}, !key.endsWith('Files')));
  return p;
}

test('real-observed five-language home copy handles full and short names without granting identity', () => {
  for (const [locale, region, timeline, prompt] of observedCopy) {
    assert.deepEqual(matchFacebookHomeCopy(region, timeline, prompt), {
      locale,
      name: 'Nway Myint',
    });
    const p = page(facebookDisplayInspectionProjection);
    row(p, 'homeComposers').nodes.push(element('div', { 'aria-label': region }));
    row(p, 'composerProfileLinks').nodes.push(
      element('a', { 'aria-label': timeline, href: '/profile.php?id=123' }),
    );
    row(p, 'composerPrompts').nodes.push(element('div', {}, true, prompt));
    assert.deepEqual(
      observeFacebookHomeName(validateProjection(facebookDisplayInspectionProjection, p)),
      { source: 'facebook-home-composer', name: 'Nway Myint', actingIdentityVerified: false },
    );
    for (const copy of FACEBOOK_UI_COPY.filter((c) => c.locale !== locale))
      assert.equal(matchFacebookHomeCopy(copy.region, timeline, prompt), null);
  }
  assert.equal(
    matchFacebookHomeCopy('Create a post', "Nway Myint's Timeline", "What's on your mind, N?"),
    null,
  );
  assert.equal(
    matchFacebookHomeCopy('Create a post', "Nway Myint's Timeline", "What's on your mind, Myint?"),
    null,
  );
  assert.equal(
    matchFacebookHomeCopy('创建帖子', 'Nway Myint的时间线', 'Nway，分享你的新鲜事吧！'),
    null,
  );
  assert.equal(matchFacebookHomeCopy('unsupported', 'Nway Myint', 'Nway Myint'), null);
});

test('Unicode display names remain exact, including complex scripts and punctuation', () => {
  for (const name of [
    "O'Neil Test",
    'နှလုံးသား ပန်းဥယျာဉ်',
    'محمد أحمد',
    '王 小明',
    '👩🏽‍💻 Dev',
    'Mary Jane Smith',
  ]) {
    for (const copy of FACEBOOK_UI_COPY) {
      const timeline = copy.timeline[0] + name + copy.timeline[1],
        prompt = copy.prompt[0] + name + copy.prompt[1];
      assert.equal(matchFacebookHomeCopy(copy.region, timeline, prompt)?.name, name);
    }
  }
  for (const name of ['', ' bad', 'bad ', '\nName', 'a'.repeat(151)])
    assert.equal(
      matchFacebookHomeCopy('创建帖子', name + '的时间线', name + '，分享你的新鲜事吧！'),
      null,
    );
});

test('localized avatars keep original origin restrictions and remain display only', () => {
  for (const copy of FACEBOOK_UI_COPY) {
    const p = page(facebookDisplayInspectionProjection);
    row(p, 'ownProfileControls').nodes.push(element('div', { 'aria-label': copy.profile[0] }));
    row(p, 'ownProfileImages').nodes.push(
      element('image', { href: 'https://example.fbcdn.net/avatar.jpg' }),
    );
    assert.equal(
      observeFacebookHomeAvatar(validateProjection(facebookDisplayInspectionProjection, p))
        ?.actingIdentityVerified,
      false,
    );
    row(p, 'ownProfileControls').nodes.push(
      element('div', { 'aria-label': copy.profile[0] }, false),
    );
    assert.equal(observeFacebookHomeAvatar(p), null);
  }
  assert.ok(facebookDisplayInspectionProjection.queries.every((q) => q.selector.length <= 500));
  assert.doesNotThrow(() => PageReadRequest.parse(facebookComposerProjection));
});

test('same composer structure handles arbitrary localized text and hidden native files; unknown submit is unavailable', () => {
  for (const label of [
    '任意文本',
    'ဘာတွေ တွေးနေလဲ',
    'نص تجريبي',
    '日本語',
    'ภาษาไทย',
    'Français',
    'unknown language',
  ]) {
    const p = composer();
    row(p, 'composerTextboxes').nodes[0] = element('div', { 'aria-label': label });
    const result = observeFacebookComposerSurface(
      validateProjection(facebookComposerProjection, p),
    );
    assert.ok(result);
    assert.equal(result.submit, null);
    assert.equal(result.actingIdentityVerified, false);
    assert.equal(result.purposeVerified, false);
    assert.equal(result.contentVerified, false);
    assert.ok(!result.textCSS.includes(label));
  }
  for (const copy of FACEBOOK_UI_COPY) {
    const p = composer();
    p.url = 'https://www.facebook.com/post/create';
    row(p, 'composerSubmits').nodes.push(element('div', { 'aria-label': copy.post }));
    assert.ok(observeFacebookComposerSurface(p, copy.locale)?.submit);
    row(p, 'composerSubmits').nodes.push(element('div', { 'aria-label': copy.post }, false));
    assert.equal(observeFacebookComposerSurface(p, copy.locale)?.submit, null);
  }
});

test('composer ambiguity, wrong documents and extra upload controls refuse candidate; locale mismatch cannot select submit', () => {
  for (const key of [
    'composerDialogs',
    'composerForms',
    'composerTextboxes',
    'composerAllFiles',
    'composerMediaFiles',
  ]) {
    const p = composer(),
      first = row(p, key).nodes[0];
    assert.ok(first);
    row(p, key).nodes.push({ ...first, visible: false });
    assert.equal(observeFacebookComposerSurface(p), null);
    row(p, key).nodes.splice(0);
    assert.equal(observeFacebookComposerSurface(p), null);
  }
  for (const key of ['composerDialogs', 'composerForms', 'composerTextboxes']) {
    const p = composer(),
      first = row(p, key).nodes[0];
    assert.ok(first);
    first.visible = false;
    assert.equal(observeFacebookComposerSurface(p), null);
  }
  for (const change of [
    (p: PageProjection) => {
      p.url = 'https://attacker.test/';
    },
    (p: PageProjection) => {
      p.url = 'https://www.facebook.com/login/';
    },
    (p: PageProjection) => {
      p.ready = 'loading';
    },
    (p: PageProjection) => {
      row(p, 'loginForm').nodes.push(element('form'));
    },
  ]) {
    const p = composer();
    change(p);
    assert.equal(observeFacebookComposerSurface(p), null);
  }
  const p = composer();
  row(p, 'composerSubmits').nodes.push(element('div', { 'aria-label': 'Post' }));
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.submit, null);
  assert.ok(observeFacebookComposerSurface(p, 'my_MM')?.submit); // Actual mixed-language Burmese UI.
});

test('observed zh_CN 发帖 variant retains disabled state and refuses competing or foreign-locale submit targets', () => {
  const p = composer();
  row(p, 'composerSubmits').nodes.push(element('div', { 'aria-label': '发帖' }));
  row(p, 'composerDisabledActions').nodes.push(element('div', { 'aria-label': '发帖' }));
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.phase, 'direct-submit');
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.submit?.enabled, false);
  row(p, 'composerDisabledActions').nodes = [];
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.submit?.enabled, true);
  assert.equal(observeFacebookComposerSurface(p, 'en_US')?.submit, null);
  row(p, 'composerSubmits').nodes.push(element('div', { 'aria-label': '发布' }));
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.submit, null);
});

test('observed profile composer distinguishes disabled Next from final Submit and refuses competing phases', () => {
  const p = composer();
  p.url = 'https://www.facebook.com/profile.php?id=10000000000001';
  row(p, 'composerAdvances').nodes.push(element('div', { 'aria-label': '下一页' }));
  row(p, 'composerDisabledActions').nodes.push(element('div', { 'aria-label': '下一页' }));
  let result = observeFacebookComposerSurface(
    validateProjection(facebookComposerProjection, p),
    'zh_CN',
  );
  assert.equal(result?.phase, 'edit-before-review');
  assert.equal(result?.advance?.enabled, false);
  assert.equal(result?.submit, null);
  row(p, 'composerDisabledActions').nodes.splice(0);
  result = observeFacebookComposerSurface(p, 'zh_CN');
  assert.equal(result?.advance?.enabled, true);
  assert.equal(observeFacebookComposerSurface(p, 'en_US')?.advance, null);
  row(p, 'composerSubmits').nodes.push(element('div', { 'aria-label': '发布' }));
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.phase, 'ambiguous');
  row(p, 'composerAdvances').nodes.splice(0);
  row(p, 'composerDisabledActions').nodes.push(element('div', { 'aria-label': '发布' }));
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN')?.submit?.enabled, false);
  p.url = 'https://www.facebook.com/profile.php?id=invalid';
  assert.equal(observeFacebookComposerSurface(p, 'zh_CN'), null);
});

test('localized profile review and Reels phases accept locale aliases without treating Next as publish', () => {
  for (const [locale, post, settings, reelEdit, reelSettings, next] of [
    ['zh-Hans', '发帖', '帖子设置', '编辑 Reels', 'Reels 设置', '下一步'],
    ['zh-Hant', '發佈', '貼文設定', '編輯 Reels', 'Reels 設定', '下一步'],
    ['en', 'Post', 'Post settings', 'Edit reel', 'Reel settings', 'Next'],
  ] as const) {
    const p = composer();
    p.url = 'https://www.facebook.com/profile.php?id=10000000000001';
    row(p, 'composerReviewDialogs').nodes.push(element('div'));
    row(p, 'composerReviewHeadings').nodes.push(element('h2', {}, true, settings));
    row(p, 'composerReviewSubmits').nodes.push(element('div', { 'aria-label': post }));
    assert.equal(observeFacebookComposerSurface(p, locale)?.phase, 'review-before-submit');
    row(p, 'composerReviewHeadings').nodes[0]!.text = reelEdit;
    row(p, 'composerReviewSubmits').nodes[0]!.attributes['aria-label'] = next;
    assert.equal(observeFacebookComposerSurface(p, locale)?.phase, 'reel-edit-before-review');
    assert.equal(observeFacebookComposerSurface(p, locale)?.submit, null);
    row(p, 'composerReviewHeadings').nodes[0]!.text = reelSettings;
    row(p, 'composerReviewSubmits').nodes[0]!.attributes['aria-label'] = post;
    const result = observeFacebookComposerSurface(p, locale);
    assert.equal(result?.phase, 'reel-review-before-submit');
    assert.equal(result?.actingIdentityVerified, false);
  }
});
