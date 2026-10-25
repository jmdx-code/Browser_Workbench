import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('scripts/desktop-drive-flow.mjs')],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron');
  const directory = path.resolve('audit/desktop-drive-flow-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
    const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
    const { TaskService } = await import('../dist/src/application/task-service.js');
    const { ResourceTableService } =
      await import('../dist/src/application/resource-table-service.js');
    const { ResourceDownloadService } =
      await import('../dist/src/application/resource-download-service.js');
    const { MaterialUsageService } =
      await import('../dist/src/application/material-usage-service.js');
    const { FilesystemResourceSourceReader } =
      await import('../dist/src/infrastructure/resource-source-reader.js');
    const { PublicResourceDriveDownloader } =
      await import('../dist/src/infrastructure/resource-drive-downloader.js');
    const { BridgeProfileSource } = await import('../dist/src/infrastructure/browser-source.js');
    const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
    const { startBridgeServer } = await import('../dist/src/bridge/server.js');
    const { emptyResourceRow, mediaReference } =
      await import('../dist/src/domain/resource-table.js');
    const { revealLocalFile } = await import('../dist/src/infrastructure/local-file-location.js');
    const located = [];
    ipcMain.handle('workbench:reveal-local-file', (event, input) => {
      assert.equal(event.sender, window.webContents);
      assert.equal(event.senderFrame, window.webContents.mainFrame);
      return revealLocalFile(input, (source) => located.push(source));
    });
    let server,
      store,
      window,
      deny = true,
      cancelMode = false,
      active = 0,
      maximum = 0;
    const requested = [],
      checks = [];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
      'base64',
    );
    const sample = await readFile('public/sample.mp4');
    const request = async (input, options) => {
      const id = new URL(String(input)).searchParams.get('id');
      requested.push(id);
      active++;
      maximum = Math.max(active, maximum);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, cancelMode && id !== 'cancel-0' ? 1200 : 30);
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(Error('ABORTED'));
            },
            { once: true },
          );
        });
        if (id === 'generated-20' && deny)
          return new Response('Permission required', { status: 403 });
        const bytes = id === 'generated-0' ? sample : png;
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': id === 'generated-0' ? 'video/mp4' : 'image/png',
            'content-length': String(bytes.length),
          },
        });
      } finally {
        active--;
      }
    };
    const timer = setTimeout(() => {
      console.error('DESKTOP_DRIVE_TIMEOUT');
      app.exit(1);
    }, 120000);
    try {
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const combo = store.createCombination({
        name: '网盘批量下载',
        note: '生成网络响应；无FB操作',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: randomUUID(),
            type: 'post',
            resourceMode: 'table',
            resourceDirectory: '',
            count: 1,
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: true,
          },
        ],
      });
      const rows = Array.from({ length: 100 }, (_, i) => ({
        ...emptyResourceRow(randomUUID()),
        text: '第' + (i + 1) + '条文案',
        media: [mediaReference('https://drive.google.com/file/d/generated-' + i + '/view')],
      }));
      const original = store.resourceTables.save(combo.id, 0, rows);
      const resources = new ResourceTableService(
        store.resourceTables,
        new FilesystemResourceSourceReader(),
        Date.now,
        new ResourceDownloadService(
          store.resourceTables,
          new PublicResourceDriveDownloader(path.join(directory, 'downloads'), request),
        ),
      );
      server = await startBridgeServer({
        root: process.cwd(),
        port: 18780,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: ({ core, store: bridge, tasks }) =>
          workspaceApi(
            new WorkspaceService(store, new BridgeProfileSource(core, bridge, tasks)),
            new TaskService(store.tasks),
            undefined,
            undefined,
            resources,
            undefined,
            undefined,
            new MaterialUsageService(store.materialUsage),
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
      const run = (expression) => window.webContents.executeJavaScript(expression);
      const until = async (expression) => {
        const started = Date.now();
        while (!(await run(expression))) {
          if (Date.now() - started > 15000) throw Error('UI_WAIT_FAILED:' + expression);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const click = async (text) =>
        assert.equal(
          await run(
            `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}||b.querySelector('strong')?.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`,
          ),
          true,
          text,
        );
      await until(`!!document.querySelector('.combo-card button[aria-label="更多操作"]')`);
      await click('更多操作');
      await until(
        `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发帖资源')`,
      );
      await click('发帖资源');
      await until(
        `!!document.querySelector('textarea[aria-label="媒体第1行"]')&&!document.querySelector('.resource-body').disabled`,
      );
      await click('下载网盘素材');
      await until(`document.querySelector('.resource-footer').textContent.includes('已处理')`);
      await until(
        `document.querySelector('.resource-check-summary')?.textContent.includes('下载 99 份')&&!document.querySelector('.resource-body').disabled`,
      );
      assert.equal(maximum, 3);
      assert.equal(requested.length, 100);
      let table = store.resourceTables.read(combo.id);
      assert.equal(table.rows.filter((row) => row.media[0]?.kind === 'local').length, 99);
      assert.equal(table.rows[0].media[0].mediaType, 'video');
      assert.equal(table.rows[20].media[0].kind, 'drive');
      assert.deepEqual(store.resourceTables.readVersion(combo.id, 1), original);
      checks.push(
        '100 generated public responses through original downloader, SHA, filesystem, authenticated HTTP and React; max3;99saved and1failed URL retained',
      );
      await click('预览');
      await until(`document.querySelector('.resource-preview-dialog video')?.readyState>=1`);
      await click('查看原文件位置');
      await until(`!document.querySelector('.file-location-action button').disabled`);
      assert.deepEqual(located, [table.rows[0].media[0].source]);
      assert.equal(
        await run(`document.querySelector('.resource-preview-dialog video').paused`),
        true,
      );
      await run(`document.querySelector('button[aria-label="关闭资源预览"]').click()`);
      deny = false;
      await click('仅重试下载失败行');
      await until(
        `document.querySelector('.resource-check-summary')?.textContent.includes('下载 1 份')&&!document.querySelector('.resource-body').disabled`,
      );
      assert.deepEqual(requested.slice(100), ['generated-20']);
      table = store.resourceTables.read(combo.id);
      assert.equal(table.rows.filter((row) => row.media[0]?.kind === 'local').length, 100);
      checks.push(
        'downloaded video decoded and paused; real preload IPC resolved its actual local file (OS callback substituted, no Explorer opened); retry requested only failed row',
      );
      await writeFile(
        path.join(directory, 'downloaded.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('保存资源');
      await until(`!document.querySelector('dialog.resource-dialog[open]')`);
      cancelMode = true;
      store.resourceTables.save(
        combo.id,
        table.revision,
        Array.from({ length: 6 }, (_, i) => ({
          ...emptyResourceRow(randomUUID()),
          text: '取消测试' + i,
          media: [mediaReference('https://drive.google.com/file/d/cancel-' + i + '/view')],
        })),
      );
      await click('更多操作');
      await until(
        `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发帖资源')`,
      );
      await click('发帖资源');
      await until(
        `document.querySelector('textarea[aria-label="媒体第1行"]')?.value.includes('cancel-0')`,
      );
      await click('下载网盘素材');
      await until(`document.querySelector('.resource-footer').textContent.includes('下载成功 1')`);
      await click('取消下载');
      await until(
        `document.querySelector('.resource-error')?.textContent.includes('下载已取消')&&!document.querySelector('.resource-body').disabled`,
      );
      while (active) await new Promise((resolve) => setTimeout(resolve, 20));
      const cancelled = store.resourceTables.read(combo.id);
      assert.equal(cancelled.rows.filter((row) => row.media[0]?.kind === 'local').length, 1);
      assert.equal(cancelled.rows.filter((row) => row.media[0]?.kind === 'drive').length, 5);
      assert.equal(
        await run(
          `document.querySelector('textarea[aria-label="媒体第1行"]').value.startsWith('https:')`,
        ),
        false,
      );
      checks.push(
        'real desktop Cancel aborted all pending downloaders;one saved media survived,5links retained, original task ledger empty',
      );
      assert.equal(store.tasks.list().length, 0);
      await writeFile(
        path.join(directory, 'cancelled.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('保存资源');
      await until(`!document.querySelector('dialog.resource-dialog[open]')`);
      const root = path.join(directory, 'retained-source');
      await mkdir(root);
      const source = path.join(root, 'text.txt');
      await writeFile(source, '生成使用记录，不上传或发布');
      const { FilesystemMaterialScanner } =
        await import('../dist/src/infrastructure/material-scanner.js');
      const { postRequest, dispatchedPost, postReceipt, deliverPostNotices } =
        await import('../dist/tests/fixtures/material-post.js');
      const catalog = store.materials.index(
        await new FilesystemMaterialScanner().scan(root),
        randomUUID(),
      );
      const seed = postRequest(store, catalog);
      store.materials.reserve(seed);
      const operation = dispatchedPost(store, seed);
      store.materialPosts.verify(postReceipt(store, seed, operation, 'PUBLISHED'));
      deliverPostNotices(store, seed.context.profileId);
      store.tasks.completeStep(seed.jobId, seed.stepId);
      const originalReceipt = store.materialPosts.result(seed.attemptId);
      await click('打开菜单');
      await until(`!!document.querySelector('.drawer')`);
      await click('素材使用记录');
      await until(
        `document.querySelector('section[aria-label="素材使用记录"]')?.textContent.includes('1 次已确认发布')`,
      );
      await click('清空素材使用记录');
      await until(`!!document.querySelector('dialog[aria-label="清空素材使用记录"][open]')`);
      await click('清空使用记录');
      await until(
        `document.querySelector('section[aria-label="素材使用记录"]')?.textContent.includes('0 次已确认发布')&&!document.querySelector('dialog[aria-label="清空素材使用记录"]')`,
      );
      assert.equal(store.materialUsage.snapshot().generation, 1);
      assert.deepEqual(store.materialPosts.result(seed.attemptId), originalReceipt);
      assert.equal(await readFile(source, 'utf8'), '生成使用记录，不上传或发布');
      assert.equal(store.materialPosts.archives().length, 0);
      checks.push(
        'actual Settings confirmation reset1 generated usage record; original publication/task evidence and local source preserved, no archive request',
      );
      await writeFile(
        path.join(directory, 'usage-cleared.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          {
            ok: true,
            completedAt: new Date().toISOString(),
            network: 'generated public responses; no real Drive requests',
            browserInputs: 0,
            uploads: 0,
            posts: 0,
            rows: 100,
            generatedPublications: 1,
            realPublications: 0,
            maximumDownloadConcurrency: maximum,
            checks,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ ok: true, directory, checks }));
    } catch (error) {
      await writeFile(path.join(directory, 'error.txt'), String(error?.stack ?? error));
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
