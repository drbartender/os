// Invoice line items from a proposal: the pure builder (lines that add up to the
// contract, spec 2026-10-08), its DB wrapper, and the writer.

'use strict';

const Sentry = require('@sentry/node');
const { toCents, db } = require('./invoiceShared');

// ─── 2. buildInvoiceLineItems / generateLineItemsFromProposal ────────────────

/**
 * NUMERIC dollars as read from proposals.total_price → integer cents, or null
 * when there is no usable contract total. toCents(null) is 0, and folding to a
 * contract of 0 would erase the whole invoice, so null stays null here.
 */
function contractCents(totalPrice) {
  if (totalPrice === null || totalPrice === undefined || totalPrice === '') return null;
  const n = Number(totalPrice);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Fold whatever the itemized lines leave short of the contract into the
 * package line (or, when that would take it below $0, one "Pricing adjustment"
 * line). Mutates `items` / `packageItem` in place and returns what it did.
 * No package line, or no contract total, means no fold.
 */
function foldToContract(items, packageItem, snap, { totalPriceCents, visibleAdjNetCents, gratuityLineCents }) {
  const fold = { gapCents: 0, explainedCents: null, unexplainedCents: 0, applied: null, drift: false };
  if (!packageItem || totalPriceCents === null || !Number.isFinite(totalPriceCents)) return fold;

  const itemizedCents = items.reduce((s, it) => s + it.line_total, 0);
  const gap = totalPriceCents - itemizedCents;
  fold.gapCents = gap;
  // What the snapshot itself expects the lines to fall short by: its total
  // less what it itemizes. That is the hidden adjustments, an override's
  // difference, or the zero clamp. Anything beyond it is drift.
  const hasSnapTotals = snap.total !== null && snap.total !== undefined
    && snap.subtotal !== null && snap.subtotal !== undefined
    && Number.isFinite(Number(snap.total)) && Number.isFinite(Number(snap.subtotal));
  if (hasSnapTotals) {
    fold.explainedCents = toCents(snap.total)
      - (toCents(snap.subtotal) + visibleAdjNetCents + gratuityLineCents);
  }
  fold.unexplainedCents = fold.explainedCents === null ? gap : gap - fold.explainedCents;
  // Each itemized line can carry up to a cent of rounding against the
  // snapshot's own rounded subtotal; past that it is a real disagreement.
  fold.drift = Math.abs(fold.unexplainedCents) > items.length;

  if (gap === 0) return fold;
  if (packageItem.line_total + gap >= 0) {
    packageItem.line_total += gap;
    packageItem.unit_price = packageItem.line_total;
    fold.applied = 'package';
  } else {
    items.push({
      description: 'Pricing adjustment',
      quantity: 1,
      unit_price: gap,
      line_total: gap,
      source_type: 'manual',
      source_id: null,
    });
    fold.applied = 'fallback';
  }
  return fold;
}

/**
 * Pure line-item builder (spec 2026-10-08). The lines always add up to the
 * contract when there is a package line and a contract total: whatever the
 * itemized lines leave short of it (a hidden adjustment, an override, the
 * engine's zero clamp, snapshot drift) is folded into the package line.
 *
 * @param {object} args
 * @param {object} args.snapshot         proposals.pricing_snapshot
 * @param {string} [args.packageName]    fallback package label
 * @param {number} [args.packageId]
 * @param {Array}  [args.addonRows]      proposal_addons rows (NUMERIC dollars)
 * @param {number|null} [args.totalPriceCents]  the contract; null = no fold
 * @returns {{ items: Array, fold: { gapCents, explainedCents, unexplainedCents, applied, drift } }}
 */
function buildInvoiceLineItems({ snapshot, packageName = null, packageId = null, addonRows = null, totalPriceCents = null }) {
  const snap = snapshot || {};
  const items = [];
  let packageItem = null;

  // Package base
  if (snap.package && snap.package.base_cost !== null && snap.package.base_cost !== undefined) {
    const unitPrice = toCents(snap.package.base_cost);
    packageItem = {
      description: snap.package.name || packageName || 'Service Package',
      quantity: 1,
      unit_price: unitPrice,
      line_total: unitPrice,
      source_type: 'package',
      source_id: packageId || null,
    };
    items.push(packageItem);
  }

  // Extra bartenders. HOSTED PACKAGE RULE: hosted packages cover bartenders
  // at a 1:100 ratio inside the per-guest rate, so on hosted snap.staffing.extra
  // counts only the OVER-ratio bartenders and snap.staffing.total is the
  // standard hourly + gratuity charge for them. Class packages always have
  // staffing.total = 0 (HOSTED PACKAGE RULE EXCEPTION). The `>0` guards below
  // skip both classes and legacy hosted snapshots (cut before 2026-05-14)
  // that pre-zeroed staffing even when extras existed.
  if (snap.staffing && snap.staffing.extra > 0 && snap.staffing.total > 0) {
    const qty = snap.staffing.extra;
    const lineTotal = toCents(snap.staffing.total);
    const unitPrice = Math.round(lineTotal / qty);
    items.push({
      description: 'Additional Bartender' + (qty > 1 ? 's' : ''),
      quantity: qty,
      unit_price: unitPrice,
      line_total: lineTotal,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Add-ons from proposal_addons (authoritative at booking time).
  // Skip $0 add-ons (e.g., addons that bundle into the package or were
  // adjusted to zero by an admin override — they don't deserve a line).
  for (const addon of addonRows || []) {
    const lineTotal = toCents(addon.line_total);
    if (lineTotal === 0) continue;
    const qty = Number(addon.quantity) || 1;
    const unitPrice = toCents(addon.rate);
    items.push({
      description: addon.addon_name || 'Add-on',
      quantity: qty,
      unit_price: unitPrice,
      line_total: lineTotal,
      source_type: 'addon',
      source_id: addon.addon_id || null,
    });
  }

  // Bar rental
  if (snap.bar_rental && snap.bar_rental.total > 0) {
    const lineTotal = toCents(snap.bar_rental.total);
    items.push({
      description: 'Bar Rental',
      quantity: 1,
      unit_price: lineTotal,
      line_total: lineTotal,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Syrups
  if (snap.syrups && snap.syrups.total > 0) {
    const lineTotal = toCents(snap.syrups.total);
    items.push({
      description: 'Signature Syrups',
      quantity: 1,
      unit_price: lineTotal,
      line_total: lineTotal,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Gratuity (§10 B1). Built from snapshot SHAPE (snap.gratuity), since this
  // function never reads breakdown labels. total_price already includes it, so
  // this only makes the client-paid gratuity visible on the invoice. (The forced
  // "Shared Gratuity" surcharge stays bundled into the Additional Bartender line
  // via snap.staffing.total — intentional, unchanged.)
  let gratuityLineCents = 0;
  if (snap.gratuity && snap.gratuity.total > 0) {
    gratuityLineCents = toCents(snap.gratuity.total);
    items.push({
      description: 'Gratuity',
      quantity: 1,
      unit_price: gratuityLineCents,
      line_total: gratuityLineCents,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Adjustments. Only what the client sees on the proposal gets a line, by
  // the page's own test (ProposalView: `if (!adj.visible) return`), and the
  // sign follows the type exactly as the engine and the page apply it. A
  // hidden one is still inside the contract, so the fold below carries it.
  let visibleAdjNetCents = 0;
  if (Array.isArray(snap.adjustments)) {
    for (const adj of snap.adjustments) {
      if (!adj || !adj.visible) continue;
      const amountCents = toCents(Math.abs(Number(adj.amount) || 0));
      if (amountCents === 0) continue;
      const lineTotal = adj.type === 'discount' ? -amountCents : amountCents;
      visibleAdjNetCents += lineTotal;
      items.push({
        description: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
        quantity: 1,
        unit_price: lineTotal,
        line_total: lineTotal,
        source_type: 'manual',
        source_id: null,
      });
    }
  }

  const fold = foldToContract(items, packageItem, snap, { totalPriceCents, visibleAdjNetCents, gratuityLineCents });
  return { items, fold };
}

/**
 * Log every applied fold; send drift and the fallback branch to Sentry. It
 * runs inside payment webhook transactions, so it never throws.
 */
function reportFold(proposalId, fold) {
  const anomalous = fold.drift || fold.applied === 'fallback';
  if (fold.applied || anomalous) {
    const msg = `invoiceLineItems: proposal ${proposalId} gap ${fold.gapCents} cents (applied ${fold.applied}; explained ${fold.explainedCents}, unexplained ${fold.unexplainedCents}, drift ${fold.drift})`;
    if (anomalous) console.warn(msg); else console.log(msg);
  }
  if (!anomalous || !process.env.SENTRY_DSN_SERVER) return;
  const kinds = [];
  if (fold.drift) kinds.push('invoice_lines_unexplained_fold');
  if (fold.applied === 'fallback') kinds.push('invoice_lines_fold_fallback');
  for (const kind of kinds) {
    try {
      Sentry.captureMessage(kind, {
        level: 'warning',
        tags: { util: 'invoiceLineItems', step: 'fold' },
        extra: { proposalId, ...fold },
      });
    } catch (err) {
      console.error('invoiceLineItems: Sentry report failed:', err && err.message);
    }
  }
}

/**
 * Build invoice line items from a proposal's current state.
 * Returns an array of plain objects; nothing is written to the DB.
 *
 * Pass `opts.totalPrice` (proposals.total_price exactly as read, NUMERIC dollars,
 * possibly null) when the caller already holds the total it derives amount_due
 * from, so the lines and the amount due come from one read. Without it the
 * total is read here, in the caller's transaction.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @param {{ totalPrice?: string|number|null }} [opts]
 * @returns {Promise<Array<{description, quantity, unit_price, line_total, source_type, source_id}>>}
 */
async function generateLineItemsFromProposal(proposalId, dbClient, opts = {}) {
  const client = db(dbClient);

  const proposalResult = await client.query(
    `SELECT p.id, p.pricing_snapshot, p.package_id, p.total_price,
            sp.name AS package_name
       FROM proposals p
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );

  if (proposalResult.rows.length === 0) {
    throw new Error(`Proposal ${proposalId} not found`);
  }

  const proposal = proposalResult.rows[0];

  const addonsResult = await client.query(
    `SELECT id, addon_id, addon_name, billing_type, rate, quantity, line_total
       FROM proposal_addons
      WHERE proposal_id = $1
      ORDER BY id`,
    [proposalId]
  );

  // A caller-held total wins; an explicit null is the one "no contract total"
  // signal. Undefined (a caller whose SELECT dropped the column) reads the row.
  const totalPrice = opts && opts.totalPrice !== undefined ? opts.totalPrice : proposal.total_price;

  const { items, fold } = buildInvoiceLineItems({
    snapshot: proposal.pricing_snapshot,
    packageName: proposal.package_name,
    packageId: proposal.package_id,
    addonRows: addonsResult.rows,
    totalPriceCents: contractCents(totalPrice),
  });
  reportFold(proposalId, fold);
  return items;
}

// ─── 3. writeLineItems ───────────────────────────────────────────────────────

/**
 * Replace all line items for an invoice with the provided set.
 * Safe to call on an unlocked invoice for refreshes.
 *
 * @param {number} invoiceId
 * @param {Array}  items     — output of generateLineItemsFromProposal()
 * @param {object} [dbClient]
 */
async function writeLineItems(invoiceId, items, dbClient) {
  const client = db(dbClient);

  await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);

  if (items.length > 0) {
    const placeholders = [];
    const values = [];
    items.forEach((item, i) => {
      const base = i * 7;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
      values.push(invoiceId, item.description, item.quantity, item.unit_price, item.line_total, item.source_type, item.source_id);
    });
    await client.query(
      `INSERT INTO invoice_line_items
         (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }
}

module.exports = {
  buildInvoiceLineItems,
  generateLineItemsFromProposal,
  writeLineItems,
};
