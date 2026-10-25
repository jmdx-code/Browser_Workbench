import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectFacebookPostEffects } from '../dist/src/infrastructure/facebook-post-effect-reader.js';
import { LookupNativeFacebookPostResultResolver } from '../dist/src/infrastructure/facebook-native-result-resolver.js';

const root = path.resolve('audit/post-test-content-a8b848f3-29e7-410d-9697-2690dd2a1d84');
const report = path.resolve('audit/native-result-alias-dom-' + randomUUID() + '.json');
const user = path.resolve('audit/native-result-alias-user-' + randomUUID());
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
      (_r, done) => done({ cancel: true }),
    );
    const sample = JSON.parse(
      await readFile(path.join(root, 'native-numeric-result-alias.json'), 'utf8'),
    );
    const html = await readFile(path.join(root, 'native-numeric-result-alias-scoped.html'), 'utf8');
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<!doctype html><meta charset="utf-8"><div role="dialog">' + html + '</div>',
        ),
    );
    const effects = await window.webContents.executeJavaScript(
      '(' + projectFacebookPostEffects.toString() + ')("result-dialog")',
    );
    effects.url = sample.currentUrl;
    assert.equal(effects.posts.length, 1);
    const post = effects.posts[0];
    assert.equal(post.accountId, sample.accountId);
    assert.equal(post.postId, sample.canonicalPostId);
    assert.deepEqual(post.photos, [sample.photoId]);
    const review = JSON.parse(await readFile(path.join(root, 'network-review.json'), 'utf8'));
    assert.equal(post.text, review.rows[1].text);
    assert.equal(post.expanded, true);
    checks.push('actual-result-dialog-author-full-text-canonical-link-and-native-photo');
    const resolver = new LookupNativeFacebookPostResultResolver({
      ready: () => true,
      read: async () => effects,
    });
    const original = {
      intent: {
        context: { accountId: sample.accountId },
        snapshot: { text: review.rows[1].text, format: 'single-image', files: [{ role: 'image' }] },
      },
      link: { purpose: 'SUBMIT' },
    };
    const accepted = {
      nativePostId: sample.nativePostId,
      nativeStoryId: 'unused',
      flow: 'ASYNC_SILENT',
      photos: [sample.photoId],
      videoId: null,
    };
    assert.equal(
      (await resolver.resolve(accepted, original, () => {}))?.postId,
      sample.canonicalPostId,
    );
    checks.push('native-numeric-result-resolves-to-actual-visible-post');
    effects.url = 'https://www.facebook.com/';
    assert.equal(await resolver.resolve(accepted, original, () => {}), null);
    checks.push('feed-route-not-an-alias');
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          checks,
          newFacebookActions: 0,
          externalRequestsBlocked: true,
          generatedDialogWrapper: true,
          managedExecutorAcceptance: false,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(report);
  } catch (error) {
    await writeFile(report, JSON.stringify({ ok: false, checks, error: error.message }, null, 2), {
      flag: 'wx',
    });
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
