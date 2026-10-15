// Sends email through Brevo or Everlytic.
//
// Which one is used:
//   - BREVO_API_KEY set      -> Brevo   (https://developers.brevo.com/reference/sendtransacemail)
//   - otherwise              -> Everlytic (original code, unchanged)
// To switch back to Everlytic later, just remove BREVO_API_KEY in Render.
//
// Both use HTTPS APIs, not SMTP, so they work on Render's free tier
// (Render blocks outbound SMTP ports on free instances).

const fetch = require("node-fetch");

function fromDetails() {
  return {
    address: process.env.EMAIL_FROM_ADDRESS,
    name: process.env.EMAIL_FROM_NAME || "Orange Funeral",
  };
}

// ---------------------------------------------------------------- Brevo

async function sendViaBrevo({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const from = fromDetails();

  if (!from.address) {
    return { ok: false, error: "EMAIL_FROM_ADDRESS is not set (must be a sender verified in Brevo)" };
  }

  const recipient = { email: to.email };
  if (to.name) recipient.name = to.name;

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: from.address, name: from.name },
        to: [recipient],
        subject,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Brevo API ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Brevo: ${err.message}` };
  }
}

// ------------------------------------------------------------ Everlytic

function everlyticAuthHeader() {
  const token = Buffer.from(
    `${process.env.EVERLYTIC_USERNAME}:${process.env.EVERLYTIC_API_KEY}`
  ).toString("base64");
  return `Basic ${token}`;
}

async function sendViaEverlytic({ to, subject, html }) {
  const baseUrl = process.env.EVERLYTIC_BASE_URL;
  const username = process.env.EVERLYTIC_USERNAME;
  const apiKey = process.env.EVERLYTIC_API_KEY;

  if (!baseUrl || !username || !apiKey || apiKey === "your-everlytic-api-key") {
    return {
      ok: false,
      error: "No email service configured: set BREVO_API_KEY, or EVERLYTIC_BASE_URL / EVERLYTIC_USERNAME / EVERLYTIC_API_KEY",
    };
  }

  const from = fromDetails();

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/2.0/trans_mails`, {
      method: "POST",
      headers: {
        Authorization: everlyticAuthHeader(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        headers: {
          from: { [from.address]: from.name },
          to: { [to.email]: to.name || to.email },
          subject,
        },
        body: { html },
        options: { track_opens: "no", track_links: "no" },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Everlytic API ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Everlytic: ${err.message}` };
  }
}

// ---------------------------------------------------------------- public

/**
 * Send one email.
 * @param {{to: {email: string, name?: string}, subject: string, html: string}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendEmail(opts) {
  const provider = process.env.BREVO_API_KEY ? "Brevo" : "Everlytic";
  const result = provider === "Brevo" ? await sendViaBrevo(opts) : await sendViaEverlytic(opts);
  // Show every send in Render's Logs so failures are easy to diagnose.
  if (result.ok) {
    console.log(`[email] sent via ${provider} to ${opts.to && opts.to.email}`);
  } else {
    console.error(`[email] FAILED via ${provider} to ${opts.to && opts.to.email}: ${result.error}`);
  }
  return result;
}

module.exports = { sendEmail };
