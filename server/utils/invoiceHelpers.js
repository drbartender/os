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
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
const { ConflictError } = require('./errors');

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
      if (last.quantity === 1) last.unit_price = last.line_total;
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
 * Reads drink_plan.selections + proposal.pricing_snapshot/num_bars from the DB
 * and builds line items via writeExtrasLineItems. Caller is responsible for
 * calling linkPaymentToInvoice() to record the payment.
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
    {
      selections,
      guestCount: prop.guest_count,
      pricingSnapshot: prop.pricing_snapshot,
      numBars: prop.num_bars,
      totalCents: extrasAmountCents,
    },
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
    { proposalId, drinkPlanId, extrasAmountCents: breakdown.totalCents },
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
  writeExtrasLineItems,
  createDrinkPlanExtrasInvoice,
  findExtrasInvoice,
  findOrRefreshExtrasInvoice,
  voidExtrasInvoiceWithReconcile,
  findOpenInvoiceForBalance,
};
