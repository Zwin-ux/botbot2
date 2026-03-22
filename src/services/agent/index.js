/**
 * Agent service — HTTP + WebSocket server.
 *
 * HTTP:
 *   GET  /health          liveness probe
 *   POST /ingest          vision detections → normalize → decision pipeline
 *   POST /event           inject a synthetic canonical GameEvent
 *   GET  /session         current session metadata
 *
 * WebSocket:
 *   WS /events            every canonical GameEvent (telemetry + decisions)
 *   WS /decisions         only agent.decision events (overlay channel — low noise)
 */

'use strict';

const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const log     = require('electron-log');
const config  = require('../../../config/default.json');
const { AgentCore } = require('./core');

const PORT = config.services.agent.port;
const app  = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);

// Two separate WS servers on the same HTTP server, differentiated by path
const wssEvents    = new WebSocketServer({ server, path: '/events'    });
const wssDecisions = new WebSocketServer({ server, path: '/decisions' });

// ── Agent core ───────────────────────────────────────────────────────────────
const agent = new AgentCore();

// All events (raw telemetry + decisions) → /events channel
agent.on('event',    (ev) => broadcastTo(wssEvents, ev));

// Decisions only → /decisions channel (overlay subscribes here)
agent.on('decision', (ev) => broadcastTo(wssDecisions, ev));

// ── HTTP routes ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * Vision service posts raw frame detections here.
 * Body: { game, sessionId, detections: { health, credits, phase, ... } }
 */
app.post('/ingest', (req, res) => {
  const { game, sessionId, detections } = req.body;
  if (!game || !detections) {
    return res.status(400).json({ error: 'Missing game or detections' });
  }
  try {
    agent.ingest(game, sessionId, detections);
    res.json({ ok: true });
  } catch (err) {
    log.error('[agent] ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Inject a synthetic canonical GameEvent (testing / other services).
 * Body: GameEvent
 */
app.post('/event', (req, res) => {
  try {
    agent.dispatch(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/session', (_req, res) => res.json(agent.currentSession()));

// ── WebSocket plumbing ───────────────────────────────────────────────────────

function setupWss(wss, label) {
  wss.on('connection', (ws) => {
    log.info(`[agent/ws/${label}] client connected`);
    ws.on('close', () => log.info(`[agent/ws/${label}] client disconnected`));
    ws.on('error', (e) => log.warn(`[agent/ws/${label}] error: ${e.message}`));
  });
}

function broadcastTo(wss, event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(payload);
  }
}

setupWss(wssEvents,    'events');
setupWss(wssDecisions, 'decisions');

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  log.info(`[agent] listening on 127.0.0.1:${PORT}`);
  log.info(`[agent] WS channels: /events (all), /decisions (overlay)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
