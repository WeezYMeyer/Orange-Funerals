function wrapper({ heading, bodyHtml, unsubToken }) {
  const base = process.env.BASE_URL || "http://localhost:3000";
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #2b2b2b; line-height: 1.6;">
    <div style="border-top: 3px solid #5b6b5b; padding-top: 20px; margin-bottom: 24px;">
      <h1 style="font-size: 20px; font-weight: normal; color: #2b2b2b; margin: 0 0 16px 0;">${heading}</h1>
    </div>
    <div style="font-size: 15px;">${bodyHtml}</div>
    <div style="margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #888;">
      ${process.env.EMAIL_FROM_NAME || "Funeral Streams"}<br/>
      <a href="${base}/unsubscribe/${unsubToken}" style="color: #888;">Unsubscribe from future emails</a>
    </div>
  </div>`;
}

function thankYouEmail({ contactName, streamTitle, unsubToken }) {
  const greeting = contactName ? `Dear ${contactName},` : "Dear friend,";
  return wrapper({
    heading: "Thank you for watching",
    unsubToken,
    bodyHtml: `
      <p>${greeting}</p>
      <p>Thank you for joining the livestream for <strong>${streamTitle}</strong>. We're grateful you were able to be present, even from a distance, and we hope it brought you some comfort.</p>
      <p>With warm regards,<br/>${process.env.EMAIL_FROM_NAME || "The Funeral Home"}</p>
    `,
  });
}

function broadcastEmail({ contactName, subjectLine, messageHtml, unsubToken }) {
  const greeting = contactName ? `Dear ${contactName},` : "Dear friend,";
  return wrapper({
    heading: subjectLine,
    unsubToken,
    bodyHtml: `<p>${greeting}</p>${messageHtml}`,
  });
}

module.exports = { thankYouEmail, broadcastEmail };
