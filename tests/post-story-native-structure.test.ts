import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { projectFacebookComposerAudience } from '../src/infrastructure/facebook-composer-audience.js';
import { projectFacebookSubmissionAudience } from '../src/infrastructure/facebook-submission-audience.js';
import { projectFacebookStoryPage } from '../src/infrastructure/facebook-story-page-reader.js';
import { audienceTarget } from '../src/domain/facebook-audience.js';
import {
  ComposerAudienceReading,
  clearAudienceDefaultTarget,
} from '../src/shared/facebook-audience.js';

function dom(html: string, run: () => void, route = '/') {
  const win = new Window({ url: 'https://www.facebook.com' + route, width: 1280, height: 900 });
  win.document.body.innerHTML = html;
  Object.defineProperty(win.document, 'readyState', { value: 'complete', configurable: true });
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  win.HTMLElement.prototype.getBoundingClientRect = () => new win.DOMRect(20, 80, 500, 400);
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    location: win.location,
    innerWidth: 1280,
    innerHeight: 900,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    run();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    win.close();
  }
}
function attach(css: string, rows: { name: string; props?: Record<string, unknown> }[], depth = 0) {
  let fiber: unknown = null;
  for (const row of rows.toReversed())
    fiber = {
      type: Object.assign(function fixture() {}, { displayName: row.name }),
      memoizedProps: row.props ?? {},
      return: fiber,
    };
  for (let i = 0; i < depth; i++) fiber = { type: 'div', memoizedProps: {}, return: fiber };
  const el = document.querySelector(css);
  assert.ok(el, css);
  Reflect.set(el, '__reactFiber$fixture', fiber);
}

for (const route of ['/', '/post/create/'])
  test(`current draft privacy drives configuration and final verification across languages on ${route}`, () =>
    dom(
      `<${route === '/' ? 'section role="dialog"' : 'main role="main"'}><form><div role="textbox" contenteditable="true">Draft</div><button role="button" id="privacy">任意ภาษา</button></form></${route === '/' ? 'section' : 'main'}>`,
      () => {
        const privacy = { base_state: 'SELF', allow: [], deny: [] };
        attach('#privacy', [
          {
            name:
              route === '/'
                ? 'CometComposerPrivacySelectorButton.react'
                : 'CometCreatorComposerPrivacySelectorEntryPointButton.react',
            props: { privacyRowInput: privacy },
          },
        ]);
        let current = projectFacebookComposerAudience();
        assert.equal(current.audience, 'SELF');
        assert.equal(projectFacebookSubmissionAudience(current).audience, 'SELF');
        privacy.base_state = 'EVERYONE';
        current = projectFacebookComposerAudience();
        assert.equal(current.audience, null);
        assert.equal(projectFacebookSubmissionAudience(current).audience, null);
        privacy.base_state = 'SELF';
        privacy.allow.push('unexpected' as never);
        assert.equal(projectFacebookComposerAudience().audience, null);
      },
      route,
    ));

test('deep native basic Self and footer checkbox are read without translated labels or a made-up input value', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div></form><section role="dialog" id="menu"><div role="radiogroup"><label><input id="self" type="radio" checked>ภาษา</label><label><input id="custom" type="radio">Custom</label></div><label><input id="default" type="checkbox" checked>任意</label><button role="button" id="done">完了</button></section></section>',
    () => {
      attach(
        '#self',
        [
          { name: 'CometPrivacySelectorOptionBasic.react' },
          {
            name: 'CometPrivacySelectorOption.react',
            props: { option: { info_type: 'BASIC', post_param: '286958161406148' } },
          },
        ],
        75,
      );
      attach('#custom', [
        { name: 'CometPrivacySelectorOptionFullCustom.react' },
        {
          name: 'CometPrivacySelectorOption.react',
          props: { option: { info_type: 'BASIC', post_param: '286958161406148' } },
        },
      ]);
      attach('#default', [
        { name: 'FDSCheckbox.react' },
        { name: 'CometDefaultPrivacySelectorPickerFooter.react' },
      ]);
      attach('#done', [
        { name: 'FDSButton.react', props: { type: 'primary' } },
        {
          name: 'CometPrivacySelectorPickerFooter.react',
          props: { showsDefaultAudienceCheckbox: true },
        },
      ]);
      let reading = ComposerAudienceReading.parse(projectFacebookComposerAudience());
      assert.equal(reading.phase, 'MENU');
      assert.equal(reading.selfSelected, true);
      assert.equal(reading.defaultChecked, true);
      assert.deepEqual(audienceTarget(reading, 'CONFIRM_AUDIENCE'), clearAudienceDefaultTarget);
      (document.querySelector('#default') as HTMLInputElement).checked = false;
      reading = ComposerAudienceReading.parse(projectFacebookComposerAudience());
      assert.ok(audienceTarget(reading, 'CONFIRM_AUDIENCE'));
      document.querySelector('#self')?.remove();
      reading = ComposerAudienceReading.parse(projectFacebookComposerAudience());
      assert.equal(reading.selfAvailable, false);
      assert.equal(reading.selfSelected, false);
    },
  ));

test('no default checkbox is accepted only when the native footer explicitly omits it', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div></form><div role="radiogroup"><label><input id="self" type="radio" checked>任意</label></div><button role="button" id="done">Done</button></section>',
    () => {
      attach('#self', [
        { name: 'CometPrivacySelectorOptionBasic.react' },
        {
          name: 'CometPrivacySelectorOption.react',
          props: { option: { post_param: '286958161406148' } },
        },
      ]);
      attach('#done', [
        { name: 'FDSButton.react', props: { type: 'primary' } },
        {
          name: 'CometPrivacySelectorPickerFooter.react',
          props: { showsDefaultAudienceCheckbox: false },
        },
      ]);
      assert.equal(projectFacebookComposerAudience().defaultChecked, false);
      attach('#done', [{ name: 'FDSButton.react', props: { type: 'primary' } }]);
      assert.equal(projectFacebookComposerAudience().defaultChecked, null);
    },
  ));

for (const fallbackOnly of [false, true])
  test(`story control pane excludes breadcrumbs and duplicate fallback buttons; fallback-only=${fallbackOnly}`, () =>
    dom(
      '<section id="creator"><nav role="navigation" id="crumb">Breadcrumb</nav><aside><button role="button" id="privacy"><svg id="settings"></svg></button><button role="button" id="submit">任意</button></aside><main role="main" id="preview"><div role="textbox" contenteditable="true" id="text"></div></main></section>' +
        (fallbackOnly
          ? ''
          : '<section><button role="button" id="fallbackPrivacy"><svg id="fallbackIcon"></svg></button><button role="button" id="fallbackSubmit">任意</button></section>'),
      () => {
        const owner = {
          name: fallbackOnly ? 'StoriesCreateFallbackRenderer.react' : 'StoriesCreate.react',
        };
        for (const css of ['#crumb', '#preview', '#privacy']) attach(css, [owner]);
        attach('#settings', [{ name: 'FBNucleusSettingsFilled20Icon.react' }, owner]);
        attach('#submit', [{ name: 'FDSButton.react', props: { disabled: false } }, owner]);
        attach('#text', [{ name: 'StoriesCreateSATPPreview.react' }, owner]);
        if (!fallbackOnly) {
          attach('#fallbackPrivacy', [{ name: 'StoriesCreateFallbackRenderer.react' }, owner]);
          attach('#fallbackIcon', [
            { name: 'FBNucleusSettingsFilled20Icon.react' },
            { name: 'StoriesCreateFallbackRenderer.react' },
            owner,
          ]);
          attach('#fallbackSubmit', [
            { name: 'FDSButton.react', props: { disabled: false } },
            { name: 'StoriesCreateFallbackRenderer.react' },
            owner,
          ]);
        }
        const reading = projectFacebookStoryPage();
        assert.equal(reading.phase, 'text-editor');
        assert.equal(reading.submit?.enabled, true);
        assert.equal(reading.privacy?.phase, 'CLOSED');
        assert.equal(document.querySelector('#submit')?.getAttribute('data-wb-story-submit'), '1');
        assert.equal(document.querySelector('#crumb')?.getAttribute('data-wb-story-form'), null);
        assert.equal(reading.fontCSS, null);
      },
      '/stories/create/',
    ));

test('native media text-overlay tool dialog does not impersonate a privacy modal across languages', () =>
  dom(
    '<section><aside><button role="button" id="privacy"><svg id="settings"></svg></button><button role="button" id="submit">任意</button></aside><main role="main" id="preview"><div role="textbox" contenteditable="true" id="text"></div><section role="dialog" aria-label="任意ภาษา" id="tools"></section></main></section>',
    () => {
      const owner = { name: 'StoriesCreate.react' };
      for (const css of ['#preview', '#privacy', '#text']) attach(css, [owner]);
      attach('#settings', [{ name: 'FBNucleusSettingsFilled20Icon.react' }, owner]);
      attach('#submit', [{ name: 'FDSButton.react', props: { disabled: false } }, owner]);
      attach('#tools', [{ name: 'StoriesCreateTextOverlayEditingTools.react' }, owner]);
      assert.equal(projectFacebookStoryPage().privacy?.phase, 'CLOSED');
      attach('#tools', [{ name: 'UnrelatedModal.react' }, owner]);
      assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
    },
    '/stories/create/',
  ));
test('closed privacy picker retained inside the composer is not an open audience menu', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div><button role="button" id="privacy"></button><label style="display:none"><input type="radio" id="old-self" checked></label><button role="button" id="publish" aria-disabled="true">Post</button></form></section>',
    () => {
      attach('#privacy', [
        { name: 'CometComposerPrivacySelectorButton.react', props: {} },
        {
          name: 'CometPrivacySelectorEntryPointMatchContainer.react',
          props: { privacyRowInput: { base_state: 'SELF', allow: [], deny: [] } },
        },
      ]);
      attach('#old-self', [
        { name: 'CometPrivacySelectorOptionBasic.react' },
        {
          name: 'CometPrivacySelectorOption.react',
          props: { option: { post_param: '286958161406148', info_type: 'BASIC' } },
        },
      ]);
      attach('#publish', [
        { name: 'FDSButton.react', props: { variant: 'primary', disabled: true } },
      ]);
      const result = projectFacebookComposerAudience();
      assert.equal(result.phase, 'COMPOSER');
      assert.equal(result.audience, 'SELF');
    },
  ));
test('current composer draft privacy outranks entry-point initial privacy and stale local props', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div><button role="button" id="privacy"></button></form></section>',
    () => {
      attach('#privacy', [
        { name: 'CometComposerPrivacySelectorButton.react' },
        {
          name: 'CometPrivacySelectorEntryPointMatchContainer.react',
          props: { privacyRowInput: { base_state: 'EVERYONE', allow: [], deny: [] } },
        },
        { name: '_', props: { localPrivacyRow: { base_state: 'EVERYONE', allow: [], deny: [] } } },
        {
          name: 'CometComposerViewStateContext',
          props: { value: { audience: { privacy: { base_state: 'SELF', allow: [], deny: [] } } } },
        },
      ]);
      assert.equal(projectFacebookComposerAudience().audience, 'SELF');
    },
  ));
test('native localPrivacyRow is used before initial privacyRowInput when no composer context is exposed', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div><button role="button" id="privacy"></button></form></section>',
    () => {
      attach('#privacy', [
        { name: 'CometComposerPrivacySelectorButton.react' },
        { name: '_', props: { privacyRowInput: { base_state: 'EVERYONE', allow: [], deny: [] } } },
        { name: '_', props: { localPrivacyRow: { base_state: 'SELF', allow: [], deny: [] } } },
      ]);
      assert.equal(projectFacebookComposerAudience().audience, 'SELF');
    },
  ));

test('native Story audience change confirmation uses dispatcher and footer identities across languages', () =>
  dom(
    '<section><aside><button role="button" id="privacy"><svg id="settings"></svg></button><button role="button" id="submit">任意</button></aside><main role="main" id="preview"><div role="textbox" contenteditable="true" id="text"></div></main><section role="dialog" id="change"><button role="button" id="save">任意</button><button role="button" id="cancel">อื่น</button></section></section>',
    () => {
      const owner = { name: 'StoriesCreate.react' };
      for (const css of ['#preview', '#privacy', '#text']) attach(css, [owner]);
      attach('#settings', [{ name: 'FBNucleusSettingsFilled20Icon.react' }, owner]);
      attach('#submit', [{ name: 'FDSButton.react', props: { disabled: false } }, owner]);
      attach('#change', [
        { name: 'FDSConfirmationDialogImpl.react' },
        { name: 'StoriesComposerDispatcherBridge.react' },
        owner,
      ]);
      attach('#save', [
        {
          name: 'FDSButton.react',
          props: { testid: 'CometConfirmationDialogConfirmButton', disabled: false },
        },
        owner,
      ]);
      attach('#cancel', [
        {
          name: 'FDSButton.react',
          props: {
            testid: 'CometConfirmationDialogCancelButton',
            type: 'secondary',
            disabled: false,
          },
        },
        owner,
      ]);
      const reading = projectFacebookStoryPage();
      assert.equal(reading.privacy?.phase, 'CHANGE_CONFIRMATION');
      assert.equal(reading.privacy?.saveEnabled, true);
      assert.equal(reading.privacy?.cancelEnabled, true);
      const pane = document.querySelector<HTMLElement>('aside');
      assert.ok(pane);
      pane.style.display = 'none';
      assert.equal(projectFacebookStoryPage().privacy?.phase, 'CHANGE_CONFIRMATION');
      attach('#change', [
        { name: 'FDSConfirmationDialogImpl.react' },
        { name: 'UnrelatedDispatcher.react' },
      ]);
      assert.equal(projectFacebookStoryPage().privacy?.phase, 'UNAVAILABLE');
      assert.equal(
        document.querySelector('#change')?.getAttribute('data-wb-story-privacy-change'),
        null,
      );
    },
    '/stories/create/',
  ));
