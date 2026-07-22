'use strict';

// Notice detection + the notify contract on PATCH /api/proposals/:id,
// POST /api/proposals/:id/notify-preflight, and record-payment.
// Runs ALONE against the shared dev DB:
//   node -r dotenv/config --test server/routes/proposals/notifyClient.test.js
// Route harness mirrors comms.silent.test.js (express + node:http, AppError
// error middleware; no supertest in this repo).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
// Registers event_week_reminder & friends with the dispatcher registry —
// without registerAll() the in-tx re-anchor no-ops on "no handler metadata"
// (the server boot calls it in prod; mirrors rescheduleProposal.test.js:30).
require('../../utils/preEventHandlers').registerAll();

const { isPlaceholderEmail } = require('../../utils/emailValidation');
const { resolvePendingLocation } = require('../../utils/venueAddress');
const {
  RESCHEDULABLE_FIELDS, reschedulableStatusOk, computeProjectedBalanceDue,
} = require('../../utils/rescheduleProposal');
const {
  NOTICE_EVENT_DETAILS, eventDetailsNoticeApplies, validateNotifyList,
} = require('../../utils/clientNotices');

// ValidationError puts field text in .fieldErrors, NEVER .message (errors.js).
// Every throws-assertion in this file matches on fieldErrors.
function throwsField(fn, field, re) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'ValidationError');
    assert.match(String(err.fieldErrors?.[field] ?? ''), re);
    return true;
  });
}

test('RESCHEDULABLE_FIELDS is the canonical three-field list', () => {
  assert.deepEqual(RESCHEDULABLE_FIELDS, ['event_date', 'event_start_time', 'event_location']);
});

test('isPlaceholderEmail: .invalid is a placeholder, real mail is not', () => {
  assert.equal(isPlaceholderEmail('jane@ccimport.invalid'), true);
  assert.equal(isPlaceholderEmail('JANE@CCIMPORT.INVALID  '), true);
  assert.equal(isPlaceholderEmail('jane@gmail.com'), false);
  assert.equal(isPlaceholderEmail(null), false);
  assert.equal(isPlaceholderEmail(''), false);
});

test('resolvePendingLocation: venue parts merge over the stored row like the save does', () => {
  const old = {
    venue_name: 'The Ivy Room', venue_street: null, venue_city: 'Chicago',
    venue_state: 'Illinois', venue_zip: null,
    event_location: 'The Ivy Room, Chicago, Illinois',
  };
  // Street-only edit: merged with stored name/city/state (crud.js mergedVenue semantics).
  const loc = resolvePendingLocation(old, { venue_street: '2700 W Chicago Ave' });
  assert.match(loc, /2700 W Chicago Ave/);
  assert.match(loc, /The Ivy Room/);
  // State abbreviations canonicalize exactly as the save does (event-editor fix).
  const abbrev = resolvePendingLocation(old, { venue_state: 'IL' });
  assert.match(abbrev, /Illinois/);
  assert.doesNotMatch(abbrev, /, IL(,|$)/);
  // No venue keys in the body: null (caller falls back to body.event_location ?? old).
  assert.equal(resolvePendingLocation(old, { guest_count: 50 }), null);
});

test('reschedulableStatusOk mirrors the InTx gate', () => {
  assert.equal(reschedulableStatusOk('deposit_paid'), true);
  assert.equal(reschedulableStatusOk('balance_paid'), true);
  assert.equal(reschedulableStatusOk('sent'), false);
  assert.equal(reschedulableStatusOk('archived'), false);
  assert.equal(reschedulableStatusOk(undefined), false);
});

test('computeProjectedBalanceDue mirrors BOTH in-tx branches', () => {
  // Offset-preserving branch (14-day lead survives the move).
  assert.equal(computeProjectedBalanceDue('2026-09-01', '2026-08-18', '2026-09-15'), '2026-09-01');
  // No prior due date: the save applies the codebase default event_date - 14d,
  // so the projection MUST match that, not return null (same-function law).
  assert.equal(computeProjectedBalanceDue('2026-09-01', null, '2026-09-15'), '2026-09-01');
  // Date unchanged: the save writes nothing; projection is null.
  assert.equal(computeProjectedBalanceDue('2026-09-01', '2026-08-18', '2026-09-01'), null);
  assert.equal(computeProjectedBalanceDue(null, '2026-08-18', '2026-09-01'), null);
});

test('eventDetailsNoticeApplies: booked + reschedulable change only', () => {
  const old = { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'A' };
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old, event_location: 'B' }, status: 'deposit_paid' }), true);
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old, event_start_time: '19:00' }, status: 'deposit_paid' }), true);
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old, event_location: 'B' }, status: 'sent' }), false);
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old, event_location: 'B' }, status: 'archived' }), false);
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old }, status: 'deposit_paid' }), false);
});

test('validateNotifyList: absent/empty is [], junk shapes reject on fieldErrors', () => {
  assert.deepEqual(validateNotifyList(undefined), []);
  assert.deepEqual(validateNotifyList(null), []);
  assert.deepEqual(validateNotifyList([]), []);
  throwsField(() => validateNotifyList('nope'), 'notify', /array/);
  throwsField(() => validateNotifyList([null]), 'notify', /object/);
  throwsField(() => validateNotifyList([{ type: 'gratuity_increase', channels: ['email'] }]), 'notify', /Unknown notice type/);
  throwsField(() => validateNotifyList([
    { type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: 'b' } },
    { type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: 'b' } },
  ]), 'notify', /Duplicate/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: [] }]), 'channels', /at least one/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['carrier_pigeon'] }]), 'channels', /Unknown channel/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email', 'carrier_pigeon'], email: { subject: 's', body_text: 'b' } }]), 'channels', /Unknown channel/);
});

// ── Route harness (preflight + PATCH + record-payment tests) ───────────────

const proposalsRouter = require('./index');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, adminToken2;
let clientId, proposalId, sentProposalId, placeholderClientId, placeholderProposalId, packageId;

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedAdmin(email) {
  const passwordHash = await bcrypt.hash('x', 4);
  const row = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [email, passwordHash]
  );
  return jwt.sign(
    { userId: row.rows[0].id, tokenVersion: row.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
}

before(async () => {
  // TWO admin tokens: adminWriteLimiter is max 10/60s PER admin, and this
  // suite fires more than 10 limited requests. Spread across both.
  adminToken = await seedAdmin(`notify-admin-a-${NONCE}@example.com`);
  adminToken2 = await seedAdmin(`notify-admin-b-${NONCE}@example.com`);

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
    [`Notify Test ${NONCE}`, `notify-${NONCE}@example.test`, '+13125550142']
  );
  clientId = c.rows[0].id;

  // The PATCH re-prices, so fixture proposals need a real package.
  const pkg = await pool.query(`SELECT id FROM service_packages WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`);
  packageId = pkg.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, event_date, event_start_time, event_location,
                            venue_name, venue_city, venue_state,
                            event_timezone, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'The Ivy Room, Chicago, Illinois',
             'The Ivy Room', 'Chicago', 'Illinois',
             'America/Chicago', 1000, 100, '2026-09-01', true)
     RETURNING id`,
    [clientId, packageId]
  );
  proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', '2026-09-08T15:00:00.000Z', 'pending')`,
    [proposalId, clientId]
  );

  const ps = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_start_time, event_location, event_timezone, total_price)
     VALUES ($1, 'sent', '2026-09-20', '18:00', 'Somewhere', 'America/Chicago', 800) RETURNING id`,
    [clientId]
  );
  sentProposalId = ps.rows[0].id;

  const pc = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, NULL) RETURNING id`,
    [`CC Import ${NONCE}`, `ccimport-${NONCE}@ccimport.invalid`]
  );
  placeholderClientId = pc.rows[0].id;
  const pp = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, event_date, event_start_time, event_location, event_timezone, total_price, amount_paid)
     VALUES ($1, $2, 'deposit_paid', '2026-10-01', '17:00', 'Old Hall', 'America/Chicago', 900, 100) RETURNING id`,
    [placeholderClientId, packageId]
  );
  placeholderProposalId = pp.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', proposalsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    console.error('harness 500:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  const ids = [proposalId, sentProposalId, placeholderProposalId, ...payProposalIds].filter(Boolean);
  if (payProposalIds.length) {
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [payProposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [payProposalIds]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [payProposalIds]).catch(() => {});
  }
  if (ids.length) {
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[clientId, placeholderClientId].filter(Boolean)]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`notify-admin-%-${NONCE}@example.com`]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── Preflight (Task 3) ──────────────────────────────────────────────────────

test('preflight: location change on a booked proposal returns the notice with a money-free draft', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { event_location: '2700 W Chicago Ave, Chicago, Illinois' },
  });
  assert.equal(res.status, 200);
  const n = res.body.notices.find((x) => x.type === 'event_details_changed');
  assert.ok(n, 'expected an event_details_changed notice');
  assert.equal(n.composable, true);
  assert.match(n.draft.email.body_text, /2700 W Chicago Ave/);
  assert.doesNotMatch(n.draft.email.body_text, /\$\d/, 'draft must carry no dollar figures');
  assert.deepEqual(n.reasons, ['event_location changed'], 'no phantom event_date reason');
  assert.doesNotMatch(n.draft.sms.body, /in your email/i, 'SMS draft never promises an email');
});

test('preflight: venue-parts-only edit resolves the same location the save would', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { venue_street: '123 Elm St' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.notices.length, 1, 'a street-only edit changes event_location at save time');
  assert.match(res.body.notices[0].draft.email.body_text, /123 Elm St/);
});

test('preflight: date move quotes the projected due date and flags autopay', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { event_date: '2026-12-01' },
  });
  assert.equal(res.status, 200);
  const n = res.body.notices[0];
  // Fixture: due 2026-09-01 = event -14d; projected due for 12-01 = 11-17.
  assert.match(n.draft.email.body_text, /November 17/);
  assert.match(n.autopay_notice, /auto-charge/i);
});

test('preflight: change_request_id present -> zero notices', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken2, body: { event_location: 'Elsewhere', change_request_id: 999999 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notices, []);
});

test('preflight: unrelated edit and unbooked proposal both return zero notices', async () => {
  const a = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken2, body: { guest_count: 90 },
  });
  assert.deepEqual(a.body.notices, []);
  const b = await request('POST', `/api/proposals/${sentProposalId}/notify-preflight`, {
    token: adminToken2, body: { event_location: 'Elsewhere' },
  });
  assert.deepEqual(b.body.notices, []);
});

test('preflight: .invalid email unavailable; endpoint writes nothing; auth required', async () => {
  const res = await request('POST', `/api/proposals/${placeholderProposalId}/notify-preflight`, {
    token: adminToken2, body: { event_location: 'New Hall' },
  });
  assert.equal(res.status, 200);
  const n = res.body.notices[0];
  assert.equal(n.channels.email.available, false);
  assert.match(n.channels.email.unavailable_reason, /placeholder/i);
  assert.equal(n.channels.sms.available, false);

  const before = await pool.query('SELECT event_location, updated_at FROM proposals WHERE id = $1', [proposalId]);
  await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken2, body: { event_location: 'X' },
  });
  const afterRows = await pool.query('SELECT event_location, updated_at FROM proposals WHERE id = $1', [proposalId]);
  assert.deepEqual(afterRows.rows[0], before.rows[0]);

  const noAuth = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, { body: {} });
  assert.equal(noAuth.status, 401);
});

test('validateNotifyList: text rules mirror comms.js caps', () => {
  const out = validateNotifyList([{
    type: NOTICE_EVENT_DETAILS, channels: ['email'],
    email: { subject: 'New\r\ndate', body_text: 'body' },
  }]);
  assert.equal(out[0].email.subject, 'New date');
  assert.equal(out[0].email.bodyText, 'body');
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email'] }]), 'subject', /empty/i);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 'x'.repeat(301), body_text: 'b' } }]), 'subject', /300/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: '  ' } }]), 'body_text', /empty/i);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['sms'], sms: { body: 'x'.repeat(641) } }]), 'sms_body', /640/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['sms'], sms: { body: '  ' } }]), 'sms_body', /empty/i);
});

// ── PATCH notify contract (Task 4) ──────────────────────────────────────────

const crudModule = require('./crud');

test('LOAD-BEARING: date change with no notify list sends nothing but still re-anchors + moves balance_due_date', async () => {
  const calls = [];
  crudModule.__setDeps({ sendRescheduleEmail: async (a) => { calls.push(a); return { email: 'sent', sms: 'skipped', skip_reasons: {} }; } });

  const before = await pool.query(
    "SELECT id, scheduled_for FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending' ORDER BY id",
    [proposalId]
  );
  assert.ok(before.rows.length > 0, 'fixture needs a pending scheduled message');
  const oldDue = (await pool.query('SELECT balance_due_date FROM proposals WHERE id = $1', [proposalId])).rows[0].balance_due_date;

  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken, body: { event_date: '2026-10-15' },
  });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body.notifications, []);
  assert.equal(calls.length, 0, 'nothing may reach the send seam');

  const afterRows = await pool.query(
    "SELECT id, scheduled_for FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending' ORDER BY id",
    [proposalId]
  );
  assert.ok(
    afterRows.rows.some((r, i) => String(r.scheduled_for) !== String(before.rows[i].scheduled_for)),
    're-anchoring must run even when nothing is sent'
  );
  const newDue = (await pool.query('SELECT balance_due_date FROM proposals WHERE id = $1', [proposalId])).rows[0].balance_due_date;
  assert.notEqual(String(newDue), String(oldDue), 'balance_due_date must move with the event date');
});

test('the reviewed text reaches the send seam verbatim, per-channel truth returned', async () => {
  const calls = [];
  crudModule.__setDeps({ sendRescheduleEmail: async (a) => { calls.push(a); return { email: 'sent', sms: 'skipped', skip_reasons: { sms: 'not selected' } }; } });
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: {
      event_location: 'Reviewed Venue, Chicago, Illinois',
      notify: [{
        type: 'event_details_changed', channels: ['email'],
        email: { subject: 'S-REVIEWED', body_text: 'B-REVIEWED' },
      }],
    },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.email.subject, 'S-REVIEWED');
  assert.equal(calls[0].message.email.bodyText, 'B-REVIEWED');
  assert.deepEqual(calls[0].channels, ['email']);
  const entry = res.body.notifications.find((n) => n.type === 'event_details_changed');
  assert.equal(entry.email, 'sent');
});

test('notice without text: 400, nothing saved; notice on untriggering save: 400, rolled back', async () => {
  const beforeLoc = (await pool.query('SELECT event_location FROM proposals WHERE id = $1', [proposalId])).rows[0].event_location;
  const a = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken2,
    body: { event_location: 'Rejected Venue', notify: [{ type: 'event_details_changed', channels: ['email'] }] },
  });
  assert.equal(a.status, 400);
  assert.equal(
    (await pool.query('SELECT event_location FROM proposals WHERE id = $1', [proposalId])).rows[0].event_location,
    beforeLoc,
    'a rejected notify list must not commit the edit'
  );

  const beforeGuests = (await pool.query('SELECT guest_count FROM proposals WHERE id = $1', [proposalId])).rows[0].guest_count;
  const b = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken2,
    body: {
      guest_count: Number(beforeGuests) + 5,
      notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
    },
  });
  assert.equal(b.status, 400);
  assert.ok(b.body.fieldErrors && b.body.fieldErrors.notify, 'the rejection names the notify field');
  assert.equal(
    String((await pool.query('SELECT guest_count FROM proposals WHERE id = $1', [proposalId])).rows[0].guest_count),
    String(beforeGuests),
    'trigger mismatch must roll the transaction back'
  );
});

test('change-request save: requested notice is a 400 (save half of the CR rule)', async () => {
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken2,
    body: {
      event_location: 'CR Venue, Chicago, Illinois',
      change_request_id: 999999,
      notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
    },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.notify);
});

test('suppressed recipient reports skipped even when requested (real send path)', async () => {
  crudModule.__setDeps({ sendRescheduleEmail: require('../../utils/rescheduleProposal').sendRescheduleEmail });
  await pool.query(`UPDATE clients SET communication_preferences = '{"email_enabled": false}'::jsonb WHERE id = $1`, [clientId]);
  try {
    const res = await request('PATCH', `/api/proposals/${proposalId}`, {
      token: adminToken2,
      body: {
        event_location: 'Suppression Venue, Chicago, Illinois',
        notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
      },
    });
    assert.equal(res.status, 200, res.raw);
    const entry = res.body.notifications.find((n) => n.type === 'event_details_changed');
    assert.equal(entry.email, 'skipped');
    assert.match(entry.skip_reasons.email, /suppressed/i);
  } finally {
    await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [clientId]);
  }
});

test('.invalid recipient reports skipped, never sent, on the real send path', async () => {
  crudModule.__setDeps({ sendRescheduleEmail: require('../../utils/rescheduleProposal').sendRescheduleEmail });
  const res = await request('PATCH', `/api/proposals/${placeholderProposalId}`, {
    token: adminToken2,
    body: {
      event_location: 'Placeholder Venue, Chicago, Illinois',
      notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
    },
  });
  assert.equal(res.status, 200, res.raw);
  const entry = res.body.notifications.find((n) => n.type === 'event_details_changed');
  assert.equal(entry.email, 'skipped');
  assert.match(entry.skip_reasons.email, /placeholder/i);
});

// ── Record payment (Task 5) ─────────────────────────────────────────────────
// Separate proposals per test: record-payment mutates status, so a shared
// fixture goes order-dependent.

const actionsModule = require('./actions');

async function seedPayProposal(cid) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, event_date, event_start_time, event_location, event_timezone, total_price, amount_paid, deposit_amount)
     VALUES ($1, $2, 'sent', '2026-11-05', '18:00', 'Pay Hall', 'America/Chicago', 500, 0, 100) RETURNING id`,
    [cid, packageId]
  );
  payProposalIds.push(r.rows[0].id);
  return r.rows[0].id;
}
const payProposalIds = [];

test('record-payment notify_client=false: no receipt, admin notice STILL fires', async () => {
  const adminCalls = [];
  const emailCalls = [];
  actionsModule.__setDeps({
    notifyAdminCategory: async (a) => { adminCalls.push(a); },
    sendEmail: async (a) => { emailCalls.push(a); return { id: 'stub' }; },
  });
  const pid = await seedPayProposal(clientId);
  const res = await request('POST', `/api/proposals/${pid}/record-payment`, {
    token: adminToken, body: { amount: 100, paid_in_full: false, method: 'cash', notify_client: false },
  });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body.notifications, []);
  assert.equal(emailCalls.length, 0, 'no client receipt may be attempted');
  assert.equal(adminCalls.length, 1, 'the routine_finance admin notice is never gated');
  assert.equal(adminCalls[0].category, 'routine_finance');
});

test('record-payment notify_client=true: receipt attempted and reported at the seam', async () => {
  const emailCalls = [];
  actionsModule.__setDeps({
    notifyAdminCategory: async () => {},
    sendEmail: async (a) => { emailCalls.push(a); return { id: 'stub' }; },
  });
  const pid = await seedPayProposal(clientId);
  const res = await request('POST', `/api/proposals/${pid}/record-payment`, {
    token: adminToken, body: { amount: 100, paid_in_full: false, method: 'cash', notify_client: true },
  });
  assert.equal(res.status, 200, res.raw);
  const entry = res.body.notifications.find((n) => n.type === 'payment_receipt');
  assert.ok(entry);
  assert.equal(entry.email, 'sent');
  assert.equal(emailCalls.length, 1);
  assert.match(emailCalls[0].subject || '', /payment|deposit|received/i);
});

test('record-payment notify_client=true on a .invalid client: skipped, never sent', async () => {
  const emailCalls = [];
  actionsModule.__setDeps({
    notifyAdminCategory: async () => {},
    sendEmail: async (a) => { emailCalls.push(a); return { id: 'stub' }; },
  });
  const pid = await seedPayProposal(placeholderClientId);
  const res = await request('POST', `/api/proposals/${pid}/record-payment`, {
    token: adminToken2, body: { amount: 50, paid_in_full: false, method: 'cash', notify_client: true },
  });
  assert.equal(res.status, 200, res.raw);
  const entry = res.body.notifications.find((n) => n.type === 'payment_receipt');
  assert.equal(entry.email, 'skipped');
  assert.match(entry.skip_reasons.email, /placeholder/i);
  assert.equal(emailCalls.length, 0);
});

test('record-payment notify_client=true on a prefs-suppressed client: skipped with reason', async () => {
  const emailCalls = [];
  actionsModule.__setDeps({
    notifyAdminCategory: async () => {},
    sendEmail: async (a) => { emailCalls.push(a); return { id: 'stub' }; },
  });
  await pool.query(`UPDATE clients SET communication_preferences = '{"email_enabled": false}'::jsonb WHERE id = $1`, [clientId]);
  try {
    const pid = await seedPayProposal(clientId);
    const res = await request('POST', `/api/proposals/${pid}/record-payment`, {
      token: adminToken2, body: { amount: 25, paid_in_full: false, method: 'cash', notify_client: true },
    });
    assert.equal(res.status, 200, res.raw);
    const entry = res.body.notifications.find((n) => n.type === 'payment_receipt');
    assert.equal(entry.email, 'skipped');
    assert.match(entry.skip_reasons.email, /suppressed/i);
    assert.equal(emailCalls.length, 0);
  } finally {
    await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [clientId]);
  }
});

test('preflight and save agree per reschedulable field, including start time', async () => {
  // Table-driven: for each single-field edit, preflight must return exactly
  // one notice (the save side's acceptance is proven by the send-seam test
  // above; both call the same eventDetailsNoticeApplies).
  const cases = [
    { event_date: '2026-11-20' },
    { event_start_time: '19:30' },
    { venue_street: '456 Oak St' }, // exercises resolvePendingLocation
  ];
  for (const body of cases) {
    const pre = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, { token: adminToken2, body });
    assert.equal(pre.status, 200, pre.raw);
    assert.equal(pre.body.notices.length, 1, `preflight must trigger for ${JSON.stringify(body)}`);
  }
});
