'use strict';

// staleProposalSweep — archive past-dated proposals that were never booked.
//
// Spec: docs/superpowers/specs/2026-08-20-stale-proposal-sweep-design.md
//
// The mirror of processEventCompletions (balanceScheduler.js), which completes
// past events that WERE paid. This one closes out the losing side: a quote that
// went out, the event date came and went, and nobody ever paid a deposit.
//
// ─── WHY 'accepted' IS EXEMPT ───────────────────────────────────────────────
//
// It reads like a courtesy ("a signed agreement deserves admin eyes") and it is
// also the money guard. reconcileProposalPaymentStatus (proposalStatus.js:26-28)
// demotes a fully refunded proposal to 'accepted': amount_paid is 0 but there is
// a real payment history. Sweeping 'accepted' would stamp a refunded booking
// 'event_passed' — "a lead that never booked" — which is false and destroys the
// distinction the archive_reason exists to carry.
//
// DO NOT add 'accepted' to SWEEP_STATUSES without solving that first.
//
// ─── THE DATE EXPRESSION ────────────────────────────────────────────────────
//
// AT TIME ZONE event_timezone, not CURRENT_DATE. The prod session runs in GMT,
// which rolls the date at 19:00 Chicago, so a naive comparison archives a
// Saturday-night event's quote while the party is still running.
//
// It deliberately does NOT read event_start_time. That column is free-text
// VARCHAR with mixed legacy formats, and depending on it is exactly what
// silently blocked every auto-completion until a regex guard was added. Anchored
// to midnight of event_date + 2, the sweep fires 24 to 48 hours after the event
// ends, which is the intended band.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { voidUnpaidProposalInvoice, cancelOpenInvoiceIntents } = require('./invoiceVoid');
const { reapShiftsForProposal } = require('./shiftReap');
const { notifyAdminCategory } = require('./adminNotifications');

const SWEEP_STATUSES = Object.freeze(['draft', 'sent', 'viewed', 'modified']);

// Proposal 600 is on indefinite legal hold: never archive, reap, void, chase or
// sweep it. It is already excluded twice over (it is 'confirmed', and it carries
// a payment), but the rule must not depend on a status filter that a future edit
// could widen. Applied to BOTH the sweep query and the accepted-skip query.
const LEGAL_HOLD_PROPOSAL_IDS = Object.freeze([600]);

const ARCHIVE_REASON = 'event_passed';

// A runaway bound, NOT a batch cap. The first production run is about 115 rows
// and steady state after that is 0 to 3 a day, so this never fires in normal
// operation. It exists so a future edit that widens the date expression or the
// status list cannot burn the live pipeline in one unattended tick.
const MAX_ARCHIVES_PER_RUN = 200;

const SKIP_ACTION = 'auto_archive_skipped';
const HEAL_ACTION = 'pi_cancel_incomplete';

/**
 * How many cancellations to treat as FAILED from one cancelOpenInvoiceIntents
 * result. An `aborted` call (no Stripe client, or the session lookup threw) tried
 * NOTHING, which is not the same as nothing failing: counting it as clean lets
 * the heal pass delete a marker without having retried anything, permanently
 * abandoning live PaymentIntents in the exact window the heal exists for.
 *
 * Deliberately NOT keyed on `checked === 0`: that is legitimately reached when a
 * PI failed on its own and the webhook flipped its session off `pending`, where
 * clearing the marker IS correct convergence.
 */
function cancelFailureCount(res) {
  if (!res) return 1;
  if (res.aborted) return 1;
  return res.failed || 0;
}

const CANDIDATE_SQL = `
  SELECT id, client_id, status, event_date, total_price
    FROM proposals
   WHERE status = ANY($1)
     AND event_date IS NOT NULL
     AND ((event_date + INTERVAL '2 days') AT TIME ZONE event_timezone) < NOW()
     AND COALESCE(amount_paid, 0) = 0
     AND id <> ALL($2)
   ORDER BY id`;

// 'accepted' proposals past the same threshold. Exempt from the sweep by design,
// so they need a signal or they rot silently the way the original 116 did.
const SKIP_CANDIDATE_SQL = `
  SELECT p.id, p.event_date, p.total_price
    FROM proposals p
   WHERE p.status = 'accepted'
     AND p.event_date IS NOT NULL
     AND ((p.event_date + INTERVAL '2 days') AT TIME ZONE p.event_timezone) < NOW()
     AND p.id <> ALL($1)
     AND NOT EXISTS (
       SELECT 1 FROM proposal_activity_log l
        WHERE l.proposal_id = p.id AND l.action = $2)
   ORDER BY p.id`;

/** Rows the sweep would archive right now. Pure read. */
async function selectCandidates(db = pool, excludeIds = LEGAL_HOLD_PROPOSAL_IDS) {
  const { rows } = await db.query(CANDIDATE_SQL, [SWEEP_STATUSES, excludeIds]);
  return rows;
}

/** Past-dated 'accepted' proposals not yet reported to an admin. Pure read. */
async function selectSkipCandidates(db = pool, excludeIds = LEGAL_HOLD_PROPOSAL_IDS) {
  const { rows } = await db.query(SKIP_CANDIDATE_SQL, [excludeIds, SKIP_ACTION]);
  return rows;
}

/**
 * One batched email per run naming the past-dated 'accepted' proposals the sweep
 * refused to touch.
 *
 * SEND FIRST, THEN MARK. notifyAdminCategory NEVER throws: it swallows
 * per-recipient failures and a Resend QuotaExceededError (free tier is 100/day)
 * into a Sentry breadcrumb and returns {emailed: 0}. Marking first would write
 * the marker, send nothing, and then suppress every future attempt, so the one
 * case that explicitly wants admin eyes would go permanently silent. The
 * autopay-failure path in balanceScheduler.js orders it the same way.
 *
 * The check-then-insert is not atomic across processes. That is acceptable only
 * because prod is single-instance; the re-entrancy guard covers same-process
 * overlap.
 */
async function notifySkipped() {
  const rows = await selectSkipCandidates();
  if (rows.length === 0) return { notified: [] };

  // Copy stays NEUTRAL. A refunded-then-demoted booking also lands in 'accepted'
  // (proposalStatus.js:26-28), so this must not assert "signed, never paid".
  const lines = rows.map((r) => {
    const d = r.event_date && new Date(r.event_date).toISOString().slice(0, 10);
    return `Proposal #${r.id}, event date ${d}, total $${r.total_price}`;
  });
  const subject = `${rows.length} past-dated proposal(s) in accepted need a look`;
  const intro = 'These proposals are past their event date and still sit in "accepted", '
    + 'so the auto-archive sweep left them alone on purpose. Each one needs a decision: '
    + 'archive it, record a payment, or complete it.';
  const emailText = `${intro}\n\n${lines.join('\n')}\n`;
  const emailHtml = `<p>${intro}</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;

  const send = _notifier || notifyAdminCategory;
  // smsBody omitted on purpose: email only.
  const res = await send({ category: 'routine_admin', subject, emailHtml, emailText });

  if (!res || !res.emailed) {
    console.warn('[stale_proposal_sweep] skip notice reached 0 recipients; NOT marking, will retry next run');
    Sentry.captureMessage('stale_proposal_sweep_skip_notice_undelivered', {
      level: 'warning',
      tags: { scheduler: 'stale_proposal_sweep' },
      extra: { proposalIds: rows.map((r) => r.id) },
    });
    return { notified: [] };
  }

  for (const r of rows) {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, $2, 'system', $3)`,
      [r.id, SKIP_ACTION, JSON.stringify({ via: 'stale_proposal_sweep', emailed: res.emailed })]);
  }
  return { notified: rows.map((r) => r.id) };
}

/**
 * Archive ONE proposal in its own transaction, mirroring POST /proposals/:id/archive
 * (routes/proposals/actions.js) step for step so the two archive doors cannot drift.
 *
 * @returns {Promise<null|{proposalId:number, invoiceIds:number[], reaped:Array, deletedMessages:number}>}
 *          null when the row vanished or left a swept status under the lock.
 */
async function archiveOne(proposalId) {
  // Defense in depth. Both queries already exclude these, but archiveOne is
  // exported and a future direct caller must not be able to route around the hold.
  if (LEGAL_HOLD_PROPOSAL_IDS.includes(Number(proposalId))) {
    console.warn(`[stale_proposal_sweep] refusing legal-hold proposal #${proposalId}`);
    return null;
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // LOCK ORDER (global: clients -> proposal_groups -> proposals). The client
    // row is locked BEFORE the proposal row, matching the settle paths. Locking
    // the proposal first inverts the order against a concurrent settle and can
    // deadlock AB-BA. No proposal_groups lock is needed: every group-archiving
    // path hoists the client lock first, which is what serializes them.
    const { rows: [peek] } = await db.query(
      'SELECT id, client_id FROM proposals WHERE id = $1', [proposalId]);
    if (!peek) { await db.query('ROLLBACK'); return null; }
    if (peek.client_id !== null) {
      await db.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [peek.client_id]);
    }

    const { rows: [target] } = await db.query(
      'SELECT id, status, COALESCE(amount_paid, 0) AS amount_paid FROM proposals WHERE id = $1 FOR UPDATE',
      [proposalId]);
    // Re-read under the lock: a proposal booked between selection and lock must
    // not be archived out from under the payment.
    //
    // amount_paid is re-checked, not just status. The invoice and drink_plan_extras
    // rails in paymentIntentSucceeded.js credit amount_paid with NO status guard and
    // promote status only on full payment, so a PARTIAL payment settling inside this
    // window leaves a 'sent'/'viewed' row carrying real money. Money is safe either
    // way (voidUnpaidProposalInvoice re-guards in-transaction), but archiving it would
    // stamp 'event_passed' — "a lead that never booked" — on a proposal someone paid.
    if (!target || !SWEEP_STATUSES.includes(target.status) || Number(target.amount_paid) > 0) {
      await db.query('ROLLBACK');
      return null;
    }

    await db.query(
      `UPDATE proposals SET status = 'archived', archive_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [proposalId, ARCHIVE_REASON]);

    const voidRes = await voidUnpaidProposalInvoice(proposalId, db);
    const reaped = await reapShiftsForProposal(proposalId, db, 'event passed, never booked');
    // DELETE rather than the 'suppressed' status is deliberate: it matches the
    // archive endpoint and cancel.js exactly. It is also unrecoverable — see the
    // Recovery section of the spec.
    const delRes = await db.query(
      `DELETE FROM scheduled_messages
        WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
      [proposalId]);

    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'archived', 'system', $2)`,
      [proposalId, JSON.stringify({
        archive_reason: ARCHIVE_REASON,
        via: 'stale_proposal_sweep',
        voided_invoice_ids: voidRes.invoiceIds,
        deleted_pending_messages: delRes.rowCount,
        reaped_shift_ids: reaped.map((r) => r.shiftId),
      })]);

    await db.query('COMMIT');
    return {
      proposalId,
      invoiceIds: voidRes.invoiceIds,
      reaped,
      deletedMessages: delRes.rowCount,
    };
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (rbErr) {
      console.error(`[stale_proposal_sweep] ROLLBACK failed for #${proposalId}:`, rbErr.message);
    }
    throw err;
  } finally {
    // RELEASE BEFORE THE POST-COMMIT TAIL. Every tail helper acquires its own
    // pooled connection; holding this one across them is a deadlock CLAUDE.md
    // records as twice-bitten. The archive route does the same (actions.js:527).
    db.release();
  }
}


// Test seams, mirroring stripePayoutSync's _setStripeClientForTests pattern.
let _selectCandidates = null;
function _setSelectCandidatesForTests(fn) { _selectCandidates = fn; }
let _notifier = null;
function _setNotifierForTests(fn) { _notifier = fn; }

// wrapScheduler does not serialize ticks, and the first run makes roughly 220
// live Stripe calls, which can plausibly outlast an hourly interval. Two
// overlapping runs could both pass the accepted-skip marker check before either
// inserts, and double-send the skip email. scheduledMessageDispatcher.js:661
// rolls the same guard for the same reason.
let inFlight = false;


/**
 * Post-commit side effects. Runs AFTER the sweep's pooled connection is released,
 * because every helper here takes its own. Each step is isolated: a failure must
 * never abort the batch.
 *
 * cancelOpenInvoiceIntents is a ONE-SHOT effect on an already-committed row, and
 * the helper never marks the stripe_sessions row, so a Stripe outage would strand
 * the remainder forever (an archived proposal is never re-selected). When it
 * reports failures we drop a HEAL_ACTION marker for healStrandedIntents to pick
 * up. A non-cancelable state or a metadata mismatch is a legitimate skip and
 * leaves no marker, which is why invoiceVoid distinguishes them.
 */
async function runPostCommitTail(result) {
  if (!result) return;
  const { proposalId, invoiceIds, reaped } = result;

  let failedCancels = 0;
  for (const invoiceId of invoiceIds) {
    try {
      const r = await cancelOpenInvoiceIntents(proposalId, invoiceId);
      failedCancels += cancelFailureCount(r);
    } catch (err) {
      failedCancels += 1;
      console.warn(`[stale_proposal_sweep] intent cancel threw for #${proposalId}/inv${invoiceId}:`, err.message);
    }
  }
  if (failedCancels > 0) {
    try {
      await pool.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
         VALUES ($1, $2, 'system', $3)`,
        [proposalId, HEAL_ACTION, JSON.stringify({
          via: 'stale_proposal_sweep', failed: failedCancels, invoice_ids: invoiceIds,
        })]);
    } catch (logErr) {
      console.error(`[stale_proposal_sweep] heal marker insert failed for #${proposalId}:`, logErr.message);
    }
  }

  // Near no-op after the in-transaction DELETE, kept so this door matches the
  // archive endpoint exactly.
  try {
    const { cancelMarketingForProposal } = require('./marketingHandlers');
    await cancelMarketingForProposal(proposalId);
  } catch (err) {
    console.error(`[stale_proposal_sweep] marketing reap failed for #${proposalId}:`, err.message);
  }
  try {
    const { cancelPendingChangeRequestsForProposal } = require('./changeRequests');
    await cancelPendingChangeRequestsForProposal(proposalId);
  } catch (err) {
    console.error(`[stale_proposal_sweep] change-request reap failed for #${proposalId}:`, err.message);
  }

  // Notify approved staff of the reaped shifts. EMAIL ONLY (sms: false) because
  // SMS costs money. This mirrors the archive endpoint's tail exactly
  // (actions.js:539-551); dropping it would break the "two archive doors cannot
  // drift" guarantee this whole module is built on. Prod has 0 live shifts on
  // the current backlog, so this is a no-op today and load-bearing later.
  for (const { shiftId, userIds } of (reaped || [])) {
    if (!userIds || userIds.length === 0) continue;
    try {
      const { notifyStaffOfCancellation } = require('./staffShiftHandlers');
      await notifyStaffOfCancellation({
        shiftId, staffUserIds: userIds, kind: 'cancelled', sms: false, email: true,
      });
    } catch (notifyErr) {
      console.error(`[stale_proposal_sweep] staff notify failed for shift ${shiftId}:`, notifyErr.message);
      Sentry.captureException(notifyErr, {
        tags: { scheduler: 'stale_proposal_sweep', step: 'staff-notify' },
        extra: { proposalId, shiftId },
      });
    }
  }
}

/**
 * Retry intent cancellations a previous tick could not complete. Bounded by the
 * HEAL_ACTION marker: only proposals with a RECORDED FAILURE are retried, and a
 * clean pass deletes the marker. Empty and free in steady state.
 */
async function healStrandedIntents() {
  const { rows } = await pool.query(
    `SELECT l.id AS log_id, l.proposal_id, l.details
       FROM proposal_activity_log l
       JOIN proposals p ON p.id = l.proposal_id
      WHERE l.action = $1 AND p.status = 'archived'
      ORDER BY l.id
      LIMIT $2`,
    [HEAL_ACTION, MAX_ARCHIVES_PER_RUN]);
  let healed = 0;
  for (const row of rows) {
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
    const invoiceIds = details.invoice_ids || [];
    let stillFailing = 0;
    for (const invoiceId of invoiceIds) {
      try {
        const r = await cancelOpenInvoiceIntents(row.proposal_id, invoiceId);
        stillFailing += cancelFailureCount(r);
      } catch (err) {
        stillFailing += 1;
        console.warn(`[stale_proposal_sweep] heal retry threw for #${row.proposal_id}/inv${invoiceId}:`, err.message);
      }
    }
    if (stillFailing === 0) {
      await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [row.log_id]);
      healed += 1;
    }
  }
  if (healed > 0) console.log(`[stale_proposal_sweep] healed ${healed} stranded intent set(s)`);
  return { healed, attempted: rows.length };
}

/**
 * Print what a real run WOULD do, and return both id lists. Pure read: the skip
 * query never writes, and notifySkipped is never called from here.
 */
async function logDryRunLists(candidates) {
  console.log(`[stale_proposal_sweep] DRY RUN: ${candidates.length} candidate(s) to archive`);
  for (const c of candidates) {
    const d = c.event_date && new Date(c.event_date).toISOString().slice(0, 10);
    console.log(`  #${c.id} ${c.status} event_date=${d} total=$${c.total_price}`);
  }
  const wouldSkip = await selectSkipCandidates();
  console.log(`[stale_proposal_sweep] DRY RUN: ${wouldSkip.length} accepted proposal(s) would be left for admin`);
  for (const r of wouldSkip) {
    const d = r.event_date && new Date(r.event_date).toISOString().slice(0, 10);
    console.log(`  #${r.id} accepted event_date=${d} total=$${r.total_price}`);
  }
  return { wouldArchive: candidates.map((c) => c.id), wouldSkip: wouldSkip.map((r) => r.id) };
}

/** Scheduler entry point. */
async function processStaleProposals() {
  if (inFlight) {
    console.warn('[stale_proposal_sweep] previous run still in flight; skipping this tick');
    return { archived: [], skippedIds: [], failed: 0, dryRun: false, skippedReentrant: true };
  }
  inFlight = true;
  try {
    const dryRun = process.env.STALE_PROPOSAL_SWEEP_DRY_RUN === 'true';

    // Heal BEFORE this tick's work, never after: a just-failed intent must get a
    // full interval to recover, not an immediate second attempt during an outage.
    if (!dryRun) {
      try {
        await healStrandedIntents();
      } catch (err) {
        console.error('[stale_proposal_sweep] heal pass failed:', err.message);
        Sentry.captureException(err, { tags: { scheduler: 'stale_proposal_sweep', step: 'heal' } });
      }
    }

    const candidates = await (_selectCandidates || selectCandidates)();

    if (candidates.length > MAX_ARCHIVES_PER_RUN) {
      console.error(`[stale_proposal_sweep] RUNAWAY GUARD: ${candidates.length} candidates exceeds MAX_ARCHIVES_PER_RUN=${MAX_ARCHIVES_PER_RUN}; archiving nothing`);
      Sentry.captureMessage('stale_proposal_sweep_runaway_guard', {
        level: 'error',
        tags: { scheduler: 'stale_proposal_sweep' },
        extra: { candidateCount: candidates.length, bound: MAX_ARCHIVES_PER_RUN },
      });
      // A dry run stays inert even here: no email. And it still prints both lists,
      // which is exactly what an operator staring at an implausible backlog needs.
      if (dryRun) {
        const lists = await logDryRunLists(candidates);
        return { archived: [], skippedIds: [], failed: 0, dryRun: true, abortedRunaway: true, ...lists };
      }
      // A guard that fires only into a log nobody reads is not a guard. Email,
      // never SMS. No em dashes, per the notifyAdminCategory contract.
      const subject = `Stale-proposal sweep halted: ${candidates.length} candidates`;
      const body = `The stale-proposal sweep found ${candidates.length} proposals to archive in one run, `
        + `which is above its safety bound of ${MAX_ARCHIVES_PER_RUN}. It archived NOTHING and stopped. `
        + `Steady state is 0 to 3 a day, so this almost certainly means the sweep's date rule or status `
        + `list changed and is now selecting live pipeline. Do not re-enable it until that is understood.`;
      try {
        const send = _notifier || notifyAdminCategory;
        await send({ category: 'routine_admin', subject, emailHtml: `<p>${body}</p>`, emailText: body });
      } catch (alertErr) {
        console.error('[stale_proposal_sweep] runaway alert failed:', alertErr.message);
      }
      return { archived: [], skippedIds: [], failed: 0, dryRun, abortedRunaway: true };
    }

    if (dryRun) {
      const lists = await logDryRunLists(candidates);
      return { archived: [], skippedIds: [], failed: 0, dryRun: true, abortedRunaway: false, ...lists };
    }

    const archived = [];
    let voidedInvoices = 0;
    let deletedMessages = 0;
    let failed = 0;
    // Filled by notifySkipped below; declared here so the summary line is complete.
    let skippedIds = [];
    for (const c of candidates) {
      try {
        const res = await archiveOne(c.id);
        if (res) {
          archived.push(res.proposalId);
          voidedInvoices += res.invoiceIds.length;
          deletedMessages += res.deletedMessages;
          // Tail THIS row now rather than batching every tail after the loop.
          // Batched, all ~115 archives commit before any Stripe call runs, so a
          // process death mid-tail strands every un-tailed row with NO heal marker
          // (the marker is written BY the tail). Interleaved, that window is one row.
          // Safe here: archiveOne released its pooled connection in its finally.
          await runPostCommitTail(res);
        }
      } catch (err) {
        failed += 1;
        console.error(`[stale_proposal_sweep] archive failed for #${c.id}:`, err.message);
        Sentry.captureException(err, {
          tags: { scheduler: 'stale_proposal_sweep', step: 'archive' },
          extra: { proposalId: c.id },
        });
      }
    }

    try {
      ({ notified: skippedIds } = await notifySkipped());
    } catch (err) {
      console.error('[stale_proposal_sweep] skip notice failed:', err.message);
      Sentry.captureException(err, {
        tags: { scheduler: 'stale_proposal_sweep', step: 'skip_notice' },
      });
    }

    if (archived.length > 0 || failed > 0 || skippedIds.length > 0) {
      console.log(
        `[stale_proposal_sweep] archived ${archived.length} (${archived.map((i) => `#${i}`).join(', ')}), `
        + `voided ${voidedInvoices} invoice(s), deleted ${deletedMessages} pending message(s), `
        + `${skippedIds.length} accepted skipped, ${failed} failed`
      );
    }

    // Rethrow so wrapScheduler records 'failed'. It records failure ONLY when
    // the fn throws (schedulerHealth.js), which is why balanceScheduler rethrows
    // too. Catching every row and returning quietly would let a systemic break
    // fail all 115 rows every hour while scheduler_health reads green forever.
    if (failed > 0) {
      throw new Error(`[stale_proposal_sweep] ${failed} row(s) failed of ${candidates.length} candidate(s)`);
    }

    return { archived, skippedIds, failed, dryRun: false, abortedRunaway: false };
  } finally {
    inFlight = false;
  }
}

module.exports = {
  SWEEP_STATUSES,
  LEGAL_HOLD_PROPOSAL_IDS,
  ARCHIVE_REASON,
  MAX_ARCHIVES_PER_RUN,
  SKIP_ACTION,
  HEAL_ACTION,
  selectCandidates,
  selectSkipCandidates,
  notifySkipped,
  archiveOne,
  processStaleProposals,
  cancelFailureCount,
  runPostCommitTail,
  healStrandedIntents,
  _setSelectCandidatesForTests,
  _setNotifierForTests,
};
