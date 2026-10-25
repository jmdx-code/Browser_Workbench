import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectFacebookSubmissionAudience } from '../dist/src/infrastructure/facebook-submission-audience.js';

const report = path.resolve('audit/post-submission-audience-' + randomUUID() + '.json');
const user = path.resolve('audit/post-submission-audience-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
void run();
async function run() {
  const deadline = setTimeout(() => app.exit(1), 45000);
  let window;
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
      (_request, done) => done({ cancel: true }),
    );
    const html = await readFile(
      path.resolve(
        'audit/post-test-content-a8b848f3-29e7-410d-9697-2690dd2a1d84/network-video-reel-settings.html',
      ),
      'utf8',
    );
    const load = () =>
      window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><meta charset="utf-8">' + html),
      );
    const read = () =>
      window.webContents.executeJavaScript(
        '(' + projectFacebookSubmissionAudience.toString() + ')()',
      );
    await load();
    assert.equal((await read()).audience, 'SELF');
    checks.push('actual-private-reels-settings-control');
    const privacy = `Array.from(document.querySelectorAll('[role="main"] [role="button"]')).find(e=>e.textContent==='帖子分享对象仅限自己')`;
    for (const [name, mutation] of [
      ['public-is-refused', `${privacy}.textContent='帖子分享对象公开'`],
      [
        'duplicate-privacy-control-is-refused',
        `const e=${privacy};e.parentElement.append(e.cloneNode(true))`,
      ],
      ['hidden-private-control-is-refused', `${privacy}.setAttribute('aria-hidden','true')`],
      ['disabled-control-is-refused', `${privacy}.setAttribute('aria-disabled','true')`],
      ['unverified-language-is-refused', `${privacy}.textContent='AudienceOnly me'`],
      [
        'foreign-empty-composer-is-refused',
        `document.body.innerHTML='<div role="dialog"><button aria-label="编辑隐私设置。分享对象：仅限自己。">仅限自己</button></div>'`,
      ],
    ]) {
      await load();
      await window.webContents.executeJavaScript(mutation);
      assert.equal((await read()).audience, null, name);
      checks.push(name);
    }
    // This composes the observed standard form with the exact captured private control;
    // it is an offline regression, not a live private standard-editor acceptance.
    const standard =
      '<div role="dialog"><form><div role="textbox" contenteditable="true">test</div><button role="button" aria-label="编辑隐私设置。分享对象：仅限自己。">仅限自己</button></form></div>';
    const loadStandard = () =>
      window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><meta charset="utf-8">' + standard),
      );
    await loadStandard();
    assert.equal((await read()).audience, 'SELF');
    checks.push('generated-standard-editor-private-control');
    for (const [name, mutation] of [
      [
        'standard-public-is-refused',
        `const e=document.querySelector('button');e.setAttribute('aria-label','编辑隐私设置。分享对象：公开。');e.textContent='公开'`,
      ],
      [
        'standard-conflicting-label-text-is-refused',
        `document.querySelector('button').textContent='公开'`,
      ],
      ['standard-disabled-is-refused', `document.querySelector('button').disabled=true`],
      ['standard-hidden-is-refused', `document.querySelector('button').style.display='none'`],
      [
        'standard-duplicate-control-is-refused',
        `const e=document.querySelector('button');e.parentElement.append(e.cloneNode(true))`,
      ],
      [
        'standard-duplicate-editor-is-refused',
        `const e=document.querySelector('[role="dialog"]');document.body.append(e.cloneNode(true))`,
      ],
      [
        'standard-editor-without-textbox-is-refused',
        `document.querySelector('[role="textbox"]').remove()`,
      ],
    ]) {
      await loadStandard();
      await window.webContents.executeJavaScript(mutation);
      assert.equal((await read()).audience, null, name);
      checks.push(name);
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          checks,
          kind: 'offline-captured-reels-and-generated-standard-privacy-control',
          newFacebookActions: 0,
          externalRequestsBlocked: true,
          managedExecutorAcceptance: false,
          standardComposerPrivateDOMNotCaptured: true,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(report);
    window.destroy();
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    await writeFile(
      report,
      JSON.stringify(
        { ok: false, checks, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.error(error);
    window?.destroy();
    clearTimeout(deadline);
    app.exit(1);
  }
}
