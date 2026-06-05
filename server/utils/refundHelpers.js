/**
 * Refund helpers — partial refunds (Approach A: refund corrects the total).
 *
 * planRefund() is PURE (no DB, no Stripe) → fully unit-tested.
 * applyRefundReconciliation() is DB-bound (added in Task 3).
 *
 * MONEY SEAM: proposals.total_price / amount_paid are DOLLARS (NUMERIC);
 * everything else is INTEGER CENTS. planRefund takes dollars in, returns
 * cents for all downstream Stripe/ledger use, and a dollars figure only
 * for the proposals columns.
 */

const { reconcileProposalPaymentStatus } = require('./proposalStatus');

function fmtUSD(cents) {
  return '$' + (cents / 100).toFixed(2);
}

/**
 * Decide which single charge to refund against and validate the amount.
 * No DB. No spanning multiple charges.
 *
 * @param {object} args
 * @param {{id:number, stripe_payment_intent_id:string, remainingCents:number}[]} args.paymentsWithRemaining
 *        Succeeded, intent-bearing proposal_payments rows with cents still
 *        refundable (caller computes remainingCents = amount − Σ succeeded refunds).
 * @param {number|string} args.requestedDollars  raw admin input
 * @param {number} args.amountPaidDollars         proposals.amount_paid
 * @param {number} args.totalPriceDollars         proposals.total_price
 * @returns {{ok:true, amountCents:number, targetPaymentId:number,
 *            targetIntentId:string, totalPriceAfterDollars:number}
 *          | {ok:false, code:string, message:string, maxRefundableCents?:number}}
 */
function planRefund({ paymentsWithRemaining, requestedDollars, amountPaidDollars, totalPriceDollars }) {
  const n = Number(requestedDollars);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Enter a refund amount greater than $0.00.' };
  }
  const amountCents = Math.round(n * 100);

  const candidates = (paymentsWithRemaining || []).filter(p => p.remainingCents > 0);
  if (candidates.length === 0) {
    return { ok: false, code: 'NO_REFUNDABLE_PAYMENT', message: 'No Stripe payment on this proposal is available to refund.' };
  }

  const target = candidates.reduce((a, b) => (b.remainingCents > a.remainingCents ? b : a));

  if (amountCents > target.remainingCents) {
    return {
      ok: false,
      code: 'EXCEEDS_SINGLE_CHARGE',
      maxRefundableCents: target.remainingCents,
      message: `Largest refundable payment is ${fmtUSD(target.remainingCents)}. Issue this as separate refunds of ${fmtUSD(target.remainingCents)} or less.`,
    };
  }

  const amountPaidCents = Math.round(Number(amountPaidDollars) * 100);
  if (amountCents > amountPaidCents) {
    return { ok: false, code: 'EXCEEDS_AMOUNT_PAID', message: 'Refund exceeds the amount currently paid on this proposal.' };
  }

  // No total_price pre-check here: planRefund is PURE and cannot see the
  // linked invoice label, so it cannot know how much of this refund is
  // contract money. The authoritative total correction (and its 0-floor) is
  // applied in applyRefundReconciliation via SQL GREATEST(total_price −
  // contractCents/100, 0), where contractCents is classified by invoice
  // label. Flooring on total_price here would WRONGLY reject a valid
  // extra-scope refund (contractCents=0 → total_price untouched). For a
  // contract refund the SQL floor + EXCEEDS_AMOUNT_PAID + the per-charge cap
  // already bound it. totalPriceAfterDollars below is a non-negative
  // worst-case (all-contract) PREVIEW the reconciliation overwrites.
  const totalAfterCents = Math.max(0, Math.round(Number(totalPriceDollars) * 100) - amountCents);

  return {
    ok: true,
    amountCents,
    targetPaymentId: target.id,
    targetIntentId: target.stripe_payment_intent_id,
    totalPriceAfterDollars: totalAfterCents / 100,
  };
}

/**
 * Apply (idempotently) the financial reconciliation for one Stripe refund.
 * MUST run inside a caller-supplied transaction (dbClient = pool.connect()).
 *
 * Correlation order, keyed by Stripe refund id (spec §Webhook Backstop):
 *   1. a `succeeded` row already has this stripe_refund_id → no-op.
 *   2. else a `pending` row for this intent w/ matching amount & no
 *      refund id → adopt it (self-heal: Stripe refunded, sync write failed).
 *   3. else create a fresh `succeeded` row (out-of-band dashboard refund).
 *
 * Then, exactly once: reverse linked invoice(s) (net-aggregated so repeated
 * partial refunds never over-reverse); amount_paid −= full refund;
 * total_price −= the CONTRACT portion only (refund cents not linked to a
 * non-contract-labeled invoice); finalize total_price_after; activity-log
 * line. Extra-scope (e.g. Additional Services) refunds drop amount_paid +
 * that invoice but leave total_price intact.
 *
 * @param {object} a
 * @param {number} a.proposalId
 * @param {string} a.stripeRefundId
 * @param {string} a.paymentIntentId
 * @param {number|null} a.paymentId          proposal_payments.id (may be null for dashboard refunds)
 * @param {number} a.amountCents
 * @param {string} a.reason
 * @param {number|null} a.issuedBy           users.id, or null (dashboard)
 * @param {object} dbClient                  transaction client
 * @returns {Promise<{applied:boolean}>}     applied=false → was already done
 */
async function applyRefundReconciliation(
  { proposalId, stripeRefundId, paymentIntentId, paymentId, amountCents, reason, issuedBy },
  dbClient
) {
  // Serialize ALL refund reconciliation for this proposal on the proposals
  // row BEFORE the already-applied check. Closes the TOCTOU where two
  // concurrent submits both pass an unlocked check and double-decrement:
  // any waiter blocks here until the winner COMMITs, then sees the winner's
  // succeeded row and cleanly no-ops.
  const propRes = await dbClient.query(
    'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId]
  );
  if (!propRes.rows[0]) throw new Error(`applyRefundReconciliation: proposal ${proposalId} not found`);

  // Already applied? Safe now — we hold the row lock.
  const done = await dbClient.query(
    `SELECT id FROM proposal_refunds WHERE stripe_refund_id = $1 AND status = 'succeeded' LIMIT 1`,
    [stripeRefundId]
  );
  if (done.rows[0]) return { applied: false };

  const totalBefore = Number(propRes.rows[0].total_price);
  const statusBefore = propRes.rows[0].status;
  let statusAfter = statusBefore;
  let autopayDisarmed = false;

  // 2/3. Adopt a pending row, else create a succeeded row. total_price_after
  // is finalized AFTER the invoice walk (it depends on the contract vs.
  // extra-scope split, which the invoice labels below determine). Insert a
  // provisional value (= totalBefore) to satisfy NOT NULL; overwrite later.
  let refundRowId;
  const pending = await dbClient.query(
    `SELECT id FROM proposal_refunds
      WHERE stripe_payment_intent_id = $1 AND amount = $2
        AND status = 'pending' AND stripe_refund_id IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [paymentIntentId, amountCents]
  );
  if (pending.rows[0]) {
    refundRowId = pending.rows[0].id;
    await dbClient.query(
      `UPDATE proposal_refunds
          SET status = 'succeeded', stripe_refund_id = $1, total_price_before = $2
        WHERE id = $3`,
      [stripeRefundId, totalBefore, refundRowId]
    );
  } else {
    const ins = await dbClient.query(
      `INSERT INTO proposal_refunds
         (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id,
          amount, reason, total_price_before, total_price_after, issued_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'succeeded')
       RETURNING id`,
      [proposalId, paymentId, paymentIntentId, stripeRefundId, amountCents,
       reason, totalBefore, issuedBy]
    );
    refundRowId = ins.rows[0].id;
  }

  // Reverse linked invoice(s) AND classify contract vs. extra-scope by the
  // invoice label — the same markers invoiceHelpers.js uses (lines 315/398/
  // 421/692). Aggregate NET still-applied per invoice (Σ of the original
  // positive link + any prior negative reversal rows) so splitting one
  // refund into several against the same charge (the no-spanning rule
  // forces this) can never over-reverse an invoice. Walk greedily, clamped
  // per invoice. Extra-scope portions (non-contract label) are tracked so
  // they do NOT shrink total_price.
  const CONTRACT_LABELS = ['Deposit', 'Balance', 'Full Payment'];
  let nonContractCents = 0;
  if (paymentId !== null && paymentId !== undefined) {
    const links = await dbClient.query(
      `SELECT ip.invoice_id,
              i.label AS invoice_label,
              SUM(ip.amount)::int AS net_applied
         FROM invoice_payments ip
         JOIN invoices i ON i.id = ip.invoice_id
        WHERE ip.payment_id = $1
        GROUP BY ip.invoice_id, i.label
       HAVING SUM(ip.amount) > 0
        ORDER BY ip.invoice_id ASC`,
      [paymentId]
    );
    let remaining = amountCents;
    for (const link of links.rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, link.net_applied);
      remaining -= take;
      if (!CONTRACT_LABELS.includes(link.invoice_label)) {
        nonContractCents += take; // extra scope — must not shrink total_price
      }
      // Negative linkage row keeps Σ invoice_payments.amount == amount_paid.
      await dbClient.query(
        'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,$3)',
        [link.invoice_id, paymentId, -take]
      );
      // Drop amount_due AND amount_paid by `take` so a fully-paid invoice
      // stays paid at the corrected figure (no phantom unpaid line).
      const upd = await dbClient.query(
        `UPDATE invoices
            SET amount_paid = GREATEST(amount_paid - $1, 0),
                amount_due  = GREATEST(amount_due  - $1, 0)
          WHERE id = $2
          RETURNING amount_due, amount_paid`,
        [take, link.invoice_id]
      );
      if (upd.rows[0]) {
        const inv = upd.rows[0];
        const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
        await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, link.invoice_id]);
      }
    }
  }

  // amount_paid ALWAYS drops by the full refund (every refunded dollar was
  // money the client paid). total_price drops ONLY by the contract portion
  // (Approach A) — extra-scope refunds leave the base contract total intact.
  // Exact NUMERIC division ($/100.0); GREATEST clamps ≥ 0.
  const contractCents = amountCents - nonContractCents;
  const totalAfter = totalBefore - contractCents / 100;
  const moneyRes = await dbClient.query(
    `UPDATE proposals
        SET total_price = GREATEST(total_price - ($1 / 100.0), 0),
            amount_paid = GREATEST(amount_paid - ($2 / 100.0), 0)
      WHERE id = $3
      RETURNING total_price, amount_paid`,
    [contractCents, amountCents, proposalId]
  );

  // Keep status ⟷ money consistent. A refund is the sole money-OUT path;
  // every money-IN path (record-payment crud.js:652-654, the stripe webhook
  // branches) re-derives proposals.status from the new money state. Skip it
  // here and status-driven surfaces — the payment panel's "Paid in full" chip,
  // the record-payment gate, the Paid tab — go stale, leaving a proposal
  // marked paid when it isn't (CLAUDE.md cross-cutting rule). Mirror that
  // rule, DEMOTE-only:
  //   amount_paid <= 0           → 'accepted'      (nothing held)
  //   amount_paid <  total_price → 'deposit_paid'  (partial — balance owed)
  //   amount_paid >= total_price → unchanged       (contract refund: still
  //                                 fully paid at the corrected total)
  // Only the pure payment statuses are demoted. 'confirmed'/'completed' are
  // lifecycle states ('completed' is state-machine-terminal) — a refund is an
  // accounting correction, not an un-confirmation; the panel's display guard
  // keeps THOSE from showing "Paid in full" beside a balance. Direct UPDATE
  // (like every payment-side write) deliberately bypasses the crud.js status
  // state machine — this IS the admin-backed ledger correction it exempts.
  //
  // CRITICAL: on balance_paid → deposit_paid ONLY, also clear autopay_enrolled.
  // balanceScheduler.js off-session charges (total_price − amount_paid) for any
  // deposit_paid + autopay_enrolled + balance_due_date<=today + card-on-file
  // row. Without this, the next hourly tick would silently re-charge the exact
  // amount just refunded. A normal deposit-stage partial refund does NOT change
  // status, so legitimate future autopay on a still-owed contract balance is
  // left armed — the disarm is scoped to the was-fully-paid transition only.
  const mr = moneyRes.rows[0];
  if (mr) {
    const rec = reconcileProposalPaymentStatus({
      status: statusBefore, amountPaid: mr.amount_paid, totalPrice: mr.total_price,
    });
    if (rec.changed) {
      autopayDisarmed = rec.autopayDisarmed;
      await dbClient.query(
        autopayDisarmed
          ? 'UPDATE proposals SET status = $1, autopay_enrolled = false WHERE id = $2'
          : 'UPDATE proposals SET status = $1 WHERE id = $2',
        [rec.status, proposalId]
      );
      statusAfter = rec.status;
    }
  }

  // Finalize total_price_after now that contract vs. extra-scope is known.
  await dbClient.query(
    'UPDATE proposal_refunds SET total_price_after = $1 WHERE id = $2',
    [totalAfter, refundRowId]
  );

  // Activity log — chronological story + the contract/extra split for audit.
  // Dedicated actor_id column (not just JSON) so it's queryable; 'admin' for
  // an operator-issued refund, 'system' for an out-of-band dashboard refund.
  await dbClient.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'refund_issued', $2, $3, $4)`,
    [
      proposalId,
      issuedBy ? 'admin' : 'system',
      issuedBy,
      JSON.stringify({
        amount: amountCents, reason, stripe_refund_id: stripeRefundId,
        contract_cents: contractCents, non_contract_cents: nonContractCents,
        total_price_before: totalBefore, total_price_after: totalAfter,
        status_before: statusBefore, status_after: statusAfter,
        autopay_disarmed: autopayDisarmed,
        issued_by: issuedBy, refund_row_id: refundRowId,
      }),
    ]
  );

  return { applied: true };
}

module.exports = { planRefund, fmtUSD, applyRefundReconciliation };
