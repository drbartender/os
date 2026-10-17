'use strict';

// The line-item removal notice names only the CLIENT-facing label
// (applyLineItemCancel's result.clientLabel; spec 2026-10-16 section 4.3):
// a hidden adjustment arrives as the shared "Pricing adjustment", never as its
// own label. A caller that passes no client label (or the admin's label under
// the old removedLabel name) sends nothing rather than guess, so the admin
// label can never ride along by accident. The route-level proof that a hidden
// line's email carries no trace of its label is in
// server/routes/proposals/cancelLineItem.test.js. Runs ALONE against the
// shared dev DB:
//   node --test server/utils/lineItemRemovedNotify.test.js
require('dotenv').config();

// The failure path reports to Sentry when a DSN is set: never from a test.
const sentryModule = require('@sentry/node');
sentryModule.captureException = () => {};

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const notify = require('./lineItemRemovedNotify');

if (process.env.NODE_ENV === 'production') {
  throw new Error('lineItemRemovedNotify.test.js refuses to run against production');
}

const NONCE = `lirn-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
let proposalId;
let sends = [];

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`LIRN Fixture ${NONCE}`, `${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_date, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', 'wedding', CURRENT_DATE + 60, 1500, 100) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  notify.__setDeps({ sendEmail: (args) => { sends.push(args); return Promise.resolve({ id: 'stub' }); } });
});

after(async () => {
  notify.__setDeps({ sendEmail: require('./email').sendEmail });
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('names the client-facing label it is given, with the total and balance as before', async () => {
  sends = [];
  const r = await notify.sendLineItemRemovedNotice({ proposalId, clientLabel: 'Bar Rental', newTotal: 1500, sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].subject, 'Your event total was updated');
  assert.match(sends[0].text,
    /We removed Bar Rental from your event at your request\. Your updated total is \$1,500\.00\. Your remaining balance is \$1,400\.00\./);
  assert.match(sends[0].html, /We removed Bar Rental from your event at your request\./);
});

test('a caller that passes no client label sends nothing, so the admin label can never ride along', async () => {
  sends = [];
  const oldName = await notify.sendLineItemRemovedNotice({ proposalId, removedLabel: 'Test secret line', newTotal: 1500 });
  assert.equal(oldName.email, 'failed', 'the admin label under the old name is never used');
  // The dialog toasts "Removed, but the client notice failed to send: <email_error>",
  // so the reason reads as plain words for the admin, never a code identifier.
  assert.equal(oldName.email_error, 'the removed line has no name to show the client. Tell the client directly.');
  const blank = await notify.sendLineItemRemovedNotice({ proposalId, clientLabel: '   ', newTotal: 1500 });
  assert.equal(blank.email, 'failed', 'a blank label is no label');
  assert.equal(sends.length, 0, 'nothing reached the client');
});
