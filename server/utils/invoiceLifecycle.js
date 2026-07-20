// Invoice creation & balance lifecycle (create/lock/refresh/on-send/balance/additional/find-open). Extracted verbatim from invoiceHelpers.js.

'use strict';

const { toCents, db } = require('./invoiceShared');
const { generateLineItemsFromProposal, writeLineItems } = require('./invoiceLineItems');
const { OFF_LEDGER_INVOICE_LABELS } = require('./proposalMoneyShared');

// The invoice-label literals written below ('Deposit' / 'Balance' /
// 'Full Payment') are the origin of the contract-total classification. The
// shared CONTRACT_LABELS constant (./proposalMoneyShared, consumed by
// payrollAccrual + refundHelpers) mirrors this exact set — keep them in sync.

// ─── 1. formatInvoiceNumber ──────────────────────────────────────────────────

/**
 * Format a raw sequence value into a human-readable invoice number.
 * @param {number} seqVal
 * @returns {string}  e.g. "INV-0001"
 */
function formatInvoiceNumber(seqVal) {
  return 'INV-' + String(seqVal).padStart(4, '0');
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
 *   - "Full Payment"  → (total_price − external_paid) in cents
 *   - "Balance"       → (total_price − external_paid − sum(locked invoice amount_due)) in cents
 *
 * external_paid (cc-transfer, 2026-07-07) is money collected off-platform in
 * CheckCherry, folded into amount_paid with NO payment rows and NO locked
 * invoice backing it — the locked-invoice subtraction alone cannot see it.
 * Netting it here keeps a refreshed Balance / Full Payment invoice from
 * re-billing money the client already paid. Zero behavior change when
 * external_paid = 0 (every non-transferred proposal).
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 */
async function refreshUnlockedInvoices(proposalId, dbClient) {
  const client = db(dbClient);

  // Fetch proposal financials, locked total, and unlocked invoices in parallel
  const [propResult, lockedResult, unlockedResult] = await Promise.all([
    client.query(
      `SELECT total_price, deposit_amount, external_paid FROM proposals WHERE id = $1`,
      [proposalId]
    ),
    client.query(
      // Off-ledger labels are excluded: their amounts have no total_price
      // entry, so counting a locked one here would shrink the Balance invoice
      // by money the contract never contained (2026-07-20). COALESCE keeps a
      // NULL-label invoice counted (NULL = ANY(...) is NULL, and NOT NULL
      // would silently drop the row); the set is currently empty (lab money
      // folds into the contract since the same day), making this a no-op.
      `SELECT COALESCE(SUM(amount_due), 0) AS locked_total
         FROM invoices
        WHERE proposal_id = $1 AND locked = true AND status != 'void'
          AND NOT (COALESCE(label, '') = ANY($2::text[]))`,
      [proposalId, OFF_LEDGER_INVOICE_LABELS]
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
  const externalCents = toCents(prop.external_paid);
  const lockedTotal = Number(lockedResult.rows[0].locked_total);

  // Fresh line items (shared across all unlocked invoices for this proposal)
  const lineItems = await generateLineItemsFromProposal(proposalId, client);

  for (const invoice of unlockedResult.rows) {
    let amountDue;

    if (invoice.label === 'Deposit') {
      amountDue = depositCents;
    } else if (invoice.label === 'Full Payment') {
      amountDue = Math.max(0, totalCents - externalCents);
    } else if (invoice.label === 'Balance') {
      amountDue = Math.max(0, totalCents - externalCents - lockedTotal);
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

  // Idempotency check. Void invoices are excluded: an archived proposal's
  // invoice gets voided (option-group losers, admin archive), and a recovered
  // (archived -> draft -> sent) proposal must mint a FRESH open invoice on
  // re-send, or its later payment has nothing to link to.
  const existingResult = await client.query(
    `SELECT id FROM invoices WHERE proposal_id = $1 AND status <> 'void' LIMIT 1`,
    [proposalId]
  );
  if (existingResult.rows.length > 0) return null;

  // Fetch proposal
  const propResult = await client.query(
    `SELECT total_price, deposit_amount, payment_type, balance_due_date, external_paid
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  if (propResult.rows.length === 0) throw new Error(`Proposal ${proposalId} not found`);

  const prop = propResult.rows[0];
  const isDeposit = prop.payment_type === 'deposit';
  const label = isDeposit ? 'Deposit' : 'Full Payment';
  // Net off-platform money (cc-transfer external_paid, folded into amount_paid
  // with no payment/invoice rows) so a Full Payment invoice bills the true
  // remainder — matching refreshUnlockedInvoices. Guaranteed no-op for native
  // proposals (external_paid defaults 0); only a contrived archive->draft->sent
  // recovery of a transferred event reaches this at all, but keep the two
  // invoice-creation paths consistent so neither can re-bill collected money.
  const amountDueCents = isDeposit
    ? toCents(prop.deposit_amount)
    : Math.max(0, toCents(prop.total_price) - toCents(prop.external_paid));
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
 * Called after a proposal edit when locked invoices already exist. Every caller
 * runs refreshUnlockedInvoices() FIRST, which re-bills a price increase into any
 * unlocked Balance/Full Payment invoice. So this mints an "Additional Services"
 * invoice ONLY when the delta cannot be absorbed that way — i.e. every
 * balance-bearing invoice is locked (the fully-paid case).
 * Returns null if: no locked invoices exist; OR an unlocked Balance/Full Payment
 * invoice already absorbed the delta (else it would double-bill); OR the price
 * didn't increase.
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

  // Do NOT mint an Additional Services invoice when an unlocked balance-bearing
  // invoice (Balance / Full Payment) still exists: every caller runs
  // refreshUnlockedInvoices() first, which rebuilds that invoice from the NEW
  // total_price and so already absorbs the price increase. Adding a separate
  // Additional Services invoice on top would bill the same delta twice — the
  // deposit_paid re-price case (locked Deposit + unlocked Balance), which hit
  // both the admin re-price (crud.js) and the drink-plan submit (F2) paths. The
  // additional invoice is the right surface ONLY when the delta cannot be
  // re-billed through an unlocked invoice — i.e. every balance-bearing invoice is
  // locked (the fully-paid case). ('Deposit' is a fixed amount that never absorbs
  // the delta in refreshUnlockedInvoices, so it correctly does not count here.)
  const absorbing = await client.query(
    `SELECT id FROM invoices
      WHERE proposal_id = $1 AND locked = false AND status != 'void'
        AND label IN ('Balance', 'Full Payment')
      LIMIT 1`,
    [proposalId]
  );
  if (absorbing.rows.length > 0) return null;

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

module.exports = {
  formatInvoiceNumber,
  createInvoice,
  lockInvoice,
  refreshUnlockedInvoices,
  createInvoiceOnSend,
  createBalanceInvoice,
  createAdditionalInvoiceIfNeeded,
  findOpenInvoiceForBalance,
};
