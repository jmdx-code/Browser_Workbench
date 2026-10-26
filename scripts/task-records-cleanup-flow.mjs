import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('scripts/task-records-cleanup-flow.mjs')],
    { windowsHide: true, stdio: 'inherit' },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
} else {
  const { app, BrowserWindow } = await import('electron');
  const fixMode = process.env.WORKBENCH_RECORD_CLEANUP_FIX === '1';
  const speedMode = fixMode || process.env.WORKBENCH_RECORD_SPEED_QUOTA === '1';
  const directory = path.resolve(
    (fixMode
      ? 'audit/task-records-fix-20261026'
      : speedMode
        ? 'audit/task-records-speed-quota-20261026'
        : 'audit/task-records-cleanup-20261026') +
      '/desktop-' +
      randomUUID(),
  );
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
    const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
    const { TaskService } = await import('../dist/src/application/task-service.js');
    const { DataCleanupService } = await import('../dist/src/application/data-cleanup.js');
    const { BridgeProfileSource } = await import('../dist/src/infrastructure/browser-source.js');
    const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
    const { startBridgeServer } = await import('../dist/src/bridge/server.js');
    const { DatabaseSync } = await import('node:sqlite');
    let store, server, window;
    const checks = [];
    const timer = setTimeout(() => app.exit(1), 60000);
    try {
      const file = path.join(directory, 'workspace.sqlite');
      store = await WorkspaceStore.open(file);
      const id = randomUUID();
      const profile = {
        id,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: 'fixture-record-account', name: null, avatar: null },
      };
      const saved = store.createCombination({
        name: '日常成绩单',
        note: '隔离数据，不连接真实浏览器',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: ['feed', 'video', 'marketplace', 'friends'].map((type) =>
          type === 'friends'
            ? {
                id: randomUUID(),
                type,
                acceptMode: 'count',
                maxAccepts: 1,
                maxLikes: 0,
                minLikeCount: 0,
              }
            : {
                id: randomUUID(),
                type,
                durationMinutes: 1,
                maxLikes: 0,
                minLikeCount: 0,
                ...(type === 'marketplace' ? { keyword: '' } : {}),
              },
        ),
      });
      const plan = store.tasks.assign(
        { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [id] },
        [profile],
      )[0];
      store.moveProfiles([id], null);
      store.tasks.requestControl(plan.id, 'stop');
      const db = new DatabaseSync(file);
      db.prepare(
        "UPDATE task_steps SET status='COMPLETED',progress=json_set(progress,'$.effectiveMilliseconds',60000) WHERE job_id=? AND position<2",
      ).run(plan.id);
      db.close();
      if (speedMode) {
        for (let i = 0; i < 2; i++) {
          const extra = store.tasks.assign(
            { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [id] },
            [profile],
          )[0];
          store.tasks.requestControl(extra.id, 'stop');
        }
      }
      const cleanup = new DataCleanupService(
        store.dataCleanup,
        { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
        undefined,
        async () => {},
        () => {},
      );
      server = await startBridgeServer({
        root: process.cwd(),
        port: 18791,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: ({ core, store: bridge, tasks }) => {
          bridge.pair(id, 'fixture-not-real', 'a'.repeat(32));
          return workspaceApi(
            new WorkspaceService(store, new BridgeProfileSource(core, bridge, tasks)),
            new TaskService(store.tasks),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            cleanup,
          );
        },
      });
      window = new BrowserWindow({
        show: false,
        width: 1360,
        height: 950,
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
      const evaluate = (code) => window.webContents.executeJavaScript(code);
      const until = async (code) => {
        const started = Date.now();
        while (!(await evaluate(code))) {
          if (Date.now() - started > 12000) throw Error('UI_WAIT:' + code);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const click = async (text) => {
        assert.equal(
          await evaluate(
            `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`,
          ),
          true,
          text,
        );
      };
      await until(`!!document.querySelector('.topnav') || !!document.querySelector('.combo-card')`);
      await evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('任务记录'));if(!b)throw Error('RECORD_NAV_MISSING');b.click()})()`,
      );
      await until(
        `document.querySelectorAll('.run-record-row[tabindex]').length===${speedMode ? 3 : 1}`,
      );
      assert.equal(
        await evaluate(`document.querySelectorAll('.run-step-pill').length`),
        speedMode ? 12 : 4,
      );
      assert.ok(
        await evaluate(
          `[...document.querySelectorAll('.run-record-row[tabindex]')].some(r=>r.textContent.includes('完成 2/4'))`,
        ),
      );
      checks.push('one stopped run, four ordered step pills including pending siblings');
      await new Promise((resolve) => setTimeout(resolve, 400));
      await writeFile(
        path.join(directory, 'records.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await evaluate(`document.querySelector('.run-record-row[tabindex]').click()`);
      await until(`document.querySelectorAll('.task-history-steps>div').length===4`);
      assert.equal(
        await evaluate(`!!document.querySelector('[aria-label="当前任务控制"]')`),
        false,
      );
      assert.equal(
        await evaluate(`document.querySelector('.record-diagnostic-collapse').open`),
        false,
      );
      assert.ok(
        await evaluate(
          `!![...document.querySelectorAll('button')].find(b=>b.textContent==='删除此条任务记录')`,
        ),
      );
      checks.push(
        'terminal drawer has report cards/delete, no disabled controls; diagnostics folded',
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await writeFile(
        path.join(directory, 'drawer.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      if (speedMode) {
        assert.equal(
          await evaluate(`document.querySelectorAll('.record-browser-avatar .avatar').length`),
          3,
        );
        assert.ok(await evaluate(`!!document.querySelector('.task-history-heading > .avatar')`));
        assert.equal(
          await evaluate(
            `getComputedStyle(document.querySelector('.record-browser-avatar')).flexDirection`,
          ),
          'row',
        );
        checks.push(
          'existing avatar component rendered horizontally in every run and drawer heading',
        );
        await evaluate(`document.querySelector('.drawer-head button[aria-label="关闭"]').click()`);
        await until(`!document.querySelector('.drawer')`);
        if (fixMode) {
          assert.ok(
            await evaluate(
              `!!document.querySelector('.records-toolbar-row .status-tabs') && !!document.querySelector('.records-toolbar-row .record-cleanup-actions')`,
            ),
          );
          await click('一键清理已结束');
          await until(
            `document.querySelector('dialog[open]')?.textContent.includes('12 条已结束')`,
          );
          await evaluate(
            `window.__cleanupFetch=window.fetch;window.fetch=(...args)=>String(args[0]).endsWith('/data-cleanup/execute')?Promise.resolve(new Response(JSON.stringify({code:'FIXTURE_CLEANUP_FAILED',error:'测试数据库暂时忙，请稍后重试'}),{status:500,headers:{'content-type':'application/json'}})):window.__cleanupFetch(...args);true`,
          );
          await click('确认清理');
          await until(
            `document.querySelector('dialog[open] [role="alert"]')?.textContent.includes('数据库暂时忙')`,
          );
          assert.ok(await evaluate(`!!document.querySelector('dialog[open]')`));
          await new Promise((r) => setTimeout(r, 300));
          await writeFile(
            path.join(directory, 'cleanup-error.png'),
            (await window.webContents.capturePage()).toPNG(),
          );
          await evaluate(`window.fetch=window.__cleanupFetch;true`);
          await click('重新预览');
          await until(
            `document.querySelector('dialog[open]')?.textContent.includes('12 条已结束')`,
          );
          await click('取消');
          checks.push(
            'status/manual actions share a toolbar row; cleanup error stays open in Chinese and re-preview recovers',
          );
        }

        await evaluate(
          `window.__recordsTableDisappeared=false;window.__recordsObserver=new MutationObserver(()=>{if(!document.querySelector('.records-table'))window.__recordsTableDisappeared=true});window.__recordsObserver.observe(document.querySelector('.records-page'),{subtree:true,childList:true});document.querySelector('.run-record-row[tabindex] .cell-time button').click()`,
        );
        await until(`document.querySelectorAll('.run-record-row[tabindex]').length===2`);
        await until(`!document.querySelector('dialog[open]')`);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await evaluate(`window.__recordsTableDisappeared`), false);
        assert.equal(store.tasks.hiddenRecordIds().length, 0); // Ordinary plans physically compact when safe.
        assert.equal((await new TaskService(store.tasks).records({ groupBy: 'run' })).total, 2);
        checks.push(
          'single-row deletion uses preview/execute without a dialog and keeps remaining table mounted',
        );
        await evaluate(
          `(()=>{const i=document.querySelector('input[aria-label="最大条数"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'1');i.dispatchEvent(new Event('input',{bubbles:true}))})()`,
        );
        await click('保存并清理');
        await until(`document.querySelector('dialog[open]')?.textContent.includes('4 条已结束')`);
        await click('确认清理');
        await until(
          `document.querySelectorAll('.run-record-row[tabindex]').length===1 && !document.querySelector('dialog[open]')`,
        );
        assert.equal(store.dataCleanup.settings().historyMaxCount, 1);
        checks.push('quota saved, preview confirms four excess steps, keeps latest single run');
        await click('保存并清理');
        await until(
          `document.querySelector('.record-cleanup-toolbar')?.textContent.includes('当前无超额记录')`,
        );
        assert.equal(await evaluate(`!!document.querySelector('dialog[open]')`), false);
        await new Promise((r) => setTimeout(r, 400));
        await writeFile(
          path.join(directory, 'quota.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
        await evaluate(`window.__recordsObserver.disconnect()`);
      } else {
        await click('删除此条任务记录');
        await until(`document.querySelector('dialog[open]')?.textContent.includes('4 条已结束')`);
        await click('确认清理');
        await until(
          `document.querySelectorAll('.run-record-row[tabindex]').length===0 && !document.querySelector('dialog[open]')`,
        );
        await until(
          `!document.querySelector('.task-history-select') && document.querySelector('.task-history')?.textContent.includes('还没有业务任务')`,
        );
        checks.push(
          'preview count=4, confirmed cleanup removes run/pending siblings and drawer history',
        );
      }
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            status: 'PASSED',
            checks,
            scope:
              'isolated generated database and Electron UI; no formal records deleted, no real browser operations',
          },
          null,
          2,
        ),
      );
      console.log('TASK_RECORDS_CLEANUP_UI_PASSED ' + directory);
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
