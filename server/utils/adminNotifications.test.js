require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { resolveCategoryRecipients } = require('./adminNotifications');

let adminA;
let adminB;
let staffC;

before(async () => {
  // adminA: subscribed to payment_failure, has a contractor_profiles phone.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, notification_preferences)
     VALUES ('admin-notif-a@example.com', 'x', 'admin',
       '{"payment_failure":true,"urgent_booking":false,"system_error":true}'::jsonb)
     RETURNING id`
  );
  adminA = a.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone) VALUES ($1, 'Admin A', '5125550001')`,
    [adminA]
  );

  // adminB: NOT subscribed to payment_failure, no contractor_profiles row.
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, notification_preferences)
     VALUES ('admin-notif-b@example.com', 'x', 'manager',
       '{"payment_failure":false,"urgent_booking":true,"system_error":true}'::jsonb)
     RETURNING id`
  );
  adminB = b.rows[0].id;

  // staffC: role 'staff', must never appear regardless of preferences.
  const c = await pool.query(
    `INSERT INTO users (email, password_hash, role, notification_preferences)
     VALUES ('staff-notif-c@example.com', 'x', 'staff',
       '{"payment_failure":true,"urgent_booking":true,"system_error":true}'::jsonb)
     RETURNING id`
  );
  staffC = c.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [adminA]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminA, adminB, staffC]]);
  await pool.end();
});

test('resolveCategoryRecipients > returns only subscribed admins/managers', async () => {
  const recips = await resolveCategoryRecipients('payment_failure');
  const ids = recips.map(r => r.id);
  assert.ok(ids.includes(adminA), 'adminA is subscribed to payment_failure');
  assert.ok(!ids.includes(adminB), 'adminB opted out of payment_failure');
  assert.ok(!ids.includes(staffC), 'staffC is role staff, never included');
});

test('resolveCategoryRecipients > includes the contractor_profiles phone when present', async () => {
  const recips = await resolveCategoryRecipients('payment_failure');
  const a = recips.find(r => r.id === adminA);
  assert.strictEqual(a.phone, '5125550001');
});

test('resolveCategoryRecipients > yields a null phone for an admin with no contractor_profiles row', async () => {
  const recips = await resolveCategoryRecipients('urgent_booking');
  const b = recips.find(r => r.id === adminB);
  assert.ok(b, 'adminB is subscribed to urgent_booking');
  assert.strictEqual(b.phone, null);
});

test('resolveCategoryRecipients > throws on an unknown category', async () => {
  await assert.rejects(() => resolveCategoryRecipients('not_a_category'), /category/);
});
