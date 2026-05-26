// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const { pool } = require('../db');
const Sentry = require('@sentry/node');
const { notifyAdminCategory } = require('./adminNotifications');
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
 * @returns {Promise<Object|null>} the inserted row, or null when a concurrent
 *   retry already recorded this twilio_sid
 */
async function recordInboundMessage({ fromPhone, body, clientId, twilioSid, metadata }) {
  const phone = (fromPhone || 'unknown').slice(0, 50);
  const text = (body || '').slice(0, 2000);
  const meta = { from: fromPhone || null, to: process.env.TWILIO_PHONE_NUMBER || null, ...(metadata || {}) };
  // ON CONFLICT makes a concurrent Twilio retry that raced past the
  // processInboundSms SELECT-dedup a graceful no-op instead of a 23505 → 500.
  // The partial unique index idx_sms_messages_twilio_sid is the arbiter; a null
  // twilio_sid can't conflict, so it still inserts. Returns null on a conflict.
  const result = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, body, message_type, status, twilio_sid, metadata)
     VALUES ('inbound', $1, $2, $3, 'general', 'received', $4, $5)
     ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING
     RETURNING *`,
    [clientId || null, phone, text, twilioSid || null, JSON.stringify(meta)]
  );
  return result.rows[0] || null;
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
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back or connection dropped */ }
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

/** Notify subscribed admins that a client texted in (urgent_client_reply). */
async function alertInboundClient(client, body) {
  await safeAlert('inbound_client', async () => {
    const name = client.name || 'A client';
    // Truncate the inbound text so the outbound alert SMS cannot exceed
    // Twilio's 1600-char limit and fail to send.
    const snippet = (body || '').slice(0, 600);
    const line = `${name} texted Dr. Bartender: "${snippet}". Reply in the admin Messages page.`;
    await notifyAdminCategory({
      category: 'urgent_client_reply',
      subject: `${name} replied by text`,
      emailHtml: `<p>${escapeHtml(line)}</p>`,
      emailText: line,
      smsBody: line,
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
    const outLabel = daysOut < 0 ? 'past due' : `${daysOut} days out`;

    // Always email subscribed admins. An event under 7 days out is urgent
    // enough to also text them. notifyAdminCategory sends SMS only when
    // smsBody is provided, so the lead-time branch just gates that argument.
    const smsLine = `Staffing alert: a bartender dropped the ${who} on ${dateStr} (${outLabel}). The shift is re-opened and needs restaffing.`;
    await notifyAdminCategory({
      category: 'urgent_staffing',
      subject: `Bartender dropped the ${dateStr} shift`,
      emailHtml: `<p>A bartender texted CANT for the <strong>${escapeHtml(who)}</strong> on <strong>${escapeHtml(dateStr)}</strong> (${escapeHtml(outLabel)}).</p><p>The shift has been re-opened and needs restaffing. It will show as unstaffed on the Events dashboard.</p>`,
      emailText: `A bartender texted CANT for the ${who} on ${dateStr} (${outLabel}). The shift has been re-opened and needs restaffing.`,
      ...(daysOut < 7 ? { smsBody: smsLine } : {}),
    });
  });
}

/** Notify subscribed admins about an inbound text the system took no action on. */
async function alertAdminEmail(subject, body) {
  await safeAlert('admin_email', async () => {
    await notifyAdminCategory({
      category: 'routine_admin',
      subject,
      emailHtml: `<p>${escapeHtml(body)}</p>`,
      emailText: body,
    });
  });
}

/** Format a date for staff-facing reply copy, e.g. "June 15". */
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

/**
 * Orchestrate one inbound SMS: classify, look up the sender, store the row,
 * run keyword/response-code actions, dispatch admin alerts. Returns a short
 * `outcome` for logging plus an optional `reply`. Never throws for an expected
 * condition. Dedupes on `twilioSid`: a re-delivered MessageSid is a no-op.
 *
 * @param {Object} args
 * @param {string} args.from - inbound E.164 number
 * @param {string} args.body - message text
 * @param {string} [args.twilioSid]
 * @returns {Promise<{outcome:string, reply:string|null}>}
 */
async function processInboundSms({ from, body, twilioSid }) {
  const text = (body || '').trim();

  // Idempotency: Twilio retries an inbound webhook on timeout. If this
  // MessageSid was already recorded as an inbound row, this delivery is a
  // retry — do nothing.
  if (twilioSid) {
    const dup = await pool.query(
      "SELECT 1 FROM sms_messages WHERE twilio_sid = $1 AND direction = 'inbound' LIMIT 1",
      [twilioSid]
    );
    if (dup.rowCount > 0) return { outcome: 'duplicate', reply: null };
  }

  const sender = await lookupSender(from);

  // STOP/START — handled before sender-type branching, for any sender. We
  // record the preference internally and tag metadata for audit. We do NOT
  // send our own reply: US carrier rules make Twilio send the mandated
  // STOP/START compliance reply itself.
  const optKeyword = detectOptKeyword(text);
  if (optKeyword) {
    const clientId = sender.type === 'client' ? sender.client.id : null;
    const recorded = await recordInboundMessage({ fromPhone: from, body: text, clientId, twilioSid, metadata: { opt_keyword: optKeyword } });
    // null = a concurrent retry already recorded this SID — don't double-apply.
    if (!recorded) return { outcome: 'duplicate', reply: null };
    if (optKeyword === 'stop') await applyOptOut(sender);
    else await applyOptIn(sender);
    return { outcome: `opt_${optKeyword}`, reply: null };
  }

  // Record the message (client_id set only for a client sender).
  const clientId = sender.type === 'client' ? sender.client.id : null;
  const recorded = await recordInboundMessage({ fromPhone: from, body: text, clientId, twilioSid });
  // null = a concurrent retry already recorded this SID — stop here.
  if (!recorded) return { outcome: 'duplicate', reply: null };

  if (sender.type === 'client') {
    // No auto-reply to clients — the admin replies personally from the
    // Messages page. We just alert the admin a client texted in.
    await alertInboundClient(sender.client, text);
    return { outcome: 'client_message', reply: null };
  }

  if (sender.type === 'staff') {
    const code = detectResponseCode(text);
    if (code === 'confirm') {
      const r = await handleConfirm(sender.staffUserId);
      const reply = r.ok
        ? `Confirmed from Dr. Bartender: you're acknowledged for the ${fmtDate(r.eventDate)} shift${r.clientName ? ' (' + r.clientName + ')' : ''}. See you there.`
        : 'Dr. Bartender: we did not find an upcoming shift to confirm for you. Reach out if that seems wrong.';
      return { outcome: r.ok ? 'staff_confirm' : 'staff_confirm_no_shift', reply };
    }
    if (code === 'cant') {
      const cant = await handleCant(sender.staffUserId);
      if (cant.ok) {
        await alertStaffCant(cant);
        return {
          outcome: 'staff_cant',
          reply: `Got it from Dr. Bartender: you are off the ${fmtDate(cant.eventDate)} shift${cant.clientName ? ' (' + cant.clientName + ')' : ''}. We will take it from here.`,
        };
      }
      await alertAdminEmail('Staff texted CANT but has no upcoming shift',
        `A staff member texted CANT but the system found no approved upcoming shift for them. Inbound text: "${text}"`);
      return {
        outcome: 'staff_cant_no_shift',
        reply: 'Dr. Bartender: we did not find an upcoming shift to release for you. Reach out if that seems wrong.',
      };
    }
    // Free-form staff text — route to admin, redirect the texter.
    await alertAdminEmail('Staff texted Dr. Bartender',
      `A staff member texted: "${text}". No response code matched, so no system action was taken.`);
    return {
      outcome: 'staff_freeform',
      reply: 'Dr. Bartender: this number is automated. For anything else, call or text Dallas directly.',
    };
  }

  // Unknown sender.
  await alertAdminEmail('Text from an unknown number',
    `An unrecognized number (${from}) texted Dr. Bartender: "${text}".`);
  return { outcome: 'unknown_sender', reply: null };
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
  processInboundSms,
};
