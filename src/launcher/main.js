'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut,
} = require('electron');
const path               = require('path');
const fs                 = require('fs');
const os                 = require('os');
const https              = require('https');
const http               = require('http');
const { spawnSync, spawn } = require('child_process');
const log                = require('electron-log');

const { Orchestrator }           = require('./orchestrator');
const { createOverlayWindow }    = require('../overlay/window');
const { createOnboardingWindow } = require('../onboarding/window');

// ── Tesseract installer (UB-Mannheim, tested release) ─────────────────────────
const TESSERACT_URL = [
  'https://github.com/UB-Mannheim/tesseract/releases/download',
  'v5.3.3.20231005',
  'tesseract-ocr-w64-setup-5.3.3.20231005.exe',
].join('/');

const TESSERACT_DEFAULT_DIR = 'C:\\Program Files\\Tesseract-OCR';

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
  globalShortcut.unregisterAll();
  if (orchestrator) await orchestrator.stopAll();
});

// ── Core app launch ───────────────────────────────────────────────────────────

async function launchApp() {
  orchestrator = new Orchestrator({
    isDev,
    isPackaged:    app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  registerOverlayIPC(orchestrator);

  try {
    await orchestrator.startAll();
    log.info('All services started');
  } catch (err) {
    log.error('Service startup failed:', err.message);
  }

  overlayWindow = createOverlayWindow();
  createTray({ hasOverlay: true });

  // Global shortcut: Ctrl+Shift+G toggles the overlay
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  });
}

// ── IPC: onboarding ───────────────────────────────────────────────────────────

function registerOnboardingIPC() {
  ipcMain.handle('app:isPackaged', () => app.isPackaged);

  ipcMain.handle('onboarding:checkDeps', () => checkDependencies());

  ipcMain.handle('onboarding:checkTesseract', () => checkTesseract());

  ipcMain.handle('onboarding:installTesseract', async (event) => {
    const existing = checkTesseract();
    if (existing.ok) return { ok: true, version: existing.version };

    const tmpExe = path.join(os.tmpdir(), 'gp_tesseract_setup.exe');

    try {
      log.info('[setup] Downloading Tesseract installer…');
      await downloadFile(TESSERACT_URL, tmpExe, (pct) => {
        event.sender.send('tess:progress', { type: 'download', pct });
      });

      log.info('[setup] Running silent Tesseract install…');
      event.sender.send('tess:progress', { type: 'installing' });

      await new Promise((resolve, reject) => {
        const child = spawn(tmpExe, ['/S', '/NORESTART'], { windowsHide: true });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Install timed out')); }, 120_000);
        child.on('close', (code) => { clearTimeout(timer); resolve(code); });
        child.on('error', (err)  => { clearTimeout(timer); reject(err); });
      });

      try { fs.unlinkSync(tmpExe); } catch {}

      const after = checkTesseract();
      log.info(`[setup] Tesseract installed: ${JSON.stringify(after)}`);
      return { ok: after.ok, version: after.version || 'installed' };

    } catch (err) {
      log.error('[setup] Tesseract install failed:', err.message);
      try { fs.unlinkSync(tmpExe); } catch {}
      return { ok: false, error: err.message };
    }
  });

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

  ipcMain.handle('onboarding:setResolution', (_, resolution) => {
    try {
      const cfgPath = path.join(app.getPath('userData'), 'user-config.json');
      const existing = fs.existsSync(cfgPath)
        ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        : {};
      existing.resolution = resolution;
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2));
      log.info(`[onboarding] Resolution set: ${resolution}`);
      return { ok: true };
    } catch (err) {
      log.warn('Could not save resolution:', err.message);
      return { ok: false };
    }
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

  orch.on('gameEvent', (event) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('gameEvent', event);
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray({ hasOverlay }) {
  if (tray) { tray.destroy(); tray = null; }

  const iconPath = path.join(__dirname, '../../assets/sprite.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);

  const overlayItems = hasOverlay ? [
    { label: 'Show Overlay',  click: () => overlayWindow?.show() },
    { label: 'Hide Overlay',  click: () => overlayWindow?.hide() },
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
    path.join(TESSERACT_DEFAULT_DIR, 'tesseract.exe'),
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

// ── Download helper (follows redirects) ──────────────────────────────────────

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (current, hops = 0) => {
      if (hops > 12) return reject(new Error('Too many redirects'));
      const proto = current.startsWith('https') ? https : http;
      const req = proto.get(current, { headers: { 'User-Agent': 'GamePartner-Setup/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          follow(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total  = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file   = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (!file.write(chunk)) { res.pause(); file.once('drain', () => res.resume()); }
          if (total > 0 && onProgress) onProgress(Math.round(received / total * 100));
        });
        res.on('end',   () => file.end(resolve));
        res.on('error', (e) => { file.destroy(); reject(e); });
        file.on('error', reject);
      });
      req.on('error', reject);
    };
    follow(url);
  });
}
