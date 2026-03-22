const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const log = require('electron-log');
const { Orchestrator } = require('./orchestrator');
const { createOverlayWindow } = require('../overlay/window');

log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs/main.log');
log.initialize();

const isDev = process.argv.includes('--dev');
let orchestrator = null;
let overlayWindow = null;
let tray = null;

app.whenReady().then(async () => {
  log.info('GamePartner starting...');

  orchestrator = new Orchestrator({ isDev });

  // Wire up IPC before starting services
  setupIPC(orchestrator);

  try {
    await orchestrator.startAll();
    log.info('All services started');
  } catch (err) {
    log.error('Service startup failed:', err);
  }

  overlayWindow = createOverlayWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      overlayWindow = createOverlayWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Keep alive as tray app — don't quit on window close
});

app.on('before-quit', async () => {
  log.info('GamePartner shutting down...');
  if (orchestrator) await orchestrator.stopAll();
});

function setupIPC(orch) {
  ipcMain.handle('services:status', () => orch.getStatus());

  ipcMain.handle('services:restart', async (_, name) => {
    await orch.restartService(name);
    return { ok: true };
  });

  ipcMain.handle('overlay:toggle', () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  });

  ipcMain.handle('overlay:setClickThrough', (_, value) => {
    if (overlayWindow) overlayWindow.setIgnoreMouseEvents(value, { forward: true });
  });

  // Forward game events from agent service -> overlay renderer
  orch.on('gameEvent', (event) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('gameEvent', event);
    }
  });
}

function createTray() {
  // Placeholder icon — replace with assets/icon.ico in production
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: 'Show Overlay', click: () => overlayWindow?.show() },
    { label: 'Hide Overlay', click: () => overlayWindow?.hide() },
    { type: 'separator' },
    {
      label: 'Services',
      submenu: [
        { label: 'Restart Agent',  click: () => orchestrator?.restartService('agent')  },
        { label: 'Restart Vision', click: () => orchestrator?.restartService('vision') },
      ],
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip('GamePartner');
}
