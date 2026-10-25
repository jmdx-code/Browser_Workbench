import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pageProjectionExpression } from '../dist/extension/page-projection.js';
import {
  facebookDisplayInspectionProjection,
  facebookComposerProjection,
} from '../dist/src/infrastructure/facebook-read-adapter.js';
import { validateProjection } from '../dist/src/shared/page-read.js';
import { observeFacebookHomeName } from '../dist/src/domain/facebook-name-analysis.js';
import { observeFacebookComposerSurface } from '../dist/src/domain/facebook-composer-analysis.js';

const report = path.resolve('audit/facebook-ui-dom-20261011.json');
const user = path.join(path.dirname(report), 'facebook-ui-dom-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
const escape = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const samples = JSON.parse(
  await readFile('audit/facebook-language-research-20261011.json', 'utf8'),
).samples;
void run();
async function run() {
  let window;
  const results = [];
  const timer = setTimeout(() => app.exit(1), 30000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'facebook-ui-' + randomUUID(),
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_req, done) => done({ cancel: true }),
    );
    async function project(html, request, url) {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><body>' + html + '</body>'),
      );
      const value = validateProjection(
        request,
        await window.webContents.executeJavaScript(pageProjectionExpression(request)),
      );
      return { ...value, url }; // Generated DOM, never represented as live Facebook.
    }
    for (const sample of samples) {
      const home = sample.home;
      const html =
        '<div role="region" aria-label="' +
        escape(home.label) +
        '"><a role="link" aria-label="' +
        escape(home.links[0].label) +
        '" href="/profile.php?id=123">Avatar</a><div role="button">' +
        escape(home.prompts[0]) +
        '</div></div>';
      const name = observeFacebookHomeName(
        await project(html, facebookDisplayInspectionProjection, 'https://www.facebook.com/'),
      );
      assert.equal(name?.name, 'Nway Myint', sample.locale);
      const surface = sample.composer.dialogs[0];
      const file =
        '<input type="file" multiple accept="' +
        escape(surface.fileInputs[0].accept) +
        '" style="display:none">';
      const submitLabel = surface.buttons[surface.buttons.length - 1].label;
      const composer =
        '<div role="dialog"><form><div role="textbox" contenteditable="true" aria-label="' +
        escape(surface.textboxes[0].label) +
        '" style="min-height:40px"> </div>' +
        file +
        '</form><button aria-label="选择背景图">选择背景图</button><div role="button" aria-label="' +
        escape(submitLabel) +
        '">' +
        escape(submitLabel) +
        '</div></div>';
      const observation = observeFacebookComposerSurface(
        await project(composer, facebookComposerProjection, 'https://www.facebook.com/post/create'),
        sample.locale,
      );
      assert.ok(observation?.submit, sample.locale);
      assert.equal(observation.actingIdentityVerified, false);
      for (const [reason, mutation] of [
        ['extra-file-outside-form', composer.replace('</form>', '</form><input type="file">')],
        ['hidden-duplicate-dialog', composer + '<div hidden>' + composer + '</div>'],
        [
          'textbox-no-longer-editable',
          composer.replace('contenteditable="true"', 'contenteditable="false"'),
        ],
        [
          'file-type-no-longer-media',
          composer.replace(escape(surface.fileInputs[0].accept), 'application/pdf'),
        ],
      ]) {
        assert.equal(
          observeFacebookComposerSurface(
            await project(
              mutation,
              facebookComposerProjection,
              'https://www.facebook.com/post/create',
            ),
            sample.locale,
          ),
          null,
          reason,
        );
      }
      results.push({
        locale: sample.locale,
        home: true,
        composerCandidate: true,
        negativeCases: 4,
      });
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          recordedAt: new Date().toISOString(),
          generatedDOM: true,
          actualFacebook: false,
          fixtureCopyFromRealResearch: true,
          externalRequestsBlocked: true,
          chromium: process.versions.chrome,
          results,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  } catch (error) {
    await writeFile(
      report,
      JSON.stringify(
        { ok: false, results, error: error instanceof Error ? error.message : 'DOM_FAILED' },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
