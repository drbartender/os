/**
 * Invoice Helper Utilities
 *
 * All money handled here is INTEGER CENTS for invoice tables.
 * Proposal/addon tables use NUMERIC dollars — convert with toCents().
 *
 * The `dbClient` parameter on every function accepts either:
 *   - A transaction client from pool.connect() (preferred inside transactions)
 *   - Omitted / falsy → falls back to the shared pool for standalone use
 */

'use strict';

const { pool } = require('../db');
const { calculateSyrupCost } = require('./pricingEngine');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert a NUMERIC dollar value (string or number) to integer cents. */
function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/** Return the db client to use (transaction client or pool fallback). */
function db(dbClient) {
  return dbClient || pool;
}

// ─── 1. formatInvoiceNumber ──────────────────────────────────────────────────

/**
 * Format a raw sequence value into a human-readable invoice number.
 * @param {number} seqVal
 * @returns {string}  e.g. "INV-0001"
 */
function formatInvoiceNumber(seqVal) {
  return 'INV-' + String(seqVal).padStart(4, '0');
}

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

  // Extra bartenders — skipped on hosted packages (HOSTED PACKAGE RULE:
  // bartender staffing is included in the per-guest rate, so staffing.total is 0).
  // This file relies on pricingEngine.js pre-zeroing staffing.total and the
  // additional-bartender addon line_total for hosted packages. If you ever
  // populate snap.staffing.total or addon.line_total from a non-pricingEngine
  // code path for a hosted proposal, add an explicit isHostedPackage() guard
  // here — the snapshot fields are load-bearing.
  if (snap.staffing && snap.staffing.extra > 0 && snap.staffing.total > 0) {
    const extra = snap.staffing.actual - snap.staffing.included;
    const qty = extra > 0 ? extra : 1;
    const lineTotal = toCents(snap.staffing.total);
    const unitPrice = qty > 0 ? Math.round(lineTotal / qty) : lineTotal;
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
  // Skip $0 add-ons (e.g., additional-bartender on hosted packages — HOSTED PACKAGE RULE).
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

// ─── 4. createInvoice ────────────────────────────────────────────────────────

/**
 * Create a new invoice row and return it.
 *
 * @param {{ proposalId, label, amountDueCents, status, dueDate }} opts
 * @param {object} [dbClient]
 * @returns {Promise<object>} The inserted invoice row.
 */
async function createInvoice({ proposalId, label, amountDueCents, status, dueDate }, dbClient) {
  const client = db(dbClient);

  const seqResult = await client.query("SELECT nextval('invoice_number_seq') AS val");
  const invoiceNumber = formatInvoiceNumber(Number(seqResult.rows[0].val));

  const result = await client.query(
    `INSERT INTO invoices
       (proposal_id, invoice_number, label, amount_due, status, due_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      proposalId,
      invoiceNumber,
      label,
      amountDueCents,
      status || 'draft',
      dueDate || null,
    ]
  );

  return result.rows[0];
}

// ─── 5. lockInvoice ──────────────────────────────────────────────────────────

/**
 * Lock an invoice so its line items and amount_due cannot be refreshed.
 * Idempotent — does nothing if already locked.
 *
 * @param {number} invoiceId
 * @param {object} [dbClient]
 */
async function lockInvoice(invoiceId, dbClient) {
  const client = db(dbClient);

  await client.query(
    `UPDATE invoices
        SET locked = true, locked_at = NOW()
      WHERE id = $1 AND locked = false`,
    [invoiceId]
  );
}

// ─── 6. refreshUnlockedInvoices ──────────────────────────────────────────────

/**
 * Regenerate line items and recalculate amount_due for all unlocked,
 * non-void invoices belonging to a proposal.
 *
 * amount_due logic:
 *   - "Deposit"       → proposal.deposit_amount in cents
 *   - "Full Payment"  → proposal.total_price in cents
 *   - "Balance" / any → total_price − sum(locked invoice amount_due) in cents
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 */
async function refreshUnlockedInvoices(proposalId, dbClient) {
  const client = db(dbClient);

  // Fetch proposal financials, locked total, and unlocked invoices in parallel
  const [propResult, lockedResult, unlockedResult] = await Promise.all([
    client.query(
      `SELECT total_price, deposit_amount FROM proposals WHERE id = $1`,
      [proposalId]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount_due), 0) AS locked_total
         FROM invoices
        WHERE proposal_id = $1 AND locked = true AND status != 'void'`,
      [proposalId]
    ),
    client.query(
      `SELECT id, label FROM invoices
        WHERE proposal_id = $1 AND locked = false AND status != 'void'
        ORDER BY id`,
      [proposalId]
    ),
  ]);

  if (propResult.rows.length === 0) return;

  const prop = propResult.rows[0];
  const totalCents = toCents(prop.total_price);
  const depositCents = toCents(prop.deposit_amount);
  const lockedTotal = Number(lockedResult.rows[0].locked_total);

  // Fresh line items (shared across all unlocked invoices for this proposal)
  const lineItems = await generateLineItemsFromProposal(proposalId, client);

  for (const invoice of unlockedResult.rows) {
    let amountDue;

    if (invoice.label === 'Deposit') {
      amountDue = depositCents;
    } else if (invoice.label === 'Full Payment') {
      amountDue = totalCents;
    } else if (invoice.label === 'Balance') {
      amountDue = Math.max(0, totalCents - lockedTotal);
    } else {
      // Non-standard labels (e.g., 'Additional Services', manual invoices)
      // have bespoke amounts and line items — skip refresh entirely
      continue;
    }

    // Update amount_due
    await client.query(
      `UPDATE invoices SET amount_due = $1, updated_at = NOW() WHERE id = $2`,
      [amountDue, invoice.id]
    );

    // Replace line items
    await writeLineItems(invoice.id, lineItems, client);
  }
}

// ─── 7. createInvoiceOnSend ──────────────────────────────────────────────────

/**
 * Called when proposal status changes to 'sent'.
 * Creates the first invoice (Deposit or Full Payment).
 * Idempotent — returns null if any invoice already exists.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @returns {Promise<object|null>} The new invoice row, or null if already exists.
 */
async function createInvoiceOnSend(proposalId, dbClient) {
  const client = db(dbClient);

  // Idempotency check
  const existingResult = await client.query(
    `SELECT id FROM invoices WHERE proposal_id = $1 LIMIT 1`,
    [proposalId]
  );
  if (existingResult.rows.length > 0) return null;

  // Fetch proposal
  const propResult = await client.query(
    `SELECT total_price, deposit_amount, payment_type, balance_due_date
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  if (propResult.rows.length === 0) throw new Error(`Proposal ${proposalId} not found`);

  const prop = propResult.rows[0];
  const isDeposit = prop.payment_type === 'deposit';
  const label = isDeposit ? 'Deposit' : 'Full Payment';
  const amountDueCents = isDeposit
    ? toCents(prop.deposit_amount)
    : toCents(prop.total_price);
  const dueDate = isDeposit ? null : (prop.balance_due_date || null);

  const invoice = await createInvoice(
    { proposalId, label, amountDueCents, status: 'sent', dueDate },
    client
  );

  const lineItems = await generateLineItemsFromProposal(proposalId, client);
  await writeLineItems(invoice.id, lineItems, client);

  return invoice;
}

// ─── 8. createBalanceInvoice ─────────────────────────────────────────────────

/**
 * Called after the deposit is paid.
 * Creates a "Balance" invoice for total_price − amount_paid.
 * Returns null if a balance invoice already exists or the balance is zero.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @returns {Promise<object|null>}
 */
async function createBalanceInvoice(proposalId, dbClient) {
  const client = db(dbClient);

  // Idempotency check — don't create a second Balance invoice
  const existingResult = await client.query(
    `SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Balance' LIMIT 1`,
    [proposalId]
  );
  if (existingResult.rows.length > 0) return null;

  // Fetch proposal
  const propResult = await client.query(
    `SELECT total_price, amount_paid, balance_due_date
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  if (propResult.rows.length === 0) throw new Error(`Proposal ${proposalId} not found`);

  const prop = propResult.rows[0];
  const totalCents = toCents(prop.total_price);
  const paidCents = toCents(prop.amount_paid);
  const balanceCents = Math.max(0, totalCents - paidCents);

  if (balanceCents === 0) return null;

  const invoice = await createInvoice(
    {
      proposalId,
      label: 'Balance',
      amountDueCents: balanceCents,
      status: 'sent',
      dueDate: prop.balance_due_date || null,
    },
    client
  );

  const lineItems = await generateLineItemsFromProposal(proposalId, client);
  await writeLineItems(invoice.id, lineItems, client);

  return invoice;
}

// ─── 9. createAdditionalInvoiceIfNeeded ──────────────────────────────────────

/**
 * Called after a proposal edit when locked invoices already exist.
 * Creates an "Additional Services" invoice for the price increase (if any).
 * Returns null if no locked invoices exist or the price didn't increase.
 *
 * @param {number} proposalId
 * @param {number} oldTotalCents   The total_price before the edit, in cents.
 * @param {object} [dbClient]
 * @returns {Promise<object|null>}
 */
async function createAdditionalInvoiceIfNeeded(proposalId, oldTotalCents, dbClient) {
  const client = db(dbClient);

  // Only act when locked invoices exist
  const lockedResult = await client.query(
    `SELECT id FROM invoices
      WHERE proposal_id = $1 AND locked = true AND status != 'void'
      LIMIT 1`,
    [proposalId]
  );
  if (lockedResult.rows.length === 0) return null;

  // Fetch new total
  const propResult = await client.query(
    `SELECT total_price FROM proposals WHERE id = $1`,
    [proposalId]
  );
  if (propResult.rows.length === 0) throw new Error(`Proposal ${proposalId} not found`);

  const newTotalCents = toCents(propResult.rows[0].total_price);
  const diffCents = newTotalCents - oldTotalCents;

  if (diffCents <= 0) return null;

  const invoice = await createInvoice(
    {
      proposalId,
      label: 'Additional Services',
      amountDueCents: diffCents,
      status: 'sent',
      dueDate: null,
    },
    client
  );

  // Line items for additional invoice reflect only the delta
  const lineItems = [
    {
      description: 'Additional Services',
      quantity: 1,
      unit_price: diffCents,
      line_total: diffCents,
      source_type: 'manual',
      source_id: null,
    },
  ];
  await writeLineItems(invoice.id, lineItems, client);

  return invoice;
}

// ─── 10. linkPaymentToInvoice ────────────────────────────────────────────────

/**
 * Link a proposal payment to an invoice, update the invoice's amount_paid
 * and status, and lock it if fully paid.
 *
 * @param {number} invoiceId
 * @param {number} paymentId    — proposal_payments.id
 * @param {number} amountCents
 * @param {object} dbClient     — must be a transaction client
 */
async function linkPaymentToInvoice(invoiceId, paymentId, amountCents, dbClient) {
  await dbClient.query(
    'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
    [invoiceId, paymentId, amountCents]
  );
  const invUpdate = await dbClient.query(
    'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
    [amountCents, invoiceId]
  );
  if (invUpdate.rows[0]) {
    const inv = invUpdate.rows[0];
    const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
    await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, invoiceId]);
    // Only lock when fully paid. Locking partially_paid invoices would freeze
    // them before later proposal changes (addons, balance refresh) can flow
    // through, leaving stale balances no admin can adjust.
    if (newStatus === 'paid') {
      await lockInvoice(invoiceId, dbClient);
    }
  }
}

// ─── 11. createDrinkPlanExtrasInvoice ────────────────────────────────────────

/**
 * Create a new "Drink Plan Extras" invoice for a drink-plan payment.
 *
 * Reads drink_plan.selections + proposal.pricing_snapshot/num_bars from the DB
 * and builds line items for the extras the client selected. Caller is
 * responsible for calling linkPaymentToInvoice() to record the payment.
 *
 * @param {{ proposalId:number, drinkPlanId:number, extrasAmountCents:number }} opts
 * @param {object} dbClient  — must be a transaction client
 * @returns {Promise<object>} The new invoice row.
 */
async function createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents }, dbClient) {
  const [dpRes, propRes] = await Promise.all([
    dbClient.query('SELECT selections FROM drink_plans WHERE id = $1', [drinkPlanId]),
    dbClient.query(
      'SELECT guest_count, num_bars, pricing_snapshot FROM proposals WHERE id = $1',
      [proposalId]
    ),
  ]);

  if (!dpRes.rows[0]) throw new Error(`Drink plan ${drinkPlanId} not found`);
  if (!propRes.rows[0]) throw new Error(`Proposal ${proposalId} not found`);

  const selections = dpRes.rows[0].selections || {};
  const prop = propRes.rows[0];
  const snap = prop.pricing_snapshot || {};

  const items = [];

  const addonSlugs = Object.keys(selections.addOns || {}).filter(
    slug => selections.addOns[slug]?.enabled
  );
  if (addonSlugs.length > 0) {
    const addonRows = await dbClient.query(
      'SELECT id, slug, name, rate, billing_type FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    for (const addon of addonRows.rows) {
      const rate = Number(addon.rate);
      const isPerGuest = addon.billing_type === 'per_guest';
      const qty = isPerGuest ? (prop.guest_count || 1) : 1;
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

  if (selections.logistics?.addBarRental === true) {
    const barRental = snap.bar_rental || {};
    const isAdditional = (prop.num_bars || 0) >= 1;
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
  // subtraction from extrasAmountCents) so we get an honest syrup line with
  // bottle count, not a ghost 1-cent item when no syrups were selected.
  const rawSyrups = selections.syrupSelections || {};
  const allSyrupIds = Array.isArray(rawSyrups)
    ? rawSyrups
    : [...new Set(Object.values(rawSyrups).flat())];
  const selfProvided = selections.syrupSelfProvided || [];
  const proposalSyrups = snap?.syrups?.selections || [];
  const newSyrupIds = allSyrupIds
    .filter((id) => !selfProvided.includes(id))
    .filter((id) => !proposalSyrups.includes(id));
  const syrupCost = calculateSyrupCost(newSyrupIds, prop.guest_count);
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

  // Ledger invariant: line items must sum to `amount_due` (extrasAmountCents,
  // what Stripe actually charged). Per-line rounding can drift a cent or two
  // from the intent-creation rounding in stripe.js; absorb that delta into
  // the last line so the invoice never shows a phantom balance.
  const lineSumCents = items.reduce((sum, it) => sum + it.line_total, 0);
  const driftCents = extrasAmountCents - lineSumCents;
  if (driftCents !== 0) {
    if (items.length > 0) {
      const last = items[items.length - 1];
      last.line_total += driftCents;
      if (last.quantity === 1) last.unit_price = last.line_total;
    } else {
      items.push({
        description: 'Drink Plan Extras',
        quantity: 1,
        unit_price: extrasAmountCents,
        line_total: extrasAmountCents,
        source_type: 'fee',
        source_id: null,
      });
    }
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
  await writeLineItems(invoice.id, items, dbClient);
  return invoice;
}

// ─── 12. findOpenInvoiceForBalance ───────────────────────────────────────────

/**
 * Locate the invoice that represents the proposal's outstanding balance.
 * Priority: Balance > Full Payment. Skips Drink Plan Extras, Deposit, and
 * any other bespoke-label invoices that shouldn't absorb balance payments —
 * absorbing a balance portion into a still-open Deposit invoice would flip it
 * to 'paid' (and lock it) while misrepresenting what the client actually paid.
 * If only a Deposit is open, the caller falls through to a Sentry warning so
 * an admin can reconcile the ledger manually.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @returns {Promise<{id:number, label:string}|null>}
 */
async function findOpenInvoiceForBalance(proposalId, dbClient) {
  const client = db(dbClient);
  const result = await client.query(
    `SELECT id, label
       FROM invoices
      WHERE proposal_id = $1
        AND status IN ('sent', 'partially_paid')
        AND label IN ('Balance', 'Full Payment')
      ORDER BY CASE label
                 WHEN 'Balance' THEN 1
                 WHEN 'Full Payment' THEN 2
               END,
               id ASC
      LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  formatInvoiceNumber,
  generateLineItemsFromProposal,
  writeLineItems,
  createInvoice,
  lockInvoice,
  refreshUnlockedInvoices,
  createInvoiceOnSend,
  createBalanceInvoice,
  createAdditionalInvoiceIfNeeded,
  linkPaymentToInvoice,
  createDrinkPlanExtrasInvoice,
  findOpenInvoiceForBalance,
};
