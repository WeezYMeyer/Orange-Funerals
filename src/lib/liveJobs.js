// Runs every 30 seconds while the app is up (started from server.js):
//   1. checks which kits' YoloBoxes are streaming right now
//   2. after End Stream, waits until the YoloBox has stopped and the
//      recording has reached S3, then emails the family the download link
//      and sends the usual thank-you email to everyone who watched
//   3. reminds the family 3 days before their link expires, and closes the
//      family link / watch page replay on that date (RECORDING_DAYS, 28)
//   4. works out each file's length and a thumbnail for the Recordings library
//   5. deletes the files once staff no longer need them (LIBRARY_DAYS, 6 months)
// Nothing here needs staff to click anything. Status shows on Settings.

const { nanoid } = require("nanoid");
const db = require("./db");
const live = require("./liveServer");
const media = require("./recordingMedia");

const TICK_MS = 30 * 1000;
const MIN = 60 * 1000;
const WAIT_AFTER_END_MIN = 4;    // the server uploads a file ~2-3 min after the stream stops
const QUIET_MIN = 4;             // YoloBox must have been off (or restarted) this long
const GIVE_UP_WAITING_MIN = 180; // YoloBox left streaming after End Stream: use what's there
const NO_RECORDING_AFTER_MIN = 60;
const PRE_ROLL_MIN = 120;        // recordings that start up to 2 h before the service count
const TEST_BEFORE_MIN = 10;      // ...unless they ended 10+ min before the service (a test stream)
const BLIP_SEC = 15;             // a part shorter than this is a reconnect blip, not worth a part
const REMIND_DAYS_BEFORE = 3;
const RETRY_EMAIL_EVERY_MS = 30 * MIN;
const MEDIA_PER_TICK = 2;
const MEDIA_MAX_ATTEMPTS = 3;
const MEDIA_RETRY_MIN = 10;

const state = {
  timer: null,
  running: false,
  lastTickAt: null,
  lastError: null,
  lastErrorAt: null,
  emailAttempts: new Map(), // streamId -> last attempt (ms), so failures retry every 30 min
};

function iso(d = new Date()) {
  return d.toISOString();
}

function noteError(where, err) {
  state.lastError = `${where}: ${err && err.message ? err.message : err}`;
  state.lastErrorAt = iso();
  console.error("[live]", state.lastError);
}

function isOwnStream(stream) {
  return Boolean(live.enabled() && stream && stream.kit_id && !String(stream.embed_code || "").trim());
}

// The funeral a kit is streaming for right now: today's earliest funeral on
// that kit that hasn't been ended. Ending it hands the kit to the next one.
function currentStreamForKit(kitId, now = new Date()) {
  return db
    .prepare(
      `SELECT * FROM streams
       WHERE kit_id = ? AND ended_at IS NULL
         AND (embed_code IS NULL OR trim(embed_code) = '')
         AND substr(service_date, 1, 10) = ?
       ORDER BY service_date ASC, id ASC LIMIT 1`
    )
    .get(kitId, live.sastToday(now));
}

function kitStatus(kitId) {
  return db.prepare("SELECT * FROM kit_status WHERE kit_id = ?").get(kitId) || null;
}

// ------------------------------------------------------------- 1. live checks

async function checkKits(now) {
  const kits = db.prepare("SELECT id FROM kits ORDER BY id").all();
  for (const k of kits) {
    const isLive = await live.isKitLive(k.id);
    if (isLive === null) continue; // server unreachable: keep the last known state
    const prev = kitStatus(k.id);
    if (!prev) {
      db.prepare("INSERT INTO kit_status (kit_id, is_live, changed_at, checked_at) VALUES (?, ?, ?, ?)").run(
        k.id, isLive ? 1 : 0, iso(now), iso(now)
      );
    } else if (Boolean(prev.is_live) !== isLive) {
      db.prepare("UPDATE kit_status SET is_live = ?, changed_at = ?, checked_at = ? WHERE kit_id = ?").run(
        isLive ? 1 : 0, iso(now), iso(now), k.id
      );
    } else {
      db.prepare("UPDATE kit_status SET checked_at = ? WHERE kit_id = ?").run(iso(now), k.id);
    }
    if (isLive) {
      const s = currentStreamForKit(k.id, now);
      if (s && !s.live_started_at) {
        db.prepare("UPDATE streams SET live_started_at = ? WHERE id = ?").run(iso(now), s.id);
      }
    }
  }
}

// ------------------------------------------------------------- 2. after End Stream

// Has the kit's YoloBox stopped long enough for the last file to be uploaded?
function recordingSettled(stream, now) {
  const ended = live.dbDate(stream.ended_at);
  const minsSinceEnd = (now - ended) / MIN;
  if (minsSinceEnd < WAIT_AFTER_END_MIN) return false;
  if (minsSinceEnd >= GIVE_UP_WAITING_MIN) return true;
  const ks = kitStatus(stream.kit_id);
  if (!ks) return minsSinceEnd >= 30; // never managed to check the server
  const changed = live.dbDate(ks.changed_at);
  const quietMins = (now - changed) / MIN;
  if (!ks.is_live) return quietMins >= QUIET_MIN;
  // Streaming again: fine if that stream started after this funeral ended
  // (the next funeral on this kit) - the earlier file has been closed.
  return changed > ended && quietMins >= QUIET_MIN;
}

// Which recorded files belong to this funeral: they start after the previous
// funeral on the same kit ended (or up to 2 h before the service) and before
// this funeral was ended.
function windowFor(stream) {
  const ended = live.dbDate(stream.ended_at);
  const service = live.serviceDateToUtc(stream.service_date);
  const liveStart = live.dbDate(stream.live_started_at);
  let start = new Date((service || ended).getTime() - PRE_ROLL_MIN * MIN);
  if (liveStart && liveStart - 5 * MIN < start) start = new Date(liveStart.getTime() - 5 * MIN);
  const prev = db
    .prepare(
      `SELECT ended_at FROM streams
       WHERE kit_id = ? AND id != ? AND ended_at IS NOT NULL AND ended_at < ?
       ORDER BY ended_at DESC LIMIT 1`
    )
    .get(stream.kit_id, stream.id, stream.ended_at);
  const prevEnded = prev ? live.dbDate(prev.ended_at) : null;
  if (prevEnded && prevEnded > start) start = prevEnded;
  return { start, end: ended };
}

// Of the files in the window, leave out test streams that finished well before
// the service and few-second blips from a reconnect - but only when something
// else is left, so a funeral never ends up with no recording because of this.
async function dropTestsAndBlips(stream, files) {
  if (files.length < 2) return files;
  const service = live.serviceDateToUtc(stream.service_date);
  const testCutoff = service ? new Date(service.getTime() - TEST_BEFORE_MIN * MIN) : null;
  const info = [];
  for (const f of files) {
    let durationSec = null;
    try {
      durationSec = await media.durationOnly(f.key, f.size);
    } catch {
      /* can't tell - keep it */
    }
    const endsAt = durationSec === null ? null : new Date(f.startedAt.getTime() + durationSec * 1000);
    let skip = null;
    if (testCutoff && endsAt && endsAt < testCutoff) skip = "test stream that ended before the service";
    else if (durationSec !== null && durationSec < BLIP_SEC) skip = `only ${Math.round(durationSec)} s long (reconnect)`;
    info.push({ ...f, durationSec, skip });
  }
  const keep = info.filter((f) => !f.skip);
  if (!keep.length) return info;
  info.filter((f) => f.skip).forEach((f) => console.log(`[live] "${stream.title}": left out ${f.key} - ${f.skip}`));
  return keep;
}

async function finalizeRecording(stream, now) {
  const minsSinceEnd = (now - live.dbDate(stream.ended_at)) / MIN;
  const { start, end } = windowFor(stream);
  const files = await dropTestsAndBlips(
    stream,
    (await live.listKitRecordings(stream.kit_id)).filter((f) => f.startedAt > start && f.startedAt <= end)
  );

  if (!files.length) {
    if (minsSinceEnd >= NO_RECORDING_AFTER_MIN) {
      db.prepare("UPDATE streams SET recording_status = 'none' WHERE id = ?").run(stream.id);
      console.log(`[live] no recording found for "${stream.title}"`);
    }
    return;
  }

  const ended = live.dbDate(stream.ended_at);
  const expires = live.endOfSastDayAfter(ended, live.recordingDays());
  const filesExpire = live.endOfSastDayAfter(ended, live.libraryDays());
  const token = stream.recording_token || nanoid(32);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO recordings (stream_id, s3_key, size_bytes, started_at, part, duration_sec) VALUES (?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    files.forEach((f, i) => insert.run(stream.id, f.key, f.size, iso(f.startedAt), i + 1, f.durationSec ?? null));
    db.prepare(
      `UPDATE streams SET recording_status = 'ready', recording_ready_at = ?, recording_expires_at = ?, recording_token = ?,
              files_expire_at = ?
       WHERE id = ?`
    ).run(iso(now), iso(expires), token, iso(filesExpire), stream.id);
  })();
  console.log(`[live] recording ready for "${stream.title}" (${files.length} part(s))`);

  const emailService = require("./emailService");
  await sendFamilyEmail(stream.id, "recording", now);
  try {
    await emailService.sendThankYouEmails(stream.id);
  } catch (err) {
    noteError(`thank-you emails for "${stream.title}"`, err);
  }
}

async function sendFamilyEmail(streamId, kind, now = new Date()) {
  const emailService = require("./emailService");
  try {
    const r = await emailService.sendFamilyRecordingEmail(streamId, { reminder: kind === "reminder" });
    // Only real attempts count towards the 30-minute retry wait (not "no email yet").
    if (!r.skipped) state.emailAttempts.set(`${kind}:${streamId}`, now.getTime());
    if (!r.ok && r.error && !r.skipped) noteError(`family ${kind} email`, r.error);
    return r;
  } catch (err) {
    state.emailAttempts.set(`${kind}:${streamId}`, now.getTime());
    noteError(`family ${kind} email`, err);
    return { ok: false, error: err.message };
  }
}

// The family email was changed on the funeral: try the new address straight away.
function forgetEmailAttempts(streamId) {
  state.emailAttempts.delete(`recording:${streamId}`);
  state.emailAttempts.delete(`reminder:${streamId}`);
}

function dueForRetry(key, now) {
  const last = state.emailAttempts.get(key);
  return !last || now.getTime() - last >= RETRY_EMAIL_EVERY_MS;
}

// ------------------------------------------------------------- 3. reminders, family expiry

async function remindersAndExpiry(now) {
  const ready = db
    .prepare("SELECT * FROM streams WHERE recording_status = 'ready' AND recording_expires_at IS NOT NULL")
    .all();
  for (const s of ready) {
    const expires = live.dbDate(s.recording_expires_at);

    // The family link and the watch page stop playing it; the files stay for
    // staff (Recordings) until filesExpireAt.
    if (expires <= now) {
      db.prepare("UPDATE streams SET recording_status = 'expired' WHERE id = ?").run(s.id);
      console.log(`[live] family link expired for "${s.title}" (staff keep it under Recordings)`);
      continue;
    }

    if (!s.family_email) continue;

    // First email didn't go through (or the family email was added later): retry every 30 min.
    if (!s.family_emailed_at && dueForRetry(`recording:${s.id}`, now)) {
      await sendFamilyEmail(s.id, "recording", now);
      continue;
    }

    const readyAt = live.dbDate(s.recording_ready_at) || now;
    const remindFrom = new Date(expires.getTime() - REMIND_DAYS_BEFORE * 24 * 60 * MIN);
    const longEnough = now - readyAt >= 24 * 60 * MIN; // never right after the first email
    if (s.family_emailed_at && !s.family_reminded_at && now >= remindFrom && longEnough && dueForRetry(`reminder:${s.id}`, now)) {
      await sendFamilyEmail(s.id, "reminder", now);
    }
  }
}

// When the files are deleted (stored on new recordings; worked out for older ones).
function filesExpireAt(stream) {
  return live.dbDate(stream.files_expire_at) || live.endOfSastDayAfter(live.dbDate(stream.ended_at), live.libraryDays());
}

// ------------------------------------------------------------- 4. length + thumbnail

async function processMedia(now) {
  const due = db
    .prepare(
      `SELECT * FROM recordings
       WHERE deleted_at IS NULL AND media_at IS NULL AND media_attempts < ?
         AND (media_tried_at IS NULL OR media_tried_at <= ?)
       ORDER BY id LIMIT ?`
    )
    .all(MEDIA_MAX_ATTEMPTS, iso(new Date(now.getTime() - MEDIA_RETRY_MIN * MIN)), MEDIA_PER_TICK);
  for (const r of due) {
    db.prepare("UPDATE recordings SET media_attempts = media_attempts + 1, media_tried_at = ? WHERE id = ?").run(iso(now), r.id);
    try {
      const m = await media.analyse(r);
      db.prepare(
        "UPDATE recordings SET duration_sec = ?, thumb = ?, thumb_pos = ?, media_at = ?, media_error = ? WHERE id = ?"
      ).run(m.durationSec, m.thumb, m.thumb ? m.thumbPos : null, iso(now), m.thumbError, r.id);
      if (m.thumbError) console.log(`[live] no thumbnail for ${r.s3_key}: ${m.thumbError}`);
    } catch (err) {
      db.prepare("UPDATE recordings SET media_error = ? WHERE id = ?").run(String(err.message || err).slice(0, 300), r.id);
      noteError(`reading ${r.s3_key}`, err);
    }
  }
}

// ------------------------------------------------------------- 5. delete old files

async function deleteOldFiles(now) {
  const rows = db
    .prepare(
      `SELECT * FROM streams
       WHERE recording_status IN ('ready', 'expired') AND files_deleted_at IS NULL AND ended_at IS NOT NULL`
    )
    .all();
  for (const s of rows) {
    if (filesExpireAt(s) > now) continue;
    const parts = db.prepare("SELECT * FROM recordings WHERE stream_id = ? AND deleted_at IS NULL").all(s.id);
    try {
      await live.deleteRecordings(parts.map((p) => p.s3_key));
      db.transaction(() => {
        db.prepare("UPDATE recordings SET deleted_at = ? WHERE stream_id = ? AND deleted_at IS NULL").run(iso(now), s.id);
        db.prepare("UPDATE streams SET recording_status = 'expired', files_deleted_at = ? WHERE id = ?").run(iso(now), s.id);
      })();
      console.log(`[live] recording files deleted for "${s.title}" (library period over)`);
    } catch (err) {
      noteError(`deleting old recording for "${s.title}"`, err);
    }
  }
}

// ------------------------------------------------------------- the loop

async function tick(now = new Date()) {
  if (state.running) return;
  state.running = true;
  try {
    try {
      await checkKits(now);
    } catch (err) {
      noteError("checking the live server", err);
    }
    if (live.s3Ready()) {
      const waiting = db
        .prepare(
          `SELECT * FROM streams
           WHERE ended_at IS NOT NULL AND kit_id IS NOT NULL
             AND (embed_code IS NULL OR trim(embed_code) = '')
             AND (recording_status IS NULL OR recording_status = 'waiting')
             AND ended_at >= datetime('now', '-14 days')`
        )
        .all();
      for (const s of waiting) {
        try {
          if (s.recording_status !== "waiting") {
            db.prepare("UPDATE streams SET recording_status = 'waiting' WHERE id = ?").run(s.id);
          }
          if (recordingSettled(s, now)) await finalizeRecording(s, now);
        } catch (err) {
          noteError(`recording for "${s.title}"`, err);
        }
      }
      try {
        await remindersAndExpiry(now);
      } catch (err) {
        noteError("reminders / expiry", err);
      }
      try {
        await deleteOldFiles(now);
      } catch (err) {
        noteError("deleting old recordings", err);
      }
      try {
        await processMedia(now);
      } catch (err) {
        noteError("recording thumbnails", err);
      }
    }
    state.lastTickAt = iso(now);
  } finally {
    state.running = false;
  }
}

function start() {
  if (!live.enabled()) {
    console.log("[live] own live server is off (set LIVE_CDN_URL to switch it on)");
    return;
  }
  console.log(`[live] checking kits every ${TICK_MS / 1000}s via ${live.cdnUrl()}`);
  setTimeout(() => tick().catch((e) => noteError("tick", e)), 5000);
  state.timer = setInterval(() => tick().catch((e) => noteError("tick", e)), TICK_MS);
}

function status() {
  const kits = db
    .prepare(
      `SELECT k.id, k.name, ks.is_live, ks.changed_at, ks.checked_at
       FROM kits k LEFT JOIN kit_status ks ON ks.kit_id = k.id ORDER BY k.id`
    )
    .all();
  return {
    enabled: live.enabled(),
    s3Ready: live.s3Ready(),
    awsKeysSet: Boolean(process.env.LIVE_AWS_ACCESS_KEY_ID && process.env.LIVE_AWS_SECRET_ACCESS_KEY),
    passwordSet: Boolean(process.env.LIVE_STREAM_PASSWORD),
    rtmpUrl: live.rtmpUrl(),
    cdnUrl: live.cdnUrl(),
    recordingDays: live.recordingDays(),
    libraryDays: live.libraryDays(),
    ffmpeg: media.ffmpegPath(),
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    kits: kits.map((k) => ({
      ...k,
      streamName: live.streamNameForKit(k.id),
      streamKey: live.streamKeyForKit(k.id),
      testUrl: `${live.cdnUrl()}/live/${live.streamNameForKit(k.id)}/`,
    })),
  };
}

module.exports = {
  start,
  tick,
  status,
  isOwnStream,
  currentStreamForKit,
  kitStatus,
  sendFamilyEmail,
  forgetEmailAttempts,
  windowFor,
  filesExpireAt,
  processMedia,
};
