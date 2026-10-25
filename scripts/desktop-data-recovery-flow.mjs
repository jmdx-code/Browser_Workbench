import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
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
  const { app, BrowserWindow, utilityProcess, ipcMain } = await import('electron');
  const directory = path.resolve('audit/desktop-data-recovery-' + randomUUID());
  const dataDir = path.join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  app.on('window-all-closed', () => {});
  void run();
  async function run() {
    let child,
      window,
      backupDirectory,
      restarted = false,
      requestedRestart = false;
    const deadline = setTimeout(() => app.exit(1), 90000);
    try {
      await app.whenReady();
      const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
      const { Store } = await import('../dist/src/bridge/store.js');
      const workspace = await WorkspaceStore.open(path.join(dataDir, 'workspace.sqlite'));
      workspace.createGroup('恢复验收分组', 'blue');
      workspace.createCombination({
        name: '恢复验收组合',
        note: '生成数据，无Facebook输入',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 2, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      workspace.close();
      const native = new Store(path.join(dataDir, 'journal.sqlite'));
      native.pair(randomUUID(), 'isolated-recovery-only', 'a'.repeat(32));
      native.db.close();
      await writeFile(path.join(dataDir, 'original.mp4'), 'source remains in place');
      async function start() {
        const service = utilityProcess.fork(path.resolve('dist/src/server.js'), [], {
          env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_PORT: '18785' },
          stdio: 'pipe',
        });
        child = service;
        service.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        const origin = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('RECOVERY_CONTROLLER_BOOT_TIMEOUT')), 15000);
          service.on('message', (message) => {
            if (message?.type === 'READY') {
              clearTimeout(timer);
              resolve(message.origin);
            }
          });
          service.once('exit', (code) => {
            clearTimeout(timer);
            reject(Error('RECOVERY_CONTROLLER_EXIT_' + code));
          });
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
        await window.loadURL(origin + '/workbench/');
        return origin;
      }
      async function stop() {
        window?.destroy();
        if (child) {
          const exit = new Promise((resolve) => child.once('exit', resolve));
          child.postMessage('SHUTDOWN');
          await exit;
          child = undefined;
        }
      }
      ipcMain.handle('workbench:choose-backup-directory', () => directory);
      ipcMain.handle('workbench:choose-restore-backup', () => backupDirectory);
      // Test callback replaces OS process relaunch. The real preload, UI, controller shutdown
      // and subsequent normal server startup/restore are exercised below.
      ipcMain.handle('workbench:restart', () => {
        requestedRestart = true;
      });
      const runUI = (expression) => window.webContents.executeJavaScript(expression);
      const until = async (expression) => {
        const since = Date.now();
        while (!(await runUI(expression))) {
          if (Date.now() - since > 10000) throw Error('RECOVERY_UI_WAIT_' + expression);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      const click = async (text) =>
        assert.equal(
          await runUI(
            `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)}||e.querySelector('strong')?.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`,
          ),
          true,
          text,
        );
      let origin = await start();
      await until('!!document.querySelector(".sidebar")');
      await click('打开菜单');
      await until('!!document.querySelector(".drawer")');
      await click('备份与恢复');
      await until('!!document.querySelector(".workspace-backup-panel")');
      await click('选择文件夹…');
      await until(
        `document.querySelector("input[aria-label=数据备份保存位置]").value===${JSON.stringify(directory)}`,
      );
      await click('创建数据备份');
      await until('document.body.innerText.includes("备份已保存")');
      backupDirectory = path.join(
        directory,
        (await readdir(directory)).find((name) => name.startsWith('BrowserWorkbench-backup-')),
      );
      const landing = await fetch(origin);
      const cookie = landing.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const create = await fetch(origin + '/api/workspace/groups/create', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '备份后新增分组', color: 'green' }),
      });
      assert.equal(create.status, 201);
      await click('选择备份…');
      await until('document.querySelector("input[aria-label=待恢复备份文件夹]").value!==""');
      await click('检查备份');
      await until('document.body.innerText.includes("1 个分组、1 个组合、1 份资料")');
      await runUI('window.confirm=()=>true;true');
      await click('使用这份备份恢复…');
      await until('document.body.innerText.includes("数据已准备")');
      await window.webContents.executeJavaScript(
        'document.querySelector("input[aria-label=待恢复备份文件夹]").scrollIntoView({block:"center"})',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(
        path.join(directory, 'prepared.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('重启并恢复');
      assert.equal(requestedRestart, true);
      await stop();
      origin = await start();
      restarted = true;
      await until('!!document.querySelector(".sidebar")');
      await click('打开菜单');
      await until('!!document.querySelector(".drawer")');
      await click('备份与恢复');
      await until('document.body.innerText.includes("数据恢复完成")');
      await runUI(
        'document.querySelector("input[aria-label=待恢复备份文件夹]").scrollIntoView({block:"center"})',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(
        path.join(directory, 'restored.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      const restore = JSON.parse(
        await readFile(path.join(dataDir, 'pending-restore.json'), 'utf8'),
      );
      assert.equal(restore.state, 'APPLIED');
      const view = new (await import('node:sqlite')).DatabaseSync(
        path.join(dataDir, 'workspace.sqlite'),
        { readOnly: true },
      );
      try {
        assert.equal(view.prepare('SELECT count(*) AS n FROM groups').get().n, 1);
        assert.equal(view.prepare('SELECT count(*) AS n FROM combinations').get().n, 1);
        assert.equal(view.prepare('SELECT count(*) AS n FROM task_plans').get().n, 0);
      } finally {
        view.close();
      }
      const safety = new (await import('node:sqlite')).DatabaseSync(
        path.join(restore.safetyDirectory, 'workspace.sqlite'),
        { readOnly: true },
      );
      try {
        assert.equal(safety.prepare('SELECT count(*) AS n FROM groups').get().n, 2);
      } finally {
        safety.close();
      }
      assert.equal(
        await readFile(path.join(dataDir, 'original.mp4'), 'utf8'),
        'source remains in place',
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            status: 'PASSED',
            completedAt: new Date().toISOString(),
            normalControllerRestarted: restarted,
            actualSQLiteSafetyBackup: restore.safetyDirectory,
            osDialogAndProcessRelaunchCallbackWereStubbed: true,
            originalMediaUnchanged: true,
            browserOperations: 0,
            uploads: 0,
            posts: 0,
            screenshots: ['prepared.png', 'restored.png'],
          },
          null,
          2,
        ),
      );
      console.log('DESKTOP_DATA_RECOVERY_PASSED ' + directory);
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
      child?.kill();
      app.exit(process.exitCode ?? 0);
    }
  }
}
