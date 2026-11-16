// Recordings library (staff only — mounted under /admin/recordings behind the
// staff login): every funeral recorded on the Orange live server, newest
// first, with a thumbnail, who streamed it and who the client was. Click a
// tile to watch it, download it or open the funeral.
//
// Recordings stay watchable here for LIBRARY_DAYS (default 6 months), longer
// than the family's link (RECORDING_DAYS, 28 days). After that the files are
// deleted automatically, but the tile, picture and details stay.

const express = require("express");
const db = require("../lib/db");
const live = require("../lib/liveServer");
const liveJobs = require("../lib/liveJobs");
const media = require("../lib/recordingMedia");
const { fileBase } = require("./recording");

const router = express.Router();
const PER_PAGE = 24;

// "2026-11-16T11:13" (SAST, as typed on the funeral form) -> "Mon 16 Nov 2026 · 11:13"
function fmtService(serviceDate, { long = false } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(serviceDate || "");
  if (!m) return "—";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const date = d.toLocaleDateString("en-ZA", {
    timeZone: "UTC",
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long ? "long" : "short",
    year: "numeric",
  });
  return m[4] ? `${date} · ${m[4]}:${m[5]}` : date;
}

function fmtWhen(isoString) {
  const d = live.dbDate(isoString);
  if (!d) return "";
  return d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtShortDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", year: "numeric" });
}

const thumbUrl = (p) => `/admin/recordings/part/${p.id}/thumb.jpg?v=${encodeURIComponent(p.thumb_pos || 0)}`;

// Parts of these funerals, without the picture bytes.
function partsFor(streamIds) {
  if (!streamIds.length) return new Map();
  const rows = db
    .prepare(
      `SELECT id, stream_id, s3_key, part, size_bytes, started_at, downloads, deleted_at, duration_sec,
              thumb_pos, (thumb IS NOT NULL) AS has_thumb, media_at, media_attempts, media_error
       FROM recordings WHERE stream_id IN (${streamIds.map(() => "?").join(",")}) ORDER BY part`
    )
    .all(...streamIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.stream_id)) map.set(r.stream_id, []);
    map.get(r.stream_id).push(r);
  }
  return map;
}

// Where the recording stands: family link open, staff only, or deleted.
function recordingState(stream, parts, now = new Date()) {
  const hasFiles = parts.some((p) => !p.deleted_at);
  const familyUntil = live.dbDate(stream.recording_expires_at);
  const filesUntil = stream.ended_at ? liveJobs.filesExpireAt(stream) : null;
  if (!hasFiles) {
    const deletedAt = live.dbDate(stream.files_deleted_at) || live.dbDate(parts.map((p) => p.deleted_at).filter(Boolean).sort().pop());
    return { key: "deleted", label: deletedAt ? `Deleted ${fmtShortDate(deletedAt)}` : "Deleted", hasFiles, familyUntil, filesUntil, deletedAt };
  }
  if (stream.recording_status === "ready" && familyUntil && familyUntil > now) {
    return { key: "family", label: `Family link until ${fmtShortDate(familyUntil)}`, hasFiles, familyUntil, filesUntil };
  }
  return { key: "staff", label: `Staff only · until ${fmtShortDate(filesUntil)}`, hasFiles, familyUntil, filesUntil };
}

function summarise(stream, parts) {
  const live_ = parts.filter((p) => !p.deleted_at);
  const withThumb = parts.filter((p) => p.has_thumb).sort((a, b) => b.size_bytes - a.size_bytes);
  const durations = parts.map((p) => p.duration_sec).filter((d) => d !== null && d !== undefined);
  const totalSec = durations.length === parts.length && parts.length ? durations.reduce((a, d) => a + d, 0) : null;
  return {
    parts,
    cover: withThumb[0] ? thumbUrl(withThumb[0]) : null,
    processing: live_.some((p) => !p.media_at && p.media_attempts < 3),
    totalSec,
    duration: media.fmtDuration(totalSec),
    durationWords: media.fmtDurationWords(totalSec),
    size: live.fmtSize(parts.reduce((a, p) => a + (p.size_bytes || 0), 0)),
    downloads: parts.reduce((a, p) => a + (p.downloads || 0), 0),
    state: recordingState(stream, parts),
  };
}

// --------------------------------------------------------------- the library

router.get("/", (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  const home = String(req.query.home || "");
  const show = ["available", "deleted"].includes(req.query.show) ? req.query.show : "";
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);

  const where = [];
  const params = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    where.push(`(s.title LIKE ? OR s.late_name LIKE ? OR s.family_name LIKE ? OR s.contact_name LIKE ?
                 OR s.venue_name LIKE ? OR s.account_client LIKE ? OR s.bb_number LIKE ?
                 OR EXISTS (SELECT 1 FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
                            WHERE sc.stream_id = s.id AND sc.status = 'confirmed' AND c.name LIKE ?))`);
    params.push(like, like, like, like, like, like, like, like);
  }
  if (home === "__private") where.push("(s.account_client IS NULL OR trim(s.account_client) = '')");
  else if (home) {
    where.push("s.account_client = ?");
    params.push(home);
  }
  const having =
    show === "available" ? "HAVING SUM(r.deleted_at IS NULL) > 0" : show === "deleted" ? "HAVING SUM(r.deleted_at IS NULL) = 0" : "";

  const baseSql = `
    FROM streams s
    JOIN recordings r ON r.stream_id = s.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY s.id ${having}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT s.id ${baseSql})`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const streams = db
    .prepare(
      `SELECT s.*, k.name AS kit_name,
              (SELECT GROUP_CONCAT(c.name, ', ') FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
                 WHERE sc.stream_id = s.id AND sc.status = 'confirmed') AS crew_confirmed,
              (SELECT COUNT(*) FROM stream_views sv WHERE sv.stream_id = s.id) AS viewer_count
       ${baseSql.replace("FROM streams s", "FROM streams s LEFT JOIN kits k ON k.id = s.kit_id")}
       ORDER BY (s.service_date IS NULL), s.service_date DESC, s.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, PER_PAGE, (Math.min(page, pages) - 1) * PER_PAGE);

  const byStream = partsFor(streams.map((s) => s.id));
  const cards = streams.map((s) => ({
    ...s,
    when: fmtService(s.service_date),
    ...summarise(s, byStream.get(s.id) || []),
  }));

  const homes = db
    .prepare(
      `SELECT DISTINCT s.account_client AS name FROM streams s
       WHERE s.account_client IS NOT NULL AND trim(s.account_client) != ''
         AND EXISTS (SELECT 1 FROM recordings r WHERE r.stream_id = s.id)
       ORDER BY s.account_client COLLATE NOCASE`
    )
    .all()
    .map((r) => r.name);
  const stored = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS b, COUNT(DISTINCT stream_id) AS n FROM recordings WHERE deleted_at IS NULL").get();

  res.render("admin/recordings", {
    cards,
    total,
    page: Math.min(page, pages),
    pages,
    filters: { q, home, show },
    homes,
    stored: { size: live.fmtSize(stored.b), funerals: stored.n },
    libraryDays: live.libraryDays(),
    recordingDays: live.recordingDays(),
  });
});

// --------------------------------------------------------------- one part's picture / file

function partById(id) {
  return db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) || null;
}

router.get("/part/:id/thumb.jpg", (req, res) => {
  const row = db.prepare("SELECT thumb FROM recordings WHERE id = ?").get(req.params.id);
  if (!row || !row.thumb) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" });
  res.send(row.thumb);
});

router.get("/part/:id/download", async (req, res) => {
  const rec = partById(req.params.id);
  if (!rec) return res.status(404).send("Not found");
  if (rec.deleted_at) return res.status(410).send("This recording has been deleted.");
  const stream = db.prepare("SELECT title FROM streams WHERE id = ?").get(rec.stream_id);
  const total = db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE stream_id = ?").get(rec.stream_id).n;
  const base = fileBase(stream && stream.title);
  try {
    res.redirect(302, await live.downloadUrl(rec.s3_key, total > 1 ? `${base} - part ${rec.part}.mp4` : `${base}.mp4`));
  } catch (err) {
    console.error("[library] download link failed:", err.message);
    res.status(502).send("The download could not be started. Please try again in a minute.");
  }
});

// "Pick another picture": the next spot in the recording.
router.post("/part/:id/thumb", async (req, res) => {
  const rec = partById(req.params.id);
  if (!rec) return res.status(404).send("Not found");
  const stream = db.prepare("SELECT slug FROM streams WHERE id = ?").get(rec.stream_id);
  const back = `/admin/recordings/${stream.slug}?part=${rec.part}`;
  if (rec.deleted_at) return res.redirect(back);
  try {
    const t = await media.newThumbnail(rec);
    db.prepare("UPDATE recordings SET thumb = ?, thumb_pos = ?, media_error = NULL WHERE id = ?").run(t.thumb, t.thumbPos, rec.id);
    res.redirect(back + "&notice=thumb");
  } catch (err) {
    console.error("[library] new thumbnail failed:", err.message);
    res.redirect(back + "&notice=thumb-failed");
  }
});

// --------------------------------------------------------------- one funeral

router.get("/:slug", (req, res) => {
  const stream = db
    .prepare(
      `SELECT s.*, k.name AS kit_name, staff.name AS creator_name
       FROM streams s LEFT JOIN kits k ON k.id = s.kit_id LEFT JOIN staff ON staff.id = s.created_by
       WHERE s.slug = ?`
    )
    .get(req.params.slug);
  if (!stream) return res.status(404).send("Not found");
  const parts = partsFor([stream.id]).get(stream.id) || [];
  if (!parts.length) return res.redirect(`/admin/streams/${stream.slug}`);

  const crew = db
    .prepare(
      `SELECT c.name, c.phone FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
       WHERE sc.stream_id = ? AND sc.status = 'confirmed' ORDER BY c.name`
    )
    .all(stream.id);
  const counts = {
    viewers: db.prepare("SELECT COUNT(*) AS n FROM stream_views WHERE stream_id = ?").get(stream.id).n,
    chat: db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE stream_id = ?").get(stream.id).n,
    thanks: db
      .prepare("SELECT COUNT(*) AS n FROM email_logs WHERE stream_id = ? AND kind = 'thank_you' AND status = 'sent'")
      .get(stream.id).n,
  };

  const info = summarise(stream, parts);
  const wanted = parseInt(req.query.part || "", 10);
  const current = parts.find((p) => p.part === wanted) || parts.find((p) => !p.deleted_at) || parts[0];
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";

  res.render("admin/recording-view", {
    stream,
    when: fmtService(stream.service_date, { long: true }),
    crew,
    counts,
    info,
    parts: parts.map((p) => ({
      ...p,
      thumbUrl: p.has_thumb ? thumbUrl(p) : null,
      duration: media.fmtDuration(p.duration_sec),
      size: live.fmtSize(p.size_bytes),
      src: p.deleted_at ? null : live.playbackUrl(p.s3_key),
    })),
    currentId: current.id,
    familyPage: stream.recording_token && info.state.key === "family" ? `${baseUrl}/recording/${stream.recording_token}` : null,
    familyUntil: live.fmtSastDate(info.state.familyUntil),
    filesUntil: live.fmtSastDate(info.state.filesUntil),
    emailedAt: fmtWhen(stream.family_emailed_at),
    remindedAt: fmtWhen(stream.family_reminded_at),
    notice: req.query.notice || null,
  });
});

module.exports = router;
module.exports._test = { fmtService, recordingState };
