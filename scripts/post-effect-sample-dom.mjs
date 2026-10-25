import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readFacebookPostEffects } from '../dist/src/infrastructure/facebook-post-effect-reader.js';

// Offline DOM replay of the four already-authorized real results. No new FB action or request.
const root = path.resolve('audit/post-test-content-a8b848f3-29e7-410d-9697-2690dd2a1d84');
const report = path.resolve('audit/post-effect-real-samples-' + randomUUID() + '.json');
const user = path.resolve('audit/post-effect-samples-user-' + randomUUID());
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
    const review = JSON.parse(await readFile(path.join(root, 'review.json'), 'utf8'));
    const page = {
      evaluate: async (fn) => {
        const value = await window.webContents.executeJavaScript('(' + fn.toString() + ')()');
        return {
          ...value,
          url: 'https://www.facebook.com/profile.php?id=' + review.accountIdCandidate,
        };
      },
    };
    for (const [index, file] of [
      'text-result.json',
      'single-result.json',
      'multi-result.json',
      'video-result.json',
    ].entries()) {
      const saved = JSON.parse(await readFile(path.join(root, file), 'utf8'));
      const item = Array.isArray(saved) ? saved[0] : saved;
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<!doctype html><meta charset="utf-8">' + (item.html ?? item.outerHTML),
          ),
      );
      const reading = await readFacebookPostEffects(page, () => {});
      assert.equal(reading.posts.length, 1);
      const post = reading.posts[0];
      assert.equal(post.accountId, review.accountIdCandidate);
      assert.ok(post.postId);
      assert.ok(post.permalink);
      assert.equal(post.nestedShare, false);
      assert.equal(
        post.text.replace(/\s+/gu, ' ').trim(),
        review.rows[index].text.replace(/\s+/gu, ' ').trim(),
      );
      assert.equal(post.photos.length, [0, 1, 2, 0][index]);
      if (index === 3) assert.equal(post.videoId, post.postId);
      checks.push({
        format: review.rows[index].type,
        postId: post.postId,
        fullOriginalRenderedText: true,
        photoCount: post.photos.length,
        videoId: post.videoId,
      });
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          kind: 'offline-replay-of-real-cua-dom',
          newFacebookActions: 0,
          externalRequestsBlocked: true,
          videoDecodeNotRetested: true,
          managedExecutorAcceptance: false,
          checks,
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
