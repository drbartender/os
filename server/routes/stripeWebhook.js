// Stripe webhook event handlers, extracted verbatim from stripe.js to keep that file
// under the line-count cap. Mounted by stripe.js via router.use(require('./stripeWebhook')),
// so the final path stays /api/stripe/webhook and the raw-body middleware (server/index.js)
// still applies. sendPaymentNotifications lives in utils/stripePaymentNotifications.js.
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { createEventShifts } = require('../utils/eventCreation');
const { getBookingWindow } = require('../utils/bookingWindow');
const { notifyLastMinuteBooking } = require('../utils/lastMinuteAlert');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { createInvoiceOnSend, createBalanceInvoice, linkPaymentToInvoice, createDrinkPlanExtrasInvoice, findExtrasInvoice, findOpenInvoiceForBalance } = require('../utils/invoiceHelpers');
const { commitGroupChoice } = require('../utils/proposalGroupCommit');
const { cancelMarketingForProposal } = require('../utils/marketingHandlers');
const { cancelPendingChangeRequestsForProposal } = require('../utils/changeRequests');
const { notifyClientPaymentFailed } = require('../utils/paymentFailedClientNotify');
const asyncHandler = require('../middleware/asyncHandler');
const { ADMIN_URL } = require('../utils/urls');
const { matchTipToEvent } = require('../utils/payrollTips');
const { clawbackTipByPaymentIntent } = require('../utils/payrollClawback');
const { esc } = require('../utils/htmlEscape');
const { UUID_RE } = require('../utils/tokens');

const router = express.Router();

const { getLiveClient, getTestClient } = require('../utils/stripeClient');
const { eventLabelFor } = require('../utils/stripeRouteHelpers');
const { sendPaymentNotifications } = require('../utils/stripePaymentNotifications');

router.post('/webhook', asyncHandler(async (req, res) => {
  // Try BOTH live and test secrets so events that span a test/live cutoff
  // (e.g., Stripe retrying a `payment_intent.succeeded` as the cutoff passes)
  // are still verified and processed. Whichever client verified the event is
  // the one whose API keypair matches the event's mode.
  const sig = req.headers['stripe-signature'];
  const verifiers = [
    { secret: process.env.STRIPE_WEBHOOK_SECRET, client: getLiveClient() },
    { secret: process.env.STRIPE_WEBHOOK_SECRET_TEST, client: getTestClient() },
  ].filter(v => v.secret && v.client);

  if (verifiers.length === 0) {
    return res.status(503).send('Payments not configured');
  }

  let event = null;
  let stripeForEvent = null;
  for (const { secret, client } of verifiers) {
    try {
      event = client.webhooks.constructEvent(req.body, sig, secret);
      stripeForEvent = client;
      break;
    } catch (_) { /* try next secret */ }
  }
  if (!event) {
    console.error('Webhook signature verification failed against all configured secrets');
    Sentry.captureMessage('Stripe webhook signature failure', {
      level: 'warning',
      tags: { webhook: 'stripe', reason: 'invalid_signature' },
    });
    return res.status(400).send('Webhook signature verification failed');
  }
  // `stripeForEvent` is intentionally available for any downstream Stripe API
  // calls inside this handler so we use the keypair matching the event's mode.
  void stripeForEvent;

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      const dbClient = await pool.connect();
      let isFirstDelivery = false;
      // Set true in-tx for an initial-booking ≤72h-out payment. Gates BOTH the flag
      // UPDATE (in-tx) and post-commit SMS so a Stripe retry never double-flags/blasts.
      let isLastMinuteHold = false;
      // Option-group choice-commit result (set in-tx below); read post-commit to
      // gate conversion and run the losing options' best-effort reaps.
      let groupChoice = { committed: false, conflict: false, archivedLoserIds: [] };
      try {
        await dbClient.query('BEGIN');

        // Idempotency: Stripe retries on transient delivery failure. Insert the
        // payment row FIRST with ON CONFLICT DO NOTHING; rowCount === 0 = duplicate
        // delivery → skip all state mutations and post-commit side effects.
        const inserted = await dbClient.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, $3, $4, 'succeeded')
           ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL AND status = 'succeeded' DO NOTHING
           RETURNING id`,
          [proposalId, intent.id, paymentType, intent.amount]
        );
        isFirstDelivery = inserted.rowCount === 1;

        if (isFirstDelivery) {
          // Option-group choice-commit — runs BEFORE the credit. First-writer-wins
          // marks this option chosen + archives the losers (voiding their unpaid
          // invoices) in THIS tx. On conflict (a 2nd option paying after another
          // already won) the amount_paid guards below skip the archived row's credit;
          // we flag it and skip conversion post-commit.
          groupChoice = await commitGroupChoice(proposalId, dbClient);
          if (groupChoice.conflict && process.env.SENTRY_DSN_SERVER) {
            Sentry.captureMessage(
              `option_paid_after_decided: payment on a non-chosen option (proposal ${proposalId}, intent ${intent.id}) — refund manually`,
              'warning'
            );
          }

          // Determine new status and amount_paid based on payment type
          if (paymentType === 'full') {
            // Additive + DERIVED status, never a flat "= total_price": credit what was actually charged so a mid-flight total change (admin edit / second-tab gratuity) can't mark paid-in-full at an amount the client never paid (DrB would eat the gap). Mirrors the invoice/drink-plan branches.
            // Guard = LIFECYCLE states only (confirmed/completed/archived — a payment
            // must not rewind those). The CASE keeps status monotonic, so excluding a
            // PAYMENT state would only drop a legitimate second distinct-intent credit
            // in a two-tab double-confirm race.
            await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $2, payment_type = 'full',
                  status = CASE WHEN COALESCE(amount_paid,0) + $2 >= total_price THEN 'balance_paid' ELSE 'deposit_paid' END
              WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')
            `, [proposalId, intent.amount / 100]);
          } else if (paymentType === 'balance') {
            // Guard archived too — an admin can archive a proposal between the
            // client opening Stripe and the webhook landing. Reviving it would
            // break the documented archived → only-draft state machine.
            // Additive + derived status (same rationale as 'full'): credit what was charged, never "= total_price".
            await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $2, autopay_status = NULL,
                  status = CASE WHEN COALESCE(amount_paid,0) + $2 >= total_price THEN 'balance_paid' ELSE 'deposit_paid' END
              WHERE id = $1 AND status = 'deposit_paid'
            `, [proposalId, intent.amount / 100]);
          } else if (paymentType === 'drink_plan_extras' || paymentType === 'drink_plan_with_balance') {
            // Drink plan extras payment — increment amount_paid
            const paidDollars = intent.amount / 100;
            const updateRes = await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $1
              WHERE id = $2
              RETURNING amount_paid, total_price
            `, [paidDollars, proposalId]);

            if (updateRes.rows[0]) {
              const newAmountPaid = Number(updateRes.rows[0].amount_paid);
              const totalPrice = Number(updateRes.rows[0].total_price);
              if (newAmountPaid >= totalPrice) {
                await dbClient.query(
                  "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')",
                  [proposalId]
                );
              }
            }
          } else if (paymentType === 'invoice') {
            // Invoice payment (Balance / Additional Services / manual invoice paid
            // via the public invoice page). Roll the captured amount up into the
            // proposal and promote to balance_paid once fully paid. Increment —
            // never "set to total" — so partial invoice payments and Additional
            // Services (which push amount_paid ABOVE total_price) are correct.
            // Mirrors the drink_plan_extras branch. Idempotent: this whole block
            // is inside isFirstDelivery (gated by the proposal_payments ON CONFLICT
            // insert), so a Stripe retry never re-increments.
            const paidDollars = intent.amount / 100;
            const upd = await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $1
              WHERE id = $2
              RETURNING amount_paid, total_price
            `, [paidDollars, proposalId]);
            if (upd.rows[0] && Number(upd.rows[0].amount_paid) >= Number(upd.rows[0].total_price)) {
              await dbClient.query(
                "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')",
                [proposalId]
              );
            }
          } else {
            // deposit — additive + DERIVED status (mirror the full branch): credit what
            // Stripe actually charged, never a flat "= deposit_amount", so a prior
            // amount_paid credit is preserved. Guard = LIFECYCLE states only: excluding
            // deposit_paid here would DROP the second credit when a client double-confirms
            // two same-amount deposit intents (fixed deposit amount → both survive the
            // stale-cancel), silently under-crediting a real charge. Idempotent via the
            // proposal_payments ON CONFLICT gate above.
            await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $2, payment_type = 'deposit',
                  status = CASE WHEN COALESCE(amount_paid,0) + $2 >= total_price THEN 'balance_paid' ELSE 'deposit_paid' END
              WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')
            `, [proposalId, intent.amount / 100]);
          }

          // Last-minute staffing hold — only for INITIAL-booking branches (full;
          // deposit covered defensively even though create-intent rejects a ≤14d
          // deposit). balance / drink_plan_* / invoice are post-conversion and
          // must never flip the hold. The post-commit SMS blast is gated on this
          // flag AND isFirstDelivery, so a Stripe retry can't re-flag or re-blast.
          // !conflict (F1): a payment on a non-chosen option must never flag a
          // last-minute hold or trigger the post-commit staff SMS blast.
          if ((paymentType === 'full' || paymentType === 'deposit') && !groupChoice.conflict) {
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

          // Save payment method ID if autopay was enrolled (card saved via setup_future_usage).
          // !conflict: never attach a card ref to an archived non-chosen option.
          if (intent.payment_method && paymentType === 'deposit' && !groupChoice.conflict) {
            await dbClient.query(`
              UPDATE proposals
              SET stripe_payment_method_id = $1
              WHERE id = $2 AND autopay_enrolled = true AND stripe_payment_method_id IS NULL
            `, [intent.payment_method, proposalId]);
          }

          await dbClient.query(
            "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_intent_id = $1",
            [intent.id]
          );

          const action = paymentType === 'balance' ? 'balance_paid'
            : paymentType === 'full' ? 'paid_in_full'
            : paymentType === 'drink_plan_extras' ? 'drink_plan_extras_paid'
            : paymentType === 'drink_plan_with_balance' ? 'drink_plan_balance_paid'
            : paymentType === 'invoice' ? 'invoice_paid'
            : 'deposit_paid';
          await dbClient.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, $2, 'system', $3)`,
            [proposalId, action, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType })]
          );

          // Grouped winner: its Deposit/Full invoice was deferred at send. Create it
          // now (idempotent on proposal_id, AFTER payment_type is stamped so Deposit
          // vs Full is picked correctly) so the link step below finds an open invoice.
          if (groupChoice.committed) {
            await createInvoiceOnSend(proposalId, dbClient);
          }

          // ── Invoice integration ──────────────────────────────────
          const invoiceId = intent.metadata?.invoice_id;
          const paymentRow = await dbClient.query(
            'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
            [intent.id, 'succeeded']
          );
          if (paymentRow.rows[0]) {
            const paymentRowId = paymentRow.rows[0].id;

            if (invoiceId) {
              // Cross-check ownership before linking: only credit an invoice that actually
              // belongs to this proposal, so a payment can never land on another proposal's
              // invoice even if the intent metadata is inconsistent. Mirrors the
              // proposal-scoped invoice lookups in the branches below.
              const invOwner = await dbClient.query(
                'SELECT id FROM invoices WHERE id = $1 AND proposal_id = $2',
                [Number(invoiceId), proposalId]
              );
              if (invOwner.rows[0]) {
                await linkPaymentToInvoice(Number(invoiceId), paymentRowId, intent.amount, dbClient);
              } else {
                // Not a full no-op: the proposal-level amount_paid UPDATE above has
                // already credited this payment. Only the invoice link is refused —
                // the orphan is the missing invoice_payments row, reconciled manually
                // off the Sentry warning below.
                console.warn(`Webhook: invoice ${invoiceId} does not belong to proposal ${proposalId} (intent ${intent.id}); payment not linked`);
                if (process.env.SENTRY_DSN_SERVER) {
                  Sentry.captureMessage(
                    `Webhook invoice/proposal mismatch (invoice ${invoiceId}, proposal ${proposalId}, intent ${intent.id}); payment not linked`,
                    'warning'
                  );
                }
              }
            } else if (paymentType === 'drink_plan_extras' || paymentType === 'drink_plan_with_balance') {
              // Idempotency: this block is inside `if (isFirstDelivery)` above, so
              // Stripe retries won't re-create the extras invoice. If lifted out,
              // add ON CONFLICT to createDrinkPlanExtrasInvoice first.
              //
              // Clamp metadata against the authoritative captured amount so a
              // corrupted extras/balance split can't apportion more than was
              // actually charged. extras takes priority; balance is the remainder.
              const rawExtrasCents = Number(intent.metadata?.extras_amount_cents || 0);
              const rawBalanceCents = Number(intent.metadata?.balance_amount_cents || 0);
              const extrasCents = Math.max(0, Math.min(rawExtrasCents, intent.amount));
              const balanceCents = Math.max(0, intent.amount - extrasCents);
              const drinkPlanId = Number(intent.metadata?.drink_plan_id);

              if ((rawExtrasCents + rawBalanceCents) !== intent.amount) {
                console.warn(
                  `Webhook: extras+balance metadata (${rawExtrasCents}+${rawBalanceCents}) != intent.amount (${intent.amount}) for intent ${intent.id}, proposal ${proposalId}`
                );
                if (process.env.SENTRY_DSN_SERVER) {
                  Sentry.captureMessage(
                    `Drink-plan extras/balance split mismatch (proposal ${proposalId}, intent ${intent.id}, rawExtras ${rawExtrasCents}, rawBalance ${rawBalanceCents}, intent.amount ${intent.amount})`,
                    'warning'
                  );
                }
              }

              // Link the submit-created "Drink Plan Extras" invoice (B1) instead
              // of creating a second one. findExtrasInvoice matches ANY non-void
              // (incl. paid/locked), so a redelivery or an out-of-order webhook
              // that already settled it is an idempotent no-op, never a duplicate.
              // The create-if-missing fallback stays inside this isFirstDelivery
              // guard for the out-of-order case (webhook before the submit commit).
              if (extrasCents > 0) {
                const extrasInv = await findExtrasInvoice(proposalId, dbClient);
                const alreadyPaid = extrasInv
                  && (extrasInv.status === 'paid'
                      || Number(extrasInv.amount_paid) >= Number(extrasInv.amount_due));
                if (extrasInv && !alreadyPaid) {
                  await linkPaymentToInvoice(extrasInv.id, paymentRowId, extrasCents, dbClient);
                } else if (!extrasInv && drinkPlanId) {
                  const created = await createDrinkPlanExtrasInvoice(
                    { proposalId, drinkPlanId, extrasAmountCents: extrasCents },
                    dbClient
                  );
                  await linkPaymentToInvoice(created.id, paymentRowId, extrasCents, dbClient);
                } else if (!extrasInv && !drinkPlanId) {
                  console.warn(
                    `Webhook: extras payment ${intent.id} for proposal ${proposalId} has no extras invoice and no drink_plan_id; extras portion ($${(extrasCents / 100).toFixed(2)}) not linked`
                  );
                  if (process.env.SENTRY_DSN_SERVER) {
                    Sentry.captureMessage(
                      `Unlinked drink-plan extras portion (proposal ${proposalId}, intent ${intent.id}, cents ${extrasCents})`,
                      'warning'
                    );
                  }
                } else if (extrasInv && alreadyPaid) {
                  // Second DISTINCT extras payment (double-submit / two tabs): the
                  // invoice is already paid+locked so we don't re-link, but
                  // amount_paid was incremented above — the client over-paid and
                  // this payment gets no invoice-level breadcrumb. Flag it.
                  console.warn(
                    `Webhook: extras invoice ${extrasInv.id} already paid; 2nd distinct extras payment ${intent.id} (proposal ${proposalId}) not linked — client likely over-paid.`
                  );
                  if (process.env.SENTRY_DSN_SERVER) {
                    Sentry.captureMessage(
                      `Second extras payment unlinked, invoice already paid (proposal ${proposalId}, intent ${intent.id}, cents ${extrasCents})`,
                      'warning'
                    );
                  }
                }
              }

              if (balanceCents > 0) {
                const balanceInv = await findOpenInvoiceForBalance(proposalId, dbClient);
                if (balanceInv) {
                  await linkPaymentToInvoice(balanceInv.id, paymentRowId, balanceCents, dbClient);
                } else {
                  console.warn(
                    `Webhook: drink_plan_with_balance payment ${intent.id} for proposal ${proposalId} had no open invoice to absorb balance portion ($${(balanceCents / 100).toFixed(2)})`
                  );
                  if (process.env.SENTRY_DSN_SERVER) {
                    Sentry.captureMessage(
                      `Unapplied drink-plan balance portion (proposal ${proposalId}, intent ${intent.id}, cents ${balanceCents})`,
                      'warning'
                    );
                  }
                }
              }
            } else {
              const openInvoice = await dbClient.query(
                "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
                [proposalId]
              );
              if (openInvoice.rows[0]) {
                await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRowId, intent.amount, dbClient);
              }
            }
          }

          // !conflict (F2): never mint a Balance invoice on an archived non-chosen option.
          if (paymentType === 'deposit' && !groupChoice.conflict) {
            await createBalanceInvoice(proposalId, dbClient);
          }
        } else {
          console.log(`Webhook: duplicate delivery for intent ${intent.id} — skipping (already processed)`);
        }

        await dbClient.query('COMMIT');
        if (isFirstDelivery) {
          console.log(`Payment (${paymentType}) received for proposal ${proposalId}: $${(intent.amount / 100).toFixed(2)}`);
        }
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, {
            tags: { webhook: 'stripe', route: '/webhook', event: 'payment_intent.succeeded' },
          });
        }
        console.error('Webhook DB error:', dbErr);
        // Re-throw so asyncHandler returns 5xx and Stripe retries delivery.
        // A 200 would tell Stripe the event was processed and silently strand
        // the proposal in an inconsistent state.
        throw dbErr;
      } finally {
        dbClient.release();
      }

      // Non-blocking post-commit work — only on first delivery. Retries must
      // not re-send receipts or re-create shifts.
      if (isFirstDelivery) {
        // ≤72h booking: admin + broad-net staff SMS blast. Fire-and-forget;
        // notifyLastMinuteBooking self-guards (try/catch + Sentry, never
        // throws). Gated by isLastMinuteHold (set in-tx above) AND
        // isFirstDelivery so a Stripe webhook retry never re-blasts.
        if (isLastMinuteHold) notifyLastMinuteBooking(proposalId);

        // Schedule the balance-reminder ladder + pre-event reminders for the
        // deposit-paid window. Both helpers are idempotent so a Stripe retry
        // re-entering this block will not double-schedule. Gated on deposit/
        // full payments; balance/extras payments skip (they fire post-conversion
        // when reminders already exist). The pre-event call moved out of the
        // separate block below into this single helper invocation.
        let depositRemindersScheduled = false;
        // !conflict: no reminder ladder (and, via this flag, no sign+pay marketing
        // enroll below) for a payment on a non-chosen option.
        if ((paymentType === 'deposit' || paymentType === 'full') && !groupChoice.conflict) {
          const { scheduleDepositPaidReminders } = require('../utils/depositPaidSchedulers');
          await scheduleDepositPaidReminders(proposalId, { source: 'payment_intent.succeeded' });
          depositRemindersScheduled = true;
        }

        // Create the shift (and, via createEventShifts, the drink plan) BEFORE
        // sending the orientation email — the orientation payload reads
        // drink_plans.token, which only exists once createEventShifts has run.
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

        // Best-effort post-commit reaps for archived losing options (marketing +
        // change-request cancels run on their own pool; a failure here never rolls
        // back the paid winner — matches today's ->archived semantics).
        for (const loserId of groupChoice.archivedLoserIds) {
          try {
            await cancelMarketingForProposal(loserId);
            await cancelPendingChangeRequestsForProposal(loserId);
          } catch (reapErr) {
            if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(reapErr, { tags: { webhook: 'stripe', reap: 'option_loser' } });
          }
        }

        // !conflict: no "payment received" receipt/notify for a non-chosen option
        // (the Sentry flag + manual refund is the admin path for that money).
        if (!groupChoice.conflict) sendPaymentNotifications(proposalId, intent.amount, paymentType);

        // depositRemindersScheduled covers both balance + pre-event scheduling
        // above. This block remains as the deposit-only marketing/drip anchor.
        if (depositRemindersScheduled) {

          // Plan 2d: schedule long-lead marketing touches (New Year, 6-mo-out)
          // and suppress the now-moot unsigned-proposal drip. Separate
          // try/catch from the Plan 2c block above so a marketing failure
          // cannot mask a pre-event-reminder failure. The helper self-gates on
          // eligibility and is idempotent under Stripe webhook retries.
          try {
            const { onProposalSignedAndPaid } = require('../utils/marketingHandlers');
            await onProposalSignedAndPaid(Number(proposalId));
          } catch (marketingErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(marketingErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'marketing-signpay' },
              });
            }
            console.error('Marketing enroll on sign+pay failed (non-blocking):', marketingErr);
          }
        }
      }
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      try {
        // Three independent writes — parallelize via Promise.all.
        await Promise.all([
          pool.query(
            "UPDATE stripe_sessions SET status = 'failed' WHERE stripe_payment_intent_id = $1",
            [intent.id]
          ),
          pool.query(
            `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
             VALUES ($1, $2, $3, $4, 'failed')`,
            [proposalId, intent.id, paymentType, intent.amount]
          ),
          pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_failed', 'system', $2)`,
            [proposalId, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType, failure_message: intent.last_payment_error?.message || null })]
          ),
        ]);
        console.warn(`Payment FAILED (${paymentType}) for proposal ${proposalId}: ${intent.last_payment_error?.message || 'unknown'}`);

        // Notify admins subscribed to payment_failure of a failed payment.
        const payInfo = await pool.query(`SELECT p.event_type, p.event_type_custom, c.name AS client_name FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [proposalId]);
        const failPi = payInfo.rows[0];
        const failReason = intent.last_payment_error?.message || 'Unknown error';
        const failAmount = `$${(intent.amount / 100).toFixed(2)}`;
        const failClient = failPi?.client_name || 'Unknown';
        await notifyAdminCategory({
          category: 'payment_failure',
          subject: `Payment failed: ${failClient} (${eventLabelFor(failPi)})`,
          emailHtml: `<p>A ${esc(paymentType)} payment of ${esc(failAmount)} failed for <strong>${esc(failClient)}</strong>.</p><p><strong>Reason:</strong> ${esc(failReason)}</p><p><a href="${ADMIN_URL}/proposals/${esc(proposalId)}">View Proposal</a></p>`,
          emailText: `A ${paymentType} payment of ${failAmount} failed for ${failClient}. Reason: ${failReason}. ${ADMIN_URL}/proposals/${proposalId}`,
        });

        // Client-facing payment-failure email (throttled 1/24h per proposal),
        // extracted to a sibling util so this over-cap file stays flat.
        await notifyClientPaymentFailed({ proposalId, paymentIntentId: intent.id });
      } catch (err) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { webhook: 'stripe', route: '/webhook' },
          });
        }
        console.error('payment_intent.payment_failed handler error:', err);
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
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
      const dbClient = await pool.connect();
      let isFirstDelivery = false;
      let groupChoice = { committed: false, conflict: false, archivedLoserIds: [] };
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
        for (const loserId of groupChoice.archivedLoserIds) {
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
          const { scheduleDepositPaidReminders } = require('../utils/depositPaidSchedulers');
          await scheduleDepositPaidReminders(Number(proposalId), { source: 'checkout.session.completed' });

          // Plan 2d: a Payment-Link deposit is a genuine client sign+pay, so
          // schedule the long-lead marketing touches and suppress the drip,
          // same as the payment_intent.succeeded path.
          try {
            const { onProposalSignedAndPaid } = require('../utils/marketingHandlers');
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
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
    // refunds.data is newest-first, so data[0] is the refund this event is about.
    // A mis-pick in a multi-refund race is harmless: unique stripe_refund_id makes
    // applyRefundReconciliation a no-op for an id already applied by the sync route.
    const refundObj = charge.refunds?.data?.[0];
    const proposalId = charge.metadata?.proposal_id
      || (paymentIntentId
            ? (await pool.query(
                'SELECT proposal_id FROM proposal_payments WHERE stripe_payment_intent_id = $1 LIMIT 1',
                [paymentIntentId]
              )).rows[0]?.proposal_id
            : null);

    if (proposalId && refundObj && paymentIntentId) {
      const dbClient = await pool.connect();
      let recon = null;
      try {
        await dbClient.query('BEGIN');
        const payRow = await dbClient.query(
          `SELECT id FROM proposal_payments
            WHERE stripe_payment_intent_id = $1 AND status = 'succeeded' LIMIT 1`,
          [paymentIntentId]
        );
        const { applyRefundReconciliation } = require('../utils/refundHelpers');
        recon = await applyRefundReconciliation(
          {
            proposalId: Number(proposalId),
            stripeRefundId: refundObj.id,
            paymentIntentId,
            paymentId: payRow.rows[0]?.id ?? null,
            amountCents: refundObj.amount,
            reason: 'Refunded via Stripe dashboard',
            issuedBy: null,
          },
          dbClient
        );
        await dbClient.query('COMMIT');
        console.log(`charge.refunded reconciled for proposal ${proposalId} (refund ${refundObj.id})`);
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, { tags: { webhook: 'stripe', event: 'charge.refunded' } });
        }
        console.error('Webhook charge.refunded error:', dbErr);
        throw dbErr; // 5xx → Stripe retries (same posture as payment_intent.succeeded)
      } finally {
        dbClient.release();
      }

      // Notify the client only when THIS request actually applied the refund.
      // Dashboard-issued refunds land here first (recon.applied true) and the
      // client gets the same notification email the in-app route would send.
      // When the webhook fires after an in-app refund, recon.applied is false
      // (the in-app route already applied) and we skip to avoid double-send.
      if (recon?.applied) {
        const { sendRefundClientNotification } = require('../utils/refundClientNotify');
        await sendRefundClientNotification({
          proposalId,
          amountCents: refundObj.amount,
          source: 'webhook',
        });
      }
    }
    // Tip-clawback path: no-ops when paymentIntentId is not a tip.
    await clawbackTipByPaymentIntent(paymentIntentId, Number(charge.amount_refunded || 0));
  }

  // Dispute/refund idempotency lives in the helpers, not in an event-level webhook_events
  // gate (audit A08, confirmed). clawbackTipByPaymentIntent moves only the delta beyond
  // tips.refunded_amount_cents (a same-cumulative Stripe redelivery is delta=0 = no-op), and
  // notifyDisputeWon below gates on tips.dispute_won_at (redelivery returns early). So an
  // at-least-once redelivery of charge.refunded / dispute.* cannot double-clawback or
  // double-notify; no extra guard is needed here.
  if (event.type === 'charge.dispute.funds_withdrawn') {
    const dispute = event.data.object;
    await clawbackTipByPaymentIntent(dispute.payment_intent, Number(dispute.amount || 0));
  }

  if (event.type === 'charge.dispute.funds_reinstated') {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
      const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
      if (rows[0]) {
        try {
          const { notifyDisputeWon } = require('../utils/payrollDisputeNotify');
          await notifyDisputeWon(rows[0].id, {
            reinstatedAmountCents: Number(dispute.amount || 0),
            disputeOpenedAt: dispute.created ? new Date(dispute.created * 1000) : null,
            disputeWonAt: new Date(),
          });
        } catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip_dispute_won' } }); }
      }
    }
    return res.json({ received: true });
  }

  // Stripe payout tracking (read-side mirror; spec 2026-07-01). No event-level
  // dedupe here by design — idempotency is the syncPayout upsert on stripe_payout_id
  // plus the atomic alerted_at claim, matching this file's per-branch ON CONFLICT
  // convention. Test-mode events are skipped so the mirror stays live-only.
  if (event.type === 'payout.paid' || event.type === 'payout.failed') {
    if (event.livemode === false) return res.json({ received: true, skipped: 'test_mode' });
    const payout = event.data.object;
    try {
      const payoutSync = require('../utils/stripePayoutSync');
      await payoutSync.syncPayout(payout);
      if (event.type === 'payout.failed') {
        await payoutSync.alertFailedPayout(payout.id);
      }
    } catch (err) {
      // Catch-and-ack (file convention, cf. funds_reinstated): the nightly sweep
      // heals a failed sync; a 500 here would retry-storm without adding safety.
      Sentry.captureException(err, { tags: { webhook: 'stripe_payout' } });
    }
    return res.json({ received: true });
  }

  res.json({ received: true });
}));

module.exports = router;
