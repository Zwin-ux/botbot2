const { BrowserWindow, screen } = require('electron');
const path = require('path');
const config = require('../../config/default.json');

const OV = config.overlay;

function createOverlayWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  const [x, y] = resolvePosition(OV.position, sw, sh, OV.width, OV.height);

  const win = new BrowserWindow({
    width:           OV.width,
    height:          OV.height,
    x,
    y,
    transparent:     true,
    frame:           false,
    resizable:       false,
    alwaysOnTop:     OV.alwaysOnTop,
    skipTaskbar:     true,
    hasShadow:       false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.setOpacity(OV.opacity);
  win.loadFile(path.join(__dirname, 'index.html'));

  if (OV.clickThrough) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  // Keep always-on-top across fullscreen game windows (Windows-specific)
  win.setAlwaysOnTop(true, 'screen-saver');

  return win;
}

function resolvePosition(pos, sw, sh, w, h) {
  const pad = 16;
  switch (pos) {
    case 'top-right':    return [sw - w - pad,      pad          ];
    case 'top-left':     return [pad,                pad          ];
    case 'bottom-right': return [sw - w - pad,      sh - h - pad ];
    case 'bottom-left':  return [pad,               sh - h - pad ];
    default:             return [sw - w - pad,      pad          ];
  }
}

module.exports = { createOverlayWindow };
