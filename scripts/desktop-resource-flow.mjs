import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

if (!process.versions.electron) {
  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('scripts/desktop-resource-flow.mjs')],
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} else {
  const { app, BrowserWindow } = await import('electron');
  const directory = path.resolve('audit/desktop-resource-flow-' + randomUUID());
  await mkdir(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'user'));
  void run();
  async function run() {
    await app.whenReady();
    const { WorkspaceStore } = await import('../dist/src/infrastructure/workspace-store.js');
    const { WorkspaceService } = await import('../dist/src/application/workspace-service.js');
    const { ResourceTableService } =
      await import('../dist/src/application/resource-table-service.js');
    const { TaskService } = await import('../dist/src/application/task-service.js');
    const { FilesystemResourceSourceReader } =
      await import('../dist/src/infrastructure/resource-source-reader.js');
    const { BridgeProfileSource } = await import('../dist/src/infrastructure/browser-source.js');
    const { workspaceApi } = await import('../dist/src/http/workspace-api.js');
    const { startBridgeServer } = await import('../dist/src/bridge/server.js');
    let server, store, window;
    const checks = [];
    const timer = setTimeout(() => {
      console.error('DESKTOP_RESOURCE_FLOW_TIMEOUT');
      app.exit(1);
    }, 120000);
    try {
      store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
      const combo = store.createCombination({
        name: '桌面批量素材验证',
        note: '隔离生成内容，不连接FB',
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
      server = await startBridgeServer({
        root: process.cwd(),
        port: 18779,
        dataDir: path.join(directory, 'bridge'),
        extensionIds: ['a'.repeat(32)],
        diagnosticsEnabled: false,
        appRoutes: ({ core, store: bridge, tasks }) =>
          workspaceApi(
            new WorkspaceService(store, new BridgeProfileSource(core, bridge, tasks)),
            new TaskService(store.tasks),
            undefined,
            undefined,
            new ResourceTableService(store.resourceTables, new FilesystemResourceSourceReader()),
          ),
      });
      const media = path.join(directory, 'media');
      await mkdir(media);
      const files = [];
      for (let i = 0; i < 80; i++) {
        const image = i >= 75;
        const target = path.join(
          media,
          '本机素材' + String(i + 1).padStart(3, '0') + (image ? '.png' : '.mp4'),
        );
        if (image)
          await writeFile(
            target,
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
              'base64',
            ),
          );
        else await copyFile('public/sample.mp4', target, 1);
        files.push(target);
      }
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
          if (Date.now() - start > 10000) throw Error('UI_WAIT_FAILED: ' + expression);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const click = async (text) => {
        const result = await run(
          `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`,
        );
        assert.equal(result, true, 'click ' + text);
      };
      const paste = async (label, text) =>
        run(
          `(()=>{const e=document.querySelector('textarea[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!e)throw Error('CELL_MISSING');e.focus();const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(text)});e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));})()`,
        );
      await until(
        `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='设置发帖资源')`,
      );
      await click('设置发帖资源');
      await until(
        `!!document.querySelector('textarea[aria-label="文案第1行"]')&&!document.querySelector('.resource-body').disabled`,
      );
      await paste('文案第1行', Array.from({ length: 200 }, (_, i) => '文案' + (i + 1)).join('\n'));
      await until(`document.querySelector('.resource-pagination').textContent.includes('200 行')`);
      await paste(
        '媒体第1行',
        Array.from(
          { length: 100 },
          (_, i) => 'https://drive.google.com/file/d/generated-public-video-' + i + '/view',
        ).join('\n'),
      );
      await click('下一页');
      await click('下一页');
      await until(`!!document.querySelector('textarea[aria-label="媒体第101行"]')`);
      window.webContents.debugger.attach('1.3');
      const drop = async (label, paths) => {
        const point = await run(
          `(()=>{const e=document.querySelector('textarea[aria-label='+CSS.escape(${JSON.stringify(label)})+']');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        for (const type of ['dragEnter', 'dragOver', 'drop'])
          await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
            type,
            ...point,
            data: { items: [], files: paths, dragOperationsMask: 1 },
          });
      };
      await drop('媒体第101行', files.slice(0, 70));
      await until(
        `document.querySelector('textarea[aria-label="媒体第101行"]').value.includes('本机素材001.mp4')`,
      );
      checks.push(
        'real filesystem-backed Electron drag filled rows101–170 after200 text and100 link paste',
      );
      await click('＋ 新增一行');
      await until(`!!document.querySelector('textarea[aria-label="媒体第201行"]')`);
      await drop('媒体第201行', files.slice(70));
      await until(`document.querySelector('.resource-pagination').textContent.includes('210 行')`);
      const chooseType = async (kind) =>
        run(`(()=>{
        const e=document.querySelector('select[aria-label="按类型选择资源行"]');
        e.value=${JSON.stringify(kind)};e.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await chooseType('text');
      await until(`document.querySelector('.resource-body').textContent.includes('已选 30 行')`);
      await click('普通文字');
      await click('上一页');
      await until(`document.querySelector('select[aria-label="背景第171行"]').value==='plain'`);
      await click('彩贴');
      await until(`document.querySelector('select[aria-label="背景第171行"]').value==='color'`);
      await click('取消选择');
      const clickCheckbox = async (label, modifiers = 0) => {
        const point =
          await run(`(()=>{const e=document.querySelector('input[aria-label='+CSS.escape(${JSON.stringify(label)})+']');
          e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        for (const type of ['mousePressed', 'mouseReleased'])
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type,
            ...point,
            button: 'left',
            clickCount: 1,
            modifiers,
          });
      };
      await clickCheckbox('选择资源第151行');
      await clickCheckbox('选择资源第160行', 8);
      await until(`document.querySelector('.resource-body').textContent.includes('已选 10 行')`);
      await clickCheckbox('选择本页资源行');
      await until(`document.querySelector('.resource-body').textContent.includes('已选 50 行')`);
      await click('上一页');
      await clickCheckbox('选择本页资源行');
      await until(`document.querySelector('.resource-body').textContent.includes('已选 100 行')`);
      await click('取消选择');
      checks.push(
        'native Shift-click selected10 consecutive rows; page selections preserved100 rows across pages; all30 text rows changed background in bulk',
      );
      await click('保存资源');
      await until(
        `!document.querySelector('.resource-editor[open]')&&!document.querySelector('textarea[aria-label="文案第201行"]')`,
      );
      const table = store.resourceTables.read(combo.id),
        rows = table.rows;
      assert.equal(rows.length, 210);
      assert.ok(
        rows
          .slice(0, 100)
          .every(
            (row) =>
              row.media.length === 1 && row.media[0].source.startsWith('https://drive.google.com/'),
          ),
      );
      assert.deepEqual(
        rows.slice(100, 170).map((row) => row.media[0]?.source),
        files.slice(0, 70),
      );
      assert.ok(
        rows
          .slice(170, 200)
          .every((row) => row.media.length === 0 && row.background === 'color' && row.text),
      );
      assert.deepEqual(
        rows.slice(200).map((row) => row.media[0]?.source),
        files.slice(70),
      );
      assert.ok(rows.slice(200).every((row) => row.text === ''));
      assert.equal(store.tasks.list().length, 0);
      checks.push(
        'saved210 rows:100Drive refs,70local videos,30colored-text intentions,5pure videos and5pure images; no tasks started',
      );
      await until(`document.querySelector('.resource-count')?.textContent.includes('210')`);
      // executeJavaScript observes React's DOM before the hidden window has painted it.
      // Keep the captured frame and the displayed counter from the same stable state.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const displayedResourceCount = await run(
        `document.querySelector('.resource-count')?.textContent`,
      );
      assert.ok(displayedResourceCount.includes('210'));
      await writeFile(
        path.join(directory, 'saved.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await click('设置发帖资源');
      await until(
        `!!document.querySelector('textarea[aria-label="文案第1行"]')&&!document.querySelector('.resource-body').disabled`,
      );
      const search = async (text) =>
        run(
          `(()=>{const input=document.querySelector('input[aria-label="搜索资源"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      await search('文案200');
      await until(`document.querySelectorAll('.resource-grid tbody tr').length===1`);
      assert.equal(
        await run(
          `document.querySelector('.resource-grid tbody textarea').getAttribute('aria-label')`,
        ),
        '文案第200行',
      );
      await paste('文案第200行', '不得覆盖隐藏行\n第二条');
      await until(`document.querySelector('.resource-error')?.textContent.includes('清除筛选')`);
      assert.equal(
        await run(`document.querySelector('textarea[aria-label="文案第200行"]').value`),
        '文案200',
      );
      assert.deepEqual(store.resourceTables.read(combo.id).rows, rows);
      await search('文案19');
      await until(`document.querySelectorAll('.resource-grid tbody tr').length===11`);
      await click('取消选择');
      await run(`document.querySelector('input[aria-label="选择资源第19行"]').click()`);
      await run(
        `document.querySelector('input[aria-label="选择资源第199行"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`,
      );
      await until(
        `!![...document.querySelectorAll('.resource-toolbar span')].find(s=>s.textContent==='已选 11 行')`,
      );
      await click('清除筛选');
      await click('取消选择');
      await click('检查资源');
      await until(
        `!!document.querySelector('.resource-check-summary')&&!document.querySelector('.resource-body').disabled`,
      );
      await run(
        `(()=>{const select=document.querySelector('select[aria-label="筛选资源状态"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'attention');select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await until(
        `!document.querySelector('textarea[aria-label="文案第101行"]')&&!!document.querySelector('textarea[aria-label="文案第1行"]')`,
      );
      await click('仅选择筛选结果');
      await until(
        `!![...document.querySelectorAll('.resource-toolbar span')].find(s=>s.textContent==='已选 130 行')`,
      );
      await click('检查选中资源');
      await until(
        `document.querySelector('.resource-check-summary')?.textContent.includes('最近一批检查 130 行')&&!document.querySelector('.resource-body').disabled`,
      );
      await until(
        `document.querySelector('.resource-check-summary')?.textContent.includes('保留 210 行')`,
      );
      await click('仅选择筛选结果');
      await until(
        `!![...document.querySelectorAll('.resource-toolbar span')].find(s=>s.textContent==='已选 130 行')`,
      );
      await writeFile(
        path.join(directory, 'resource-filter.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      assert.deepEqual(store.resourceTables.read(combo.id).rows, rows);
      assert.equal(store.tasks.list().length, 0);
      checks.push(
        'real saved-source inspection identifies130 attention rows:100 pending Drive and30 unverified colored backgrounds; duplicate content is a nonblocking hint; selected recheck retains210 observations and duplicate roots; search keeps original row200, filtered Shift selects11 visible matches, paste cannot overwrite hidden rows; zero task assignments',
      );
      await click('清除筛选');
      await search('文案200');
      await until(`!!document.querySelector('button[aria-label="预览资源第200行"]')`);
      await run(`document.querySelector('button[aria-label="预览资源第200行"]').click()`);
      await until(
        `document.querySelector('.resource-preview-dialog[open]')?.textContent.includes('文案200')`,
      );
      assert.equal(
        await run(
          `document.querySelector('.resource-preview-dialog .resource-preview-text').textContent`,
        ),
        '文案200',
      );
      await run(`document.querySelector('button[aria-label="关闭资源预览"]').click()`);
      await search('本机素材080');
      await until(`!!document.querySelector('button[aria-label="预览资源第210行"]')`);
      await run(`document.querySelector('button[aria-label="预览资源第210行"]').click()`);
      await until(
        `(()=>{const image=document.querySelector('.resource-preview-dialog img');return !!image&&image.complete&&image.naturalWidth>0;})()`,
      );
      await writeFile(
        path.join(directory, 'resource-preview.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(`document.querySelector('button[aria-label="关闭资源预览"]').click()`);
      await search('本机素材071');
      await until(`!!document.querySelector('button[aria-label="预览资源第201行"]')`);
      await run(`document.querySelector('button[aria-label="预览资源第201行"]').click()`);
      await until(`document.querySelector('.resource-preview-dialog video')?.readyState>=1`);
      assert.equal(
        await run(`document.querySelector('.resource-preview-dialog video').paused`),
        true,
      );
      await run(`document.querySelector('button[aria-label="关闭资源预览"]').click()`);
      await search('文案1');
      await until(`!!document.querySelector('button[aria-label="预览资源第1行"]')`);
      await run(`document.querySelector('button[aria-label="预览资源第1行"]').click()`);
      await until(
        `document.querySelector('.resource-preview-dialog[open]')?.textContent.includes('本次未自动下载')`,
      );
      assert.equal(
        await run(
          `document.querySelectorAll('.resource-preview-dialog video,.resource-preview-dialog img').length`,
        ),
        0,
      );
      await run(`document.querySelector('button[aria-label="关闭资源预览"]').click()`);
      assert.deepEqual(store.resourceTables.read(combo.id).rows, rows);
      assert.equal(store.tasks.list().length, 0);
      checks.push(
        'real saved-row previews preserve original filtered row numbers: text200, decoded local image210, video201 metadata without autoplay, Drive1 explicit pending without fetching; same table and zero task ledger',
      );
      const report = {
        ok: true,
        actualFacebook: false,
        generatedClipboard: true,
        actualDesktopPreload: true,
        filesystemBackedCDPDrag: true,
        windowsExplorerGesture: false,
        resourcePublishingAccepted: false,
        rows: 210,
        displayedResourceCount,
        checks,
        database: path.join(directory, 'workspace.sqlite'),
        inputsToFacebook: 0,
        uploads: 0,
        posts: 0,
      };
      await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), {
        flag: 'wx',
      });
      console.log(path.join(directory, 'result.json'));
    } catch (error) {
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify(
          { ok: false, actualFacebook: false, checks, error: String(error.stack ?? error) },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      console.error(directory, String(error.stack ?? error));
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
