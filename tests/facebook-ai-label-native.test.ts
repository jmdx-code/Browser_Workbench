import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { projectFacebookAILabel } from '../src/infrastructure/facebook-ai-label-reader.js';
import {
  facebookAILabelReading,
  facebookAILabelScope,
  facebookAILabelSwitch,
} from '../src/shared/facebook-ai-label.js';
import { decidePostAILabel } from '../src/domain/facebook-ai-label.js';

function dom(html: string, run: () => void, route = '/') {
  const win = new Window({ url: 'https://www.facebook.com' + route, width: 1280, height: 900 });
  win.document.body.innerHTML = html;
  Object.defineProperty(win.document, 'readyState', { value: 'complete', configurable: true });
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  win.HTMLElement.prototype.getBoundingClientRect = () => new win.DOMRect(20, 2000, 500, 40);
  const values = {
    window: win,
    document: win.document,
    location: win.location,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    win.close();
  }
}
function attach(css: string, rows: { name?: string; props: Record<string, unknown> }[]) {
  let f: unknown = null;
  for (const r of rows.toReversed())
    f = {
      type: Object.assign(function fixture() {}, { displayName: r.name ?? '_' }),
      memoizedProps: r.props,
      return: f,
    };
  const el = document.querySelector(css);
  assert.ok(el);
  Reflect.set(el, '__reactFiber$fixture', f);
}
const read = () =>
  facebookAILabelReading.parse(
    projectFacebookAILabel({ scope: facebookAILabelScope, switchCSS: facebookAILabelSwitch }),
  );
const metadata = (value: boolean) => ({ isSelfDisclosedAsGenAI: value });
const fragment = (name: string) => ({ __fragments: { [name]: {} } });

for (const value of [false, true]) {
  test(`personal composer uses native draft ${value}, independent of label and stale child props`, () =>
    dom(
      '<section role="dialog"><button role="button" id="other">other</button><button role="button" id="ai" aria-label="任意ภาษา"></button></section>',
      () => {
        attach('#other', [{ props: { selectors: { genAILabelSelector: {} } } }]);
        attach('#ai', [
          {
            props: {
              cometComposerGenAILabelSelector_viewer$key: fragment(
                'CometComposerGenAILabelSelector_viewer',
              ),
              genAISelfDisclosureMetadata: metadata(!value),
            },
          },
          {
            name: 'CometComposerViewStateContext',
            props: { value: { genAISelfDisclosureMetadata: metadata(value) } },
          },
        ]);
        const r = read();
        assert.equal(r.phase, 'composer');
        assert.equal(r.mode, 'dialog');
        assert.equal(r.value, value);
        assert.equal(document.querySelectorAll(facebookAILabelScope + ' ' + r.openCSS).length, 1);
      },
    ));
  for (const story of [false, true])
    test(`${story ? 'story' : 'creator'} inline ${value} excludes boost and marks a fresh native target below the viewport`, () =>
      dom(
        '<main role="main"><div><button role="switch" id="boost" aria-checked="false"></button></div><div><button role="switch" id="ai"></button></div><i id="old" data-wb-ai-label-switch="1"></i></main>',
        () => {
          document.querySelector('#ai')!.setAttribute('aria-checked', String(value));
          attach('#boost', [
            { props: { option: fragment('CometCreatorComposerBoostOption_option') } },
          ]);
          const field = story ? 'genAISelfDisclosureData' : 'genAISelfDisclosureMetadata';
          attach('#ai', [
            { name: 'FDSSwitch.react', props: { value } },
            {
              props: story
                ? { viewer: fragment('StoriesCometGenAILabelSelector_viewer') }
                : { option: fragment('CometCreatorComposerGenAILabelOption_option') },
            },
            { props: { value: { [field]: metadata(value) } } },
          ]);
          const r = read();
          assert.equal(r.phase, 'composer');
          assert.equal(r.mode, 'inline');
          assert.equal(r.value, value);
          assert.equal(document.querySelectorAll(facebookAILabelSwitch).length, 1);
          assert.equal(document.querySelector(facebookAILabelSwitch)?.id, 'ai');
          assert.equal(
            document.querySelector('#boost')!.hasAttribute('data-wb-ai-label-switch'),
            false,
          );
          const d = decidePostAILabel(value ? 'off' : 'on', r, () => false);
          assert.equal(d.kind === 'action' && d.purpose, 'SET_AI_LABEL');
          assert.equal(decidePostAILabel(value ? 'on' : 'off', r, () => false).kind, 'ready');
        },
        story ? '/stories/create/' : '/post/create',
      ));
}
test('native AI push-page confirms only its own footer while composer draft still has the old value', () =>
  dom(
    '<section role="dialog"><button role="button" id="publish">Publish</button><div id="settings"><button role="switch" id="toggle" aria-checked="true"></button><button role="button" id="done">任意</button></div></section>',
    () => {
      const owner = { name: 'CometComposerGenAILabelSelector.react', props: {} };
      attach('#toggle', [
        { name: 'FDSSwitch.react', props: { value: true } },
        owner,
        {
          name: 'CometComposerViewStateContext',
          props: { value: { genAISelfDisclosureMetadata: metadata(false) } },
        },
      ]);
      attach('#done', [
        { name: 'FDSButton.react', props: { testid: 'gen-ai-label-push-page-footer' } },
        owner,
      ]);
      const r = read();
      assert.equal(r.phase, 'settings');
      assert.equal(r.value, true);
      assert.equal(document.querySelector('[data-wb-ai-label-confirm="1"]')?.id, 'done');
      assert.equal(
        document.querySelector('#publish')!.hasAttribute('data-wb-ai-label-confirm'),
        false,
      );
    },
  ));
test('missing controls, unrelated switches and untranslated text do not invent AI off', () =>
  dom(
    '<main role="main"><button role="switch" aria-label="AI label" aria-checked="false"></button></main>',
    () => {
      assert.equal(read().phase, 'absent');
      assert.equal(read().value, null);
      assert.throws(
        () => decidePostAILabel('off', read(), () => false),
        /CONFIGURATION_UNAVAILABLE/,
      );
    },
  ));
test('committed native AI switch is read instead of an old cached context value', () =>
  dom(
    '<main role="main"><button role="switch" id="ai" aria-checked="false"></button></main>',
    () => {
      attach('#ai', [
        { props: { option: fragment('CometCreatorComposerGenAILabelOption_option') } },
        { props: { value: { genAISelfDisclosureMetadata: metadata(true) } } },
      ]);
      assert.equal(read().phase, 'composer');
      assert.equal(read().value, false);
    },
  ));
test('multiple native AI controls cannot select an arbitrary target', () =>
  dom(
    '<main><button role="switch" id="a" aria-checked="false"></button><button role="switch" id="b" aria-checked="false"></button></main>',
    () => {
      for (const id of ['a', 'b'])
        attach('#' + id, [
          { props: { option: fragment('CometCreatorComposerGenAILabelOption_option') } },
        ]);
      assert.equal(read().phase, 'ambiguous');
      assert.equal(document.querySelectorAll(facebookAILabelSwitch).length, 0);
    },
  ));
test('known personal selector initial undefined state is observed off, not an absent-control fallback', () =>
  dom('<section role="dialog"><button role="button" id="ai"></button></section>', () => {
    attach('#ai', [
      {
        props: {
          cometComposerGenAILabelSelector_viewer$key: {},
          genAISelfDisclosureMetadata: undefined,
        },
      },
    ]);
    assert.equal(read().value, false);
    assert.equal(read().phase, 'composer');
  }));
import {
  projectFacebookReelContent,
  readFacebookReelContent,
} from '../src/infrastructure/facebook-reel-reader.js';
import type { Page } from 'playwright-core';

test('creator media form does not become a Reels editor merely because it is in a dialog', () =>
  dom(
    '<section role="dialog"><main role="main"><form role="form" aria-label="native form"><h2>Photo editor</h2><button role="button" aria-label="发布"></button></form></main></section>',
    () => {
      const r = projectFacebookReelContent();
      assert.equal(r.found, false);
      assert.equal(r.phase, null);
    },
    '/post/create',
  ));
test('actual profile Reels edit stage still has explicit structural stage evidence', () =>
  dom(
    '<section role="dialog"><main role="main"><form role="form" aria-label="native form"><h2>Edit Reels</h2><button role="button" aria-label="Next"></button></form></main></section>',
    () => {
      const r = projectFacebookReelContent();
      assert.equal(r.found, true);
      assert.equal(r.phase, 'reel-edit-before-review');
    },
    '/profile.php?id=123456',
  ));
test('native Reels route guard rejects wrong route while unrelated creator form is allowed through', async () => {
  const value = {
    url: 'https://www.facebook.com/post/create',
    timeOrigin: 1,
    found: false,
    phase: null as string | null,
    composer: null,
  };
  const page = { evaluate: async () => ({ ...value }) } as unknown as Page;
  assert.equal((await readFacebookReelContent(page, () => {})).found, false);
  value.found = true;
  value.phase = 'reel-edit-before-review';
  await assert.rejects(
    readFacebookReelContent(page, () => {}),
    /REEL_ROUTE_UNVERIFIED/,
  );
  value.url = 'https://www.facebook.com/profile.php?id=123456';
  assert.equal((await readFacebookReelContent(page, () => {})).found, true);
});
test('current Fiber alternate is used instead of old memoized switch props', () =>
  dom(
    '<main role="main"><button role="switch" id="ai" aria-checked="false"></button></main>',
    () => {
      const props = { option: fragment('CometCreatorComposerGenAILabelOption_option') };
      const currentRoot: { return: null; stateNode?: unknown } = { return: null };
      currentRoot.stateNode = { current: currentRoot };
      const oldRoot = { return: null, stateNode: currentRoot.stateNode };
      const old = {
        type: Object.assign(function old() {}, { displayName: 'FDSSwitch.react' }),
        memoizedProps: { value: true, ...props },
        return: oldRoot,
        alternate: null as unknown,
      };
      const fresh = {
        type: old.type,
        memoizedProps: { value: false, ...props },
        return: currentRoot,
        alternate: old,
      };
      old.alternate = fresh;
      Reflect.set(document.querySelector('#ai')!, '__reactFiber$fixture', old);
      assert.equal(read().value, false);
      assert.equal(read().phase, 'composer');
    },
  ));
test('native committed AI switch outranks stale FDSSwitch child props during a settings change', () =>
  dom(
    '<section><button role="switch" id="ai" aria-checked="true"></button><button role="button" id="done"></button></section>',
    () => {
      const owner = { name: 'CometComposerGenAILabelSelector.react', props: {} };
      attach('#ai', [{ name: 'FDSSwitch.react', props: { value: false } }, owner]);
      attach('#done', [{ props: { testid: 'gen-ai-label-push-page-footer' } }, owner]);
      assert.equal(read().phase, 'settings');
      assert.equal(read().value, true);
    },
  ));
import { projectFacebookPostEffects } from '../src/infrastructure/facebook-post-effect-reader.js';
test('creator video thumbnail in its own attachment card is not a second uploaded image', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div><input type="file" multiple accept="image/*,video/*"><div role="form"><div role="list"><div role="listitem"><img alt="video thumbnail"><span>0:12</span><button role="button" aria-label="移除视频"></button></div></div></div><button role="button" aria-label="发布"></button></form></section>',
    () => {
      const r = projectFacebookPostEffects();
      assert.ok(r.composer);
      assert.deepEqual(
        r.composer.media.map((m) => m.kind),
        ['video'],
      );
      const video = r.composer.media[0];
      assert.ok(video && video.kind === 'video');
      assert.equal(video.durationSeconds, 12);
      assert.equal(r.composer.media[0]?.ready, false);
    },
    '/post/create',
  ));
test('a photo in another list item is retained beside a video card so mixed input cannot masquerade as one video', () =>
  dom(
    '<section role="dialog"><form><div role="textbox" contenteditable="true"></div><input type="file" multiple accept="image/*,video/*"><div role="form"><div role="list"><div role="listitem"><img alt="thumbnail"><span>0:12</span><button role="button" aria-label="移除视频"></button></div><div role="listitem"><img alt="original.png"></div></div></div><button role="button" aria-label="发布"></button></form></section>',
    () => {
      const r = projectFacebookPostEffects();
      assert.deepEqual(
        r.composer?.media.map((m) => m.kind),
        ['image', 'video'],
      );
    },
    '/post/create',
  ));
