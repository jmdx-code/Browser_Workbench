import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('scripts/desktop-recovery-flow.mjs')],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} else {
  const { app, BrowserWindow } = await import('electron');
  const directory = path.resolve('audit/desktop-recovery-flow-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
    const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
    const { TaskService } = await import('../dist/src/application/task-service.js');
    const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
    const { startBridgeServer } = await import('../dist/src/bridge/server.js');
    const { loadServerConfig } = await import('../dist/src/infrastructure/server-config.js');
    let store, server, window;
    const checks = [];
    const timer = setTimeout(() => app.exit(1), 60_000);
    try {
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const combination = store.createCombination({
        name: 'Recovery fixture',
        note: 'isolated; no browser business',
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const config = await loadServerConfig(process.cwd());
      const probe = createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      server = await startBridgeServer({
        root: process.cwd(),
        port,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: () =>
          workspaceApi(
            new WorkspaceService(store, { profiles: () => [], records: () => [], stop: () => {} }),
            new TaskService(
              store.tasks,
              () => undefined,
              () => {},
              () => config.featureEvidence,
            ),
          ),
      });
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          preload: path.resolve('dist/src/desktop/preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      await window.loadURL(server.origin + '/workbench/');
      const evaluate = (source) => window.webContents.executeJavaScript(source);
      const until = async (expression) => {
        const deadline = Date.now() + 15_000;
        while (!(await evaluate(expression))) {
          if (Date.now() > deadline) throw Error('UI_WAIT_FAILED: ' + expression);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const click = async (label) =>
        assert.equal(
          await evaluate(
            `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.querySelector('strong')?.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`,
          ),
          true,
          'click ' + label,
        );
      const name = async (value) =>
        evaluate(
          `(()=>{const input=document.querySelector('.combination-fields input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      await until("!!document.querySelector('.combo-card .combo-body')");
      await evaluate("document.querySelector('.combo-card .combo-body').click()");
      await until("!!document.querySelector('.editor')");
      await evaluate(
        `(()=>{const original=window.fetch.bind(window);window.reviewMode='';window.reviewDraftRequests=0;window.fetch=async(url,options)=>{if(String(url).endsWith('/combinations/draft')){window.reviewDraftRequests++;const mode=window.reviewMode;window.reviewMode='';if(mode==='reject')return new Response(JSON.stringify({code:'UNAVAILABLE',error:'isolated rejection'}),{status:503,headers:{'content-type':'application/json'}});if(mode==='lost'){await original(url,options);throw Error('isolated reply loss');}}return original(url,options);};})()`,
      );
      await evaluate("window.reviewMode='reject'");
      await name('Local edit preserved');
      await click('保存草稿');
      await until("!!document.querySelector('.draft-recovery')");
      assert.equal(store.combinations()[0].draft, null);
      await click('核对保存状态');
      await until("!document.querySelector('.draft-recovery')");
      assert.equal(
        await evaluate("document.querySelector('.combination-fields input').value"),
        'Local edit preserved',
      );
      await click('保存草稿');
      await until("document.body.innerText.includes('草稿已保存')");
      assert.equal(store.combinations()[0].draft.name, 'Local edit preserved');
      checks.push(
        'explicit readback recovered rejected save; local edit persisted through original CAS',
      );
      await evaluate("window.reviewMode='lost'");
      await name('Applied reply lost');
      await click('保存草稿');
      await until("!!document.querySelector('.draft-recovery')");
      const appliedRevision = store.combinations()[0].revision;
      const requestsBefore = await evaluate('window.reviewDraftRequests');
      await click('核对保存状态');
      await until("!document.querySelector('.draft-recovery')");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(store.combinations()[0].revision, appliedRevision);
      assert.equal(await evaluate('window.reviewDraftRequests'), requestsBefore);
      checks.push('lost reply acknowledged by readback with no automatic rewrite');
      const row = store.combinations()[0];
      store.writeDraft(row.id, row.revision, { ...row.draft, name: 'External changed draft' });
      await name('Unsaved local conflict');
      await click('保存草稿');
      await until("!!document.querySelector('.draft-recovery')");
      await click('核对保存状态');
      await until(
        "document.querySelector('.draft-recovery').textContent.includes('External changed draft')",
      );
      assert.equal(
        await evaluate("document.querySelector('.combination-fields input').value"),
        'Unsaved local conflict',
      );
      await writeFile(
        path.join(directory, 'conflict.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('保留当前编辑');
      await until("!document.querySelector('.draft-recovery')");
      assert.equal(store.combinations()[0].draft.name, 'External changed draft');
      await click('保存草稿');
      await until("document.body.innerText.includes('草稿已保存')");
      assert.equal(store.combinations()[0].draft.name, 'Unsaved local conflict');
      checks.push(
        'conflicting persisted draft requires explicit local choice and a subsequent save',
      );
      await writeFile(
        path.join(directory, 'editor.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      const recoveryProfile = randomUUID(),
        recoveryAttempt = randomUUID();
      await evaluate(
        `(()=>{const original=window.fetch;window.connectionRecoveryRequests=0;window.connectionPending=true;window.fetch=async(url,options)=>{if(String(url)==='/api/bridge-connection-health')return new Response(JSON.stringify({failures:[],pending:window.connectionPending?[{id:${JSON.stringify(recoveryAttempt)},profileId:${JSON.stringify(recoveryProfile)},expiresAt:Date.now()+60000}]:[]}),{headers:{'content-type':'application/json'}});if(String(url)==='/api/bridge-connections/recover'){window.connectionRecoveryRequests++;const input=JSON.parse(options.body);if(input.id!==${JSON.stringify(recoveryAttempt)}||input.profileId!==${JSON.stringify(recoveryProfile)})throw Error('UI_RECOVERY_BINDING_CHANGED');window.connectionPending=false;return new Response(JSON.stringify({requested:true,profileId:input.profileId}),{headers:{'content-type':'application/json'}});}return original(url,options);};})()`,
      );
      await click('打开菜单');
      await until("!!document.querySelector('.drawer')");
      await click('功能状态');
      await until(
        "document.querySelectorAll('.feature-row').length>=5&&document.body.innerText.includes('仅短样本通过')",
      );
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
      await evaluate("document.querySelector('.feature-list').scrollIntoView({block:'center'})");
      await writeFile(
        path.join(directory, 'settings.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      window.setSize(840, 600);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
      await writeFile(
        path.join(directory, 'settings-840.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      window.setSize(1280, 900);
      checks.push(
        'settings show implementation, actual gates and evidence independently without viewport overflow',
      );
      await click('返回菜单');
      await until("!!document.querySelector('.menu-list')");
      await click('连接诊断');
      await until("!!document.querySelector('.connection-recovery-row')");
      assert.equal(await evaluate('window.connectionRecoveryRequests'), 0);
      await click('恢复此资料连接');
      await until("!!document.querySelector('dialog[open]')");
      await click('取消');
      assert.equal(await evaluate('window.connectionRecoveryRequests'), 0);
      await click('恢复此资料连接');
      await until("!!document.querySelector('dialog[open]')");
      await evaluate(
        "document.querySelector('.connection-health').scrollIntoView({block:'center'})",
      );
      await writeFile(
        path.join(directory, 'connection-confirm.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await evaluate("document.querySelector('dialog[open] button.danger').click()");
      await until(
        "!document.querySelector('dialog[open]')&&document.body.innerText.includes('恢复请求已确认')",
      );
      await until("!document.querySelector('.connection-recovery-row')");
      assert.equal(await evaluate('window.connectionRecoveryRequests'), 1);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
      checks.push(
        'connection recovery UI never sends automatically or after cancel; explicit confirmation sends exact live attempt once',
      );
      await click('关闭菜单');
      await until("!document.querySelector('.drawer')");
      await evaluate(
        `(()=>{const original=window.fetch;window.reviewHung=false;window.reviewAbort=false;window.fetch=(url,options)=>{if(!window.reviewHung&&String(url)==='/api/workspace'){window.reviewHung=true;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{window.reviewAbort=true;reject(options.signal.reason);},{once:true}));}return original(url,options);};})()`,
      );
      await until('window.reviewHung');
      await until(
        "!!document.querySelector('.error-note')&&document.body.innerText.includes('当前列表可能是旧状态')",
      );
      await click('重新连接');
      await until("!document.body.innerText.includes('当前列表可能是旧状态')");
      assert.equal(await evaluate('window.reviewAbort'), true);
      checks.push('actual renderer hung polling times out, aborts and reconnects');
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          { outcome: 'PASSED', checks, browserOperations: 0, realFacebook: false },
          null,
          2,
        ),
      );
      console.log('DESKTOP_RECOVERY_PASSED ' + directory);
    } catch (error) {
      await writeFile(path.join(directory, 'failure.txt'), String(error));
      if (window && !window.isDestroyed()) {
        await writeFile(
          path.join(directory, 'failure-ui.txt'),
          await window.webContents.executeJavaScript('document.body.innerText'),
        );
        await writeFile(
          path.join(directory, 'failure.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      console.error(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      window?.destroy();
      await server?.close();
      store?.close();
      app.exit(process.exitCode ?? 0);
    }
  }
}
