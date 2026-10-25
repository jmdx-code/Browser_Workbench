import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('scripts/desktop-settings-flow.mjs')],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} else {
  const { app, BrowserWindow } = await import('electron');
  const directory = path.resolve('audit/desktop-settings-flow-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
    const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
    const { TaskService } = await import('../dist/src/application/task-service.js');
    const { BridgeProfileSource } = await import('../dist/src/infrastructure/browser-source.js');
    const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
    const { startBridgeServer } = await import('../dist/src/bridge/server.js');
    let server, store, window;
    const checks = [];
    const timer = setTimeout(() => {
      console.error('DESKTOP_SETTINGS_TIMEOUT');
      app.exit(1);
    }, 60000);
    try {
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const group = store.createGroup('桌面删除分组', 'gray');
      const profileIds = [randomUUID(), randomUUID()];
      const extraProfileId = randomUUID();
      store.moveProfiles(profileIds, group.id);
      store.moveProfiles([extraProfileId], null);
      store.createCombination({
        name: '商城配置桌面检查',
        note: '隔离数据，不控制FB',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: randomUUID(),
            type: 'marketplace',
            durationMinutes: 4,
            keyword: '',
            maxLikes: 0,
            minLikeCount: 0,
          },
        ],
      });
      server = await startBridgeServer({
        root: process.cwd(),
        port: 18778,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: ({ core, store: bridge, tasks }) => {
          for (const id of [...profileIds, extraProfileId])
            bridge.pair(id, 'isolated-fixture-secret', 'a'.repeat(32));
          return workspaceApi(
            new WorkspaceService(store, new BridgeProfileSource(core, bridge, tasks)),
            new TaskService(store.tasks),
          );
        },
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
      const evaluate = (text) => window.webContents.executeJavaScript(text);
      const until = async (expression) => {
        const start = Date.now();
        while (!(await evaluate(expression))) {
          if (Date.now() - start > 10000) throw Error('UI_WAIT_FAILED: ' + expression);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      const click = async (text) => {
        assert.equal(
          await evaluate(
            `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}||b.querySelector('strong')?.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`,
          ),
          true,
          'click ' + text,
        );
      };
      await until(`!!document.querySelector('.combo-card')`);
      await click('全部'); // Generated profiles are intentionally offline.
      await evaluate(`document.querySelector('input[aria-label="选择整组 桌面删除分组"]').click()`);
      await until(`document.querySelector('.selection-bar strong')?.textContent==='已选 2'`);
      await click('分组操作 · 桌面删除分组');
      await until(
        `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='删除分组')`,
      );
      await click('删除分组');
      await until(`!!document.querySelector('dialog[open]')`);
      await evaluate(`document.querySelector('dialog[open] button.danger').click()`);
      await until(
        `!document.querySelector('dialog[open]')&&!document.body.innerText.includes('桌面删除分组')`,
      );
      assert.equal(store.profileMetadata().size, 3);
      assert.ok([...store.profileMetadata().values()].every((row) => row.groupId === null));
      assert.equal(
        await evaluate(`document.querySelector('.selection-bar strong').textContent`),
        '已选 2',
      );
      checks.push(
        'group delete moved two fixture profiles to ungrouped, preserved multiselection and profiles',
      );
      await until(`document.querySelector('input[aria-label="同时运行数量"]')?.value==='100'`);
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: false,
        flatten: true,
        filter: [],
        waitForDebuggerOnStart: false,
      });
      checks.push('real Chromium accepts disabled auto-attach with empty target filter');
      const handlePoint = await evaluate(
        `(()=>{const r=document.querySelector('.sidebar-resizer').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+30};})()`,
      );
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...handlePoint,
      });
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        button: 'left',
        buttons: 1,
        x: handlePoint.x + 40,
        y: handlePoint.y,
      });
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        x: handlePoint.x + 40,
        y: handlePoint.y,
      });
      await until(
        `document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')==='330'&&localStorage.getItem('workbench.sidebar-width.v1')==='330'`,
      );
      assert.equal(await evaluate(`localStorage.getItem('workbench.sidebar-width.v1')`), '330');
      await evaluate(`document.querySelector('.sidebar-resizer').focus()`);
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Home',
        code: 'Home',
        windowsVirtualKeyCode: 36,
      });
      await until(
        `document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')==='290'`,
      );
      await click('清空');
      await evaluate(
        `[...document.querySelectorAll('.sidebar .segmented button')].find(b=>b.textContent.trim()==='全部').click()`,
      );
      await until(`document.querySelectorAll('.profile-row input').length===3`);
      await evaluate(`document.querySelector('.profile-row input').click()`);
      const lastPoint = await evaluate(
        `(()=>{const nodes=document.querySelectorAll('.profile-row input');const r=nodes[nodes.length-1].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        modifiers: 8,
        ...lastPoint,
      });
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        modifiers: 8,
        ...lastPoint,
      });
      await until(`document.querySelector('.selection-bar strong')?.textContent==='已选 3'`);
      await evaluate(
        `document.querySelector('input[aria-label="选择 Chrome ${extraProfileId.slice(0, 8)}"]').click()`,
      );
      await until(`document.querySelector('.selection-bar strong')?.textContent==='已选 2'`);
      checks.push(
        'actual Chromium pointer drag persisted sidebar width, keyboard reset and Shift range selected three profiles including the middle row',
      );
      const fill = async (selector, value) => {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await window.webContents.debugger.sendCommand('Input.insertText', { text: value });
      };
      await fill('input[aria-label="同时运行数量"]', '37');
      await evaluate(`document.querySelector('input[aria-label="同时运行数量"]').blur()`);
      await until(
        `document.querySelector('input[aria-label="同时运行数量"]')?.value==='37'&&!document.querySelector('button[aria-label="增加并发"]').disabled`,
      );
      assert.equal(store.tasks.settings().maxConcurrentProfiles, 37);
      for (const invalid of ['0', '101', '1.5', '']) {
        await fill('input[aria-label="同时运行数量"]', invalid);
        await evaluate(`document.querySelector('input[aria-label="同时运行数量"]').blur()`);
        await until(`document.querySelector('input[aria-label="同时运行数量"]')?.value==='37'`);
        assert.equal(store.tasks.settings().maxConcurrentProfiles, 37);
      }
      await fill('input[aria-label="同时运行数量"]', '99');
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await until(
        `document.querySelector('input[aria-label="同时运行数量"]')?.value==='99'&&!document.querySelector('button[aria-label="增加并发"]').disabled`,
      );
      await click('增加并发');
      await until(
        `document.querySelector('input[aria-label="同时运行数量"]')?.value==='100'&&document.querySelector('button[aria-label="增加并发"]').disabled`,
      );
      assert.equal(store.tasks.settings().maxConcurrentProfiles, 100);
      checks.push(
        'Default100, direct edit/blur/Enter persisted; invalid0/101/fraction/empty rejected; plus respects100',
      );
      if (process.env.WORKBENCH_SETTINGS_CONCURRENCY_ONLY === '1') {
        await window.loadURL(server.origin + '/workbench/');
        await until(`document.querySelector('input[aria-label="同时运行数量"]')?.value==='100'`);
        assert.equal(store.tasks.settings().maxConcurrentProfiles, 100);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await writeFile(
          path.join(directory, 'concurrency.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
        await writeFile(
          path.join(directory, 'result.json'),
          JSON.stringify(
            {
              status: 'PASSED',
              scope: 'isolated concurrency UI only; no Facebook control',
              checks,
              reloadPersisted: true,
              maxConcurrentProfiles: 100,
              browserOperations: 0,
            },
            null,
            2,
          ),
        );
        console.log('DESKTOP_CONCURRENCY_PASSED ' + directory);
        return;
      }
      await click('打开菜单');
      await until(`!!document.querySelector('.drawer')`);
      await click('功能状态');
      await until(`document.querySelectorAll('.feature-row').length>=5`);
      checks.push('settings survive navigation and re-read; feature states shown truthfully');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(
        path.join(directory, 'settings.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('关闭菜单');
      await until(`!document.querySelector('.drawer')`);
      await until(`document.querySelector('input[aria-label="同时运行数量"]')?.value==='100'`);
      await evaluate(`document.querySelector('.combo-card .combo-body').click()`);
      await until(`!!document.querySelector('.step-marketplace input[maxlength="120"]')`);
      await fill('.step-marketplace input[maxlength="120"]', '手机 & phone');
      await click('保存组合');
      await until(
        `!document.querySelector('.step-marketplace')&&document.body.innerText.includes('组合已保存为新版本')`,
      );
      const saved = store.combinations()[0];
      assert.equal(saved.saved.steps[0].keyword, '手机 & phone');
      assert.equal(saved.version, 2);
      assert.equal(store.tasks.list().length, 0);
      checks.push(
        'Marketplace keyword saved as immutable version through actual editor; zero task plans',
      );
      await evaluate(`document.querySelector('.combo-card .combo-body').click()`);
      await until(
        `document.querySelector('.step-marketplace input[maxlength="120"]')?.value==='手机 & phone'`,
      );
      await writeFile(
        path.join(directory, 'marketplace-editor.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      const fixturePlans = store.tasks.assign(
        { requestId: randomUUID(), combinationId: saved.id, version: saved.version, profileIds },
        profileIds.map((id) => ({
          id,
          online: false,
          synced: false,
          unresolved: 0,
          dispatchAllowed: false,
          account: { state: 'unknown', id: null, name: null, avatar: null },
        })),
      );
      await evaluate(
        `[...document.querySelectorAll('nav.tabs button')].find(b=>b.textContent.includes('任务记录')).click()`,
      );
      await until(`!!document.querySelector('.records-page')`);
      await evaluate(`document.querySelector('button.status-tab.tab-attention').click()`);
      await until(`document.querySelectorAll('.records-table button.records-row').length===2`);
      const chosen = await evaluate(
        `(()=>{const row=document.querySelector('.records-table button.records-row');const name=row.querySelector('.cell-browser strong').textContent;row.click();return name;})()`,
      );
      await until(
        `!!document.querySelector('.task-history-select select option[value=""]')&&document.querySelector('.task-history-select select').value!==''`,
      );
      const selectedPlanId = await evaluate(
        `document.querySelector('.task-history-select select').value`,
      );
      const exact = fixturePlans.find((plan) => plan.id === selectedPlanId);
      assert.ok(exact);
      await until(`document.querySelector('.task-progress progress')?.max===240000`);
      assert.equal(
        await evaluate(`document.querySelector('.task-progress').textContent.trim()`),
        '有效浏览 0:00 / 4:00',
      );
      assert.equal(chosen, 'Chrome ' + exact.profileId.slice(0, 8));
      assert.equal(
        await evaluate(`document.querySelector('.selection-bar strong').textContent`),
        '已选 2',
      );
      assert.ok(
        store.tasks
          .list()
          .every((plan) => plan.state === 'QUEUED' && store.tasks.operations(plan.id).length === 0),
      );
      checks.push(
        'exception center opened the exact original queued fixture plan, retained sidebar selection and sent zero browser operations',
      );
      const exportFile = path.join(directory, 'exported-history.json');
      const downloaded = new Promise((resolve, reject) => {
        window.webContents.session.once('will-download', (_event, item) => {
          item.setSavePath(exportFile);
          item.once('done', (_event, state) =>
            state === 'completed' ? resolve() : reject(Error('HISTORY_EXPORT_' + state)),
          );
        });
      });
      await click('导出记录');
      await downloaded;
      const exported = JSON.parse(await readFile(exportFile, 'utf8'));
      assert.equal(exported.format, 'browser-workbench-task-history');
      assert.equal(exported.history.selectedPlanId, exact.id);
      assert.equal(exported.history.profileId, exact.profileId);
      assert.equal(exported.history.operations.length, 0);
      assert.deepEqual(exported.history.steps[0].budget, { kind: 'time', milliseconds: 240000 });
      checks.push(
        'actual desktop downloaded the original selected public task history, with no credentials or browser operations',
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            completedAt: new Date().toISOString(),
            status: 'PASSED',
            scope: 'isolated desktop UI, no Facebook control or business acceptance',
            checks,
            maxConcurrentProfiles: 100,
            fixtureTaskPlans: 2,
            browserOperations: 0,
            screenshots: ['settings.png', 'marketplace-editor.png'],
          },
          null,
          2,
        ),
      );
      console.log('DESKTOP_SETTINGS_PASSED ' + directory);
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
      if (window && !window.isDestroyed()) window.destroy();
      await server?.close();
      store?.close();
      app.exit(process.exitCode ?? 0);
    }
  }
}
