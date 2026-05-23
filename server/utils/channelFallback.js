/**
 * Channel substitution decision for a scheduled single-channel touch.
 *
 * Delivery-failure / opt-out fallback, spec 7.3. Pure, no I/O. The caller
 * passes the already-loaded client row.
 *
 * Channel availability for a client:
 *   - email usable: communication_preferences.email_enabled !== false
 *       AND email_status !== 'bad'
 *   - sms usable:   communication_preferences.sms_enabled !== false
 *       AND phone_status !== 'bad' AND a non-empty phone number on file
 *
 * Marketing touches (category === 'marketing'): if marketing_enabled is false
 * the touch is suppressed outright (no fallback). If marketing is on, an
 * opted-out / bad primary channel still falls back to the other channel.
 * Operational touches always attempt fallback.
 */

function emailUsable(client) {
  if (!client) return false;
  const prefs = client.communication_preferences || {};
  if (prefs.email_enabled === false) return false;
  if (client.email_status === 'bad') return false;
  return true;
}

function smsUsable(client) {
  if (!client) return false;
  const prefs = client.communication_preferences || {};
  if (prefs.sms_enabled === false) return false;
  if (client.phone_status === 'bad') return false;
  if (!client.phone || String(client.phone).trim() === '') return false;
  return true;
}

/**
 * @param {Object} args
 * @param {'email'|'sms'} args.channel the scheduled row's channel.
 * @param {Object} args.client clients row with communication_preferences,
 *   email_status, phone_status, phone.
 * @param {'operational'|'marketing'} args.category the handler's category.
 * @returns {{action: 'proceed'|'substitute'|'suppress', channel?: 'email'|'sms'}}
 */
function resolveChannelFallback({ channel, client, category }) {
  const prefs = (client && client.communication_preferences) || {};

  // Marketing touch with marketing disabled: suppress, no fallback.
  if (category === 'marketing' && prefs.marketing_enabled === false) {
    return { action: 'suppress', reason: 'marketing_disabled' };
  }

  const primaryUsable = channel === 'email' ? emailUsable(client) : smsUsable(client);
  if (primaryUsable) {
    return { action: 'proceed', channel };
  }

  // Primary channel unusable, try the alternate.
  const altChannel = channel === 'email' ? 'sms' : 'email';
  const altUsable = altChannel === 'email' ? emailUsable(client) : smsUsable(client);
  if (altUsable) {
    return { action: 'substitute', channel: altChannel };
  }

  // Neither channel works.
  return { action: 'suppress', reason: 'no_working_channel' };
}

module.exports = { resolveChannelFallback, emailUsable, smsUsable };
