import { app, BrowserWindow } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('audit/private-test-media-' + randomUUID());
await mkdir(root);
app.setPath('userData', path.join(root, 'user'));
void run();
async function run() {
  let window;
  const deadline = setTimeout(() => app.exit(1), 45000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }),
    );
    await window.loadURL(
      'data:text/html,<meta charset="utf-8"><title>Generated private test media</title>',
    );
    const assets = [];
    for (let number = 1; number <= 3; number++) {
      const data = await window.webContents.executeJavaScript(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f4f6f8'; ctx.fillRect(0,0,800,600);
        ctx.fillStyle = ${JSON.stringify(['#167a62', '#b53d50', '#246da8'][number - 1])}; ctx.fillRect(40,40,720,100);
        ctx.font = 'bold 38px Arial'; ctx.fillStyle = '#ffffff'; ctx.fillText('PRIVATE TEST IMAGE ${number}',65,105);
        ctx.fillStyle = '#24282f'; ctx.font = '26px Arial'; ctx.fillText('Generated test pattern - no personal data',50,200);
        for(let i=0;i<6;i++){ctx.fillStyle=['#167a62','#b53d50','#246da8','#f0c94a','#32363e','#ffffff'][i];ctx.fillRect(50+i*115,270,100,180);}
        ctx.font = '22px Arial'; ctx.fillStyle = '#24282f'; ctx.fillText('Only me / software publication acceptance',50,525);
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const bytes = Buffer.from(data, 'base64'),
        source = path.join(root, `image-${number}.png`);
      await writeFile(source, bytes, { flag: 'wx' });
      assets.push({
        source,
        role: 'image',
        digest: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
    const source = path.resolve('public/sample.mp4'),
      video = await readFile(source);
    const preview = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const video=document.createElement('video');video.muted=true;
      video.onloadeddata=()=>{video.currentTime=Math.min(2,video.duration/2);};
      video.onseeked=()=>{const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);resolve(c.toDataURL('image/png').split(',')[1]);};
      video.onerror=()=>reject(Error('TEST_VIDEO_DECODE_FAILED'));
      video.src=${JSON.stringify('data:video/mp4;base64,' + video.toString('base64'))};
    })`);
    await writeFile(path.join(root, 'video-preview.png'), Buffer.from(preview, 'base64'), {
      flag: 'wx',
    });
    assets.push({
      source,
      role: 'video',
      digest: createHash('sha256').update(video).digest('hex'),
      bytes: video.length,
    });
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify(
        { version: 1, root, assets, networkRequestsBlocked: true, uploads: 0, publications: 0 },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(root);
    window.destroy();
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    clearTimeout(deadline);
    app.exit(1);
  }
}
