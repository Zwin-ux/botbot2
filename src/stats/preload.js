'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stats', {
  getStats:    () => ipcRenderer.invoke('stats:getData'),
  close:       () => ipcRenderer.invoke('stats:close'),
  minimize:    () => ipcRenderer.invoke('stats:minimize'),
});
