// Thin wrapper around Everlytic's transactional email API.
// Docs: https://help.everlytic.com/knowledgebase/send-a-transactional-email/
//       https://help.everlytic.com/knowledgebase/authentication/
//
// Everlytic is multi-tenant — every account has its own base URL (the domain
// of your Everlytic installation), so unlike most email APIs there's a
// EVERLYTIC_BASE_URL to set, not just a key.
//
// A note on accuracy: Everlytic's public docs show the request fields
// (headers/body/attachments/options) but not a single copy-pasteable JSON
// example — the example below is built from their field descriptions. The
// first real send is worth checking closely (see README "Verifying your
// Everlytic setup") in case a field name needs a small tweak once you're
// looking at your own account's docs/support.

const fetch = require("node-fetch");

function authHeader() {
  const username = process.env.EVERLYTIC_USERNAME;
  const apiKey = process.env.EVERLYTIC_API_KEY;
  const token = Buffer.from(`${username}:${apiKey}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * Send one email via Everlytic.
 * @param {{to: {email: string, name?: string}, subject: string, html: string}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendEmail({ to, subject, html }) {
  const baseUrl = process.env.EVERLYTIC_BASE_URL;
  const username = process.env.EVERLYTIC_USERNAME;
  const apiKey = process.env.EVERLYTIC_API_KEY;

  if (!baseUrl || !username || !apiKey || apiKey === "your-everlytic-api-key") {
    return {
      ok: false,
      error: "EVERLYTIC_BASE_URL / EVERLYTIC_USERNAME / EVERLYTIC_API_KEY are not configured in .env",
    };
  }

  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME || "Orange Funeral";

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/2.0/trans_mails`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        headers: {
          from: { [fromAddress]: fromName },
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
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail };
