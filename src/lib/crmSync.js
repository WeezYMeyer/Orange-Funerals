// Sends Orange Funerals' contacts to the Orange Platform CRM (its Supabase database).
//
// Whenever someone enters their email on a watch page, is billed on a quote or
// invoice, or unsubscribes, their email goes into a small outbox table. A worker
// sends each one across as a full, current snapshot (name, phone, funerals watched,
// funerals booked, unsubscribed) and clears it from the outbox once Supabase accepts
// it. If the platform can't be reached, nothing is lost: the outbox is retried every
// few minutes, and the watch page never waits for it.
//
// Three settings in Render → Environment switch it on:
//   CRM_SUPABASE_URL    https://<project>.supabase.co  (the url in the platform's config.js)
//   CRM_SUPABASE_KEY    the platform's publishable / anon key (the key in config.js)
//   CRM_INGEST_SECRET   the value Supabase gave you from the crm_secrets table
// Without all three the sync stays off and the app works exactly as before.

const fetch = require("node-fetch");
const db = require("./db");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RETRY_EVERY_MS = 5 * 60 * 1000;
const BATCH = 200;

const state = { running: false, lastSyncAt: null, lastError: null, timer: null, soon: null };

function config() {
  return {
    url: String(process.env.CRM_SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    key: String(process.env.CRM_SUPABASE_KEY || "").trim(),
    secret: String(process.env.CRM_INGEST_SECRET || "").trim(),
  };
}
function enabled() {
  const c = config();
  return Boolean(c.url && c.key && c.secret);
}

function cleanEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 200 ? e : null;
}

// SQLite keeps "YYYY-MM-DD HH:MM:SS" in UTC; the platform reads ISO dates.
function iso(sqliteTime) {
  if (!sqliteTime) return null;
  return String(sqliteTime).replace(" ", "T").replace(/(\.\d+)?Z?$/, "Z");
}

// ------------------------------------------------------------------ outbox

const queueStmt = db.prepare(
  `INSERT INTO crm_outbox (email) VALUES (?)
   ON CONFLICT(email) DO UPDATE SET queued_at = datetime('now'), attempts = 0, last_error = NULL`
);

/** Queue one or more emails to be sent to the CRM. Never throws, never waits. */
function enqueue(...emails) {
  try {
    let any = false;
    for (const raw of emails.flat()) {
      const e = cleanEmail(raw);
      if (!e) continue;
      queueStmt.run(e);
      any = true;
    }
    if (any) flushSoon();
  } catch (err) {
    console.error("[crm] could not queue:", err.message);
  }
}

function flushSoon() {
  if (!enabled() || state.soon) return;
  state.soon = setTimeout(() => {
    state.soon = null;
    flush();
  }, 1500);
}

// ---------------------------------------------------------------- snapshot

function snapshot(email) {
  const contact = db.prepare("SELECT * FROM contacts WHERE email = ?").get(email);

  const watched = contact
    ? db
        .prepare(
          `SELECT s.slug, s.title, s.service_date, s.branch, sv.created_at AS viewed_at
           FROM stream_views sv JOIN streams s ON s.id = sv.stream_id
           WHERE sv.contact_id = ?
           ORDER BY s.service_date`
        )
        .all(contact.id)
    : [];

  const booked = db
    .prepare(
      `SELECT s.slug, s.title, s.service_date, s.branch, s.lead_source,
              MAX(d.bill_to_name) AS name, MAX(d.bill_to_phone) AS phone,
              MAX(d.updated_at) AS updated_at,
              MAX(CASE WHEN d.kind = 'invoice' AND d.paid_at IS NOT NULL THEN 2
                       WHEN d.kind = 'invoice' THEN 1 ELSE 0 END) AS st
       FROM documents d JOIN streams s ON s.id = d.stream_id
       WHERE lower(trim(d.bill_to_email)) = ?
       GROUP BY s.id
       ORDER BY s.service_date`
    )
    .all(email);

  // Nothing here mentions this email any more (e.g. its funeral was deleted). Tell the
  // CRM to clear the funeral lists on a record it already has, but not to create one.
  if (!contact && !booked.length) {
    return { email, funeralsWatched: [], funeralsBooked: [], onlyIfExists: true };
  }

  const funeral = (r) => ({
    slug: r.slug,
    title: r.title,
    date: r.service_date ? String(r.service_date).slice(0, 10) : null,
    branch: r.branch === "capetown" ? "Cape Town" : "Pretoria",
  });

  const times = [
    contact && contact.created_at,
    ...watched.map((w) => w.viewed_at),
    ...booked.map((b) => b.updated_at),
  ].filter(Boolean).sort();

  const lastBooked = booked[booked.length - 1];
  return {
    email,
    name: (contact && contact.name) || (lastBooked && lastBooked.name) || "",
    phone: (lastBooked && lastBooked.phone) || "",
    optOut: Boolean(contact && contact.opt_out),
    funeralsWatched: watched.map(funeral),
    funeralsBooked: booked.map((b) => ({
      ...funeral(b),
      status: ["quote", "invoiced", "paid"][b.st] || "quote",
      cameVia: b.lead_source || null,
    })),
    firstSeenAt: iso(times[0]),
    lastSeenAt: iso(times[times.length - 1]),
  };
}

// -------------------------------------------------------------------- send

async function send(contact) {
  const c = config();
  const headers = { apikey: c.key, "content-type": "application/json", accept: "application/json" };
  // Legacy anon keys are JWTs and go in Authorization too; the newer sb_publishable_
  // keys only go in the apikey header.
  if (c.key.startsWith("eyJ")) headers.Authorization = `Bearer ${c.key}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${c.url}/rest/v1/rpc/crm_upsert_contact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ secret: c.secret, contact }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    // Wrong secret / key, or the SQL hasn't been run: retrying won't help until it's fixed.
    if (res.status === 404 || /crm_upsert_contact/i.test(body)) {
      return { ok: false, fatal: true, error: `Orange Platform's database doesn't have the contact intake yet: run the latest schema.sql in Supabase (HTTP ${res.status})` };
    }
    if (res.status === 401 || res.status === 403 || /not allowed/i.test(body)) {
      return { ok: false, fatal: true, error: `Orange Platform turned the key or secret down: check CRM_SUPABASE_KEY and CRM_INGEST_SECRET in Render (HTTP ${res.status})` };
    }
    return { ok: false, fatal: false, error: `HTTP ${res.status} ${body.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, fatal: false, error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function flush() {
  if (!enabled() || state.running) return;
  state.running = true;
  try {
    const rows = db.prepare("SELECT email, queued_at FROM crm_outbox ORDER BY queued_at LIMIT ?").all(BATCH);
    let sent = 0;
    for (const row of rows) {
      const snap = snapshot(row.email);
      const result = await send(snap);
      if (result.ok) {
        // Only clear it if it wasn't queued again while we were sending.
        db.prepare("DELETE FROM crm_outbox WHERE email = ? AND queued_at = ?").run(row.email, row.queued_at);
        sent++;
        state.lastSyncAt = new Date().toISOString();
        state.lastError = null;
      } else {
        db.prepare("UPDATE crm_outbox SET attempts = attempts + 1, last_error = ? WHERE email = ?").run(
          result.error,
          row.email
        );
        state.lastError = result.error;
        console.error(`[crm] could not send ${row.email}: ${result.error}`);
        if (result.fatal) break; // fix the settings first; everything stays queued
      }
    }
    if (sent) console.log(`[crm] sent ${sent} contact(s) to Orange Platform`);
    // A full batch means there may be more waiting.
    if (rows.length === BATCH && !state.lastError) setImmediate(flush);
  } catch (err) {
    state.lastError = err.message;
    console.error("[crm] sync stopped:", err.message);
  } finally {
    state.running = false;
  }
}

// --------------------------------------------------------------- backfill

/** Queue every contact and every billed email (used once, and by "Sync everything again"). */
function enqueueAll() {
  const fromViewers = db.prepare("SELECT email FROM contacts").all().map((r) => r.email);
  const fromDocs = db
    .prepare("SELECT DISTINCT lower(trim(bill_to_email)) AS email FROM documents WHERE bill_to_email IS NOT NULL AND trim(bill_to_email) != ''")
    .all()
    .map((r) => r.email);
  const all = [...new Set([...fromViewers, ...fromDocs])];
  enqueue(all);
  return all.length;
}

function start() {
  if (!enabled()) {
    console.log("[crm] sync to Orange Platform is off (set CRM_SUPABASE_URL, CRM_SUPABASE_KEY, CRM_INGEST_SECRET)");
    return;
  }
  // The first time the sync is switched on, send everyone who is already here.
  const done = db.prepare("SELECT value FROM settings WHERE key = 'crm_backfilled_at'").get();
  if (!done || !done.value) {
    const n = enqueueAll();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('crm_backfilled_at', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();
    console.log(`[crm] first run: queued ${n} existing contact(s)`);
  }
  console.log("[crm] sync to Orange Platform is on");
  flush();
  state.timer = setInterval(flush, RETRY_EVERY_MS);
}

function status() {
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM crm_outbox").get().n;
  const failing = db.prepare("SELECT COUNT(*) AS n FROM crm_outbox WHERE attempts > 0").get().n;
  return { enabled: enabled(), waiting, failing, lastSyncAt: state.lastSyncAt, lastError: state.lastError };
}

module.exports = { enqueue, enqueueAll, flush, start, status, snapshot };
