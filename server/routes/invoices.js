'use strict';

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth, requireAdminOrManager, clientAuth } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createInvoice, writeLineItems, voidExtrasInvoiceWithReconcile } = require('../utils/invoiceHelpers');
const { cancelOpenInvoiceIntents } = require('../utils/invoiceVoid');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { OFF_LEDGER_INVOICE_LABELS } = require('../utils/proposalMoneyShared');
const { renderExtensionTerms } = require('../data/extensionTermsCopy');

const router = express.Router();

const { UUID_RE } = require('../utils/tokens');

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * GET /api/invoices/t/:token
 * Fetch a single invoice by its shareable token (public, rate-limited).
 * Excludes voided invoices. Returns line items and payments in parallel.
 */
router.get('/t/:token', publicLimiter, asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.token)) {
    throw new NotFoundError('This invoice is no longer available');
  }
  const result = await pool.query(
    `SELECT
       i.id, i.token, i.proposal_id, i.invoice_number, i.label,
       i.amount_due, i.amount_paid, i.status, i.due_date,
       i.locked, i.locked_at, i.created_at, i.updated_at,
       p.event_date, p.event_start_time, p.event_location,
       p.event_type, p.event_type_custom, p.guest_count,
       c.name AS client_name, c.email AS client_email
     FROM invoices i
     JOIN proposals p ON p.id = i.proposal_id
     JOIN clients c ON c.id = p.client_id
     WHERE i.token = $1
       AND i.status != 'void'`,
    [req.params.token]
  );

  if (!result.rows[0]) {
    throw new NotFoundError('This invoice is no longer available');
  }

  const invoice = result.rows[0];

  // Parallel fetch line items and payments
  const [lineItemsRes, paymentsRes, refundsRes, extRes] = await Promise.all([
    pool.query(
      `SELECT id, description, quantity::float8 AS quantity, unit_price, line_total, source_type
         FROM invoice_line_items
        WHERE invoice_id = $1
        ORDER BY id`,
      [invoice.id]
    ),
    // Public payments list. EXCLUDE negative refund-reversal rows: reconciliation
    // writes a negative invoice_payments row per refund (refundHelpers) to keep
    // Σ amount == amount_paid, but that same refund already surfaces in the
    // `refunds` array below. Including the negative row here double-counts a
    // refund as both a -$X payment record AND a $X refunded line on InvoicePage.
    // Positive payment links are unaffected. Public token route only; the admin
    // endpoints do not select payments, so nothing else changes.
    pool.query(
      `SELECT ip.id, ip.amount, ip.created_at,
              pp.payment_type, pp.status AS payment_status
         FROM invoice_payments ip
         JOIN proposal_payments pp ON pp.id = ip.payment_id
        WHERE ip.invoice_id = $1
          AND ip.amount >= 0
        ORDER BY ip.created_at`,
      [invoice.id]
    ),
    // Refunds attributable to THIS invoice: a refund links to a payment
    // (proposal_refunds.payment_id), and a payment links to an invoice
    // (invoice_payments.payment_id), so a succeeded refund shows on the invoice
    // its payment funded. amount is CENTS. Informational only — the invoice's
    // amount_paid/status are unchanged (a refund is money returned, not re-owed).
    // pr.reason is deliberately NOT selected: it is admin free-text (often an
    // internal note) and this is a public token route — clients see amount + date only.
    //
    // Combined-payment attribution: a drink_plan_with_balance payment funds TWO
    // invoices, but pr.amount is the refund against the whole payment — displayed
    // raw it over-states on both. Two regimes, per refund:
    //  1. ATTRIBUTED (post-upgrade): reconciliation stamps each negative
    //     reversal row with its refund_id, so this invoice's exact share is
    //     -SUM of THIS refund's reversal rows here. A partial refund that
    //     walked onto the other invoice only shows nothing here (no phantom).
    //  2. LEGACY fallback (pre-upgrade refunds, no stamped rows anywhere):
    //     the F3 clamp — LEAST(pr.amount, GROSS positive applied). Gross,
    //     because the unstamped negative reversals would net toward 0 and
    //     hide the very refund being displayed.
    // One output row per refund by construction (aggregate lateral, no fan-out).
    // COUPLING: the EXISTS regime probe is whole-table by refund_id while the
    // SUM is scoped by ip.payment_id = pr.payment_id. Reconciliation always
    // writes reversal rows under the refund's own payment_id, keeping the two
    // aligned; if a refactor ever lets them diverge, a stamped refund would
    // hide instead of falling back to the clamp. Do NOT scope the EXISTS to
    // this invoice (that re-phantoms a refund walked onto the other invoice).
    pool.query(
      `SELECT pr.id, d.display_cents AS amount, pr.created_at
         FROM proposal_refunds pr
         JOIN LATERAL (
           SELECT CASE
                    WHEN EXISTS (SELECT 1 FROM invoice_payments x WHERE x.refund_id = pr.id)
                    THEN COALESCE(-SUM(ip.amount) FILTER (WHERE ip.refund_id = pr.id), 0)
                    ELSE LEAST(pr.amount, COALESCE(SUM(ip.amount) FILTER (WHERE ip.amount > 0), 0))
                  END::int AS display_cents
             FROM invoice_payments ip
            WHERE ip.payment_id = pr.payment_id AND ip.invoice_id = $1
         ) d ON d.display_cents > 0
        WHERE pr.status = 'succeeded'
        ORDER BY pr.created_at`,
      [invoice.id]
    ),
    // Service-extension source row. Non-null ONLY when a service_extensions
    // row references this invoice, so ordinary Deposit/Balance invoices
    // (including links already in client inboxes) see no change at all. Rides
    // the parallel fetch: it depends only on invoice.id, and this GET is every
    // client's invoice page load, so a serial await here would tax all of
    // them. Drives the terms gate on InvoicePage: pay stays disabled until
    // accepted_at is set.
    pool.query(
      `SELECT id, status, amount_cents, terms_version, client_accepted_at,
              contracted_end_time, requested_end_time, expires_at
         FROM service_extensions
        WHERE invoice_id = $1
        ORDER BY id DESC LIMIT 1`,
      [invoice.id]
    ),
  ]);
  let extension = null;
  if (extRes.rows[0]) {
    const e = extRes.rows[0];
    // renderExtensionTerms throws on an unknown version rather than showing copy
    // the client never agreed to. Fall back to no terms block (which leaves pay
    // disabled) instead of 500-ing a client's payment page.
    let terms = null;
    try {
      terms = renderExtensionTerms({ version: e.terms_version, newEndDisplay: e.requested_end_time });
    } catch (copyErr) {
      console.error('[invoices] unknown extension terms version', e.terms_version, copyErr.message);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(copyErr, { tags: { feature: 'service-extension', step: 'terms_render' } });
      }
    }
    extension = {
      is_extension: true,
      status: e.status,
      terms,
      accepted_at: e.client_accepted_at,
      expires_at: e.expires_at,
      contracted_end_time: e.contracted_end_time,
      requested_end_time: e.requested_end_time,
      requires_payment: Number(e.amount_cents) > 0,
      requires_acceptance: !e.client_accepted_at,
    };
  }

  // `extension` lives INSIDE the invoice object: InvoicePage stores data.invoice
  // and nothing else, so a top-level sibling would never render (the exact
  // server/client shape mismatch Task 8 pins with a regression test).
  res.json({
    invoice: {
      ...invoice,
      line_items: lineItemsRes.rows,
      payments: paymentsRes.rows,
      refunds: refundsRes.rows,
      extension,
    },
  });
}));

// ─── Admin / Manager ─────────────────────────────────────────────────────────

/**
 * GET /api/invoices/recent
 * Latest 20 non-void invoices with event and client names.
 * Must be defined BEFORE /:id to avoid param shadowing.
 */
router.get('/recent', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT
       i.id, i.token, i.proposal_id, i.invoice_number, i.label,
       i.amount_due, i.amount_paid, i.status, i.due_date,
       i.locked, i.created_at,
       p.event_type, p.event_type_custom,
       c.name AS client_name
     FROM invoices i
     JOIN proposals p ON p.id = i.proposal_id
     JOIN clients c ON c.id = p.client_id
     WHERE i.status != 'void'
     ORDER BY i.created_at DESC
     LIMIT 20`
  );

  res.json({ invoices: result.rows });
}));

/**
 * GET /api/invoices/proposal/:proposalId
 * List all invoices for a proposal, ordered oldest → newest.
 */
router.get('/proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    throw new ValidationError({ proposalId: 'Invalid proposal ID.' });
  }

  const result = await pool.query(
    `SELECT
       id, token, proposal_id, invoice_number, label,
       amount_due, amount_paid, status, due_date,
       locked, locked_at, created_at, updated_at
     FROM invoices
     WHERE proposal_id = $1
     ORDER BY created_at ASC`,
    [proposalId]
  );

  res.json({ invoices: result.rows });
}));

/**
 * POST /api/invoices/proposal/:proposalId
 * Create a new invoice for a proposal.
 * Body: { label, amount, due_date?, line_items? }
 * amount is in dollars (converted to cents internally).
 */
router.post('/proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    throw new ValidationError({ proposalId: 'Invalid proposal ID.' });
  }

  const { label, amount, due_date, line_items } = req.body;

  const fieldErrors = {};
  if (!label || typeof label !== 'string' || !label.trim()) {
    fieldErrors.label = 'Label is required.';
  } else if (OFF_LEDGER_INVOICE_LABELS.includes(label.trim())) {
    // Off-ledger labels (currently 'Service Extension') are minted ONLY by the
    // extension request route. The webhook keys its amount_paid roll-up skip on
    // the label alone (paymentIntentSucceeded.js), so an admin minting an
    // invoice INTO this label would silently take its money off-ledger.
    fieldErrors.label = 'This label is reserved for system-generated invoices. Pick a different label.';
  }
  if (typeof amount !== 'number' || amount <= 0) {
    fieldErrors.amount = 'Amount must be a positive number.';
  }
  if (line_items !== undefined && !Array.isArray(line_items)) {
    fieldErrors.line_items = 'line_items must be an array.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify proposal exists
    const propCheck = await client.query(
      'SELECT id FROM proposals WHERE id = $1',
      [proposalId]
    );
    if (!propCheck.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Proposal not found.');
    }

    // Convert dollars → cents
    const amountDueCents = Math.round(amount * 100);

    const invoice = await createInvoice(
      {
        proposalId,
        label: label.trim(),
        amountDueCents,
        status: 'draft',
        dueDate: due_date || null,
      },
      client
    );

    // Build line items: use provided array or fall back to a single line from label+amount
    let items;
    if (Array.isArray(line_items) && line_items.length > 0) {
      items = line_items.map((li) => {
        const qty = Number(li.quantity) > 0 ? Math.round(Number(li.quantity)) : 1;
        const unitPrice = Math.round(Number(li.amount || 0) * 100);
        return {
          description: String(li.description || '').trim() || label.trim(),
          quantity: qty,
          unit_price: unitPrice,
          line_total: unitPrice * qty,
          source_type: 'manual',
          source_id: null,
        };
      });
    } else {
      items = [
        {
          description: label.trim(),
          quantity: 1,
          unit_price: amountDueCents,
          line_total: amountDueCents,
          source_type: 'manual',
          source_id: null,
        },
      ];
    }

    await writeLineItems(invoice.id, items, client);

    await client.query('COMMIT');

    res.status(201).json({ invoice });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * PATCH /api/invoices/:id
 * Update an invoice — allowed fields: label, due_date, status (void only).
 * Locked invoices cannot have label or due_date changed.
 */
router.patch('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError({ id: 'Invalid invoice ID.' });
  }

  const { label, due_date, status } = req.body;

  // Validate status — only 'void' is allowed via this endpoint
  if (status !== undefined && status !== 'void') {
    throw new ValidationError({ status: "Only status='void' is permitted via this endpoint." });
  }

  const setClauses = [];
  const values = [];

  if (label !== undefined) {
    if (typeof label !== 'string' || !label.trim()) {
      throw new ValidationError({ label: 'Label must be a non-empty string.' });
    }
    if (OFF_LEDGER_INVOICE_LABELS.includes(label.trim())) {
      // Same guard as the create route: renaming an ordinary invoice INTO an
      // off-ledger label would silently take its money off-ledger (the webhook
      // keys the amount_paid roll-up skip on the label alone).
      throw new ValidationError({ label: 'This label is reserved for system-generated invoices. Pick a different label.' });
    }
    values.push(label.trim());
    setClauses.push(`label = $${values.length}`);
  }

  if (due_date !== undefined) {
    values.push(due_date || null);
    setClauses.push(`due_date = $${values.length}`);
  }

  if (status !== undefined) {
    values.push(status);
    setClauses.push(`status = $${values.length}`);
  }

  if (setClauses.length === 0) {
    throw new ValidationError({ _form: 'No updatable fields provided.' });
  }

  values.push(id);
  const idParam = `$${values.length}`;

  // Fetch existing invoice for state checks (locked, amount_paid) + label so a
  // "Drink Plan Extras" void can route through the comp reconcile helper.
  const existing = await pool.query(
    'SELECT locked, amount_paid, label, proposal_id FROM invoices WHERE id = $1',
    [id]
  );
  if (!existing.rows[0]) {
    throw new NotFoundError('Invoice not found.');
  }

  // Block metadata edits (label, due_date) on locked invoices.
  // status='void' is gated separately by the amount_paid check below.
  const editingMetadata = label !== undefined || due_date !== undefined;
  if (editingMetadata && existing.rows[0].locked) {
    throw new ConflictError('This invoice is locked and cannot be edited', 'INVOICE_LOCKED');
  }

  // Symmetric half of the off-ledger guard (merge-gate finding, 2026-08-03):
  // renaming an invoice OUT of an off-ledger label is as dangerous as renaming
  // one in. The webhook keys its amount_paid roll-up SKIP on the label alone
  // while the extension settle keys on invoice_id, so a renamed extension
  // invoice that then gets paid would roll side money INTO amount_paid AND
  // still settle the extension: contract money counted twice.
  if (label !== undefined && OFF_LEDGER_INVOICE_LABELS.includes(existing.rows[0].label)) {
    throw new ConflictError(
      'This is a system-generated off-ledger invoice; its label cannot be changed.',
      'OFF_LEDGER_LABEL_LOCKED'
    );
  }

  // Prevent voiding an invoice that has payments applied
  if (status === 'void' && Number(existing.rows[0].amount_paid) > 0) {
    throw new ConflictError(
      'Cannot void an invoice with payments applied. Refund payments first.',
      'INVOICE_HAS_PAYMENTS'
    );
  }

  // Comp/waive of a "Drink Plan Extras" invoice: void + audit + total_price
  // reconcile, atomically, via the shared helper (also used by submit's
  // void-before-refresh so the void/audit/reconcile logic never drifts).
  if (status === 'void' && existing.rows[0].label === 'Drink Plan Extras') {
    const client = await pool.connect();
    let voidedRow;
    try {
      await client.query('BEGIN');
      // Re-check under the row lock (seam-sweep I4): the pre-tx amount_paid
      // read is stale, and a webhook can link a payment between that read and
      // this transaction. Never void an invoice that has money on it.
      const { rows: [locked] } = await client.query(
        'SELECT amount_paid, status FROM invoices WHERE id = $1 FOR UPDATE', [id]
      );
      if (!locked) throw new NotFoundError('Invoice not found.');
      if (Number(locked.amount_paid) > 0) {
        throw new ConflictError(
          'Cannot void an invoice with payments applied. Refund payments first.',
          'INVOICE_HAS_PAYMENTS'
        );
      }
      if (locked.status !== 'void') {
        // reconcile_total expresses the CALLER'S INTENT and has no safe default.
        //   true  (comp/waive) — the add-on is being given away, so subtract it
        //                        from total_price. This is what the comp route
        //                        has always meant, so it stays the default for
        //                        any caller that does not say.
        //   false (correction) — the invoice is a stale or duplicate demand and
        //                        the contract is right as it stands.
        // Getting this backwards on a PAID-IN-FULL proposal invents an
        // overpayment: prod 527 is settled at $370/$370 with a stale $20 extras
        // invoice, and comping it would drop total_price to $350 against $370
        // collected. The admin Void button therefore sends false explicitly and
        // says so in its confirm copy (2026-07-28 push review).
        const reconcileTotalPrice = req.body.reconcile_total !== false;
        await voidExtrasInvoiceWithReconcile(id, req.user.id, client, { reconcileTotalPrice });
      }
      const voided = await client.query(
        `SELECT id, token, proposal_id, invoice_number, label,
                amount_due, amount_paid, status, due_date,
                locked, locked_at, created_at, updated_at
           FROM invoices WHERE id = $1`,
        [id]
      );
      await client.query('COMMIT');
      voidedRow = voided.rows[0];
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow rollback noise */ }
      throw err;
    } finally {
      client.release();
    }
    // Post-commit, best-effort, AFTER the pool client is released (Stripe
    // network calls must not hold a DB connection): cancel any open checkout
    // PaymentIntents so a client with the pay page already open cannot be
    // charged for the just-voided invoice (seam-sweep M2). Never blocks.
    await cancelOpenInvoiceIntents(existing.rows[0].proposal_id, id);
    return res.json({ invoice: voidedRow });
  }

  // When voiding, the UPDATE predicate re-checks payability atomically
  // (seam-sweep I4): the pre-read amount_paid is stale, and a webhook can link
  // a payment between the read and this UPDATE. A void request that loses that
  // race matches zero rows and 409s instead of voiding a paid invoice.
  const voidGuard = status === 'void'
    ? ` AND amount_paid = 0 AND status IN ('draft', 'sent', 'partially_paid')`
    : '';
  const result = await pool.query(
    `UPDATE invoices
        SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = ${idParam}${voidGuard}
      RETURNING id, token, proposal_id, invoice_number, label,
                amount_due, amount_paid, status, due_date,
                locked, locked_at, created_at, updated_at`,
    values
  );

  if (!result.rows[0]) {
    const { rows: [current] } = await pool.query(
      `SELECT id, token, proposal_id, invoice_number, label,
              amount_due, amount_paid, status, due_date,
              locked, locked_at, created_at, updated_at
         FROM invoices WHERE id = $1`,
      [id]
    );
    if (!current) throw new NotFoundError('Invoice not found.');
    // Idempotent re-void: already void is a success, not a conflict.
    if (status === 'void' && current.status === 'void') {
      return res.json({ invoice: current });
    }
    throw new ConflictError(
      'Cannot void an invoice with payments applied. Refund payments first.',
      'INVOICE_HAS_PAYMENTS'
    );
  }

  // Post-commit, best-effort PI cancellation on void (seam-sweep M2); see the
  // extras path above for rationale.
  if (status === 'void') {
    await cancelOpenInvoiceIntents(result.rows[0].proposal_id, id);
  }

  res.json({ invoice: result.rows[0] });
}));

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * GET /api/invoices/client/:proposalToken
 * List invoices for a proposal, accessible by the owning client only.
 * Returns only sent/paid/partially_paid — no drafts or voids.
 */
router.get('/client/:proposalToken', clientAuth, asyncHandler(async (req, res) => {
  // proposals.token is UUID; a non-UUID param casts-and-throws (Postgres 22P02) -> 500.
  // Reject it up front and return the empty list this route already contracts on (the
  // public /t/:token route guards the same way).
  if (!UUID_RE.test(req.params.proposalToken)) {
    return res.json({ invoices: [] });
  }
  const result = await pool.query(
    `SELECT
       i.id, i.token, i.proposal_id, i.invoice_number, i.label,
       i.amount_due, i.amount_paid, i.status, i.due_date,
       i.locked, i.created_at, i.updated_at
     FROM invoices i
     JOIN proposals p ON p.id = i.proposal_id
     WHERE p.token = $1
       AND p.client_id = $2
       AND i.status IN ('sent', 'paid', 'partially_paid')
     ORDER BY i.created_at ASC`,
    [req.params.proposalToken, req.user.id]
  );

  res.json({ invoices: result.rows });
}));

module.exports = router;
