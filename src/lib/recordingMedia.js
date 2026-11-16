// Length and a thumbnail picture for each recorded file, worked out from a few
// small pieces of the file in S3 instead of downloading the whole 2 GB:
//   - the first ~0.5 MB (file header) + the last ~3 MB give the exact length
//   - ~8 MB from part-way through gives one picture, made by ffmpeg
//
// Two kinds of file:
//  - "faststart" MP4 (from Nov 2026 the live server rewrites every recording
//    this way): the index (moov) is at the front and holds the length, and
//    ffmpeg jumps straight to the right spot over a private S3 link.
//  - fragmented MP4 (MediaMTX "fmp4", older recordings): a header followed by
//    ~1-second fragments (moof + mdat). Each fragment says when it starts
//    (tfdt) and how long its samples are (trun), so the last fragment tells
//    us where the recording ends, and a picture is made from one piece.
//
// ffmpeg comes from the optional "ffmpeg-static" package (installed by npm on
// Render), or FFMPEG_PATH, or an ffmpeg on the PATH. Without it the length is
// still worked out and the library shows a plain tile instead of a picture.

const fs = require("fs");
const { spawn } = require("child_process");
const live = require("./liveServer");

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 3 * 1024 * 1024;
const SAMPLE_BYTES = 8 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 30 * 1000;

// Where in the recording the picture is taken (fraction of the file). The
// first is the default; "Pick another picture" moves to the next one.
const POSITIONS = [0.4, 0.25, 0.55, 0.7, 0.85, 0.15, 0.32, 0.47, 0.62, 0.78];

function nextPosition(current) {
  const i = POSITIONS.findIndex((p) => Math.abs(p - current) < 0.001);
  return POSITIONS[(i + 1) % POSITIONS.length];
}

// ------------------------------------------------------------- MP4 boxes

function readBox(buf, pos, end) {
  if (pos + 8 > end) return null;
  let size = buf.readUInt32BE(pos);
  const type = buf.toString("latin1", pos + 4, pos + 8);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > end) return null;
    size = Number(buf.readBigUInt64BE(pos + 8));
    header = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < header) return null;
  return { type, start: pos, size, body: pos + header, end: pos + size };
}

function children(buf, box) {
  const out = [];
  let p = box.body;
  while (p < box.end) {
    const b = readBox(buf, p, box.end);
    if (!b || b.end > box.end) break;
    out.push(b);
    p = b.end;
  }
  return out;
}

const child = (buf, box, type) => children(buf, box).find((c) => c.type === type);

// moov -> { tracks: Map(trackId -> { timescale, handler, defDuration, defFlags }), videoId }
function parseMoov(buf, moov) {
  const tracks = new Map();
  for (const trak of children(buf, moov).filter((c) => c.type === "trak")) {
    const tkhd = child(buf, trak, "tkhd");
    const mdia = child(buf, trak, "mdia");
    const mdhd = mdia && child(buf, mdia, "mdhd");
    const hdlr = mdia && child(buf, mdia, "hdlr");
    if (!tkhd || !mdhd) continue;
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const v1 = buf[mdhd.body] === 1;
    const timescale = buf.readUInt32BE(mdhd.body + (v1 ? 20 : 12));
    const mediaDuration = v1 ? Number(buf.readBigUInt64BE(mdhd.body + 24)) : buf.readUInt32BE(mdhd.body + 16);
    const handler = hdlr ? buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) : "";
    tracks.set(id, { timescale, mediaDuration, handler, defDuration: 0, defFlags: 0 });
  }
  const mvex = child(buf, moov, "mvex");
  if (mvex) {
    for (const trex of children(buf, mvex).filter((c) => c.type === "trex")) {
      const t = tracks.get(buf.readUInt32BE(trex.body + 4));
      if (t) {
        t.defDuration = buf.readUInt32BE(trex.body + 12);
        t.defFlags = buf.readUInt32BE(trex.body + 20);
      }
    }
  }
  let videoId = null;
  for (const [id, t] of tracks) if (t.handler === "vide" && videoId === null) videoId = id;
  if (videoId === null && tracks.size) videoId = tracks.keys().next().value;
  return { tracks, videoId, fragmented: Boolean(mvex) };
}

// moof -> Map(trackId -> { start, duration, firstIsKeyframe })   (in track time units)
function parseMoof(buf, moof, tracks) {
  const out = new Map();
  for (const traf of children(buf, moof).filter((c) => c.type === "traf")) {
    const tfhd = child(buf, traf, "tfhd");
    if (!tfhd) continue;
    const hf = buf.readUInt32BE(tfhd.body) & 0xffffff;
    const id = buf.readUInt32BE(tfhd.body + 4);
    const t = tracks.get(id) || { defDuration: 0, defFlags: 0 };
    let p = tfhd.body + 8;
    if (hf & 0x01) p += 8; // base data offset
    if (hf & 0x02) p += 4; // sample description index
    let defDuration = t.defDuration;
    if (hf & 0x08) { defDuration = buf.readUInt32BE(p); p += 4; }
    if (hf & 0x10) p += 4; // default sample size
    let defFlags = t.defFlags;
    if (hf & 0x20) { defFlags = buf.readUInt32BE(p); p += 4; }

    const tfdt = child(buf, traf, "tfdt");
    const start = tfdt
      ? buf[tfdt.body] === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4)
      : 0;

    let duration = 0;
    let firstFlags = null;
    for (const trun of children(buf, traf).filter((c) => c.type === "trun")) {
      const rf = buf.readUInt32BE(trun.body) & 0xffffff;
      const count = buf.readUInt32BE(trun.body + 4);
      let q = trun.body + 8;
      if (rf & 0x01) q += 4; // data offset
      let firstSampleFlags = null;
      if (rf & 0x04) { firstSampleFlags = buf.readUInt32BE(q); q += 4; }
      for (let i = 0; i < count && q <= trun.end; i++) {
        let d = defDuration;
        let f = i === 0 && firstSampleFlags !== null ? firstSampleFlags : defFlags;
        if (rf & 0x100) { d = buf.readUInt32BE(q); q += 4; }
        if (rf & 0x200) q += 4;
        if (rf & 0x400) { f = buf.readUInt32BE(q); q += 4; }
        if (rf & 0x800) q += 4;
        if (firstFlags === null) firstFlags = f;
        duration += d;
      }
    }
    // sample_is_non_sync_sample is bit 16 of the sample flags
    out.set(id, { start, duration, firstIsKeyframe: firstFlags !== null && !(firstFlags & 0x10000) });
  }
  return out;
}

// Complete fragments (moof boxes) inside a piece of the file: [box]
function findMoofs(buf, from = 0) {
  const out = [];
  let i = buf.indexOf("moof", from + 4, "latin1");
  while (i !== -1) {
    const s = i - 4;
    const size = buf.readUInt32BE(s);
    if (size > 24 && size < 4 * 1024 * 1024 && s + size <= buf.length && buf.toString("latin1", s + 12, s + 16) === "mfhd") {
      out.push({ type: "moof", start: s, size, body: s + 8, end: s + size });
    }
    i = buf.indexOf("moof", i + 4, "latin1");
  }
  return out;
}

// ------------------------------------------------------------- reading the file

async function readHeader(key, size) {
  let head = await live.readRange(key, 0, Math.min(size, HEAD_BYTES) - 1);
  let pos = 0;
  let moov = null;
  while (pos < head.length) {
    const b = readBox(head, pos, Number.MAX_SAFE_INTEGER);
    if (!b) break;
    if (b.type === "moov") {
      if (b.end > head.length) head = await live.readRange(key, 0, Math.min(size, b.end + 64 * 1024) - 1);
      moov = b;
      break;
    }
    pos = b.end;
  }
  if (!moov || moov.end > head.length) throw new Error("not a recording the library can read (no MP4 header)");
  const info = parseMoov(head, moov);
  if (info.videoId === null) throw new Error("no video in the recording");
  if (!info.fragmented) {
    const v = info.tracks.get(info.videoId);
    return { ...info, durationSec: v.timescale ? v.mediaDuration / v.timescale : null };
  }
  const init = head.subarray(0, moov.end);
  const first = findMoofs(head, moov.end)[0];
  const firstStart = first ? (parseMoof(head, first, info.tracks).get(info.videoId) || {}).start || 0 : 0;
  return { ...info, init, firstStart };
}

// Length of the recording in seconds.
async function durationOf(key, size, header) {
  if (!header.fragmented) {
    if (header.durationSec === null || !Number.isFinite(header.durationSec)) throw new Error("the recording has no length");
    return header.durationSec;
  }
  const from = Math.max(0, size - TAIL_BYTES);
  const tail = await live.readRange(key, from, size - 1);
  const moofs = findMoofs(tail);
  for (let i = moofs.length - 1; i >= 0; i--) {
    const v = parseMoof(tail, moofs[i], header.tracks).get(header.videoId);
    if (v) {
      const ts = header.tracks.get(header.videoId).timescale || 90000;
      return Math.max(0, (v.start + v.duration - header.firstStart) / ts);
    }
  }
  throw new Error("could not find the end of the recording");
}

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* optional package not installed */
  }
  return "ffmpeg";
}

// One JPEG (640 px wide), from MP4 bytes on stdin (input = Buffer) or from a
// link ffmpeg reads itself (input = { url, seek } - it only fetches the index
// and the few seconds it needs).
function frameToJpeg(input) {
  return new Promise((resolve, reject) => {
    const source = Buffer.isBuffer(input)
      ? ["-f", "mp4", "-i", "pipe:0"]
      : ["-ss", String(Math.max(0, input.seek || 0)), "-i", input.url];
    let proc;
    try {
      proc = spawn(ffmpegPath(), [
        "-hide_banner", "-loglevel", "error",
        ...source,
        "-map", "0:v:0", "-frames:v", "1",
        "-vf", "scale=640:-2", "-q:v", "4",
        "-f", "image2", "-c:v", "mjpeg", "pipe:1",
      ]);
    } catch (err) {
      return reject(err);
    }
    const out = [];
    let errText = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => { errText += d.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new Error("ffmpeg is not installed, so no thumbnail") : err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const jpg = Buffer.concat(out);
      if (jpg.length > 500 && jpg[0] === 0xff && jpg[1] === 0xd8) return resolve(jpg);
      reject(new Error(`ffmpeg could not make a picture (${code}): ${errText.trim().slice(0, 200)}`));
    });
    proc.stdin.on("error", () => {}); // ffmpeg stops reading once it has its picture
    proc.stdin.end(Buffer.isBuffer(input) ? input : undefined);
  });
}

// A picture from `position` (0..1) of the way through the file.
async function thumbnailAt(key, size, header, position) {
  if (!header.fragmented) {
    const url = await live.signedGetUrl(key, 600);
    return frameToJpeg({ url, seek: (header.durationSec || 0) * position });
  }
  const start = Math.max(header.init.length, Math.floor(size * position));
  const end = Math.min(size - 1, start + SAMPLE_BYTES - 1);
  const piece = await live.readRange(key, start, end);
  const moofs = findMoofs(piece);
  if (!moofs.length) throw new Error("no video found at that point of the recording");
  const startFrag =
    moofs.find((m) => (parseMoof(piece, m, header.tracks).get(header.videoId) || {}).firstIsKeyframe) || moofs[0];
  return frameToJpeg(Buffer.concat([header.init, piece.subarray(startFrag.start)]));
}

// Everything for one recordings row: { durationSec, thumb (Buffer|null), thumbPos, thumbError }
async function analyse(rec, position = POSITIONS[0]) {
  const size = Number(rec.size_bytes || 0);
  if (size < 1024) throw new Error("the recording file is empty");
  const header = await readHeader(rec.s3_key, size);
  const durationSec = await durationOf(rec.s3_key, size, header);
  let thumb = null;
  let thumbError = null;
  try {
    thumb = await thumbnailAt(rec.s3_key, size, header, position);
  } catch (err) {
    thumbError = err.message;
  }
  return { durationSec, thumb, thumbPos: position, thumbError };
}

// Just a new picture (for "Pick another picture").
async function newThumbnail(rec) {
  const size = Number(rec.size_bytes || 0);
  const position = nextPosition(rec.thumb_pos || POSITIONS[0]);
  const header = await readHeader(rec.s3_key, size);
  const thumb = await thumbnailAt(rec.s3_key, size, header, position);
  return { thumb, thumbPos: position };
}

// 4321 -> "1:12:01", 754 -> "12:34"
function fmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return "";
  const s = Math.round(Number(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

// 4321 -> "1 h 12 min", 754 -> "12 min"
function fmtDurationWords(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return "";
  const mins = Math.round(Number(sec) / 60);
  if (mins < 1) return `${Math.round(Number(sec))} sec`;
  const h = Math.floor(mins / 60);
  return h ? `${h} h ${mins % 60} min` : `${mins} min`;
}

module.exports = { analyse, newThumbnail, fmtDuration, fmtDurationWords, ffmpegPath, POSITIONS, _test: { findMoofs, parseMoof, readBox } };
