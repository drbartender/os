const { wrapEmail } = require('./emailTemplates');

function renderCcWrapUpEmail({ client, proposal }) {
  const firstName = String(client.name || '').split(' ')[0] || client.name || 'there';
  const subject = `Thanks for celebrating with Dr. Bartender, ${firstName}`;

  const eventDate = new Date(proposal.event_date).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const reviewLink = process.env.PUBLIC_GOOGLE_REVIEW_URL;
  const feedbackUrl = `${process.env.PUBLIC_SITE_URL}/feedback/${proposal.token}`;

  const reviewBlock = reviewLink
    ? `<p><a href="${reviewLink}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;text-decoration:none;border-radius:4px;">Leave a Google review</a></p>`
    : '';

  const html = wrapEmail(`
    <p>Hi ${firstName},</p>
    <p>Thank you for celebrating with us on ${eventDate}. We hope you had a great time!</p>
    ${reviewBlock}
    <p>We'd love your feedback, <a href="${feedbackUrl}">tell us how we did</a>.</p>
    <p>Cheers, Dallas</p>
  `);

  const text = [
    `Hi ${firstName},`,
    ``,
    `Thank you for celebrating with us on ${eventDate}.`,
    reviewLink ? `\nLeave a Google review: ${reviewLink}` : '',
    `\nWe'd love your feedback: ${feedbackUrl}`,
    `\nCheers, Dallas`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

module.exports = { renderCcWrapUpEmail };
