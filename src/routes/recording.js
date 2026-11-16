// The family's private recording page: /recording/<token>
// Linked from the family email. Shows every part of the recording with a
// player and a Download button, until the expiry date. No email gate - the
// long random token in the link is the key.
const express = require("express");
const db = require("../lib/db");
const live = require("../lib/liveServer");

const router = express.Router();

function load(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || "")) return null;
  return db.prepare("SELECT * FROM streams WHERE recording_token = ?").get(token) || null;
}

function isExpired(stream) {
  if (stream.recording_status === "expired") return true;
  const until = live.dbDate(stream.recording_expires_at);
  return Boolean(until && until <= new Date());
}

// "Service for Pieter Ëloff" -> "Service for Pieter Eloff" (safe as a file name)
function fileBase(title) {
  const ascii = String(title || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ascii || "Recording";
}

router.get("/:token", (req, res) => {
  const stream = load(req.params.token);
  if (!stream) return res.status(404).render("watch/not-found");
  const expired = isExpired(stream);
  const parts = expired
    ? []
    : db
        .prepare("SELECT * FROM recordings WHERE stream_id = ? AND deleted_at IS NULL ORDER BY part")
        .all(stream.id)
        .map((r) => ({ id: r.id, part: r.part, src: live.playbackUrl(r.s3_key), size: live.fmtSize(r.size_bytes) }));
  res.set("Cache-Control", "no-store");
  res.render("recording/page", {
    stream,
    parts,
    expired,
    until: live.fmtSastDate(live.dbDate(stream.recording_expires_at)),
    token: req.params.token,
  });
});

router.get("/:token/download/:id", async (req, res) => {
  const stream = load(req.params.token);
  if (!stream) return res.status(404).send("Not found");
  if (isExpired(stream)) return res.status(410).send("This recording is no longer available.");
  const rec = db
    .prepare("SELECT * FROM recordings WHERE id = ? AND stream_id = ? AND deleted_at IS NULL")
    .get(req.params.id, stream.id);
  if (!rec) return res.status(404).send("Not found");
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM recordings WHERE stream_id = ? AND deleted_at IS NULL")
    .get(stream.id).n;
  const base = fileBase(stream.title);
  const filename = total > 1 ? `${base} - part ${rec.part}.mp4` : `${base}.mp4`;
  try {
    const url = await live.downloadUrl(rec.s3_key, filename);
    db.prepare("UPDATE recordings SET downloads = downloads + 1 WHERE id = ?").run(rec.id);
    res.redirect(302, url);
  } catch (err) {
    console.error("[recording] download link failed:", err.message);
    res.status(502).send("The download could not be started. Please try again in a minute.");
  }
});

module.exports = router;
module.exports.fileBase = fileBase;
