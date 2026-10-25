import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readFacebookPostPage } from '../dist/src/infrastructure/facebook-post-page-reader.js';
import { readFacebookPostEffects } from '../dist/src/infrastructure/facebook-post-effect-reader.js';
import { FacebookComposerObserver } from '../dist/src/infrastructure/facebook-composer-observer.js';
import {
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_REVIEW_SUBMIT,
} from '../dist/src/shared/facebook-ui.js';

// Replays the actual already-published multi-image confirmation DOM offline. No FB input.
const root = path.resolve('audit/post-test-content-a8b848f3-29e7-410d-9697-2690dd2a1d84');
const report = path.resolve('audit/post-review-real-sample-' + randomUUID() + '.json');
const user = path.resolve('audit/post-review-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
void run();
async function run() {
  const deadline = setTimeout(() => app.exit(1), 45000);
  let window;
  let projection;
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
    const review = JSON.parse(await readFile(path.join(root, 'review.json'), 'utf8'));
    const sample = JSON.parse(await readFile(path.join(root, 'profile-next-stage.json'), 'utf8'));
    const url = 'https://www.facebook.com/profile.php?id=' + review.accountIdCandidate;
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
          encodeURIComponent('<!doctype html><meta charset="utf-8">' + sample.html),
      );
    await load();
    projection = await page.evaluate(() => {
      const r = document.querySelector(
        '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])',
      );
      const labels = Array.from(r.querySelectorAll('span[dir="auto"]')).filter(
        (e) => e.textContent === '帖子预览',
      );
      const edit = document.querySelector('form [role="textbox"][contenteditable="true"]');
      return {
        labels: labels.length,
        captionChildren: labels[0]?.parentElement?.children.length,
        children: Array.from(labels[0]?.parentElement?.children ?? []).map((e) => ({
          tag: e.tagName,
          role: e.getAttribute('role'),
          text: e.textContent?.slice(0, 150),
          html: e.outerHTML.slice(0, 250),
        })),
        previewText: labels[0]?.nextElementSibling?.textContent,
        editable: edit?.innerText,
        editableText: edit?.textContent,
      };
    });
    const reading = await readFacebookPostPage(page, 'zh_CN', () => {});
    projection = reading.projection;
    assert.equal(reading.surface?.phase, 'review-before-submit');
    assert.equal(reading.surface.submit.scope, FACEBOOK_COMPOSER_SCOPE);
    assert.equal(reading.surface.submit.css, FACEBOOK_COMPOSER_REVIEW_SUBMIT);
    assert.equal(reading.surface.advance, null);
    assert.equal(reading.text, review.rows[2].text);
    const effects = await readFacebookPostEffects(page, () => {});
    assert.equal(effects.composer?.text, review.rows[2].text);
    assert.equal(effects.composer?.submitEnabled, true);
    checks.push('actual-hidden-editor-and-visible-full-preview-read');
    const observer = new FacebookComposerObserver();
    const action = {
      kind: 'click',
      target: { scope: FACEBOOK_COMPOSER_SCOPE, css: FACEBOOK_COMPOSER_REVIEW_SUBMIT },
    };
    const post = {
      intent: { snapshot: { text: review.rows[2].text } },
      link: { purpose: 'SUBMIT' },
    };
    await observer.assert(page, action, post, () => {}, 'zh_CN');
    await assert.rejects(
      observer.assert(
        page,
        action,
        { ...post, link: { purpose: 'ADVANCE_COMPOSER' } },
        () => {},
        'zh_CN',
      ),
      /PHASE_MISMATCH/,
    );
    checks.push('final-submit-target-distinct-from-next-and-save');
    await assert.rejects(
      readFacebookPostPage(page, 'en_US', () => {}),
      /LOCALE_CONFLICT/,
    );
    checks.push('unobserved-review-locale-refused');
    await window.webContents.executeJavaScript(
      `document.querySelector('[role="dialog"]:has(form [role="textbox"][contenteditable="true"]) [role="button"][aria-label="发帖"]').setAttribute('aria-disabled','true')`,
    );
    assert.equal(
      (await readFacebookPostPage(page, 'zh_CN', () => {})).surface.submit.enabled,
      false,
    );
    await assert.rejects(
      observer.assert(page, action, post, () => {}, 'zh_CN'),
      /PHASE_MISMATCH/,
    );
    checks.push('disabled-final-submit-refused');
    await load();
    await window.webContents.executeJavaScript(
      `const r=document.querySelector('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'); const label=Array.from(r.querySelectorAll('span[dir="auto"]')).find(e=>e.textContent==='帖子预览');label.nextElementSibling.textContent='Changed visible preview';`,
    );
    await assert.rejects(
      readFacebookPostPage(page, 'zh_CN', () => {}),
      /CONTENT_OR_DOCUMENT_UNVERIFIED/,
    );
    await assert.rejects(
      observer.assert(page, action, post, () => {}, 'zh_CN'),
      /CONTENT_OR_DOCUMENT_UNVERIFIED/,
    );
    assert.equal((await readFacebookPostEffects(page, () => {})).composer, null);
    checks.push('hidden-original-alone-cannot-authorize-changed-visible-preview');
    await load();
    await window.webContents.executeJavaScript(
      `const review=document.querySelector('[role="dialog"][aria-label="帖子设置"]'); review.parentElement.append(review.cloneNode(true));`,
    );
    assert.equal((await readFacebookPostPage(page, 'zh_CN', () => {})).surface, null);
    assert.equal((await readFacebookPostEffects(page, () => {})).composer, null);
    checks.push('ambiguous-confirmation-refused');
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          kind: 'offline-replay-of-real-profile-next-review',
          newFacebookActions: 0,
          externalRequestsBlocked: true,
          managedExecutorAcceptance: false,
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
      {
        flag: 'wx',
      },
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
