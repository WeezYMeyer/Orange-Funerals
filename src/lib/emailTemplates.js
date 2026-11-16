// Escape text that comes from viewers or staff before putting it into HTML.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FROM_NAME = () => process.env.EMAIL_FROM_NAME || "Orange Funeral";

// Discreet service credit shown in the footer of every email.
// Orange Productions credit, following the CI guide (Roboto, #F05A22 / #242524).
// Built with tables + inline styles so it renders the same in Gmail, Outlook and Apple Mail.
// The logo is served by the app itself: put orange-productions-mark.png in src/public/img/.
const OP = {
  orange: "#F05A22",
  charcoal: "#242524",
  phone: "071 325 8694",
  phoneIntl: "+27713258694",
  email: "johan@orangeproductions.co.za",
  site: "www.orangeproductions.co.za",
  url: "https://www.orangeproductions.co.za",
};

function credit(base) {
  const font = "Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif";
  const logo = `${base}/img/orange-productions-mark.png`;
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top: 28px; border-collapse: collapse;">
        <tr>
          <td style="border-top: 1px solid #eeeeee; padding-top: 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
              <tr>
                <td valign="middle" style="padding-right: 14px;">
                  <a href="${OP.url}"><img src="${logo}" width="52" height="52" alt="Orange Productions" style="display: block; border: 0; width: 52px; height: 52px;" /></a>
                </td>
                <td valign="middle" style="font-family: ${font};">
                  <div style="font-size: 10px; letter-spacing: 1.6px; text-transform: uppercase; color: #9b9b9b; margin-bottom: 3px;">This service was streamed by</div>
                  <a href="${OP.url}" style="text-decoration: none; color: ${OP.charcoal};">
                    <span style="font-size: 16px; font-weight: 700; letter-spacing: 0.5px; color: ${OP.charcoal};">ORANGE</span>
                    <span style="font-size: 16px; font-weight: 300; letter-spacing: 1px; color: ${OP.charcoal};">PRODUCTIONS</span>
                  </a>
                  <div style="font-size: 11px; font-weight: 300; color: #8a8a8a; margin-top: 4px; line-height: 1.6;">
                    Live streaming &middot; Sound &middot; Video &mdash; for memorials, family gatherings and events
                  </div>
                  <div style="font-size: 11px; color: #8a8a8a; margin-top: 6px; line-height: 1.6;">
                    <a href="tel:${OP.phoneIntl}" style="color: #6f6f6f; text-decoration: none;">${OP.phone}</a>
                    &nbsp;&middot;&nbsp;
                    <a href="mailto:${OP.email}" style="color: #6f6f6f; text-decoration: none;">${OP.email}</a>
                    &nbsp;&middot;&nbsp;
                    <a href="${OP.url}" style="color: ${OP.orange}; text-decoration: none; font-weight: 500;">${OP.site}</a>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
}

function wrapper({ heading, bodyHtml, unsubToken }) {
  const base = process.env.BASE_URL || "http://localhost:3000";
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #2b2b2b; line-height: 1.6;">
    <div style="border-top: 3px solid #5b6b5b; padding-top: 20px; margin-bottom: 24px;">
      <h1 style="font-size: 20px; font-weight: normal; color: #2b2b2b; margin: 0 0 16px 0;">${heading}</h1>
    </div>
    <div style="font-size: 15px;">${bodyHtml}</div>
    <div style="margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #888;">
      ${esc(FROM_NAME())}<br/>
      <a href="${base}/unsubscribe/${encodeURIComponent(unsubToken)}" style="color: #888;">Unsubscribe from future emails</a>
      ${credit(base)}
    </div>
  </div>`;
}

// Recording stays on the watch link for 4 weeks after the stream ends.
const REWATCH_DAYS = 28;

// ended_at is stored by SQLite in UTC ("YYYY-MM-DD HH:MM:SS"); show the
// date in South African time.
function rewatchUntil(endedAt, untilDate) {
  const ended = endedAt ? new Date(endedAt.replace(" ", "T") + "Z") : new Date();
  // Own live server: the real expiry date of the recording is known.
  const until = untilDate || new Date(ended.getTime() + REWATCH_DAYS * 24 * 60 * 60 * 1000);
  return until.toLocaleDateString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function thankYouEmail({ contactName, streamTitle, watchUrl, endedAt, untilDate, unsubToken }) {
  const greeting = contactName ? `Dear ${esc(contactName)},` : "Dear friend,";
  const until = esc(rewatchUntil(endedAt, untilDate));
  const url = esc(watchUrl);
  return wrapper({
    heading: "Thank you for watching",
    unsubToken,
    bodyHtml: `
      <p>${greeting}</p>
      <p>Thank you for joining the livestream for <strong>${esc(streamTitle)}</strong>. We're grateful you were able to be present, even from a distance, and we hope it brought you some comfort.</p>
      <p>If you would like to watch the service again, or share it with family who couldn't attend, the recording will remain available on the same link until <strong>${until}</strong>.</p>
      <p>With warm regards,<br/>${esc(FROM_NAME())}</p>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top: 28px; border-collapse: collapse;">
        <tr>
          <td style="background: #f4f6f2; border: 1px solid #dde4d6; border-radius: 6px; padding: 20px 22px; text-align: center;">
            <div style="font-size: 15px; color: #2b2b2b; margin-bottom: 14px;">Watch the service again</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse: collapse; margin: 0 auto;">
              <tr>
                <td style="background: #5b6b5b; border-radius: 6px;">
                  <a href="${url}" style="display: inline-block; padding: 11px 26px; font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; color: #ffffff; text-decoration: none;">Open the livestream</a>
                </td>
              </tr>
            </table>
            <div style="font-family: Arial, sans-serif; font-size: 12px; color: #6b6b6b; margin-top: 12px; word-break: break-all;">
              <a href="${url}" style="color: #46543f;">${url}</a><br/>
              Available until ${until}
            </div>
          </td>
        </tr>
      </table>
    `,
  });
}

// messageHtml is written by staff in the broadcast composer, so it is left as HTML.
function broadcastEmail({ contactName, subjectLine, messageHtml, unsubToken }) {
  const greeting = contactName ? `Dear ${esc(contactName)},` : "Dear friend,";
  return wrapper({
    heading: esc(subjectLine),
    unsubToken,
    bodyHtml: `<p>${greeting}</p>${messageHtml}`,
  });
}


// A green call-to-action box, same look as the thank-you email.
function buttonBox({ title, url, label, note }) {
  const u = esc(url);
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top: 28px; border-collapse: collapse;">
        <tr>
          <td style="background: #f4f6f2; border: 1px solid #dde4d6; border-radius: 6px; padding: 20px 22px; text-align: center;">
            <div style="font-size: 15px; color: #2b2b2b; margin-bottom: 14px;">${esc(title)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse: collapse; margin: 0 auto;">
              <tr>
                <td style="background: #5b6b5b; border-radius: 6px;">
                  <a href="${u}" style="display: inline-block; padding: 11px 26px; font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; color: #ffffff; text-decoration: none;">${esc(label)}</a>
                </td>
              </tr>
            </table>
            <div style="font-family: Arial, sans-serif; font-size: 12px; color: #6b6b6b; margin-top: 12px; word-break: break-all;">
              <a href="${u}" style="color: #46543f;">${u}</a><br/>
              ${esc(note)}
            </div>
          </td>
        </tr>
      </table>`;
}

// To the family, a few minutes after the service: thank you + the recording.
function familyRecordingEmail({ contactName, streamTitle, pageUrl, until, parts, unsubToken }) {
  const greeting = contactName ? `Dear ${esc(contactName)},` : "Dear family,";
  const partsNote =
    parts > 1
      ? `<p>The livestream was restarted during the service, so the recording is in <strong>${parts} parts</strong>. You'll find all of them on the page, in order.</p>`
      : "";
  return wrapper({
    heading: "The recording of the service",
    unsubToken,
    bodyHtml: `
      <p>${greeting}</p>
      <p>Thank you for allowing us to stream <strong>${esc(streamTitle)}</strong>. We hope it helped family and friends who could not be there to be part of the day.</p>
      <p>The recording of the service is ready. You can watch it online, or download it to keep and share. It will be available until <strong>${esc(until)}</strong>; after that date it is permanently removed, so please download it before then.</p>
      ${partsNote}
      <p>With heartfelt sympathy,<br/>${esc(FROM_NAME())}</p>
      ${buttonBox({ title: "Watch or download the recording", url: pageUrl, label: "Open the recording", note: `Available until ${until}` })}
    `,
  });
}

// To the family, a few days before the recording is removed.
function familyReminderEmail({ contactName, streamTitle, pageUrl, until, unsubToken }) {
  const greeting = contactName ? `Dear ${esc(contactName)},` : "Dear family,";
  return wrapper({
    heading: "A reminder about the recording",
    unsubToken,
    bodyHtml: `
      <p>${greeting}</p>
      <p>This is a gentle reminder that the recording of <strong>${esc(streamTitle)}</strong> will be removed on <strong>${esc(until)}</strong>.</p>
      <p>If you would like to keep it, please download it before then. Once it has been removed, we are not able to recover it.</p>
      <p>With warm regards,<br/>${esc(FROM_NAME())}</p>
      ${buttonBox({ title: "Download the recording", url: pageUrl, label: "Open the recording", note: `Removed after ${until}` })}
    `,
  });
}

module.exports = { thankYouEmail, broadcastEmail, familyRecordingEmail, familyReminderEmail };
