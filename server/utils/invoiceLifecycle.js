// Invoice creation & balance lifecycle (create/lock/refresh/on-send/balance/additional/find-open). Extracted verbatim from invoiceHelpers.js.

'use strict';

const Sentry = require('@sentry/node');
const { toCents, db } = require('./invoiceShared');
const { generateLineItemsFromProposal, writeLineItems } = require('./invoiceLineItems');
const { CONTRACT_LABELS, PARTIAL_BILL_LABELS } = require('./proposalMoneyShared');

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
 * Re-derive amount_due (and line items) for every unlocked, non-void invoice
 * on a proposal, so the open invoices are always a correct view of what the
 * client still owes.
 *
 * THE INVARIANT: Σ(amount_due − amount_paid) ≤ owed, over the open invoices,
 * where owed = total_price − amount_paid. NOT equality: a partial bill is a
 * deliberate under-bill (a Deposit asks for $100 against a $2,000 contract).
 * Over-billing is never correct.
 *
 * Each invoice therefore demands what it has ALREADY collected plus its share
 * of what is still outstanding:  amount_due = amount_paid + allocation.
 * With amount_paid = 0 (the normal case) that is just the allocation. The
 * amount_paid term is what keeps a settled invoice settled: a refund lowers
 * amount_paid and its demand together (refundHelpers), and this must not
 * independently drag amount_due below what was actually collected, which would
 * flip a paid invoice to a client-visible partially_paid phantom balance on a
 * live pay link (the RC1 defect, push review 2026-07-26).
 *
 * owed uses amount_paid, NOT the old `Σ(locked invoice amount_due)` proxy.
 * That proxy assumed every payment is backed by a locked invoice, which
 * nothing enforces: prop 51 took a $100 Stripe deposit in 2026-05 and has no
 * Deposit invoice at all, so the proxy read $0 collected and every re-price
 * re-billed the deposit (2026-07-28). external_paid is deliberately absent
 * from the expression because amount_paid already CONTAINS it (verified on
 * prop 599: paid 360 = payments 260 + external 100); subtracting it again is
 * the same double-count in the other direction.
 *
 * Partial bills (PARTIAL_BILL_LABELS) are CAPPED, never raised. Every other
 * label is a remainder bill and takes what the partials leave. The old code
 * `continue`d past every label outside Deposit/Balance/Full Payment, which
 * stranded three clients on a price DECREASE (Brandon, Cathy, Eve).
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 */
async function refreshUnlockedInvoices(proposalId, dbClient) {
  const client = db(dbClient);

  const [propResult, unlockedResult] = await Promise.all([
    client.query(
      `SELECT total_price, deposit_amount, amount_paid FROM proposals WHERE id = $1`,
      [proposalId]
    ),
    client.query(
      `SELECT id, label, amount_due, amount_paid FROM invoices
        WHERE proposal_id = $1 AND locked = false AND status != 'void'
        ORDER BY id`,
      [proposalId]
    ),
  ]);

  if (propResult.rows.length === 0) return;

  const prop = propResult.rows[0];
  const owed = Math.max(0, toCents(prop.total_price) - toCents(prop.amount_paid));
  const depositCents = toCents(prop.deposit_amount);

  const rows = unlockedResult.rows;
  const partials = rows.filter((r) => PARTIAL_BILL_LABELS.includes(r.label));
  const remainders = rows.filter((r) => !PARTIAL_BILL_LABELS.includes(r.label));

  // Allocating owed across two remainder bills has no correct answer without
  // knowing which is meant to carry the balance. Zero proposals in prod have
  // more than one open unlocked invoice (verified 2026-07-28), so refuse to
  // guess rather than invent a rule nothing can validate.
  if (remainders.length > 1) {
    console.warn(
      `[invoice-derivation] proposal ${proposalId} has ${remainders.length} remainder invoices; skipping refresh`
    );
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(`Multiple remainder invoices on proposal ${proposalId}`, {
        level: 'warning',
        tags: { area: 'invoice_derivation' },
        extra: { proposalId, labels: remainders.map((r) => r.label) },
        fingerprint: ['invoice-derivation-multi-remainder', String(proposalId)],
      });
    }
    return;
  }

  // Cap each partial against what is still unallocated, then hand the rest to
  // the single remainder bill. `intended` is the partial's full demand; the
  // allocation is what it may still ASK FOR beyond what it already collected.
  let unallocated = owed;
  const writes = [];
  for (const inv of partials) {
    const collected = Number(inv.amount_paid);
    const intended = inv.label === 'Deposit' ? depositCents : Number(inv.amount_due);
    const amountDue = Math.max(collected, Math.min(intended, collected + unallocated));
    unallocated -= (amountDue - collected);
    writes.push({ inv, amountDue });
  }
  for (const inv of remainders) {
    writes.push({ inv, amountDue: Number(inv.amount_paid) + unallocated });
    unallocated = 0;
  }

  const proposalLineItems = await generateLineItemsFromProposal(proposalId, client);

  for (const { inv, amountDue } of writes) {
    const collected = Number(inv.amount_paid);
    const changed = Number(inv.amount_due) !== amountDue;

    // A zero-due open invoice is not harmless: it presents a $0 bill on a live
    // pay link. Void it — but ONLY when nothing was ever collected against it.
    // Voiding an invoice with payments applied is what the admin PATCH route
    // refuses outright, and it would orphan the invoice_payments rows.
    // 'Drink Plan Extras' is exempt because voiding one has a comp-reconcile
    // side effect owned by voidExtrasInvoiceWithReconcile (invoiceExtras.js),
    // and reaching into that from here would be a require cycle.
    if (amountDue === 0 && collected === 0) {
      if (inv.label !== 'Drink Plan Extras') {
        await client.query(
          `UPDATE invoices SET amount_due = 0, status = 'void', updated_at = NOW() WHERE id = $1`,
          [inv.id]
        );
        // Clear the lines too: a voided invoice carrying a stale $150 breakdown
        // still renders that breakdown on the public invoice page.
        await writeLineItems(inv.id, [], client);
        continue;
      }
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage(
          `Drink Plan Extras invoice ${inv.id} derived to $0 and needs a reconciled void`,
          {
            level: 'warning',
            tags: { area: 'invoice_derivation' },
            extra: { proposalId, invoiceId: inv.id },
            fingerprint: ['invoice-derivation-zero-extras', String(inv.id)],
          }
        );
      }
    }

    await client.query(
      `UPDATE invoices SET amount_due = $1, updated_at = NOW() WHERE id = $2`,
      [amountDue, inv.id]
    );

    if (CONTRACT_LABELS.includes(inv.label)) {
      // Contract labels show the full contract breakdown against a partial
      // amount_due; that is the established shape (INV-0144 shows a $350
      // package line against a $250 balance) and is unchanged here.
      await writeLineItems(inv.id, proposalLineItems, client);
    } else if (changed) {
      // A bespoke invoice's lines are its own. Collapse to one line so they
      // sum to the new amount instead of dumping a paid-for package breakdown
      // onto it. Only on change, so an untouched extras invoice keeps the
      // itemization writeExtrasLineItems gave it.
      await writeLineItems(
        inv.id,
        [{
          description: inv.label,
          quantity: 1,
          unit_price: amountDue,
          line_total: amountDue,
          source_type: 'manual',
          source_id: null,
        }],
        client
      );
    }
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
