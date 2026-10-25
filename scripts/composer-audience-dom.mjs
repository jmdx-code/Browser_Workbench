import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectFacebookComposerAudience } from '../dist/src/infrastructure/facebook-composer-audience.js';
import { projectFacebookSubmissionAudience } from '../dist/src/infrastructure/facebook-submission-audience.js';

const id = randomUUID(),
  root = path.resolve('audit/composer-audience-dom-' + id);
await mkdir(root);
app.setPath('userData', path.join(root, 'user'));
const checks = [];
let window;
void run();
async function run() {
  const deadline = setTimeout(() => app.exit(1), 45000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: id,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_r, done) => done({ cancel: true }),
    );
    const composer = `<div role="dialog"><div role="dialog" aria-label="Create post"><h2>Create post</h2></div><form><div role="textbox" contenteditable="true"></div><button role="button" aria-label="Edit privacy. Sharing with Public. ">Public</button></form></div>`;
    const menu = `<section><h2>Post audience</h2><div role="radiogroup" aria-label="Select audience"><label for="public">Public</label><input id="public" type="radio" name="audience"><label for="self">Only me</label><input id="self" type="radio" name="audience"></div><label for="default">Set as default audience.</label><input id="default" type="checkbox"><button role="button" aria-label="Done with privacy audience selection and close dialog">Done</button></section>`;
    const load = async (privacyMenu = false) => {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><meta charset="utf-8">' + composer),
      );
      if (privacyMenu)
        await window.webContents.executeJavaScript(
          `document.querySelector('form').style.display='none';document.querySelector('[role="dialog"]').insertAdjacentHTML('beforeend',${JSON.stringify(menu)})`,
        );
    };
    const read = () =>
      window.webContents.executeJavaScript(
        '(' + projectFacebookComposerAudience.toString() + ')()',
      );
    await load();
    let r = await read();
    assert.equal(r.phase, 'COMPOSER');
    assert.equal(r.openEnabled, true);
    assert.equal(r.audience, null);
    checks.push('public-empty-editor-can-open-scope');
    await window.webContents.executeJavaScript(
      `const p=document.querySelector('button');p.setAttribute('aria-label','Edit privacy. Sharing with Only me. ');p.textContent='Only me'`,
    );
    r = await read();
    assert.equal(r.audience, 'SELF');
    assert.equal(
      (
        await window.webContents.executeJavaScript(
          '(' + projectFacebookSubmissionAudience.toString() + ')()',
        )
      ).audience,
      'SELF',
    );
    checks.push('english-confirmed-self-including-native-trailing-space');
    for (const [name, mutation] of [
      [
        'conflicting-label-text',
        `document.querySelector('button').setAttribute('aria-label','Edit privacy. Sharing with Only me. ')`,
      ],
      [
        'duplicate-privacy',
        `const p=document.querySelector('button');p.parentElement.append(p.cloneNode(true))`,
      ],
      [
        'foreign-filled-draft',
        `document.querySelector('[role="textbox"]').textContent='foreign draft'`,
      ],
    ]) {
      await load();
      await window.webContents.executeJavaScript(mutation);
      r = await read();
      assert.ok(!r.openEnabled || !r.draftEmpty, name);
      checks.push(name);
    }
    await load(true);
    r = await read();
    assert.equal(r.phase, 'MENU');
    assert.equal(r.draftEmpty, true);
    assert.equal(r.selfSelected, false);
    assert.equal(r.defaultChecked, false);
    checks.push('native-labelled-radio-and-default-checkbox');
    await window.webContents.executeJavaScript(`document.querySelector('#self').checked=true`);
    r = await read();
    assert.equal(r.selfSelected, true);
    assert.equal(r.defaultChecked, false);
    assert.equal(r.audience, null);
    checks.push('selected-radio-is-not-confirmed-editor-self');
    for (const [name, mutation, verify] of [
      [
        'default-checkbox-retained',
        `document.querySelector('#default').checked=true`,
        (r) => r.defaultChecked === true,
      ],
      [
        'disabled-confirm',
        `document.querySelector('section button').disabled=true`,
        (r) => r.confirmEnabled === false,
      ],
      [
        'disabled-self',
        `document.querySelector('#self').disabled=true`,
        (r) => r.selfEnabled === false,
      ],
      [
        'duplicate-self-label',
        `const l=document.createElement('label');l.htmlFor='self';l.textContent='Only me';document.querySelector('[role="radiogroup"]').append(l)`,
        (r) => r.phase === 'UNAVAILABLE',
      ],
      [
        'missing-default',
        `document.querySelector('#default').remove()`,
        (r) => r.phase === 'UNAVAILABLE',
      ],
      [
        'hidden-menu',
        `document.querySelector('section').style.display='none'`,
        (r) => r.phase === 'UNAVAILABLE',
      ],
      [
        'filled-hidden-editor',
        `document.querySelector('[role="textbox"]').textContent='foreign draft'`,
        (r) => r.phase === 'UNAVAILABLE',
      ],
    ]) {
      await load(true);
      await window.webContents.executeJavaScript(mutation);
      assert.ok(verify(await read()), name);
      checks.push(name);
    }
    await writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          kind: 'isolated-dom-from-observed-control-structure',
          checks,
          facebookActions: 0,
          publications: 0,
          externalRequestsBlocked: true,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(root);
    window.destroy();
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    await writeFile(
      path.join(root, 'result.json'),
      JSON.stringify({ ok: false, checks, error: String(error) }, null, 2),
      { flag: 'wx' },
    );
    console.error(error);
    window?.destroy();
    clearTimeout(deadline);
    app.exit(1);
  }
}
