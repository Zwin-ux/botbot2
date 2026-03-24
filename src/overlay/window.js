'use strict';

const { BrowserWindow, screen, app } = require('electron');
const path = require('path');
const fs   = require('fs');
const config = require('../../config/default.json');

const OV = config.overlay;

// ── Position persistence ────────────────────────────────────────────────────

function userConfigPath() {
  return path.join(app.getPath('userData'), 'user-config.json');
}

function loadSavedPosition() {
  try {
    const cfgPath = userConfigPath();
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.overlayX != null && cfg.overlayY != null) {
      return { x: cfg.overlayX, y: cfg.overlayY };
    }
  } catch { /* use default */ }
  return null;
}

function savePosition(x, y) {
  try {
    const cfgPath = userConfigPath();
    const cfg = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      : {};
    cfg.overlayX = x;
    cfg.overlayY = y;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch { /* non-critical */ }
}

// ── Window creation ─────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // Restore saved position, or fall back to config default
  const saved = loadSavedPosition();
  let x, y;
  if (saved) {
    // Clamp to screen bounds so the overlay is never offscreen
    x = Math.max(0, Math.min(saved.x, sw - OV.width));
    y = Math.max(0, Math.min(saved.y, sh - OV.height));
  } else {
    [x, y] = resolvePosition(OV.position, sw, sh, OV.width, OV.height);
  }

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

  // Save position when user drags the overlay (debounced)
  let moveTimer = null;
  win.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [nx, ny] = win.getPosition();
      savePosition(nx, ny);
    }, 500);
  });

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
