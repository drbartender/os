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
  if (snap.package && snap.package.base_total !== null && snap.package.base_total !== undefined) {
    const unitPrice = toCents(snap.package.base_total);
    items.push({
      description: snap.package.name || proposal.package_name || 'Service Package',
      quantity: 1,
      unit_price: unitPrice,
      line_total: unitPrice,
      source_type: 'package',
      source_id: proposal.package_id || null,
    });
  }

  // Extra bartenders
  if (snap.staffing && snap.staffing.extra_bartender_cost > 0) {
    const extra = snap.staffing.actual - snap.staffing.included;
    const qty = extra > 0 ? extra : 1;
    const lineTotal = toCents(snap.staffing.extra_bartender_cost);
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

  // Add-ons from proposal_addons table (authoritative at booking time)
  const addonsResult = await client.query(
    `SELECT id, addon_id, addon_name, billing_type, rate, quantity, line_total
       FROM proposal_addons
      WHERE proposal_id = $1
      ORDER BY id`,
    [proposalId]
  );

  for (const addon of addonsResult.rows) {
    const qty = Number(addon.quantity) || 1;
    const unitPrice = toCents(addon.rate);
    const lineTotal = toCents(addon.line_total);
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

  for (const item of items) {
    await client.query(
      `INSERT INTO invoice_line_items
         (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        invoiceId,
        item.description,
        item.quantity,
        item.unit_price,
        item.line_total,
        item.source_type,
        item.source_id,
      ]
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

  // Fetch current proposal financials
  const propResult = await client.query(
    `SELECT total_price, deposit_amount FROM proposals WHERE id = $1`,
    [proposalId]
  );
  if (propResult.rows.length === 0) return;

  const prop = propResult.rows[0];
  const totalCents = toCents(prop.total_price);
  const depositCents = toCents(prop.deposit_amount);

  // Sum of all locked invoices for this proposal
  const lockedResult = await client.query(
    `SELECT COALESCE(SUM(amount_due), 0) AS locked_total
       FROM invoices
      WHERE proposal_id = $1 AND locked = true AND status != 'void'`,
    [proposalId]
  );
  const lockedTotal = Number(lockedResult.rows[0].locked_total);

  // Fetch unlocked, non-void invoices
  const unlockedResult = await client.query(
    `SELECT id, label FROM invoices
      WHERE proposal_id = $1 AND locked = false AND status != 'void'
      ORDER BY id`,
    [proposalId]
  );

  // Fresh line items (shared across all unlocked invoices for this proposal)
  const lineItems = await generateLineItemsFromProposal(proposalId, client);

  for (const invoice of unlockedResult.rows) {
    let amountDue;

    if (invoice.label === 'Deposit') {
      amountDue = depositCents;
    } else if (invoice.label === 'Full Payment') {
      amountDue = totalCents;
    } else {
      // "Balance" or any other label → remainder after locked invoices
      amountDue = Math.max(0, totalCents - lockedTotal);
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
};
