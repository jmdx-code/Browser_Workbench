import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFacebookPostPage } from '../dist/src/infrastructure/facebook-post-page-reader.js';
import { FacebookComposerObserver } from '../dist/src/infrastructure/facebook-composer-observer.js';
import {
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_TEXT,
  facebookComposerPostSelector,
} from '../dist/src/shared/facebook-ui.js';

const report = path.resolve('audit/post-page-reader-dom-' + randomUUID() + '.json');
await mkdir(path.dirname(report), { recursive: true });
const user = path.resolve('audit/post-page-reader-dom-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
const escape = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const rows = [];
void run();
async function run() {
  const timer = setTimeout(() => app.exit(1), 30_000);
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: randomUUID(),
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }),
    );
    let fixtureURL = 'https://www.facebook.com/post/create';
    const execute = (fn, arg) =>
      window.webContents.executeJavaScript(
        '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')',
      );
    const page = {
      evaluate: async (fn, arg) => {
        const value = await execute(fn, arg);
        // Only this network-isolated generated DOM substitutes a URL; production reads real location.
        return value && typeof value === 'object' && 'url' in value
          ? { ...value, url: fixtureURL }
          : value;
      },
      locator: (scope) => ({
        locator: (css) => ({
          evaluate: async (fn) =>
            window.webContents.executeJavaScript(
              '(' +
                fn.toString() +
                ')(document.querySelector(' +
                JSON.stringify(scope + ' ' + css) +
                '))',
            ),
        }),
      }),
    };
    const composer = (body) =>
      '<div role="dialog" style="min-height:120px"><form><div role="textbox" contenteditable="true" style="min-height:40px">' +
      body +
      '</div><input type="file" multiple accept="image/*,video/*" hidden></form><div role="button" aria-label="发布" style="height:20px">发布</div></div>';
    const load = (html) =>
      window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><meta charset="utf-8"><body>' + html),
      );
    await load(composer('<p><br></p>'));
    const blank = await readFacebookPostPage(page, 'zh_CN', () => {});
    assert.equal(blank.text, '');
    assert.equal(blank.surface?.submit?.enabled, true);
    assert.equal(blank.locale, 'zh_CN');
    assert.equal(
      blank.projection.rows.find((row) => row.key === 'composerDialogs')?.nodes[0]?.attributes[
        'aria-label'
      ],
      undefined,
    );
    const action = {
      kind: 'typeText',
      tabId: 42,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { scope: FACEBOOK_COMPOSER_SCOPE, css: FACEBOOK_COMPOSER_TEXT },
      text: '原文',
    };
    const post = { intent: { snapshot: { text: '原文' } }, link: { purpose: 'SET_TEXT' } };
    await new FacebookComposerObserver().assert(page, action, post, () => {}, 'zh_CN');
    rows.push('unlabelled-real-observed-composer-and-empty-layout-newline');
    const original = '🙂'.repeat(400) + '\n中文 العربية မြန်မာ\n尾部保持  空格';
    await load(composer('<div style="white-space:pre-wrap">' + escape(original) + '</div>'));
    const full = await readFacebookPostPage(page, 'zh_CN', () => {});
    assert.equal(full.text, original);
    await new FacebookComposerObserver().assert(
      page,
      {
        ...action,
        kind: 'click',
        target: { scope: FACEBOOK_COMPOSER_SCOPE, css: facebookComposerPostSelector('zh_CN') },
      },
      { intent: { snapshot: { text: original } }, link: { purpose: 'SUBMIT' } },
      () => {},
      'zh_CN',
    );
    rows.push('full-original-unicode-newlines-and-suffix');
    const unknown = await readFacebookPostPage(page, undefined, () => {});
    assert.equal(unknown.surface?.submit, null);
    rows.push('missing-locale-does-not-guess-submit');
    await load(
      composer('正文').replace('role="dialog"', 'role="dialog" aria-label="Create a post"'),
    );
    await assert.rejects(
      readFacebookPostPage(page, 'zh_CN', () => {}),
      /LOCALE_CONFLICT/,
    );
    rows.push('conflicting-locale-invalidates');
    fixtureURL = 'https://www.facebook.com/';
    await load(
      '<div role="region" aria-label="创建帖子" style="height:80px"><a role="link" aria-label="模拟资料的时间线" href="/profile.php?id=123">模拟头像</a><div role="button">模拟资料，分享你的新鲜事吧！</div></div>',
    );
    const home = await readFacebookPostPage(page, undefined, () => {});
    assert.equal(home.opener?.text, '模拟资料，分享你的新鲜事吧！');
    assert.equal(home.surface, null);
    rows.push('scoped-home-opener');
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          generatedDOM: true,
          actualFacebook: false,
          externalRequestsBlocked: true,
          chromium: process.versions.chrome,
          checks: rows,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(report);
  } catch (error) {
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: false,
          generatedDOM: true,
          actualFacebook: false,
          checks: rows,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
