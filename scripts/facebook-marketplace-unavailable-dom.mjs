import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  projectFacebookBrowsePage,
  FacebookBrowsePage,
} from '../dist/src/infrastructure/facebook-browse-reader.js';
void (async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'workbench-marketplace-dom-'));
  app.setPath('userData', temp);
  await app.whenReady();
  let window;
  const checks = [];
  try {
    window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_r, done) => done({ cancel: true }),
    );
    const headings = [
      "Marketplace Isn't Available to You",
      'You Can’t Use Marketplace Right Now',
      '无法使用 Marketplace',
      '你目前无法使用 Marketplace',
    ];
    async function check(name, html, expected, route = '/marketplace/') {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<!doctype html><meta charset=utf-8>' + html),
      );
      const source = projectFacebookBrowsePage
        .toString()
        .replaceAll('location.pathname', JSON.stringify(route));
      const value = FacebookBrowsePage.parse(
        await window.webContents.executeJavaScript('(' + source + ')()'),
      );
      assert.equal(value.marketplaceUnavailable, expected, name);
      checks.push(name);
    }
    for (const heading of headings)
      await check('empty-state heading: ' + heading, '<main><h1>' + heading + '</h1></main>', true);
    await check(
      'same hint in product description',
      '<main><p>无法使用 Marketplace</p></main>',
      false,
    );
    await check(
      'same heading inside a post',
      '<main><article><h1>无法使用 Marketplace</h1></article></main>',
      false,
    );
    await check(
      'hidden heading',
      '<main><h1 style="display:none">无法使用 Marketplace</h1></main>',
      false,
    );
    await check(
      'visible merchandise blocks denial',
      '<main><h1>无法使用 Marketplace</h1><a href="https://www.facebook.com/marketplace/item/123/">Product</a></main>',
      false,
    );
    await check(
      'feed heading cannot deny marketplace',
      '<main><h1>无法使用 Marketplace</h1></main>',
      false,
      '/',
    );
    await check('heading outside main', '<h1>无法使用 Marketplace</h1><main>Content</main>', false);
    await check('missing main', '<h1>无法使用 Marketplace</h1>', false);
    await check(
      'dialog obscures interpretation',
      '<main><h1>无法使用 Marketplace</h1></main><div role=dialog>Loading</div>',
      false,
    );
    await check(
      'empty product detail restriction',
      '<main><h1>无法使用 Marketplace</h1></main>',
      true,
      '/marketplace/item/123/',
    );
    await check(
      'loaded product title is not denial',
      '<main><h1>无法使用 Marketplace</h1><button role=button>Product action</button></main>',
      false,
      '/marketplace/item/123/',
    );
    const report = {
      at: new Date().toISOString(),
      passed: true,
      checks,
      actualChromium: true,
      actualFacebook: false,
      externalNetwork: false,
      userProfilesTouched: false,
    };
    await writeFile(
      'audit/marketplace-unavailable-dom-results.json',
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ passed: true, checks: checks.length }));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
