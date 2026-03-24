'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  globalShortcut, shell, screen,
} = require('electron');
const path               = require('path');
const fs                 = require('fs');
const os                 = require('os');
const https              = require('https');
const http               = require('http');
const { spawnSync, spawn } = require('child_process');
const log                = require('electron-log');
const config             = require('../../config/default.json');

const { Orchestrator }           = require('./orchestrator');
const { createOverlayWindow }    = require('../overlay/window');
const { createOnboardingWindow } = require('../onboarding/window');
const { createStatsWindow }      = require('../stats/window');
const { IPC, VALID_GAMES, VALID_RESOLUTIONS } = require('../shared/ipc-channels');

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
let statsWindow      = null;
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

// ── Auto-update (checks GitHub Releases on launch) ──────────────────────────

function initAutoUpdate() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;     // don't download until user confirms
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      log.info(`[update] New version available: ${info.version}`);
      // Surface to overlay as a low-priority NES alert
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('gameEvent', {
          type: 'agent.decision',
          payload: {
            message: `Update v${info.version} available -- restart to install`,
            priority: 'low',
            ttl: 15000,
          },
        });
      }
      autoUpdater.downloadUpdate();
    });

    autoUpdater.on('update-downloaded', () => {
      log.info('[update] Update downloaded — will install on quit');
    });

    autoUpdater.on('error', (err) => {
      log.debug(`[update] Auto-update check failed: ${err.message}`);
    });

    // Check after a short delay so it doesn't slow down startup
    setTimeout(() => autoUpdater.checkForUpdates(), 10_000);
  } catch {
    // electron-updater not installed (dev mode) — skip silently
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
    initAutoUpdate();
  }
});

app.on('window-all-closed', () => { /* tray app — stay alive */ });

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
    tesseractDir:  getSavedTesseractDir(),
  });
  registerOverlayIPC(orchestrator);

  try {
    await orchestrator.startAll();
    log.info('All services started');
  } catch (err) {
    log.error('Service startup failed:', err.message);
    // Surface the error back to callers via a flag
    orchestrator._startupError = err.message;
  }

  overlayWindow = createOverlayWindow();
  createTray({ hasOverlay: true });

  // Surface startup errors to the overlay after it loads
  if (orchestrator._startupError) {
    overlayWindow.webContents.on('did-finish-load', () => {
      overlayWindow.webContents.send('serviceError', orchestrator._startupError);
    });
  }

  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  });
}

// ── IPC: onboarding ───────────────────────────────────────────────────────────

function registerOnboardingIPC() {
  // Guard: prevent double-registration if called twice
  if (ipcMain.eventNames().includes(IPC.IS_PACKAGED)) return;

  // ── App state ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.IS_PACKAGED, () => app.isPackaged);

  ipcMain.handle(IPC.GET_RESOLUTION, () => {
    const { size } = screen.getPrimaryDisplay();
    return { width: size.width, height: size.height };
  });

  // ── Dependency checks ──────────────────────────────────────────────────────
  ipcMain.handle(IPC.CHECK_DEPS,       () => {
    const deps = checkDependencies();
    // Persist Tesseract path if found during dependency check
    if (deps.tesseract.ok && deps.tesseract.dir) saveTesseractPath(deps.tesseract.dir);
    return deps;
  });
  ipcMain.handle(IPC.CHECK_TESSERACT,  () => {
    const result = checkTesseract();
    if (result.ok && result.dir) saveTesseractPath(result.dir);
    return result;
  });

  // ── Tesseract auto-install ─────────────────────────────────────────────────
  ipcMain.handle(IPC.INSTALL_TESSERACT, async (event) => {
    const existing = checkTesseract();
    if (existing.ok) return { ok: true, version: existing.version };

    const tmpExe = path.join(os.tmpdir(), 'gp_tesseract_setup.exe');
    try {
      log.info('[setup] Downloading Tesseract installer…');
      await downloadFile(TESSERACT_URL, tmpExe, (pct) => {
        event.sender.send(IPC.TESS_PROGRESS, { type: 'download', pct });
      });

      log.info('[setup] Running silent Tesseract install…');
      event.sender.send(IPC.TESS_PROGRESS, { type: 'installing' });

      await new Promise((resolve, reject) => {
        const child = spawn(tmpExe, ['/S', '/NORESTART'], { windowsHide: true });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, 120_000);
        child.on('close', (code) => { clearTimeout(timer); resolve(code); });
        child.on('error', (err)  => { clearTimeout(timer); reject(err); });
      });

      try { fs.unlinkSync(tmpExe); } catch {}

      const after = checkTesseract();
      log.info(`[setup] Tesseract post-install check: ${JSON.stringify(after)}`);
      if (after.ok && after.dir) saveTesseractPath(after.dir);
      return { ok: after.ok, version: after.version || 'installed' };

    } catch (err) {
      log.error('[setup] Tesseract install failed:', err.message);
      try { fs.unlinkSync(tmpExe); } catch {}
      return { ok: false, error: err.message };
    }
  });

  // ── Pip install (dev mode) ─────────────────────────────────────────────────
  ipcMain.handle(IPC.INSTALL_PIPS, (event) => {
    return new Promise((resolve) => {
      const reqPath = path.join(__dirname, '../../src/services/vision/requirements.txt');
      const child   = spawn('python', ['-m', 'pip', 'install', '-r', reqPath, '--quiet'], {
        windowsHide: true,
      });
      child.stdout.on('data', (d) =>
        event.sender.send(IPC.INSTALL_PROGRESS, { type: 'out', text: d.toString().trim() })
      );
      child.stderr.on('data', (d) =>
        event.sender.send(IPC.INSTALL_PROGRESS, { type: 'err', text: d.toString().trim() })
      );
      child.on('close', (code) => resolve({ ok: code === 0 }));
      child.on('error', (err)  => resolve({ ok: false, error: err.message }));
    });
  });

  // ── Profile + resolution ───────────────────────────────────────────────────
  ipcMain.handle(IPC.SET_PROFILE, (_, game) => {
    if (!VALID_GAMES.includes(game)) {
      log.warn(`[onboarding] Rejected invalid game: ${game}`);
      return { ok: false, error: 'invalid game' };
    }
    log.info(`[onboarding] Profile selected: ${game}`);
    return { ok: true };
  });

  ipcMain.handle(IPC.SET_RESOLUTION, (_, resolution) => {
    if (!VALID_RESOLUTIONS.includes(resolution)) {
      log.warn(`[onboarding] Rejected invalid resolution: ${resolution}`);
      return { ok: false, error: 'invalid resolution' };
    }
    try {
      const cfgPath = path.join(app.getPath('userData'), 'user-config.json');
      const cfg = fs.existsSync(cfgPath)
        ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        : {};
      cfg.resolution = resolution;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      log.info(`[onboarding] Resolution saved: ${resolution}`);
      return { ok: true };
    } catch (err) {
      log.warn('Could not save resolution:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.COMPLETE, async () => {
    markSetupComplete();
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
      onboardingWindow = null;
    }
    await launchApp();
    // Surface any startup errors back to the renderer
    const err = orchestrator?._startupError;
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle(IPC.MINIMIZE,      () => onboardingWindow?.minimize());
  ipcMain.handle(IPC.CLOSE,         () => app.quit());
  ipcMain.handle(IPC.OPEN_EXTERNAL, (_, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

// ── IPC: overlay + services ───────────────────────────────────────────────────

function registerOverlayIPC(orch) {
  if (ipcMain.eventNames().includes(IPC.SERVICES_STATUS)) return;

  ipcMain.handle(IPC.SERVICES_STATUS, () => orch.getStatus());

  ipcMain.handle(IPC.SERVICES_RESTART, async (_, name) => {
    await orch.restartService(name);
    return { ok: true };
  });

  ipcMain.handle(IPC.OVERLAY_TOGGLE, () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  });

  ipcMain.handle(IPC.OVERLAY_SET_CLICKTHROUGH, (_, value) => {
    if (overlayWindow) overlayWindow.setIgnoreMouseEvents(value, { forward: true });
  });

  orch.on('gameEvent', (event) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.GAME_EVENT, event);
    }
  });

  // Surface service crashes to the overlay so consumers see what's wrong
  orch.on('serviceExit', ({ name }) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('serviceError',
        `${name} service crashed -- check logs or restart`
      );
    }
  });
}

// ── IPC: stats window ────────────────────────────────────────────────────────

function registerStatsIPC() {
  if (ipcMain.eventNames().includes('stats:getData')) return;

  ipcMain.handle('stats:getData', async () => {
    const storagePort = config.services.storage.port;
    try {
      const http = require('http');
      const fetch = (url) => new Promise((resolve, reject) => {
        http.get(url, (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      const game = config.activeProfile;
      const [events, stats] = await Promise.all([
        fetch(`http://127.0.0.1:${storagePort}/events?limit=50`),
        fetch(`http://127.0.0.1:${storagePort}/stats/${game}`),
      ]);

      if (!events || !Array.isArray(events)) {
        return { totalEvents: 0, game };
      }

      // Compute breakdown by event type
      const breakdown = {};
      let earliest = Infinity;
      let latest = 0;
      let decisions = 0;
      for (const ev of events) {
        breakdown[ev.type] = (breakdown[ev.type] || 0) + 1;
        if (ev.ts < earliest) earliest = ev.ts;
        if (ev.ts > latest)   latest = ev.ts;
        if (ev.type === 'agent.decision') decisions++;
      }

      return {
        game,
        totalEvents:     events.length,
        decisions,
        sessionDuration: latest > earliest ? latest - earliest : 0,
        breakdown,
        recentEvents:    events.slice(0, 8),
        stats:           stats || {},
      };
    } catch (err) {
      log.warn('[stats] Failed to fetch stats:', err.message);
      return { totalEvents: 0, game: config.activeProfile };
    }
  });

  ipcMain.handle('stats:close', () => {
    if (statsWindow && !statsWindow.isDestroyed()) statsWindow.close();
    statsWindow = null;
  });

  ipcMain.handle('stats:minimize', () => {
    if (statsWindow && !statsWindow.isDestroyed()) statsWindow.minimize();
  });
}

function openStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.focus();
    return;
  }
  registerStatsIPC();
  statsWindow = createStatsWindow();
  statsWindow.on('closed', () => { statsWindow = null; });
}

// ── Recording ───────────────────────────────────────────────────────────────

async function startRecording() {
  const visionPort = config.services.vision.port;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: visionPort, path: '/record/start', method: 'POST' },
        (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    if (result.ok) {
      log.info(`[main] Recording started → ${result.dir}`);
      // Notify overlay
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('gameEvent', {
          type: 'agent.decision',
          payload: { message: 'Recording 60s for calibration', priority: 'info', ttl: 4000 },
        });
      }
    } else {
      log.warn(`[main] Recording failed: ${result.error}`);
    }
  } catch (err) {
    log.error(`[main] Could not start recording: ${err.message}`);
  }
}

// ── Game switching ───────────────────────────────────────────────────────────

async function switchGame(game) {
  if (!VALID_GAMES.includes(game)) return;

  log.info(`[main] Switching game to: ${game}`);
  config.activeProfile = game;

  // Persist to user-config so it survives restart
  try {
    const cfgPath = path.join(app.getPath('userData'), 'user-config.json');
    const userCfg = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      : {};
    userCfg.activeProfile = game;
    fs.writeFileSync(cfgPath, JSON.stringify(userCfg, null, 2));
  } catch (err) {
    log.warn('Could not persist game choice:', err.message);
  }

  // Restart vision service with new profile
  if (orchestrator) {
    try {
      await orchestrator.restartService('vision');
      log.info(`[main] Vision restarted for ${game}`);
    } catch (err) {
      log.error(`[main] Vision restart failed: ${err.message}`);
    }
  }

  // Rebuild tray to show updated radio selection
  createTray({ hasOverlay: !!overlayWindow });
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

  const gameChoices = VALID_GAMES.map(g => ({
    label: g.charAt(0).toUpperCase() + g.slice(1),
    type: 'radio',
    checked: config.activeProfile === g,
    click: () => switchGame(g),
  }));

  const menu = Menu.buildFromTemplate([
    ...(hasOverlay ? [
      { label: 'Show Overlay',  click: () => overlayWindow?.show() },
      { label: 'Hide Overlay',  click: () => overlayWindow?.hide() },
      { type: 'separator' },
      {
        label: 'Switch Game',
        submenu: gameChoices,
      },
      {
        label: 'Overlay',
        submenu: [
          { label: 'Click-Through', type: 'checkbox', checked: false,
            click: (item) => {
              if (overlayWindow) overlayWindow.setIgnoreMouseEvents(item.checked, { forward: true });
            },
          },
          { type: 'separator' },
          ...[100, 80, 60, 40].map(pct => ({
            label: `Opacity ${pct}%`,
            type: 'radio',
            checked: pct === 100,
            click: () => { if (overlayWindow) overlayWindow.setOpacity(pct / 100); },
          })),
        ],
      },
      {
        label: 'Services',
        submenu: [
          { label: 'Restart Agent',  click: () => orchestrator?.restartService('agent')  },
          { label: 'Restart Vision', click: () => orchestrator?.restartService('vision') },
        ],
      },
      { type: 'separator' },
      { label: 'Session Stats', click: () => openStatsWindow() },
      { label: 'Record 60s', click: () => startRecording() },
      { label: 'View Logs', click: () => {
        const logPath = path.join(app.getPath('userData'), 'logs/main.log');
        shell.openPath(logPath);
      }},
      { label: 'Report Bug', click: () => {
        shell.openExternal('https://github.com/Zwin-ux/botbot2/issues/new');
      }},
      { type: 'separator' },
    ] : [
      { label: 'Setup in progress…', enabled: false },
      { type: 'separator' },
    ]),
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
      if (r.status === 0) return { ok: true, version: (r.stdout || r.stderr || '').trim(), cmd };
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
        // Resolve the directory containing the binary for TESSDATA_PREFIX
        const resolvedDir = bin === 'tesseract' ? null : path.dirname(bin);
        return { ok: true, version: ver || 'installed', dir: resolvedDir };
      }
    } catch { /* try next */ }
  }
  return { ok: false };
}

function saveTesseractPath(tessDir) {
  if (!tessDir) return;
  try {
    const cfgPath = path.join(app.getPath('userData'), 'user-config.json');
    const cfg = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      : {};
    cfg.tesseractDir = tessDir;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    log.info(`[setup] Tesseract path saved: ${tessDir}`);
  } catch (err) {
    log.warn('Could not save Tesseract path:', err.message);
  }
}

function getSavedTesseractDir() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'user-config.json');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.tesseractDir || null;
  } catch { return null; }
}

function checkPipPackages() {
  const pkgs = {
    cv2: 'opencv-python-headless', pytesseract: 'pytesseract',
    mss: 'mss', numpy: 'numpy', PIL: 'Pillow', requests: 'requests',
  };
  const checks = {};
  for (const [importName, pipName] of Object.entries(pkgs)) {
    try {
      const r = spawnSync('python', ['-c', `import ${importName}`], { timeout: 5000, windowsHide: true });
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
          res.resume(); follow(res.headers.location, hops + 1); return;
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
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
