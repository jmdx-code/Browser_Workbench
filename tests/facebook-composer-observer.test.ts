import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { FacebookComposerObserver } from '../src/infrastructure/facebook-composer-observer.js';
import { facebookComposerProjection } from '../src/infrastructure/facebook-read-adapter.js';
import {
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_TEXT,
  facebookComposerAdvanceSelector,
  facebookComposerPostSelector,
} from '../src/shared/facebook-ui.js';
import type { PageProjection } from '../src/shared/page-read.js';
import { postFixture, postRequest, postAction } from './fixtures/material-post.js';

function observedPage() {
  const p: PageProjection = {
    url: 'https://www.facebook.com/profile.php?id=123',
    timeOrigin: 1000,
    ready: 'complete',
    visibility: 'visible',
    rows: facebookComposerProjection.queries.map((q) => ({ key: q.key, nodes: [] })),
  };
  for (const [key, tag] of [
    ['composerDialogs', 'div'],
    ['composerForms', 'form'],
    ['composerTextboxes', 'div'],
    ['composerAllFiles', 'input'],
    ['composerMediaFiles', 'input'],
  ] as const) {
    p.rows
      .find((row) => row.key === key)!
      .nodes.push({
        tag,
        visible: !key.endsWith('Files'),
        text: '',
        attributes: key === 'composerDialogs' ? { 'aria-label': '创建帖子' } : {},
      });
  }
  return p;
}

test('private composer observer uses full original text and enforces Next/Submit/disabled phase on the original action', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    const intent = (await store.materials.reserve(r)).intent;
    // Longer than public projection text; two inputs with equal first 500 chars must differ.
    intent.snapshot.text = '🙂'.repeat(400) + '\n完整尾部 العربية';
    const p = observedPage();
    p.rows
      .find((row) => row.key === 'composerAdvances')!
      .nodes.push({ tag: 'div', text: '', visible: true, attributes: { 'aria-label': '下一页' } });
    let body = intent.snapshot.text;
    const locator = { locator: () => locator, evaluate: async () => body };
    const page = {
      evaluate: async () => structuredClone(p),
      locator: () => locator,
    } as unknown as Page;
    const observer = new FacebookComposerObserver();
    const original = await postAction(store, r, 'ADVANCE_COMPOSER');
    assert.equal(original.action.kind, 'click');
    if (original.action.kind !== 'click') throw Error('fixture');
    original.action.target = {
      scope: FACEBOOK_COMPOSER_SCOPE,
      css: facebookComposerAdvanceSelector('zh_CN')!,
    };
    const post = { intent, link: { ...original, sequence: 1 } };
    await observer.assert(page, original.action, post, () => {});
    p.ready = 'interactive';
    await observer.assert(page, original.action, post, () => {});
    p.ready = 'loading';
    await assert.rejects(
      observer.assert(page, original.action, post, () => {}),
      /FACEBOOK_COMPOSER_TARGET_UNVERIFIED/,
    );
    p.ready = 'complete';
    body = intent.snapshot.text.slice(0, 500) + 'different suffix';
    await assert.rejects(
      observer.assert(page, original.action, post, () => {}),
      /ORIGINAL_TEXT_MISMATCH/,
    );
    body = intent.snapshot.text;
    p.rows
      .find((row) => row.key === 'composerDisabledActions')!
      .nodes.push({ tag: 'div', text: '', visible: true, attributes: { 'aria-label': '下一页' } });
    await assert.rejects(
      observer.assert(page, original.action, post, () => {}),
      /PHASE_MISMATCH/,
    );
    p.rows.find((row) => row.key === 'composerDisabledActions')!.nodes = [];
    const submit = {
      ...original.action,
      target: { scope: FACEBOOK_COMPOSER_SCOPE, css: facebookComposerPostSelector('zh_CN') },
    };
    await assert.rejects(
      observer.assert(
        page,
        submit,
        { intent, link: { ...post.link, purpose: 'SUBMIT', action: submit } },
        () => {},
      ),
      /PHASE_MISMATCH/,
    );
    p.rows.find((row) => row.key === 'composerAdvances')!.nodes = [];
    p.rows
      .find((row) => row.key === 'composerSubmits')!
      .nodes.push({ tag: 'div', text: '', visible: true, attributes: { 'aria-label': '发布' } });
    await observer.assert(
      page,
      submit,
      { intent, link: { ...post.link, purpose: 'SUBMIT', action: submit } },
      () => {},
    );
    const type = {
      kind: 'typeText' as const,
      tabId: 42,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { scope: FACEBOOK_COMPOSER_SCOPE, css: FACEBOOK_COMPOSER_TEXT },
      text: intent.snapshot.text,
    };
    body = 'foreign draft';
    await assert.rejects(
      observer.assert(
        page,
        type,
        { intent, link: { ...post.link, purpose: 'SET_TEXT', action: type } },
        () => {},
      ),
      /ORIGINAL_TEXT_MISMATCH/,
    );
    body = '';
    await observer.assert(
      page,
      type,
      { intent, link: { ...post.link, purpose: 'SET_TEXT', action: type } },
      () => {},
    );
    let guards = 0;
    await assert.rejects(
      observer.assert(
        page,
        type,
        { intent, link: { ...post.link, purpose: 'SET_TEXT', action: type } },
        () => {
          if (++guards === 2) throw Error('connection changed during projection');
        },
      ),
      /connection changed/,
    );
  });
});
