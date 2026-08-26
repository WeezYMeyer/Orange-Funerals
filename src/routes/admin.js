const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const { requireStaff } = require("../lib/auth");
const { makeUniqueSlug } = require("../lib/slug");
const { sendThankYouEmails, sendBroadcast } = require("../lib/emailService");

const router = express.Router();

// Works out a simple traffic-light status for a stream's thank-you emails,
// used to color the badge in the dashboard and detail page.
//   'not-ended'  — hasn't ended yet, nothing to show
//   'no-viewers' — ended, but nobody watched, so there's nothing to send
//   'sent'       — ended, everyone who watched got their email (green)
//   'partial'    — ended, some sent, some failed (amber)
//   'failed'     — ended, nothing sent yet / everything failed (red)
function emailStatus(stream) {
  if (!stream.ended_at) return "not-ended";
  if (stream.viewer_count === 0) return "no-viewers";
  if (stream.emails_sent > 0 && stream.emails_failed === 0) return "sent";
  if (stream.emails_sent > 0 && stream.emails_failed > 0) return "partial";
  return "failed";
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
  next();
});

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
              (SELECT COUNT(*) FROM email_logs el WHERE el.stream_id = s.id AND el.kind = 'thank_you' AND el.status = 'failed') AS emails_failed
       FROM streams s
       LEFT JOIN staff ON staff.id = s.created_by
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
  res.render("admin/new-stream", { error: null, form: {} });
});

router.post("/streams/new", (req, res) => {
  const { title, embedCode, serviceDate } = req.body;

  if (!title || !title.trim() || !embedCode || !embedCode.trim()) {
    return res.render("admin/new-stream", {
      error: "Please provide both a title and the embed code.",
      form: req.body,
    });
  }

  const slug = makeUniqueSlug(title);
  db.prepare(
    `INSERT INTO streams (slug, title, embed_code, service_date, created_by) VALUES (?, ?, ?, ?, ?)`
  ).run(slug, title.trim(), embedCode.trim(), serviceDate || null, req.session.staffId);

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

  const publicUrl = `${process.env.BASE_URL || "http://localhost:3000"}/watch/${stream.slug}`;

  res.render("admin/stream-detail", {
    stream,
    viewers,
    publicUrl,
    status,
    notice: req.query.notice || null,
  });
});

router.post("/streams/:slug/end", async (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  if (!stream.ended_at) {
    db.prepare("UPDATE streams SET ended_at = datetime('now') WHERE id = ?").run(stream.id);
  }

  let notice = "ended";
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
  res.render("admin/edit-stream", { stream, error: null, form: null });
});

router.post("/streams/:slug/edit", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  const { title, embedCode, serviceDate } = req.body;
  if (!title || !title.trim() || !embedCode || !embedCode.trim()) {
    return res.render("admin/edit-stream", {
      stream,
      error: "Please provide both a title and the embed code.",
      form: req.body,
    });
  }

  db.prepare(
    `UPDATE streams SET title = ?, embed_code = ?, service_date = ? WHERE id = ?`
  ).run(title.trim(), embedCode.trim(), serviceDate || null, stream.id);

  res.redirect(`/admin/streams/${stream.slug}?notice=updated`);
});

// --- Delete stream ---

router.post("/streams/:slug/delete", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  const deleteAll = db.transaction((streamId) => {
    db.prepare("DELETE FROM email_logs WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM chat_messages WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM stream_views WHERE stream_id = ?").run(streamId);
    db.prepare("DELETE FROM streams WHERE id = ?").run(streamId);
  });
  deleteAll(stream.id);

  res.redirect("/admin?notice=deleted");
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
