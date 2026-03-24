const { contextBridge, ipcRenderer } = require('electron');

// Read active game name synchronously from config (available at require time)
let _gameName = 'YOUR GAME';
try {
  const config = require('../../config/default.json');
  _gameName = (config.activeProfile || 'your game').toUpperCase();
} catch { /* fallback */ }

contextBridge.exposeInMainWorld('gp', {
  // Receive game events pushed from the agent
  onGameEvent: (cb) => ipcRenderer.on('gameEvent', (_e, event) => cb(event)),

  // Receive service error notifications
  onServiceError: (cb) => ipcRenderer.on('serviceError', (_e, msg) => cb(msg)),

  // Get active game name for display
  getGameName: () => _gameName,

  // Query service status
  getStatus: () => ipcRenderer.invoke('services:status'),

  // Toggle click-through mode
  setClickThrough: (v) => ipcRenderer.invoke('overlay:setClickThrough', v),
});
