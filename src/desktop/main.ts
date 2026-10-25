import { cleanupDesktopSmoke } from './cleanup-smoke.js';
import { windowLayoutSmoke } from './window-layout-smoke.js';
import { applyPendingWorkspaceReset } from '../infrastructure/workspace-reset.js';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  shell,
  safeStorage,
  session,
  Notification,
  screen,
} from 'electron';
import { DesktopTaskNotification } from '../shared/workspace-preferences.js';
import type { UtilityProcess } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  defaultBackupDirectory,
  productDataDirectory,
  productExtensionDirectory,
} from '../infrastructure/paths.js';
import { DatabaseSync } from 'node:sqlite';
import { revealLocalFile } from '../infrastructure/local-file-location.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const softwareVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, '../package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
})();
let child: UtilityProcess | null = null;
let window: BrowserWindow | null = null;
let quitting = false;
let shutdownStarted = false;
let windowMayClose = false;
let restartRequested = false;
function finishShutdown() {
  if (!quitting) {
    quitting = true;
    if (restartRequested) app.relaunch();
  }
  app.quit();
}
const smokeFile = process.env.WORKBENCH_SMOKE_OUT;
app.setName('Browser Workbench');
if (process.env.WORKBENCH_SMOKE_USER_DATA)
  app.setPath('userData', process.env.WORKBENCH_SMOKE_USER_DATA);
if (!app.requestSingleInstanceLock({ version: softwareVersion })) {
  const message = `浏览器工作台 v${softwareVersion} 已在运行，已切换到运行中的窗口。`;
  if (smokeFile) {
    try {
      void writeFile(
        smokeFile,
        JSON.stringify(
          { ok: false, code: 'SECOND_INSTANCE_RUNNING', version: softwareVersion, reason: message },
          null,
          2,
        ),
      ).finally(() => app.quit());
    } catch {
      app.quit();
    }
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
    const incomingVersion =
      additionalData &&
      typeof additionalData === 'object' &&
      'version' in additionalData &&
      typeof additionalData.version === 'string'
        ? additionalData.version
        : null;
    if (!smokeFile && window && !window.isDestroyed()) {
      const detail =
        incomingVersion && incomingVersion !== softwareVersion
          ? `检测到尝试启动 v${incomingVersion}；请先关闭当前运行中的 v${softwareVersion} 再切换版本。`
          : '已为您激活当前正在运行的窗口。';
      void dialog.showMessageBox(window, {
        type: 'info',
        title: '浏览器工作台已在运行',
        message: `浏览器工作台 v${softwareVersion} 已在运行`,
        detail,
      });
    }
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!smokeFile && window && !window.isDestroyed() && !windowMayClose) {
      event.preventDefault();
      window.close();
      return;
    }
    if (!child) {
      if (restartRequested && !quitting) {
        quitting = true;
        app.relaunch();
      }
      return;
    }
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    child.postMessage('SHUTDOWN');
    const fallback = setTimeout(() => {
      child?.kill();
      finishShutdown();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(fallback);
      finishShutdown();
    });
  });
  app.on('window-all-closed', () => {
    if (!smokeFile) app.quit();
  });
  void app
    .whenReady()
    .then(boot)
    .catch(async (error: unknown) => {
      const reason = error instanceof Error ? error.message : '启动失败';
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'STARTUP_FAILED';
      if (smokeFile)
        await writeFile(smokeFile, JSON.stringify({ ok: false, code, reason }, null, 2));
      else dialog.showErrorBox('浏览器工作台启动失败', reason);
      app.quit();
    });
}
async function boot() {
  const dataDir = process.env.WORKBENCH_DATA_DIR ?? productDataDirectory();
  if (await applyPendingWorkspaceReset(dataDir)) {
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    await rm(path.join(app.getPath('userData'), 'graph-avatar.credential'), { force: true });
  }
  await mkdir(dataDir, { recursive: true });
  let avatarToken = process.env.WORKBENCH_GRAPH_AVATAR_TOKEN;
  if (!avatarToken && safeStorage.isEncryptionAvailable()) {
    try {
      avatarToken = safeStorage.decryptString(
        await readFile(path.join(app.getPath('userData'), 'graph-avatar.credential')),
      );
    } catch {
      /* Optional display credentials; no credential data is logged. */
    }
  }
  const layoutScreens = () =>
    screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      primary: d.id === screen.getPrimaryDisplay().id,
      scaleFactor: d.scaleFactor,
      workArea: d.workArea,
    }));
  child = utilityProcess.fork(
    path.join(
      process.env.WORKBENCH_BASE_ROOT ?? path.dirname(root),
      'dist/src/desktop/server-bootstrap.js',
    ),
    [],
    {
      env: {
        ...process.env,
        WORKBENCH_DATA_DIR: dataDir,
        WORKBENCH_RUNTIME_ROOT: path.dirname(root),
        WORKBENCH_DISPLAYS: JSON.stringify(layoutScreens()),
        ...(avatarToken ? { WORKBENCH_GRAPH_AVATAR_TOKEN: avatarToken } : {}),
      },
      stdio: 'pipe',
      serviceName: 'Browser Workbench Controller',
    },
  );
  const service = child;
  const updateScreens = () =>
    service.postMessage({ type: 'DISPLAY_LAYOUT_CHANGED', displays: layoutScreens() });
  screen.on('display-added', updateScreens);
  screen.on('display-removed', updateScreens);
  screen.on('display-metrics-changed', updateScreens);
  service.once('exit', () => {
    screen.removeListener('display-added', updateScreens);
    screen.removeListener('display-removed', updateScreens);
    screen.removeListener('display-metrics-changed', updateScreens);
  });
  service.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'OPEN_EXTENSION_DIRECTORY'
    ) {
      void shell.openPath(productExtensionDirectory());
      return;
    }
    const notice = DesktopTaskNotification.safeParse(message);
    if (notice.success && !smokeFile && Notification.isSupported()) {
      const { failed, completed } = notice.data;
      const body = [
        failed ? `${failed} 份任务失败` : '',
        completed ? `${completed} 份任务完成` : '',
      ]
        .filter(Boolean)
        .join('，');
      try {
        new Notification({ title: 'Browser Workbench', body }).show();
      } catch {
        /* Desktop notifications are optional. */
      }
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      (message.type === 'REQUEST_RESTART' || message.type === 'REQUEST_RESET')
    ) {
      if (message.type === 'REQUEST_RESET') {
        windowMayClose = true;
        restartRequested = true;
        app.quit();
        return;
      }
      restartRequested = true;
      if (window && !window.isDestroyed()) window.close();
      else app.quit();
    }
  });
  service.stdout?.on('data', (buffer: Buffer) => process.stdout.write(buffer));
  let diagnostics = '';
  let preparationWindow: BrowserWindow | null = null;
  let startupProgressMessages = 0;
  const startupStartedAt = Date.now();
  const closePreparation = () => {
    if (preparationWindow && !preparationWindow.isDestroyed()) preparationWindow.destroy();
  };
  service.stderr?.on('data', (buffer: Buffer) => {
    diagnostics = (diagnostics + buffer.toString()).slice(-8000);
    process.stderr.write(buffer);
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let timer = setTimeout(() => {
      settled = true;
      reject(Error('控制服务启动超时'));
    }, 15000);
    service.on('message', (message: unknown) => {
      if (settled) return;
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'STARTUP_PROGRESS' &&
        'completed' in message &&
        typeof message.completed === 'number' &&
        Number.isFinite(message.completed) &&
        message.completed >= 0 &&
        'total' in message &&
        typeof message.total === 'number' &&
        Number.isFinite(message.total) &&
        message.total >= message.completed
      ) {
        startupProgressMessages++;
        clearTimeout(timer);
        const remaining = 600000 - (Date.now() - started);
        timer = setTimeout(
          () => {
            settled = true;
            reject(Error('历史记录准备超时，请重新打开软件继续；原任务数据仍保留。'));
          },
          Math.max(1, Math.min(60000, remaining)),
        );
        if (!smokeFile && !preparationWindow) {
          preparationWindow = new BrowserWindow({
            width: 520,
            height: 230,
            resizable: false,
            title: '正在准备工作台',
            backgroundColor: '#22252a',
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
          });
          preparationWindow.setMenu(null);
          void preparationWindow.loadURL(
            'data:text/html;charset=utf-8,' +
              encodeURIComponent(
                '<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{background:#22252a;color:#eee;font:16px system-ui;padding:28px;line-height:1.8}p{color:#bbb;font-size:14px}</style><b>正在准备历史记录</b><p>历史较多时，首次启动需要一些时间。<br>完成后会自动打开工作台。</p></html>',
              ),
          );
        }
        if (preparationWindow && !preparationWindow.isDestroyed()) {
          preparationWindow.setProgressBar(message.total ? message.completed / message.total : 2);
          preparationWindow.setTitle(
            message.total
              ? `正在准备工作台 · ${message.completed}/${message.total}`
              : '正在准备工作台',
          );
        }
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'READY' &&
        'origin' in message &&
        typeof message.origin === 'string'
      ) {
        settled = true;
        clearTimeout(timer);
        resolve(message.origin);
      }
    });
    service.once('exit', (code) => {
      child = null;
      clearTimeout(timer);
      if (diagnostics.includes('DATABASE_VERSION_TOO_NEW')) {
        reject(
          Object.assign(
            Error('数据已被更新版本升级，请使用新版本打开；当前本地数据库保持完好未修改。'),
            { code: 'DATABASE_VERSION_TOO_NEW' },
          ),
        );
        return;
      }
      if (diagnostics.includes('EADDRINUSE') || diagnostics.includes('CONTROLLER_PORT')) {
        reject(
          Object.assign(
            Error(`浏览器工作台已在运行（端口被占用），请切换到已打开的窗口或先关闭旧版本。`),
            { code: 'CONTROLLER_PORT_IN_USE' },
          ),
        );
        return;
      }
      reject(Error('控制服务启动失败 (' + code + ')；端口可能被占用。' + diagnostics));
    });
  });
  service.on('exit', (code) => {
    child = null;
    if (!quitting && !shutdownStarted) {
      if (!smokeFile)
        dialog.showErrorBox('控制服务已停止', '执行通道已停止，请重新打开软件。错误码：' + code);
      app.quit();
    }
  });
  window = new BrowserWindow({
    icon: path.join(root, '../public/app-icon.png'),
    width: 1240,
    height: 840,
    minWidth: 840,
    minHeight: 600,
    title: '浏览器工作台',
    backgroundColor: '#e9eaec',
    show: !smokeFile,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(root, 'src/desktop/preload.cjs'),
    },
  });
  closePreparation();
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (
        target.protocol === 'https:' &&
        target.hostname === 'github.com' &&
        /^\/[^/]+\/[^/]+\/releases(?:\/|$)/.test(target.pathname)
      )
        void shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    windowMayClose = true;
    if (!smokeFile)
      dialog.showErrorBox(
        '界面已停止',
        '请重新打开软件。上次确认保存的草稿仍保留；原因：' + details.reason,
      );
    app.quit();
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  let closeRequest: string | null = null;
  let closeTimer: NodeJS.Timeout | null = null;
  let closeChoicePending = false;
  async function chooseAfterSaveFailure() {
    if (!window || closeChoicePending) return;
    closeChoicePending = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '编辑内容尚未保存',
        message: '尚未确认草稿保存。请选择重试、继续编辑，或放弃本次未保存修改后退出。',
        buttons: ['重试保存', '继续编辑', '放弃未保存修改并退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (!window || window.isDestroyed()) return;
      if (response === 2) windowMayClose = true;
      if (response === 0 || response === 2) window.close();
    } finally {
      closeChoicePending = false;
    }
  }
  window.on('close', (event) => {
    if (windowMayClose) return;
    event.preventDefault();
    if (closeRequest) return;
    closeRequest = randomUUID();
    window?.webContents.send('workbench:prepare-close', closeRequest);
    closeTimer = setTimeout(() => {
      closeRequest = null;
      void chooseAfterSaveFailure();
    }, 15000);
  });
  window.on('closed', () => {
    if (closeTimer) clearTimeout(closeTimer);
  });
  ipcMain.on('workbench:close-result', (event, value: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !value ||
      typeof value !== 'object' ||
      !('requestId' in value) ||
      value.requestId !== closeRequest ||
      !('ok' in value) ||
      typeof value.ok !== 'boolean'
    )
      return;
    if (closeTimer) clearTimeout(closeTimer);
    closeRequest = null;
    if (value.ok) {
      windowMayClose = true;
      window.close();
    } else void chooseAfterSaveFailure();
  });
  ipcMain.handle('workbench:choose-material-directory', async (event) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择素材目录',
      properties: ['openDirectory'],
    });
    return selected.canceled ? null : (selected.filePaths[0] ?? null);
  });
  ipcMain.handle('workbench:choose-backup-directory', async (event) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择数据备份保存位置',
      defaultPath: defaultBackupDirectory(),
      properties: ['openDirectory'],
    });
    return selected.canceled ? null : (selected.filePaths[0] ?? null);
  });
  ipcMain.handle('workbench:choose-restore-backup', async (event) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择数据备份中的 backup.json',
      defaultPath: defaultBackupDirectory(),
      properties: ['openFile'],
      filters: [{ name: '数据备份清单', extensions: ['json'] }],
    });
    return selected.canceled || !selected.filePaths[0] ? null : path.dirname(selected.filePaths[0]);
  });
  ipcMain.handle('workbench:restart', async (event) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    restartRequested = true;
    // Uses the normal draft-save handshake and original controller shutdown before relaunch.
    window.close();
  });
  ipcMain.handle('workbench:reveal-local-file', async (event, input: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    return revealLocalFile(input, (source) => shell.showItemInFolder(source));
  });
  await window.loadURL(origin + '/workbench/');
  if (smokeFile)
    await smoke(origin, dataDir, {
      progressMessages: startupProgressMessages,
      elapsedMs: Date.now() - startupStartedAt,
    });
}
async function smoke(
  origin: string,
  dataDir: string,
  startup: { progressMessages: number; elapsedMs: number },
) {
  if (!window) throw Error('WINDOW_MISSING');
  await window.webContents.executeJavaScript(
    "new Promise((resolve,reject)=>{const deadline=Date.now()+10000;function check(){if(document.querySelector('.sidebar')&&!document.querySelector('main.loading'))requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));else if(Date.now()>deadline)reject(Error('UI_NOT_READY'));else requestAnimationFrame(check)}check()})",
  );
  const screenshot = await window.webContents.capturePage();
  await writeFile(smokeFile + '.png', screenshot.toPNG());
  const htmlFacts: unknown = await window.webContents.executeJavaScript(
    "({title:document.title,sidebar:!!document.querySelector('.sidebar'),browserRunMonitor:!!document.querySelector('.browser-run-monitor'),notes:document.querySelector('.development-note')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth,nodeExposed:typeof window.require!=='undefined',desktopBridge:typeof window.workbenchDesktop?.onBeforeClose==='function'&&typeof window.workbenchDesktop?.chooseMaterialDirectory==='function'&&typeof window.workbenchDesktop?.materialFilePath==='function',constructedFileRejected:window.workbenchDesktop?.materialFilePath(new File(['generated'],'generated.mp4'))===''} )",
  );
  const landing = await fetch(origin);
  const cookie = landing.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw Error('BOOTSTRAP_COOKIE_MISSING');
  const state = await fetch(origin + '/api/workspace', {
    headers: { cookie, 'x-workbench-workspace-contract': '6' },
  });
  if (!state.ok) throw Error('WORKSPACE_HTTP_' + state.status + ':' + (await state.text()));
  const value: unknown = await state.json();
  const cleanupFacts = await cleanupDesktopSmoke(window, origin, cookie, dataDir, smokeFile ?? '');
  const layoutFacts = await windowLayoutSmoke(window, dataDir, smokeFile ?? '');
  if ('restarting' in cleanupFacts && cleanupFacts.restarting) return;
  // Exercise the real preload close handshake with an isolated durable write.
  // This harness does not substitute for testing the editor's autosave in the UI.
  await window.webContents.executeJavaScript(
    "window.workbenchDesktop.onBeforeClose(async()=>{const result=await fetch('/api/workspace/combinations/create-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:{name:'桌面关闭保存验收',note:'隔离测试',steps:[],randomOrder:false,loop:{mode:'finite',rounds:1}}})});return result.ok});true",
  );
  const closed = new Promise<void>((resolve) => window?.once('closed', () => resolve()));
  window.close();
  await closed;
  const afterClose = await fetch(origin + '/api/workspace', {
    headers: { cookie, 'x-workbench-workspace-contract': '6' },
  });
  const afterCloseValue: unknown = await afterClose.json();
  const closePersisted = !!(
    afterCloseValue &&
    typeof afterCloseValue === 'object' &&
    'combinations' in afterCloseValue &&
    Array.isArray(afterCloseValue.combinations) &&
    afterCloseValue.combinations.some(
      (row: unknown) =>
        row &&
        typeof row === 'object' &&
        'draft' in row &&
        row.draft &&
        typeof row.draft === 'object' &&
        'name' in row.draft &&
        row.draft.name === '桌面关闭保存验收',
    )
  );
  if (!afterClose.ok || !closePersisted) throw Error('CLOSE_DRAFT_NOT_PERSISTED');
  const database = new DatabaseSync(path.join(dataDir, 'workspace.sqlite'), { readOnly: true });
  let workspaceDatabaseVersion: unknown;
  try {
    workspaceDatabaseVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  } finally {
    database.close();
  }
  await writeFile(
    smokeFile ?? '',
    JSON.stringify(
      {
        ok: true,
        startup,
        runtime: process.versions,
        dataDir,
        origin,
        htmlFacts,
        workspace: value,
        closePersisted,
        ...cleanupFacts,
        ...(layoutFacts && typeof layoutFacts === 'object' ? layoutFacts : {}),
        workspaceDatabaseVersion,
      },
      null,
      2,
    ),
  );
  app.quit();
}
