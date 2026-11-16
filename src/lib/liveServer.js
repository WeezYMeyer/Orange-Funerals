// Orange live server (AWS, Cape Town): settings, live checks and recordings.
//
// Render environment variables (values come from the orange-live stack Outputs):
//   LIVE_CDN_URL                 https://dxxxx.cloudfront.net          (turns the feature on)
//   LIVE_RTMP_URL                rtmp://<ip>:1935/live                 (shown on Settings for the YoloBoxes)
//   LIVE_STREAM_PASSWORD         the stream password chosen for the stack
//   LIVE_RECORDINGS_BUCKET       orange-live-recordings-<account>
//   LIVE_AWS_REGION              af-south-1
//   LIVE_AWS_ACCESS_KEY_ID / LIVE_AWS_SECRET_ACCESS_KEY   (IAM user orange-live-app)
//   RECORDING_DAYS               optional, default 28: how long the family link and watch page play it
//   LIBRARY_DAYS                 optional, default 183 (6 months): how long staff can still watch it under
//                                Recordings before the files are deleted (keep below the stack's clean-up days)
//
// Times: the database stores UTC. The YoloBox recordings are named in South
// African time (UTC+2, no daylight saving), e.g. 2026-11-16_07-22-48-835589.mp4.

const fetch = require("node-fetch");

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

function cdnUrl() {
  return (process.env.LIVE_CDN_URL || "").trim().replace(/\/+$/, "");
}

function enabled() {
  return Boolean(cdnUrl());
}

function recordingDays() {
  const n = parseInt(process.env.RECORDING_DAYS || "28", 10);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 28;
}

// Staff keep the files longer than the family link (never shorter).
function libraryDays() {
  const n = parseInt(process.env.LIBRARY_DAYS || "183", 10);
  const days = Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 183;
  return Math.max(days, recordingDays());
}

// Kit 1 -> "kit1". The YoloBox path is live/kit1.
function streamNameForKit(kitId) {
  return `kit${kitId}`;
}

function liveUrlForKit(kitId) {
  return `${cdnUrl()}/live/${streamNameForKit(kitId)}/index.m3u8`;
}

function rtmpUrl() {
  return (process.env.LIVE_RTMP_URL || "").trim().replace(/\/+$/, "");
}

function streamKeyForKit(kitId) {
  const pass = process.env.LIVE_STREAM_PASSWORD || "PASSWORD";
  return `${streamNameForKit(kitId)}?user=publisher&pass=${pass}`;
}

function playbackUrl(s3Key) {
  // recordings/... is served from S3 through the same CloudFront distribution.
  return `${cdnUrl()}/${s3Key.split("/").map(encodeURIComponent).join("/")}`;
}

// ------------------------------------------------------------- live check

// Is this kit's YoloBox streaming right now? Returns true / false, or null if
// the server could not be reached (then nothing is changed).
async function isKitLive(kitId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // MediaMTX answers index.m3u8 with a redirect to ?cookieCheck=1; ask for that directly.
    const res = await fetch(`${liveUrlForKit(kitId)}?cookieCheck=1`, { signal: ctrl.signal, redirect: "follow" });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- S3

let s3Client = null;
function s3() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    const opts = { region: process.env.LIVE_AWS_REGION || "af-south-1" };
    if (process.env.LIVE_AWS_ACCESS_KEY_ID && process.env.LIVE_AWS_SECRET_ACCESS_KEY) {
      opts.credentials = {
        accessKeyId: process.env.LIVE_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.LIVE_AWS_SECRET_ACCESS_KEY,
      };
    }
    // Only used by the automated tests (a local stand-in for S3).
    if (process.env.LIVE_S3_ENDPOINT) {
      opts.endpoint = process.env.LIVE_S3_ENDPOINT;
      opts.forcePathStyle = true;
    }
    s3Client = new S3Client(opts);
  }
  return s3Client;
}

function bucket() {
  return process.env.LIVE_RECORDINGS_BUCKET || "";
}

function s3Ready() {
  return Boolean(bucket());
}

// "2026-11-16_07-22-48-835589.mp4" (SAST) -> Date (UTC)
function startTimeFromKey(key) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,6}))?\.mp4$/.exec(key);
  if (!m) return null;
  const ms = m[7] ? Math.floor(parseInt(m[7].padEnd(6, "0"), 10) / 1000) : 0;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  return new Date(local - SAST_OFFSET_MS);
}

// All finished recordings for a kit, oldest first: [{ key, size, startedAt: Date }]
async function listKitRecordings(kitId) {
  const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const prefix = `recordings/live/${streamNameForKit(kitId)}/`;
  const out = [];
  let token;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token })
    );
    for (const o of page.Contents || []) {
      const startedAt = startTimeFromKey(o.Key);
      if (startedAt) out.push({ key: o.Key, size: Number(o.Size || 0), startedAt });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

async function deleteRecordings(keys) {
  if (!keys.length) return;
  const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
  for (let i = 0; i < keys.length; i += 1000) {
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      })
    );
  }
}

// Bytes start..end (inclusive) of a recording, for reading its header,
// last seconds or one picture without downloading the whole file.
async function readRange(key, start, end) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=${start}-${end}` }));
  return Buffer.from(await res.Body.transformToByteArray());
}

// A one-hour link that downloads the file with a friendly name.
async function downloadUrl(key, filename) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const safe = String(filename || "recording.mp4").replace(/["\\\r\n]/g, "").slice(0, 150);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safe}"`,
      ResponseContentType: "video/mp4",
    }),
    { expiresIn: 3600 }
  );
}

// ------------------------------------------------------------- time helpers

// "2026-11-16T10:00" (SAST, from the funeral form) -> Date (UTC)
function serviceDateToUtc(serviceDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(serviceDate || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - SAST_OFFSET_MS);
}

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO -> Date
function dbDate(s) {
  if (!s) return null;
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

// Today's date in South Africa, "YYYY-MM-DD".
function sastToday(now = new Date()) {
  return new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

// 23:59:59 SAST on the day `days` after `from` -> Date (UTC)
function endOfSastDayAfter(from, days) {
  const local = new Date(from.getTime() + SAST_OFFSET_MS);
  const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, 23, 59, 59);
  return new Date(end - SAST_OFFSET_MS);
}

function fmtSastDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function fmtSize(bytes) {
  if (!bytes) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

module.exports = {
  enabled,
  s3Ready,
  cdnUrl,
  rtmpUrl,
  recordingDays,
  libraryDays,
  streamNameForKit,
  streamKeyForKit,
  liveUrlForKit,
  playbackUrl,
  isKitLive,
  listKitRecordings,
  deleteRecordings,
  readRange,
  downloadUrl,
  startTimeFromKey,
  serviceDateToUtc,
  dbDate,
  sastToday,
  endOfSastDayAfter,
  fmtSastDate,
  fmtSize,
};
