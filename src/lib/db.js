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

// --- Quotes, invoices & business settings (added Oct 2026) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- One quote and/or one invoice per funeral. Money is stored in cents.
  CREATE TABLE IF NOT EXISTS documents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id         INTEGER NOT NULL REFERENCES streams(id),
    kind              TEXT NOT NULL,            -- 'quote' | 'invoice'
    number            TEXT NOT NULL UNIQUE,     -- e.g. Q0001 / INV0001
    issue_date        TEXT NOT NULL,            -- YYYY-MM-DD
    due_date          TEXT,                     -- quote: valid until; invoice: due date
    bill_to_name      TEXT,
    bill_to_phone     TEXT,
    bill_to_email     TEXT,
    bill_to_address   TEXT,
    package_label     TEXT NOT NULL,
    package_details   TEXT,
    package_cents     INTEGER NOT NULL DEFAULT 0,
    charge_transport  INTEGER NOT NULL DEFAULT 0,
    transport_km      REAL NOT NULL DEFAULT 0,
    transport_rate_cents INTEGER NOT NULL DEFAULT 0,
    extra_label       TEXT,
    extra_cents       INTEGER NOT NULL DEFAULT 0,
    total_cents       INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    paid_at           TEXT,                     -- invoices only
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stream_id, kind)
  );
`);

{
  const existing = new Set(db.prepare("PRAGMA table_info(streams)").all().map((c) => c.name));
  if (!existing.has("lead_source")) db.exec("ALTER TABLE streams ADD COLUMN lead_source TEXT");
  if (!existing.has("extra_gear")) db.exec("ALTER TABLE streams ADD COLUMN extra_gear TEXT");  // JSON [{item, qty}]
  if (!existing.has("branch")) db.exec("ALTER TABLE streams ADD COLUMN branch TEXT NOT NULL DEFAULT 'pretoria'");
  if (!existing.has("recording_embed")) db.exec("ALTER TABLE streams ADD COLUMN recording_embed TEXT"); // YoloLive replay, after the service
  if (!existing.has("chat_enabled")) db.exec("ALTER TABLE streams ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 1");
  const docCols = new Set(db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name));
  if (!docCols.has("gear_items")) db.exec("ALTER TABLE documents ADD COLUMN gear_items TEXT"); // funeral gear lines, synced
  if (!docCols.has("extra_items")) db.exec("ALTER TABLE documents ADD COLUMN extra_items TEXT"); // JSON [{label, qty, unit_cents}]
  if (!docCols.has("prepared_by")) db.exec("ALTER TABLE documents ADD COLUMN prepared_by INTEGER REFERENCES staff(id)");
}

// Defaults fill in keys that are missing or empty, so edits on the
// Business settings page are never overwritten on reboot.
{
  const defaults = {
    business_name: "Orange Productions (Pty) Ltd",
    business_address: "Lyttelton Manor, Centurion, Gauteng",
    business_phone: "071 325 8694",
    business_email: "johan@orangeproductions.co.za",
    business_website: "www.orangeproductions.co.za",
    // Pretoria branch
    bank_name: "Standard Bank",
    bank_branch_name: "Centurion Mall",
    bank_account_holder: "Orange Live",
    bank_account_number: "10 14 701 917 4",
    bank_branch_code: "012645",
    bank_account_type: "Current",
    bank_swift: "SBZAZAJJ",
    // Cape Town branch
    ct_bank_name: "Capitec",
    ct_bank_branch_name: "",
    ct_bank_account_holder: "Orange Broadcast",
    ct_bank_account_number: "1055880003",
    ct_bank_branch_code: "",
    ct_bank_account_type: "Current",
    ct_bank_swift: "CABLZAJJ",
    // Added to the end of the operator's confirmation WhatsApp.
    crew_guidelines_message: "Hi,\nHere's the file \"Orange Cape Town - Funeral Streaming - Freelancer Guidelines and Protocol Document.pdf\" for your review.\nhttps://acrobat.adobe.com/id/urn:aaid:sc:EU:d102ec77-fcf5-4457-b358-34c4ee039d1b\n\nAdd your comments and collaborate with others in real time. You don't need to download Acrobat to access the file.",
    package_label: "Budget Streaming Package",
    package_details:
      "Camera & Streaming Operator (1 person)\nFuneral Streaming Kit – professional Panasonic camera, wireless streaming devices with internet\nSound Kit",
    package_price: "3000",
    transport_rate: "5",
    quote_valid_days: "7",
    invoice_due_days: "0",
    payment_terms: "Payment due before the service. Please use the invoice number as your payment reference.",
    vat_note: "Orange Productions is not VAT registered – no VAT is charged.",
  };
  const ins = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value IS NULL OR settings.value = ''`
  );
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

  // One-off update (Oct 2026): replace the earlier Nedbank details with
  // the Standard Bank (Pretoria) account. Runs once, then never again,
  // so later edits on the Settings page are kept.
  const version = parseInt((db.prepare("SELECT value FROM settings WHERE key = 'settings_version'").get() || {}).value || "1", 10);
  if (version < 2) {
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const k of ["bank_name", "bank_branch_name", "bank_account_holder", "bank_account_number",
                     "bank_branch_code", "bank_account_type", "bank_swift"]) {
      set.run(k, defaults[k]);
    }
    set.run("settings_version", "2");
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
