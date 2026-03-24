'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const log = require('electron-log');
const config = require('../../config/default.json');

const HEALTH_POLL_INTERVAL = 500;
const HEALTH_POLL_TIMEOUT  = 15_000;

// Default Tesseract install path on Windows (UB Mannheim installer default)
const TESSERACT_DEFAULT_DIR = 'C:\\Program Files\\Tesseract-OCR';

class ServiceProcess extends EventEmitter {
  constructor(name, descriptor) {
    super();
    this.name = name;
    this.descriptor = descriptor;
    this.process = null;
    this.status = 'stopped';
    this.restartTimer = null;
    this.autoRestart = config.services[name]?.autoRestart ?? false;
    this.restartDelay = config.services[name]?.restartDelay ?? 2000;
  }

  start() {
    if (this.status === 'running' || this.status === 'starting') return;
    this.status = 'starting';

    const { cmd, args = [], cwd, env = {} } = this.descriptor;
    log.info(`[orchestrator] Starting service: ${this.name} → ${cmd} ${args.join(' ')}`);

    this.process = spawn(cmd, args, {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout.on('data', (d) =>
      log.info(`[${this.name}] ${d.toString().trim()}`)
    );
    this.process.stderr.on('data', (d) =>
      log.warn(`[${this.name}] ${d.toString().trim()}`)
    );

    this.process.on('exit', (code, signal) => {
      log.warn(`[orchestrator] Service ${this.name} exited (code=${code}, signal=${signal})`);
      this.status = 'crashed';
      this.emit('exit', { code, signal });

      if (this.autoRestart) {
        this.restartTimer = setTimeout(() => this.start(), this.restartDelay);
      }
    });

    this.process.on('error', (err) => {
      log.error(`[orchestrator] Failed to spawn ${this.name}:`, err);
      this.status = 'crashed';
      this.emit('error', err);
    });
  }

  async waitReady() {
    const port = this.descriptor.port;
    if (!port) return;

    const deadline = Date.now() + HEALTH_POLL_TIMEOUT;
    while (Date.now() < deadline) {
      if (await tcpReachable('127.0.0.1', port)) {
        this.status = 'running';
        log.info(`[orchestrator] ${this.name} is ready on port ${port}`);
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL);
    }
    throw new Error(`Service ${this.name} did not become ready within ${HEALTH_POLL_TIMEOUT}ms`);
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.autoRestart = false;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.status = 'stopped';
  }

  getStatus() {
    return {
      name:   this.name,
      status: this.status,
      pid:    this.process?.pid ?? null,
      port:   this.descriptor.port ?? null,
    };
  }
}

class Orchestrator extends EventEmitter {
  constructor({ isDev = false, isPackaged = false, resourcesPath = '', tesseractDir = '' } = {}) {
    super();
    this.isDev         = isDev;
    this.isPackaged    = isPackaged;
    this.resourcesPath = resourcesPath;
    this.tesseractDir  = tesseractDir || TESSERACT_DEFAULT_DIR;
    this.services = this._buildServiceMap();
  }

  _buildServiceMap() {
    const root = path.resolve(__dirname, '../..');

    // ── Vision service: bundled exe in production, python script in dev ──────
    let visionCmd, visionArgs, visionCwd, visionEnv = { PYTHONUNBUFFERED: '1' };

    if (this.isPackaged) {
      const visionResDir = path.join(this.resourcesPath, 'vision');
      visionCmd  = path.join(visionResDir, 'vision_server.exe');
      visionArgs = [];
      visionCwd  = visionResDir;

      // Point the bundled exe at the extracted config and profiles
      visionEnv = {
        PYTHONUNBUFFERED:  '1',
        GP_CONFIG_PATH:    path.join(visionResDir, 'config', 'default.json'),
        GP_PROFILES_PATH:  path.join(visionResDir, 'profiles'),
        // Add Tesseract to PATH so pytesseract can find the binary
        PATH:              `${this.tesseractDir};${process.env.PATH || ''}`,
        TESSDATA_PREFIX:   path.join(this.tesseractDir, 'tessdata'),
      };
    } else {
      visionCmd  = 'python';
      visionArgs = [path.join(root, 'src/services/vision/server.py')];
      visionCwd  = root;
    }

    return {
      agent: new ServiceProcess('agent', {
        cmd:  'node',
        args: [path.join(root, 'src/services/agent/index.js')],
        cwd:  root,
        port: config.services.agent.port,
      }),

      vision: new ServiceProcess('vision', {
        cmd:  visionCmd,
        args: visionArgs,
        cwd:  visionCwd,
        port: config.services.vision.port,
        env:  visionEnv,
      }),

      storage: new ServiceProcess('storage', {
        cmd:  'node',
        args: [path.join(root, 'src/services/storage/index.js')],
        cwd:  root,
        port: config.services.storage.port,
      }),
    };
  }

  async startAll() {
    const order = ['storage', 'agent', 'vision'];
    for (const name of order) {
      const svc = this.services[name];
      svc.start();
      svc.on('exit', () => this.emit('serviceExit', { name }));
      try {
        await svc.waitReady();
      } catch (err) {
        log.error(`[orchestrator] ${name} startup failed:`, err.message);
      }
    }
    this._connectAgentFeed();
  }

  async stopAll() {
    for (const svc of Object.values(this.services)) svc.stop();
  }

  async restartService(name) {
    const svc = this.services[name];
    if (!svc) throw new Error(`Unknown service: ${name}`);
    log.info(`[orchestrator] Restarting ${name}`);
    svc.stop();
    await sleep(500);
    svc.autoRestart = config.services[name]?.autoRestart ?? false;
    svc.start();
    await svc.waitReady();
  }

  getStatus() {
    return Object.values(this.services).map((s) => s.getStatus());
  }

  _connectAgentFeed() {
    const { port, host } = config.services.agent;
    const WebSocket = require('ws');
    const url = `ws://${host}:${port}/decisions`;

    const connect = () => {
      const ws = new WebSocket(url);
      ws.on('open',    () => log.info('[orchestrator] Agent event feed connected'));
      ws.on('message', (raw) => {
        try { this.emit('gameEvent', JSON.parse(raw)); } catch { /* malformed */ }
      });
      ws.on('close',   () => {
        log.warn('[orchestrator] Agent event feed disconnected — reconnecting in 3s');
        setTimeout(connect, 3000);
      });
      ws.on('error',   () => ws.terminate());
    };

    setTimeout(connect, 1500);
  }
}

function tcpReachable(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('error',   () => done(false));
    socket.once('timeout', () => done(false));
    socket.connect(port, host);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Orchestrator };
