import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve(import.meta.filename)],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} else {
  const { app, BrowserWindow } = await import('electron');
  const directory = path.resolve('audit/desktop-task-tests-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    let window, server, store;
    const deadline = setTimeout(() => app.exit(1), 60000);
    try {
      await app.whenReady();
      const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
      const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
      const { TaskService } = await import('../dist/src/application/task-service.js');
      const { BridgeProfileSource } = await import('../dist/src/infrastructure/browser-source.js');
      const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
      const { startBridgeServer } = await import('../dist/src/bridge/server.js');
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const row = store.createCombination({
        name: '生成定时组合',
        note: '无浏览器输入',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 4, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      const profileIds = [randomUUID(), randomUUID()];
      server = await startBridgeServer({
        root: process.cwd(),
        port: 18786,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: ({ core, store: bridge, tasks }) => {
          const source = new BridgeProfileSource(core, bridge, tasks);
          const profiles = () =>
            source.profiles().map((p, i) => ({
              ...p,
              online: true,
              synced: true,
              phase: 'PAUSED',
              unresolved: 0,
              extensionVersion: '0.3.21',
              account: {
                state: 'logged-in',
                id: 'generated-account-' + i,
                name: '生成账号' + (i + 1),
                avatar: null,
              },
            }));
          const execution = {
            available: () => true,
            capabilities: () => ({
              types: ['feed', 'video', 'marketplace'],
              combinations: store
                .combinations()
                .map((c) => ({ id: c.id, version: c.version, enabled: true, reason: '' })),
            }),
            start: (input) =>
              store.tasks.assign(
                input,
                profiles().map((p) => ({ ...p, dispatchAllowed: true })),
              ),
            stopProfile: async (id) => {
              for (const p of store.tasks.list().filter((p) => p.profileId === id))
                store.tasks.requestControl(p.id, 'stop');
            },
            commandPlan: async (id, command) =>
              command === 'resume'
                ? store.tasks.resume(id)
                : store.tasks.requestControl(id, command),
          };
          return workspaceApi(
            new WorkspaceService(store, { profiles, records: () => [], stop: () => {} }),
            new TaskService(store.tasks, () => execution),
          );
        },
      });
      for (const id of profileIds)
        server.store.pair(id, 'generated-scheduling-only', 'a'.repeat(32));
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      await window.loadURL(server.origin + '/workbench/');
      const ui = (expression) => window.webContents.executeJavaScript(expression);
      const until = async (expression) => {
        const at = Date.now();
        while (!(await ui(expression))) {
          if (Date.now() - at > 10000) throw Error('TASK_TEST_UI_WAIT ' + expression);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const click = async (text) =>
        assert.equal(
          await ui(
            `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`,
          ),
          true,
          text,
        );
      const fill = async (label, value) =>
        assert.equal(
          await ui(
            `(()=>{const e=document.querySelector('input[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
          ),
          true,
          label,
        );
      await until('document.querySelectorAll(".profile-row").length===2');
      await click('全选匹配');
      await until('document.body.innerText.includes("已选 2")');
      assert.equal(await ui('document.querySelectorAll(".test-module").length'), 5);
      assert.equal(await ui('document.querySelectorAll(".test-module.ready").length'), 3);
      assert.equal(
        await ui(
          '(()=>{const b=[...document.querySelectorAll(".test-module")].find(e=>e.textContent.startsWith("浏览首页"));b.click();return true})()',
        ),
        true,
      );
      await until('!!document.querySelector(".test-dialog[open]")');
      await fill('单项测试时长', '0');
      await click('开始测试');
      await until('!!document.querySelector(".test-dialog [role=alert]")');
      assert.equal(store.tasks.list().length, 0);
      await fill('单项测试时长', '1');
      await click('开始测试');
      await until('!document.querySelector(".test-dialog")');
      await until('document.querySelectorAll(".test-results tbody tr").length===2');
      assert.equal(store.tasks.list().length, 2);
      assert.deepEqual(
        store.tasks
          .list()
          .map((p) => p.profileId)
          .sort(),
        profileIds.sort(),
      );
      assert.ok(
        store.tasks
          .list()
          .every((p) => p.snapshot.steps.length === 1 && p.snapshot.steps[0].type === 'feed'),
      );
      assert.equal(await ui('document.querySelectorAll(".combination-card").length'), 1);
      await writeFile(
        path.join(directory, 'running.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('停止所选');
      await until(
        'document.querySelectorAll(".test-results tbody tr").length===2&&document.querySelector(".test-results").innerText.includes("已停止")',
      );
      assert.ok(store.tasks.list().every((p) => p.state === 'STOPPED'));
      assert.equal(await ui('document.body.innerText.includes("已选 2")'), true);
      assert.equal(
        await ui(
          '(()=>{const b=[...document.querySelectorAll(".test-module")].find(e=>e.textContent.startsWith("发布快拍"));b.click();return true})()',
        ),
        true,
      );
      await until('document.querySelector(".test-notice")?.textContent.includes("尚未接通")');
      await writeFile(
        path.join(directory, 'stopped.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            status: 'PASSED',
            scope:
              'generated React/Electron/HTTP/original SQLite test assignment, execution fixture; no FB business',
            profiles: 2,
            originalPlans: 2,
            capturedSelection: true,
            invalidDurationRejected: true,
            bulkStop: true,
            selectionRetained: true,
            unsupportedModuleExplained: true,
            browserOperations: 0,
            uploads: 0,
            posts: 0,
            screenshots: ['running.png', 'stopped.png'],
          },
          null,
          2,
        ),
      );
      console.log('DESKTOP_TASK_TESTS_PASSED ' + directory);
    } catch (error) {
      await writeFile(path.join(directory, 'failure.txt'), String(error.stack ?? error));
      if (window && !window.isDestroyed())
        await writeFile(
          path.join(directory, 'failure.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
      console.error(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      window?.destroy();
      await server?.close();
      store?.close();
      app.exit(process.exitCode ?? 0);
    }
  }
}
