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
  email: "markus@orangeproductions.co.za",
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

function thankYouEmail({ contactName, streamTitle, unsubToken }) {
  const greeting = contactName ? `Dear ${esc(contactName)},` : "Dear friend,";
  return wrapper({
    heading: "Thank you for watching",
    unsubToken,
    bodyHtml: `
      <p>${greeting}</p>
      <p>Thank you for joining the livestream for <strong>${esc(streamTitle)}</strong>. We're grateful you were able to be present, even from a distance, and we hope it brought you some comfort.</p>
      <p>With warm regards,<br/>${esc(FROM_NAME())}</p>
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

module.exports = { thankYouEmail, broadcastEmail };
