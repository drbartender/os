'use strict';
// A restore out of 'archived' clears a stale client signature (audit
// ESIG-14): archived -> draft -> sent used to keep client_signed_at on a row
// the public page could neither sign (the sign UPDATE refuses a signed row)
// nor pay (pay-only needs 'accepted'), so a restored quote now goes back to
// unsigned, the way the restore already clears the cancel fields, and a
// signature_voided activity row keeps the prior record.
//
// No database: pool.connect hands the route a client whose query answers the
// status handler's statements from an in-memory row; every statement is
// recorded with the client it ran on. The real router on express() over
// real HTTP with a real admin JWT.
//
// Run: node --test server/routes/proposals/lifecycle.restoreSignature.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lifecycle-test-secret';
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

const ADMIN = { id: 7, email: 'admin@example.com', role: 'admin', onboarding_status: 'approved', can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null };
const SIGNED_AT = new Date('2026-10-01T15:00:00.000Z');
const SIGNATURE_COLUMNS = ['client_signed_name', 'client_signature_data', 'client_signed_at', 'client_signature_method',
  'client_signature_ip', 'client_signature_user_agent', 'client_signature_document_version', 'client_signed_total', 'client_signed_snapshot'];

function archivedRow({ signed = true, amountPaid = '0.00', externalPaid = '0.00' } = {}) {
  return {
    id: 902, status: 'archived', group_id: null, amount_paid: amountPaid, external_paid: externalPaid, total_price: '600.00',
    client_signed_name: signed ? 'Test Signer' : null, client_signature_data: signed ? 'data:image/png;base64,iVBORw0KGgo=' : null,
    client_signed_at: signed ? SIGNED_AT : null, client_signature_method: signed ? 'draw' : null,
    client_signature_ip: signed ? '10.0.0.1' : null, client_signature_user_agent: signed ? 'test-agent' : null,
    client_signature_document_version: signed ? 'event-services-agreement-v4' : null,
    client_signed_total: signed ? '600.00' : null, client_signed_snapshot: signed ? { document_version: 'event-services-agreement-v4', rows: [], total: 600 } : null,
    accepted_at: signed ? SIGNED_AT : null, sent_at: new Date('2026-09-30T15:00:00.000Z'),
    cancelled_at: null, cancelled_by: null, cancellation_note: null, archive_reason: 'event_passed',
  };
}

let row;
// Bank debits still settling on the row (paymentInFlight.js reads
// stripe_sessions.status = 'processing'); set per test.
let inFlightRows = [];
const calls = [];
function answer(via, sql, params) {
  calls.push({ via, sql, params });
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [ADMIN], rowCount: 1 };
  if (/FROM stripe_sessions s/.test(sql) && /status = 'processing'/.test(sql)) return { rows: inFlightRows, rowCount: inFlightRows.length };
  if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ ...row }], rowCount: 1 };
  if (/^\s*UPDATE proposals SET\s+status = \$1::text/.test(sql)) {
    row = { ...row, status: params[0], cancelled_at: null, cancelled_by: null, cancellation_note: null, archive_reason: null };
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (/^\s*UPDATE proposals SET\s+client_signed_name = NULL/i.test(sql)) {
    if (!row.client_signed_at) return { rows: [], rowCount: 0 };
    const signedByClient = row.accepted_at && row.accepted_at.getTime() === row.client_signed_at.getTime();
    for (const c of SIGNATURE_COLUMNS) row[c] = null;
    if (signedByClient) row.accepted_at = null;
    if (params[1] === true && ['accepted', 'viewed', 'modified'].includes(row.status)) row.status = 'sent';
    return { rows: [{ ...row }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer('pool', sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer('client', sql, params), release() {} });

const lifecycleRouter = require('./lifecycle');
lifecycleRouter.__setDeps({ createInvoiceOnSend: async () => {}, sendProposalSentEmail: async () => {} });

let server; let baseUrl; let token;
function patch(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PATCH',
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
const voidedRow = () => calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql) && /'signature_voided'/.test(c.sql));
const idx = (sql) => calls.findIndex((c) => c.sql === sql);

before(async () => {
  token = jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', lifecycleRouter);
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

beforeEach(() => { calls.length = 0; inFlightRows = []; });

test('archived -> draft on a signed row clears the signature inside the transaction and records the prior signature', async () => {
  row = archivedRow({ signed: true });
  const res = await patch(`/api/proposals/${row.id}/status`, { status: 'draft' });
  assert.equal(res.status, 200, res.raw);
  const v = voidUpdate();
  assert.ok(v >= 0, 'the signature was cleared');
  assert.equal(calls[v].via, 'client');
  assert.ok(idx('BEGIN') < v && v < idx('COMMIT'), 'inside BEGIN/COMMIT');
  assert.deepEqual(calls[v].params.slice(0, 2), [String(row.id), false], 'the status route keeps its own status (draft)');
  const audit = voidedRow();
  assert.ok(audit, 'a signature_voided activity row was written');
  assert.equal(audit.via, 'client');
  const details = JSON.parse(audit.params[2]);
  assert.match(String(details.reason), /archived -> draft/);
  assert.equal(details.previous.signed_name, 'Test Signer');
  assert.equal(new Date(details.previous.signed_at).getTime(), SIGNED_AT.getTime());
  assert.equal(details.previous.document_version, 'event-services-agreement-v4');
  assert.equal(details.previous.signed_total, '600.00');
  assert.equal(res.body.status, 'draft');
  assert.equal(res.body.client_signed_at, null);
  assert.equal(res.body.client_signed_name, null);
  assert.equal(res.body.accepted_at, null, 'the acceptance stamp the sign set goes with it');
});

test('archived -> draft on an unsigned row writes no void', async () => {
  row = archivedRow({ signed: false });
  const res = await patch(`/api/proposals/${row.id}/status`, { status: 'draft' });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1);
  assert.equal(voidedRow(), undefined);
  assert.equal(res.body.status, 'draft');
});

// Round 2 (L3): the void keys on leaving 'archived' for any pre-payment status,
// not on the target 'draft': a forced restore straight to sent or viewed used
// to keep the signature and recreate the second path of the audit.
test('a forced archived -> sent on a signed, money-free row clears the signature too', async () => {
  row = archivedRow({ signed: true });
  const res = await patch(`/api/proposals/${row.id}/status?force=true`, { status: 'sent' });
  assert.equal(res.status, 200, res.raw);
  assert.ok(voidUpdate() >= 0, 'the signature was cleared on a forced restore');
  const details = JSON.parse(voidedRow().params[2]);
  assert.match(String(details.reason), /archived -> sent/);
  assert.equal(res.body.status, 'sent');
  assert.equal(res.body.client_signed_at, null);
});

// Round 2 (L4): the restore keeps the signature when the row holds money
// (amount_paid, external_paid, or a bank debit still settling): a cancelled
// booking that kept its retainer (money law 1) rests on the signature it was
// forfeited under, and a debit in flight credits the row after the restore.
test('archived -> draft keeps the signature when the row holds money or a payment is in flight', async () => {
  for (const [label, fixture, inFlight] of [
    ['amount_paid', archivedRow({ signed: true, amountPaid: '100.00' }), []],
    ['external_paid', archivedRow({ signed: true, externalPaid: '100.00' }), []],
    ['in flight', archivedRow({ signed: true }), [{ stripe_payment_intent_id: 'pi_test_1', amount_cents: 10000, started_at: new Date(), invoice_id: null, invoice_number: null }]],
  ]) {
    row = fixture;
    inFlightRows = inFlight;
    calls.length = 0;
    const res = await patch(`/api/proposals/${row.id}/status`, { status: 'draft' });
    assert.equal(res.status, 200, `${label}: ${res.raw}`);
    assert.equal(voidUpdate(), -1, `${label}: no void UPDATE`);
    assert.equal(voidedRow(), undefined, `${label}: no signature_voided row`);
    assert.equal(res.body.status, 'draft', label);
    assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime(), `${label}: the signature stands`);
    assert.equal(res.body.client_signed_total, '600.00', label);
  }
});

test('a forced restore onto a paid status keeps the signature', async () => {
  row = archivedRow({ signed: true, amountPaid: '100.00' });
  const res = await patch(`/api/proposals/${row.id}/status?force=true`, { status: 'deposit_paid' });
  assert.equal(res.status, 200, res.raw);
  assert.equal(voidUpdate(), -1);
  assert.equal(new Date(res.body.client_signed_at).getTime(), SIGNED_AT.getTime());
});
