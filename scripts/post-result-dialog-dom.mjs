import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectFacebookPostEffects } from '../dist/src/infrastructure/facebook-post-effect-reader.js';

const root = path.resolve('audit/post-result-dialog-dom-' + randomUUID());
await mkdir(root);
app.setPath('userData', path.join(root, 'user'));
void run();
async function run() {
  let window;
  const checks = [],
    timer = setTimeout(() => app.exit(1), 45000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        partition: randomUUID(),
      },
    });
    const url = 'https://www.facebook.com/permalink.php?story_fbid=222&id=111';
    const post = `<div role="dialog"><h2>Generated user's Post</h2><div data-ad-rendering-role="profile_name"><a href="/profile.php?id=111&amp;tracking=fixture">Generated user</a></div><a href="?tracking=fixture#timestamp">8m</a><div data-ad-rendering-role="story_message"><div data-ad-comet-preview="message"><div dir="auto"><img width="16" height="16" src="https://static.xx.fbcdn.net/images/emoji.php/v9/test/16/test.png" alt="&#129505;"> first paragraph</div><div dir="auto">Second paragraph</div></div></div><button role="button" aria-label="Edit audience"><img alt="Only me"></button></div>`;
    window.webContents.session.protocol.handle('https', (request) =>
      request.url === url
        ? new Response(
            '<!doctype html><style>body{margin:0}div{min-height:20px}</style><div role="dialog">' +
              post +
              '</div><div role="dialog" aria-label="Messenger"><h2>Unrelated dialog</h2></div>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        : new Response('blocked', { status: 403 }),
    );
    const load = () => window.loadURL(url),
      read = () =>
        window.webContents.executeJavaScript(
          '(' + projectFacebookPostEffects.toString() + ')("result-dialog")',
        );
    await load();
    let value = await read();
    assert.equal(value.posts.length, 1);
    assert.equal(value.posts[0].postId, '222');
    assert.equal(value.posts[0].accountId, '111');
    assert.equal(value.posts[0].permalink, url);
    assert.equal(value.posts[0].text, '\u{1f9e1} first paragraph\nSecond paragraph');
    checks.push(
      'single-innermost-native-permalink-dialog-without-article-preserves-emoji-and-all-text',
    );
    assert.equal(
      (
        await window.webContents.executeJavaScript(
          '(' + projectFacebookPostEffects.toString() + ')("visible")',
        )
      ).posts.length,
      0,
    );
    checks.push('dialog-fallback-does-not-broaden-feed');
    for (const [name, mutation, check] of [
      [
        'short-native-message-without-preview-or-dir-auto',
        `document.querySelector('[data-ad-rendering-role="story_message"]').innerHTML='<div><span><div>Generated short text</div></span></div>'`,
        (r) => r.posts.length === 1 && r.posts[0].text === 'Generated short text',
      ],
      [
        'ambiguous-native-messages-without-preview-are-not-merged',
        `document.querySelector('[data-ad-rendering-role="story_message"]').innerHTML='<div>First</div>';document.querySelector('[data-ad-rendering-role="story_message"]').insertAdjacentHTML('afterend','<div data-ad-rendering-role="story_message">Second</div>')`,
        (r) => r.posts[0]?.text === null,
      ],
      [
        'foreign-actor',
        `document.querySelector('[data-ad-rendering-role="profile_name"] a').href='/profile.php?id=999'`,
        (r) => r.posts[0]?.postId === null,
      ],
      [
        'duplicate-post-dialog',
        `document.body.insertAdjacentHTML('beforeend',${JSON.stringify(post)})`,
        (r) => r.posts.length === 0,
      ],
      [
        'conflicting-native-link',
        `document.querySelector('[data-ad-rendering-role="profile_name"]').insertAdjacentHTML('afterend','<a href="/permalink.php?story_fbid=333&amp;id=111">Other result</a>')`,
        (r) => r.posts[0]?.postId === '333',
      ],
      [
        'unsupported-caption-image',
        `document.querySelector('[data-ad-comet-preview="message"] img').src='https://untrusted.example/image.png'`,
        (r) => r.posts[0]?.text === null,
      ],
      [
        'folded-english-caption',
        `document.querySelector('[data-ad-comet-preview="message"]').insertAdjacentHTML('beforeend','<button role="button">See more</button>')`,
        (r) => r.posts[0]?.expanded === false,
      ],
    ]) {
      await load();
      await window.webContents.executeJavaScript(mutation);
      assert.ok(check(await read()), name);
      checks.push(name);
    }
    await writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          checks,
          facebookActions: 0,
          uploads: 0,
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
    clearTimeout(timer);
    app.exit(0);
  } catch (error) {
    await writeFile(
      path.join(root, 'result.json'),
      JSON.stringify({ ok: false, checks, error: String(error) }, null, 2),
      { flag: 'wx' },
    );
    console.error(error);
    window?.destroy();
    clearTimeout(timer);
    app.exit(1);
  }
}
