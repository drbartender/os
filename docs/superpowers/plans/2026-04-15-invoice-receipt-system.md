# Invoice/Receipt System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an invoice system on top of the existing proposal/payment infrastructure with shareable token-gated invoice pages, PDF generation, Stripe payment integration, and admin/client invoice dropdowns.

**Architecture:** New `invoices`, `invoice_line_items`, and `invoice_payments` tables sit on top of existing proposal/payment tables. Invoices auto-generate at lifecycle events (proposal sent, deposit paid, items added after payment) and lock on first payment. A new `server/routes/invoices.js` handles CRUD + public token access. A reusable `InvoiceDropdown` React component integrates into ProposalDetail (admin) and ClientDashboard. A new `/invoice/:token` public page renders the invoice with Stripe payment and html2pdf.js PDF export.

**Tech Stack:** Express routes, raw SQL (pg), Stripe PaymentIntents, React 18, html2pdf.js, vanilla CSS

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `server/routes/invoices.js` | Invoice CRUD, public token fetch, admin list, manual creation |
| `server/utils/invoiceHelpers.js` | Shared helpers: generate line items from proposal, lock invoice, create auto-invoices |
| `client/src/pages/invoice/InvoicePage.js` | Public token-gated invoice view + Stripe payment + PDF |
| `client/src/components/InvoiceDropdown.js` | Reusable dropdown showing invoices for a proposal (admin + client) |

### Modified Files
| File | What Changes |
|---|---|
| `server/db/schema.sql` | Add `invoices`, `invoice_line_items`, `invoice_payments` tables + sequence + indexes |
| `server/index.js` | Mount `/api/invoices` route |
| `server/routes/stripe.js` | Add `create-intent-for-invoice/:token` endpoint; update webhook to link payments to invoices |
| `server/routes/proposals.js` | Trigger invoice auto-generation on status→sent; regenerate unlocked invoices on PATCH; link record-payment to invoices |
| `server/routes/clientPortal.js` | Add `GET /invoices/:proposalToken` endpoint |
| `client/src/App.js` | Add `/invoice/:token` route to all domain contexts |
| `client/src/pages/admin/ProposalDetail.js` | Import and render InvoiceDropdown + manual create modal |
| `client/src/pages/admin/FinancialsDashboard.js` | Make Recent Payments rows clickable → link to invoice |
| `client/src/pages/public/ClientDashboard.js` | Import and render InvoiceDropdown on proposal cards |

---

## Task 1: Database Schema

**Files:**
- Modify: `server/db/schema.sql` (append after line 1373)

- [ ] **Step 1: Add the invoice_number_seq sequence and invoices table**

Append to the end of `server/db/schema.sql`:

```sql
-- ─── Invoice System ─────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(20) NOT NULL,
  label VARCHAR(100) NOT NULL DEFAULT 'Invoice',
  amount_due INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'paid', 'partially_paid', 'void')),
  locked BOOLEAN NOT NULL DEFAULT false,
  locked_at TIMESTAMPTZ,
  due_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_proposal_id ON invoices(proposal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_token ON invoices(token);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

DROP TRIGGER IF EXISTS update_invoices_updated_at ON invoices;
CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

- [ ] **Step 2: Add invoice_line_items table**

Append:

```sql
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  source_type VARCHAR(20) DEFAULT 'manual'
    CHECK (source_type IN ('package', 'addon', 'fee', 'manual')),
  source_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id ON invoice_line_items(invoice_id);
```

- [ ] **Step 3: Add invoice_payments junction table**

Append:

```sql
CREATE TABLE IF NOT EXISTS invoice_payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES proposal_payments(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_id ON invoice_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_payment_id ON invoice_payments(payment_id);
```

- [ ] **Step 4: Verify schema applies cleanly**

Run: `node -e "require('./server/db').initDb().then(() => { console.log('Schema OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"`

Expected: "Schema OK" with no errors.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(invoices): add invoices, invoice_line_items, invoice_payments tables + sequence"
```

---

## Task 2: Invoice Helper Utilities

**Files:**
- Create: `server/utils/invoiceHelpers.js`

- [ ] **Step 1: Create the invoiceHelpers module with formatInvoiceNumber and generateLineItemsFromProposal**

Create `server/utils/invoiceHelpers.js`:

```js
const { pool } = require('../db');

/**
 * Format a sequence number as INV-0001, INV-0042, etc.
 */
function formatInvoiceNumber(seqVal) {
  return 'INV-' + String(seqVal).padStart(4, '0');
}

/**
 * Build invoice line items from a proposal's current state.
 * Returns an array of { description, quantity, unit_price, line_total, source_type, source_id }.
 * All money values in cents.
 */
async function generateLineItemsFromProposal(proposalId, dbClient) {
  const client = dbClient || pool;

  // Fetch proposal with package info
  const propRes = await client.query(`
    SELECT p.pricing_snapshot, p.total_price, p.event_duration_hours, p.guest_count,
           p.num_bars, p.num_bartenders,
           sp.name AS package_name
    FROM proposals p
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    WHERE p.id = $1
  `, [proposalId]);

  if (!propRes.rows[0]) return [];
  const prop = propRes.rows[0];
  const snapshot = prop.pricing_snapshot || {};
  const items = [];

  // Package base line item
  if (snapshot.package) {
    const pkgTotal = Math.round(Number(snapshot.package.base_total || 0) * 100);
    items.push({
      description: `${prop.package_name || 'Service Package'} (${prop.event_duration_hours} hrs)`,
      quantity: 1,
      unit_price: pkgTotal,
      line_total: pkgTotal,
      source_type: 'package',
      source_id: null,
    });
  }

  // Extra bartender line item (if applicable)
  if (snapshot.staffing?.extra_bartender_cost && Number(snapshot.staffing.extra_bartender_cost) > 0) {
    const extraCost = Math.round(Number(snapshot.staffing.extra_bartender_cost) * 100);
    const extraCount = (snapshot.staffing.actual || 1) - (snapshot.staffing.included || 1);
    items.push({
      description: `Extra Bartender${extraCount > 1 ? 's' : ''} (x${extraCount})`,
      quantity: extraCount,
      unit_price: Math.round(extraCost / extraCount),
      line_total: extraCost,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Add-ons from proposal_addons
  const addonsRes = await client.query(
    'SELECT id, addon_name, billing_type, rate, quantity, line_total FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
    [proposalId]
  );
  for (const addon of addonsRes.rows) {
    items.push({
      description: addon.addon_name,
      quantity: addon.quantity || 1,
      unit_price: Math.round(Number(addon.rate) * 100),
      line_total: Math.round(Number(addon.line_total) * 100),
      source_type: 'addon',
      source_id: addon.id,
    });
  }

  // Bar fees
  if (snapshot.bar_rental) {
    const barTotal = Math.round(Number(snapshot.bar_rental.total || 0) * 100);
    if (barTotal > 0) {
      items.push({
        description: `Bar Rental (${prop.num_bars || 1} bar${(prop.num_bars || 1) > 1 ? 's' : ''})`,
        quantity: 1,
        unit_price: barTotal,
        line_total: barTotal,
        source_type: 'fee',
        source_id: null,
      });
    }
  }

  // Syrup cost
  if (snapshot.syrups?.total && Number(snapshot.syrups.total) > 0) {
    const syrupTotal = Math.round(Number(snapshot.syrups.total) * 100);
    items.push({
      description: 'Specialty Syrups',
      quantity: 1,
      unit_price: syrupTotal,
      line_total: syrupTotal,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Adjustments (discounts/surcharges from pricing_snapshot)
  if (snapshot.adjustments && Array.isArray(snapshot.adjustments)) {
    for (const adj of snapshot.adjustments) {
      const adjAmount = Math.round(Number(adj.amount || 0) * 100);
      if (adjAmount !== 0) {
        items.push({
          description: adj.label || 'Adjustment',
          quantity: 1,
          unit_price: adjAmount,
          line_total: adjAmount,
          source_type: 'fee',
          source_id: null,
        });
      }
    }
  }

  return items;
}

/**
 * Write line items into invoice_line_items for an invoice.
 * Deletes existing items first (safe for unlocked invoices being refreshed).
 */
async function writeLineItems(invoiceId, items, dbClient) {
  const client = dbClient || pool;
  await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  for (const item of items) {
    await client.query(`
      INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [invoiceId, item.description, item.quantity, item.unit_price, item.line_total, item.source_type, item.source_id || null]);
  }
}

/**
 * Create an invoice for a proposal. Returns the created invoice row.
 * @param {object} opts - { proposalId, label, amountDueCents, status, dueDate }
 * @param {object} [dbClient] - optional transaction client
 */
async function createInvoice({ proposalId, label, amountDueCents, status = 'sent', dueDate = null }, dbClient) {
  const client = dbClient || pool;

  // Get next invoice number
  const seqRes = await client.query("SELECT nextval('invoice_number_seq') AS num");
  const invoiceNumber = formatInvoiceNumber(seqRes.rows[0].num);

  const result = await client.query(`
    INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status, due_date)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [proposalId, invoiceNumber, label, amountDueCents, status, dueDate || null]);

  return result.rows[0];
}

/**
 * Lock an invoice: set locked=true, locked_at=NOW(). Idempotent.
 */
async function lockInvoice(invoiceId, dbClient) {
  const client = dbClient || pool;
  await client.query(
    'UPDATE invoices SET locked = true, locked_at = NOW() WHERE id = $1 AND locked = false',
    [invoiceId]
  );
}

/**
 * Refresh line items for all unlocked invoices on a proposal.
 * Called when proposal pricing changes.
 */
async function refreshUnlockedInvoices(proposalId, dbClient) {
  const client = dbClient || pool;

  const unlocked = await client.query(
    "SELECT id, label FROM invoices WHERE proposal_id = $1 AND locked = false AND status != 'void'",
    [proposalId]
  );

  if (unlocked.rows.length === 0) return;

  // Get current proposal total
  const propRes = await client.query(
    'SELECT total_price, deposit_amount FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!propRes.rows[0]) return;
  const totalCents = Math.round(Number(propRes.rows[0].total_price) * 100);
  const depositCents = Math.round(Number(propRes.rows[0].deposit_amount || 100) * 100);

  // Sum of all locked invoice amounts
  const lockedRes = await client.query(
    "SELECT COALESCE(SUM(amount_due), 0) AS locked_total FROM invoices WHERE proposal_id = $1 AND locked = true AND status != 'void'",
    [proposalId]
  );
  const lockedTotal = Number(lockedRes.rows[0].locked_total);

  // Generate fresh line items
  const allItems = await generateLineItemsFromProposal(proposalId, client);

  for (const inv of unlocked.rows) {
    // Determine the correct amount_due based on label type
    let newAmountDue;
    const lowerLabel = inv.label.toLowerCase();
    if (lowerLabel === 'deposit') {
      newAmountDue = depositCents;
    } else if (lowerLabel === 'full payment') {
      newAmountDue = totalCents;
    } else if (lowerLabel === 'balance') {
      newAmountDue = totalCents - lockedTotal;
    } else {
      // Additional services or manual — recalculate as remainder
      newAmountDue = totalCents - lockedTotal;
    }
    if (newAmountDue < 0) newAmountDue = 0;

    await client.query(
      'UPDATE invoices SET amount_due = $1 WHERE id = $2',
      [newAmountDue, inv.id]
    );
    await writeLineItems(inv.id, allItems, client);
  }
}

/**
 * Auto-create invoices when a proposal status changes to 'sent'.
 * Creates a deposit or full payment invoice based on proposal.payment_type.
 */
async function createInvoiceOnSend(proposalId, dbClient) {
  const client = dbClient || pool;

  // Check if invoices already exist (idempotent)
  const existing = await client.query(
    "SELECT id FROM invoices WHERE proposal_id = $1 AND status != 'void' LIMIT 1",
    [proposalId]
  );
  if (existing.rows.length > 0) return null;

  const propRes = await client.query(
    'SELECT total_price, deposit_amount, payment_type, balance_due_date FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!propRes.rows[0]) return null;
  const prop = propRes.rows[0];

  const totalCents = Math.round(Number(prop.total_price) * 100);
  const depositCents = Math.round(Number(prop.deposit_amount || 100) * 100);
  const isFullPay = prop.payment_type === 'full';

  const invoice = await createInvoice({
    proposalId,
    label: isFullPay ? 'Full Payment' : 'Deposit',
    amountDueCents: isFullPay ? totalCents : depositCents,
    status: 'sent',
    dueDate: prop.balance_due_date || null,
  }, client);

  // Write line items
  const items = await generateLineItemsFromProposal(proposalId, client);
  await writeLineItems(invoice.id, items, client);

  return invoice;
}

/**
 * After a deposit invoice is paid, create the balance invoice.
 */
async function createBalanceInvoice(proposalId, dbClient) {
  const client = dbClient || pool;

  // Check if a balance invoice already exists
  const existing = await client.query(
    "SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status != 'void' LIMIT 1",
    [proposalId]
  );
  if (existing.rows.length > 0) return null;

  const propRes = await client.query(
    'SELECT total_price, amount_paid, balance_due_date FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!propRes.rows[0]) return null;
  const prop = propRes.rows[0];

  const totalCents = Math.round(Number(prop.total_price) * 100);
  const paidCents = Math.round(Number(prop.amount_paid || 0) * 100);
  const balanceCents = totalCents - paidCents;

  if (balanceCents <= 0) return null;

  const invoice = await createInvoice({
    proposalId,
    label: 'Balance',
    amountDueCents: balanceCents,
    status: 'sent',
    dueDate: prop.balance_due_date || null,
  }, client);

  const items = await generateLineItemsFromProposal(proposalId, client);
  await writeLineItems(invoice.id, items, client);

  return invoice;
}

/**
 * After proposal is modified and locked invoices exist, create an "Additional Services"
 * invoice for the price difference (if positive).
 */
async function createAdditionalInvoiceIfNeeded(proposalId, oldTotalCents, dbClient) {
  const client = dbClient || pool;

  const propRes = await client.query(
    'SELECT total_price FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!propRes.rows[0]) return null;
  const newTotalCents = Math.round(Number(propRes.rows[0].total_price) * 100);

  // Only create if price increased
  if (newTotalCents <= oldTotalCents) return null;

  // Only create if there are locked invoices (meaning some payment has been made)
  const lockedRes = await client.query(
    "SELECT COUNT(*) AS cnt FROM invoices WHERE proposal_id = $1 AND locked = true",
    [proposalId]
  );
  if (Number(lockedRes.rows[0].cnt) === 0) return null;

  // Sum of all existing non-void invoice amounts
  const sumRes = await client.query(
    "SELECT COALESCE(SUM(amount_due), 0) AS total FROM invoices WHERE proposal_id = $1 AND status != 'void'",
    [proposalId]
  );
  const existingTotal = Number(sumRes.rows[0].total);
  const difference = newTotalCents - existingTotal;

  if (difference <= 0) return null;

  const invoice = await createInvoice({
    proposalId,
    label: 'Additional Services',
    amountDueCents: difference,
    status: 'sent',
  }, client);

  const items = await generateLineItemsFromProposal(proposalId, client);
  await writeLineItems(invoice.id, items, client);

  return invoice;
}

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
```

- [ ] **Step 2: Verify the module loads without errors**

Run: `node -e "const h = require('./server/utils/invoiceHelpers'); console.log(Object.keys(h)); process.exit(0);"`

Expected: prints array of exported function names.

- [ ] **Step 3: Commit**

```bash
git add server/utils/invoiceHelpers.js
git commit -m "feat(invoices): add invoice helper utilities — line item generation, auto-creation, locking"
```

---

## Task 3: Invoice API Routes

**Files:**
- Create: `server/routes/invoices.js`
- Modify: `server/index.js:113` (add route mount)

- [ ] **Step 1: Create the invoices route file with public token fetch**

Create `server/routes/invoices.js`:

```js
const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager, clientAuth } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createInvoice, writeLineItems } = require('../utils/invoiceHelpers');

const router = express.Router();

// ─── Public: fetch invoice by token ────────────────────────────────

/** GET /api/invoices/t/:token — public, token-gated */
router.get('/t/:token', publicLimiter, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.token, i.invoice_number, i.label, i.amount_due, i.amount_paid,
             i.status, i.locked, i.due_date, i.created_at,
             p.id AS proposal_id, p.event_name, p.event_date, p.event_start_time,
             p.event_duration_hours, p.event_location, p.guest_count, p.total_price,
             c.name AS client_name, c.email AS client_email, c.phone AS client_phone
      FROM invoices i
      JOIN proposals p ON p.id = i.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE i.token = $1 AND i.status != 'void'
    `, [req.params.token]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });

    const invoice = result.rows[0];

    // Fetch line items and payments in parallel
    const [lineItemsRes, paymentsRes] = await Promise.all([
      pool.query(
        'SELECT id, description, quantity, unit_price, line_total, source_type FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id',
        [invoice.id]
      ),
      pool.query(`
        SELECT ip.amount, ip.created_at, pp.payment_type, pp.stripe_payment_intent_id, pp.status AS payment_status
        FROM invoice_payments ip
        JOIN proposal_payments pp ON pp.id = ip.payment_id
        WHERE ip.invoice_id = $1
        ORDER BY ip.created_at DESC
      `, [invoice.id]),
    ]);

    res.json({
      invoice: {
        ...invoice,
        line_items: lineItemsRes.rows,
        payments: paymentsRes.rows,
      },
    });
  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin: list invoices for a proposal ───────────────────────────

/** GET /api/invoices/proposal/:proposalId — admin only */
router.get('/proposal/:proposalId', auth, requireAdminOrManager, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, token, invoice_number, label, amount_due, amount_paid, status, locked, due_date, created_at
      FROM invoices
      WHERE proposal_id = $1
      ORDER BY created_at ASC
    `, [req.params.proposalId]);

    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('Invoice list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin: recent invoices (for financials dashboard) ─────────────

/** GET /api/invoices/recent — admin only */
router.get('/recent', auth, requireAdminOrManager, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.token, i.invoice_number, i.label, i.amount_due, i.amount_paid,
             i.status, i.created_at,
             p.event_name, c.name AS client_name
      FROM invoices i
      JOIN proposals p ON p.id = i.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE i.status != 'void'
      ORDER BY i.created_at DESC
      LIMIT 20
    `);

    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('Recent invoices error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin: manually create invoice ────────────────────────────────

/** POST /api/invoices/proposal/:proposalId — admin only */
router.post('/proposal/:proposalId', auth, requireAdminOrManager, async (req, res) => {
  const { label, amount, due_date, line_items } = req.body;

  if (!label || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Label and positive amount are required.' });
  }

  try {
    const proposalRes = await pool.query('SELECT id FROM proposals WHERE id = $1', [req.params.proposalId]);
    if (!proposalRes.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const amountCents = Math.round(Number(amount) * 100);

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      const invoice = await createInvoice({
        proposalId: parseInt(req.params.proposalId, 10),
        label,
        amountDueCents: amountCents,
        status: 'sent',
        dueDate: due_date || null,
      }, dbClient);

      // Write manual line items if provided, otherwise single line
      const items = (line_items && line_items.length > 0)
        ? line_items.map(li => ({
            description: li.description,
            quantity: li.quantity || 1,
            unit_price: Math.round(Number(li.amount) * 100),
            line_total: Math.round(Number(li.amount) * (li.quantity || 1) * 100),
            source_type: 'manual',
            source_id: null,
          }))
        : [{
            description: label,
            quantity: 1,
            unit_price: amountCents,
            line_total: amountCents,
            source_type: 'manual',
            source_id: null,
          }];

      await writeLineItems(invoice.id, items, dbClient);
      await dbClient.query('COMMIT');

      res.status(201).json({ invoice });
    } catch (txErr) {
      await dbClient.query('ROLLBACK');
      throw txErr;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('Manual invoice creation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin: update invoice (label, due_date, void) ─────────────────

/** PATCH /api/invoices/:id — admin only */
router.patch('/:id', auth, requireAdminOrManager, async (req, res) => {
  const { label, due_date, status } = req.body;

  try {
    const existing = await pool.query('SELECT id, status FROM invoices WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });

    // Only allow voiding or updating label/due_date
    if (status && status !== 'void') {
      return res.status(400).json({ error: 'Only voiding is allowed via this endpoint.' });
    }

    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (label !== undefined) {
      updates.push(`label = $${paramIdx++}`);
      values.push(label);
    }
    if (due_date !== undefined) {
      updates.push(`due_date = $${paramIdx++}`);
      values.push(due_date || null);
    }
    if (status === 'void') {
      updates.push(`status = $${paramIdx++}`);
      values.push('void');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE invoices SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error('Invoice update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Client Portal: list invoices for a proposal ───────────────────

/** GET /api/invoices/client/:proposalToken — client auth */
router.get('/client/:proposalToken', clientAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.token, i.invoice_number, i.label, i.amount_due, i.amount_paid,
             i.status, i.due_date, i.created_at
      FROM invoices i
      JOIN proposals p ON p.id = i.proposal_id
      WHERE p.token = $1 AND p.client_id = $2 AND i.status IN ('sent', 'paid', 'partially_paid')
      ORDER BY i.created_at ASC
    `, [req.params.proposalToken, req.user.id]);

    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('Client invoice list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount the route in server/index.js**

In `server/index.js`, add after line 113 (`app.use('/api/thumbtack', ...)`):

```js
app.use('/api/invoices', require('./routes/invoices'));
```

- [ ] **Step 3: Verify the route loads**

Run: `node -e "require('./server/routes/invoices'); console.log('Route OK'); process.exit(0);"`

Expected: "Route OK"

- [ ] **Step 4: Commit**

```bash
git add server/routes/invoices.js server/index.js
git commit -m "feat(invoices): add invoice CRUD routes + mount in server"
```

---

## Task 4: Stripe Invoice Payment Endpoint

**Files:**
- Modify: `server/routes/stripe.js` (add new endpoint before webhook)

- [ ] **Step 1: Add create-intent-for-invoice endpoint**

In `server/routes/stripe.js`, add before the `// ─── Stripe Webhook` section (before line 425):

```js
// ─── Public: create a Payment Intent for an invoice ─────────────

/** POST /api/stripe/create-intent-for-invoice/:token — public, token-gated */
router.post('/create-intent-for-invoice/:token', publicLimiter, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

    const invRes = await pool.query(`
      SELECT i.id AS invoice_id, i.amount_due, i.amount_paid, i.status AS invoice_status,
             p.id AS proposal_id, p.event_name, p.stripe_customer_id,
             c.email AS client_email, c.name AS client_name
      FROM invoices i
      JOIN proposals p ON p.id = i.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE i.token = $1 AND i.status IN ('sent', 'partially_paid')
    `, [req.params.token]);

    if (!invRes.rows[0]) return res.status(404).json({ error: 'Invoice not found or already paid.' });

    const inv = invRes.rows[0];
    const balanceCents = inv.amount_due - inv.amount_paid;
    if (balanceCents <= 0) {
      return res.status(400).json({ error: 'Invoice is already fully paid.' });
    }

    const customerId = await getOrCreateCustomer({
      id: inv.proposal_id,
      stripe_customer_id: inv.stripe_customer_id,
      client_email: inv.client_email,
      client_name: inv.client_name,
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: customerId,
      description: `Invoice ${inv.invoice_id} — ${inv.client_name || 'Dr. Bartender'}`,
      receipt_email: inv.client_email || undefined,
      metadata: {
        proposal_id: String(inv.proposal_id),
        invoice_id: String(inv.invoice_id),
        payment_type: 'invoice',
      },
    });

    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [inv.proposal_id, paymentIntent.id, balanceCents]
    );

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe invoice payment intent error:', err);
    res.status(500).json({ error: 'Failed to create payment intent.' });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(invoices): add Stripe create-intent-for-invoice endpoint"
```

---

## Task 5: Webhook + Record-Payment Invoice Integration

**Files:**
- Modify: `server/routes/stripe.js` (webhook handler)
- Modify: `server/routes/proposals.js` (record-payment + status change + PATCH)

- [ ] **Step 1: Add invoice require to stripe.js**

At the top of `server/routes/stripe.js`, add after the existing requires (after line 8):

```js
const { lockInvoice, createBalanceInvoice } = require('../utils/invoiceHelpers');
```

- [ ] **Step 2: Update the webhook payment_intent.succeeded handler to link invoice payments**

In the webhook `payment_intent.succeeded` handler, inside the `if (isFirstDelivery)` block (after the activity log insert at approximately line 582), add invoice linking logic:

```js
          // ── Invoice integration ──────────────────────────────────
          const invoiceId = intent.metadata?.invoice_id;
          if (invoiceId) {
            // Payment was made through an invoice — link and lock
            const paymentRow = await dbClient.query(
              'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
              [intent.id, 'succeeded']
            );
            if (paymentRow.rows[0]) {
              await dbClient.query(
                'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
                [invoiceId, paymentRow.rows[0].id, intent.amount]
              );
              // Update invoice amount_paid and status
              const invUpdate = await dbClient.query(
                'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
                [intent.amount, invoiceId]
              );
              if (invUpdate.rows[0]) {
                const inv = invUpdate.rows[0];
                const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
                await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, invoiceId]);
              }
              await lockInvoice(invoiceId, dbClient);
            }
          } else {
            // Legacy payment (not through invoice) — try to find and link the right invoice
            const openInvoice = await dbClient.query(
              "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
              [proposalId]
            );
            if (openInvoice.rows[0]) {
              const paymentRow = await dbClient.query(
                'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
                [intent.id, 'succeeded']
              );
              if (paymentRow.rows[0]) {
                await dbClient.query(
                  'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
                  [openInvoice.rows[0].id, paymentRow.rows[0].id, intent.amount]
                );
                const invUpdate = await dbClient.query(
                  'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
                  [intent.amount, openInvoice.rows[0].id]
                );
                if (invUpdate.rows[0]) {
                  const inv = invUpdate.rows[0];
                  const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
                  await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, openInvoice.rows[0].id]);
                }
                await lockInvoice(openInvoice.rows[0].id, dbClient);
              }
            }
          }

          // If a deposit was just paid, create the balance invoice
          if (paymentType === 'deposit' || paymentType === 'full') {
            if (paymentType === 'deposit') {
              await createBalanceInvoice(proposalId, dbClient);
            }
          }
```

- [ ] **Step 3: Add invoice helpers require to proposals.js**

At the top of `server/routes/proposals.js`, add after the existing requires (after line 8):

```js
const { createInvoiceOnSend, refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded, lockInvoice } = require('../utils/invoiceHelpers');
```

- [ ] **Step 4: Trigger invoice creation when proposal status changes to 'sent'**

In `server/routes/proposals.js`, in the `PATCH /:id/status` handler, after the email sending block (around line 984), add:

```js
    // Auto-create first invoice when proposal is sent
    if (status === 'sent') {
      try {
        await createInvoiceOnSend(parseInt(req.params.id, 10));
      } catch (invErr) {
        console.error('Invoice auto-creation failed (non-blocking):', invErr);
      }
    }
```

- [ ] **Step 5: Refresh unlocked invoices when proposal is edited**

In `server/routes/proposals.js`, in the `PATCH /:id` handler, after the commit (around line 904) and before the return, add:

```js
    // Refresh unlocked invoices with new pricing
    const oldTotalCents = Math.round(Number(old.total_price || 0) * 100);
    try {
      await refreshUnlockedInvoices(parseInt(req.params.id, 10));
      await createAdditionalInvoiceIfNeeded(parseInt(req.params.id, 10), oldTotalCents);
    } catch (invErr) {
      console.error('Invoice refresh failed (non-blocking):', invErr);
    }
```

- [ ] **Step 6: Link record-payment to invoices**

In `server/routes/proposals.js`, in the `POST /:id/record-payment` handler, inside the transaction block (after the activity log insert, around line 1101), add:

```js
      // Link payment to the oldest open invoice
      const openInvoice = await dbClient.query(
        "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
        [proposal.id]
      );
      if (openInvoice.rows[0]) {
        const paymentRow = await dbClient.query(
          'SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
          [proposal.id]
        );
        if (paymentRow.rows[0]) {
          const payAmountCents = Math.round(paymentAmount * 100);
          await dbClient.query(
            'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
            [openInvoice.rows[0].id, paymentRow.rows[0].id, payAmountCents]
          );
          const invUpdate = await dbClient.query(
            'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
            [payAmountCents, openInvoice.rows[0].id]
          );
          if (invUpdate.rows[0]) {
            const inv = invUpdate.rows[0];
            const invStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
            await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [invStatus, openInvoice.rows[0].id]);
          }
          await lockInvoice(openInvoice.rows[0].id, dbClient);
        }
      }
```

- [ ] **Step 7: Commit**

```bash
git add server/routes/stripe.js server/routes/proposals.js
git commit -m "feat(invoices): integrate invoice linking into webhook, record-payment, status change, and proposal edit"
```

---

## Task 6: InvoiceDropdown Component

**Files:**
- Create: `client/src/components/InvoiceDropdown.js`

- [ ] **Step 1: Create the InvoiceDropdown component**

Create `client/src/components/InvoiceDropdown.js`:

```jsx
import React, { useState, useEffect } from 'react';
import api from '../utils/api';

function formatCurrency(cents) {
  if (cents == null) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Dropdown showing invoices for a proposal.
 * @param {object} props
 * @param {number|string} props.proposalId - The proposal ID (admin mode)
 * @param {string} [props.proposalToken] - The proposal token (client mode)
 * @param {boolean} [props.isClient] - If true, uses client auth endpoint
 * @param {string} [props.clientToken] - JWT for client auth header
 */
export default function InvoiceDropdown({ proposalId, proposalToken, isClient = false, clientToken }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchInvoices = async () => {
      try {
        let res;
        if (isClient && proposalToken) {
          const headers = clientToken ? { Authorization: `Bearer ${clientToken}` } : {};
          res = await api.get(`/invoices/client/${proposalToken}`, { headers });
        } else if (proposalId) {
          res = await api.get(`/invoices/proposal/${proposalId}`);
        } else {
          setLoading(false);
          return;
        }
        if (!cancelled) setInvoices(res.data.invoices || []);
      } catch (err) {
        console.error('Failed to load invoices:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchInvoices();
    return () => { cancelled = true; };
  }, [proposalId, proposalToken, isClient, clientToken]);

  if (loading || invoices.length === 0) return null;

  return (
    <div className="invoice-dropdown-wrapper">
      <button
        className="section-toggle"
        onClick={() => setOpen(!open)}
        style={{ marginTop: '0.75rem' }}
      >
        {open ? 'Hide Invoices' : `Invoices (${invoices.length})`}
      </button>
      {open && (
        <div className="invoice-dropdown-list" style={{ marginTop: '0.5rem' }}>
          {invoices.map(inv => {
            const isPaid = inv.status === 'paid';
            const isPartial = inv.status === 'partially_paid';
            const color = isPaid ? 'var(--sage)' : 'var(--rust)';
            const statusLabel = isPaid ? 'Paid' : isPartial ? 'Partial' : 'Due';
            const displayAmount = isPaid ? inv.amount_paid : inv.amount_due;

            return (
              <a
                key={inv.id}
                href={`/invoice/${inv.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="invoice-dropdown-item"
                style={{ color, textDecoration: 'none' }}
              >
                <span className="invoice-dropdown-number">
                  {inv.invoice_number} · {inv.label}
                </span>
                <span className="invoice-dropdown-amount">
                  {formatCurrency(displayAmount)} — {statusLabel}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add CSS for invoice dropdown**

In `client/src/index.css`, add at the end:

```css
/* ─── Invoice Dropdown ─────────────────────────────────────────── */
.invoice-dropdown-wrapper {
  margin-top: 0.5rem;
}
.invoice-dropdown-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.invoice-dropdown-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: var(--cream);
  font-size: 0.85rem;
  transition: background 0.15s;
  cursor: pointer;
}
.invoice-dropdown-item:hover {
  background: var(--cream-dark);
}
.invoice-dropdown-number {
  font-weight: 600;
}
.invoice-dropdown-amount {
  font-weight: 500;
  white-space: nowrap;
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/InvoiceDropdown.js client/src/index.css
git commit -m "feat(invoices): add InvoiceDropdown reusable component + CSS"
```

---

## Task 7: Invoice Page (Public)

**Files:**
- Create: `client/src/pages/invoice/InvoicePage.js`
- Modify: `client/src/App.js` (add route)

- [ ] **Step 1: Install html2pdf.js**

Run: `cd client && npm install html2pdf.js`

- [ ] **Step 2: Create the InvoicePage component**

Create `client/src/pages/invoice/InvoicePage.js`:

```jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import api from '../../utils/api';

function formatCurrency(cents) {
  if (cents == null) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function PaymentForm({ onSuccess }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError('');

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (stripeError) {
      setError(stripeError.message);
      setProcessing(false);
    } else {
      onSuccess();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="invoice-payment-form">
      <PaymentElement />
      {error && <p style={{ color: 'var(--rust)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
      <button type="submit" className="btn" disabled={!stripe || processing} style={{ marginTop: '1rem', width: '100%' }}>
        {processing ? 'Processing...' : 'Pay Now'}
      </button>
    </form>
  );
}

export default function InvoicePage() {
  const { token } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clientSecret, setClientSecret] = useState(null);
  const [stripePromise, setStripePromise] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const printRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/invoices/t/${token}`);
        if (!cancelled) setInvoice(data.invoice);
      } catch (err) {
        if (!cancelled) setError('Invoice not found or no longer available.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Fetch Stripe publishable key
  useEffect(() => {
    api.get('/stripe/publishable-key').then(({ data }) => {
      if (data.key) setStripePromise(loadStripe(data.key));
    });
  }, []);

  const handlePayClick = useCallback(async () => {
    try {
      const { data } = await api.post(`/stripe/create-intent-for-invoice/${token}`);
      setClientSecret(data.clientSecret);
      setShowPayment(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to initiate payment.');
    }
  }, [token]);

  const handlePaymentSuccess = useCallback(() => {
    setPaymentSuccess(true);
    setShowPayment(false);
    // Refresh invoice data
    api.get(`/invoices/t/${token}`).then(({ data }) => setInvoice(data.invoice));
  }, [token]);

  const handleSavePdf = useCallback(async () => {
    const html2pdf = (await import('html2pdf.js')).default;
    const element = printRef.current;
    if (!element) return;
    const filename = `${invoice.invoice_number}-${invoice.label.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;
    html2pdf().set({
      margin: [0.5, 0.5, 0.5, 0.5],
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
    }).from(element).save();
  }, [invoice]);

  if (loading) return <div className="invoice-page"><div className="loading"><div className="spinner" />Loading...</div></div>;
  if (error) return <div className="invoice-page"><div className="card"><p className="text-error">{error}</p></div></div>;
  if (!invoice) return null;

  const isPaid = invoice.status === 'paid' || paymentSuccess;
  const balanceDue = invoice.amount_due - invoice.amount_paid;

  return (
    <div className="invoice-page">
      <div className="invoice-document" ref={printRef}>
        {/* Header */}
        <div className="invoice-header">
          <div>
            <h1 className="invoice-title">INVOICE</h1>
            <p className="invoice-number">{invoice.invoice_number}</p>
          </div>
          <div className="invoice-brand">
            <p className="invoice-brand-name">Dr. Bartender</p>
            <p className="text-muted text-small">contact@drbartender.com</p>
          </div>
        </div>

        {/* PAID stamp */}
        {isPaid && (
          <div className="invoice-paid-stamp">PAID</div>
        )}

        {/* Meta + Bill To */}
        <div className="invoice-meta-row">
          <div className="invoice-meta-block">
            <p className="text-muted text-small">Date Issued</p>
            <p>{formatDate(invoice.created_at)}</p>
            {invoice.due_date && (
              <>
                <p className="text-muted text-small" style={{ marginTop: '0.5rem' }}>Due Date</p>
                <p>{formatDate(invoice.due_date)}</p>
              </>
            )}
          </div>
          <div className="invoice-meta-block">
            <p className="text-muted text-small">Bill To</p>
            <p style={{ fontWeight: 600 }}>{invoice.client_name || '—'}</p>
            {invoice.client_email && <p className="text-small">{invoice.client_email}</p>}
            {invoice.client_phone && <p className="text-small">{invoice.client_phone}</p>}
          </div>
        </div>

        {/* Event Info */}
        <div className="invoice-event-block">
          <p className="text-muted text-small">Event</p>
          <p style={{ fontWeight: 600 }}>{invoice.event_name || 'Event'}</p>
          <p className="text-small">{formatDate(invoice.event_date)}{invoice.event_location ? ` · ${invoice.event_location}` : ''}{invoice.guest_count ? ` · ${invoice.guest_count} guests` : ''}</p>
        </div>

        {/* Line Items */}
        <table className="invoice-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Description</th>
              <th style={{ textAlign: 'center' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit Price</th>
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.line_items || []).map(li => (
              <tr key={li.id}>
                <td>{li.description}</td>
                <td style={{ textAlign: 'center' }}>{li.quantity}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(li.unit_price)}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(li.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="invoice-totals">
          <div className="invoice-totals-row">
            <span>Invoice Total</span>
            <span>{formatCurrency(invoice.amount_due)}</span>
          </div>
          {invoice.amount_paid > 0 && (
            <div className="invoice-totals-row">
              <span>Amount Paid</span>
              <span style={{ color: 'var(--sage)' }}>-{formatCurrency(invoice.amount_paid)}</span>
            </div>
          )}
          <div className="invoice-totals-row invoice-totals-balance">
            <span>{isPaid ? 'Balance Due' : 'Balance Due'}</span>
            <span style={{ color: isPaid ? 'var(--sage)' : 'var(--rust)' }}>
              {isPaid ? '$0.00' : formatCurrency(balanceDue)}
            </span>
          </div>
        </div>

        {/* Payment details if paid */}
        {isPaid && invoice.payments && invoice.payments.length > 0 && (
          <div className="invoice-payment-details">
            <p className="text-muted text-small" style={{ marginBottom: '0.3rem' }}>Payment Details</p>
            {invoice.payments.map((pay, i) => (
              <p key={i} className="text-small">
                {formatDate(pay.created_at)} — {formatCurrency(pay.amount)} via {pay.payment_type || 'Stripe'}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Actions (outside printRef so they don't appear in PDF) */}
      <div className="invoice-actions">
        {!isPaid && balanceDue > 0 && !showPayment && (
          <button className="btn" onClick={handlePayClick} style={{ width: '100%' }}>
            Pay {formatCurrency(balanceDue)}
          </button>
        )}

        {showPayment && clientSecret && stripePromise && (
          <div style={{ marginTop: '1rem' }}>
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
              <PaymentForm onSuccess={handlePaymentSuccess} />
            </Elements>
          </div>
        )}

        {paymentSuccess && (
          <div className="invoice-success-msg">
            <p>Payment successful! Thank you.</p>
          </div>
        )}

        <button className="btn btn-secondary" onClick={handleSavePdf} style={{ width: '100%', marginTop: '0.75rem' }}>
          Save as PDF
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add CSS for invoice page**

In `client/src/index.css`, append:

```css
/* ─── Invoice Page ─────────────────────────────────────────────── */
.invoice-page {
  max-width: 700px;
  margin: 2rem auto;
  padding: 0 1rem;
}
.invoice-document {
  background: white;
  border: 1px solid var(--cream-dark);
  border-radius: 8px;
  padding: 2rem;
  position: relative;
}
.invoice-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 2px solid var(--deep-brown);
}
.invoice-title {
  font-family: var(--font-display);
  font-size: 1.8rem;
  margin: 0;
  color: var(--deep-brown);
}
.invoice-number {
  font-size: 0.9rem;
  color: var(--text-muted);
  margin-top: 0.2rem;
}
.invoice-brand {
  text-align: right;
}
.invoice-brand-name {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--deep-brown);
  margin: 0;
}
.invoice-paid-stamp {
  position: absolute;
  top: 3rem;
  right: 2rem;
  font-family: var(--font-display);
  font-size: 2.5rem;
  font-weight: 800;
  color: var(--sage);
  opacity: 0.25;
  transform: rotate(-15deg);
  pointer-events: none;
  letter-spacing: 0.1em;
}
.invoice-meta-row {
  display: flex;
  gap: 2rem;
  margin-bottom: 1.5rem;
}
.invoice-meta-block p {
  margin: 0.1rem 0;
}
.invoice-event-block {
  margin-bottom: 1.5rem;
  padding: 0.75rem;
  background: var(--cream);
  border-radius: 6px;
}
.invoice-event-block p { margin: 0.1rem 0; }
.invoice-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1.5rem;
  font-size: 0.9rem;
}
.invoice-table th {
  border-bottom: 2px solid var(--cream-dark);
  padding: 0.5rem;
  font-weight: 600;
  color: var(--deep-brown);
}
.invoice-table td {
  padding: 0.5rem;
  border-bottom: 1px solid var(--cream);
}
.invoice-totals {
  margin-left: auto;
  max-width: 280px;
}
.invoice-totals-row {
  display: flex;
  justify-content: space-between;
  padding: 0.3rem 0;
  font-size: 0.9rem;
}
.invoice-totals-balance {
  border-top: 2px solid var(--deep-brown);
  margin-top: 0.3rem;
  padding-top: 0.5rem;
  font-weight: 700;
  font-size: 1rem;
}
.invoice-payment-details {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--cream-dark);
}
.invoice-actions {
  margin-top: 1.5rem;
}
.invoice-success-msg {
  text-align: center;
  padding: 1rem;
  background: rgba(45, 106, 79, 0.1);
  border-radius: 6px;
  color: var(--sage);
  font-weight: 600;
}
.invoice-payment-form {
  padding: 1rem;
  border: 1px solid var(--cream-dark);
  border-radius: 8px;
  background: white;
}
@media (max-width: 600px) {
  .invoice-document { padding: 1.25rem; }
  .invoice-meta-row { flex-direction: column; gap: 1rem; }
  .invoice-totals { max-width: 100%; }
  .invoice-paid-stamp { font-size: 1.8rem; top: 2rem; right: 1rem; }
}
```

- [ ] **Step 4: Add route to App.js**

In `client/src/App.js`, add the import at the top (after line 17, the ProposalView import):

```js
import InvoicePage from './pages/invoice/InvoicePage';
```

Then add the route in each domain context that has public token routes:

In `PublicWebsiteRoutes` (around line 180, after the `/proposal/:token` route):
```jsx
<Route path="/invoice/:token" element={<InvoicePage />} />
```

In `HiringRoutes` (around line 208, after the `/proposal/:token` route):
```jsx
<Route path="/invoice/:token" element={<InvoicePage />} />
```

In `StaffSiteRoutes` (around line 245, after the `/proposal/:token` route):
```jsx
<Route path="/invoice/:token" element={<InvoicePage />} />
```

In `AppRoutes` (around line 268, after the `/proposal/:token` route):
```jsx
<Route path="/invoice/:token" element={<InvoicePage />} />
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/invoice/InvoicePage.js client/src/index.css client/src/App.js client/package.json client/package-lock.json
git commit -m "feat(invoices): add public InvoicePage with Stripe payment + PDF export"
```

---

## Task 8: Integrate InvoiceDropdown into Admin ProposalDetail

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js`

- [ ] **Step 1: Import InvoiceDropdown**

At the top of `ProposalDetail.js`, add the import alongside existing component imports:

```js
import InvoiceDropdown from '../../components/InvoiceDropdown';
```

- [ ] **Step 2: Add CreateInvoiceModal state variables**

In the component's state declarations (near the top of the component function), add:

```js
const [showCreateInvoice, setShowCreateInvoice] = useState(false);
const [newInvoiceLabel, setNewInvoiceLabel] = useState('');
const [newInvoiceAmount, setNewInvoiceAmount] = useState('');
const [newInvoiceDueDate, setNewInvoiceDueDate] = useState('');
const [creatingInvoice, setCreatingInvoice] = useState(false);
```

- [ ] **Step 3: Add createInvoice handler**

Add a handler function in the component:

```js
const handleCreateInvoice = async () => {
  if (!newInvoiceLabel || !newInvoiceAmount || Number(newInvoiceAmount) <= 0) return;
  setCreatingInvoice(true);
  try {
    await api.post(`/invoices/proposal/${id}`, {
      label: newInvoiceLabel,
      amount: Number(newInvoiceAmount),
      due_date: newInvoiceDueDate || null,
    });
    setShowCreateInvoice(false);
    setNewInvoiceLabel('');
    setNewInvoiceAmount('');
    setNewInvoiceDueDate('');
    // Force re-render of InvoiceDropdown by bumping a key
    setProposal(prev => ({ ...prev }));
  } catch (err) {
    console.error('Failed to create invoice:', err);
  } finally {
    setCreatingInvoice(false);
  }
};
```

- [ ] **Step 4: Render InvoiceDropdown and create button in the pricing section**

Find the pricing/financial section in the JSX (the area near the "Payment Actions" toggle, around line 1030). After the closing `</div>` of the financial summary rows and before the Payment Actions button, add:

```jsx
{/* Invoice Dropdown */}
<InvoiceDropdown proposalId={id} />

{/* Create Invoice */}
{!showCreateInvoice ? (
  <button className="btn btn-sm btn-secondary" onClick={() => setShowCreateInvoice(true)}
    style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
    + Create Invoice
  </button>
) : (
  <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--cream)', borderRadius: '6px' }}>
    <label className="text-muted text-small" style={{ display: 'block', marginBottom: '0.3rem' }}>New Invoice</label>
    <input className="form-input" placeholder="Label (e.g. Rush Fee)" value={newInvoiceLabel}
      onChange={e => setNewInvoiceLabel(e.target.value)}
      style={{ marginBottom: '0.4rem', fontSize: '0.85rem' }} />
    <input className="form-input" type="number" step="0.01" min="0.01" placeholder="Amount ($)"
      value={newInvoiceAmount} onChange={e => setNewInvoiceAmount(e.target.value)}
      style={{ marginBottom: '0.4rem', fontSize: '0.85rem' }} />
    <input className="form-input" type="date" value={newInvoiceDueDate}
      onChange={e => setNewInvoiceDueDate(e.target.value)}
      style={{ marginBottom: '0.5rem', fontSize: '0.85rem' }} />
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button className="btn btn-sm" onClick={handleCreateInvoice} disabled={creatingInvoice}>
        {creatingInvoice ? 'Creating...' : 'Create'}
      </button>
      <button className="btn btn-sm btn-secondary" onClick={() => setShowCreateInvoice(false)}>Cancel</button>
    </div>
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat(invoices): add InvoiceDropdown + manual create to admin ProposalDetail"
```

---

## Task 9: Integrate InvoiceDropdown into Client Dashboard

**Files:**
- Modify: `client/src/pages/public/ClientDashboard.js`

- [ ] **Step 1: Import InvoiceDropdown**

At the top of `ClientDashboard.js`, add:

```js
import InvoiceDropdown from '../../components/InvoiceDropdown';
```

- [ ] **Step 2: Add the dropdown inside each proposal card**

In the proposal card JSX (inside the `.map`, after the `.client-proposal-card-details` div and before the `Link` button), add:

```jsx
<InvoiceDropdown
  proposalToken={p.token}
  isClient={true}
  clientToken={localStorage.getItem('db_client_token')}
/>
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/public/ClientDashboard.js
git commit -m "feat(invoices): add InvoiceDropdown to client portal dashboard"
```

---

## Task 10: Make Financials Recent Payments Clickable

**Files:**
- Modify: `server/routes/proposals.js` (financials endpoint)
- Modify: `client/src/pages/admin/FinancialsDashboard.js`

- [ ] **Step 1: Update the financials endpoint to include invoice tokens**

In `server/routes/proposals.js`, update the `recentPayments` query in the financials endpoint (around line 623). Replace the existing payments query with:

```sql
SELECT pp.id, pp.proposal_id, pp.payment_type, pp.amount, pp.status AS payment_status,
       pp.created_at, p.event_name, c.name AS client_name,
       ip.invoice_id, i.token AS invoice_token
FROM proposal_payments pp
JOIN proposals p ON p.id = pp.proposal_id
LEFT JOIN clients c ON c.id = p.client_id
LEFT JOIN invoice_payments ip ON ip.payment_id = pp.id
LEFT JOIN invoices i ON i.id = ip.invoice_id
WHERE pp.status = 'succeeded'
ORDER BY pp.created_at DESC
LIMIT 20
```

- [ ] **Step 2: Make payment rows clickable in FinancialsDashboard**

In `client/src/pages/admin/FinancialsDashboard.js`, update the `recentPayments.map` table body (around line 132). Replace the `<tr key={pp.id}>` with:

```jsx
<tr
  key={pp.id}
  style={{ cursor: pp.invoice_token ? 'pointer' : 'default' }}
  onClick={() => pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank')}
  onKeyDown={(e) => e.key === 'Enter' && pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank')}
  tabIndex={pp.invoice_token ? 0 : undefined}
  role={pp.invoice_token ? 'link' : undefined}
  title={pp.invoice_token ? 'View invoice' : 'No invoice linked'}
>
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/proposals.js client/src/pages/admin/FinancialsDashboard.js
git commit -m "feat(invoices): make financials Recent Payments rows link to invoices"
```

---

## Task 11: Documentation Updates

**Files:**
- Modify: `CLAUDE.md` (folder structure)
- Modify: `README.md` (folder structure, features)
- Modify: `ARCHITECTURE.md` (if exists — API routes, schema)

- [ ] **Step 1: Update CLAUDE.md folder structure**

Add to the server/routes section:
```
│   │   ├── invoices.js        # Invoice CRUD, public token view, client portal
```

Add to the server/utils section:
```
│   │   ├── invoiceHelpers.js  # Invoice auto-generation, line items, locking
```

Add to the client/src/components section:
```
│   │   ├── InvoiceDropdown.js # Invoice list dropdown (admin + client)
```

Add to the client/src/pages section:
```
│   │   ├── invoice/
│   │   │   └── InvoicePage.js     # Public token-gated invoice view + payment
```

- [ ] **Step 2: Update README.md with same folder structure changes and feature description**

Add "Invoice/Receipt System" to Key Features section if it exists. Update folder trees to match CLAUDE.md additions.

- [ ] **Step 3: Update ARCHITECTURE.md if it exists**

Add invoice API routes to the API route table. Add `invoices`, `invoice_line_items`, `invoice_payments` to the database schema section.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs: add invoice system to folder structure and feature docs"
```

---

## Self-Review

**Spec coverage check:**
- [x] Hybrid locking (update while unlocked, lock on payment) — Task 2 (`lockInvoice`, `refreshUnlockedInvoices`) + Task 5 (webhook/record-payment integration)
- [x] Invoice = receipt (PAID stamp, same document) — Task 7 (InvoicePage paid state)
- [x] Sequential numbering + labels — Task 1 (sequence) + Task 2 (`formatInvoiceNumber`)
- [x] Auto-generated at lifecycle events — Task 2 (`createInvoiceOnSend`, `createBalanceInvoice`, `createAdditionalInvoiceIfNeeded`) + Task 5 (hooks into proposals.js)
- [x] Manual creation — Task 3 (`POST /api/invoices/proposal/:proposalId`) + Task 8 (admin UI)
- [x] Shareable token link — Task 3 (`GET /api/invoices/t/:token`) + Task 7 (InvoicePage)
- [x] Pay button on invoice — Task 4 (Stripe intent) + Task 7 (PaymentForm)
- [x] PDF export — Task 7 (html2pdf.js)
- [x] Admin ProposalDetail dropdown — Task 8
- [x] Admin Events (shared component) — Task 8 (ProposalDetail serves both routes)
- [x] Financials clickable payments — Task 10
- [x] Client portal dropdown — Task 9
- [x] Public proposal NOT modified — confirmed, no changes to ProposalView
- [x] Edge cases (void, legacy, partial) — Tasks 3, 5
- [x] Documentation updates — Task 11

**Placeholder scan:** No TBDs, TODOs, or "implement later" found.

**Type consistency check:**
- `formatInvoiceNumber` used in Task 2, called in `createInvoice` (same file) — consistent
- `lockInvoice` defined in Task 2, imported in Tasks 4 and 5 — consistent signature
- `createBalanceInvoice` defined in Task 2, called in Task 5 — consistent
- Invoice status values (`draft`, `sent`, `paid`, `partially_paid`, `void`) consistent across schema (Task 1), routes (Task 3), and frontend (Tasks 6, 7)
- Amount fields consistently INTEGER cents in all new tables and code
