import { cleanupDesktopSmoke } from './cleanup-smoke.js';
import { windowLayoutSmoke } from './window-layout-smoke.js';
import { applyPendingWorkspaceReset } from '../infrastructure/workspace-reset.js';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  Tray,
  utilityProcess,
  shell,
  safeStorage,
  session,
  Notification,
  screen,
} from 'electron';
import { pruneStaleRuntimeBackups } from '../infrastructure/software-update-backend.js';
import { DesktopTaskNotification } from '../shared/workspace-preferences.js';
import type { UtilityProcess } from 'electron';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  defaultBackupDirectory,
  productDataDirectory,
  productExtensionDirectory,
} from '../infrastructure/paths.js';
import { productAiWorkspaceDirectory } from '../infrastructure/ai-workspace.js';
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
let tray: Tray | null = null;
let currentOrigin = '';
let recentControllerCrashTimes: number[] = [];
let recoveringController = false;
let quitting = false;
let shutdownStarted = false;
let windowMayClose = false;
let forceQuitRequested = false;
let restartRequested = false;
const startedViaAutoLaunch = process.argv.includes('--wb-autostart');
let activePowerBlockerId: number | null = null;
let activePowerLockMode: 'none' | 'prevent-app-suspension' | 'prevent-display-sleep' = 'none';
let schedulerPowerLockMode = 'none';
let hostingStatus: {
  runningCount: number;
  autoMonitorCount: number;
  keepAwake?: boolean;
  summary: string;
} = {
  runningCount: 0,
  autoMonitorCount: 0,
  keepAwake: false,
  summary: '',
};
function syncEffectivePowerLock() {
  const needsKeepAwake =
    hostingStatus.runningCount > 0 ||
    (hostingStatus.keepAwake ?? hostingStatus.autoMonitorCount > 0);
  const desired: 'none' | 'prevent-app-suspension' | 'prevent-display-sleep' =
    schedulerPowerLockMode === 'prevent-display-sleep'
      ? 'prevent-display-sleep'
      : schedulerPowerLockMode === 'prevent-app-suspension' || needsKeepAwake
        ? 'prevent-app-suspension'
        : 'none';
  if (
    desired === activePowerLockMode &&
    (desired === 'none' ||
      (activePowerBlockerId !== null && powerSaveBlocker.isStarted(activePowerBlockerId)))
  ) {
    return;
  }
  if (activePowerBlockerId !== null && powerSaveBlocker.isStarted(activePowerBlockerId)) {
    powerSaveBlocker.stop(activePowerBlockerId);
  }
  activePowerBlockerId = null;
  activePowerLockMode = 'none';
  if (desired === 'prevent-display-sleep' || desired === 'prevent-app-suspension') {
    try {
      activePowerBlockerId = powerSaveBlocker.start(desired);
      activePowerLockMode = desired;
    } catch {
      activePowerBlockerId = null;
      activePowerLockMode = 'none';
    }
  }
}
function relaunchClean() {
  const args = process.argv.slice(1).filter((arg) => arg !== '--wb-autostart');
  app.relaunch({ args });
}
function applyPowerLockMode(mode: string) {
  schedulerPowerLockMode = mode;
  syncEffectivePowerLock();
}
function showMainWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function updateTrayMenu() {
  if (!tray) return;
  const statusLabel =
    hostingStatus.summary ||
    (hostingStatus.runningCount > 0 || hostingStatus.autoMonitorCount > 0
      ? `托管中（任务 ${hostingStatus.runningCount} · 监控 ${hostingStatus.autoMonitorCount}）`
      : `浏览器工作台 v${softwareVersion}（空闲）`);
  tray.setToolTip(`浏览器工作台 v${softwareVersion} — ${statusLabel}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      { label: '显示浏览器工作台', click: () => showMainWindow() },
      {
        label: '退出工作台',
        click: () => {
          forceQuitRequested = true;
          showMainWindow();
          window?.close();
        },
      },
    ]),
  );
}
function ensureTray() {
  if (tray || smokeFile) return;
  try {
    const iconPath = path.join(root, '../public/app-icon.png');
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.isEmpty() ? iconPath : img.resize({ width: 16, height: 16 }));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    updateTrayMenu();
  } catch {
    tray = null;
  }
}
function finishShutdown() {
  schedulerPowerLockMode = 'none';
  hostingStatus = { runningCount: 0, autoMonitorCount: 0, keepAwake: false, summary: '' };
  syncEffectivePowerLock();
  try {
    tray?.destroy();
  } catch {}
  tray = null;
  if (!quitting) {
    quitting = true;
    if (restartRequested) relaunchClean();
  }
  app.quit();
}
const smokeFile = process.env.WORKBENCH_SMOKE_OUT;
function isAutoLaunchSupported(): boolean {
  if (smokeFile) return false;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  return !/^electron(?:\.exe)?$/i.test(path.basename(process.execPath));
}
function readAutoLaunchState(): { supported: boolean; enabled: boolean } {
  if (!isAutoLaunchSupported()) return { supported: false, enabled: false };
  try {
    const settings = app.getLoginItemSettings({
      path: process.execPath,
      args: ['--wb-autostart'],
    });
    return { supported: true, enabled: Boolean(settings.openAtLogin) };
  } catch {
    return { supported: false, enabled: false };
  }
}
app.setName('Browser Workbench');
if (process.platform === 'win32') app.setAppUserModelId('浏览器工作台');
if (process.env.WORKBENCH_SMOKE_USER_DATA)
  app.setPath('userData', process.env.WORKBENCH_SMOKE_USER_DATA);

if (
  process.platform === 'win32' &&
  !smokeFile &&
  !process.env.WORKBENCH_SMOKE_USER_DATA &&
  process.env.WORKBENCH_ALLOW_MSIX_SANDBOX !== '1' &&
  process.env.WORKBENCH_MSIX_RELAUNCHED !== '1' &&
  !process.argv.includes('--wb-msix-relaunched')
) {
  try {
    const candidateDataDir = productDataDirectory();
    mkdirSync(candidateDataDir, { recursive: true });
    const resolvedReal = realpathSync.native(candidateDataDir);
    if (/\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\Roaming\\/i.test(resolvedReal)) {
      const escapedExe = process.execPath.replace(/'/g, "''");
      const psBreakaway =
        `$exe = '${escapedExe}'; ` +
        `$dir = Split-Path -Parent $exe; ` +
        `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $exe + '" --wb-msix-relaunched'); CurrentDirectory = $dir }; ` +
        `if ($res.ReturnValue -ne 0) { exit 1 }`;
      const launched = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psBreakaway],
        { stdio: 'ignore', windowsHide: true, timeout: 8000 },
      );
      if (launched.status === 0) {
        app.exit(0);
      }
    }
  } catch {
    // Proceed normally if realpath inspection or WMI breakaway is unavailable
  }
}

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
  if (!smokeFile) {
    void pruneStaleRuntimeBackups(app.getPath('userData')).catch(() => {});
  }
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
  const spawnController = async (showPrepWindow: boolean) => {
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
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'SET_POWER_LOCK' &&
        'mode' in message &&
        typeof message.mode === 'string'
      ) {
        applyPowerLockMode(message.mode);
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'SET_HOSTING_STATUS'
      ) {
        const m = message as {
          runningCount?: unknown;
          autoMonitorCount?: unknown;
          keepAwake?: unknown;
          summary?: unknown;
        };
        hostingStatus = {
          runningCount: typeof m.runningCount === 'number' ? m.runningCount : 0,
          autoMonitorCount: typeof m.autoMonitorCount === 'number' ? m.autoMonitorCount : 0,
          keepAwake: typeof m.keepAwake === 'boolean' ? m.keepAwake : undefined,
          summary: typeof m.summary === 'string' ? m.summary : '',
        };
        syncEffectivePowerLock();
        updateTrayMenu();
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'OPEN_AI_WORKSPACE_DIRECTORY'
      ) {
        const target =
          'directory' in message &&
          typeof message.directory === 'string' &&
          message.directory.trim()
            ? message.directory
            : productAiWorkspaceDirectory();
        void mkdir(target, { recursive: true }).finally(() => {
          void shell.openPath(target);
        });
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'REVEAL_DIAGNOSTIC_PACKAGE' &&
        'filePath' in message &&
        typeof message.filePath === 'string' &&
        message.filePath.trim()
      ) {
        shell.showItemInFolder(message.filePath);
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'CLIPBOARD_GET' &&
        'reqId' in message &&
        typeof message.reqId === 'string'
      ) {
        const reqId = message.reqId;
        void (async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const text = clipboard.readText();
              service.postMessage({ type: 'CLIPBOARD_RESULT', reqId, ok: true, text });
              return;
            } catch {
              if (attempt < 4) await new Promise((r) => setTimeout(r, 35));
            }
          }
          service.postMessage({ type: 'CLIPBOARD_RESULT', reqId, ok: false, text: '' });
        })();
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'CLIPBOARD_SET' &&
        'reqId' in message &&
        typeof message.reqId === 'string' &&
        'text' in message &&
        typeof message.text === 'string'
      ) {
        const reqId = message.reqId;
        const targetText = message.text;
        void (async () => {
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              clipboard.writeText(targetText);
              service.postMessage({ type: 'CLIPBOARD_RESULT', reqId, ok: true, text: targetText });
              return;
            } catch {
              if (attempt < 4) await new Promise((r) => setTimeout(r, 35));
            }
          }
          service.postMessage({ type: 'CLIPBOARD_RESULT', reqId, ok: false, text: '' });
        })();
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
          new Notification({ title: '浏览器工作台', body }).show();
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
    const closePreparation = () => {
      if (preparationWindow && !preparationWindow.isDestroyed()) preparationWindow.destroy();
    };
    service.stderr?.on('data', (buffer: Buffer) => {
      diagnostics = (diagnostics + buffer.toString()).slice(-8000);
      process.stderr.write(buffer);
    });
    const nextOrigin = await new Promise<string>((resolve, reject) => {
      const started = Date.now();
      let settled = false;
      let timer = setTimeout(() => {
        settled = true;
        closePreparation();
        try {
          service.kill();
        } catch {}
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
              closePreparation();
              try {
                service.kill();
              } catch {}
              reject(Error('历史记录准备超时，请重新打开软件继续；原任务数据仍保留。'));
            },
            Math.max(1, Math.min(60000, remaining)),
          );
          if (showPrepWindow && !smokeFile && !startedViaAutoLaunch && !preparationWindow) {
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
        if (child === service) child = null;
        clearTimeout(timer);
        if (settled) return;
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
    closePreparation();
    currentOrigin = nextOrigin;
    service.on('exit', (code) => {
      if (child === service) child = null;
      if (quitting || shutdownStarted) return;
      hostingStatus = { runningCount: 0, autoMonitorCount: 0, keepAwake: false, summary: '' };
      schedulerPowerLockMode = 'none';
      syncEffectivePowerLock();
      updateTrayMenu();
      if (smokeFile) {
        windowMayClose = true;
        forceQuitRequested = true;
        app.quit();
        return;
      }
      const now = Date.now();
      recentControllerCrashTimes = recentControllerCrashTimes.filter((t) => now - t < 5 * 60_000);
      if (recentControllerCrashTimes.length < 2 && !recoveringController) {
        recoveringController = true;
        recentControllerCrashTimes.push(now);
        if (Notification.isSupported()) {
          try {
            new Notification({
              title: '浏览器工作台',
              body: `控制服务意外退出（错误码 ${code}），正在自动恢复…`,
            }).show();
          } catch {}
        }
        setTimeout(() => {
          void spawnController(false)
            .then(async (recovered) => {
              try {
                if (window && !window.isDestroyed()) {
                  await window.loadURL(recovered.origin + '/workbench/');
                }
              } finally {
                recoveringController = false;
              }
            })
            .catch(() => {
              recoveringController = false;
              dialog.showErrorBox(
                '控制服务恢复失败',
                '自动重启控制服务失败，请重新打开软件。错误码：' + code,
              );
              windowMayClose = true;
              forceQuitRequested = true;
              app.quit();
            });
        }, 1500);
        return;
      }
      dialog.showErrorBox(
        '控制服务已停止',
        '执行通道多次异常停止，请重新打开软件。错误码：' + code,
      );
      windowMayClose = true;
      forceQuitRequested = true;
      app.quit();
    });
    return { origin: nextOrigin, startupProgressMessages };
  };
  const startupStartedAt = Date.now();
  const { origin, startupProgressMessages } = await spawnController(true);
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
  ensureTray();
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:') {
        void shell.openExternal(url);
      }
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
    if (new URL(target).origin !== currentOrigin) event.preventDefault();
  });
  window.webContents.on('will-prevent-unload', (event) => {
    if (windowMayClose || quitting || recoveringController) {
      event.preventDefault();
    }
  });
  const allowedClipboardPermissions = new Set(['clipboard-sanitized-write', 'clipboard-read']);
  window.webContents.session.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      requestingOrigin === origin && allowedClipboardPermissions.has(permission),
  );
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    let validOrigin = false;
    try {
      validOrigin =
        contents === window?.webContents && new URL(contents.getURL()).origin === origin;
    } catch {
      validOrigin = false;
    }
    callback(validOrigin && allowedClipboardPermissions.has(permission));
  });
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
      if (response === 0 || response === 2) {
        window.close();
      } else {
        restartRequested = false;
        forceQuitRequested = false;
      }
    } finally {
      closeChoicePending = false;
    }
  }
  let closeGuardOpen = false;
  function beginDraftSaveAndClose() {
    if (closeRequest) return;
    closeRequest = randomUUID();
    window?.webContents.send('workbench:prepare-close', closeRequest);
    closeTimer = setTimeout(() => {
      closeRequest = null;
      void chooseAfterSaveFailure();
    }, 15000);
  }
  window.on('close', (event) => {
    if (windowMayClose) return;
    event.preventDefault();
    if (
      !smokeFile &&
      !forceQuitRequested &&
      (hostingStatus.runningCount > 0 || hostingStatus.autoMonitorCount > 0)
    ) {
      if (closeGuardOpen || !window || window.isDestroyed()) return;
      closeGuardOpen = true;
      const statusDetail =
        hostingStatus.summary ||
        `当前有 ${hostingStatus.runningCount} 项任务运行中、${hostingStatus.autoMonitorCount} 项自动托管已开启`;
      void dialog
        .showMessageBox(window, {
          type: 'question',
          title: '后台任务或自动托管正在运行',
          message: '关闭窗口会停止正在执行的任务与定时托管',
          detail: `${statusDetail}。\n建议「最小化到托盘继续运行」，右下角托盘图标随时可点回主界面。`,
          buttons: ['最小化到托盘继续运行', '取消', '强制退出工作台'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        .then(({ response }) => {
          closeGuardOpen = false;
          if (!window || window.isDestroyed()) return;
          if (response === 0) {
            restartRequested = false;
            forceQuitRequested = false;
            ensureTray();
            window.hide();
          } else if (response === 2) {
            forceQuitRequested = true;
            beginDraftSaveAndClose();
          } else {
            restartRequested = false;
            forceQuitRequested = false;
          }
        })
        .catch(() => {
          closeGuardOpen = false;
          restartRequested = false;
          forceQuitRequested = false;
        });
      return;
    }
    beginDraftSaveAndClose();
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
  ipcMain.handle('workbench:choose-feedback-directory', async (event) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择问题反馈包保存目录',
      properties: ['openDirectory'],
    });
    return selected.canceled ? null : (selected.filePaths[0] ?? null);
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
  ipcMain.handle('workbench:get-auto-launch', (event) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    return readAutoLaunchState();
  });
  ipcMain.handle('workbench:set-auto-launch', (event, input: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('IPC_SENDER_REJECTED');
    const enabled = Boolean(
      input &&
      typeof input === 'object' &&
      'enabled' in input &&
      (input as { enabled: unknown }).enabled,
    );
    if (!isAutoLaunchSupported()) {
      return { supported: false, enabled: false };
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: ['--wb-autostart'],
      });
    } catch {
      return readAutoLaunchState();
    }
    return readAutoLaunchState();
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
    "({title:document.title,sidebar:!!document.querySelector('.sidebar'),notes:document.querySelector('.development-note')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth,nodeExposed:typeof window.require!=='undefined',desktopBridge:typeof window.workbenchDesktop?.onBeforeClose==='function'&&typeof window.workbenchDesktop?.chooseMaterialDirectory==='function'&&typeof window.workbenchDesktop?.materialFilePath==='function',constructedFileRejected:window.workbenchDesktop?.materialFilePath(new File(['generated'],'generated.mp4'))===''} )",
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
