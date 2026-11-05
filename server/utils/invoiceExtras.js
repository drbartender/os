// Drink-plan extras invoices (write/create/find/refresh/void-reconcile). Extracted verbatim from invoiceHelpers.js.

'use strict';

const { toCents, db } = require('./invoiceShared');
const { calculateSyrupCost } = require('./pricingEngine');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
const { OFF_LEDGER_INVOICE_LABELS } = require('./proposalMoneyShared');
const { ConflictError } = require('./errors');
const { writeLineItems } = require('./invoiceLineItems');
const { createInvoice } = require('./invoiceLifecycle');
const { readSnapshot } = require('./pricingSnapshot');

// ─── 11. writeExtrasLineItems + createDrinkPlanExtrasInvoice ──────────────────

/**
 * Build and write the "Drink Plan Extras" line items for an invoice from a
 * selections payload. Extracted from createDrinkPlanExtrasInvoice so the submit
 * find-or-refresh path and the create path share ONE line-item builder and can
 * never drift.
 *
 * Mirrors the create-intent extras math: raw enabled add-on slugs (per-guest vs
 * flat), bar rental (first-vs-additional keyed on numBars), and NEW syrups only
 * (excludes self-provided + already-in-snapshot). `totalCents` is the invoice
 * amount_due (what Stripe charged); per-line rounding can drift a cent or two
 * from that, so the drift is absorbed into the last line — the lines always sum
 * to amount_due and the invoice never shows a phantom balance.
 *
 * @param {number} invoiceId
 * @param {{ selections:object, guestCount:number, pricingSnapshot:object, numBars:number, totalCents:number }} args
 * @param {object} dbClient — must be a transaction client
 * @returns {Promise<Array>} the line items written
 */
async function writeExtrasLineItems(invoiceId, { lines, selections, guestCount, pricingSnapshot, numBars, totalCents }, dbClient) {
  const client = db(dbClient);
  const sel = selections || {};
  const snap = pricingSnapshot || {};
  const items = [];

  // Pre-priced lines (audit PRC-03): computeExtrasBreakdown now prices the
  // add-ons, the bar and the syrups through the fold's own engine legs and
  // hands the lines over, so the invoice shows the figures the contract
  // absorbed, not a flat catalog rate. The selection-derived builder below
  // stays for the one caller with no breakdown in hand, the out-of-order
  // webhook mint (createDrinkPlanExtrasInvoice without lineItemState).
  if (Array.isArray(lines)) {
    for (const line of lines) items.push({ ...line });
  }

  const addonSlugs = Array.isArray(lines) ? [] : Object.keys(sel.addOns || {}).filter(
    (slug) => sel.addOns[slug]?.enabled
  );
  if (addonSlugs.length > 0) {
    const addonRows = await client.query(
      'SELECT id, slug, name, rate, billing_type FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    for (const addon of addonRows.rows) {
      const rate = Number(addon.rate);
      const isPerGuest = addon.billing_type === 'per_guest';
      const qty = isPerGuest ? (guestCount || 1) : 1;
      const lineCents = toCents(rate * qty);
      const unitCents = toCents(rate);
      const description = isPerGuest
        ? `${addon.name} (${qty} guests)`
        : addon.name;
      items.push({
        description,
        quantity: qty,
        unit_price: unitCents,
        line_total: lineCents,
        source_type: 'addon',
        source_id: addon.id,
      });
    }
  }

  if (!Array.isArray(lines) && sel.logistics?.addBarRental === true) {
    const barRental = snap.bar_rental || {};
    const isAdditional = (numBars || 0) >= 1;
    const feeDollars = isAdditional
      ? (barRental.additional_bar_fee || 100)
      : (barRental.first_bar_fee || 50);
    const lineCents = toCents(feeDollars);
    items.push({
      description: isAdditional ? 'Additional Portable Bar' : 'Portable Bar Rental',
      quantity: 1,
      unit_price: lineCents,
      line_total: lineCents,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Syrup cost — compute directly from selections (instead of deriving by
  // subtraction from totalCents) so we get an honest syrup line with bottle
  // count, not a ghost 1-cent item when no syrups were selected.
  const rawSyrups = sel.syrupSelections || {};
  const allSyrupIds = Array.isArray(rawSyrups)
    ? rawSyrups
    : [...new Set(Object.values(rawSyrups).flat())];
  // Array.isArray guard: a public token payload could send a non-array
  // syrupSelfProvided — a string would suppress charges via substring .includes,
  // an object/number would throw.
  const selfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const proposalSyrups = snap?.syrups?.selections || [];
  const newSyrupIds = allSyrupIds
    .filter((id) => !selfProvided.includes(id))
    .filter((id) => !proposalSyrups.includes(id));
  const syrupCost = Array.isArray(lines) ? { total: 0 } : calculateSyrupCost(newSyrupIds, guestCount);
  if (syrupCost.total > 0) {
    const syrupCents = toCents(syrupCost.total);
    const bottleSuffix = syrupCost.totalBottles > 1 ? ` (${syrupCost.totalBottles} bottles)` : '';
    items.push({
      description: `Hand-Crafted Syrups${bottleSuffix}`,
      quantity: 1,
      unit_price: syrupCents,
      line_total: syrupCents,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Ledger invariant: line items must sum to `totalCents` (what Stripe charged).
  // Per-line rounding can drift a cent or two from the intent-creation rounding
  // in stripe.js; absorb that delta into the last line so the invoice never
  // shows a phantom balance.
  const lineSumCents = items.reduce((sum, it) => sum + it.line_total, 0);
  const driftCents = totalCents - lineSumCents;
  if (driftCents !== 0) {
    if (items.length > 0) {
      const last = items[items.length - 1];
      last.line_total += driftCents;
      // Keep unit_price consistent with the adjusted line_total (line_total is the
      // authoritative ledger figure; unit_price is display). For qty>1 a rounded
      // per-unit is the closest representable value.
      last.unit_price = last.quantity > 1
        ? Math.round(last.line_total / last.quantity)
        : last.line_total;
    } else {
      items.push({
        description: 'Drink Plan Extras',
        quantity: 1,
        unit_price: totalCents,
        line_total: totalCents,
        source_type: 'fee',
        source_id: null,
      });
    }
  }

  await writeLineItems(invoiceId, items, client);
  return items;
}

/**
 * Create a new "Drink Plan Extras" invoice for a drink-plan payment.
 *
 * Builds line items via writeExtrasLineItems. `lineItemState` (optional) is the
 * PRE-mutation { selections, guestCount, pricingSnapshot, numBars } captured by
 * the submit transaction BEFORE it increments num_bars / overwrites the pricing
 * snapshot — pass it so the line LABELS match amount_due (e.g. a first bar isn't
 * mislabeled "Additional Portable Bar"). The webhook / backfill callers run
 * post-commit and omit it, so the final DB state is read instead. Caller records
 * the payment via linkPaymentToInvoice().
 *
 * `foldedIntoTotal` (optional) is the stored fold fact (round 2 H1): true
 * from the submit transaction path, whose fold put this money inside
 * total_price, false from the fast path, which folds nothing. A caller that
 * cannot know it (the out-of-order webhook mint, the backfill) leaves the
 * column NULL and the readers fall back to the line shape until the submit
 * stamps it through findOrRefreshExtrasInvoice.
 *
 * @param {{ proposalId:number, drinkPlanId:number, extrasAmountCents:number, lineItemState?:object, foldedIntoTotal?:boolean }} opts
 * @param {object} dbClient  — must be a transaction client
 * @returns {Promise<object>} The new invoice row.
 */
async function createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents, lineItemState, foldedIntoTotal }, dbClient) {
  let selections;
  let guestCount;
  let pricingSnapshot;
  let numBars;
  let lines;
  if (lineItemState) {
    ({ selections, guestCount, pricingSnapshot, numBars, lines } = lineItemState);
  } else {
    const [dpRes, propRes] = await Promise.all([
      dbClient.query('SELECT selections FROM drink_plans WHERE id = $1', [drinkPlanId]),
      dbClient.query(
        'SELECT guest_count, num_bars, pricing_snapshot FROM proposals WHERE id = $1',
        [proposalId]
      ),
    ]);
    if (!dpRes.rows[0]) throw new Error(`Drink plan ${drinkPlanId} not found`);
    if (!propRes.rows[0]) throw new Error(`Proposal ${proposalId} not found`);
    selections = dpRes.rows[0].selections || {};
    guestCount = propRes.rows[0].guest_count;
    pricingSnapshot = readSnapshot(propRes.rows[0].pricing_snapshot, { context: 'invoiceExtras' });
    numBars = propRes.rows[0].num_bars;
  }

  const invoice = await createInvoice(
    {
      proposalId,
      label: 'Drink Plan Extras',
      amountDueCents: extrasAmountCents,
      status: 'sent',
      dueDate: null,
    },
    dbClient
  );
  if (foldedIntoTotal === true || foldedIntoTotal === false) {
    await dbClient.query('UPDATE invoices SET folded_into_total = $1 WHERE id = $2', [foldedIntoTotal, invoice.id]);
    invoice.folded_into_total = foldedIntoTotal;
  }
  await writeExtrasLineItems(
    invoice.id,
    { lines, selections, guestCount, pricingSnapshot, numBars, totalCents: extrasAmountCents },
    dbClient
  );
  return invoice;
}

// ─── 11b. findExtrasInvoice / findOrRefreshExtrasInvoice ──────────────────────

/**
 * The DEDUP finder: newest non-void "Drink Plan Extras" invoice for a proposal
 * (INCLUDING paid/locked). Used everywhere we must not create a second extras
 * invoice — submit (find-or-refresh), the webhook link, the finalize warning,
 * and comp. Matching ANY non-void (not just open) is what makes the out-of-order
 * webhook safe: a webhook that already created + paid one (flipping it to
 * status='paid', locked=true) is still found and reused, never duplicated.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @returns {Promise<{id, label, status, locked, amount_due, amount_paid, folded_into_total}|null>}
 */
async function findExtrasInvoice(proposalId, dbClient) {
  const client = db(dbClient);
  const result = await client.query(
    `SELECT id, label, status, locked, amount_due, amount_paid, folded_into_total
       FROM invoices
      WHERE proposal_id = $1 AND label = 'Drink Plan Extras' AND status <> 'void'
      ORDER BY id DESC
      LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

/**
 * Find-or-refresh the proposal's "Drink Plan Extras" invoice at submit:
 *   - no existing non-void one → create it at breakdown.totalCents;
 *   - existing OPEN + UNLOCKED → refresh amount_due + line items to the new
 *     breakdown (covers a selection edit before the card is confirmed);
 *   - existing paid/locked     → reuse AS-IS (never mutate a paid invoice; the
 *     out-of-order webhook already settled it); only the stored fold fact is
 *     stamped, since the webhook could not know it and the submit decides it.
 *
 * `foldedIntoTotal` is that fact (round 2 H1): the transaction path passes
 * true, the fast path false; it is written on the create and on the refresh.
 *
 * @param {{ proposalId, drinkPlanId, breakdown, selections, guestCount, pricingSnapshot, numBars, foldedIntoTotal?:boolean }} args
 * @param {object} dbClient — must be a transaction client
 * @returns {Promise<object>} the extras invoice row
 */
async function findOrRefreshExtrasInvoice(
  { proposalId, drinkPlanId, breakdown, selections, guestCount, pricingSnapshot, numBars, foldedIntoTotal },
  dbClient
) {
  const factKnown = foldedIntoTotal === true || foldedIntoTotal === false;
  const inv = await findExtrasInvoice(proposalId, dbClient);
  if (inv) {
    const isOpenUnlocked =
      (inv.status === 'sent' || inv.status === 'partially_paid') && !inv.locked;
    if (isOpenUnlocked) {
      const fact = factKnown ? foldedIntoTotal : (inv.folded_into_total ?? null);
      await dbClient.query(
        'UPDATE invoices SET amount_due = $1, folded_into_total = $2, updated_at = NOW() WHERE id = $3',
        [breakdown.totalCents, fact, inv.id]
      );
      inv.folded_into_total = fact;
      await writeExtrasLineItems(
        inv.id,
        { lines: breakdown.lines, selections, guestCount, pricingSnapshot, numBars, totalCents: breakdown.totalCents },
        dbClient
      );
    } else if (factKnown && inv.folded_into_total !== foldedIntoTotal) {
      // paid/locked: the demand and the lines stand; the provenance is recorded.
      await dbClient.query('UPDATE invoices SET folded_into_total = $1 WHERE id = $2', [foldedIntoTotal, inv.id]);
      inv.folded_into_total = foldedIntoTotal;
    }
    return inv;
  }
  return createDrinkPlanExtrasInvoice(
    {
      proposalId,
      drinkPlanId,
      extrasAmountCents: breakdown.totalCents,
      // Pre-mutation state so the fresh invoice's line LABELS match amount_due
      // (the submit tx already incremented num_bars / recalced the snapshot),
      // and the breakdown's own priced lines (audit PRC-03).
      lineItemState: { lines: breakdown.lines, selections, guestCount, pricingSnapshot, numBars },
      foldedIntoTotal: factKnown ? foldedIntoTotal : undefined,
    },
    dbClient
  );
}

// ─── 11b2. extrasLinesAreFolded / sumOffContractPaidCents ────────────────────

/**
 * Did this "Drink Plan Extras" invoice's money fold into proposals.total_price?
 *
 * PURE. The stored fact answers first (invoices.folded_into_total, round 2
 * H1, 2026-11-05): the submit path that minted or refreshed the invoice wrote
 * true from the transaction path, whose fold put the whole extras (new add-on
 * rows, a bar, the new syrups) inside total_price, and false from the fast
 * path, which folds nothing. The line shape alone could not tell them apart:
 * a transaction-path submit that adds no NEW add-on row (an upgrade already
 * sold, toggled beside two new syrups) mints a syrup-only-looking invoice
 * whose money the contract already holds, and reading it as unfolded charged
 * that money twice. Money law 5: provenance is stored, never read off a label
 * or a line shape.
 *
 * A row minted before the column, or by the out-of-order webhook mint the
 * submit has not stamped yet (NULL), keeps the old classification: ANY add-on
 * or bar-rental line marks the transaction path, a syrup-only invoice the fast
 * path. Derived from PERSISTED line items, never a fresh recompute, so a
 * mid-flight price change cannot corrupt the answer.
 *
 * @param {{line_total:any, source_type:string, description:string}[]} lineRows
 * @param {{folded_into_total?:boolean|null}} [invoice]  the invoice row, when the
 *   caller selected folded_into_total; omitted, the line shape decides
 * @returns {boolean}
 */
function extrasLinesAreFolded(lineRows, invoice) {
  const stored = invoice ? invoice.folded_into_total : undefined;
  if (stored === true || stored === false) return stored;
  return (lineRows || []).some((r) =>
    r.source_type === 'addon'
    || r.description === 'Portable Bar Rental'
    || r.description === 'Additional Portable Bar');
}

// Labels whose collected money IS inside proposals.total_price. Deposit /
// Balance / Full Payment by construction; 'Additional Services' because
// createAdditionalInvoiceIfNeeded mints it FROM a total_price delta;
// 'Enhancement Lab' because lab additions fold into total_price (2026-07-20,
// which is why that label left OFF_LEDGER_INVOICE_LABELS).
//
// NOT the same thing as CONTRACT_LABELS, which is a REFUND-SCOPE
// classification. Confusing the two under-refunded a client by $300 in review
// (2026-07-28): CONTRACT_LABELS excludes Additional Services, so netting by it
// treated contract money as off-contract and swallowed a real overpayment.
const IN_TOTAL_PRICE_LABELS = Object.freeze([
  'Deposit', 'Balance', 'Full Payment', 'Additional Services', 'Enhancement Lab',
]);

// Labels whose collected money is NOT off-contract: inside total_price
// (IN_TOTAL_PRICE_LABELS) or off both columns (OFF_LEDGER_INVOICE_LABELS).
// sumOffContractPaidCents skips exactly these, and offContractPaidCentsSql
// binds the same array, so the two readers can never disagree on the partition.
const NOT_OFF_CONTRACT_LABELS = Object.freeze([...IN_TOTAL_PRICE_LABELS, ...OFF_LEDGER_INVOICE_LABELS]);

/**
 * Sum the money a proposal has COLLECTED that does NOT live inside
 * proposals.total_price: syrup-only "Drink Plan Extras" and any free-text
 * manual invoice (Damage Fee, Travel) created via POST /api/invoices/proposal/:id.
 *
 * This is the netting term for any "is the client overpaid?" question.
 * `amount_paid - total_price` is NOT overpayment in this schema, because those
 * dollars roll into proposals.amount_paid and never into total_price — see the
 * long note in refundHelpers.js. Handing the raw difference to
 * planOverpaymentSplits refunds money the client still owes for goods DRB is
 * still buying.
 *
 * OFF_LEDGER_INVOICE_LABELS ('Service Extension') is skipped too, for the
 * OPPOSITE reason: that money never rolls into proposals.amount_paid either
 * (the webhook's off-ledger skip), so it is off BOTH sides of the
 * `amount_paid - total_price` equation and can never be a netting term.
 * Counting a paid extension here would deflate a genuine overpayment and
 * under-refund the client on a cancel-line.
 *
 * @param {number} proposalId
 * @param {object} dbClient  the CALLER'S client — this runs inside a held
 *                           transaction, so it must never take its own.
 * @returns {Promise<number>} cents
 */
async function sumOffContractPaidCents(proposalId, dbClient) {
  const client = db(dbClient);
  const { rows } = await client.query(
    `SELECT id, label, amount_paid, folded_into_total FROM invoices
      WHERE proposal_id = $1 AND status <> 'void' AND amount_paid > 0
        AND NOT (COALESCE(label, '') = ANY($2::text[]))`,
    [proposalId, NOT_OFF_CONTRACT_LABELS]
  );

  let cents = 0;
  for (const inv of rows) {
    if (inv.label === 'Drink Plan Extras') {
      // The stored fact decides; the lines are read only for a NULL row.
      const stored = inv.folded_into_total === true || inv.folded_into_total === false;
      const lines = stored ? [] : (await client.query(
        'SELECT line_total, source_type, description FROM invoice_line_items WHERE invoice_id = $1',
        [inv.id]
      )).rows;
      if (extrasLinesAreFolded(lines, inv)) continue; // folded: it IS contract money
    }
    cents += Number(inv.amount_paid);
  }
  return cents;
}

// ─── 11b3. contractBalanceDueCents / offContractPaidCentsSql ─────────────────

/**
 * The contract balance still due, in SIGNED cents (negative = the contract is
 * overpaid): total_price − amount_paid + sumOffContractPaidCents.
 *
 * `total_price − amount_paid` alone is NOT the balance due in this schema, for
 * the same reason the raw difference is not the overpayment (above): a paid
 * syrup-only Drink Plan Extras invoice or a free-text manual invoice rolls into
 * amount_paid and never into total_price, so the raw difference forgives the
 * contract by that money. Every site that charges, bills or quotes the balance
 * (autopay, charge-balance, the Balance invoice, the drink-plan balance fold,
 * the reminders, the client surfaces) reads THIS, and the status ladder keeps
 * its own raw `amount_paid >= total_price` paid flag (money law 8), which is a
 * different question. Audit PAY-01, 2026-11-05: a deposit-paid client who paid
 * a 6000-cent syrup pack was then auto-charged 84000 against a 90000 balance.
 *
 * Takes the row values the caller already holds (a claim UPDATE ... RETURNING,
 * a locked read, a payload row), never a re-read, so the figure matches the
 * row the caller decided on. Callers that want a floor clamp it themselves.
 *
 * @param {{id:number, total_price:any, amount_paid:any}} proposal
 * @param {object} [dbClient]  the caller's transaction client, or the pool
 * @returns {Promise<number>} signed cents
 */
async function contractBalanceDueCents(proposal, dbClient) {
  const offContract = await sumOffContractPaidCents(proposal.id, dbClient);
  return toCents(proposal.total_price || 0) - toCents(proposal.amount_paid || 0) + offContract;
}

/**
 * SQL twin of sumOffContractPaidCents, for the one set-based reader that cannot
 * call it per row (balanceInvoiceMonitor scans every proposal in one query).
 * A correlated scalar subquery on the outer proposals alias (`proposalRef`,
 * e.g. 'p.id'); `labelsParam` is the placeholder the caller binds
 * NOT_OFF_CONTRACT_LABELS to (e.g. '$2'). The folded-extras predicate is the
 * SQL form of extrasLinesAreFolded: the stored fact (folded_into_total) first,
 * and on a NULL row an addon line or a bar-rental line marks a Drink Plan
 * Extras invoice as folded (contract money). Keep the three in step.
 *
 * @param {string} proposalRef
 * @param {string} labelsParam
 * @returns {string} a SQL expression yielding integer cents (0 when none)
 */
function offContractPaidCentsSql(proposalRef, labelsParam) {
  return `COALESCE((
    SELECT SUM(oc.amount_paid) FROM invoices oc
     WHERE oc.proposal_id = ${proposalRef} AND oc.status <> 'void' AND oc.amount_paid > 0
       AND NOT (COALESCE(oc.label, '') = ANY(${labelsParam}::text[]))
       AND NOT (oc.label = 'Drink Plan Extras' AND COALESCE(oc.folded_into_total, EXISTS (
             SELECT 1 FROM invoice_line_items ocl
              WHERE ocl.invoice_id = oc.id
                AND (ocl.source_type = 'addon'
                     OR ocl.description IN ('Portable Bar Rental', 'Additional Portable Bar')))))
  ), 0)::bigint`;
}

// ─── 11c. voidExtrasInvoiceWithReconcile ─────────────────────────────────────

/**
 * Void an unpaid "Drink Plan Extras" invoice and (for a comp) reconcile the
 * proposal total. Shared by the invoices PATCH comp route and the submit
 * void-before-refresh path so the void/audit logic never drifts.
 *
 * The `reconcileTotalPrice` flag is the ONE thing that differs between callers:
 *   - Comp/waive (PATCH, default true): the add-on portion is being WAIVED, so
 *     subtract it from proposals.total_price and re-run the payment-status
 *     ladder. Syrups were never in total_price, so a syrup-only comp is a pure
 *     void.
 *   - Path-switch (submit, false): the plan is being re-submitted as
 *     add-to-balance, which keeps the add-on in the extras-inclusive
 *     total_price so refreshUnlockedInvoices can put it on the rebuilt Balance.
 *     Subtracting here would bill the add-on nowhere (undercharge).
 *
 * The folded-into-total portion is derived from the invoice's PERSISTED line
 * items, never a fresh recompute, so a mid-flight price change can't corrupt the
 * reversal. An extras invoice that has ANY add-on or bar-rental line came through
 * the submit TRANSACTION path, where calculateProposal folds the WHOLE extras
 * (add-ons + bar + new syrups) into total_price — so the entire invoice comes
 * back out. A syrup-only invoice came through the fast path, which never ran
 * calculateProposal, so nothing was folded (subtract 0). Comp is unpaid-only: a
 * paid invoice throws.
 *
 * @param {number} invoiceId
 * @param {number|null} actorId  admin user id (null = system/client action)
 * @param {object} dbClient      must be a transaction client
 * @param {{ reconcileTotalPrice?:boolean, reason?:string }} [opts]
 * @returns {Promise<object>} the invoice row (pre-void state)
 */
async function voidExtrasInvoiceWithReconcile(invoiceId, actorId, dbClient, opts = {}) {
  const { reconcileTotalPrice = true, reason = 'comp' } = opts;
  const client = db(dbClient);

  const invRes = await client.query(
    `SELECT id, proposal_id, label, amount_due, amount_paid, status
       FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const inv = invRes.rows[0];
  if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
  if (Number(inv.amount_paid) > 0) {
    throw new ConflictError(
      'Cannot void an invoice with payments applied. Refund payments first.',
      'INVOICE_HAS_PAYMENTS'
    );
  }
  if (inv.status === 'void') return inv; // idempotent

  await client.query(
    `UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1`,
    [invoiceId]
  );

  // Audit: a comp is an admin money action; the path-switch void is a system
  // move. Either way we record who/what and how much left the books.
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'extras_comped', $2, $3, $4)`,
    [
      inv.proposal_id,
      actorId ? 'admin' : 'system',
      actorId || null,
      JSON.stringify({ amount_cents: Number(inv.amount_due), invoice_id: invoiceId, reason }),
    ]
  );

  if (reconcileTotalPrice) {
    // An extras invoice with ANY add-on or bar-rental line went through the submit
    // transaction path, where calculateProposal folded the ENTIRE extras (add-ons
    // + bar + new syrups) into total_price — so the whole invoice comes back out.
    // A syrup-only invoice took the fast path (no calculateProposal), so nothing
    // was folded (subtract 0). Derived from PERSISTED line items, never a recompute.
    const lines = await client.query(
      'SELECT line_total, source_type, description FROM invoice_line_items WHERE invoice_id = $1',
      [invoiceId]
    );
    const foldedCents = extrasLinesAreFolded(lines.rows)
      ? lines.rows.reduce((sum, r) => sum + Number(r.line_total), 0)
      : 0;
    if (foldedCents > 0) {
      // proposals.total_price is NUMERIC DOLLARS — subtract dollars, not cents.
      const prop = await client.query(
        `UPDATE proposals SET total_price = total_price - $1, updated_at = NOW()
          WHERE id = $2 RETURNING status, amount_paid, total_price`,
        [foldedCents / 100, inv.proposal_id]
      );
      const p = prop.rows[0];
      if (p) {
        const rec = reconcileProposalPaymentStatus({
          status: p.status,
          amountPaid: p.amount_paid,
          totalPrice: p.total_price,
        });
        if (rec.changed) {
          await client.query('UPDATE proposals SET status = $1 WHERE id = $2', [rec.status, inv.proposal_id]);
        }
        if (rec.autopayDisarmed) {
          await client.query('UPDATE proposals SET autopay_status = NULL WHERE id = $1', [inv.proposal_id]);
        }
      }
    }
  }

  return inv;
}

module.exports = {
  extrasLinesAreFolded,
  sumOffContractPaidCents,
  contractBalanceDueCents,
  offContractPaidCentsSql,
  NOT_OFF_CONTRACT_LABELS,
  IN_TOTAL_PRICE_LABELS,
  writeExtrasLineItems,
  createDrinkPlanExtrasInvoice,
  findExtrasInvoice,
  findOrRefreshExtrasInvoice,
  voidExtrasInvoiceWithReconcile,
};
