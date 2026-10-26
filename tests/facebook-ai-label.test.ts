import test from 'node:test';
import assert from 'node:assert/strict';
import { postAILabelSetting, requiresNativePostBackground } from '../src/domain/material-post.js';
import type { PostIntent } from '../src/shared/material-index.js';
import { emptyResourceRow } from '../src/domain/resource-table.js';
import { randomUUID } from 'node:crypto';
import { decidePostAILabel } from '../src/domain/facebook-ai-label.js';
import {
  facebookAILabelReading,
  facebookAILabelScope,
  facebookAILabelSwitch,
  type AILabelPurpose,
} from '../src/shared/facebook-ai-label.js';
import { projectFacebookAILabel } from '../src/infrastructure/facebook-ai-label-reader.js';
import { assertFacebookAILabelInput } from '../src/infrastructure/facebook-ai-label-input.js';
import type { Page } from 'playwright-core';

const composer = facebookAILabelReading.parse({
  url: 'https://www.facebook.com/',
  timeOrigin: 1,
  ready: true,
  visible: true,
  phase: 'composer',
  value: false,
  openCSS: '[role="button"][aria-label="AI label off"]',
  switchEnabled: false,
  confirmEnabled: false,
});
test('AI input fence rechecks exact target and saved state, with no added reads for preserve-current', async () => {
  let reading = composer,
    reads = 0,
    current = true,
    revokeDuringRead = false;
  const page = {
    url: () => composer.url,
    evaluate: async () => {
      reads++;
      if (revokeDuringRead) current = false;
      return structuredClone(reading);
    },
  } as unknown as Page;
  const guard = () => {
    if (!current) throw Error('GENERATED_OWNER_STOPPED');
  };
  const action = {
    kind: 'click' as const,
    tabId: 42,
    documentEpoch: 0,
    routeEpoch: 0,
    target: { scope: facebookAILabelScope, css: composer.openCSS! },
  };
  assert.equal(
    await assertFacebookAILabelInput(
      page,
      action,
      { link: { purpose: 'SUBMIT' } },
      'preserve-current',
      guard,
    ),
    false,
  );
  assert.equal(reads, 0);
  assert.equal(
    await assertFacebookAILabelInput(
      page,
      action,
      { link: { purpose: 'OPEN_AI_LABEL' } },
      'on',
      guard,
    ),
    true,
  );
  await assert.rejects(
    assertFacebookAILabelInput(
      page,
      { ...action, target: { ...action.target, css: '#foreign' } },
      { link: { purpose: 'OPEN_AI_LABEL' } },
      'on',
      guard,
    ),
    /ACTION_UNCONFIRMED/,
  );
  await assert.rejects(
    assertFacebookAILabelInput(page, action, { link: { purpose: 'SUBMIT' } }, 'on', guard),
    /UNCONFIRMED_BEFORE_CONTENT/,
  );
  reading = { ...composer, value: true };
  assert.equal(
    await assertFacebookAILabelInput(page, action, { link: { purpose: 'SUBMIT' } }, 'on', guard),
    false,
  );
  reading = { ...composer, phase: 'settings', value: true, openCSS: null, confirmEnabled: true };
  await assert.rejects(
    assertFacebookAILabelInput(page, action, { link: { purpose: 'SUBMIT' } }, 'on', guard),
    /UNCONFIRMED_BEFORE_CONTENT/,
  );
  revokeDuringRead = true;
  await assert.rejects(
    assertFacebookAILabelInput(page, action, { link: { purpose: 'SUBMIT' } }, 'on', guard),
    /OWNER_STOPPED/,
  );
});
test('AI label keeps current by default and separates a selected switch from the saved composer state', () => {
  const done = new Set<AILabelPurpose>(),
    applied = (purpose: AILabelPurpose) => done.has(purpose);
  assert.equal(decidePostAILabel('preserve-current', undefined, applied).kind, 'ready');
  assert.equal(decidePostAILabel('off', composer, applied).kind, 'ready');
  const open = decidePostAILabel('on', composer, applied);
  assert.equal(open.kind === 'action' && open.purpose, 'OPEN_AI_LABEL');
  done.add('OPEN_AI_LABEL');
  const settings = {
    ...composer,
    phase: 'settings' as const,
    openCSS: null,
    switchEnabled: true,
    confirmEnabled: true,
  };
  const toggle = decidePostAILabel('on', settings, applied);
  assert.equal(toggle.kind === 'action' && toggle.purpose, 'SET_AI_LABEL');
  done.add('SET_AI_LABEL');
  const confirm = decidePostAILabel('on', { ...settings, value: true }, applied);
  assert.equal(confirm.kind === 'action' && confirm.purpose, 'CONFIRM_AI_LABEL');
  done.add('CONFIRM_AI_LABEL');
  assert.equal(decidePostAILabel('on', { ...composer, value: true }, applied).kind, 'ready');
  assert.throws(() => decidePostAILabel('on', composer, applied), /AI_LABEL_CHANGED/);
  assert.throws(
    () => decidePostAILabel('on', { ...settings, value: true }, applied),
    /CONFIGURATION_UNAVAILABLE/,
  );
});
test('AI label never blindly retoggles, dismisses foreign settings, or treats closed settings as saved', () => {
  const settings = {
    ...composer,
    phase: 'settings' as const,
    openCSS: null,
    switchEnabled: true,
    confirmEnabled: true,
  };
  assert.throws(() => decidePostAILabel('on', settings, () => false), /CONFIGURATION_UNAVAILABLE/);
  assert.throws(
    () => decidePostAILabel('on', composer, (p) => p === 'OPEN_AI_LABEL'),
    /SETTINGS_CLOSED/,
  );
  assert.throws(
    () => decidePostAILabel('on', settings, (p) => p !== 'CONFIRM_AI_LABEL'),
    /AI_LABEL_CHANGED/,
  );
  assert.equal(decidePostAILabel('on', { ...composer, visible: false }, () => false).kind, 'wait');
  assert.equal(
    decidePostAILabel('on', { ...settings, switchEnabled: false }, (p) => p === 'OPEN_AI_LABEL')
      .kind,
    'wait',
  );
  assert.throws(
    () => decidePostAILabel('on', { ...composer, phase: 'ambiguous' }, () => false),
    /CONFIGURATION_UNAVAILABLE/,
  );
});

class NodeFixture {
  nodes = new Map<string, NodeFixture[]>();
  attributes = new Map<string, string>();
  textContent = '';
  disabled = false;
  hidden = false;
  getBoundingClientRect() {
    return { width: 500, height: 300, left: 0, right: 500, top: 0, bottom: 300 };
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  querySelectorAll(css: string) {
    return this.nodes.get(css) ?? [];
  }
  matches() {
    return this.disabled;
  }
  closest() {
    return this.hidden ? this : null;
  }
}
test('bounded AI projection distinguishes unique native composer, settings, disabled and ambiguous controls', () => {
  const root = new NodeFixture(),
    opener = new NodeFixture(),
    toggle = new NodeFixture(),
    heading = new NodeFixture(),
    confirm = new NodeFixture();
  opener.attributes.set('aria-label', 'AI label off');
  toggle.attributes.set('aria-checked', 'false');
  confirm.textContent = 'Got it';
  root.nodes.set('[role="button"]', [opener]);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    querySelectorAll: () => [root],
  };
  try {
    for (const [key, value] of Object.entries({
      document,
      location: new URL('https://www.facebook.com/'),
      innerWidth: 1280,
      innerHeight: 900,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    })) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true });
    }
    const read = () =>
      facebookAILabelReading.parse(
        projectFacebookAILabel({ scope: facebookAILabelScope, switchCSS: facebookAILabelSwitch }),
      );
    assert.equal(read().phase, 'composer');
    document.readyState = 'interactive';
    assert.equal(read().ready, true);
    document.readyState = 'loading';
    assert.equal(read().ready, false);
    document.readyState = 'complete';
    assert.equal(read().value, false);
    for (const label of ['AI 标签已关闭', 'AI 標籤已關閉']) {
      opener.attributes.set('aria-label', label);
      assert.equal(read().value, false);
      assert.equal(read().phase, 'composer');
    }
    opener.attributes.set('aria-label', 'AI 標籤已開啟');
    assert.equal(read().value, true);
    root.nodes.set('[role="button"]', []);
    assert.equal(read().value, false);
    root.nodes.set('[role="button"]', [opener]);
    opener.disabled = true;
    assert.equal(read().openCSS, null);
    root.nodes.set('[role="dialog"][aria-label="Labeling your content"]', [heading]);
    root.nodes.set(facebookAILabelSwitch, [toggle]);
    root.nodes.set('[role="button"]', [confirm]);
    assert.equal(read().phase, 'settings');
    toggle.attributes.set('aria-checked', 'true');
    assert.equal(read().value, true);
    root.nodes.set(facebookAILabelSwitch, [toggle, new NodeFixture()]);
    assert.equal(read().phase, 'ambiguous');
    document.querySelectorAll = () => [root, new NodeFixture()];
    assert.equal(read().phase, 'ambiguous');
    Object.defineProperty(globalThis, 'location', {
      value: new URL('https://example.org/'),
      configurable: true,
    });
    assert.equal(read().phase, 'absent');
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('AI off without controls passes only before any configuration action; known on still needs an action', () => {
  assert.equal(
    decidePostAILabel(
      'off',
      { ...composer, phase: 'ambiguous', value: null, openCSS: null },
      () => false,
    ).kind,
    'ready',
  );
  assert.throws(() =>
    decidePostAILabel('off', { ...composer, phase: 'ambiguous', value: null }, () => true),
  );
  assert.equal(decidePostAILabel('off', { ...composer, value: true }, () => false).kind, 'action');
});

test('native colored post background is limited to 120 Unicode characters and four lines', () => {
  const intent = (text: string, media: unknown[] = []) =>
    ({ resource: { row: { background: 'color', media } }, snapshot: { text } }) as PostIntent;
  assert.equal(requiresNativePostBackground(intent('文'.repeat(120))), true);
  assert.equal(requiresNativePostBackground(intent('😀'.repeat(121))), false);
  assert.equal(requiresNativePostBackground(intent('a\nb\nc\nd')), true);
  assert.equal(requiresNativePostBackground(intent('a\nb\nc\nd\ne')), false);
  assert.equal(requiresNativePostBackground(intent('长文'.repeat(200))), false);
  assert.equal(requiresNativePostBackground(intent('短文', [{}])), false);
});

test('single-post row AI overrides step defaults, including explicit preserve-current; old rows inherit', () => {
  for (const step of [undefined, 'on', 'off', 'preserve-current'] as const) {
    const directory = {} as PostIntent;
    assert.equal(postAILabelSetting(directory, step), step ?? 'preserve-current');
    for (const aiLabel of [undefined, 'on', 'off', 'preserve-current'] as const) {
      const intent = {
        resource: { row: { ...emptyResourceRow(randomUUID()), ...(aiLabel ? { aiLabel } : {}) } },
      } as PostIntent;
      assert.equal(postAILabelSetting(intent, step), aiLabel ?? step ?? 'preserve-current');
    }
  }
});
