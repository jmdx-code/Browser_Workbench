import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  projectFacebookPostEffects,
  readFacebookPostEffects,
} from '../dist/src/infrastructure/facebook-post-effect-reader.js';

// Actual Chromium decoding of a generated local fixture. No Facebook connection or upload.
const report = path.resolve('audit/post-media-readiness-dom-' + randomUUID() + '.json');
const user = path.resolve('audit/post-media-readiness-dom-user-' + randomUUID());
await mkdir(user, { recursive: true });
app.setPath('userData', user);
const checks = [];
void run();
async function run() {
  const timer = setTimeout(() => app.exit(1), 30000);
  let window;
  try {
    const bytes = await readFile(process.env.WORKBENCH_MEDIA_READINESS_VIDEO);
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
      (_req, done) => done({ cancel: true }),
    );
    const htmlPath = path.join(user, 'fixture.html');
    await writeFile(
      htmlPath,
      `<!doctype html><meta charset="utf-8">
      <div role="dialog"><form><div role="textbox" contenteditable="true">完整正文</div>
      <input type="file" multiple accept="image/*,video/*" hidden>
      <div role="form"><span>已上传的影音内容</span><div role="list">
      <div role="button" aria-label="移除视频" style="height:20px">移除视频</div>
      <video width="160" height="90" muted></video></div></div></form>
      <div role="button" aria-label="下一页" style="height:20px">下一页</div></div>`,
      { flag: 'wx' },
    );
    await window.loadFile(htmlPath);
    const project = () =>
      window.webContents.executeJavaScript(
        '(' +
          projectFacebookPostEffects.toString() +
          ')(' +
          JSON.stringify({
            scope: 'visible',
            postLabels: ['发布'],
            advanceLabels: ['下一页'],
          }) +
          ')',
      );
    let value = await project();
    assert.equal(value.composer.media[0].ready, false);
    assert.equal(value.composer.advanceEnabled, true);
    checks.push('remove control without decoded video is not ready');
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const video=document.querySelector('video');
      video.addEventListener('loadeddata',()=>resolve(true),{once:true});
      video.addEventListener('error',()=>reject(Error('fixture decode failed')),{once:true});
      video.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),char=>char.charCodeAt(0))],{type:'video/mp4'}));
      video.load();
    })`);
    value = await project();
    assert.equal(value.composer.media[0].ready, true);
    const decodedVideo = await window.webContents.executeJavaScript(`(()=>{
      const video=document.querySelector('video');
      return {width:video.videoWidth,height:video.videoHeight,durationSeconds:video.duration};
    })()`);
    checks.push('actual generated MP4 decoding detected');
    const page = {
      evaluate: async (fn, arg) => {
        const result = await window.webContents.executeJavaScript(
          '(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')',
        );
        return result && typeof result === 'object' && 'url' in result
          ? { ...result, url: 'https://www.facebook.com/post/create' }
          : result;
      },
    };
    const reading = await readFacebookPostEffects(page, () => {});
    assert.deepEqual(reading.composer.media[0].previewBytes, {
      source: 'owned-preview-blob',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
    checks.push('local decoded Blob full digest and byte size match original generated MP4');
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="下一页"]').setAttribute('aria-disabled','true')`,
    );
    assert.equal((await project()).composer.advanceEnabled, false);
    checks.push('disabled next rejected');
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="下一页"]').outerHTML='<button role="button" aria-label="发布" disabled>发布</button>'`,
    );
    assert.equal((await project()).composer.submitEnabled, false);
    checks.push('native disabled submit rejected');
    await window.webContents.executeJavaScript(
      `document.querySelector('[role="dialog"]').setAttribute('aria-hidden','true')`,
    );
    assert.equal((await project()).composer, null);
    checks.push('hidden composer rejected');
    await window.webContents.executeJavaScript(`(() => {
      const root=document.querySelector('[role="dialog"]');
      root.removeAttribute('aria-hidden');
      const video=root.querySelector('video');
      root.querySelector('form').appendChild(video);
      video.style.display='none';
      root.querySelector('[role="form"]').remove();
      root.querySelector('[aria-label="发布"]').removeAttribute('disabled');
    })()`);
    const modern = await readFacebookPostEffects(page, () => {});
    assert.equal(modern.composer.media.length, 1);
    assert.equal(modern.composer.media[0].kind, 'video');
    assert.equal(modern.composer.media[0].ready, true);
    assert.equal(modern.composer.media[0].durationSeconds, decodedVideo.durationSeconds);
    assert.equal(
      modern.composer.media[0].previewBytes.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    checks.push(
      'observed native-form layout with hidden decoded video and no ARIA list matches original bytes',
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('form').appendChild(document.querySelector('video').cloneNode())`,
    );
    assert.equal((await project()).composer.media.length, 0);
    checks.push('two native-form videos are ambiguous, not one ready upload');
    await window.webContents.executeJavaScript(
      `document.querySelectorAll('video').forEach(element=>element.remove())`,
    );
    const images = await Promise.all(
      ['blue.png', 'orange.png'].map((name) =>
        readFile(path.resolve('audit/product-publication-20261011/resources', name)),
      ),
    );
    await window.webContents
      .executeJavaScript(`Promise.all(${JSON.stringify(images.map((image) => image.toString('base64')))}.map(value=>new Promise((resolve,reject)=>{
      const image=document.createElement('img');
      image.alt='';image.onload=()=>resolve(true);image.onerror=()=>reject(Error('fixture image decode failed'));
      document.querySelector('form').appendChild(image);
      image.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(value),c=>c.charCodeAt(0))],{type:'image/png'}));
    })))`);
    const modernImages = await readFacebookPostEffects(page, () => {});
    assert.equal(modernImages.composer.media.length, 2);
    assert.ok(modernImages.composer.media.every((item) => item.kind === 'image' && item.ready));
    assert.deepEqual(
      modernImages.composer.media.map((item) => item.previewBytes),
      images.map((image) => ({
        source: 'owned-preview-blob',
        sha256: createHash('sha256').update(image).digest('hex'),
        size: image.length,
      })),
    );
    checks.push(
      'native-form nameless PNG previews decode and retain exact ordered original byte proofs',
    );
    await writeFile(
      report,
      JSON.stringify(
        {
          ok: true,
          actualFacebook: false,
          generatedDOM: true,
          externalRequestsBlocked: true,
          chromium: process.versions.chrome,
          fixture: {
            ...decodedVideo,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
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
      JSON.stringify(
        { ok: false, actualFacebook: false, generatedDOM: true, checks, error: String(error) },
        null,
        2,
      ),
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
