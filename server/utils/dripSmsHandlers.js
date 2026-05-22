/**
 * Drip SMS handlers — the SMS-only touches of the unsigned-proposal drip
 * (spec 1.3): touch 1 (+1d), touch 3 (+10d), touch 5 SMS half (+21d). The drip
 * email halves (touches 2/4/5-email) live in marketingHandlers.js. Kept in a
 * separate file because marketingHandlers.js is near the file-size soft cap.
 *
 * Scheduling: scheduleDripForProposal (marketingHandlers.js) inserts the
 * scheduled_messages rows. These handlers only render + send at dispatch time.
 *
 * Each registers with anchor 'created_at' + offsetFromEventDate: null so the
 * reschedule cascade leaves them alone (a moved event_date does not change the
 * "you haven't signed yet" timeline) and category 'marketing' so the dispatcher
 * gates them on communication_preferences.marketing_enabled. priority 4 is
 * inert until Phase 4b.
 *
 * drip_touch_5_sms additionally registers multiChannel: true — it is the SMS
 * half of the +21d touch whose email half is drip_touch_5_email, and spec 7.3
 * forbids the Phase 4b delivery-failure logic from channel-substituting a
 * multi-channel touch. drip_touch_1 and drip_touch_3 are single-channel
 * SMS-only and omit it. multiChannel is also inert until Phase 4b.
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

/**
 * Load the proposal + client fields a drip SMS handler needs. Throws when the
 * proposal is gone, archived, the client has no phone, or SMS is opted out —
 * the dispatcher then marks the row 'failed' (archived is normally already
 * caught by the dispatcher's own suppression, but we re-check defensively).
 */
async function loadDripSmsContext(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_type, p.event_type_custom,
            c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
            c.communication_preferences AS comm_prefs, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) throw new Error(`drip SMS: proposal ${proposalId} not found`);
  if (proposal.status === 'archived') throw new Error('drip SMS: proposal archived');
  if (!proposal.client_phone) throw new Error('drip SMS: client has no phone');
  if (proposal.phone_status === 'bad') throw new Error('drip SMS: client phone_status is bad');
  const prefs = proposal.comm_prefs || {};
  if (prefs.sms_enabled === false) throw new Error('drip SMS: sms_enabled is false');
  return proposal;
}

function eventDateSms(eventDate) {
  if (!eventDate) return 'your event';
  const parsed = new Date(String(eventDate).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

async function sendDripSms(proposalId, messageType, bodyFn) {
  const p = await loadDripSmsContext(proposalId);
  const body = bodyFn(p);
  await sendAndLogSms({
    to: p.client_phone,
    body,
    clientId: p.client_id,
    messageType,
    recipientName: p.client_name || null,
  });
}

const DRIP_SMS_PRIORITY = 4;

function registerDripSmsHandlers() {
  registerHandler(
    'drip_touch_1',
    ({ entity }) => sendDripSms(entity.id, 'drip_touch_1', (p) => smsTemplates.dripTouch1Sms({
      eventTypeLabel: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
      eventDate: eventDateSms(p.event_date),
    })),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: DRIP_SMS_PRIORITY }
  );
  registerHandler(
    'drip_touch_3',
    ({ entity }) => sendDripSms(entity.id, 'drip_touch_3', (p) => smsTemplates.dripTouch3Sms({
      eventTypeLabel: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
      eventDate: eventDateSms(p.event_date),
      link: proposalUrl(p.token),
    })),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: DRIP_SMS_PRIORITY }
  );
  registerHandler(
    'drip_touch_5_sms',
    ({ entity }) => sendDripSms(entity.id, 'drip_touch_5_sms', (p) => smsTemplates.dripTouch5Sms({
      eventDate: eventDateSms(p.event_date),
      link: proposalUrl(p.token),
    })),
    // drip_touch_5_sms is the SMS half of the +21d drip touch — its email half
    // is the separate drip_touch_5_email row. multiChannel: true (a Phase-4b
    // registerHandler option, inert until Phase 4b — today's registerHandler
    // ignores unknown option keys, exactly as it does for priority) tells the
    // Phase 4b delivery-failure logic NOT to channel-substitute this row: each
    // half of a multi-channel touch is independent (spec 7.3). drip_touch_1 and
    // drip_touch_3 are single-channel SMS-only and deliberately omit it.
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: DRIP_SMS_PRIORITY, multiChannel: true }
  );
}

module.exports = { registerDripSmsHandlers, loadDripSmsContext };
