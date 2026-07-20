// stripeWebhook concern: payment_intent.succeeded. Extracted verbatim from
// stripeWebhook.js — settles deposit/full/balance/invoice/drink-plan payments,
// commits option-group choice + client sweep, links invoices, and runs the
// post-commit side effects (shifts, reminders, marketing, notifications).
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { createEventShifts } = require('../../utils/eventCreation');
const { getBookingWindow } = require('../../utils/bookingWindow');
const { notifyLastMinuteBooking } = require('../../utils/lastMinuteAlert');
const { createInvoiceOnSend, createBalanceInvoice, linkPaymentToInvoice, createDrinkPlanExtrasInvoice, findExtrasInvoice, findOpenInvoiceForBalance } = require('../../utils/invoiceHelpers');
const { commitGroupChoice, sweepClientAlternatives } = require('../../utils/proposalGroupCommit');
const { OFF_LEDGER_INVOICE_LABELS } = require('../../utils/proposalMoneyShared');
const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
const { sendPaymentNotifications } = require('../../utils/stripePaymentNotifications');
const { notifyAdminCategory } = require('../../utils/adminNotifications');

// B3: email-first admin alert when a payment settles onto a cancelled (archived)
// proposal. Fire-and-forget from the post-commit tail; notifyAdminCategory self-
// guards, the extra catch keeps this from masking sibling post-commit work. Copy
// carries no em dashes (client/admin copy convention).
function notifyPaymentOnArchived(proposalId, amountCents, paymentType, archiveReason) {
  const dollars = `$${(amountCents / 100).toFixed(2)}`;
  const reasonSuffix = archiveReason ? ` (archive reason: ${archiveReason})` : '';
  const line = `A ${paymentType} payment of ${dollars} just settled on proposal #${proposalId}, which was already cancelled${reasonSuffix}. The money is in the ledger, but the cancellation refund already ran before it arrived. Open the proposal and refund this payment straight from the payment panel (the Refund button), which returns it without re-running the cancellation math. Do NOT expect the Cancel then Refund flow to catch it: the booking is already archived, so that path may report nothing is owed.`;
  return notifyAdminCategory({
    category: 'payment_failure',
    subject: `Payment received on a cancelled event (proposal #${proposalId})`,
    emailText: line,
    emailHtml: `<p>${line}</p>`,
  }).catch((err) => {
    console.error('payment_on_archived admin notify failed (non-blocking):', err && err.message);
  });
}

module.exports = async function handlePaymentIntentSucceeded(event) {
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
      // Ungrouped same-client alternatives archived by the sweep (in-tx below);
      // read post-commit for the same best-effort reaps.
      let sweptAlternativeIds = [];
      // B3: set in-tx when this payment settles onto an already-archived
      // (cancelled) proposal. The credit stays byte-identical (blocking it would
      // strand charged money outside the ledger and break /cancel/refund pickup);
      // this flag drives the post-commit Sentry + admin alert only.
      let archivedSettle = null;
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
          // LOCK ORDER: on an initial-booking payment (the only case where
          // commitGroupChoice can claim a group / archive losers and the sweep
          // can archive strays), take the client-row lock FIRST so every
          // archiver obeys clients -> proposal_groups -> proposals. Without
          // this hoist, a grouped settle locks loser rows before the sweep's
          // client lock and can deadlock AB-BA against the admin archive
          // endpoint (which holds the client lock and wants those rows).
          if (paymentType === 'full' || paymentType === 'deposit') {
            await dbClient.query(
              `SELECT c.id FROM clients c JOIN proposals p ON p.client_id = c.id
                WHERE p.id = $1 FOR UPDATE OF c`, [proposalId]);
          }

          // B3: detect a settle onto an already-archived (cancelled) proposal
          // ONCE, up front, and record the breadcrumb here. This proposal's
          // archived state is pre-existing and terminal for the credit branches
          // below (commitGroupChoice and the sweep only ever archive OTHER rows —
          // group losers / same-client strays — never this winner), so a single
          // early read is stable for the whole tx. archivedSettle then drives
          // (a) the post-commit admin alert AND (b) the suppression of every
          // CONVERSION side effect (balance invoice, last-minute hold + staff
          // blast, shift creation, reminder ladder, marketing enroll, client
          // receipt). The money still lands in proposal_payments (and in
          // amount_paid on the rails that do not exclude archived) so
          // /cancel/refund or a manual refund can return it — we suppress only
          // the "treat this as a live booking" behavior, never the credit.
          const archRes = await dbClient.query(
            'SELECT status, archive_reason FROM proposals WHERE id = $1',
            [proposalId]
          );
          if (archRes.rows[0] && archRes.rows[0].status === 'archived') {
            archivedSettle = { archiveReason: archRes.rows[0].archive_reason || null };
            await dbClient.query(
              `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_on_archived', 'system', $2)`,
              [proposalId, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType, archive_reason: archivedSettle.archiveReason })]
            );
          }

          // Option-group choice-commit — runs BEFORE the credit. First-writer-wins
          // marks this option chosen + archives the losers (voiding their unpaid
          // invoices) in THIS tx. On conflict (a 2nd option paying after another
          // already won) the amount_paid guards below skip the archived row's credit;
          // we flag it and skip conversion post-commit.
          // !archivedSettle (B3): a stale payment on an ALREADY-cancelled proposal
          // must never make it win/decide a group — a cancelled option cannot be
          // the chosen one, and letting it archive its live siblings is exactly the
          // "treat the settle as a live initial booking" harm this guard closes.
          if (!archivedSettle) {
            groupChoice = await commitGroupChoice(proposalId, dbClient);
            if (groupChoice.conflict && process.env.SENTRY_DSN_SERVER) {
              Sentry.captureMessage(
                `option_paid_after_decided: payment on a non-chosen option (proposal ${proposalId}, intent ${intent.id}) — refund manually`,
                'warning'
              );
            }
          }

          // Same-client sweep of UNGROUPED alternatives: on an initial-booking
          // payment (deposit/full only — never balance/extras/invoice, where a
          // new draft for the client's NEXT event is legitimate), archive the
          // client's other open, unpaid proposals like formal-group losers.
          // !archivedSettle (B3): a stale payment on a cancelled event is NOT the
          // client's first real booking, so it must never sweep (silently archive
          // + void) the client's legitimate rebooking quotes.
          if (!groupChoice.conflict && !archivedSettle && (paymentType === 'full' || paymentType === 'deposit')) {
            const sweep = await sweepClientAlternatives(proposalId, dbClient);
            sweptAlternativeIds = sweep.sweptIds;
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
            // M3 (phantom-Outstanding fix): credit the balance monotonically across
            // EVERY money-bearing lifecycle state, not just 'deposit_paid'. The old
            // `WHERE status = 'deposit_paid'` matched zero rows whenever an admin moved
            // the proposal forward (e.g. to 'confirmed') before the balance webhook
            // landed: the payment row still committed and the Balance invoice still
            // paid via the label-blind link below, but amount_paid never incremented,
            // leaving a phantom Outstanding balance. The WHERE now admits the paid/
            // confirmed/completed states so the credit always lands; 'archived' stays
            // excluded, since reviving it would break the documented archived ->
            // only-draft state machine. Status stays GUARDED by the CASE: only 'deposit_paid'
            // advances (to balance_paid once fully paid); confirmed/completed are
            // preserved, never rewound by a payment. Additive, never "= total_price"
            // (same rationale as the full branch). Idempotent via the proposal_payments
            // ON CONFLICT insert above.
            await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $2, autopay_status = NULL,
                  status = CASE
                    WHEN status IN ('confirmed', 'completed') THEN status
                    WHEN COALESCE(amount_paid, 0) + $2 >= total_price THEN 'balance_paid'
                    ELSE 'deposit_paid'
                  END
              WHERE id = $1 AND status IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed')
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
            // OFF-LEDGER EXCEPTION: an invoice whose label is in
            // OFF_LEDGER_INVOICE_LABELS has NO total_price entry, so rolling
            // its payment into amount_paid would forgive the contract by that
            // amount. The set is CURRENTLY EMPTY (Enhancement Lab money folds
            // into total_price since 2026-07-20, so its payments roll up like
            // any contract invoice); the branch stays wired for a future
            // genuinely-additive label.
            const paidInvoiceId = Number(intent.metadata?.invoice_id) || null;
            let offLedger = false;
            if (paidInvoiceId) {
              const labelRes = await dbClient.query('SELECT label FROM invoices WHERE id = $1', [paidInvoiceId]);
              offLedger = OFF_LEDGER_INVOICE_LABELS.includes(labelRes.rows[0]?.label);
            }
            if (!offLedger) {
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
          if ((paymentType === 'full' || paymentType === 'deposit') && !groupChoice.conflict && !archivedSettle) {
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

          // !conflict (F2): never mint a Balance invoice on an archived non-chosen
          // option. !archivedSettle (B3): never mint one on a cancelled event a
          // stale payment just landed on — the admin refunds it, no live booking.
          if (paymentType === 'deposit' && !groupChoice.conflict && !archivedSettle) {
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
        // B3 settle-on-archived alert (post-commit, connection released). The
        // credit + in-tx breadcrumb already committed above. Warn Sentry and
        // email-first notify the admin (SMS costs money; category 'payment_failure'
        // is the money-anomaly lane) to re-run Cancel then Refund. notifyAdminCategory
        // self-guards, but keep a defensive catch so this tail never masks other work.
        if (archivedSettle) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureMessage(
              `payment_landed_on_archived_proposal (proposal ${proposalId}, intent ${intent.id}, type ${paymentType}, $${(intent.amount / 100).toFixed(2)}) — re-run Cancel then Refund`,
              'warning'
            );
          }
          notifyPaymentOnArchived(proposalId, intent.amount, paymentType, archivedSettle.archiveReason);
        }

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
        // enroll below) for a payment on a non-chosen option. !archivedSettle (B3):
        // nor for a stale payment on a cancelled event.
        if ((paymentType === 'deposit' || paymentType === 'full') && !groupChoice.conflict && !archivedSettle) {
          const { scheduleDepositPaidReminders } = require('../../utils/depositPaidSchedulers');
          await scheduleDepositPaidReminders(proposalId, { source: 'payment_intent.succeeded' });
          depositRemindersScheduled = true;
        }

        // Create the shift (and, via createEventShifts, the drink plan) BEFORE
        // sending the orientation email — the orientation payload reads
        // drink_plans.token, which only exists once createEventShifts has run.
        // A conflicting late payment on a non-chosen option must NOT convert.
        // !archivedSettle (B3): a stale payment on a cancelled event must NOT mint
        // a phantom open shift (createEventShifts is status-blind; this is the gate).
        if (!groupChoice.conflict && !archivedSettle) {
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
        for (const loserId of [...groupChoice.archivedLoserIds, ...sweptAlternativeIds]) {
          try {
            await cancelMarketingForProposal(loserId);
            await cancelPendingChangeRequestsForProposal(loserId);
          } catch (reapErr) {
            if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(reapErr, { tags: { webhook: 'stripe', reap: 'option_loser' } });
          }
        }

        // !conflict: no "payment received" receipt/notify for a non-chosen option
        // (the Sentry flag + manual refund is the admin path for that money).
        // !archivedSettle (B3): no conversion receipt for a stale payment on a
        // cancelled event — the payment_on_archived admin alert is that money's path.
        if (!groupChoice.conflict && !archivedSettle) sendPaymentNotifications(proposalId, intent.amount, paymentType);

        // depositRemindersScheduled covers both balance + pre-event scheduling
        // above. This block remains as the deposit-only marketing/drip anchor.
        if (depositRemindersScheduled) {

          // Plan 2d: schedule long-lead marketing touches (New Year, 6-mo-out)
          // and suppress the now-moot unsigned-proposal drip. Separate
          // try/catch from the Plan 2c block above so a marketing failure
          // cannot mask a pre-event-reminder failure. The helper self-gates on
          // eligibility and is idempotent under Stripe webhook retries.
          try {
            const { onProposalSignedAndPaid } = require('../../utils/marketingHandlers');
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
};
