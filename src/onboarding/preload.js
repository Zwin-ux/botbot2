'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gp', {
  // App state
  isPackaged:        ()       => ipcRenderer.invoke('app:isPackaged'),

  // Dependency checking
  checkDeps:         ()       => ipcRenderer.invoke('onboarding:checkDeps'),
  checkTesseract:    ()       => ipcRenderer.invoke('onboarding:checkTesseract'),

  // Installers
  installTesseract:  ()       => ipcRenderer.invoke('onboarding:installTesseract'),
  installPips:       ()       => ipcRenderer.invoke('onboarding:installPips'),

  // Configuration
  setProfile:        (game)   => ipcRenderer.invoke('onboarding:setProfile', game),
  setResolution:     (res)    => ipcRenderer.invoke('onboarding:setResolution', res),

  // Lifecycle
  complete:          ()       => ipcRenderer.invoke('onboarding:complete'),
  minimize:          ()       => ipcRenderer.invoke('onboarding:minimize'),
  close:             ()       => ipcRenderer.invoke('onboarding:close'),

  // Progress events
  onTessProgress:    (cb)     => ipcRenderer.on('tess:progress',    (_, d) => cb(d)),
  onInstallProgress: (cb)     => ipcRenderer.on('install:progress', (_, d) => cb(d)),
});
