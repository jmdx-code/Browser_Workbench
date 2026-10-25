import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('scripts/facebook-feed-projection-fixture.mjs')],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} else {
  const { app, BrowserWindow } = await import('electron');
  const directory = path.resolve('audit/feed-projection-fixture-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { projectFacebookBrowsePage, FacebookBrowsePage } =
      await import('../dist/src/infrastructure/facebook-browse-reader.js');
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    const checks = [];
    let documentHTML = '';
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
      response.end(documentHTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const actions =
      '<i data-ad-rendering-role="like_button"></i><i data-ad-rendering-role="share_button"></i>';
    const author = '<h4 data-ad-rendering-role="profile_name">Fixture author</h4>';
    const post = (body, markers = actions, attributes = '') =>
      '<section ' +
      attributes +
      ' style="width:300px;height:250px">' +
      author +
      body +
      markers +
      '</section>';
    const body =
      '<div data-ad-rendering-role="story_message" style="height:100px">Visible fixture body</div>';
    const skeleton =
      '<div role="article" style="position:absolute;left:350px;top:0;width:600px;height:600px"></div>';
    async function read(html, mediaState, route = '/') {
      documentHTML =
        '<style>body{margin:0}main{min-height:800px}h4{margin:0}</style><main>' + html + '</main>';
      await window.loadURL(origin + route);
      if (mediaState)
        await window.webContents.executeJavaScript(
          'for(const el of document.querySelectorAll("video")) Object.defineProperties(el,' +
            JSON.stringify(
              Object.fromEntries(
                Object.entries(mediaState).map(([key, value]) => [
                  key,
                  { value, configurable: true },
                ]),
              ),
            ) +
            ');',
        );
      await window.webContents.executeJavaScript(`
        window.__projectionVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
        window.__projectionHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
        window.__projectionFocus = Document.prototype.hasFocus;
        window.__projectionOwnFocus = Object.hasOwn(document, 'hasFocus');
        window.setInterval = () => { throw Error('READ_PROJECTION_TIMER_FORBIDDEN'); };
        HTMLMediaElement.prototype.play = () => { throw Error('READ_PROJECTION_PLAY_FORBIDDEN'); };
        true;
      `);
      const result = FacebookBrowsePage.parse(
        await window.webContents.executeJavaScript(
          '(' + projectFacebookBrowsePage.toString() + ')()',
        ),
      );
      const readOnly = await window.webContents.executeJavaScript(`({
        visibility: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get === window.__projectionVisibility,
        hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get === window.__projectionHidden,
        focus: Document.prototype.hasFocus === window.__projectionFocus && Object.hasOwn(document, 'hasFocus') === window.__projectionOwnFocus,
        events: (() => { let seen = false; document.addEventListener('visibilitychange', () => { seen = true; }, { once: true }); document.dispatchEvent(new Event('visibilitychange')); return seen; })()
      })`);
      assert.ok(
        Object.values(readOnly).every(Boolean),
        'BROWSE_PROJECTION_MUST_BE_READ_ONLY:' + JSON.stringify(readOnly),
      );
      return result;
    }
    try {
      let value = await read(post(body) + skeleton);
      checks.push(
        'each browse projection preserves native visibility/focus/events and never schedules timers or plays media',
      );
      assert.match(value.contentKey, /Visible fixture body/);
      assert.equal(value.structure.structuralPosts, 1);
      checks.push('roleless visible body survives a larger empty article placeholder');
      value = await read(skeleton);
      assert.equal(value.contentKey, null);
      checks.push('empty placeholders are not feed content');
      value = await read(
        post(
          '<div data-ad-rendering-role="story_message" style="position:absolute;top:1500px">Offscreen body</div>',
        ),
      );
      assert.equal(value.contentKey, null);
      checks.push('author and controls without visible body grant no content');
      value = await read(post(body, ''));
      assert.equal(value.contentKey, null);
      checks.push('isolated author/message markers without a post action boundary are rejected');
      value = await read(post(body, actions, 'aria-busy="true"'));
      assert.equal(value.contentKey, null);
      checks.push('busy roleless post is not credited');
      value = await read(post(author + body));
      assert.equal(value.contentKey, null);
      checks.push('ambiguous multi-author aggregate is not a single post boundary');
      value = await read(
        '<div role="article" style="height:100px">Legacy visible article</div>' + skeleton,
      );
      assert.equal(value.contentKey, 'Legacy visible article');
      checks.push('legacy article survives a larger blank placeholder');
      value = await read(
        '<div role="article" aria-busy="true" style="height:100px">Loading fixture</div>',
      );
      assert.equal(value.contentKey, null);
      checks.push('busy article is not credited');
      const pixel =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
      value = await read(post('<img src="' + pixel + '" width="200" height="200">'));
      assert.match(value.contentKey, /^post:/);
      checks.push('decoded visible post-sized picture supports roleless media-only posts');
      value = await read(
        post(
          '<style>h4{position:absolute;top:-100px}</style><img src="' +
            pixel +
            '" width="200" height="200">',
        ),
      );
      assert.match(value.contentKey, /^post:/);
      checks.push(
        'visible loaded post image remains content when its author is above the viewport',
      );
      value = await read(post('<img src="' + pixel + '" width="40" height="40">'));
      assert.equal(value.contentKey, null);
      checks.push('avatar-sized image is not post body');
      value = await read(
        '<div style="overflow-y:auto;height:200px"><div style="height:1200px"></div></div>',
      );
      assert.equal(value.structure.scrollRoots.length, 0);
      checks.push('off-target scroll panel is not adopted as the center wheel root');
      value = await read(
        '<div style="overflow-y:auto;height:200px;position:absolute;left:0;right:0;top:calc(50vh - 100px)"><div style="height:1200px"></div></div>',
      );
      assert.equal(value.structure.scrollRoots.length, 1);
      assert.equal(value.structure.scrollRoots[0].top, 0);
      assert.equal(value.structure.scrollRoots[0].max, 1000);
      assert.ok(value.structure.centerHit);
      checks.push('bounded scroll-root and center-hit geometry are read without copying page text');
      const video = '<video style="width:200px;height:200px"></video>';
      const decoded = { readyState: 4, videoWidth: 360, videoHeight: 640, error: null };
      value = await read(post(video), decoded);
      assert.match(value.contentKey, /^post:.*video:decoded:/);
      assert.equal(value.video, null);
      checks.push(
        'modeled decoded no-URL media-only post supports feed content, not Reels playback evidence',
      );
      for (const state of [
        { ...decoded, readyState: 0 },
        { ...decoded, videoWidth: 0 },
        { ...decoded, error: { code: 3 } },
      ]) {
        value = await read(post(video), state);
        assert.equal(value.contentKey, null);
      }
      checks.push('unready, zero-dimension and failed modeled videos are not loaded post content');
      value = await read(
        post('<video style="position:absolute;top:1500px;width:200px;height:200px"></video>'),
        decoded,
      );
      assert.equal(value.contentKey, null);
      checks.push('offscreen decoded modeled media is not visible feed content');
      value = await read(post(video, ''), decoded);
      assert.equal(value.contentKey, null);
      value = await read(post(author + video), decoded);
      assert.equal(value.contentKey, null);
      checks.push(
        'decoded modeled video still requires one post author and both action boundaries',
      );
      value = await read(post(video), decoded, '/reel/123');
      assert.equal(value.contentKey, null);
      assert.equal(value.video, null);
      checks.push('decoded inline feed fallback cannot manufacture a source-less Reel player');
      const { projectFacebookComposerAudience } =
        await import('../dist/src/infrastructure/facebook-composer-audience.js');
      const { audienceTarget } = await import('../dist/src/domain/facebook-audience.js');
      for (const label of ['Done', 'Done with privacy audience selection and close dialog']) {
        for (const duplicate of [false, true]) {
          const button = '<div role="button" aria-label="' + label + '">Done</div>';
          documentHTML =
            '<div role="dialog"><form style="display:none"><div role="textbox" contenteditable="true"></div></form>' +
            '<h2>Post audience</h2><div role="radiogroup" aria-label="Select audience"><label><input type="radio" checked>Only me</label></div>' +
            '<label><input type="checkbox">Set as default audience.</label>' +
            button +
            (duplicate ? button : '') +
            '</div>';
          await window.loadURL(origin);
          const privacy = await window.webContents.executeJavaScript(
            '(' + projectFacebookComposerAudience.toString() + ')()',
          );
          assert.equal(privacy.phase, duplicate ? 'UNAVAILABLE' : 'MENU');
          assert.equal(audienceTarget(privacy, 'CONFIRM_AUDIENCE') !== null, !duplicate);
          assert.equal(
            audienceTarget({ ...privacy, defaultChecked: true }, 'CONFIRM_AUDIENCE'),
            null,
          );
        }
      }
      checks.push(
        'both observed audience Done labels support a unique native menu; duplicates and default changes cannot confirm',
      );
      const {
        projectFacebookStoryPage,
        projectFacebookStoryMediaBytes,
        projectFacebookStoryVideoInput,
        FacebookStoryPage,
      } = await import('../dist/src/infrastructure/facebook-story-page-reader.js');
      documentHTML =
        '<html lang="en"><body><nav role="navigation" aria-label="Stories Creation Form">' +
        '<div role="button" aria-label="Story privacy settings">Privacy</div>' +
        '<div role="button" aria-label="Share to story">Share</div>' +
        '<div role="button" aria-pressed="false">Add text</div></nav>' +
        '<main role="main" aria-label="Stories Creation Preview"><h2>Preview</h2><img style="width:200px;height:300px">' +
        '<div role="textbox" aria-label="Start typing" contenteditable="false">Fixture caption</div></main></body></html>';
      await window.loadURL(origin + '/stories/create/');
      const generated = await window.webContents.executeJavaScript(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
        const context = canvas.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0,0,2,2);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const image = document.querySelector('img'); image.src = URL.createObjectURL(blob); await image.decode();
        return btoa(String.fromCharCode(...bytes));
      })()`);
      const storyProjection =
        '(' +
        projectFacebookStoryPage
          .toString()
          .replace(
            "location.origin === 'https://www.facebook.com'",
            'location.origin === ' + JSON.stringify(origin),
          ) +
        ')()';
      const story = FacebookStoryPage.parse(
        await window.webContents.executeJavaScript(storyProjection),
      );
      assert.equal(story.phase, 'media-editor');
      assert.equal(story.text, 'Fixture caption');
      assert.equal(story.textEditing, false);
      assert.equal(story.media?.ready, true);
      assert.equal(story.addText?.enabled, true);
      assert.equal(
        await window.webContents.executeJavaScript(
          'document.querySelector(' + JSON.stringify(story.addText.css) + ').textContent',
        ),
        'Add text',
      );
      await window.webContents.executeJavaScript(`(() => {
        const shell = document.createElement('div'); shell.setAttribute('role', 'dialog');
        shell.append(...document.body.childNodes); document.body.append(shell);
      })()`);
      assert.equal(
        (await window.webContents.executeJavaScript(storyProjection)).privacy?.phase,
        'CLOSED',
      );
      await window.webContents.executeJavaScript(`(() => {
        const blocker = document.createElement('div'); blocker.id = 'fixture-blocker';
        blocker.setAttribute('role', 'dialog'); blocker.textContent = 'Unknown dialog';
        document.body.append(blocker);
      })()`);
      assert.equal(
        (await window.webContents.executeJavaScript(storyProjection)).privacy?.phase,
        'UNAVAILABLE',
      );
      await window.webContents.executeJavaScript(
        'document.getElementById("fixture-blocker").remove()',
      );
      checks.push(
        'native SPA editor shell permits privacy access; unrelated visible dialogs still block',
      );
      const storyMediaProjection =
        '(' +
        projectFacebookStoryMediaBytes
          .toString()
          .replace(
            "location.origin !== 'https://www.facebook.com'",
            'location.origin !== ' + JSON.stringify(origin),
          ) +
        ') ("image")';
      const mediaProof = await window.webContents.executeJavaScript(storyMediaProjection);
      const generatedBytes = Buffer.from(generated, 'base64');
      assert.equal(mediaProof?.bytes, generatedBytes.length);
      assert.equal(mediaProof?.sha256, createHash('sha256').update(generatedBytes).digest('hex'));
      await window.webContents.executeJavaScript(
        'document.querySelector("main").append(document.querySelector("img").cloneNode());',
      );
      assert.equal(
        (await window.webContents.executeJavaScript(storyProjection)).phase,
        'ambiguous',
      );
      assert.equal(await window.webContents.executeJavaScript(storyMediaProjection), null);
      checks.push(
        'media story preserves read-only caption and hashes only one decoded owned Blob; duplicate previews cannot verify',
      );
      await window.webContents.executeJavaScript(`document.querySelector('main').innerHTML =
        '<input type="file" accept="image/*,video/*"><div role="button" aria-label="Create a text story">Create a text story</div>';`);
      assert.equal((await window.webContents.executeJavaScript(storyProjection)).phase, 'entry');
      checks.push(
        'an empty story entry inside the retained Preview container is still entry, not an unfinished media editor',
      );
      await window.webContents.executeJavaScript(`document.querySelector('main').innerHTML =
        '<img alt="Generated actor" style="width:40px;height:40px"><canvas width="608" height="1080" style="width:200px;height:300px"></canvas><input type="file" accept="image/*,video/*">';`);
      const nativeCanvas = await window.webContents.executeJavaScript(storyProjection);
      assert.equal(nativeCanvas.nativeVideoCanvas, true);
      assert.equal(nativeCanvas.phase, 'ambiguous');
      assert.equal(nativeCanvas.submit, null);
      checks.push('native video canvas cannot borrow an avatar as media or grant a submit target');
      await window.webContents.executeJavaScript(`(() => {
        const selection = new DataTransfer();
        selection.items.add(new File(['generated-selected-video'], 'pattern.mp4', {type:'video/mp4'}));
        document.querySelector('input[type="file"]').files = selection.files;
      })()`);
      const videoInputProjection =
        '(' +
        projectFacebookStoryVideoInput
          .toString()
          .replace(
            "location.origin !== 'https://www.facebook.com'",
            'location.origin !== ' + JSON.stringify(origin),
          ) +
        ')()';
      const selectedVideo = await window.webContents.executeJavaScript(videoInputProjection);
      assert.equal(selectedVideo.bytes, Buffer.byteLength('generated-selected-video'));
      assert.equal(
        selectedVideo.sha256,
        createHash('sha256').update('generated-selected-video').digest('hex'),
      );
      assert.equal((await window.webContents.executeJavaScript(storyProjection)).submit, null);
      await window.webContents.executeJavaScript(
        'document.querySelector(\'input[type="file"]\').value = "";',
      );
      assert.equal(await window.webContents.executeJavaScript(videoInputProjection), null);
      checks.push(
        'selected video FileList has exact bounded bytes, but neither it nor Canvas grants readiness or submission',
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            outcome: 'PASSED',
            checks,
            realFacebook: false,
            browserBusinessOperations: 0,
            mediaStatesModeled: true,
          },
          null,
          2,
        ),
      );
      console.log('FEED_PROJECTION_PASSED ' + directory);
    } catch (error) {
      await writeFile(path.join(directory, 'failure.txt'), String(error));
      console.error(error);
      process.exitCode = 1;
    } finally {
      window.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.exit(process.exitCode ?? 0);
    }
  }
}
