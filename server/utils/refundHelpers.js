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

const { pool } = require('../db');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
const {
  CONTRACT_LABELS,
  OFF_LEDGER_INVOICE_LABELS,
  TOTAL_TRACKING_INVOICE_LABELS,
} = require('./proposalMoneyShared');

function fmtUSD(cents) {
  return '$' + (cents / 100).toFixed(2);
}

/** Rails the admin refund panel considers refundable. */
const PANEL_REFUND_RAILS = Object.freeze(['deposit', 'balance', 'full', 'invoice']);
/**
 * Rails the cancel-line flow considers refundable: the panel set PLUS the
 * drink-plan rails, because cancelling a drink-plan item must be able to refund
 * the charge that paid for it. Both rails roll into proposals.amount_paid
 * (paymentIntentSucceeded), so excluding them made the overpayment fall entirely
 * into manual_return_cents (cross-LLM push review, 2026-07-26).
 */
const CANCEL_LINE_REFUND_RAILS = Object.freeze([
  ...PANEL_REFUND_RAILS, 'drink_plan_extras', 'drink_plan_with_balance',
]);

/**
 * Load a proposal's refundable charges with cents still refundable per charge.
 * EXACT extraction of the inline SQL that lived in routes/stripe.js POST
 * /refund/:id (2026-07-24, cancel-line) so the admin panel and the cancel-line
 * flow share one source of money truth. Semantics unchanged: succeeded,
 * intent-bearing payments on the CALLER'S rails (default PANEL_REFUND_RAILS, so
 * the panel is byte-identical; the cancel-line flow passes the wider
 * CANCEL_LINE_REFUND_RAILS), remaining = amount minus succeeded AND pending
 * refunds (a pending row may already be in flight at Stripe, so it
 * conservatively blocks headroom).
 *
 * OFF-LEDGER EXCLUSION (2026-08-03, service extension): a payment linked to an
 * OFF_LEDGER-labeled invoice ('Service Extension') is never a candidate here,
 * regardless of rails. Those dollars are not in proposals.amount_paid (the
 * webhook's off-ledger skip), so letting a contract refund draw against them
 * would let the admin refund money the contract never recorded, and
 * mis-attribute the reversal to contract scope. proposal_payments carries no
 * invoice linkage, so the exclusion is a NOT EXISTS anti-join over
 * invoice_payments JOIN invoices (same join applyRefundReconciliation walks
 * below). Whole-payment exclusion is EXACT, not approximate: extension
 * invoices are minted alone and paid alone, so a payment can never fund a
 * contract invoice AND an extension invoice. Extension refunds go through the
 * Stripe dashboard directly, where applyRefundReconciliation's offLedgerCents
 * path already handles them (see docs/ops-runbook.md).
 *
 * @param {number} proposalId
 * @param {object} [dbClient]  held tx client, or the shared pool
 * @param {object} [opts]
 * UNCREDITED HEADROOM (2026-09-15, spec section 4b): a payment can exceed the
 * invoice it paid. linkPaymentToInvoice caps the invoice credit at that
 * invoice's remaining due and returns the rest as overflow, while the webhook
 * rolls the WHOLE intent into proposals.amount_paid. So part of an overpaying
 * payment sits in amount_paid with no invoice behind it, and refunding that
 * part must not reverse an invoice credit that is still owed. uncreditedCents
 * is that part, net of what earlier refunds already took:
 *   amount - Σ invoice_payments (reversals are negative) - Σ succeeded+pending refunds
 * A refund either absorbs headroom or reverses a link, so subtracting the
 * refunds collapses "headroom already consumed" into the same expression.
 *
 * @param {string[]} [opts.rails]  payment_type rails treated as refundable
 * @returns {Promise<{id:number, stripe_payment_intent_id:string, remainingCents:number, uncreditedCents:number}[]>}
 */
async function loadPaymentsWithRemaining(proposalId, dbClient = pool, { rails = PANEL_REFUND_RAILS } = {}) {
  const res = await dbClient.query(
    `SELECT pp.id,
            pp.stripe_payment_intent_id,
            pp.amount
              - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                           WHERE pr.payment_id = pp.id AND pr.status IN ('succeeded', 'pending')), 0)
              AS "remainingCents",
            GREATEST(
              pp.amount
                - COALESCE((SELECT SUM(ip2.amount) FROM invoice_payments ip2
                             WHERE ip2.payment_id = pp.id), 0)
                - COALESCE((SELECT SUM(pr2.amount) FROM proposal_refunds pr2
                             WHERE pr2.payment_id = pp.id AND pr2.status IN ('succeeded', 'pending')), 0),
              0)
              AS "uncreditedCents"
       FROM proposal_payments pp
      WHERE pp.proposal_id = $1
        AND pp.status = 'succeeded'
        AND pp.stripe_payment_intent_id IS NOT NULL
        AND pp.payment_type = ANY($2::text[])
        AND NOT EXISTS (
              SELECT 1
                FROM invoice_payments ip
                JOIN invoices i ON i.id = ip.invoice_id
               WHERE ip.payment_id = pp.id
                 AND i.label = ANY($3::text[]))
      ORDER BY pp.id ASC`,
    [proposalId, rails, OFF_LEDGER_INVOICE_LABELS]
  );
  return res.rows.map((r) => ({
    id: r.id,
    stripe_payment_intent_id: r.stripe_payment_intent_id,
    remainingCents: Number(r.remainingCents),
    uncreditedCents: Number(r.uncreditedCents),
  }));
}

/**
 * Split an overpayment across refundable charges, largest remaining first.
 * PURE. A single refund never spans a Stripe charge (the EXCEEDS_SINGLE_CHARGE
 * rule), so an overpayment bigger than any one charge becomes sequential
 * per-charge splits. Cents left after all charge headroom are external/CC
 * money (Zelle, CC transfer) with no Stripe charge behind them: returned by
 * hand, reported as manualReturnCents, never fired through Stripe.
 *
 * @param {object} args
 * @param {{id:number, stripe_payment_intent_id:string, remainingCents:number}[]} args.paymentsWithRemaining
 * @param {number} args.overpaymentCents
 * @returns {{splits:{paymentId:number, paymentIntentId:string, amountCents:number}[],
 *            stripeRefundableCents:number, manualReturnCents:number}}
 */
function planOverpaymentSplits({ paymentsWithRemaining, overpaymentCents }) {
  const splits = [];
  let needed = Math.max(0, Math.trunc(Number(overpaymentCents) || 0));
  const candidates = (paymentsWithRemaining || [])
    .filter((p) => p.remainingCents > 0 && p.stripe_payment_intent_id)
    .sort((a, b) => b.remainingCents - a.remainingCents);
  for (const p of candidates) {
    if (needed <= 0) break;
    const take = Math.min(needed, p.remainingCents);
    splits.push({ paymentId: p.id, paymentIntentId: p.stripe_payment_intent_id, amountCents: take });
    needed -= take;
  }
  const stripeRefundableCents = splits.reduce((s, x) => s + x.amountCents, 0);
  return { splits, stripeRefundableCents, manualReturnCents: needed };
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
 * @param {string} [args.scope]                   'contract' (default) or 'overpayment'.
 *        An overpayment refund leaves total_price alone (so the preview must too),
 *        prefers the charge carrying the most UNCREDITED headroom among charges that
 *        can cover the amount, and is refused outright when even that charge cannot
 *        cover it from uncredited money.
 * @param {number} [args.contractInvoiceSlackCents] how much the contract invoices
 *        over-demand relative to total_price; returnable as an overpayment on top of
 *        a charge's uncredited headroom, because reversing that credit brings a stale
 *        invoice back to the contract rather than below it.
 * @param {boolean} [args.preferUncredited]       defaults to scope === 'overpayment'.
 *        Derived, not independent: the refusal below judges the chosen target, so a
 *        caller that asked for overpayment scope WITHOUT the preference would be
 *        refused against a charge the planner never preferred.
 * @returns {{ok:true, amountCents:number, targetPaymentId:number,
 *            targetIntentId:string, totalPriceAfterDollars:number}
 *          | {ok:false, code:string, message:string, maxRefundableCents?:number}}
 */
function planRefund({
  paymentsWithRemaining, requestedDollars, amountPaidDollars, totalPriceDollars,
  scope = 'contract', preferUncredited = scope === 'overpayment',
  contractInvoiceSlackCents: slackCents = 0,
}) {
  const n = Number(requestedDollars);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Enter a refund amount greater than $0.00.' };
  }
  const amountCents = Math.round(n * 100);

  const candidates = (paymentsWithRemaining || []).filter(p => p.remainingCents > 0);
  if (candidates.length === 0) {
    return { ok: false, code: 'NO_REFUNDABLE_PAYMENT', message: 'No Stripe payment on this proposal is available to refund.' };
  }

  // Largest remaining first, id ascending on a tie so the pick is deterministic
  // (it used to depend on row order). preferUncredited then REPLACES the target
  // only with a charge that can cover the whole amount, so the rejection below
  // still reports the true maximum when nothing can.
  const byRemaining = [...candidates].sort(
    (a, b) => b.remainingCents - a.remainingCents || a.id - b.id
  );
  let target = byRemaining[0];
  if (preferUncredited) {
    const covering = candidates
      .filter((p) => p.remainingCents >= amountCents)
      .sort((a, b) => (Number(b.uncreditedCents) || 0) - (Number(a.uncreditedCents) || 0)
        || b.remainingCents - a.remainingCents
        || a.id - b.id);
    if (covering.length > 0) target = covering[0];
  }

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
  // An overpayment refund must come off money no invoice was ever credited.
  // If the chosen charge cannot cover it from its uncredited headroom, the
  // remainder would walk the invoice links and reverse CREDITED money while
  // total_price stands, leaving a settled invoice demanding less than the
  // contract. That is exactly the defect section 4b closes, and the absorption
  // rule alone only closes it when the headroom is big enough. It is also how a
  // genuinely unrefundable overpayment surfaces: money taken outside Stripe
  // (external_paid rolls into amount_paid with no charge behind it) leaves every
  // charge fully credited, so there is nothing here to return through Stripe.
  // Cancel-line does NOT come through here: it plans its own splits and its fold
  // has already corrected the invoice demand, which is what makes reversing
  // credited money right on that path and wrong on this one.
  if (scope === 'overpayment') {
    const slack = Math.max(0, Number(slackCents) || 0);
    const allowance = (Number(target.uncreditedCents) || 0) + slack;
    if (amountCents > allowance) {
      const maxAllowance = candidates.reduce(
        (m, p) => Math.max(m, Math.min(p.remainingCents, (Number(p.uncreditedCents) || 0) + slack)), 0
      );
      return {
        ok: false,
        code: 'OVERPAYMENT_NOT_ON_A_CHARGE',
        maxOverpaymentRefundableCents: maxAllowance,
        message: maxAllowance > 0
          ? `Only ${fmtUSD(maxAllowance)} of this overpayment can be returned through Stripe. Refund up to ${fmtUSD(maxAllowance)} as an overpayment; the rest was paid outside Stripe, so return that part by hand.`
          : 'None of this overpayment can be returned through Stripe: it was paid outside Stripe, and the invoices already match the contract. Return it by hand.',
      };
    }
  }

  // Overpayment scope never lowers total_price, so its preview must not either:
  // this snapshot is what the pending row carries if the refund never reconciles.
  const totalAfterCents = scope === 'overpayment'
    ? Math.round(Number(totalPriceDollars) * 100)
    : Math.max(0, Math.round(Number(totalPriceDollars) * 100) - amountCents);

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
 * @param {boolean} [a.allowPendingHeuristic=true]  when no pendingRowId is given,
 *        may a pending row be adopted by (intent, amount)? The refund.created
 *        handler passes false: a dashboard refund has no pending row of its own,
 *        and a stranded one of the same amount would silently re-scope it.
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
  {
    proposalId, stripeRefundId, paymentIntentId, paymentId, amountCents, reason,
    issuedBy, totalScope = null, pendingRowId = null, allowPendingHeuristic = true,
  },
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
  // Prefer the caller's OWN pending row by id. The (intent, amount) lookup
  // below was a fine identity heuristic when the row only recorded history,
  // but total_scope made the adopted row decide the total_price rule: a
  // stranded pending row of the same amount on the same charge would silently
  // rewrite the money semantics of a later, unrelated refund in either
  // direction (push review, 2026-07-26). refundExecute knows exactly which row
  // it wrote, the sweeper resolves it from Stripe, and the refund.created
  // webhook validates the id Stripe echoed back before using it. So no caller
  // reaches the heuristic below any more; it is kept only so a future adoption
  // path that genuinely has no row id still has a defined behavior, and it must
  // be opted into with allowPendingHeuristic.
  let pending = { rows: [] };
  if (pendingRowId) {
    // Scoped to THIS proposal (lane security review, 2026-09-15). The row id can
    // arrive from Stripe metadata, and the heuristic it replaced constrained
    // intent AND amount, so an unconstrained lookup would have LESS validation
    // than the path it replaced: another proposal's pending row could decide
    // this refund's money rule and be marked succeeded against this refund's id,
    // stranding its own refund forever. A row that does not match leaves
    // pending.rows empty and the caller's explicit scope stands.
    pending = await dbClient.query(
      `SELECT id, total_scope FROM proposal_refunds
        WHERE id = $1 AND proposal_id = $2 AND status = 'pending' AND stripe_refund_id IS NULL`,
      [pendingRowId, proposalId]
    );
  } else if (allowPendingHeuristic) {
    pending = await dbClient.query(
      `SELECT id, total_scope FROM proposal_refunds
        WHERE stripe_payment_intent_id = $1 AND amount = $2
          AND status = 'pending' AND stripe_refund_id IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [paymentIntentId, amountCents]
    );
  }
  // total_price rule for THIS refund. The row is the source of truth (the
  // refund.created webhook and the stale-pending sweeper adopt pending rows
  // with no memory of the issuing caller); the param covers a direct call from
  // refundExecute before adoption; 'contract' is the historical default.
  const scope = (pending.rows[0] && pending.rows[0].total_scope)
    || totalScope
    || 'contract';
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
          amount, reason, total_price_before, total_price_after, issued_by, status, total_scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'succeeded',$9)
       RETURNING id`,
      [proposalId, paymentId, paymentIntentId, stripeRefundId, amountCents,
       reason, totalBefore, issuedBy, scope]
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
  // they do NOT shrink total_price. CONTRACT_LABELS is the shared constant
  // (./proposalMoneyShared), same classification payrollAccrual uses.
  let nonContractCents = 0;
  let offLedgerCents = 0;
  let absorbedCents = 0;
  if (paymentId !== null && paymentId !== undefined) {
    // UNCREDITED HEADROOM FIRST (spec 2026-09-15 section 4b). A payment can
    // exceed the invoice it paid: linkPaymentToInvoice caps the credit at that
    // invoice's remaining due, while the webhook rolls the WHOLE intent into
    // proposals.amount_paid. Those uncredited cents are on no invoice, so an
    // overpayment refund of them must reverse no invoice. Reversing anyway left
    // a LOCKED invoice demanding money on an unchanged contract, or flipped an
    // unlocked one to partially_paid with a phantom balance on a live pay link.
    // The old rule was correct only for cancel-line, where refreshUnlockedInvoices
    // had already corrected the demand in the same transaction. This block is NOT
    // a no-op there: 22 of 103 succeeded prod payments carry uncredited headroom
    // (typically a `full` payment linked only to a $100 Deposit invoice), so a
    // cancel-line refund on one now absorbs headroom instead of reversing that
    // Deposit credit. That is the better outcome — the deposit really was paid
    // and its invoice should keep saying so — and the cancel-line suites pin it.
    //
    // headroom = amount - Σ links (reversals are negative) - Σ OTHER succeeded
    // refunds on this charge. A refund either absorbs headroom or reverses a
    // link, so that last term is exactly "headroom already consumed" and a
    // second overpayment refund correctly finds none. This row is already
    // 'succeeded' by now, hence the id exclusion.
    //
    // Skipped for a payment linked to an off-ledger invoice: those dollars never
    // entered amount_paid, so absorbing them would drop money that is not there.
    // Extension invoices are minted alone and paid alone (headroom is
    // structurally 0), so this guard states the rule rather than relying on it.
    if (scope === 'overpayment') {
      if (!(await paymentIsOffLedger(paymentId, dbClient))) {
        const headroom = await uncreditedHeadroomCents(paymentId, dbClient, {
          excludeRefundRowId: refundRowId,
        });
        absorbedCents = Math.min(amountCents, headroom);
      }
    }
    const links = await dbClient.query(
      `SELECT ip.invoice_id,
              i.label AS invoice_label,
              i.locked AS invoice_locked,
              SUM(ip.amount)::int AS net_applied
         FROM invoice_payments ip
         JOIN invoices i ON i.id = ip.invoice_id
        WHERE ip.payment_id = $1
        GROUP BY ip.invoice_id, i.label, i.locked
       HAVING SUM(ip.amount) > 0
        ORDER BY ip.invoice_id ASC`,
      [paymentId]
    );
    let remaining = amountCents - absorbedCents;
    for (const link of links.rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, link.net_applied);
      remaining -= take;
      if (!CONTRACT_LABELS.includes(link.invoice_label)) {
        nonContractCents += take; // extra scope — must not shrink total_price
      }
      if (OFF_LEDGER_INVOICE_LABELS.includes(link.invoice_label)) {
        // These dollars never entered proposals.amount_paid (the webhook's
        // off-ledger skip), so their refund must not leave it either.
        offLedgerCents += take;
      }
      // Negative linkage row keeps Σ invoice_payments.amount == amount_paid.
      // refund_id stamps WHICH refund this reversal belongs to, so the public
      // invoice display can attribute a refund to the exact invoice(s) it
      // walked onto (a partial refund on a combined payment shows only where
      // it actually landed, not on every invoice the payment funded).
      await dbClient.query(
        'INSERT INTO invoice_payments (invoice_id, payment_id, amount, refund_id) VALUES ($1,$2,$3,$4)',
        [link.invoice_id, paymentId, -take, refundRowId]
      );
      // Contract scope: drop amount_due AND amount_paid by `take` so a
      // fully-paid invoice stays paid at the corrected figure (no phantom
      // unpaid line). Overpayment scope drops amount_paid ONLY when something
      // else already corrected this invoice's demand — which is true of
      // exactly one population: UNLOCKED invoices with a TOTAL-TRACKING label,
      // the ones refreshUnlockedInvoices rebuilds from the new total inside
      // the cancel transaction. Dropping their due again would mint phantom
      // credit. Every other invoice (locked, or unlocked with a label the
      // refresh skips or computes independently, e.g. Deposit / Additional
      // Services / Enhancement Lab / manual) has nobody correcting it, so
      // paid-only would leave due > paid and flip a settled invoice to a
      // client-visible partially_paid phantom balance on a live pay link.
      // Keyed on the FACT (is the demand refresh-managed?) via the shared
      // constant, not on the `locked` proxy that first encoded it — so adding
      // a label to the refresh can never silently desync this rule
      // (push review, 2026-07-26).
      const demandIsRefreshManaged = link.invoice_locked !== true
        && TOTAL_TRACKING_INVOICE_LABELS.includes(link.invoice_label);
      const dropDue = scope !== 'overpayment' || !demandIsRefreshManaged;
      const upd = dropDue
        ? await dbClient.query(
            `UPDATE invoices
                SET amount_paid = GREATEST(amount_paid - $1, 0),
                    amount_due  = GREATEST(amount_due  - $1, 0)
              WHERE id = $2
              RETURNING amount_due, amount_paid`,
            [take, link.invoice_id]
          )
        : await dbClient.query(
            `UPDATE invoices
                SET amount_paid = GREATEST(amount_paid - $1, 0)
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

  // amount_paid drops by the refund MINUS the off-ledger portion: every
  // refunded dollar was money the client paid, but off-ledger invoice dollars
  // were never rolled INTO amount_paid, so reversing them here would make the
  // contract look less paid than it is. OFF_LEDGER_INVOICE_LABELS holds
  // 'Service Extension' (since 2026-07-26; Enhancement Lab left the set
  // 2026-07-20 when lab money started folding into total_price/amount_paid,
  // so its refunds reverse symmetrically like Additional Services). This is
  // the LIVE path for extension refunds: loadPaymentsWithRemaining excludes
  // extension payments from the admin panel and cancel-line candidates, so an
  // extension refund arrives here only via the Stripe dashboard (charge
  // .refunded webhook / stale-pending sweeper), where offLedgerCents keeps
  // amount_paid untouched and total_price never moves (non-contract label).
  // total_price drops ONLY by the contract portion (Approach A) — extra-scope
  // refunds leave the base contract total intact. Exact NUMERIC division
  // ($/100.0); GREATEST clamps ≥ 0.
  // Overpayment scope (cancel-line, 2026-07-24): the fold already lowered
  // total_price to the corrected figure BEFORE this refund fired; treating the
  // contract-linked portion as a total_price drop here would lower it twice
  // (a $200 removal ending $400 lower). Scope-zero the contract portion so the
  // total stands; amount_paid still drops by the full refunded amount.
  // NOTE (2026-07-26): a derivation was attempted here that treated
  // `amount_paid - total_price` as "money paid in excess of the contract" and
  // spared that portion from lowering total_price. It was REVERTED before
  // shipping: that difference is not overpayment in this schema. Drink Plan
  // Extras (syrup-only pay-now) and manual-label invoices legitimately roll
  // into amount_paid and never into total_price, so the difference counted
  // them as excess and then subtracted them twice, silently swallowing genuine
  // contract refunds. Prod's only positive difference (proposal 599, $60) is
  // exactly a paid Drink Plan Extras invoice, not an overpayment. The real
  // defect it was chasing (refunding a TRUE overpayment lowers total and paid
  // together, so the proposal stays overpaid forever) is logged in
  // docs/fix-list-remaining-2026-07-02.md with the netting formula that would
  // fix it properly. Do not re-attempt without netting out outstanding
  // non-contract invoice money.
  const contractCents = scope === 'overpayment' ? 0 : amountCents - nonContractCents;
  const paidDropCents = amountCents - offLedgerCents;
  // Floor at 0 to match the SQL GREATEST clamp below (and planRefund's pending
  // preview). Without this the audit figure written to total_price_after could
  // go negative while the real total_price column is clamped at 0, so refund
  // history would show a negative total the ledger never actually held.
  const totalAfter = Math.max(0, totalBefore - contractCents / 100);
  // total_price_override rides along by the SAME contract portion. The
  // override is the service contract (pricingEngine substitutes it for the
  // calculated service total and layers client gratuity on top), so a refund
  // that lowers total_price by contractCents lowers the override by
  // contractCents too, or the two drift: the next proposal-editor save
  // carries the stale override forward, the engine substitutes it, and the
  // post-save pass mints an Additional Services invoice for exactly the
  // refunded amount (prod 599, refund #14; 527, refund #11 — 2026-08-25).
  // Same $1 on both columns; NULL stays NULL (native proposal). Extra-scope
  // and overpayment-scope refunds carry contractCents = 0 and move neither.
  //
  // Gratuity dollars refunded here are contract scope too: neither the panel
  // nor cancel passes a gratuity scope into reconciliation (gratuity_cents on
  // the refund row feeds only the payroll clawback). Since client gratuity is
  // re-derived from gratuity_rate at every price, lowering the override by the
  // full amount is the only representation a later save leaves alone. Two
  // costs, both on the fix list (2026-08-25): a later cancel-line gratuity
  // removal re-prices to override + 0 and reads that same money as an
  // overpayment again (the preview shows it before any second refund); and
  // GREATEST clamps each column at 0 independently, so a refund larger than
  // the service contract leaves total_price - override below the derived
  // gratuity and the next re-price bills the gap. Before this change that gap
  // was the whole refund.
  const moneyRes = await dbClient.query(
    `UPDATE proposals
        SET total_price = GREATEST(total_price - ($1 / 100.0), 0),
            amount_paid = GREATEST(amount_paid - ($2 / 100.0), 0),
            total_price_override = CASE
              WHEN total_price_override IS NULL THEN NULL
              ELSE GREATEST(total_price_override - ($1 / 100.0), 0)
            END
      WHERE id = $3
      RETURNING total_price, amount_paid, total_price_override`,
    [contractCents, paidDropCents, proposalId]
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
        total_scope: scope, uncredited_absorbed_cents: absorbedCents,
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

/**
 * Money paid on this proposal that is NOT inside proposals.total_price: a paid
 * Drink Plan Extras invoice whose lines were never folded, a manual label.
 * Thin pass-through to the ONE derivation (invoiceExtras), so the panel, the
 * editor and cancel-line can never drift apart on what "off contract" means.
 * Lazy require: invoiceExtras pulls in the invoice lifecycle, and this module
 * is required from inside it at other depths.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]  REQUIRED from any in-transaction caller (one
 *                             pooled connection per request; a pool fallback
 *                             inside a held transaction is the deadlock).
 * @returns {Promise<number>} cents
 */
function offContractPaidCents(proposalId, dbClient = pool) {
  const { sumOffContractPaidCents } = require('./invoiceExtras');
  return sumOffContractPaidCents(proposalId, dbClient);
}

/**
 * The netted overpayment: money held beyond the contract, with off-contract
 * invoice money taken out first. THE definition for every surface that says
 * "overpaid" and the cap on an overpayment-scope refund.
 *
 * The raw `amount_paid - total_price` difference is NOT overpayment in this
 * schema, which is why the 2026-07-26 attempt was reverted: a paid Drink Plan
 * Extras invoice rolls into amount_paid and never into total_price, so the raw
 * difference counts it as excess and a refund then subtracts it twice. Same
 * formula cancel-line already uses (lineItemCancel.js overpaymentCents), same
 * response key name as its preview.
 *
 * Note amount_paid includes external_paid, so a positive figure here can be
 * money with no Stripe charge behind it. Callers that offer a refund must check
 * refundable headroom separately (loadPaymentsWithRemaining).
 *
 * PURE, and the single definition of the arithmetic. Callers that already hold
 * the proposal row (the admin payload, cancel-line's fold against a new total)
 * use this directly rather than re-reading; `overpaymentCents` below is the
 * async wrapper that fetches for callers that do not.
 *
 * @param {number|string} amountPaidDollars  proposals.amount_paid (NUMERIC dollars)
 * @param {number|string} totalPriceDollars  proposals.total_price (NUMERIC dollars)
 * @param {number} offContractCents          the netting term, in cents
 * @returns {number} cents, floored at 0
 */
function nettedOverpaymentCents(amountPaidDollars, totalPriceDollars, offContractCents) {
  const paidCents = Math.round(Number(amountPaidDollars || 0) * 100);
  const totalCents = Math.round(Number(totalPriceDollars || 0) * 100);
  return Math.max(0, paidCents - totalCents - (Number(offContractCents) || 0));
}

/**
 * The overpayment still AVAILABLE to return, and the parts it is made of.
 * Succeeded refunds need no netting (they already lowered amount_paid); pending
 * overpayment refunds have not landed yet, so they must be held back or two
 * concurrent submits spend the same excess twice.
 *
 * Shared by the route's advisory check and refundExecute's authoritative one
 * (which calls it under the proposals row lock), so the two can never name
 * different figures to the admin.
 */
async function availableOverpaymentCents(proposalId, dbClient = pool) {
  const excessCents = await overpaymentCents(proposalId, dbClient);
  const res = await dbClient.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS cents FROM proposal_refunds
      WHERE proposal_id = $1 AND status = 'pending' AND total_scope = 'overpayment'`,
    [proposalId]
  );
  const pendingCents = Number(res.rows[0].cents);
  return { excessCents, pendingCents, availableCents: Math.max(0, excessCents - pendingCents) };
}

/**
 * Why an overpayment refund was refused, in the admin's terms. The three cases
 * are genuinely different acts, and naming the wrong one is dangerous: telling
 * an admin "not overpaid, uncheck the box" when the real cause is a refund in
 * flight steers them onto the CONTRACT path, which carries no cap and would
 * shrink the contract by the amount already being returned (lane security
 * review, 2026-09-15).
 */
function overpaymentRefusalMessage({ excessCents, pendingCents, availableCents }) {
  // Order matters: a refund in flight is checked FIRST. When it has consumed the
  // whole excess, excessCents can be 0 while the real cause is the outstanding
  // refund, and "not overpaid, uncheck the box" would steer the admin onto the
  // uncapped contract path while money is already on its way back.
  if (pendingCents > 0) {
    return `A ${fmtUSD(pendingCents)} refund on this proposal has not settled yet, which leaves ${fmtUSD(availableCents)} of the ${fmtUSD(excessCents)} overpayment available. Wait for it to settle before returning more. Do not uncheck the box: that would correct the contract instead of returning the overpayment.`;
  }
  if (excessCents <= 0) {
    return 'This proposal is not overpaid, so there is nothing to return as an overpayment. Uncheck the box to correct the contract instead.';
  }
  return `This proposal is overpaid by ${fmtUSD(availableCents)}. Refund up to ${fmtUSD(availableCents)} as an overpayment, or uncheck the box to correct the contract instead.`;
}

/**
 * Cents of this payment that no invoice was ever credited: the part that sits in
 * proposals.amount_paid with nothing behind it on the invoice side, because
 * linkPaymentToInvoice caps a credit at that invoice's remaining due while the
 * webhook rolls the WHOLE intent into amount_paid.
 *
 * THE definition, shared by the reconciler (which excludes the row it is
 * applying, already marked succeeded), the panel's locked pre-flight and the
 * dashboard scope decision, so the three cannot drift.
 *
 * includePending nets refunds that have reached Stripe but not reconciled:
 * conservative, and what every pre-flight check wants. The reconciler passes
 * false because a pending row is not yet money out of this charge.
 */
async function uncreditedHeadroomCents(paymentId, dbClient = pool, {
  excludeRefundRowId = null, includePending = false,
} = {}) {
  const statuses = includePending ? ['succeeded', 'pending'] : ['succeeded'];
  const { rows } = await dbClient.query(
    `SELECT GREATEST(
              pp.amount
                - COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                             WHERE ip.payment_id = pp.id), 0)
                - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                             WHERE pr.payment_id = pp.id
                               AND pr.status = ANY($2::text[])
                               AND ($3::int IS NULL OR pr.id <> $3)), 0),
              0)::int AS headroom
       FROM proposal_payments pp WHERE pp.id = $1`,
    [paymentId, statuses, excludeRefundRowId]
  );
  return Number(rows[0]?.headroom || 0);
}

/**
 * How much the CONTRACT invoices currently demand beyond what the contract says.
 *
 * This is the other half of what an overpayment refund may return, and it is
 * what a per-charge headroom test alone gets wrong. Paying a contract in full by
 * card credits the whole charge to a Balance invoice, which then LOCKS; repricing
 * the proposal down afterwards leaves that invoice demanding the old figure while
 * `total_price` is lower. There is no uncredited money anywhere, yet reversing
 * part of that credit is exactly the right correction: it brings the invoice back
 * to the contract. That is the commonest overpayment there is, and it is the case
 * the editor's own "a refund is likely owed" line announces.
 *
 * Contrast money taken outside Stripe: there the invoices already agree with the
 * contract, slack is zero, and reversing a credit would push a settled invoice
 * BELOW the contract. Same headroom, opposite right answer, and only this figure
 * tells them apart.
 */
async function contractInvoiceSlackCents(proposalId, dbClient = pool) {
  const { rows } = await dbClient.query(
    `SELECT GREATEST(
              COALESCE((SELECT SUM(i.amount_due) FROM invoices i
                         WHERE i.proposal_id = p.id AND i.status <> 'void'
                           AND i.label = ANY($2::text[])), 0)
              - ROUND(p.total_price * 100), 0)::int AS slack
       FROM proposals p WHERE p.id = $1`,
    [proposalId, CONTRACT_LABELS]
  );
  return Number(rows[0]?.slack || 0);
}

/** True when this payment funded an off-ledger invoice (Service Extension). */
async function paymentIsOffLedger(paymentId, dbClient = pool) {
  const res = await dbClient.query(
    `SELECT 1 FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
      WHERE ip.payment_id = $1 AND i.label = ANY($2::text[]) LIMIT 1`,
    [paymentId, OFF_LEDGER_INVOICE_LABELS]
  );
  return res.rowCount > 0;
}

async function overpaymentCents(proposalId, dbClient = pool) {
  const res = await dbClient.query(
    'SELECT total_price, amount_paid FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!res.rows[0]) return 0;
  const offContract = await offContractPaidCents(proposalId, dbClient);
  return nettedOverpaymentCents(res.rows[0].amount_paid, res.rows[0].total_price, offContract);
}

module.exports = {
  planRefund,
  offContractPaidCents,
  overpaymentCents,
  nettedOverpaymentCents,
  uncreditedHeadroomCents,
  contractInvoiceSlackCents,
  paymentIsOffLedger,
  availableOverpaymentCents,
  overpaymentRefusalMessage,
  fmtUSD,
  applyRefundReconciliation,
  loadPaymentsWithRemaining,
  planOverpaymentSplits,
  PANEL_REFUND_RAILS,
  CANCEL_LINE_REFUND_RAILS,
};
