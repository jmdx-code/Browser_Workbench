import { applyPendingWorkspaceReset } from '../infrastructure/workspace-reset.js';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { pruneStaleRuntimeBackups } from '../infrastructure/software-update-backend.js';
import { revealLocalFile } from '../infrastructure/local-file-location.js';
import { productAiWorkspaceDirectory } from '../infrastructure/ai-workspace.js';
import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultBackupDirectory,
  productDataDirectory,
  productExtensionDirectory,
} from '../infrastructure/paths.js';
import { DesktopTaskNotification } from '../shared/workspace-preferences.js';
import { DatabaseSync } from 'node:sqlite';
import {
  breakawayFromMsixSandboxIfNeeded,
  DesktopTrayAndPower,
  readAutoLaunchState,
  relaunchClean,
  resolveSoftwareVersion,
  setAutoLaunchEnabled,
  showMainWindow,
} from './tray-power.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const softwareVersion = resolveSoftwareVersion(root);
const smokeFile = process.env.WORKBENCH_SMOKE_OUT;
const startedViaAutoLaunch = process.argv.includes('--wb-autostart');
let child: UtilityProcess | null = null,
  window: BrowserWindow | null = null,
  currentOrigin = '',
  recentControllerCrashTimes: number[] = [],
  recoveringController = false,
  quitting = false,
  shutdownStarted = false,
  windowMayClose = false,
  forceQuitRequested = false,
  restartRequested = false;
const trayAndPower = new DesktopTrayAndPower(
  root,
  softwareVersion,
  smokeFile,
  () => window,
  () => {
    forceQuitRequested = true;
  },
);
const writeSmoke = (payload: unknown) =>
  smokeFile ? writeFile(smokeFile, JSON.stringify(payload, null, 2)) : Promise.resolve();
function finishShutdown() {
  trayAndPower.shutdown();
  if (!quitting) {
    quitting = true;
    if (restartRequested) relaunchClean();
  }
  app.quit();
}
app.setName('Browser Workbench');
if (process.platform === 'win32') app.setAppUserModelId('浏览器工作台');
if (process.env.WORKBENCH_SMOKE_USER_DATA)
  app.setPath('userData', process.env.WORKBENCH_SMOKE_USER_DATA);
breakawayFromMsixSandboxIfNeeded(smokeFile);
if (!app.requestSingleInstanceLock({ version: softwareVersion })) {
  const reason = `浏览器工作台 v${softwareVersion} 已在运行，已切换到运行中的窗口。`;
  if (smokeFile)
    void writeSmoke({
      ok: false,
      code: 'SECOND_INSTANCE_RUNNING',
      version: softwareVersion,
      reason,
    })
      .catch(() => {})
      .finally(() => app.quit());
  else app.quit();
} else {
  app.on('second-instance', (_event, _argv, _cwd, extra) => {
    showMainWindow(window);
    const inc =
      extra && typeof extra === 'object' && 'version' in extra && typeof extra.version === 'string'
        ? extra.version
        : null;
    if (!smokeFile && window && !window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'info',
        title: '浏览器工作台已在运行',
        message: `浏览器工作台 v${softwareVersion} 已在运行`,
        detail:
          inc && inc !== softwareVersion
            ? `检测到尝试启动 v${inc}；请先关闭当前运行中的 v${softwareVersion} 再切换版本。`
            : '已为您激活当前正在运行的窗口。',
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
      if (restartRequested) {
        quitting = true;
        relaunchClean();
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
    }, 15000);
    child.once('exit', () => {
      clearTimeout(fallback);
      finishShutdown();
    });
  });
  app.on('window-all-closed', () => {
    if (!smokeFile && window) app.quit();
  });
  void app
    .whenReady()
    .then(boot)
    .catch(async (error: unknown) => {
      const reason = error instanceof Error ? error.message : '启动失败',
        code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'STARTUP_FAILED';
      if (smokeFile) await writeSmoke({ ok: false, code, reason });
      else dialog.showErrorBox('浏览器工作台启动失败', reason);
      app.quit();
    });
}
async function withClipboardRetry<T>(
  fn: () => T | Promise<T>,
): Promise<{ ok: true; text: T } | { ok: false; text: string }> {
  for (let i = 0; i < 5; i++) {
    try {
      return { ok: true, text: await fn() };
    } catch {
      if (i < 4) await new Promise((r) => setTimeout(r, 35));
    }
  }
  return { ok: false, text: '' };
}
const objOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && 'type' in v ? (v as Record<string, unknown>) : null;
const notify = (body: string) => {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title: '浏览器工作台', body }).show();
  } catch {}
};
const PREP_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{background:#22252a;color:#eee;font:16px system-ui;padding:28px;line-height:1.8}p{color:#bbb;font-size:14px}</style><b>正在准备历史记录</b><p>历史较多时，首次启动需要一些时间。<br>完成后会自动打开工作台。</p></html>',
  );
function handleControllerMessage(service: UtilityProcess, message: unknown): void {
  const m = objOf(message);
  if (m) {
    const replyClip = (reqId: string, fn: () => string | Promise<string>) =>
      void withClipboardRetry(fn).then((r) =>
        service.postMessage({ type: 'CLIPBOARD_RESULT', reqId, ...r }),
      );
    const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : ''),
      num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : 0),
      handlers: Record<string, () => void> = {
        OPEN_EXTENSION_DIRECTORY: () => void shell.openPath(productExtensionDirectory()),
        SET_HOSTING_STATUS: () =>
          trayAndPower.setHostingStatus({
            runningCount: num('runningCount'),
            autoMonitorCount: num('autoMonitorCount'),
            keepAwake: typeof m.keepAwake === 'boolean' ? m.keepAwake : undefined,
            powerLockMode:
              m.powerLockMode === 'prevent-display-sleep' ||
              m.powerLockMode === 'prevent-app-suspension' ||
              m.powerLockMode === 'none'
                ? m.powerLockMode
                : undefined,
            summary: str('summary'),
          }),
        OPEN_AI_WORKSPACE_DIRECTORY: () => {
          const target = str('directory').trim() || productAiWorkspaceDirectory();
          void mkdir(target, { recursive: true }).finally(() => void shell.openPath(target));
        },
        REVEAL_DIAGNOSTIC_PACKAGE: () =>
          void (str('filePath').trim() && shell.showItemInFolder(str('filePath'))),
        CLIPBOARD_GET: () =>
          void (typeof m.reqId === 'string' && replyClip(m.reqId, () => clipboard.readText())),
        CLIPBOARD_SET: () => {
          if (typeof m.reqId === 'string' && typeof m.text === 'string') {
            const text = m.text;
            replyClip(m.reqId, () => (clipboard.writeText(text), text));
          }
        },
        REQUEST_RESET: () => {
          windowMayClose = restartRequested = true;
          app.quit();
        },
        REQUEST_RESTART: () => {
          restartRequested = true;
          if (window && !window.isDestroyed()) window.close();
          else app.quit();
        },
      };
    const h = typeof m.type === 'string' ? handlers[m.type] : undefined;
    if (h) return h();
  }
  const notice = DesktopTaskNotification.safeParse(message);
  if (notice.success && !smokeFile) {
    const { failed, completed } = notice.data;
    notify(
      [failed ? `${failed} 份任务失败` : '', completed ? `${completed} 份任务完成` : '']
        .filter(Boolean)
        .join('，'),
    );
  }
}
async function spawnControllerProcess(
  showPrepWindow: boolean,
  dataDir: string,
  avatarToken: string | undefined,
): Promise<{ origin: string; startupProgressMessages: number }> {
  const fatalExit = () => {
    windowMayClose = true;
    forceQuitRequested = true;
    app.quit();
  };
  const layoutScreens = () =>
    screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      primary: d.id === screen.getPrimaryDisplay().id,
      scaleFactor: d.scaleFactor,
      workArea: d.workArea,
    }));
  const service = utilityProcess.fork(
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
        WORKBENCH_DESKTOP_EXE: process.execPath,
        WORKBENCH_DISPLAYS: JSON.stringify(layoutScreens()),
        ...(avatarToken ? { WORKBENCH_GRAPH_AVATAR_TOKEN: avatarToken } : {}),
      },
      stdio: 'pipe',
      serviceName: 'Browser Workbench Controller',
    },
  );
  child = service;
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
  service.on('message', (message: unknown) => handleControllerMessage(service, message));
  service.stdout?.on('data', (b: Buffer) => process.stdout.write(b));
  let diagnostics = '',
    prepWin: BrowserWindow | null = null,
    startupProgressMessages = 0;
  const closePrep = () => {
    if (prepWin && !prepWin.isDestroyed()) prepWin.destroy();
  };
  service.stderr?.on('data', (b: Buffer) => {
    diagnostics = (diagnostics + b.toString()).slice(-8000);
    process.stderr.write(b);
  });
  const nextOrigin = await new Promise<string>((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const armTimeout = (ms: number, msg: string) =>
      setTimeout(() => {
        settled = true;
        closePrep();
        try {
          service.kill();
        } catch {}
        reject(Error(msg));
      }, ms);
    let timer = armTimeout(15000, '控制服务启动超时');
    service.on('message', (message: unknown) => {
      if (settled) return;
      const msg = objOf(message);
      if (
        msg?.type === 'STARTUP_PROGRESS' &&
        typeof msg.completed === 'number' &&
        Number.isFinite(msg.completed) &&
        msg.completed >= 0 &&
        typeof msg.total === 'number' &&
        Number.isFinite(msg.total) &&
        msg.total >= msg.completed
      ) {
        startupProgressMessages++;
        clearTimeout(timer);
        timer = armTimeout(
          Math.max(1, Math.min(60000, 600000 - (Date.now() - started))),
          '历史记录准备超时，请重新打开软件继续；原任务数据仍保留。',
        );
        if (showPrepWindow && !smokeFile && !startedViaAutoLaunch && !prepWin) {
          prepWin = new BrowserWindow({
            width: 520,
            height: 230,
            resizable: false,
            title: '正在准备工作台',
            backgroundColor: '#22252a',
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
          });
          prepWin.setMenu(null);
          void prepWin.loadURL(PREP_HTML);
        }
        if (prepWin && !prepWin.isDestroyed()) {
          prepWin.setProgressBar(msg.total ? msg.completed / msg.total : 2);
          prepWin.setTitle(
            msg.total ? `正在准备工作台 · ${msg.completed}/${msg.total}` : '正在准备工作台',
          );
        }
        return;
      }
      if (msg?.type === 'READY' && typeof msg.origin === 'string') {
        settled = true;
        clearTimeout(timer);
        resolve(msg.origin);
      }
    });
    service.once('exit', (code) => {
      if (child === service) child = null;
      clearTimeout(timer);
      if (settled) return;
      const failWith = (k: string, msg: string) => reject(Object.assign(Error(msg), { code: k }));
      if (diagnostics.includes('DATABASE_VERSION_TOO_NEW'))
        return failWith(
          'DATABASE_VERSION_TOO_NEW',
          '数据已被更新版本升级，请使用新版本打开；当前本地数据库保持完好未修改。',
        );
      if (diagnostics.includes('EADDRINUSE') || diagnostics.includes('CONTROLLER_PORT'))
        return failWith(
          'CONTROLLER_PORT_IN_USE',
          '浏览器工作台已在运行（端口被占用），请切换到已打开的窗口或先关闭旧版本。',
        );
      reject(Error(`控制服务启动失败 (${code})；端口可能被占用。${diagnostics}`));
    });
  });
  closePrep();
  currentOrigin = nextOrigin;
  service.on('exit', (code) => {
    if (child === service) child = null;
    if (quitting || shutdownStarted) return;
    trayAndPower.resetOnControllerExit();
    if (smokeFile) return fatalExit();
    const now = Date.now(),
      recent = recentControllerCrashTimes.filter((t) => now - t < 5 * 60_000);
    recentControllerCrashTimes = recent;
    if (recent.length < 2 && !recoveringController) {
      recoveringController = true;
      recent.push(now);
      notify(`控制服务意外退出（错误码 ${code}），正在自动恢复…`);
      setTimeout(() => {
        void spawnControllerProcess(false, dataDir, avatarToken)
          .then(async (r) => {
            if (window && !window.isDestroyed()) await window.loadURL(r.origin + '/workbench/');
          })
          .catch(() => {
            dialog.showErrorBox(
              '控制服务恢复失败',
              '自动重启控制服务失败，请重新打开软件。错误码：' + code,
            );
            fatalExit();
          })
          .finally(() => {
            recoveringController = false;
          });
      }, 1500);
      return;
    }
    dialog.showErrorBox('控制服务已停止', '执行通道多次异常停止，请重新打开软件。错误码：' + code);
    fatalExit();
  });
  return { origin: nextOrigin, startupProgressMessages };
}
async function boot() {
  const dataDir = process.env.WORKBENCH_DATA_DIR ?? productDataDirectory();
  if (await applyPendingWorkspaceReset(dataDir)) {
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    await rm(path.join(app.getPath('userData'), 'graph-avatar.credential'), { force: true });
  }
  await mkdir(dataDir, { recursive: true });
  if (!smokeFile) void pruneStaleRuntimeBackups(app.getPath('userData')).catch(() => {});
  let avatarToken = process.env.WORKBENCH_GRAPH_AVATAR_TOKEN;
  if (!avatarToken && safeStorage.isEncryptionAvailable()) {
    try {
      avatarToken = safeStorage.decryptString(
        await readFile(path.join(app.getPath('userData'), 'graph-avatar.credential')),
      );
    } catch {}
  }
  const startupStartedAt = Date.now(),
    { origin, startupProgressMessages } = await spawnControllerProcess(true, dataDir, avatarToken);
  window = new BrowserWindow({
    icon: path.join(root, '../public/app-icon.png'),
    width: 1240,
    height: 840,
    minWidth: 840,
    minHeight: 600,
    title: '浏览器工作台',
    backgroundColor: '#e9eaec',
    show: !smokeFile && !startedViaAutoLaunch,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(root, 'src/desktop/preload.cjs'),
    },
  });
  window.setMenu(null);
  trayAndPower.ensureTray();
  attachMainWindowHandlers(window, origin);
  await window.loadURL(origin + '/workbench/');
  if (smokeFile)
    await smoke(origin, dataDir, {
      progressMessages: startupProgressMessages,
      elapsedMs: Date.now() - startupStartedAt,
    });
}
function attachMainWindowHandlers(win: BrowserWindow, origin: string) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    windowMayClose = true;
    if (!smokeFile)
      dialog.showErrorBox(
        '界面已停止',
        '请重新打开软件。已保存的配置数据仍保留；原因：' + d.reason,
      );
    app.quit();
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== currentOrigin) e.preventDefault();
  });
  win.webContents.on('will-prevent-unload', (e) => {
    if (windowMayClose || quitting || recoveringController) e.preventDefault();
  });
  const allowedClipboard = new Set(['clipboard-sanitized-write', 'clipboard-read']);
  win.webContents.session.setPermissionCheckHandler(
    (_c, p, reqOrigin) => reqOrigin === origin && allowedClipboard.has(p),
  );
  win.webContents.session.setPermissionRequestHandler((c, p, cb) => {
    let ok = false;
    try {
      ok = c === win.webContents && new URL(c.getURL()).origin === origin;
    } catch {}
    cb(ok && allowedClipboard.has(p));
  });
  let closeRequest: string | null = null,
    closeTimer: NodeJS.Timeout | null = null,
    closeChoicePending = false,
    closeGuardOpen = false;
  const showBox = (opts: Electron.MessageBoxOptions) => dialog.showMessageBox(win, opts),
    resetCloseFlags = () => {
      restartRequested = forceQuitRequested = false;
    },
    runGuardedDialog = async (
      isOpen: () => boolean,
      setOpen: (v: boolean) => void,
      opts: Electron.MessageBoxOptions,
      onResponse: (response: number) => void,
    ) => {
      if (win.isDestroyed() || isOpen()) return;
      setOpen(true);
      try {
        const { response } = await showBox(opts);
        if (!win.isDestroyed()) onResponse(response);
      } finally {
        setOpen(false);
      }
    };
  async function chooseAfterSaveFailure() {
    await runGuardedDialog(
      () => closeChoicePending,
      (v) => (closeChoicePending = v),
      {
        type: 'warning',
        title: '编辑内容尚未保存',
        message: '尚未确认资源表保存。请选择重试、继续编辑，或放弃本次未保存修改后退出。',
        buttons: ['重试保存', '继续编辑', '放弃未保存修改并退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      },
      (response) => {
        if (response === 2) windowMayClose = true;
        if (response === 0 || response === 2) win.close();
        else resetCloseFlags();
      },
    );
  }
  function beginDraftSaveAndClose() {
    if (closeRequest) return;
    closeRequest = randomUUID();
    win.webContents.send('workbench:prepare-close', closeRequest);
    closeTimer = setTimeout(() => {
      closeRequest = null;
      void chooseAfterSaveFailure();
    }, 15000);
  }
  win.on('close', (event) => {
    if (windowMayClose) return;
    event.preventDefault();
    const hs = trayAndPower.getHostingStatus();
    if (
      !smokeFile &&
      !forceQuitRequested &&
      !restartRequested &&
      (hs.runningCount > 0 || hs.autoMonitorCount > 0)
    ) {
      const detail =
        (hs.summary ||
          `当前有 ${hs.runningCount} 项任务运行中、${hs.autoMonitorCount} 项自动托管已开启`) +
        '。\n建议「最小化到托盘继续运行」，右下角托盘图标随时可点回主界面。';
      void runGuardedDialog(
        () => closeGuardOpen,
        (v) => (closeGuardOpen = v),
        {
          type: 'question',
          title: '后台任务或自动托管正在运行',
          message: '关闭窗口会停止正在执行的任务与定时托管',
          detail,
          buttons: ['最小化到托盘继续运行', '取消', '强制退出工作台'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        },
        (response) => {
          if (response === 0) {
            resetCloseFlags();
            trayAndPower.ensureTray();
            win.hide();
          } else if (response === 2) {
            forceQuitRequested = true;
            beginDraftSaveAndClose();
          } else resetCloseFlags();
        },
      ).catch(() => resetCloseFlags());
      return;
    }
    beginDraftSaveAndClose();
  });
  win.on('closed', () => {
    if (closeTimer) clearTimeout(closeTimer);
  });
  const isMainFrame = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      !win.isDestroyed() &&
      e.sender === win.webContents &&
      e.senderFrame === win.webContents.mainFrame,
    openDialogPath = async (opts: Electron.OpenDialogOptions, useDir = false) => {
      const sel = await dialog.showOpenDialog(win, opts),
        p = sel.filePaths[0];
      return sel.canceled || !p ? null : useDir ? path.dirname(p) : p;
    };
  ipcMain.on('workbench:close-result', (event, value: unknown) => {
    if (
      !isMainFrame(event) ||
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
      win.close();
    } else void chooseAfterSaveFailure();
  });
  const ipcHandlers: Record<string, (input: unknown) => unknown> = {
    'workbench:choose-backup-directory': () =>
      openDialogPath({
        title: '选择数据备份保存位置',
        defaultPath: defaultBackupDirectory(),
        properties: ['openDirectory'],
      }),
    'workbench:choose-restore-backup': () =>
      openDialogPath(
        {
          title: '选择数据备份中的 backup.json',
          defaultPath: defaultBackupDirectory(),
          properties: ['openFile'],
          filters: [{ name: '数据备份清单', extensions: ['json'] }],
        },
        true,
      ),
    'workbench:choose-feedback-directory': () =>
      openDialogPath({ title: '选择问题反馈包保存目录', properties: ['openDirectory'] }),
    'workbench:restart': () => {
      restartRequested = true;
      win.close();
    },
    'workbench:reveal-local-file': (input) =>
      revealLocalFile(input, (source) => shell.showItemInFolder(source)),
    'workbench:get-auto-launch': () => readAutoLaunchState(smokeFile),
    'workbench:set-auto-launch': (input) =>
      setAutoLaunchEnabled(
        smokeFile,
        Boolean(
          input &&
          typeof input === 'object' &&
          'enabled' in input &&
          (input as { enabled: unknown }).enabled,
        ),
      ),
  };
  for (const [channel, fn] of Object.entries(ipcHandlers))
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!isMainFrame(event)) throw Error('IPC_SENDER_REJECTED');
      return fn(input);
    });
}
async function smoke(
  origin: string,
  dataDir: string,
  startup: { progressMessages: number; elapsedMs: number },
) {
  const win = window;
  if (!win) throw Error('WINDOW_MISSING');
  const evalJs = (code: string) => win.webContents.executeJavaScript(code);
  await evalJs(
    "new Promise((resolve,reject)=>{const deadline=Date.now()+10000;function check(){if(document.querySelector('.sidebar')&&!document.querySelector('main.loading'))requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));else if(Date.now()>deadline)reject(Error('UI_NOT_READY'));else requestAnimationFrame(check)}check()})",
  );
  await writeFile(smokeFile + '.png', (await win.webContents.capturePage()).toPNG());
  const htmlFacts: unknown = await evalJs(
      "({title:document.title,sidebar:!!document.querySelector('.sidebar'),notes:document.querySelector('.development-note')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth,nodeExposed:typeof window.require!=='undefined',desktopBridge:typeof window.workbenchDesktop?.onBeforeClose==='function'&&typeof window.workbenchDesktop?.materialFilePath==='function',constructedFileRejected:window.workbenchDesktop?.materialFilePath(new File(['generated'],'generated.mp4'))===''} )",
    ),
    cookie = (await fetch(origin)).headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw Error('BOOTSTRAP_COOKIE_MISSING');
  const fetchWs = () =>
      fetch(origin + '/api/workspace', {
        headers: { cookie, 'x-workbench-workspace-contract': '6' },
      }),
    state = await fetchWs();
  if (!state.ok) throw Error(`WORKSPACE_HTTP_${state.status}:${await state.text()}`);
  const value: unknown = await state.json();
  await evalJs(
    "window.workbenchDesktop.onBeforeClose(async()=>{const result=await fetch('/api/workspace/combinations/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:{name:'桌面关闭保存验收',note:'隔离测试',steps:[{id:'10000000-0000-4000-8000-000000000001',type:'feed',durationMinutes:1,maxLikes:0,minLikeCount:0}],randomOrder:false,loop:{mode:'finite',rounds:1}}})});return result.ok});true",
  );
  const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
  win.close();
  await closed;
  const afterClose = await fetchWs(),
    combos = (
      (await afterClose.json()) as { combinations?: Array<{ saved?: { name?: string } }> } | null
    )?.combinations,
    closePersisted =
      Array.isArray(combos) && combos.some((r) => r?.saved?.name === '桌面关闭保存验收');
  if (!afterClose.ok || !closePersisted) throw Error('CLOSE_WRITE_NOT_PERSISTED');
  const db = new DatabaseSync(path.join(dataDir, 'workspace.sqlite'), { readOnly: true });
  let workspaceDatabaseVersion: unknown;
  try {
    workspaceDatabaseVersion = db.prepare('PRAGMA user_version').get()?.user_version;
  } finally {
    db.close();
  }
  await writeSmoke({
    ok: true,
    startup,
    runtime: process.versions,
    dataDir,
    origin,
    htmlFacts,
    workspace: value,
    closePersisted,
    workspaceDatabaseVersion,
  });
  app.quit();
}
