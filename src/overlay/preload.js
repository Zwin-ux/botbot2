const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gp', {
  // Receive game events pushed from the agent
  onGameEvent: (cb) => ipcRenderer.on('gameEvent', (_e, event) => cb(event)),

  // Query service status
  getStatus: () => ipcRenderer.invoke('services:status'),

  // Toggle click-through mode
  setClickThrough: (v) => ipcRenderer.invoke('overlay:setClickThrough', v),
});
