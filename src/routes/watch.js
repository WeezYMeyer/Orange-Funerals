const express = require("express");
const { nanoid } = require("nanoid");
const db = require("../lib/db");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUnlocked(req, streamId) {
  return Boolean(req.session.unlockedStreams && req.session.unlockedStreams[streamId]);
}

router.get("/:slug", (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) return res.status(404).render("watch/not-found");

  const unlocked = isUnlocked(req, stream.id);
  res.render("watch/stream", {
    stream,
    unlocked,
    error: null,
    viewerName: req.session.viewerName || "",
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
      unlocked: false,
      error: "Please enter a valid email address.",
      viewerName: name,
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

  req.session.unlockedStreams = req.session.unlockedStreams || {};
  req.session.unlockedStreams[stream.id] = true;
  req.session.viewerName = name;
  req.session.viewerEmail = email;

  res.redirect(`/watch/${stream.slug}`);
});

module.exports = router;
