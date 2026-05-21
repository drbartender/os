const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const tpl = require('./marketingEmailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { resolveEventTimezone } = require('./eventTimezone'); // Gemini Finding 4
const { PUBLIC_SITE_URL, ADMIN_URL, API_URL } = require('./urls');
const {
  isRetentionEligibleEventType,
  shouldScheduleNewYearTouch,
  shouldScheduleSixMonthsTouch,
  computeNewYearSendAt,
  computeSixMonthsOutSendAt,
  computeReviewRequestSendAt,
  computeRetentionNudgeSendAt,
  clientHasUpcomingEvent,
} = require('./retentionEligibility');
const { scheduleMessage } = require('./messageScheduling'); // from Plan 2a
const { registerHandler } = require('./scheduledMessageDispatcher'); // from Plan 2a

// NOTE: there is intentionally NO exported MARKETING_MESSAGE_TYPES list here.
// The single source of truth for marketing-class gating is the `category`
// option passed to `registerHandler(messageType, fn, { category })` below;
// the dispatcher's marketing-gate reads `getHandlerMeta(messageType).category`
// at fire time. Keeping a parallel constant would drift — leave it out.
//
// review_request is registered with category: 'operational' (transactional
// post-sale follow-up under CAN-SPAM); the dispatcher does NOT gate it on
// marketing_enabled. The other six handlers are 'marketing'.

function formatEventDateDisplay(eventDate) {
  if (!eventDate) return 'your upcoming event';
  return new Date(eventDate).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function firstName(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || 'there';
}

function dayOfWeek(eventDate) {
  if (!eventDate) return 'weekend';
  return new Date(eventDate).toLocaleDateString('en-US', { weekday: 'long' });
}

function buildUnsubscribeUrl(clientId) {
  if (!clientId) return '';
  const token = jwt.sign(
    { clientId, marketing: true },
    process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET,
    { expiresIn: '365d' }
  );
  // Reuses existing /api/email-marketing/unsubscribe — that endpoint already
  // handles a token-bearing GET and flips email_leads.status. For
  // clients.communication_preferences.marketing_enabled flips we'll add a
  // sibling endpoint in a later plan (or extend the existing one).
  return `${API_URL}/api/email-marketing/unsubscribe?token=${token}`;
}

async function loadProposalForHandler(proposalId) {
  const { rows } = await pool.query(`
    SELECT p.id, p.token, p.event_date, p.event_type, p.event_type_custom,
           p.event_timezone, p.status, p.client_id, p.created_at,
           c.name AS client_name, c.email AS client_email,
           c.communication_preferences AS comm_prefs,
           c.email_status, c.phone_status
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [proposalId]);
  return rows[0] || null;
}

// ─── Scheduling helpers ───────────────────────────────────────────

/**
 * On status='sent', schedule the email half of the unsigned-proposal drip.
 * Touches 2 (+7d), 4 (+14d), 5-email (+21d). Touches 1/3/5-sms come from Plan 3.
 *
 * Idempotent: re-calling on an already-enrolled proposal is a no-op (the
 * dispatcher's scheduleMessage upserts on the natural key
 * (entity_type, entity_id, message_type, recipient_id, channel)).
 */
async function scheduleDripForProposal(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived' || proposal.status === 'signed') return;
  if (!proposal.client_id) return;

  const anchor = new Date(); // time-of-send moment
  const day = 86400000;
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'drip_touch_2',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: new Date(anchor.getTime() + 7 * day),
  });
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'drip_touch_4',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: new Date(anchor.getTime() + 14 * day),
  });
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'drip_touch_5_email',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: new Date(anchor.getTime() + 21 * day),
  });
}

/**
 * On status='completed' (auto or manual), schedule the post-event review
 * request at event_date + 2 days, 10am EVENT-local (Gemini Finding 4).
 */
async function scheduleReviewRequest(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'review_request',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeReviewRequestSendAt(proposal.event_date, tz),
  });
}

/**
 * On sign+pay (Stripe webhook), schedule a Jan 2 New Year touch if eligible.
 * Eligible: event date is in next calendar year AND event is >=60 days into new year.
 * Send time uses event timezone (Gemini Finding 4).
 */
async function scheduleNewYearHello(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const signedAt = new Date(); // approximate; real sign moment lives on activity log
  if (!shouldScheduleNewYearTouch(signedAt, proposal.event_date)) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'new_year_hello',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeNewYearSendAt(proposal.event_date, tz),
  });
}

/**
 * W2 fix — reschedule-cascade hook for new_year_hello.
 *
 * The `new_year_hello` row is anchored to "Jan 2 of event_year at 10am
 * event-local" (computed via `computeNewYearSendAt(eventDate, tz)`). This is
 * NOT expressible as a fixed offsetFromEventDate, so Plan 2c's generic
 * `reanchorPendingMessages` cascade — which uses `eventDateMs + offset*1000`
 * — would leave the row stuck at the OLD Jan 2 if admin moves the event
 * across a year boundary. Worse, when registered with
 * `offsetFromEventDate: null`, Plan 2c's cascade explicitly skips the row.
 *
 * This helper is the per-message-type re-anchor entrypoint Plan 2c's
 * cascade calls for any message_type registered with
 * `{ anchor: 'event_date', offsetFromEventDate: null }`. Plan 2c MUST be
 * updated to detect this combination in `reanchorPendingMessages` and
 * invoke a per-type recompute helper (see the contract note below). For
 * Plan 2d, only new_year_hello falls into this bucket today.
 *
 * Strategy: DELETE the pending row (if any) and re-evaluate eligibility for
 * the new event_date via `scheduleNewYearHello`. If still eligible, a new
 * row is inserted via `scheduleMessage` with the freshly-computed
 * scheduled_for. If no longer eligible (event now in the same year or > 1
 * year out), the row is simply gone.
 *
 * Idempotent: safe to call multiple times.
 *
 * @returns {Promise<{deleted: boolean, rescheduled: boolean}>}
 */
async function recomputeNewYearHelloForProposal(proposalId) {
  const del = await pool.query(
    `DELETE FROM scheduled_messages
      WHERE entity_type = 'proposal'
        AND entity_id = $1
        AND message_type = 'new_year_hello'
        AND status = 'pending'`,
    [proposalId]
  );
  const deleted = del.rowCount > 0;
  await scheduleNewYearHello(proposalId);
  const post = await pool.query(
    `SELECT 1 FROM scheduled_messages
      WHERE entity_type = 'proposal'
        AND entity_id = $1
        AND message_type = 'new_year_hello'
        AND status = 'pending'
      LIMIT 1`,
    [proposalId]
  );
  return { deleted, rescheduled: post.rowCount > 0 };
}

/**
 * On sign+pay (Stripe webhook), schedule a 6-months-out touch if eligible.
 * Eligible: booking lead time strictly > 6 months.
 * Send time uses event timezone (Gemini Finding 4).
 */
async function scheduleSixMonthsOut(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const signedAt = new Date();
  if (!shouldScheduleSixMonthsTouch(signedAt, proposal.event_date)) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'six_months_out',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeSixMonthsOutSendAt(proposal.event_date, tz),
  });
}

/**
 * On status='completed', if event_type is in the retention whitelist,
 * schedule a T+11mo retention nudge. Uses event timezone (Gemini Finding 4).
 */
async function scheduleRetentionNudge(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;
  if (!isRetentionEligibleEventType(proposal.event_type)) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'retention_nudge',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeRetentionNudgeSendAt(proposal.event_date, tz),
  });
}

/**
 * On archive, suppress every pending scheduled message for the proposal.
 * Sent messages stay 'sent'. This is the archive cascade rule applied to
 * the new dispatcher table; existing schedulers also enforce it via their
 * WHERE clauses (Plan 1's Task 12-14).
 */
async function cancelMarketingForProposal(proposalId) {
  await pool.query(
    `UPDATE scheduled_messages
     SET status = 'suppressed'
     WHERE entity_type = 'proposal'
       AND entity_id = $1
       AND status = 'pending'`,
    [proposalId]
  );
}

// ─── Dispatcher handlers ──────────────────────────────────────────

async function loadHandlerContext(scheduledMessage) {
  const proposal = await loadProposalForHandler(scheduledMessage.entity_id);
  if (!proposal) throw new Error(`proposal ${scheduledMessage.entity_id} not found`);
  if (proposal.status === 'archived') throw new Error('proposal archived');
  if (!proposal.client_email) throw new Error('client has no email');
  if (proposal.email_status === 'bad') throw new Error('client email status is bad');

  const prefs = proposal.comm_prefs || {};
  if (prefs.email_enabled === false) throw new Error('email_enabled is false');

  return { proposal };
}

function makeMarketingTemplateContext(proposal) {
  return {
    clientName: proposal.client_name,
    clientFirstName: firstName(proposal.client_name),
    eventTypeLabel: getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    }),
    eventDateDisplay: formatEventDateDisplay(proposal.event_date),
    proposalUrl: `${PUBLIC_SITE_URL}/proposal/${proposal.token}`,
    unsubscribeUrl: buildUnsubscribeUrl(proposal.client_id),
  };
}

function handler(messageType, renderFn) {
  return async ({ scheduledMessage }) => {
    const { proposal } = await loadHandlerContext(scheduledMessage);
    const tplOut = await renderFn(proposal);
    await sendEmail({
      to: proposal.client_email,
      subject: tplOut.subject,
      html: tplOut.html,
      text: tplOut.text,
      replyTo: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    });
  };
}

async function bartenderTipHandlesForSingleBartenderEvent(proposalId) {
  // Look up the proposal's shift(s) and the assigned bartenders' tip handles.
  // Returns { bartenderName, venmoHandle, cashappHandle } when the event had
  // exactly one approved bartender; otherwise returns null so the template
  // omits the tip line.
  //
  // Schema notes (verified against server/db/schema.sql, 2026-05-20):
  //   - There is NO `shift_assignments` table. Staff-to-shift linkage uses
  //     `shift_requests` (sr.shift_id, sr.user_id, sr.status). Status values:
  //     'pending' | 'approved' | 'denied'. 'approved' is the post-confirm state.
  //   - `shifts.proposal_id` exists (ALTER TABLE shifts ADD COLUMN proposal_id).
  //   - `payment_profiles` columns: `venmo_handle`, `cashapp_handle`,
  //     `paypal_url`. There is NO `zelle_handle` column. Zelle support is
  //     intentionally OUT OF SCOPE for Plan 2d. If we later want Zelle, add
  //     a separate migration: ALTER TABLE payment_profiles ADD COLUMN
  //     IF NOT EXISTS zelle_handle TEXT. For now, omit Zelle from the tip
  //     handles entirely.
  const { rows } = await pool.query(`
    SELECT sr.user_id, cp.preferred_name AS bartender_name,
           pp.venmo_handle, pp.cashapp_handle
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
    LEFT JOIN payment_profiles pp ON pp.user_id = sr.user_id
    WHERE s.proposal_id = $1
      AND sr.status = 'approved'
  `, [proposalId]);

  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    bartenderName: r.bartender_name,
    venmoHandle: r.venmo_handle,
    cashappHandle: r.cashapp_handle,
  };
}

/**
 * Register all marketing handlers with the dispatcher.
 *
 * Each registration includes metadata (Gemini Findings 1 & 5):
 *   - category: 'marketing' → dispatcher gates on
 *     communication_preferences.marketing_enabled (Plan 2a Task 9)
 *   - offsetFromEventDate / anchor → Plan 2c's reschedule cascade uses
 *     `getHandlerMeta(messageType)` to recompute scheduled_for for any
 *     pending row when admin updates event_date or balance_due_date
 *
 * Drip touches (2, 4, 5_email) anchor to the proposal-sent moment (NOT
 * event_date), so they pass `offsetFromEventDate: null` — the cascade
 * leaves them alone on reschedule (a moved event_date doesn't change the
 * "you haven't signed yet" timeline).
 *
 * review_request is operational, not marketing (CAN-SPAM transactional
 * post-sale follow-up).
 */
const DAY_SECONDS = 86400;
const MONTH_SECONDS = 30 * DAY_SECONDS; // approximate; cascade uses calendar math at compute time for accuracy

function registerMarketingHandlers() {
  registerHandler(
    'drip_touch_2',
    handler('drip_touch_2', (p) => tpl.dripTouch2Client(makeMarketingTemplateContext(p))),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }
  );
  registerHandler(
    'drip_touch_4',
    handler('drip_touch_4', (p) => tpl.dripTouch4Client(makeMarketingTemplateContext(p))),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }
  );
  registerHandler(
    'drip_touch_5_email',
    handler('drip_touch_5_email', (p) => tpl.dripTouch5Client(makeMarketingTemplateContext(p))),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }
  );
  registerHandler(
    'new_year_hello',
    handler('new_year_hello', (p) => tpl.newYearHelloClient(makeMarketingTemplateContext(p))),
    // Anchored on event_date but the scheduled_for is computed via calendar
    // math (Jan 2 of event_year at 10am event-local) — NOT expressible as a
    // fixed offset. We register with `offsetFromEventDate: null` so Plan 2c's
    // generic offset-based reanchor MUST NOT touch this row directly.
    //
    // W2: Plan 2c's reschedule cascade MUST instead detect message_types with
    // `{ anchor: 'event_date', offsetFromEventDate: null }` and dispatch to
    // the per-type helper `recomputeNewYearHelloForProposal(proposalId)`,
    // which DELETEs the pending row and calls `scheduleNewYearHello` again
    // with the new event_date (re-evaluating eligibility). Without this hook
    // the row stays pinned to the OLD Jan 2 when admin moves an event across
    // a year boundary. See `.plan-2-contract.md` for the cross-plan contract.
    { offsetFromEventDate: null, anchor: 'event_date', category: 'marketing' }
  );
  registerHandler(
    'six_months_out',
    handler('six_months_out', (p) => tpl.sixMonthsOutClient({
      ...makeMarketingTemplateContext(p),
      potionPlannerUrl: `${PUBLIC_SITE_URL}/plan/${p.token}`,
      consultUrl: null, // wired to Cal.com once the integration plan lands
    })),
    { offsetFromEventDate: -6 * MONTH_SECONDS, anchor: 'event_date', category: 'marketing' }
  );
  registerHandler('retention_nudge', async ({ scheduledMessage }) => {
    const { proposal } = await loadHandlerContext(scheduledMessage);
    // Last-mile suppression: client has another upcoming event → skip.
    const hasUpcoming = await clientHasUpcomingEvent(proposal.client_id, proposal.id);
    if (hasUpcoming) throw new Error('SUPPRESS: client has upcoming event');
    const tplOut = tpl.retentionNudgeClient(makeMarketingTemplateContext(proposal));
    await sendEmail({
      to: proposal.client_email,
      subject: tplOut.subject,
      html: tplOut.html,
      text: tplOut.text,
      replyTo: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    });
  }, {
    offsetFromEventDate: 11 * MONTH_SECONDS,
    anchor: 'event_date',
    category: 'marketing',
  });

  registerHandler('review_request', async ({ scheduledMessage }) => {
    const { proposal } = await loadHandlerContext(scheduledMessage);
    const tipHandles = await bartenderTipHandlesForSingleBartenderEvent(proposal.id);
    const ctx = {
      ...makeMarketingTemplateContext(proposal),
      dayOfWeek: dayOfWeek(proposal.event_date),
      feedbackUrl: `${PUBLIC_SITE_URL}/feedback/${proposal.token}`,
      ...(tipHandles || {}),
    };
    const tplOut = tpl.reviewRequestClient(ctx);
    await sendEmail({
      to: proposal.client_email,
      subject: tplOut.subject,
      html: tplOut.html,
      text: tplOut.text,
      replyTo: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    });
  }, {
    offsetFromEventDate: 2 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational', // transactional post-sale follow-up under CAN-SPAM
  });
}

module.exports = {
  registerMarketingHandlers,
  scheduleDripForProposal,
  scheduleReviewRequest,
  scheduleNewYearHello,
  scheduleSixMonthsOut,
  scheduleRetentionNudge,
  recomputeNewYearHelloForProposal,
  cancelMarketingForProposal,
};
