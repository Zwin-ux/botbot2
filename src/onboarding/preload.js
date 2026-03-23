const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gp', {
  checkDeps:        ()      => ipcRenderer.invoke('onboarding:checkDeps'),
  installPips:      ()      => ipcRenderer.invoke('onboarding:installPips'),
  setProfile:       (game)  => ipcRenderer.invoke('onboarding:setProfile', game),
  complete:         ()      => ipcRenderer.invoke('onboarding:complete'),
  minimize:         ()      => ipcRenderer.invoke('onboarding:minimize'),
  close:            ()      => ipcRenderer.invoke('onboarding:close'),
  onInstallProgress: (cb)   => ipcRenderer.on('install:progress', (_, d) => cb(d)),
});
