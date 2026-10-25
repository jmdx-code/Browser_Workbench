import { app, BrowserWindow } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectFacebookReelResult } from '../dist/src/infrastructure/facebook-reel-result-reader.js';

// Actual sanitized own-result markup with generated layout and local decoding. No network,
// native browser control, Facebook input, original reservation or publication is performed.
const report = path.resolve('audit/reel-result-dom-' + randomUUID() + '.json');
const user = path.resolve('audit/reel-result-dom-user-' + randomUUID());
await mkdir(user, { recursive: true });
app.setPath('userData', user);
void run();
async function run() {
  let window;
  const checks = [],
    timer = setTimeout(() => app.exit(1), 30000);
  try {
    const html = await readFile('audit/reel-result-readonly-0313/scoped-safe.html', 'utf8');
    const sample = JSON.parse(
      await readFile(
        'audit/post-test-content-a8b848f3-29e7-410d-9697-2690dd2a1d84/network-video-sample.json',
        'utf8',
      ),
    );
    const bytes = await readFile(
      'audit/video-readiness-valid-0313/resources/new-video/post/sample-valid-320x180.mp4',
    );
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1200,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: randomUUID(),
      },
    });
    // Intercept only the exact fixture document. Every other HTTP request is blocked.
    const url = 'https://www.facebook.com/reel/2092087444732127/';
    const document =
      '<!doctype html><meta charset="utf-8"><style>body{margin:0}svg{display:none}video{width:320px;height:180px} span[dir="auto"]{display:block} [role="group"]{width:600px;min-height:200px}</style><main>' +
      html +
      '</main>';
    window.webContents.session.protocol.handle('https', (request) =>
      request.url === url
        ? new Response(document, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : new Response('blocked', { status: 403 }),
    );
    await window.loadURL(url);
    const project = () =>
      window.webContents.executeJavaScript('(' + projectFacebookReelResult.toString() + ')()');
    let value = await project();
    assert.equal(value.posts.length, 1);
    assert.equal(value.posts[0].videoReady, false);
    checks.push('actual caption/author structure yields only original route and unready video');
    await window.webContents
      .executeJavaScript(`new Promise((resolve,reject)=>{const video=document.querySelector('video');
      video.addEventListener('loadeddata',()=>resolve(true),{once:true});video.addEventListener('error',()=>reject(Error('local decode failed')),{once:true});
      video.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))],{type:'video/mp4'}));video.load();})`);
    value = await project();
    const post = value.posts[0];
    assert.equal(post.videoReady, true);
    assert.equal(post.accountId, sample.request.av);
    assert.equal(post.videoId, '2092087444732127');
    assert.equal(
      post.text.replace(/\s+/gu, ' ').trim(),
      sample.request.input.message.text.replace(/\s+/gu, ' ').trim(),
    );
    checks.push(
      'full real multiline caption excludes collapse control; decoded local video belongs to same player',
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('main').insertAdjacentHTML('beforeend','<div role="group" aria-label="Video player"><h2><a href="/profile.php?id=999">Other</a></h2><span dir="auto">Foreign caption</span><video></video></div>')`,
    );
    assert.deepEqual((await project()).posts, []);
    checks.push('a second visible author/player is ambiguous, not a latest-post fallback');
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          actualFacebook: false,
          actualSanitizedDOM: true,
          generatedLayout: true,
          localDecodedVideo: true,
          externalNetwork: false,
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
    await writeFile(
      report,
      JSON.stringify({ ok: false, actualFacebook: false, checks, error: String(error) }, null, 2),
      { flag: 'wx' },
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
