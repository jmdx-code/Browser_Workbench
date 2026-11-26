import { app, BrowserWindow, Menu, nativeImage, powerSaveBlocker, Tray } from 'electron';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { productDataDirectory } from '../infrastructure/paths.js';
type HostingStatus = {
  runningCount: number;
  autoMonitorCount: number;
  keepAwake?: boolean;
  summary: string;
};
const EMPTY_HOSTING: HostingStatus = {
  runningCount: 0,
  autoMonitorCount: 0,
  keepAwake: false,
  summary: '',
};
export function resolveSoftwareVersion(root: string): string {
  try {
    return (
      (JSON.parse(readFileSync(path.join(root, '../package.json'), 'utf8')) as { version?: string })
        .version ?? app.getVersion()
    );
  } catch {
    return app.getVersion();
  }
}
export const relaunchClean = () =>
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--wb-autostart') });
export function showMainWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
const autoLaunchSupported = (smokeFile: string | undefined) =>
  !smokeFile &&
  (process.platform === 'win32' || process.platform === 'darwin') &&
  !/^electron(?:\.exe)?$/i.test(path.basename(process.execPath));
export function readAutoLaunchState(smokeFile: string | undefined) {
  if (!autoLaunchSupported(smokeFile)) return { supported: false, enabled: false };
  try {
    const { openAtLogin } = app.getLoginItemSettings({
      path: process.execPath,
      args: ['--wb-autostart'],
    });
    return { supported: true, enabled: Boolean(openAtLogin) };
  } catch {
    return { supported: false, enabled: false };
  }
}
export function setAutoLaunchEnabled(smokeFile: string | undefined, enabled: boolean) {
  if (autoLaunchSupported(smokeFile)) {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: ['--wb-autostart'],
      });
    } catch {}
  }
  return readAutoLaunchState(smokeFile);
}
export function breakawayFromMsixSandboxIfNeeded(smokeFile: string | undefined): void {
  if (
    process.platform !== 'win32' ||
    smokeFile ||
    process.env.WORKBENCH_SMOKE_USER_DATA ||
    process.env.WORKBENCH_ALLOW_MSIX_SANDBOX === '1' ||
    process.env.WORKBENCH_MSIX_RELAUNCHED === '1' ||
    process.argv.includes('--wb-msix-relaunched')
  )
    return;
  try {
    const dir = productDataDirectory();
    mkdirSync(dir, { recursive: true });
    if (
      !/\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\Roaming\\/i.test(realpathSync.native(dir))
    )
      return;
    const ps =
      `$exe = '${process.execPath.replace(/'/g, "''")}'; $dir = Split-Path -Parent $exe; ` +
      `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $exe + '" --wb-msix-relaunched'); CurrentDirectory = $dir }; ` +
      `if ($res.ReturnValue -ne 0) { exit 1 }`;
    const launched = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 8000,
      },
    );
    if (launched.status === 0) app.exit(0);
  } catch {}
}
export class DesktopTrayAndPower {
  private tray: Tray | null = null;
  private activePowerBlockerId: number | null = null;
  private activePowerLockMode: 'none' | 'prevent-app-suspension' | 'prevent-display-sleep' = 'none';
  private schedulerPowerLockMode = 'none';
  private hostingStatus: HostingStatus = { ...EMPTY_HOSTING };
  constructor(
    private readonly root: string,
    private readonly softwareVersion: string,
    private readonly smokeFile: string | undefined,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onForceQuitFromTray: () => void,
  ) {}
  getHostingStatus = (): HostingStatus => this.hostingStatus;
  syncEffectivePowerLock(): void {
    const keepAwake =
        this.hostingStatus.runningCount > 0 ||
        (this.hostingStatus.keepAwake ?? this.hostingStatus.autoMonitorCount > 0),
      desired: 'none' | 'prevent-app-suspension' | 'prevent-display-sleep' =
        this.schedulerPowerLockMode === 'prevent-display-sleep'
          ? 'prevent-display-sleep'
          : this.schedulerPowerLockMode === 'prevent-app-suspension' || keepAwake
            ? 'prevent-app-suspension'
            : 'none',
      active =
        this.activePowerBlockerId !== null && powerSaveBlocker.isStarted(this.activePowerBlockerId);
    if (desired === this.activePowerLockMode && (desired === 'none' || active)) return;
    if (active && this.activePowerBlockerId !== null)
      powerSaveBlocker.stop(this.activePowerBlockerId);
    this.activePowerBlockerId = null;
    this.activePowerLockMode = 'none';
    if (desired === 'none') return;
    try {
      this.activePowerBlockerId = powerSaveBlocker.start(desired);
      this.activePowerLockMode = desired;
    } catch {
      this.activePowerBlockerId = null;
    }
  }
  applyPowerLockMode(mode: string): void {
    this.schedulerPowerLockMode = mode;
    this.syncEffectivePowerLock();
  }
  private syncAndRefresh(): void {
    this.syncEffectivePowerLock();
    this.updateTrayMenu();
  }
  setHostingStatus(status: HostingStatus): void {
    this.hostingStatus = status;
    this.syncAndRefresh();
  }
  resetOnControllerExit(): void {
    this.hostingStatus = { ...EMPTY_HOSTING };
    this.schedulerPowerLockMode = 'none';
    this.syncAndRefresh();
  }
  updateTrayMenu(): void {
    if (!this.tray) return;
    const statusLabel =
      this.hostingStatus.summary ||
      (this.hostingStatus.runningCount > 0 || this.hostingStatus.autoMonitorCount > 0
        ? `托管中（任务 ${this.hostingStatus.runningCount} · 监控 ${this.hostingStatus.autoMonitorCount}）`
        : `浏览器工作台 v${this.softwareVersion}（空闲）`);
    this.tray.setToolTip(`浏览器工作台 v${this.softwareVersion} — ${statusLabel}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: statusLabel, enabled: false },
        { type: 'separator' },
        { label: '显示浏览器工作台', click: () => showMainWindow(this.getWindow()) },
        {
          label: '退出工作台',
          click: () => {
            this.onForceQuitFromTray();
            const win = this.getWindow();
            showMainWindow(win);
            win?.close();
          },
        },
      ]),
    );
  }
  ensureTray(): void {
    if (this.tray || this.smokeFile) return;
    try {
      const iconPath = path.join(this.root, '../public/app-icon.png'),
        img = nativeImage.createFromPath(iconPath);
      this.tray = new Tray(img.isEmpty() ? iconPath : img.resize({ width: 16, height: 16 }));
      this.tray.on('click', () => showMainWindow(this.getWindow()));
      this.tray.on('double-click', () => showMainWindow(this.getWindow()));
      this.updateTrayMenu();
    } catch {
      this.tray = null;
    }
  }
  shutdown(): void {
    this.resetOnControllerExit();
    try {
      this.tray?.destroy();
    } catch {}
    this.tray = null;
  }
}
