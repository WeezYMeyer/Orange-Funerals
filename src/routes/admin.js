const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const { requireStaff } = require("../lib/auth");
const { makeUniqueSlug } = require("../lib/slug");
const { sendThankYouEmails, sendBroadcast } = require("../lib/emailService");
const msg = require("../lib/crewMessages");
const crm = require("../lib/crmSync");

const router = express.Router();

// Works out a simple traffic-light status for a stream's thank-you emails,
// used to color the badge in the dashboard and detail page.
//   'not-ended'  — hasn't ended yet, nothing to show
//   'no-viewers' — ended, but nobody watched, so there's nothing to send
//   'sent'       — ended, everyone who watched got their email (green)
//   'partial'    — ended, some sent, some failed (amber)
//   'pending'    — ended, emails not sent yet (waiting for the recording)
//   'failed'     — ended, sending was tried and everything failed (red)
function emailStatus(stream) {
  if (!stream.ended_at) return "not-ended";
  if (stream.viewer_count === 0) return "no-viewers";
  if (!stream.emails_sent && !stream.emails_failed) return "pending";
  if (stream.emails_sent > 0 && stream.emails_failed === 0) return "sent";
  if (stream.emails_sent > 0 && stream.emails_failed > 0) return "partial";
  return "failed";
}

// --- Funeral details helpers ---

function allKits() {
  return db.prepare("SELECT * FROM kits ORDER BY name").all();
}

// Previously used "where it came from" values, offered as suggestions.
function allSources() {
  return db
    .prepare("SELECT DISTINCT lead_source AS s FROM streams WHERE lead_source IS NOT NULL AND lead_source != '' ORDER BY lead_source COLLATE NOCASE")
    .all()
    .map((r) => r.s);
}

function publicUrlFor(stream) {
  return `${process.env.BASE_URL || "http://localhost:3000"}/watch/${stream.slug}`;
}

// Extra gear rows: gearItem[] + gearQty[] + gearPrice[] -> [{ item, qty, price_cents }]
// Entered once on the funeral; quotes and invoices pull these lines in automatically.
function readGear(body) {
  const items = [].concat(body.gearItem || []);
  const qtys = [].concat(body.gearQty || []);
  const prices = [].concat(body.gearPrice || []);
  const cents = (v) => {
    const n = parseFloat(String(v || "").replace(/[R\s]/gi, "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  };
  return items
    .map((item, i) => ({
      item: String(item || "").trim().slice(0, 120),
      qty: String(qtys[i] || "").trim().slice(0, 10),
      price_cents: cents(prices[i]),
    }))
    .filter((g) => g.item);
}

function parseGear(json) {
  try {
    const g = JSON.parse(json || "[]");
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
}

// Reads and validates the stream form (title, embed, date + funeral details).
function readStreamForm(body) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  const f = {
    title: clean(body.title),
    embedCode: clean(body.embedCode),
    serviceDate: clean(body.serviceDate),
    venueName: clean(body.venueName),
    venueAddress: clean(body.venueAddress),
    mapsLink: clean(body.mapsLink),
    contactName: clean(body.contactName),
    contactPhone: clean(body.contactPhone),
    arrivalTime: clean(body.arrivalTime),
    crewNotes: clean(body.crewNotes),
    kitId: body.kitId ? parseInt(body.kitId, 10) || null : null,
    leadSource: clean(body.leadSource),
    branch: body.branch === "capetown" ? "capetown" : "pretoria",
    chatEnabled: [].concat(body.chatEnabled || []).includes("1") ? 1 : 0,
    gear: readGear(body),
  };
  const missing = [];
  if (!f.title) missing.push("title");
  if (!f.serviceDate) missing.push("service date & time");
  if (!f.venueName) missing.push("venue name");
  if (!f.mapsLink) missing.push("Google Maps link");
  let error = null;
  if (missing.length) error = `Please fill in: ${missing.join(", ")}.`;
  else if (!/^https?:\/\//i.test(f.mapsLink)) error = "The Google Maps link should start with https:// — copy it from Google Maps' Share button.";
  return { f, error };
}

function streamFormValues(f) {
  return [f.title, f.embedCode, f.serviceDate || null, f.venueName || null, f.venueAddress || null,
    f.mapsLink || null, f.contactName || null, f.contactPhone || null, f.arrivalTime || null,
    f.crewNotes || null, f.kitId, f.leadSource || null,
    f.gear.length ? JSON.stringify(f.gear) : null, f.branch, f.chatEnabled];
}

// Other funerals on the same day using the same kit.
function kitClashes(stream) {
  if (!stream.kit_id || !stream.service_date) return [];
  return db
    .prepare(
      `SELECT slug, title, service_date FROM streams
       WHERE kit_id = ? AND id != ? AND substr(service_date, 1, 10) = substr(?, 1, 10)`
    )
    .all(stream.kit_id, stream.id || 0, stream.service_date);
}

// --- Auth ---

router.get("/login", (req, res) => {
  if (req.session.staffId) return res.redirect("/admin");
  res.render("admin/login", { error: null });
});

router.post("/login", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const staff = db.prepare("SELECT * FROM staff WHERE email = ?").get(email);

  if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
    return res.render("admin/login", { error: "Incorrect email or password." });
  }

  req.session.staffId = staff.id;
  req.session.staffName = staff.name;
  res.redirect("/admin");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

router.use(requireStaff);

// Makes the current path available to every admin view without having to
// thread it through each individual res.render() call — used by
// admin-nav.ejs to highlight which nav link is active.
router.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.signedInName = req.session.staffName;
  next();
});

// Quotes, invoices, finance & business settings.
const billing = require("./billing");
router.use(billing);

// --- Dashboard ---
// Two tabs: "Upcoming" (default — anything not yet ended, i.e. still to
// happen or currently live) and "Past" (ended streams, for looking
// something up later). Every staff login sees the same shared list.

router.get("/", (req, res) => {
  const tab = req.query.tab === "past" ? "past" : "upcoming";
  const sort = req.query.sort === "desc" ? "desc" : "asc";

  const whereClause = tab === "past" ? "s.ended_at IS NOT NULL" : "s.ended_at IS NULL";
  // Upcoming defaults soonest-first; Past defaults most-recent-first — flipped by the sort toggle.
  const defaultDirection = tab === "past" ? "DESC" : "ASC";
  const direction = sort === "desc" ? (defaultDirection === "ASC" ? "DESC" : "ASC") : defaultDirection;

  const streams = db
    .prepare(
      `SELECT s.*,
              staff.name AS creator_name,
              (SELECT COUNT(*) FROM stream_views sv WHERE sv.stream_id = s.id) AS viewer_count,
              (SELECT COUNT(*) FROM email_logs el WHERE el.stream_id = s.id AND el.kind = 'thank_you' AND el.status = 'sent') AS emails_sent,
              (SELECT COUNT(*) FROM email_logs el WHERE el.stream_id = s.id AND el.kind = 'thank_you' AND el.status = 'failed') AS emails_failed,
              (SELECT GROUP_CONCAT(c.name, ', ') FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
                 WHERE sc.stream_id = s.id AND sc.status = 'confirmed') AS crew_confirmed,
              (SELECT COUNT(*) FROM stream_crew sc WHERE sc.stream_id = s.id AND sc.status = 'asked') AS crew_asked,
              k.name AS kit_name
       FROM streams s
       LEFT JOIN staff ON staff.id = s.created_by
       LEFT JOIN kits k ON k.id = s.kit_id
       WHERE ${whereClause}
       ORDER BY (s.service_date IS NULL), s.service_date ${direction}, s.created_at ${direction}`
    )
    .all()
    .map((s) => ({ ...s, status: emailStatus(s) }));

  res.render("admin/dashboard", {
    streams,
    staffName: req.session.staffName,
    tab,
    sort,
    notice: req.query.notice || null,
  });
});

// --- New stream ---

router.get("/streams/new", (req, res) => {
  res.render("admin/new-stream", { error: null, form: {}, kits: allKits(), sources: allSources() });
});

router.post("/streams/new", (req, res) => {
  const { f, error } = readStreamForm(req.body);
  if (error) {
    return res.render("admin/new-stream", { error, form: f, kits: allKits(), sources: allSources() });
  }

  const slug = makeUniqueSlug(f.title);
  db.prepare(
    `INSERT INTO streams (title, embed_code, service_date, venue_name, venue_address, maps_link,
       contact_name, contact_phone, arrival_time, crew_notes, kit_id, lead_source, extra_gear, branch, chat_enabled, slug, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(...streamFormValues(f), slug, req.session.staffId);

  const created = db.prepare("SELECT id FROM streams WHERE slug = ?").get(slug);
  if (created) billing.syncDocsForStream(created.id);
  res.redirect(`/admin/streams/${slug}`);
});

// --- Stream detail ---

router.get("/streams/:slug", (req, res) => {
  const stream = db
    .prepare(
      `SELECT s.*, staff.name AS creator_name
       FROM streams s
       LEFT JOIN staff ON staff.id = s.created_by
       WHERE s.slug = ?`
    )
    .get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  const viewers = db
    .prepare(
      `SELECT c.email, c.name, sv.created_at
       FROM stream_views sv
       JOIN contacts c ON c.id = sv.contact_id
       WHERE sv.stream_id = ?
       ORDER BY sv.created_at ASC`
    )
    .all(stream.id);

  const emailCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM email_logs WHERE stream_id = ? AND kind = 'thank_you'`
    )
    .get(stream.id);

  const status = emailStatus({
    ended_at: stream.ended_at,
    viewer_count: viewers.length,
    emails_sent: emailCounts.sent || 0,
    emails_failed: emailCounts.failed || 0,
  });

  const publicUrl = publicUrlFor(stream);
  stream.gear = parseGear(stream.extra_gear);
  const guidelines = (db.prepare("SELECT value FROM settings WHERE key = 'crew_guidelines_message'").get() || {}).value || "";
  const kit = stream.kit_id ? db.prepare("SELECT * FROM kits WHERE id = ?").get(stream.kit_id) : null;

  const assignments = db
    .prepare(
      `SELECT sc.*, c.name, c.phone, c.notes AS crew_notes_profile, c.own_vehicle AS crew_own_vehicle
       FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
       WHERE sc.stream_id = ?
       ORDER BY CASE sc.status WHEN 'confirmed' THEN 0 WHEN 'asked' THEN 1 WHEN 'shortlisted' THEN 2 ELSE 3 END, c.name`
    )
    .all(stream.id)
    .map((a) => {
      const crew = { name: a.name, phone: a.phone };
      return {
        ...a,
        askLink: msg.waLink(a.phone, msg.availabilityMessage({ stream, crew })),
        confirmLink: msg.waLink(a.phone, msg.confirmationMessage({ stream, crew, assignment: a, kit, publicUrl, guidelines })),
      };
    });

  const availableCrew = db
    .prepare(
      `SELECT * FROM crew WHERE active = 1
       AND id NOT IN (SELECT crew_id FROM stream_crew WHERE stream_id = ?)
       ORDER BY name`
    )
    .all(stream.id);

  res.render("admin/stream-detail", {
    stream,
    viewers,
    publicUrl,
    status,
    kit,
    clashes: kitClashes(stream),
    assignments,
    availableCrew,
    fmtDateLong: msg.fmtDateLong,
    chatMessages: db
      .prepare("SELECT id, name, body, created_at FROM chat_messages WHERE stream_id = ? ORDER BY id DESC LIMIT 300")
      .all(stream.id),
    docs: Object.fromEntries(
      db.prepare("SELECT * FROM documents WHERE stream_id = ?").all(stream.id).map((d) => [d.kind, d])
    ),
    notice: req.query.notice || null,
  });
});

// Step 1 after the service: end the stream. Thank-you emails are sent
// separately, once YoloLive's recording embed code has been added.
router.post("/streams/:slug/end", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");
  if (!stream.ended_at) {
    db.prepare("UPDATE streams SET ended_at = datetime('now') WHERE id = ?").run(stream.id);
  }
  res.redirect(`/admin/streams/${stream.slug}?notice=ended#after`);
});

// Step 2: the recording. YoloLive gives a different embed code for the replay;
// once saved, the same watch link plays the recording instead of the live feed.
router.post("/streams/:slug/recording", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");
  const code = String(req.body.recordingEmbed || "").trim();
  db.prepare("UPDATE streams SET recording_embed = ? WHERE id = ?").run(code || null, stream.id);
  res.redirect(`/admin/streams/${stream.slug}?notice=${code ? "recording-saved" : "recording-removed"}#after`);
});

// Step 3: send the thank-you emails (same as retry: never emails anyone twice).
router.post("/streams/:slug/send-thanks", async (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");
  if (!stream.ended_at) {
    db.prepare("UPDATE streams SET ended_at = datetime('now') WHERE id = ?").run(stream.id);
  }
  let notice;
  try {
    const result = await sendThankYouEmails(stream.id);
    notice = result.alreadySent ? "already-sent" : `thanks-sent-${result.sent}-${result.failed}-${result.skipped}`;
  } catch (err) {
    notice = `email-error-${encodeURIComponent(err.message)}`;
  }
  res.redirect(`/admin/streams/${stream.slug}?notice=${notice}#after`);
});

// Retries the thank-you send — only to contacts who don't already have a
// successful send logged, so this is safe to click after a partial failure
// without double-emailing anyone who already got theirs.
router.post("/streams/:slug/resend-thanks", async (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  let notice;
  try {
    const result = await sendThankYouEmails(stream.id);
    notice = result.alreadySent
      ? "already-sent"
      : `thanks-sent-${result.sent}-${result.failed}-${result.skipped}`;
  } catch (err) {
    notice = `email-error-${encodeURIComponent(err.message)}`;
  }

  res.redirect(`/admin/streams/${stream.slug}?notice=${notice}`);
});

// --- Edit stream (title / embed code / date-time) ---
// The slug never changes here, so a link you've already sent out keeps
// working even after you update the embed code.

router.get("/streams/:slug/edit", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");
  res.render("admin/edit-stream", { stream, error: null, form: null, kits: allKits(), sources: allSources() });
});

router.post("/streams/:slug/edit", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  const { f, error } = readStreamForm(req.body);
  if (error) {
    return res.render("admin/edit-stream", { stream, error, form: f, kits: allKits(), sources: allSources() });
  }

  db.prepare(
    `UPDATE streams SET title = ?, embed_code = ?, service_date = ?, venue_name = ?, venue_address = ?,
       maps_link = ?, contact_name = ?, contact_phone = ?, arrival_time = ?, crew_notes = ?, kit_id = ?,
       lead_source = ?, extra_gear = ?, branch = ?, chat_enabled = ?
     WHERE id = ?`
  ).run(...streamFormValues(f), stream.id);
  broadcastChatState(req, stream.slug, f.chatEnabled);
  billing.syncDocsForStream(stream.id); // gear changes flow into the quote/invoice

  res.redirect(`/admin/streams/${stream.slug}?notice=updated`);
});

// --- Delete stream ---

router.post("/streams/:slug/delete", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  // Who this funeral touched, so their CRM records drop it once it's gone.
  const touched = [
    ...db.prepare("SELECT c.email FROM stream_views sv JOIN contacts c ON c.id = sv.contact_id WHERE sv.stream_id = ?").all(stream.id).map((r) => r.email),
    ...billing.billedEmails(stream.id),
  ];

  const deleteAll = db.transaction((streamId) => {
    db.prepare("DELETE FROM email_logs WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM chat_messages WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM stream_views WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM stream_crew WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM chat_messages WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM documents WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM streams WHERE id = ?").run(streamId);
  });
  deleteAll(stream.id);
  crm.enqueue(touched);

  res.redirect("/admin?notice=deleted");
});

// --- Live chat moderation ---

// Tell everyone watching this stream right now that chat was switched on/off.
function broadcastChatState(req, slug, enabled) {
  const io = req.app.get("io");
  if (io) io.to(`stream:${slug}`).emit("chat:state", { enabled: Boolean(enabled) });
}

router.post("/streams/:slug/chat/toggle", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");
  const next = stream.chat_enabled ? 0 : 1;
  db.prepare("UPDATE streams SET chat_enabled = ? WHERE id = ?").run(next, stream.id);
  broadcastChatState(req, stream.slug, next);
  res.redirect(`/admin/streams/${stream.slug}#chat`);
});

router.post("/streams/:slug/chat/:id/delete", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");
  const id = parseInt(req.params.id, 10);
  db.prepare("DELETE FROM chat_messages WHERE id = ? AND stream_id = ?").run(id, stream.id);
  const io = req.app.get("io");
  if (io) io.to(`stream:${stream.slug}`).emit("chat:deleted", { id });
  res.redirect(`/admin/streams/${stream.slug}#chat`);
});

// --- Operators on a funeral ---

function findStream(req, res) {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) res.status(404).send("Stream not found");
  return stream;
}

router.post("/streams/:slug/crew/add", (req, res) => {
  const stream = findStream(req, res);
  if (!stream) return;
  const ids = [].concat(req.body.crewIds || []).map((n) => parseInt(n, 10)).filter(Boolean);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO stream_crew (stream_id, crew_id, uses_own_vehicle)
     SELECT ?, id, own_vehicle FROM crew WHERE id = ? AND active = 1`
  );
  for (const id of ids) insert.run(stream.id, id);
  res.redirect(`/admin/streams/${stream.slug}#crew`);
});

// action: ask | confirm | decline | reset | remove | vehicle-yes | vehicle-no
router.post("/streams/:slug/crew/:id/:action", (req, res) => {
  const stream = findStream(req, res);
  if (!stream) return;
  const id = parseInt(req.params.id, 10);
  const where = "WHERE id = ? AND stream_id = ?";
  const run = (sql) => db.prepare(sql + " " + where).run(id, stream.id);

  switch (req.params.action) {
    case "ask":
      // Don't downgrade someone already confirmed if the button is clicked again.
      run(`UPDATE stream_crew SET status = CASE WHEN status = 'confirmed' THEN status ELSE 'asked' END,
             asked_at = COALESCE(asked_at, datetime('now'))`);
      break;
    case "confirm":
      run(`UPDATE stream_crew SET status = 'confirmed', confirmed_at = datetime('now')`);
      break;
    case "decline":
      run(`UPDATE stream_crew SET status = 'declined'`);
      break;
    case "reset":
      run(`UPDATE stream_crew SET status = 'shortlisted', confirmed_at = NULL`);
      break;
    case "remove":
      db.prepare("DELETE FROM stream_crew " + where).run(id, stream.id);
      break;
    case "vehicle-yes":
      run(`UPDATE stream_crew SET uses_own_vehicle = 1`);
      break;
    case "vehicle-no":
      run(`UPDATE stream_crew SET uses_own_vehicle = 0`);
      break;
    default:
      return res.status(400).send("Unknown action");
  }
  res.redirect(`/admin/streams/${stream.slug}#crew`);
});

// --- Crew (camera operators) ---

router.get("/crew", (req, res) => {
  const crew = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM stream_crew sc JOIN streams s ON s.id = sc.stream_id
            WHERE sc.crew_id = c.id AND sc.status = 'confirmed' AND s.ended_at IS NULL) AS upcoming
       FROM crew c WHERE c.active = 1 ORDER BY c.name`
    )
    .all();
  const editing = req.query.edit ? crew.find((c) => c.id === parseInt(req.query.edit, 10)) || null : null;
  res.render("admin/crew", { crew, editing, error: null, form: {}, notice: req.query.notice || null });
});

function readCrewForm(body) {
  const f = {
    name: String(body.name || "").trim(),
    phone: String(body.phone || "").trim(),
    ownVehicle: body.ownVehicle === "1" ? 1 : 0,
    notes: String(body.notes || "").trim(),
  };
  let error = null;
  if (!f.name || !f.phone) error = "Please enter a name and a WhatsApp number.";
  else if (msg.waNumber(f.phone).length < 10) error = "That WhatsApp number looks too short — use e.g. 082 123 4567.";
  return { f, error };
}

function renderCrewError(res, error, form, editing) {
  const crew = db.prepare("SELECT *, 0 AS upcoming FROM crew WHERE active = 1 ORDER BY name").all();
  res.render("admin/crew", { crew, editing, error, form, notice: null });
}

router.post("/crew", (req, res) => {
  const { f, error } = readCrewForm(req.body);
  if (error) return renderCrewError(res, error, f, null);
  db.prepare("INSERT INTO crew (name, phone, own_vehicle, notes) VALUES (?, ?, ?, ?)").run(
    f.name, f.phone, f.ownVehicle, f.notes || null
  );
  res.redirect("/admin/crew?notice=added");
});

router.post("/crew/:id/edit", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare("SELECT * FROM crew WHERE id = ? AND active = 1").get(id);
  if (!existing) return res.status(404).send("Crew member not found");
  const { f, error } = readCrewForm(req.body);
  if (error) return renderCrewError(res, error, f, existing);
  db.prepare("UPDATE crew SET name = ?, phone = ?, own_vehicle = ?, notes = ? WHERE id = ?").run(
    f.name, f.phone, f.ownVehicle, f.notes || null, id
  );
  res.redirect("/admin/crew?notice=updated");
});

// Hidden rather than deleted, so past funerals still show who worked them.
router.post("/crew/:id/remove", (req, res) => {
  db.prepare("UPDATE crew SET active = 0 WHERE id = ?").run(parseInt(req.params.id, 10));
  res.redirect("/admin/crew?notice=removed");
});

// --- Calendar ---

router.get("/calendar", (req, res) => {
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || "");
  const year = m ? +m[1] : now.getFullYear();
  const month = m ? +m[2] : now.getMonth() + 1; // 1-12
  const pad = (n) => String(n).padStart(2, "0");
  const monthKey = `${year}-${pad(month)}`;

  const streams = db
    .prepare(
      `SELECT s.slug, s.title, s.service_date, s.venue_name, s.ended_at, k.name AS kit_name,
         (SELECT GROUP_CONCAT(c.name, ', ') FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
            WHERE sc.stream_id = s.id AND sc.status = 'confirmed') AS crew_confirmed,
         (SELECT COUNT(*) FROM stream_crew sc WHERE sc.stream_id = s.id AND sc.status = 'asked') AS crew_asked
       FROM streams s LEFT JOIN kits k ON k.id = s.kit_id
       WHERE substr(s.service_date, 1, 7) = ?
       ORDER BY s.service_date`
    )
    .all(monthKey);

  const byDay = {};
  for (const s of streams) {
    const p = msg.parseServiceDate(s.service_date);
    if (!p) continue;
    (byDay[p.day] = byDay[p.day] || []).push({ ...s, time: p.time });
  }

  // Monday-first grid.
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const prev = month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  res.render("admin/calendar", {
    cells,
    byDay,
    monthLabel: `${["January","February","March","April","May","June","July","August","September","October","November","December"][month - 1]} ${year}`,
    prev,
    next,
    today: monthKey === todayKey ? now.getDate() : null,
    total: streams.length,
  });
});

// --- Staff logins ---
// Each person gets their own login, so "Loaded by" on streams and
// "Prepared by" on quotes/invoices show who actually did it.

router.get("/staff", (req, res) => {
  const staff = db.prepare("SELECT id, name, email, created_at FROM staff ORDER BY name").all();
  res.render("admin/staff", {
    staff,
    meId: req.session.staffId,
    adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post("/staff", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !email || password.length < 8) {
    return res.redirect("/admin/staff?error=" + encodeURIComponent("Enter a name, email and a password of at least 8 characters."));
  }
  if (db.prepare("SELECT 1 FROM staff WHERE email = ?").get(email)) {
    return res.redirect("/admin/staff?error=" + encodeURIComponent("There's already a login with that email."));
  }
  db.prepare("INSERT INTO staff (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, bcrypt.hashSync(password, 12));
  res.redirect("/admin/staff?notice=added");
});

router.post("/staff/:id/name", (req, res) => {
  const name = String(req.body.name || "").trim();
  const id = parseInt(req.params.id, 10);
  if (name) {
    db.prepare("UPDATE staff SET name = ? WHERE id = ?").run(name, id);
    if (id === req.session.staffId) req.session.staffName = name;
  }
  res.redirect("/admin/staff?notice=renamed");
});

router.post("/staff/:id/password", (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8) {
    return res.redirect("/admin/staff?error=" + encodeURIComponent("Passwords need at least 8 characters."));
  }
  db.prepare("UPDATE staff SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), parseInt(req.params.id, 10));
  res.redirect("/admin/staff?notice=password");
});

router.post("/staff/:id/remove", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.staffId) {
    return res.redirect("/admin/staff?error=" + encodeURIComponent("You can't remove the login you're signed in with."));
  }
  // Keep their name on things they created, but stop the login working.
  const used =
    db.prepare("SELECT 1 FROM streams WHERE created_by = ? UNION SELECT 1 FROM documents WHERE prepared_by = ?").get(id, id);
  if (used) {
    db.prepare("UPDATE staff SET password_hash = '!', email = email || '.removed.' || id WHERE id = ?").run(id);
  } else {
    db.prepare("DELETE FROM staff WHERE id = ?").run(id);
  }
  res.redirect("/admin/staff?notice=removed");
});

// --- Broadcast ---

router.get("/broadcast", (req, res) => {
  const contactCount = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE opt_out = 0").get().n;
  res.render("admin/broadcast", { error: null, sentSummary: null, contactCount, form: {} });
});

router.post("/broadcast", async (req, res) => {
  const { subjectLine, message } = req.body;
  const contactCount = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE opt_out = 0").get().n;

  if (!subjectLine || !subjectLine.trim() || !message || !message.trim()) {
    return res.render("admin/broadcast", {
      error: "Please provide both a subject and a message.",
      sentSummary: null,
      contactCount,
      form: req.body,
    });
  }

  // Preserve line breaks from the plain-text textarea as paragraphs.
  const messageHtml = message
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const result = await sendBroadcast({ subjectLine: subjectLine.trim(), messageHtml });

  res.render("admin/broadcast", {
    error: null,
    sentSummary: result,
    contactCount,
    form: {},
  });
});

module.exports = router;
