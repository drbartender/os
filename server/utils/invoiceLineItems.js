// Invoice line-item building/writing from a proposal. Extracted verbatim from invoiceHelpers.js.

'use strict';

const { toCents, db } = require('./invoiceShared');

// ─── 2. generateLineItemsFromProposal ────────────────────────────────────────

/**
 * Build invoice line items from a proposal's current state.
 * Returns an array of plain objects; nothing is written to the DB.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @returns {Promise<Array<{description, quantity, unit_price, line_total, source_type, source_id}>>}
 */
async function generateLineItemsFromProposal(proposalId, dbClient) {
  const client = db(dbClient);
  const items = [];

  // Fetch proposal with package info
  const proposalResult = await client.query(
    `SELECT p.id, p.pricing_snapshot, p.package_id,
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
  const snap = proposal.pricing_snapshot || {};

  // Package base
  if (snap.package && snap.package.base_cost !== null && snap.package.base_cost !== undefined) {
    const unitPrice = toCents(snap.package.base_cost);
    items.push({
      description: snap.package.name || proposal.package_name || 'Service Package',
      quantity: 1,
      unit_price: unitPrice,
      line_total: unitPrice,
      source_type: 'package',
      source_id: proposal.package_id || null,
    });
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

  // Add-ons from proposal_addons table (authoritative at booking time).
  // Skip $0 add-ons (e.g., addons that bundle into the package or were
  // adjusted to zero by an admin override — they don't deserve a line).
  const addonsResult = await client.query(
    `SELECT id, addon_id, addon_name, billing_type, rate, quantity, line_total
       FROM proposal_addons
      WHERE proposal_id = $1
      ORDER BY id`,
    [proposalId]
  );

  for (const addon of addonsResult.rows) {
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
  if (snap.gratuity && snap.gratuity.total > 0) {
    const lineTotal = toCents(snap.gratuity.total);
    items.push({
      description: 'Gratuity',
      quantity: 1,
      unit_price: lineTotal,
      line_total: lineTotal,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Adjustments (discounts, surcharges, etc.)
  if (Array.isArray(snap.adjustments)) {
    for (const adj of snap.adjustments) {
      if (adj.amount === null || adj.amount === undefined) continue;
      const lineTotal = toCents(adj.amount);
      items.push({
        description: adj.label || 'Adjustment',
        quantity: 1,
        unit_price: lineTotal,
        line_total: lineTotal,
        source_type: 'manual',
        source_id: null,
      });
    }
  }

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
  generateLineItemsFromProposal,
  writeLineItems,
};
