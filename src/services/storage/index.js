/**
 * Storage service — lightweight HTTP API over SQLite.
 *
 * Endpoints:
 *   GET  /health
 *   POST /events           store a GameEvent
 *   GET  /events?session=  query events by session
 *   POST /sessions         create / update a session record
 *   GET  /sessions/:id     get session metadata
 *   GET  /stats/:game      aggregated stats for a game
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const log     = require('electron-log');
const config  = require('../../../config/default.json');
const { openDb } = require('./schema');

const PORT   = config.services.storage.port;
const DB_DIR = path.resolve(__dirname, '../../../data');
const DB_PATH = path.join(DB_DIR, 'gamepartner.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db  = openDb(DB_PATH);
const app = express();
app.use(express.json({ limit: '2mb' }));

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// Bulk ingest — vision/agent can batch events
app.post('/events', (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (id, type, game, ts, session_id, payload)
     VALUES (@id, @type, @game, @ts, @sessionId, @payload)`
  );
  const insertMany = db.transaction((evs) => {
    for (const ev of evs) {
      insert.run({
        id:        ev.id,
        type:      ev.type,
        game:      ev.game,
        ts:        ev.ts,
        sessionId: ev.sessionId ?? null,
        payload:   JSON.stringify(ev.payload ?? {}),
      });
    }
  });
  try {
    insertMany(events);
    res.json({ stored: events.length });
  } catch (err) {
    log.error('[storage] insert error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/events', (req, res) => {
  const { session, type, limit = 100, offset = 0 } = req.query;
  let sql  = 'SELECT * FROM events WHERE 1=1';
  const params = [];
  if (session) { sql += ' AND session_id = ?'; params.push(session); }
  if (type)    { sql += ' AND type = ?';       params.push(type);    }
  sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(sql).all(...params).map(r => ({
    ...r, payload: JSON.parse(r.payload),
  }));
  res.json(rows);
});

app.post('/sessions', (req, res) => {
  const { id, game, startedAt, endedAt, meta } = req.body;
  db.prepare(
    `INSERT INTO sessions (id, game, started_at, ended_at, meta)
     VALUES (@id, @game, @startedAt, @endedAt, @meta)
     ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, meta=excluded.meta`
  ).run({ id, game, startedAt: startedAt ?? Date.now(), endedAt: endedAt ?? null,
          meta: JSON.stringify(meta ?? {}) });
  res.json({ ok: true });
});

app.get('/sessions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, meta: JSON.parse(row.meta) });
});

app.get('/stats/:game', (req, res) => {
  const { game } = req.params;
  const kills  = db.prepare(`SELECT COUNT(*) as n FROM events WHERE game=? AND type='combat.kill'`).get(game);
  const deaths = db.prepare(`SELECT COUNT(*) as n FROM events WHERE game=? AND type='combat.death'`).get(game);
  const rounds = db.prepare(`SELECT COUNT(*) as n FROM events WHERE game=? AND type='round.start'`).get(game);
  res.json({
    game,
    kills:  kills.n,
    deaths: deaths.n,
    rounds: rounds.n,
    kd: deaths.n > 0 ? (kills.n / deaths.n).toFixed(2) : kills.n,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  log.info(`[storage] listening on 127.0.0.1:${PORT} — db: ${DB_PATH}`);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
