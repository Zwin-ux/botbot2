'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
} = require('electron');
const path               = require('path');
const fs                 = require('fs');
const { spawnSync, spawn } = require('child_process');
const log                = require('electron-log');

const { Orchestrator }           = require('./orchestrator');
const { createOverlayWindow }    = require('../overlay/window');
const { createOnboardingWindow } = require('../onboarding/window');

// ── Logging ───────────────────────────────────────────────────────────────────

log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs/main.log');
log.initialize();

const isDev = process.argv.includes('--dev');

// ── Module-level handles ──────────────────────────────────────────────────────

let orchestrator     = null;
let overlayWindow    = null;
let onboardingWindow = null;
let tray             = null;

// ── Setup-complete flag ───────────────────────────────────────────────────────

function setupFlagPath() {
  return path.join(app.getPath('userData'), 'setup-complete.json');
}
function isSetupComplete() {
  try { return fs.existsSync(setupFlagPath()); } catch { return false; }
}
function markSetupComplete() {
  try {
    fs.writeFileSync(setupFlagPath(), JSON.stringify({ completedAt: Date.now() }));
  } catch (err) {
    log.warn('Could not write setup flag:', err.message);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  log.info('GamePartner starting…');

  if (!isSetupComplete()) {
    // First run: show NES onboarding wizard; services start after completion
    onboardingWindow = createOnboardingWindow();
    registerOnboardingIPC();
    createTray({ hasOverlay: false });
  } else {
    await launchApp();
  }
});

app.on('window-all-closed', () => {
  // Tray app — stay alive when windows close
});

app.on('before-quit', async () => {
  log.info('GamePartner shutting down…');
  if (orchestrator) await orchestrator.stopAll();
});

// ── Core app launch ───────────────────────────────────────────────────────────

async function launchApp() {
  orchestrator = new Orchestrator({ isDev });
  registerOverlayIPC(orchestrator);

  try {
    await orchestrator.startAll();
    log.info('All services started');
  } catch (err) {
    log.error('Service startup failed:', err.message);
  }

  overlayWindow = createOverlayWindow();
  createTray({ hasOverlay: true });
}

// ── IPC: onboarding ───────────────────────────────────────────────────────────

function registerOnboardingIPC() {
  ipcMain.handle('onboarding:checkDeps', () => checkDependencies());

  ipcMain.handle('onboarding:installPips', (event) => {
    return new Promise((resolve) => {
      const reqPath = path.join(__dirname, '../../src/services/vision/requirements.txt');
      const child   = spawn('python', ['-m', 'pip', 'install', '-r', reqPath, '--quiet'], {
        windowsHide: true,
      });
      child.stdout.on('data', (d) =>
        event.sender.send('install:progress', { type: 'out', text: d.toString().trim() })
      );
      child.stderr.on('data', (d) =>
        event.sender.send('install:progress', { type: 'err', text: d.toString().trim() })
      );
      child.on('close', (code) => resolve({ ok: code === 0 }));
      child.on('error', (err)  => resolve({ ok: false, error: err.message }));
    });
  });

  ipcMain.handle('onboarding:setProfile', (_, game) => {
    log.info(`[onboarding] Profile selected: ${game}`);
    return { ok: true };
  });

  ipcMain.handle('onboarding:complete', async () => {
    markSetupComplete();
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
      onboardingWindow = null;
    }
    await launchApp();
    return { ok: true };
  });

  ipcMain.handle('onboarding:minimize', () => onboardingWindow?.minimize());
  ipcMain.handle('onboarding:close',    () => app.quit());
}

// ── IPC: overlay + services ───────────────────────────────────────────────────

function registerOverlayIPC(orch) {
  // Guard: handlers survive app restarts within same process
  if (ipcMain.eventNames().includes('services:status')) return;

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

  // Forward filtered agent decisions → overlay
  orch.on('gameEvent', (event) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('gameEvent', event);
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray({ hasOverlay }) {
  if (tray) { tray.destroy(); tray = null; }

  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const overlayItems = hasOverlay ? [
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
  ] : [
    { label: 'Setup in progress…', enabled: false },
    { type: 'separator' },
  ];

  const menu = Menu.buildFromTemplate([
    ...overlayItems,
    { label: 'Quit GamePartner', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip('GamePartner');
}

// ── Dependency checks ─────────────────────────────────────────────────────────

function checkDependencies() {
  return {
    python:    checkPython(),
    tesseract: checkTesseract(),
    packages:  checkPipPackages(),
  };
}

function checkPython() {
  for (const cmd of ['python', 'python3']) {
    try {
      const r = spawnSync(cmd, ['--version'], { timeout: 4000, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) {
        return { ok: true, version: (r.stdout || r.stderr || '').trim(), cmd };
      }
    } catch { /* try next */ }
  }
  return { ok: false };
}

function checkTesseract() {
  const candidates = [
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    'tesseract',
  ];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
      if (r.status === 0 || (r.stderr && r.stderr.includes('tesseract'))) {
        const ver = (r.stderr || r.stdout || '').split('\n')[0].replace('tesseract', '').trim();
        return { ok: true, version: ver || 'installed' };
      }
    } catch { /* try next */ }
  }
  return { ok: false };
}

function checkPipPackages() {
  const pkgs = {
    cv2:         'opencv-python-headless',
    pytesseract: 'pytesseract',
    mss:         'mss',
    numpy:       'numpy',
    PIL:         'Pillow',
    requests:    'requests',
  };

  const checks = {};
  for (const [importName, pipName] of Object.entries(pkgs)) {
    try {
      const r = spawnSync('python', ['-c', `import ${importName}`], {
        timeout: 5000, windowsHide: true,
      });
      checks[pipName] = { ok: r.status === 0 };
    } catch {
      checks[pipName] = { ok: false };
    }
  }

  return { checks, allOk: Object.values(checks).every(c => c.ok) };
}
