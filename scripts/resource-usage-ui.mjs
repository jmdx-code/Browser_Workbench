import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated generated UI only. No server, formal database or user browser is contacted.
const output = path.resolve('audit/resource-usage-ui-20261011.json');
const user = path.resolve('audit/resource-usage-ui-user-' + randomUUID());
await mkdir(user);
app.setPath('userData', user);
const bundle = path.resolve('audit/resource-usage-render-20261011-v2.mjs');
const { render } = await import(pathToFileURL(bundle).href);
const id = randomUUID();
const rows = [
  {
    id,
    version: 1,
    revision: 0,
    draft: null,
    saved: {
      name: '资源执行记录 · 生成样本',
      note: '生成状态仅用于界面核验',
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
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    },
    updatedAt: 0,
  },
];
const cases = [
  { name: 'unread', summaries: null, expected: '资源记录未读取' },
  { name: 'unset', summaries: [], expected: '剩余 0 条 · 尚未设置资源' },
  {
    name: 'pending-and-review',
    summaries: [
      {
        version: 2,
        combinationId: id,
        revision: 4,
        total: 250,
        published: 190,
        remaining: 60,
        pendingAttempts: 50,
        reviewAttempts: 20,
        previousVersionPending: 10,
        verifiedReady: 0,
      },
    ],
    expected: '剩余 60 条 · 已发 190 条 · 50 个执行中 · 20 个待核对 · 其中旧资源 10 个 · 待核验',
  },
];
const css = await readFile('src/renderer/style.css', 'utf8');
void run();
async function run() {
  const results = [];
  let window;
  const deadline = setTimeout(() => app.exit(1), 30000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }),
    );
    for (const width of [319, 1280]) {
      window.setContentSize(width, 900);
      for (const sample of cases) {
        await window.loadURL(
          'data:text/html;charset=utf-8,' +
            encodeURIComponent(
              '<!doctype html><meta charset="utf-8"><style>' +
                css +
                '</style>' +
                render(rows, sample.summaries),
            ),
        );
        const actual = await window.webContents.executeJavaScript(`({
        label: document.querySelector('.resource-count').textContent,
        title: document.querySelector('.resource-count').title,
        buttons: Array.from(document.querySelectorAll('button')).filter(e=>e.textContent==='启动').map(e=>e.disabled),
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth
      })`);
        assert.equal(actual.label, sample.expected);
        assert.ok(actual.title.includes('包含执行中及待核对项'));
        assert.deepEqual(actual.buttons, [true]);
        assert.ok(actual.scrollWidth <= actual.width, JSON.stringify(actual));
        if (sample.name === 'pending-and-review')
          await writeFile(
            path.resolve(`audit/resource-usage-ui-${width}-20261011.png`),
            (await window.webContents.capturePage()).toPNG(),
            { flag: 'wx' },
          );
        results.push({ requestedWidth: width, case: sample.name, ...actual });
      }
    }
    await writeFile(
      output,
      JSON.stringify({ ok: true, generatedUI: true, actualFacebook: false, results }, null, 2),
      { flag: 'wx' },
    );
  } catch (failure) {
    console.error(failure);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
