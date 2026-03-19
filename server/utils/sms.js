const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * Send an SMS via Twilio
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (E.164 format, e.g. +13125551234)
 * @param {string} options.body - Message text
 * @returns {Promise}
 */
async function sendSMS({ to, body }) {
  if (!to) throw new Error('SMS recipient phone number is required');
  const message = await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
  });
  console.log(`SMS sent: ${message.sid} → ${to}`);
  return message;
}

module.exports = { sendSMS };
