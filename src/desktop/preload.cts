import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBridge } from '../shared/desktop.js';
let closeHandler: ((_event: Electron.IpcRendererEvent, requestId: string) => void) | null = null;
const bridge: DesktopBridge = {
  materialFilePath: (file) => webUtils.getPathForFile(file),
  revealLocalFile: (source) =>
    ipcRenderer.invoke('workbench:reveal-local-file', { source }) as ReturnType<
      DesktopBridge['revealLocalFile']
    >,
  onBeforeClose(callback) {
    if (closeHandler) ipcRenderer.removeListener('workbench:prepare-close', closeHandler);
    const handler = (_event: Electron.IpcRendererEvent, requestId: string) => {
      void callback().then(
        (ok) => ipcRenderer.send('workbench:close-result', { requestId, ok }),
        () => ipcRenderer.send('workbench:close-result', { requestId, ok: false }),
      );
    };
    closeHandler = handler;
    ipcRenderer.on('workbench:prepare-close', handler);
    return () => {
      ipcRenderer.removeListener('workbench:prepare-close', handler);
      if (closeHandler === handler) closeHandler = null;
    };
  },
  chooseMaterialDirectory: () =>
    ipcRenderer.invoke('workbench:choose-material-directory') as Promise<string | null>,
  chooseBackupDirectory: () =>
    ipcRenderer.invoke('workbench:choose-backup-directory') as Promise<string | null>,
  chooseRestoreBackup: () =>
    ipcRenderer.invoke('workbench:choose-restore-backup') as Promise<string | null>,
  restartSoftware: () => ipcRenderer.invoke('workbench:restart') as Promise<void>,
};
contextBridge.exposeInMainWorld('workbenchDesktop', bridge);
