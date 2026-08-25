const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const { requireStaff } = require("../lib/auth");
const { makeUniqueSlug } = require("../lib/slug");
const { sendThankYouEmails, sendBroadcast } = require("../lib/emailService");

const router = express.Router();

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

// --- Dashboard ---

router.get("/", (req, res) => {
  const streams = db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM stream_views sv WHERE sv.stream_id = s.id) AS viewer_count
       FROM streams s
       ORDER BY s.created_at DESC`
    )
    .all();
  res.render("admin/dashboard", { streams, staffName: req.session.staffName });
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
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
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

  const publicUrl = `${process.env.BASE_URL || "http://localhost:3000"}/watch/${stream.slug}`;

  res.render("admin/stream-detail", { stream, viewers, publicUrl, notice: req.query.notice || null });
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
