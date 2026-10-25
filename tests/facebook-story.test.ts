import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import {
  projectFacebookStoryPage,
  readFacebookStoryPage,
  FacebookStoryPage,
} from '../src/infrastructure/facebook-story-page-reader.js';
import { StepSchema } from '../src/shared/contracts.js';
import { randomUUID } from 'node:crypto';
import { resourceSupportsDestination } from '../src/domain/resource-table.js';

function fixture(run: (nodes: Map<string, unknown[]>) => void) {
  const nodes = new Map<string, unknown[]>();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const url = new URL('https://www.facebook.com/stories/create/');
  for (const [key, value] of Object.entries({
    location: url,
    innerWidth: 1280,
    innerHeight: 900,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      documentElement: { lang: 'zh-Hans' },
      querySelectorAll: (css: string) => nodes.get(css) ?? [],
    },
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try {
    run(nodes);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const node = (text = '', attributes: Record<string, string> = {}, disabled = false) => ({
  innerText: text,
  textContent: text,
  getAttribute: (key: string) => attributes[key] ?? null,
  getBoundingClientRect: () => ({
    width: 200,
    height: 80,
    left: 10,
    top: 10,
    right: 210,
    bottom: 90,
  }),
  matches: () => disabled,
  querySelectorAll: () => [],
});

test('only the observed unnamed story editor shell is excluded from privacy blockers', () =>
  fixture((nodes) => {
    document.documentElement.lang = 'en';
    nodes.set(
      '[role="navigation"][aria-label="Stories Creation Form"] [role="button"][aria-label="Story privacy settings"]',
      [node()],
    );
    let forms = 1,
      previews = 1;
    const shell = {
      ...node(),
      querySelectorAll: (css: string) =>
        Array.from(
          {
            length: css.includes('Stories Creation Form')
              ? forms
              : css.includes('Stories Creation Preview')
                ? previews
                : 0,
          },
          () => node(),
        ),
    };
    nodes.set('[role="dialog"]', [shell]);
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'CLOSED');
    nodes.set('[role="dialog"]', [shell, node()]);
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
    nodes.set('[role="dialog"]', [shell]);
    forms = 2;
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
    forms = 1;
    previews = 0;
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
  }));
test('story projection distinguishes native single-file entry from text editor; no actor or publication is inferred', () =>
  fixture((nodes) => {
    nodes.set('input[type="file"]:not([multiple])[accept*="image/"][accept*="video/"]', [node()]);
    const entry = FacebookStoryPage.parse(projectFacebookStoryPage());
    assert.equal(entry.phase, 'entry');
    assert.ok(entry.mediaCSS);
    assert.equal(entry.submit, null);
    nodes.clear();
    nodes.set('[role="textbox"][contenteditable="true"]', [node('生成快拍正文')]);
    nodes.set('[role="button"][aria-label="分享到快拍"]', [node('', {}, true)]);
    nodes.set('[role="combobox"][aria-label="字体样式"]', [node()]);
    nodes.set('[role="switch"][aria-label="添加 AI 标签"]', [
      node('', { 'aria-checked': 'false' }),
    ]);
    const read = FacebookStoryPage.parse(projectFacebookStoryPage());
    assert.equal(read.phase, 'text-editor');
    assert.equal(read.text, '生成快拍正文');
    assert.equal(read.submit?.enabled, false);
    assert.equal(read.ai?.checked, false);
    assert.equal('actor' in read, false);
    assert.equal('postId' in read, false);
    nodes.set('[role="textbox"][contenteditable="true"]', [node(), node()]);
    assert.equal(projectFacebookStoryPage().phase, 'ambiguous');
    assert.equal(projectFacebookStoryPage().submit, null);
  }));
test('observed English story labels identify only unique native controls, never a publication result', () =>
  fixture((nodes) => {
    document.documentElement.lang = 'en';
    nodes.set('[role="textbox"][contenteditable="true"]', [node()]);
    const submit =
      '[role="navigation"][aria-label="Stories Creation Form"] [role="button"][aria-label="Share to story"]';
    nodes.set(submit, [node('', {}, true)]);
    nodes.set('[role="combobox"][aria-label="Font style"]', [node()]);
    nodes.set('[role="switch"][aria-label="Add AI label"]', [
      node('', { 'aria-checked': 'false' }),
    ]);
    const page = FacebookStoryPage.parse(projectFacebookStoryPage());
    assert.equal(page.phase, 'text-editor');
    assert.equal(page.submit?.enabled, false);
    assert.equal(page.ai?.checked, false);
    assert.ok(page.fontCSS);
    assert.equal('postId' in page, false);
    nodes.set(submit, [node(), node()]);
    assert.equal(projectFacebookStoryPage().submit, null);
  }));

test('native empty paragraph is empty and floating duplicate controls do not replace the creation form', () =>
  fixture((nodes) => {
    document.documentElement.lang = 'en';
    const editor = { ...node('\n'), textContent: '' };
    nodes.set('[role="textbox"][contenteditable="true"]', [editor]);
    const prefix = '[role="navigation"][aria-label="Stories Creation Form"] ';
    nodes.set('[role="button"][aria-label="Story privacy settings"]', [node(), node()]);
    nodes.set(prefix + '[role="button"][aria-label="Story privacy settings"]', [node()]);
    nodes.set(prefix + '[role="button"][aria-label="Share to story"]', [node('', {}, true)]);
    const reading = projectFacebookStoryPage();
    assert.equal(reading.text, '');
    assert.equal(reading.privacy?.openEnabled, true);
    assert.equal(reading.submit?.enabled, false);
    editor.textContent = ' ';
    assert.equal(projectFacebookStoryPage().text, '\n');
    nodes.set(prefix + '[role="button"][aria-label="Story privacy settings"]', [node(), node()]);
    assert.equal(projectFacebookStoryPage().privacy?.openEnabled, false);
  }));

test('native privacy warning is not a selected or saved Friends audience', () =>
  fixture((nodes) => {
    document.documentElement.lang = 'en';
    nodes.set('[role="textbox"][contenteditable="true"]', [node()]);
    const menu = node();
    const change = {
      ...node(
        'Changes you make will apply to any photos and videos currently in your story in addition to those you add from now on',
      ),
      querySelectorAll: (css: string) =>
        css.includes('Save') || css.includes('Cancel') ? [node()] : [],
    };
    nodes.set('[role="dialog"]', [menu, change]);
    nodes.set('[role="dialog"][aria-label="Story privacy"]', [menu]);
    nodes.set('[role="dialog"][aria-label="Change story privacy"]', [change]);
    const reading = projectFacebookStoryPage();
    assert.equal(reading.privacy?.phase, 'CHANGE_CONFIRMATION');
    assert.equal(reading.privacy?.draftSelection, null);
    assert.equal(reading.privacy?.saveEnabled, true);
    change.textContent = 'Unrecognized warning';
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
  }));

test('document language does not suppress an observed unique story control', () =>
  fixture((nodes) => {
    nodes.set('[role="textbox"][contenteditable="true"]', [node()]);
    nodes.set('[role="button"][aria-label="分享到快拍"]', [node()]);
    document.documentElement.lang = 'ar';
    const value = projectFacebookStoryPage();
    assert.equal(value.phase, 'text-editor');
    assert.equal(value.submit?.enabled, true);
    assert.equal(value.ai, null);
    globalThis.location.pathname = '/';
    assert.equal(projectFacebookStoryPage().phase, 'ambiguous');
  }));

test('story privacy reads only the native checked draft; duplicate controls and conflicting checked state stay unavailable', () =>
  fixture((nodes) => {
    document.documentElement.lang = 'en';
    const dialogCSS = '[role="dialog"][aria-label="Story privacy"]';
    const radioLabels = [
      'PublicAnyone on Facebook or Messenger',
      'FriendsOnly your Facebook friends',
      'CustomChoose people to show your story to',
    ];
    const radios = radioLabels.map((label, i) => ({
      ...node('', { 'aria-checked': String(i === 0) }),
      checked: i === 0,
      labels: [{ textContent: label }],
    }));
    const controls = new Map<string, unknown[]>([
      ['input[type="radio"]', radios],
      ['[role="button"][aria-label="Save"]', [node()]],
      ['[role="button"][aria-label="Cancel"]', [node()]],
    ]);
    const dialog = { ...node(), querySelectorAll: (css: string) => controls.get(css) ?? [] };
    nodes.set(
      '[role="navigation"][aria-label="Stories Creation Form"] [role="button"][aria-label="Story privacy settings"]',
      [node()],
    );
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'CLOSED');
    assert.equal(projectFacebookStoryPage().privacy?.draftSelection, null);
    nodes.set('[role="dialog"]', [dialog]);
    nodes.set(dialogCSS, [dialog]);
    const reading = FacebookStoryPage.parse(projectFacebookStoryPage());
    assert.equal(reading.privacy?.phase, 'MENU');
    assert.equal(reading.privacy?.draftSelection, 'PUBLIC');
    assert.equal(reading.privacy?.friendsEnabled, true);
    assert.equal('audience' in reading, false);
    controls.set('[role="button"][aria-label="Save"]', [node(), node()]);
    assert.equal(projectFacebookStoryPage().privacy?.saveEnabled, false);
    radios[1]!.checked = true;
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
    radios[1]!.checked = false;
    radios[1]!.labels = [{ textContent: 'Unknown option' }];
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
    nodes.set('[role="dialog"]', [dialog, node()]);
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
    document.documentElement.lang = 'ar';
    assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
  }));
test('story read keeps both owner guards; saved destination and resource purposes retain old post compatibility', async () => {
  let value: unknown;
  fixture(() => {
    value = projectFacebookStoryPage();
  });
  const page = { evaluate: async () => value } as unknown as Page;
  let guards = 0;
  await assert.rejects(
    readFacebookStoryPage(page, () => {
      if (++guards === 2) throw Error('OWNER_REVOKED');
    }),
    /OWNER_REVOKED/,
  );
  const step = {
    id: randomUUID(),
    type: 'post',
    destination: 'story',
    resourceMode: 'table',
    resourceDirectory: '',
    count: 2,
    allowRepeat: true,
    forbidSameAccountRepeat: true,
    archivePublished: false,
  };
  assert.equal(StepSchema.parse(step).type, 'post');
  const row = { id: randomUUID(), text: '生成', media: [], background: 'plain' as const };
  assert.equal(resourceSupportsDestination(row, 'post'), true);
  assert.equal(resourceSupportsDestination(row, 'story'), false);
  assert.equal(resourceSupportsDestination({ ...row, purpose: 'both' }, 'story'), true);
});
