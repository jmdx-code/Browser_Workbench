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
  type AILabelPurpose,
} from '../src/shared/facebook-ai-label.js';
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

test('explicit AI off never treats unknown or missing controls as false', () => {
  for (const phase of ['absent', 'ambiguous'] as const)
    assert.throws(
      () =>
        decidePostAILabel('off', { ...composer, phase, value: null, openCSS: null }, () => false),
      /CONFIGURATION_UNAVAILABLE/,
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
