// Read-only feed of funerals for Orange Platform's calendar.
//
//   GET /api/funerals?key=<PLATFORM_FEED_KEY>
//
// Job details only — no prices, client phone numbers or viewer emails.
// The key lives in Render's environment (PLATFORM_FEED_KEY) so it survives
// restarts; without it the feed is switched off.

const express = require("express");
const crypto = require("crypto");
const db = require("../lib/db");
const { parseServiceDate } = require("../lib/crewMessages");

const router = express.Router();

// Orange Platform runs on a different web address, so the browser needs
// permission (CORS) to read this. The key, not the origin, is what protects it.
router.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function keyMatches(given) {
  const expected = process.env.PLATFORM_FEED_KEY || "";
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseGear(json) {
  try {
    const g = JSON.parse(json || "[]");
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
}

router.get("/funerals", (req, res) => {
  if (!process.env.PLATFORM_FEED_KEY) {
    return res.status(503).json({ error: "Feed is switched off: set PLATFORM_FEED_KEY in Render." });
  }
  if (!keyMatches(req.query.key)) {
    return res.status(401).json({ error: "Wrong or missing key." });
  }

  const base = process.env.BASE_URL || "";
  const rows = db
    .prepare(
      `SELECT s.*, k.name AS kit_name,
         (SELECT GROUP_CONCAT(c.name, ', ') FROM stream_crew sc JOIN crew c ON c.id = sc.crew_id
            WHERE sc.stream_id = s.id AND sc.status = 'confirmed') AS operators,
         (SELECT COUNT(*) FROM stream_crew sc WHERE sc.stream_id = s.id AND sc.status = 'asked') AS asked
       FROM streams s LEFT JOIN kits k ON k.id = s.kit_id
       WHERE s.service_date IS NOT NULL AND s.service_date != ''
         AND substr(s.service_date, 1, 10) >= date('now', '-120 days')
       ORDER BY s.service_date`
    )
    .all();

  const funerals = rows.map((s) => {
    const p = parseServiceDate(s.service_date);
    return {
      id: s.slug,
      title: s.title,
      date: p ? p.ymd : null,
      startTime: p ? p.time : null,
      crewArrival: s.arrival_time || null,
      branch: s.branch === "capetown" ? "Cape Town" : "Pretoria",
      venueName: s.venue_name || null,
      venueAddress: s.venue_address || null,
      mapsLink: s.maps_link || null,
      kit: s.kit_name || null,
      extraGear: parseGear(s.extra_gear).map((g) => ({ item: g.item, qty: g.qty })), // no prices
      operators: s.operators ? s.operators.split(", ") : [],
      crewStatus: s.operators ? "confirmed" : s.asked ? "asked" : "none",
      notes: s.crew_notes || null,
      ended: Boolean(s.ended_at),
      adminUrl: base ? `${base}/admin/streams/${s.slug}` : null,
      watchUrl: base ? `${base}/watch/${s.slug}` : null,
    };
  });

  res.json({ source: "Orange Funerals", generatedAt: new Date().toISOString(), funerals });
});

module.exports = router;
