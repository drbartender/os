// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const { pool } = require('../db');
const Sentry = require('@sentry/node');
const { sendSMS, normalizePhone } = require('./sms');
const { sendEmail } = require('./email');
const { getEventTypeLabel } = require('./eventTypes');

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'end', 'cancel', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

/**
 * Classify a message body as an opt-out / opt-in keyword.
 * Matches only when the ENTIRE trimmed body is a single keyword (Twilio's
 * own STOP handling works the same way — "stop by later" is not an opt-out).
 *
 * @param {string} body
 * @returns {'stop'|'start'|null}
 */
function detectOptKeyword(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Classify a message body as a staff shift response code (spec section 3).
 * Whole-body match only — a code buried in a sentence is treated as
 * free-form text and routed to the admin instead.
 *
 * @param {string} body
 * @returns {'confirm'|'cant'|null}
 */
function detectResponseCode(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase().replace(/['’]/g, '');
  if (word === 'confirm') return 'confirm';
  if (word === 'cant') return 'cant';
  return null;
}

/**
 * Extract the last 10 digits of a phone number for matching. Inbound numbers
 * arrive E.164 (+1XXXXXXXXXX); stored numbers are free-text. Returns null when
 * fewer than 10 digits are present.
 *
 * @param {string} phone
 * @returns {string|null}
 */
function last10(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Resolve an inbound phone number to its sender. Clients are checked first.
 *
 * @param {string} fromPhone - the inbound E.164 number (Twilio `From`)
 * @returns {Promise<
 *   {type:'client', client:{id:number,name:string,phone:string,communication_preferences:object,phone_status:string}} |
 *   {type:'staff', staffUserId:number, staff:{id:number,communication_preferences:object}} |
 *   {type:'unknown'}
 * >}
 */
async function lookupSender(fromPhone) {
  const key = last10(fromPhone);
  if (!key) return { type: 'unknown' };

  const c = await pool.query(
    `SELECT id, name, phone, communication_preferences, phone_status
     FROM clients
     WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [key]
  );
  if (c.rows[0]) return { type: 'client', client: c.rows[0] };

  const s = await pool.query(
    `SELECT u.id, u.communication_preferences
     FROM contractor_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE RIGHT(REGEXP_REPLACE(cp.phone, '\\D', '', 'g'), 10) = $1
     ORDER BY cp.updated_at DESC
     LIMIT 1`,
    [key]
  );
  if (s.rows[0]) return { type: 'staff', staffUserId: s.rows[0].id, staff: s.rows[0] };

  return { type: 'unknown' };
}

/**
 * Insert an inbound message into sms_messages. For an inbound row,
 * recipient_phone holds the SENDER's number (the external party) so the
 * column reads as "the other party's phone" for both directions; client_id
 * is the canonical link for the thread UI. The body is truncated and the
 * sender phone is defaulted so a malformed Twilio payload cannot violate the
 * NOT NULL / length constraints.
 *
 * @param {Object} args
 * @param {string} args.fromPhone - inbound E.164 sender number
 * @param {string} args.body - message text (may be empty)
 * @param {number|null} args.clientId - matched clients.id, or null
 * @param {string} [args.twilioSid] - Twilio MessageSid
 * @param {Object} [args.metadata] - extra metadata to merge
 * @returns {Promise<Object>} the inserted row
 */
async function recordInboundMessage({ fromPhone, body, clientId, twilioSid, metadata }) {
  const phone = (fromPhone || 'unknown').slice(0, 50);
  const text = (body || '').slice(0, 2000);
  const meta = { from: fromPhone || null, to: process.env.TWILIO_PHONE_NUMBER || null, ...(metadata || {}) };
  const result = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, body, message_type, status, twilio_sid, metadata)
     VALUES ('inbound', $1, $2, $3, 'general', 'received', $4, $5)
     RETURNING *`,
    [clientId || null, phone, text, twilioSid || null, JSON.stringify(meta)]
  );
  return result.rows[0];
}

/**
 * Set communication_preferences.sms_enabled = <value> for the matched sender
 * and append a STOP/START audit timestamp. No-op for an unknown sender (a
 * number with no client/staff row). The audit path is a static literal
 * (auditPath is a controlled internal constant, not user input) because
 * jsonb_set requires a text[] path.
 *
 * @param {Object} sender - a lookupSender(...) result
 * @param {boolean} enabled
 */
async function setSmsEnabled(sender, enabled) {
  // Static-literal jsonb path — '{sms_opt_in_at}' or '{sms_opt_out_at}'.
  const auditPath = enabled ? "'{sms_opt_in_at}'" : "'{sms_opt_out_at}'";
  // COALESCE guards a NULL communication_preferences column.
  if (sender.type === 'client') {
    await pool.query(
      `UPDATE clients
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.client.id, JSON.stringify(enabled)]
    );
  } else if (sender.type === 'staff') {
    await pool.query(
      `UPDATE users
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.staffUserId, JSON.stringify(enabled)]
    );
  }
  // sender.type === 'unknown' → nothing to update
}

/** Opt the sender OUT of SMS (STOP keyword). */
async function applyOptOut(sender) {
  await setSmsEnabled(sender, false);
}

/** Opt the sender back IN to SMS (START keyword). */
async function applyOptIn(sender) {
  await setSmsEnabled(sender, true);
}

/**
 * Find the texting staff member's nearest upcoming approved shift and return
 * it. `event_date >= CURRENT_DATE` and a non-terminal shift status. start_time
 * is free-text so the same-day tiebreak is best-effort.
 *
 * @param {number} staffUserId
 * @returns {Promise<Object|null>} the shift_requests+shifts row, or null
 */
async function findNearestApprovedShift(staffUserId) {
  const r = await pool.query(
    `SELECT sr.id AS request_id, s.id AS shift_id, s.event_date, s.start_time,
            s.status AS shift_status, s.client_name, s.event_type, s.event_type_custom
     FROM shift_requests sr
     JOIN shifts s ON s.id = sr.shift_id
     WHERE sr.user_id = $1
       AND sr.status = 'approved'
       AND s.event_date >= CURRENT_DATE
       AND s.status NOT IN ('completed', 'cancelled')
     ORDER BY s.event_date ASC, s.start_time ASC
     LIMIT 1`,
    [staffUserId]
  );
  return r.rows[0] || null;
}

/**
 * Handle a staff CONFIRM response code: stamp acknowledged_at on the nearest
 * upcoming approved shift_request.
 *
 * @param {number} staffUserId
 * @returns {Promise<{ok:true, shiftId:number, eventDate:string, clientName:string|null} | {ok:false, reason:'no_shift'}>}
 */
async function handleConfirm(staffUserId) {
  const shift = await findNearestApprovedShift(staffUserId);
  if (!shift) return { ok: false, reason: 'no_shift' };
  await pool.query(
    'UPDATE shift_requests SET acknowledged_at = NOW() WHERE id = $1',
    [shift.request_id]
  );
  return { ok: true, shiftId: shift.shift_id, eventDate: shift.event_date, clientName: shift.client_name || null };
}

/**
 * Handle a staff CANT response code: un-assign the staffer from their nearest
 * upcoming approved shift and re-open that shift. Does NOT clear
 * shifts.auto_assigned_at — re-staffing is left to the admin (decision: CANT
 * is flag-and-alert, not auto-restaff). Returns shift info for the alert.
 *
 * @param {number} staffUserId
 * @returns {Promise<
 *   {ok:true, shiftId:number, requestId:number, eventDate:string, clientName:string|null, eventType:string|null, eventTypeCustom:string|null} |
 *   {ok:false, reason:'no_shift'}
 * >}
 */
async function handleCant(staffUserId) {
  const shift = await findNearestApprovedShift(staffUserId);
  if (!shift) return { ok: false, reason: 'no_shift' };

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `UPDATE shift_requests
       SET status = 'denied',
           notes = TRIM(COALESCE(notes, '') || ' [Staff texted CANT ' || NOW()::date || ']')
       WHERE id = $1`,
      [shift.request_id]
    );
    // Re-open the shift so it shows as unstaffed. auto_assigned_at is left as-is
    // on purpose so processScheduledAutoAssigns does not auto-re-staff it.
    await dbClient.query(
      "UPDATE shifts SET status = 'open' WHERE id = $1 AND status <> 'cancelled'",
      [shift.shift_id]
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }

  return {
    ok: true,
    shiftId: shift.shift_id,
    requestId: shift.request_id,
    eventDate: shift.event_date,
    clientName: shift.client_name || null,
    eventType: shift.event_type || null,
    eventTypeCustom: shift.event_type_custom || null,
  };
}

/** Escape HTML metacharacters so untrusted inbound text is safe in email HTML. */
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Run an alert send without letting a failure escape. */
async function safeAlert(label, fn) {
  try {
    await fn();
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'sms-inbound-alert', alert: label } });
    }
    console.error(`[smsInbound] admin alert "${label}" failed (non-blocking):`, err.message);
  }
}

/** SMS the admin that a client texted in. ADMIN_PHONE unset means skipped. */
async function alertInboundClient(client, body) {
  await safeAlert('inbound_client', async () => {
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');
    if (!adminPhone) {
      console.log('[smsInbound] ADMIN_PHONE unset — inbound-client alert skipped');
      return;
    }
    const name = client.name || 'A client';
    // Truncate the inbound text so the outbound alert SMS cannot exceed
    // Twilio's 1600-char limit and fail to send.
    const snippet = (body || '').slice(0, 600);
    await sendSMS({
      to: adminPhone,
      body: `${name} texted Dr. Bartender: "${snippet}". Reply in the admin Messages page.`,
    });
  });
}

/**
 * Alert the admin that a staffer texted CANT. Channel by lead time: event
 * under 7 days out and ADMIN_PHONE configured fires SMS (urgent); otherwise
 * fires email. The alert is dropped only if BOTH ADMIN_PHONE and ADMIN_EMAIL
 * are unset.
 *
 * @param {Object} cant - a successful handleCant(...) result
 */
async function alertStaffCant(cant) {
  await safeAlert('staff_cant', async () => {
    const eventDate = new Date(cant.eventDate);
    const dayMs = 24 * 60 * 60 * 1000;
    const daysOut = Math.floor((eventDate.getTime() - Date.now()) / dayMs);
    const eventLabel = getEventTypeLabel({ event_type: cant.eventType, event_type_custom: cant.eventTypeCustom });
    const who = cant.clientName ? `${eventLabel} for ${cant.clientName}` : `shift #${cant.shiftId}`;
    const dateStr = eventDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');

    // Event under 7 days out fires an urgent SMS, but ONLY if ADMIN_PHONE is set.
    // If not set, fall through to email rather than dropping the alert.
    if (daysOut < 7 && adminPhone) {
      await sendSMS({
        to: adminPhone,
        body: `Staffing alert: a bartender dropped the ${who} on ${dateStr} (${daysOut < 0 ? 'past due' : daysOut + ' days out'}). The shift is re-opened and needs restaffing.`,
      });
      return;
    }
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      console.log('[smsInbound] ADMIN_PHONE and ADMIN_EMAIL both unset — staff-CANT alert skipped');
      return;
    }
    await sendEmail({
      to: adminEmail,
      subject: `Bartender dropped the ${dateStr} shift`,
      html: `<p>A bartender texted CANT for the <strong>${escapeHtml(who)}</strong> on <strong>${escapeHtml(dateStr)}</strong> (${daysOut} days out).</p><p>The shift has been re-opened and needs restaffing. It will show as unstaffed on the Events dashboard.</p>`,
      text: `A bartender texted CANT for the ${who} on ${dateStr} (${daysOut} days out). The shift has been re-opened and needs restaffing.`,
    });
  });
}

/** Email the admin about an inbound text the system took no action on. */
async function alertAdminEmail(subject, body) {
  await safeAlert('admin_email', async () => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      console.log('[smsInbound] ADMIN_EMAIL unset — admin email skipped');
      return;
    }
    await sendEmail({
      to: adminEmail,
      subject,
      html: `<p>${escapeHtml(body)}</p>`,
      text: body,
    });
  });
}

module.exports = {
  detectOptKeyword,
  detectResponseCode,
  lookupSender,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
  handleConfirm,
  findNearestApprovedShift,
  handleCant,
  alertInboundClient,
  alertStaffCant,
  alertAdminEmail,
};
