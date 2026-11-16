const express = require("express");
const { nanoid } = require("nanoid");
const db = require("../lib/db");
const crm = require("../lib/crmSync");
const live = require("../lib/liveServer");
const liveJobs = require("../lib/liveJobs");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


// What the video area shows for funerals on the Orange live server (kit
// assigned, no YoloLive embed code). Returns null for YoloLive funerals,
// which keep using the pasted embed codes exactly as before.
function playerFor(stream) {
  if (!liveJobs.isOwnStream(stream)) return null;
  if (!stream.ended_at) {
    const current = liveJobs.currentStreamForKit(stream.kit_id);
    if (current && current.id === stream.id) {
      return { mode: "live", src: live.liveUrlForKit(stream.kit_id), abr: live.abrUrlForKit(stream.kit_id) };
    }
    return { mode: "notyet" };
  }
  if (stream.recording_status === "ready") {
    const parts = db
      .prepare("SELECT id, s3_key, part FROM recordings WHERE stream_id = ? AND deleted_at IS NULL ORDER BY part")
      .all(stream.id)
      .map((r) => ({ part: r.part, src: live.playbackUrl(r.s3_key) }));
    if (parts.length) {
      return { mode: "replay", parts, until: live.fmtSastDate(live.dbDate(stream.recording_expires_at)) };
    }
  }
  if (stream.recording_status === "expired") return { mode: "expired" };
  if (stream.recording_status === "none") return { mode: "norecording" };
  return { mode: "processing" };
}

function isUnlocked(req, streamId) {
  return Boolean(req.session.unlockedStreams && req.session.unlockedStreams[streamId]);
}

// The live player asks every minute whether this page should still show the
// live stream (it stops when staff press End Stream, so viewers never drift
// into the next funeral on the same kit).
router.get("/:slug/state", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).json({ mode: "missing" });
  const p = playerFor(stream);
  res.set("Cache-Control", "no-store").json({ mode: p ? p.mode : "embed" });
});

router.get("/:slug", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).render("watch/not-found");

  const unlocked = isUnlocked(req, stream.id);
  res.render("watch/stream", {
    stream,
    player: playerFor(stream),
    unlocked,
    error: null,
    viewerName: req.session.viewerName || "",
    // Entered their email on an earlier funeral: offer one-click "Continue as …".
    remembered: req.session.viewerEmail ? { name: req.session.viewerName || "", email: req.session.viewerEmail } : null,
    formValues: {},
  });
});

router.post("/:slug", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).render("watch/not-found");

  const name = (req.body.name || "").trim().slice(0, 100);
  const email = (req.body.email || "").trim().toLowerCase().slice(0, 200);

  if (!EMAIL_RE.test(email)) {
    return res.render("watch/stream", {
      stream,
      player: null,
      unlocked: false,
      error: "Please enter a valid email address.",
      viewerName: name,
      remembered: null,
      formValues: { name, email },
    });
  }

  let contact = db.prepare("SELECT * FROM contacts WHERE email = ?").get(email);
  if (!contact) {
    const unsubToken = nanoid(24);
    const info = db
      .prepare("INSERT INTO contacts (email, name, unsub_token) VALUES (?, ?, ?)")
      .run(email, name || null, unsubToken);
    contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(info.lastInsertRowid);
  } else if (name && !contact.name) {
    db.prepare("UPDATE contacts SET name = ? WHERE id = ?").run(name, contact.id);
  }

  db.prepare(
    "INSERT OR IGNORE INTO stream_views (stream_id, contact_id) VALUES (?, ?)"
  ).run(stream.id, contact.id);

  // On to the Orange Platform CRM, in the background — the viewer never waits for it.
  crm.enqueue(email);

  req.session.unlockedStreams = req.session.unlockedStreams || {};
  req.session.unlockedStreams[stream.id] = true;
  req.session.viewerName = name;
  req.session.viewerEmail = email;

  res.redirect(`/watch/${stream.slug}`);
});

module.exports = router;
