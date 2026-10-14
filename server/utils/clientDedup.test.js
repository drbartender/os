require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { findOrCreateClient } = require('./clientDedup');

// Each test runs inside its own BEGIN/ROLLBACK, so nothing it inserts is
// committed to the shared dev DB — no cleanup needed beyond the rollback.

test('phone-only row then email proposal-create resolves to ONE client (the Jim case)', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Simulate the Thumbtack phone-only lead.
    const a = await findOrCreateClient(db, { name: 'Dupe Test', phone: '(555) 010-2929', source: 'thumbtack' });
    // Simulate the later admin proposal-create with name + email + same phone.
    const b = await findOrCreateClient(db, { name: 'Dupe Test', email: 'DupeTest@example.com', phone: '555-010-2929', source: 'direct' });
    assert.strictEqual(b, a, 'should reuse the phone-only row, not create a second');
    const row = await db.query('SELECT email FROM clients WHERE id = $1', [a]);
    assert.strictEqual(row.rows[0].email, 'dupetest@example.com', 'email backfilled onto the phone-only row');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('different name on a shared phone does NOT merge', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const a = await findOrCreateClient(db, { name: 'Person One', phone: '555-010-3030', source: 'thumbtack' });
    const b = await findOrCreateClient(db, { name: 'Person Two', phone: '555-010-3030', source: 'thumbtack' });
    assert.notStrictEqual(b, a, 'name guard prevents merging two people on one phone');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('same email (case-insensitive) reuses the row and does NOT overwrite the name', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const a = await findOrCreateClient(db, { name: 'Email Match', email: 'emailmatch@example.com' });
    const b = await findOrCreateClient(db, { name: 'Different Name', email: 'EmailMatch@example.com' });
    assert.strictEqual(b, a, 'same email reuses the existing client');
    const row = await db.query('SELECT name FROM clients WHERE id = $1', [a]);
    assert.strictEqual(row.rows[0].name, 'Email Match', 'existing name is preserved (backfill-only, no takeover)');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('email match does NOT backfill a submitted phone (public-wizard takeover guard)', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Existing email-only row with a NULL phone (e.g. a marketing lead).
    const a = await findOrCreateClient(db, { name: 'Victim', email: 'victim@example.com' });
    // An unauthenticated public submit reusing the victim's email + an attacker phone.
    const b = await findOrCreateClient(db, { name: 'Whoever', email: 'Victim@example.com', phone: '555-010-9999' });
    assert.strictEqual(b, a, 'email match still resolves to the same row');
    const row = await db.query('SELECT phone FROM clients WHERE id = $1', [a]);
    assert.strictEqual(row.rows[0].phone, null, 'attacker phone must NOT be stamped onto an email-matched row');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

// ─── Trusted phone match (the Thumbtack webhook) ────────────────────
// Thumbtack never sends an email, so a customer whose first lead was harvested
// comes back as name + phone only. The public-wizard guard below (phone + name
// may only resolve an EMAIL-LESS row) would re-create them; the webhook is
// authenticated and the identity comes from Thumbtack's own account, so it may
// pass trustedPhoneMatch and resolve the harvested row too.

test('trusted phone match: a repeat Thumbtack lead resolves to the harvested client, email untouched', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // The first lead was harvested: the row carries an email now.
    const a = await findOrCreateClient(db, { name: 'Repeat Lead', email: 'repeatlead@example.com', phone: '555-010-4040', source: 'thumbtack' });
    // A month later the same person comes back through Thumbtack: name + phone. The webhook
    // passes no email; a different one is passed HERE only to prove the matched row's email
    // survives even if a trusted caller ever did submit one.
    const b = await findOrCreateClient(db, { name: 'Repeat Lead', email: 'repeatlead.other@example.com', phone: '(555) 010-4040', source: 'thumbtack', trustedPhoneMatch: true });
    assert.strictEqual(b, a, 'the webhook resolves to the existing client instead of creating a second row');
    const row = await db.query('SELECT email FROM clients WHERE id = $1', [a]);
    assert.strictEqual(row.rows[0].email, 'repeatlead@example.com', 'the harvested email is never overwritten');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('trusted phone match prefers the row that carries an email over an email-less dup on the same phone', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const a1 = await findOrCreateClient(db, { name: 'Dup Pair', email: 'duppair@example.com', phone: '555-010-5050', source: 'thumbtack' });
    // In prod the harvested original is OLDER than the dup; NOW() is fixed inside one
    // transaction, so backdate it or the two rows would tie on created_at.
    await db.query("UPDATE clients SET created_at = NOW() - interval '30 days' WHERE id = $1", [a1]);
    // The untrusted path refuses a1 (it has an email) and inserts a second row: the old bug shape.
    const a2 = await findOrCreateClient(db, { name: 'Dup Pair', phone: '555-010-5050', source: 'thumbtack' });
    assert.notStrictEqual(a2, a1, 'setup: the untrusted path still creates the dup (that is the guard)');
    const b = await findOrCreateClient(db, { name: 'Dup Pair', phone: '555-010-5050', source: 'thumbtack', trustedPhoneMatch: true });
    assert.strictEqual(b, a1, 'the trusted match lands on the row with the email, not the newer email-less dup');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('trusted phone match only reaches a Thumbtack-sourced row: an email-bearing website client is left alone', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // A website-first client with an email, same name + phone as the incoming Thumbtack lead.
    const a = await findOrCreateClient(db, { name: 'Website First', email: 'websitefirst@example.com', phone: '555-010-8080', source: 'website' });
    const b = await findOrCreateClient(db, { name: 'Website First', phone: '555-010-8080', source: 'thumbtack', trustedPhoneMatch: true });
    assert.notStrictEqual(b, a, 'the trusted match is scoped to rows the Thumbtack webhook itself created (source thumbtack)');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

// Guard (passes before and after the trusted flag exists): the name check is not relaxed.
test('trusted phone match still requires the name (one phone, two people)', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const a = await findOrCreateClient(db, { name: 'Phone Owner', email: 'phoneowner@example.com', phone: '555-010-6060', source: 'thumbtack' });
    const b = await findOrCreateClient(db, { name: 'Someone Else', phone: '555-010-6060', source: 'thumbtack', trustedPhoneMatch: true });
    assert.notStrictEqual(b, a, 'a different name on the same phone is a new client even on the trusted path');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

// Guard (passes before and after): the public path never gains the trusted behavior.
test('the default (public) path still refuses to attach to an email-bearing row by phone + name', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const a = await findOrCreateClient(db, { name: 'Guarded Row', email: 'guarded@example.com', phone: '555-010-7070', source: 'direct' });
    const b = await findOrCreateClient(db, { name: 'Guarded Row', phone: '555-010-7070', source: 'direct' });
    assert.notStrictEqual(b, a, 'without the trusted flag, phone + name never resolves an email-bearing row (public-wizard takeover guard)');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

after(async () => {
  await pool.end();
});
