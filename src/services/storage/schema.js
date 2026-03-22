const Database = require('better-sqlite3');
const log = require('electron-log');

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      game       TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      meta       TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      game       TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      session_id TEXT REFERENCES sessions(id),
      payload    TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
  `);

  log.info(`[storage/schema] Database ready at ${dbPath}`);
  return db;
}

module.exports = { openDb };
