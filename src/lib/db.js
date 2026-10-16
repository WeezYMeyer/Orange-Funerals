// SQLite data layer (better-sqlite3 — synchronous, no separate DB server to run).
// Handles schema creation on first boot and exposes small helper functions
// used by the routes. Keeping raw SQL here (rather than an ORM) keeps the
// app dependency-light and easy to deploy anywhere Node runs.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const dbFile = process.env.DATABASE_FILE || "./data/funeral-streams.db";
const resolved = path.resolve(process.cwd(), dbFile);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

const db = new Database(resolved);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS streams (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slug           TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL,
    embed_code     TEXT NOT NULL,
    service_date   TEXT,
    created_by     INTEGER REFERENCES staff(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at       TEXT,
    thanks_sent_at TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT,
    opt_out     INTEGER NOT NULL DEFAULT 0,
    unsub_token TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stream_views (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id  INTEGER NOT NULL REFERENCES streams(id),
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stream_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id  INTEGER NOT NULL REFERENCES streams(id),
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    stream_id  INTEGER REFERENCES streams(id),
    kind       TEXT NOT NULL,      -- 'thank_you' | 'broadcast'
    subject    TEXT NOT NULL,
    status     TEXT NOT NULL,      -- 'sent' | 'failed' | 'skipped_optout'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_stream_views_stream ON stream_views(stream_id);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_stream ON chat_messages(stream_id);
  CREATE INDEX IF NOT EXISTS idx_email_logs_contact ON email_logs(contact_id);
`);

// --- Crew, kits & funeral logistics (added Oct 2026) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS crew (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    own_vehicle INTEGER NOT NULL DEFAULT 0,
    notes       TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kits (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
  );

  -- One row per operator considered for a funeral.
  -- status: 'shortlisted' -> 'asked' -> 'confirmed' | 'declined'
  CREATE TABLE IF NOT EXISTS stream_crew (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id        INTEGER NOT NULL REFERENCES streams(id),
    crew_id          INTEGER NOT NULL REFERENCES crew(id),
    status           TEXT NOT NULL DEFAULT 'shortlisted',
    uses_own_vehicle INTEGER NOT NULL DEFAULT 0,
    asked_at         TEXT,
    confirmed_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stream_id, crew_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stream_crew_stream ON stream_crew(stream_id);
`);

// Funeral detail columns on streams — added with ALTER so existing
// databases upgrade in place on the next boot.
{
  const existing = new Set(db.prepare("PRAGMA table_info(streams)").all().map((c) => c.name));
  const cols = {
    venue_name: "TEXT",
    venue_address: "TEXT",
    maps_link: "TEXT",
    contact_name: "TEXT",
    contact_phone: "TEXT",
    arrival_time: "TEXT",
    crew_notes: "TEXT",
    kit_id: "INTEGER REFERENCES kits(id)",
  };
  for (const [name, type] of Object.entries(cols)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE streams ADD COLUMN ${name} ${type}`);
  }
}

// The three funeral kits. Safe to run every boot.
for (const name of ["Kit 1", "Kit 2", "Kit 3"]) {
  db.prepare("INSERT OR IGNORE INTO kits (name) VALUES (?)").run(name);
}

// Optional auto-bootstrap of a staff login from environment variables.
//
// This exists for hosts where you can't run an interactive `npm run setup`
// (e.g. Render's free tier has no Shell access), and it doubles as a safety
// net anywhere the database might get wiped (e.g. Render's free tier has no
// persistent disk, so a fresh empty database appears every time the service
// restarts) — it runs on every boot, so you can always log in with whatever
// ADMIN_EMAIL / ADMIN_PASSWORD is currently set, even after a reset.
//
// Safe to leave set permanently; safe to leave unset (nothing happens).
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const name = process.env.ADMIN_NAME || "Admin";
  const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);

  db.prepare(
    `INSERT INTO staff (name, email, password_hash) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, name = excluded.name`
  ).run(name, email, passwordHash);
}

module.exports = db;
