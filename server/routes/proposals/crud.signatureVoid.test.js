'use strict';
// The editor PATCH voids a signed, unpaid booking's signature when it moves
// the terms the client signed (audit ESIG-02): package, guests, hours, bars,
// bartenders, add-ons, syrups, adjustments, override, the total, or the venue
// the Event-Specific Agreement names. Inside the PATCH's own transaction the
// signature columns and the signed record are cleared, an 'accepted' row goes
// back to 'sent' so the page shows Sign & Pay again, and a signature_voided
// activity row carries the prior record. A save that moves none of those
// terms, and a paid row (the additional-services flow), keep the signature.
//
// No database: pool.connect hands the route a client whose query answers the
// PATCH's statements from an in-memory row (the fixture is priced by the real
// engine, so the stored snapshot and the re-price agree), every statement is
// recorded with the client it ran on, and the post-commit tail's helpers are
// stubbed through __setDeps or answered empty. The real router runs on
// express() over real HTTP with a real admin JWT.
//
// Run: node --test server/routes/proposals/crud.signatureVoid.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crud-void-test-secret';
delete process.env.SENTRY_DSN_SERVER;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const sentry = require('@sentry/node');
sentry.captureException = () => {};
sentry.captureMessage = () => {};

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateProposal } = require('../../utils/pricingEngine');

// ─── fixture ────────────────────────────────────────────────────────────────
const ADMIN = { id: 7, email: 'admin@example.com', role: 'admin', onboarding_status: 'approved', can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null };
const PKG = {
  id: 1, slug: 'test-flat', name: 'Test Flat', category: 'byob', pricing_type: 'flat', bar_type: 'byob',
  base_rate_4hr: 600, base_rate_3hr: null, extra_hour_rate: 100, first_bar_fee: 50, additional_bar_fee: 100,
  guests_per_bartender: 100, bartenders_included: 1, extra_bartender_hourly: 40, min_total: 0, is_active: true,
};
const SIGNED_AT = new Date('2026-10-01T15:00:00.000Z');
function signedUnpaidRow({ status = 'accepted', amountPaid = '0.00' } = {}) {
  const snap = calculateProposal({
    pkg: PKG, guestCount: 50, durationHours: 4, numBars: 0, numBartenders: null,
    addons: [], syrupSelections: [], adjustments: [], totalPriceOverride: null,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
  const signedSnapshot = { document_version: 'event-services-agreement-v4', rows: [{ key: 'package', label: 'Test Flat', amount: 600 }], gratuity_amount: 0, total: 600 };
  return {
    id: 901, client_id: 5, token: 'a8e2a5b4-1f4e-4e0e-9e2e-0a1b2c3d4e5f', status, amount_paid: amountPaid, external_paid: '0.00',
    package_id: PKG.id, guest_count: 50, event_duration_hours: '4.00', num_bars: 0, num_bartenders: 1,
    event_date: '2027-06-12', event_start_time: '6:00 PM', event_timezone: 'America/Chicago',
    event_location: '123 Test St, Rockford, IL', venue_name: null, venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: null,
    event_type: 'Wedding', event_type_category: null, event_type_custom: null,
    pricing_snapshot: snap, total_price: String(snap.total.toFixed(2)), total_price_override: null, adjustments: [],
    deposit_amount: '100.00', payment_type: 'full', autopay_enrolled: false, balance_due_date: null,
    setup_minutes_before: null, class_options: null, client_provides_glassware: false,
    tip_jar: true, gratuity_rate: 0, gratuity_floor_rate: null, gratuity_rate_change_origin: null,
    client_signed_name: 'Test Signer', client_signature_data: 'data:image/png;base64,iVBORw0KGgo=', client_signed_at: SIGNED_AT,
    client_signature_method: 'draw', client_signature_ip: '10.0.0.1', client_signature_user_agent: 'test-agent',
    client_signature_document_version: 'event-services-agreement-v4',
    client_signed_total: String(snap.total.toFixed(2)), client_signed_snapshot: signedSnapshot,
    accepted_at: SIGNED_AT, sent_at: new Date('2026-09-30T15:00:00.000Z'), created_at: new Date('2026-09-29T15:00:00.000Z'), updated_at: new Date(),
    view_count: 1, last_viewed_at: null, group_id: null,
  };
}

// ─── the recorder in place of Postgres ──────────────────────────────────────
let row;
// Bank debits still settling on the row (paymentInFlight.js reads
// stripe_sessions.status = 'processing'); set per test.
let inFlightRows = [];
// Card confirmations that may be landing (paymentInFlight.js reads pending
// sessions created within its window, the window riding as a parameter so the
// recorder can apply it the way Postgres would); set per test as
// [{ created_at: Date }].
let pendingSessions = [];
const calls = [];
const SIGNATURE_COLUMNS = ['client_signed_name', 'client_signature_data', 'client_signed_at', 'client_signature_method',
  'client_signature_ip', 'client_signature_user_agent', 'client_signature_document_version', 'client_signed_total', 'client_signed_snapshot'];

function answer(via, sql, params) {
  calls.push({ via, sql, params });
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [ADMIN], rowCount: 1 };
  if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ ...row, adjustments_token: 'tok-' + row.id }], rowCount: 1 };
  if (/FROM service_packages WHERE id = \$1/.test(sql)) return { rows: [PKG], rowCount: 1 };
  if (/^\s*UPDATE proposals SET\s+client_signed_name = NULL/i.test(sql)) {
    if (!row.client_signed_at) return { rows: [], rowCount: 0 };
    const resetStatus = params[1] === true;
    const signedByClient = row.accepted_at && row.client_signed_at && row.accepted_at.getTime() === row.client_signed_at.getTime();
    for (const c of SIGNATURE_COLUMNS) row[c] = null;
    if (signedByClient) row.accepted_at = null;
    if (resetStatus && ['accepted', 'viewed', 'modified'].includes(row.status)) row.status = 'sent';
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (/UPDATE proposals SET\s+event_date = COALESCE\(\$1, event_date\)/.test(sql)) {
    row = { ...row, guest_count: params[4], num_bars: params[6], num_bartenders: params[7], pricing_snapshot: JSON.parse(params[8]), total_price: String(Number(params[9]).toFixed(2)) };
    return { rows: [{ ...row, adjustments_token: 'tok-' + row.id }], rowCount: 1 };
  }
  if (/FROM stripe_sessions s/.test(sql) && /status = 'processing'/.test(sql)) return { rows: inFlightRows, rowCount: inFlightRows.length };
  if (/FROM stripe_sessions/.test(sql) && /status = 'pending'/.test(sql)) {
    const cutoff = Date.now() - Number(params[1]) * 60000;
    const rows = pendingSessions.filter((s) => s.created_at.getTime() > cutoff);
    return { rows, rowCount: rows.length };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM shifts/.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
  if (/SELECT id, event_date, event_start_time, event_timezone, balance_due_date/.test(sql)) return { rows: [{ ...row }], rowCount: 1 };
  if (/SELECT total_price, deposit_amount, external_paid FROM proposals/.test(sql)) return { rows: [{ ...row }], rowCount: 1 };
  if (/AS locked_total/.test(sql)) return { rows: [{ locked_total: '0' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer('pool', sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer('client', sql, params), release() {} });

const crudRouter = require('./crud');
crudRouter.__setDeps({
  sendProposalSentEmail: async () => {},
  createInvoiceOnSend: async () => {},
  sendRescheduleEmail: async () => ({ email: 'skipped', sms: 'skipped', skip_reasons: {} }),
});

let server; let baseUrl; let token;
function patch(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
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
    req.write(payload);
    req.end();
  });
}

const voidUpdate = () => calls.findIndex((c) => /^\s*UPDATE proposals SET\s+client_signed_name = NULL/i.test(c.sql));
const voidedRow = () => calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql) && c.params[1] === undefined && /'signature_voided'/.test(c.sql))
  || calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql) && /'signature_voided'/.test(c.sql));
const mainUpdate = () => calls.findIndex((c) => /UPDATE proposals SET\s+event_date = COALESCE/.test(c.sql));
const commitIndex = () => calls.findIndex((c) => c.sql === 'COMMIT');
const beginIndex = () => calls.findIndex((c) => c.sql === 'BEGIN');

before(async () => {
  token = jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => { calls.length = 0; inFlightRows = []; pendingSessions = []; });

test('a guest-count change on a signed unpaid accepted row voids the signature inside the transaction and sends the row back to sent', async () => {
  row = signedUnpaidRow();
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 80 });
  assert.equal(res.status, 200, res.raw);

  const v = voidUpdate();
  assert.ok(v >= 0, 'the signature was cleared');
  assert.equal(calls[v].via, 'client', 'on the held transaction client');
  assert.ok(beginIndex() < v && v < commitIndex(), 'inside BEGIN/COMMIT');
  assert.ok(v < mainUpdate(), 'before the re-price UPDATE, so the returned row carries the void');
  assert.deepEqual(calls[v].params.slice(0, 2), [row.id, true]);

  const audit = voidedRow();
  assert.ok(audit, 'a signature_voided activity row was written');
  assert.equal(audit.via, 'client');
  assert.ok(beginIndex() < calls.indexOf(audit) && calls.indexOf(audit) < commitIndex());
  const details = JSON.parse(audit.params[2]);
  assert.ok(details.reason.includes('guest_count'), `reason names the moved term: ${JSON.stringify(details.reason)}`);
  assert.equal(details.from_status, 'accepted');
  assert.equal(details.to_status, 'sent');
  assert.equal(details.previous.signed_name, 'Test Signer');
  assert.equal(new Date(details.previous.signed_at).getTime(), SIGNED_AT.getTime());
  assert.equal(details.previous.document_version, 'event-services-agreement-v4');
  assert.equal(details.previous.signature_ip, '10.0.0.1');
  assert.equal(details.previous.signed_total, '600.00');
  assert.deepEqual(details.previous.signed_snapshot, signedUnpaidRow().client_signed_snapshot);

  assert.equal(res.body.status, 'sent');
  assert.equal(res.body.client_signed_at, null);
  assert.equal(res.body.client_signed_total, null);
  assert.equal(res.body.accepted_at, null, 'the acceptance stamp the sign set goes with it');
  assert.equal(res.body.guest_count, 80, 'the edit itself still landed');
});

test('a bar added to a signed unpaid row (the total moves) voids it; a venue change alone voids it too', async () => {
  row = signedUnpaidRow();
  let res = await patch(`/api/proposals/${row.id}`, { num_bars: 1 });
  assert.equal(res.status, 200, res.raw);
  assert.ok(voidUpdate() >= 0, 'the signature was cleared on a price move');
  assert.ok(JSON.parse(voidedRow().params[2]).reason.includes('total'));

  calls.length = 0;
  row = signedUnpaidRow();
  res = await patch(`/api/proposals/${row.id}`, { venue_street: '456 Other Ave' });
  assert.equal(res.status, 200, res.raw);
  assert.ok(voidUpdate() >= 0, 'the signature was cleared on a venue move');
  assert.ok(JSON.parse(voidedRow().params[2]).reason.includes('venue'));
});

test('a save that moves none of the signed terms keeps the signature', async () => {
  row = signedUnpaidRow();
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 50, setup_minutes_before: 45 });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1, 'no void UPDATE');
  assert.equal(voidedRow(), undefined, 'no signature_voided row');
  assert.equal(res.body.status, 'accepted');
  assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime());
});

test('a paid row keeps its signature when its terms move (the additional-services flow)', async () => {
  row = signedUnpaidRow({ status: 'deposit_paid', amountPaid: '100.00' });
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 80 });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1, 'no void UPDATE on a paid row');
  assert.equal(voidedRow(), undefined);
  assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime());
});

// Round 2 (M2): "unpaid" for the void means no money on the row AND none in
// flight. amount_paid stays 0 until payment_intent.succeeded, so an ACH deposit
// still settling plus an admin edit used to clear the signature the webhook
// then credited against, leaving a paid row the client could never re-sign.
test('a bank debit still settling keeps the signature: no void, the signed total stands', async () => {
  row = signedUnpaidRow();
  inFlightRows = [{ stripe_payment_intent_id: 'pi_test_1', amount_cents: 10000, started_at: new Date(), invoice_id: null, invoice_number: null }];
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 80 });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1, 'no void UPDATE while a payment is in flight');
  assert.equal(voidedRow(), undefined, 'no signature_voided row');
  assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime());
  assert.equal(res.body.client_signed_total, '600.00');
  assert.equal(res.body.status, 'accepted');
  const probe = calls.find((c) => /FROM stripe_sessions s/.test(c.sql) && /status = 'processing'/.test(c.sql));
  assert.ok(probe, 'the in-flight read ran');
  assert.equal(probe.via, 'client', 'on the held transaction client');
  assert.equal(res.body.guest_count, 80, 'the edit itself still landed');
});

test('money collected off-platform (external_paid) keeps the signature too', async () => {
  row = { ...signedUnpaidRow(), external_paid: '100.00' };
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 80 });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1, 'no void UPDATE with external money on the row');
  assert.equal(voidedRow(), undefined);
  assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime());
});

// Round 3 (L8): a card payment never produces a processing session, so a card
// deposit confirmed but not yet credited (the seconds before
// payment_intent.succeeded, a 3DS challenge keeping the intent pending) was
// invisible to the money guard and the void fired ahead of the credit; the
// webhook then credited a row the sign UPDATE refuses. A pending session
// inside the sign email's own window counts as money on the row; one older
// than the window is a stale intent and the void is allowed.
test('a pending card session inside the window keeps the signature', async () => {
  row = signedUnpaidRow();
  pendingSessions = [{ created_at: new Date(Date.now() - 5 * 60000) }];
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 80 });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1, 'no void UPDATE while a card confirmation may be landing');
  assert.equal(voidedRow(), undefined);
  assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime());
  assert.equal(res.body.client_signed_total, '600.00');
  const probe = calls.find((c) => /FROM stripe_sessions/.test(c.sql) && /status = 'pending'/.test(c.sql));
  assert.ok(probe && probe.via === 'client', 'the pending read ran on the held client');
});

test('a pending session older than the window is stale and the void goes ahead', async () => {
  row = signedUnpaidRow();
  pendingSessions = [{ created_at: new Date(Date.now() - 45 * 60000) }];
  const res = await patch(`/api/proposals/${row.id}`, { guest_count: 80 });
  assert.equal(res.status, 200, res.raw);
  assert.ok(voidUpdate() >= 0, 'the signature was cleared');
  assert.ok(voidedRow(), 'a signature_voided row was written');
  assert.equal(res.body.client_signed_at, null);
  assert.equal(res.body.status, 'sent');
});
