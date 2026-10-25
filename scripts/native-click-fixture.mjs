import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [import.meta.filename],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  process.exitCode = code === 0 ? 0 : 1;
} else {
  const { app, BrowserWindow } = await import('electron');
  const directory = path.resolve('audit/native-click-fixture-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { clickFacebookNativeTarget } =
      await import('../dist/src/infrastructure/facebook-native-click.js');
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.debugger.attach('1.3');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<style>button{position:absolute;left:40px;top:40px;width:120px;height:50px}</style><button id="target">Action</button><script>window.clicks=[];document.addEventListener("click",e=>window.clicks.push({id:e.target.id,trusted:e.isTrusted}));</script>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'https://www.facebook.com/';
    let inputCount = 0;
    const exec = (code) => window.webContents.executeJavaScript(code);
    const page = {
      evaluate: (fn, input) =>
        exec(
          `(()=>{const location={origin:'https://www.facebook.com',href:window.fixtureHref};return (${fn.toString()})(${JSON.stringify(input)})})()`,
        ),
      mouse: {
        click: async (x, y) => {
          inputCount++;
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x,
            y,
          });
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      },
    };
    const checks = [];
    const target = { css: '#target', text: 'Action' };
    let allowed = true;
    const guard = () => {
      if (!allowed) throw Error('USER_STOP');
    };
    async function reset() {
      await window.loadURL('http://127.0.0.1:' + server.address().port);
      await exec(
        `window.fixtureHref=${JSON.stringify(url)};window.rafCalls=0;window.requestAnimationFrame=()=>{window.rafCalls++;return 0};Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});true`,
      );
      allowed = true;
    }
    try {
      await reset();
      await clickFacebookNativeTarget(page, target, url, guard);
      assert.deepEqual(await exec('window.clicks'), [{ id: 'target', trusted: true }]);
      assert.equal(await exec('window.rafCalls'), 0);
      checks.push(
        'native trusted mouse click succeeds with rAF deliberately stalled; no locator force-click or DOM click',
      );
      for (const change of [
        `document.body.insertAdjacentHTML('beforeend','<div style="position:absolute;left:0;top:0;width:500px;height:500px;background:white"></div>')`,
        `document.querySelector('#target').setAttribute('disabled','')`,
        `document.body.style.opacity='0'`,
        `document.body.setAttribute('inert','')`,
        `window.fixtureHref='https://www.facebook.com/reel/1'`,
        `Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})`,
        `document.querySelector('#target').insertAdjacentHTML('afterend','<button id="target">Action</button>')`,
      ]) {
        await reset();
        await exec(change + ';true');
        const before = inputCount;
        await assert.rejects(
          clickFacebookNativeTarget(page, target, url, guard),
          /TARGET_UNAVAILABLE/,
        );
        assert.equal(inputCount, before);
      }
      checks.push(
        'overlay, disabled, transparent ancestor, inert, route change, hidden document and ambiguous target reject before input',
      );
      await reset();
      const before = inputCount;
      await assert.rejects(
        clickFacebookNativeTarget(page, target, url, guard, {
          wait: async () => {
            allowed = false;
          },
        }),
        /USER_STOP/,
      );
      assert.equal(inputCount, before);
      checks.push('stop between layout observations prevents mouse input');
      await reset();
      let fallback = 0;
      await exec("document.querySelector('#target').style.top='1500px'");
      await clickFacebookNativeTarget(page, target, url, guard, {
        scrollFallback: async () => {
          fallback++;
        },
      });
      assert.equal(fallback, 1);
      assert.equal(inputCount, before);
      checks.push(
        'offscreen target selects existing SDK scroll path before any click; no timeout fallback',
      );
      await reset();
      const beforeUnknown = inputCount;
      const uncertain = {
        ...page,
        mouse: {
          click: async () => {
            inputCount++;
            throw Error('ACK_LOST');
          },
        },
      };
      await assert.rejects(clickFacebookNativeTarget(uncertain, target, url, guard), /ACK_LOST/);
      assert.equal(inputCount, beforeUnknown + 1);
      checks.push('unknown mouse acknowledgement is not retried');
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            status: 'PASSED',
            checks,
            realFacebook: false,
            visibilityAndOriginModeled: true,
            actualDOMAndTrustedNativeMouse: true,
            browserRestarts: 0,
            inputCount,
          },
          null,
          2,
        ),
      );
      console.log('NATIVE_CLICK_FIXTURE_PASSED ' + directory);
    } catch (error) {
      await writeFile(path.join(directory, 'failure.txt'), String(error.stack ?? error));
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
