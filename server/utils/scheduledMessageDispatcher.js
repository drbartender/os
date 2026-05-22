const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

// ─── Handler registry ──────────────────────────────────────────
// Keyed by message_type. Handler signature:
//   async ({ entity, recipient, scheduledMessage }) => void
// Throwing flips the row to 'failed'.
//
// Each registered handler carries metadata used by:
//   - Plan 2c rescheduleProposal to look up the offset and recompute
//     scheduled_for when an event date / balance due date changes
//   - The dispatcher itself to gate marketing-class messages on the
//     client's communication_preferences.marketing_enabled flag

const handlers = new Map();
const handlerMeta = new Map();

const VALID_ANCHORS = new Set(['event_date', 'balance_due_date', 'created_at', 'completed_at']);
const VALID_CATEGORIES = new Set(['operational', 'marketing']);

/**
 * Register a handler with optional metadata.
 *
 * @param {string} messageType
 * @param {Function} handlerFn  async ({ entity, recipient, scheduledMessage }) => void
 * @param {Object} [options]
 * @param {number|null} [options.offsetFromEventDate]
 *   Seconds offset from the anchor (negative = before, positive = after).
 *   null means the message is anchor-independent (e.g., drip touches anchored
 *   to proposal-sent timestamp, not event date) and is NOT re-anchored on
 *   reschedule.
 * @param {'event_date'|'balance_due_date'|'created_at'|'completed_at'} [options.anchor='event_date']
 *   Which field on the entity the offset is measured from. Plan 2c's
 *   reschedule cascade uses this to know whether to recompute from
 *   the new event_date, the new balance_due_date, etc.
 * @param {'operational'|'marketing'} [options.category='operational']
 *   Operational messages bypass the marketing-enabled gate (transactional
 *   under CAN-SPAM). Marketing messages are suppressed when the recipient
 *   has marketing_enabled = false.
 */
function registerHandler(messageType, handlerFn, options = {}) {
  if (typeof handlerFn !== 'function') {
    throw new Error(`registerHandler: handlerFn for '${messageType}' must be a function`);
  }
  const meta = {
    offsetFromEventDate: (options.offsetFromEventDate === null || options.offsetFromEventDate === undefined) ? null : Number(options.offsetFromEventDate),
    anchor: options.anchor || 'event_date',
    category: options.category || 'operational',
  };
  if (!VALID_ANCHORS.has(meta.anchor)) {
    throw new Error(`registerHandler: invalid anchor '${meta.anchor}' for '${messageType}'`);
  }
  if (!VALID_CATEGORIES.has(meta.category)) {
    throw new Error(`registerHandler: invalid category '${meta.category}' for '${messageType}'`);
  }
  if (meta.offsetFromEventDate !== null && !Number.isFinite(meta.offsetFromEventDate)) {
    throw new Error(`registerHandler: offsetFromEventDate must be a finite number or null for '${messageType}'`);
  }
  handlers.set(messageType, handlerFn);
  handlerMeta.set(messageType, meta);
}

/**
 * Look up the metadata for a registered message_type. Returns null when no
 * handler is registered (caller should treat that as "leave the row alone").
 *
 * Consumed primarily by Plan 2c's `reanchorPendingMessages` so the reschedule
 * cascade can recompute scheduled_for for every pending row regardless of
 * which plan registered it (2a balance reminders, 2c event-week / T-30, 2d
 * marketing). This replaces Plan 2c's local `messageOffsets` constant per
 * Gemini Finding 1.
 *
 * @param {string} messageType
 * @returns {{offsetFromEventDate: number|null, anchor: string, category: string} | null}
 */
function getHandlerMeta(messageType) {
  return handlerMeta.get(messageType) || null;
}

function _clearHandlersForTest() {
  handlers.clear();
  handlerMeta.clear();
}

function _handlersForTest() {
  return handlers;
}

// ─── Built-in suppression checks ──────────────────────────────

async function checkSuppression({ row, entity, recipient }) {
  // Archived-proposal cascade — universal rule per spec section 7.1.
  if (row.entity_type === 'proposal' && entity && entity.status === 'archived') {
    return 'archived: proposal is archived, cascade rule applies';
  }
  // Per-channel comm-prefs (clients only — staff/admin prefs handled by later plans).
  if (row.recipient_type === 'client' && recipient) {
    if (row.channel === 'email') {
      const prefs = recipient.communication_preferences || {};
      if (prefs.email_enabled === false) {
        return 'suppressed: client.communication_preferences.email_enabled is false';
      }
      if (recipient.email_status === 'bad') {
        return 'suppressed: client.email_status is bad';
      }
    }
    if (row.channel === 'sms') {
      const prefs = recipient.communication_preferences || {};
      if (prefs.sms_enabled === false) {
        return 'suppressed: client.communication_preferences.sms_enabled is false';
      }
      if (recipient.phone_status === 'bad') {
        return 'suppressed: client.phone_status is bad';
      }
    }
  }
  return null;
}

// ─── Entity / recipient lookups ──────────────────────────────

async function lookupEntity(entityType, entityId) {
  if (entityType === 'proposal') {
    const r = await pool.query(
      `SELECT id, status, event_date, event_type, event_type_custom, total_price, amount_paid, balance_due_date,
              autopay_enrolled, client_id, token, event_timezone
       FROM proposals WHERE id = $1`,
      [entityId]
    );
    return r.rows[0] || null;
  }
  if (entityType === 'client') {
    const r = await pool.query('SELECT id, name, email, phone FROM clients WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  if (entityType === 'shift') {
    const r = await pool.query('SELECT * FROM shifts WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  if (entityType === 'consult') {
    const r = await pool.query('SELECT * FROM consults WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  return null;
}

async function lookupRecipient(recipientType, recipientId) {
  if (recipientType === 'client') {
    const r = await pool.query(
      `SELECT id, name, email, phone, communication_preferences, email_status, phone_status
       FROM clients WHERE id = $1`,
      [recipientId]
    );
    return r.rows[0] || null;
  }
  // staff / admin live in users table. NOTE: `users` has no `phone` column —
  // staff phone numbers live on `contractor_profiles`. Plan 2b/2d handlers
  // that need staff phone numbers must join contractor_profiles themselves;
  // the dispatcher only loads the minimal recipient row here.
  const r = await pool.query(
    `SELECT id, email, role, communication_preferences
     FROM users WHERE id = $1`,
    [recipientId]
  );
  return r.rows[0] || null;
}

// ─── Dispatch one row ────────────────────────────────────────

async function dispatchRow(row) {
  let entity, recipient;
  try {
    [entity, recipient] = await Promise.all([
      lookupEntity(row.entity_type, row.entity_id),
      lookupRecipient(row.recipient_type, row.recipient_id),
    ]);

    if (!entity || !recipient) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `lookup failed: entity=${!!entity} recipient=${!!recipient}`]
      );
      return;
    }

    const suppressionReason = await checkSuppression({ row, entity, recipient });
    if (suppressionReason) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, suppressionReason]
      );
      return;
    }

    // Marketing-class gate (Gemini Finding 5). The handler registry carries a
    // `category` metadata field; marketing-class messages are suppressed when
    // the client opted out of marketing comms. Operational messages bypass
    // this gate (CAN-SPAM allows transactional follow-ups regardless of
    // marketing preference). Plan 2d's marketing handlers all register with
    // category='marketing'; review_request stays operational because it's a
    // post-sale transactional follow-up.
    const meta = handlerMeta.get(row.message_type);
    if (meta?.category === 'marketing' && row.recipient_type === 'client') {
      const prefs = recipient.communication_preferences || {};
      if (prefs.marketing_enabled === false) {
        await pool.query(
          "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
          [row.id, 'marketing_disabled: client.communication_preferences.marketing_enabled is false']
        );
        return;
      }
    }

    const handler = handlers.get(row.message_type);
    if (!handler) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `no handler registered for message_type '${row.message_type}'`]
      );
      return;
    }

    await handler({ entity, recipient, scheduledMessage: row });

    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
      [row.id]
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { dispatcher: 'scheduled_messages', message_type: row.message_type },
      extra: { row_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id },
    });
    console.error(`[scheduledMessageDispatcher] row ${row.id} (${row.message_type}) failed:`, err.message);
    try {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, String(err.message || err).slice(0, 500)]
      );
    } catch (markErr) {
      console.error('[scheduledMessageDispatcher] failed to mark row failed:', markErr.message);
    }
  }
}

// ─── Pull pending rows and dispatch ──────────────────────────

const BATCH_LIMIT = 100;
// Max drain passes per tick — 50 x BATCH_LIMIT = 5000 messages, well above any
// real backlog. Bounds the drain loop so a row whose terminal-status write
// keeps failing cannot spin the tick (the remainder carries to the next tick).
const MAX_DRAIN_PASSES = 50;

// Re-entrancy guard. dispatchPending is fired on a 5-min setInterval, and
// wrapScheduler does NOT serialize ticks. If one run overruns the interval, the
// next tick would re-SELECT rows the prior run has already sent but not yet
// marked 'sent' (dispatchRow sends, THEN updates) and send them again —
// duplicate balance reminders / autopay receipts. A module-level in-flight flag
// makes an overlapping tick a no-op until the prior run finishes.
let _dispatchInFlight = false;

async function dispatchPending() {
  if (_dispatchInFlight) {
    console.warn('[scheduledMessageDispatcher] previous dispatch still in flight — skipping this tick');
    return;
  }
  _dispatchInFlight = true;
  try {
    // Drain fully: keep pulling batches while the last one was full, so a
    // backlog larger than BATCH_LIMIT clears within this tick instead of
    // waiting for the next 5-min interval. dispatchRow normally moves a row out
    // of 'pending' (sent/failed/suppressed); MAX_DRAIN_PASSES bounds the loop so
    // a row whose terminal-status write itself keeps failing cannot spin the
    // tick — the remaining backlog just carries to the next interval.
    let batchSize;
    let passes = 0;
    do {
      const { rows } = await pool.query(
        `SELECT id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for
         FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC
         LIMIT $1`,
        [BATCH_LIMIT]
      );
      batchSize = rows.length;

      for (const row of rows) {
        // Sequential dispatch — keeps a single SMTP burst from blowing past
        // Resend's rate limit. If volume grows, swap to a concurrency-limited
        // Promise queue.
        await dispatchRow(row);
      }
      passes += 1;
    } while (batchSize === BATCH_LIMIT && passes < MAX_DRAIN_PASSES);
    if (batchSize === BATCH_LIMIT) {
      console.warn(`[scheduledMessageDispatcher] hit the ${MAX_DRAIN_PASSES}-pass drain cap — remaining backlog carries to the next tick`);
    }
  } finally {
    _dispatchInFlight = false;
  }
}

// ─── Built-in money-path handlers ────────────────────────────

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

function lastFour(_proposal) {
  // last4 is not stored on proposals today (only stripe_payment_method_id).
  // Return null so templates skip the line. Future task: store last4 alongside
  // the payment method id at deposit time so we can render it here.
  return null;
}

async function sendBalanceReminder({ entity, recipient, paymentMode }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new Error('balance reminder fired but balance is zero or negative');
  }
  const tpl = emailTemplates.paymentReminderClient({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    balanceDueDate: entity.balance_due_date,
    proposalUrl: proposalUrl(entity.token),
    paymentMode,
    last4: lastFour(entity),
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

async function sendBalanceDueToday({ entity, recipient }) {
  // T+0 — "balance due today" non-autopay email. Reuses paymentReminderClient
  // in manual mode but with a more urgent subject. Could be a separate template
  // later; for now, the manual variant covers the body.
  await sendBalanceReminder({ entity, recipient, paymentMode: 'manual' });
}

async function sendBalanceLate({ entity, recipient, daysLate }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new Error('late reminder fired but balance is zero or negative');
  }
  const tpl = emailTemplates.paymentReminderLate({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    proposalUrl: proposalUrl(entity.token),
    daysLate,
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

// All money-path handlers are anchored on balance_due_date (NOT event_date)
// so Plan 2c's reschedule cascade re-anchors them correctly when admin updates
// the balance due date (Gemini Finding 1 + 6 — balance-due-date updates on
// reschedule are tracked as a follow-up in Plan 2c).
const DAY_SECONDS = 86400;

registerHandler(
  'balance_reminder_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'autopay' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_reminder_non_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'manual' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_due_today',
  ({ entity, recipient }) => sendBalanceDueToday({ entity, recipient }),
  { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_late_t1',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 1 }),
  { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_late_t3',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 3 }),
  { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);

module.exports = {
  registerHandler,
  getHandlerMeta,
  dispatchPending,
  _clearHandlersForTest,
  _handlersForTest,
};
