import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBridge } from '../shared/desktop.js';
let closeCallback: (() => Promise<boolean>) | null = null;
ipcRenderer.on(
  'workbench:prepare-close',
  (_event: Electron.IpcRendererEvent, requestId: string) => {
    const cb = closeCallback;
    if (!cb) {
      ipcRenderer.send('workbench:close-result', { requestId, ok: true });
      return;
    }
    void cb().then(
      (ok) => ipcRenderer.send('workbench:close-result', { requestId, ok }),
      () => ipcRenderer.send('workbench:close-result', { requestId, ok: false }),
    );
  },
);
const bridge: DesktopBridge = {
  materialFilePath: (file) => webUtils.getPathForFile(file),
  revealLocalFile: (source) =>
    ipcRenderer.invoke('workbench:reveal-local-file', { source }) as ReturnType<
      DesktopBridge['revealLocalFile']
    >,
  onBeforeClose(callback) {
    closeCallback = callback;
    return () => {
      if (closeCallback === callback) closeCallback = null;
    };
  },
  chooseBackupDirectory: () =>
    ipcRenderer.invoke('workbench:choose-backup-directory') as Promise<string | null>,
  chooseRestoreBackup: () =>
    ipcRenderer.invoke('workbench:choose-restore-backup') as Promise<string | null>,
  chooseFeedbackDirectory: () =>
    ipcRenderer.invoke('workbench:choose-feedback-directory') as Promise<string | null>,
  restartSoftware: () => ipcRenderer.invoke('workbench:restart') as Promise<void>,
  getAutoLaunch: () =>
    ipcRenderer.invoke('workbench:get-auto-launch') as Promise<{
      supported: boolean;
      enabled: boolean;
    }>,
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke('workbench:set-auto-launch', { enabled }) as Promise<{
      supported: boolean;
      enabled: boolean;
    }>,
};
contextBridge.exposeInMainWorld('workbenchDesktop', bridge);
