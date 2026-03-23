'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/ipc-channels');

contextBridge.exposeInMainWorld('gp', {
  // App state
  isPackaged:    () => ipcRenderer.invoke(IPC.IS_PACKAGED),
  getResolution: () => ipcRenderer.invoke(IPC.GET_RESOLUTION),

  // Dependency checking
  checkDeps:      () => ipcRenderer.invoke(IPC.CHECK_DEPS),
  checkTesseract: () => ipcRenderer.invoke(IPC.CHECK_TESSERACT),

  // Installers
  installTesseract: () => ipcRenderer.invoke(IPC.INSTALL_TESSERACT),
  installPips:      () => ipcRenderer.invoke(IPC.INSTALL_PIPS),

  // Configuration
  setProfile:    (game) => ipcRenderer.invoke(IPC.SET_PROFILE, game),
  setResolution: (res)  => ipcRenderer.invoke(IPC.SET_RESOLUTION, res),

  // Lifecycle
  complete: () => ipcRenderer.invoke(IPC.COMPLETE),
  minimize: () => ipcRenderer.invoke(IPC.MINIMIZE),
  close:    () => ipcRenderer.invoke(IPC.CLOSE),

  // Open external URL (restricted to https:// in main process)
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),

  // Progress events — returns unsubscribe fn to prevent listener stacking on retry
  onTessProgress: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on(IPC.TESS_PROGRESS, h);
    return () => ipcRenderer.removeListener(IPC.TESS_PROGRESS, h);
  },
  onInstallProgress: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on(IPC.INSTALL_PROGRESS, h);
    return () => ipcRenderer.removeListener(IPC.INSTALL_PROGRESS, h);
  },
});
