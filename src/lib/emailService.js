const db = require("./db");
const { sendEmail } = require("./mailer");
const { thankYouEmail, broadcastEmail } = require("./emailTemplates");

/**
 * Send the "thank you for watching" email to every contact who watched a
 * given stream. Safe to call more than once — it only actually sends once
 * (guarded by streams.thanks_sent_at) and skips anyone who has opted out.
 * Returns a summary of what happened.
 */
async function sendThankYouEmails(streamId) {
  const stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(streamId);
  if (!stream) throw new Error("Stream not found");
  if (stream.thanks_sent_at) {
    return { alreadySent: true, sent: 0, skipped: 0, failed: 0 };
  }

  const contacts = db
    .prepare(
      `SELECT c.* FROM contacts c
       JOIN stream_views sv ON sv.contact_id = c.id
       WHERE sv.stream_id = ?`
    )
    .all(streamId);

  const logInsert = db.prepare(
    `INSERT INTO email_logs (contact_id, stream_id, kind, subject, status) VALUES (?, ?, 'thank_you', ?, ?)`
  );

  let sent = 0,
    skipped = 0,
    failed = 0;
  const subject = `Thank you for watching — ${stream.title}`;

  for (const contact of contacts) {
    if (contact.opt_out) {
      logInsert.run(contact.id, streamId, subject, "skipped_optout");
      skipped++;
      continue;
    }
    const html = thankYouEmail({
      contactName: contact.name,
      streamTitle: stream.title,
      unsubToken: contact.unsub_token,
    });
    const result = await sendEmail({ to: { email: contact.email, name: contact.name || undefined }, subject, html });
    if (result.ok) {
      logInsert.run(contact.id, streamId, subject, "sent");
      sent++;
    } else {
      logInsert.run(contact.id, streamId, subject, "failed");
      failed++;
    }
  }

  db.prepare("UPDATE streams SET thanks_sent_at = datetime('now') WHERE id = ?").run(streamId);
  return { alreadySent: false, sent, skipped, failed, total: contacts.length };
}

/**
 * Send a one-off broadcast email to every contact who has never opted out.
 */
async function sendBroadcast({ subjectLine, messageHtml }) {
  const contacts = db.prepare("SELECT * FROM contacts WHERE opt_out = 0").all();
  const logInsert = db.prepare(
    `INSERT INTO email_logs (contact_id, stream_id, kind, subject, status) VALUES (?, NULL, 'broadcast', ?, ?)`
  );

  let sent = 0,
    failed = 0;
  for (const contact of contacts) {
    const html = broadcastEmail({
      contactName: contact.name,
      subjectLine,
      messageHtml,
      unsubToken: contact.unsub_token,
    });
    const result = await sendEmail({ to: { email: contact.email, name: contact.name || undefined }, subject: subjectLine, html });
    if (result.ok) {
      logInsert.run(contact.id, subjectLine, "sent");
      sent++;
    } else {
      logInsert.run(contact.id, subjectLine, "failed");
      failed++;
    }
  }

  return { sent, failed, total: contacts.length };
}

module.exports = { sendThankYouEmails, sendBroadcast };
