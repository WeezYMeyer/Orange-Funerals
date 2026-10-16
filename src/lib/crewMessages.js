// Builds the WhatsApp messages sent to camera operators, and the
// wa.me "click to chat" links that open WhatsApp with the message
// already typed. Nothing is sent automatically — staff press Send.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// service_date is stored as the browser's datetime-local value,
// "YYYY-MM-DDTHH:MM", with no timezone. Parse it as plain parts so the
// server's timezone (UTC on Render) never shifts the date or time.
function parseServiceDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value || "");
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  return {
    ymd: `${y}-${mo}-${d}`,
    dayName: DAYS[date.getUTCDay()],
    day: +d,
    monthName: MONTHS[+mo - 1],
    year: +y,
    time: h ? `${h}:${mi}` : null,
  };
}

function fmtDateLong(value) {
  const p = parseServiceDate(value);
  if (!p) return "Date to be confirmed";
  return `${p.dayName} ${p.day} ${p.monthName} ${p.year}`;
}

// South African numbers: "068 579 7702" / "+27 68 579 7702" -> "27685797702".
function waNumber(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = "27" + digits.slice(1);
  return digits;
}

function waLink(phone, text) {
  return `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function timeLine(stream) {
  const p = parseServiceDate(stream.service_date);
  const parts = [];
  if (p && p.time) parts.push(`Service starts ${p.time}`);
  if (stream.arrival_time) parts.push(`please arrive by ${stream.arrival_time}`);
  return parts.length ? parts.join(", ") : "Time to be confirmed";
}

function venueLines(stream) {
  const lines = [];
  const venue = [stream.venue_name, stream.venue_address].filter(Boolean).join(", ");
  lines.push(`📍 ${venue || "Venue to be confirmed"}`);
  if (stream.maps_link) lines.push(`🗺️ ${stream.maps_link}`);
  return lines;
}

/** First message: "are you available?" */
function availabilityMessage({ stream, crew }) {
  return [
    `Hi ${firstName(crew.name)}, it's Orange Productions.`,
    `Are you available to operate a funeral livestream?`,
    ``,
    `📅 ${fmtDateLong(stream.service_date)}`,
    `⏰ ${timeLine(stream)}`,
    ...venueLines(stream),
    ``,
    `Please reply YES or NO. Thank you!`,
  ].join("\n");
}

/** Second message, after they've said yes: the full brief. */
function confirmationMessage({ stream, crew, assignment, kit, publicUrl }) {
  const lines = [
    `✅ CONFIRMED – ${stream.title}`,
    ``,
    `Hi ${firstName(crew.name)}, thanks, you're booked. Here are the full details:`,
    ``,
    `📅 ${fmtDateLong(stream.service_date)}`,
    `⏰ ${timeLine(stream)}`,
    ...venueLines(stream),
    ``,
  ];
  if (stream.contact_name || stream.contact_phone) {
    lines.push(`👤 Client contact: ${[stream.contact_name, stream.contact_phone].filter(Boolean).join(" – ")}`);
  }
  lines.push(`🎒 Kit: ${kit ? kit.name : "To be confirmed"}`);
  lines.push(
    assignment.uses_own_vehicle
      ? `🚗 Transport: you're driving your own vehicle`
      : `🚗 Transport: not using your own vehicle – we'll confirm transport with you`
  );
  lines.push(`🔴 Stream page: ${publicUrl}`);
  if (stream.crew_notes) {
    lines.push(``, `📝 Notes:`, stream.crew_notes.trim());
  }
  lines.push(``, `Please reply to confirm you've received this.`);
  return lines.join("\n");
}

module.exports = {
  parseServiceDate,
  fmtDateLong,
  waNumber,
  waLink,
  availabilityMessage,
  confirmationMessage,
};
