require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { purgeExpiredPendingEmailChanges } = require('./pendingEmailChangeCleanup');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let userId;

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'pec-cleanup-test-%'");
  const hash = await bcrypt.hash('x', 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`pec-cleanup-test-${NONCE}@example.com`, hash]
  );
  userId = u.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM pending_email_changes WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('purgeExpiredPendingEmailChanges > deletes rows consumed_at NOT NULL', async () => {
  await pool.query('DELETE FROM pending_email_changes WHERE user_id = $1', [userId]);

  // Three rows: consumed (delete), expired-recent (keep — still inside 7 day grace),
  // expired-stale (delete: expires_at older than NOW - 7 days), and fresh (keep).
  await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at, consumed_at)
     VALUES
       ($1, $2, $3, NOW() + INTERVAL '24 hours', NOW()),
       ($1, $4, $5, NOW() - INTERVAL '1 hour', NULL),
       ($1, $6, $7, NOW() - INTERVAL '8 days', NULL),
       ($1, $8, $9, NOW() + INTERVAL '24 hours', NULL)`,
    [
      userId,
      `consumed-${NONCE}@example.com`, crypto.randomBytes(32).toString('hex'),
      `expired-recent-${NONCE}@example.com`, crypto.randomBytes(32).toString('hex'),
      `expired-stale-${NONCE}@example.com`, crypto.randomBytes(32).toString('hex'),
      `fresh-${NONCE}@example.com`, crypto.randomBytes(32).toString('hex'),
    ]
  );

  const n = await purgeExpiredPendingEmailChanges();
  assert.ok(n >= 2, `expected to delete at least 2 rows, got ${n}`);

  // The fresh and expired-recent rows survive.
  const { rows } = await pool.query(
    `SELECT new_email FROM pending_email_changes WHERE user_id = $1 ORDER BY new_email`,
    [userId]
  );
  const surviving = rows.map((r) => r.new_email);
  assert.ok(surviving.includes(`fresh-${NONCE}@example.com`), 'fresh survives');
  assert.ok(surviving.includes(`expired-recent-${NONCE}@example.com`), 'recently-expired survives 7-day grace');
  assert.ok(!surviving.includes(`consumed-${NONCE}@example.com`), 'consumed purged');
  assert.ok(!surviving.includes(`expired-stale-${NONCE}@example.com`), 'old-expired purged');
});
