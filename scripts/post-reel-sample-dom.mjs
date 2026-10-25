import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readFacebookPostPage } from '../dist/src/infrastructure/facebook-post-page-reader.js';
import { readFacebookPostEffects } from '../dist/src/infrastructure/facebook-post-effect-reader.js';
import { FacebookComposerObserver } from '../dist/src/infrastructure/facebook-composer-observer.js';
import {
  FACEBOOK_REEL_MAIN,
  FACEBOOK_COMPOSER_REVIEW_SUBMIT,
} from '../dist/src/shared/facebook-ui.js';

const root = path.resolve('audit/post-test-content-a8b848f3-29e7-410d-9697-2690dd2a1d84');
const report = path.resolve('audit/post-reel-real-sample-' + randomUUID() + '.json');
const user = path.resolve('audit/post-reel-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
void run();
async function run() {
  const deadline = setTimeout(() => app.exit(1), 45000);
  let window, projection;
  const checks = [];
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
      (_r, done) => done({ cancel: true }),
    );
    const review = JSON.parse(await readFile(path.join(root, 'network-review.json'), 'utf8'));
    const html = await readFile(path.join(root, 'network-video-reel-settings.html'), 'utf8');
    const url = 'https://www.facebook.com/profile.php?id=' + review.accountId;
    const page = {
      evaluate: async (fn, arg) => {
        const value = await window.webContents.executeJavaScript(
          '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')',
        );
        return value && typeof value === 'object' && 'url' in value ? { ...value, url } : value;
      },
    };
    const load = () =>
      window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><meta charset="utf-8">' + html),
      );
    await load();
    const read = await readFacebookPostPage(page, 'zh_CN', () => {});
    projection = read.projection;
    assert.equal(read.surface?.phase, 'reel-review-before-submit');
    assert.equal(read.surface?.submit.scope, FACEBOOK_REEL_MAIN);
    assert.equal(read.text, review.rows[3].text);
    assert.equal(
      (await readFacebookPostEffects(page, () => {})).composer?.text,
      review.rows[3].text,
    );
    checks.push('actual-reels-settings-complete-caption-and-unique-final-target');
    const observer = new FacebookComposerObserver();
    const post = {
      intent: { snapshot: { text: review.rows[3].text, format: 'video' } },
      link: { purpose: 'SUBMIT' },
    };
    const action = {
      kind: 'click',
      target: { scope: FACEBOOK_REEL_MAIN, css: FACEBOOK_COMPOSER_REVIEW_SUBMIT },
    };
    await observer.assert(page, action, post, () => {}, 'zh_CN');
    await assert.rejects(
      observer.assert(
        page,
        action,
        { ...post, intent: { snapshot: { ...post.intent.snapshot, format: 'text' } } },
        () => {},
        'zh_CN',
      ),
      /PHASE_MISMATCH/,
    );
    checks.push('final-reels-action-refuses-non-video-purpose');
    await assert.rejects(
      readFacebookPostPage(page, 'en_US', () => {}),
      /LOCALE_CONFLICT/,
    );
    checks.push('unobserved-locale-refused');
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="描述一下你的 Reels..."]').textContent='changed caption';`,
    );
    await assert.rejects(
      observer.assert(page, action, post, () => {}, 'zh_CN'),
      /ORIGINAL_TEXT_MISMATCH/,
    );
    checks.push('changed-final-caption-refused');
    await load();
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="发帖"][role="button"]').setAttribute('aria-disabled','true');`,
    );
    assert.equal(
      (await readFacebookPostPage(page, 'zh_CN', () => {})).surface?.submit.enabled,
      false,
    );
    await assert.rejects(
      observer.assert(page, action, post, () => {}, 'zh_CN'),
      /PHASE_MISMATCH/,
    );
    checks.push('disabled-final-submit-refused');
    await load();
    await window.webContents.executeJavaScript(
      `const r=document.querySelector('[role="dialog"][aria-label="创建帖子"]');r.parentElement.append(r.cloneNode(true));`,
    );
    assert.equal((await readFacebookPostPage(page, 'zh_CN', () => {})).surface, null);
    assert.equal((await readFacebookPostEffects(page, () => {})).composer, null);
    checks.push('ambiguous-reels-refused');
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          kind: 'offline-replay-of-real-reels-settings',
          newFacebookActions: 0,
          externalRequestsBlocked: true,
          managedExecutorAcceptance: false,
          reelEditorDOMNotCaptured: true,
          actualSDKFileListNotTested: true,
          checks,
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
      JSON.stringify({ ok: false, checks, error: error.message, projection }, null, 2),
      { flag: 'wx' },
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
