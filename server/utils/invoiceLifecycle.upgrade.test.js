// server/utils/invoiceLifecycle.upgrade.test.js
// The deposit-to-full upgrade (spec 2026-08-28 §4a). A deposit-terms send
// mints a Deposit invoice; when the client pays in FULL the open Deposit row
// is re-derived from the proposal into the Full Payment invoice BEFORE the
// credit lands, so the payment fits and nothing overflows. Guard cases pin
// that a Deposit with money on it, a locked one, a void one, or a differently
// labelled one is never touched and never breadcrumbed.
require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { upgradeDepositInvoiceToFull } = require('./invoiceLifecycle');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLifecycle.upgrade.test.js refuses to run against production');
}

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];
const invoiceIds = [];

async function seed({ label = 'Deposit', status = 'sent', locked = false, invoiceAmountPaid = 0, totalPrice = 550, externalPaid = 0, balanceDueDate = '2026-09-12' } = {}) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Upgrade Test', $1) RETURNING id`, [`upg-${NONCE}-${seq}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid, balance_due_date,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours, event_type, payment_type)
     VALUES ($1, 'accepted', $2, 0, 100, $3, $4,
             '{"package": {"name": "The Core Reaction", "base_cost": 550}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', 'full')
     RETURNING id`,
    [c.rows[0].id, totalPrice, externalPaid, balanceDueDate]
  );
  proposalIds.push(p.rows[0].id);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, due_date)
     VALUES ($1, $2, $3, 10000, $4, $5, $6, NULL) RETURNING id`,
    [p.rows[0].id, `UPG${NONCE}${seq}`, label, invoiceAmountPaid, status, locked]
  );
  invoiceIds.push(i.rows[0].id);
  return { proposalId: p.rows[0].id, invoiceId: i.rows[0].id };
}

const invoice = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const breadcrumbs = async (proposalId) => (await pool.query(
  "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
)).rows;

// The helper refuses to run off the pool, so every call here rides a transaction.
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function expectUntouched({ proposalId, invoiceId }, label) {
  assert.equal(await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c)), null);
  const inv = await invoice(invoiceId);
  assert.equal(inv.label, label);
  assert.equal(Number(inv.amount_due), 10000);
  assert.equal((await breadcrumbs(proposalId)).length, 0, 'no breadcrumb on a guard refusal');
}

after(async () => {
  if (invoiceIds.length) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
    await pool.query('DELETE FROM invoices WHERE id = ANY($1::int[])', [invoiceIds]);
  }
  if (proposalIds.length) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('happy path: the open Deposit becomes Full Payment at total_price with the balance due date, lines regenerate, breadcrumb written', async () => {
  const { proposalId, invoiceId } = await seed();
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    out = await upgradeDepositInvoiceToFull(proposalId, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  assert.ok(out, 'returns the updated row');
  assert.equal(out.id, invoiceId);
  const inv = await invoice(invoiceId);
  assert.equal(inv.label, 'Full Payment');
  assert.equal(Number(inv.amount_due), 55000);
  assert.equal(Number(inv.amount_paid), 0, 'no money moved; that is the link step');
  assert.equal(inv.status, 'sent');
  assert.equal(inv.locked, false);
  // Cast the DATE to text and compare the calendar string, the read
  // rescheduleProposal.test.js uses. No setTypeParser is registered in this repo,
  // so pg parses oid 1082 with postgres-date, which builds a JS Date at LOCAL
  // midnight; new Date(...).toISOString().slice(0, 10) therefore lands on the
  // PRIOR day in any session timezone ahead of UTC.
  const dueYmd = (await pool.query('SELECT due_date::text AS ymd FROM invoices WHERE id = $1', [invoiceId])).rows[0].ymd;
  assert.equal(dueYmd, '2026-09-12', 'same shape createInvoiceOnSend gives a native Full Payment');
  assert.equal(inv.invoice_number, `UPG${NONCE}1`, 'the invoice number never changes');
  const lines = (await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [invoiceId])).rows;
  assert.ok(lines.length >= 1, 'lines regenerated from the snapshot');
  assert.equal(lines[0].description, 'The Core Reaction');
  const bc = await breadcrumbs(proposalId);
  assert.equal(bc.length, 1);
  assert.equal(bc[0].details.invoice_id, invoiceId);
  assert.equal(bc[0].details.from_amount_due, 10000);
  assert.equal(bc[0].details.to_amount_due, 55000);
});

test('external_paid is netted out of the re-derived amount', async () => {
  const { proposalId, invoiceId } = await seed({ externalPaid: 100 });
  await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c));
  assert.equal(Number((await invoice(invoiceId)).amount_due), 45000);
});

test('guard: a Deposit with money on it is never touched', async () => {
  await expectUntouched(await seed({ status: 'partially_paid', invoiceAmountPaid: 5000 }), 'Deposit');
});

test('guard: a locked Deposit is never touched', async () => {
  await expectUntouched(await seed({ locked: true }), 'Deposit');
});

test('guard: a void Deposit is never touched', async () => {
  await expectUntouched(await seed({ status: 'void' }), 'Deposit');
});

test('guard: a Balance or Full Payment invoice is not a Deposit', async () => {
  await expectUntouched(await seed({ label: 'Balance' }), 'Balance');
  await expectUntouched(await seed({ label: 'Full Payment' }), 'Full Payment');
});

test('guard: a proposal with no invoice at all returns null and writes nothing', async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Upgrade Test', $1) RETURNING id`, [`upg-none-${NONCE}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, 'accepted', 550, 0, 100, CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  assert.equal(await inTx((c) => upgradeDepositInvoiceToFull(p.rows[0].id, c)), null);
  assert.equal((await breadcrumbs(p.rows[0].id)).length, 0);
});

test('refuses to run without the caller transaction client', async () => {
  // Off the pool the UPDATE, the line rewrite and the breadcrumb would be three
  // separate commits, and the total_price read would be unserialized.
  await assert.rejects(() => upgradeDepositInvoiceToFull(1), /requires the caller transaction client/);
});

test('a confirmed or completed proposal is never relabelled (the credit rails skip those too)', async () => {
  const { proposalId, invoiceId } = await seed();
  await pool.query("UPDATE proposals SET status = 'confirmed' WHERE id = $1", [proposalId]);
  assert.equal(await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c)), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit');
  assert.equal((await breadcrumbs(proposalId)).length, 0);
});

test('a cancelled proposal is never relabelled (its promised refund reads the retainer off this row)', async () => {
  const { proposalId, invoiceId } = await seed();
  await pool.query('UPDATE proposals SET cancelled_at = NOW() WHERE id = $1', [proposalId]);
  assert.equal(await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c)), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit');
});

test('money the proposal already held is never re-billed: the helper declines and the old link path runs', async () => {
  const { proposalId, invoiceId } = await seed();
  // $200 recorded before the invoice existed (a draft-time admin record), so
  // amount_paid holds money this Deposit invoice never saw.
  await pool.query('UPDATE proposals SET amount_paid = 200 WHERE id = $1', [proposalId]);
  assert.equal(await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c, { paymentCents: 0 })), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit');
  // The caller's own payment, already credited, is not "prior" money.
  await pool.query('UPDATE proposals SET amount_paid = 550 WHERE id = $1', [proposalId]);
  const out = await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c, { paymentCents: 55000 }));
  assert.ok(out, 'a fresh full payment that is the only money still upgrades');
  assert.equal(out.label, 'Full Payment');
});

test('nothing owed means nothing to relabel', async () => {
  const { proposalId, invoiceId } = await seed({ externalPaid: 550 });
  assert.equal(await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c)), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit', 'a zero-due sent row would refuse every later link');
});

test('lines that do not sum to the money stay as they were, and the breadcrumb says so', async () => {
  const { proposalId, invoiceId } = await seed();
  // An override moves total_price off the snapshot the generator builds from.
  await pool.query('UPDATE proposals SET total_price = 999 WHERE id = $1', [proposalId]);
  // A real old line, so the assertion proves survival rather than "nothing was ever written".
  await pool.query(
    `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
     VALUES ($1, 'Deposit', 1, 10000, 10000, 'manual')`, [invoiceId]);
  const linesBefore = (await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [invoiceId])).rows;
  assert.equal(linesBefore.length, 1);
  const out = await inTx((c) => upgradeDepositInvoiceToFull(proposalId, c));
  assert.equal(out.label, 'Full Payment');
  assert.equal(Number(out.amount_due), 99900, 'the money is re-derived from the proposal');
  // (The lines sum to the snapshot's 550, not the 999 contract, so they stay.)
  const linesAfter = (await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [invoiceId])).rows;
  assert.deepEqual(linesAfter, linesBefore, 'lines that would contradict the total are not written');
  const bc = await breadcrumbs(proposalId);
  assert.equal(bc[0].details.lines_regenerated, false);
  assert.equal(bc[0].details.lines_skipped_reason, 'generated_sum_mismatch');
});
