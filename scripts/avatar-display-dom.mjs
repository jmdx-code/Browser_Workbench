import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pageProjectionExpression } from '../dist/extension/page-projection.js';
import { facebookDisplayInspectionProjection } from '../dist/src/infrastructure/facebook-read-adapter.js';
import { validateProjection } from '../dist/src/shared/page-read.js';
import { observeFacebookHomeAvatar } from '../dist/src/domain/facebook-avatar-analysis.js';
const report = path.resolve(
  process.env.WORKBENCH_AVATAR_DOM_REPORT ?? 'audit/avatar-display-dom.json',
);
const temporaryUserData = path.join(path.dirname(report), 'avatar-dom-user-' + randomUUID());
await mkdir(temporaryUserData);
app.setPath('userData', temporaryUserData);
void run();
async function run() {
  let window;
  const results = [];
  const timeout = setTimeout(() => app.exit(1), 25000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'avatar-dom-' + randomUUID(),
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, done) => done({ cancel: true }),
    );
    const resource = 'https://scontent.generated.fbcdn.net/avatar.jpg';
    const image =
      '<svg width="40" height="40"><image width="40" height="40" xlink:href="' +
      resource +
      '" /></svg>';
    const control = '<div role="button" aria-label="你的个人主页">' + image + '</div>';
    for (const item of [
      {
        name: 'scoped-svg-xlink',
        html: '<header role="banner">' + control + '</header>',
        expected: true,
      },
      {
        name: 'unrelated-banner-image',
        html:
          '<header role="banner"><div role="button" aria-label="Messenger">' +
          image +
          '</div></header>',
        expected: false,
      },
      { name: 'outside-banner', html: control, expected: false },
      {
        name: 'hidden-control',
        html: '<header role="banner"><div hidden>' + control + '</div></header>',
        expected: false,
      },
      {
        name: 'two-controls-hidden-sentinel',
        html: '<header role="banner">' + control + '<div hidden>' + control + '</div></header>',
        expected: false,
      },
    ]) {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><body>' + item.html + '</body>'),
      );
      const projection = validateProjection(
        facebookDisplayInspectionProjection,
        await window.webContents.executeJavaScript(
          pageProjectionExpression(facebookDisplayInspectionProjection),
        ),
      );
      const observed = observeFacebookHomeAvatar({
        ...projection,
        url: 'https://www.facebook.com/',
      });
      assert.equal(observed !== null, item.expected, item.name);
      if (item.expected) assert.equal(observed?.url, resource);
      results.push({ name: item.name, avatarObserved: observed !== null });
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          recordedAt: new Date().toISOString(),
          generatedDOM: true,
          actualFacebook: false,
          externalResourceRequestsBlocked: true,
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
    clearTimeout(timeout);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
