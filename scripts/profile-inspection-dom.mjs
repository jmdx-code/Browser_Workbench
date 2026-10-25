import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pageProjectionExpression } from '../dist/extension/page-projection.js';
import { facebookIdentityProjection } from '../dist/src/infrastructure/facebook-read-adapter.js';
import { validateProjection } from '../dist/src/shared/page-read.js';
import { analyzeFacebookIdentityPage } from '../dist/src/domain/facebook-page-analysis.js';

// Generated DOM only. Does not connect to a browser profile or read any real credentials.
const report = path.resolve(
  process.env.WORKBENCH_INSPECTION_DOM_REPORT ?? 'audit/inspection-dom.json',
);
const userData = path.join(path.dirname(report), 'inspection-dom-user-' + randomUUID());
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
void run();

async function run() {
  let window;
  const results = [];
  const timeout = setTimeout(() => app.exit(1), 25_000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'inspection-dom-' + randomUUID(),
      },
    });
    const email = '<input name="email" value="GENERATED_PRIVATE_SENTINEL">';
    const password = '<input type="password" value="GENERATED_PRIVATE_SENTINEL">';
    const form = '<form>' + email + password + '</form>';
    for (const item of [
      { name: 'home-login', html: form, route: '/', expected: 'logged-out' },
      { name: 'login-route', html: form, route: '/login.php', expected: 'logged-out' },
      {
        name: 'split-forms',
        html: '<form>' + email + '</form><form>' + password + '</form>',
        route: '/',
        expected: 'unknown',
      },
      {
        name: 'hidden-parent',
        html: '<div hidden>' + form + '</div>',
        route: '/',
        expected: 'unknown',
      },
      { name: 'multiple-forms', html: form + form, route: '/', expected: 'unknown' },
      { name: 'registration', html: form, route: '/reg/', expected: 'unknown' },
      {
        name: 'conflicting-profile',
        html: '<header role="banner"><a href="/profile.php?id=42">Profile</a></header>' + form,
        route: '/',
        expected: 'unknown',
      },
    ]) {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><body>' + item.html + '</body>'),
      );
      const projection = validateProjection(
        facebookIdentityProjection,
        await window.webContents.executeJavaScript(
          pageProjectionExpression(facebookIdentityProjection),
        ),
      );
      // The generated data: URL itself contains fixture markup; inspect only projected DOM data.
      assert.equal(JSON.stringify(projection.rows).includes('GENERATED_PRIVATE_SENTINEL'), false);
      // Only the analyser route is synthetic; selector/visibility results are actual Chromium DOM.
      const analysed = analyzeFacebookIdentityPage({
        ...projection,
        url: 'https://www.facebook.com' + item.route,
      });
      assert.equal(analysed.account.state, item.expected, item.name);
      assert.equal(analysed.account.id, null);
      results.push({ name: item.name, state: analysed.account.state, credentialValuesRead: false });
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          recordedAt: new Date().toISOString(),
          actualFacebook: false,
          actualBrowserProfile: false,
          generatedDOM: true,
          syntheticFacebookRoute: true,
          chromium: process.versions.chrome,
          results,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  } catch (error) {
    await writeFile(
      report,
      JSON.stringify(
        { ok: false, results, error: error instanceof Error ? error.message : 'DOM_CHECK_FAILED' },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
