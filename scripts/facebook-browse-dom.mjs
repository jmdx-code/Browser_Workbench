import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  projectFacebookBrowsePage,
  FacebookBrowsePage,
  FACEBOOK_REEL_NEXT_CSS,
} from '../dist/src/infrastructure/facebook-browse-reader.js';

const id = randomUUID(),
  user = path.resolve('audit/browse-dom-user-' + id);
const report = path.resolve('audit/browse-dom-' + id + '.json');
await mkdir(user, { recursive: true });
app.setPath('userData', user);
void run();
async function run() {
  let window;
  const checks = [],
    timer = setTimeout(() => app.exit(1), 30_000);
  try {
    const bytes = await readFile(
      path.resolve(
        'audit/video-readiness-valid-0313/resources/new-video/post/sample-valid-320x180.mp4',
      ),
    );
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: id,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }),
    );
    const file = path.join(user, 'fixture.html');
    await writeFile(
      file,
      '<!doctype html><meta charset="utf-8"><main><div role="article" style="height:1800px"><a href="/posts/123">Generated article</a></div></main>',
      { flag: 'wx' },
    );
    await window.loadFile(file);
    const project = async () =>
      FacebookBrowsePage.parse(
        await window.webContents.executeJavaScript(
          '(' + projectFacebookBrowsePage.toString() + ')()',
        ),
      );
    let value = await project();
    assert.equal(value.ready, true);
    assert.equal(value.contentKey, '/posts/123');
    checks.push('visible article is structurally scoped without language text');
    await window.webContents.executeJavaScript('scrollTo(0,500)');
    assert.ok((await project()).scrollY >= 499);
    checks.push('actual Chromium scroll offset is observed');
    await window.webContents.executeJavaScript(
      'scrollTo(0,0);document.querySelector("main").innerHTML=`<div style="height:200px;width:500px;overflow-y:auto"><div style="height:1800px">nested scroll</div></div>`;document.querySelector("main>div").scrollTop=400',
    );
    assert.ok((await project()).scrollY >= 399);
    checks.push('inner feed scroller is observed even when window scroll stays zero');
    await window.webContents.executeJavaScript(
      'document.querySelector("main").innerHTML=`<a style="display:block;width:300px;height:100px" href="https://www.facebook.com/reel/123456">sample reel card</a>`',
    );
    assert.equal((await project()).videoEntry, 'https://www.facebook.com/reel/123456');
    checks.push('visible reel entry is taken from the actual anchor URL');
    await window.webContents.executeJavaScript(
      'scrollTo(0,0);document.querySelector("main").innerHTML="<video width=320 height=180 muted></video>"',
    );
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const video=document.querySelector('video'); video.muted=true;
      video.addEventListener('loadeddata',()=>resolve(true),{once:true});
      video.addEventListener('error',()=>reject(Error('decode failed')),{once:true});
      video.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))],{type:'video/mp4'}));video.load();
    })`);
    value = await project();
    assert.ok(value.video?.css);
    assert.equal(value.video.paused, true);
    await window.webContents.executeJavaScript("document.querySelector('video').play()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await project();
    assert.equal(value.video.paused, false);
    assert.ok(value.video.timeSeconds > 0);
    checks.push('decoded local video paused and actual advancing playback are distinguished');
    await window.webContents.executeJavaScript(
      'document.querySelector("main").insertAdjacentHTML("beforeend","<video width=320 height=180 style=opacity:0></video>")',
    );
    value = await project();
    assert.ok(value.video?.source);
    assert.equal(value.structure.visibleVideos, 1);
    assert.equal(value.structure.players[1].area, 0);
    assert.equal(value.structure.players[1].sourceLength, 0);
    assert.equal(value.structure.players[1].readyState, 0);
    checks.push(
      'transparent preload player does not hide the active media; missing source and loading state remain diagnosable',
    );
    await window.webContents.executeJavaScript(
      'document.querySelector("main>video:last-child").remove()',
    );
    await window.webContents.executeJavaScript(
      'document.querySelector("main").insertAdjacentHTML("beforeend","<video width=320 height=180 style=display:inline-block></video>")',
    );
    assert.equal((await project()).video, null);
    checks.push('equal visible players are ambiguous, no arbitrary media selected');
    await window.webContents.executeJavaScript(`new Promise(async (resolve,reject)=>{
      document.querySelector('main').innerHTML='<video width=320 height=180 muted></video>';
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const video=document.querySelector('video');video.srcObject=canvas.captureStream(20);
      const context=canvas.getContext('2d');
      const animation=setInterval(()=>{context.fillStyle='green';context.fillRect(0,0,320,180)},50);
      try {await video.play();setTimeout(()=>{clearInterval(animation);resolve(true)},250)}catch(error){clearInterval(animation);reject(error)}
    })`);
    const streamProject = projectFacebookBrowsePage
      .toString()
      .replaceAll('location.href', JSON.stringify('https://www.facebook.com/reel/123456'));
    value = FacebookBrowsePage.parse(
      await window.webContents.executeJavaScript('(' + streamProject + ')()'),
    );
    assert.equal(value.structure.players[0].sourceLength, 0);
    assert.equal(value.video.source, 'srcObject:https://www.facebook.com/reel/123456');
    assert.equal(value.video.paused, false);
    assert.ok(value.video.timeSeconds > 0);
    const streamUnscoped = await project();
    assert.equal(streamUnscoped.video, null);
    checks.push(
      'actual decoded srcObject playback on a generated exact Reel route is observed; an unscoped stream stays rejected',
    );
    const nextProject = streamProject.replaceAll(
      'location.pathname',
      JSON.stringify('/reel/123456'),
    );
    for (const label of ['Next Card', '下一条快拍']) {
      await window.webContents
        .executeJavaScript(`document.querySelector('main').setAttribute('role','main');
        document.querySelector('main').insertAdjacentHTML('beforeend', '<button role="button" aria-label="${label}" style="width:48px;height:48px"></button>');`);
      const next = () => window.webContents.executeJavaScript('(' + nextProject + ')()');
      assert.equal((await next()).nextReelCSS, FACEBOOK_REEL_NEXT_CSS);
      await window.webContents.executeJavaScript(
        "document.querySelector('main>button').setAttribute('aria-disabled','true')",
      );
      assert.equal((await next()).nextReelCSS, null);
      await window.webContents.executeJavaScript("document.querySelector('main>button').remove()");
    }
    checks.push(
      'observed English and Simplified Chinese next-card labels select the same exact native command; disabled controls cannot',
    );
    await window.webContents.executeJavaScript(
      'document.body.insertAdjacentHTML("beforeend","<div role=dialog aria-modal=true style=width:100px;height:100px>Generated modal</div>")',
    );
    assert.equal((await project()).blocked, true);
    checks.push('visible modal blocks browse decisions');
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          checks,
          actualChromium: true,
          actualFacebook: false,
          generatedLayout: true,
          externalNetwork: false,
          managedExecutorAcceptance: false,
          newPosts: 0,
          realProfileInputs: 0,
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
      JSON.stringify({ ok: false, checks, actualFacebook: false, error: String(error) }, null, 2),
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
