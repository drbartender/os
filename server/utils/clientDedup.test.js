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

after(async () => {
  await pool.end();
});
