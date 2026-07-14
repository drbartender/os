// Drink-plan extras invoices (write/create/find/refresh/void-reconcile). Extracted verbatim from invoiceHelpers.js.

'use strict';

const { toCents, db } = require('./invoiceShared');
const { calculateSyrupCost } = require('./pricingEngine');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
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
async function writeExtrasLineItems(invoiceId, { selections, guestCount, pricingSnapshot, numBars, totalCents }, dbClient) {
  const client = db(dbClient);
  const sel = selections || {};
  const snap = pricingSnapshot || {};
  const items = [];

  const addonSlugs = Object.keys(sel.addOns || {}).filter(
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

  if (sel.logistics?.addBarRental === true) {
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
  const selfProvided = sel.syrupSelfProvided || [];
  const proposalSyrups = snap?.syrups?.selections || [];
  const newSyrupIds = allSyrupIds
    .filter((id) => !selfProvided.includes(id))
    .filter((id) => !proposalSyrups.includes(id));
  const syrupCost = calculateSyrupCost(newSyrupIds, guestCount);
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
 * @param {{ proposalId:number, drinkPlanId:number, extrasAmountCents:number, lineItemState?:object }} opts
 * @param {object} dbClient  — must be a transaction client
 * @returns {Promise<object>} The new invoice row.
 */
async function createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents, lineItemState }, dbClient) {
  let selections;
  let guestCount;
  let pricingSnapshot;
  let numBars;
  if (lineItemState) {
    ({ selections, guestCount, pricingSnapshot, numBars } = lineItemState);
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
  await writeExtrasLineItems(
    invoice.id,
    { selections, guestCount, pricingSnapshot, numBars, totalCents: extrasAmountCents },
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
 * @returns {Promise<{id, label, status, locked, amount_due, amount_paid}|null>}
 */
async function findExtrasInvoice(proposalId, dbClient) {
  const client = db(dbClient);
  const result = await client.query(
    `SELECT id, label, status, locked, amount_due, amount_paid
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
 *     out-of-order webhook already settled it).
 *
 * @param {{ proposalId, drinkPlanId, breakdown, selections, guestCount, pricingSnapshot, numBars }} args
 * @param {object} dbClient — must be a transaction client
 * @returns {Promise<object>} the extras invoice row
 */
async function findOrRefreshExtrasInvoice(
  { proposalId, drinkPlanId, breakdown, selections, guestCount, pricingSnapshot, numBars },
  dbClient
) {
  const inv = await findExtrasInvoice(proposalId, dbClient);
  if (inv) {
    const isOpenUnlocked =
      (inv.status === 'sent' || inv.status === 'partially_paid') && !inv.locked;
    if (isOpenUnlocked) {
      await dbClient.query(
        'UPDATE invoices SET amount_due = $1, updated_at = NOW() WHERE id = $2',
        [breakdown.totalCents, inv.id]
      );
      await writeExtrasLineItems(
        inv.id,
        { selections, guestCount, pricingSnapshot, numBars, totalCents: breakdown.totalCents },
        dbClient
      );
    }
    // paid/locked → reuse as-is.
    return inv;
  }
  return createDrinkPlanExtrasInvoice(
    {
      proposalId,
      drinkPlanId,
      extrasAmountCents: breakdown.totalCents,
      // Pre-mutation state so the fresh invoice's line LABELS match amount_due
      // (the submit tx already incremented num_bars / recalced the snapshot).
      lineItemState: { selections, guestCount, pricingSnapshot, numBars },
    },
    dbClient
  );
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
    const hasAddonOrBar = lines.rows.some((r) =>
      r.source_type === 'addon'
      || r.description === 'Portable Bar Rental'
      || r.description === 'Additional Portable Bar');
    const foldedCents = hasAddonOrBar
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
  writeExtrasLineItems,
  createDrinkPlanExtrasInvoice,
  findExtrasInvoice,
  findOrRefreshExtrasInvoice,
  voidExtrasInvoiceWithReconcile,
};
