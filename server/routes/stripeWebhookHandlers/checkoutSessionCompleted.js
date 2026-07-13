// stripeWebhook concern: checkout.session.completed. Extracted verbatim from
// stripeWebhook.js — handles the bartender tip-page sessions (kind=tip) and the
// proposal Payment-Link deposit/full settlement. Returns via res on the tip-path
// early-acks and the delayed-settlement guard; otherwise falls through to the ack.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { createEventShifts } = require('../../utils/eventCreation');
const { getBookingWindow } = require('../../utils/bookingWindow');
const { notifyLastMinuteBooking } = require('../../utils/lastMinuteAlert');
const { createInvoiceOnSend, createBalanceInvoice, linkPaymentToInvoice } = require('../../utils/invoiceHelpers');
const { commitGroupChoice, sweepClientAlternatives } = require('../../utils/proposalGroupCommit');
const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
const { matchTipToEvent } = require('../../utils/payrollTips');
const { UUID_RE } = require('../../utils/tokens');
const { sendPaymentNotifications } = require('../../utils/stripePaymentNotifications');

module.exports = async function handleCheckoutSessionCompleted(event, res) {
    const session = event.data.object;

    // Tip page handler — only for sessions tagged kind=tip in metadata.
    // Non-tip sessions fall through to the proposal deposit logic below.
    if (session.metadata && session.metadata.kind === 'tip') {
      const targetUserId = parseInt(session.metadata.bartender_user_id, 10);
      const token = session.metadata.tip_page_token;
      const piId = session.payment_intent;

      // Record a tip session we cannot turn into a tips row (bad metadata) so real money
      // isn't silently lost in the Stripe balance. Idempotent on stripe_session_id. NOT
      // wrapped in try/catch: a real DB failure bubbles to a 500 so Stripe retries instead
      // of acking an unrecorded tip — i.e. a 200 here means the orphan is durably recorded.
      const recordOrphanedTip = (reason) => pool.query(
        `INSERT INTO tips_orphaned (stripe_session_id, stripe_payment_intent_id, amount_cents,
                                    attempted_token, attempted_bartender_user_id, customer_email, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (stripe_session_id) DO NOTHING`,
        [
          session.id, piId || null, session.amount_total || null,
          token || null, Number.isInteger(targetUserId) ? targetUserId : null,
          session.customer_details?.email || null, reason,
        ]
      );

      if (!Number.isInteger(targetUserId) || !token || !UUID_RE.test(token) || !piId) {
        console.error('[tip-webhook] malformed tip session metadata', session.id);
        Sentry.captureMessage('Malformed tip session metadata', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          // Never log raw metadata: tip_page_token is a live bearer credential.
          // Keep the diagnostic value (which keys were present, a token prefix).
          extra: {
            sessionId: session.id,
            metadataKeys: Object.keys(session.metadata || {}),
            tokenPrefix: (token || '').slice(0, 8) || null,
          },
        });
        await recordOrphanedTip('malformed_metadata');
        return res.json({ received: true });
      }

      if (!session.amount_total || session.amount_total <= 0) {
        console.error('[tip-webhook] non-positive amount_total', session.id);
        Sentry.captureMessage('Non-positive tip amount_total', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, amount_total: session.amount_total },
        });
        await recordOrphanedTip('non_positive_amount');
        return res.json({ received: true });
      }

      // Cross-validate metadata against the DB. The token is the source of truth —
      // if Stripe metadata's bartender_user_id disagrees with the user_id stored
      // against this token (e.g. a Payment Link was hand-edited in the Stripe
      // dashboard, or a backfill bug mis-mapped users), credit the DB user, not
      // the metadata user. Token not in DB at all = stale link from a since-rotated
      // token; ack and drop.
      const verify = await pool.query(
        'SELECT user_id FROM payment_profiles WHERE tip_page_token = $1',
        [token]
      );
      if (!verify.rows[0]) {
        console.error('[tip-webhook] tip_page_token not found in DB', session.id);
        Sentry.captureMessage('Tip session token not found in payment_profiles', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, tokenPrefix: token.slice(0, 8) },
        });
        await recordOrphanedTip('token_not_found');
        return res.json({ received: true });
      }
      const dbUserId = verify.rows[0].user_id;
      if (dbUserId !== targetUserId) {
        console.warn('[tip-webhook] metadata bartender_user_id mismatch — using DB value', session.id);
        Sentry.captureMessage('Tip metadata bartender_user_id mismatch', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, metadataUserId: targetUserId, dbUserId },
        });
      }

      const inserted = await pool.query(`
        INSERT INTO tips (tip_page_token, target_user_id, amount_cents,
                          stripe_payment_intent_id, stripe_session_id,
                          customer_email, tipped_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
        RETURNING id
      `, [
        token, dbUserId, session.amount_total, piId, session.id,
        session.customer_details?.email || null, session.created,
      ]);
      // Best-effort match the tip to its event; must not fail the webhook.
      // Tip session handled — do NOT fall through to proposal deposit logic.
      if (inserted.rows.length) {
        try { await matchTipToEvent(inserted.rows[0].id); }
        catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip', step: 'tip_match' } }); }
      }
      return res.json({ received: true });
    }

    const proposalId = session.metadata?.proposal_id;
    // Payment-Link amount mirrors the booking window at creation time (deposit,
    // or full inside the 14-day window). Read the tagged type back so the
    // proposal settles to the right status/amount. Default 'deposit' keeps
    // older links (created before payment_type was tagged) on their prior path.
    const linkPaymentType = session.metadata?.payment_type === 'full' ? 'full' : 'deposit';
    if (proposalId) {
      // Delayed-settlement guard (M9): a Checkout Session can complete with funds not
      // yet captured (payment_status 'unpaid'/'no_payment_required') for a delayed-
      // notification payment method. There are no async_payment_succeeded/failed
      // handlers and the proposal Payment Link does not pin payment_method_types, so
      // recording this as a succeeded proposal payment would credit unsettled funds.
      // Card-only today makes this a latent guard; ack without recording payment or
      // side effects when the session is present-but-not-paid.
      if (session.payment_status && session.payment_status !== 'paid') {
        console.warn(`Webhook: checkout.session.completed for proposal ${proposalId} has payment_status '${session.payment_status}' (not paid), acking without recording payment`);
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureMessage(
            `checkout_session_unpaid: proposal ${proposalId} session ${session.id} payment_status ${session.payment_status}, acked without recording`,
            'warning'
          );
        }
        return res.json({ received: true });
      }
      const dbClient = await pool.connect();
      let isFirstDelivery = false;
      // Set true in-tx for a ≤72h-out Payment-Link settlement. Gates BOTH the
      // flag UPDATE (in-tx) and the post-commit SMS blast so a Stripe retry
      // never double-flags/blasts. Mirrors payment_intent.succeeded.
      let isLastMinuteHold = false;
      let groupChoice = { committed: false, conflict: false, archivedLoserIds: [] };
      let sweptAlternativeIds = [];
      try {
        await dbClient.query('BEGIN');

        // Idempotency guard (see payment_intent.succeeded for rationale).
        // Insert payment row first; if it collides with a prior delivery of
        // the same session (same payment_intent), skip all state mutations
        // and post-commit side effects.
        const inserted = await dbClient.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, $3, $4, 'succeeded')
           ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL AND status = 'succeeded' DO NOTHING
           RETURNING id`,
          [proposalId, session.payment_intent, linkPaymentType, session.amount_total]
        );
        isFirstDelivery = inserted.rowCount === 1;

        // Unconditional: a payment_intent.succeeded that claimed isFirstDelivery first must not leave this link row 'pending' (would let it be reused). Scoped to proposal_id so a reused/orphaned link cannot mark sibling sessions succeeded.
        await dbClient.query("UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_link_id = $1 AND proposal_id = $2", [session.payment_link, proposalId]);

        if (isFirstDelivery) {
          // LOCK ORDER (see payment_intent.succeeded): client-row lock first,
          // before any group/proposal locking. Both Payment-Link types are
          // initial bookings, so this hoist is unconditional here.
          await dbClient.query(
            `SELECT c.id FROM clients c JOIN proposals p ON p.client_id = c.id
              WHERE p.id = $1 FOR UPDATE OF c`, [proposalId]);

          // Option-group choice-commit (see payment_intent.succeeded). First-writer-
          // wins marks this option chosen + archives losers in THIS tx; on conflict we
          // flag + skip conversion post-commit (the archived guard skips the credit).
          groupChoice = await commitGroupChoice(proposalId, dbClient);
          if (groupChoice.conflict && process.env.SENTRY_DSN_SERVER) {
            Sentry.captureMessage(
              `option_paid_after_decided: payment-link payment on a non-chosen option (proposal ${proposalId}, session ${session.id}) — refund manually`,
              'warning'
            );
          }

          // Same-client sweep of ungrouped alternatives (see payment_intent.succeeded).
          // Both Payment-Link types are initial bookings, so no payment-type gate here.
          if (!groupChoice.conflict) {
            const sweep = await sweepClientAlternatives(proposalId, dbClient);
            sweptAlternativeIds = sweep.sweptIds;
          }

          if (linkPaymentType === 'full') {
            // Full payment via link → additive + DERIVED status (mirrors the 'full'
            // branch of payment_intent.succeeded). Credit session.amount_total (what
            // Stripe actually captured), never a flat "= total_price": a stale link
            // baked at an old, lower total must not mark paid-in-full at the current
            // higher total (DrB would eat the gap). Guard = LIFECYCLE states only
            // (confirmed/completed/archived); the monotonic CASE makes a payment-state
            // exclusion redundant and would only drop a legitimate second credit.
            await dbClient.query(
              `UPDATE proposals
               SET amount_paid = COALESCE(amount_paid, 0) + $2, payment_type = 'full',
                   status = CASE WHEN COALESCE(amount_paid,0) + $2 >= total_price THEN 'balance_paid' ELSE 'deposit_paid' END
               WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')`,
              [proposalId, session.amount_total / 100]
            );
          } else {
            // Deposit via link → additive + derived status (same rationale): credit what
            // was charged, preserve any prior credit. Guard = LIFECYCLE states only
            // (confirmed/completed/archived); the monotonic CASE means no payment-state
            // exclusion is needed (it would only drop a legitimate second credit).
            await dbClient.query(
              `UPDATE proposals
               SET amount_paid = COALESCE(amount_paid, 0) + $2, payment_type = 'deposit',
                   status = CASE WHEN COALESCE(amount_paid,0) + $2 >= total_price THEN 'balance_paid' ELSE 'deposit_paid' END
               WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')`,
              [proposalId, session.amount_total / 100]
            );
          }

          // Last-minute staffing hold — a Payment-Link settlement is always an
          // INITIAL booking (both link types map to full/deposit, the exact
          // pair payment_intent.succeeded flags on), so no payment-type gate is
          // needed here. !conflict (F1): a settlement on a non-chosen option must
          // never flag a hold or trigger the post-commit staff SMS blast. The
          // blast is gated on this flag AND isFirstDelivery, so a Stripe retry
          // can't re-flag or re-blast. Mirrors payment_intent.succeeded.
          if (!groupChoice.conflict) {
            const lmRes = await dbClient.query(
              'SELECT event_date, event_start_time FROM proposals WHERE id = $1',
              [proposalId]
            );
            if (lmRes.rows[0]) {
              const w = getBookingWindow({
                eventDate: lmRes.rows[0].event_date,
                eventStartTime: lmRes.rows[0].event_start_time,
              });
              if (w.lastMinuteHold) {
                isLastMinuteHold = true;
                await dbClient.query(
                  'UPDATE proposals SET last_minute_hold = true WHERE id = $1',
                  [proposalId]
                );
              }
            }
          }

          await dbClient.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, $2, 'system', $3)`,
            [proposalId, linkPaymentType === 'full' ? 'paid_in_full' : 'deposit_paid', JSON.stringify({ amount: session.amount_total, payment_link: session.payment_link, payment_type: linkPaymentType })]
          );

          // Grouped winner: create the deferred Deposit/Full invoice now (idempotent,
          // after payment_type is stamped) so the link step below finds it.
          if (groupChoice.committed) {
            await createInvoiceOnSend(proposalId, dbClient);
          }

          // ── Invoice integration (parity with payment_intent.succeeded) ──
          const openInvoice = await dbClient.query(
            "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
            [proposalId]
          );
          if (openInvoice.rows[0]) {
            const paymentRow = await dbClient.query(
              'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
              [session.payment_intent, 'succeeded']
            );
            if (paymentRow.rows[0]) {
              await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, session.amount_total, dbClient);
            }
          }
          // !conflict (F2): never mint a Balance invoice on an archived non-chosen option.
          if (!groupChoice.conflict) await createBalanceInvoice(proposalId, dbClient);
        } else {
          console.log(`Webhook: duplicate checkout.session.completed for intent ${session.payment_intent} — skipping`);
        }

        await dbClient.query('COMMIT');
        if (isFirstDelivery) {
          console.log(`${linkPaymentType === 'full' ? 'Full payment' : 'Deposit'} paid (payment link) for proposal ${proposalId}`);
        }
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, {
            tags: { webhook: 'stripe', route: '/webhook', event: 'checkout.session.completed' },
          });
        }
        console.error('Webhook DB error:', dbErr);
        // Re-throw so asyncHandler returns 5xx and Stripe retries delivery.
        throw dbErr;
      } finally {
        dbClient.release();
      }

      // Non-blocking post-commit work — only on first delivery.
      if (isFirstDelivery) {
        // ≤72h booking: admin + broad-net staff SMS blast. Fire-and-forget;
        // notifyLastMinuteBooking self-guards (try/catch + Sentry, never throws).
        // Gated by isLastMinuteHold (set in-tx above, which already implies
        // !conflict) AND isFirstDelivery so a Stripe retry never re-blasts. Fired
        // BEFORE createEventShifts to mirror payment_intent.succeeded's ordering —
        // the blast reads only the proposal/client/staff rows, never shift rows,
        // so it does not depend on the shift existing first.
        if (isLastMinuteHold) notifyLastMinuteBooking(proposalId);
        // !conflict: no receipt/notify for a non-chosen option (Sentry + manual refund).
        if (!groupChoice.conflict) sendPaymentNotifications(proposalId, session.amount_total || 0, linkPaymentType);
        // A conflicting late payment on a non-chosen option must NOT convert.
        if (!groupChoice.conflict) {
          try {
            const shift = await createEventShifts(proposalId);
            if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
          } catch (shiftErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(shiftErr, {
                tags: { webhook: 'stripe', route: '/webhook' },
              });
            }
            console.error('Shift auto-creation failed (non-blocking):', shiftErr);
          }
        }
        // Best-effort post-commit reaps for archived losing options.
        for (const loserId of [...groupChoice.archivedLoserIds, ...sweptAlternativeIds]) {
          try {
            await cancelMarketingForProposal(loserId);
            await cancelPendingChangeRequestsForProposal(loserId);
          } catch (reapErr) {
            if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(reapErr, { tags: { webhook: 'stripe', reap: 'option_loser' } });
          }
        }

        // Schedule the balance-reminder ladder + pre-event reminders, same as
        // the payment_intent.succeeded path (which schedules for both deposit and
        // full). A paid-in-full link has no balance, so the balance-reminder
        // rungs self-skip; the pre-event reminders still apply.
        // !conflict: neither reminders nor sign+pay marketing for a non-chosen option.
        if (!groupChoice.conflict) {
          const { scheduleDepositPaidReminders } = require('../../utils/depositPaidSchedulers');
          await scheduleDepositPaidReminders(Number(proposalId), { source: 'checkout.session.completed' });

          // Plan 2d: a Payment-Link deposit is a genuine client sign+pay, so
          // schedule the long-lead marketing touches and suppress the drip,
          // same as the payment_intent.succeeded path.
          try {
            const { onProposalSignedAndPaid } = require('../../utils/marketingHandlers');
            await onProposalSignedAndPaid(Number(proposalId));
          } catch (marketingErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(marketingErr, {
                tags: { webhook: 'stripe', route: '/webhook', event: 'checkout.session.completed', step: 'marketing-signpay' },
              });
            }
            console.error('Marketing enroll on Payment-Link deposit failed (non-blocking):', marketingErr);
          }
        }
      }
    }
};
