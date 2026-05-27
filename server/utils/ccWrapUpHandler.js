const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendEmail } = require('./email');
const { renderCcWrapUpEmail } = require('./ccWrapUpEmailTemplate');

async function wrapUpHandler({ entity: proposal, recipient: client }) {
  const { subject, html, text } = renderCcWrapUpEmail({ client, proposal });
  await sendEmail({
    to: client.email,
    subject,
    html,
    text,
    from: 'Dr. Bartender <no-reply@drbartender.com>',
    replyTo: process.env.ADMIN_EMAIL,
  });
}

function registerCcWrapUpHandler() {
  registerHandler('post_event_wrap_up_email', wrapUpHandler, {
    offsetFromEventDate: null,      // anchor-independent; admin chooses send time
    anchor: 'event_date',           // for getHandlerMeta completeness only
    category: 'operational',        // bypasses marketing-enabled gate
    priority: 3,
    cooldownExempt: true,
    multiChannel: false,
  });
}

module.exports = { registerCcWrapUpHandler, wrapUpHandler };
