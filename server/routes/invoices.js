'use strict';

const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager, clientAuth } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createInvoice, writeLineItems } = require('../utils/invoiceHelpers');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const [lineItemsRes, paymentsRes] = await Promise.all([
    pool.query(
      `SELECT id, description, quantity, unit_price, line_total, source_type
         FROM invoice_line_items
        WHERE invoice_id = $1
        ORDER BY id`,
      [invoice.id]
    ),
    pool.query(
      `SELECT ip.id, ip.amount, ip.created_at,
              pp.payment_type, pp.status AS payment_status
         FROM invoice_payments ip
         JOIN proposal_payments pp ON pp.id = ip.payment_id
        WHERE ip.invoice_id = $1
        ORDER BY ip.created_at`,
      [invoice.id]
    ),
  ]);

  res.json({
    invoice: {
      ...invoice,
      line_items: lineItemsRes.rows,
      payments: paymentsRes.rows,
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

  // Fetch existing invoice for state checks (locked, amount_paid)
  const existing = await pool.query(
    'SELECT locked, amount_paid FROM invoices WHERE id = $1',
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

  // Prevent voiding an invoice that has payments applied
  if (status === 'void' && Number(existing.rows[0].amount_paid) > 0) {
    throw new ConflictError(
      'Cannot void an invoice with payments applied. Refund payments first.',
      'INVOICE_HAS_PAYMENTS'
    );
  }

  const result = await pool.query(
    `UPDATE invoices
        SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = ${idParam}
      RETURNING id, token, proposal_id, invoice_number, label,
                amount_due, amount_paid, status, due_date,
                locked, locked_at, created_at, updated_at`,
    values
  );

  if (!result.rows[0]) {
    throw new NotFoundError('Invoice not found.');
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
