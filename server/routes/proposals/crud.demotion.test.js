require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cr-demote-%-${NONCE}@example.com`;
let server, baseUrl, adminToken, pkgId;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  const u = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager') LIMIT 1");
  assert.ok(u.rows[0], 'need an admin/manager user seeded');
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  // Pick a per_guest, non-class package so a guest_count bump actually moves
  // the calculated total; flat-priced (BYOB) packages would no-op on this PATCH.
  const p = await pool.query("SELECT id FROM service_packages WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class' ORDER BY id LIMIT 1");
  assert.ok(p.rows[0], 'need an active per_guest, non-class package');
  pkgId = p.rows[0].id;
  const app = express(); app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use((err, rq, rs, nx) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposal_addons WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)', [EMAIL_LIKE]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('confirmed proposal STAYS confirmed when a guest bump outruns amount_paid (merge decision A: lifecycle untouched; delta billed via the Additional Services invoice)', async () => {
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', ['CR Demote', `cr-demote-a-${NONCE}@example.com`]);
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1,'confirmed',$2,100,4,1,4800,1000,'{}') RETURNING id`, [c.rows[0].id, pkgId]);
  const res = await req('PATCH', `/api/proposals/${pr.rows[0].id}`, adminToken, { guest_count: 300 });
  assert.equal(res.status, 200);
  // Decision A (reconcileProposalPaymentStatus): 'confirmed' is a lifecycle state,
  // not demoted by a price move; the price delta is collected via the post-commit
  // Additional Services invoice rather than by reverting the status.
  assert.equal(res.body.status, 'confirmed');
});

// Round 3 M1 (2026-11-05): the PATCH ladder nets the off-contract money. The
// M2 shape, a deposit_paid row holding 16000 of which 6000 is a paid
// syrup-only Drink Plan Extras invoice against a 15000 contract, stayed
// deposit_paid on the webhook and now stays deposit_paid on an admin save too.
test('M1: a save on a row holding paid syrup money beside the deposit stays deposit_paid (the ladder nets the term)', async () => {
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', ['CR Netted', `cr-demote-net-${NONCE}@example.com`]);
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1,'deposit_paid',$2,100,4,1,4800,4850,'{}') RETURNING id`, [c.rows[0].id, pkgId]);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, folded_into_total)
     VALUES ($1, $2, 'Drink Plan Extras', 6000, 6000, 'paid', true, false) RETURNING id`,
    [pr.rows[0].id, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  try {
    // A same-count save: the engine prices 100 guests again, and the flag is
    // judged against the total it commits. 4850 paid, 60 of it syrup money.
    const res = await req('PATCH', `/api/proposals/${pr.rows[0].id}`, adminToken, { guest_count: 100 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = (await pool.query('SELECT status, total_price FROM proposals WHERE id = $1', [pr.rows[0].id])).rows[0];
    const totalCents = Math.round(Number(row.total_price) * 100);
    assert.ok(485000 >= totalCents, 'premise: the raw read (4850 >= total) would promote; re-seed if the package price moved');
    assert.equal(row.status, 479000 >= totalCents ? 'balance_paid' : 'deposit_paid', 'the flag follows 4790 of contract money, not 4850');
    assert.equal(res.body.status, row.status);
  } finally {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [inv.rows[0].id]);
    await pool.query('DELETE FROM invoices WHERE id = $1', [inv.rows[0].id]);
  }
});
