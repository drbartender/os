'use strict';

/**
 * Staff-initiated service-extension request (spec 2026-07-25 section 5.1).
 *
 * SECURITY: `auth` alone is NOT sufficient. The onboarding self-promotion hole
 * means an authenticated account is not necessarily real staff, so every
 * endpoint here requires the same predicate the staff home uses:
 *   sr.user_id = req.user.id AND sr.shift_id = $ AND sr.status = 'approved'
 *   AND sr.dropped_at IS NULL
 * Without it, any account could POST an arbitrary shift_id and fire a real SMS
 * plus a payable invoice at a real client.
 *
 * STAFF NEVER SEE THE PRICE (spec decision 2). No response in this file may
 * contain amount_cents, gratuity_cents, or any dollar figure. Every response
 * body is built from an explicit field list, never by spreading a DB row.
 */

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { serviceExtensionLimiter } = require('../../middleware/rateLimiters');
const { ValidationError, ConflictError, PermissionError } = require('../../utils/errors');
const { createInvoice, writeLineItems } = require('../../utils/invoiceHelpers');
const { SERVICE_EXTENSION_INVOICE_LABEL } = require('../../utils/proposalMoneyShared');
const { computeExtensionDelta, allowedAdditionalHours, MAX_EXTENSION_HOURS } = require('../../utils/serviceExtensionPricing');
const { eventEndInstantForDuration } = require('../../utils/eventEndInstant');
const { CURRENT_EXTENSION_TERMS_VERSION } = require('../../data/extensionTermsCopy');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

// NO router-level `auth`. This router is mounted at '/' alongside the PUBLIC
// accept router, so a pathless router.use(auth) would 401 the client payment
// path. `auth` is attached per route below.

// Grace after the contracted end during which a request may still be OPENED.
const REQUEST_GRACE_MINUTES = 15;
// How long a pending request stays payable after the contracted end. Longer than
// the open-grace on purpose: a request created at end+14min must not expire 60
// seconds later, before the client can even read the text.
const EXPIRY_GRACE_MINUTES = 30;

/**
 * Resolve the caller's assignment to this shift, or throw. Returns the shift +
 * proposal context every handler needs.
 */
async function requireAssignment(req, shiftId) {
  // s.status != 'cancelled' matches the canonical assignment predicates
  // (eventDetailsPayload.js:113, 149-150; eventDetails.js:130). Without it a
  // staffer on a cancelled shift of a live proposal could still open an
  // extension request.
  const { rows } = await pool.query(
    `SELECT s.id AS shift_id, s.proposal_id, s.event_date, s.start_time,
            p.event_duration_hours, p.status AS proposal_status, p.package_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id AND s.status != 'cancelled'
       JOIN proposals p ON p.id = s.proposal_id
      WHERE sr.user_id = $1
        AND sr.shift_id = $2
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
      LIMIT 1`,
    [req.user.id, shiftId]
  );
  if (!rows[0]) {
    // Deliberately not distinguishing "no such shift" from "not your shift":
    // a caller who is not on the job learns nothing either way.
    throw new PermissionError('You are not assigned to this event.');
  }
  return rows[0];
}

/** Window check: event start through contracted end + grace, as instants. */
async function checkWindow(ctx) {
  const end = await eventEndInstantForDuration(pool, ctx.proposal_id, Number(ctx.event_duration_hours));
  if (!end) return { ok: false, code: 'unparseable_shift_time', message: 'Could not determine this event’s start time. Contact management.' };
  const now = Date.now();
  if (now < new Date(end.startInstant).getTime()) {
    return { ok: false, code: 'too_early', message: 'You can request more time once the event has started.' };
  }
  const deadline = new Date(end.endInstant).getTime() + REQUEST_GRACE_MINUTES * 60 * 1000;
  if (now > deadline) {
    return { ok: false, code: 'too_late', message: 'The window to request more time for this event has closed.' };
  }
  return { ok: true, end };
}

/** GET /api/service-extensions/eligibility/:shiftId */
router.get('/eligibility/:shiftId', auth, asyncHandler(async (req, res) => {
  const shiftId = Number(req.params.shiftId);
  if (!Number.isInteger(shiftId) || shiftId <= 0 || shiftId > 2147483647) throw new ValidationError({ shiftId: 'Invalid shift.' });
  const ctx = await requireAssignment(req, shiftId);

  const contracted = Number(ctx.event_duration_hours);
  const [end, allowed, pendingRes, pkgRes] = await Promise.all([
    eventEndInstantForDuration(pool, ctx.proposal_id, contracted),
    // Both limits at once: the mis-scroll cap and the 2:00 AM curfew.
    allowedAdditionalHours(pool, ctx.proposal_id, contracted),
    pool.query(
      `SELECT requested_end_time, status FROM service_extensions
        WHERE proposal_id = $1 AND status = 'pending' LIMIT 1`,
      [ctx.proposal_id]
    ),
    pool.query('SELECT pricing_type, bar_type FROM service_packages WHERE id = $1', [ctx.package_id]),
  ]);

  const window = await checkWindow(ctx);
  const pkg = pkgRes.rows[0] || {};

  // The picker offers exactly what the validator will accept, and no more.
  // Offering a step that POST would refuse means a staffer promises a client
  // an end time, in person, that we then decline to sell.
  const allowedHours = allowed ? allowed.hours : 0;

  // Human labels for the picker, one per 30-minute step. Times and durations
  // only: no money, so spec decision 2 still holds.
  const stepLabels = {};
  for (let i = 1; i <= Math.round(allowedHours / 0.5); i++) {
    const added = i * 0.5;
    const e = await eventEndInstantForDuration(pool, ctx.proposal_id, contracted + added);
    if (e) stepLabels[String(added)] = `${e.endDisplay} (+${added === 0.5 ? '30 min' : added + ' hr'})`;
  }
  const maxEnd = allowedHours > 0
    ? await eventEndInstantForDuration(pool, ctx.proposal_id, contracted + allowedHours)
    : null;

  // An event already contracted to the curfew has no sellable time left. That
  // is a real ineligibility, not an empty picker the staffer has to interpret.
  const noRoom = allowed !== null && allowedHours <= 0;

  res.json({
    eligible: window.ok && pendingRes.rowCount === 0 && !noRoom,
    reason: !window.ok
      ? window.code
      : (pendingRes.rowCount > 0 ? 'already_pending' : (noRoom ? 'past_curfew' : null)),
    contractedEndDisplay: end ? end.endDisplay : null,
    contractedDurationHours: contracted,
    stepLabels,
    maxEndDisplay: maxEnd ? maxEnd.endDisplay : null,
    maxAdditionalHours: allowedHours,
    // Set only when the curfew (not the 3-hour cap) is what limits the picker,
    // so the staffer can explain the hard stop to a client who wants more.
    curfewEndDisplay: allowed && allowed.curfewBinds ? allowed.curfewDisplay : null,
    // Hosted packages need the product confirmation tick before sending.
    isHosted: pkg.pricing_type === 'per_guest',
    isClass: pkg.bar_type === 'class',
    pending: pendingRes.rows[0]
      ? { requestedEndTime: pendingRes.rows[0].requested_end_time, status: pendingRes.rows[0].status }
      : null,
  });
}));

/** POST /api/service-extensions */
router.post('/', auth, serviceExtensionLimiter, asyncHandler(async (req, res) => {
  const shiftId = Number(req.body?.shiftId);
  const requestedEndHours = Number(req.body?.requestedEndHours);
  const hostedProductConfirmed = req.body?.hostedProductConfirmed === true;

  if (!Number.isInteger(shiftId) || shiftId <= 0 || shiftId > 2147483647) throw new ValidationError({ shiftId: 'Invalid shift.' });
  if (!Number.isFinite(requestedEndHours)) {
    throw new ValidationError({ requestedEndHours: 'Choose a new end time.' });
  }

  const ctx = await requireAssignment(req, shiftId);
  if (['archived', 'completed'].includes(ctx.proposal_status)) {
    throw new ConflictError('This event is closed.', 'EVENT_CLOSED');
  }

  const window = await checkWindow(ctx);
  if (!window.ok) throw new ConflictError(window.message, window.code);

  // PRE-FLIGHT price, for validation and the hosted-confirmation gate only. The
  // authoritative price is recomputed inside the transaction below with the
  // proposal row locked; see the note there.
  const delta = await computeExtensionDelta({
    client: pool, proposalId: ctx.proposal_id, requestedDurationHours: requestedEndHours,
  });
  if (!delta.ok) {
    const messages = {
      not_an_extension: 'Pick an end time later than the contracted one.',
      over_cap: `You can add at most ${MAX_EXTENSION_HOURS} hours. Contact management for more.`,
      past_curfew: delta.curfewDisplay
        ? `Bar service cannot run past ${delta.curfewDisplay}. Pick an earlier end time.`
        : 'Bar service cannot run that late. Pick an earlier end time.',
      bad_increment: 'Pick a time on a 30 minute mark.',
      unparseable_time: 'Could not determine this event’s times. Contact management.',
      missing_package: 'This event cannot be priced online. Contact management.',
      missing_proposal: 'This event cannot be priced online. Contact management.',
    };
    throw new ValidationError({ requestedEndHours: messages[delta.reason] || 'That end time is not available.' });
  }
  if (delta.isHosted && !hostedProductConfirmed) {
    throw new ValidationError({
      hostedProductConfirmed: 'Confirm you have the product to serve the extra time.',
    });
  }

  const dbClient = await pool.connect();
  let created;
  let invoiceToken;
  let sent; // { amountCents, requestedEndDisplay } from the LOCKED reprice
  try {
    await dbClient.query('BEGIN');

    // Lock the proposal and RE-PRICE inside the transaction. The pre-flight
    // delta above was computed against an unlocked read, and the partial unique
    // index only blocks a second PENDING row: once a first extension SETTLES,
    // the index frees up while this request still holds a stale baseline. Two
    // staffers both computing from 4h could then have the first settle to 4.5h
    // and the second insert a 4h-to-5h delta, overcharging the client for a half
    // hour they already paid for and recording a contracted baseline that never
    // existed. FOR UPDATE serialises against settleExtension's own transaction.
    //
    // LOCK ORDER: proposals FIRST, then service_extensions (the INSERT below).
    // settleInTx takes the same two locks in the same order for exactly this
    // reason; reversing either side is an ABBA deadlock (40P01).
    await dbClient.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [ctx.proposal_id]);
    const priced = await computeExtensionDelta({
      client: dbClient, proposalId: ctx.proposal_id, requestedDurationHours: requestedEndHours,
    });
    if (!priced.ok) {
      // The duration moved under us and the requested end is no longer a valid
      // extension (e.g. another request already reached or passed it).
      await dbClient.query('ROLLBACK');
      throw new ConflictError(
        'This event was just extended by another request. Reload and pick a new end time.',
        'EXTENSION_BASELINE_MOVED'
      );
    }
    if (Number(priced.contractedDurationHours) !== Number(delta.contractedDurationHours)) {
      await dbClient.query('ROLLBACK');
      throw new ConflictError(
        'This event was just extended by another request. Reload and pick a new end time.',
        'EXTENSION_BASELINE_MOVED'
      );
    }

    // `priced` is authoritative from here on: it was computed under the row
    // lock. Destructured so nothing below can accidentally reach for the
    // pre-flight `delta` and persist a stale baseline or a stale amount.
    const {
      amountCents, gratuityDeltaCents, contractedEndDisplay, requestedEndDisplay,
      contractedDurationHours, requestedDurationHours, contractedEndInstant, isHosted,
    } = priced;

    const invoice = await createInvoice({
      proposalId: ctx.proposal_id,
      label: SERVICE_EXTENSION_INVOICE_LABEL,
      amountDueCents: amountCents,
      // 'sent', never 'draft': create-intent-for-invoice only accepts
      // sent/partially_paid, so a draft extension invoice would be unpayable.
      status: 'sent',
    }, dbClient);

    await writeLineItems(invoice.id, [{
      description: `Additional bar service, ${contractedEndDisplay} to ${requestedEndDisplay}`,
      quantity: 1,
      unit_price: amountCents,
      line_total: amountCents,
      // 'fee', NOT a new value. invoice_line_items.source_type carries
      // CHECK (source_type IN ('package','addon','fee','manual')) at
      // schema.sql:2004, so 'service_extension' would raise 23514 on
      // every single request, and the catch below only special-cases 23505.
      // The extension is identified by the invoice's LABEL, not by this column.
      source_type: 'fee',
      source_id: null,
    }], dbClient);

    // Payable until the contracted end + EXPIRY_GRACE_MINUTES, floored at
    // 15 minutes from NOW so a request opened late in the open-grace window
    // still gets a usable life instead of expiring on the next sweep tick.
    const contractedEndMs = new Date(contractedEndInstant).getTime();
    const expiresAt = new Date(Math.max(
      contractedEndMs + EXPIRY_GRACE_MINUTES * 60 * 1000,
      Date.now() + 15 * 60 * 1000
    ));

    // The partial unique index on (proposal_id) WHERE status='pending' is what
    // makes a concurrent second request a clean 409 instead of a double charge.
    const ins = await dbClient.query(
      `INSERT INTO service_extensions
         (proposal_id, shift_id, requested_by_user_id, invoice_id,
          contracted_end_time, requested_end_time,
          contracted_duration_hours, requested_duration_hours,
          amount_cents, gratuity_cents, hosted_product_confirmed,
          terms_version, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)
       RETURNING id, requested_end_time, status`,
      [
        ctx.proposal_id, shiftId, req.user.id, invoice.id,
        contractedEndDisplay, requestedEndDisplay,
        contractedDurationHours, requestedDurationHours,
        amountCents, gratuityDeltaCents,
        isHosted ? hostedProductConfirmed : null,
        CURRENT_EXTENSION_TERMS_VERSION, expiresAt,
      ]
    );
    created = ins.rows[0];
    invoiceToken = invoice.token;
    // Carry the authoritative figures out to the post-commit tail.
    sent = { amountCents, requestedEndDisplay };

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'extension_requested', 'staff', $2, $3::jsonb)`,
      [ctx.proposal_id, req.user.id, JSON.stringify({
        extension_id: created.id,
        requested_end: requestedEndDisplay,
        amount_cents: amountCents,
      })]
    );

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    // 23505 on the partial unique index = another staffer got there first.
    if (err.code === '23505') {
      throw new ConflictError(
        'Another request for this event is already with the client.',
        'EXTENSION_ALREADY_PENDING'
      );
    }
    // 40P01 deadlock / 40001 serialization: the lock order above is designed so
    // this should not happen, but a future caller could reintroduce it. Surface a
    // retryable conflict rather than a 500 so the staffer just taps again.
    if (err.code === '40P01' || err.code === '40001') {
      throw new ConflictError(
        'Someone else was updating this event just now. Tap again.',
        'EXTENSION_CONFLICT_RETRY'
      );
    }
    throw err;
  } finally {
    // Release BEFORE notifying: the notify helpers take their own pooled
    // connections (CLAUDE.md one-pooled-connection rule).
    dbClient.release();
  }

  // Post-commit tail. A send failure must not undo a created request, and it
  // must not 500 a response whose invoice and pending row are already
  // COMMITTED: an error here would skip the admin alerts too, leaving a live
  // request nobody was told about while the staffer's retry hits the
  // one-pending index. Degrade to clientNotified:false + Sentry instead.
  // Uses the LOCKED figures (`sent`), never the pre-flight `delta`: the client
  // must be quoted exactly what the invoice says.
  let reachable = false;
  try {
    const reach = await notify.notifyClientOfRequest({
      proposalId: ctx.proposal_id,
      invoiceToken,
      amountCents: sent.amountCents,
      newEndDisplay: sent.requestedEndDisplay,
      termsVersion: CURRENT_EXTENSION_TERMS_VERSION,
    });
    reachable = reach.reachable;
    await notify.alertAdminsRequestSent({
      proposalId: ctx.proposal_id,
      newEndDisplay: sent.requestedEndDisplay,
      amountCents: sent.amountCents,
      requesterUserId: req.user.id,
      clientReachable: reachable,
    });
    if (!reachable) {
      await notify.alertAdminsProblem({
        proposalId: ctx.proposal_id,
        kind: 'client_unreachable',
        detail: `The extension link could not be delivered by SMS or email. Relay it manually: /invoice/${invoiceToken}`,
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      extra: { proposalId: ctx.proposal_id, extensionId: created.id, phase: 'post_commit_notify' },
    });
  }

  // Explicit field list. No price, ever (spec decision 2).
  res.status(201).json({
    id: created.id,
    status: created.status,
    requestedEndTime: created.requested_end_time,
    clientNotified: reachable,
  });
}));

module.exports = router;
