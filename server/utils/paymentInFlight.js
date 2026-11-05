'use strict';
/**
 * Bank debit in flight (spec 2026-09-14 section 3.2). ONE definition of "a
 * payment on this proposal is still settling", read by all three checkout
 * rails, the balance reminder ladder, the public invoice and proposal
 * payloads, the polled payment-state route and the admin payment panel.
 * Nothing else reads stripe_sessions.status = 'processing' directly.
 *
 * The row state is written by the payment_intent.processing webhook
 * (routes/stripeWebhookHandlers/paymentIntentProcessing.js) and released by
 * the succeeded and payment_failed handlers. IN_FLIGHT_MAX_AGE_DAYS is the
 * backstop for a lost failed event: a processing row can never lock an
 * invoice forever (D6).
 */
const { pool } = require('../db');
const { ConflictError, ExternalServiceError } = require('./errors');
const { isValidTimezone, DEFAULT_TZ } = require('./eventTimezone');

const IN_FLIGHT_MAX_AGE_DAYS = 14;
// Mirrors publicSwitch.js: the SDK default is 80s with retries, far too long
// for a request a client is waiting on. stripe-node also retries a network
// failure twice by default, so a stall would hold a Pay click for three
// attempts; one retry keeps the ceiling near twenty seconds.
const STRIPE_CALL_TIMEOUT_MS = 10000;
const STRIPE_RETRIEVE_OPTS = Object.freeze({ timeout: STRIPE_CALL_TIMEOUT_MS, maxNetworkRetries: 1 });
// The webhook-independent backstop reads at most this many recent unresolved
// intents from Stripe per checkout click, newest first, in parallel. Measured
// on prod 2026-09-14: no proposal carried more than one in its window.
const BACKSTOP_SCAN_LIMIT = 5;
// A processing row older than this and still processing has outlived every
// bank debit Stripe describes; the hourly monitor reports it (spec review F4).
const STALE_PROCESSING_DAYS = 8;

// The LATERAL fragment the polled payment-state route joins so that route
// stays one round trip (thirteen polls per redirect). Same predicate as
// findInFlightPayments, kept here so there is still one definition. Expects
// the proposals alias `p`, yields pp_* columns; read them with
// pendingFromLateralRow. The day count is a module constant, never input.
const IN_FLIGHT_LATERAL_SQL = `LEFT JOIN LATERAL (
  SELECT s.amount AS pp_amount_cents, s.processing_at AS pp_started_at,
         s.invoice_id AS pp_invoice_id, i.invoice_number AS pp_invoice_number
    FROM stripe_sessions s LEFT JOIN invoices i ON i.id = s.invoice_id
   WHERE s.proposal_id = p.id AND s.status = 'processing'
     AND s.processing_at > NOW() - make_interval(days => ${Number(IN_FLIGHT_MAX_AGE_DAYS)})
   ORDER BY s.processing_at DESC LIMIT 1
) pp ON true`;

function toInt(v) {
  return (v === null || v === undefined) ? null : Number(v);
}

function pendingFromLateralRow(row) {
  if (!row || row.pp_amount_cents === null || row.pp_amount_cents === undefined) return null;
  return {
    amount_cents: Number(row.pp_amount_cents),
    started_at: row.pp_started_at,
    invoice_id: toInt(row.pp_invoice_id),
    invoice_number: row.pp_invoice_number || null,
  };
}

async function findInFlightPayments(proposalId, db = pool) {
  const { rows } = await db.query(
    `SELECT s.stripe_payment_intent_id,
            s.amount AS amount_cents,
            s.processing_at AS started_at,
            s.invoice_id,
            i.invoice_number
       FROM stripe_sessions s
       LEFT JOIN invoices i ON i.id = s.invoice_id
      WHERE s.proposal_id = $1
        AND s.status = 'processing'
        AND s.processing_at > NOW() - make_interval(days => $2::int)
      ORDER BY s.processing_at DESC`,
    [proposalId, IN_FLIGHT_MAX_AGE_DAYS]
  );
  return rows.map((r) => ({
    stripe_payment_intent_id: r.stripe_payment_intent_id,
    amount_cents: Number(r.amount_cents),
    started_at: r.started_at,
    invoice_id: toInt(r.invoice_id),
    invoice_number: r.invoice_number || null,
  }));
}

// Processing rows that have outlived any bank debit's window. Alert-only
// input for balanceInvoiceMonitor; a lost payment_failed event is the usual
// cause, and until the row expires it blocks every checkout on the proposal.
async function findStaleProcessingPayments(db = pool) {
  const { rows } = await db.query(
    `SELECT proposal_id, stripe_payment_intent_id, amount AS amount_cents, processing_at
       FROM stripe_sessions
      WHERE status = 'processing'
        AND processing_at < NOW() - make_interval(days => $1::int)
        AND processing_at > NOW() - make_interval(days => $2::int)
      ORDER BY processing_at ASC
      LIMIT 50`,
    [STALE_PROCESSING_DAYS, IN_FLIGHT_MAX_AGE_DAYS]
  );
  return rows.map((r) => ({
    proposal_id: Number(r.proposal_id),
    stripe_payment_intent_id: r.stripe_payment_intent_id,
    amount_cents: Number(r.amount_cents),
    processing_at: r.processing_at,
  }));
}

// The public shape (spec section 7): the newest in-flight payment, intent id
// stripped. Identical on every public route.
function toPublicPending(rows) {
  if (!rows || !rows[0]) return null;
  const { amount_cents, started_at, invoice_id, invoice_number } = rows[0];
  return { amount_cents, started_at, invoice_id, invoice_number };
}

// The 409 copy (spec section 5.1). No em dashes. event_timezone is free text
// on the row, so it is validated before it reaches the formatter: a bad zone
// must not turn the refusal into a 500.
function inFlightMessage({ amountCents, startedAt, timeZone }) {
  const dollars = `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
  const tz = isValidTimezone(timeZone) ? timeZone : DEFAULT_TZ;
  let since = '';
  if (startedAt) {
    const d = new Date(startedAt);
    if (!Number.isNaN(d.getTime())) {
      since = ` since ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz })}`;
    }
  }
  return `A ${dollars} payment for this event has been processing${since}. `
    + 'Bank payments take four to six business days to clear, and you will get a receipt by email when it does. '
    + 'If you think this is a mistake, email contact@drbartender.com.';
}

// A bank account Stripe could not verify instantly waits on microdeposits.
// No money has moved, but the intent is live and charges once verified, so a
// second intent beside it is the same double the processing state prevents.
function verificationMessage() {
  return 'A bank payment for this event is waiting on a verification step. '
    + 'Check your email from Stripe to finish it, and it will clear four to six business days after that. '
    + 'If you would rather pay another way, email contact@drbartender.com.';
}

// A succeeded intent whose webhook has not landed yet: the block is the same,
// the story is different. Nothing about bank days applies to a card that
// already cleared.
function settledMessage() {
  return 'We have already received this payment and are recording it now. '
    + 'Refresh the page in a moment. If it still shows as unpaid, email contact@drbartender.com.';
}

function isSettlingAtStripe(intent) {
  return !!intent && (intent.status === 'processing' || intent.status === 'succeeded');
}
function awaitingMicrodeposits(intent) {
  return !!intent && intent.status === 'requires_action'
    && intent.next_action && intent.next_action.type === 'verify_with_microdeposits';
}

async function retrieveIntents(stripe, intentIds) {
  const intents = new Map();
  await Promise.all(intentIds.map(async (id) => {
    try {
      intents.set(id, await stripe.paymentIntents.retrieve(id, STRIPE_RETRIEVE_OPTS));
    } catch (err) {
      // Gone at Stripe genuinely means not in flight; a null tombstone tells
      // the deposit rail's reuse branch not to ask again. Anything else is
      // unknown, and unknown is not "nothing in flight" (D7): fail closed.
      if (err && err.code === 'resource_missing') { intents.set(id, null); return; }
      throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
    }
  }));
  return intents;
}

function refuseIfSettling(intent, timeZone) {
  if (intent && intent.status === 'succeeded') {
    throw new ConflictError(settledMessage(), 'PAYMENT_IN_FLIGHT');
  }
  if (isSettlingAtStripe(intent)) {
    throw new ConflictError(
      inFlightMessage({
        amountCents: intent.amount,
        startedAt: intent.status === 'processing' && intent.created ? new Date(intent.created * 1000) : null,
        timeZone,
      }),
      'PAYMENT_IN_FLIGHT'
    );
  }
  if (awaitingMicrodeposits(intent)) {
    throw new ConflictError(verificationMessage(), 'PAYMENT_IN_FLIGHT');
  }
}

// The ONLY rail-facing guard. Both halves from ONE read of the
// proposal's recent rows. A processing row refuses without any Stripe call.
// Otherwise the newest unresolved intents are read from Stripe and refused
// when settling or awaiting microdeposits. Returns the intents it fetched (a
// null value marks one gone at Stripe) so the deposit rail's reuse branch does
// not retrieve the same one again.
async function assertNoPaymentInFlight({ proposalId, stripe, timeZone, db = pool }) {
  const { rows } = await db.query(
    `SELECT stripe_payment_intent_id, status, amount AS amount_cents, processing_at
       FROM stripe_sessions
      WHERE proposal_id = $1
        AND stripe_payment_intent_id IS NOT NULL
        AND ((status = 'processing' AND processing_at > NOW() - make_interval(days => $2::int))
          OR (status IN ('pending', 'failed') AND created_at > NOW() - make_interval(days => $2::int)))
      ORDER BY COALESCE(processing_at, created_at) DESC`,
    [proposalId, IN_FLIGHT_MAX_AGE_DAYS]
  );
  const processing = rows.find((r) => r.status === 'processing');
  if (processing) {
    throw new ConflictError(
      inFlightMessage({ amountCents: processing.amount_cents, startedAt: processing.processing_at, timeZone }),
      'PAYMENT_IN_FLIGHT'
    );
  }
  const candidates = rows.slice(0, BACKSTOP_SCAN_LIMIT).map((r) => r.stripe_payment_intent_id);
  if (!candidates.length) return { intents: new Map() };
  const intents = await retrieveIntents(stripe, candidates);
  for (const id of candidates) refuseIfSettling(intents.get(id), timeZone);
  return { intents };
}

module.exports = {
  IN_FLIGHT_MAX_AGE_DAYS,
  STALE_PROCESSING_DAYS,
  STRIPE_RETRIEVE_OPTS,
  IN_FLIGHT_LATERAL_SQL,
  pendingFromLateralRow,
  findInFlightPayments,
  findStaleProcessingPayments,
  toPublicPending,
  inFlightMessage,
  verificationMessage,
  settledMessage,
  assertNoPaymentInFlight,
};
