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
  const { app, BrowserWindow, ipcMain } = await import('electron');
  const directory = path.resolve('audit/desktop-task-options-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    let window, server, store;
    const checks = [];
    const deadline = setTimeout(() => app.exit(1), 90000);
    try {
      await app.whenReady();
      const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
      const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
      const { TaskService } = await import('../dist/src/application/task-service.js');
      const { MaterialUsageService } =
        await import('../dist/src/application/material-usage-service.js');
      const { WorkspaceBackupService } =
        await import('../dist/src/application/workspace-backup-service.js');
      const { FilesystemWorkspaceBackupWriter } =
        await import('../dist/src/infrastructure/workspace-backup-writer.js');
      const { ResourceTableService } =
        await import('../dist/src/application/resource-table-service.js');
      const { BridgeProfileSource } = await import('../dist/src/infrastructure/browser-source.js');
      const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
      const { startBridgeServer } = await import('../dist/src/bridge/server.js');
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const combination = store.createCombination({
        name: '桌面商城及快拍配置',
        note: '生成数据，零FB操作',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: randomUUID(),
            type: 'marketplace',
            keyword: '',
            categoryId: '479353692612078',
            minPrice: 10,
            maxPrice: 200,
            durationMinutes: 4,
            maxLikes: 0,
            minLikeCount: 0,
          },
          {
            id: randomUUID(),
            type: 'post',
            destination: 'story',
            resourceMode: 'table',
            resourceDirectory: '',
            count: 2,
            allowRepeat: true,
            forbidSameAccountRepeat: true,
            archivePublished: false,
          },
        ],
      });
      const rows = ['普通帖子', '快拍素材', '两用素材'].map((text) => ({
        id: randomUUID(),
        text,
        media: [],
        background: 'plain',
      }));
      store.resourceTables.save(combination.id, 0, rows);
      server = await startBridgeServer({
        root: process.cwd(),
        port: 18784,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: ({ core, store: bridge, tasks }) => {
          const backups = new WorkspaceBackupService(
            store.tasks,
            new FilesystemWorkspaceBackupWriter(
              (file) => store.backup(file),
              (file) => bridge.backup(file),
              '0.1.41',
            ),
          );
          return workspaceApi(
            new WorkspaceService(store, new BridgeProfileSource(core, bridge, tasks)),
            new TaskService(store.tasks, undefined, () => backups.assertIdle()),
            undefined,
            undefined,
            new ResourceTableService(store.resourceTables),
            undefined,
            undefined,
            new MaterialUsageService(store.materialUsage),
            backups,
          );
        },
      });
      let chosenBackupDirectories = 0;
      ipcMain.handle('workbench:choose-backup-directory', () => {
        chosenBackupDirectories++;
        return directory;
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
      const run = (expression) => window.webContents.executeJavaScript(expression);
      const until = async (expression) => {
        const start = Date.now();
        while (!(await run(expression))) {
          if (Date.now() - start > 10000) throw Error('UI_WAIT_FAILED ' + expression);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      const click = async (text) =>
        assert.equal(
          await run(
            `(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}||el.getAttribute('aria-label')===${JSON.stringify(text)}||el.querySelector('strong')?.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)return false;button.click();return true;})()`,
          ),
          true,
          text,
        );
      const screenshot = async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await writeFile(
          path.join(directory, name),
          (await window.webContents.capturePage()).toPNG(),
        );
      };
      const select = async (label, value) =>
        assert.equal(
          await run(
            `(()=>{const el=document.querySelector('select[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!el)return false;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
          ),
          true,
          label,
        );
      await until(`!!document.querySelector('.combo-card .combo-body')`);
      await run(`document.querySelector('.combo-card .combo-body').click()`);
      await until(`document.querySelectorAll('.step').length===2`);
      assert.equal(
        await run(`document.querySelector('.step-post strong').textContent`),
        '发布快拍',
      );
      assert.deepEqual(
        await run(
          `[...document.querySelector('.step-marketplace').querySelectorAll('input[type=number]')].map(el=>el.value)`,
        ),
        ['4', '10', '200'],
      );
      assert.equal(
        await run(`document.querySelector('.step-marketplace select').value`),
        '479353692612078',
      );
      assert.ok(
        await run(`document.querySelector('.step-post').textContent.includes('每个账号快拍数')`),
      );
      await screenshot('editor.png');
      await click('＋ 发布快拍');
      await until(`document.querySelectorAll('.step-post').length===2`);
      await click('＋ 随机发帖');
      await until(`!!document.querySelector('select[aria-label="AI 声明"]')`);
      await select('AI 声明', 'on');
      await until(`document.querySelector('select[aria-label="AI 声明"]').value==='on'`);
      await run(
        `document.querySelector('select[aria-label="AI 声明"]').scrollIntoView({block:'center'})`,
      );
      await until(
        `(()=>{const r=document.querySelector('select[aria-label="AI 声明"]').getBoundingClientRect();return r.top>=48&&r.bottom<=innerHeight-24})()`,
      );
      await screenshot('ai-label.png');
      await click('保存组合');
      await until(`!document.querySelector('.editor')`);
      const saved = store.combinations()[0];
      assert.equal(saved.saved.steps.length, 4);
      assert.equal(saved.saved.steps[2].destination, 'story');
      assert.equal(saved.saved.steps[3].aiLabel, 'on');
      const { DatabaseSync } = await import('node:sqlite');
      const read = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
      try {
        assert.deepEqual(
          JSON.parse(
            read
              .prepare('SELECT body FROM combination_versions WHERE combination_id=? AND version=1')
              .get(combination.id).body,
          ),
          combination.saved,
        );
      } finally {
        read.close();
      }
      checks.push(
        'marketplace category/prices, separate story settings and explicit AI label save v2 while v1 remains immutable',
      );
      await click('更多操作');
      await until(
        `!![...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='发帖资源')`,
      );
      await click('发帖资源');
      await until(`!!document.querySelector('select[aria-label="用途第3行"]')`);
      await select('用途第2行', 'story');
      await select('用途第3行', 'both');
      await run(`document.querySelector('input[aria-label="选择资源第1行"]').click()`);
      await select('批量设置资源用途', 'both');
      await until(`document.querySelector('select[aria-label="用途第1行"]').value==='both'`);
      await select('筛选资源状态', 'story');
      await until(`document.querySelectorAll('.resource-grid tbody tr').length===3`);
      assert.equal(
        await run(`document.querySelector('input[aria-label="选择资源第1行"]').checked`),
        true,
      );
      await screenshot('resource-purpose.png');
      await select('筛选资源状态', 'post');
      await until(`document.querySelectorAll('.resource-grid tbody tr').length===2`);
      await click('保存资源');
      await until(`!document.querySelector('.resource-body')`);
      const table = store.resourceTables.read(combination.id);
      assert.deepEqual(
        table.rows.map((row) => row.purpose),
        ['both', 'story', 'both'],
      );
      assert.deepEqual(store.resourceTables.readVersion(combination.id, 1).rows, rows);
      assert.equal(store.tasks.list().length, 0);
      checks.push(
        'row and bulk purpose edits, destination filter, selection retention, save/close and old resource revision preservation',
      );
      await click('打开菜单');
      await until("!!document.querySelector('.drawer')");
      await click('备份与恢复');
      await until("!!document.querySelector('.workspace-backup-panel')");
      await click('选择文件夹…');
      await until(
        `document.querySelector('input[aria-label="数据备份保存位置"]').value===${JSON.stringify(directory)}`,
      );
      await until(
        "!![...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='创建数据备份'&&!el.disabled)",
      );
      await click('创建数据备份');
      await until(
        "document.querySelector('.workspace-backup-panel').textContent.includes('备份已保存')",
      );
      assert.equal(chosenBackupDirectories, 1);
      const { readdir, readFile } = await import('node:fs/promises');
      const backups = (await readdir(directory)).filter((name) =>
        name.startsWith('BrowserWorkbench-backup-'),
      );
      assert.equal(backups.length, 1);
      const metadata = JSON.parse(
        await readFile(path.join(directory, backups[0], 'backup.json'), 'utf8'),
      );
      assert.equal(metadata.files.length, 2);
      assert.equal(metadata.includesSourceMedia, false);
      await run(
        "document.querySelector('.workspace-backup-panel').scrollIntoView({block:'center'})",
      );
      await screenshot('backup.png');
      checks.push(
        'actual sandbox preload folder-selection IPC (fixture dialog callback), authenticated HTTP backup, two live SQLite copies and visible saved path; no source/cache copy',
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            status: 'PASSED',
            completedAt: new Date().toISOString(),
            scope: 'isolated React/Electron/SQLite, generated text only',
            checks,
            browserOperations: 0,
            uploads: 0,
            posts: 0,
            screenshots: ['editor.png', 'ai-label.png', 'resource-purpose.png', 'backup.png'],
            nativeFolderDialogWasStubbed: true,
          },
          null,
          2,
        ),
      );
      console.log('DESKTOP_TASK_OPTIONS_PASSED ' + directory);
    } catch (error) {
      await writeFile(path.join(directory, 'failure.txt'), String(error.stack ?? error));
      if (window && !window.isDestroyed()) {
        await writeFile(
          path.join(directory, 'failure.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
        await writeFile(
          path.join(directory, 'failure-ui.txt'),
          await window.webContents.executeJavaScript('document.body.innerText'),
        );
      }
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
