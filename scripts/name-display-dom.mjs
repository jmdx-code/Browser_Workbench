import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pageProjectionExpression } from '../dist/extension/page-projection.js';
import { facebookDisplayInspectionProjection } from '../dist/src/infrastructure/facebook-read-adapter.js';
import { validateProjection } from '../dist/src/shared/page-read.js';
import { observeFacebookHomeName } from '../dist/src/domain/facebook-name-analysis.js';
const report = path.resolve('audit/name-display-dom-verified.json');
const user = path.join(path.dirname(report), 'name-dom-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
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
        partition: 'name-dom-' + randomUUID(),
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }),
    );
    const link =
      '<a role="link" href="https://www.facebook.com/profile.php?id=123" aria-label="Generated Name的时间线">Avatar</a>';
    const prompt = '<div role="button">Generated Name，分享你的新鲜事吧！</div>';
    const composer = '<div role="region" aria-label="创建帖子">' + link + prompt + '</div>';
    for (const item of [
      { name: 'matching-composer', html: composer, expected: true },
      { name: 'outside-region', html: link + prompt, expected: false },
      { name: 'hidden-region', html: '<div hidden>' + composer + '</div>', expected: false },
      {
        name: 'hidden-duplicate-region',
        html: composer + '<div hidden>' + composer + '</div>',
        expected: false,
      },
      {
        name: 'mismatched-prompt',
        html: composer.replace('Generated Name，', 'Other，'),
        expected: false,
      },
      {
        name: 'extra-link-in-same-region',
        html: composer.replace('</a>', '</a>' + link),
        expected: false,
      },
    ]) {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><body>' + item.html + '</body>'),
      );
      const projected = validateProjection(
        facebookDisplayInspectionProjection,
        await window.webContents.executeJavaScript(
          pageProjectionExpression(facebookDisplayInspectionProjection),
        ),
      );
      const observed = observeFacebookHomeName({ ...projected, url: 'https://www.facebook.com/' });
      assert.equal(observed !== null, item.expected, item.name);
      if (item.expected) assert.equal(observed?.name, 'Generated Name');
      results.push({ name: item.name, observed: observed !== null });
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          recordedAt: new Date().toISOString(),
          generatedDOM: true,
          actualFacebook: false,
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
    clearTimeout(timeout);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
