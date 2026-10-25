import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

// Mechanism experiment only: native Chromium visibility, rAF and real decoded video.
// No Facebook, no user profiles, no prototype overrides or browser startup flags.
if (!process.versions.electron) {
  const directory = path.resolve('audit/background-rendering-' + randomUUID());
  await mkdir(directory);
  const runtime = JSON.parse(await readFile('config/media-runtime.json', 'utf8'));
  const ffmpeg = path.resolve('vendor/media-runtime', runtime.directory, 'bin/ffmpeg.exe');
  await promisify(execFile)(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30',
      '-t',
      '4',
      '-an',
      '-c:v',
      runtime.encoder,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      path.join(directory, 'generated.mp4'),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [import.meta.filename, directory],
    { windowsHide: true, stdio: 'inherit', timeout: 45000 },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', reject);
  });
} else {
  void run();
  async function run() {
    const { app, BrowserWindow } = await import('electron');
    const directory = path.resolve(process.argv[2]);
    assert.ok(directory.startsWith(path.resolve('audit/background-rendering-')));
    app.setPath('userData', path.join(directory, 'user'));
    await app.whenReady();
    const bytes = await readFile(path.join(directory, 'generated.mp4'));
    const html =
      '<!doctype html><main><video src="/generated.mp4" width="320" height="180" muted loop autoplay></video><button style="position:absolute;left:400px;top:100px;width:150px;height:80px" onclick="window.trustedClick=event.isTrusted;void document.querySelector(\'video\').play()">Play fixture</button></main><script>window.framesObserved=0;function frame(){window.framesObserved++;requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>';
    const server = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': req.url === '/generated.mp4' ? 'video/mp4' : 'text/html',
      });
      res.end(req.url === '/generated.mp4' ? bytes : html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const window = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        backgroundThrottling: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let frameMessages = 0,
      captureErrors = 0;
    const protocol = window.webContents.debugger;
    const report = {
      runtime: process.versions,
      realFacebook: false,
      userBrowserRestarts: 0,
      productMechanismEnabled: false,
      samples: [],
      completed: false,
    };
    const deadline = setTimeout(() => app.exit(1), 30000);
    try {
      await window.loadURL('http://127.0.0.1:' + server.address().port);
      await window.webContents.executeJavaScript(`{
      const v=document.querySelector('video');v.muted=true;
      void v.play().catch(()=>{}); true;
    }`);
      protocol.attach('1.3');
      protocol.on('message', (_event, method, params) => {
        if (method !== 'Page.screencastFrame') return;
        frameMessages++;
        void protocol
          .sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId })
          .catch(() => {
            captureErrors++;
          });
      });
      const observe = () =>
        window.webContents.executeJavaScript(`(()=>{
      const v=document.querySelector('video');return {visible:document.visibilityState,
        focused:document.hasFocus(),width:innerWidth,height:innerHeight,
        raf:window.framesObserved,time:v.currentTime,paused:v.paused,ready:v.readyState,
        decoded:v.getVideoPlaybackQuality().totalVideoFrames,trustedClick:window.trustedClick??null};})()`);
      const sample = async (name) => {
        const before = await observe(),
          started = performance.now(),
          framesBefore = frameMessages;
        await new Promise((resolve) => setTimeout(resolve, 1300));
        const after = await observe();
        const value = {
          name,
          before,
          after,
          wallMs: performance.now() - started,
          rafDelta: after.raf - before.raf,
          decodedDelta: after.decoded - before.decoded,
          capturedFrames: frameMessages - framesBefore,
          windowVisible: window.isVisible(),
          windowMinimized: window.isMinimized(),
        };
        report.samples.push(value);
        return value;
      };
      await sample('not-shown-baseline');
      await protocol.sendCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: 1,
        maxWidth: 16,
        maxHeight: 16,
        everyNthFrame: 30,
      });
      await sample('not-shown-native-capture');
      window.minimize();
      await sample('minimized-native-capture');
      await protocol.sendCommand('Page.setWebLifecycleState', { state: 'active' });
      await sample('minimized-active-lifecycle');
      await protocol.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: 450,
        y: 140,
        button: 'left',
        clickCount: 1,
      });
      await protocol.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 450,
        y: 140,
        button: 'left',
        clickCount: 1,
      });
      await sample('minimized-native-play');
      await protocol.sendCommand('Page.stopScreencast');
      await sample('capture-released');
      report.completed = true;
      report.captureErrors = captureErrors;
      report.conclusion =
        'Mechanism measurements only; no claim about Facebook, focus, capacity or platform risk.';
    } catch (error) {
      report.error = String(error.stack ?? error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          directory,
          completed: report.completed,
          samples: report.samples,
          error: report.error,
        }),
      );
      if (protocol.isAttached()) protocol.detach();
      window.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.exit(process.exitCode ?? 0);
    }
  }
}
