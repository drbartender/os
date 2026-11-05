'use strict';
// The public quote wizard withholds the proposal token when the submit
// resolved to an EXISTING client row, and delivers only to the address on
// file (audit 2026-11-05 AUTH-12, the sibling of AUTH-02 on the email match).
//
// clients.email carries a unique index, so a submit whose email matches an
// existing client must attach to that row (a second row cannot hold the
// address). Until this fix the 201 handed the submitter the proposal token,
// and the public proposal page then showed the row's client_name and phone
// prefill, so a stranger who knew only a client's email could open, sign or
// pay a proposal under the victim's record; the proposal-sent email and SMS
// went to the submitted address and phone. Now a matched submit answers
// 201 with token: null and a masked delivered_to, the mail goes to the row's
// email and any SMS to the row's phone (never the submitted one), and a
// submit that CREATED the row keeps today's response with the token.
//
// Pure: the real router over real HTTP against a table-keyed stubbed pool
// (the `pool.query = ...` seam of sms.status.test.js) that answers the
// transaction's statements, including createInvoiceOnSend's, from fixture
// rows; the post-commit send is captured through sendProposalSentEmail's
// __setDeps seam. The DB-backed harness for this route is
// publicSmsConsent.test.js.

require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const sendProposal = require('../../utils/sendProposalSentEmail');

const VICTIM_ID = 42;
const VICTIM_EMAIL = 'victim@example.com';
const VICTIM_PHONE = '5555550142';
const NEW_ID = 900;
const PROPOSAL_ID = 7001;
const TOKEN = '0f3d2b4a-1c5e-4f6a-8b7c-9d0e1f2a3b4c';

// A flat-priced service package as pg returns it (NUMERIC columns as strings).
const pkg = {
  id: 1, slug: 'core', name: 'Core', category: 'service_only', pricing_type: 'flat', bar_type: 'service_only',
  base_rate_4hr: '400.00', base_rate_3hr: null, base_rate_4hr_small: null, base_rate_3hr_small: null,
  extra_hour_rate: '100.00', extra_hour_rate_small: null, min_guests: null, min_billed_guests: null,
  guests_per_bartender: 100, bartenders_included: 1, extra_bartender_hourly: '40.00',
  first_bar_fee: null, additional_bar_fee: null, min_total: null, includes: [], is_active: true,
};

let statements = [];
let proposalRow = null;
const realQuery = pool.query;
const realConnect = pool.connect;

function answer(raw, params) {
  const text = String(raw).replace(/\s+/g, ' ').trim();
  statements.push({ text, params });
  if (text.includes('FROM clients WHERE LOWER(email) = $1')) {
    return params[0] === VICTIM_EMAIL ? { rows: [{ id: VICTIM_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.startsWith('INSERT INTO clients')) return { rows: [{ id: NEW_ID }], rowCount: 1 };
  if (text.includes('FROM clients WHERE id = $1')) {
    const victim = params[0] === VICTIM_ID;
    return {
      rows: [{
        communication_preferences: { sms_enabled: true, email_enabled: true },
        email_status: null, phone_status: null,
        phone: victim ? VICTIM_PHONE : '5555550900',
        email: victim ? VICTIM_EMAIL : 'newcomer@example.com',
      }],
      rowCount: 1,
    };
  }
  if (text.startsWith('INSERT INTO proposals')) {
    proposalRow = {
      id: PROPOSAL_ID, token: TOKEN, client_id: params[0], status: 'sent', event_type: 'Wedding',
      event_type_custom: null, event_date: '2026-12-31', package_id: pkg.id, payment_type: 'full',
      deposit_amount: null, balance_due_date: null, external_paid: 0,
      pricing_snapshot: JSON.parse(params[9]), total_price: params[10],
    };
    return { rows: [proposalRow], rowCount: 1 };
  }
  if (text.includes('FROM proposals')) return { rows: proposalRow ? [{ ...proposalRow, package_name: pkg.name }] : [], rowCount: proposalRow ? 1 : 0 };
  if (text.includes('FROM service_packages')) return { rows: [pkg], rowCount: 1 };
  if (text.includes("nextval('invoice_number_seq')")) return { rows: [{ val: 1 }], rowCount: 1 };
  if (text.startsWith('INSERT INTO invoices')) {
    return { rows: [{ id: 9001, proposal_id: PROPOSAL_ID, invoice_number: 'INV-0001', amount_due: 0, status: 'sent' }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 }; // BEGIN/COMMIT, savepoints, addons, drafts, logs, invoices, line items
}

let server;
let baseUrl;
const sent = { emails: [], sms: [] };

function submit(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(new URL('/api/proposals/public/submit', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const body = (email, phone) => ({
  client_name: 'Wizard Submitter', client_email: email, client_phone: phone,
  event_date: '2026-12-31', event_start_time: '18:00', event_duration_hours: 4,
  venue_name: 'Match Hall', venue_street: '1 Test St', venue_city: 'Chicago', venue_state: 'IL',
  guest_count: 50, package_id: pkg.id, event_type: 'Wedding',
});

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(text, params || []));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(text, params || [])),
    release() {},
  });
  sendProposal.__setDeps({
    sendEmail: (args) => { sent.emails.push(args); return Promise.resolve({ id: 'stub' }); },
    sendAndLogSms: (args) => { sent.sms.push(args); return Promise.resolve({ ok: true }); },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', require('./public'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

test('a submit whose email matches an existing client attaches the proposal but withholds the token and delivers to the address on file', async () => {
  statements = []; proposalRow = null; sent.emails = []; sent.sms = [];
  const res = await submit(body('Victim@example.com', '5555550666'));
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.token, null, 'the token is withheld');
  assert.ok(!res.raw.includes(TOKEN), 'the token appears nowhere in the body');
  assert.equal(res.body.delivered_to, 'v***@example.com', 'the address on file, masked');
  assert.equal(typeof res.body.total, 'number');
  const insert = statements.find((s) => s.text.startsWith('INSERT INTO proposals'));
  assert.equal(insert.params[0], VICTIM_ID, 'the proposal hangs off the matched row (the unique index allows no other)');
  assert.ok(!statements.some((s) => s.text.startsWith('INSERT INTO clients')), 'no second client row');
  assert.ok(!statements.some((s) => /UPDATE clients SET (email|phone)/.test(s.text)), 'the matched row is not mutated');
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].to, VICTIM_EMAIL, 'the proposal mail goes to the row\'s email');
  for (const s of sent.sms) {
    assert.equal(s.to, VICTIM_PHONE, 'any SMS goes to the phone on file, never the submitted number');
  }
});

test('a submit that creates the client row keeps the token in the response and delivers to the submitted contact', async () => {
  statements = []; proposalRow = null; sent.emails = []; sent.sms = [];
  const res = await submit(body('newcomer@example.com', '5555550900'));
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.token, TOKEN);
  assert.equal(res.body.delivered_to, undefined);
  assert.ok(statements.some((s) => s.text.startsWith('INSERT INTO clients')), 'a new row was created');
  assert.equal(sent.emails[0].to, 'newcomer@example.com');
  for (const s of sent.sms) assert.equal(s.to, '5555550900');
});
