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

const adminNotifications = require('./adminNotifications');

test('recipients carry the kind switches and the subscription count', async () => {
  await pool.query(
    `UPDATE users SET admin_push_preferences = '{"staffing_drop": false}'::jsonb,
       staff_notification_preferences = jsonb_set(staff_notification_preferences, '{push_subscriptions}', '[{"endpoint":"https://push.example.test/a","keys":{"p256dh":"p","auth":"a"}}]'::jsonb, true)
     WHERE id = $1`, [adminA]
  );
  const rows = await resolveCategoryRecipients('system_error');
  const a = rows.find((r) => r.id === adminA);
  assert.deepEqual(a.admin_push_preferences, { staffing_drop: false });
  assert.equal(a.push_subscription_count, 1);
  const b = rows.find((r) => r.id === adminB);
  assert.deepEqual(b.admin_push_preferences, {});
  assert.equal(b.push_subscription_count, 0);
});

test('the push leg: category gate, then the kind switch, then a subscription; fire-and-forget; never throws', async () => {
  // The dev DB is shared: a real admin or manager may hold a subscription, so
  // nothing here asserts a total. Only the fixtures' presence or absence counts.
  const sent = [];
  const pushedTo = (id) => sent.some((s) => s.userId === id);
  adminNotifications.__setDeps({ sendPushToUser: async (args) => { await Promise.resolve(); sent.push(args); return { subscriptions: 1, sent: 1, failed: 0, gone: 0 }; } });
  try {
    // adminA: subscribed to system_error, has a subscription, staffing_drop OFF.
    // adminB: subscribed to system_error, NO subscription.
    // staffC: never a recipient.
    await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'staffing_drop', title: 'T', body: 'B', url: '/events/1', recordId: 1 },
    });
    await adminNotifications.__flushPush();
    assert.ok(!pushedTo(adminA), 'adminA has the kind off');
    assert.ok(!pushedTo(adminB), 'adminB has no subscription');
    assert.ok(!pushedTo(staffC), 'staffC is never a recipient');

    sent.length = 0;
    const r2 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'payment_landed', title: 'T', body: 'B', url: '/events/1', recordId: 1 },
    });
    await adminNotifications.__flushPush();
    assert.ok(r2.pushQueued >= 1, 'adminA is queued at least');
    assert.ok(pushedTo(adminA), 'adminA has the kind on and a subscription');
    assert.ok(!pushedTo(adminB), 'adminB still has no subscription');
    assert.ok(!pushedTo(staffC), 'staffC is never a recipient');
    const toA = sent.find((s) => s.userId === adminA);
    assert.equal(toA.tag, 'payment_landed:1');
    assert.equal(toA.url, '/events/1');
    assert.equal(toA.surface, 'admin', 'the admin channel sends only to admin-phone entries');

    // The category gate comes first: adminA is NOT subscribed to urgent_booking.
    sent.length = 0;
    await adminNotifications.notifyAdminCategory({
      category: 'urgent_booking', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'payment_landed', title: 'T', body: 'B', url: '/events/1', recordId: 1 },
    });
    await adminNotifications.__flushPush();
    assert.ok(!pushedTo(adminA), 'adminA is not subscribed to urgent_booking');
    assert.ok(!pushedTo(adminB), 'adminB is subscribed but holds no subscription');

    // No push block: nothing is pushed whatever the category.
    sent.length = 0;
    const r4 = await adminNotifications.notifyAdminCategory({ category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't' });
    await adminNotifications.__flushPush();
    assert.equal(r4.pushQueued, 0);
    assert.equal(sent.length, 0);

    // An unknown kind is dropped, not thrown.
    const r5 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'routine_thumbtack', title: 'T', body: 'B', url: '/' },
    });
    await adminNotifications.__flushPush();
    assert.equal(r5.pushQueued, 0);
    assert.equal(sent.length, 0);

    // A sender that throws never reaches the caller.
    adminNotifications.__setDeps({ sendPushToUser: async () => { await Promise.resolve(); throw new Error('push service down'); } });
    const r6 = await adminNotifications.notifyAdminCategory({
      category: 'system_error', subject: 's', emailHtml: '<p>h</p>', emailText: 't',
      push: { kind: 'payment_landed', title: 'T', body: 'B', url: '/events/1', recordId: 2 },
    });
    assert.ok(r6.pushQueued >= 1, 'adminA is queued at least');
    await adminNotifications.__flushPush();
  } finally {
    adminNotifications.__setDeps({ sendPushToUser: require('./adminPush').sendPushToUser });
  }
});

test('pushAdminKind pushes without emailing or texting', async () => {
  const sent = [];
  adminNotifications.__setDeps({ sendPushToUser: async (args) => { await Promise.resolve(); sent.push(args); return { subscriptions: 1, sent: 1, failed: 0, gone: 0 }; } });
  try {
    const r = await adminNotifications.pushAdminKind({
      category: 'system_error',
      push: { kind: 'drink_plan_submitted', title: 'Drink plan submitted', body: 'Ada · Wedding.', url: '/events/5', recordId: 5 },
    });
    await adminNotifications.__flushPush();
    assert.ok(r.pushQueued >= 1, 'adminA is queued at least');
    const toA = sent.find((s) => s.userId === adminA);
    assert.ok(toA, 'adminA is pushed');
    assert.equal(toA.tag, 'drink_plan_submitted:5');
    assert.ok(!sent.some((s) => s.userId === adminB), 'adminB holds no subscription');
  } finally {
    adminNotifications.__setDeps({ sendPushToUser: require('./adminPush').sendPushToUser });
  }
});
