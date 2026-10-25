import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { startBridgeServer } from '../dist/src/bridge/server.js';
import { KernelBridge } from '../dist/src/infrastructure/kernel-bridge.js';
import { BridgeProfileSource } from '../dist/src/infrastructure/browser-source.js';
import { FacebookPublishingRuntime } from '../dist/src/infrastructure/facebook-publishing-runtime.js';
import { WorkspaceService } from '../dist/src/application/workspace-service.js';
import { TaskService } from '../dist/src/application/task-service.js';
import { workspaceApi } from '../dist/src/http/workspace-api.js';
import { ResourceTableService } from '../dist/src/application/resource-table-service.js';
import { createServer } from 'node:net';

// Generated offline profiles and an isolated controller: original UI/API/SQL control flow,
// no runtime tick, native browser connection, Facebook page, input or publication.
const directory = path.resolve('audit/task-product-ui-' + randomUUID());
await mkdir(path.join(directory, 'user'), { recursive: true });
app.setPath('userData', path.join(directory, 'user'));
void run();
async function run() {
  let window, store, server, kernel, runtime;
  const results = [];
  const timeout = setTimeout(() => app.exit(1), 55_000);
  try {
    await app.whenReady();
    store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
    const combo = store.createCombination({
      name: '首页与视频流程',
      note: '隔离生成资料界面验证',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 2 },
      steps: [
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    server = await startBridgeServer({
      root: process.cwd(),
      dataDir: directory,
      port,
      extensionIds: ['a'.repeat(32)],
      appRoutes: ({ core, store: bridge, tasks }) => {
        const profiles = new BridgeProfileSource(core, bridge, tasks);
        kernel = new KernelBridge(core, tasks);
        runtime = new FacebookPublishingRuntime(
          kernel,
          core,
          store,
          directory,
          () => profiles.profiles().map((profile) => ({ ...profile, dispatchAllowed: false })),
          { feed: () => true, video: () => true },
        );
        return workspaceApi(
          new WorkspaceService(store, profiles),
          new TaskService(store.tasks, () => runtime),
          undefined,
          undefined,
          new ResourceTableService(store.resourceTables),
        );
      },
    });
    const ids = Array.from({ length: 30 }, () => randomUUID());
    for (const [index, id] of ids.entries()) {
      server.store.pair(id, 'generated-offline-secret', 'a'.repeat(32));
      store.renameProfile(id, '资料 ' + String(index + 1).padStart(2, '0'));
    }
    const group = store.createGroup('批量选择', 'blue');
    store.moveProfiles(ids.slice(0, 29), group.id);
    window = new BrowserWindow({
      show: false,
      width: 1240,
      height: 840,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    // Hidden QA window must paint current React state rather than capture its initial frame.
    window.webContents.setBackgroundThrottling(false);
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, done) => done({ cancel: new URL(details.url).origin !== server.origin }),
    );
    const evaluate = async (code) => {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        try { return {value:await (${code})}; }
        catch(error) { return {error:error.message}; }
      })()`);
      if (result.error) throw Error(result.error);
      return result.value;
    };
    const wait = async (condition, label) => {
      const deadline = Date.now() + 10_000;
      while (!(await condition())) {
        if (Date.now() >= deadline) throw Error('UI_TIMEOUT:' + label);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const click = async (selector, prefix) => {
      await wait(
        () =>
          evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
        .some(element=>element.textContent.trim().startsWith(${JSON.stringify(prefix)})&&!element.disabled)`),
        prefix,
      );
      return evaluate(`(()=>{
      const button=[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(element=>element.textContent.trim().startsWith(${JSON.stringify(prefix)}));
      if(!button || button.disabled) throw Error('BUTTON_UNAVAILABLE'); button.click(); return true;
    })()`);
    };
    const allState = (state) =>
      store.tasks.list().length === 29 && store.tasks.list().every((plan) => plan.state === state);
    await window.loadURL(server.origin);
    await window.loadURL(server.origin + '/workbench/');
    await wait(() => evaluate("!!document.querySelector('.combination-card')"), 'loaded');
    await evaluate(
      '(()=>{document.querySelector(\'input[aria-label="选择整组 批量选择"]\').click();return true})()',
    );
    await wait(
      () => evaluate("document.querySelector('.selection-tools strong').textContent==='已选 29'"),
      'selection',
    );
    assert.equal(
      await evaluate("document.querySelector('.selection-tools strong').textContent"),
      '已选 29',
    );
    await click('.combination-card button', '启动');
    await wait(() => allState('QUEUED'), 'bulk-start');
    assert.ok(
      store.tasks
        .list()
        .every(
          (plan) => plan.combinationId === combo.id && ids.slice(0, 29).includes(plan.profileId),
        ),
    );
    const original = store.tasks.list().map((plan) => ({
      id: plan.id,
      snapshot: plan.snapshot,
      steps: store.tasks.steps(plan.id).map((step) => ({ id: step.id, progress: step.progress })),
    }));
    await wait(
      () =>
        evaluate(
          "[...document.querySelectorAll('.sidebar-bottom button')].some(b=>b.textContent.includes('暂停任务 (29)')&&!b.disabled)",
        ),
      'pause-ready',
    );
    await click('.sidebar-bottom button', '暂停任务');
    await wait(() => allState('PAUSED'), 'bulk-pause');
    await wait(
      () =>
        evaluate(
          "document.querySelector('.combination-card .badge')?.textContent.includes('29 份暂停')",
        ),
      'paused-count',
    );
    await writeFile(
      path.join(directory, 'paused.png'),
      (
        await (async () => {
          await evaluate(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
          );
          return window.webContents.capturePage();
        })()
      ).toPNG(),
    );
    await evaluate("(()=>{document.querySelector('.profile-name').click();return true})()");
    await wait(
      () => evaluate('!!document.querySelector(\'[aria-label="当前任务控制"]\')'),
      'single-history',
    );
    assert.equal(
      await evaluate("document.querySelector('.selection-tools strong').textContent"),
      '已选 29',
    );
    await click('[aria-label="当前任务控制"] button', '继续');
    await wait(
      () => store.tasks.list().filter((plan) => plan.state === 'QUEUED').length === 1,
      'single-resume',
    );
    assert.equal(store.tasks.list().filter((plan) => plan.state === 'PAUSED').length, 28);
    await click('.topbar nav button', '任务组合');
    await wait(
      () =>
        evaluate(
          "[...document.querySelectorAll('.sidebar-bottom button')].some(b=>b.textContent.includes('继续任务 (28)')&&!b.disabled)",
        ),
      'bulk-continue-ready',
    );
    await click('.sidebar-bottom button', '继续任务');
    await wait(() => allState('QUEUED'), 'bulk-continue');
    assert.deepEqual(
      store.tasks.list().map((plan) => ({
        id: plan.id,
        snapshot: plan.snapshot,
        steps: store.tasks.steps(plan.id).map((step) => ({ id: step.id, progress: step.progress })),
      })),
      original,
    );
    await click('.sidebar-bottom button', '停止所选浏览器');
    await wait(() => allState('STOPPED'), 'bulk-stop');
    for (const [width, height] of [
      [1240, 840],
      [840, 600],
    ]) {
      window.setContentSize(width, height);
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      const layout = await evaluate(
        "({overflow:document.documentElement.scrollWidth>innerWidth, bottom:document.querySelector('.sidebar-bottom').getBoundingClientRect().bottom, height:innerHeight})",
      );
      assert.equal(layout.overflow, false);
      assert.ok(layout.bottom <= layout.height + 1);
      results.push({ width, height, layout });
    }
    await writeFile(
      path.join(directory, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          generatedProfiles: 30,
          selectedProfiles: 29,
          originalPlanCount: 29,
          bulkStartPauseResumeStop: true,
          singleResumePreservesSelection: true,
          originalVersionsProgressPreserved: true,
          layout: results,
          realBrowserInputs: 0,
          actualFacebook: false,
          newPosts: 0,
        },
        null,
        2,
      ),
    );
    console.log(
      'Task product UI passed: 29 original plans, bulk controls and single resume; generated profiles only.',
    );
  } catch (error) {
    if (window)
      await writeFile(
        path.join(directory, 'failed.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    await writeFile(
      path.join(directory, 'result.json'),
      JSON.stringify(
        { ok: false, error: error instanceof Error ? error.message : String(error), results },
        null,
        2,
      ),
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    await runtime?.close();
    await kernel?.close();
    await server?.close();
    store?.close();
    clearTimeout(timeout);
    app.exit(process.exitCode ?? 0);
  }
}
