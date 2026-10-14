require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const pushSender = require('./pushSender');
const adminPush = require('./adminPush');

const NONCE = `${Date.now()}-${process.pid}`;
let userId;
const SUB = (n) => ({ endpoint: `https://push.example.test/${NONCE}/${n}`, keys: { p256dh: 'p', auth: 'a' }, subscribed_at: new Date().toISOString() });

before(async () => {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, staff_notification_preferences)
     VALUES ($1, 'x', 'admin', jsonb_build_object('push_subscriptions', $2::jsonb)) RETURNING id`,
    [`admin-push-${NONCE}@example.com`, JSON.stringify([SUB(1), SUB(2), SUB(3)])]
  );
  userId = r.rows[0].id;
});
after(async () => {
  try {
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  } finally {
    await pool.end();
  }
});

const subsOf = async () => (await pool.query('SELECT staff_notification_preferences->\'push_subscriptions\' AS s FROM users WHERE id = $1', [userId])).rows[0].s;

test('PUSH_KINDS is the seven kinds in the screen order and isPushKind knows only them', () => {
  assert.deepEqual([...adminPush.PUSH_KINDS], ['booking_signed', 'booking_signed_paid', 'payment_landed', 'booking_last_minute', 'drink_plan_submitted', 'staffing_drop', 'staffing_cover_swap']);
  assert.equal(adminPush.isPushKind('staffing_drop'), true);
  assert.equal(adminPush.isPushKind('routine_thumbtack'), false);
  assert.equal(adminPush.isPushKind('constructor'), false);
});

test('pushTag is kind plus record id, so a retry replaces its own banner', () => {
  assert.equal(adminPush.pushTag('payment_landed', 42), 'payment_landed:42');
  assert.equal(adminPush.pushTag('payment_landed', null), 'payment_landed');
});

test('publicKey is null unless BOTH VAPID keys are set', () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub'; delete process.env.VAPID_PRIVATE_KEY;
  assert.equal(adminPush.publicKey(), null);
  process.env.VAPID_PRIVATE_KEY = 'priv';
  assert.equal(adminPush.publicKey(), 'pub');
  [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
  if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
  if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
});

test('sendPushToUser sends to every subscription, counts, and prunes only the gone ones', async () => {
  const calls = [];
  const real = pushSender.sendPush;
  pushSender.sendPush = async ({ subscription, title, tag }) => {
    await Promise.resolve();
    calls.push({ endpoint: subscription.endpoint, title, tag });
    if (subscription.endpoint.endsWith('/2')) return { ok: false, gone: true };
    if (subscription.endpoint.endsWith('/3')) return { ok: false, error: 'boom' };
    return { ok: true };
  };
  try {
    const out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/events/1', tag: 'payment_landed:1' });
    assert.deepEqual(out, { subscriptions: 3, sent: 1, failed: 1, gone: 1, readFailed: false });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].tag, 'payment_landed:1');
    const left = await subsOf();
    assert.deepEqual(left.map((s) => s.endpoint.slice(-2)), ['/1', '/3']);
  } finally { pushSender.sendPush = real; }
});

test('sendPushToUser resolves its counts even when the prune cannot get a connection', async () => {
  await pool.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(staff_notification_preferences, '{push_subscriptions}', $2::jsonb, true) WHERE id = $1`,
    [userId, JSON.stringify([SUB(1), SUB(2), SUB(3)])]
  );
  const realSend = pushSender.sendPush;
  const realConnect = pool.connect;
  pushSender.sendPush = async ({ subscription }) => {
    await Promise.resolve();
    if (subscription.endpoint.endsWith('/2')) return { ok: false, gone: true };
    if (subscription.endpoint.endsWith('/3')) return { ok: false, error: 'boom' };
    return { ok: true };
  };
  // Only the promise form rejects (the prune's own pool.connect()). pool.query
  // calls connect with a callback internally, so that form keeps working and
  // the subscription read still succeeds.
  pool.connect = function connect(cb) {
    if (typeof cb === 'function') return realConnect.call(this, cb);
    return Promise.reject(new Error('pool saturated'));
  };
  let out;
  try {
    out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/events/1', tag: 'payment_landed:1' });
  } finally {
    pool.connect = realConnect;
    pushSender.sendPush = realSend;
  }
  assert.deepEqual(out, { subscriptions: 3, sent: 1, failed: 1, gone: 1, readFailed: false });
  const left = await subsOf();
  assert.deepEqual(left.map((s) => s.endpoint.slice(-2)), ['/1', '/2', '/3'], 'the prune could not run, so the gone one is still stored');
});

test('sendPushToUser with no subscriptions sends nothing and says so', async () => {
  const r = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'manager') RETURNING id`, [`admin-push-none-${NONCE}@example.com`]);
  try {
    const out = await adminPush.sendPushToUser({ userId: r.rows[0].id, title: 'T', body: 'B', url: '/' });
    assert.deepEqual(out, { subscriptions: 0, sent: 0, failed: 0, gone: 0, readFailed: false });
  } finally { await pool.query('DELETE FROM users WHERE id = $1', [r.rows[0].id]); }
});

test('sendPushToUser never throws: a failed read returns zeros', async () => {
  const out = await adminPush.sendPushToUser({ userId: 'not-a-number', title: 'T', body: 'B', url: '/' });
  const { error, ...rest } = out;
  // Zero counts like "no subscriptions", but flagged, so the caller can tell a
  // failed read from a true answer.
  assert.deepEqual(rest, { subscriptions: 0, sent: 0, failed: 0, gone: 0, readFailed: true });
  assert.equal(typeof error, 'string');
  assert.ok(error.length > 0);
});

// One user can hold an admin-phone entry and a staff-portal entry. Each
// channel sends only to its own, and the prune still re-reads the whole array
// and removes by endpoint, so a gone entry of either surface goes and the
// other surface's entry stays.
test('sendPushToUser sends only to the named surface, and the prune removes a gone entry of either', async () => {
  const ADMIN_SUB = { ...SUB('admin'), surface: 'admin' };
  const STAFF_SUB = SUB('staff');
  const seed = () => pool.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(staff_notification_preferences, '{push_subscriptions}', $2::jsonb, true) WHERE id = $1`,
    [userId, JSON.stringify([ADMIN_SUB, STAFF_SUB])]
  );
  await seed();
  const real = pushSender.sendPush;
  let calls = [];
  let answer = { ok: true };
  pushSender.sendPush = async ({ subscription }) => { await Promise.resolve(); calls.push(subscription.endpoint); return answer; };
  try {
    let out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/', surface: 'admin' });
    assert.deepEqual(calls, [ADMIN_SUB.endpoint]);
    assert.equal(out.subscriptions, 1);
    assert.equal(out.sent, 1);
    calls = [];
    out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/', surface: 'staff' });
    assert.deepEqual(calls, [STAFF_SUB.endpoint]);
    assert.equal(out.subscriptions, 1);

    answer = { ok: false, gone: true };
    calls = [];
    out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/', surface: 'admin' });
    assert.equal(out.gone, 1);
    assert.deepEqual((await subsOf()).map((x) => x.endpoint), [STAFF_SUB.endpoint], 'the gone admin entry goes; the staff entry the admin read never saw stays');

    await seed();
    calls = [];
    out = await adminPush.sendPushToUser({ userId, title: 'T', body: 'B', url: '/', surface: 'staff' });
    assert.equal(out.gone, 1);
    const left = await subsOf();
    assert.deepEqual(left.map((x) => x.endpoint), [ADMIN_SUB.endpoint], 'the gone staff entry goes; the admin entry stays');
    assert.equal(left[0].surface, 'admin');
  } finally { pushSender.sendPush = real; }
});

test('deleteAllSubscriptions empties the array and keeps the rest of the blob', async () => {
  await pool.query(`UPDATE users SET staff_notification_preferences = jsonb_set(staff_notification_preferences, '{quiet_hours}', '"22:00-08:00"') WHERE id = $1`, [userId]);
  await adminPush.deleteAllSubscriptions(userId);
  const row = (await pool.query('SELECT staff_notification_preferences AS p FROM users WHERE id = $1', [userId])).rows[0].p;
  assert.deepEqual(row.push_subscriptions, []);
  assert.equal(row.quiet_hours, '22:00-08:00');
});

test('pushCopy builds a path url, a tag-able record id, and never an em dash', () => {
  const c = adminPush.pushCopy;
  const all = [
    c.bookingSigned({ clientName: 'Ada', eventTypeLabel: 'Wedding', proposalId: 7, dateLabel: 'Saturday, October 18' }),
    c.bookingSignedPaid({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$1,200.00', proposalId: 7 }),
    c.paymentLanded({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$500.00', paymentType: 'balance', proposalId: 7 }),
    c.bankPaymentStarted({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$100.00', initial: true, proposalId: 7 }),
    c.bankPaymentStarted({ clientName: 'Ada', eventTypeLabel: 'Wedding', amount: '$900.00', initial: false, proposalId: 7 }),
    c.lastMinuteBooking({ eventTypeLabel: 'Wedding', date: 'Sat, Oct 18', time: '6:00 PM', proposalId: 7 }),
    c.drinkPlanSubmitted({ clientName: 'Ada', eventTypeLabel: 'Wedding', proposalId: 7 }),
    c.staffingDrop({ clientName: 'Ada', eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Bartender', proposalId: 7, shiftId: 99 }),
    c.staffingCover({ clientName: 'Ada', eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Bartender', proposalId: null, shiftId: 99 }),
    c.staffingSwap({ clientName: null, eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Barback', proposalId: 7, shiftId: 99 }),
  ];
  assert.deepEqual(all.map((x) => x.kind), ['booking_signed', 'booking_signed_paid', 'payment_landed', 'booking_signed_paid', 'payment_landed', 'booking_last_minute', 'drink_plan_submitted', 'staffing_drop', 'staffing_cover_swap', 'staffing_cover_swap']);
  assert.equal(all[0].url, '/proposals/7');
  assert.equal(all[1].url, '/events/7');
  assert.equal(all[8].url, '/staffing');
  assert.equal(all[7].recordId, 99);
  for (const x of all) {
    assert.ok(x.title && x.body, JSON.stringify(x));
    assert.doesNotMatch(x.title + x.body, /\u2014/);
  }
  assert.match(all[3].title, /started/i);
  assert.doesNotMatch(all[3].body, /landed/i);
  assert.match(all[0].body, / · Saturday, October 18$/, 'the date ends the body when the site has it');
  assert.doesNotMatch(all[1].body, /undefined|null/, 'no date, no trace of one');

  // The client name and the event kind come from the public quote form, so a
  // banner clamps them: names to 60 characters, kinds to 40, cut with an ellipsis.
  const longName = c.bookingSigned({ clientName: 'N'.repeat(200), eventTypeLabel: 'K'.repeat(100), proposalId: 7 });
  assert.ok(longName.title.length <= 70, `title is ${longName.title.length} characters`);
  assert.equal(longName.title, `${'N'.repeat(59)}\u2026 signed`, 'the name part ends in the ellipsis');
  assert.equal(longName.body, `${'K'.repeat(39)}\u2026. Open the proposal.`, 'the kind part is clipped to 40');
  const longStaff = c.staffingDrop({ clientName: 'N'.repeat(200), eventTypeLabel: 'Wedding', dateLabel: 'Oct 18', position: 'Bartender', proposalId: 7, shiftId: 99 });
  assert.equal(longStaff.body, `Wedding for ${'N'.repeat(59)}\u2026 · Bartender. Needs restaffing.`, 'the staffing builders clamp the name too');
  // The clip counts code points: 58 x plus three emoji is 61, so the 60 cap
  // cuts between the emoji, and the kept one stays whole (a UTF-16 cut at 59
  // would keep half of the first one, a lone surrogate).
  const emojiName = c.bookingSigned({ clientName: `${'x'.repeat(58)}\u{1F600}\u{1F600}\u{1F600}`, eventTypeLabel: 'Wedding', proposalId: 7 });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiName.title), `no lone surrogate in ${JSON.stringify(emojiName.title)}`);
  assert.match(emojiName.title, /\u2026 signed$/, 'the name part ends in the ellipsis');
  assert.equal(emojiName.title, `${'x'.repeat(58)}\u{1F600}\u2026 signed`, 'the cut keeps one whole emoji');
});
