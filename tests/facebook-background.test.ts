import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FacebookBackground,
  facebookBackgroundScope,
  FACEBOOK_BACKGROUND_OPTIONS,
  FACEBOOK_NO_BACKGROUND,
  nativeSolidBackgrounds,
  nativeBackgroundCSS,
} from '../src/shared/facebook-background.js';
import { projectFacebookBackground } from '../src/infrastructure/facebook-background-reader.js';

class FixtureNode {
  parentElement: FixtureNode | null = null;
  textContent = '';
  backgroundColor = 'rgba(0, 0, 0, 0)';
  backgroundImage = 'none';
  disabled = false;
  nodes = new Map<string, FixtureNode[]>();
  getBoundingClientRect() {
    return { width: 500, height: 347, top: 10, left: 10, right: 510, bottom: 357 };
  }
  matches() {
    return this.disabled;
  }
  querySelector() {
    return null;
  }
  querySelectorAll(css: string) {
    return this.nodes.get(css) ?? [];
  }
}
function fixture(run: (root: FixtureNode, editor: FixtureNode, painter: FixtureNode) => void) {
  const root = new FixtureNode(),
    editor = new FixtureNode(),
    painter = new FixtureNode();
  editor.parentElement = painter;
  painter.parentElement = root;
  root.nodes.set('[role="textbox"][contenteditable="true"]', [editor]);
  root.nodes.set(FACEBOOK_BACKGROUND_OPTIONS, [new FixtureNode()]);
  root.nodes.set(FACEBOOK_NO_BACKGROUND, [new FixtureNode()]);
  for (const solid of nativeSolidBackgrounds)
    root.nodes.set(nativeBackgroundCSS(solid.label), [new FixtureNode()]);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    location: new URL('https://www.facebook.com/'),
    innerWidth: 1280,
    innerHeight: 900,
    getComputedStyle: (node: FixtureNode) => ({
      display: 'block',
      visibility: 'visible',
      backgroundColor: node.backgroundColor,
      backgroundImage: node.backgroundImage,
    }),
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      documentElement: { lang: 'en' },
      querySelectorAll: (css: string) => (css === facebookBackgroundScope ? [root] : []),
    },
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try {
    run(root, editor, painter);
  } finally {
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const project = () =>
  FacebookBackground.parse(
    projectFacebookBackground({
      scope: facebookBackgroundScope,
      openCSS: FACEBOOK_BACKGROUND_OPTIONS,
      clearCSS: FACEBOOK_NO_BACKGROUND,
      solids: nativeSolidBackgrounds,
    }),
  );

test('background effect is painted behind the unique editor, not inferred from a palette button or input ACK', () =>
  fixture((root, editor, painter) => {
    const plain = project();
    Object.defineProperty(document, 'readyState', { value: 'interactive', configurable: true });
    assert.equal(project().ready, true);
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    assert.equal(project().ready, false);
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    assert.equal(plain.phase, 'plain');
    assert.equal(plain.options.length, 3);
    assert.equal(plain.draftEmpty, true);
    const palette = root.nodes.get(nativeBackgroundCSS(nativeSolidBackgrounds[0].label))?.[0];
    assert.ok(palette);
    palette.backgroundColor = nativeSolidBackgrounds[0].color;
    assert.equal(project().phase, 'plain');
    painter.backgroundColor = nativeSolidBackgrounds[0].color;
    const solid = project();
    assert.equal(solid.phase, 'solid');
    assert.equal(solid.selectedCSS, nativeBackgroundCSS(nativeSolidBackgrounds[0].label));
    assert.equal('actor' in solid, false);
    assert.equal('postId' in solid, false);
    editor.textContent = 'unrelated draft';
    assert.equal(project().draftEmpty, false);
    painter.backgroundColor = 'rgba(0, 0, 0, 0)';
    painter.backgroundImage = 'linear-gradient(red,blue)';
    assert.equal(project().phase, 'unsupported');
  }));

test('duplicate editors, disabled options, unsupported labels and foreign origins cannot produce a background click target', () =>
  fixture((root) => {
    const red = root.nodes.get(nativeBackgroundCSS(nativeSolidBackgrounds[0].label))?.[0];
    assert.ok(red);
    red.disabled = true;
    assert.equal(
      project().options.some((option) => option.id === 'red'),
      false,
    );
    document.documentElement.lang = 'unknown';
    assert.equal(project().options.length, 2);
    assert.equal(project().openCSS, FACEBOOK_BACKGROUND_OPTIONS);
    root.nodes.set('[role="textbox"][contenteditable="true"]', [
      new FixtureNode(),
      new FixtureNode(),
    ]);
    assert.equal(project().phase, 'ambiguous');
    Object.defineProperty(globalThis, 'location', {
      value: new URL('https://foreign.example/'),
      configurable: true,
    });
    assert.equal(project().phase, 'absent');
    assert.equal(project().options.length, 0);
  }));
