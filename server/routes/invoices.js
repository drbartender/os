'use strict';

const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager, clientAuth } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createInvoice, writeLineItems } = require('../utils/invoiceHelpers');

const router = express.Router();

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * GET /api/invoices/t/:token
 * Fetch a single invoice by its shareable token (public, rate-limited).
 * Excludes voided invoices. Returns line items and payments in parallel.
 */
router.get('/t/:token', publicLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         i.id, i.token, i.proposal_id, i.invoice_number, i.label,
         i.amount_due, i.amount_paid, i.status, i.due_date,
         i.locked, i.locked_at, i.created_at, i.updated_at,
         p.event_name, p.event_date, p.event_start_time, p.event_location,
         p.event_type, p.guest_count,
         c.name AS client_name, c.email AS client_email
       FROM invoices i
       JOIN proposals p ON p.id = i.proposal_id
       JOIN clients c ON c.id = p.client_id
       WHERE i.token = $1
         AND i.status != 'void'`,
      [req.params.token]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Invoice not found.' });
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
  } catch (err) {
    console.error('Invoice public token fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin / Manager ─────────────────────────────────────────────────────────

/**
 * GET /api/invoices/recent
 * Latest 20 non-void invoices with event and client names.
 * Must be defined BEFORE /:id to avoid param shadowing.
 */
router.get('/recent', auth, requireAdminOrManager, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         i.id, i.token, i.proposal_id, i.invoice_number, i.label,
         i.amount_due, i.amount_paid, i.status, i.due_date,
         i.locked, i.created_at,
         p.event_name,
         c.name AS client_name
       FROM invoices i
       JOIN proposals p ON p.id = i.proposal_id
       JOIN clients c ON c.id = p.client_id
       WHERE i.status != 'void'
       ORDER BY i.created_at DESC
       LIMIT 20`
    );

    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('Recent invoices fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/invoices/proposal/:proposalId
 * List all invoices for a proposal, ordered oldest → newest.
 */
router.get('/proposal/:proposalId', auth, requireAdminOrManager, async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    return res.status(400).json({ error: 'Invalid proposal ID.' });
  }

  try {
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
  } catch (err) {
    console.error('Proposal invoices fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/invoices/proposal/:proposalId
 * Create a new invoice for a proposal.
 * Body: { label, amount, due_date?, line_items? }
 * amount is in dollars (converted to cents internally).
 */
router.post('/proposal/:proposalId', auth, requireAdminOrManager, async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    return res.status(400).json({ error: 'Invalid proposal ID.' });
  }

  const { label, amount, due_date, line_items } = req.body;

  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label is required.' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }
  if (line_items !== undefined && !Array.isArray(line_items)) {
    return res.status(400).json({ error: 'line_items must be an array.' });
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
      return res.status(404).json({ error: 'Proposal not found.' });
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
    await client.query('ROLLBACK');
    console.error('Invoice create error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/invoices/:id
 * Update an invoice — allowed fields: label, due_date, status (void only).
 */
router.patch('/:id', auth, requireAdminOrManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid invoice ID.' });
  }

  const { label, due_date, status } = req.body;

  // Validate status — only 'void' is allowed via this endpoint
  if (status !== undefined && status !== 'void') {
    return res.status(400).json({ error: "Only status='void' is permitted via this endpoint." });
  }

  const setClauses = [];
  const values = [];

  if (label !== undefined) {
    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'label must be a non-empty string.' });
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
    return res.status(400).json({ error: 'No updatable fields provided.' });
  }

  values.push(id);
  const idParam = `$${values.length}`;

  try {
    // Prevent voiding an invoice that has payments applied
    if (status === 'void') {
      const paidCheck = await pool.query(
        'SELECT amount_paid FROM invoices WHERE id = $1',
        [id]
      );
      if (paidCheck.rows[0] && Number(paidCheck.rows[0].amount_paid) > 0) {
        return res.status(400).json({ error: 'Cannot void an invoice with payments applied. Refund payments first.' });
      }
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
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error('Invoice update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * GET /api/invoices/client/:proposalToken
 * List invoices for a proposal, accessible by the owning client only.
 * Returns only sent/paid/partially_paid — no drafts or voids.
 */
router.get('/client/:proposalToken', clientAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('Client invoice list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
